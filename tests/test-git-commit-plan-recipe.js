import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  realpathSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { parseWrapperArgs, runGitCommitFromPlan } from '../src/git-commit-plan-wrapper.js';

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-git-commit-plan-')));
}

function runGit(dir, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout;
}

function makeRepo() {
  const dir = tmpDir();
  const repoDir = join(dir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  runGit(repoDir, ['init', '-b', 'main']);
  runGit(repoDir, ['config', 'user.name', 'Guardrail Test']);
  runGit(repoDir, ['config', 'user.email', 'guardrail-test@example.com']);
  return repoDir;
}

function withCwd(dir, fn) {
  const current = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(current);
  }
}

function makePlanFile(repoDir, planFileName, messageFileName, overrides = {}) {
  const plan = {
    version: 1,
    kind: 'commit_plan',
    repo_path: '.',
    summary: 'test plan',
    paths: ['src/approved.txt'],
    message_file: messageFileName,
    bounds: {
      allowed_roots: ['src'],
      max_files: 1,
    },
    ...overrides,
  };

  const planPath = join(repoDir, planFileName);
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
  return planPath;
}

describe('Git commit from plan wrapper', () => {
  it('parses wrapper args by flag', () => {
    const parsed = parseWrapperArgs([
      '--plan-file', '.guardrail/commit-plan.json',
      '--message-file', '.guardrail/commit-message.txt',
    ]);

    assert.equal(parsed.planFile, '.guardrail/commit-plan.json');
    assert.equal(parsed.messageFile, '.guardrail/commit-message.txt');
  });

  it('commits only paths from an approved plan', async () => {
    const repoDir = makeRepo();
    const approved = join(repoDir, 'src', 'approved.txt');
    const blocked = join(repoDir, 'src', 'blocked.txt');
    const guardrailDir = join(repoDir, '.guardrail');
    mkdirSync(guardrailDir, { recursive: true });
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(approved, 'approved baseline\n');
    writeFileSync(blocked, 'blocked baseline\n');
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', 'baseline']);

    writeFileSync(approved, 'approved change\n');
    writeFileSync(blocked, 'blocked change\n');
    const messageFile = join(guardrailDir, 'commit-message.txt');
    writeFileSync(messageFile, 'Plan-bound commit');

    makePlanFile(repoDir, '.guardrail/commit-plan.json', '.guardrail/commit-message.txt');
    const beforeHead = runGit(repoDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    runGit(repoDir, ['status', '--short', '--untracked-files=no'], { encoding: 'utf8' }).trim();

    await withCwd(repoDir, () => runGitCommitFromPlan({
      planFile: '.guardrail/commit-plan.json',
      messageFile: '.guardrail/commit-message.txt',
    }));

    const afterHead = runGit(repoDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const committed = runGit(repoDir, ['show', '--pretty=format:', '--name-status', 'HEAD'], { encoding: 'utf8' }).trim();
    const workingAfter = runGit(repoDir, ['status', '--short', '--untracked-files=no'], { encoding: 'utf8' }).trim();

    assert.notEqual(beforeHead, afterHead);
    assert.equal(committed.includes('approved.txt'), true);
    assert.ok(workingAfter.includes('blocked.txt'), 'blocked file remains unstaged after commit');
  });

  it('fails when the recipe-supplied message_file does not match plan message_file', async () => {
    const repoDir = makeRepo();
    const approved = join(repoDir, 'src', 'approved.txt');
    const blocked = join(repoDir, 'src', 'blocked.txt');
    const guardrailDir = join(repoDir, '.guardrail');
    mkdirSync(dirname(approved), { recursive: true });
    mkdirSync(dirname(blocked), { recursive: true });
    mkdirSync(guardrailDir, { recursive: true });
    writeFileSync(approved, 'approved baseline\n');
    writeFileSync(blocked, 'blocked baseline\n');
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', 'baseline']);
    writeFileSync(approved, 'approved change\n');
    writeFileSync(join(guardrailDir, 'commit-message.txt'), 'Plan-bound commit');
    writeFileSync(join(guardrailDir, 'alt-message.txt'), 'Alt commit file');
    makePlanFile(repoDir, '.guardrail/commit-plan.json', '.guardrail/commit-message.txt');

    await assert.rejects(
      withCwd(repoDir, () => runGitCommitFromPlan({
        planFile: '.guardrail/commit-plan.json',
        messageFile: '.guardrail/alt-message.txt',
      })),
      /plan.message_file mismatch/,
    );
  });
});
