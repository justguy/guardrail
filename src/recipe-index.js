import { readdirSync, existsSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { loadRecipe, VALID_CATEGORIES } from './recipe.js';

const LOOKUP_CASE_INSENSITIVE = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Search directory normalization utilities
// ---------------------------------------------------------------------------

function toPortablePath(value) {
  if (!value || typeof value !== 'string') return '';
  const normalized = normalize(value);
  const withSlash = normalized.split(sep).join('/');
  return LOOKUP_CASE_INSENSITIVE ? withSlash.toLowerCase() : withSlash;
}

export function normalizeSearchDirectory(rawDir, basePath = process.cwd()) {
  if (!rawDir || typeof rawDir !== 'string') return null;
  return isAbsolute(rawDir) ? resolve(rawDir) : resolve(basePath, rawDir);
}

export function normalizeSearchDirectories(dirs, basePath = process.cwd()) {
  const normalized = [];
  const seen = new Set();
  for (const rawDir of dirs || []) {
    const resolved = normalizeSearchDirectory(rawDir, basePath);
    if (!resolved) continue;
    if (!existsSync(resolved)) continue;
    const canonical = toPortablePath(resolved);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    normalized.push(resolved);
  }
  return normalized;
}

export function normalizePathForRecipeLookup(rawPath, basePath = process.cwd()) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  return toPortablePath(isAbsolute(rawPath) ? rawPath : resolve(basePath, rawPath));
}

// ---------------------------------------------------------------------------
// Index building — scan directories for recipe files
// Supports: flat (*.recipe.json) and versioned (<id>/<version>.json)
// ---------------------------------------------------------------------------

/**
 * Scan one or more directories and build a recipe index.
 *
 * @param {string[]} dirs - Directories to scan for recipe files.
 * @returns {object[]} Array of indexed recipe entries.
 */
export function buildIndex(dirs) {
  const entries = [];
  const normalizedDirs = normalizeSearchDirectories(dirs);
  for (const resolved of normalizedDirs) {

    const items = readdirSync(resolved, { withFileTypes: true });

    for (const item of items) {
      if (item.isDirectory()) {
        // Versioned: <id>/<version>.json — index all versions
        const idDir = join(resolved, item.name);
        const vFiles = readdirSync(idDir).filter(f => f.endsWith('.json'));
        for (const vf of vFiles) {
          tryAddRecipe(entries, join(idDir, vf), resolved);
        }
      } else if (item.name.endsWith('.recipe.json')) {
        // Flat legacy: <id>.recipe.json
          tryAddRecipe(entries, join(resolved, item.name), resolved);
      }
    }
  }
  return entries;
}

function tryAddRecipe(entries, filePath, sourceRoot) {
  try {
    const recipe = loadRecipe(filePath);
    entries.push({
      ...recipe,
      _sourceRoot: sourceRoot,
      _canonicalSource: normalizePathForRecipeLookup(filePath),
      _canonicalSourceRoot: normalizePathForRecipeLookup(sourceRoot),
      _source: filePath,
      category: recipe.category ?? 'custom',
      tags:     recipe.tags ?? [],
      channel:  recipe.channel ?? 'community',
    });
  } catch {
    // Skip invalid recipes during indexing
  }
}

// ---------------------------------------------------------------------------
// Build a version-aware index: { id → [{ version, recipe, source }] }
// ---------------------------------------------------------------------------

/**
 * Build a map of recipe ID → sorted version list.
 *
 * @param {string[]} dirs - Directories to scan.
 * @returns {Map<string, object[]>} Map of id → [{ version, recipe, source }] sorted newest-first.
 */
export function buildVersionIndex(dirs) {
  const all = buildIndex(dirs);
  const map = new Map();

  for (const entry of all) {
    if (!map.has(entry.id)) map.set(entry.id, []);
    map.get(entry.id).push({
      version: entry.version,
      recipe: entry,
      source: entry._source,
    });
  }

  // Sort each ID's versions newest-first
  for (const [, versions] of map) {
    versions.sort((a, b) => compareSemver(b.version, a.version));
  }

  return map;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Filter indexed recipes by criteria.
 */
export function filterRecipes(index, filters = {}) {
  let results = index;

  if (filters.category) {
    results = results.filter(r => r.category === filters.category);
  }
  if (filters.tag) {
    results = results.filter(r => r.tags.includes(filters.tag));
  }
  if (filters.risk_level) {
    results = results.filter(r => r.risk_level === filters.risk_level);
  }
  if (filters.channel) {
    results = results.filter(r => r.channel === filters.channel);
  }
  if (filters.search) {
    results = fuzzySearch(results, filters.search);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Deduplicate: keep only latest version per recipe ID
// ---------------------------------------------------------------------------

/**
 * Deduplicate indexed recipes, keeping the latest version of each ID.
 */
export function deduplicateLatest(index) {
  const best = new Map();
  for (const entry of index) {
    const existing = best.get(entry.id);
    if (!existing || compareSemver(entry.version, existing.version) > 0) {
      best.set(entry.id, entry);
    }
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------
// Fuzzy search
// ---------------------------------------------------------------------------

/**
 * Fuzzy search across recipe name, description, id, and tags.
 */
export function fuzzySearch(recipes, query) {
  const q = query.toLowerCase();

  const scored = recipes.map(r => {
    const fields = [
      r.id, r.name, r.description,
      ...(r.tags || []),
      r.category || '',
    ].map(f => (f || '').toLowerCase());

    let score = 0;
    if (fields[0].includes(q)) score += 100;
    if (fields[1].includes(q)) score += 80;
    if (fields[2].includes(q)) score += 40;
    for (let i = 3; i < fields.length - 1; i++) {
      if (fields[i].includes(q)) score += 60;
    }
    if (fields[fields.length - 1].includes(q)) score += 50;

    const qTokens = q.split(/\s+/);
    const allText = fields.join(' ');
    for (const token of qTokens) {
      if (token.length >= 2 && allText.includes(token)) score += 20;
    }
    if (fields[0].startsWith(q.slice(0, 3))) score += 15;

    return { recipe: r, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.recipe);
}

// ---------------------------------------------------------------------------
// Group by category
// ---------------------------------------------------------------------------

export function groupByCategory(recipes) {
  const groups = new Map();
  for (const cat of VALID_CATEGORIES) groups.set(cat, []);
  for (const r of recipes) {
    const cat = r.category || 'custom';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(r);
  }
  return groups;
}

/**
 * Format a recipe list for terminal display.
 */
export function formatRecipeList(recipes) {
  if (recipes.length === 0) return 'No recipes found.';

  const lines = [];
  for (const r of recipes) {
    const trust = r.channel === 'verified' ? '[verified]' : '[community]';
    const risk = r.risk_level.toUpperCase().padEnd(6);
    const ver = (r.version || '').padEnd(8);
    const tags = r.tags?.length ? ` tags: ${r.tags.join(', ')}` : '';
    lines.push(`  ${r.id.padEnd(25)} ${ver} ${risk} ${trust.padEnd(12)} ${r.name}${tags}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Semver comparison
// ---------------------------------------------------------------------------

function compareSemver(a, b) {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
