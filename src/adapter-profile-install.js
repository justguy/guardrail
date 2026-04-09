import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { validateProfile, hashProfile } from './adapter-profile.js';
import { loadRawJson } from './recipe.js';
import { parseGitHubUrl, checkTrustedSource, loadConfig } from './recipe-install.js';

// ---------------------------------------------------------------------------
// Shared validation helper — produces a stable error prefix that downstream
// automation can match on.
// ---------------------------------------------------------------------------

function assertValidProfile(raw) {
  const validation = validateProfile(raw);
  if (!validation.valid) {
    throw new Error(
      `Adapter profile validation failed: ${validation.errors.join('; ')}`
    );
  }
}

// ---------------------------------------------------------------------------
// Registry directory management
// ---------------------------------------------------------------------------

function ensureProfileDir(profileDir) {
  const dir = profileDir || resolve(homedir(), '.guardrail', 'adapter-profiles');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Core install logic
// ---------------------------------------------------------------------------

function installProfileToStore(profile, hash, opts = {}) {
  const profileDir = ensureProfileDir(opts.profileDir);
  const toolDir = join(profileDir, profile.tool);
  const targetPath = join(toolDir, `${profile.version}.json`);

  // Immutability: block overwrite of existing version unless content matches
  if (existsSync(targetPath)) {
    const existing = JSON.parse(readFileSync(targetPath, 'utf8'));
    const existingHash = hashProfile(existing);
    if (existingHash === hash) {
      return { installed: false, tool: profile.tool, version: profile.version, path: targetPath, hash, note: 'already installed (identical)' };
    }
    if (!opts.force) {
      throw new Error(
        `Adapter profile "${profile.tool}" v${profile.version} already installed with different content. ` +
        'Version is immutable — publish a new version instead.'
      );
    }
  }

  if (!existsSync(toolDir)) {
    mkdirSync(toolDir, { recursive: true });
  }
  writeFileSync(targetPath, JSON.stringify(profile, null, 2) + '\n');

  return { installed: true, tool: profile.tool, version: profile.version, path: targetPath, hash };
}

// ---------------------------------------------------------------------------
// Install from local path
// ---------------------------------------------------------------------------

export function installFromPath(filePath, opts = {}) {
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`Profile not found: ${abs}`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`Profile is not valid JSON: ${err.message}`);
  }
  assertValidProfile(raw);
  const hash = hashProfile(raw);
  return installProfileToStore(raw, hash, opts);
}

// ---------------------------------------------------------------------------
// Install from URL
// ---------------------------------------------------------------------------

export async function installFromUrl(url, opts = {}) {
  const config = loadConfig(opts.configPath);
  if (!config.trusted_sources || config.trusted_sources.length === 0) {
    throw new Error(
      'No trusted sources configured for remote adapter profile install. ' +
      'Add a trusted_sources array to ~/.guardrail/config.json first.'
    );
  }
  if (!checkTrustedSource(url, config.trusted_sources)) {
    throw new Error(
      `Source "${url}" is not in trusted sources. ` +
      'Add a matching prefix to ~/.guardrail/config.json.'
    );
  }

  const fetchJson = opts.fetchJson || loadRawJson;
  const raw = await fetchJson(url);
  assertValidProfile(raw);
  const hash = hashProfile(raw);
  return installProfileToStore(raw, hash, opts);
}

// ---------------------------------------------------------------------------
// Install from GitHub
// ---------------------------------------------------------------------------

export async function installFromGitHub(source, opts = {}) {
  const config = loadConfig(opts.configPath);
  const configPath = opts.configPath || resolve(homedir(), '.guardrail', 'config.json');

  if (!config.trusted_sources || config.trusted_sources.length === 0) {
    throw new Error(
      `No trusted sources configured. Add a trusted_sources array to ${configPath}.\n` +
      `Example: { "trusted_sources": ["github://guardrail-dev/adapter-profiles/"] }`
    );
  }
  if (!checkTrustedSource(source, config.trusted_sources)) {
    throw new Error(
      `Source "${source}" is not in trusted sources.\n` +
      `Add a matching prefix to ${configPath}.`
    );
  }

  const parsed = parseGitHubUrl(source);

  // Only full SHA is accepted for adapter profiles (no short SHA resolution in Phase 1)
  if (parsed.sha.length !== 40) {
    throw new Error(
      `Adapter profile install requires a full 40-character SHA, got ${parsed.sha.length} chars.\n` +
      'Use the full commit SHA from GitHub.'
    );
  }

  const fetchJson = opts.fetchJson || loadRawJson;
  const raw = await fetchJson(parsed.rawUrl);
  assertValidProfile(raw);

  const hash = hashProfile(raw);
  const result = installProfileToStore(raw, hash, opts);

  // Write pin metadata
  const pinsDir = join(dirname(result.path), '.pins');
  mkdirSync(pinsDir, { recursive: true });
  const pinPath = join(pinsDir, `${raw.version}.json`);
  const pin = {
    source,
    owner: parsed.owner,
    repo: parsed.repo,
    path: parsed.path,
    sha: parsed.sha,
    rawUrl: parsed.rawUrl,
    content_hash: hash,
    installed_at: new Date().toISOString(),
  };
  writeFileSync(pinPath, JSON.stringify(pin, null, 2) + '\n');

  return { ...result, pin };
}

// ---------------------------------------------------------------------------
// Unified install entry point
// ---------------------------------------------------------------------------

/**
 * Install an adapter profile from a local path, URL, or github:// source.
 */
export async function installAdapterProfile(source, opts = {}) {
  if (source.startsWith('github://')) {
    return installFromGitHub(source, opts);
  }
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return installFromUrl(source, opts);
  }
  if (/^[a-z][a-z0-9-]*$/.test(source) && !existsSync(source)) {
    throw new Error(
      `"${source}" is not a local path, URL, or github:// source.\n` +
      'To install from the public registry, use the full GitHub URL:\n' +
      `  guardrail adapter profile install github://guardrail-dev/adapter-profiles/${source}.json@<sha>\n` +
      'Browse available profiles at: https://github.com/guardrail-dev/adapter-profiles'
    );
  }
  return installFromPath(source, opts);
}
