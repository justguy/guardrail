import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAuditLog } from '../src/audit.js';
import {
  getResidentLaneHistory,
  getResidentLaneResult,
  residentLanePortfolioAuditPath,
  waitForResidentLaneResult,
} from '../src/lane/query.js';

function tmpRepo() {
  return mkdtempSync(join(tmpdir(), 'gr-lane-query-'));
}

describe('lane query helpers', () => {
  it('builds the host portfolio audit path from the requested host state dir', () => {
    const repo = tmpRepo();
    const auditPath = residentLanePortfolioAuditPath({ hostStateDir: join(repo, '.host') }, {
      defaultHostStateDir: () => join(repo, '.default-host'),
    });
    assert.equal(auditPath, join(repo, '.host', 'resident-lane-portfolio.jsonl'));
  });

  it('returns filtered resident lane history entries from the repo audit log', () => {
    const repo = tmpRepo();
    const auditPath = join(repo, '.guardrail', 'audit.jsonl');
    const audit = createAuditLog(auditPath);
    const laneDir = join(repo, '.guardrail', 'lanes', 'math');

    audit.append({ event: 'lane_start', lane_id: 'math', lane_dir: laneDir, request_id: 'req-1' });
    audit.append({ event: 'lane_request', lane_id: 'math', lane_dir: laneDir, request_id: 'req-2' });
    audit.append({ event: 'lane_start', lane_id: 'other', lane_dir: join(repo, '.guardrail', 'lanes', 'other'), request_id: 'req-3' });

    const history = getResidentLaneHistory({ guardrailRepo: repo, laneId: 'math', limit: 5 }, {
      parseInteger(value, fallback) {
        return value == null ? fallback : Number(value);
      },
    });

    assert.equal(history.count, 2);
    assert.equal(history.totalMatches, 2);
    assert.deepEqual(history.entries.map((entry) => entry.request_id), ['req-1', 'req-2']);
    assert.equal(existsSync(history.auditPath), true);
  });

  it('returns missing when no request has been selected yet', () => {
    const repo = tmpRepo();
    const laneDir = join(repo, '.guardrail', 'lanes', 'math');
    const result = getResidentLaneResult({ laneDir }, {
      getResidentLaneStatus() {
        return { laneDir, status: 'ready', currentRequestId: null, lastCompletedRequestId: null, lastRequestId: null };
      },
      laneResultPath(targetLaneDir, requestId) {
        return join(targetLaneDir, 'results', `${requestId}.json`);
      },
      readJson() {
        return null;
      },
    });

    assert.equal(result.status, 'missing');
    assert.equal(result.reason, 'no_request_selected');
  });

  it('returns completed when a stored result exists', () => {
    const repo = tmpRepo();
    const laneDir = join(repo, '.guardrail', 'lanes', 'math');
    const resultPath = join(laneDir, 'results', 'req-7.json');
    const stored = { ok: true, stdout: 'done\n' };

    const result = getResidentLaneResult({ laneDir, requestId: 'req-7' }, {
      getResidentLaneStatus() {
        return { laneDir, status: 'ready', currentRequestId: null, lastCompletedRequestId: 'req-7', lastRequestId: 'req-7' };
      },
      laneResultPath() {
        return resultPath;
      },
      readJson(path) {
        return path === resultPath ? stored : null;
      },
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.requestId, 'req-7');
    assert.deepEqual(result.result, stored);
  });

  it('returns pending when the current request is still running', () => {
    const repo = tmpRepo();
    const laneDir = join(repo, '.guardrail', 'lanes', 'math');

    const result = getResidentLaneResult({ laneDir, requestId: 'req-9' }, {
      getResidentLaneStatus() {
        return {
          laneDir,
          status: 'busy',
          currentRequestId: 'req-9',
          currentRequestStartedAt: '2026-04-15T00:00:00.000Z',
          lastRequestId: 'req-9',
        };
      },
      laneResultPath(targetLaneDir, requestId) {
        return join(targetLaneDir, 'results', `${requestId}.json`);
      },
      readJson() {
        return null;
      },
    });

    assert.equal(result.status, 'pending');
    assert.equal(result.reason, 'request_still_running');
  });

  it('waitForResidentLaneResult returns completed after a pending poll', async () => {
    const states = [
      { status: 'pending', resultPath: '/tmp/result.json' },
      { status: 'completed', requestId: 'req-10', resultPath: '/tmp/result.json', result: { ok: true } },
    ];
    let resultCalls = 0;

    const result = await waitForResidentLaneResult({ laneDir: '/tmp/lane', requestId: 'req-10', timeoutMs: 50, pollIntervalMs: 1 }, {
      getResidentLaneResult() {
        const current = states[Math.min(resultCalls, states.length - 1)];
        resultCalls += 1;
        return current;
      },
      getResidentLaneStatus() {
        return { status: 'busy', currentRequestId: 'req-10', lastRequestId: 'req-10', currentRequestStartedAt: '2026-04-15T00:00:00.000Z' };
      },
      parseInteger(value, fallback) {
        return value == null ? fallback : Number(value);
      },
      waitTimeoutMs: 50,
      waitPollIntervalMs: 1,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.requestId, 'req-10');
  });

  it('waitForResidentLaneResult returns lane_failed when the lane fails first', async () => {
    const result = await waitForResidentLaneResult({ laneDir: '/tmp/lane', requestId: 'req-11', timeoutMs: 10, pollIntervalMs: 1 }, {
      getResidentLaneResult() {
        return { status: 'pending', resultPath: '/tmp/result.json' };
      },
      getResidentLaneStatus() {
        return {
          status: 'failed',
          currentRequestId: null,
          lastRequestId: 'req-11',
          failureReason: 'boom',
          failureStage: 'runtime',
          logPath: '/tmp/lane.log',
        };
      },
      parseInteger(value, fallback) {
        return value == null ? fallback : Number(value);
      },
      waitTimeoutMs: 10,
      waitPollIntervalMs: 1,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'lane_failed');
    assert.equal(result.failureReason, 'boom');
  });
});
