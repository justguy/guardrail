import { readFileSync } from 'node:fs';

export function readLogTail(path, maxLines = 10) {
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (!text) return '';
    return text.split('\n').slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

export function readLaneControl(laneDir, lanePaths, readJson) {
  return readJson(lanePaths(laneDir).controlPath, null);
}

export function writeLaneControl(laneDir, patch, lanePaths, readJson, writeJson) {
  const paths = lanePaths(laneDir);
  const existing = readJson(paths.controlPath, {}) || {};
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  writeJson(paths.controlPath, next);
  return next;
}

export function getResidentLaneLogs(rawOptions = {}, deps = {}) {
  const { getResidentLaneStatus, parseInteger } = deps;
  const status = getResidentLaneStatus(rawOptions);
  const tailLines = parseInteger(rawOptions.tail, 40, 'tail', 1);
  const text = readLogTail(status.logPath, tailLines);
  return {
    laneDir: status.laneDir,
    laneId: status.laneId || null,
    status: status.status,
    tool: status.tool ?? status.adapterId ?? null,
    logPath: status.logPath || null,
    tailLines,
    text,
    hasLog: text.trim().length > 0,
  };
}

export function extendResidentLane(laneDir, updates = {}, deps = {}) {
  const { readLaneControl, writeLaneControl } = deps;
  const existing = readLaneControl(laneDir) || {};
  const patch = {};
  if (updates.idleTimeoutMs != null) {
    const n = Number(updates.idleTimeoutMs);
    if (!Number.isFinite(n) || n < 1000) throw new Error('idle_timeout_ms must be >= 1000');
    patch.idleTimeoutMs = n;
  }
  if (updates.healthTimeoutMs != null) {
    const n = Number(updates.healthTimeoutMs);
    if (!Number.isFinite(n) || n < 1000) throw new Error('health_timeout_ms must be >= 1000');
    patch.healthTimeoutMs = n;
  }
  if (updates.heartbeat) patch.heartbeatAt = new Date().toISOString();
  if (Object.keys(patch).length === 0) {
    throw new Error('extendResidentLane requires idleTimeoutMs, healthTimeoutMs, or heartbeat');
  }
  const effectiveIdle = patch.idleTimeoutMs ?? existing.idleTimeoutMs ?? null;
  const effectiveHealth = patch.healthTimeoutMs ?? existing.healthTimeoutMs ?? null;
  if (Number.isFinite(effectiveIdle) && Number.isFinite(effectiveHealth) && effectiveHealth >= effectiveIdle) {
    throw new Error('health_timeout_ms must be less than idle_timeout_ms');
  }
  return writeLaneControl(laneDir, patch);
}
