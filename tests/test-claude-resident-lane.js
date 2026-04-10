import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync,
  constants as fsConstants,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  lanePaths,
  parseResidentLaneArgs,
  normalizeResidentLaneOptions,
  runLaneRequest,
  launchResidentLane,
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
});
