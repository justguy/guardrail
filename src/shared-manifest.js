import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { serializeStable } from './contract.js';

// ---------------------------------------------------------------------------
// Shared Manifest — team-level recipe/policy/profile distribution
// ---------------------------------------------------------------------------

const MANIFEST_VERSION = 1;

/**
 * @typedef {object} SharedManifest
 * @property {number} version
 * @property {string} name
 * @property {string} org
 * @property {string} updated_at
 * @property {object[]} recipes    - Recipe references (id, version, channel).
 * @property {object[]} policies   - Policy definitions.
 * @property {object[]} profiles   - Profile definitions.
 * @property {string} content_hash - SHA-256 of the manifest content.
 */

export function validateSharedManifest(manifest) {
  const errors = [];
  if (manifest.version !== MANIFEST_VERSION) errors.push(`version must be ${MANIFEST_VERSION}`);
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) errors.push('name required');
  if (typeof manifest.org !== 'string' || !manifest.org.trim()) errors.push('org required');
  if (!Array.isArray(manifest.recipes)) errors.push('recipes must be an array');
  if (!Array.isArray(manifest.policies)) errors.push('policies must be an array');
  if (!Array.isArray(manifest.profiles)) errors.push('profiles must be an array');
  return errors;
}

export function hashSharedManifest(manifest) {
  const hashable = { name: manifest.name, org: manifest.org, recipes: manifest.recipes, policies: manifest.policies, profiles: manifest.profiles };
  return createHash('sha256').update(serializeStable(hashable)).digest('hex');
}

export function createSharedManifest(opts) {
  const manifest = {
    version: MANIFEST_VERSION,
    name: opts.name,
    org: opts.org,
    updated_at: new Date().toISOString(),
    recipes: opts.recipes || [],
    policies: opts.policies || [],
    profiles: opts.profiles || [],
  };
  manifest.content_hash = hashSharedManifest(manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Sync — pull/push shared manifests
// ---------------------------------------------------------------------------

export function saveSharedManifest(manifest, dir) {
  const targetDir = resolve(dir, '.guardrail', 'shared');
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  const path = join(targetDir, `${manifest.name}.manifest.json`);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return path;
}

export function loadSharedManifest(name, dir) {
  const path = join(resolve(dir, '.guardrail', 'shared'), `${name}.manifest.json`);
  if (!existsSync(path)) throw new Error(`Shared manifest "${name}" not found at ${path}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  return manifest;
}

/**
 * Sync a shared manifest — verify hash, detect conflicts.
 */
export function syncManifest(incoming, existing) {
  if (!existing) return { action: 'create', manifest: incoming, conflicts: [] };

  const conflicts = [];
  if (incoming.content_hash === existing.content_hash) {
    return { action: 'none', manifest: existing, conflicts: [] };
  }

  // Check for recipe conflicts (same id, different version)
  const existingRecipes = new Map((existing.recipes || []).map(r => [r.id, r]));
  for (const recipe of (incoming.recipes || [])) {
    const ex = existingRecipes.get(recipe.id);
    if (ex && ex.version !== recipe.version) {
      conflicts.push({ type: 'recipe_version', id: recipe.id, local: ex.version, remote: recipe.version });
    }
  }

  return { action: 'update', manifest: incoming, conflicts };
}

/**
 * Pin a shared manifest to a specific version hash.
 */
export function pinManifest(manifest, dir) {
  const pinDir = resolve(dir, '.guardrail', 'pins');
  if (!existsSync(pinDir)) mkdirSync(pinDir, { recursive: true });
  const path = join(pinDir, `${manifest.name}.pin.json`);
  writeFileSync(path, JSON.stringify({ name: manifest.name, pinned_hash: manifest.content_hash, pinned_at: new Date().toISOString() }, null, 2) + '\n');
  return path;
}

export function loadPin(name, dir) {
  const path = join(resolve(dir, '.guardrail', 'pins'), `${name}.pin.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}
