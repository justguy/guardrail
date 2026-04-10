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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

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

function shellTruthy(value) {
  return value === true || value === 'true' || value === '1';
}

function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback, label, min) {
  if (value === '' || value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${label} must be an integer >= ${min}`);
  }
  return parsed;
}

export function parseResidentLaneArgs(argv) {
  const options = {
    laneDir: '',
    guardrailRepo: '',
    workingDir: '',
    model: '',
    effort: '',
    permissionMode: '',
    outputFormat: '',
    maxBudgetUsd: '',
    allowedTools: '',
    systemPrompt: '',
    addDirs: '',
    inputFiles: '',
    laneId: '',
    keyPath: '',
    identityNonce: '',
    bootNonce: '',
    sessionName: '',
    sessionId: '',
    noSessionPersistence: '',
    authFd: '',
    pollIntervalMs: '',
    idleTimeoutMs: '',
    launchDaemonHelper: false,
    daemon: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    switch (flag) {
      case '--lane-dir':
        options.laneDir = value;
        i += 1;
        break;
      case '--guardrail-repo':
        options.guardrailRepo = value;
        i += 1;
        break;
      case '--working-dir':
        options.workingDir = value;
        i += 1;
        break;
      case '--model':
        options.model = value;
        i += 1;
        break;
      case '--effort':
        options.effort = value;
        i += 1;
        break;
      case '--permission-mode':
        options.permissionMode = value;
        i += 1;
        break;
      case '--output-format':
        options.outputFormat = value;
        i += 1;
        break;
      case '--max-budget-usd':
        options.maxBudgetUsd = value;
        i += 1;
        break;
      case '--allowed-tools':
        options.allowedTools = value;
        i += 1;
        break;
      case '--system-prompt':
        options.systemPrompt = value;
        i += 1;
        break;
      case '--add-dirs':
        options.addDirs = value;
        i += 1;
        break;
      case '--input-files':
        options.inputFiles = value;
        i += 1;
        break;
      case '--lane-id':
        options.laneId = value;
        i += 1;
        break;
      case '--key-path':
        options.keyPath = value;
        i += 1;
        break;
      case '--identity-nonce':
        options.identityNonce = value;
        i += 1;
        break;
      case '--boot-nonce':
        options.bootNonce = value;
        i += 1;
        break;
      case '--session-name':
        options.sessionName = value;
        i += 1;
        break;
      case '--session-id':
        options.sessionId = value;
        i += 1;
        break;
      case '--no-session-persistence':
        options.noSessionPersistence = value;
        i += 1;
        break;
      case '--auth-fd':
        options.authFd = value;
        i += 1;
        break;
      case '--poll-interval-ms':
        options.pollIntervalMs = value;
        i += 1;
        break;
      case '--idle-timeout-ms':
        options.idleTimeoutMs = value;
        i += 1;
        break;
      case '--launch-daemon-helper':
        options.launchDaemonHelper = true;
        break;
      case '--daemon':
        options.daemon = true;
        break;
      default:
        break;
    }
  }

  return options;
}

export function normalizeResidentLaneOptions(rawOptions, baseCwd = process.cwd()) {
  if (!rawOptions.laneDir) throw new Error('Provide --lane-dir.');
  if (!rawOptions.sessionName) throw new Error('Provide --session-name.');

  const guardrailRepo = rawOptions.guardrailRepo
    ? resolve(baseCwd, rawOptions.guardrailRepo)
    : baseCwd;
  const laneDir = resolve(guardrailRepo, rawOptions.laneDir);
  const workingDir = rawOptions.workingDir
    ? resolve(guardrailRepo, rawOptions.workingDir)
    : guardrailRepo;

  return {
    laneDir,
    guardrailRepo,
    workingDir,
    model: rawOptions.model || 'sonnet',
    effort: rawOptions.effort || 'low',
    permissionMode: rawOptions.permissionMode || 'default',
    outputFormat: rawOptions.outputFormat || 'text',
    maxBudgetUsd: rawOptions.maxBudgetUsd || '1.00',
    allowedTools: rawOptions.allowedTools || '',
    systemPrompt: rawOptions.systemPrompt || '',
    addDirs: splitCsv(rawOptions.addDirs).map((dir) => resolve(workingDir, dir)),
    inputFiles: splitCsv(rawOptions.inputFiles),
    laneId: rawOptions.laneId || '',
    keyPath: rawOptions.keyPath ? resolve(baseCwd, rawOptions.keyPath) : '',
    identityNonce: rawOptions.identityNonce || '',
    bootNonce: rawOptions.bootNonce || '',
    sessionName: rawOptions.sessionName,
    sessionId: rawOptions.sessionId || '',
    noSessionPersistence: shellTruthy(rawOptions.noSessionPersistence),
    authFd: parseInteger(rawOptions.authFd, null, 'auth_fd', 3),
    pollIntervalMs: parseInteger(rawOptions.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'poll_interval_ms', 50),
    idleTimeoutMs: parseInteger(rawOptions.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'idle_timeout_ms', 1000),
    launchDaemonHelper: rawOptions.launchDaemonHelper === true,
    daemon: rawOptions.daemon === true,
  };
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

function ensureLaneLayout(laneDir) {
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

function stableRepoOwnerId(guardrailRepo) {
  return createHash('sha256')
    .update(resolve(guardrailRepo))
    .digest('hex')
    .slice(0, 16);
}

function buildLaneIdentity(options, existing = null) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
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

function buildWrapperArgs(options, request, lifecycle) {
  const wrapperPath = resolve(options.guardrailRepo, 'src/claude-exec-wrapper.js');
  const args = [wrapperPath, '--prompt', request.prompt];
  if (options.inputFiles.length > 0) args.push('--input-files', options.inputFiles.join(','));
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.outputFormat) args.push('--output-format', options.outputFormat);
  if (options.maxBudgetUsd) args.push('--max-budget-usd', options.maxBudgetUsd);
  if (options.allowedTools) args.push('--allowed-tools', options.allowedTools);
  if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
  args.push('--working-dir', options.workingDir);
  if (options.addDirs.length > 0) args.push('--add-dirs', options.addDirs.join(','));
  args.push('--session-name', options.sessionName);
  if (options.noSessionPersistence) args.push('--no-session-persistence', 'true');
  args.push('--lifecycle', lifecycle);
  if (options.sessionId) args.push('--session-id', options.sessionId);
  return args;
}

function canonicalRequestPayload(request) {
  return JSON.stringify({
    id: request.id,
    prompt: request.prompt,
  });
}

function readSecretFromFd(fd) {
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

function signLaneRequest(request, secret) {
  return createHmac('sha256', secret)
    .update(canonicalRequestPayload(request))
    .digest('hex');
}

function verifyLaneRequestSignature(request, secret) {
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

function validateLaneRequest(parsed, secret = '') {
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

export async function runLaneRequest(options, request, state, deps = {}) {
  const runner = deps.runner || spawnClaudeWrapper;
  const lifecycle = state.startedConversation ? 'continue' : 'start';
  const startedAt = new Date().toISOString();
  const result = await runner(buildWrapperArgs(options, request, lifecycle), options.guardrailRepo);
  return {
    requestId: request.id,
    prompt: request.prompt,
    lifecycle,
    ok: result.code === 0,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

async function spawnClaudeWrapper(args, cwd) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      if (signal) {
        resolvePromise({ code: 1, stdout, stderr: `${stderr}\nclaude wrapper exited on signal ${signal}`.trim() });
        return;
      }
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
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

function persistLaneFailureState(options, err, failureStage = 'bootstrap') {
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

function createLaneBootError(message, details = {}) {
  const err = new Error(message);
  err.code = 'LANE_BOOT_FAILED';
  err.details = details;
  return err;
}

async function waitForResidentLaneBootstrap(options, child, deps = {}) {
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

export function getResidentLaneStatus(rawOptions) {
  if (!rawOptions.laneDir) throw new Error('Provide --lane-dir.');
  const guardrailRepo = rawOptions.guardrailRepo
    ? resolve(process.cwd(), rawOptions.guardrailRepo)
    : process.cwd();
  const laneDir = resolve(guardrailRepo, rawOptions.laneDir);
  const keyPath = rawOptions.keyPath ? resolve(process.cwd(), rawOptions.keyPath) : '';
  const paths = lanePaths(laneDir);
  const state = readJson(paths.statePath, null);
  const identity = readJson(paths.identityPath, null);
  const effectiveKeyPath = keyPath || identity?.keyPath || state?.keyPath || '';
  const keyPresent = !!(effectiveKeyPath && existsSync(effectiveKeyPath));
  const requestFifoPresent = isFifo(paths.requestFifo);
  const responseFifoPresent = isFifo(paths.responseFifo);
  const classified = classifyLaneStatus(state, !!identity, keyPresent, requestFifoPresent, responseFifoPresent);
  const implicitFailure = inferImplicitFailure(classified, state);
  const derived = implicitFailure || classified;

  return {
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

export function listResidentLanes(rawOptions = {}) {
  const guardrailRepo = rawOptions.guardrailRepo
    ? resolve(process.cwd(), rawOptions.guardrailRepo)
    : process.cwd();
  const registryDir = rawOptions.lanesDir
    ? resolve(guardrailRepo, rawOptions.lanesDir)
    : join(guardrailRepo, '.guardrail', 'lanes');

  const entries = [];
  if (existsSync(registryDir)) {
    for (const entry of readdirSync(registryDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const laneDir = join(registryDir, entry.name);
      const status = getResidentLaneStatus({ guardrailRepo, laneDir });
      entries.push(status);
    }
  }

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

    if (lane.keyPath) {
      removeIfExists(lane.keyPath);
    }
    removeLaneDirectory(lane.laneDir);
    pruned.push({
      laneDir: lane.laneDir,
      laneId: lane.laneId,
      status: lane.status,
      keyPath: lane.keyPath || null,
    });
  }

  return {
    registryDir: listing.registryDir,
    includeFailed,
    pruned,
    skipped,
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

async function runResidentLaneDaemon(options) {
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

      const response = await runLaneRequest(options, request, state);
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
  // Resident lanes are launched as detached background processes from host
  // runtimes; ignore SIGHUP so the lane survives when the launching shell exits.
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

export async function launchResidentLane(rawOptions, deps = {}) {
  const options = normalizeResidentLaneOptions(rawOptions);
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
  writeJson(paths.identityPath, identity);

  if (existing?.status && existing.status !== 'expired' && isPidAlive(existing.pid)) {
    return {
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

  const selfPath = fileURLToPath(import.meta.url);
  const helperAuthFd = optionsWithIdentity.authFd ? 3 : null;
  const helperArgs = [
    selfPath,
    '--launch-daemon-helper',
    '--lane-dir', optionsWithIdentity.laneDir,
    '--guardrail-repo', optionsWithIdentity.guardrailRepo,
    '--working-dir', optionsWithIdentity.workingDir,
    '--lane-id', optionsWithIdentity.laneId || '',
    '--key-path', optionsWithIdentity.keyPath || '',
    '--session-name', optionsWithIdentity.sessionName,
    '--session-id', optionsWithIdentity.sessionId || '',
    '--no-session-persistence', String(optionsWithIdentity.noSessionPersistence),
    '--poll-interval-ms', String(optionsWithIdentity.pollIntervalMs),
    '--idle-timeout-ms', String(optionsWithIdentity.idleTimeoutMs),
    '--model', optionsWithIdentity.model,
    '--effort', optionsWithIdentity.effort,
    '--permission-mode', optionsWithIdentity.permissionMode,
    '--output-format', optionsWithIdentity.outputFormat,
    '--max-budget-usd', optionsWithIdentity.maxBudgetUsd,
    '--allowed-tools', optionsWithIdentity.allowedTools,
    '--system-prompt', optionsWithIdentity.systemPrompt,
    '--add-dirs', optionsWithIdentity.addDirs.join(','),
    '--input-files', optionsWithIdentity.inputFiles.join(','),
    '--identity-nonce', optionsWithIdentity.identityNonce,
    '--boot-nonce', optionsWithIdentity.bootNonce,
  ];
  if (helperAuthFd !== null) {
    helperArgs.push('--auth-fd', String(helperAuthFd));
  }

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

function launchResidentLaneDaemonHelper(rawOptions) {
  const options = normalizeResidentLaneOptions(rawOptions);
  ensureLaneLayout(options.laneDir);
  const paths = lanePaths(options.laneDir);
  const selfPath = fileURLToPath(import.meta.url);
  const stdoutFd = openSync(paths.logPath, 'a');
  const stderrFd = openSync(paths.logPath, 'a');
  const daemonAuthFd = options.authFd ? 3 : null;
  const daemonArgs = [
    selfPath,
    '--daemon',
    '--lane-dir', options.laneDir,
    '--guardrail-repo', options.guardrailRepo,
    '--working-dir', options.workingDir,
    '--lane-id', options.laneId || '',
    '--key-path', options.keyPath || '',
    '--session-name', options.sessionName,
    '--session-id', options.sessionId || '',
    '--no-session-persistence', String(options.noSessionPersistence),
    '--poll-interval-ms', String(options.pollIntervalMs),
    '--idle-timeout-ms', String(options.idleTimeoutMs),
    '--model', options.model,
    '--effort', options.effort,
    '--permission-mode', options.permissionMode,
    '--output-format', options.outputFormat,
    '--max-budget-usd', options.maxBudgetUsd,
    '--allowed-tools', options.allowedTools,
    '--system-prompt', options.systemPrompt,
    '--add-dirs', options.addDirs.join(','),
    '--input-files', options.inputFiles.join(','),
    '--identity-nonce', options.identityNonce || '',
    '--boot-nonce', options.bootNonce || '',
  ];
  if (daemonAuthFd !== null) {
    daemonArgs.push('--auth-fd', String(daemonAuthFd));
  }

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
    laneDir: options.laneDir,
    statePath: paths.statePath,
    keyPath: options.keyPath || null,
    stopped: true,
  };
}

export {
  canonicalRequestPayload,
  createLaneBootError,
  waitForResidentLaneBootstrap,
  readSecretFromFd,
  signLaneRequest,
  verifyLaneRequestSignature,
  validateLaneRequest,
};

async function main() {
  const raw = parseResidentLaneArgs(process.argv.slice(2));
  let options;
  try {
    options = normalizeResidentLaneOptions(raw);
    if (options.launchDaemonHelper) {
      launchResidentLaneDaemonHelper(raw);
      return;
    }
    if (options.daemon) {
      await runResidentLaneDaemon(options);
      return;
    }

    const summary = await launchResidentLane(raw);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (err) {
    if (raw?.daemon) {
      try {
        const failureOptions = options || normalizeResidentLaneOptions(raw);
        persistLaneFailureState(failureOptions, err, 'bootstrap');
      } catch {
        // Best effort.
      }
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
