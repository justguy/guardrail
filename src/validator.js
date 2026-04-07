import { createHash } from 'node:crypto';
import { resolve, isAbsolute } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS = {
  SUCCESS: 'success',
  VALIDATION_FAILED: 'validation_failed',
  UPDATE_REQUESTED: 'update_requested',
  PROTOCOL_ERROR: 'protocol_error',
};

const PROTOCOL_MSG_TYPES = new Set([
  'SUCCESS',
  'VALIDATION_FAILED_REQUIRE_UPDATE',
]);

const ALLOWED_UPDATE_ACTIONS = new Set(['apply_patch', 'run_script']);

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute a deterministic validation signature from a worker result.
 * Signature = SHA-256( exitCode + sha256(stdout) + sha256(stderr) )
 */
export function computeValidationSignature(workerResult) {
  const exitPart = String(workerResult.exitCode ?? 0);
  const stdoutHash = sha256(workerResult.stdout ?? '');
  const stderrHash = sha256(workerResult.stderr ?? '');
  return sha256(exitPart + stdoutHash + stderrHash);
}

// ---------------------------------------------------------------------------
// NDJSON protocol parsing
// ---------------------------------------------------------------------------

/**
 * Parse stdout for Guardrail protocol messages (one JSON object per line).
 * Returns { protocolMessages, parseErrors }.
 */
function parseProtocolMessages(stdout) {
  const protocolMessages = [];
  const parseErrors = [];

  if (!stdout || typeof stdout !== 'string') {
    return { protocolMessages, parseErrors };
  }

  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // Only attempt to parse lines that look like JSON objects
    if (!trimmed.startsWith('{')) continue;

    try {
      const msg = JSON.parse(trimmed);
      if (msg && typeof msg.type === 'string' && PROTOCOL_MSG_TYPES.has(msg.type)) {
        protocolMessages.push(msg);
      }
    } catch {
      parseErrors.push(`Failed to parse NDJSON line: ${trimmed.slice(0, 120)}`);
    }
  }

  return { protocolMessages, parseErrors };
}

/**
 * Extract a structured update proposal from a VALIDATION_FAILED_REQUIRE_UPDATE
 * protocol message.  Returns null if the message does not carry a valid proposal.
 */
function extractUpdateProposal(msg) {
  if (!msg || msg.type !== 'VALIDATION_FAILED_REQUIRE_UPDATE') return null;

  // Support both spec format (payload.proposedUpdate) and flat format (updateProposal)
  const raw = (msg.payload && typeof msg.payload === 'object') ? msg.payload : msg.updateProposal;
  if (!raw || typeof raw !== 'object') return null;
  const proposedUpdate = raw.proposedUpdate;

  if (!proposedUpdate || typeof proposedUpdate !== 'object') return null;
  if (!ALLOWED_UPDATE_ACTIONS.has(proposedUpdate.action)) return null;

  return {
    validationSignature: typeof raw.validationSignature === 'string'
      ? raw.validationSignature
      : null,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    proposedUpdate: {
      action: proposedUpdate.action,
      summary: typeof proposedUpdate.summary === 'string' ? proposedUpdate.summary : '',
      command: typeof proposedUpdate.command === 'string' ? proposedUpdate.command : null,
      args: Array.isArray(proposedUpdate.args)
        ? proposedUpdate.args.map(String)
        : [],
      cwd: typeof proposedUpdate.cwd === 'string' ? proposedUpdate.cwd : process.cwd(),
      patch: typeof proposedUpdate.patch === 'string' ? proposedUpdate.patch : null,
    },
  };
}

// ---------------------------------------------------------------------------
// validateResult
// ---------------------------------------------------------------------------

/**
 * Validate a worker result according to the chosen validator mode.
 *
 * @param {object} workerResult - { exitCode, stdout, stderr }
 * @param {'exit_code' | 'ndjson'} validatorMode
 * @returns {object} ValidationResult
 */
