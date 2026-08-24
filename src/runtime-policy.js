import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync,
  openSync, closeSync, writeSync, unlinkSync,
  constants,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Time policy enforcement (I-A3)
// ---------------------------------------------------------------------------

/**
 * Check all runtime time/quota limits before execution.
 *
 * @param {object} runtimeLimits - From manifest: { validUntil, allowedWindow, maxRuns, maxExecutionsPerMinute }
 * @param {string} manifestHash  - Hash of the manifest (used as counter key).
 * @param {string} stateDir      - Directory for persisted state.
 * @returns {{ allowed: boolean, errors: object[] }}
 */
export function checkTimePolicy(runtimeLimits, manifestHash, stateDir) {
  const errors = [];
  if (!runtimeLimits) return { allowed: true, errors };

  if (runtimeLimits.validUntil) {
    const expiry = new Date(runtimeLimits.validUntil);
    if (Date.now() > expiry.getTime()) {
      errors.push({ code: 'time_window_expired', detail: `Manifest expired at ${runtimeLimits.validUntil}` });
    }
  }

  if (runtimeLimits.allowedWindow) {
    if (!isInAllowedWindow(runtimeLimits.allowedWindow)) {
      errors.push({ code: 'outside_allowed_window', detail: `Current time outside window: ${runtimeLimits.allowedWindow}` });
    }
  }

  if (runtimeLimits.maxRuns != null) {
    const r = checkAndIncrementCounter(manifestHash, 'runs', runtimeLimits.maxRuns, stateDir);
    if (!r.allowed) errors.push({ code: r.code, detail: r.detail });
  }

  if (runtimeLimits.maxExecutionsPerMinute != null) {
    const r = checkRateLimit(manifestHash, runtimeLimits.maxExecutionsPerMinute, stateDir);
    if (!r.allowed) errors.push({ code: r.code, detail: r.detail });
  }

  return { allowed: errors.length === 0, errors };
}

function isInAllowedWindow(windowSpec) {
  const match = windowSpec.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!match) return true;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = parseInt(match[1]) * 60 + parseInt(match[2]);
  const end = parseInt(match[3]) * 60 + parseInt(match[4]);
  return start <= end
    ? (cur >= start && cur <= end)
    : (cur >= start || cur <= end);
}

// ---------------------------------------------------------------------------
// Counter persistence — atomic read/increment/write (I-A3)
// ---------------------------------------------------------------------------

/**
 * Check a counter against a max value and increment atomically.
 * Missing file on first run: initialize to 0.
 * Corrupt file: fail closed.
 */
export function checkAndIncrementCounter(manifestHash, counterName, maxValue, stateDir) {
  const counterDir = join(stateDir, 'counters');
  const counterPath = join(counterDir, `${manifestHash}-${counterName}.json`);

  let counter;
  try {
    if (existsSync(counterPath)) {
      const raw = readFileSync(counterPath, 'utf8');
      counter = JSON.parse(raw);
      if (typeof counter.value !== 'number' || !Number.isFinite(counter.value)) {
        return { allowed: false, code: `max_${counterName}_exhausted`, detail: 'Counter file corrupt — fail closed' };
      }
    } else {
      counter = { value: 0 };
    }
  } catch {
    return { allowed: false, code: `max_${counterName}_exhausted`, detail: 'Counter file corrupt — fail closed' };
  }

  if (counter.value >= maxValue) {
    return { allowed: false, code: `max_${counterName}_exhausted`, detail: `${counterName} exhausted: ${counter.value}/${maxValue}` };
  }

  // Atomic increment
  counter.value += 1;
  counter.updatedAt = new Date().toISOString();
  if (!existsSync(counterDir)) mkdirSync(counterDir, { recursive: true });
  atomicWrite(counterPath, JSON.stringify(counter));
  return { allowed: true, code: null, detail: null, value: counter.value };
}

/**
 * Check rate limit (executions per minute).
 */
