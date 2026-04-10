import { resolve, dirname } from 'node:path';

import {
  loadWorkflowDefinition,
  normalizeWorkflowDefinition,
  hashWorkflow,
  createWorkflowManifest,
  compareWorkflowManifests,
  TERMINAL_STATES,
  buildWorkflowRecipeSearchDirs,
} from './workflow.js';
import { evaluateWorkflowRisk } from './policy-engine.js';
import { saveManifest, loadManifest } from './manifest.js';
import {
  createLogger,
  printBanner,
  printWorkflowApprovalSummary,
  printWorkflowDrift,
  printStepProgress,
  printWorkflowResult,
  printDenied,
  generateRunId,
} from './logger.js';
import { launchWorker, detectInteractiveAttempt } from './worker-interface.js';
import {
  validateResult,
  validateUpdateProposal,
} from './validator.js';
import { createServiceRegistry } from './service-registry.js';
import { createContract, verifyFileHash } from './contract.js';
import {
  promptApproval,
  STATUS_EXIT_CODES,
  buildOutOfScopeUpdateDecision,
} from './supervisor.js';
import { indexById, persistStateSafe, executeSubprocess } from './shared.js';
import {
  createNegotiationState,
  detectIssues,
  generateNegotiationRequest,
  applyDelta,
  buildEscalationPackage,
} from './negotiation.js';
import { checkTimePolicy, acquireLock } from './runtime-policy.js';
import { createAuditLog } from './audit.js';
import { resolveInputs, resolveRecipeById } from './recipe-runner.js';
import { hashRecipe } from './recipe.js';
import { executeRecipe } from './recipe-executor.js';
import { verifyRecipeInputContentHashes } from './prompt-inputs.js';
import { classifyTrust } from './recipe-channel.js';
import {
  emitProgress as emitSupervisorProgress,
  emitExecutionEnd as emitSupervisorExecutionEnd,
  mapResultStatusToProgressStatus,
} from './progress-events.js';

const STATE_REFERENCE_RE = /\{\{state\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\}\}/g;
const SHARED_OUTPUT_TYPES = new Set(['string', 'number', 'boolean', 'json']);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function emitProgress(progressSink, runId, event, data = {}) {
  emitSupervisorProgress(progressSink, runId, 'workflow', event, data);
}

function emitExecutionEnd(progressSink, runId, finalStatus, context = {}) {
  emitSupervisorExecutionEnd(progressSink, runId, 'workflow', finalStatus, {
    message: context.message,
    workflowName: context.workflowName,
    stepsExecuted: context.stepsExecuted,
  });
}

function buildResult(runId, status, opts = {}) {
  return {
    runId,
    status,
    attempt:         opts.attempt         ?? 0,
    workflowHash:    opts.workflowHash    ?? '',
    manifestPath:    opts.manifestPath    ?? '',
    riskLevel:       opts.riskLevel       ?? '',
    riskReasons:     opts.riskReasons     ?? [],
    exitCode:        STATUS_EXIT_CODES[status] ?? STATUS_EXIT_CODES.internal_error,
    stepsExecuted:   opts.stepsExecuted   ?? 0,
    failedStep:      opts.failedStep      ?? null,
    terminalReason:  opts.terminalReason  ?? null,
    rollbackRan:     opts.rollbackRan     ?? false,
  };
}

function makeEmptyState(runId) {
  return {
    runId,
    kind: 'workflow',
    workflowName: '',
    currentStep:  '',
    iteration:    0,
    stepsExecuted: [],
    serviceHandles: {},
    terminalReason: null,
  };
}

function formatDriftsForPrint(diffs) {
  return diffs.map(d => (typeof d === 'string' ? { description: d } : d));
}

function formatReviewEachTimeReason(workflow) {
  const flaggedItems = [];
  const steps = workflow?.steps ?? [];

  for (const step of steps) {
    if (!step || step.type !== 'recipe_ref') continue;
    const flaggedInputs = step?.recipeRef?.flaggedInputs ?? [];
    const neverReuseKeys = flaggedInputs
      .filter((entry) => entry?.neverReuse)
      .map((entry) => entry.key)
      .filter((key) => typeof key === 'string' && key.length > 0)
      .map((key) => `${step.id}:${key}`);

    for (const key of neverReuseKeys) {
      flaggedItems.push(key);
    }
  }

  if (flaggedItems.length === 0) return null;
  return `Fresh approval required for review_each_time inputs: ${flaggedItems.join(', ')}`;
}

function formatRecipeRefBoundaryMismatch(expected = {}, actual = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(expected)) {
    if (value !== actual[key]) {
      parts.push(`${key}: ${value} -> ${actual[key]}`);
    }
  }
  if (parts.length === 0) return null;
  return parts.join(', ');
}

function splitStatePath(path) {
  if (typeof path !== 'string') return [];
  return path.match(/[^.[\]]+/g) ?? [];
}

function resolveByPath(context, path) {
  const segments = splitStatePath(path);
  let value = context;

  for (const segment of segments) {
    if (value === null || value === undefined) return undefined;

    const index = String(Number(segment)) === segment ? Number(segment) : segment;
    value = value[index];
    if (value === undefined) return undefined;
  }

  return value;
}

function isTypedMatch(value, expectedType) {
  if (expectedType === 'string') return typeof value === 'string';
  if (expectedType === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expectedType === 'boolean') return typeof value === 'boolean';
  return value !== undefined; // json
}

function resolveStateReferenceValue(raw, runtimeState, { preserveType = false } = {}) {
  if (typeof raw !== 'string') {
    return { value: raw, consumed: false };
  }

  const matches = [...raw.matchAll(STATE_REFERENCE_RE)];
  if (matches.length === 0) {
    return { value: raw, consumed: false };
  }

  const resolved = raw.replace(STATE_REFERENCE_RE, (_, stepId, outputKey) => {
    const stepState = runtimeState[stepId];
    if (!stepState || !(outputKey in stepState)) {
      throw new Error(`Missing state reference {{state.${stepId}.${outputKey}}}`);
    }

    const value = stepState[outputKey];
    return value === undefined ? '' : String(value);
  });

  if (preserveType && matches.length === 1 && raw === matches[0][0]) {
    const stepId = matches[0][1];
    const outputKey = matches[0][2];
    return { value: runtimeState[stepId]?.[outputKey], consumed: true };
  }

  return { value: resolved, consumed: true };
}

