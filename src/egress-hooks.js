/**
 * egress-hooks.js — Pre-egress classification and scrubbing hook points.
 *
 * Provides structured allow/block/redact decisions before adapter output
 * leaves the Guardrail trust boundary. Outcomes are machine-readable with
 * typed reasons. Audit records include payload_hash but never the blocked
 * or redacted payload itself.
 *
 * This module is the seam — it defines the hook contract and enforcement
 * surface. Production-grade scrubbing (regex NLP, ML classifiers) is
 * out of scope for P0g.
 */

import { createHash } from 'node:crypto';
import { serializeStable } from './contract.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EGRESS_OUTCOMES = Object.freeze({
  ALLOW: 'allow',
  BLOCK: 'block',
  REDACT: 'redact',
});

export const SENSITIVITY_LABELS = Object.freeze({
  PUBLIC: 'public',
  INTERNAL: 'internal',
  CONFIDENTIAL: 'confidential',
  RESTRICTED: 'restricted',
});

// ---------------------------------------------------------------------------
// Payload classification
// ---------------------------------------------------------------------------

/**
 * Classify a payload against a set of rules.
 *
 * Each rule: { label, match_fields: string[], outcome, reason }
 * Rules are evaluated in order; first match wins.
 *
 * @param {object} payload     — Flat or nested object to inspect.
 * @param {object[]} rules     — Ordered list of classification rules.
 * @param {string} defaultLabel — Label when no rule matches.
 * @returns {{ label: string, reason: string, matchedRule: object|null, matchedFields: string[] }}
 */
export function classifyPayload(payload, rules = [], defaultLabel = SENSITIVITY_LABELS.PUBLIC) {
  const flatKeys = collectKeys(payload);

  for (const rule of rules) {
    if (!rule || !Array.isArray(rule.match_fields)) continue;
    const matched = rule.match_fields.filter(f => flatKeys.has(String(f).toLowerCase()));
    if (matched.length > 0) {
      return {
        label: rule.label ?? SENSITIVITY_LABELS.RESTRICTED,
        reason: typeof rule.reason === 'string' ? rule.reason : 'Matched classification rule.',
        matchedRule: rule,
        matchedFields: matched,
      };
    }
  }

  return {
    label: defaultLabel,
    reason: 'No classification rule matched.',
    matchedRule: null,
    matchedFields: [],
  };
}

// ---------------------------------------------------------------------------
// Egress hook runner
// ---------------------------------------------------------------------------

/**
 * Run the pre-egress hook for a payload.
 *
 * hookConfig shape:
 *   {
 *     enabled: boolean,
 *     rules: Array<{ label, match_fields, outcome, reason }>,
 *     default_label: string,
 *     default_outcome: 'allow'|'block'|'redact',
 *   }
 *
 * @param {object}   payload     — Output payload about to leave the trust boundary.
 * @param {object}   hookConfig  — Hook configuration (from profile or policy).
 * @param {Function} [auditFn]   — Optional audit callback: (entry) => void.
 * @returns {{
 *   outcome: 'allow'|'block'|'redact',
 *   label: string,
 *   reason: string,
 *   matchedFields: string[],
 *   sanitized: object|null,
 *   payloadHash: string,
 * }}
 */
