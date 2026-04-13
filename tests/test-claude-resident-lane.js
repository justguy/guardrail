import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyClaudeAuthSource,
  lanePaths,
  laneResultPath,
  parseResidentLaneArgs,
  normalizeResidentLaneOptions,
  preflightClaudeLaneAuth,
  runLaneRequest,
  getResidentLaneResult,
  getResidentLaneStatus,
  launchResidentLane,
  listResidentLanes,
  pruneResidentLanes,
  signLaneRequest,
  stopResidentLane,
  trackLaneRequestId,
  validateLaneRequest,
  waitForResidentLaneBootstrap,
} from '../src/claude-resident-lane.js';
import {
  runResidentLaneDaemon,
  revokeResidentLane,
  killResidentLane,
} from '../src/resident-lane-core.js';
// Exercise the generic lane entrypoint, which now dispatches to Claude/Codex adapters.
import {
  listResidentLaneAdapters,
  parseResidentLaneArgs as parseGenericResidentLaneArgs,
  normalizeResidentLaneOptions as normalizeGenericResidentLaneOptions,
  runLaneRequest as runGenericLaneRequest,
} from '../src/resident-lane.js';
import { sendResidentLaneMessage } from '../src/claude-resident-lane-client.js';
import { launchResidentLane as launchLocalExecLane } from '../src/local-exec-resident-lane.js';
import { acquireLock } from '../src/runtime-policy.js';

function tmpLaneDir() {
  return mkdtempSync(join(tmpdir(), 'gr-claude-lane-'));
}

function withHostState(dir, options = {}) {
  return {
    hostStateDir: join(dir, 'host-state'),
    ...options,
  };
}

function mkfifo(path) {
  const result = spawnSync('mkfifo', [path], { stdio: 'ignore' });
  if (result.status !== 0) {
    throw new Error(`mkfifo failed for ${path}`);
  }
}

function makeFakeLaunchHelper(daemonPid, options = {}) {
  const child = new EventEmitter();
  child.pid = options.helperPid ?? 11111;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setTimeout(() => {
    if (options.stdout !== false) {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ pid: daemonPid }) + '\n', 'utf8'));
    }
    if (options.stderrText) {
      child.stderr.emit('data', Buffer.from(options.stderrText, 'utf8'));
    }
    child.emit('exit', options.closeCode ?? 0, options.signal ?? null);
    child.emit('close', options.closeCode ?? 0);
  }, 0);
  return child;
}

function getFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}