function resolveTaskArgs(runArgs, runtimeState) {
  const resolved = [];
  for (const arg of runArgs ?? []) {
    try {
      const result = resolveStateReferenceValue(arg, runtimeState, { preserveType: false });
      resolved.push(String(result.value));
    } catch (err) {
      return { terminalReason: err.message };
    }
  }

  return { resolvedArgs: resolved, terminalReason: null };
}

function resolveRecipeInputs(rawInputs, runtimeState, stepId) {
  const resolvedInputs = {};
  const sourceInputs = rawInputs || {};

  for (const [key, raw] of Object.entries(sourceInputs)) {
    try {
      const result = resolveStateReferenceValue(raw, runtimeState, { preserveType: true });
      if (result.consumed && result.value === undefined) {
        return {
          terminalReason: `Missing state reference in recipe_ref step "${stepId}" input "${key}"`,
        };
      }
      resolvedInputs[key] = result.value;
    } catch (err) {
      return { terminalReason: `Missing state reference in recipe_ref step "${stepId}" input "${key}"` };
    }
  }

  return { resolvedInputs };
}

function publishSharedOutputs(stepDef, executionContext, runtimeState, stepId) {
  const outputs = stepDef?.outputs;
  if (!outputs || typeof outputs !== 'object') return { terminalReason: null };

  if (Object.keys(outputs).length === 0) return { terminalReason: null };

  if (!runtimeState[stepId]) {
    runtimeState[stepId] = {};
  }

  for (const [outputKey, outputSpec] of Object.entries(outputs)) {
    if (!outputSpec || typeof outputSpec !== 'object') {
      return { terminalReason: `Step "${stepId}" output "${outputKey}" declaration is invalid.` };
    }

    const outputType = outputSpec.type;
    const from = outputSpec.from;

    if (!SHARED_OUTPUT_TYPES.has(outputType)) {
      return { terminalReason: `Step "${stepId}" output "${outputKey}" has unsupported type "${String(outputType)}".` };
    }

    if (typeof from !== 'string' || from.length === 0) {
      return { terminalReason: `Step "${stepId}" output "${outputKey}" has an invalid from path.` };
    }

    const value = resolveByPath(executionContext, from);
    if (value === undefined) {
      return { terminalReason: `Step "${stepId}" output "${outputKey}" is missing value at "${from}".` };
    }

    if (!isTypedMatch(value, outputType)) {
      return {
        terminalReason: `Step "${stepId}" output "${outputKey}" type mismatch: expected ${outputType}, got ${typeof value}`,
      };
    }

    runtimeState[stepId][outputKey] = value;
  }

  return { terminalReason: null };
}

// ---------------------------------------------------------------------------
// Phase A: Load, normalize, hash, evaluate risk (pure pipeline)
// ---------------------------------------------------------------------------

function loadAndPrepare(definitionPath, trustClass, logger, options = {}) {
  const definition = loadWorkflowDefinition(resolve(definitionPath));
  const basePath = dirname(resolve(definitionPath));
  const workflow = normalizeWorkflowDefinition(definition, basePath, {
    recipeSearchDirs: options.recipeSearchDirs,
    allowUnverified: options.allowUnverified,
  });

  logger.info('workflow_loaded', { name: workflow.name, entryStep: workflow.entryStep, maxIterations: workflow.maxIterations });

  const workflowHash = hashWorkflow(workflow);
  logger.info('workflow_hashed', { workflowHash });

  const riskAssessment = evaluateWorkflowRisk(workflow, {
    trustClass: trustClass || undefined,
    projectRoot: workflow.projectRoot,
  });

  logger.info('risk_evaluated', {
    trustClass: riskAssessment.trustClass,
    riskLevel:  riskAssessment.riskLevel,
    reasons:    riskAssessment.reasons,
  });

  return { workflow, workflowHash, riskAssessment };
}

// ---------------------------------------------------------------------------
// Phase B: Manifest comparison (pure)
// ---------------------------------------------------------------------------

function compareAgainstApproved(candidate, manifestPath, logger) {
  let approved = null;
  try {
    approved = loadManifest(manifestPath);
  } catch (err) {
    logger.error('manifest_load_error', { path: manifestPath, error: err.message });
  }

  if (approved === null) {
    logger.info('no_approved_manifest', { path: manifestPath });
    return { needsApproval: true, driftDiffs: [], approved };
  }

  const comparison = compareWorkflowManifests(candidate, approved);
  if (comparison.matches) {
    const reviewEachTimeReason = formatReviewEachTimeReason(candidate.workflow);
    if (reviewEachTimeReason) {
      logger.info('workflow_review_each_time_reapproval', {
        manifestPath,
        reviewEachTimeInputs: reviewEachTimeReason,
      });
      return { needsApproval: true, driftDiffs: [], approved, reviewEachTimeReason };
    }
    logger.info('manifest_matches', { workflowHash: candidate.workflowHash });
    return { needsApproval: false, driftDiffs: [], approved };
  }

  logger.warn('drift_detected', { diffs: comparison.diffs });
  return { needsApproval: true, driftDiffs: comparison.diffs, approved, reviewEachTimeReason: null };
}

// ---------------------------------------------------------------------------
// Phase C: Approval flow
// ---------------------------------------------------------------------------

async function handleApproval(candidate, manifestPath, driftDiffs, approved, riskAssessment, {
  nonInteractive,
  jsonOutput,
  logger,
  stateDir,
  state,
  runId,
  resultOpts,
  reviewEachTimeReason = null,
}) {
  if (nonInteractive) {
    return handleNonInteractiveApproval(approved, driftDiffs, candidate, {
      logger,
      stateDir,
      state,
      runId,
      resultOpts,
      jsonOutput,
      reviewEachTimeReason,
    });
  }

  if (!process.stdin.isTTY) {
    logger.error('unsupported_no_tty', { message: 'Interactive approval needed but stdin is not a TTY' });
    resultOpts.terminalReason = 'Interactive approval required but stdin is not a TTY.';
    const result = buildResult(runId, 'unsupported', resultOpts);
    state.terminalReason = resultOpts.terminalReason;
    persistStateSafe(stateDir, state);
    return result;
  }

  return handleInteractiveApproval(candidate, manifestPath, driftDiffs, riskAssessment, { jsonOutput, logger, stateDir, state, runId, resultOpts });
}

