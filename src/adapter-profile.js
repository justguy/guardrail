/**
 * adapter-profile.js — Adapter profile validation, loading, version selection,
 * hashing, and listing for the Guardrail adapter system.
 *
 * Profiles describe how an external tool integrates with Guardrail:
 * intercept shape, response mapping, protocol, exit codes, defaults.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { serializeStable } from './contract.js';
import { validatePath } from './adapter-extract.js';

// --- Constants ---------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const VALID_PROTOCOLS = new Set(['stdin-json', 'env-shim', 'mcp']);
export const VALID_AUTH_TYPES = new Set(['claude_login', 'claude_exec_probe', 'gh_auth']);

const DEFERRED_PROTOCOLS = new Set(['http', 'python-callable', 'node-callable']);

const ALLOWED_TOP_LEVEL = new Set([
  'version', 'tool', 'description', 'schema_target', 'protocol',
  'intercept', 'response', 'exit_codes', 'defaults',
  'requires_env', 'requires_auth', 'mcp_transport', 'egress_hook',
]);

const TOOL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const RESPONSE_PREFIX_RE = /^\$\.(guardrail|process|telemetry)\b/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_PROFILE_BYTES = 256 * 1024;
const VALID_MCP_TRANSPORT_TYPES = new Set(['stdio']);
const VALID_MCP_CORRELATION = new Set(['request_id']);
const VALID_MCP_CAP_DISCOVERY = new Set(['required']);

// --- Helpers -----------------------------------------------------------------

function collectResponsePaths(obj, prefix, paths) {
  if (obj == null || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof val === 'string' && val.startsWith('$.')) {
      paths.push({ key: fullKey, path: val });
    } else if (typeof val === 'object' && val !== null) {
      collectResponsePaths(val, fullKey, paths);
    }
  }
}

function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// --- Validation --------------------------------------------------------------

/**
 * Validate a profile object against the adapter profile schema.
 * @param {object} profile
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateProfile(profile) {
  const errors = [];

  if (profile == null || typeof profile !== 'object' || Array.isArray(profile)) {
    return { valid: false, errors: ['Profile must be a non-null object'] };
  }

  // Size check on serialized form
  const raw = JSON.stringify(profile);
  if (Buffer.byteLength(raw, 'utf8') > MAX_PROFILE_BYTES) {
    errors.push(`Profile exceeds maximum size of ${MAX_PROFILE_BYTES} bytes`);
  }

  // Unknown top-level fields
  for (const key of Object.keys(profile)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      errors.push(`Unknown top-level field: ${key}`);
    }
  }

  // tool
  if (typeof profile.tool !== 'string' || !TOOL_RE.test(profile.tool)) {
    errors.push('tool must match ^[a-z0-9]+(-[a-z0-9]+)*$');
  }

  // version
  if (typeof profile.version !== 'string' || !SEMVER_RE.test(profile.version)) {
    errors.push('version must be semver (e.g. 1.0.0)');
  }

  // schema_target
  if (profile.schema_target !== 'adapter-result/v1') {
    errors.push('schema_target must equal "adapter-result/v1"');
  }

  // protocol
  if (DEFERRED_PROTOCOLS.has(profile.protocol)) {
    errors.push(`protocol "${profile.protocol}" is deferred and not valid in Phase 1`);
  } else if (!VALID_PROTOCOLS.has(profile.protocol)) {
    errors.push(`protocol must be one of: ${[...VALID_PROTOCOLS].join(', ')}`);
  }

  // intercept.command (+ args + cwd): every reference MUST be a $. path so
  // profiles cannot smuggle literal strings into the resolved command line.
  if (profile.intercept == null || typeof profile.intercept !== 'object') {
    errors.push('intercept must be an object');
  } else {
    if (typeof profile.intercept.command !== 'string') {
      errors.push('intercept.command is required and must be a string');
    } else if (!profile.intercept.command.startsWith('$.')) {
      errors.push('intercept.command must be a $. path reference, not a literal');
    } else {
      const pathResult = validatePath(profile.intercept.command);
      if (!pathResult.valid) {
        errors.push(`intercept.command: ${pathResult.error}`);
      }
    }
    if (profile.intercept.args !== undefined) {
      if (typeof profile.intercept.args !== 'string') {
        errors.push('intercept.args must be a string $. path reference when present');
      } else if (!profile.intercept.args.startsWith('$.')) {
        errors.push('intercept.args must be a $. path reference, not a literal');
      } else {
        const pathResult = validatePath(profile.intercept.args);
        if (!pathResult.valid) {
          errors.push(`intercept.args: ${pathResult.error}`);
        }
      }
    }
    if (profile.intercept.cwd !== undefined) {
      if (typeof profile.intercept.cwd !== 'string') {
        errors.push('intercept.cwd must be a string $. path reference when present');
      } else if (!profile.intercept.cwd.startsWith('$.')) {
        errors.push('intercept.cwd must be a $. path reference, not a literal');
      } else {
        const pathResult = validatePath(profile.intercept.cwd);
        if (!pathResult.valid) {
          errors.push(`intercept.cwd: ${pathResult.error}`);
        }
      }
    }
  }

  // response.format
  if (profile.response != null && typeof profile.response === 'object') {
    if (profile.response.format !== undefined) {
      if (profile.response.format !== 'json' && profile.response.format !== 'human') {
        errors.push('response.format must be "json" or "human"');
      }
    }

    // Human-format templates MUST be strings — array/object templates only
    // make sense when the profile is rendering a structured JSON payload.
    if (profile.response.format === 'human') {
      for (const key of ['success', 'blocked', 'failed']) {
        const tpl = profile.response[key];
        if (tpl !== undefined && typeof tpl !== 'string') {
          errors.push(`response.${key}: human format requires a string template`);
        }
      }
    }

    // Validate all path references inside response
    const paths = [];
    collectResponsePaths(profile.response, 'response', paths);
    for (const { key, path } of paths) {
      if (!RESPONSE_PREFIX_RE.test(path)) {
        errors.push(
          `${key}: path "${path}" must start with $.guardrail, $.process, or $.telemetry`
        );
      }
      const pathResult = validatePath(path);
      if (!pathResult.valid) {
        errors.push(`${key}: ${pathResult.error}`);
      }
    }
  }

  // MCP protocol sanity: MCP profiles are long-lived; silently running them
  // in interactive mode would completely sidestep the non-interactive
  // guardrail posture. Reject the configuration at validation time.
  if (
    profile.protocol === 'mcp'
    && profile.defaults != null
    && typeof profile.defaults === 'object'
    && profile.defaults.non_interactive === false
  ) {
    errors.push('protocol "mcp" cannot declare defaults.non_interactive: false');
  }

  if (profile.protocol === 'mcp') {
    if (profile.mcp_transport == null || typeof profile.mcp_transport !== 'object' || Array.isArray(profile.mcp_transport)) {
      errors.push('protocol "mcp" requires an mcp_transport object');
    } else {
      const transport = profile.mcp_transport;
      if (typeof transport.type !== 'string' || !VALID_MCP_TRANSPORT_TYPES.has(transport.type)) {
        errors.push(`mcp_transport.type must be one of: ${[...VALID_MCP_TRANSPORT_TYPES].join(', ')}`);
      }
      if (typeof transport.command !== 'string' || transport.command.trim() === '') {
        errors.push('mcp_transport.command must be a non-empty string');
      }
      if (transport.args !== undefined) {
        if (!Array.isArray(transport.args) || !transport.args.every((value) => typeof value === 'string')) {
          errors.push('mcp_transport.args must be an array of strings when present');
        }
      }
      if (transport.cwd !== undefined && typeof transport.cwd !== 'string') {
        errors.push('mcp_transport.cwd must be a string when present');
      }
      if (
        typeof transport.correlation !== 'string'
        || !VALID_MCP_CORRELATION.has(transport.correlation)
      ) {
        errors.push(`mcp_transport.correlation must be one of: ${[...VALID_MCP_CORRELATION].join(', ')}`);
      }
      if (
        typeof transport.capability_discovery !== 'string'
        || !VALID_MCP_CAP_DISCOVERY.has(transport.capability_discovery)
      ) {
        errors.push(`mcp_transport.capability_discovery must be one of: ${[...VALID_MCP_CAP_DISCOVERY].join(', ')}`);
      }
      if (transport.streaming !== undefined && transport.streaming !== false) {
        errors.push('mcp_transport.streaming must be false when present');
      }
    }
  } else if (profile.mcp_transport !== undefined) {
    errors.push('mcp_transport is only valid when protocol is "mcp"');
  }

  if (profile.requires_env !== undefined) {
    if (!Array.isArray(profile.requires_env) || profile.requires_env.length === 0) {
      errors.push('requires_env must be a non-empty array of env var names when present');
    } else {
      for (const name of profile.requires_env) {
        if (typeof name !== 'string' || !ENV_NAME_RE.test(name)) {
          errors.push(`requires_env entries must match ${ENV_NAME_RE}: ${String(name)}`);
        }
      }
    }
  }

  if (profile.requires_auth !== undefined) {
    if (!Array.isArray(profile.requires_auth) || profile.requires_auth.length === 0) {
      errors.push('requires_auth must be a non-empty array when present');
    } else {
      for (const requirement of profile.requires_auth) {
        if (requirement == null || typeof requirement !== 'object' || Array.isArray(requirement)) {
          errors.push('requires_auth entries must be objects');
          continue;
        }
        if (typeof requirement.type !== 'string' || !VALID_AUTH_TYPES.has(requirement.type)) {
          errors.push(`requires_auth.type must be one of: ${[...VALID_AUTH_TYPES].join(', ')}`);
        }
        if (requirement.check !== undefined && typeof requirement.check !== 'string') {
          errors.push('requires_auth.check must be a string when present');
        }
        if (requirement.message !== undefined && typeof requirement.message !== 'string') {
          errors.push('requires_auth.message must be a string when present');
        }
        if (requirement.env !== undefined) {
          if (!Array.isArray(requirement.env) || requirement.env.length === 0) {
            errors.push('requires_auth.env must be a non-empty array when present');
          } else {
            for (const name of requirement.env) {
              if (typeof name !== 'string' || !ENV_NAME_RE.test(name)) {
                errors.push(`requires_auth.env entries must match ${ENV_NAME_RE}: ${String(name)}`);
              }
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// --- Hashing -----------------------------------------------------------------

/**
 * Compute SHA-256 hash of a profile using canonical serialization.
 * @param {object} profile
 * @returns {string} hex digest
 */
