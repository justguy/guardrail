import { createHash } from 'node:crypto';
import {
  existsSync, readFileSync, mkdirSync,
  openSync, closeSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { serializeStable } from './contract.js';
import { captureFingerprint } from './fingerprint.js';
import { sovereignMeta, computePayloadHash } from './shared.js';
import { SCHEMA_VERSION, eventFamily } from './event-schema.js';

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

function computeEntryHash(entry) {
  // Hash all fields except entry_hash itself
  const { entry_hash: _, ...rest } = entry;
  return createHash('sha256').update(serializeStable(rest)).digest('hex');
}

function getLastEntryHash(auditPath) {
  if (!existsSync(auditPath)) return null;
  const content = readFileSync(auditPath, 'utf8').trim();
  if (!content) return null;
  const lines = content.split('\n');
  const lastLine = lines[lines.length - 1];
  try {
    return JSON.parse(lastLine).entry_hash ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audit log — hash-chained, append-only (I-A5)
// ---------------------------------------------------------------------------

/**
 * Create an audit log writer for a given path.
 * Each entry is hash-chained to the previous one.
 *
 * @param {string} auditPath - Path to the audit.jsonl file.
 * @returns {object} Audit log interface.
 */
export function createAuditLog(auditPath) {
  // Ensure directory exists
  const dir = dirname(auditPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return {
    path: auditPath,
    append: (entry) => appendEntry(auditPath, entry),
    verify: () => verifyAuditChain(auditPath),
    query:  (filters) => queryAuditLog(auditPath, filters),
  };
}

/**
 * Append a hash-chained entry to the audit log.
 *
 * @param {string} auditPath   - Path to the audit.jsonl file.
 * @param {object} entry       - Entry fields (event, trace_id, manifest_hash, etc.).
 * @param {object} [provenance] - Optional source provenance descriptor passed to sovereignMeta().
 */
export function appendEntry(auditPath, entry, provenance) {
  const prevHash = getLastEntryHash(auditPath);

  // Build the entry without chain hashes first so payload_hash can cover it
  const base = {
    schema_version:   SCHEMA_VERSION,
    family:           entry.family ?? eventFamily(entry.event),
    timestamp:        new Date().toISOString(),
    ...entry,
    fingerprint:      captureFingerprint(),
    ...sovereignMeta(provenance),
    prev_hash:        prevHash,
  };

  // payload_hash covers everything except the chain hashes themselves
  base.payload_hash = computePayloadHash(base);

  const fullEntry = base;

  fullEntry.entry_hash = computeEntryHash(fullEntry);

  // Atomic single-write append (not buffered)
  const line = JSON.stringify(fullEntry) + '\n';
  const fd = openSync(auditPath, 'a');
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Chain verification — tamper resistance (I-A5, Directive 7)
// ---------------------------------------------------------------------------

/**
 * Verify the full hash chain of an audit log.
 *
 * @param {string} auditPath - Path to the audit.jsonl file.
 * @returns {{ valid: boolean, entries: number, error: string|null, brokenAt: number|null }}
 */
export function verifyAuditChain(auditPath) {
  if (!existsSync(auditPath)) return { valid: true, entries: 0, error: null, brokenAt: null };
  const content = readFileSync(auditPath, 'utf8').trim();
  if (!content) return { valid: true, entries: 0, error: null, brokenAt: null };

  const lines = content.split('\n');
  let prevHash = null;

  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { valid: false, entries: i, error: `Parse error at entry ${i}`, brokenAt: i };
    }

    // Verify entry_hash matches recomputed hash
    const computed = computeEntryHash(entry);
    if (entry.entry_hash !== computed) {
      return { valid: false, entries: i, error: `audit_chain_broken: entry hash mismatch at index ${i}`, brokenAt: i };
    }

    // Verify chain linkage
    if (i === 0) {
      if (entry.prev_hash !== null) {
        return { valid: false, entries: i, error: `audit_chain_broken: first entry has non-null prev_hash`, brokenAt: i };
      }
    } else {
      if (entry.prev_hash !== prevHash) {
        return { valid: false, entries: i, error: `audit_chain_broken: chain broken at index ${i}`, brokenAt: i };
      }
    }

    prevHash = entry.entry_hash;
  }

  return { valid: true, entries: lines.length, error: null, brokenAt: null };
}

// ---------------------------------------------------------------------------
// Audit query surface (Directive 8)
// ---------------------------------------------------------------------------

/**
 * Query audit log entries with optional filters.
 *
 * @param {string} auditPath - Path to the audit.jsonl file.
 * @param {object} [filters] - Optional filters: trace_id, manifest_hash, event, after, before.
 * @returns {object[]} Matching entries.
 */
export function queryAuditLog(auditPath, filters = {}) {
  if (!existsSync(auditPath)) return [];
  const content = readFileSync(auditPath, 'utf8').trim();
  if (!content) return [];

  const results = [];
  for (const line of content.split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (matchesFilters(entry, filters)) results.push(entry);
    } catch {
      // Skip parse errors in query mode
    }
  }
  return results;
}

function matchesFilters(entry, filters) {
  if (filters.trace_id && entry.trace_id !== filters.trace_id) return false;
  if (filters.manifest_hash && entry.manifest_hash !== filters.manifest_hash) return false;
  if (filters.event && entry.event !== filters.event) return false;
  if (filters.after && entry.timestamp < filters.after) return false;
  if (filters.before && entry.timestamp > filters.before) return false;
  return true;
}