function handleNonInteractiveApproval(approved, driftDiffs, candidate, {
  logger,
  stateDir,
  state,
  runId,
  resultOpts,
  jsonOutput,
  reviewEachTimeReason = null,
}) {
  if (approved === null) {
    logger.error('non_interactive_no_manifest');
    resultOpts.terminalReason = 'No approved manifest found. Run interactively to approve.';
    state.terminalReason = resultOpts.terminalReason;
    persistStateSafe(stateDir, state);
    return buildResult(runId, 'approval_required', resultOpts);
  }

  const reason = driftDiffs.length > 0
    ? 'Workflow drift detected in non-interactive mode.'
    : reviewEachTimeReason;

  if (reason && !driftDiffs.length && approved) {
    logger.error('non_interactive_review_each_time_blocked', { reason });
    resultOpts.terminalReason = reason;
    state.terminalReason = resultOpts.terminalReason;
    persistStateSafe(stateDir, state);
    return buildResult(runId, 'approval_required', resultOpts);
  }

  // Generate negotiation request for agent consumption
  const negState = createNegotiationState(approved);
  const issues = detectIssues(candidate, approved);
  const negotiationRequest = generateNegotiationRequest(issues, negState);

  logger.error('non_interactive_drift', { diffs: driftDiffs, negotiation: negotiationRequest });
  resultOpts.terminalReason = reason;
  state.terminalReason = resultOpts.terminalReason;
  persistStateSafe(stateDir, state);
  if (!jsonOutput) printWorkflowDrift(formatDriftsForPrint(driftDiffs));

  const result = buildResult(runId, 'drift_detected', resultOpts);
  result.negotiationRequest = negotiationRequest;
  return result;
}

async function handleInteractiveApproval(candidate, manifestPath, driftDiffs, riskAssessment, { jsonOutput, logger, stateDir, state, runId, resultOpts }) {
  if (!jsonOutput) {
    printBanner();
    if (driftDiffs.length > 0) printWorkflowDrift(formatDriftsForPrint(driftDiffs));
    printWorkflowApprovalSummary(candidate.workflow, riskAssessment);
  }

  const userApproved = await promptApproval(riskAssessment.riskLevel);

  if (!userApproved) {
    logger.info('approval_denied', { riskLevel: riskAssessment.riskLevel });
    resultOpts.terminalReason = 'Workflow approval denied by user.';
    state.terminalReason = resultOpts.terminalReason;
    persistStateSafe(stateDir, state);
    if (!jsonOutput) printDenied();
    return buildResult(runId, 'approval_denied', resultOpts);
  }

  logger.info('approval_granted', { riskLevel: riskAssessment.riskLevel });
  candidate.riskAssessment.acknowledgedBy = 'interactive_user';
  candidate.riskAssessment.acknowledgedAt = new Date().toISOString();

  try {
    saveManifest(candidate, manifestPath);
    logger.info('manifest_saved', { path: manifestPath });
  } catch (err) {
    logger.error('manifest_save_error', { path: manifestPath, error: err.message });
    resultOpts.terminalReason = 'Failed to save approved manifest.';
    state.terminalReason = resultOpts.terminalReason;
    persistStateSafe(stateDir, state);
    return buildResult(runId, 'internal_error', resultOpts);
  }

  return null; // null means approved — proceed to execution
}

// ---------------------------------------------------------------------------
// Step execution — pure dispatch functions
// ---------------------------------------------------------------------------

async function executeServiceStep(stepDef, workflow, serviceRegistry, logger) {
  const serviceDef = (workflow.services || []).find(s => s.id === stepDef.serviceId);

  switch (stepDef.type) {
    case 'service_start': {
      if (!serviceDef) {
        logger.error('service_not_found', { serviceId: stepDef.serviceId });
        return { outcome: 'failure' };
      }
      const result = await serviceRegistry.startService(serviceDef);
      if (!result.success) {
        logger.warn('service_start_failed', { serviceId: stepDef.serviceId, error: result.error });
        return { outcome: 'failure' };
      }
      logger.info('service_started', { serviceId: stepDef.serviceId });
      return { outcome: 'success' };
    }

    case 'service_stop': {
      const result = await serviceRegistry.stopService(stepDef.serviceId);
      if (!result.success) {
        logger.warn('service_stop_failed', { serviceId: stepDef.serviceId, error: result.error });
        return { outcome: 'failure' };
      }
      logger.info('service_stopped', { serviceId: stepDef.serviceId });
      return { outcome: 'success' };
    }

    case 'service_restart': {
      const result = await serviceRegistry.restartService(stepDef.serviceId, serviceDef);
      if (!result.success) {
        logger.warn('service_restart_failed', { serviceId: stepDef.serviceId, error: result.error });
        return { outcome: 'failure' };
      }
      logger.info('service_restarted', { serviceId: stepDef.serviceId });
      return { outcome: 'success' };
    }

    default:
      return { outcome: 'failure' };
  }
}

