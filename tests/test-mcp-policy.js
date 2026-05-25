import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describeDelegatedGrant, loadDelegatedGrant, evaluateDelegatedTool } from '../src/delegated-policy.js';

function tmpDir() {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'gr-mcp-policy-')));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function baseGrant(overrides = {}) {
  const {
    recipeHash = 'a'.repeat(64),
    gitCommitRecipeHash = 'b'.repeat(64),
    gitPushRecipeHash = 'c'.repeat(64),
    ...rest
  } = overrides;
  const grant = {
    version: 1,
    agent: 'codex',
    repo_path: '.',
    expires_at: '2999-01-01T00:00:00.000Z',
    tools: {
      guardrail_run_recipe: {
        recipes: {
          'mcp-echo': {
            allow_unverified: true,
            recipe_hash: recipeHash,
            inputs: { message: { exact: 'hello' } },
          },
        },
      },
      guardrail_http_request: {
        hosts: ['127.0.0.1', 'localhost'],
        ports: [4317],
        methods: ['GET'],
        max_body_bytes: 128,
      },
      guardrail_git_status: true,
      guardrail_git_diff: true,
      guardrail_git_commit: {
        recipe_hash: gitCommitRecipeHash,
        allow_unverified: true,
        allowed_paths: ['src', 'tests'],
      },
      guardrail_git_push_feature_branch: {
        recipe_hash: gitPushRecipeHash,
        remote: 'origin',
        branch_pattern: '^(feature|bugfix|chore|docs|refactor|test|ci)/[A-Za-z0-9._/-]{1,96}$',
      },
    },
  };
  return { ...grant, ...rest, tools: rest.tools ?? grant.tools };
}

describe('delegated MCP policy', () => {
  it('describes grant capabilities and help for agent discovery', () => {
    const dir = tmpDir();
    const grantPath = join(dir, 'grant.json');
    writeJson(grantPath, baseGrant());
    const grantState = loadDelegatedGrant(grantPath, { cwd: dir });

    const status = describeDelegatedGrant(grantState, { now: '2026-01-01T00:00:00.000Z' });

    assert.equal(status.ok, true);
    assert.ok(status.tools.includes('guardrail_http_request'));
    assert.deepEqual(status.capabilities.guardrail_http_request.policy.hosts, ['127.0.0.1', 'localhost']);
    assert.deepEqual(status.capabilities.guardrail_http_request.policy.ports, [4317]);
    assert.deepEqual(status.capabilities.guardrail_http_request.policy.methods, ['GET']);
    assert.equal(status.capabilities.guardrail_http_request.policy.maxBodyBytes, 128);
    assert.equal(status.capabilities.guardrail_git_commit.policy.recipeHash, 'b'.repeat(64));
    assert.deepEqual(status.capabilities.guardrail_git_commit.policy.allowedPaths, ['src', 'tests']);
    assert.match(status.help.discovery, /guardrail_grant_status/);
    assert.match(status.help.moreInfo, /correction\.expected/);
  });

  it('loads a grant and allows constrained tool calls', () => {
    const dir = tmpDir();
    const grantPath = join(dir, 'grant.json');
    writeJson(grantPath, baseGrant());
    const grantState = loadDelegatedGrant(grantPath, { cwd: dir });

    assert.equal(grantState.ok, true);
    const allowed = evaluateDelegatedTool(
      { grantState, cwd: dir, agent: 'codex' },
      'guardrail_run_recipe',
      { recipe: 'mcp-echo', inputs: { message: 'hello' }, repo_path: '.' },
    );
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.allowUnverified, true);

    const commit = evaluateDelegatedTool(
      { grantState, cwd: dir, agent: 'codex' },
      'guardrail_git_commit',
      { paths: ['src/index.js'], message_file: 'msg.txt', repo_path: '.' },
    );
    assert.equal(commit.allowed, true);
    assert.equal(commit.allowUnverified, true);
  });

  it('denies undelegated inputs, remote HTTP, protected branches, and resource widening', () => {
    const dir = tmpDir();
    const grantPath = join(dir, 'grant.json');
    writeJson(grantPath, baseGrant());
    const grantState = loadDelegatedGrant(grantPath, { cwd: dir });
    const context = { grantState, cwd: dir, agent: 'codex' };

    const badInput = evaluateDelegatedTool(context, 'guardrail_run_recipe', {
      recipe: 'mcp-echo',
      inputs: { message: 'goodbye' },
    });
    assert.equal(badInput.allowed, false);
    assert.match(badInput.reason, /outside delegated constraints/);

    const remote = evaluateDelegatedTool(context, 'guardrail_http_request', {
      url: 'https://example.com/',
      method: 'GET',
    });
    assert.equal(remote.allowed, false);
    assert.match(remote.reason, /loopback/);
    assert.match(remote.correction.expected, /loopback/);

    const protectedBranch = evaluateDelegatedTool(context, 'guardrail_git_push_feature_branch', {
      branch: 'main',
      remote: 'origin',
    });
    assert.equal(protectedBranch.allowed, false);
    assert.match(protectedBranch.correction.expected, /non-protected/);

    const longHttp = evaluateDelegatedTool(context, 'guardrail_http_request', {
      url: 'http://127.0.0.1:4317/',
      method: 'GET',
      timeout_ms: 6000,
    });
    assert.equal(longHttp.allowed, false);
    assert.match(longHttp.reason, /timeout_ms/);
    assert.match(longHttp.correction.expected, /5000 or less/);

    const largeDiff = evaluateDelegatedTool(context, 'guardrail_git_diff', { max_bytes: 1024 * 1024 });
    assert.equal(largeDiff.allowed, false);
    assert.match(largeDiff.reason, /max_bytes/);
    assert.match(largeDiff.correction.expected, /65536 or less/);
  });

  it('denies expired grants, agent mismatch, and symlink repo escape', () => {
    const dir = tmpDir();
    const outside = tmpDir();
    symlinkSync(outside, join(dir, 'outside-link'), 'dir');
    const grantPath = join(dir, 'grant.json');

    writeJson(grantPath, baseGrant({ expires_at: '2000-01-01T00:00:00.000Z' }));
    const expiredGrant = loadDelegatedGrant(grantPath, { cwd: dir });
    const expired = evaluateDelegatedTool(
      { grantState: expiredGrant, cwd: dir, agent: 'codex' },
      'guardrail_git_status',
      { repo_path: '.' },
    );
    assert.equal(expired.allowed, false);
    assert.match(expired.reason, /expired/);

    writeJson(grantPath, baseGrant({ agent: 'other-agent' }));
    const agentGrant = loadDelegatedGrant(grantPath, { cwd: dir });
    const wrongAgent = evaluateDelegatedTool(
      { grantState: agentGrant, cwd: dir, agent: 'codex' },
      'guardrail_git_status',
      { repo_path: '.' },
    );
    assert.equal(wrongAgent.allowed, false);
    assert.match(wrongAgent.reason, /other-agent/);

    writeJson(grantPath, baseGrant());
    const symlinkGrant = loadDelegatedGrant(grantPath, { cwd: dir });
    const escape = evaluateDelegatedTool(
      { grantState: symlinkGrant, cwd: dir, agent: 'codex' },
      'guardrail_git_status',
      { repo_path: 'outside-link' },
    );
    assert.equal(escape.allowed, false);
    assert.match(escape.reason, /outside delegated root/);
  });
});
