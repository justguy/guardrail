import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { serializeStable } from './contract.js';

// ---------------------------------------------------------------------------
// Org-wide Recipe Marketplace — discover, publish, version
// ---------------------------------------------------------------------------

/**
 * Create a marketplace index from a registry directory.
 *
 * @param {string} registryDir - Path to the marketplace registry.
 * @returns {object[]} Indexed recipe entries with usage stats.
 */
export function buildMarketplaceIndex(registryDir) {
  const resolved = resolve(registryDir);
  if (!existsSync(resolved)) return [];

  const entries = [];
  const files = readdirSync(resolved).filter(f => f.endsWith('.recipe.json') || f.endsWith('.packed.json'));

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(resolved, file), 'utf8'));
      const recipe = raw.recipe || raw; // support packed or raw recipes
      entries.push({
        id:            recipe.id,
        name:          recipe.name,
        version:       recipe.version,
        author:        recipe.author,
        description:   recipe.description,
        category:      recipe.category ?? 'custom',
        tags:          recipe.tags ?? [],
        channel:       recipe.channel ?? 'community',
        risk_level:    recipe.risk_level,
        trust_level:   raw.content_hash ? 'packed' : 'source',
        usage_count:   loadUsageCount(recipe.id, registryDir),
        published_at:  raw.packed_at ?? null,
        _source:       join(resolved, file),
      });
    } catch { /* skip invalid */ }
  }

  return entries;
}

/**
 * Publish a recipe to the marketplace registry.
 */
export function publishRecipe(recipe, registryDir) {
  const dir = resolve(registryDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Check for version conflict
  const filename = `${recipe.id}-${recipe.version}.recipe.json`;
  const path = join(dir, filename);
  if (existsSync(path)) {
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    const existingHash = createHash('sha256').update(serializeStable(onDisk)).digest('hex');
    const newHash = createHash('sha256').update(serializeStable(recipe)).digest('hex');
    if (existingHash !== newHash) {
      throw new Error(`Version ${recipe.version} of "${recipe.id}" already published with different content. Bump the version.`);
    }
    return { status: 'already_published', path };
  }

  writeFileSync(path, JSON.stringify(recipe, null, 2) + '\n', 'utf8');
  return { status: 'published', path };
}

/**
 * Find a specific recipe version in the registry.
 */
export function findRecipe(id, version, registryDir) {
  const index = buildMarketplaceIndex(registryDir);
  return index.find(r => r.id === id && r.version === version) ?? null;
}

/**
 * Record a usage event for a recipe.
 */
export function recordUsage(recipeId, registryDir) {
  const usageDir = resolve(registryDir, '.usage');
  if (!existsSync(usageDir)) mkdirSync(usageDir, { recursive: true });
  const path = join(usageDir, `${recipeId}.json`);

  let usage = { count: 0, last_used: null };
  if (existsSync(path)) {
    try { usage = JSON.parse(readFileSync(path, 'utf8')); } catch { /* reset */ }
  }
  usage.count += 1;
  usage.last_used = new Date().toISOString();
  writeFileSync(path, JSON.stringify(usage) + '\n');
}

function loadUsageCount(recipeId, registryDir) {
  const path = join(resolve(registryDir, '.usage'), `${recipeId}.json`);
  if (!existsSync(path)) return 0;
  try { return JSON.parse(readFileSync(path, 'utf8')).count ?? 0; } catch { return 0; }
}

/**
 * Format marketplace listing.
 */
export function formatMarketplace(entries) {
  if (entries.length === 0) return 'No recipes in marketplace.';
  const lines = [];
  for (const r of entries) {
    const trust = r.channel === 'verified' ? '[verified]' : '[community]';
    const usage = r.usage_count > 0 ? ` (${r.usage_count} uses)` : '';
    const author = typeof r.author === 'string' ? r.author : r.author?.name ?? '';
    lines.push(`  ${r.id.padEnd(25)} v${r.version.padEnd(8)} ${trust.padEnd(12)} by ${author}${usage}`);
  }
  return lines.join('\n');
}
