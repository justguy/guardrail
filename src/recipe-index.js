import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadRecipe, VALID_CATEGORIES } from './recipe.js';

// ---------------------------------------------------------------------------
// Index building — scan directories for recipe files
// ---------------------------------------------------------------------------

/**
 * Scan one or more directories and build a recipe index.
 *
 * @param {string[]} dirs - Directories to scan for .recipe.json files.
 * @returns {object[]} Array of indexed recipe entries.
 */
export function buildIndex(dirs) {
  const entries = [];
  for (const dir of dirs) {
    const resolved = resolve(dir);
    if (!existsSync(resolved)) continue;
    const files = readdirSync(resolved).filter(f => f.endsWith('.recipe.json'));
    for (const file of files) {
      try {
        const recipe = loadRecipe(join(resolved, file));
        entries.push({
          ...recipe,
          _source: join(resolved, file),
          category: recipe.category ?? 'custom',
          tags:     recipe.tags ?? [],
          channel:  recipe.channel ?? 'community',
        });
      } catch {
        // Skip invalid recipes during indexing
      }
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Filter indexed recipes by criteria.
 *
 * @param {object[]} index  - Recipe index from buildIndex().
 * @param {object} filters  - { category, tag, risk_level, channel, search }.
 * @returns {object[]} Matching recipes.
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
// Fuzzy search
// ---------------------------------------------------------------------------

/**
 * Fuzzy search across recipe name, description, id, and tags.
 * Uses substring matching + simple distance scoring.
 *
 * @param {object[]} recipes - Recipe array.
 * @param {string} query     - Search query.
 * @returns {object[]} Matching recipes sorted by relevance.
 */
export function fuzzySearch(recipes, query) {
  const q = query.toLowerCase();

  const scored = recipes.map(r => {
    const fields = [
      r.id,
      r.name,
      r.description,
      ...(r.tags || []),
      r.category || '',
    ].map(f => (f || '').toLowerCase());

    let score = 0;

    // Exact substring match in id or name (highest weight)
    if (fields[0].includes(q)) score += 100;
    if (fields[1].includes(q)) score += 80;

    // Substring in description
    if (fields[2].includes(q)) score += 40;

    // Substring in tags
    for (let i = 3; i < fields.length - 1; i++) {
      if (fields[i].includes(q)) score += 60;
    }

    // Category match
    if (fields[fields.length - 1].includes(q)) score += 50;

    // Token overlap (split query into words)
    const qTokens = q.split(/\s+/);
    const allText = fields.join(' ');
    for (const token of qTokens) {
      if (token.length >= 2 && allText.includes(token)) score += 20;
    }

    // Levenshtein-like: prefix match on id
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

/**
 * Group recipes by category.
 *
 * @param {object[]} recipes - Recipe array.
 * @returns {Map<string, object[]>} Map of category → recipes.
 */
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
 *
 * @param {object[]} recipes - Recipe array.
 * @returns {string} Formatted output.
 */
export function formatRecipeList(recipes) {
  if (recipes.length === 0) return 'No recipes found.';

  const lines = [];
  for (const r of recipes) {
    const trust = r.channel === 'verified' ? '[verified]' : '[community]';
    const risk = r.risk_level.toUpperCase().padEnd(6);
    const tags = r.tags?.length ? ` tags: ${r.tags.join(', ')}` : '';
    lines.push(`  ${r.id.padEnd(25)} ${risk} ${trust.padEnd(12)} ${r.name}${tags}`);
  }
  return lines.join('\n');
}