async function executeTaskStep(stepDef, stepId, ctx, runtimeArgs, runtimeState = {}) {
  const { logger } = ctx;
  let { iteration } = ctx;

  const contract = createContract({
    command:   stepDef.run.command,
    args:      runtimeArgs ?? (stepDef.run.args || []),
    cwd:       stepDef.run.cwd,
    mode:      stepDef.run.mode || 'structured',
    timeoutMs: stepDef.run.timeoutMs,
    envPolicy: stepDef.run.envPolicy,
  });

  // File provenance check
  const fileHashCheck = verifyFileHash(contract.command, contract.fileHash);
  if (!fileHashCheck.skipped && !fileHashCheck.verified) {
    logger.error('file_hash_mismatch', { stepId, path: fileHashCheck.path, expected: fileHashCheck.expected, actual: fileHashCheck.actual });
    return { outcome: 'failure', iteration, terminalReason: `File hash mismatch for ${fileHashCheck.path ?? contract.command}` };
  }

  // Resolve validator mode: stepDef.validator can be a string ('exit_code'/'ndjson')
  // or an object ({ regex: "..." }). For launchWorker we need the string mode.
  const stepValidator = stepDef.validator;
  const validatorMode = (typeof stepValidator === 'string') ? stepValidator : 'exit_code';
  const timeoutMs = stepDef.run.timeoutMs || 60000;

  let workerResult;
  try {
    workerResult = await launchWorker(contract, { timeoutMs, validatorMode });
  } catch (err) {
    logger.error('worker_launch_error', { stepId, error: err.message });
    return { outcome: 'failure', iteration, terminalReason: `Worker launch failed: ${err.message}` };
  }

  if (workerResult.timedOut) {
    logger.warn('worker_timeout', { stepId, timeoutMs });
    return { outcome: 'failure', iteration, terminalReason: `Step "${stepId}" timed out after ${timeoutMs}ms` };
  }

  // Check for interactive prompt attempt on non-zero exit
  if (workerResult.exitCode !== 0) {
    const interactiveCheck = detectInteractiveAttempt(workerResult);
    if (interactiveCheck.detected) {
      logger.warn('interactive_prompt_detected', { stepId, pattern: interactiveCheck.pattern, exitCode: workerResult.exitCode });
      return {
        outcome: 'failure',
        iteration,
        terminalReason: `Interactive prompt detected in step "${stepId}" (pattern: "${interactiveCheck.pattern}"). Process was spawned without a TTY and cannot receive interactive input.`,
      };
    }
  }

  const validation = validateResult(workerResult, validatorMode);
  logger.info('task_validation', { stepId, valid: validation.valid, status: validation.status });

  if (validation.valid && validation.status === 'success') {
    // Apply regex validator if step declares one (object form with .regex)
    if (typeof stepValidator === 'object' && stepValidator?.regex) {
      const re = new RegExp(stepValidator.regex);
      if (!re.test(workerResult.stdout)) {
        logger.warn('step_validator_regex_failed', { stepId, regex: stepValidator.regex });
        return { outcome: 'validation_failed', iteration, terminalReason: null };
      }
    }
    const publishResult = publishSharedOutputs(stepDef, {
      protocolMessages: workerResult.protocolMessages ?? [],
      validationStatus: validation.status,
      exitCode: workerResult.exitCode,
    }, runtimeState, stepId);

    if (publishResult.terminalReason) {
      return { outcome: 'validation_failed', iteration, terminalReason: publishResult.terminalReason };
    }

    return {
      outcome: 'success',
      iteration,
      terminalReason: null,
      executionContext: {
        protocolMessages: workerResult.protocolMessages ?? [],
        validationStatus: validation.status,
        exitCode: workerResult.exitCode,
      },
    };
  }

  if (validation.status === 'update_requested' && validation.updateProposal) {
    return handleUpdateProposal(
      validation.updateProposal,
      contract,
      stepDef,
      stepId,
      ctx,
      iteration,
      runtimeArgs ?? (stepDef.run.args || []),
      runtimeState,
    );
  }

  if (validation.status === 'validation_failed') {
    logger.warn('task_validation_failed', { stepId });
    return { outcome: 'validation_failed', iteration, terminalReason: null };
  }

  if (validation.status === 'protocol_error') {
    logger.error('task_protocol_error', { stepId, errors: validation.errors });
    return { outcome: 'failure', iteration, terminalReason: `Protocol error in step "${stepId}"` };
  }

  return { outcome: 'failure', iteration, terminalReason: `Unknown validation status: ${validation.status}` };
}

async function executeRecipeRefStep(stepDef, stepId, ctx, runtimeState) {
  const {
    logger,
    workflow,
    recipeSearchDirs,
    auditLog,
    runId,
    workflowHash,
    stateDir,
  } = ctx;

  const inputHashCheck = verifyRecipeInputContentHashes(stepDef.recipeRef?.inputContentHashes);
  if (!inputHashCheck.verified) {
    const reason = inputHashCheck.errors.join('; ');
    logger.warn('recipe_ref_input_drift', { stepId, reason });
    return { outcome: 'failure', terminalReason: `Recipe input file drift detected for step "${stepId}": ${reason}` };
  }

  let resolvedRecipe;
  try {
    resolvedRecipe = resolveRecipeById(stepDef.recipeRef.specifier, recipeSearchDirs);
  } catch (err) {
    logger.error('recipe_ref_resolution_error', { stepId, error: err.message });
    return { outcome: 'failure', terminalReason: `Recipe resolution failed for step "${stepId}": ${err.message}` };
  }

  const currentHash = hashRecipe(resolvedRecipe.recipe);
  if (resolvedRecipe.version !== stepDef.recipeRef.resolvedVersion || currentHash !== stepDef.recipeRef.recipeHash) {
    logger.warn('recipe_ref_drift_detected', {
      stepId,
      expectedVersion: stepDef.recipeRef.resolvedVersion,
      actualVersion: resolvedRecipe.version,
      expectedHash: stepDef.recipeRef.recipeHash,
      actualHash: currentHash,
    });
    return {
      outcome: 'failure',
      terminalReason: `Recipe reference drift detected for step "${stepId}". Re-approve the workflow.`,
    };
  }

  const expectedTrust = stepDef.recipeRef?.trust;
  const currentTrust = classifyTrust(resolvedRecipe.recipe);
  const boundaryExpected = {};
  const boundaryActual = {};
  if (stepDef.recipeRef?.channel !== undefined) {
    boundaryExpected.channel = stepDef.recipeRef.channel;
    boundaryActual.channel = currentTrust.channel;
  }
  if (Object.prototype.hasOwnProperty.call(stepDef.recipeRef || {}, 'signature')) {
    boundaryExpected.signature = stepDef.recipeRef.signature ?? null;
    boundaryActual.signature = resolvedRecipe.recipe.signature ?? null;
  }
  if (expectedTrust?.channel !== undefined) {
    boundaryExpected.trust_channel = expectedTrust.channel;
    boundaryActual.trust_channel = currentTrust.channel;
  }
  if (expectedTrust?.verified !== undefined) {
    boundaryExpected.trust_verified = expectedTrust.verified;
    boundaryActual.trust_verified = currentTrust.verified;
  }

  const trustMismatch = formatRecipeRefBoundaryMismatch(boundaryExpected, boundaryActual);
  if (trustMismatch) {
    logger.warn('recipe_ref_trust_boundary_mismatch', { stepId, expected: boundaryExpected, actual: boundaryActual });
    return {
      outcome: 'failure',
      terminalReason: `recipe_ref trust boundary mismatch for step "${stepId}": ${trustMismatch}. Re-approve the workflow and review trust settings.`,
    };
  }

  const templateInputResult = resolveRecipeInputs(stepDef.recipeRef.templateInputs || {}, runtimeState, stepId);
  if (templateInputResult.terminalReason) {
    return { outcome: 'validation_failed', terminalReason: templateInputResult.terminalReason };
  }

  const resolvedInputs = {
    ...(stepDef.recipeRef.resolvedInputs || {}),
    ...(templateInputResult.resolvedInputs || {}),
  };

  let recipeInputs;
  try {
    const inputResult = resolveInputs(resolvedRecipe.recipe, resolvedInputs, { execution_shape: 'structured' });
    recipeInputs = inputResult.resolved;
  } catch (err) {
    return { outcome: 'validation_failed', terminalReason: `Recipe input validation failed for step "${stepId}": ${err.message}` };
  }

  const execution = await executeRecipe(resolvedRecipe.recipe, recipeInputs, {
    allowUnverified: stepDef.recipeRef.allowUnverified ?? false,
    cwd: workflow.projectRoot,
    stateDir,
    approved: true,
    traceId: runId,
    auditLog,
    manifestHash: workflowHash,
  });

  if (execution.status === 'success') {
    const publishResult = publishSharedOutputs(stepDef, {
      status: execution.status,
      stepsExecuted: execution.stepsExecuted,
      reason: execution.reason,
      results: execution.results,
    }, runtimeState, stepId);

    if (publishResult.terminalReason) {
      return { outcome: 'validation_failed', terminalReason: publishResult.terminalReason };
    }

    logger.info('recipe_ref_completed', { stepId, recipeId: resolvedRecipe.recipe.id, recipeVersion: resolvedRecipe.version });
    return { outcome: 'success' };
  }

  const reason = execution.reason || `Recipe step ended with status ${execution.status}`;
  logger.warn('recipe_ref_failed', { stepId, status: execution.status, reason });
  return { outcome: 'failure', terminalReason: reason };
}

