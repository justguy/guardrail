import { pretty } from './shared.js';
import {
  VALID_SESSION_LIFECYCLES,
  compareSessionContracts,
  isSessionRevoked,
} from './agent-session.js';

// ---------------------------------------------------------------------------
// Session-lifecycle evaluation (pure, no I/O)
// ---------------------------------------------------------------------------

/**
 * Evaluate a session-lifecycle request against an already-approved contract.
 *
 * Pure function: caller must load the approved contract (or pass null) before
 * invoking. Returns { ok, code?, reason?, diffs? }.
 *
 * Fail-closed codes:
 *   - session_missing          continue/attach against an absent contract
 *   - session_drift            identity fields changed for a continue
 *   - session_attach_mismatch  attach used with mismatched name/identity
 *   - session_already_exists   start collides with non-matching live contract
 */
export function evaluateSessionLifecycle(candidate, approved, lifecycle) {
  if (!candidate || typeof candidate !== 'object') {
    return {
      ok: false,
      code: 'session_missing',
      reason: 'session contract candidate is missing',
    };
  }

  // Revocation is checked against the on-disk approved contract before any
  // lifecycle evaluation. A revoked contract blocks all operations — distinct
  // from session_missing (no contract) and session_drift (wrong identity).
  if (isSessionRevoked(approved)) {
    return {
      ok: false,
      code: 'session_revoked',
      reason: `session has been revoked${approved.revokedBy ? ` by ${approved.revokedBy}` : ''}${approved.revocationReason ? `: ${approved.revocationReason}` : ''}`,
    };
  }

  const intent = lifecycle ?? candidate.lifecycle;
  if (!VALID_SESSION_LIFECYCLES.has(intent)) {
    return {
      ok: false,
      code: 'session_drift',
      reason: `unknown lifecycle ${pretty(intent)}; expected one of ${[...VALID_SESSION_LIFECYCLES].join(', ')}`,
    };
  }

  if (intent === 'start') return evaluateStart(candidate, approved);
  if (intent === 'continue') return evaluateContinue(candidate, approved);
  return evaluateAttach(candidate, approved);
}

function evaluateStart(candidate, approved) {
  if (approved === null || approved === undefined) {
    return { ok: true };
  }
  const { matches, diffs } = compareSessionContracts(candidate, approved);
  if (matches) {
    // Idempotent re-start of the same logical session is allowed so
    // re-running a workflow step never turns into a false drift failure.
    return { ok: true };
  }
  return {
    ok: false,
    code: 'session_already_exists',
    reason: 'a session contract already exists for this slot; explicit fresh start required',
    diffs,
  };
}

function evaluateContinue(candidate, approved) {
  if (approved === null || approved === undefined) {
    return {
      ok: false,
      code: 'session_missing',
      reason: 'continue requested but no approved session contract exists for this slot',
    };
  }
  if (approved.sessionId && candidate.sessionId && approved.sessionId !== candidate.sessionId) {
    return {
      ok: false,
      code: 'session_drift',
      reason: `continue rejected: sessionId mismatch (${pretty(approved.sessionId)} -> ${pretty(candidate.sessionId)})`,
    };
  }
  // Lifecycle intent is allowed to differ between approved and candidate
  // (previous write may have been a start); identity is what matters.
  const candidateForCompare = {
    ...candidate,
    lifecycle: approved.lifecycle ?? candidate.lifecycle,
  };
  const { matches, diffs } = compareSessionContracts(candidateForCompare, approved);
  if (matches) return { ok: true };
  return {
    ok: false,
    code: 'session_drift',
    reason: `session contract drift on continue: ${diffs.join('; ')}`,
    diffs,
  };
}

function evaluateAttach(candidate, approved) {
  if (!candidate.sessionName) {
    return {
      ok: false,
      code: 'session_attach_mismatch',
      reason: 'attach requires an explicit sessionName',
    };
  }
  if (approved === null || approved === undefined) {
    return {
      ok: false,
      code: 'session_missing',
      reason: 'attach requested but no approved session contract exists for this slot',
    };
  }
  if (approved.sessionName !== candidate.sessionName) {
    return {
      ok: false,
      code: 'session_attach_mismatch',
      reason: `attach rejected: sessionName mismatch (${pretty(approved.sessionName)} -> ${pretty(candidate.sessionName)})`,
    };
  }
  if (approved.sessionId && candidate.sessionId && approved.sessionId !== candidate.sessionId) {
    return {
      ok: false,
      code: 'session_attach_mismatch',
      reason: `attach rejected: sessionId mismatch (${pretty(approved.sessionId)} -> ${pretty(candidate.sessionId)})`,
    };
  }
  const candidateForCompare = {
    ...candidate,
    lifecycle: approved.lifecycle ?? candidate.lifecycle,
  };
  const { matches, diffs } = compareSessionContracts(candidateForCompare, approved);
  if (matches) return { ok: true };
  return {
    ok: false,
    code: 'session_attach_mismatch',
    reason: `attach rejected: identity mismatch (${diffs.join('; ')})`,
    diffs,
  };
}