export function checkRateLimit(manifestHash, maxPerMinute, stateDir) {
  const counterDir = join(stateDir, 'counters');
  const ratePath = join(counterDir, `${manifestHash}-rate.json`);

  let rateState;
  try {
    if (existsSync(ratePath)) {
      const raw = readFileSync(ratePath, 'utf8');
      rateState = JSON.parse(raw);
      if (!Array.isArray(rateState.timestamps)) {
        return { allowed: false, code: 'rate_limit_exceeded', detail: 'Rate file corrupt — fail closed' };
      }
    } else {
      rateState = { timestamps: [] };
    }
  } catch {
    return { allowed: false, code: 'rate_limit_exceeded', detail: 'Rate file corrupt — fail closed' };
  }

  const windowStart = Date.now() - 60000;
  rateState.timestamps = rateState.timestamps.filter(t => t > windowStart);

  if (rateState.timestamps.length >= maxPerMinute) {
    return { allowed: false, code: 'rate_limit_exceeded', detail: `${rateState.timestamps.length}/${maxPerMinute} per minute` };
  }

  rateState.timestamps.push(Date.now());
  if (!existsSync(counterDir)) mkdirSync(counterDir, { recursive: true });
  atomicWrite(ratePath, JSON.stringify(rateState));
  return { allowed: true, code: null, detail: null };
}

// ---------------------------------------------------------------------------
// Concurrency locks (I-A4)
// ---------------------------------------------------------------------------

/**
 * Acquire a concurrency lock for a manifest execution.
 * Lock is a file with PID, timestamp, TTL.
 * Expired or dead-PID locks are reclaimed.
 *
 * @param {string} manifestHash  - Lock key base.
 * @param {string[]} resourceLocks - Additional resource lock identifiers.
 * @param {string} stateDir       - Directory for lock files.
 * @param {number} [ttlMs=60000]  - Lock TTL in milliseconds.
 * @returns {{ acquired: boolean, code: string|null, detail: string|null, release: Function|null }}
 */
export function acquireLock(manifestHash, resourceLocks, stateDir, ttlMs = 60000) {
  const lockKey = manifestHash + (resourceLocks?.length ? '-' + resourceLocks.join('-') : '');
  const lockDir = join(stateDir, 'locks');
  const lockPath = join(lockDir, `${lockKey}.lock`);

  if (!existsSync(lockDir)) mkdirSync(lockDir, { recursive: true });

  // Check existing lock
  if (existsSync(lockPath)) {
    let lockData;
    try {
      lockData = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch {
      return { acquired: false, code: 'concurrent_execution_blocked', detail: 'Lock file corrupt — fail closed', release: null };
    }

    const now = Date.now();
    const expired = lockData.expiresAt && now > lockData.expiresAt;
    const pidDead = lockData.pid && !isProcessAlive(lockData.pid);

    if (!expired && !pidDead) {
      return {
        acquired: false,
        code: 'concurrent_execution_blocked',
        detail: `Lock held by PID ${lockData.pid}, expires ${new Date(lockData.expiresAt).toISOString()}`,
        release: null,
      };
    }

    // Reclaim expired or dead-PID lock
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  }

  // Acquire via O_EXCL (atomic create)
  const lockData = {
    pid:           process.pid,
    acquiredAt:    new Date().toISOString(),
    expiresAt:     Date.now() + ttlMs,
    manifestHash,
    resourceLocks: resourceLocks ?? [],
  };

  try {
    const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    writeSync(fd, JSON.stringify(lockData));
    closeSync(fd);
  } catch (err) {
    if (err.code === 'EEXIST') {
      return { acquired: false, code: 'concurrent_execution_blocked', detail: 'Lock race — another process acquired first', release: null };
    }
    return { acquired: false, code: 'concurrent_execution_blocked', detail: `Lock error: ${err.message}`, release: null };
  }

  const release = () => { try { unlinkSync(lockPath); } catch { /* ignore */ } };
  return { acquired: true, code: null, detail: null, release };
}

/**
 * Release a lock by path.
 */
export function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function atomicWrite(targetPath, content) {
  const tmpPath = targetPath + '.tmp.' + randomBytes(4).toString('hex');
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, targetPath);
}
