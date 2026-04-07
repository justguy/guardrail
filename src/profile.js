import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_RISK_TOLERANCES = new Set(['low', 'medium', 'high']);
const VALID_ENVIRONMENTS = new Set(['dev', 'staging', 'prod']);
const PROFILES_DIR = join(homedir(), '.guardrail', 'profiles');

// ---------------------------------------------------------------------------
// Profile schema
// ---------------------------------------------------------------------------

/**
 * Validate a profile definition.
 * @param {object} profile
 * @returns {string[]} Errors (empty = valid).
 */
export function validateProfile(profile) {
  const errors = [];
  if (typeof profile.name !== 'string' || profile.name.trim() === '') {
    errors.push('name must be a non-empty string');
  }
  if (!VALID_RISK_TOLERANCES.has(profile.risk_tolerance)) {
    errors.push(`risk_tolerance must be one of ${[...VALID_RISK_TOLERANCES].join(', ')}`);
  }
  if (!VALID_ENVIRONMENTS.has(profile.environment)) {
    errors.push(`environment must be one of ${[...VALID_ENVIRONMENTS].join(', ')}`);
  }
  if (typeof profile.approval_rules !== 'object' || profile.approval_rules === null) {
    errors.push('approval_rules must be an object');
  } else {
    if (typeof profile.approval_rules.require_for_high_risk !== 'boolean') {
      errors.push('approval_rules.require_for_high_risk must be a boolean');
    }
    if (typeof profile.approval_rules.require_for_prod !== 'boolean') {
      errors.push('approval_rules.require_for_prod must be a boolean');
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Profile CRUD
// ---------------------------------------------------------------------------

/**
 * Save a profile to disk.
 */
export function saveProfile(profile) {
  const errors = validateProfile(profile);
  if (errors.length > 0) {
    throw new Error(`Invalid profile:\n  - ${errors.join('\n  - ')}`);
  }
  if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true });
  const filePath = join(PROFILES_DIR, `${profile.name}.json`);
  writeFileSync(filePath, JSON.stringify(profile, null, 2) + '\n', 'utf8');
  return filePath;
}

/**
 * Load a profile by name.
 */
export function loadProfile(name) {
  const filePath = join(PROFILES_DIR, `${name}.json`);
  if (!existsSync(filePath)) throw new Error(`Profile "${name}" not found at ${filePath}`);
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * List all saved profiles.
 */
export function listProfiles() {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(readFileSync(join(PROFILES_DIR, f), 'utf8'));
      } catch { return null; }
    })
    .filter(Boolean);
}

/**
 * Get the active profile (stored in ~/.guardrail/active-profile).
 */
export function getActiveProfile() {
  const activePath = join(homedir(), '.guardrail', 'active-profile');
  if (!existsSync(activePath)) return null;
  const name = readFileSync(activePath, 'utf8').trim();
  try { return loadProfile(name); } catch { return null; }
}

/**
 * Set the active profile.
 */
export function setActiveProfile(name) {
  // Verify profile exists
  loadProfile(name);
  const dir = join(homedir(), '.guardrail');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'active-profile'), name, 'utf8');
}

/**
 * Apply profile to execution context — returns overrides.
 */
export function applyProfile(profile) {
  const overrides = {
    approvalRequired: false,
    dryRunDefault: false,
    blockedPatterns: [],
  };

  // Risk tolerance affects defaults
  if (profile.risk_tolerance === 'low') {
    overrides.dryRunDefault = true;
    overrides.approvalRequired = true;
  }

  // Environment affects approval
  if (profile.environment === 'prod') {
    overrides.approvalRequired = true;
    overrides.blockedPatterns.push('recursive delete', 'wildcard on root');
  }

  // Explicit approval rules
  if (profile.approval_rules?.require_for_high_risk) {
    overrides.approvalRequired = true;
  }

  return overrides;
}

// ---------------------------------------------------------------------------
// Built-in profiles
// ---------------------------------------------------------------------------

export const BUILTIN_PROFILES = {
  'cautious-dev': {
    name: 'cautious-dev',
    description: 'Conservative developer profile — dry-run by default, approval for all risky actions',
    risk_tolerance: 'low',
    environment: 'dev',
    approval_rules: { require_for_high_risk: true, require_for_prod: true, auto_approve_low_risk: false },
  },
  'fast-ci': {
    name: 'fast-ci',
    description: 'CI/CD profile — non-interactive, trusts approved manifests, medium risk tolerance',
    risk_tolerance: 'medium',
    environment: 'staging',
    approval_rules: { require_for_high_risk: true, require_for_prod: true, auto_approve_low_risk: true },
  },
  'prod-safe': {
    name: 'prod-safe',
    description: 'Production profile — maximum safety, approval required for everything',
    risk_tolerance: 'low',
    environment: 'prod',
    approval_rules: { require_for_high_risk: true, require_for_prod: true, auto_approve_low_risk: false },
  },
};
