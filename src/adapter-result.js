/**
 * adapter-result.js — Stable machine-readable surface for adapter-result/v1.
 * Holds the reason-code vocabulary, the deterministic status→code mapping,
 * the paranoia-level shape validator, and the builder helpers used by
 * adapter-engine.js. Also hosts the pure intercept payload helper.
 * MUST NOT import adapter-engine.js (one-way dependency, no cycles).
 */

import { extractValue } from './adapter-extract.js';

// --- Stable reason-code vocabulary -----------------------------------------
// Adding a new entry is additive; removing one is a breaking change.

export const ADAPTER_REASON_CODES = Object.freeze({
  // success
  OK: 'OK',
  // blocked
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_DENIED: 'APPROVAL_DENIED',
  DRIFT_DETECTED: 'DRIFT_DETECTED',
  POLICY_VIOLATION: 'POLICY_VIOLATION',
  TIME_POLICY_VIOLATED: 'TIME_POLICY_VIOLATED',
  CONCURRENT_BLOCKED: 'CONCURRENT_BLOCKED',
  UNSUPPORTED: 'UNSUPPORTED',
  UPDATE_DENIED: 'UPDATE_DENIED',
  MCP_BLOCKED: 'MCP_BLOCKED',
  MISSING_AUTH_MAPPING: 'MISSING_AUTH_MAPPING',
  MISSING_AUTH_PREREQUISITE: 'MISSING_AUTH_PREREQUISITE',
  EGRESS_BLOCKED: 'EGRESS_BLOCKED',
  // failed
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  TIMEOUT: 'TIMEOUT',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  PROFILE_INVALID: 'PROFILE_INVALID',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  COMMAND_UNRESOLVED: 'COMMAND_UNRESOLVED',
  INTERCEPT_INVALID: 'INTERCEPT_INVALID',
  SUPERVISOR_THREW: 'SUPERVISOR_THREW',
});

const KNOWN_CODES = new Set(Object.values(ADAPTER_REASON_CODES));

// drift_detected MUST collapse to DRIFT_DETECTED, not POLICY_VIOLATION.
export const STATUS_TO_CODE = Object.freeze({
  success: ADAPTER_REASON_CODES.OK,
  approval_required: ADAPTER_REASON_CODES.APPROVAL_REQUIRED,
  approval_denied: ADAPTER_REASON_CODES.APPROVAL_DENIED,
  drift_detected: ADAPTER_REASON_CODES.DRIFT_DETECTED,
  policy_violation: ADAPTER_REASON_CODES.POLICY_VIOLATION,
  time_policy_violated: ADAPTER_REASON_CODES.TIME_POLICY_VIOLATED,
  concurrent_blocked: ADAPTER_REASON_CODES.CONCURRENT_BLOCKED,
  unsupported: ADAPTER_REASON_CODES.UNSUPPORTED,
  update_denied: ADAPTER_REASON_CODES.UPDATE_DENIED,
  validation_failed: ADAPTER_REASON_CODES.VALIDATION_FAILED,
  timeout: ADAPTER_REASON_CODES.TIMEOUT,
  protocol_error: ADAPTER_REASON_CODES.PROTOCOL_ERROR,
  internal_error: ADAPTER_REASON_CODES.INTERNAL_ERROR,
});

/** Default human-readable reason for each native supervisor status. */
export const DEFAULT_REASONS = Object.freeze({
  success: 'Command executed successfully.',
  approval_required: 'Approval required in non-interactive mode.',
  approval_denied: 'Approval was denied.',
  drift_detected: 'Contract drift detected in non-interactive mode.',
  validation_failed: 'Result validation failed.',
  timeout: 'Execution timed out.',
  policy_violation: 'Policy violation detected.',
  unsupported: 'Unsupported operation.',
  update_denied: 'Update proposal was denied.',
  protocol_error: 'Protocol error occurred.',
  internal_error: 'Internal error occurred.',
  time_policy_violated: 'Time-based policy constraint violated.',
  concurrent_blocked: 'Blocked by concurrency lock.',
});

