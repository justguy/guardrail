import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Policy schema
// ---------------------------------------------------------------------------

const POLICY_SCHEMA_VERSION = 1;

/**
 * Validate a policy definition.
 * @param {object} policy
 * @returns {string[]} Errors.
 */
export function validatePolicy(policy) {
  const errors = [];
  if (typeof policy.name !== 'string' || policy.name.trim() === '') {
    errors.push('name must be a non-empty string');
  }
  if (typeof policy.version !== 'string' || !/^\d+\.\d+\.\d+/.test(policy.version)) {
    errors.push('version must be semver');
  }
  if (!Array.isArray(policy.allowed_actions)) {
    errors.push('allowed_actions must be an array');
  }
  if (!Array.isArray(policy.restricted_scopes)) {
    errors.push('restricted_scopes must be an array');
  }
  if (!Array.isArray(policy.required_approvals)) {
    errors.push('required_approvals must be an array');
  }

  // Validate action entries
  for (const action of (policy.allowed_actions || [])) {
    if (typeof action !== 'string' && typeof action !== 'object') {
      errors.push('allowed_actions entries must be strings or objects');
    }
  }

  // Validate restricted scopes
  for (const scope of (policy.restricted_scopes || [])) {
    if (typeof scope !== 'string') {
      errors.push('restricted_scopes entries must be strings');
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Policy CRUD
// ---------------------------------------------------------------------------

/**
 * Save a policy to disk.
 */
export function savePolicy(policy, dir) {
  const policyDir = resolve(dir, 'policies');
  if (!existsSync(policyDir)) mkdirSync(policyDir, { recursive: true });
  const filePath = join(policyDir, `${policy.name}.policy.json`);
  writeFileSync(filePath, JSON.stringify({ schema_version: POLICY_SCHEMA_VERSION, ...policy }, null, 2) + '\n', 'utf8');
  return filePath;
}

/**
 * Load a policy by name from a directory.
 */
export function loadPolicy(name, dir) {
  const filePath = join(resolve(dir, 'policies'), `${name}.policy.json`);
  if (!existsSync(filePath)) throw new Error(`Policy "${name}" not found at ${filePath}`);
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * List all policies in a directory.
 */
export function listPolicies(dir) {
  const policyDir = resolve(dir, 'policies');
  if (!existsSync(policyDir)) return [];
  return readdirSync(policyDir)
    .filter(f => f.endsWith('.policy.json'))
    .map(f => {
      try { return JSON.parse(readFileSync(join(policyDir, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Policy enforcement
// ---------------------------------------------------------------------------

/**
 * Check an action against a policy. Returns violations.
 *
 * @param {object} action - { command, args, cwd, scope }
 * @param {object} policy - Loaded policy.
 * @returns {{ compliant: boolean, violations: object[] }}
 */
export function enforcePolicy(action, policy) {
  const violations = [];

  // Check if action command is in allowed list
  if (policy.allowed_actions.length > 0) {
    const allowed = new Set(
      policy.allowed_actions.map(a => typeof a === 'string' ? a : a.command).filter(Boolean),
    );
    if (allowed.size > 0 && !allowed.has(action.command) && !allowed.has('*')) {
      violations.push({ rule: 'allowed_actions', detail: `Command "${action.command}" not in allowed actions` });
    }
  }

  // Check scope restrictions
  for (const restricted of (policy.restricted_scopes || [])) {
    const resolvedRestricted = resolve(restricted);
    const cwd = resolve(action.cwd || process.cwd());
    if (cwd.startsWith(resolvedRestricted) || resolvedRestricted.startsWith(cwd)) {
      // Check args for paths in restricted scope
      for (const arg of (action.args || [])) {
        if (arg.startsWith('/') || arg.startsWith('./')) {
          const resolvedArg = resolve(arg);
          if (resolvedArg.startsWith(resolvedRestricted)) {
            violations.push({ rule: 'restricted_scopes', detail: `Path "${arg}" is in restricted scope "${restricted}"` });
          }
        }
      }
    }
  }

  return { compliant: violations.length === 0, violations };
}

/**
 * Format policy for human-readable display.
 */
export function formatPolicy(policy) {
  const lines = [];
  lines.push(`Policy: ${policy.name} v${policy.version}`);
  if (policy.description) lines.push(`  ${policy.description}`);
  lines.push(`  Allowed actions: ${policy.allowed_actions.length === 0 ? 'all' : policy.allowed_actions.join(', ')}`);
  lines.push(`  Restricted scopes: ${policy.restricted_scopes.length === 0 ? 'none' : policy.restricted_scopes.join(', ')}`);
  lines.push(`  Required approvals: ${policy.required_approvals.length === 0 ? 'none' : policy.required_approvals.join(', ')}`);
  return lines.join('\n');
}
