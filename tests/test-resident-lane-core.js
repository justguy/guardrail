import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getResidentLaneStatus,
  lanePaths,
  listResidentLanes,
  runResidentLaneRequest,
} from '../src/resident-lane-core.js';

function tmpLaneDir() {
  return mkdtempSync(join(tmpdir(), 'gr-lane-core-'));
}

describe('Resident lane core', () => {
  it('runs a non-Claude adapter through the generic request contract', async () => {
    const adapter = {
      adapterId: 'echo',
      async runRequest(options, request, state) {
        return {
          requestId: request.id,
          prompt: request.prompt,
          lifecycle: state.startedConversation ? 'continue' : 'start',
          ok: true,
          exitCode: 0,
          stdout: `${options.prefix}:${request.prompt.toUpperCase()}\n`,
          stderr: '',
          startedAt: '2026-04-10T00:00:00.000Z',
          completedAt: '2026-04-10T00:00:01.000Z',
        };
      },
    };

    const result = await runResidentLaneRequest(
      adapter,
      { adapterId: 'echo', prefix: 'ECHO' },
      { id: 'req-1', prompt: 'hello' },
      { startedConversation: false },
    );

    assert.equal(result.ok, true);
    assert.equal(result.lifecycle, 'start');
    assert.equal(result.stdout, 'ECHO:HELLO\n');
  });

  it('surfaces adapter identity through status and lane listing', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'echo-live');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);

    writeFileSync(paths.identityPath, JSON.stringify({
      adapterId: 'echo',
      laneId: 'echo-live',
      laneDir,
      guardrailRepo: dir,
      identityNonce: 'nonce-echo',
    }), 'utf8');
    writeFileSync(paths.statePath, JSON.stringify({
      adapterId: 'echo',
      pid: 12345,
      status: 'failed',
      laneId: 'echo-live',
      sessionName: 'echo-live',
      failureReason: 'boom',
      failureStage: 'runtime',
    }), 'utf8');

    const status = getResidentLaneStatus({ guardrailRepo: dir, laneDir });
    const listing = listResidentLanes({ guardrailRepo: dir });

    assert.equal(status.adapterId, 'echo');
    assert.equal(listing.lanes.length, 1);
    assert.equal(listing.lanes[0].adapterId, 'echo');
  });

  it('surfaces overlapping scope conflicts in lane status and list output', () => {
    const dir = tmpLaneDir();
    const lanesDir = join(dir, '.guardrail', 'lanes');
    const laneADir = join(lanesDir, 'lane-a');
    const laneBDir = join(lanesDir, 'lane-b');
    mkdirSync(laneADir, { recursive: true });
    mkdirSync(laneBDir, { recursive: true });
    const pathsA = lanePaths(laneADir);
    const pathsB = lanePaths(laneBDir);

    writeFileSync(pathsA.identityPath, JSON.stringify({
      adapterId: 'claude',
      laneId: 'lane-a',
      laneDir: laneADir,
      guardrailRepo: dir,
      identityNonce: 'nonce-a',
      scopeType: 'paths',
      scopeMode: 'warn',
      scopePaths: ['src'],
    }), 'utf8');
    writeFileSync(pathsB.identityPath, JSON.stringify({
      adapterId: 'codex',
      laneId: 'lane-b',
      laneDir: laneBDir,
      guardrailRepo: dir,
      identityNonce: 'nonce-b',
      scopeType: 'paths',
      scopeMode: 'block',
      scopePaths: ['src/utils'],
    }), 'utf8');
    writeFileSync(pathsA.statePath, JSON.stringify({
      adapterId: 'claude',
      pid: process.pid,
      status: 'ready',
      laneId: 'lane-a',
      sessionName: 'lane-a',
      scopeType: 'paths',
      scopeMode: 'warn',
      scopePaths: ['src'],
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');
    writeFileSync(pathsB.statePath, JSON.stringify({
      adapterId: 'codex',
      pid: process.pid,
      status: 'ready',
      laneId: 'lane-b',
      sessionName: 'lane-b',
      scopeType: 'paths',
      scopeMode: 'block',
      scopePaths: ['src/utils'],
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const status = getResidentLaneStatus({ guardrailRepo: dir, laneDir: laneADir });
    const listing = listResidentLanes({ guardrailRepo: dir });

    assert.equal(status.scopeType, 'paths');
    assert.deepEqual(status.scopePaths, ['src']);
    assert.equal(status.scopeConflicts.length, 1);
    assert.equal(status.scopeConflicts[0].laneId, 'lane-b');
    assert.equal(status.scopeConflicts[0].enforcement, 'block');
    assert.equal(listing.lanes.length, 2);
    assert.equal(listing.lanes[0].scopeConflicts.length, 1);
    assert.equal(listing.lanes[1].scopeConflicts.length, 1);
  });
});
