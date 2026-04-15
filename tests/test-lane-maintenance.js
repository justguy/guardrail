import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  cleanupResidentLane,
  killResidentLane,
  revokeResidentLane,
} from '../src/lane/maintenance.js';

function tmpLaneRoot() {
  return mkdtempSync(join(tmpdir(), 'gr-lane-maintenance-'));
}

function simpleLanePaths(laneDir) {
  return {
    statePath: join(laneDir, 'state.json'),
    requestFifo: join(laneDir, 'requests.fifo'),
    responseFifo: join(laneDir, 'responses.fifo'),
    controlPath: join(laneDir, 'control.json'),
  };
}

describe('lane/maintenance', () => {
  it('cleanupResidentLane returns missing when no lane matches', () => {
    const result = cleanupResidentLane({ guardrailRepo: '/tmp/repo' }, {
      listResidentLanes() {
        return { registryDir: '/tmp/repo/.guardrail/lanes', lanes: [] };
      },
    });

    assert.equal(result.status, 'missing');
    assert.equal(result.cleaned, false);
  });

  it('cleanupResidentLane returns ambiguous when multiple lanes match', () => {
    const result = cleanupResidentLane({ guardrailRepo: '/tmp/repo' }, {
      listResidentLanes() {
        return {
          registryDir: '/tmp/repo/.guardrail/lanes',
          lanes: [
            { laneDir: '/tmp/repo/.guardrail/lanes/a', laneId: 'a', status: 'ready', tool: 'claude' },
            { laneDir: '/tmp/repo/.guardrail/lanes/b', laneId: 'b', status: 'ready', tool: 'codex' },
          ],
        };
      },
    });

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.matches.length, 2);
  });

  it('cleanupResidentLane stops a live lane and then cleans it', () => {
    const laneRoot = tmpLaneRoot();
    const laneDir = join(laneRoot, '.guardrail', 'lanes', 'math');
    mkdirSync(join(laneDir, 'logs'), { recursive: true });
    const cleaned = [];
    const stopCalls = [];

    const result = cleanupResidentLane({ guardrailRepo: laneRoot, laneDir }, {
      cleanupLaneArtifacts(options, status) {
        stopCalls.push({ options, status });
      },
      isPidAlive() {
        return true;
      },
      laneDirFingerprint() {
        return 'fingerprint';
      },
      lanePaths: simpleLanePaths,
      listResidentLanes() {
        return {
          registryDir: join(laneRoot, '.guardrail', 'lanes'),
          lanes: [{
            laneDir,
            laneId: 'math',
            alive: true,
            status: 'ready',
            adapterId: 'claude',
            tool: 'claude',
            keyPath: join(laneRoot, 'lane.key'),
            sessionName: 'math-live',
            sessionId: 'sess-1',
          }],
        };
      },
      readJson() {
        return {
          pid: 1234,
          adapterId: 'claude',
          scopeType: 'none',
          scopeMode: 'warn',
          scopePaths: [],
          resourceMode: 'warn',
          resources: [],
        };
      },
      readLaneClaim() {
        return null;
      },
      removeHostLaneRegistryEntry() {},
      removeIfExists() {},
      removeLaneClaim() {},
      writeJson(_path, data) {
        cleaned.push(data);
      },
    });

    assert.equal(result.status, 'cleaned');
    assert.equal(result.cleaned, true);
    assert.equal(result.stoppedLiveLane, true);
    assert.equal(stopCalls.length, 1);
    assert.equal(cleaned.at(-1).action, 'cleanup');
  });

  it('revokeResidentLane sends SIGTERM for a live pid and writes a sentinel', () => {
    const laneRoot = tmpLaneRoot();
    const laneDir = join(laneRoot, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const originalKill = process.kill;
    const kills = [];

    process.kill = ((pid, signal) => {
      kills.push({ pid, signal });
      return true;
    });

    try {
      const result = revokeResidentLane({ guardrailRepo: laneRoot, laneDir, actor: 'ops', reason: 'test' }, {
        cleanupLaneArtifacts() {},
        isPidAlive() {
          return true;
        },
        lanePaths: simpleLanePaths,
        readJson() {
          return { pid: 4321, adapterId: 'claude' };
        },
      });

      assert.equal(result.revoked, true);
      assert.deepEqual(kills, [{ pid: 4321, signal: 'SIGTERM' }]);
      assert.equal(readFileSync(join(laneDir, 'REVOKED'), 'utf8').includes('revokedAt'), true);
    } finally {
      process.kill = originalKill;
    }
  });

  it('killResidentLane sends SIGKILL for a live pid and writes a sentinel', () => {
    const laneRoot = tmpLaneRoot();
    const laneDir = join(laneRoot, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const originalKill = process.kill;
    const kills = [];

    process.kill = ((pid, signal) => {
      kills.push({ pid, signal });
      return true;
    });

    try {
      const result = killResidentLane({ guardrailRepo: laneRoot, laneDir, actor: 'admin', reason: 'emergency' }, {
        cleanupLaneArtifacts() {},
        isPidAlive() {
          return true;
        },
        lanePaths: simpleLanePaths,
        readJson() {
          return { pid: 9876, adapterId: 'claude' };
        },
      });

      assert.equal(result.killed, true);
      assert.equal(result.revoked, true);
      assert.deepEqual(kills, [{ pid: 9876, signal: 'SIGKILL' }]);
      assert.equal(readFileSync(join(laneDir, 'REVOKED'), 'utf8').includes('revokedAt'), true);
    } finally {
      process.kill = originalKill;
    }
  });
});
