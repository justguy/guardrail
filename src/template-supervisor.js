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
import {
  emitProgress,
  emitExecutionEnd,
  mapResultStatusToProgressStatus,
} from './progress-events.js';
import { launchWorker, detectInteractiveAttempt } from './worker-interface.js';
import { validateResult } from './validator.js';
import { createContract, verifyFileHash } from './contract.js';
import { promptApproval, STATUS_EXIT_CODES } from './supervisor.js';
import { persistStateSafe, buildEnvFromPolicy } from './shared.js';
import { createAuditLog } from './audit.js';
import { authorize, ACTIONS } from './authorization.js';

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

function emitTemplateProgress(progressSink, runId, event, data = {}) {
  emitProgress(progressSink, runId, 'template', event, data);
}

function emitTemplateExecutionEnd(progressSink, runId, finalStatus, context = {}) {
  emitExecutionEnd(progressSink, runId, 'template', finalStatus, context);
}

function emitTemplateStepResult(progressSink, runId, finalStatus, context = {}) {
  const progressStatus = mapResultStatusToProgressStatus(finalStatus);
  const event = progressStatus === 'blocked'
    ? 'step_blocked'
    : progressStatus === 'failed'
      ? 'step_failed'
      : 'step_completed';

  emitTemplateProgress(progressSink, runId, event, {
    stepId: context.stepId || 'template',
    stepType: context.stepType || 'template_step',
    stepResult: finalStatus,
    ...context,
  });
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
 * @param {object} [options.delegatedApproval] - Active delegated MCP approval record.
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
    progressSink   = null,
    delegatedApproval = null,
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
  const emitFinalResult = (status, opts = {}) => {
    const result = buildResult(runId, status, { ...resultOpts, ...opts });
    emitTemplateExecutionEnd(progressSink, runId, status, {
      message: result.reason || opts.reason || '',
      stepsExecuted: opts.stepsExecuted ?? 0,
      rollbackRan: result.rollbackRan,
      failedStep: result.failedStep,
    });
    return result;
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
      return emitFinalResult('internal_error', {
        ...resultOpts,
        reason: err.message,
      });
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
      return emitFinalResult('validation_failed', {
        ...resultOpts,
        reason: msg,
      });
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
      return emitFinalResult('policy_violation', {
        ...resultOpts,
        reason: msg,
      });
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
      return emitFinalResult('policy_violation', {
        ...resultOpts,
        reason: msg,
      });
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
    let delegatedManifestReason = '';

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

    if (!needsApproval && approved?.riskAssessment?.delegated) {
      const delegatedRecord = approved.riskAssessment.delegated;
      if (delegatedApproval?.allowed !== true) {
        delegatedManifestReason = 'Approved template manifest was created by a delegated grant and requires an active delegated grant for reuse.';
        needsApproval = true;
      } else if (delegatedRecord.tool && delegatedRecord.tool !== delegatedApproval.tool) {
        delegatedManifestReason = 'Approved template manifest was created by a different delegated MCP tool and must be re-approved for this tool.';
        needsApproval = true;
      }
      if (delegatedManifestReason) {
        logger.warn('template_delegated_manifest_reapproval_required', {
          templateName: def.name,
          manifestPath,
          reason: delegatedManifestReason,
        });
      }
    }

    // ---- Non-interactive: verify acknowledgement on matching manifest -------
    if (nonInteractive && approved !== null && !needsApproval) {
      if (!approved.riskAssessment?.acknowledgedBy) {
        logger.error('non_interactive_unacknowledged_risk', { path: manifestPath });
        const reason = 'Approved manifest has no acknowledged risk. Run interactively first.';
        emitTemplateProgress(progressSink, runId, 'approval_pending', { reason, message: reason });
        if (!jsonOutput) {
          printResult({ success: false, exitCode: 10, message: reason });
        }
        return emitFinalResult('approval_required', {
          ...resultOpts,
          reason,
        });
      }
    }

    // ---- Approval flow -----------------------------------------------------
    if (needsApproval) {
      if (delegatedApproval?.allowed === true) {
        const expectedTemplateHash = delegatedApproval.templateHash ?? delegatedApproval.expectedTemplateHash ?? null;
        if (!expectedTemplateHash) {
          const reason = 'Delegated template approval requires a template_hash pinned in the active grant.';
          if (!jsonOutput) {
            printResult({ success: false, exitCode: 16, message: reason });
          }
          return emitFinalResult('policy_violation', { ...resultOpts, reason });
        }
        if (expectedTemplateHash !== templateHash) {
          const reason = 'Delegated template approval grant does not match the resolved template execution hash.';
          if (!jsonOutput) {
            printResult({ success: false, exitCode: 16, message: reason });
          }
          return emitFinalResult('policy_violation', { ...resultOpts, reason });
        }
        candidate.riskAssessment.acknowledgedBy = delegatedApproval.actor || 'delegated_grant';
        candidate.riskAssessment.acknowledgedAt = new Date().toISOString();
        candidate.riskAssessment.delegated = {
          grantHash: delegatedApproval.grantHash ?? null,
          templateHash,
          tool: delegatedApproval.tool ?? null,
          reason: delegatedApproval.reason ?? 'delegated approval',
        };
        try {
          saveManifest(candidate, manifestPath);
          approved = candidate;
          needsApproval = false;
          logger.info('template_delegated_approval', {
            templateName: def.name,
            manifestPath,
            grantHash: delegatedApproval.grantHash ?? null,
          });
        } catch (err) {
          const reason = `Failed to save delegated template approval manifest: ${err.message}`;
          if (!jsonOutput) {
            printResult({ success: false, exitCode: 19, message: 'Failed to save manifest.' });
          }
          return emitFinalResult('internal_error', { ...resultOpts, reason });
        }
      }
    }

    if (needsApproval) {
      if (nonInteractive) {
        if (approved === null) {
          logger.error('non_interactive_no_manifest');
          const reason = 'No approved manifest. Run interactively to approve.';
          emitTemplateProgress(progressSink, runId, 'approval_pending', { reason, message: reason });
          if (!jsonOutput) {
            printResult({ success: false, exitCode: 10, message: reason });
          }
          return emitFinalResult('approval_required', { ...resultOpts, reason });
        }
        // Drift in non-interactive
        logger.error('non_interactive_drift', { diffs: driftDiffs });
        const reason = 'Template drift detected in non-interactive mode.';
        emitTemplateProgress(progressSink, runId, 'approval_pending', { reason, message: reason });
        if (!jsonOutput) {
          printTemplateDrift(formatDiffs(driftDiffs));
          printResult({ success: false, exitCode: 12, message: reason });
        }
        return emitFinalResult('drift_detected', { ...resultOpts, reason });
      }

      if (!process.stdin.isTTY) {
        logger.error('unsupported_no_tty');
        const reason = 'Interactive approval needed but stdin is not a TTY.';
        emitTemplateProgress(progressSink, runId, 'approval_pending', { reason, message: reason });
        if (!jsonOutput) {
          printResult({ success: false, exitCode: 17, message: reason });
        }
        return emitFinalResult('unsupported', { ...resultOpts, reason });
      }

      // Interactive approval
      if (!jsonOutput) {
        printBanner();
        if (driftDiffs.length > 0) printTemplateDrift(formatDiffs(driftDiffs));
        printTemplateSummary(def, riskAssessment, envResult);
      }

      emitTemplateProgress(progressSink, runId, 'approval_pending', {
        reason: 'Template approval required.',
        message: 'Template approval required.',
      });
      const userApproved = await promptApproval(riskAssessment.riskLevel);

      if (!userApproved) {
        logger.info('approval_denied', { riskLevel: riskAssessment.riskLevel });
        const reason = 'User denied approval.';
        emitTemplateProgress(progressSink, runId, 'approval_pending', { reason, message: reason });
        if (!jsonOutput) printDenied();
        return emitFinalResult('approval_denied', { ...resultOpts, reason });
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
        return emitFinalResult('internal_error', {
          ...resultOpts,
          reason: 'Failed to save manifest.',
        });
      }
    }

    // ---- Runtime policy: unified authorization gate -------------------------
    const runtimeLimits = options.runtimeLimits ?? null;
    const auditLog = createAuditLog(resolve(stateDir, 'audit.jsonl'));

    const templateRuntimeAuth = await authorize(ACTIONS.TEMPLATE_RUN, {
      runtimeLimits,
      manifestHash: templateHash,
      stateDir,
    });
    if (!templateRuntimeAuth.allowed) {
      logger.error('template_runtime_authorization_denied', {
        code:   templateRuntimeAuth.code,
        reason: templateRuntimeAuth.reason,
      });
      auditLog.append({ event: 'blocked', trace_id: runId, manifest_hash: templateHash, reason: templateRuntimeAuth.reason });
      if (!jsonOutput) {
        const tStatus = templateRuntimeAuth.code === 'time_policy_violated'
          ? 'time_policy_violated'
          : 'concurrent_blocked';
        printResult({ success: false, exitCode: STATUS_EXIT_CODES[tStatus], message: templateRuntimeAuth.reason });
      }
      const tStatus = templateRuntimeAuth.code === 'time_policy_violated'
        ? 'time_policy_violated'
        : 'concurrent_blocked';
      return emitFinalResult(tStatus, { ...resultOpts, reason: templateRuntimeAuth.reason });
    }
    lockRelease = templateRuntimeAuth.release;

    auditLog.append({ event: 'execution_start', trace_id: runId, manifest_hash: templateHash });
    emitTemplateProgress(progressSink, runId, 'execution_start', {
      message: `Template execution started`,
      templateName: def.name,
      stepId: 'template',
      stepType: 'template',
    });

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
      emitTemplateProgress(progressSink, runId, 'step_started', {
        stepId: step.id,
        stepType: 'template_step',
        attempt: stepsExecuted,
        message: `Starting template step "${step.id}"`,
      });

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
        emitTemplateStepResult(progressSink, runId, 'success', {
          stepId: step.id,
          message: `Template step "${step.id}" completed`,
          attempt: stepsExecuted,
          stepType: 'template_step',
        });
      } else {
        emitTemplateStepResult(progressSink, runId, 'validation_failed', {
          stepId: step.id,
          message: `Template step "${step.id}" failed: ${stepResult.error}`,
          attempt: stepsExecuted,
          stepType: 'template_step',
        });
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
        const reason = `Template execution failed at step "${step.id}"`;
        const result = emitFinalResult('validation_failed', {
          ...resultOpts,
          reason,
          failedStep,
          rollbackRan,
        });
        if (!jsonOutput) {
          printResult({
            success: false,
            exitCode: result.exitCode,
            message: reason,
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

    const result = emitFinalResult('success', resultOpts);
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
    return emitFinalResult('internal_error', { ...resultOpts, reason: `Internal error: ${err.message}` });
  }
}
