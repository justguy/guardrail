import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';

import { createContract, hashContract, checkRegexSafety, verifyFileHash } from './contract.js';
import { createManifest, saveManifest, loadManifest, compareManifests, DEFAULT_MANIFEST_PATH } from './manifest.js';
import { evaluateRisk } from './policy-engine.js';
import { createLogger, printBanner, printApprovalSummary, printDrift, printDenied, printResult, generateRunId, colorize } from './logger.js';
import { launchWorker, detectInteractiveAttempt } from './worker-interface.js';
import { validateResult, validateUpdateProposal, createConvergenceTracker, computeValidationSignature } from './validator.js';
import { persistStateSafe, executeSubprocess } from './shared.js';
import { checkTimePolicy, acquireLock } from './runtime-policy.js';
import { createAuditLog } from './audit.js';

// ---------------------------------------------------------------------------
// Exit code mapping
// ---------------------------------------------------------------------------

export const STATUS_EXIT_CODES = {
  success:                 0,
  approval_required:      10,
  approval_denied:        11,
  drift_detected:         12,
  validation_failed:      13,
  update_denied:          14,
  timeout:                15,
  policy_violation:       16,
  unsupported:            17,
  protocol_error:         18,
  internal_error:         19,
  time_policy_violated:   20,
  concurrent_blocked:     21,
  audit_chain_broken:     22,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the fail-closed decision for an update proposal that exceeds the
 * already approved contract. Guardrail does not allow ad hoc in-session
 * overrides for widened scope; the user must re-run and store a new manifest.
 */
export function buildOutOfScopeUpdateDecision(proposalCheck) {
  const reasons = Array.isArray(proposalCheck?.reasons) && proposalCheck.reasons.length > 0
    ? proposalCheck.reasons
    : ['update proposal exceeded the approved contract'];

  return {
    allowed: false,
    status: 'update_denied',
    requiresManifestReapproval: true,
    allowInteractiveOverride: false,
    reasons,
    message: 'Requested update is outside the approved contract. Run Guardrail again and explicitly approve a widened contract if you want to expand scope.',
  };
}

/**
 * Bounded stream clipping policy for adapter-facing worker output.
 * Full raw output stays in logs/state; only bounded slices reach results.
 */
const MAX_WORKER_OUTPUT_BYTES = 1024 * 1024; // 1 MB

function clipOutput(str) {
  if (typeof str !== 'string') return { text: '', truncated: false };
  if (Buffer.byteLength(str) <= MAX_WORKER_OUTPUT_BYTES) return { text: str, truncated: false };
  // Clip to byte budget, then trim to last complete char boundary
  const buf = Buffer.from(str);
  return { text: buf.subarray(0, MAX_WORKER_OUTPUT_BYTES).toString('utf8'), truncated: true };
}

/**
 * Build the structured result object returned by runSupervisor.
 *
 * Phase 1 adapter contract: includes reason, drift, worker, and telemetry
 * fields so adapter-engine.js can translate to adapter-result/v1 without
 * scraping terminal output.
 */
function buildResult(runId, status, opts = {}) {
  const stdoutClip = clipOutput(opts.workerStdout);
  const stderrClip = clipOutput(opts.workerStderr);

  return {
    runId,
    status,
    attempt:      opts.attempt      ?? 0,
    contractHash: opts.contractHash ?? '',
    manifestPath: opts.manifestPath ?? '',
    riskLevel:    opts.riskLevel    ?? '',
    riskReasons:  opts.riskReasons  ?? [],
    exitCode:     STATUS_EXIT_CODES[status] ?? STATUS_EXIT_CODES.internal_error,

    // Machine-readable reason for adapters and APIs
    reason: opts.reason ?? '',

    // Bounded drift context
    drift: {
      detected: (opts.driftDiffs ?? []).length > 0,
      diffs:    (opts.driftDiffs ?? []).map(d => typeof d === 'string' ? { description: d } : d),
    },

    // Bounded worker context
    worker: {
      launched:                   opts.workerLaunched ?? false,
      exitCode:                   opts.workerExitCode ?? null,
      timedOut:                   opts.workerTimedOut ?? false,
      interactivePromptDetected:  opts.interactivePromptDetected ?? false,
      stdout:                     stdoutClip.text,
      stderr:                     stderrClip.text,
      stdoutTruncated:            stdoutClip.truncated,
      stderrTruncated:            stderrClip.truncated,
    },

    // Execution telemetry
    telemetry: {
      durationMs: opts.durationMs ?? 0,
    },
  };
}

// writeState and persistState are now in shared.js (writeStateAtomic / persistStateSafe)

/**
 * Read the existing state file, or return a fresh skeleton.
 */
function readState(stateDir) {
  const statePath = join(stateDir, 'state.json');
  try {
    const raw = readFileSync(statePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Prompt the user interactively. Returns true if approved, false if denied.
 * For red risk: requires the user to type "APPROVE" exactly.
 * For green/yellow: Enter approves, 'n' or Ctrl-C denies.
 */
export function promptApproval(riskLevel, options = {}) {
  const {
    createInterfaceImpl = createInterface,
    input = process.stdin,
    output = process.stdout,
  } = options;

  return new Promise((resolvePromise) => {
    let settled = false;
    let answered = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    const rl = createInterfaceImpl({
      input,
      output,
    });

    // Ensure Ctrl-C (close without answer) counts as denial
    rl.on('close', () => {
      if (answered) return;
      settle(false);
    });

    if (riskLevel === 'red') {
      rl.question(
        colorize('  Type APPROVE to continue, or press Ctrl-C to deny: ', 'red'),
        (answer) => {
          answered = true;
          settle(answer.trim() === 'APPROVE');
          rl.close();
        },
      );
    } else {
      rl.question(
        colorize('  [Enter] Approve  |  n + Enter to deny: ', 'yellow'),
        (answer) => {
          answered = true;
          const trimmed = answer.trim().toLowerCase();
          settle(trimmed !== 'n' && trimmed !== 'no');
          rl.close();
        },
      );
    }
  });
}

/**
 * Execute an update proposal as a subprocess. Returns the result.
 */
function executeUpdate(proposal, contract) {
  const pu = proposal.proposedUpdate;
  if (!pu || !pu.command) {
    return Promise.resolve({ success: false, error: 'No command in update proposal', hasChanges: false });
  }
  return executeSubprocess(pu.command, pu.args, pu.cwd || contract.cwd || process.cwd());
}

// ---------------------------------------------------------------------------
// Main supervisor
// ---------------------------------------------------------------------------

/**
 * Run the Guardrail supervisor orchestration loop.
 *
 * @param {object} options - Supervisor options.
 * @returns {Promise<object>} Structured result object.
 */
export async function runSupervisor(options) {
  const {
    command,
    args        = [],
    shell       = null,
    cwd         = process.cwd(),
    manifestPath: rawManifestPath,
    nonInteractive = false,
    jsonOutput     = false,
    trustClass     = null,
    validator      = null,
    updateSource   = null,
    projectRoot    = null,
    envPolicy      = null,
  } = options;

  const runId    = generateRunId();
  const startTime = Date.now();
  const stateDir = join(cwd, '.guardrail');
  const logDir   = join(stateDir, 'logs');
  const logger   = createLogger(runId, logDir);

  const manifestPath = resolve(cwd, rawManifestPath || DEFAULT_MANIFEST_PATH);
  const resolvedProjectRoot = projectRoot ? resolve(projectRoot) : resolve(cwd);

  // State tracking
  const state = {
    runId,
    lastAttempt:        null,
    attemptHistory:     [],
    updateHistory:      [],
    convergenceMarkers: {},
  };

  // Shared result fields that get populated as we progress
  const resultOpts = {
    contractHash: '',
    manifestPath,
    riskLevel:    '',
    riskReasons:  [],
    attempt:      0,
    reason:       '',
    driftDiffs:   [],
    workerLaunched: false,
    workerExitCode: null,
    workerTimedOut: false,
    interactivePromptDetected: false,
    workerStdout: '',
    workerStderr: '',
    durationMs:   0,
  };

  // Helper to finalize shared result opts before each buildResult call
  const finalize = (reason) => {
    resultOpts.reason = reason;
    resultOpts.durationMs = Date.now() - startTime;
  };

  logger.info('supervisor_start', { command, args, shell, cwd, nonInteractive, jsonOutput });

  let lockRelease = null;

  try {
    // ------------------------------------------------------------------
    // Step 1: Build and normalize the contract
    // ------------------------------------------------------------------
    const mode = shell ? 'shell' : 'structured';
    const contract = createContract({
      command,
      args,
      cwd:   resolve(cwd),
      mode,
      shell: shell || null,
      envPolicy: envPolicy || undefined,
    });

    logger.info('contract_created', { mode, command });

    // ------------------------------------------------------------------
    // Step 1b: ReDoS safety check on any validator regex in the contract
    // ------------------------------------------------------------------
    if (validator && typeof validator === 'object' && validator.regex) {
      const safety = checkRegexSafety(validator.regex);
      if (!safety.safe) {
        logger.error('redos_regex_rejected', { reason: safety.reason });
        finalize(`Validator regex rejected: ${safety.reason}`);
        const result = buildResult(runId, 'policy_violation', resultOpts);
        persistState(stateDir, state, result);
        if (!jsonOutput) {
          printResult({
            success: false,
            exitCode: result.exitCode,
            message: `Validator regex rejected: ${safety.reason}`,
          });
        }
        return result;
      }
    }

    // ------------------------------------------------------------------
    // Step 2: Hash the contract
    // ------------------------------------------------------------------
    const contractHash = hashContract(contract);
    resultOpts.contractHash = contractHash;

    logger.info('contract_hashed', { contractHash });

    // ------------------------------------------------------------------
    // Step 2b: File provenance check
    // ------------------------------------------------------------------
    const fileHashCheck = verifyFileHash(contract.command, contract.fileHash);
    if (!fileHashCheck.skipped) {
      logger.info('file_hash_check', {
        path: fileHashCheck.path,
        expected: fileHashCheck.expected,
        actual: fileHashCheck.actual,
        verified: fileHashCheck.verified,
      });

      if (!fileHashCheck.verified) {
        logger.error('file_hash_mismatch', {
          path: fileHashCheck.path,
          expected: fileHashCheck.expected,
          actual: fileHashCheck.actual,
        });
        finalize(`File hash mismatch: expected ${fileHashCheck.expected}, got ${fileHashCheck.actual ?? 'unreadable'} for ${fileHashCheck.path ?? contract.command}`);
        const result = buildResult(runId, 'policy_violation', resultOpts);
        persistState(stateDir, state, result);
        if (!jsonOutput) {
          printResult({
            success: false,
            exitCode: result.exitCode,
            message: `File hash mismatch: expected ${fileHashCheck.expected}, got ${fileHashCheck.actual ?? 'unreadable'} for ${fileHashCheck.path ?? contract.command}`,
          });
        }
        return result;
      }
    }

    // ------------------------------------------------------------------
    // Step 3: Evaluate risk
    // ------------------------------------------------------------------
    const riskAssessment = evaluateRisk(contract, {
      trustClass:  trustClass || undefined,
      projectRoot: resolvedProjectRoot,
    });

    resultOpts.riskLevel   = riskAssessment.riskLevel;
    resultOpts.riskReasons = riskAssessment.reasons;

    logger.info('risk_evaluated', {
      trustClass: riskAssessment.trustClass,
      riskLevel:  riskAssessment.riskLevel,
      reasons:    riskAssessment.reasons,
    });

    // ------------------------------------------------------------------
    // Step 4: Create manifest candidate
    // ------------------------------------------------------------------
    const workflow = {
      validator:    validator ?? 'exit_code',
      updateSource: updateSource ?? 'none',
    };
    const candidate = createManifest(contract, contractHash, riskAssessment, workflow, resolvedProjectRoot);

    logger.info('manifest_candidate_created', { contractHash });

    // ------------------------------------------------------------------
    // Step 5: Load approved manifest
    // ------------------------------------------------------------------
    let approved = null;
    try {
      approved = loadManifest(manifestPath);
    } catch (err) {
      logger.error('manifest_load_error', { path: manifestPath, error: err.message });
      // Corrupt manifest is treated as missing - require re-approval
      approved = null;
    }

    // ------------------------------------------------------------------
    // Step 6: Compare manifests
    // ------------------------------------------------------------------
    let needsApproval = false;
    let driftDiffs    = [];

    if (approved === null) {
      // No approved manifest - approval required
      needsApproval = true;
      logger.info('no_approved_manifest', { path: manifestPath });
    } else {
      const comparison = compareManifests(candidate, approved);
      if (comparison.matches) {
        // Manifests match - skip to execution
        logger.info('manifest_matches', { contractHash });
      } else {
        // Drift detected
        needsApproval = true;
        driftDiffs    = comparison.diffs;
        logger.warn('drift_detected', { diffs: driftDiffs });
      }
    }

    // ------------------------------------------------------------------
    // Steps 7-9: Approval flow
    // ------------------------------------------------------------------
    // Non-interactive: verify acknowledged risk in existing manifest even if no drift
    if (nonInteractive && approved !== null && !needsApproval) {
      if (!approved.riskAssessment?.acknowledgedBy) {
        logger.error('non_interactive_unacknowledged_risk', { path: manifestPath });
        finalize('Approved manifest has no acknowledged risk assessment. Run interactively first.');
        const result = buildResult(runId, 'approval_required', resultOpts);
        persistState(stateDir, state, result);
        if (!jsonOutput) {
          printResult({ success: false, exitCode: result.exitCode, message: 'Approved manifest has no acknowledged risk assessment. Run interactively first.' });
        }
        return result;
      }
    }

    if (needsApproval) {
      if (nonInteractive) {
        // Non-interactive mode: fail closed
        if (approved === null) {
          logger.error('non_interactive_no_manifest', { path: manifestPath });
          finalize('No approved manifest found. Run interactively to approve.');
          const result = buildResult(runId, 'approval_required', resultOpts);
          persistState(stateDir, state, result);
          if (!jsonOutput) {
            printResult({ success: false, exitCode: result.exitCode, message: 'No approved manifest found. Run interactively to approve.' });
          }
          return result;
        } else {
          // Drift in non-interactive mode
          logger.error('non_interactive_drift', { diffs: driftDiffs });
          resultOpts.driftDiffs = driftDiffs;
          finalize('Contract drift detected in non-interactive mode.');
          const result = buildResult(runId, 'drift_detected', resultOpts);
          persistState(stateDir, state, result);
          if (!jsonOutput) {
            printDrift(driftDiffs);
            printResult({ success: false, exitCode: result.exitCode, message: 'Contract drift detected in non-interactive mode.' });
          }
          return result;
        }
      }

      // Detect unsupported TTY condition: interactive approval requested but no TTY
      if (!process.stdin.isTTY) {
        logger.error('unsupported_no_tty', { message: 'Interactive approval needed but stdin is not a TTY' });
        finalize('Interactive approval required but stdin is not a TTY. Use --non-interactive with --approved-manifest.');
        const result = buildResult(runId, 'unsupported', resultOpts);
        persistState(stateDir, state, result);
        if (!jsonOutput) {
          printResult({ success: false, exitCode: result.exitCode, message: 'Interactive approval required but stdin is not a TTY. Use --non-interactive with --approved-manifest.' });
        }
        return result;
      }

      // Interactive mode: show approval prompt
      if (!jsonOutput) {
        printBanner();

        if (driftDiffs.length > 0) {
          printDrift(driftDiffs);
        }

        printApprovalSummary(contract, riskAssessment);
      }

      const userApproved = await promptApproval(riskAssessment.riskLevel);

      if (!userApproved) {
        logger.info('approval_denied', { riskLevel: riskAssessment.riskLevel });
        finalize('User denied approval.');
        const result = buildResult(runId, 'approval_denied', resultOpts);
        persistState(stateDir, state, result);
        if (!jsonOutput) {
          printDenied();
        }
        return result;
      }

      // Approved - record acknowledgement and save manifest
      logger.info('approval_granted', { riskLevel: riskAssessment.riskLevel });

      candidate.riskAssessment.acknowledgedBy = 'interactive_user';
      candidate.riskAssessment.acknowledgedAt = new Date().toISOString();

      try {
        saveManifest(candidate, manifestPath);
        logger.info('manifest_saved', { path: manifestPath });
      } catch (err) {
        logger.error('manifest_save_error', { path: manifestPath, error: err.message });
        finalize('Failed to save approved manifest. Aborting before execution.');
        const result = buildResult(runId, 'internal_error', resultOpts);
        persistState(stateDir, state, result);
        if (!jsonOutput) {
          printResult({
            success: false,
            exitCode: result.exitCode,
            message: 'Failed to save approved manifest. Aborting before execution.',
          });
        }
        return result;
      }
    }

    // ------------------------------------------------------------------
    // Step 9b: Runtime policy — time limits and concurrency lock
    // ------------------------------------------------------------------
    const runtimeLimits = options.runtimeLimits ?? null;
    const auditLog = createAuditLog(join(stateDir, 'audit.jsonl'));

    if (runtimeLimits) {
      const timeCheck = checkTimePolicy(runtimeLimits, contractHash, stateDir);
      if (!timeCheck.allowed) {
        const detail = timeCheck.errors.map(e => e.detail).join('; ');
        logger.error('time_policy_violated', { errors: timeCheck.errors });
        auditLog.append({ event: 'blocked', trace_id: runId, manifest_hash: contractHash, reason: detail });
        finalize(`Time policy violated: ${detail}`);
        const result = buildResult(runId, 'time_policy_violated', resultOpts);
        persistState(stateDir, state, result);
        if (!jsonOutput) {
          printResult({ success: false, exitCode: result.exitCode, message: `Time policy violated: ${detail}` });
        }
        return result;
      }
    }

    const lockResult = acquireLock(contractHash, [], stateDir);
    if (!lockResult.acquired) {
      logger.error('concurrent_blocked', { detail: lockResult.detail });
      auditLog.append({ event: 'blocked', trace_id: runId, manifest_hash: contractHash, reason: lockResult.detail });
      finalize(`Concurrent execution blocked: ${lockResult.detail}`);
      const result = buildResult(runId, 'concurrent_blocked', resultOpts);
      persistState(stateDir, state, result);
      if (!jsonOutput) {
        printResult({ success: false, exitCode: result.exitCode, message: `Concurrent execution blocked: ${lockResult.detail}` });
      }
      return result;
    }
    lockRelease = lockResult.release;

    auditLog.append({ event: 'execution_start', trace_id: runId, manifest_hash: contractHash });

    // ------------------------------------------------------------------
    // Step 10: Create convergence tracker
    // ------------------------------------------------------------------
    const maxRetries = contract.retryPolicy?.maxRetries ?? 3;
    const convergence = createConvergenceTracker(maxRetries);
    const backoffSchedule = contract.retryPolicy?.backoff ?? [1000, 2000, 4000];

    // ------------------------------------------------------------------
    // Step 11: Execution loop
    // ------------------------------------------------------------------
    let attempt = 0;
    let lastWorkerResult = null;
    let finalStatus = 'internal_error';
    let terminalMessage = null;

    const validatorMode = workflow.validator;
    const timeoutMs = contract.timeoutMs ?? 60000;

    while (true) {
      attempt += 1;
      resultOpts.attempt = attempt;

      logger.info('worker_launch', { attempt, command, args });

      // Launch the worker
      let workerResult;
      try {
        workerResult = await launchWorker(contract, {
          timeoutMs,
          validatorMode,
        });
      } catch (err) {
        logger.error('worker_launch_error', { attempt, error: err.message });
        finalStatus = 'internal_error';
        state.attemptHistory.push({
          attempt,
          timestamp: new Date().toISOString(),
          status:    'launch_error',
          error:     err.message,
        });
        break;
      }

      lastWorkerResult = workerResult;

      // Check for timeout
      if (workerResult.timedOut) {
        logger.warn('worker_timeout', { attempt, timeoutMs });
        finalStatus = 'timeout';
        state.attemptHistory.push({
          attempt,
          timestamp: new Date().toISOString(),
          status:    'timeout',
          exitCode:  workerResult.exitCode,
        });
        break;
      }

      // Check for interactive prompt attempt on non-zero exit
      if (workerResult.exitCode !== 0) {
        const interactiveCheck = detectInteractiveAttempt(workerResult);
        if (interactiveCheck.detected) {
          logger.warn('interactive_prompt_detected', {
            attempt,
            pattern: interactiveCheck.pattern,
            exitCode: workerResult.exitCode,
          });
          finalStatus = 'validation_failed';
          terminalMessage = `Interactive prompt detected (pattern: "${interactiveCheck.pattern}"). Process was spawned without a TTY and cannot receive interactive input.`;
          state.attemptHistory.push({
            attempt,
            timestamp: new Date().toISOString(),
            status:    'interactive_prompt_detected',
            exitCode:  workerResult.exitCode,
            pattern:   interactiveCheck.pattern,
          });
          break;
        }
      }

      // Validate result
      const validation = validateResult(workerResult, validatorMode);

      logger.info('validation_result', {
        attempt,
        valid:  validation.valid,
        status: validation.status,
        errors: validation.errors,
      });

      state.attemptHistory.push({
        attempt,
        timestamp: new Date().toISOString(),
        status:    validation.status,
        exitCode:  validation.exitCode,
        errors:    validation.errors,
      });

      // --- Success ---
      if (validation.valid && validation.status === 'success') {
        finalStatus = 'success';
        logger.info('worker_success', { attempt, exitCode: validation.exitCode });
        break;
      }

      // --- Update requested (ndjson mode) ---
      if (validation.status === 'update_requested' && validation.updateProposal) {
        const proposal = validation.updateProposal;
        logger.info('update_proposed', { attempt, action: proposal.proposedUpdate?.action, summary: proposal.proposedUpdate?.summary });

        // Validate the proposal against the contract
        const proposalCheck = validateUpdateProposal(proposal, contract);

        if (!proposalCheck.allowed) {
          // Proposal widens scope - fail closed and require a new
          // manifest-backed approval rather than an in-session override.
          const decision = buildOutOfScopeUpdateDecision(proposalCheck);
          logger.warn('update_requires_reapproval', { attempt, reasons: decision.reasons });
          finalStatus = decision.status;
          state.updateHistory.push({
            attempt,
            timestamp: new Date().toISOString(),
            status:    'requires_reapproval',
            reasons:   decision.reasons,
          });

          if (!jsonOutput) {
            printDrift(decision.reasons.map(r => ({ description: r })));
          }
          terminalMessage = decision.message;
          break;
        }

        // Execute the update
        logger.info('update_executing', { attempt, command: proposal.proposedUpdate?.command });

        let updateResult;
        try {
          updateResult = await executeUpdate(proposal, contract);
        } catch (err) {
          logger.error('update_execution_error', { attempt, error: err.message });
          finalStatus = 'protocol_error';
          state.updateHistory.push({
            attempt,
            timestamp: new Date().toISOString(),
            status:    'execution_error',
            error:     err.message,
          });
          break;
        }

        state.updateHistory.push({
          attempt,
          timestamp:  new Date().toISOString(),
          status:     updateResult.success ? 'applied' : 'failed',
          hasChanges: updateResult.hasChanges,
          exitCode:   updateResult.exitCode,
        });

        if (!updateResult.success) {
          logger.warn('update_failed', { attempt, error: updateResult.error, exitCode: updateResult.exitCode });
          finalStatus = 'update_denied';
          break;
        }

        // Record in convergence tracker
        const validationSig = computeValidationSignature(workerResult);
        const updateSig = proposal.validationSignature || null;
        convergence.record(validationSig, updateSig, updateResult.hasChanges);

        state.convergenceMarkers = convergence.state();

        if (convergence.shouldAbort()) {
          logger.warn('convergence_abort', { attempt, reason: convergence.state().priorTerminalReason });
          finalStatus = 'update_denied';
          break;
        }

        // Apply backoff before retrying
        const backoffMs = backoffSchedule[Math.min(attempt - 1, backoffSchedule.length - 1)] ?? 4000;
        logger.info('retry_backoff', { attempt, backoffMs });
        await sleep(backoffMs);

        // Continue the loop to re-run the original command
        continue;
      }

      // --- Validation failed (no update path) ---
      if (validation.status === 'validation_failed') {
        // Check convergence tracker for retries
        const validationSig = computeValidationSignature(workerResult);
        convergence.record(validationSig, null, false);
        state.convergenceMarkers = convergence.state();

        if (convergence.shouldAbort()) {
          logger.warn('validation_failed_no_convergence', { attempt, reason: convergence.state().priorTerminalReason });
          finalStatus = 'validation_failed';
          break;
        }

        // Retry with backoff
        const backoffMs = backoffSchedule[Math.min(attempt - 1, backoffSchedule.length - 1)] ?? 4000;
        logger.info('retry_backoff_validation', { attempt, backoffMs });
        await sleep(backoffMs);
        continue;
      }

      // --- Protocol error ---
      if (validation.status === 'protocol_error') {
        logger.error('protocol_error', { attempt, errors: validation.errors });
        finalStatus = 'protocol_error';
        break;
      }

      // --- Unknown status - fail safe ---
      logger.error('unknown_validation_status', { attempt, status: validation.status });
      finalStatus = 'internal_error';
      break;
    }

    // ------------------------------------------------------------------
    // Step 12: Release lock, write audit + state
    // ------------------------------------------------------------------
    if (lockRelease) lockRelease();
    auditLog.append({
      event: finalStatus === 'success' ? 'execution_end' : 'execution_failed',
      trace_id: runId,
      manifest_hash: contractHash,
      exit_code: lastWorkerResult?.exitCode ?? null,
      status: finalStatus,
    });

    // Populate worker context from the execution loop
    if (lastWorkerResult) {
      resultOpts.workerLaunched = true;
      resultOpts.workerExitCode = lastWorkerResult.exitCode ?? null;
      resultOpts.workerTimedOut = lastWorkerResult.timedOut ?? false;
      resultOpts.workerStdout = lastWorkerResult.stdout ?? '';
      resultOpts.workerStderr = lastWorkerResult.stderr ?? '';
    }
    if (terminalMessage && terminalMessage.includes('Interactive prompt detected')) {
      resultOpts.interactivePromptDetected = true;
    }
    resultOpts.driftDiffs = driftDiffs;

    const reasonMsg = finalStatus === 'success'
      ? 'Run completed successfully.'
      : (terminalMessage ?? `Run ended with status: ${finalStatus}`);
    finalize(reasonMsg);

    const result = buildResult(runId, finalStatus, resultOpts);
    persistState(stateDir, state, result);

    // ------------------------------------------------------------------
    // Step 13: Output and return
    // ------------------------------------------------------------------
    if (!jsonOutput) {
      const isSuccess = finalStatus === 'success';
      printResult({
        success:  isSuccess,
        exitCode: result.exitCode,
        message:  reasonMsg,
        errors:   lastWorkerResult?.stderr ? [lastWorkerResult.stderr.slice(0, 500)] : [],
      });
    }

    logger.info('supervisor_end', { status: finalStatus, exitCode: result.exitCode, attempts: attempt });

    return result;

  } catch (err) {
    // Top-level catch for truly unexpected errors
    logger.error('supervisor_crash', { error: err.message, stack: err.stack });

    // Release lock if held
    try { if (lockRelease) lockRelease(); } catch { /* ignore */ }

    finalize(`Internal error: ${err.message}`);
    const result = buildResult(runId, 'internal_error', resultOpts);
    try {
      persistState(stateDir, state, result);
    } catch {
      // State write failed too - nothing we can do
    }

    if (!jsonOutput) {
      printResult({
        success:  false,
        exitCode: result.exitCode,
        message:  `Internal error: ${err.message}`,
      });
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// State persistence helper
// ---------------------------------------------------------------------------

function persistState(stateDir, state, result) {
  state.lastAttempt = {
    timestamp: new Date().toISOString(),
    exitCode:  result.exitCode,
    status:    result.status,
  };
  persistStateSafe(stateDir, state);
}

// ---------------------------------------------------------------------------
// Sleep utility
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
