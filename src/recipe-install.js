import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadRecipe, loadRemoteRecipe, hashRecipe, loadRawJson, validateRecipe } from './recipe.js';

const execFileAsync = promisify(execFile);

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
export function loadConfig(configPath, opts = {}) {
  const strict = opts?.strict === true;
  const path = configPath || resolve(homedir(), '.guardrail', 'config.json');
  const fallback = { trusted_sources: [], recipe_roots: [], default_recipe_roots: [] };
  if (!existsSync(path)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (strict) {
      if (parsed?.trusted_sources !== undefined && !Array.isArray(parsed.trusted_sources)) {
        throw new Error(`Invalid Guardrail config at ${path}: trusted_sources must be an array when present`);
      }
      if (parsed?.recipe_roots !== undefined && !Array.isArray(parsed.recipe_roots)) {
        throw new Error(`Invalid Guardrail config at ${path}: recipe_roots must be an array when present`);
      }
      if (parsed?.default_recipe_roots !== undefined && !Array.isArray(parsed.default_recipe_roots)) {
        throw new Error(`Invalid Guardrail config at ${path}: default_recipe_roots must be an array when present`);
      }
      const roots = [
        ...(Array.isArray(parsed?.recipe_roots) ? parsed.recipe_roots : []),
        ...(Array.isArray(parsed?.default_recipe_roots) ? parsed.default_recipe_roots : []),
      ];
      for (const value of roots) {
        if (typeof value !== 'string' || value.trim() === '') {
          throw new Error(`Invalid Guardrail config at ${path}: recipe root entries must be non-empty strings`);
        }
      }
    }
    const recipeRoots = Array.isArray(parsed?.recipe_roots) ? parsed.recipe_roots : [];
    const defaultRecipeRoots = Array.isArray(parsed?.default_recipe_roots)
      ? parsed.default_recipe_roots
      : recipeRoots;
    return {
      trusted_sources: Array.isArray(parsed?.trusted_sources) ? parsed.trusted_sources : [],
      recipe_roots: recipeRoots,
      default_recipe_roots: defaultRecipeRoots,
      ...parsed,
    };
  } catch (err) {
    if (strict) throw err;
    return fallback;
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

function _installRecipeToStore(recipe, opts = {}) {
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
  return _installRecipeToStore(recipe, opts);
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
  return _installRecipeToStore(recipe, opts);
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
      const versionFiles = readdirSync(idDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
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
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .map(f => f.replace('.json', ''))
    .sort(compareSemver);
}

// ---------------------------------------------------------------------------
// GitHub URL parsing
// ---------------------------------------------------------------------------

/**
 * Parse a github:// URL into components.
 *
 * Format: github://owner/repo/path/to/file.json@sha
 * Returns: { owner, repo, path, sha, rawUrl }
 * Throws on missing sha or invalid format.
 */
export function parseGitHubUrl(source) {
  const rest = source.replace(/^github:\/\//, '');

  const atIdx = rest.lastIndexOf('@');
  if (atIdx === -1) {
    throw new Error(
      `GitHub recipe URL must include a commit SHA: ${source}\n` +
      'Format: github://owner/repo/path/to/file.json@<sha>'
    );
  }

  const pathPart = rest.slice(0, atIdx);
  const sha = rest.slice(atIdx + 1);

  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error(`Invalid commit SHA "${sha}" in: ${source}`);
  }

  const segments = pathPart.split('/');
  if (segments.length < 3) {
    throw new Error(
      `GitHub URL must include owner/repo/path: ${source}\n` +
      'Format: github://owner/repo/path/to/file.json@<sha>'
    );
  }

  const owner = segments[0];
  const repo = segments[1];
  const path = segments.slice(2).join('/');

  return {
    owner,
    repo,
    path,
    sha,
    rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`,
  };
}

// ---------------------------------------------------------------------------
// SHA resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a short SHA to a full 40-character SHA via the GitHub API.
 * Fails closed if the full SHA cannot be resolved.
 */
async function resolveFullSha(parsed) {
  if (parsed.sha.length === 40) return parsed.sha.toLowerCase();

  // Try gh CLI first — authenticated requests, 5000/hr rate limit
  try {
    const { stdout } = await execFileAsync('gh', [
      'api', `repos/${parsed.owner}/${parsed.repo}/commits/${parsed.sha}`,
      '--jq', '.sha',
    ], { timeout: 10000 });
    const fullSha = stdout.trim();
    if (/^[0-9a-f]{40}$/i.test(fullSha)) return fullSha;
  } catch { /* gh not available or API error */ }

  // Fallback: GitHub API via loadRawJson
  try {
    const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${parsed.sha}`;
    const obj = await loadRawJson(url, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (obj.sha && /^[0-9a-f]{40}$/i.test(obj.sha)) return obj.sha;
  } catch { /* try next path */ }

  throw new Error(
    `Could not resolve short SHA "${parsed.sha}" for github://${parsed.owner}/${parsed.repo}/${parsed.path}.\n` +
    'Use a full 40-character SHA, or retry with GitHub API access available.'
  );
}

// ---------------------------------------------------------------------------
// GitHub API content fallback
// ---------------------------------------------------------------------------

/**
 * Load a recipe file through the authenticated GitHub contents API.
 * This is the fallback path when raw.githubusercontent.com is unavailable,
 * which commonly happens for private repositories.
 */
export async function loadGitHubRecipeFromApi(parsed, fullSha) {
  const { stdout } = await execFileAsync('gh', [
    'api',
    `repos/${parsed.owner}/${parsed.repo}/contents/${parsed.path}?ref=${fullSha}`,
    '--jq',
    '.content',
  ], { timeout: 10000 });

  const content = stdout.replace(/\s+/g, '');
  if (!content) {
    throw new Error(
      `GitHub contents API returned no content for github://${parsed.owner}/${parsed.repo}/${parsed.path}@${fullSha}`
    );
  }

  let recipe;
  try {
    recipe = JSON.parse(Buffer.from(content, 'base64').toString('utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON from GitHub contents API: ${err.message}`);
  }

  validateRecipe(recipe);
  return recipe;
}

// ---------------------------------------------------------------------------
// Pin path helper
// ---------------------------------------------------------------------------

/**
 * Compute the pin metadata path for a recipe file path.
 * Pin metadata lives under a hidden .pins/ directory.
 */
export function pinPathForRecipePath(recipePath) {
  const version = basename(recipePath, '.json');
  return join(dirname(recipePath), '.pins', `${version}.json`);
}

// ---------------------------------------------------------------------------
// Install from GitHub
// ---------------------------------------------------------------------------

/**
 * Install a recipe from a github:// URL with SHA pinning.
 *
 * Fetches from raw.githubusercontent.com at the exact commit SHA,
 * validates the recipe, stores it locally, and writes pin metadata.
 */
export async function installFromGitHub(source, opts = {}) {
  const config = loadConfig(opts.configPath);
  const policy = getOrgPolicyFromOpts(opts);
  const configPath = opts.configPath || resolve(homedir(), '.guardrail', 'config.json');

  if (!config.trusted_sources || config.trusted_sources.length === 0) {
    throw new Error(
      `No trusted sources configured. Add a trusted_sources array to ${configPath}.\n` +
      `Example: { "trusted_sources": ["github://guardrail-dev/recipes/"] }`
    );
  }
  if (!checkTrustedSource(source, config.trusted_sources)) {
    throw new Error(
      `Source "${source}" is not in trusted sources.\n` +
      `Add a matching prefix to ${configPath}.`
    );
  }
  if (!isTrustedExecutionSource(source, policy)) {
    const policyLabel = policy?.name || 'active';
    throw new Error(
      `Source "${source}" is not in trusted execution sources for org policy "${policyLabel}".` +
      ` Add trusted_execution_sources to this policy.`
    );
  }

  const parsed = parseGitHubUrl(source);

  // Resolve short SHA to full 40-char SHA
  const fullSha = await resolveFullSha(parsed);
  const resolvedRawUrl = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${fullSha}/${parsed.path}`;

  const remoteLoader = opts.loadRemoteRecipe ?? loadRemoteRecipe;
  let recipe;
  try {
    recipe = await remoteLoader(resolvedRawUrl);
  } catch (rawErr) {
    const githubApiLoader = opts.loadGitHubRecipeFromApi ?? loadGitHubRecipeFromApi;
    try {
      recipe = await githubApiLoader(parsed, fullSha);
    } catch {
      throw rawErr;
    }
  }
  const result = _installRecipeToStore(recipe, opts);

  // Write pin metadata
  const pinPath = pinPathForRecipePath(result.path);
  mkdirSync(dirname(pinPath), { recursive: true });
  const pin = {
    source,
    owner: parsed.owner,
    repo: parsed.repo,
    path: parsed.path,
    sha: fullSha,
    input_sha: parsed.sha,
    rawUrl: resolvedRawUrl,
    content_hash: result.hash,
    installed_at: new Date().toISOString(),
  };
  writeFileSync(pinPath, JSON.stringify(pin, null, 2) + '\n');

  return { ...result, pin };
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