export function runEgressHook(payload, hookConfig = {}, auditFn = null) {
  const enabled = hookConfig?.enabled !== false; // default enabled when config present
  const payloadHash = hashPayload(payload);

  if (!enabled) {
    return buildOutcome(EGRESS_OUTCOMES.ALLOW, SENSITIVITY_LABELS.PUBLIC, 'Egress hook disabled.', [], null, payloadHash);
  }

  const rules = Array.isArray(hookConfig.rules) ? hookConfig.rules : [];
  const defaultLabel = hookConfig.default_label ?? SENSITIVITY_LABELS.PUBLIC;
  const defaultOutcome = hookConfig.default_outcome ?? EGRESS_OUTCOMES.ALLOW;

  const classification = classifyPayload(payload, rules, defaultLabel);
  const outcome = classification.matchedRule
    ? (classification.matchedRule.outcome ?? defaultOutcome)
    : defaultOutcome;

  const validOutcome = Object.values(EGRESS_OUTCOMES).includes(outcome)
    ? outcome
    : EGRESS_OUTCOMES.BLOCK; // unknown outcome → fail closed

  const sanitized = validOutcome === EGRESS_OUTCOMES.REDACT
    ? redactFields(payload, classification.matchedFields)
    : null;

  const result = buildOutcome(
    validOutcome,
    classification.label,
    classification.reason,
    classification.matchedFields,
    sanitized,
    payloadHash,
  );

  if (typeof auditFn === 'function') {
    auditFn(buildAuditEntry(result));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Validate egress hook config
// ---------------------------------------------------------------------------

/**
 * Validate a hook config object. Returns error strings.
 * @param {object} hookConfig
 * @returns {string[]}
 */
export function validateEgressHookConfig(hookConfig) {
  const errors = [];
  if (typeof hookConfig !== 'object' || hookConfig === null) {
    return ['hookConfig must be an object'];
  }
  if (hookConfig.enabled !== undefined && typeof hookConfig.enabled !== 'boolean') {
    errors.push('enabled must be boolean');
  }
  if (hookConfig.default_label !== undefined && !Object.values(SENSITIVITY_LABELS).includes(hookConfig.default_label)) {
    errors.push(`default_label must be one of: ${Object.values(SENSITIVITY_LABELS).join(', ')}`);
  }
  if (hookConfig.default_outcome !== undefined && !Object.values(EGRESS_OUTCOMES).includes(hookConfig.default_outcome)) {
    errors.push(`default_outcome must be one of: ${Object.values(EGRESS_OUTCOMES).join(', ')}`);
  }
  if (hookConfig.rules !== undefined) {
    if (!Array.isArray(hookConfig.rules)) {
      errors.push('rules must be an array');
    } else {
      for (let i = 0; i < hookConfig.rules.length; i++) {
        const rule = hookConfig.rules[i];
        if (!rule || typeof rule !== 'object') { errors.push(`rules[${i}] must be an object`); continue; }
        if (!Array.isArray(rule.match_fields)) errors.push(`rules[${i}].match_fields must be an array`);
        if (rule.outcome !== undefined && !Object.values(EGRESS_OUTCOMES).includes(rule.outcome)) {
          errors.push(`rules[${i}].outcome must be one of: ${Object.values(EGRESS_OUTCOMES).join(', ')}`);
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Collect all lowercased key names from a nested object. */
function collectKeys(obj, depth = 0) {
  const keys = new Set();
  if (!obj || typeof obj !== 'object' || depth > 5) return keys;
  for (const k of Object.keys(obj)) {
    keys.add(k.toLowerCase());
    const nested = collectKeys(obj[k], depth + 1);
    for (const nk of nested) keys.add(nk);
  }
  return keys;
}

/** Compute a stable SHA-256 hash of a payload for audit records. */
function hashPayload(payload) {
  try {
    return createHash('sha256').update(serializeStable(payload)).digest('hex');
  } catch {
    return createHash('sha256').update(String(payload)).digest('hex');
  }
}

/**
 * Return a copy of payload with matched fields replaced by a redaction marker.
 * Only top-level keys are redacted (P0g scope — the seam, not deep scrubbing).
 */
function redactFields(payload, fields) {
  if (!payload || typeof payload !== 'object') return payload;
  const fieldSet = new Set(fields.map(f => f.toLowerCase()));
  const copy = { ...payload };
  for (const k of Object.keys(copy)) {
    if (fieldSet.has(k.toLowerCase())) {
      copy[k] = '[REDACTED]';
    }
  }
  return copy;
}

/** Build a normalized outcome object. */
function buildOutcome(outcome, label, reason, matchedFields, sanitized, payloadHash) {
  return {
    outcome,
    label,
    reason,
    matchedFields: Array.isArray(matchedFields) ? matchedFields : [],
    sanitized,
    payloadHash,
  };
}

/**
 * Build an audit entry for a hook result.
 * Does NOT include the original payload or any sanitized payload — only the hash,
 * outcome, label, reason, and which field names were matched.
 */
function buildAuditEntry(result) {
  return {
    event: 'egress_hook_result',
    outcome: result.outcome,
    label: result.label,
    reason: result.reason,
    matched_fields: result.matchedFields,
    // payload_hash lets auditors correlate without revealing content
    payload_hash: result.payloadHash,
    // sanitized_keys: field names that were redacted (names only, not values)
    sanitized_keys: result.sanitized ? Object.keys(result.sanitized).filter(k => result.sanitized[k] === '[REDACTED]') : null,
  };
}
