import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Org Policy Engine — org-wide enforcement that overrides local settings
// ---------------------------------------------------------------------------

/**
 * @typedef {object} OrgPolicy
 * @property {string} name
 * @property {string} version
 * @property {string[]} allowed_actions
 * @property {string[]} forbidden_operations
 * @property {string[]} required_approvals
 * @property {boolean} overrides_local - Always true for org policies.
 */

export function validateOrgPolicy(policy) {
  const errors = [];
  if (typeof policy.name !== 'string' || !policy.name.trim()) errors.push('name required');
  if (typeof policy.version !== 'string') errors.push('version required');
  if (!Array.isArray(policy.forbidden_operations)) errors.push('forbidden_operations must be an array');
  if (!Array.isArray(policy.required_approvals)) errors.push('required_approvals must be an array');
  return errors;
}

/**
 * Enforce an org policy against an action. Org policy always wins.
 */
export function enforceOrgPolicy(action, orgPolicy, localPolicy) {
  const violations = [];

  // Org forbidden operations override everything
  for (const forbidden of (orgPolicy.forbidden_operations || [])) {
    const cmdStr = [action.command, ...(action.args || [])].join(' ');
    if (cmdStr.includes(forbidden) || action.command === forbidden) {
      violations.push({ rule: 'forbidden_operation', detail: `"${forbidden}" is forbidden by org policy "${orgPolicy.name}"`, level: 'org' });
    }
  }

  // Org required approvals
  for (const reqApproval of (orgPolicy.required_approvals || [])) {
    if (action.risk_level === reqApproval || action.environment === reqApproval) {
      violations.push({ rule: 'required_approval', detail: `Org policy requires approval for "${reqApproval}"`, level: 'org' });
    }
  }

  // Org allowed actions (if specified, restricts to whitelist)
  if (orgPolicy.allowed_actions?.length > 0) {
    const allowed = new Set(orgPolicy.allowed_actions);
    if (!allowed.has(action.command) && !allowed.has('*')) {
      violations.push({ rule: 'allowed_actions', detail: `"${action.command}" not in org allowed list`, level: 'org' });
    }
  }

  // Local policy violations (lower priority — reported but don't override org)
  if (localPolicy) {
    for (const forbidden of (localPolicy.forbidden_operations || [])) {
      const cmdStr = [action.command, ...(action.args || [])].join(' ');
      if (cmdStr.includes(forbidden)) {
        violations.push({ rule: 'forbidden_operation', detail: `"${forbidden}" forbidden by local policy`, level: 'local' });
      }
    }
  }

  return { compliant: violations.length === 0, violations };
}

/**
 * Resolve policy hierarchy: org > team > user.
 * Returns the effective policy by merging in priority order.
 */
export function resolveHierarchy(orgPolicy, teamPolicy, userPolicy) {
  const effective = {
    allowed_actions:      orgPolicy?.allowed_actions ?? teamPolicy?.allowed_actions ?? userPolicy?.allowed_actions ?? [],
    forbidden_operations: [
      ...(orgPolicy?.forbidden_operations ?? []),
      ...(teamPolicy?.forbidden_operations ?? []),
      ...(userPolicy?.forbidden_operations ?? []),
    ],
    required_approvals: [
      ...new Set([
        ...(orgPolicy?.required_approvals ?? []),
        ...(teamPolicy?.required_approvals ?? []),
        ...(userPolicy?.required_approvals ?? []),
      ]),
    ],
    source: orgPolicy ? 'org' : teamPolicy ? 'team' : 'user',
  };

  // Org allowed_actions restricts (overrides), not extends
  if (orgPolicy?.allowed_actions?.length > 0) {
    effective.allowed_actions = orgPolicy.allowed_actions;
  }

  return effective;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function saveOrgPolicy(policy, dir) {
  const policyDir = resolve(dir, '.guardrail', 'org-policies');
  if (!existsSync(policyDir)) mkdirSync(policyDir, { recursive: true });
  const path = join(policyDir, `${policy.name}.json`);
  writeFileSync(path, JSON.stringify(policy, null, 2) + '\n', 'utf8');
  return path;
}

export function loadOrgPolicy(name, dir) {
  const path = join(resolve(dir, '.guardrail', 'org-policies'), `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}