// --- Exit-code fallbacks (mirrors supervisor STATUS_EXIT_CODES) ------------

export const ADAPTER_EXIT_CODES = Object.freeze({
  blocked: 16,
  failed: 19,
  // code-specific overrides
  DRIFT_DETECTED: 12,
  APPROVAL_REQUIRED: 10,
  APPROVAL_DENIED: 11,
  TIME_POLICY_VIOLATED: 20,
  CONCURRENT_BLOCKED: 21,
  MCP_BLOCKED: 16,
});

// --- Shape validator --------------------------------------------------------

/**
 * Fail-closed shape check for an adapter-result/v1 value. Returns
 * { valid: boolean, errors: string[] }. Used by runAdapter as a paranoia
 * gate right before returning so accidental regressions in the shape surface
 * immediately instead of leaking to consumers.
 */
export function validateAdapterResult(result) {
  const errors = [];

  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    return { valid: false, errors: ['Adapter result must be a non-null object'] };
  }
  if (result.schemaVersion !== 'adapter-result/v1') {
    errors.push(`schemaVersion must equal "adapter-result/v1" (got ${String(result.schemaVersion)})`);
  }

  const g = result.guardrail;
  if (g == null || typeof g !== 'object' || Array.isArray(g)) {
    errors.push('guardrail block is required');
  } else {
    const requiredStrings = ['nativeStatus', 'category', 'reason', 'code'];
    for (const key of requiredStrings) {
      if (typeof g[key] !== 'string' || g[key].length === 0) {
        errors.push(`guardrail.${key} must be a non-empty string`);
      }
    }
    if (!['success', 'blocked', 'failed'].includes(g.category)) {
      errors.push(`guardrail.category must be one of success|blocked|failed (got ${String(g.category)})`);
    }
    if (!KNOWN_CODES.has(g.code)) {
      errors.push(`guardrail.code must be one of ADAPTER_REASON_CODES (got ${String(g.code)})`);
    }
    if (!Number.isInteger(g.exitCode)) {
      errors.push('guardrail.exitCode must be an integer');
    }
    if (typeof g.driftDetected !== 'boolean') {
      errors.push('guardrail.driftDetected must be a boolean');
    }
    if (!Array.isArray(g.driftSummary)) {
      errors.push('guardrail.driftSummary must be an array');
    }
    if (!Array.isArray(g.riskReasons)) {
      errors.push('guardrail.riskReasons must be an array');
    }
  }

  const p = result.process;
  if (p == null || typeof p !== 'object' || Array.isArray(p)) {
    errors.push('process block is required');
  } else {
    if (typeof p.launched !== 'boolean') errors.push('process.launched must be a boolean');
    if (typeof p.stdout !== 'string') errors.push('process.stdout must be a string');
    if (typeof p.stderr !== 'string') errors.push('process.stderr must be a string');
    if (typeof p.stdoutTruncated !== 'boolean') errors.push('process.stdoutTruncated must be a boolean');
    if (typeof p.stderrTruncated !== 'boolean') errors.push('process.stderrTruncated must be a boolean');
  }

  const t = result.telemetry;
  if (t == null || typeof t !== 'object' || Array.isArray(t)) {
    errors.push('telemetry block is required');
  } else {
    if (typeof t.runId !== 'string') errors.push('telemetry.runId must be a string');
    if (typeof t.durationMs !== 'number') errors.push('telemetry.durationMs must be a number');
  }

  return { valid: errors.length === 0, errors };
}

// --- Builders ---------------------------------------------------------------

/**
 * Build a synthetic blocked adapter-result/v1 for cases where no supervisor
 * ran (MCP gate, auth preflight, env mapping).
 * @param {string} code - one of ADAPTER_REASON_CODES (blocked family)
 * @param {string} reason - non-empty human reason
 */
