import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  lanePaths,
  laneResultPath,
  parseResidentLaneArgs,
  normalizeResidentLaneOptions,
  runLaneRequest,
  getResidentLaneResult,
  getResidentLaneStatus,
  launchResidentLane,
  listResidentLanes,
  pruneResidentLanes,
  signLaneRequest,
  stopResidentLane,
  trackLaneRequestId,
  validateLaneRequest,
  waitForResidentLaneBootstrap,
} from '../src/claude-resident-lane.js';
import { sendResidentLaneMessage } from '../src/claude-resident-lane-client.js';

function tmpLaneDir() {
  return mkdtempSync(join(tmpdir(), 'gr-claude-lane-'));
}

function mkfifo(path) {
  const result = spawnSync('mkfifo', [path], { stdio: 'ignore' });
  if (result.status !== 0) {
    throw new Error(`mkfifo failed for ${path}`);
  }
}

function makeFakeLaunchHelper(daemonPid, options = {}) {
  const child = new EventEmitter();
  child.pid = options.helperPid ?? 11111;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setTimeout(() => {
    if (options.stdout !== false) {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ pid: daemonPid }) + '\n', 'utf8'));
    }
    if (options.stderrText) {
      child.stderr.emit('data', Buffer.from(options.stderrText, 'utf8'));
    }
    child.emit('exit', options.closeCode ?? 0, options.signal ?? null);
    child.emit('close', options.closeCode ?? 0);
  }, 0);
  return child;
}

