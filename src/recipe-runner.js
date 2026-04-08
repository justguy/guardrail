import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { buildIndex, buildVersionIndex, deduplicateLatest } from './recipe-index.js';
import { executeRecipe, dryRun } from './recipe-executor.js';
import { hashRecipe, loadRemoteRecipe } from './recipe.js';
import { validateInputValue, inferApprovalMode } from './input-validator.js';
import { classifyBucket, summarizeCapabilities, escalateTraits } from './risk-traits.js';
import { pinPathForRecipePath, loadGitHubRecipeFromApi } from './recipe-install.js';

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
 * Returns { resolved, flagged, errors } — flagged inputs require approval.
 *
 * @param {object} recipe     - Validated recipe.
 * @param {object} cliInputs  - { key: value } from --input flags.
 * @param {object} [opts]     - { execution_shape }.
 * @returns {{ resolved: object, flagged: object[], errors: string[] }}
 */
export function resolveInputs(recipe, cliInputs = {}, opts = {}) {
  const resolved = {};
  const flagged = [];
  const errors = [];

  for (const [key, schema] of Object.entries(recipe.inputs || {})) {
    const raw = cliInputs[key] ?? schema.default;

    if (raw === undefined) {
      if (schema.required !== false) {
        errors.push(`Missing required input: "${key}"`);
      }
      continue;
    }

    // Run typed validation
    const result = validateInputValue(raw, schema, {
      execution_shape: opts.execution_shape,
    });

    if (!result.valid) {
      const bucket = classifyBucket(result.risk_traits);
      if (bucket === 'block') {
        errors.push(`Input "${key}" blocked: ${result.reasons.join(', ')}`);
      } else {
        errors.push(`Input "${key}": ${result.reasons.join(', ')}`);
      }
      continue;
    }

    resolved[key] = result.normalized ?? raw;

    if (result.risk_traits.length > 0 || result.never_reuse) {
      flagged.push({
        key, value: raw, normalized: result.normalized,
        traits: result.risk_traits, reasons: result.reasons,
        capabilities: summarizeCapabilities(result.risk_traits),
        parsed_shape: result.parsed_shape,
        never_reuse: result.never_reuse || false,
      });
    }
  }

  // Unknown inputs
  for (const key of Object.keys(cliInputs)) {
    if (!recipe.inputs || !(key in recipe.inputs)) {
      errors.push(`Unknown input: "${key}"`);
    }
  }

  // Cross-parameter escalation
  if (flagged.length > 0) {
    const allTraits = flagged.flatMap(f => f.traits);
    const escalated = escalateTraits(allTraits);
    const newTraits = escalated.filter(t => !allTraits.includes(t));
    if (newTraits.length > 0) {
      flagged.push({
        key: '_cross_parameter', value: null, normalized: null,
        traits: newTraits,
        reasons: newTraits.map(t => `Cross-parameter escalation: ${t}`),
        capabilities: summarizeCapabilities(newTraits),
      });
    }
  }

  if (errors.length > 0) {
    throw new Error(`Input validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  return { resolved, flagged };
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
  await verifyPinnedRecipeSource(recipe, sourcePath, opts);
  const { resolved, flagged } = resolveInputs(recipe, opts.inputs || {}, {
    execution_shape: opts.execution_shape,
  });

  // Verify content hash if expected hash provided
  if (opts.expectedHash) {
    const actual = hashRecipe(recipe);
    if (actual !== opts.expectedHash) {
      throw new Error(
        `Hash mismatch for "${recipe.id}@${version}": expected ${opts.expectedHash}, got ${actual}`
      );
    }
  }

  // Check for blocked inputs
  const blocked = flagged.filter(f => classifyBucket(f.traits) === 'block');
  if (blocked.length > 0) {
    const reasons = blocked.map(b => `Input "${b.key}": ${b.reasons.join(', ')}`);
    throw new Error(`Execution blocked:\n  - ${reasons.join('\n  - ')}`);
  }

  if (opts.dryRunOnly) {
    return {
      status: 'dry_run',
      recipe: { id: recipe.id, name: recipe.name, version },
      sourcePath, flagged,
      ...dryRun(recipe, resolved, { allowedPaths: opts.allowedPaths }),
    };
  }

  // In non-interactive, flagged inputs fail closed
  if (opts.nonInteractive && flagged.length > 0) {
    const caps = flagged.flatMap(f => f.capabilities);
    throw new Error(
      `Execution paused — approval required for:\n  - ${caps.join('\n  - ')}\n` +
      'Run interactively to approve, or use a manifest with approved values.'
    );
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

// ---------------------------------------------------------------------------
// Pin verification — GitHub-installed recipes
// ---------------------------------------------------------------------------

/**
 * Verify a recipe against its GitHub pin metadata (if present).
 *
 * - No pin file → no-op (pre-v0.2 or non-GitHub install)
 * - Local hash mismatch → exit 12 (tamper)
 * - Remote hash mismatch → exit 12 (upstream compromise)
 * - Network failure on remote check → warning, continue (offline-first)
 */
export async function verifyPinnedRecipeSource(recipe, sourcePath, opts = {}) {
  const pinPath = pinPathForRecipePath(sourcePath);
  if (!existsSync(pinPath)) return;

  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  const currentHash = hashRecipe(recipe);
  if (currentHash !== pin.content_hash) {
    throw Object.assign(
      new Error(
        `Pin verification failed for "${recipe.id}": local content hash does not match ` +
        `pinned hash from ${pin.source}. Recipe may have been tampered with.\n` +
        `Expected: ${pin.content_hash}\n` +
        `Got:      ${currentHash}\n` +
        'Re-install the recipe to fix: guardrail recipe install ' + pin.source
      ),
      { exitCode: 12 }
    );
  }

  // Re-fetch from GitHub to verify remote hasn't changed
  if (!opts.skipRemoteVerify) {
    try {
      const remoteLoader = opts.loadRemoteRecipe ?? loadRemoteRecipe;
      const githubApiLoader = opts.loadGitHubRecipeFromApi ?? loadGitHubRecipeFromApi;
      let remoteRecipe = null;

      try {
        remoteRecipe = await remoteLoader(pin.rawUrl);
      } catch (rawErr) {
        if (pin.owner && pin.repo && pin.path && pin.sha) {
          try {
            remoteRecipe = await githubApiLoader({
              owner: pin.owner,
              repo: pin.repo,
              path: pin.path,
            }, pin.sha);
          } catch {
            throw rawErr;
          }
        } else {
          throw rawErr;
        }
      }

      const remoteHash = hashRecipe(remoteRecipe);
      if (remoteHash !== pin.content_hash) {
        throw Object.assign(
          new Error(
            `Remote verification failed for "${recipe.id}": content at ${pin.source} ` +
            `no longer matches pinned hash. Possible upstream compromise. Exit 12.`
          ),
          { exitCode: 12 }
        );
      }
    } catch (err) {
      if (err.exitCode === 12) throw err;
      // Network failure is not fatal — local pin still protects
    }
  }
}