export function buildBlockedResult(code, reason) {
  assertKnownCode(code);
  const exitCode = ADAPTER_EXIT_CODES[code] ?? ADAPTER_EXIT_CODES.blocked;
  return {
    schemaVersion: 'adapter-result/v1',
    guardrail: {
      nativeStatus: 'policy_violation',
      category: 'blocked',
      code,
      reason,
      exitCode,
      contractHash: '', manifestPath: '', riskLevel: '', riskReasons: [],
      driftDetected: false, driftSummary: [],
    },
    process: emptyProcess(),
    telemetry: { runId: '', durationMs: 0 },
  };
}

export function buildSuccessResult(reason = DEFAULT_REASONS.success) {
  return {
    schemaVersion: 'adapter-result/v1',
    guardrail: {
      nativeStatus: 'success',
      category: 'success',
      code: ADAPTER_REASON_CODES.OK,
      reason,
      exitCode: 0,
      contractHash: '',
      manifestPath: '',
      riskLevel: '',
      riskReasons: [],
      driftDetected: false,
      driftSummary: [],
    },
    process: emptyProcess(),
    telemetry: { runId: '', durationMs: 0 },
  };
}

/**
 * Build a synthetic failed adapter-result/v1 for cases where the adapter
 * pipeline itself hit an error before delegating to the supervisor.
 * @param {string} code - one of ADAPTER_REASON_CODES (failed family)
 * @param {string} reason - non-empty human reason
 */
export function buildFailedResult(code, reason) {
  assertKnownCode(code);
  const exitCode = ADAPTER_EXIT_CODES[code] ?? ADAPTER_EXIT_CODES.failed;
  return {
    schemaVersion: 'adapter-result/v1',
    guardrail: {
      nativeStatus: 'internal_error',
      category: 'failed',
      code,
      reason,
      exitCode,
      contractHash: '', manifestPath: '', riskLevel: '', riskReasons: [],
      driftDetected: false, driftSummary: [],
    },
    process: emptyProcess(),
    telemetry: { runId: '', durationMs: 0 },
  };
}

function emptyProcess() {
  return {
    launched: false, exitCode: null, timedOut: false,
    interactivePromptDetected: false,
    stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
  };
}

function assertKnownCode(code) {
  if (!KNOWN_CODES.has(code)) {
    throw new Error(`Unknown adapter reason code: ${String(code)}`);
  }
}

// --- Intercept extraction ---------------------------------------------------

/**
 * Resolve {command, args, cwd} from a stdin-json-style rawInput using a
 * profile's intercept block. Pure — never spawns, never logs. Returns
 * { command, args, cwd, error }: `error` is set and the other fields are
 * null/empty when resolution fails.
 */
export function extractFromIntercept(rawInput, intercept) {
  if (rawInput == null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return errShape('stdin-json intercept requires a JSON object input.');
  }
  if (!intercept || typeof intercept !== 'object') {
    return errShape('Adapter profile intercept must be an object.');
  }

  const commandValue = extractValue(rawInput, intercept.command);
  if (typeof commandValue !== 'string' || commandValue.trim() === '') {
    return errShape('Adapter intercept.command did not resolve to a non-empty string.');
  }

  let args = [];
  if (typeof intercept.args === 'string') {
    const argsValue = extractValue(rawInput, intercept.args);
    if (argsValue == null) {
      args = [];
    } else if (Array.isArray(argsValue)) {
      if (!argsValue.every((e) => typeof e === 'string')) {
        return errShape('Adapter intercept.args must resolve to an array of strings.');
      }
      args = argsValue;
    } else if (typeof argsValue === 'string') {
      args = [argsValue];
    } else {
      return errShape('Adapter intercept.args must resolve to a string or array of strings.');
    }
  }

  let cwd = null;
  if (typeof intercept.cwd === 'string') {
    const cwdValue = extractValue(rawInput, intercept.cwd);
    if (cwdValue != null) {
      if (typeof cwdValue !== 'string' || cwdValue.trim() === '') {
        return errShape('Adapter intercept.cwd must resolve to a non-empty string when present.');
      }
      cwd = cwdValue;
    }
  }

  return { command: commandValue, args, cwd, error: null };
}

function errShape(error) {
  return { command: null, args: [], cwd: null, error };
}