async function handleUpdateProposal(proposal, contract, stepDef, stepId, ctx, iteration, runtimeArgs, runtimeState) {
  const { logger, jsonOutput, maxIterations } = ctx;

  logger.info('update_proposed', { stepId, action: proposal.proposedUpdate?.action });

  const proposalCheck = validateUpdateProposal(proposal, contract);
  if (!proposalCheck.allowed) {
    const decision = buildOutOfScopeUpdateDecision(proposalCheck);
    logger.warn('update_requires_reapproval', { stepId, reasons: decision.reasons });
    if (!jsonOutput) printWorkflowDrift(decision.reasons.map(r => ({ description: r })));
    return { outcome: 'failure', iteration, terminalReason: decision.message };
  }

  logger.info('update_executing', { stepId, command: proposal.proposedUpdate?.command });

  let updateResult;
  try {
    const pu = proposal.proposedUpdate;
    updateResult = await executeSubprocess(pu.command, pu.args, pu.cwd || stepDef.run?.cwd);
  } catch (err) {
    logger.error('update_execution_error', { stepId, error: err.message });
    return { outcome: 'failure', iteration, terminalReason: `Update execution failed: ${err.message}` };
  }

  if (!updateResult.success) {
    logger.warn('update_failed', { stepId, error: updateResult.error });
    return { outcome: 'failure', iteration, terminalReason: `Update failed: ${updateResult.error}` };
  }

  if (iteration < maxIterations) {
    iteration += 1;
    return executeTaskStep(stepDef, stepId, { ...ctx, iteration }, runtimeArgs, runtimeState);
  }

  return { outcome: 'failure', iteration, terminalReason: `Max iterations reached during update cycle for step "${stepId}"` };
}

// ---------------------------------------------------------------------------
// Transition resolution (pure)
// ---------------------------------------------------------------------------

function resolveTransition(stepDef, outcome, stepMap, logger) {
  const nextStep = stepDef.on?.[outcome];

  if (nextStep === undefined || nextStep === null) {
    logger.error('missing_transition', { stepId: stepDef.id, outcome });
    return { terminal: true, status: 'internal_error', reason: `No transition defined for outcome "${outcome}" on step "${stepDef.id}"` };
  }

  if (nextStep === 'done') {
    return { terminal: true, status: 'success', reason: null };
  }

  if (nextStep === 'abort') {
    const status = outcome === 'success' ? 'internal_error' : 'validation_failed';
    return { terminal: true, status, reason: `Workflow aborted after step "${stepDef.id}" with outcome "${outcome}"` };
  }

  if (!stepMap.has(nextStep) && !TERMINAL_STATES.has(nextStep)) {
    logger.error('unknown_transition_target', { stepId: stepDef.id, target: nextStep });
    return { terminal: true, status: 'internal_error', reason: `Transition target "${nextStep}" does not exist` };
  }

  return { terminal: false, nextStep };
}

// ---------------------------------------------------------------------------
// Phase D-pre: Rollback execution
// ---------------------------------------------------------------------------

