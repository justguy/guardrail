import { writeFileSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { serializeStable } from './contract.js';
import { deepEqual, pretty } from './shared.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_CONTRACT_VERSION = 1;
export const VALID_SESSION_TOOLS = new Set(['claude', 'codex']);
export const VALID_SESSION_LIFECYCLES = new Set(['start', 'continue', 'attach']);
const SESSION_SLOT_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// Identity fields hashed and compared. Order does not affect serializeStable
// (it sorts keys); the array documents the stable identity set.
export const SESSION_IDENTITY_FIELDS = [
  'version',
  'kind',
  'tool',
  'recipeId',
  'recipeVersion',
  'workingDir',
  'scope',
  'sessionName',
  'sessionId',
  'lifecycle',
];

// ---------------------------------------------------------------------------
// Pure helpers (internal)
// ---------------------------------------------------------------------------

function normalizeAddDirs(addDirs, baseCwd) {
  if (addDirs === undefined || addDirs === null) return [];
  if (!Array.isArray(addDirs)) {
    throw new Error('agent-session: addDirs must be an array of strings');
  }
  const seen = new Set();
  for (const entry of addDirs) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error('agent-session: addDirs entries must be non-empty strings');
    }
    const absolute = isAbsolute(entry) ? entry : resolve(baseCwd, entry);
    seen.add(resolve(absolute));
  }
  return [...seen].sort();
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`agent-session: ${label} must be a non-empty string`);
  }
  return value;
}

function optionalNullableString(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`agent-session: ${label} must be a non-empty string when provided`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public API — sanitization + paths
// ---------------------------------------------------------------------------

/**
 * Sanitize a session slot name. Returns 'default' for null/empty/invalid
 * input. Names with shell metacharacters or path separators are rejected.
 */
export function sanitizeSessionSlot(name) {
  if (name === undefined || name === null) return 'default';
  if (typeof name !== 'string') return 'default';
  const trimmed = name.trim();
  if (trimmed === '') return 'default';
  if (!SESSION_SLOT_RE.test(trimmed)) return 'default';
  return trimmed;
}

/**
 * Compute the on-disk path for a session contract artifact.
 */
export function defaultSessionContractPath(stateDir, recipeId, sessionName) {
  if (!stateDir || typeof stateDir !== 'string') {
    throw new Error('agent-session: stateDir must be a non-empty string');
  }
  if (!recipeId || typeof recipeId !== 'string') {
    throw new Error('agent-session: recipeId must be a non-empty string');
  }
  const slot = sanitizeSessionSlot(sessionName);
  return resolve(stateDir, 'agent-sessions', recipeId, `${slot}.json`);
}

// ---------------------------------------------------------------------------
// Public API — build + hash
// ---------------------------------------------------------------------------

/**
 * Build a canonical session contract object from raw input fields.
 * The returned object is fully populated except for createdAt/updatedAt,
 * which are filled in by saveSessionContract().
 */
export function buildSessionContract(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('agent-session: buildSessionContract requires an input object');
  }

  const tool = requireString(input.tool, 'tool');
  if (!VALID_SESSION_TOOLS.has(tool)) {
    throw new Error(
      `agent-session: tool must be one of ${[...VALID_SESSION_TOOLS].join(', ')}, got ${pretty(tool)}`,
    );
  }

  const recipeId = requireString(input.recipeId, 'recipeId');
  const recipeVersion = requireString(input.recipeVersion, 'recipeVersion');
  const workingDir = resolve(requireString(input.workingDir, 'workingDir'));
  const scope = { addDirs: normalizeAddDirs(input.addDirs, workingDir) };
  const sessionName = optionalNullableString(input.sessionName, 'sessionName');
  const sessionId = optionalNullableString(input.sessionId, 'sessionId');

  const lifecycle = requireString(input.lifecycle, 'lifecycle');
  if (!VALID_SESSION_LIFECYCLES.has(lifecycle)) {
    throw new Error(
      `agent-session: lifecycle must be one of ${[...VALID_SESSION_LIFECYCLES].join(', ')}, got ${pretty(lifecycle)}`,
    );
  }

  const contract = {
    version: SESSION_CONTRACT_VERSION,
    kind: 'agent_session_contract',
    tool,
    recipeId,
    recipeVersion,
    workingDir,
    scope,
    sessionName,
    sessionId,
    lifecycle,
  };
  contract.contractHash = hashSessionContract(contract);
  return contract;
}

