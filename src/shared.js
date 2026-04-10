import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Deep equality (JSON-serialisable values only)
// ---------------------------------------------------------------------------

export function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  if (typeof a === 'object') {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (!deepEqual(keysA, keysB)) return false;
    return keysA.every(k => deepEqual(a[k], b[k]));
  }

  return false;
}

// ---------------------------------------------------------------------------
// Pretty-print for diff output
// ---------------------------------------------------------------------------

export function pretty(value) {
  if (value === undefined) return '<absent>';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Index an array of objects by their `id` field
// ---------------------------------------------------------------------------

export function indexById(arr) {
  const map = new Map();
  for (const item of arr ?? []) {
    map.set(item.id, item);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Path resolution — resolve to absolute, falling back gracefully
// ---------------------------------------------------------------------------

export function resolvePath(p, base) {
  if (!p || typeof p !== 'string') return base;
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

// ---------------------------------------------------------------------------
// Atomic state file write
// ---------------------------------------------------------------------------

export function writeStateAtomic(stateDir, state) {
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, 'state.json');
  const tmpPath = join(stateDir, `.tmp-state-${randomBytes(8).toString('hex')}.json`);
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, statePath);
}

export function persistStateSafe(stateDir, state) {
  try {
    writeStateAtomic(stateDir, state);
  } catch {
    // Best-effort: never crash the supervisor on state write failure.
  }
}

// ---------------------------------------------------------------------------
// Execute a command as a subprocess (used for update proposals)
// ---------------------------------------------------------------------------

export function executeSubprocess(command, args, cwd, options = {}) {
  return new Promise((resolvePromise) => {
    if (!command) {
      return resolvePromise({ success: false, error: 'No command provided', hasChanges: false });
    }

    const spawnArgs = Array.isArray(args) ? args : [];
    const spawnCwd = cwd || process.cwd();
    const spawnEnv = options.env || buildEnvFromPolicy(options.envPolicy);

    let child;
    try {
      child = spawn(command, spawnArgs, {
        cwd: spawnCwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
      });
    } catch (err) {
      return resolvePromise({ success: false, error: err.message, hasChanges: false });
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      stderr += `Spawn error: ${err.message}\n`;
    });

    child.on('close', (code) => {
      const success = code === 0;
      const hasChanges = success && stdout.length > 0;
      resolvePromise({
        success,
        exitCode: code,
        stdout,
        stderr,
        error: success ? null : `Exit code ${code}`,
        hasChanges,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Diff helpers — compare object fields and produce human-readable strings
// ---------------------------------------------------------------------------

export function diffObjectFields(candidate, approved, fields, prefix = '') {
  const diffs = [];
  for (const field of fields) {
    if (!deepEqual(candidate[field], approved[field])) {
      const label = prefix ? `${prefix}.${field}` : field;
      diffs.push(`${label}: ${pretty(approved[field])} -> ${pretty(candidate[field])}`);
    }
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Build environment from an envPolicy object
// ---------------------------------------------------------------------------

export function buildEnvFromPolicy(envPolicy) {
  if (!envPolicy) return { ...process.env };

  let env;
  if (envPolicy.inherit === false) {
    env = {};
    for (const key of (envPolicy.allow || [])) {
      if (key in process.env) env[key] = process.env[key];
    }
  } else {
    env = { ...process.env };
  }

  for (const [key, value] of Object.entries(envPolicy.inject || {})) {
    env[key] = value;
  }

  return env;
}

export function diffNestedBlocks(candidateBlock, approvedBlock) {
  const diffs = [];
  const allKeys = new Set([
    ...Object.keys(candidateBlock ?? {}),
    ...Object.keys(approvedBlock ?? {}),
  ]);

  for (const key of allKeys) {
    const cVal = candidateBlock?.[key];
    const aVal = approvedBlock?.[key];
    if (!deepEqual(cVal, aVal)) {
      diffs.push({ key, from: aVal, to: cVal });
    }
  }
  return diffs;
}
