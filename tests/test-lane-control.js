import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readLogTail,
  readLaneControl,
  writeLaneControl,
  getResidentLaneLogs,
  extendResidentLane,
} from '../src/lane/control.js';

describe('lane/control', () => {
  it('readLogTail returns the requested tail lines and fails closed on missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-control-'));
    try {
      const logPath = join(dir, 'lane.log');
      writeFileSync(logPath, 'one\ntwo\nthree\nfour\n', 'utf8');
      assert.equal(readLogTail(logPath, 2), 'three\nfour');
      assert.equal(readLogTail(join(dir, 'missing.log'), 2), '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readLaneControl delegates through lanePaths + readJson', () => {
    const calls = [];
    const result = readLaneControl('/tmp/lane-a', laneDir => ({ controlPath: `${laneDir}/control.json` }), (path, fallback) => {
      calls.push({ path, fallback });
      return { idleTimeoutMs: 1234 };
    });

    assert.deepEqual(result, { idleTimeoutMs: 1234 });
    assert.deepEqual(calls, [{ path: '/tmp/lane-a/control.json', fallback: null }]);
  });

  it('writeLaneControl merges an existing control payload and stamps updatedAt', () => {
    const writes = [];
    const result = writeLaneControl(
      '/tmp/lane-b',
      { healthTimeoutMs: 5000 },
      laneDir => ({ controlPath: `${laneDir}/control.json` }),
      () => ({ idleTimeoutMs: 9000, note: 'keep' }),
      (path, value) => writes.push({ path, value }),
    );

    assert.equal(result.idleTimeoutMs, 9000);
    assert.equal(result.healthTimeoutMs, 5000);
    assert.equal(result.note, 'keep');
    assert.match(result.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, '/tmp/lane-b/control.json');
    assert.deepEqual(writes[0].value, result);
  });

  it('getResidentLaneLogs returns normalized metadata and log presence', () => {
    const result = getResidentLaneLogs(
      { tail: '5' },
      {
        getResidentLaneStatus: () => ({
          laneDir: '/tmp/lane-c',
          laneId: 'lane-c',
          status: 'busy',
          adapterId: 'claude-resident',
          logPath: '/tmp/lane-c/lane.log',
        }),
        parseInteger: (value, fallback) => Number.parseInt(value, 10) || fallback,
      },
    );

    assert.equal(result.laneId, 'lane-c');
    assert.equal(result.status, 'busy');
    assert.equal(result.tool, 'claude-resident');
    assert.equal(result.tailLines, 5);
    assert.equal(result.text, '');
    assert.equal(result.hasLog, false);
  });

  it('extendResidentLane validates timeout relationships and heartbeat-only updates', () => {
    const writes = [];

    const heartbeatOnly = extendResidentLane(
      '/tmp/lane-d',
      { heartbeat: true },
      {
        readLaneControl: () => ({ idleTimeoutMs: 900000, healthTimeoutMs: 300000 }),
        writeLaneControl: (_laneDir, patch) => {
          writes.push(patch);
          return patch;
        },
      },
    );
    assert.match(heartbeatOnly.heartbeatAt, /^\d{4}-\d{2}-\d{2}T/);

    const updated = extendResidentLane(
      '/tmp/lane-d',
      { idleTimeoutMs: '1200000', healthTimeoutMs: '600000' },
      {
        readLaneControl: () => ({ idleTimeoutMs: 900000, healthTimeoutMs: 300000 }),
        writeLaneControl: (_laneDir, patch) => patch,
      },
    );
    assert.equal(updated.idleTimeoutMs, 1200000);
    assert.equal(updated.healthTimeoutMs, 600000);

    assert.throws(
      () => extendResidentLane('/tmp/lane-d', {}, {
        readLaneControl: () => ({}),
        writeLaneControl: () => ({}),
      }),
      /requires idleTimeoutMs, healthTimeoutMs, or heartbeat/,
    );

    assert.throws(
      () => extendResidentLane('/tmp/lane-d', { healthTimeoutMs: 2000, idleTimeoutMs: 2000 }, {
        readLaneControl: () => ({}),
        writeLaneControl: () => ({}),
      }),
      /health_timeout_ms must be less than idle_timeout_ms/,
    );

    assert.throws(
      () => extendResidentLane('/tmp/lane-d', { idleTimeoutMs: 999 }, {
        readLaneControl: () => ({}),
        writeLaneControl: () => ({}),
      }),
      /idle_timeout_ms must be >= 1000/,
    );
  });
});
