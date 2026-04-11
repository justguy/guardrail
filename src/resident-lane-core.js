import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join, relative, resolve, sep } from 'node:path';

const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const STARTUP_POLL_INTERVAL_MS = 25;
const STARTUP_TIMEOUT_MS = 2_000;
const STARTUP_SETTLE_MS = 150;
const POST_START_GRACE_MS = 750;
const MAX_TRACKED_REQUEST_IDS = 1024;
const MAX_REQUEST_BYTES = 50_000;
const MAX_PROMPT_CHARS = 32_000;
const MAX_REQUEST_ID_CHARS = 128;
const PARTIAL_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 250;

function withinPathScope(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function normalizeRelativeRepoPath(maybePath, guardrailRepo, label = 'scope path') {
  const raw = String(maybePath || '').trim();
  if (!raw) throw new Error(`${label} cannot be empty`);
  const repoRoot = resolve(guardrailRepo);
  const resolved = resolve(repoRoot, raw);
  if (!withinPathScope(resolved, repoRoot)) {
    throw new Error(`${label} must stay within the Guardrail repo`);
  }
  const rel = relative(repoRoot, resolved);
  return rel || '.';
}

export function normalizeResidentLaneScope(rawOptions, guardrailRepo, workingDir) {
  const explicitScopeType = rawOptions.scopeType || rawOptions.writeScopeType || '';
  const inferredWorktree = !explicitScopeType
    && resolve(workingDir || guardrailRepo) !== resolve(guardrailRepo);
  const scopeType = explicitScopeType || (inferredWorktree ? 'worktree' : 'none');
  const scopeMode = rawOptions.scopeMode || 'warn';

  if (!['none', 'repo', 'worktree', 'paths'].includes(scopeType)) {
    throw new Error('scope_type must be one of: none, repo, worktree, paths');
  }
  if (!['warn', 'block'].includes(scopeMode)) {
    throw new Error('scope_mode must be one of: warn, block');
  }

  if (scopeType === 'none') {
    return {
      scopeType,
      scopeMode,
      scopePaths: [],
    };
  }

  if (scopeType === 'repo') {
    return {
      scopeType,
      scopeMode: 'block',
      scopePaths: ['.'],
    };
  }

  if (scopeType === 'worktree') {
    const rel = normalizeRelativeRepoPath(workingDir, guardrailRepo, 'working_dir');
    return {
      scopeType,
      scopeMode,
      scopePaths: [rel],
    };
  }

  const rawScopePaths = Array.isArray(rawOptions.scopePaths)
    ? rawOptions.scopePaths.flatMap((entry) => splitCsv(entry))
    : splitCsv(rawOptions.scopePaths || rawOptions.scopePath || '');
  if (rawScopePaths.length === 0) {
    throw new Error('scope_type=paths requires at least one --scope-path');
  }
  return {
    scopeType,
    scopeMode,
    scopePaths: rawScopePaths.map((entry) => normalizeRelativeRepoPath(entry, guardrailRepo)),
  };
}

export function shellTruthy(value) {
  return value === true || value === 'true' || value === '1';
}

export function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseInteger(value, fallback, label, min) {
  if (value === '' || value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${label} must be an integer >= ${min}`);
  }
  return parsed;
}

export function lanePaths(laneDir) {
  return {
    requestFifo: join(laneDir, 'requests.fifo'),
    responseFifo: join(laneDir, 'responses.fifo'),
    statePath: join(laneDir, 'state.json'),
    identityPath: join(laneDir, 'identity.json'),
    launchPath: join(laneDir, 'launch.json'),
    logPath: join(laneDir, 'logs', 'lane.log'),
    resultsDir: join(laneDir, 'results'),
  };
}

export function laneResultPath(laneDir, requestId) {
  return join(lanePaths(laneDir).resultsDir, `${requestId}.json`);
}

function ensureFifo(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isFIFO()) {
      chmodSync(path, 0o600);
      return;
    }
    throw new Error(`${path} exists but is not a FIFO`);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const result = spawnSync('mkfifo', [path], { stdio: 'ignore' });
  if (result.status !== 0) {
    throw new Error(`Failed to create FIFO: ${path}`);
  }
  chmodSync(path, 0o600);
}

export function ensureLaneLayout(laneDir) {
  mkdirSync(laneDir, { recursive: true });
  mkdirSync(join(laneDir, 'logs'), { recursive: true });
  mkdirSync(join(laneDir, 'results'), { recursive: true });
  const paths = lanePaths(laneDir);
  ensureFifo(paths.requestFifo);
  ensureFifo(paths.responseFifo);
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function stableRepoOwnerId(guardrailRepo) {
  return createHash('sha256')
    .update(resolve(guardrailRepo))
    .digest('hex')
    .slice(0, 16);
}

function buildLaneIdentity(options, existing = null) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    adapterId: options.adapterId || existing?.adapterId || 'unknown',
    tool: options.tool || existing?.tool || options.adapterId || existing?.adapterId || 'unknown',
    scopeType: options.scopeType || existing?.scopeType || 'none',
    scopeMode: options.scopeMode || existing?.scopeMode || 'warn',
    scopePaths: Array.isArray(options.scopePaths)
      ? options.scopePaths
      : (existing?.scopePaths || []),
    laneId: options.laneId || existing?.laneId || null,
    laneDir: options.laneDir,
    guardrailRepo: options.guardrailRepo,
    workingDir: options.workingDir,
    keyPath: options.keyPath || existing?.keyPath || null,
    sessionName: options.sessionName,
    sessionId: options.sessionId || null,
    ownerRepoId: stableRepoOwnerId(options.guardrailRepo),
    identityNonce: existing?.identityNonce || options.identityNonce || randomBytes(12).toString('hex'),
    bootNonce: options.bootNonce || existing?.bootNonce || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function validateLaneIdentity(identity, options) {
  if (!identity) return;
  if (identity.laneDir && resolve(identity.laneDir) !== options.laneDir) {
    throw createLaneBootError('Resident lane identity does not match the requested lane directory.', {
      failureStage: 'bootstrap',
    });
  }
  if (identity.guardrailRepo && resolve(identity.guardrailRepo) !== options.guardrailRepo) {
    throw createLaneBootError('Resident lane identity belongs to a different Guardrail repo.', {
      failureStage: 'bootstrap',
    });
  }
  if (identity.laneId && options.laneId && identity.laneId !== options.laneId) {
    throw createLaneBootError('Resident lane identity belongs to a different lane id.', {
      failureStage: 'bootstrap',
    });
  }
}

function writeLaneIdentity(options, existing = null) {
  const identity = buildLaneIdentity(options, existing);
  writeJson(lanePaths(options.laneDir).identityPath, identity);
  return identity;
}

function readLogTail(path, maxLines = 10) {
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (!text) return '';
    return text.split('\n').slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

export function getResidentLaneLogs(rawOptions = {}) {
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

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'EPERM') return true;
    return false;
  }
}

function buildState(options, pid, startedConversation = false, extra = {}) {
  const paths = lanePaths(options.laneDir);
  return {
    adapterId: options.adapterId || 'unknown',
    tool: options.tool || options.adapterId || 'unknown',
    scopeType: options.scopeType || 'none',
    scopeMode: options.scopeMode || 'warn',
    scopePaths: Array.isArray(options.scopePaths) ? options.scopePaths : [],
    laneDir: options.laneDir,
    requestFifo: paths.requestFifo,
    responseFifo: paths.responseFifo,
    identityPath: paths.identityPath,
    guardrailRepo: options.guardrailRepo,
    workingDir: options.workingDir,
    laneId: options.laneId || null,
    keyPath: options.keyPath || null,
    sessionName: options.sessionName,
    sessionId: options.sessionId || null,
    identityNonce: options.identityNonce || null,
    bootNonce: options.bootNonce || null,
    ownerRepoId: stableRepoOwnerId(options.guardrailRepo),
    noSessionPersistence: options.noSessionPersistence,
    authMode: options.authFd ? 'hmac_fd' : 'none',
    logPath: paths.logPath,
    startedConversation,
    pid,
    status: extra.status || 'ready',
    lastRequestId: extra.lastRequestId || null,
    currentRequestId: extra.currentRequestId || null,
    currentRequestStartedAt: extra.currentRequestStartedAt || null,
    lastCompletedRequestId: extra.lastCompletedRequestId || null,
    lastCompletedAt: extra.lastCompletedAt || null,
    lastExitCode: extra.lastExitCode ?? null,
    lastResultPath: extra.lastResultPath || null,
    failureReason: extra.failureReason || null,
    failureStage: extra.failureStage || null,
    lastActivityAt: extra.lastActivityAt || new Date().toISOString(),
    createdAt: extra.createdAt || new Date().toISOString(),
    pollIntervalMs: options.pollIntervalMs,
    idleTimeoutMs: options.idleTimeoutMs,
  };
}

function canonicalRequestPayload(request) {
  return JSON.stringify({
    id: request.id,
    prompt: request.prompt,
  });
}

export function readSecretFromFd(fd) {
  if (!Number.isInteger(fd) || fd < 3) return '';
  const chunks = [];
  const buffer = Buffer.alloc(4096);
  for (;;) {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead <= 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

export function signLaneRequest(request, secret) {
  return createHmac('sha256', secret)
    .update(canonicalRequestPayload(request))
    .digest('hex');
}

export function verifyLaneRequestSignature(request, secret) {
  if (!secret) return true;
  if (typeof request.signature !== 'string' || request.signature.length !== 64 || !/^[a-f0-9]{64}$/.test(request.signature)) {
    throw new Error('invalid_signature');
  }
  const expected = Buffer.from(signLaneRequest(request, secret), 'utf8');
  const actual = Buffer.from(request.signature, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('invalid_signature');
  }
  return true;
}

export function validateLaneRequest(parsed, secret = '') {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_request');
  }

  const keys = Object.keys(parsed).sort();
  const expectedKeys = secret ? ['id', 'prompt', 'signature'] : ['id', 'prompt'];
  if (keys.length !== expectedKeys.length || !expectedKeys.every((key, index) => keys[index] === key)) {
    throw new Error('invalid_request');
  }

  if (
    typeof parsed.id !== 'string' ||
    parsed.id.length < 1 ||
    parsed.id.length > MAX_REQUEST_ID_CHARS ||
    !/^[A-Za-z0-9._:-]+$/.test(parsed.id)
  ) {
    throw new Error('invalid_request_id');
  }

  if (
    typeof parsed.prompt !== 'string' ||
    parsed.prompt.length < 1 ||
    parsed.prompt.length > MAX_PROMPT_CHARS
  ) {
    throw new Error('invalid_prompt');
  }

  verifyLaneRequestSignature(parsed, secret);
  return parsed;
}

export function trackLaneRequestId(seenRequestIds, requestId, nowMs = Date.now(), ttlMs = DEFAULT_IDLE_TIMEOUT_MS) {
  if (!(seenRequestIds instanceof Map)) {
    throw new Error('seenRequestIds must be a Map');
  }

  for (const [seenId, seenAtMs] of seenRequestIds.entries()) {
    if ((nowMs - seenAtMs) > ttlMs) {
      seenRequestIds.delete(seenId);
    }
  }

  if (seenRequestIds.has(requestId)) {
    throw new Error('duplicate_request_id');
  }

  seenRequestIds.set(requestId, nowMs);

  while (seenRequestIds.size > MAX_TRACKED_REQUEST_IDS) {
    const oldest = seenRequestIds.keys().next().value;
    if (oldest === undefined) break;
    seenRequestIds.delete(oldest);
  }

  return seenRequestIds;
}

export async function runResidentLaneRequest(adapter, options, request, state, deps = {}) {
  if (!adapter || typeof adapter.runRequest !== 'function') {
    throw new Error('Resident lane adapter must provide runRequest(options, request, state, deps).');
  }
  return adapter.runRequest(options, request, state, deps);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function updateStateFile(laneDir, state) {
  writeJson(lanePaths(laneDir).statePath, state);
}

function writeLaneResult(laneDir, response) {
  const resultPath = laneResultPath(laneDir, response.requestId);
  writeJson(resultPath, response);
  return resultPath;
}

function deriveFailureReason(err, fallback = 'Resident lane bootstrap failed.') {
  const message = String(err?.message || '').trim();
  return message || fallback;
}

export function persistLaneFailureState(options, err, failureStage = 'bootstrap') {
  try {
    mkdirSync(options.laneDir, { recursive: true });
    mkdirSync(join(options.laneDir, 'logs'), { recursive: true });
    const pid = err?.details?.pid ?? process.pid;
    const state = buildState(options, pid, false, {
      status: 'failed',
      failureReason: deriveFailureReason(err),
      failureStage,
      lastActivityAt: new Date().toISOString(),
    });
    writeJson(lanePaths(options.laneDir).statePath, state);
  } catch {
    // Best effort.
  }
}

export function createLaneBootError(message, details = {}) {
  const err = new Error(message);
  err.code = 'LANE_BOOT_FAILED';
  err.details = details;
  return err;
}

export async function waitForResidentLaneBootstrap(options, child, deps = {}) {
  const readState = deps.readState || ((path) => readJson(path, null));
  const isAlive = deps.isAlive || isPidAlive;
  const sleepFn = deps.sleep || sleep;
  const nowFn = deps.now || Date.now;
  const logTailFn = deps.readLogTail || readLogTail;
  const timeoutMs = deps.timeoutMs || STARTUP_TIMEOUT_MS;
  const postStartGraceMs = deps.postStartGraceMs || POST_START_GRACE_MS;
  const paths = lanePaths(options.laneDir);
  const expectedPid = child?.pid ?? null;
  const exitState = { code: null, signal: null, error: null };

  if (child instanceof EventEmitter) {
    child.once('error', (err) => {
      exitState.error = err;
    });
    child.once('exit', (code, signal) => {
      exitState.code = code;
      exitState.signal = signal;
    });
  }

  const startedAtMs = nowFn();
  let healthySinceMs = null;
  let postStartSinceMs = null;

  for (;;) {
    const state = readState(paths.statePath);
    const alive = expectedPid ? isAlive(expectedPid) : false;

    if (state?.status === 'failed') {
      throw createLaneBootError(
        state.failureReason || 'Resident lane daemon failed during startup.',
        {
          pid: state.pid ?? expectedPid,
          statePath: paths.statePath,
          logPath: paths.logPath,
          failureReason: state.failureReason || null,
          failureStage: state.failureStage || null,
        },
      );
    }

    if (exitState.error) {
      const logTail = logTailFn(paths.logPath);
      throw createLaneBootError(
        deriveFailureReason(exitState.error),
        {
          pid: expectedPid,
          statePath: paths.statePath,
          logPath: paths.logPath,
          failureReason: deriveFailureReason(exitState.error),
          failureStage: postStartSinceMs === null ? 'bootstrap' : 'post_start',
          logTail,
        },
      );
    }

    if ((exitState.code !== null || exitState.signal !== null) && !alive) {
      const logTail = logTailFn(paths.logPath);
      throw createLaneBootError(
        logTail || `Resident lane daemon exited during startup (code=${exitState.code ?? 'null'}, signal=${exitState.signal ?? 'null'}).`,
        {
          pid: expectedPid,
          statePath: paths.statePath,
          logPath: paths.logPath,
          failureReason: logTail || null,
          failureStage: postStartSinceMs === null ? 'bootstrap' : 'post_start',
          exitCode: exitState.code,
          signal: exitState.signal,
        },
      );
    }

    const appearsHealthy = !!(
      state
      && state.pid === expectedPid
      && alive
      && state.status !== 'failed'
      && state.status !== 'expired'
      && state.status !== 'stopped'
    );

    if (appearsHealthy) {
      if (healthySinceMs === null) {
        healthySinceMs = nowFn();
      } else if ((nowFn() - healthySinceMs) >= STARTUP_SETTLE_MS) {
        if (postStartSinceMs === null) {
          postStartSinceMs = nowFn();
        } else if ((nowFn() - postStartSinceMs) >= postStartGraceMs) {
          return state;
        }
      }
    } else {
      healthySinceMs = null;
    }

    if ((nowFn() - startedAtMs) >= timeoutMs) {
      const logTail = logTailFn(paths.logPath);
      throw createLaneBootError(
        logTail || 'Resident lane daemon did not become ready before the startup deadline.',
        {
          pid: expectedPid,
          statePath: paths.statePath,
          logPath: paths.logPath,
          failureReason: logTail || null,
          failureStage: postStartSinceMs === null ? 'bootstrap' : 'post_start',
        },
      );
    }

    await sleepFn(STARTUP_POLL_INTERVAL_MS);
  }
}

function writeResponse(fd, payload) {
  writeSync(fd, `${JSON.stringify(payload)}\n`, undefined, 'utf8');
}

function removeIfExists(path) {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function isFifo(path) {
  try {
    return lstatSync(path).isFIFO();
  } catch {
    return false;
  }
}

function classifyLaneStatus(state, identityPresent, keyPresent, requestFifoPresent, responseFifoPresent) {
  const alive = !!(state?.pid && isPidAlive(state.pid) && state.status !== 'expired' && state.status !== 'stopped' && state.status !== 'failed');
  const allArtifactsPresent = keyPresent && requestFifoPresent && responseFifoPresent;

  if (!state && !identityPresent && !keyPresent && !requestFifoPresent && !responseFifoPresent) {
    return { status: 'missing', alive: false, recommendedAction: 'start' };
  }
  if (state?.status === 'expired' || state?.status === 'stopped') {
    return { status: state.status, alive: false, recommendedAction: 'start' };
  }
  if (state?.status === 'failed') {
    return { status: 'failed', alive: false, recommendedAction: allArtifactsPresent ? 'cleanup' : 'start' };
  }
  if (alive) {
    if (state?.status === 'busy') {
      return { status: 'busy', alive: true, recommendedAction: 'result' };
    }
    return { status: state?.status || 'ready', alive: true, recommendedAction: 'send' };
  }
  if (state || identityPresent || keyPresent || requestFifoPresent || responseFifoPresent) {
    return { status: 'stale', alive: false, recommendedAction: allArtifactsPresent ? 'cleanup' : 'start' };
  }
  return { status: 'missing', alive: false, recommendedAction: 'start' };
}

function inferImplicitFailure(status, state) {
  if (!state) return null;
  if (status.status !== 'stale') return null;
  if (state.failureReason || state.failureStage) return null;
  if (state.startedConversation) return null;
  if (state.currentRequestId || state.lastCompletedRequestId) return null;
  if (state.status !== 'ready' && state.status !== 'busy') return null;

  return {
    status: 'failed',
    alive: false,
    recommendedAction: 'start',
    failureStage: 'post_start',
    failureReason: 'Resident lane daemon exited before processing the first request.',
  };
}

function scopeRootsForLane(entry) {
  const repoRoot = resolve(entry.guardrailRepo || process.cwd());
  const scopeType = entry.scopeType || 'none';
  const scopePaths = Array.isArray(entry.scopePaths) ? entry.scopePaths : [];
  if (scopeType === 'none' || scopePaths.length === 0) return [];
  return scopePaths.map((scopePath) => resolve(repoRoot, scopePath));
}

function laneScopesOverlap(a, b) {
  const aRoots = scopeRootsForLane(a);
  const bRoots = scopeRootsForLane(b);
  if (aRoots.length === 0 || bRoots.length === 0) return false;
  for (const aRoot of aRoots) {
    for (const bRoot of bRoots) {
      if (withinPathScope(aRoot, bRoot) || withinPathScope(bRoot, aRoot)) {
        return true;
      }
    }
  }
  return false;
}

function buildScopeConflict(entry, other) {
  const enforcement = (
    entry.scopeType === 'repo'
    || entry.scopeMode === 'block'
    || other.scopeType === 'repo'
    || other.scopeMode === 'block'
  ) ? 'block' : 'warn';
  return {
    laneId: other.laneId || null,
    laneDir: other.laneDir,
    tool: other.tool || other.adapterId || null,
    scopeType: other.scopeType || 'none',
    scopeMode: other.scopeMode || 'warn',
    scopePaths: Array.isArray(other.scopePaths) ? other.scopePaths : [],
    enforcement,
  };
}

function annotateScopeConflicts(entries) {
  return entries.map((entry) => {
    const scopeConflicts = entries
      .filter((other) => (
        other.laneDir !== entry.laneDir
        && other.alive
        && entry.alive
        && laneScopesOverlap(entry, other)
      ))
      .map((other) => buildScopeConflict(entry, other));
    return {
      ...entry,
      scopeConflicts,
    };
  });
}

function normalizeListFilterValues(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => String(entry).split(','))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseOptionalBooleanFilter(value) {
  if (value == null || value === '') return null;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('Boolean lane filters must be true or false.');
}

function laneMatchesFilters(entry, rawOptions = {}) {
  const statuses = normalizeListFilterValues(rawOptions.status);
  if (statuses.length > 0 && !statuses.includes(entry.status)) return false;

  const tools = normalizeListFilterValues(rawOptions.toolFilter);
  if (tools.length > 0 && !tools.includes(entry.tool || entry.adapterId || '')) return false;

  const laneIds = normalizeListFilterValues(rawOptions.filterLaneId || rawOptions.laneId);
  if (laneIds.length > 0 && !laneIds.includes(entry.laneId || '')) return false;

  const sessionNames = normalizeListFilterValues(rawOptions.filterSessionName);
  if (sessionNames.length > 0 && !sessionNames.includes(entry.sessionName || '')) return false;

  const scopeTypes = normalizeListFilterValues(rawOptions.scopeTypeFilter);
  if (scopeTypes.length > 0 && !scopeTypes.includes(entry.scopeType || 'none')) return false;

  const scopeModes = normalizeListFilterValues(rawOptions.scopeModeFilter);
  if (scopeModes.length > 0 && !scopeModes.includes(entry.scopeMode || 'warn')) return false;

  const alive = parseOptionalBooleanFilter(rawOptions.alive);
  if (alive !== null && alive !== entry.alive) return false;

  const hasConflicts = parseOptionalBooleanFilter(rawOptions.hasConflicts);
  if (hasConflicts !== null && hasConflicts !== ((entry.scopeConflicts?.length || 0) > 0)) return false;

  return true;
}

function registryDirFor(rawOptions = {}) {
  const guardrailRepo = rawOptions.guardrailRepo
    ? resolve(process.cwd(), rawOptions.guardrailRepo)
    : process.cwd();
  const registryDir = rawOptions.lanesDir
    ? resolve(guardrailRepo, rawOptions.lanesDir)
    : join(guardrailRepo, '.guardrail', 'lanes');
  return { guardrailRepo, registryDir };
}

function collectResidentLaneRegistryEntries(rawOptions = {}) {
  const { registryDir } = registryDirFor(rawOptions);
  const entries = [];
  if (!existsSync(registryDir)) {
    return { registryDir, entries: [] };
  }

  for (const entry of readdirSync(registryDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const laneDir = join(registryDir, entry.name);
    entries.push(collectResidentLaneStatusBase({ ...rawOptions, laneDir }));
  }

  return { registryDir, entries };
}

function collectResidentLaneStatusBase(rawOptions) {
  if (!rawOptions.laneDir) throw new Error('Provide --lane-dir.');
  const guardrailRepo = rawOptions.guardrailRepo
    ? resolve(process.cwd(), rawOptions.guardrailRepo)
    : process.cwd();
  const laneDir = resolve(guardrailRepo, rawOptions.laneDir);
  const keyPath = rawOptions.keyPath ? resolve(process.cwd(), rawOptions.keyPath) : '';
  const paths = lanePaths(laneDir);
  const state = readJson(paths.statePath, null);
  const identity = readJson(paths.identityPath, null);
  const effectiveKeyPath = identity?.keyPath || state?.keyPath || keyPath || '';
  const keyPresent = !!(effectiveKeyPath && existsSync(effectiveKeyPath));
  const requestFifoPresent = isFifo(paths.requestFifo);
  const responseFifoPresent = isFifo(paths.responseFifo);
  const classified = classifyLaneStatus(state, !!identity, keyPresent, requestFifoPresent, responseFifoPresent);
  const implicitFailure = inferImplicitFailure(classified, state);
  const derived = implicitFailure || classified;

  return {
    adapterId: state?.adapterId ?? identity?.adapterId ?? rawOptions.adapterId ?? rawOptions.tool ?? null,
    tool: state?.tool ?? identity?.tool ?? rawOptions.tool ?? state?.adapterId ?? identity?.adapterId ?? rawOptions.adapterId ?? null,
    scopeType: state?.scopeType ?? identity?.scopeType ?? rawOptions.scopeType ?? 'none',
    scopeMode: state?.scopeMode ?? identity?.scopeMode ?? rawOptions.scopeMode ?? 'warn',
    scopePaths: state?.scopePaths ?? identity?.scopePaths ?? rawOptions.scopePaths ?? [],
    laneDir,
    statePath: paths.statePath,
    status: derived.status,
    alive: derived.alive,
    pid: state?.pid ?? null,
    laneId: state?.laneId ?? identity?.laneId ?? rawOptions.laneId ?? null,
    sessionName: state?.sessionName ?? identity?.sessionName ?? rawOptions.sessionName ?? null,
    sessionId: state?.sessionId ?? identity?.sessionId ?? rawOptions.sessionId ?? null,
    identityPath: paths.identityPath,
    identityNonce: state?.identityNonce ?? identity?.identityNonce ?? null,
    bootNonce: state?.bootNonce ?? identity?.bootNonce ?? null,
    ownerRepoId: state?.ownerRepoId ?? identity?.ownerRepoId ?? null,
    guardrailRepo: state?.guardrailRepo ?? identity?.guardrailRepo ?? guardrailRepo,
    workingDir: state?.workingDir ?? identity?.workingDir ?? rawOptions.workingDir ?? guardrailRepo,
    lastRequestId: state?.lastRequestId ?? null,
    currentRequestId: state?.currentRequestId ?? null,
    currentRequestStartedAt: state?.currentRequestStartedAt ?? null,
    lastCompletedRequestId: state?.lastCompletedRequestId ?? null,
    lastCompletedAt: state?.lastCompletedAt ?? null,
    lastExitCode: state?.lastExitCode ?? null,
    lastResultPath: state?.lastResultPath ?? null,
    lastActivityAt: state?.lastActivityAt ?? null,
    createdAt: state?.createdAt ?? null,
    pollIntervalMs: state?.pollIntervalMs ?? null,
    idleTimeoutMs: state?.idleTimeoutMs ?? null,
    logPath: state?.logPath ?? paths.logPath,
    keyPath: effectiveKeyPath || null,
    keyPresent,
    requestFifoPresent,
    responseFifoPresent,
    startedConversation: state?.startedConversation ?? false,
    authMode: state?.authMode ?? null,
    failureReason: state?.failureReason ?? derived.failureReason ?? null,
    failureStage: state?.failureStage ?? derived.failureStage ?? null,
    recommendedAction: derived.recommendedAction,
  };
}

export function getResidentLaneStatus(rawOptions) {
  const base = collectResidentLaneStatusBase(rawOptions);
  const { entries } = collectResidentLaneRegistryEntries({ ...rawOptions, guardrailRepo: base.guardrailRepo });
  const combined = entries.some((entry) => entry.laneDir === base.laneDir)
    ? entries
    : [...entries, base];
  return annotateScopeConflicts(combined).find((entry) => entry.laneDir === base.laneDir) || base;
}

export function listResidentLanes(rawOptions = {}) {
  const { registryDir, entries: baseEntries } = collectResidentLaneRegistryEntries(rawOptions);
  const entries = annotateScopeConflicts(baseEntries).filter((entry) => laneMatchesFilters(entry, rawOptions));

  entries.sort((a, b) => {
    const byCreated = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    if (byCreated !== 0) return byCreated;
    return String(a.laneId || a.sessionName || a.laneDir).localeCompare(String(b.laneId || b.sessionName || b.laneDir));
  });

  const counts = entries.reduce((acc, entry) => {
    acc.total += 1;
    acc[entry.status] = (acc[entry.status] || 0) + 1;
    return acc;
  }, { total: 0 });

  return {
    registryDir,
    counts,
    lanes: entries,
  };
}

function cleanupOneLane(lane) {
  if (lane.keyPath) {
    removeIfExists(lane.keyPath);
  }
  removeLaneDirectory(lane.laneDir);
  return {
    laneDir: lane.laneDir,
    laneId: lane.laneId || null,
    adapterId: lane.adapterId || null,
    tool: lane.tool || lane.adapterId || null,
    status: lane.status,
    keyPath: lane.keyPath || null,
    aliveBeforeCleanup: lane.alive,
  };
}

function removeLaneDirectory(laneDir) {
  try {
    rmSync(laneDir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

export function pruneResidentLanes(rawOptions = {}) {
  const includeFailed = rawOptions.includeFailed === true || rawOptions.includeFailed === 'true';
  const listing = listResidentLanes(rawOptions);
  const prunableStates = new Set(includeFailed ? ['stale', 'expired', 'stopped', 'failed'] : ['stale', 'expired', 'stopped']);
  const pruned = [];
  const skipped = [];

  for (const lane of listing.lanes) {
    if (lane.alive || !prunableStates.has(lane.status)) {
      skipped.push({
        laneDir: lane.laneDir,
        laneId: lane.laneId,
        status: lane.status,
        reason: lane.alive ? 'lane_alive' : 'not_prunable',
      });
      continue;
    }

    pruned.push(cleanupOneLane(lane));
  }

  return {
    registryDir: listing.registryDir,
    includeFailed,
    pruned,
    skipped,
  };
}

export function cleanupResidentLane(rawOptions = {}) {
  const listing = listResidentLanes(rawOptions);
  const explicitLaneDir = rawOptions.laneDir
    ? resolve(rawOptions.guardrailRepo ? resolve(process.cwd(), rawOptions.guardrailRepo) : process.cwd(), rawOptions.laneDir)
    : null;
  const selected = explicitLaneDir
    ? listing.lanes.filter((lane) => lane.laneDir === explicitLaneDir)
    : listing.lanes;

  if (selected.length === 0) {
    return {
      status: 'missing',
      cleaned: false,
      message: 'No resident lane matched the requested cleanup target.',
      registryDir: listing.registryDir,
      matches: [],
    };
  }

  if (selected.length > 1) {
    return {
      status: 'ambiguous',
      cleaned: false,
      message: 'More than one resident lane matched the requested cleanup target.',
      registryDir: listing.registryDir,
      matches: selected.map((lane) => ({
        laneDir: lane.laneDir,
        laneId: lane.laneId || null,
        status: lane.status,
        tool: lane.tool || lane.adapterId || null,
      })),
    };
  }

  const lane = selected[0];
  const stopped = lane.alive ? stopResidentLane({
    ...rawOptions,
    laneDir: lane.laneDir,
    laneId: lane.laneId || rawOptions.laneId || '',
    keyPath: lane.keyPath || rawOptions.keyPath || '',
    tool: lane.tool || rawOptions.tool || lane.adapterId || 'claude',
    sessionName: lane.sessionName || rawOptions.sessionName || lane.laneId || '',
    sessionId: lane.sessionId || rawOptions.sessionId || '',
  }) : null;
  const cleaned = cleanupOneLane({
    ...lane,
    alive: false,
    status: stopped ? 'stopped' : lane.status,
    keyPath: (stopped?.keyPath || lane.keyPath || null),
  });

  return {
    status: 'cleaned',
    cleaned: true,
    registryDir: listing.registryDir,
    lane: cleaned,
    stoppedLiveLane: !!stopped,
  };
}

export function getResidentLaneResult(rawOptions) {
  if (!rawOptions.laneDir) throw new Error('Provide --lane-dir.');
  const status = getResidentLaneStatus(rawOptions);
  const requestId = rawOptions.requestId
    || status.currentRequestId
    || status.lastCompletedRequestId
    || status.lastRequestId
    || null;

  if (!requestId) {
    return {
      status: 'missing',
      reason: 'no_request_selected',
      message: 'No resident lane request has been recorded yet.',
      requestId: null,
      resultPath: null,
    };
  }

  const resultPath = laneResultPath(status.laneDir, requestId);
  const result = readJson(resultPath, null);
  if (result) {
    return {
      status: 'completed',
      requestId,
      resultPath,
      result,
    };
  }

  if (status.currentRequestId === requestId && status.status === 'busy') {
    return {
      status: 'pending',
      reason: 'request_still_running',
      message: 'Resident lane request is still running.',
      requestId,
      resultPath,
      currentRequestStartedAt: status.currentRequestStartedAt,
    };
  }

  return {
    status: 'missing',
    reason: 'result_not_found',
    message: 'No stored resident lane result was found for that request.',
    requestId,
    resultPath,
  };
}

export async function waitForResidentLaneResult(rawOptions = {}) {
  const timeoutMs = parseInteger(rawOptions.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 'timeout_ms', 1);
  const pollIntervalMs = parseInteger(rawOptions.pollIntervalMs, DEFAULT_WAIT_POLL_INTERVAL_MS, 'poll_interval_ms', 1);
  const startedAt = Date.now();

  for (;;) {
    const result = getResidentLaneResult(rawOptions);
    if (result.status === 'completed') return result;

    const status = getResidentLaneStatus(rawOptions);
    if (status.status === 'failed') {
      return {
        status: 'failed',
        reason: 'lane_failed',
        message: 'Resident lane failed before the requested result was produced.',
        requestId: rawOptions.requestId || status.currentRequestId || status.lastRequestId || null,
        failureReason: status.failureReason || null,
        failureStage: status.failureStage || null,
        logPath: status.logPath || null,
      };
    }
    if (status.status === 'expired' || status.status === 'stale' || status.status === 'stopped' || status.status === 'missing') {
      return {
        status: 'missing',
        reason: 'lane_unavailable',
        message: 'Resident lane is no longer available.',
        requestId: rawOptions.requestId || status.currentRequestId || status.lastRequestId || null,
      };
    }

    if ((Date.now() - startedAt) >= timeoutMs) {
      return {
        status: 'pending',
        reason: 'request_still_running',
        message: 'Resident lane request is still running.',
        requestId: rawOptions.requestId || status.currentRequestId || status.lastRequestId || null,
        currentRequestStartedAt: status.currentRequestStartedAt || null,
        resultPath: result.resultPath || null,
      };
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
  }
}

function cleanupLaneArtifacts(options, status, extra = {}) {
  const paths = lanePaths(options.laneDir);
  const finalState = {
    ...buildState(options, process.pid, false, {
      status,
      lastRequestId: extra.lastRequestId || null,
      currentRequestId: extra.currentRequestId || null,
      currentRequestStartedAt: extra.currentRequestStartedAt || null,
      lastCompletedRequestId: extra.lastCompletedRequestId || null,
      lastCompletedAt: extra.lastCompletedAt || null,
      lastExitCode: extra.lastExitCode ?? null,
      lastResultPath: extra.lastResultPath || null,
      failureReason: extra.failureReason || null,
      failureStage: extra.failureStage || null,
      lastActivityAt: new Date().toISOString(),
      createdAt: extra.createdAt || undefined,
    }),
    pid: process.pid,
  };
  writeJson(paths.statePath, finalState);
  removeIfExists(options.keyPath);
  removeIfExists(paths.requestFifo);
  removeIfExists(paths.responseFifo);
}

export async function runResidentLaneDaemon(options, adapter, deps = {}) {
  ensureLaneLayout(options.laneDir);
  const paths = lanePaths(options.laneDir);

  let state = buildState(options, process.pid, false);
  const authSecret = options.authFd ? readSecretFromFd(options.authFd) : '';
  updateStateFile(options.laneDir, state);

  const requestFd = openSync(paths.requestFifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
  const responseFd = openSync(paths.responseFifo, fsConstants.O_RDWR);

  let lastActivityAtMs = Date.now();
  let queue = Promise.resolve();
  let requestBuffer = '';
  let partialRequestAtMs = 0;
  const seenRequestIds = new Map();

  const enqueueRequest = (request) => {
    queue = queue.then(async () => {
      lastActivityAtMs = Date.now();
      state = {
        ...state,
        status: 'busy',
        lastRequestId: request.id,
        currentRequestId: request.id,
        currentRequestStartedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      };
      updateStateFile(options.laneDir, state);

      const response = await runResidentLaneRequest(adapter, options, request, state, deps);
      const resultPath = writeLaneResult(options.laneDir, response);
      state = {
        ...state,
        startedConversation: state.startedConversation || response.ok,
        status: 'ready',
        lastRequestId: request.id,
        currentRequestId: null,
        currentRequestStartedAt: null,
        lastCompletedRequestId: request.id,
        lastCompletedAt: response.completedAt,
        lastExitCode: response.exitCode,
        lastResultPath: resultPath,
        lastActivityAt: response.completedAt,
      };
      updateStateFile(options.laneDir, state);
      writeResponse(responseFd, response);
    }).catch((err) => {
      const failure = {
        requestId: request.id,
        prompt: request.prompt,
        ok: false,
        exitCode: 1,
        error: err.message,
        completedAt: new Date().toISOString(),
      };
      const resultPath = writeLaneResult(options.laneDir, failure);
      state = {
        ...state,
        status: 'ready',
        lastRequestId: request.id,
        currentRequestId: null,
        currentRequestStartedAt: null,
        lastCompletedRequestId: request.id,
        lastCompletedAt: failure.completedAt,
        lastExitCode: failure.exitCode,
        lastResultPath: resultPath,
        lastActivityAt: failure.completedAt,
      };
      updateStateFile(options.laneDir, state);
      writeResponse(responseFd, failure);
    });
  };

  let shuttingDown = false;
  const shutdown = (status, err = null, failureStage = 'runtime') => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      cleanupLaneArtifacts(options, status, {
        lastRequestId: state.lastRequestId,
        currentRequestId: state.currentRequestId,
        currentRequestStartedAt: state.currentRequestStartedAt,
        lastCompletedRequestId: state.lastCompletedRequestId,
        lastCompletedAt: state.lastCompletedAt,
        lastExitCode: state.lastExitCode,
        lastResultPath: state.lastResultPath,
        failureReason: err ? deriveFailureReason(err) : state.failureReason,
        failureStage: err ? failureStage : state.failureStage,
        createdAt: state.createdAt,
      });
    } finally {
      try { closeSync(requestFd); } catch {}
      try { closeSync(responseFd); } catch {}
      process.exit(0);
    }
  };

  process.once('SIGINT', () => shutdown('stopped'));
  process.once('SIGTERM', () => shutdown('stopped'));
  process.on('SIGHUP', () => {});
  process.once('uncaughtException', (err) => shutdown('failed', err, 'runtime'));
  process.once('unhandledRejection', (err) => shutdown('failed', err instanceof Error ? err : new Error(String(err)), 'runtime'));
  process.once('exit', (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      cleanupLaneArtifacts(options, 'failed', {
        lastRequestId: state.lastRequestId,
        currentRequestId: state.currentRequestId,
        currentRequestStartedAt: state.currentRequestStartedAt,
        lastCompletedRequestId: state.lastCompletedRequestId,
        lastCompletedAt: state.lastCompletedAt,
        lastExitCode: state.lastExitCode,
        lastResultPath: state.lastResultPath,
        failureReason: state.failureReason || `Resident lane daemon exited unexpectedly (code=${code ?? 'null'}).`,
        failureStage: state.failureStage || (state.startedConversation ? 'runtime' : 'post_start'),
        createdAt: state.createdAt,
      });
    } catch {
      // Best effort during process exit.
    }
  });

  try {
    const chunk = Buffer.alloc(4096);
    for (;;) {
      try {
        const bytesRead = readSync(requestFd, chunk, 0, chunk.length, null);
        if (bytesRead > 0) {
          requestBuffer += chunk.toString('utf8', 0, bytesRead);
          if (!partialRequestAtMs) partialRequestAtMs = Date.now();
          if (requestBuffer.length > MAX_REQUEST_BYTES) {
            requestBuffer = '';
            partialRequestAtMs = 0;
            writeResponse(responseFd, { ok: false, error: 'request_too_large' });
          }
          while (requestBuffer.includes('\n')) {
            const newlineIndex = requestBuffer.indexOf('\n');
            const line = requestBuffer.slice(0, newlineIndex).trim();
            requestBuffer = requestBuffer.slice(newlineIndex + 1);
            partialRequestAtMs = requestBuffer.length > 0 ? Date.now() : 0;
            if (!line) continue;
            try {
              const parsed = JSON.parse(line);
              const request = validateLaneRequest(parsed, authSecret);
              trackLaneRequestId(seenRequestIds, request.id, Date.now(), options.idleTimeoutMs);
              enqueueRequest(request);
            } catch (err) {
              writeResponse(responseFd, {
                requestId: typeof err?.requestId === 'string' ? err.requestId : null,
                ok: false,
                error: err.message === 'invalid_request'
                  || err.message === 'invalid_request_id'
                  || err.message === 'invalid_prompt'
                  || err.message === 'invalid_signature'
                  || err.message === 'duplicate_request_id'
                  ? err.message
                  : 'invalid_json',
              });
            }
          }
        }
      } catch (err) {
        if (err?.code !== 'EAGAIN') throw err;
      }

      if (requestBuffer && partialRequestAtMs && (Date.now() - partialRequestAtMs) > PARTIAL_REQUEST_TIMEOUT_MS) {
        requestBuffer = '';
        partialRequestAtMs = 0;
        writeResponse(responseFd, { ok: false, error: 'request_timeout' });
      }

      if ((Date.now() - lastActivityAtMs) > options.idleTimeoutMs) {
        shutdown('expired');
      }
      await sleep(options.pollIntervalMs);
    }
  } finally {
    if (!shuttingDown) {
      try { closeSync(requestFd); } catch {}
      try { closeSync(responseFd); } catch {}
    }
  }
}

export async function launchResidentLaneWithAdapter(options, adapter, deps = {}) {
  ensureLaneLayout(options.laneDir);
  const paths = lanePaths(options.laneDir);
  const existingIdentity = readJson(paths.identityPath, null);
  validateLaneIdentity(existingIdentity, options);

  const seededOptions = {
    ...options,
    identityNonce: existingIdentity?.identityNonce || randomBytes(12).toString('hex'),
    bootNonce: randomBytes(12).toString('hex'),
  };
  const identity = buildLaneIdentity(seededOptions, existingIdentity);
  const optionsWithIdentity = {
    ...seededOptions,
    identityNonce: identity.identityNonce,
    bootNonce: seededOptions.bootNonce,
  };

  const existing = readJson(paths.statePath, null);
  const duplicates = optionsWithIdentity.laneId
    ? listResidentLanes({ guardrailRepo: optionsWithIdentity.guardrailRepo }).lanes.filter((lane) => (
      lane.laneId === optionsWithIdentity.laneId
      && lane.laneDir !== optionsWithIdentity.laneDir
      && lane.alive
    ))
    : [];
  if (duplicates.length > 0) {
    throw createLaneBootError(`Duplicate live resident lane detected for lane id "${optionsWithIdentity.laneId}".`, {
      failureStage: 'bootstrap',
      conflictingLaneDir: duplicates[0].laneDir,
      conflictingPid: duplicates[0].pid,
    });
  }
  const scopeConflicts = optionsWithIdentity.scopeType && optionsWithIdentity.scopeType !== 'none'
    ? listResidentLanes({ guardrailRepo: optionsWithIdentity.guardrailRepo }).lanes
      .filter((lane) => (
        lane.laneDir !== optionsWithIdentity.laneDir
        && lane.alive
        && laneScopesOverlap(optionsWithIdentity, lane)
      ))
      .map((lane) => buildScopeConflict(optionsWithIdentity, lane))
    : [];
  if (scopeConflicts.some((conflict) => conflict.enforcement === 'block')) {
    throw createLaneBootError('Resident lane scope conflicts with another live lane in this Guardrail repo.', {
      failureStage: 'bootstrap',
      scopeConflicts,
    });
  }
  writeJson(paths.identityPath, identity);

  if (existing?.status && existing.status !== 'expired' && isPidAlive(existing.pid)) {
    return {
      adapterId: existing.adapterId ?? optionsWithIdentity.adapterId ?? adapter.adapterId ?? null,
      tool: existing.tool ?? optionsWithIdentity.tool ?? existing.adapterId ?? optionsWithIdentity.adapterId ?? adapter.adapterId ?? null,
      scopeType: existing.scopeType ?? optionsWithIdentity.scopeType ?? 'none',
      scopeMode: existing.scopeMode ?? optionsWithIdentity.scopeMode ?? 'warn',
      scopePaths: existing.scopePaths ?? optionsWithIdentity.scopePaths ?? [],
      scopeConflicts,
      laneDir: optionsWithIdentity.laneDir,
      requestFifo: existing.requestFifo ?? paths.requestFifo,
      responseFifo: existing.responseFifo ?? paths.responseFifo,
      pid: existing.pid,
      sessionName: existing.sessionName,
      sessionId: existing.sessionId ?? null,
      workingDir: existing.workingDir,
      statePath: paths.statePath,
      reused: true,
      authMode: existing.authMode ?? 'none',
      keyPath: existing.keyPath ?? optionsWithIdentity.keyPath ?? null,
      identityPath: paths.identityPath,
      identityNonce: existing.identityNonce ?? identity.identityNonce ?? null,
      bootNonce: existing.bootNonce ?? identity.bootNonce ?? null,
    };
  }

  if (!adapter || typeof adapter.buildHelperArgs !== 'function') {
    throw new Error('Resident lane adapter must provide buildHelperArgs(options, helperAuthFd).');
  }

  const helperAuthFd = optionsWithIdentity.authFd ? 3 : null;
  const helperArgs = adapter.buildHelperArgs(optionsWithIdentity, helperAuthFd);
  const helperStdio = ['ignore', 'pipe', 'pipe'];
  if (optionsWithIdentity.authFd) {
    helperStdio.push(optionsWithIdentity.authFd);
  }

  const spawnProcess = deps.spawnProcess || spawn;
  const child = spawnProcess(process.execPath, helperArgs, {
    cwd: optionsWithIdentity.guardrailRepo,
    detached: false,
    stdio: helperStdio,
    env: process.env,
  });

  let helperStdout = '';
  let helperStderr = '';
  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      helperStdout += chunk.toString();
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      helperStderr += chunk.toString();
    });
  }

  await new Promise((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(helperStderr.trim() || `Resident lane launch helper exited with code ${code}.`));
        return;
      }
      resolvePromise();
    });
  });

  let daemonPid = null;
  try {
    daemonPid = JSON.parse(helperStdout.trim()).pid ?? null;
  } catch {
    daemonPid = null;
  }
  if (!Number.isInteger(daemonPid) || daemonPid <= 0) {
    throw createLaneBootError(helperStderr.trim() || 'Resident lane launch helper did not return a daemon pid.', {
      statePath: paths.statePath,
      logPath: paths.logPath,
      failureStage: 'bootstrap',
    });
  }

  const launchSummary = {
    adapterId: optionsWithIdentity.adapterId || adapter.adapterId || null,
    tool: optionsWithIdentity.tool || optionsWithIdentity.adapterId || adapter.adapterId || null,
    scopeType: optionsWithIdentity.scopeType || 'none',
    scopeMode: optionsWithIdentity.scopeMode || 'warn',
    scopePaths: optionsWithIdentity.scopePaths || [],
    scopeConflicts,
    laneDir: optionsWithIdentity.laneDir,
    requestFifo: paths.requestFifo,
    responseFifo: paths.responseFifo,
    pid: daemonPid,
    sessionName: optionsWithIdentity.sessionName,
    sessionId: optionsWithIdentity.sessionId || null,
    workingDir: optionsWithIdentity.workingDir,
    statePath: paths.statePath,
    authMode: optionsWithIdentity.authFd ? 'hmac_fd' : 'none',
    laneId: optionsWithIdentity.laneId || null,
    keyPath: optionsWithIdentity.keyPath || null,
    logPath: paths.logPath,
    identityPath: paths.identityPath,
    identityNonce: optionsWithIdentity.identityNonce,
    bootNonce: optionsWithIdentity.bootNonce,
  };
  writeJson(paths.launchPath, launchSummary);
  writeLaneIdentity(optionsWithIdentity, identity);

  try {
    const waitForBootstrap = deps.waitForBootstrap || waitForResidentLaneBootstrap;
    await waitForBootstrap(optionsWithIdentity, { pid: daemonPid }, deps.waitForBootstrapDeps || {});
  } catch (err) {
    persistLaneFailureState(optionsWithIdentity, err, err?.details?.failureStage || 'bootstrap');
    throw err;
  }
  return launchSummary;
}

export function launchResidentLaneDaemonHelper(options, adapter) {
  ensureLaneLayout(options.laneDir);
  const paths = lanePaths(options.laneDir);
  const stdoutFd = openSync(paths.logPath, 'a');
  const stderrFd = openSync(paths.logPath, 'a');
  const daemonAuthFd = options.authFd ? 3 : null;

  if (!adapter || typeof adapter.buildDaemonArgs !== 'function') {
    throw new Error('Resident lane adapter must provide buildDaemonArgs(options, daemonAuthFd).');
  }

  const daemonArgs = adapter.buildDaemonArgs(options, daemonAuthFd);
  const daemonStdio = ['ignore', stdoutFd, stderrFd];
  if (options.authFd) {
    daemonStdio.push(options.authFd);
  }

  const daemon = spawn(process.execPath, daemonArgs, {
    cwd: options.guardrailRepo,
    detached: true,
    stdio: daemonStdio,
    env: process.env,
  });
  daemon.unref();
  process.stdout.write(`${JSON.stringify({ pid: daemon.pid })}\n`);
}

export function stopResidentLane(rawOptions) {
  if (!rawOptions.laneDir) throw new Error('Provide --lane-dir.');
  const guardrailRepo = rawOptions.guardrailRepo
    ? resolve(process.cwd(), rawOptions.guardrailRepo)
    : process.cwd();
  const laneDir = resolve(guardrailRepo, rawOptions.laneDir);
  const keyPath = rawOptions.keyPath ? resolve(process.cwd(), rawOptions.keyPath) : '';
  const options = {
    adapterId: rawOptions.adapterId || 'unknown',
    laneDir,
    keyPath,
    guardrailRepo,
    workingDir: rawOptions.workingDir ? resolve(guardrailRepo, rawOptions.workingDir) : guardrailRepo,
    laneId: rawOptions.laneId || '',
    sessionName: rawOptions.sessionName || rawOptions.laneId || '',
    sessionId: rawOptions.sessionId || '',
    noSessionPersistence: false,
    authFd: null,
  };
  const paths = lanePaths(options.laneDir);
  const state = readJson(paths.statePath, null);
  if (state?.pid && isPidAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // fall through to local cleanup
    }
  }
  cleanupLaneArtifacts(options, 'stopped', {
    lastRequestId: state?.lastRequestId || null,
    currentRequestId: state?.currentRequestId || null,
    currentRequestStartedAt: state?.currentRequestStartedAt || null,
    lastCompletedRequestId: state?.lastCompletedRequestId || null,
    lastCompletedAt: state?.lastCompletedAt || null,
    lastExitCode: state?.lastExitCode ?? null,
    lastResultPath: state?.lastResultPath || null,
    createdAt: state?.createdAt,
  });
  try {
    rmSync(join(options.laneDir, 'logs'), { recursive: true, force: true });
  } catch {}
  return {
    adapterId: state?.adapterId ?? options.adapterId,
    tool: state?.tool ?? options.tool ?? state?.adapterId ?? options.adapterId,
    laneDir: options.laneDir,
    statePath: paths.statePath,
    keyPath: options.keyPath || null,
    stopped: true,
  };
}