describe('Claude resident lane', () => {
  it('parses lane args by flag name', () => {
    const parsed = parseGenericResidentLaneArgs([
      '--lane-dir', '.guardrail/lanes/math',
      '--guardrail-repo', '.',
      '--working-dir', '.',
      '--tool', 'codex',
      '--profile', 'dev',
      '--sandbox', 'workspace-write',
      '--session-name', 'math-live-session',
      '--session-id', 'math-live-session-1',
      '--poll-interval-ms', '250',
      '--idle-timeout-ms', '10000',
      '--daemon',
    ]);

    assert.equal(parsed.laneDir, '.guardrail/lanes/math');
    assert.equal(parsed.guardrailRepo, '.');
    assert.equal(parsed.workingDir, '.');
    assert.equal(parsed.tool, 'codex');
    assert.equal(parsed.profile, 'dev');
    assert.equal(parsed.sandbox, 'workspace-write');
    assert.equal(parsed.sessionName, 'math-live-session');
    assert.equal(parsed.sessionId, 'math-live-session-1');
    assert.equal(parsed.pollIntervalMs, '250');
    assert.equal(parsed.idleTimeoutMs, '10000');
    assert.equal(parsed.daemon, true);
  });

  it('normalizes resident lane options', () => {
    const dir = tmpLaneDir();
    const options = normalizeGenericResidentLaneOptions({
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
    assert.equal(options.tool, 'claude');
    assert.equal(options.sessionName, 'math-live-session');
    assert.equal(options.sessionId, 'math-live-session-1');
    assert.equal(options.noSessionPersistence, false);
    assert.deepEqual(options.addDirs, [resolve(dir, 'docs'), resolve(dir, 'tests')]);
    assert.deepEqual(options.inputFiles, ['a.txt', 'b.txt']);
  });

  it('normalizes resident lane write scopes', () => {
    const dir = tmpLaneDir();
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: 'packages/app',
      sessionName: 'math-live-session',
      scopeType: 'worktree',
      scopeMode: 'warn',
    }, dir);

    assert.equal(options.scopeType, 'worktree');
    assert.equal(options.scopeMode, 'warn');
    assert.deepEqual(options.scopePaths, ['packages/app']);
  });

  it('infers a worktree scope when working_dir narrows below the repo root', () => {
    const dir = tmpLaneDir();
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: 'packages/app',
      sessionName: 'math-live-session',
    }, dir);

    assert.equal(options.scopeType, 'worktree');
    assert.equal(options.scopeMode, 'warn');
    assert.deepEqual(options.scopePaths, ['packages/app']);
  });

  it('derives FIFO paths from the lane dir', () => {
    const paths = lanePaths('/tmp/example-lane');
    assert.equal(paths.requestFifo, '/tmp/example-lane/requests.fifo');
    assert.equal(paths.responseFifo, '/tmp/example-lane/responses.fifo');
    assert.equal(paths.statePath, '/tmp/example-lane/state.json');
    assert.equal(paths.identityPath, '/tmp/example-lane/identity.json');
  });

  it('uses lifecycle start for the first request and continue after success', async () => {
    const dir = tmpLaneDir();
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const options = normalizeGenericResidentLaneOptions({
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
      maxBudgetUsd: '10.00',
      systemPrompt: 'Answer briefly.',
    }, dir);

    const calls = [];
    const runner = async (args, _cwd, _env, hooks) => {
      calls.push({ args, hooks });
      return { code: 0, stdout: '12\n', stderr: '' };
    };

    const savedHome = process.env.HOME;
    process.env.HOME = homeDir;
    let first;
    let second;
    try {
      first = await runLaneRequest(options, {
        id: 'req-1',
        prompt: '4x3=?',
        reportArtifact: 'docs/plans/REPORT_req1.md',
        completionMode: 'artifact',
      }, { startedConversation: false }, { runner });
      second = await runLaneRequest(options, {
        id: 'req-2',
        prompt: '4x4=?',
        reportArtifact: 'docs/plans/REPORT_req2.md',
        completionMode: 'artifact',
      }, { startedConversation: true }, { runner });
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
    }

    assert.equal(first.lifecycle, 'start');
    assert.equal(second.lifecycle, 'continue');
    assert.equal(first.runtimeSessionId, options.sessionId);
    assert.notEqual(second.runtimeSessionId, first.runtimeSessionId);
    assert.match(
      second.runtimeSessionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.equal(first.stdout, '12\n');
    assert.ok(calls[0].args[0].endsWith('src/claude-prompt-wrapper.js'));
    assert.ok(calls[0].args.includes('--lifecycle'));
    assert.ok(calls[0].args.includes('start'));
    assert.ok(calls[1].args.includes('continue'));
    assert.equal(getFlagValue(calls[0].args, '--session-id'), first.runtimeSessionId);
    assert.equal(getFlagValue(calls[1].args, '--session-id'), second.runtimeSessionId);
    assert.ok(calls[0].args.includes('--session-name'));
    assert.ok(calls[0].args.includes('math-live-session'));
    assert.equal(getFlagValue(calls[0].args, '--guardrail-report-artifact'), 'docs/plans/REPORT_req1.md');
    assert.equal(getFlagValue(calls[0].args, '--guardrail-completion-mode'), 'artifact');
    assert.equal(getFlagValue(calls[1].args, '--guardrail-report-artifact'), 'docs/plans/REPORT_req2.md');
    assert.equal(getFlagValue(calls[1].args, '--guardrail-completion-mode'), 'artifact');
    assert.equal(typeof calls[0].hooks, 'object');
    assert.equal(calls[0].hooks.onProgress, undefined);
    assert.equal(calls[0].hooks.onStderrLine, undefined);
  });

  it('generates a UUID session id for Claude lanes when none is provided', () => {
    const dir = tmpLaneDir();
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      sessionName: 'math-live-session',
    }, dir);

    assert.match(
      options.sessionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('passes Guardrail progress file flags to the Claude wrapper', async () => {
    const dir = tmpLaneDir();
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      laneId: 'math-live',
      sessionName: 'math-live-session',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      maxBudgetUsd: '10.00',
    }, dir);

    let seenArgs = null;
    const runner = async (args) => {
      seenArgs = args;
      return { code: 0, stdout: 'ok\n', stderr: '' };
    };

    const savedHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      await runLaneRequest(options, { id: 'req-1', prompt: 'status?' }, { startedConversation: false }, { runner });
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
    }

    assert.ok(seenArgs.includes('--guardrail-progress-file'));
    assert.ok(seenArgs.includes(resolve(dir, '.guardrail', 'lanes', 'math', 'progress', 'req-1.ndjson')));
    assert.ok(seenArgs.includes('--guardrail-progress-state-file'));
    assert.ok(seenArgs.includes(resolve(dir, '.guardrail', 'lanes', 'math', 'progress', 'req-1.json')));
    assert.ok(seenArgs.includes('--guardrail-heartbeat-seconds'));
    assert.ok(seenArgs.includes('60'));
  });

  it('runs Claude lanes with the unmodified host environment when no API key or operator CLAUDE_CONFIG_DIR is present', async () => {
    const dir = tmpLaneDir();
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      laneId: 'math-live',
      sessionName: 'math-live-session',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      maxBudgetUsd: '10.00',
    }, dir);

    // Simulate keychain-auth context: no API key, no operator CLAUDE_CONFIG_DIR.
    const savedHome = process.env.HOME;
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    const savedOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = homeDir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CONFIG_DIR;

    let seenEnvRef = null;
    let seenConfigDir = 'sentinel';
    const runner = async (_args, _cwd, env) => {
      seenEnvRef = env;
      seenConfigDir = env.CLAUDE_CONFIG_DIR;
      return { code: 0, stdout: 'ok\n', stderr: '' };
    };

    try {
      await runLaneRequest(options, { id: 'req-1', prompt: 'status?' }, { startedConversation: false }, { runner });
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
      if (savedOAuthToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken;
      if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    }

    // D0z: keychain auth path must NOT inject CLAUDE_CONFIG_DIR — doing so would
    // break the keychain service name hash and lose credentials.
    const slug = resolve(dir).replace(/[\\/]/g, '-');
    const hostProjectDir = join(homeDir, 'projects', slug);
    const localProjectDir = resolve(dir, '.guardrail', 'claude-runtime', 'projects', slug);
    assert.equal(seenEnvRef, process.env);
    assert.equal(seenConfigDir, undefined);
    assert.ok(lstatSync(hostProjectDir).isSymbolicLink());
    assert.equal(resolve(dirname(hostProjectDir), readlinkSync(hostProjectDir)), localProjectDir);
  });

  it('auth preflight: classifies env-token auth without redirecting CLAUDE_CONFIG_DIR', async () => {
    const dir = tmpLaneDir();
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      laneId: 'math-live',
      sessionName: 'math-live-session',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      maxBudgetUsd: '10.00',
    }, dir);

    const savedHome = process.env.HOME;
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = homeDir;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    delete process.env.CLAUDE_CONFIG_DIR;

    let seenEnv = null;
    let seenApiKey = null;
    const runner = async (_options, env) => {
      seenEnv = env;
      seenApiKey = env.ANTHROPIC_API_KEY;
      return { code: 0, stdout: 'ok\n', stderr: '' };
    };
    let result;

    try {
      result = await preflightClaudeLaneAuth(options, { preflightRunner: runner });
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
      else delete process.env.ANTHROPIC_API_KEY;
      if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    }

    assert.equal(result.ok, true);
    assert.equal(result.source, 'env_token');
    assert.equal(classifyClaudeAuthSource({ HOME: homeDir, ANTHROPIC_API_KEY: 'sk-ant-test-key' }).source, 'env_token');
    assert.equal(seenEnv, process.env);
    assert.equal(seenEnv.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(seenApiKey, 'sk-ant-test-key');
  });

  it('auth preflight: classifies oauth-token auth without redirecting CLAUDE_CONFIG_DIR', async () => {
    const dir = tmpLaneDir();
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      laneId: 'oauth-lane',
      sessionName: 'oauth-session',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      maxBudgetUsd: '10.00',
    }, dir);

    const savedHome = process.env.HOME;
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = homeDir;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
    delete process.env.CLAUDE_CONFIG_DIR;

    let seenEnv = null;
    const runner = async (_options, env) => {
      seenEnv = env;
      return { code: 0, stdout: 'ok\n', stderr: '' };
    };
    let result;

    try {
      result = await preflightClaudeLaneAuth(options, { preflightRunner: runner });
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
      if (savedToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    }

    assert.equal(result.ok, true);
    assert.equal(result.source, 'env_token');
    assert.equal(classifyClaudeAuthSource({ HOME: homeDir, CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token' }).source, 'env_token');
    assert.equal(seenEnv, process.env);
    assert.equal(seenEnv.CLAUDE_CONFIG_DIR, undefined);
  });

  it('D0z: passes env through unchanged when operator has already set CLAUDE_CONFIG_DIR', async () => {
    const dir = tmpLaneDir();
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      laneId: 'math-live',
      sessionName: 'math-live-session',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      maxBudgetUsd: '10.00',
    }, dir);

    const savedHome = process.env.HOME;
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = homeDir;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.CLAUDE_CONFIG_DIR = '/operator/chosen/config';

    let seenEnvRef = null;
    let seenConfigDir = null;
    const runner = async (_args, _cwd, env) => {
      // Capture values at call time, before finally-block restores the env.
      seenEnvRef = env;
      seenConfigDir = env.CLAUDE_CONFIG_DIR;
      return { code: 0, stdout: 'ok\n', stderr: '' };
    };

    try {
      await runLaneRequest(options, { id: 'req-1', prompt: 'status?' }, { startedConversation: false }, { runner });
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
      else delete process.env.ANTHROPIC_API_KEY;
      if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
      else delete process.env.CLAUDE_CONFIG_DIR;
    }

    // Operator override takes precedence; env object is the same reference.
    assert.equal(seenEnvRef, process.env);
    assert.equal(seenConfigDir, '/operator/chosen/config');
  });

  it('auth preflight: returns structured auth_preflight_failed for Claude login errors', async () => {
    const dir = tmpLaneDir();
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      laneId: 'math-live',
      sessionName: 'math-live-session',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      maxBudgetUsd: '10.00',
    }, dir);

    const savedHome = process.env.HOME;
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = homeDir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CONFIG_DIR;

    let result;
    try {
      result = await preflightClaudeLaneAuth(options, {
        preflightRunner: async () => ({
          code: 1,
          stdout: '',
          stderr: 'claude --print failed with exit code 1: Not logged in · Please run /login',
        }),
      });
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
      else delete process.env.ANTHROPIC_API_KEY;
      if (savedToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
      else delete process.env.CLAUDE_CONFIG_DIR;
    }

    assert.equal(result.ok, false);
    assert.equal(result.source, 'keychain');
    assert.equal(result.reason, 'auth_preflight_failed');
    assert.match(result.message, /Claude auth preflight failed/);
  });

  it('auth preflight: treats logged-out auth status output as auth_preflight_failed', async () => {
    const dir = tmpLaneDir();
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      laneId: 'math-live',
      sessionName: 'math-live-session',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      maxBudgetUsd: '10.00',
    }, dir);

    const savedHome = process.env.HOME;
    process.env.HOME = homeDir;

    let result;
    try {
      result = await preflightClaudeLaneAuth(options, {
        preflightRunner: async () => ({
          code: 1,
          stdout: '{\n  "loggedIn": false,\n  "authMethod": "none"\n}\n',
          stderr: '',
        }),
      });
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
    }

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'auth_preflight_failed');
    assert.match(result.message, /Claude auth preflight failed/);
  });

  it('D0z: fails closed when the host Claude project path already exists as a non-empty directory', async () => {
    const dir = tmpLaneDir();
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      laneId: 'math-live',
      sessionName: 'math-live-session',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      maxBudgetUsd: '10.00',
    }, dir);

    const slug = resolve(dir).replace(/[\\/]/g, '-');
    const hostProjectDir = join(homeDir, 'projects', slug);
    mkdirSync(hostProjectDir, { recursive: true });
    writeFileSync(join(hostProjectDir, 'existing.txt'), 'occupied\n');

    const savedHome = process.env.HOME;
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    const savedOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = homeDir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CONFIG_DIR;

    try {
      await assert.rejects(
        () => runLaneRequest(options, { id: 'req-1', prompt: 'status?' }, { startedConversation: false }, {
          runner: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
        }),
        /Claude project bridge conflict/,
      );
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
      if (savedOAuthToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken;
      if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    }

    assert.deepEqual(readdirSync(hostProjectDir), ['existing.txt']);
  });

  it('D0z: reuses the same repo-scoped Claude project bridge across lane ids in the same repo', async () => {
    const dir = tmpLaneDir();
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const firstOptions = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/first',
      guardrailRepo: '.',
      workingDir: '.',
      laneId: 'first-lane',
      sessionName: 'first-session',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      maxBudgetUsd: '10.00',
    }, dir);
    const secondOptions = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/second',
      guardrailRepo: '.',
      workingDir: '.',
      laneId: 'second-lane',
      sessionName: 'second-session',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      maxBudgetUsd: '10.00',
    }, dir);

    const savedHome = process.env.HOME;
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    const savedOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = homeDir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CONFIG_DIR;

    try {
      await runLaneRequest(firstOptions, { id: 'req-1', prompt: 'status?' }, { startedConversation: false }, {
        runner: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
      });
      await runLaneRequest(secondOptions, { id: 'req-2', prompt: 'status?' }, { startedConversation: false }, {
        runner: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
      });
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
      if (savedOAuthToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken;
      if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    }

    const slug = resolve(dir).replace(/[\\/]/g, '-');
    const hostProjectDir = join(homeDir, 'projects', slug);
    const localProjectDir = resolve(dir, '.guardrail', 'claude-runtime', 'projects', slug);
    assert.ok(lstatSync(hostProjectDir).isSymbolicLink());
    assert.equal(resolve(dirname(hostProjectDir), readlinkSync(hostProjectDir)), localProjectDir);
  });

  it('D0z: reuses a legacy lane-scoped repo-local Claude project bridge without treating it as a conflict', async () => {
    const dir = tmpLaneDir();
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/current',
      guardrailRepo: '.',
      workingDir: '.',
      laneId: 'current-lane',
      sessionName: 'current-session',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      maxBudgetUsd: '10.00',
    }, dir);

    const slug = resolve(dir).replace(/[\\/]/g, '-');
    const hostProjectDir = join(homeDir, 'projects', slug);
    const legacyTarget = resolve(dir, '.guardrail', 'claude-runtime', 'legacy-lane', 'projects', slug);
    mkdirSync(dirname(legacyTarget), { recursive: true });
    mkdirSync(legacyTarget, { recursive: true });
    writeFileSync(join(legacyTarget, 'legacy.txt'), 'migrate-me\n');
    mkdirSync(dirname(hostProjectDir), { recursive: true });
    symlinkSync(legacyTarget, hostProjectDir, 'dir');

    const savedHome = process.env.HOME;
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    const savedOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = homeDir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CONFIG_DIR;

    try {
      await runLaneRequest(options, { id: 'req-1', prompt: 'status?' }, { startedConversation: false }, {
        runner: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
      });
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
      if (savedOAuthToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken;
      if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    }

    const localProjectDir = legacyTarget;
    assert.ok(lstatSync(hostProjectDir).isSymbolicLink());
    assert.equal(resolve(dirname(hostProjectDir), readlinkSync(hostProjectDir)), localProjectDir);
    assert.equal(readFileSync(join(localProjectDir, 'legacy.txt'), 'utf8'), 'migrate-me\n');
  });

  it('D0z: recreates a missing repo-local legacy target when the host symlink is broken', async () => {
    const dir = tmpLaneDir();
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/current',
      guardrailRepo: '.',
      workingDir: '.',
      laneId: 'current-lane',
      sessionName: 'current-session',
      model: 'sonnet',
      permissionMode: 'dontAsk',
      maxBudgetUsd: '10.00',
    }, dir);

    const slug = resolve(dir).replace(/[\\/]/g, '-');
    const hostProjectDir = join(homeDir, 'projects', slug);
    const legacyTarget = resolve(dir, '.guardrail', 'claude-runtime', 'legacy-lane', 'projects', slug);
    mkdirSync(dirname(hostProjectDir), { recursive: true });
    symlinkSync(legacyTarget, hostProjectDir, 'dir');

    const savedHome = process.env.HOME;
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    const savedOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = homeDir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CONFIG_DIR;

    try {
      await runLaneRequest(options, { id: 'req-1', prompt: 'status?' }, { startedConversation: false }, {
        runner: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
      });
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
      if (savedOAuthToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken;
      if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    }

    assert.ok(existsSync(legacyTarget));
    assert.ok(lstatSync(hostProjectDir).isSymbolicLink());
    assert.equal(resolve(dirname(hostProjectDir), readlinkSync(hostProjectDir)), legacyTarget);
  });

  it('D0z: defaults noSessionPersistence to true for resident Claude lane runs', () => {
    const dir = tmpLaneDir();
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      sessionName: 'math-live-session',
    }, dir);
    assert.equal(options.noSessionPersistence, true);
  });

  it('D0z: noSessionPersistence can be explicitly disabled with false', () => {
    const dir = tmpLaneDir();
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      sessionName: 'math-live-session',
      noSessionPersistence: 'false',
    }, dir);
    assert.equal(options.noSessionPersistence, false);
  });

  it('D0z: noSessionPersistence true causes --no-session-persistence flag in wrapper args', async () => {
    const dir = tmpLaneDir();
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: '.',
      workingDir: '.',
      sessionName: 'math-live-session',
      // noSessionPersistence omitted → defaults to true
    }, dir);

    let seenArgs = null;
    const runner = async (args) => {
      seenArgs = args;
      return { code: 0, stdout: 'ok\n', stderr: '' };
    };

    const savedHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      await runLaneRequest(options, { id: 'req-1', prompt: 'status?' }, { startedConversation: false }, { runner });
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
    }

    assert.ok(seenArgs.includes('--no-session-persistence'), '--no-session-persistence must be in wrapper args when noSessionPersistence=true');
  });

  it('builds codex lane wrapper args when tool=codex', async () => {
    const dir = tmpLaneDir();
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/codex',
      guardrailRepo: '.',
      workingDir: '.',
      tool: 'codex',
      sessionName: 'codex-live-session',
      sessionId: 'codex-live-session-1',
      model: 'gpt-5-codex',
      profile: 'dev',
      sandbox: 'workspace-write',
      addDirs: 'docs,tests',
      imageFiles: 'fixtures/a.png,fixtures/b.webp',
      color: 'never',
      oss: 'true',
      localProvider: 'ollama',
      skipGitRepoCheck: 'true',
      ephemeral: 'true',
      fullAuto: 'true',
    }, dir);

    const calls = [];
    const runner = async (args) => {
      calls.push(args);
      return { code: 0, stdout: 'done\n', stderr: '' };
    };

    await runGenericLaneRequest(options, { id: 'req-1', prompt: 'review this' }, { startedConversation: false }, { runner });

    assert.ok(calls[0][0].endsWith('src/codex-exec-wrapper.js'));
    assert.ok(calls[0].includes('--profile'));
    assert.ok(calls[0].includes('dev'));
    assert.ok(calls[0].includes('--sandbox'));
    assert.ok(calls[0].includes('workspace-write'));
    assert.ok(calls[0].includes('--image-files'));
    assert.ok(calls[0].includes(resolve(dir, 'fixtures/a.png') + ',' + resolve(dir, 'fixtures/b.webp')));
    assert.ok(calls[0].includes('--full-auto'));
    assert.ok(calls[0].includes('true'));
    assert.ok(calls[0].includes('--session-name'));
    assert.ok(calls[0].includes('codex-live-session'));
  });

  it('builds prompt-wrapper lane args when tool=prompt-wrapper', async () => {
    const dir = tmpLaneDir();
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/wrapper',
      guardrailRepo: '.',
      workingDir: '.',
      tool: 'prompt-wrapper',
      sessionName: 'wrapper-live-session',
      sessionId: 'wrapper-live-session-1',
      wrapperCommand: './scripts/fake-wrapper.js',
      wrapperArgs: 'mode=review,fast',
      systemPrompt: 'Stay terse.',
      inputFiles: 'docs/one.md,docs/two.md',
    }, dir);

    const calls = [];
    const runner = async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: 'done\n', stderr: '' };
    };

    await runGenericLaneRequest(options, { id: 'req-1', prompt: 'review this' }, { startedConversation: false }, { runner });

    assert.equal(calls[0].command, resolve(dir, 'scripts/fake-wrapper.js'));
    assert.ok(calls[0].args.includes('--prompt'));
    assert.ok(calls[0].args.includes('review this'));
    assert.ok(calls[0].args.includes('--session-name'));
    assert.ok(calls[0].args.includes('wrapper-live-session'));
    assert.ok(calls[0].args.includes('--input-files'));
    assert.ok(calls[0].args.includes('docs/one.md,docs/two.md'));
    assert.ok(calls[0].args.includes('--system-prompt'));
    assert.ok(calls[0].args.includes('Stay terse.'));
  });

  it('builds local-exec lane args when tool=local-exec', async () => {
    const dir = tmpLaneDir();
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/local-exec',
      guardrailRepo: '.',
      workingDir: '.',
      tool: 'local-exec',
      sessionName: 'local-exec-live',
      sessionId: 'local-exec-live-1',
      command: 'node',
      commandArgs: ['scripts/echo-prompt.js', '--mode', 'review'],
      resources: ['branch:main'],
      resourceMode: 'block',
    }, dir);

    const calls = [];
    const runner = async (spawnOptions, prompt) => {
      calls.push({ spawnOptions, prompt });
      return { code: 0, stdout: `ECHO:${prompt}\n`, stderr: '' };
    };

    const result = await runGenericLaneRequest(
      options,
      { id: 'req-1', prompt: 'review this' },
      { startedConversation: false },
      { runner },
    );

    assert.equal(calls[0].spawnOptions.command, 'node');
    assert.deepEqual(calls[0].spawnOptions.commandArgs, ['scripts/echo-prompt.js', '--mode', 'review']);
    assert.equal(calls[0].prompt, 'review this');
    assert.equal(result.stdout, 'ECHO:review this\n');
  });

  it('builds ssh prompt-wrapper lane args when tool=ssh-prompt-wrapper', async () => {
    const dir = tmpLaneDir();
    const options = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/ssh-wrapper',
      guardrailRepo: '.',
      workingDir: '.',
      tool: 'ssh-prompt-wrapper',
      sessionName: 'ssh-wrapper-live',
      sessionId: 'ssh-wrapper-live-1',
      sshTarget: 'build@staging.example.com',
      sshArgs: ['-i', '~/.ssh/id_ed25519'],
      remoteWorkingDir: '/srv/app',
      wrapperCommand: 'guarded-wrapper',
      wrapperArgs: 'mode=review',
      systemPrompt: 'Stay terse.',
    }, dir);

    const calls = [];
    const runner = async (spawnOptions, request, lifecycle) => {
      calls.push({ spawnOptions, request, lifecycle });
      return { code: 0, stdout: 'done\n', stderr: '' };
    };

    await runGenericLaneRequest(options, { id: 'req-1', prompt: 'review this' }, { startedConversation: false }, { runner });

    assert.equal(calls[0].spawnOptions.sshTarget, 'build@staging.example.com');
    assert.deepEqual(calls[0].spawnOptions.sshArgs, ['-i', '~/.ssh/id_ed25519']);
    assert.equal(calls[0].spawnOptions.remoteWorkingDir, '/srv/app');
    assert.equal(calls[0].spawnOptions.wrapperCommand, 'guarded-wrapper');
    assert.equal(calls[0].lifecycle, 'start');
  });

  it('lists bundled resident lane adapters beyond Claude/Codex', () => {
    const adapters = listResidentLaneAdapters();
    const ids = adapters.map((adapter) => adapter.id).sort();

    assert.ok(ids.includes('claude'));
    assert.ok(ids.includes('codex'));
    assert.ok(ids.includes('local-exec'));
    assert.ok(ids.includes('prompt-wrapper'));
    assert.ok(ids.includes('ssh-prompt-wrapper'));
    assert.ok(adapters.every((adapter) => adapter.source === 'bundled'));
  });

  it('canonicalizes branch aliases and auto-discovers git branch resources', () => {
    const dir = tmpLaneDir();
    mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const explicit = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/local-exec',
      guardrailRepo: '.',
      workingDir: '.',
      tool: 'local-exec',
      sessionName: 'local-exec-live',
      command: 'node',
      commandArgs: ['scripts/echo.js'],
      resources: ['branch:main', 'service:postgres'],
    }, dir);

    assert.deepEqual(explicit.resources, ['git-branch:main', 'service:postgres']);
    assert.equal(explicit.resourceDetails[0].className, 'git-branch');
    assert.equal(explicit.resourceDetails[0].source, 'explicit');

    const discovered = normalizeGenericResidentLaneOptions({
      laneDir: '.guardrail/lanes/local-exec',
      guardrailRepo: '.',
      workingDir: '.',
      tool: 'local-exec',
      sessionName: 'local-exec-live',
      command: 'node',
      commandArgs: ['scripts/echo.js'],
    }, dir);

    assert.ok(discovered.resources.includes('git-branch:main'));
    assert.ok(discovered.resourceDetails.some((detail) => detail.raw === 'git-branch:main' && detail.source === 'discovered'));
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

  it('fails closed when another live lane with the same lane id already exists in the repo registry', async () => {
    const dir = tmpLaneDir();
    const existingLaneDir = join(dir, '.guardrail', 'lanes', 'math-a');
    mkdirSync(existingLaneDir, { recursive: true });
    const existingPaths = lanePaths(existingLaneDir);
    mkfifo(existingPaths.requestFifo);
    mkfifo(existingPaths.responseFifo);
    writeFileSync(existingPaths.identityPath, JSON.stringify({
      laneId: 'math-live',
      laneDir: existingLaneDir,
      guardrailRepo: dir,
      identityNonce: 'nonce-a',
      keyPath: join(dir, 'lane-a.key'),
    }), 'utf8');
    writeFileSync(existingPaths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math-live',
      sessionName: 'math-live',
      identityNonce: 'nonce-a',
      bootNonce: 'boot-a',
      requestFifo: existingPaths.requestFifo,
      responseFifo: existingPaths.responseFifo,
    }), 'utf8');

    await assert.rejects(() => launchResidentLane({
      laneDir: join(dir, '.guardrail', 'lanes', 'math-b'),
      guardrailRepo: dir,
      workingDir: dir,
      laneId: 'math-live',
      sessionName: 'math-live',
      keyPath: join(dir, 'host-keys', 'repo-a', 'math-live.key'),
      hostStateDir: join(dir, 'host-keys'),
    }), /Duplicate live resident lane/);
  });

  it('fails closed when another live lane with the same lane id is claimed from a different repo host registry', async () => {
    const dir = tmpLaneDir();
    const hostStateDir = join(dir, 'host-state');
    const laneId = 'shared-live';
    const keyPath = join(hostStateDir, 'repo-a', `${laneId}.key`);
    const remoteLaneDir = join(dir, 'other-repo', '.guardrail', 'lanes', laneId);
    const registryEntryPath = join(
      hostStateDir,
      'resident-lanes',
      `${createHash('sha256').update(resolve(remoteLaneDir)).digest('hex').slice(0, 24)}.json`,
    );
    mkdirSync(join(hostStateDir, 'resident-lanes'), { recursive: true });
    writeFileSync(registryEntryPath, JSON.stringify({
      laneId,
      laneDir: remoteLaneDir,
      guardrailRepo: join(dir, 'other-repo'),
      ownerRepoId: 'other-repo-id',
      pid: process.pid,
      bootNonce: 'boot-other',
      resourceMode: 'block',
      resources: ['service:postgres'],
      updatedAt: new Date().toISOString(),
    }), 'utf8');

    await assert.rejects(
      launchResidentLane({
        laneDir: join(dir, '.guardrail', 'lanes', 'math-b'),
        guardrailRepo: dir,
        workingDir: dir,
        laneId,
        sessionName: laneId,
        keyPath,
        hostStateDir,
        resources: ['service:postgres'],
        resourceMode: 'warn',
      }),
      (err) => err?.code === 'LANE_BOOT_FAILED' && /Duplicate live resident lane/.test(err?.message || ''),
    );
  });

  it('fails closed when a startup lock already exists for the requested lane', async () => {
    const dir = tmpLaneDir();
    const laneId = 'math-live';
    const hostStateDir = join(dir, 'host-state');
    const keyPath = join(hostStateDir, 'repo-a', `${laneId}.key`);
    const targetLaneDir = join(dir, '.guardrail', 'lanes', 'math-b');
    const startupKey = createHash('sha256')
      .update(`resident-lane-start:${laneId}`)
      .digest('hex');
    const startupStateDir = join(targetLaneDir, '.startup-locks');
    const lock = acquireLock(startupKey, [], startupStateDir, 30_000);
    assert.equal(lock.acquired, true);

    try {
      await assert.rejects(
        launchResidentLane({
          laneDir: targetLaneDir,
          guardrailRepo: dir,
          workingDir: dir,
          laneId,
          sessionName: laneId,
          keyPath,
          hostStateDir,
        }),
        (err) => err?.code === 'LANE_BOOT_FAILED' && /(already starting this resident lane|Duplicate live resident lane)/.test(err?.message || ''),
      );
    } finally {
      lock.release?.();
    }
  });

  it('blocks lane startup when the requested write scope overlaps a live block-owned lane', async () => {
    const dir = tmpLaneDir();
    const existingLaneDir = join(dir, '.guardrail', 'lanes', 'math-a');
    mkdirSync(existingLaneDir, { recursive: true });
    const existingPaths = lanePaths(existingLaneDir);
    mkfifo(existingPaths.requestFifo);
    mkfifo(existingPaths.responseFifo);
    writeFileSync(existingPaths.identityPath, JSON.stringify({
      laneId: 'math-a',
      laneDir: existingLaneDir,
      guardrailRepo: dir,
      identityNonce: 'nonce-a',
      scopeType: 'paths',
      scopeMode: 'block',
      scopePaths: ['src'],
    }), 'utf8');
    writeFileSync(existingPaths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math-a',
      sessionName: 'math-a',
      scopeType: 'paths',
      scopeMode: 'block',
      scopePaths: ['src'],
      requestFifo: existingPaths.requestFifo,
      responseFifo: existingPaths.responseFifo,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    await assert.rejects(
      launchResidentLane({
        laneDir: join(dir, '.guardrail', 'lanes', 'math-b'),
        guardrailRepo: dir,
        workingDir: dir,
        sessionName: 'math-b',
        scopeType: 'paths',
        scopeMode: 'warn',
        scopePaths: ['src/utils'],
      }, {
        spawnProcess: () => {
          throw new Error('spawn should not be reached for blocked scope conflicts');
        },
      }),
      (err) => err?.code === 'LANE_BOOT_FAILED' && err?.details?.scopeConflicts?.length === 1,
    );
  });

  it('returns scope conflict warnings in the launch summary when overlapping lanes are warn-only', async () => {
    const dir = tmpLaneDir();
    const hostStateDir = join(dir, 'host-keys');
    const existingLaneDir = join(dir, '.guardrail', 'lanes', 'math-a');
    mkdirSync(existingLaneDir, { recursive: true });
    const existingPaths = lanePaths(existingLaneDir);
    mkfifo(existingPaths.requestFifo);
    mkfifo(existingPaths.responseFifo);
    writeFileSync(existingPaths.identityPath, JSON.stringify({
      laneId: 'math-a',
      laneDir: existingLaneDir,
      guardrailRepo: dir,
      identityNonce: 'nonce-a',
      scopeType: 'paths',
      scopeMode: 'warn',
      scopePaths: ['docs'],
    }), 'utf8');
    writeFileSync(existingPaths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math-a',
      sessionName: 'math-a',
      scopeType: 'paths',
      scopeMode: 'warn',
      scopePaths: ['docs'],
      requestFifo: existingPaths.requestFifo,
      responseFifo: existingPaths.responseFifo,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const fakeChild = makeFakeLaunchHelper(515151);
    const summary = await launchResidentLane({
      laneDir: join(dir, '.guardrail', 'lanes', 'math-b'),
      guardrailRepo: dir,
      hostStateDir,
      workingDir: dir,
      sessionName: 'math-b',
      scopeType: 'paths',
      scopeMode: 'warn',
      scopePaths: ['docs/api'],
    }, {
      spawnProcess: () => fakeChild,
      waitForBootstrap: waitForResidentLaneBootstrap,
      waitForBootstrapDeps: {
        timeoutMs: 500,
        postStartGraceMs: 50,
        isAlive: () => true,
        readState: () => ({
          pid: 515151,
          status: 'ready',
          sessionName: 'math-b',
          scopeType: 'paths',
          scopeMode: 'warn',
          scopePaths: ['docs/api'],
          lastActivityAt: new Date().toISOString(),
        }),
      },
    });

    assert.equal(summary.scopeType, 'paths');
    assert.deepEqual(summary.scopePaths, ['docs/api']);
    assert.equal(summary.scopeConflicts.length, 1);
    assert.equal(summary.scopeConflicts[0].laneId, 'math-a');
    assert.equal(summary.scopeConflicts[0].enforcement, 'warn');
  });

  it('blocks lane startup when requested resource claims overlap a block-owned live lane', async () => {
    const dir = tmpLaneDir();
    const hostStateDir = join(dir, 'host-keys');
    const existingLaneDir = join(dir, '.guardrail', 'lanes', 'resource-a');
    mkdirSync(existingLaneDir, { recursive: true });
    const existingPaths = lanePaths(existingLaneDir);
    mkfifo(existingPaths.requestFifo);
    mkfifo(existingPaths.responseFifo);
    writeFileSync(existingPaths.identityPath, JSON.stringify({
      laneId: 'resource-a',
      laneDir: existingLaneDir,
      guardrailRepo: dir,
      identityNonce: 'nonce-a',
      resourceMode: 'block',
      resources: ['git-branch:main'],
    }), 'utf8');
    writeFileSync(existingPaths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'resource-a',
      sessionName: 'resource-a',
      resourceMode: 'block',
      resources: ['git-branch:main'],
      requestFifo: existingPaths.requestFifo,
      responseFifo: existingPaths.responseFifo,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    await assert.rejects(
      launchResidentLane({
        laneDir: join(dir, '.guardrail', 'lanes', 'resource-b'),
        guardrailRepo: dir,
        hostStateDir,
        workingDir: dir,
        sessionName: 'resource-b',
        resources: ['git-branch:main'],
        resourceMode: 'warn',
      }, {
        spawnProcess: () => {
          throw new Error('spawn should not be reached for blocked resource conflicts');
        },
      }),
      (err) => err?.code === 'LANE_BOOT_FAILED' && err?.details?.resourceConflicts?.length === 1,
    );
  });

  it('filters resident lanes by resource claims and reports resource conflicts', () => {
    const dir = tmpLaneDir();
    const lanesDir = join(dir, '.guardrail', 'lanes');
    const laneADir = join(lanesDir, 'resource-a');
    const laneBDir = join(lanesDir, 'resource-b');
    mkdirSync(laneADir, { recursive: true });
    mkdirSync(laneBDir, { recursive: true });
    const pathsA = lanePaths(laneADir);
    const pathsB = lanePaths(laneBDir);
    mkfifo(pathsA.requestFifo);
    mkfifo(pathsA.responseFifo);
    mkfifo(pathsB.requestFifo);
    mkfifo(pathsB.responseFifo);
    writeFileSync(pathsA.identityPath, JSON.stringify({
      laneId: 'resource-a',
      laneDir: laneADir,
      guardrailRepo: dir,
      identityNonce: 'nonce-a',
      resourceMode: 'warn',
      resources: ['service:postgres'],
    }), 'utf8');
    writeFileSync(pathsB.identityPath, JSON.stringify({
      laneId: 'resource-b',
      laneDir: laneBDir,
      guardrailRepo: dir,
      identityNonce: 'nonce-b',
      resourceMode: 'block',
      resources: ['service:postgres'],
    }), 'utf8');
    writeFileSync(pathsA.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'resource-a',
      sessionName: 'resource-a',
      resourceMode: 'warn',
      resources: ['service:postgres'],
      requestFifo: pathsA.requestFifo,
      responseFifo: pathsA.responseFifo,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');
    writeFileSync(pathsB.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'resource-b',
      sessionName: 'resource-b',
      resourceMode: 'block',
      resources: ['service:postgres'],
      requestFifo: pathsB.requestFifo,
      responseFifo: pathsB.responseFifo,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const listing = listResidentLanes({
      guardrailRepo: dir,
      resourceFilter: 'service:postgres',
      hasConflicts: true,
    });

    assert.equal(listing.lanes.length, 2);
    assert.equal(listing.lanes[0].resourceConflicts.length, 1);
    assert.equal(listing.lanes[0].resourceConflicts[0].laneId, 'resource-b');
  });

  it('lists host-registry lanes across repos when allRepos is enabled', () => {
    const dir = tmpLaneDir();
    const hostStateDir = join(dir, 'host-keys');
    const localLaneDir = join(dir, '.guardrail', 'lanes', 'resource-local');
    mkdirSync(localLaneDir, { recursive: true });
    const localPaths = lanePaths(localLaneDir);
    mkfifo(localPaths.requestFifo);
    mkfifo(localPaths.responseFifo);
    writeFileSync(localPaths.identityPath, JSON.stringify({
      laneId: 'resource-local',
      laneDir: localLaneDir,
      guardrailRepo: dir,
      identityNonce: 'nonce-local',
      resourceMode: 'warn',
      resources: ['service:postgres'],
    }), 'utf8');
    writeFileSync(localPaths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'resource-local',
      sessionName: 'resource-local',
      resourceMode: 'warn',
      resources: ['service:postgres'],
      requestFifo: localPaths.requestFifo,
      responseFifo: localPaths.responseFifo,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const externalLaneDir = join(dir, 'other-repo', '.guardrail', 'lanes', 'resource-external');
    const externalRegistryDir = join(hostStateDir, 'resident-lanes');
    mkdirSync(externalRegistryDir, { recursive: true });
    const externalRegistryKey = createHash('sha256')
      .update(resolve(externalLaneDir))
      .digest('hex')
      .slice(0, 24);
    writeFileSync(join(externalRegistryDir, `${externalRegistryKey}.json`), JSON.stringify({
      laneId: 'resource-external',
      laneDir: externalLaneDir,
      guardrailRepo: join(dir, 'other-repo'),
      ownerRepoId: 'other-repo-id',
      tool: 'codex',
      sessionName: 'resource-external',
      resourceMode: 'block',
      resources: ['service:postgres'],
      pid: process.pid,
      status: 'ready',
      updatedAt: new Date().toISOString(),
    }), 'utf8');

    const listing = listResidentLanes({
      guardrailRepo: dir,
      hostStateDir,
      allRepos: true,
      resourceFilter: 'service:postgres',
    });
    const status = getResidentLaneStatus({
      guardrailRepo: dir,
      laneDir: localLaneDir,
      hostStateDir,
    });

    assert.equal(listing.lanes.length, 2);
    assert.ok(listing.lanes.some((lane) => lane.laneId === 'resource-external'));
    assert.equal(status.resourceConflicts.length, 1);
    assert.equal(status.resourceConflicts[0].laneId, 'resource-external');
    assert.ok(status.resourceConflicts[0].guardrailRepo.endsWith('other-repo'));
  });

  it('does not treat git-branch resources from different repos as conflicting', () => {
    const dir = tmpLaneDir();
    const hostStateDir = join(dir, 'host-keys');
    const localLaneDir = join(dir, '.guardrail', 'lanes', 'branch-local');
    mkdirSync(localLaneDir, { recursive: true });
    const localPaths = lanePaths(localLaneDir);
    mkfifo(localPaths.requestFifo);
    mkfifo(localPaths.responseFifo);
    writeFileSync(localPaths.identityPath, JSON.stringify({
      laneId: 'branch-local',
      laneDir: localLaneDir,
      guardrailRepo: dir,
      ownerRepoId: 'repo-a',
      identityNonce: 'nonce-local',
      resourceMode: 'warn',
      resources: ['git-branch:main'],
      resourceDetails: [{ raw: 'git-branch:main', className: 'git-branch', name: 'main', scope: 'repo', source: 'explicit' }],
    }), 'utf8');
    writeFileSync(localPaths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'branch-local',
      sessionName: 'branch-local',
      ownerRepoId: 'repo-a',
      resourceMode: 'warn',
      resources: ['git-branch:main'],
      resourceDetails: [{ raw: 'git-branch:main', className: 'git-branch', name: 'main', scope: 'repo', source: 'explicit' }],
      requestFifo: localPaths.requestFifo,
      responseFifo: localPaths.responseFifo,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const externalLaneDir = join(dir, 'other-repo', '.guardrail', 'lanes', 'branch-external');
    const externalRegistryDir = join(hostStateDir, 'resident-lanes');
    mkdirSync(externalRegistryDir, { recursive: true });
    const externalRegistryKey = createHash('sha256')
      .update(resolve(externalLaneDir))
      .digest('hex')
      .slice(0, 24);
    writeFileSync(join(externalRegistryDir, `${externalRegistryKey}.json`), JSON.stringify({
      laneId: 'branch-external',
      laneDir: externalLaneDir,
      guardrailRepo: join(dir, 'other-repo'),
      ownerRepoId: 'repo-b',
      tool: 'codex',
      sessionName: 'branch-external',
      resourceMode: 'block',
      resources: ['git-branch:main'],
      resourceDetails: [{ raw: 'git-branch:main', className: 'git-branch', name: 'main', scope: 'repo', source: 'explicit' }],
      pid: process.pid,
      status: 'ready',
      updatedAt: new Date().toISOString(),
    }), 'utf8');

    const status = getResidentLaneStatus({
      guardrailRepo: dir,
      laneDir: localLaneDir,
      hostStateDir,
    });

    assert.equal(status.resourceConflicts.length, 0);
  });

  it('lists resident lanes from the project lane registry', () => {
    const dir = tmpLaneDir();
    const readyLaneDir = join(dir, '.guardrail', 'lanes', 'math-ready');
    const staleLaneDir = join(dir, '.guardrail', 'lanes', 'math-stale');
    mkdirSync(readyLaneDir, { recursive: true });
    mkdirSync(staleLaneDir, { recursive: true });
    const readyPaths = lanePaths(readyLaneDir);
    const stalePaths = lanePaths(staleLaneDir);
    mkfifo(readyPaths.requestFifo);
    mkfifo(readyPaths.responseFifo);
    writeFileSync(readyPaths.identityPath, JSON.stringify({
      laneId: 'math-ready',
      laneDir: readyLaneDir,
      guardrailRepo: dir,
      keyPath: join(dir, 'ready.key'),
      identityNonce: 'nonce-ready',
    }), 'utf8');
    writeFileSync(stalePaths.identityPath, JSON.stringify({
      laneId: 'math-stale',
      laneDir: staleLaneDir,
      guardrailRepo: dir,
      identityNonce: 'nonce-stale',
    }), 'utf8');
    writeFileSync(readyPaths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math-ready',
      sessionName: 'math-ready',
      keyPath: join(dir, 'ready.key'),
      identityNonce: 'nonce-ready',
      bootNonce: 'boot-ready',
      requestFifo: readyPaths.requestFifo,
      responseFifo: readyPaths.responseFifo,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const listing = listResidentLanes({ guardrailRepo: dir });
    assert.equal(listing.lanes.length, 2);
    assert.equal(listing.counts.ready, 1);
    assert.equal(listing.counts.stale, 1);
    assert.equal(listing.lanes.find((lane) => lane.laneId === 'math-ready')?.identityNonce, 'nonce-ready');
  });

  it('filters resident lanes by status and conflict state', () => {
    const dir = tmpLaneDir();
    const readyLaneDir = join(dir, '.guardrail', 'lanes', 'math-ready');
    const conflictedLaneDir = join(dir, '.guardrail', 'lanes', 'math-conflicted');
    mkdirSync(readyLaneDir, { recursive: true });
    mkdirSync(conflictedLaneDir, { recursive: true });
    const readyPaths = lanePaths(readyLaneDir);
    const conflictedPaths = lanePaths(conflictedLaneDir);
    mkfifo(readyPaths.requestFifo);
    mkfifo(readyPaths.responseFifo);
    mkfifo(conflictedPaths.requestFifo);
    mkfifo(conflictedPaths.responseFifo);
    const sharedScope = ['docs/api'];
    writeFileSync(readyPaths.identityPath, JSON.stringify({
      laneId: 'math-ready',
      laneDir: readyLaneDir,
      guardrailRepo: dir,
      keyPath: join(dir, 'ready.key'),
      identityNonce: 'nonce-ready',
      tool: 'claude',
      scopeType: 'paths',
      scopeMode: 'warn',
      scopePaths: sharedScope,
    }), 'utf8');
    writeFileSync(conflictedPaths.identityPath, JSON.stringify({
      laneId: 'math-conflicted',
      laneDir: conflictedLaneDir,
      guardrailRepo: dir,
      keyPath: join(dir, 'conflicted.key'),
      identityNonce: 'nonce-conflicted',
      tool: 'codex',
      scopeType: 'paths',
      scopeMode: 'block',
      scopePaths: sharedScope,
    }), 'utf8');
    writeFileSync(readyPaths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math-ready',
      sessionName: 'math-ready',
      keyPath: join(dir, 'ready.key'),
      identityNonce: 'nonce-ready',
      bootNonce: 'boot-ready',
      tool: 'claude',
      scopeType: 'paths',
      scopeMode: 'warn',
      scopePaths: sharedScope,
      requestFifo: readyPaths.requestFifo,
      responseFifo: readyPaths.responseFifo,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');
    writeFileSync(conflictedPaths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math-conflicted',
      sessionName: 'math-conflicted',
      keyPath: join(dir, 'conflicted.key'),
      identityNonce: 'nonce-conflicted',
      bootNonce: 'boot-conflicted',
      tool: 'codex',
      scopeType: 'paths',
      scopeMode: 'block',
      scopePaths: sharedScope,
      requestFifo: conflictedPaths.requestFifo,
      responseFifo: conflictedPaths.responseFifo,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const listing = listResidentLanes({
      guardrailRepo: dir,
      status: 'ready',
      toolFilter: 'codex',
      hasConflicts: true,
    });
    assert.equal(listing.lanes.length, 1);
    assert.equal(listing.lanes[0].laneId, 'math-conflicted');
    assert.equal(listing.counts.ready, 1);
  });

  it('prunes stale and stopped lanes while leaving failed lanes unless explicitly included', () => {
    const dir = tmpLaneDir();
    const staleLaneDir = join(dir, '.guardrail', 'lanes', 'math-stale');
    const failedLaneDir = join(dir, '.guardrail', 'lanes', 'math-failed');
    mkdirSync(staleLaneDir, { recursive: true });
    mkdirSync(failedLaneDir, { recursive: true });
    const stalePaths = lanePaths(staleLaneDir);
    const failedPaths = lanePaths(failedLaneDir);
    writeFileSync(stalePaths.identityPath, JSON.stringify({
      laneId: 'math-stale',
      laneDir: staleLaneDir,
      guardrailRepo: dir,
      keyPath: join(dir, 'stale.key'),
      identityNonce: 'nonce-stale',
    }), 'utf8');
    writeFileSync(failedPaths.identityPath, JSON.stringify({
      laneId: 'math-failed',
      laneDir: failedLaneDir,
      guardrailRepo: dir,
      keyPath: join(dir, 'failed.key'),
      identityNonce: 'nonce-failed',
    }), 'utf8');
    writeFileSync(stalePaths.statePath, JSON.stringify({
      pid: 12345,
      status: 'stale',
      laneId: 'math-stale',
      sessionName: 'math-stale',
    }), 'utf8');
    writeFileSync(failedPaths.statePath, JSON.stringify({
      pid: 12345,
      status: 'failed',
      laneId: 'math-failed',
      sessionName: 'math-failed',
      failureReason: 'boom',
      failureStage: 'runtime',
    }), 'utf8');
    writeFileSync(join(dir, 'stale.key'), 'secret\n', 'utf8');
    writeFileSync(join(dir, 'failed.key'), 'secret\n', 'utf8');

    const result = pruneResidentLanes({ guardrailRepo: dir });
    assert.equal(result.pruned.length, 1);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.pruned[0].laneId, 'math-stale');
    assert.equal(result.pruned[0].cleanupReason, 'dead_artifacts_present');
    assert.equal(existsSync(result.pruned[0].tombstonePath), true);
    assert.equal(existsSync(staleLaneDir), false);
    assert.equal(existsSync(failedLaneDir), true);
  });

  it('supports prune dry-run classification without deleting lane artifacts', () => {
    const dir = tmpLaneDir();
    const staleLaneDir = join(dir, '.guardrail', 'lanes', 'math-stale');
    mkdirSync(staleLaneDir, { recursive: true });
    const stalePaths = lanePaths(staleLaneDir);
    writeFileSync(stalePaths.identityPath, JSON.stringify({
      laneId: 'math-stale',
      laneDir: staleLaneDir,
      guardrailRepo: dir,
      keyPath: join(dir, 'stale.key'),
      identityNonce: 'nonce-stale',
    }), 'utf8');
    writeFileSync(stalePaths.statePath, JSON.stringify({
      pid: 12345,
      status: 'stale',
      laneId: 'math-stale',
      sessionName: 'math-stale',
    }), 'utf8');
    writeFileSync(join(dir, 'stale.key'), 'secret\n', 'utf8');

    const result = pruneResidentLanes({ guardrailRepo: dir, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].laneId, 'math-stale');
    assert.equal(result.candidates[0].reason, 'dead_artifacts_present');
    assert.equal(result.pruned.length, 0);
    assert.equal(existsSync(staleLaneDir), true);
    assert.equal(existsSync(join(dir, 'stale.key')), true);
    assert.equal(existsSync(join(dir, '.guardrail', 'lane-tombstones')), false);
  });

  it('treats EPERM pid probes as alive when checking resident lane status', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);
    const keyPath = join(dir, 'lane.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(paths.statePath, JSON.stringify({
      pid: 424242,
      status: 'ready',
      sessionName: 'math-live-session',
      sessionId: 'math-live-session-1',
      workingDir: dir,
      requestFifo: paths.requestFifo,
      responseFifo: paths.responseFifo,
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }), 'utf8');

    const originalKill = process.kill;
    process.kill = ((pid, signal) => {
      if (pid === 424242 && signal === 0) {
        const err = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return originalKill(pid, signal);
    });

    try {
      const status = getResidentLaneStatus({ laneDir, keyPath, guardrailRepo: dir });
      assert.equal(status.status, 'ready');
      assert.equal(status.alive, true);
      assert.equal(status.failureReason, null);
    } finally {
      process.kill = originalKill;
    }
  });

  it('fails lane startup when the daemon exits during bootstrap and records a failed state', async () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    const fakeChild = makeFakeLaunchHelper(424242);

    await assert.rejects(
      launchResidentLane({
        laneDir,
        guardrailRepo: dir,
        workingDir: dir,
        sessionName: 'math-live-session',
      }, {
        spawnProcess: () => fakeChild,
        waitForBootstrap: waitForResidentLaneBootstrap,
        waitForBootstrapDeps: {
          timeoutMs: 250,
          isAlive: () => false,
          readLogTail: () => 'bootstrap crashed',
        },
      }),
      (err) => err?.code === 'LANE_BOOT_FAILED',
    );

    const status = getResidentLaneStatus({ laneDir, guardrailRepo: dir });
    assert.equal(status.status, 'failed');
    assert.equal(status.failureStage, 'bootstrap');
    assert.match(status.failureReason, /bootstrap/);
  });

  it('persists auth preflight failure state before the first packet is accepted', async () => {
    const dir = tmpLaneDir();
    const options = normalizeResidentLaneOptions({
      laneDir: '.guardrail/lanes/math',
      guardrailRepo: dir,
      workingDir: dir,
      sessionName: 'math-live-session',
    }, dir);

    await assert.rejects(
      runResidentLaneDaemon(options, {
        adapterId: 'claude',
        async preflightDaemon() {
          return {
            ok: false,
            source: 'keychain',
            checkedAt: '2026-04-12T00:00:00.000Z',
            reason: 'auth_preflight_failed',
            message: 'Claude auth preflight failed for resident lane (keychain): Not logged in',
          };
        },
      }),
      (err) => err?.code === 'LANE_BOOT_FAILED' && err?.details?.failureStage === 'auth_preflight',
    );

    const status = getResidentLaneStatus({ laneDir: options.laneDir, guardrailRepo: dir });
    assert.equal(status.status, 'failed');
    assert.equal(status.failureStage, 'auth_preflight');
    assert.equal(status.authSource, 'keychain');
    assert.equal(status.authPreflightStatus, 'failed');
    assert.equal(status.authPreflightReason, 'auth_preflight_failed');
    assert.match(status.authPreflightMessage, /Not logged in/);
  });

  it('fails lane startup when the daemon dies in the immediate post-start window', async () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    const fakeChild = makeFakeLaunchHelper(434343);
    let alive = true;
    setTimeout(() => {
      alive = false;
    }, 500);

    await assert.rejects(
      launchResidentLane({
        laneDir,
        guardrailRepo: dir,
        workingDir: dir,
        sessionName: 'math-live-session',
      }, {
        spawnProcess: () => fakeChild,
        waitForBootstrap: waitForResidentLaneBootstrap,
        waitForBootstrapDeps: {
          timeoutMs: 2000,
          postStartGraceMs: 800,
          isAlive: () => alive,
          readState: () => ({
            pid: 434343,
            status: 'ready',
            sessionName: 'math-live-session',
            lastActivityAt: new Date().toISOString(),
          }),
          readLogTail: () => 'post-start crashed',
        },
      }),
      /post-start crashed/,
    );

    const status = getResidentLaneStatus({ laneDir, guardrailRepo: dir });
    assert.equal(status.status, 'failed');
    assert.equal(status.failureStage, 'post_start');
  });

  it('keeps a launched resident lane alive across SIGHUP', async () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    const keyPath = join(dir, 'lane.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    const keyFd = openSync(keyPath, 'r');

    const summary = await launchLocalExecLane({
      laneDir,
      guardrailRepo: dir,
      workingDir: dir,
      keyPath,
      authFd: keyFd,
      sessionName: 'math-live-session',
      command: 'node',
      commandArgs: ['-e', 'process.stdin.resume()'],
    });

    try {
      process.kill(summary.pid, 'SIGHUP');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      const status = getResidentLaneStatus({ laneDir, guardrailRepo: dir, keyPath });
      assert.equal(status.status, 'ready');
      assert.equal(status.alive, true);
    } finally {
      closeSync(keyFd);
      stopResidentLane({ laneDir, guardrailRepo: dir, keyPath, sessionName: 'math-live-session' });
    }
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

  it('sends report-artifact and completion-mode metadata over the resident lane FIFOs', async () => {
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
          throw new Error('Timed out waiting for FIFO request metadata');
        }
        try {
          const bytesRead = readSync(requestFd, chunk, 0, chunk.length, null);
          if (bytesRead > 0) {
            buffer += chunk.toString('utf8', 0, bytesRead);
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex >= 0) {
              const request = JSON.parse(buffer.slice(0, newlineIndex));
              assert.equal(request.reportArtifact, 'docs/plans/REPORT_demo.md');
              assert.equal(request.completionMode, 'artifact');
              writeSync(responseFd, `${JSON.stringify({ requestId: request.id, ok: true, stdout: 'ok\n' })}\n`, undefined, 'utf8');
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
        '--request-id', 'req-meta',
        '--prompt', 'do work',
        '--report-artifact', 'docs/plans/REPORT_demo.md',
        '--completion-mode', 'artifact',
      ]);
      const [response] = await Promise.all([responsePromise, serverDone]);
      assert.equal(response.ok, true);
      assert.equal(response.stdout, 'ok\n');
    } finally {
      closeSync(requestFd);
      closeSync(responseFd);
    }
  });

  it('signs and validates requests with an inherited auth fd secret', async () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);

    const secretPath = join(dir, 'lane.secret');
    writeFileSync(secretPath, 'resident-secret\n', 'utf8');
    const secretFd = openSync(secretPath, fsConstants.O_RDONLY);

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
              const request = JSON.parse(buffer.slice(0, newlineIndex));
              assert.equal(
                request.signature,
                signLaneRequest({
                  id: request.id,
                  prompt: request.prompt,
                  reportArtifact: request.reportArtifact || '',
                  completionMode: request.completionMode || '',
                }, 'resident-secret'),
              );
              assert.doesNotThrow(() => validateLaneRequest(request, 'resident-secret'));
              writeSync(responseFd, `${JSON.stringify({ requestId: request.id, ok: true, stdout: '25\n' })}\n`, undefined, 'utf8');
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
        '--request-id', 'req-signed',
        '--prompt', '5x5=?',
        '--report-artifact', 'docs/plans/REPORT_signed.md',
        '--completion-mode', 'artifact',
        '--auth-fd', String(secretFd),
      ]);
      const [response] = await Promise.all([responsePromise, serverDone]);
      assert.equal(response.ok, true);
      assert.equal(response.stdout, '25\n');
    } finally {
      closeSync(secretFd);
      closeSync(requestFd);
      closeSync(responseFd);
    }
  });

  it('returns a distinct timeout error when the lane does not answer in time', async () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);

    const requestFd = openSync(paths.requestFifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
    const responseFd = openSync(paths.responseFifo, fsConstants.O_RDWR);

    try {
      await assert.rejects(
        sendResidentLaneMessage([
          '--lane-dir', laneDir,
          '--request-id', 'req-timeout',
          '--prompt', '4x5=?',
          '--timeout-ms', '10',
        ]),
        (err) => err?.code === 'LANE_TIMEOUT' && err?.requestId === 'req-timeout',
      );
    } finally {
      closeSync(requestFd);
      closeSync(responseFd);
    }
  });

  it('rejects duplicate request ids within the same active lane window', () => {
    const seen = new Map();

    assert.doesNotThrow(() => trackLaneRequestId(seen, 'req-1', 1_000, 60_000));
    assert.throws(
      () => trackLaneRequestId(seen, 'req-1', 2_000, 60_000),
      /duplicate_request_id/,
    );

    assert.doesNotThrow(() => trackLaneRequestId(seen, 'req-1', 70_500, 60_000));
  });

  it('stopResidentLane removes FIFO endpoints and key path', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);
    const keyPath = join(dir, 'math.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');

    const result = stopResidentLane({
      laneDir,
      keyPath,
      guardrailRepo: dir,
      laneId: 'math',
    });

    assert.equal(result.stopped, true);
    assert.equal(existsSync(paths.requestFifo), false);
    assert.equal(existsSync(paths.responseFifo), false);
    assert.equal(existsSync(keyPath), false);
  });

  it('reports alive resident lane status with a send recommendation', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);
    const keyPath = join(dir, 'math.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(paths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math',
      tool: 'codex',
      sessionName: 'math-live-session',
      sessionId: 'math-live-session-1',
      lastRequestId: 'req-1',
      lastActivityAt: new Date().toISOString(),
      idleTimeoutMs: 900000,
      pollIntervalMs: 300,
      keyPath,
    }), 'utf8');

    const status = getResidentLaneStatus({ laneDir, keyPath, guardrailRepo: dir, laneId: 'math' });
    assert.equal(status.status, 'ready');
    assert.equal(status.alive, true);
    assert.equal(status.tool, 'codex');
    assert.equal(status.keyPresent, true);
    assert.equal(status.requestFifoPresent, true);
    assert.equal(status.responseFifoPresent, true);
    assert.equal(status.recommendedAction, 'send');
  });

  it('reports busy resident lane status with current request visibility', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    mkfifo(paths.requestFifo);
    mkfifo(paths.responseFifo);
    const keyPath = join(dir, 'math.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(paths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'busy',
      laneId: 'math',
      sessionName: 'math-live-session',
      currentRequestId: 'req-2',
      currentRequestStartedAt: '2026-04-10T00:00:00.000Z',
      lastRequestId: 'req-2',
      lastActivityAt: new Date().toISOString(),
      keyPath,
    }), 'utf8');

    const status = getResidentLaneStatus({ laneDir, keyPath, guardrailRepo: dir, laneId: 'math' });
    assert.equal(status.status, 'busy');
    assert.equal(status.alive, true);
    assert.equal(status.currentRequestId, 'req-2');
    assert.equal(status.currentRequestStartedAt, '2026-04-10T00:00:00.000Z');
    assert.equal(status.recommendedAction, 'result');
  });

  it('returns completed resident lane results from stored result artifacts', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const resultPath = laneResultPath(laneDir, 'req-3');
    mkdirSync(lanePaths(laneDir).resultsDir, { recursive: true });
    writeFileSync(resultPath, JSON.stringify({
      requestId: 'req-3',
      ok: true,
      exitCode: 0,
      stdout: '12\n',
    }), 'utf8');
    writeFileSync(lanePaths(laneDir).statePath, JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math',
      sessionName: 'math-live-session',
      lastRequestId: 'req-3',
      lastCompletedRequestId: 'req-3',
      lastResultPath: resultPath,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const result = getResidentLaneResult({ laneDir, guardrailRepo: dir, laneId: 'math', requestId: 'req-3' });
    assert.equal(result.status, 'completed');
    assert.equal(result.result.stdout, '12\n');
    assert.equal(result.resultPath, resultPath);
  });

  it('rehydrates stale lane status from a newer completed result artifact', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    const resultPath = laneResultPath(laneDir, 'req-5');
    mkdirSync(paths.resultsDir, { recursive: true });
    writeFileSync(resultPath, JSON.stringify({
      requestId: 'req-5',
      ok: true,
      exitCode: 0,
      stdout: 'done\n',
      completedAt: '2026-04-12T07:16:10.727Z',
    }), 'utf8');
    writeFileSync(paths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'stalled',
      laneId: 'math',
      sessionName: 'math-live-session',
      lastRequestId: 'req-5',
      currentRequestId: 'req-5',
      currentRequestStartedAt: '2026-04-12T07:01:21.393Z',
      lastActivityAt: '2026-04-12T07:01:21.517Z',
      currentAiPhase: 'started',
      currentAiMessage: 'Resident lane request accepted.',
    }), 'utf8');

    const status = getResidentLaneStatus({ laneDir, guardrailRepo: dir, laneId: 'math' });
    assert.equal(status.status, 'ready');
    assert.equal(status.currentRequestId, null);
    assert.equal(status.lastCompletedRequestId, 'req-5');
    assert.equal(status.lastResultPath, resultPath);
    assert.equal(status.lastExitCode, 0);
    assert.equal(status.currentAiPhase, null);
  });

  it('returns pending resident lane results while a request is still running', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(lanePaths(laneDir).statePath, JSON.stringify({
      pid: process.pid,
      status: 'busy',
      laneId: 'math',
      sessionName: 'math-live-session',
      lastRequestId: 'req-4',
      currentRequestId: 'req-4',
      currentRequestStartedAt: '2026-04-10T00:00:00.000Z',
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const result = getResidentLaneResult({ laneDir, guardrailRepo: dir, laneId: 'math', requestId: 'req-4' });
    assert.equal(result.status, 'pending');
    assert.equal(result.reason, 'request_still_running');
    assert.equal(result.requestId, 'req-4');
  });

  it('reports expired resident lane status when the key is gone', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    writeFileSync(paths.statePath, JSON.stringify({
      pid: process.pid,
      status: 'expired',
      laneId: 'math',
      sessionName: 'math-live-session',
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const status = getResidentLaneStatus({
      laneDir,
      keyPath: join(dir, 'missing.key'),
      guardrailRepo: dir,
      laneId: 'math',
    });
    assert.equal(status.status, 'expired');
    assert.equal(status.alive, false);
    assert.equal(status.keyPresent, false);
    assert.equal(status.recommendedAction, 'start');
  });

  it('reports failed resident lane status with a failure reason', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(lanePaths(laneDir).statePath, JSON.stringify({
      pid: 12345,
      status: 'failed',
      laneId: 'math',
      sessionName: 'math-live-session',
      failureReason: 'bootstrap crashed',
      failureStage: 'bootstrap',
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const status = getResidentLaneStatus({ laneDir, guardrailRepo: dir, laneId: 'math' });
    assert.equal(status.status, 'failed');
    assert.equal(status.failureReason, 'bootstrap crashed');
    assert.equal(status.failureStage, 'bootstrap');
  });

  it('infers a post-start failure from stale startup state with no recorded failure metadata', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'math');
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(lanePaths(laneDir).statePath, JSON.stringify({
      pid: 12345,
      status: 'ready',
      laneId: 'math',
      sessionName: 'math-live-session',
      startedConversation: false,
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }), 'utf8');

    const status = getResidentLaneStatus({ laneDir, guardrailRepo: dir, laneId: 'math' });
    assert.equal(status.status, 'failed');
    assert.equal(status.failureStage, 'post_start');
    assert.match(status.failureReason, /first request/i);
  });
});

// ===========================================================================
// Lane Emergency Controls (P0h)
// ===========================================================================

describe('Lane emergency controls: revokeResidentLane', () => {
  it('writes status=revoked to state file and creates REVOKED sentinel', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'test-lane');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    writeFileSync(paths.statePath, JSON.stringify({
      pid: 99999,
      status: 'ready',
      laneId: 'test-lane',
      bootNonce: 'abc',
      identityNonce: 'def',
      createdAt: new Date().toISOString(),
    }), 'utf8');

    const result = revokeResidentLane({ laneDir, guardrailRepo: dir, actor: 'ops', reason: 'test-revoke' });
    assert.equal(result.revoked, true);

    const state = JSON.parse(readFileSync(paths.statePath, 'utf8'));
    assert.equal(state.status, 'revoked');
    assert.ok(existsSync(join(laneDir, 'REVOKED')));
  });

  it('revokeResidentLane sentinel prevents runResidentLaneDaemon from starting', async () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'blocked-lane');
    mkdirSync(laneDir, { recursive: true });

    // Write sentinel manually to simulate a prior revocation
    writeFileSync(join(laneDir, 'REVOKED'), JSON.stringify({ revokedAt: new Date().toISOString() }) + '\n', 'utf8');

    const options = {
      adapterId: 'test',
      laneDir,
      keyPath: '',
      guardrailRepo: dir,
      workingDir: dir,
      laneId: 'blocked-lane',
      scopeType: 'none',
      scopeMode: 'warn',
      scopePaths: [],
      resourceMode: 'warn',
      resources: [],
      sessionName: '',
      sessionId: '',
      noSessionPersistence: false,
      authFd: null,
      bootNonce: '',
      identityNonce: '',
    };

    await assert.rejects(
      () => runResidentLaneDaemon(options, null),
      /revoked/i,
    );
  });
});

