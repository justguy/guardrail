import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  detectBlockedGitCommand,
  runClaudeGitGuardrailHook,
  splitCommandSegments,
} from '../src/claude-git-guardrail-hook.js';

const HOOK_PATH = resolve('src/claude-git-guardrail-hook.js');

describe('claude git guardrail hook', () => {
  it('splits bash segments and strips leading env assignments', () => {
    assert.deepEqual(
      splitCommandSegments('FOO=bar git push origin main && git status'),
      ['git push origin main', 'git status'],
    );
  });

  it('blocks raw non-force git push and suggests the bounded push recipe', () => {
    const result = detectBlockedGitCommand('git push origin feature/demo');
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'git_push');
    assert.match(result.message, /guardrail run --recipe git-push/);
    assert.doesNotMatch(result.message, /git-force-push-safe/);
  });

  it('blocks raw force push and suggests the lease-bound recipe', () => {
    const result = detectBlockedGitCommand('git push --force-with-lease origin feature/demo');
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'git_push');
    assert.match(result.message, /guardrail run --recipe git-force-push-safe/);
    assert.match(result.message, /expected_remote_oid=<sha>/);
  });

  it('blocks raw destructive worktree and history wipe commands without a recipe recommendation', () => {
    for (const command of [
      'git reset --hard HEAD~1',
      'git clean -fd',
      'git branch -D feature/demo',
      'git checkout -- .',
      'git restore .',
    ]) {
      const result = detectBlockedGitCommand(command);
      assert.equal(result.blocked, true, command);
      assert.match(result.message, /No shipped Guardrail recipe exists/);
    }
  });

  it('allows non-blocked git commands', () => {
    const result = detectBlockedGitCommand('git status --short');
    assert.equal(result.blocked, false);
  });

  it('returns a blocked hook result for Claude PreToolUse payloads', () => {
    const payload = JSON.stringify({
      tool_input: {
        command: 'git push origin feature/demo',
      },
    });

    const result = runClaudeGitGuardrailHook(payload);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /raw git push is not allowed/);
  });

  it('allows invalid payloads to pass through fail-closed for the hook transport', () => {
    const result = runClaudeGitGuardrailHook('{not-json');
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
  });

  it('runs as an executable hook script', () => {
    const payload = JSON.stringify({
      tool_input: {
        command: 'git push --force origin feature/demo',
      },
    });

    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: payload,
      encoding: 'utf8',
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /git-force-push-safe/);
    assert.match(result.stderr, /raw git push is not allowed/);
  });
});
