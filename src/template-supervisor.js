import { resolve, dirname } from 'node:path';

import {
  loadTemplate,
  validateUserInputs,
  buildResolvedSteps,
  buildResolvedRollbackSteps,
  computeEnvIntersection,
  hashTemplateExecution,
  createTemplateManifest,
  compareTemplateManifests,
  evaluateTemplateRisk,
} from './template.js';
import { saveManifest, loadManifest } from './manifest.js';
import {
  createLogger,
  printBanner,
  printDenied,
  printResult,
  generateRunId,
  colorize,
} from './logger.js';
import { launchWorker, detectInteractiveAttempt } from './worker-interface.js';
import { validateResult } from './validator.js';
import { createContract, verifyFileHash } from './contract.js';
import { promptApproval, STATUS_EXIT_CODES } from './supervisor.js';
import { persistStateSafe, buildEnvFromPolicy } from './shared.js';
import { checkTimePolicy, acquireLock } from './runtime-policy.js';
import { createAuditLog } from './audit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResult(runId, status, opts = {}) {
  return {
    runId,
    status,
    templateName:   opts.templateName   ?? '',
    templateHash:   opts.templateHash   ?? '',
    manifestPath:   opts.manifestPath   ?? '',
    riskLevel:      opts.riskLevel      ?? '',
    riskReasons:    opts.riskReasons    ?? [],
    stepsExecuted:  opts.stepsExecuted  ?? 0,
    failedStep:     opts.failedStep     ?? null,
    rollbackRan:    opts.rollbackRan    ?? false,
    exitCode:       STATUS_EXIT_CODES[status] ?? STATUS_EXIT_CODES.internal_error,
  };
}

function makeState(runId, templateName) {
  return {
    runId,
    kind: 'template',
    templateName,
    stepsExecuted: [],
    rollbackSteps: [],
    terminalReason: null,
  };
}

function formatDiffs(diffs) {
  return diffs.map(d => typeof d === 'string' ? { description: d } : d);
}

// ---------------------------------------------------------------------------
// Terminal output helpers for template-specific display
// ---------------------------------------------------------------------------

function printTemplateSummary(def, riskAssessment, envResult) {
  const line = (text = '') => process.stdout.write(text + '\n');
  const sep = () => line(colorize('─'.repeat(56), 'dim'));
  const lv = (label, value) => {
    const padded = (label + ':').padEnd(20);
    return `  ${colorize(padded, 'dim')} ${value}`;
  };

  line();
  line(colorize('  Template Summary', 'bold'));
  sep();

  line(lv('Template', def.name));
  line(lv('Kind', def.kind === 'template' ? 'single command' : 'multi-step workflow'));
  line(lv('Description', def.description));

  if (def.kind === 'template') {
    line(lv('Command', def.run.command));
  } else {
    const steps = (def.steps || []).map(s => s.id).join(' → ');
    line(lv('Steps', steps));
  }

  if (envResult.intersection.length > 0) {
    line(lv('Env vars passed', envResult.intersection.join(', ')));
  }
  if (envResult.denied.length > 0) {
    line(lv('Env vars denied', envResult.denied.join(', ')));
  }

  sep();

  if (riskAssessment) {
    const riskColor = { green: 'green', yellow: 'yellow', red: 'red' };
    line(lv('Trust class', riskAssessment.trustClass));
    line(lv('Risk level', colorize(riskAssessment.riskLevel.toUpperCase(), riskColor[riskAssessment.riskLevel] || 'red')));
    if (riskAssessment.reasons.length > 0) {
      line(lv('Risk reasons', ''));
      for (const reason of riskAssessment.reasons) {
        line(`                       ${colorize('- ' + reason, 'yellow')}`);
      }
    }
    sep();
  }

  line();
  line(colorize('  You are responsible for approving this template execution.', 'bold'));
  line(colorize('  Guardrail highlights risk; it does not certify safety.', 'dim'));
  line();
}