export function hashProfile(profile) {
  const canon = serializeStable(profile);
  return createHash('sha256').update(canon).digest('hex');
}

// --- Loading -----------------------------------------------------------------

/**
 * Load and validate a profile from a file path.
 * @param {string} filePath — absolute or relative path to JSON profile
 * @returns {object} parsed and validated profile
 * @throws on read failure, parse error, or validation error
 */
export function loadProfile(filePath) {
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`Profile not found: ${abs}`);
  }
  const raw = readFileSync(abs, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_PROFILE_BYTES) {
    throw new Error(`Profile exceeds maximum size of ${MAX_PROFILE_BYTES} bytes`);
  }
  let profile;
  try {
    profile = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Profile is not valid JSON: ${err.message}`);
  }
  const result = validateProfile(profile);
  if (!result.valid) {
    throw new Error(`Invalid profile at ${abs}: ${result.errors.join('; ')}`);
  }
  return profile;
}

/**
 * Load a bundled profile shipped with Guardrail.
 * @param {string} toolName
 * @returns {object} parsed and validated profile
 * @throws if bundled profile does not exist or is invalid
 */
export function loadBundledProfile(toolName) {
  const bundledPath = join(__dirname, 'adapter-profiles', `${toolName}.json`);
  return loadProfile(bundledPath);
}

// --- Resolution --------------------------------------------------------------

/**
 * Resolve the best profile for a tool.
 *
 * Resolution order:
 * 1. Installed profiles in ~/.guardrail/adapter-profiles/<tool>/
 *    (newest semver wins among installed)
 * 2. Falls back to bundled profile at src/adapter-profiles/<tool>.json
 *
 * If installed version < bundled version, logs a warning but keeps installed.
 *
 * @param {string} toolName
 * @param {object} [opts]
 * @param {string} [opts.profileDir] — override installed profile directory
 * @param {Function} [opts.warn] — warning callback (default: console.error)
 * @returns {object} resolved profile
 * @throws if no profile found anywhere
 */
export function resolveProfile(toolName, opts = {}) {
  const warn = opts.warn || console.error;
  const baseDir = opts.profileDir || join(homedir(), '.guardrail', 'adapter-profiles');
  const installedDir = join(baseDir, toolName);
  const bundledPath = join(__dirname, 'adapter-profiles', `${toolName}.json`);

  // Try installed profiles
  let installed = null;
  if (existsSync(installedDir)) {
    const files = readdirSync(installedDir).filter(f => f.endsWith('.json'));
    let best = null;
    let bestVersion = null;
    for (const file of files) {
      try {
        const p = loadProfile(join(installedDir, file));
        if (p.tool !== toolName) continue;
        if (!bestVersion || compareSemver(p.version, bestVersion) > 0) {
          best = p;
          bestVersion = p.version;
        }
      } catch {
        // skip invalid files
      }
    }
    installed = best;
  }

  // Try bundled
  let bundled = null;
  if (existsSync(bundledPath)) {
    try {
      bundled = loadProfile(bundledPath);
    } catch {
      // bundled profile corrupt — treat as absent
    }
  }

  if (installed && bundled) {
    if (compareSemver(installed.version, bundled.version) < 0) {
      warn(
        `[guardrail] Installed profile for "${toolName}" (v${installed.version}) ` +
        `is older than bundled (v${bundled.version}). Consider upgrading.`
      );
    }
    return installed;
  }
  if (installed) return installed;
  if (bundled) return bundled;

  throw new Error(`No profile found for tool "${toolName}"`);
}

// --- Listing -----------------------------------------------------------------

/**
 * List all known adapter profiles (installed + bundled).
 * @param {object} [opts]
 * @param {string} [opts.profileDir] — override installed profile directory
 * @returns {{ tool: string, version: string, source: string }[]}
 */
export function listProfiles(opts = {}) {
  const results = [];
  const baseDir = opts.profileDir || join(homedir(), '.guardrail', 'adapter-profiles');
  const bundledDir = join(__dirname, 'adapter-profiles');

  // Scan installed
  if (existsSync(baseDir)) {
    for (const toolDir of readdirSync(baseDir)) {
      const full = join(baseDir, toolDir);
      let entries;
      try { entries = readdirSync(full); } catch { continue; }
      for (const file of entries.filter(f => f.endsWith('.json'))) {
        try {
          const p = loadProfile(join(full, file));
          results.push({ tool: p.tool, version: p.version, source: 'installed' });
        } catch {
          // skip invalid
        }
      }
    }
  }

  // Scan bundled
  if (existsSync(bundledDir)) {
    for (const file of readdirSync(bundledDir).filter(f => f.endsWith('.json'))) {
      try {
        const p = loadProfile(join(bundledDir, file));
        const isDup = results.some(r => r.tool === p.tool && r.version === p.version);
        if (!isDup) {
          results.push({ tool: p.tool, version: p.version, source: 'bundled' });
        }
      } catch {
        // skip invalid
      }
    }
  }

  return results;
}
