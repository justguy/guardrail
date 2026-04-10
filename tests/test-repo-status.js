import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getRepoStatusSummary } from '../src/repo-status.js';

function tmpRepoDir() {
  return mkdtempSync(join(tmpdir(), 'gr-repo-status-'));
}

function runGit(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'git failed').trim());
  }
  return result.stdout.trim();
}

describe('repo status summary', () => {
  it('reports staged, unstaged, and untracked changes together', () => {
    const repoDir = tmpRepoDir();
    mkdirSync(repoDir, { recursive: true });
    runGit(repoDir, ['init', '-b', 'main']);
    runGit(repoDir, ['config', 'user.name', 'Guardrail Test']);
    runGit(repoDir, ['config', 'user.email', 'guardrail-test@example.com']);

    writeFileSync(join(repoDir, 'tracked.txt'), 'base\n', 'utf8');
    runGit(repoDir, ['add', 'tracked.txt']);
    runGit(repoDir, ['commit', '-m', 'baseline']);

    writeFileSync(join(repoDir, 'tracked.txt'), 'changed\n', 'utf8');
    runGit(repoDir, ['add', 'tracked.txt']);
    writeFileSync(join(repoDir, 'tracked.txt'), 'changed again\n', 'utf8');
    writeFileSync(join(repoDir, 'new-output.txt'), 'artifact\n', 'utf8');

    const summary = getRepoStatusSummary(repoDir);
    assert.equal(summary.clean, false);
    assert.equal(summary.branch, 'main');
    assert.equal(summary.staged.length, 1);
    assert.equal(summary.staged[0].path, 'tracked.txt');
    assert.equal(summary.unstaged.length, 1);
    assert.equal(summary.unstaged[0].path, 'tracked.txt');
    assert.deepEqual(summary.untracked, ['new-output.txt']);
  });
});
