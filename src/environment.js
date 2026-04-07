import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Environment Separation — dev / staging / prod isolation
// ---------------------------------------------------------------------------

const VALID_ENVS = new Set(['dev', 'staging', 'prod']);

/**
 * Create an environment config.
 */
export function createEnvironment(name, opts = {}) {
  if (!VALID_ENVS.has(name)) throw new Error(`Invalid environment: "${name}". Valid: ${[...VALID_ENVS].join(', ')}`);
  return {
    name,
    policies:    opts.policies || [],
    credentials: opts.credentials || [],
    recipes:     opts.recipes || [],
    isolated:    true,
  };
}

/**
 * Check if cross-environment execution is attempted.
 *
 * @param {string} currentEnv - The active environment.
 * @param {string} targetEnv  - The target environment of the action.
 * @returns {{ allowed: boolean, reason: string|null }}
 */
export function checkCrossEnv(currentEnv, targetEnv) {
  if (currentEnv === targetEnv) return { allowed: true, reason: null };

  // Prod can never be accessed from non-prod
  if (targetEnv === 'prod' && currentEnv !== 'prod') {
    return { allowed: false, reason: `Cross-environment access denied: "${currentEnv}" cannot access "prod"` };
  }

  // Staging can be accessed from dev (promotion path)
  if (targetEnv === 'staging' && currentEnv === 'dev') {
    return { allowed: true, reason: null };
  }

  // Any other cross-env is blocked
  return { allowed: false, reason: `Cross-environment access denied: "${currentEnv}" → "${targetEnv}"` };
}

/**
 * Save environment config.
 */
export function saveEnvironment(env, stateDir) {
  const dir = resolve(stateDir, 'environments');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${env.name}.json`), JSON.stringify(env, null, 2) + '\n');
}

/**
 * Load environment config.
 */
export function loadEnvironment(name, stateDir) {
  const path = join(resolve(stateDir, 'environments'), `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Get current environment from config or env var.
 */
export function getCurrentEnv(stateDir) {
  // Check env var first
  const envVar = process.env.GUARDRAIL_ENV;
  if (envVar && VALID_ENVS.has(envVar)) return envVar;

  // Check config file
  const configPath = join(resolve(stateDir), 'current-env');
  if (existsSync(configPath)) {
    const name = readFileSync(configPath, 'utf8').trim();
    if (VALID_ENVS.has(name)) return name;
  }

  return 'dev'; // default
}

export { VALID_ENVS };