/**
 * Compute the canonical SHA-256 hash of a session contract, excluding
 * mutable bookkeeping fields (contractHash, createdAt, updatedAt).
 */
export function hashSessionContract(contract) {
  if (!contract || typeof contract !== 'object') {
    throw new Error('agent-session: hashSessionContract requires a contract object');
  }
  const hashable = {};
  for (const field of SESSION_IDENTITY_FIELDS) {
    hashable[field] = contract[field] ?? null;
  }
  return createHash('sha256').update(serializeStable(hashable)).digest('hex');
}

// ---------------------------------------------------------------------------
// Public API — diff + compare (pure)
// ---------------------------------------------------------------------------

/**
 * Return human-readable diff strings between a candidate and an approved
 * contract. Bookkeeping fields (createdAt, updatedAt, contractHash) are
 * intentionally ignored.
 */
export function diffSessionContracts(candidate, approved) {
  if (!candidate || !approved) return [];
  const diffs = [];
  for (const field of SESSION_IDENTITY_FIELDS) {
    if (!deepEqual(candidate[field], approved[field])) {
      diffs.push(`~ session.${field}: ${pretty(approved[field])} -> ${pretty(candidate[field])}`);
    }
  }
  return diffs;
}

/**
 * Compare a candidate against an approved session contract.
 */
export function compareSessionContracts(candidate, approved) {
  const diffs = diffSessionContracts(candidate, approved);
  return { matches: diffs.length === 0, diffs };
}

// ---------------------------------------------------------------------------
// Public API — revocation
// ---------------------------------------------------------------------------

/**
 * Return true if a loaded session contract has been revoked.
 */
export function isSessionRevoked(contract) {
  return contract != null && contract.status === 'revoked';
}

/**
 * Permanently revoke a session contract on disk. Sets status to 'revoked',
 * stamps revokedAt, revokedBy, and revocationReason. Fails closed: throws if
 * the contract does not exist (cannot revoke unknown state). Idempotent if
 * already revoked.
 */
export function revokeSessionContract(filePath, { actor = 'operator', reason = '' } = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('agent-session: revokeSessionContract requires a filePath');
  }
  const existing = loadSessionContract(filePath);
  if (!existing) {
    throw new Error(`agent-session: no session contract at ${filePath}; cannot revoke unknown state`);
  }
  if (isSessionRevoked(existing)) return existing;
  const now = new Date().toISOString();
  const revoked = {
    ...existing,
    status: 'revoked',
    revokedAt: now,
    revokedBy: actor,
    revocationReason: reason || null,
    updatedAt: now,
  };
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-revoke-${randomBytes(8).toString('hex')}.json`);
  writeFileSync(tmpPath, JSON.stringify(revoked, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, filePath);
  return revoked;
}

// ---------------------------------------------------------------------------
// Public API — load / save (the only I/O surface)
// ---------------------------------------------------------------------------

/**
 * Load a session contract from disk. Returns null if the file does not exist.
 * Throws on JSON parse or shape errors so corrupt state fails closed.
 */
export function loadSessionContract(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.kind !== 'agent_session_contract') {
      throw new Error('not an agent_session_contract');
    }
    return parsed;
  } catch (parseErr) {
    throw new Error(`Corrupt agent session contract at ${filePath}: ${parseErr.message}`);
  }
}

/**
 * Persist a session contract atomically. Sets createdAt on first write and
 * always refreshes updatedAt. The candidate is not mutated; the persisted
 * object is returned.
 */
export function saveSessionContract(contract, filePath) {
  if (!contract || typeof contract !== 'object') {
    throw new Error('agent-session: saveSessionContract requires a contract object');
  }
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('agent-session: saveSessionContract requires a target filePath');
  }

  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  let existingCreatedAt = null;
  try {
    const existing = loadSessionContract(filePath);
    if (existing && typeof existing.createdAt === 'string') {
      existingCreatedAt = existing.createdAt;
    }
  } catch {
    existingCreatedAt = null;
  }

  const now = new Date().toISOString();
  const persisted = {
    ...contract,
    contractHash: contract.contractHash ?? hashSessionContract(contract),
    createdAt: existingCreatedAt ?? contract.createdAt ?? now,
    updatedAt: now,
  };

  const tmpPath = join(dir, `.tmp-session-${randomBytes(8).toString('hex')}.json`);
  writeFileSync(tmpPath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, filePath);
  return persisted;
}
