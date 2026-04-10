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
});