describe('Lane emergency controls: killResidentLane', () => {
  it('writes status=revoked + failureStage=killed and creates REVOKED sentinel', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'kill-lane');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    writeFileSync(paths.statePath, JSON.stringify({
      pid: 99998,
      status: 'ready',
      laneId: 'kill-lane',
      bootNonce: 'abc',
      identityNonce: 'def',
      createdAt: new Date().toISOString(),
    }), 'utf8');

    const result = killResidentLane({ laneDir, guardrailRepo: dir, actor: 'admin', reason: 'break-glass-test' });
    assert.equal(result.killed, true);
    assert.equal(result.revoked, true);

    const state = JSON.parse(readFileSync(paths.statePath, 'utf8'));
    assert.equal(state.status, 'revoked');
    assert.equal(state.failureStage, 'killed');
    assert.ok(existsSync(join(laneDir, 'REVOKED')));
  });

  it('kill is distinct from stop — killed state is not "stopped"', () => {
    const dir = tmpLaneDir();
    const laneDir = join(dir, '.guardrail', 'lanes', 'kill-distinct');
    mkdirSync(laneDir, { recursive: true });
    const paths = lanePaths(laneDir);
    writeFileSync(paths.statePath, JSON.stringify({
      pid: 99997,
      status: 'ready',
      laneId: 'kill-distinct',
      bootNonce: 'x',
      identityNonce: 'y',
      createdAt: new Date().toISOString(),
    }), 'utf8');

    killResidentLane({ laneDir, guardrailRepo: dir });
    const state = JSON.parse(readFileSync(paths.statePath, 'utf8'));
    assert.notEqual(state.status, 'stopped');
    assert.equal(state.status, 'revoked');
  });
});