async function executeRollbackSteps(rollbackSteps, logger, jsonOutput) {
  if (!rollbackSteps || rollbackSteps.length === 0) return false;

  logger.info('rollback_start', { stepCount: rollbackSteps.length });
  if (!jsonOutput) printStepProgress('  Running rollback...', 'rollback', 'running');

  for (const step of rollbackSteps) {
    logger.info('rollback_step', { stepId: step.id });

    const contract = createContract({
      command:   step.run.command,
      args:      step.run.args || [],
      cwd:       step.run.cwd,
      mode:      step.run.mode || 'structured',
      timeoutMs: step.run.timeoutMs,
      envPolicy: step.run.envPolicy,
    });

    try {
      const workerResult = await launchWorker(contract, {
        timeoutMs: step.run.timeoutMs || 60000,
        validatorMode: 'exit_code',
      });

      const validation = validateResult(workerResult, 'exit_code');

      if (!validation.valid) {
        logger.warn('rollback_step_failed', { stepId: step.id, exitCode: validation.exitCode });
        if (!jsonOutput) printStepProgress(`  Rollback step "${step.id}"`, 'rollback', 'failed');
        // I-W9: Rollback step failure is logged, subsequent rollback steps continue
      } else {
        logger.info('rollback_step_done', { stepId: step.id });
      }
    } catch (err) {
      logger.warn('rollback_step_error', { stepId: step.id, error: err.message });
      if (!jsonOutput) printStepProgress(`  Rollback step "${step.id}"`, 'rollback', 'failed');
      // Continue with remaining rollback steps
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Phase D: Execution loop
// ---------------------------------------------------------------------------

async function executeWorkflow(workflow, {
  serviceRegistry, logger, jsonOutput, state, recipeSearchDirs,
  auditLog, runId, workflowHash, stateDir, progressSink,
}) {
  const stepMap = indexById(workflow.steps);
  const totalSteps = workflow.steps.length;
  let currentStep = workflow.entryStep;
  let iteration = 0;
  let stepsExecuted = 0;
  let failedStep = null;
  let finalStatus = 'success';
  let terminalReason = null;
  const runtimeState = {};

  logger.info('workflow_execution_start', { entryStep: currentStep, maxIterations: workflow.maxIterations });

  while (true) {
    if (iteration >= workflow.maxIterations) {
      failedStep = currentStep;
      finalStatus = 'internal_error';
      terminalReason = `Workflow did not converge within ${workflow.maxIterations} iterations`;
      logger.warn('convergence_abort', { maxIterations: workflow.maxIterations, lastStep: currentStep });
      break;
    }

    const stepDef = stepMap.get(currentStep);

    if (!stepDef) {
      logger.error('missing_step_definition', { stepId: currentStep });
      return { stepsExecuted, failedStep: currentStep, finalStatus: 'internal_error', terminalReason: `Step definition not found: ${currentStep}`, iteration };
    }

    iteration += 1;
    stepsExecuted += 1;
    state.currentStep = currentStep;
    state.iteration = iteration;

    logger.info('step_start', { stepId: currentStep, type: stepDef.type, iteration });
    emitProgress(progressSink, runId, 'step_started', {
      stepId: currentStep,
      stepType: stepDef.type,
      message: `Starting step "${currentStep}"`,
      attempt: iteration,
    });
    if (!jsonOutput) printStepProgress(`[step ${stepsExecuted}/${totalSteps}] ${currentStep}`, stepDef.type, 'running');

    let outcome = 'success';

    // Dispatch by step type
    const isServiceStep = ['service_start', 'service_stop', 'service_restart'].includes(stepDef.type);

    if (isServiceStep) {
      const svcResult = await executeServiceStep(stepDef, workflow, serviceRegistry, logger);
      state.serviceHandles = serviceRegistry.getState();
      outcome = svcResult.outcome;
    } else if (stepDef.type === 'recipe_ref') {
      const recipeResult = await executeRecipeRefStep(stepDef, currentStep, {
        logger, workflow, recipeSearchDirs, auditLog, runId, workflowHash, stateDir,
      }, runtimeState);
      outcome = recipeResult.outcome;
      if (recipeResult.terminalReason) terminalReason = recipeResult.terminalReason;
    } else if (stepDef.type === 'task') {
      const argsResult = resolveTaskArgs(stepDef.run.args, runtimeState);
      if (argsResult.terminalReason) {
        outcome = 'validation_failed';
        terminalReason = argsResult.terminalReason;
      } else {
        const taskResult = await executeTaskStep(
          stepDef,
          currentStep,
          { logger, jsonOutput, maxIterations: workflow.maxIterations, iteration },
          argsResult.resolvedArgs,
          runtimeState,
        );
        outcome = taskResult.outcome;
        iteration = taskResult.iteration;
        if (taskResult.terminalReason) terminalReason = taskResult.terminalReason;
      }
    } else {
      logger.error('unknown_step_type', { stepId: currentStep, type: stepDef.type });
      return { stepsExecuted, failedStep: currentStep, finalStatus: 'policy_violation', terminalReason: `Unknown step type: ${stepDef.type}`, iteration };
    }

    state.stepsExecuted.push({
      stepId: currentStep, type: stepDef.type, iteration, outcome, timestamp: new Date().toISOString(),
    });

    if (outcome === 'success') {
      emitProgress(progressSink, runId, 'step_completed', {
        stepId: currentStep,
        stepType: stepDef.type,
        stepResult: outcome,
        message: `Step "${currentStep}" completed`,
        attempt: iteration,
      });
      if (!jsonOutput) {
        printStepProgress(`[step ${stepsExecuted}/${totalSteps}] ${currentStep}`, stepDef.type, 'done');
      }
    } else {
      emitProgress(progressSink, runId, 'step_failed', {
        stepId: currentStep,
        stepType: stepDef.type,
        stepResult: outcome,
        message: `Step "${currentStep}" failed with outcome "${outcome}"`,
        attempt: iteration,
      });
      if (!jsonOutput) {
        printStepProgress(`[step ${stepsExecuted}/${totalSteps}] ${currentStep}`, stepDef.type, 'failed');
      }
    }

    if (!jsonOutput && outcome === 'success') {
      printStepProgress(`[step ${stepsExecuted}/${totalSteps}] ${currentStep}`, stepDef.type, 'done');
    } else if (!jsonOutput) {
      printStepProgress(`[step ${stepsExecuted}/${totalSteps}] ${currentStep}`, stepDef.type, 'failed');
    }

    // I-W4: Non-idempotent step failure forces rollback and abort
    if (outcome !== 'success' && !(stepDef.idempotent ?? false)) {
      failedStep = currentStep;
      finalStatus = 'validation_failed';
      terminalReason = terminalReason || `Non-idempotent step "${currentStep}" failed — rollback required`;
      emitProgress(progressSink, runId, 'step_blocked', {
        stepId: currentStep,
        stepType: stepDef.type,
        message: terminalReason,
        attempt: iteration,
      });
      logger.warn('non_idempotent_failure', { stepId: currentStep });
      break;
    }

    // Resolve transition
    const transition = resolveTransition(stepDef, outcome, stepMap, logger);

    if (transition.terminal) {
      finalStatus = transition.status;
      terminalReason = terminalReason || transition.reason;
      if (transition.status !== 'success') failedStep = currentStep;
      break;
    }

    currentStep = transition.nextStep;
  }

  // Execute rollback on non-success terminal state (I-W2, I-W9)
  const rollbackSteps = workflow.rollback?.steps ?? [];
  let rollbackRan = false;

  if (finalStatus !== 'success' && rollbackSteps.length > 0) {
    rollbackRan = await executeRollbackSteps(rollbackSteps, logger, jsonOutput);
  }

  return { stepsExecuted, failedStep, finalStatus, terminalReason, iteration, rollbackRan };
}

// ---------------------------------------------------------------------------
// Phase E: Cleanup and return
// ---------------------------------------------------------------------------

async function cleanupServices(serviceRegistry, logger, state) {
  if (!serviceRegistry) return;
  try {
    await serviceRegistry.cleanupAll();
    logger.info('services_cleaned_up');
  } catch (err) {
    logger.error('service_cleanup_error', { error: err.message });
  }
  state.serviceHandles = serviceRegistry.getState();
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runWorkflowSupervisor(options) {
  const {
    definitionPath,
    manifestPath: rawManifestPath,
    nonInteractive = false,
    jsonOutput     = false,
    progressSink   = null,
    allowUnverified = false,
    trustClass     = null,
  } = options;

  const runId = generateRunId();
  const stateDir = resolve(dirname(resolve(definitionPath)), '.guardrail');
  const logDir = resolve(stateDir, 'logs');
  const logger = createLogger(runId, logDir);
  const manifestPath = resolve(rawManifestPath);

  const resultOpts = {
    workflowHash: '', manifestPath, riskLevel: '', riskReasons: [],
    attempt: 0, stepsExecuted: 0, failedStep: null, terminalReason: null, rollbackRan: false,
  };

  const state = makeEmptyState(runId);

  logger.info('workflow_supervisor_start', { definitionPath, manifestPath, nonInteractive, jsonOutput });

  let serviceRegistry = null;
  let lockRelease = null;

  try {
    // Phase A: Load and prepare
    let prepared;
    try {
      prepared = loadAndPrepare(definitionPath, trustClass, logger, {
        allowUnverified,
        recipeSearchDirs: options.recipeSearchDirs,
      });
    } catch (err) {
      logger.error('definition_load_error', { path: definitionPath, error: err.message });
      persistStateSafe(stateDir, state);
      resultOpts.terminalReason = `Failed to load workflow definition: ${err.message}`;
      state.terminalReason = resultOpts.terminalReason;
      persistStateSafe(stateDir, state);
      const result = buildResult(runId, 'internal_error', resultOpts);
      emitExecutionEnd(progressSink, runId, result.status, {
        message: resultOpts.terminalReason,
      });
      return result;
    }

    const { workflow, workflowHash, riskAssessment } = prepared;
    const recipeSearchDirs = buildWorkflowRecipeSearchDirs(
      workflow.projectRoot,
      dirname(resolve(definitionPath)),
      options.recipeSearchDirs,
    );
    state.workflowName = workflow.name;
    state.currentStep = workflow.entryStep;
    resultOpts.workflowHash = workflowHash;
    resultOpts.riskLevel = riskAssessment.riskLevel;
    resultOpts.riskReasons = riskAssessment.reasons;

    // Phase B: Manifest comparison
    const candidate = createWorkflowManifest(workflow, workflowHash, riskAssessment, workflow.projectRoot);
    const {
      needsApproval,
      driftDiffs,
      approved,
      reviewEachTimeReason = null,
    } = compareAgainstApproved(candidate, manifestPath, logger);

    // Non-interactive reuse must come from a previously acknowledged Guardrail
    // approval record, not just a matching file on disk.
    if (nonInteractive && approved !== null && !needsApproval) {
      if (!approved.riskAssessment?.acknowledgedBy) {
        logger.error('non_interactive_unacknowledged_risk', { path: manifestPath });
        resultOpts.terminalReason = 'Approved workflow manifest has no acknowledged risk assessment. Run interactively first.';
        emitProgress(progressSink, runId, 'approval_pending', {
          workflowName: workflow.name,
          message: resultOpts.terminalReason,
          reason: resultOpts.terminalReason,
        });
        state.terminalReason = resultOpts.terminalReason;
        persistStateSafe(stateDir, state);
        const result = buildResult(runId, 'approval_required', resultOpts);
        emitExecutionEnd(progressSink, runId, result.status, { workflowName: workflow.name, message: resultOpts.terminalReason });
        return result;
      }
    }

    // Phase C: Approval
    if (needsApproval) {
      emitProgress(progressSink, runId, 'approval_pending', {
        workflowName: workflow.name,
        reason:
          driftDiffs.length > 0
            ? 'Workflow approval required: workflow drift detected.'
            : 'Workflow approval required.',
        message:
          driftDiffs.length > 0
            ? 'Workflow drift detected.'
            : reviewEachTimeReason ?? 'Workflow review required.',
      });
      const approvalResult = await handleApproval(candidate, manifestPath, driftDiffs, approved, riskAssessment, {
        nonInteractive,
        jsonOutput,
        logger,
        stateDir,
        state,
        runId,
        resultOpts,
        reviewEachTimeReason: reviewEachTimeReason,
      });
      if (approvalResult !== null) {
        emitExecutionEnd(progressSink, runId, approvalResult.status, {
          workflowName: workflow.name,
          message: approvalResult.terminalReason || 'Workflow did not pass approval gate.',
          stepsExecuted: approvalResult.stepsExecuted ?? 0,
        });
        return approvalResult;
      }
    }

    // Phase D-pre: Runtime policy — time limits and concurrency lock
    emitProgress(progressSink, runId, 'execution_start', {
      workflowName: workflow.name,
      message: 'Workflow execution started',
      stepsExecuted: 0,
    });

    const runtimeLimits = options.runtimeLimits ?? null;
    const auditLog = createAuditLog(resolve(stateDir, 'audit.jsonl'));

    if (runtimeLimits) {
      const timeCheck = checkTimePolicy(runtimeLimits, workflowHash, stateDir);
      if (!timeCheck.allowed) {
        const detail = timeCheck.errors.map(e => e.detail).join('; ');
        logger.error('time_policy_violated', { errors: timeCheck.errors });
        auditLog.append({ event: 'blocked', trace_id: runId, manifest_hash: workflowHash, reason: detail });
        resultOpts.terminalReason = `Time policy violated: ${detail}`;
        state.terminalReason = resultOpts.terminalReason;
        persistStateSafe(stateDir, state);
        const result = buildResult(runId, 'time_policy_violated', resultOpts);
        emitExecutionEnd(progressSink, runId, result.status, {
          workflowName: workflow.name,
          message: resultOpts.terminalReason,
          stepsExecuted: resultOpts.stepsExecuted,
        });
        return result;
      }
    }

    const lockResult = acquireLock(workflowHash, [], stateDir);
    if (!lockResult.acquired) {
      logger.error('concurrent_blocked', { detail: lockResult.detail });
      auditLog.append({ event: 'blocked', trace_id: runId, manifest_hash: workflowHash, reason: lockResult.detail });
      resultOpts.terminalReason = `Concurrent execution blocked: ${lockResult.detail}`;
      state.terminalReason = resultOpts.terminalReason;
      persistStateSafe(stateDir, state);
      const result = buildResult(runId, 'concurrent_blocked', resultOpts);
      emitExecutionEnd(progressSink, runId, result.status, {
        workflowName: workflow.name,
        message: resultOpts.terminalReason,
        stepsExecuted: resultOpts.stepsExecuted,
      });
      return result;
    }
    lockRelease = lockResult.release;

    auditLog.append({ event: 'execution_start', trace_id: runId, manifest_hash: workflowHash });

    // Phase D: Execute workflow
    serviceRegistry = createServiceRegistry(workflow.services || []);

    const execResult = await executeWorkflow(workflow, {
      serviceRegistry, logger, jsonOutput, state, recipeSearchDirs, auditLog, runId, workflowHash, stateDir,
      progressSink,
    });

    resultOpts.attempt = execResult.stepsExecuted;
    resultOpts.stepsExecuted = execResult.stepsExecuted;
    resultOpts.failedStep = execResult.failedStep;
    resultOpts.terminalReason = execResult.terminalReason;
    resultOpts.rollbackRan = execResult.rollbackRan ?? false;

    // Phase E: Cleanup — release lock, audit, services
    if (lockRelease) lockRelease();
    auditLog.append({
      event: execResult.finalStatus === 'success' ? 'execution_end' : 'execution_failed',
      trace_id: runId, manifest_hash: workflowHash, status: execResult.finalStatus,
    });

    await cleanupServices(serviceRegistry, logger, state);
    state.terminalReason = execResult.terminalReason;
    persistStateSafe(stateDir, state);

    const result = buildResult(runId, execResult.finalStatus, resultOpts);
    emitExecutionEnd(progressSink, runId, result.status, {
      workflowName: workflow.name,
      message: result.terminalReason || `Workflow finished with status ${result.status}`,
      stepsExecuted: result.stepsExecuted,
    });

    if (!jsonOutput) {
      printWorkflowResult({
        success: execResult.finalStatus === 'success',
        failedStep: execResult.failedStep,
        reason: execResult.terminalReason,
        stepsExecuted: execResult.stepsExecuted,
        servicesStarted: (workflow.services || []).length,
        totalIterations: execResult.iteration,
      });
    }

    logger.info('workflow_supervisor_end', { status: execResult.finalStatus, exitCode: result.exitCode });
    return result;

  } catch (err) {
    logger.error('workflow_supervisor_crash', { error: err.message, stack: err.stack });
    try { if (lockRelease) lockRelease(); } catch { /* ignore */ }
    await cleanupServices(serviceRegistry, logger, state);
    resultOpts.terminalReason = `Internal error: ${err.message}`;
    state.terminalReason = resultOpts.terminalReason;
    persistStateSafe(stateDir, state);
    const result = buildResult(runId, 'internal_error', resultOpts);
    emitExecutionEnd(progressSink, runId, result.status, {
      workflowName: null,
      message: result.terminalReason,
      stepsExecuted: resultOpts.stepsExecuted,
    });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Negotiation round handler — for agent delta submissions
// ---------------------------------------------------------------------------

/**
 * Process an agent-submitted delta against a negotiation state.
 *
 * @param {object} negState - Negotiation state from createNegotiationState().
 * @param {object} delta    - Agent-proposed manifest delta.
 * @param {object} [opts]   - Options: { workflowStarted, agentSigned }.
 * @returns {{ accepted: boolean, negotiationRequest: object|null, escalation: object|null, negState: object }}
 */
export function negotiateWorkflowDelta(negState, delta, opts = {}) {
  // Hard block: agent attempted to sign
  if (delta.signature || delta.approved_by) {
    const issues = detectIssues(
      { workflow: delta.workflow ?? {}, riskAssessment: delta.riskAssessment ?? {} },
      negState.originalManifest,
      { agentSigned: true, ...opts },
    );
    const escalation = buildEscalationPackage(negState, issues, 'Agent attempted to sign manifest');
    return { accepted: false, negotiationRequest: null, escalation, negState };
  }

  const result = applyDelta(delta, negState);

  if (result.accepted) {
    return { accepted: true, negotiationRequest: null, escalation: null, negState: result.negState };
  }

  // Generate next negotiation request or escalation
  const hasHardBlock = result.issues.some(i => !i.self_resolvable);
  const isExhausted = result.negState.terminated;

  if (hasHardBlock || isExhausted) {
    const reason = isExhausted
      ? `Negotiation exhausted after ${result.negState.maxRounds} rounds`
      : `Hard block: ${result.issues.filter(i => !i.self_resolvable).map(i => i.code).join(', ')}`;
    const escalation = buildEscalationPackage(result.negState, result.issues, reason);
    return { accepted: false, negotiationRequest: null, escalation, negState: result.negState };
  }

  const request = generateNegotiationRequest(result.issues, result.negState);
  return { accepted: false, negotiationRequest: request, escalation: null, negState: result.negState };
}