function printTemplateDrift(diffs) {
  const line = (text = '') => process.stdout.write(text + '\n');

  line();
  line(colorize('  Template drift detected', 'yellow'));
  line();

  if (diffs.length > 0) {
    line(colorize('  Changes:', 'bold'));
    for (const diff of diffs) {
      const desc = diff.description || String(diff);
      if (desc.startsWith('+')) line(colorize(`  ${desc}`, 'green'));
      else if (desc.startsWith('-')) line(colorize(`  ${desc}`, 'red'));
      else if (desc.startsWith('~')) line(colorize(`  ${desc}`, 'cyan'));
      else line(`  ${desc}`);
    }
  }

  line();
  line(colorize('  Run `guardrail template diff` to review, then re-approve.', 'yellow'));
  line();
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

async function executeStep(step, envIntersection, cwd, logger) {
  // Build env policy: only pass intersection vars
  const envPolicy = {
    inherit: false,
    allow: envIntersection,
    inject: {},
  };

  // If step declares its own env.allow, further intersect
  if (step.run.env?.allow) {
    const stepAllow = new Set(step.run.env.allow);
    envPolicy.allow = envIntersection.filter(k => stepAllow.has(k));
  }

  const contract = createContract({
    command: step.run.command,
    args: step.run.args || [],
    cwd,
    mode: 'structured',
    envPolicy,
  });

  // File provenance check
  const fileHashCheck = verifyFileHash(contract.command, contract.fileHash);
  if (!fileHashCheck.skipped && !fileHashCheck.verified) {
    logger.error('file_hash_mismatch', { stepId: step.id, path: fileHashCheck.path, expected: fileHashCheck.expected, actual: fileHashCheck.actual });
    return { success: false, error: `File hash mismatch for ${fileHashCheck.path ?? contract.command}` };
  }

  let workerResult;
  try {
    workerResult = await launchWorker(contract, {
      timeoutMs: 60000,
      validatorMode: 'exit_code',
    });
  } catch (err) {
    logger.error('step_launch_error', { stepId: step.id, error: err.message });
    return { success: false, error: err.message };
  }

  if (workerResult.timedOut) {
    logger.warn('step_timeout', { stepId: step.id });
    return { success: false, error: 'Step timed out' };
  }

  // Anti-interactive detection
  if (workerResult.exitCode !== 0) {
    const interactiveCheck = detectInteractiveAttempt(workerResult);
    if (interactiveCheck.detected) {
      logger.warn('interactive_prompt_detected', { stepId: step.id, pattern: interactiveCheck.pattern });
      return { success: false, error: `Interactive prompt detected (pattern: "${interactiveCheck.pattern}")` };
    }
  }

  const validation = validateResult(workerResult, 'exit_code');
  logger.info('step_result', { stepId: step.id, valid: validation.valid, exitCode: validation.exitCode });

  // Optional validator regex
  if (validation.valid && step.validator?.regex) {
    const re = new RegExp(step.validator.regex);
    if (!re.test(workerResult.stdout)) {
      logger.warn('step_validator_failed', { stepId: step.id, regex: step.validator.regex });
      return { success: false, error: `Validator regex did not match output` };
    }
  }

  return {
    success: validation.valid,
    exitCode: validation.exitCode,
    stdout: workerResult.stdout,
    stderr: workerResult.stderr,
    error: validation.valid ? null : `Exit code ${validation.exitCode}`,
  };
}

// ---------------------------------------------------------------------------
// Rollback execution
// ---------------------------------------------------------------------------

async function executeRollback(rollbackSteps, envIntersection, cwd, logger, jsonOutput) {
  if (rollbackSteps.length === 0) return;

  logger.info('rollback_start', { stepCount: rollbackSteps.length });
  if (!jsonOutput) {
    process.stdout.write(colorize('\n  Running rollback...\n', 'yellow'));
  }

  for (const step of rollbackSteps) {
    logger.info('rollback_step', { stepId: step.id });
    const result = await executeStep(step, envIntersection, cwd, logger);
    if (!result.success) {
      logger.warn('rollback_step_failed', { stepId: step.id, error: result.error });
      if (!jsonOutput) {
        process.stdout.write(colorize(`  Rollback step "${step.id}" failed: ${result.error}\n`, 'red'));
      }
    } else {
      logger.info('rollback_step_done', { stepId: step.id });
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a template under Guardrail supervision.
 *
 * @param {object} options
 * @param {string} options.templatePath     - Path to the template JSON file.
 * @param {object} options.inputs           - Map of input key → value.
 * @param {string} [options.manifestPath]   - Custom approved manifest path.
 * @param {boolean} [options.nonInteractive] - Fail closed, no prompts.
 * @param {boolean} [options.jsonOutput]     - Emit JSON output.
 * @param {string[]} [options.envAllow]      - Caller's env allow list.
 * @returns {Promise<object>} Structured result.
 */
export async function runTemplateSupervisor(options) {
  const {
    templatePath,
    inputs       = {},
    manifestPath: rawManifestPath,
    nonInteractive = false,
    jsonOutput     = false,
    envAllow       = [],
  } = options;

  const runId = generateRunId();
  const basePath = dirname(resolve(templatePath));
  const stateDir = resolve(basePath, '.guardrail');
  const logDir = resolve(stateDir, 'logs');
  const logger = createLogger(runId, logDir);

  const resultOpts = {
    templateName: '', templateHash: '', manifestPath: '',
    riskLevel: '', riskReasons: [],
    stepsExecuted: 0, failedStep: null, rollbackRan: false,
  };

  logger.info('template_supervisor_start', { templatePath, nonInteractive, jsonOutput });

  let lockRelease = null;

  try {
    // ---- Load and validate template ----------------------------------------
    let def;
    try {
      def = loadTemplate(resolve(templatePath));
    } catch (err) {
      logger.error('template_load_error', { path: templatePath, error: err.message });
      if (!jsonOutput) {
        printResult({ success: false, exitCode: 1, message: err.message });
      }
      return buildResult(runId, 'internal_error', resultOpts);
    }

    resultOpts.templateName = def.name;
    const state = makeState(runId, def.name);

    // ---- Validate user inputs ----------------------------------------------
    const inputValidation = validateUserInputs(def.inputs, inputs);
    if (!inputValidation.valid) {
      const msg = `Input validation failed:\n  - ${inputValidation.errors.join('\n  - ')}`;
      logger.error('input_validation_failed', { errors: inputValidation.errors });
      if (!jsonOutput) {
        printResult({ success: false, exitCode: 1, message: msg });
      }
      return buildResult(runId, 'validation_failed', resultOpts);
    }

    for (const w of inputValidation.warnings) {
      logger.warn('input_warning', { warning: w });
    }

    // ---- Environment handshake ---------------------------------------------
    // Templates require an explicit caller allow-list for any required env.
    const requiredEnv = def.requires_env || [];
    if (requiredEnv.length > 0 && envAllow.length === 0) {
      const msg = [
        'Template requires explicit --env-allow for environment access.',
        `Required variables: ${requiredEnv.join(', ')}`,
      ].join('\n');
      logger.error('env_handshake_missing_allow', { required: requiredEnv });
      if (!jsonOutput) {
        printResult({ success: false, exitCode: 1, message: msg });
      }
      return buildResult(runId, 'policy_violation', resultOpts);
    }

    const envResult = computeEnvIntersection(requiredEnv, envAllow);

    if (envResult.denied.length > 0) {
      const msg = envResult.denied.map(v =>
        `Template requires ${v} but your env allow list does not include it.`
      ).join('\n');
      logger.error('env_handshake_denied', { denied: envResult.denied });
      if (!jsonOutput) {
        printResult({ success: false, exitCode: 1, message: msg });
      }
      return buildResult(runId, 'policy_violation', resultOpts);
    }

    for (const w of envResult.warnings) {
      logger.warn('env_warning', { warning: w });
    }

    // ---- Compute hash and risk ---------------------------------------------
    const templateHash = hashTemplateExecution(def, inputValidation.values, envResult.intersection);
    resultOpts.templateHash = templateHash;

    const riskAssessment = evaluateTemplateRisk(def, envResult.intersection);
    resultOpts.riskLevel = riskAssessment.riskLevel;
    resultOpts.riskReasons = riskAssessment.reasons;

    logger.info('template_hashed', { templateHash });
    logger.info('risk_evaluated', { riskLevel: riskAssessment.riskLevel, reasons: riskAssessment.reasons });

    // ---- Manifest comparison -----------------------------------------------
    const manifestPath = resolve(rawManifestPath || `.guardrail/templates/${def.name}.approved.json`);
    resultOpts.manifestPath = manifestPath;

    const candidate = createTemplateManifest(
      def, templateHash, riskAssessment,
      inputValidation.values, envResult.intersection,
    );

    let approved = null;
    try {
      approved = loadManifest(manifestPath);
    } catch (err) {
      logger.error('manifest_load_error', { path: manifestPath, error: err.message });
    }

    let needsApproval = false;
    let driftDiffs = [];

    if (approved === null) {
      needsApproval = true;
      logger.info('no_approved_manifest', { path: manifestPath });
    } else {
      const comparison = compareTemplateManifests(candidate, approved);
      if (comparison.matches) {
        logger.info('manifest_matches', { templateHash });
      } else {
        needsApproval = true;
        driftDiffs = comparison.diffs;
        logger.warn('drift_detected', { diffs: driftDiffs });
      }
    }

    // ---- Non-interactive: verify acknowledgement on matching manifest -------
    if (nonInteractive && approved !== null && !needsApproval) {
      if (!approved.riskAssessment?.acknowledgedBy) {
        logger.error('non_interactive_unacknowledged_risk', { path: manifestPath });
        if (!jsonOutput) {
          printResult({ success: false, exitCode: 10, message: 'Approved manifest has no acknowledged risk. Run interactively first.' });
        }
        return buildResult(runId, 'approval_required', resultOpts);
      }
    }

    // ---- Approval flow -----------------------------------------------------
    if (needsApproval) {
      if (nonInteractive) {
        if (approved === null) {
          logger.error('non_interactive_no_manifest');
          if (!jsonOutput) {
            printResult({ success: false, exitCode: 10, message: 'No approved manifest. Run interactively to approve.' });
          }
          return buildResult(runId, 'approval_required', resultOpts);
        }
        // Drift in non-interactive
        logger.error('non_interactive_drift', { diffs: driftDiffs });
        if (!jsonOutput) {
          printTemplateDrift(formatDiffs(driftDiffs));
          printResult({ success: false, exitCode: 12, message: 'Template drift detected in non-interactive mode.' });
        }
        return buildResult(runId, 'drift_detected', resultOpts);
      }

      if (!process.stdin.isTTY) {
        logger.error('unsupported_no_tty');
        if (!jsonOutput) {
          printResult({ success: false, exitCode: 17, message: 'Interactive approval needed but stdin is not a TTY.' });
        }
        return buildResult(runId, 'unsupported', resultOpts);
      }

      // Interactive approval
      if (!jsonOutput) {
        printBanner();
        if (driftDiffs.length > 0) printTemplateDrift(formatDiffs(driftDiffs));
        printTemplateSummary(def, riskAssessment, envResult);
      }

      const userApproved = await promptApproval(riskAssessment.riskLevel);

      if (!userApproved) {
        logger.info('approval_denied', { riskLevel: riskAssessment.riskLevel });
        if (!jsonOutput) printDenied();
        return buildResult(runId, 'approval_denied', resultOpts);
      }

      // Approved — save manifest
      logger.info('approval_granted');
      candidate.riskAssessment.acknowledgedBy = 'interactive_user';
      candidate.riskAssessment.acknowledgedAt = new Date().toISOString();

      try {
        saveManifest(candidate, manifestPath);
        logger.info('manifest_saved', { path: manifestPath });
      } catch (err) {
        logger.error('manifest_save_error', { path: manifestPath, error: err.message });
        if (!jsonOutput) {
          printResult({ success: false, exitCode: 19, message: 'Failed to save manifest.' });
        }
        return buildResult(runId, 'internal_error', resultOpts);
      }
    }

    // ---- Runtime policy: time limits and concurrency lock -------------------
    const runtimeLimits = options.runtimeLimits ?? null;
    const auditLog = createAuditLog(resolve(stateDir, 'audit.jsonl'));

    if (runtimeLimits) {
      const timeCheck = checkTimePolicy(runtimeLimits, templateHash, stateDir);
      if (!timeCheck.allowed) {
        const detail = timeCheck.errors.map(e => e.detail).join('; ');
        logger.error('time_policy_violated', { errors: timeCheck.errors });
        auditLog.append({ event: 'blocked', trace_id: runId, manifest_hash: templateHash, reason: detail });
        if (!jsonOutput) {
          printResult({ success: false, exitCode: STATUS_EXIT_CODES.time_policy_violated, message: `Time policy violated: ${detail}` });
        }
        return buildResult(runId, 'time_policy_violated', resultOpts);
      }
    }

    const lockResult = acquireLock(templateHash, [], stateDir);
    if (!lockResult.acquired) {
      logger.error('concurrent_blocked', { detail: lockResult.detail });
      auditLog.append({ event: 'blocked', trace_id: runId, manifest_hash: templateHash, reason: lockResult.detail });
      if (!jsonOutput) {
        printResult({ success: false, exitCode: STATUS_EXIT_CODES.concurrent_blocked, message: `Concurrent execution blocked: ${lockResult.detail}` });
      }
      return buildResult(runId, 'concurrent_blocked', resultOpts);
    }
    lockRelease = lockResult.release;

    auditLog.append({ event: 'execution_start', trace_id: runId, manifest_hash: templateHash });

    // ---- Execute steps -----------------------------------------------------
    const resolvedSteps = buildResolvedSteps(def, inputValidation.values);
    const rollbackSteps = buildResolvedRollbackSteps(def, inputValidation.values);
    const cwd = resolve(basePath);

    let stepsExecuted = 0;
    let failedStep = null;
    let rollbackRan = false;

    for (const step of resolvedSteps) {
      stepsExecuted++;
      logger.info('step_start', { stepId: step.id, stepsExecuted, total: resolvedSteps.length });

      if (!jsonOutput) {
        process.stdout.write(`  [${stepsExecuted}/${resolvedSteps.length}] ${step.id} ... `);
      }

      const stepResult = await executeStep(step, envResult.intersection, cwd, logger);

      state.stepsExecuted.push({
        stepId: step.id,
        success: stepResult.success,
        exitCode: stepResult.exitCode,
        timestamp: new Date().toISOString(),
      });

      if (stepResult.success) {
        if (!jsonOutput) process.stdout.write(colorize('done\n', 'green'));
      } else {
        if (!jsonOutput) process.stdout.write(colorize(`failed: ${stepResult.error}\n`, 'red'));
        failedStep = step.id;

        // Run rollback if step was non-idempotent
        if (!step.idempotent && rollbackSteps.length > 0) {
          rollbackRan = true;
          await executeRollback(rollbackSteps, envResult.intersection, cwd, logger, jsonOutput);
        }

        resultOpts.stepsExecuted = stepsExecuted;
        resultOpts.failedStep = failedStep;
        resultOpts.rollbackRan = rollbackRan;
        state.terminalReason = `Step "${step.id}" failed: ${stepResult.error}`;
        persistStateSafe(stateDir, state);

        const result = buildResult(runId, 'validation_failed', resultOpts);
        if (!jsonOutput) {
          printResult({
            success: false,
            exitCode: result.exitCode,
            message: `Template execution failed at step "${step.id}"`,
            errors: stepResult.stderr ? [stepResult.stderr.slice(0, 500)] : [],
          });
        }
        if (lockRelease) lockRelease();
        auditLog.append({ event: 'execution_failed', trace_id: runId, manifest_hash: templateHash, status: 'validation_failed' });
        logger.info('template_supervisor_end', { status: 'validation_failed', failedStep });
        return result;
      }
    }

    // ---- Success -----------------------------------------------------------
    if (lockRelease) lockRelease();
    auditLog.append({ event: 'execution_end', trace_id: runId, manifest_hash: templateHash, status: 'success' });

    resultOpts.stepsExecuted = stepsExecuted;
    persistStateSafe(stateDir, state);

    const result = buildResult(runId, 'success', resultOpts);
    if (!jsonOutput) {
      printResult({ success: true, exitCode: 0, message: 'Template execution completed successfully.' });
    }
    logger.info('template_supervisor_end', { status: 'success', stepsExecuted });
    return result;

  } catch (err) {
    logger.error('template_supervisor_crash', { error: err.message, stack: err.stack });
    try { if (lockRelease) lockRelease(); } catch { /* ignore */ }
    if (!jsonOutput) {
      printResult({ success: false, exitCode: 19, message: `Internal error: ${err.message}` });
    }
    return buildResult(runId, 'internal_error', resultOpts);
  }
}
