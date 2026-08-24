import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  cleanupLaneArtifacts,
  createLaneBootError,
  launchResidentLaneDaemonHelper,
  persistLaneFailureState,
  runResidentLaneDaemon,
  waitForResidentLaneBootstrap,
} from '../src/lane/runtime.js';

function tmpLaneRoot() {
  return mkdtempSync(join(tmpdir(), 'gr-lane-runtime-'));
}

function simpleLanePaths(laneDir) {
  return {
    statePath: join(laneDir, 'state.json'),
    logPath: join(laneDir, 'logs', 'lane.log'),
    requestFifo: join(laneDir, 'requests.fifo'),
    responseFifo: join(laneDir, 'responses.fifo'),
    controlPath: join(laneDir, 'control.json'),
  };
}

describe('lane/runtime', () => {
  it('createLaneBootError tags the lane boot failure code and details', () => {
    const err = createLaneBootError('boom', { stage: 'bootstrap' });
    assert.equal(err.code, 'LANE_BOOT_FAILED');
    assert.equal(err.message, 'boom');
    assert.deepEqual(err.details, { stage: 'bootstrap' });
  });

  it('persistLaneFailureState writes a failed state and clears the lane claim', () => {
    const laneDir = join(tmpLaneRoot(), 'lane');
    const removedClaims = [];
    const writes = [];

    persistLaneFailureState({
      laneDir,
      laneId: 'math',
      keyPath: '/tmp/lane.key',
      bootNonce: 'boot-1',
    }, new Error('bootstrap crashed'), 'bootstrap', {
      buildState(options, pid, _startedConversation, extra) {
        return { ...options, pid, ...extra };
      },
      lanePaths: simpleLanePaths,
      removeLaneClaim(...args) {
        removedClaims.push(args);
      },
      writeJson(path, data) {
        writes.push({ path, data });
      },
    });

    assert.equal(removedClaims.length, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].data.status, 'failed');
    assert.equal(writes[0].data.failureReason, 'bootstrap crashed');
    assert.equal(writes[0].data.failureStage, 'bootstrap');
  });

  it('waitForResidentLaneBootstrap returns once the daemon is stably ready', async () => {
    const child = new EventEmitter();
    child.pid = 4242;
    let tick = 0;
    let now = 0;
    const states = [
      { pid: 4242, status: 'bootstrapping' },
      { pid: 4242, status: 'ready' },
      { pid: 4242, status: 'ready' },
      { pid: 4242, status: 'ready' },
    ];

    const result = await waitForResidentLaneBootstrap({ laneDir: '/tmp/lane' }, child, {
      lanePaths: () => ({ statePath: '/tmp/lane/state.json', logPath: '/tmp/lane/logs/lane.log' }),
      readJson: () => null,
      readLogTail: () => '',
      isPidAlive: () => true,
      startupPollIntervalMs: 1,
      startupSettleMs: 1,
      startupTimeoutMs: 20,
      postStartGraceMs: 1,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      readState: () => states[Math.min(tick++, states.length - 1)],
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.pid, 4242);
  });

  it('waitForResidentLaneBootstrap reports daemon exit failures with the log tail', async () => {
    const child = new EventEmitter();
    child.pid = 5252;

    setImmediate(() => {
      child.emit('exit', 1, null);
    });

    await assert.rejects(
      waitForResidentLaneBootstrap({ laneDir: '/tmp/lane' }, child, {
        lanePaths: () => ({ statePath: '/tmp/lane/state.json', logPath: '/tmp/lane/logs/lane.log' }),
        readJson: () => null,
        readLogTail: () => 'bootstrap crashed',
        isPidAlive: () => false,
        startupPollIntervalMs: 1,
        startupSettleMs: 1,
        startupTimeoutMs: 20,
        postStartGraceMs: 1,
      }),
      /bootstrap crashed/,
    );
  });

  it('cleanupLaneArtifacts writes the final state and removes transient artifacts', () => {
    const laneDir = tmpLaneRoot();
    const removed = [];
    let written = null;

    cleanupLaneArtifacts({
      laneDir,
      laneId: 'math',
      keyPath: join(laneDir, 'lane.key'),
      bootNonce: 'boot-2',
    }, 'stopped', {
      lastRequestId: 'req-1',
      createdAt: '2026-04-15T00:00:00.000Z',
    }, {
      buildState(options, pid, _startedConversation, extra) {
        return { ...options, pid, ...extra };
      },
      lanePaths: simpleLanePaths,
      removeHostLaneRegistryEntry() {},
      removeLaneClaim() {},
      removeIfExists(path) {
        removed.push(path);
      },
      writeJson(_path, data) {
        written = data;
      },
    });

    assert.equal(written.status, 'stopped');
    assert.equal(written.lastRequestId, 'req-1');
    assert.ok(removed.includes(join(laneDir, 'lane.key')));
    assert.ok(removed.includes(join(laneDir, 'requests.fifo')));
    assert.ok(removed.includes(join(laneDir, 'responses.fifo')));
    assert.ok(removed.includes(join(laneDir, 'control.json')));
  });

  it('runResidentLaneDaemon fails closed when the lane has already been revoked', async () => {
    const laneDir = tmpLaneRoot();
    mkdirSync(join(laneDir, 'logs'), { recursive: true });
    writeFileSync(join(laneDir, 'REVOKED'), 'revoked\n', 'utf8');

    await assert.rejects(
      runResidentLaneDaemon({ laneDir, pollIntervalMs: 1 }, null, {
        appendFileSync() {},
        buildState: () => ({}),
        cleanupLaneArtifacts() {},
        defaultHealthTimeoutMs: 300000,
        ensureLaneLayout() {},
        lanePaths: simpleLanePaths,
        laneResultPath: () => join(laneDir, 'result.json'),
        maxRequestBytes: 1000,
        partialRequestTimeoutMs: 1000,
        readLaneControl: () => ({}),
        readSecretFromFd: () => '',
        runResidentLaneRequest: async () => ({}),
        trackLaneRequestId() {},
        validateLaneRequest: () => ({}),
        writeJson() {},
      }),
      /revoked/,
    );
  });

  it('runResidentLaneDaemon persists an auth preflight failure before the first packet', async () => {
    const laneDir = tmpLaneRoot();
    const states = [];

    await assert.rejects(
      runResidentLaneDaemon({ laneDir, pollIntervalMs: 1 }, {
        async preflightDaemon() {
          return {
            ok: false,
            reason: 'login_required',
            message: 'Resident lane auth failed',
            checkedAt: '2026-04-15T00:00:00.000Z',
          };
        },
      }, {
        appendFileSync() {},
        buildState: (_options, pid, _startedConversation, extra) => ({ pid, ...extra }),
        cleanupLaneArtifacts() {},
        defaultHealthTimeoutMs: 300000,
        ensureLaneLayout() {},
        lanePaths: simpleLanePaths,
        laneResultPath: () => join(laneDir, 'result.json'),
        maxRequestBytes: 1000,
        partialRequestTimeoutMs: 1000,
        readLaneControl: () => ({}),
        readSecretFromFd: () => '',
        runResidentLaneRequest: async () => ({}),
        trackLaneRequestId() {},
        validateLaneRequest: () => ({}),
        writeJson(_path, data) {
          states.push(data);
        },
      }),
      /Resident lane auth failed/,
    );

    assert.equal(states.at(-1).status, 'failed');
    assert.equal(states.at(-1).failureStage, 'auth_preflight');
  });

  it('launchResidentLaneDaemonHelper starts a detached helper and prints the daemon pid', async () => {
    const laneDir = tmpLaneRoot();
    const writes = [];
    const originalWrite = process.stdout.write;

    process.stdout.write = ((chunk, ...args) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      launchResidentLaneDaemonHelper({
        laneDir,
        guardrailRepo: laneDir,
        authFd: null,
      }, {
        buildDaemonArgs() {
          return ['-e', 'setTimeout(() => {}, 5000)'];
        },
      }, {
        ensureLaneLayout(targetLaneDir) {
          mkdirSync(join(targetLaneDir, 'logs'), { recursive: true });
        },
        lanePaths: simpleLanePaths,
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const payload = JSON.parse(writes.at(-1));
    assert.ok(Number.isInteger(payload.pid));
    assert.ok(payload.pid > 0);
    try {
      process.kill(payload.pid, 'SIGTERM');
    } catch {}
  });
});
