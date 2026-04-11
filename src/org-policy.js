import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

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
 * @property {string[]} trusted_recipe_roots
 * @property {string[]} trusted_execution_sources
 * @property {string[]} trusted_registries
 * @property {boolean} overrides_local - Always true for org policies.
 */

export function validateOrgPolicy(policy) {
  const errors = [];
  if (typeof policy.name !== 'string' || !policy.name.trim()) errors.push('name required');
  if (typeof policy.version !== 'string') errors.push('version required');
  if (!Array.isArray(policy.forbidden_operations)) errors.push('forbidden_operations must be an array');
  if (!Array.isArray(policy.required_approvals)) errors.push('required_approvals must be an array');
  if (!Array.isArray(policy.trusted_recipe_roots || [])) errors.push('trusted_recipe_roots must be an array');
  if (!Array.isArray(policy.trusted_execution_sources || [])) errors.push('trusted_execution_sources must be an array');
  if (!Array.isArray(policy.trusted_registries || [])) errors.push('trusted_registries must be an array');
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
    trusted_recipe_roots: [
      ...(orgPolicy?.trusted_recipe_roots ?? []),
      ...(teamPolicy?.trusted_recipe_roots ?? []),
      ...(userPolicy?.trusted_recipe_roots ?? []),
    ],
    trusted_execution_sources: [
      ...(orgPolicy?.trusted_execution_sources ?? []),
      ...(teamPolicy?.trusted_execution_sources ?? []),
      ...(userPolicy?.trusted_execution_sources ?? []),
    ],
    trusted_registries: [
      ...(orgPolicy?.trusted_registries ?? []),
      ...(teamPolicy?.trusted_registries ?? []),
      ...(userPolicy?.trusted_registries ?? []),
    ],
    source: orgPolicy ? 'org' : teamPolicy ? 'team' : 'user',
  };

  // Org allowed_actions restricts (overrides), not extends
  if (orgPolicy?.allowed_actions?.length > 0) {
    effective.allowed_actions = orgPolicy.allowed_actions;
  }
  if (orgPolicy?.trusted_recipe_roots?.length > 0) {
    effective.trusted_recipe_roots = orgPolicy.trusted_recipe_roots;
  }
  if (orgPolicy?.trusted_execution_sources?.length > 0) {
    effective.trusted_execution_sources = orgPolicy.trusted_execution_sources;
  }
  if (orgPolicy?.trusted_registries?.length > 0) {
    effective.trusted_registries = orgPolicy.trusted_registries;
  }

  return effective;
}

// ---------------------------------------------------------------------------
// Targeted trust boundaries
// ---------------------------------------------------------------------------

export function isTrustedRecipeRoot(rootPath, orgPolicy, baseDir = process.cwd()) {
  const policyRoots = orgPolicy?.trusted_recipe_roots;
  if (!Array.isArray(policyRoots) || policyRoots.length === 0) return true;

  const normalizedCandidate = resolve(rootPath);
  return policyRoots.some(rawRoot => {
    if (typeof rawRoot !== 'string' || rawRoot.trim().length === 0) return false;
    const normalizedPolicyRoot = resolve(baseDir, rawRoot);
    return normalizedCandidate === normalizedPolicyRoot
      || normalizedCandidate.startsWith(`${normalizedPolicyRoot}${sep}`);
  });
}

export function isTrustedExecutionSource(source, orgPolicy) {
  const policySources = orgPolicy?.trusted_execution_sources;
  if (!Array.isArray(policySources) || policySources.length === 0) return true;
  return policySources.some(rawSource => (
    typeof rawSource === 'string'
    && rawSource.length > 0
    && source.startsWith(rawSource)
  ));
}

export function isTrustedRegistry(registry, orgPolicy, baseDir = process.cwd()) {
  const policyRegistries = orgPolicy?.trusted_registries;
  if (!Array.isArray(policyRegistries) || policyRegistries.length === 0) return true;

  const candidate = registry.includes('://') ? registry : resolve(baseDir, registry);
  return policyRegistries.some((rawRegistry) => {
    if (typeof rawRegistry !== 'string' || rawRegistry.length === 0) return false;
    const normalized = rawRegistry.includes('://') ? rawRegistry : resolve(baseDir, rawRegistry);
    return candidate === normalized || candidate.startsWith(`${normalized}${sep}`);
  });
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

export function loadEffectiveOrgPolicy(dir) {
  const directPath = join(resolve(dir, '.guardrail'), 'org-policy.json');
  if (existsSync(directPath)) {
    return JSON.parse(readFileSync(directPath, 'utf8'));
  }
  return loadOrgPolicy('default', dir);
}

export function resolveActiveOrgPolicy({
  orgPolicy = null,
  orgPolicyName = null,
  orgPolicyDir = null,
  fallbackDir = process.cwd(),
} = {}) {
  const policyBase = resolve(orgPolicyDir || fallbackDir);
  const policy = orgPolicy
    || (orgPolicyName ? loadOrgPolicy(orgPolicyName, policyBase) : loadEffectiveOrgPolicy(policyBase));
  return { policy, policyBase };
}
