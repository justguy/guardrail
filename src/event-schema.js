// ---------------------------------------------------------------------------
// Event Schema v1 — single vocabulary source for all Guardrail subsystems
// ---------------------------------------------------------------------------
// Every event emitted by audit, metrics, notifications, incident-hooks, and
// compliance carries two mandatory envelope fields:
//   schema_version: 1          (integer, bumped on breaking changes)
//   family: <string>           (one of the five families below)
//
// Subsystems MUST import event strings from this file rather than defining
// their own sets. This keeps all five families consistent across surfaces.
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Five event families
// ---------------------------------------------------------------------------

/**
 * Execution events — command/workflow/recipe run lifecycle, approval, drift,
 * rollback, locking.
 */
export const EXECUTION_EVENTS = new Set([
  'execution_start', 'execution_end', 'execution_success',
  'execution_failed', 'execution_failure', 'execution_aborted',
  'approval_granted', 'approval_denied', 'approval_required',
  'drift_detected', 'manifest_saved',
  'recipe_executed',
  'step_completed', 'step_failed', 'step_blocked',
  'rollback_start', 'rollback_end',
  'lock_acquired', 'lock_released', 'lock_blocked',
]);

/**
 * Admin/control events — configuration changes, deployment mode, key
 * rotation, recipe lifecycle admin actions.
 */
export const ADMIN_EVENTS = new Set([
  'config_changed', 'deploy_mode_changed', 'key_rotated',
  'recipe_installed', 'recipe_published', 'profile_updated',
]);

/**
 * Access/read/export events — read queries against audit log, compliance
 * exports, metrics reads, manifest reads. These are never execution events.
 */
export const ACCESS_EVENTS = new Set([
  'audit_queried', 'compliance_exported', 'metrics_read',
  'manifest_read', 'policy_read',
]);

/**
 * Policy/authorization events — policy evaluation outcomes, RBAC checks,
 * resource limit enforcement, violations.
 */
export const POLICY_EVENTS = new Set([
  'violation_detected', 'policy_violation', 'resource_exceeded',
  'rbac_check', 'policy_eval_allowed', 'policy_eval_blocked',
  'recipe_blocked',
]);

/**
 * Incident/emergency events — abnormal activity, audit chain breaks,
 * escalations, concurrent access blocks.
 */
export const INCIDENT_EVENTS = new Set([
  'incident_detected', 'abnormal_activity',
  'audit_chain_broken', 'concurrent_blocked',
  'incident_escalated', 'incident_halted',
]);

// ---------------------------------------------------------------------------
// Unified event vocabulary
// ---------------------------------------------------------------------------

/** Flat map from event type string → family name. */
export const FAMILY_MAP = new Map([
  ...([...EXECUTION_EVENTS].map(e => [e, 'execution'])),
  ...([...ADMIN_EVENTS].map(e => [e, 'admin'])),
  ...([...ACCESS_EVENTS].map(e => [e, 'access'])),
  ...([...POLICY_EVENTS].map(e => [e, 'policy'])),
  ...([...INCIDENT_EVENTS].map(e => [e, 'incident'])),
]);

/** All known event type strings across all families. */
export const ALL_EVENTS = new Set(FAMILY_MAP.keys());

/**
 * Return the family for a given event type string.
 * Returns 'unknown' for unregistered event types.
 *
 * @param {string} type
 * @returns {'execution'|'admin'|'access'|'policy'|'incident'|'unknown'}
 */
export function eventFamily(type) {
  return FAMILY_MAP.get(type) ?? 'unknown';
}

/**
 * Attach schema envelope fields (schema_version, family) to an event object.
 * Does not mutate the input; returns a new object.
 *
 * @param {string} type   - Event type string.
 * @param {object} fields - Additional event fields.
 * @returns {object}
 */
export function makeEventEntry(type, fields = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    family: eventFamily(type),
    event: type,
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// Derived sets used by specific subsystems
// ---------------------------------------------------------------------------

/**
 * Events that trigger outbound notifications (webhook/slack/email/log).
 * Derived from the shared vocabulary — no bespoke string literals.
 */
export const NOTIFY_EVENTS = new Set([
  'approval_required',
  'execution_success',
  'execution_failure',
  'policy_violation',
  'incident_detected',
]);

/**
 * Event types that can trigger incident hooks.
 * Spans execution, policy, and incident families intentionally — an incident
 * hook can fire on events from any family.
 */
export const INCIDENT_TRIGGERS = new Set([
  'policy_violation',
  'execution_failed',
  'abnormal_activity',
  'resource_exceeded',
  'audit_chain_broken',
  'concurrent_blocked',
]);