describe('Claude resident lane', () => {
  it('parses lane args by flag name', () => {
    const parsed = parseResidentLaneArgs([
      '--lane-dir', '.guardrail/lanes/math',
      '--guardrail-repo', '.',
      '--working-dir', '.',
      '--session-name', 'math-live-session',
      '--session-id', 'math-live-session-1',
      '--poll-interval-ms', '250',
      '--idle-timeout-ms', '10000',
      '--daemon',
    ]);

    assert.equal(parsed.laneDir, '.guardrail/lanes/math');
    assert.equal(parsed.guardrailRepo, '.');
    assert.equal(parsed.workingDir, '.');
    assert.equal(parsed.sessionName, 'math-live-session');
    assert.equal(parsed.sessionId, 'math-live-session-1');
    assert.equal(parsed.pollIntervalMs, '250');
    assert.equal(parsed.idleTimeoutMs, '10000');
    assert.equal(parsed.daemon, true);
  });

  it('normalizes resident lane options', () => {
    const dir = tmpLaneDir();
    const options = normalizeResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      sessionName: 'math-live-session',
      sessionId: 'math-live-session-1',
      noSessionPersistence: 'false',
      addDirs: 'docs,tests',
      inputFiles: 'a.txt,b.txt',
    }, dir);

    assert.equal(options.laneDir, resolve(dir, '.guardrail/lanes/math'));
    assert.equal(options.guardrailRepo, resolve(dir));
    assert.equal(options.workingDir, resolve(dir));
    assert.equal(options.sessionName, 'math-live-session');
    assert.equal(options.sessionId, 'math-live-session-1');
    assert.equal(options.noSessionPersistence, false);
    assert.deepEqual(options.addDirs, [resolve(dir, 'docs'), resolve(dir, 'tests')]);
    assert.deepEqual(options.inputFiles, ['a.txt', 'b.txt']);
  });

  it('derives FIFO paths from the lane dir', () => {
    const paths = lanePaths('/tmp/example-lane');
    assert.equal(paths.requestFifo, '/tmp/example-lane/requests.fifo');
    assert.equal(paths.responseFifo, '/tmp/example-lane/responses.fifo');
    assert.equal(paths.statePath, '/tmp/example-lane/state.json');
    assert.equal(paths.identityPath, '/tmp/example-lane/identity.json');
  });

  it('uses lifecycle start for the first request and continue after success', async () => {
    const dir = tmpLaneDir();
    const options = normalizeResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      sessionName: 'math-live-session',
      sessionId: 'math-live-session-1',
      noSessionPersistence: 'false',
      model: 'sonnet',
      effort: 'low',
      permissionMode: 'default',
      outputFormat: 'text',
      maxBudgetUsd: '1.00',
      systemPrompt: 'Answer briefly.',
    }, dir);

    const calls = [];
    const runner = async (args) => {
      calls.push(args);
      return { code: 0, stdout: '12\n', stderr: '' };
    };

    const first = await runLaneRequest(options, { id: 'req-1', prompt: '4x3=?' }, { startedConversation: false }, { runner });
    const second = await runLaneRequest(options, { id: 'req-2', prompt: '4x4=?' }, { startedConversation: true }, { runner });

    assert.equal(first.lifecycle, 'start');
    assert.equal(second.lifecycle, 'continue');
    assert.equal(first.stdout, '12\n');
    assert.ok(calls[0].includes('--lifecycle'));
    assert.ok(calls[0].includes('start'));
    assert.ok(calls[1].includes('continue'));
    assert.ok(calls[0].includes('--session-name'));
    assert.ok(calls[0].includes('math-live-session'));
  });

  it('reuses an already-running lane instead of failing', async () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);
    writeFileSync(paths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      sessionName: 'math-live-session',
      sessionId: 'math-live-session-1',
      workingDir: dir,
      requestFifo: paths.requestFifo,
      responseFifo: paths.responseFifo,
    }), 'utf8');

    const summary = await launchResidentLane({
      laneDir,
      guardrailRepo: dir,
      workingDir: dir,
      sessionName: 'math-live-session',
      sessionId: 'math-live-session-1',
    });

    assert.equal(summary.reused, true);
    assert.equal(summary.pid, process.pid);
    assert.equal(summary.requestFifo, paths.requestFifo);
    assert.equal(summary.responseFifo, paths.responseFifo);
  });

  it('fails closed when another live lane with the same lane id already exists in the repo registry', async () => {
    const dir = tmpLaneDir();
    const existingLaneDir = join(dir, '.guardrail', 'lanes', 'math-a');
    mkdirSync(existingLaneDir, { recursive: true });
    const existingPaths = lanePaths(existingLaneDir);
    mkfifo(existingPaths.requestFifo);
    mkfifo(existingPaths.responseFifo);
    writeFileSync(existingPaths.identityPath, JSON.stringify({
      laneId: 'math-live',
      laneDir: existingLaneDir,
      guardrailRepo: dir,
      identityNonce: 'nonce-a',
      keyPath: join(dir, 'lane-a.key'),
    }), 'utf8');
    writeFileSync(existingPaths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math-live',
      sessionName: 'math-live',
      identityNonce: 'nonce-a',
      bootNonce: 'boot-a',
      requestFifo: existingPaths.requestFifo,
      responseFifo: existingPaths.responseFifo,
    }), 'utf8');

    await assert.rejects(() => launchResidentLane({
      laneDir: join(dir, '.guardrail', 'lanes', 'math-b'),
      guardrailRepo: dir,
      workingDir: dir,
      laneId: 'math-live',
      sessionName: 'math-live',
    }), /Duplicate live resident lane/);
  });

  it('lists resident lanes from the project lane registry', () => {
    const dir = tmpLaneDir();
    const readyLaneDir = join(dir, '.guardrail', 'lanes', 'math-ready');
    const staleLaneDir = join(dir, '.guardrail', 'lanes', 'math-stale');
    mkdirSync(readyLaneDir, { recursive: true });
    mkdirSync(staleLaneDir, { recursive: true });
    const readyPaths = lanePaths(readyLaneDir);
    const stalePaths = lanePaths(staleLaneDir);
    mkfifo(readyPaths.requestFifo);
    mkfifo(readyPaths.responseFifo);
    writeFileSync(readyPaths.identityPath, JSON.stringify({
      laneId: 'math-ready',
      laneDir: readyLaneDir,
      guardrailRepo: dir,
      keyPath: join(dir, 'ready.key'),
      identityNonce: 'nonce-ready',
    }), 'utf8');
    writeFileSync(stalePaths.identityPath, JSON.stringify({
      laneId: 'math-stale',
      laneDir: staleLaneDir,
      guardrailRepo: dir,
      identityNonce: 'nonce-stale',
    }), 'utf8');
    writeFileSync(readyPaths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math-ready',
      sessionName: 'math-ready',
      keyPath: join(dir, 'ready.key'),
      identityNonce: 'nonce-ready',
      bootNonce: 'boot-ready',
      requestFifo: readyPaths.requestFifo,
      responseFifo: readyPaths.responseFifo,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const listing = listResidentLanes({ guardrailRepo: dir });
    assert.equal(listing.lanes.length, 2);
    assert.equal(listing.counts.ready, 1);
    assert.equal(listing.counts.stale, 1);
    assert.equal(listing.lanes.find((lane) => lane.laneId === 'math-ready')?.identityNonce, 'nonce-ready');
  });

  it('prunes stale and stopped lanes while leaving failed lanes unless explicitly included', () => {
    const dir = tmpLaneDir();
    const staleLaneDir = join(dir, '.guardrail', 'lanes', 'math-stale');
    const failedLaneDir = join(dir, '.guardrail', 'lanes', 'math-failed');
    mkdirSync(staleLaneDir, { recursive: true });
    mkdirSync(failedLaneDir, { recursive: true });
    const stalePaths = lanePaths(staleLaneDir);
    const failedPaths = lanePaths(failedLaneDir);
    writeFileSync(stalePaths.identityPath, JSON.stringify({
      laneId: 'math-stale',
      laneDir: staleLaneDir,
      guardrailRepo: dir,
      keyPath: join(dir, 'stale.key'),
      identityNonce: 'nonce-stale',
    }), 'utf8');
    writeFileSync(failedPaths.identityPath, JSON.stringify({
      laneId: 'math-failed',
      laneDir: failedLaneDir,
      guardrailRepo: dir,
      keyPath: join(dir, 'failed.key'),
      identityNonce: 'nonce-failed',
    }), 'utf8');
    writeFileSync(stalePaths.statePath, JSON.stringify({
      pid: 12345,
      status: 'stale',
      laneId: 'math-stale',
      sessionName: 'math-stale',
    }), 'utf8');
    writeFileSync(failedPaths.statePath, JSON.stringify({
      pid: 12345,
      status: 'failed',
      laneId: 'math-failed',
      sessionName: 'math-failed',
      failureReason: 'boom',
      failureStage: 'runtime',
    }), 'utf8');
    writeFileSync(join(dir, 'stale.key'), 'secret\n', 'utf8');
    writeFileSync(join(dir, 'failed.key'), 'secret\n', 'utf8');

    const result = pruneResidentLanes({ guardrailRepo: dir });
    assert.equal(result.pruned.length, 1);
    assert.equal(result.pruned[0].laneId, 'math-stale');
    assert.equal(existsSync(staleLaneDir), false);
    assert.equal(existsSync(failedLaneDir), true);
  });

  it('treats EPERM pid probes as alive when checking resident lane status', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);
    const keyPath = join(dir, 'lane.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(paths.statePath, JSON.stringify({
      pid: 424242,
      status: 'ready',
      sessionName: 'math-live-session',
      sessionId: 'math-live-session-1',
      workingDir: dir,
      requestFifo: paths.requestFifo,
      responseFifo: paths.responseFifo,
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }), 'utf8');

    const originalKill = process.kill;
    process.kill = ((pid, signal) => {
      if (pid === 424242 && signal === 0) {
        const err = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return originalKill(pid, signal);
    });

    try {
      const status = getResidentLaneStatus({ laneDir, keyPath, guardrailRepo: dir });
      assert.equal(status.status, 'ready');
      assert.equal(status.alive, true);
      assert.equal(status.failureReason, null);
    } finally {
      process.kill = originalKill;
    }
  });

  it('fails lane startup when the daemon exits during bootstrap and records a failed state', async () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    const fakeChild = makeFakeLaunchHelper(424242);

    await assert.rejects(
      launchResidentLane({
        laneDir,
        guardrailRepo: dir,
        workingDir: dir,
        sessionName: 'math-live-session',
      }, {
        spawnProcess: () => fakeChild,
        waitForBootstrap: waitForResidentLaneBootstrap,
        waitForBootstrapDeps: {
          timeoutMs: 250,
          isAlive: () => false,
          readLogTail: () => 'bootstrap crashed',
        },
      }),
      (err) => err?.code === 'LANE_BOOT_FAILED',
    );

    const status = getResidentLaneStatus({ laneDir, guardrailRepo: dir });
    assert.equal(status.status, 'failed');
    assert.equal(status.failureStage, 'bootstrap');
    assert.match(status.failureReason, /bootstrap/);
  });

  it('fails lane startup when the daemon dies in the immediate post-start window', async () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    const fakeChild = makeFakeLaunchHelper(434343);
    let alive = true;
    setTimeout(() => {
      alive = false;
    }, 500);

    await assert.rejects(
      launchResidentLane({
        laneDir,
        guardrailRepo: dir,
        workingDir: dir,
        sessionName: 'math-live-session',
      }, {
        spawnProcess: () => fakeChild,
        waitForBootstrap: waitForResidentLaneBootstrap,
        waitForBootstrapDeps: {
          timeoutMs: 2000,
          postStartGraceMs: 800,
          isAlive: () => alive,
          readState: () => ({
            pid: 434343,
            status: 'ready',
            sessionName: 'math-live-session',
            lastActivityAt: new Date().toISOString(),
          }),
          readLogTail: () => 'post-start crashed',
        },
      }),
      /post-start crashed/,
    );

    const status = getResidentLaneStatus({ laneDir, guardrailRepo: dir });
    assert.equal(status.status, 'failed');
    assert.equal(status.failureStage, 'post_start');
  });

  it('keeps a launched resident lane alive across SIGHUP', async () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    const keyPath = join(dir, 'lane.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    const keyFd = openSync(keyPath, 'r');

    const summary = await launchResidentLane({
      laneDir,
      guardrailRepo: dir,
      workingDir: dir,
      keyPath,
      authFd: keyFd,
      sessionName: 'math-live-session',
    });

    try {
      process.kill(summary.pid, 'SIGHUP');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      const status = getResidentLaneStatus({ laneDir, guardrailRepo: dir, keyPath });
      assert.equal(status.status, 'ready');
      assert.equal(status.alive, true);
    } finally {
      closeSync(keyFd);
      stopResidentLane({ laneDir, guardrailRepo: dir, keyPath, sessionName: 'math-live-session' });
    }
  });

  it('sends a prompt over the resident lane FIFOs', async () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);

    const requestFd = openSync(paths.requestFifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
    const responseFd = openSync(paths.responseFifo, fsConstants.O_RDWR);
    const serverDone = (async () => {
      const chunk = Buffer.alloc(4096);
      let buffer = '';
      const startedAt = Date.now();
      for (;;) {
        if ((Date.now() - startedAt) > 5000) {
          throw new Error('Timed out waiting for FIFO request');
        }
        try {
          const bytesRead = readSync(requestFd, chunk, 0, chunk.length, null);
          if (bytesRead > 0) {
            buffer += chunk.toString('utf8', 0, bytesRead);
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex >= 0) {
              const line = buffer.slice(0, newlineIndex);
              const request = JSON.parse(line);
              writeSync(responseFd, `${JSON.stringify({ requestId: request.id, ok: true, stdout: '20\n' })}\n`, undefined, 'utf8');
              return;
            }
          }
        } catch (err) {
          if (err?.code !== 'EAGAIN') throw err;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    })();

    try {
      const responsePromise = sendResidentLaneMessage([
        '--lane-dir', laneDir,
        '--request-id', 'req-1',
        '--prompt', '4x5=?',
      ]);
      const [response] = await Promise.all([responsePromise, serverDone]);
      assert.equal(response.ok, true);
      assert.equal(response.stdout, '20\n');
    } finally {
      closeSync(requestFd);
      closeSync(responseFd);
    }
  });

  it('signs and validates requests with an inherited auth fd secret', async () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);

    const secretPath = join(dir, 'lane.secret');
    writeFileSync(secretPath, 'resident-secret\n', 'utf8');
    const secretFd = openSync(secretPath, fsConstants.O_RDONLY);

    const requestFd = openSync(paths.requestFifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
    const responseFd = openSync(paths.responseFifo, fsConstants.O_RDWR);
    const serverDone = (async () => {
      const chunk = Buffer.alloc(4096);
      let buffer = '';
      const startedAt = Date.now();
      for (;;) {
        if ((Date.now() - startedAt) > 5000) {
          throw new Error('Timed out waiting for FIFO request');
        }
        try {
          const bytesRead = readSync(requestFd, chunk, 0, chunk.length, null);
          if (bytesRead > 0) {
            buffer += chunk.toString('utf8', 0, bytesRead);
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex >= 0) {
              const request = JSON.parse(buffer.slice(0, newlineIndex));
              assert.equal(
                request.signature,
                signLaneRequest({ id: request.id, prompt: request.prompt }, 'resident-secret'),
              );
              assert.doesNotThrow(() => validateLaneRequest(request, 'resident-secret'));
              writeSync(responseFd, `${JSON.stringify({ requestId: request.id, ok: true, stdout: '25\n' })}\n`, undefined, 'utf8');
              return;
            }
          }
        } catch (err) {
          if (err?.code !== 'EAGAIN') throw err;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    })();

    try {
      const responsePromise = sendResidentLaneMessage([
        '--lane-dir', laneDir,
        '--request-id', 'req-signed',
        '--prompt', '5x5=?',
        '--auth-fd', String(secretFd),
      ]);
      const [response] = await Promise.all([responsePromise, serverDone]);
      assert.equal(response.ok, true);
      assert.equal(response.stdout, '25\n');
    } finally {
      closeSync(secretFd);
      closeSync(requestFd);
      closeSync(responseFd);
    }
  });

  it('returns a distinct timeout error when the lane does not answer in time', async () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);

    const requestFd = openSync(paths.requestFifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
    const responseFd = openSync(paths.responseFifo, fsConstants.O_RDWR);

    try {
      await assert.rejects(
        sendResidentLaneMessage([
          '--lane-dir', laneDir,
          '--request-id', 'req-timeout',
          '--prompt', '4x5=?',
          '--timeout-ms', '10',
        ]),
        (err) => err?.code === 'LANE_TIMEOUT' && err?.requestId === 'req-timeout',
      );
    } finally {
      closeSync(requestFd);
      closeSync(responseFd);
    }
  });

  it('rejects duplicate request ids within the same active lane window', () => {
    const seen = new Map();

    assert.doesNotThrow(() => trackLaneRequestId(seen, 'req-1', 1_000, 60_000));
    assert.throws(
      () => trackLaneRequestId(seen, 'req-1', 2_000, 60_000),
      /duplicate_request_id/,
    );

    assert.doesNotThrow(() => trackLaneRequestId(seen, 'req-1', 70_500, 60_000));
  });

  it('stopResidentLane removes FIFO endpoints and key path', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);
    const keyPath = join(dir, 'math.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');

    const result = stopResidentLane({
      laneDir,
      keyPath,
      guardrailRepo: dir,
      laneId: 'math',
    });

    assert.equal(result.stopped, true);
    assert.equal(existsSync(paths.requestFifo), false);
    assert.equal(existsSync(paths.responseFifo), false);
    assert.equal(existsSync(keyPath), false);
  });

  it('reports alive resident lane status with a send recommendation', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);
    const keyPath = join(dir, 'math.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(paths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math',
      sessionName: 'math-live-session',
      sessionId: 'math-live-session-1',
      lastRequestId: 'req-1',
      lastActivityAt: new Date().toISOString(),
      idleTimeoutMs: 900000,
      pollIntervalMs: 300,
      keyPath,
    }), 'utf8');

    const status = getResidentLaneStatus({ laneDir, keyPath, guardrailRepo: dir, laneId: 'math' });
    assert.equal(status.status, 'ready');
    assert.equal(status.alive, true);
    assert.equal(status.keyPresent, true);
    assert.equal(status.requestFifoPresent, true);
    assert.equal(status.responseFifoPresent, true);
    assert.equal(status.recommendedAction, 'send');
  });

  it('reports busy resident lane status with current request visibility', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);
    const keyPath = join(dir, 'math.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(paths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'busy',
      laneId: 'math',
      sessionName: 'math-live-session',
      currentRequestId: 'req-2',
      currentRequestStartedAt: '2026-04-10T00:00:00.000Z',
      lastRequestId: 'req-2',
      lastActivityAt: new Date().toISOString(),
      keyPath,
    }), 'utf8');

    const status = getResidentLaneStatus({ laneDir, keyPath, guardrailRepo: dir, laneId: 'math' });
    assert.equal(status.status, 'busy');
    assert.equal(status.alive, true);
    assert.equal(status.currentRequestId, 'req-2');
    assert.equal(status.currentRequestStartedAt, '2026-04-10T00:00:00.000Z');
    assert.equal(status.recommendedAction, 'result');
  });

  it('returns completed resident lane results from stored result artifacts', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const resultPath = laneResultPath(laneDir, 'req-3');
    mkdirSync(lanePaths(laneDir).resultsDir, { recursive: true });
    writeFileSync(resultPath, JSON.stringify({
      requestId: 'req-3',
      ok: true,
      exitCode: 0,
      stdout: '12\n',
    }), 'utf8');
    writeFileSync(lanePaths(laneDir).statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math',
      sessionName: 'math-live-session',
      lastRequestId: 'req-3',
      lastCompletedRequestId: 'req-3',
      lastResultPath: resultPath,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const result = getResidentLaneResult({ laneDir, guardrailRepo: dir, laneId: 'math', requestId: 'req-3' });
    assert.equal(result.status, 'completed');
    assert.equal(result.result.stdout, '12\n');
    assert.equal(result.resultPath, resultPath);
  });

  it('returns pending resident lane results while a request is still running', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(lanePaths(laneDir).statePath, JSON.stringify({
      pid: process.pid,
      status: 'busy',
      laneId: 'math',
      sessionName: 'math-live-session',
      lastRequestId: 'req-4',
      currentRequestId: 'req-4',
      currentRequestStartedAt: '2026-04-10T00:00:00.000Z',
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const result = getResidentLaneResult({ laneDir, guardrailRepo: dir, laneId: 'math', requestId: 'req-4' });
    assert.equal(result.status, 'pending');
    assert.equal(result.reason, 'request_still_running');
    assert.equal(result.requestId, 'req-4');
  });

  it('reports expired resident lane status when the key is gone', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    writeFileSync(paths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'expired',
      laneId: 'math',
      sessionName: 'math-live-session',
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const status = getResidentLaneStatus({
      laneDir,
      keyPath: join(dir, 'missing.key'),
      guardrailRepo: dir,
      laneId: 'math',
    });
    assert.equal(status.status, 'expired');
    assert.equal(status.alive, false);
    assert.equal(status.keyPresent, false);
    assert.equal(status.recommendedAction, 'start');
  });

  it('reports failed resident lane status with a failure reason', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(lanePaths(laneDir).statePath, JSON.stringify({
      pid: 12345,
      status: 'failed',
      laneId: 'math',
      sessionName: 'math-live-session',
      failureReason: 'bootstrap crashed',
      failureStage: 'bootstrap',
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const status = getResidentLaneStatus({ laneDir, guardrailRepo: dir, laneId: 'math' });
    assert.equal(status.status, 'failed');
    assert.equal(status.failureReason, 'bootstrap crashed');
    assert.equal(status.failureStage, 'bootstrap');
  });

  it('infers a post-start failure from stale startup state with no recorded failure metadata', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(lanePaths(laneDir).statePath, JSON.stringify({
      pid: 12345,
      status: 'ready',
      laneId: 'math',
      sessionName: 'math-live-session',
      startedConversation: false,
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }), 'utf8');

    const status = getResidentLaneStatus({ laneDir, guardrailRepo: dir, laneId: 'math' });
    assert.equal(status.status, 'failed');
    assert.equal(status.failureStage, 'post_start');
    assert.match(status.failureReason, /first request/i);
  });
});
