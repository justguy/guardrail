import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { buildIndex, buildVersionIndex, deduplicateLatest } from './recipe-index.js';
import { executeRecipe, dryRun } from './recipe-executor.js';
import { hashRecipe } from './recipe.js';

// ---------------------------------------------------------------------------
// Default search directories for recipe resolution
// ---------------------------------------------------------------------------

function defaultSearchDirs() {
  const dirs = ['recipes', 'node_modules/.guardrail/recipes'];
  const home = resolve(homedir(), '.guardrail', 'recipes');
  if (existsSync(home)) dirs.push(home);
  return dirs;
}

// ---------------------------------------------------------------------------
// Parse recipe specifier: "id" or "id@version"
// ---------------------------------------------------------------------------

/**
 * Parse a recipe specifier into id and optional version.
 *
 * @param {string} specifier - e.g. "git-branch-cleanup" or "git-branch-cleanup@1.2.0"
 * @returns {{ id: string, version: string|null }}
 */
export function parseRecipeSpecifier(specifier) {
  const at = specifier.lastIndexOf('@');
  if (at > 0 && /^\d+\.\d+\.\d+/.test(specifier.slice(at + 1))) {
    return { id: specifier.slice(0, at), version: specifier.slice(at + 1) };
  }
  return { id: specifier, version: null };
}

// ---------------------------------------------------------------------------
// Resolve a recipe by ID (optionally pinned to a version)
// ---------------------------------------------------------------------------

/**
 * Find a recipe by ID across search directories.
 * If version is specified, finds that exact version.
 * Otherwise, resolves to the latest installed version.
 *
 * @param {string} specifier  - Recipe ID or ID@version.
 * @param {string[]} [dirs]   - Directories to search.
 * @returns {{ recipe: object, sourcePath: string, version: string }}
 */
export function resolveRecipeById(specifier, dirs) {
  const { id, version } = parseRecipeSpecifier(specifier);
  const searchDirs = dirs || defaultSearchDirs();
  const versionIndex = buildVersionIndex(searchDirs);
  const versions = versionIndex.get(id);

  if (!versions || versions.length === 0) {
    const allIds = [...versionIndex.keys()];
    const hint = allIds.length > 0
      ? `\nAvailable recipes: ${allIds.join(', ')}`
      : '\nNo recipes found in search directories.';
    throw new Error(`Recipe "${id}" not found.${hint}`);
  }

  if (version) {
    // Exact version match
    const match = versions.find(v => v.version === version);
    if (!match) {
      const available = [...new Set(versions.map(v => v.version))].join(', ');
      throw new Error(
        `Recipe "${id}" version ${version} not found.\nAvailable versions: ${available}`
      );
    }
    return { recipe: match.recipe, sourcePath: match.source, version: match.version };
  }

  // Latest version (first in sorted-newest-first list)
  const latest = versions[0];
  return { recipe: latest.recipe, sourcePath: latest.source, version: latest.version };
}

// ---------------------------------------------------------------------------
// Validate and resolve inputs against recipe schema
// ---------------------------------------------------------------------------

/**
 * Validate CLI-provided inputs against recipe input schema.
 */
export function resolveInputs(recipe, cliInputs = {}) {
  const resolved = {};
  const errors = [];

  for (const [key, schema] of Object.entries(recipe.inputs || {})) {
    const value = cliInputs[key] ?? schema.default;

    if (value === undefined) {
      if (schema.required !== false) {
        errors.push(`Missing required input: "${key}"`);
      }
      continue;
    }

    if (schema.type === 'boolean') {
      if (value === 'true' || value === true) resolved[key] = true;
      else if (value === 'false' || value === false) resolved[key] = false;
      else errors.push(`Input "${key}" must be a boolean, got "${value}"`);
    } else if (schema.type === 'integer') {
      const n = Number(value);
      if (!Number.isInteger(n)) {
        errors.push(`Input "${key}" must be an integer, got "${value}"`);
      } else {
        if (schema.min !== undefined && n < schema.min) errors.push(`Input "${key}" must be >= ${schema.min}`);
        if (schema.max !== undefined && n > schema.max) errors.push(`Input "${key}" must be <= ${schema.max}`);
        resolved[key] = n;
      }
    } else {
      const str = String(value);
      if (schema.pattern && !new RegExp(schema.pattern).test(str)) {
        errors.push(`Input "${key}" does not match pattern ${schema.pattern}: "${str}"`);
      }
      if (schema.enum && !schema.enum.includes(str)) {
        errors.push(`Input "${key}" must be one of [${schema.enum.join(', ')}], got "${str}"`);
      }
      resolved[key] = str;
    }
  }

  for (const key of Object.keys(cliInputs)) {
    if (!recipe.inputs || !(key in recipe.inputs)) {
      errors.push(`Unknown input: "${key}"`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Input validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Run a recipe by specifier — orchestrator
// ---------------------------------------------------------------------------

/**
 * Resolve, validate, and execute a recipe by specifier.
 *
 * @param {string} specifier - Recipe ID or ID@version.
 * @param {object} opts      - { inputs, allowUnverified, dryRunOnly, ... }.
 * @returns {Promise<object>} Execution result.
 */
export async function runRecipeById(specifier, opts = {}) {
  const { recipe, sourcePath, version } = resolveRecipeById(specifier, opts.searchDirs);
  const resolved = resolveInputs(recipe, opts.inputs || {});

  // Verify content hash if expected hash provided
  if (opts.expectedHash) {
    const actual = hashRecipe(recipe);
    if (actual !== opts.expectedHash) {
      throw new Error(
        `Hash mismatch for "${recipe.id}@${version}": expected ${opts.expectedHash}, got ${actual}`
      );
    }
  }

  if (opts.dryRunOnly) {
    return {
      status: 'dry_run',
      recipe: { id: recipe.id, name: recipe.name, version },
      sourcePath,
      ...dryRun(recipe, resolved, { allowedPaths: opts.allowedPaths }),
    };
  }

  return executeRecipe(recipe, resolved, {
    allowUnverified: opts.allowUnverified || false,
    cwd: opts.cwd || process.cwd(),
    stateDir: opts.stateDir || '.guardrail',
    approved: opts.approved || false,
    allowedPaths: opts.allowedPaths,
  });
}

// ---------------------------------------------------------------------------
// Run a runbook (sequential multi-recipe execution)
// ---------------------------------------------------------------------------

/**
 * Execute a sequence of recipes (runbook).
 * Each recipe runs independently with its own guardrails.
 * Stops on first failure.
 *
 * @param {object[]} steps - Array of { recipe: "id@version", inputs: {} }.
 * @param {object} opts    - Shared options.
 * @returns {Promise<object>} Runbook result.
 */
export async function runRunbook(steps, opts = {}) {
  const results = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepOpts = { ...opts, inputs: step.inputs || {} };

    try {
      const result = await runRecipeById(step.recipe, stepOpts);
      results.push({ step: i + 1, recipe: step.recipe, ...result });

      if (result.status !== 'success' && result.status !== 'dry_run') {
        return {
          status: 'failed',
          failedStep: i + 1,
          failedRecipe: step.recipe,
          reason: result.reason || result.status,
          results,
        };
      }
    } catch (err) {
      results.push({ step: i + 1, recipe: step.recipe, status: 'error', reason: err.message });
      return {
        status: 'failed',
        failedStep: i + 1,
        failedRecipe: step.recipe,
        reason: err.message,
        results,
      };
    }
  }

  return { status: 'success', stepsCompleted: results.length, results };
}