export function validateResult(workerResult, validatorMode) {
  const result = {
    valid: false,
    status: STATUS.PROTOCOL_ERROR,
    exitCode: workerResult.exitCode ?? -1,
    updateProposal: null,
    errors: [],
  };

  if (validatorMode === 'exit_code') {
    return validateExitCode(workerResult, result);
  }

  if (validatorMode === 'ndjson') {
    return validateNdjson(workerResult, result);
  }

  result.errors.push(`Unknown validator mode: ${validatorMode}`);
  return result;
}

function validateExitCode(workerResult, result) {
  const code = workerResult.exitCode ?? -1;
  if (code === 0) {
    result.valid = true;
    result.status = STATUS.SUCCESS;
  } else {
    result.valid = false;
    result.status = STATUS.VALIDATION_FAILED;
    result.errors.push(`Process exited with code ${code}`);
  }
  return result;
}

function validateNdjson(workerResult, result) {
  const { protocolMessages, parseErrors } = parseProtocolMessages(workerResult.stdout);

  if (parseErrors.length > 0) {
    result.errors.push(...parseErrors);
  }

  // If no protocol messages found, fall back to exit code interpretation
  // but flag it as a protocol error.
  if (protocolMessages.length === 0) {
    result.status = STATUS.PROTOCOL_ERROR;
    result.errors.push('No Guardrail protocol messages found in stdout');
    result.valid = false;
    return result;
  }

  // Use the last protocol message as the authoritative one.
  const finalMsg = protocolMessages[protocolMessages.length - 1];

  if (finalMsg.type === 'SUCCESS') {
    result.valid = true;
    result.status = STATUS.SUCCESS;
    return result;
  }

  if (finalMsg.type === 'VALIDATION_FAILED_REQUIRE_UPDATE') {
    result.valid = false;

    const proposal = extractUpdateProposal(finalMsg);
    if (proposal) {
      result.status = STATUS.UPDATE_REQUESTED;
      result.updateProposal = proposal;
    } else {
      result.status = STATUS.VALIDATION_FAILED;
      result.errors.push(
        'VALIDATION_FAILED_REQUIRE_UPDATE received but contained no valid update proposal',
      );
    }
    return result;
  }

  // Shouldn't reach here given the PROTOCOL_MSG_TYPES filter, but be defensive.
  result.status = STATUS.PROTOCOL_ERROR;
  result.errors.push(`Unhandled protocol message type: ${finalMsg.type}`);
  return result;
}

// ---------------------------------------------------------------------------
// validateUpdateProposal
// ---------------------------------------------------------------------------

/**
 * Check whether an update proposal falls within the contract scope.
 *
 * @param {object} proposal - The updateProposal from a ValidationResult
 * @param {object} contract - The resolved contract (with updatePolicy, allowedBinaries, writablePaths)
 * @returns {{ allowed: boolean, reasons: string[] }}
 */
