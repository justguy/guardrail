import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { loadRecipe, loadRemoteRecipe, hashRecipe } from './recipe.js';

// ---------------------------------------------------------------------------
// Registry directory management
// ---------------------------------------------------------------------------

/**
 * Ensure the local recipe registry directory exists.
 *
 * @param {string} [registryDir] - Override for testing.
 * @returns {string} Absolute path to the registry directory.
 */
export function ensureRegistryDir(registryDir) {
  const dir = registryDir || resolve(homedir(), '.guardrail', 'recipes');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Versioned path helpers
// ---------------------------------------------------------------------------

/**
 * Build the versioned storage path for a recipe.
 * Layout: <registryDir>/<id>/<version>.json
 */
function versionedPath(registryDir, id, version) {
  return join(registryDir, id, `${version}.json`);
}

/**
 * Build the recipe subdirectory path.
 */
function recipeDir(registryDir, id) {
  return join(registryDir, id);
}

// ---------------------------------------------------------------------------
// Trusted source configuration
// ---------------------------------------------------------------------------

/**
 * Load trusted sources from config.
 */
export function loadConfig(configPath) {
  const path = configPath || resolve(homedir(), '.guardrail', 'config.json');
  if (!existsSync(path)) return { trusted_sources: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { trusted_sources: [] };
  }
}

/**
 * Check if a source URL is trusted.
 */
export function checkTrustedSource(source, trustedSources) {
  if (!trustedSources || trustedSources.length === 0) return false;
  return trustedSources.some(ts => source.startsWith(ts));
}

// ---------------------------------------------------------------------------
// Core install logic (shared by path and URL install)
// ---------------------------------------------------------------------------

function installRecipe(recipe, opts = {}) {
  const registryDir = ensureRegistryDir(opts.registryDir);
  const idDir = recipeDir(registryDir, recipe.id);
  const targetPath = versionedPath(registryDir, recipe.id, recipe.version);
  const hash = hashRecipe(recipe);

  // Immutability: block overwrite of existing version unless content matches
  if (existsSync(targetPath)) {
    const existing = JSON.parse(readFileSync(targetPath, 'utf8'));
    const existingHash = hashRecipe(existing);
    if (existingHash === hash) {
      return { installed: false, id: recipe.id, version: recipe.version, path: targetPath, hash, note: 'already installed (identical)' };
    }
    if (!opts.force) {
      throw new Error(
        `Recipe "${recipe.id}" v${recipe.version} already installed with different content. ` +
        'Version is immutable — publish a new version instead.'
      );
    }
  }

  // Also check flat legacy path and migrate if needed
  const legacyPath = join(registryDir, `${recipe.id}.recipe.json`);
  // Don't migrate — just install in new location

  if (!existsSync(idDir)) {
    mkdirSync(idDir, { recursive: true });
  }
  writeFileSync(targetPath, JSON.stringify(recipe, null, 2) + '\n');

  return { installed: true, id: recipe.id, version: recipe.version, path: targetPath, hash };
}

// ---------------------------------------------------------------------------
// Install from local path
// ---------------------------------------------------------------------------

/**
 * Install a recipe from a local file path.
 */
export function installFromPath(filePath, opts = {}) {
  const recipe = loadRecipe(resolve(filePath));
  return installRecipe(recipe, opts);
}

// ---------------------------------------------------------------------------
// Install from URL
// ---------------------------------------------------------------------------

/**
 * Install a recipe from a remote URL.
 */
export async function installFromUrl(url, opts = {}) {
  const config = loadConfig(opts.configPath);
  if (!config.trusted_sources || config.trusted_sources.length === 0) {
    throw new Error(
      'No trusted sources configured for remote recipe install. ' +
      'Add a trusted_sources array to ~/.guardrail/config.json first.'
    );
  }
  if (!checkTrustedSource(url, config.trusted_sources)) {
    throw new Error(
      `Source "${url}" is not in trusted sources. ` +
      'Add a matching prefix to ~/.guardrail/config.json.'
    );
  }
  const remoteLoader = opts.loadRemoteRecipe ?? loadRemoteRecipe;
  const recipe = await remoteLoader(url);
  return installRecipe(recipe, opts);
}

// ---------------------------------------------------------------------------
// List installed recipes (supports versioned + legacy flat)
// ---------------------------------------------------------------------------

/**
 * List all recipes installed in the local registry.
 * Supports both versioned (<id>/<version>.json) and legacy (<id>.recipe.json).
 */
export function listInstalled(registryDir) {
  const dir = registryDir || resolve(homedir(), '.guardrail', 'recipes');
  if (!existsSync(dir)) return [];

  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Versioned: <id>/<version>.json
      const idDir = join(dir, entry.name);
      const versionFiles = readdirSync(idDir).filter(f => f.endsWith('.json'));
      for (const vf of versionFiles) {
        try {
          const recipe = JSON.parse(readFileSync(join(idDir, vf), 'utf8'));
          results.push({
            id: recipe.id, name: recipe.name, version: recipe.version,
            category: recipe.category, risk_level: recipe.risk_level,
            path: join(idDir, vf),
          });
        } catch { /* skip invalid */ }
      }
    } else if (entry.name.endsWith('.recipe.json')) {
      // Legacy flat: <id>.recipe.json
      try {
        const recipe = JSON.parse(readFileSync(join(dir, entry.name), 'utf8'));
        results.push({
          id: recipe.id, name: recipe.name, version: recipe.version,
          category: recipe.category, risk_level: recipe.risk_level,
          path: join(dir, entry.name), legacy: true,
        });
      } catch { /* skip invalid */ }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// List versions of a specific recipe
// ---------------------------------------------------------------------------

/**
 * List all installed versions of a recipe.
 */
export function listVersions(recipeId, registryDir) {
  const dir = registryDir || resolve(homedir(), '.guardrail', 'recipes');
  const idDir = join(dir, recipeId);
  if (!existsSync(idDir)) return [];

  return readdirSync(idDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort(compareSemver);
}

// ---------------------------------------------------------------------------
// Semver comparison (simple)
// ---------------------------------------------------------------------------

function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
