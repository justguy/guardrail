import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  evaluateLaneHealth,
  extendResidentLane,
  readLaneControl,
  writeLaneControl,
  lanePaths,
  getResidentLaneResult,
} from '../src/resident-lane-core.js';
import { normalizeResidentLaneOptions as normalizeClaude } from '../src/claude-resident-lane.js';
import { normalizeResidentLaneOptions as normalizeCodex } from '../src/codex-resident-lane.js';

function tmpLaneDir() {
  const dir = mkdtempSync(join(tmpdir(), 'gr-lane-health-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('lane health protocol', () => {
  it('claude normalizer produces 300_000 ms default healthTimeoutMs', () => {
    const opts = normalizeClaude({ laneDir: tmpLaneDir(), sessionName: 's' });
    assert.equal(opts.healthTimeoutMs, 300_000);
    assert.equal(opts.idleTimeoutMs, 15 * 60 * 1000);
    assert.ok(opts.idleTimeoutMs > opts.healthTimeoutMs,
      'idle timeout must be longer than health timeout for long runs');
  });

  it('codex normalizer produces 300_000 ms default healthTimeoutMs', () => {
    const opts = normalizeCodex({ laneDir: tmpLaneDir(), sessionName: 's' });
    assert.equal(opts.healthTimeoutMs, 300_000);
  });

  it('surfaces stalled before hard expiry (evaluateLaneHealth)', () => {
    const base = {
      status: 'ready',
      lastActivityAtMs: 1_000,
      lastSeenHeartbeat: null,
      control: {},
      idleTimeoutMs: 10_000,
      healthTimeoutMs: 2_000,
    };

    const beforeHealth = evaluateLaneHealth({ ...base, now: 2_500 });
    assert.equal(beforeHealth.action, 'none');
    assert.equal(beforeHealth.nextStatus, 'ready');

    const afterHealth = evaluateLaneHealth({ ...base, now: 4_000 });
    assert.equal(afterHealth.action, 'stall');
    assert.equal(afterHealth.nextStatus, 'stalled');

    const afterIdle = evaluateLaneHealth({ ...base, status: 'stalled', now: 20_000 });
    assert.equal(afterIdle.action, 'expire');
  });

  it('surfaces stalled for in-flight busy requests before hard expiry', () => {
    const result = evaluateLaneHealth({
      status: 'busy',
      lastActivityAtMs: 1_000,
      lastSeenHeartbeat: null,
      control: {},
      idleTimeoutMs: 10_000,
      healthTimeoutMs: 2_000,
      now: 4_000,
    });
    assert.equal(result.action, 'stall');
    assert.equal(result.nextStatus, 'stalled');
  });

  it('live extend updates effective timeouts observed by daemon loop', () => {
    const laneDir = tmpLaneDir();
    mkdirSync(join(laneDir, 'logs'), { recursive: true });
    extendResidentLane(laneDir, { idleTimeoutMs: 60_000, healthTimeoutMs: 30_000 });
    const control = readLaneControl(laneDir);
    assert.equal(control.idleTimeoutMs, 60_000);
    assert.equal(control.healthTimeoutMs, 30_000);

    const base = {
      status: 'ready',
      lastActivityAtMs: 1_000,
      lastSeenHeartbeat: null,
      idleTimeoutMs: 5_000,
      healthTimeoutMs: 2_000,
      now: 10_000,
    };
    const withoutControl = evaluateLaneHealth({ ...base, control: {} });
    assert.equal(withoutControl.action, 'expire',
      'baseline timeouts should expire at now=10_000');

    const withControl = evaluateLaneHealth({
      ...base,
      control: { idleTimeoutMs: 60_000, healthTimeoutMs: 30_000 },
    });
    assert.equal(withControl.action, 'none',
      'extended timeouts from control file must postpone expiry');
  });

  it('heartbeat clears stalled state without faking completion', () => {
    const laneDir = tmpLaneDir();
    extendResidentLane(laneDir, { heartbeat: true });
    const control = readLaneControl(laneDir);
    assert.ok(control.heartbeatAt, 'heartbeat should set heartbeatAt');

    const result = evaluateLaneHealth({
      status: 'stalled',
      lastActivityAtMs: 1_000,
      lastSeenHeartbeat: null,
      control: { heartbeatAt: control.heartbeatAt },
      idleTimeoutMs: 10_000,
      healthTimeoutMs: 2_000,
      now: 5_000,
    });
    assert.equal(result.action, 'clear_stall');
    assert.equal(result.nextStatus, 'ready');
    assert.equal(result.nextActivity, 5_000);
    assert.equal(result.nextSeenHeartbeat, control.heartbeatAt);
  });

  it('heartbeat returns stalled in-flight requests to busy, not ready', () => {
    const laneDir = tmpLaneDir();
    extendResidentLane(laneDir, { heartbeat: true });
    const control = readLaneControl(laneDir);

    const result = evaluateLaneHealth({
      status: 'stalled',
      currentRequestId: 'req-1',
      lastActivityAtMs: 1_000,
      lastSeenHeartbeat: null,
      control: { heartbeatAt: control.heartbeatAt },
      idleTimeoutMs: 10_000,
      healthTimeoutMs: 2_000,
      now: 5_000,
    });
    assert.equal(result.action, 'clear_stall');
    assert.equal(result.nextStatus, 'busy');
  });

  it('extendResidentLane rejects invalid inputs and empty updates', () => {
    const laneDir = tmpLaneDir();
    assert.throws(() => extendResidentLane(laneDir, {}), /requires/);
    assert.throws(() => extendResidentLane(laneDir, { idleTimeoutMs: 500 }), />= 1000/);
    assert.throws(() => extendResidentLane(laneDir, { healthTimeoutMs: 'abc' }), /health_timeout_ms/);
    extendResidentLane(laneDir, { idleTimeoutMs: 10_000 });
    assert.throws(() => extendResidentLane(laneDir, { healthTimeoutMs: 10_000 }), /less than idle_timeout_ms/);
  });

  it('control file persists through writeLaneControl merge', () => {
    const laneDir = tmpLaneDir();
    writeLaneControl(laneDir, { idleTimeoutMs: 90_000 });
    writeLaneControl(laneDir, { healthTimeoutMs: 45_000 });
    const control = readLaneControl(laneDir);
    assert.equal(control.idleTimeoutMs, 90_000);
    assert.equal(control.healthTimeoutMs, 45_000);
    assert.ok(existsSync(lanePaths(laneDir).controlPath));
    const raw = JSON.parse(readFileSync(lanePaths(laneDir).controlPath, 'utf8'));
    assert.ok(raw.updatedAt);
  });

  it('treats stalled current requests as pending results', () => {
    const laneDir = tmpLaneDir();
    mkdirSync(join(laneDir, 'results'), { recursive: true });
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'stalled',
      laneDir,
      currentRequestId: 'req-stalled',
      lastRequestId: 'req-stalled',
      lastActivityAt: new Date().toISOString(),
      pollIntervalMs: 300,
      idleTimeoutMs: 900000,
      healthTimeoutMs: 300000,
    }), 'utf8');

    const result = getResidentLaneResult({ laneDir, requestId: 'req-stalled' });
    assert.equal(result.status, 'pending');
    assert.equal(result.reason, 'request_still_running');
  });
});
