import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { validateProfile, hashProfile } from './adapter-profile.js';
import { loadRawJson } from './recipe.js';
import { parseGitHubUrl, checkTrustedSource, loadConfig } from './recipe-install.js';
import {
  loadAdapterProfileIndex,
  resolveAdapterProfileFromSignedIndex,
  verifyAdapterProfileIndex,
} from './adapter-profile-index.js';
import { isTrustedAdapterIndex, isTrustedExecutionSource, resolveActiveOrgPolicy } from './org-policy.js';

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

function trustedAdapterIndexesFromConfig(config = {}, configPath = null) {
  const entries = Array.isArray(config?.trusted_adapter_indexes) ? config.trusted_adapter_indexes : [];
  return entries.map((entry) => ({
    indexPath: resolve(dirname(configPath || resolve(homedir(), '.guardrail', 'config.json')), entry.path),
    indexKeyPath: resolve(dirname(configPath || resolve(homedir(), '.guardrail', 'config.json')), entry.key),
  }));
}

function readVerifiedTrustedIndex(entry, opts = {}) {
  assertTrustedAdapterIndex(entry.indexPath, opts);
  if (!existsSync(entry.indexKeyPath)) {
    throw new Error(`Adapter profile index public key not found: ${entry.indexKeyPath}`);
  }
  const index = loadAdapterProfileIndex(entry.indexPath);
  const publicKeyPem = readFileSync(entry.indexKeyPath, 'utf8');
  const verify = verifyAdapterProfileIndex(index, publicKeyPem);
  if (!verify.valid) {
    throw new Error(verify.reason);
  }
  return { entry, index };
}

function collectTrustedIndexMatches(toolName, opts = {}) {
  const configPath = opts.configPath || resolve(homedir(), '.guardrail', 'config.json');
  const config = loadConfig(configPath, { strict: true });
  const trustedIndexes = trustedAdapterIndexesFromConfig(config, configPath);
  if (trustedIndexes.length === 0) {
    throw new Error(
      'Bare-name adapter install requires a trusted signed index.\n'
      + 'Either pass --index <path> --index-key <pubkey.pem>, or configure trusted_adapter_indexes in ~/.guardrail/config.json.'
    );
  }

  const matches = [];
  for (const entry of trustedIndexes) {
    const { index } = readVerifiedTrustedIndex(entry, opts);
    const profileEntry = index.profiles?.[toolName];
    if (!profileEntry) continue;
    matches.push({
      indexPath: entry.indexPath,
      indexKeyPath: entry.indexKeyPath,
      indexSignature: index.signature,
      entry: profileEntry,
      source: `github://${profileEntry.owner}/${profileEntry.repo}/${profileEntry.path}@${profileEntry.sha}`,
    });
  }
  return matches;
}

function assertTrustedAdapterIndex(indexPath, opts = {}) {
  const policy = resolveActiveOrgPolicy({
    orgPolicy: opts.orgPolicy,
    orgPolicyName: opts.orgPolicyName,
    orgPolicyDir: opts.orgPolicyDir,
    fallbackDir: opts.policyFallbackDir || process.cwd(),
  }).policy;
  if (!isTrustedAdapterIndex(indexPath, policy, opts.policyFallbackDir || process.cwd())) {
    const policyLabel = policy?.name || 'active';
    throw new Error(
      `Adapter index "${indexPath}" is not trusted by org policy "${policyLabel}". `
      + 'Add a matching prefix to trusted_adapter_indexes.'
    );
  }
}

function resolveBareNameFromTrustedIndexes(source, opts = {}) {
  if (opts.indexPath || opts.indexKeyPath) {
    if (!opts.indexPath || !opts.indexKeyPath) {
      throw new Error('Bare-name adapter install requires both --index <path> and --index-key <pubkey.pem>.');
    }
    assertTrustedAdapterIndex(opts.indexPath, opts);
    return resolveAdapterProfileFromSignedIndex(source, {
      indexPath: opts.indexPath,
      indexKeyPath: opts.indexKeyPath,
    });
  }

  const matches = collectTrustedIndexMatches(source, opts);
  if (matches.length === 0) {
    throw new Error(`Adapter profile "${source}" was not found in any trusted signed index.`);
  }
  if (matches.length > 1) {
    const details = matches.map((match) => {
      const keyId = match.indexSignature?.key_id || '<unknown-key>';
      return `- ${match.indexPath} (${keyId}) -> ${match.source}`;
    }).join('\n');
    throw new Error(
      `Adapter profile "${source}" matched multiple trusted signed indexes.\n`
      + 'Pass --index <path> --index-key <pubkey.pem> to disambiguate.\n'
      + details
    );
  }
  return matches[0];
}

