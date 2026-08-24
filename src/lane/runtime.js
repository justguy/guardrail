import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { evaluateLaneHealth } from './health.js';

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function updateStateFile(laneDir, state, deps = {}) {
  const { lanePaths, writeJson } = deps;
  writeJson(lanePaths(laneDir).statePath, state);
}

function appendLaneLogLine(logPath, line, deps = {}) {
  const { appendFileSync } = deps;
  appendFileSync(logPath, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
}

function writeLaneResult(laneDir, response, deps = {}) {
  const { laneResultPath, writeJson } = deps;
  const resultPath = laneResultPath(laneDir, response.requestId);
  writeJson(resultPath, response);
  return resultPath;
}

function deriveFailureReason(err, fallback = 'Resident lane bootstrap failed.') {
  const message = String(err?.message || '').trim();
  return message || fallback;
}

function writeResponse(fd, payload) {
  writeSync(fd, `${JSON.stringify(payload)}\n`, undefined, 'utf8');
}

export function createLaneBootError(message, details = {}) {
  const err = new Error(message);
  err.code = 'LANE_BOOT_FAILED';
  err.details = details;
  return err;
}

export function persistLaneFailureState(options, err, failureStage = 'bootstrap', deps = {}) {
  const { buildState, lanePaths, removeLaneClaim, writeJson } = deps;
  try {
    mkdirSync(options.laneDir, { recursive: true });
    mkdirSync(join(options.laneDir, 'logs'), { recursive: true });
    if (options.laneId) {
      removeLaneClaim(options.laneId, options.keyPath || '', {
        laneDir: options.laneDir,
        bootNonce: options.bootNonce || null,
      });
    }
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

export async function waitForResidentLaneBootstrap(options, child, deps = {}) {
  const {
    isPidAlive,
    lanePaths,
    readJson,
    readLogTail,
    startupPollIntervalMs,
    startupSettleMs,
    startupTimeoutMs,
    postStartGraceMs,
  } = deps;
  const readState = deps.readState || ((path) => readJson(path, null));
  const isAlive = deps.isAlive || isPidAlive;
  const sleepFn = deps.sleep || sleep;
  const nowFn = deps.now || Date.now;
  const logTailFn = deps.readLogTailOverride || readLogTail;
  const timeoutMs = deps.timeoutMs || startupTimeoutMs;
  const graceMs = deps.postStartGraceMsOverride || postStartGraceMs;
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
      throw createLaneBootError(deriveFailureReason(exitState.error), {
        pid: expectedPid,
        statePath: paths.statePath,
        logPath: paths.logPath,
        failureReason: deriveFailureReason(exitState.error),
        failureStage: postStartSinceMs === null ? 'bootstrap' : 'post_start',
        logTail,
      });
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
      && state.status !== 'bootstrapping'
      && state.status !== 'failed'
      && state.status !== 'expired'
      && state.status !== 'stopped'
    );

    if (appearsHealthy) {
      if (healthySinceMs === null) {
        healthySinceMs = nowFn();
      } else if ((nowFn() - healthySinceMs) >= startupSettleMs) {
        if (postStartSinceMs === null) {
          postStartSinceMs = nowFn();
        } else if ((nowFn() - postStartSinceMs) >= graceMs) {
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

    await sleepFn(startupPollIntervalMs);
  }
}

export function cleanupLaneArtifacts(options, status, extra = {}, deps = {}) {
  const {
    buildState,
    lanePaths,
    removeHostLaneRegistryEntry,
    removeLaneClaim,
    removeIfExists,
    writeJson,
  } = deps;
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
  removeHostLaneRegistryEntry(options);
  if (options.laneId) {
    removeLaneClaim(options.laneId, options.keyPath || '', {
      laneDir: options.laneDir,
      bootNonce: options.bootNonce || finalState.bootNonce || null,
    });
  }
  removeIfExists(options.keyPath);
  removeIfExists(paths.requestFifo);
  removeIfExists(paths.responseFifo);
  removeIfExists(paths.controlPath);
}

export async function runResidentLaneDaemon(options, adapter, deps = {}) {
  const {
    appendFileSync,
    buildState,
    defaultHealthTimeoutMs,
    ensureLaneLayout,
    lanePaths,
    laneResultPath,
    maxRequestBytes,
    partialRequestTimeoutMs,
    readLaneControl,
    readSecretFromFd,
    runResidentLaneRequest,
    trackLaneRequestId,
    validateLaneRequest,
    writeJson,
  } = deps;
  ensureLaneLayout(options.laneDir);
  const paths = lanePaths(options.laneDir);

  if (existsSync(join(options.laneDir, 'REVOKED'))) {
    throw createLaneBootError('Lane has been revoked and cannot be restarted.', {
      failureStage: 'revocation_check',
    });
  }

  let state = buildState(options, process.pid, false, { status: 'bootstrapping' });
  const authSecret = options.authFd ? readSecretFromFd(options.authFd) : '';
  updateStateFile(options.laneDir, state, { lanePaths, writeJson });

  if (adapter && typeof adapter.preflightDaemon === 'function') {
    const preflight = await adapter.preflightDaemon(options, deps);
    state = {
      ...state,
      authSource: preflight?.source || null,
      authPreflightStatus: preflight?.ok ? 'passed' : 'failed',
      authPreflightReason: preflight?.reason || null,
      authPreflightMessage: preflight?.message || null,
      authPreflightCheckedAt: preflight?.checkedAt || new Date().toISOString(),
      lastActivityAt: preflight?.checkedAt || new Date().toISOString(),
    };
    if (!preflight?.ok) {
      state = {
        ...state,
        status: 'failed',
        failureReason: preflight?.message || preflight?.reason || 'Resident lane auth preflight failed.',
        failureStage: 'auth_preflight',
      };
      updateStateFile(options.laneDir, state, { lanePaths, writeJson });
      throw createLaneBootError(state.failureReason, {
        failureStage: 'auth_preflight',
        authSource: state.authSource,
        authPreflightStatus: state.authPreflightStatus,
        authPreflightReason: state.authPreflightReason,
        authPreflightMessage: state.authPreflightMessage,
        authPreflightCheckedAt: state.authPreflightCheckedAt,
      });
    }
    state = { ...state, status: 'ready' };
    updateStateFile(options.laneDir, state, { lanePaths, writeJson });
  } else {
    state = { ...state, status: 'ready' };
    updateStateFile(options.laneDir, state, { lanePaths, writeJson });
  }

  const requestFd = openSync(paths.requestFifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
  const responseFd = openSync(paths.responseFifo, fsConstants.O_RDWR);

  let lastActivityAtMs = Date.now();
  let lastSeenHeartbeat = null;
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
        currentAiState: 'running',
        currentAiEvent: 'ai_checkpoint',
        currentAiPhase: 'supervisor_init',
        currentAiMessage: 'Resident lane request accepted.',
        currentAiTimestamp: new Date().toISOString(),
      };
      updateStateFile(options.laneDir, state, { lanePaths, writeJson });

      const response = await runResidentLaneRequest(adapter, options, request, state, {
        ...deps,
        onProgress: (event) => {
          const nowIso = event?.timestamp || new Date().toISOString();
          lastActivityAtMs = Date.now();
          if (state.status === 'stalled') state = { ...state, status: 'busy' };
          state = {
            ...state,
            lastActivityAt: nowIso,
            currentAiState: event?.status || 'running',
            currentAiEvent: event?.event || null,
            currentAiPhase: event?.phase || null,
            currentAiMessage: event?.message || null,
            currentAiTimestamp: nowIso,
          };
          updateStateFile(options.laneDir, state, { lanePaths, writeJson });
        },
        onStderrLine: (line) => {
          appendLaneLogLine(paths.logPath, line, { appendFileSync });
        },
      });
      const resultPath = writeLaneResult(options.laneDir, response, { laneResultPath, writeJson });
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
        currentAiState: null,
        currentAiEvent: null,
        currentAiPhase: null,
        currentAiMessage: null,
        currentAiTimestamp: null,
      };
      updateStateFile(options.laneDir, state, { lanePaths, writeJson });
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
      const resultPath = writeLaneResult(options.laneDir, failure, { laneResultPath, writeJson });
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
        currentAiState: null,
        currentAiEvent: null,
        currentAiPhase: null,
        currentAiMessage: null,
        currentAiTimestamp: null,
      };
      updateStateFile(options.laneDir, state, { lanePaths, writeJson });
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
      }, deps);
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
      }, deps);
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
          if (requestBuffer.length > maxRequestBytes) {
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

      if (requestBuffer && partialRequestAtMs && (Date.now() - partialRequestAtMs) > partialRequestTimeoutMs) {
        requestBuffer = '';
        partialRequestAtMs = 0;
        writeResponse(responseFd, { ok: false, error: 'request_timeout' });
      }

      const control = readLaneControl(options.laneDir) || {};
      const evalResult = evaluateLaneHealth({
        status: state.status,
        currentRequestId: state.currentRequestId,
        lastActivityAtMs,
        lastSeenHeartbeat,
        now: Date.now(),
        control,
        idleTimeoutMs: options.idleTimeoutMs,
        healthTimeoutMs: options.healthTimeoutMs ?? defaultHealthTimeoutMs,
      });
      lastActivityAtMs = evalResult.nextActivity;
      lastSeenHeartbeat = evalResult.nextSeenHeartbeat;
      if (evalResult.action === 'expire') {
        shutdown('expired');
      } else if (evalResult.action === 'stall') {
        state = { ...state, status: 'stalled' };
        updateStateFile(options.laneDir, state, { lanePaths, writeJson });
      } else if (evalResult.action === 'clear_stall') {
        state = {
          ...state,
          status: state.currentRequestId ? 'busy' : 'ready',
          lastActivityAt: new Date().toISOString(),
        };
        updateStateFile(options.laneDir, state, { lanePaths, writeJson });
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

export function launchResidentLaneDaemonHelper(options, adapter, deps = {}) {
  const { ensureLaneLayout, lanePaths } = deps;
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
  if (options.authFd) daemonStdio.push(options.authFd);

  const daemon = spawn(process.execPath, daemonArgs, {
    cwd: options.guardrailRepo,
    detached: true,
    stdio: daemonStdio,
    env: process.env,
  });
  daemon.unref();
  process.stdout.write(`${JSON.stringify({ pid: daemon.pid })}\n`);
}
