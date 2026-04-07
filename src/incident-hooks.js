// ---------------------------------------------------------------------------
// Incident Response Hooks — triggers on violations and abnormal activity
// ---------------------------------------------------------------------------

/**
 * @typedef {object} IncidentHook
 * @property {string} trigger  - Event pattern: policy_violation, execution_failed, abnormal_activity.
 * @property {string} action   - Response: alert, halt, escalate.
 * @property {object} [config] - Action-specific config (webhook url, escalation target, etc.).
 */

const VALID_TRIGGERS = new Set([
  'policy_violation', 'execution_failed', 'abnormal_activity',
  'resource_exceeded', 'audit_chain_broken', 'concurrent_blocked',
]);

const VALID_ACTIONS = new Set(['alert', 'halt', 'escalate', 'log']);

/**
 * Validate an incident hook definition.
 */
export function validateHook(hook) {
  const errors = [];
  if (!VALID_TRIGGERS.has(hook.trigger)) {
    errors.push(`trigger must be one of ${[...VALID_TRIGGERS].join(', ')}`);
  }
  if (!VALID_ACTIONS.has(hook.action)) {
    errors.push(`action must be one of ${[...VALID_ACTIONS].join(', ')}`);
  }
  return errors;
}

/**
 * Create an incident response system.
 *
 * @param {IncidentHook[]} hooks - Configured hooks.
 * @param {object} [notifier]    - Optional notification dispatcher.
 * @returns {object} Incident response interface.
 */
export function createIncidentResponder(hooks = [], notifier = null) {
  const incidents = [];

  /**
   * Process an event and fire matching hooks.
   *
   * @param {string} eventType - The event that occurred.
   * @param {object} context   - Event context (actor, details, etc.).
   * @returns {{ triggered: object[], halt: boolean }}
   */
  function process(eventType, context = {}) {
    const matching = hooks.filter(h => h.trigger === eventType);
    const triggered = [];
    let halt = false;

    for (const hook of matching) {
      const incident = {
        trigger:    eventType,
        action:     hook.action,
        context,
        timestamp:  new Date().toISOString(),
        resolved:   false,
      };

      switch (hook.action) {
        case 'halt':
          halt = true;
          incident.message = `Execution halted due to ${eventType}`;
          break;
        case 'escalate':
          incident.message = `Escalated: ${eventType} — requires attention from ${hook.config?.target ?? 'admin'}`;
          break;
        case 'alert':
          incident.message = `Alert: ${eventType}`;
          if (notifier) {
            notifier.notify({
              type: eventType,
              message: incident.message,
              actor: context.actor,
              details: context,
            });
          }
          break;
        case 'log':
          incident.message = `Logged: ${eventType}`;
          break;
      }

      incidents.push(incident);
      triggered.push(incident);
    }

    return { triggered, halt };
  }

  function getIncidents() { return incidents; }

  function unresolvedCount() { return incidents.filter(i => !i.resolved).length; }

  return { process, getIncidents, unresolvedCount };
}

/**
 * Example incident hook configurations.
 */
export const EXAMPLE_HOOKS = [
  { trigger: 'policy_violation', action: 'alert', config: { target: 'security-team' } },
  { trigger: 'execution_failed', action: 'log', config: {} },
  { trigger: 'abnormal_activity', action: 'halt', config: {} },
  { trigger: 'audit_chain_broken', action: 'escalate', config: { target: 'admin' } },
  { trigger: 'resource_exceeded', action: 'alert', config: { target: 'ops-team' } },
];

export { VALID_TRIGGERS, VALID_ACTIONS };