export function validateUpdateProposal(proposal, contract) {
  const reasons = [];

  if (!proposal || !proposal.proposedUpdate) {
    return { allowed: false, reasons: ['No proposed update provided'] };
  }

  const { proposedUpdate } = proposal;
  const updatePolicy = contract.updatePolicy ?? {};
  const allowedActions = Array.isArray(updatePolicy.allowedActions)
    ? new Set(updatePolicy.allowedActions)
    : new Set();

  // 1. Check action type
  if (!allowedActions.has(proposedUpdate.action)) {
    reasons.push(
      `Action "${proposedUpdate.action}" is not in allowedActions [${[...allowedActions].join(', ')}]`,
    );
  }

  // 2. Check command against allowed binaries
  if (proposedUpdate.command != null) {
    const allowedBinaries = Array.isArray(contract.allowedBinaries)
      ? new Set(contract.allowedBinaries)
      : new Set();

    if (allowedBinaries.size > 0 && !allowedBinaries.has(proposedUpdate.command)) {
      reasons.push(
        `Command "${proposedUpdate.command}" is not in allowedBinaries [${[...allowedBinaries].join(', ')}]`,
      );
    }
  }

  // 2b. Check whether a run_script proposal expands the approved command surface.
  if (proposedUpdate.action === 'run_script') {
    const approvedCommand = contract.command ?? null;
    const approvedArgs = Array.isArray(contract.args) ? contract.args : [];
    const proposedArgs = Array.isArray(proposedUpdate.args) ? proposedUpdate.args : [];

    const sameCommand = proposedUpdate.command === approvedCommand;
    const sameArgs =
      approvedArgs.length === proposedArgs.length &&
      approvedArgs.every((value, index) => value === proposedArgs[index]);

    if (!sameCommand || !sameArgs) {
      const approvedText = [approvedCommand, ...approvedArgs].filter(Boolean).join(' ');
      const proposedText = [proposedUpdate.command, ...proposedArgs].filter(Boolean).join(' ');
      reasons.push(
        `Proposed command "${proposedText}" differs from approved command "${approvedText}"`,
      );
    }
  }

  // 3. Check cwd against writable paths
  if (proposedUpdate.cwd != null) {
    const writablePaths = Array.isArray(contract.writablePaths)
      ? contract.writablePaths
      : [];

    if (writablePaths.length > 0) {
      const resolvedCwd = resolve(proposedUpdate.cwd);
      const withinWritable = writablePaths.some((wp) => {
        const resolvedWp = resolve(wp);
        return resolvedCwd === resolvedWp || resolvedCwd.startsWith(resolvedWp + '/');
      });

      if (!withinWritable) {
        reasons.push(
          `Working directory "${proposedUpdate.cwd}" is not within writable paths [${writablePaths.join(', ')}]`,
        );
      }
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Convergence tracker
// ---------------------------------------------------------------------------

/**
 * Create a convergence tracker that detects when the validate-update loop
 * is no longer making progress and should abort.
 *
 * @param {number} maxRetries - Maximum number of retry attempts allowed
 * @returns {{ record: Function, shouldAbort: Function }}
 */
export function createConvergenceTracker(maxRetries = 3) {
  let attemptCount = 0;
  let priorTerminalReason = null;

  const seenValidationSignatures = new Set();
  const seenUpdateSignatures = new Set();
  let lastValidationSig = null;
  let lastUpdateSig = null;

  /**
   * Record the outcome of a validation/update cycle.
   *
   * @param {string|null} validationSig - Hash of the current validation state
   * @param {string|null} updateSig     - Hash of the update proposal (null if none)
   * @param {boolean}     hasChanges    - Whether the update produced any changes
   */
  function record(validationSig, updateSig, hasChanges) {
    attemptCount += 1;

    // Check: retry limit
    if (attemptCount > maxRetries) {
      priorTerminalReason = `Retry limit reached (${maxRetries})`;
      return;
    }

    // Check: same validation signature repeats without a successful state change
    if (validationSig != null && seenValidationSignatures.has(validationSig)) {
      priorTerminalReason =
        `Validation signature repeated without successful state change (${validationSig.slice(0, 12)}...)`;
      return;
    }

    // Check: same update signature repeats
    if (updateSig != null && seenUpdateSignatures.has(updateSig)) {
      priorTerminalReason =
        `Update signature repeated — same fix proposed again (${updateSig.slice(0, 12)}...)`;
      return;
    }

    // Check: update ran but reported no changes
    if (updateSig != null && !hasChanges) {
      priorTerminalReason = 'Update produced no changes';
      return;
    }

    // All good — track the signatures for future comparisons
    if (validationSig != null) seenValidationSignatures.add(validationSig);
    if (updateSig != null) seenUpdateSignatures.add(updateSig);
    lastValidationSig = validationSig;
    lastUpdateSig = updateSig;

    // Reset terminal reason since this cycle was productive
    priorTerminalReason = null;
  }

  /**
   * Returns whether the loop should abort.
   */
  function shouldAbort() {
    return priorTerminalReason != null;
  }

  /**
   * Returns diagnostic state for logging.
   */
  function state() {
    return {
      attemptCount,
      priorTerminalReason,
      lastValidationSig,
      lastUpdateSig,
      seenValidationCount: seenValidationSignatures.size,
      seenUpdateCount: seenUpdateSignatures.size,
    };
  }

  return { record, shouldAbort, state };
}