export function discoverTrustedAdapterProfiles(opts = {}) {
  const configPath = opts.configPath || resolve(homedir(), '.guardrail', 'config.json');
  const config = loadConfig(configPath, { strict: true });
  const trustedIndexes = trustedAdapterIndexesFromConfig(config, configPath);
  const toolFilter = typeof opts.toolName === 'string' && opts.toolName.trim() !== ''
    ? opts.toolName.trim()
    : null;

  const indexes = trustedIndexes.map((entry) => {
    const { index } = readVerifiedTrustedIndex(entry, opts);
    const tools = Object.entries(index.profiles || {})
      .filter(([toolName]) => !toolFilter || toolName === toolFilter)
      .map(([toolName, profileEntry]) => ({
        tool: toolName,
        owner: profileEntry.owner,
        repo: profileEntry.repo,
        path: profileEntry.path,
        sha: profileEntry.sha,
        version: profileEntry.version,
        contentHash: profileEntry.content_hash,
        source: `github://${profileEntry.owner}/${profileEntry.repo}/${profileEntry.path}@${profileEntry.sha}`,
      }));
    return {
      indexPath: entry.indexPath,
      indexKeyPath: entry.indexKeyPath,
      keyId: index.signature?.key_id || null,
      toolCount: tools.length,
      tools,
    };
  }).filter((entry) => !toolFilter || entry.tools.length > 0);

  const matches = indexes.flatMap((entry) => entry.tools.map((tool) => ({
    ...tool,
    indexPath: entry.indexPath,
    indexKeyPath: entry.indexKeyPath,
    keyId: entry.keyId,
  })));

  return {
    configPath,
    toolName: toolFilter,
    indexCount: indexes.length,
    matchCount: matches.length,
    ambiguous: !!toolFilter && matches.length > 1,
    indexes,
    matches,
  };
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
  const policy = resolveActiveOrgPolicy({
    orgPolicy: opts.orgPolicy,
    orgPolicyName: opts.orgPolicyName,
    orgPolicyDir: opts.orgPolicyDir,
    fallbackDir: opts.policyFallbackDir || process.cwd(),
  }).policy;
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
  if (!isTrustedExecutionSource(url, policy)) {
    const policyLabel = policy?.name || 'active';
    throw new Error(
      `Source "${url}" is not in trusted execution sources for org policy "${policyLabel}". ` +
      'Add a matching prefix to trusted_execution_sources.'
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
  const policy = resolveActiveOrgPolicy({
    orgPolicy: opts.orgPolicy,
    orgPolicyName: opts.orgPolicyName,
    orgPolicyDir: opts.orgPolicyDir,
    fallbackDir: opts.policyFallbackDir || process.cwd(),
  }).policy;
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
  if (!isTrustedExecutionSource(source, policy)) {
    const policyLabel = policy?.name || 'active';
    throw new Error(
      `Source "${source}" is not in trusted execution sources for org policy "${policyLabel}". ` +
      'Add a matching prefix to trusted_execution_sources.'
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
  if (opts.indexResolution) {
    pin.index = {
      index_path: opts.indexResolution.indexPath,
      key_id: opts.indexResolution.indexSignature?.key_id || null,
      tool: opts.indexResolution.tool || raw.tool,
      version: opts.indexResolution.entry?.version || raw.version,
      content_hash: opts.indexResolution.entry?.content_hash || null,
    };
  }
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
    const resolved = resolveBareNameFromTrustedIndexes(source, opts);
    return installFromGitHub(resolved.source, {
      ...opts,
      indexResolution: {
        ...resolved,
        tool: source,
      },
    });
  }
  return installFromPath(source, opts);
}
