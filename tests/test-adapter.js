import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  normalizeToAdapterResult,
  renderResponse,
  runAdapter,
} from '../src/adapter-engine.js';
import { runStdinAdapter } from '../src/adapter-stdin.js';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'guardrail-adapter-'));
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    input: options.input,
  });
}

function writeProfile(dir, profile) {
  const path = join(dir, `${profile.tool}.json`);
  writeFileSync(path, JSON.stringify(profile, null, 2));
  return path;
}

function makeJsonProfile(overrides = {}) {
  return {
    version: '1.0.0',
    tool: 'openclaw-test',
    description: 'test profile',
    schema_target: 'adapter-result/v1',
    protocol: 'stdin-json',
    intercept: {
      command: '$.command',
      args: '$.args',
      cwd: '$.cwd',
    },
    response: {
      format: 'json',
      success: {
        status: 'success',
        stdout: '$.process.stdout',
      },
      blocked: {
        status: 'blocked',
        reason: '$.guardrail.reason',
      },
      failed: {
        status: 'failed',
        exit_code: '$.guardrail.exitCode',
        stderr: '$.process.stderr',
      },
    },
    exit_codes: {
      success: 0,
      blocked: 12,
      failed: 1,
    },
    defaults: {
      non_interactive: true,
      json_output: true,
    },
    ...overrides,
  };
}

describe('adapter engine', () => {
  it('normalizes supervisor results into adapter-result/v1', () => {
    const result = normalizeToAdapterResult({
      runId: 'gr-123',
      status: 'drift_detected',
      reason: 'Contract drift detected in non-interactive mode.',
      exitCode: 12,
      contractHash: 'sha256-abc',
      manifestPath: '/tmp/approved.json',
      riskLevel: 'yellow',
      riskReasons: ['shell mode enabled'],
      drift: {
        detected: true,
        diffs: [{ description: '~ args[0]: "test" -> "install"' }],
      },
      worker: {
        launched: false,
        exitCode: null,
        timedOut: false,
        interactivePromptDetected: false,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      },
      telemetry: {
        durationMs: 45,
      },
    });

    assert.equal(result.schemaVersion, 'adapter-result/v1');
    assert.equal(result.guardrail.nativeStatus, 'drift_detected');
    assert.equal(result.guardrail.category, 'blocked');
    assert.equal(result.guardrail.reason, 'Contract drift detected in non-interactive mode.');
    assert.deepEqual(result.guardrail.driftSummary, ['~ args[0]: "test" -> "install"']);
    assert.equal(result.telemetry.runId, 'gr-123');
    assert.equal(result.telemetry.durationMs, 45);
  });

  it('uses response.format from the response block for human rendering', () => {
    const profile = makeJsonProfile({
      response: {
        format: 'human',
        blocked: 'Blocked: {{guardrail.reason}}',
      },
    });
    const rendered = renderResponse(profile, {
      guardrail: { category: 'blocked', reason: 'Needs approval' },
      process: {},
      telemetry: {},
    });
    assert.equal(rendered, 'Blocked: Needs approval');
  });

  it('extracts command, args, and cwd from stdin-json intercept paths', async () => {
    const dir = makeTempDir();
    const profilePath = writeProfile(dir, makeJsonProfile());
    let seenOptions = null;

    const result = await runAdapter({
      profilePath,
      rawInput: {
        command: 'npm',
        args: ['test', '--runInBand'],
        cwd: '/tmp/project',
      },
      supervisorFn: async (options) => {
        seenOptions = options;
        return {
          runId: 'gr-1',
          status: 'success',
          reason: 'ok',
          exitCode: 0,
          worker: { launched: true, stdout: 'done', stderr: '' },
          telemetry: { durationMs: 12 },
        };
      },
    });

    assert.equal(seenOptions.command, 'npm');
    assert.deepEqual(seenOptions.args, ['test', '--runInBand']);
    assert.equal(seenOptions.cwd, '/tmp/project');
    assert.equal(seenOptions.nonInteractive, true);
    assert.equal(seenOptions.jsonOutput, true);
    assert.deepEqual(result.renderedResponse, { status: 'success', stdout: 'done' });
    assert.equal(result.exitCode, 0);
  });

  it('uses profile exit code mapping instead of the native Guardrail exit code', async () => {
    const dir = makeTempDir();
    const profilePath = writeProfile(dir, makeJsonProfile());

    const result = await runAdapter({
      profilePath,
      rawInput: { command: 'npm', args: ['test'] },
      supervisorFn: async () => ({
        runId: 'gr-2',
        status: 'internal_error',
        reason: 'boom',
        exitCode: 19,
        worker: { launched: false, stdout: '', stderr: 'boom' },
        telemetry: { durationMs: 1 },
      }),
    });

    assert.equal(result.adapterResult.guardrail.category, 'failed');
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.renderedResponse, {
      status: 'failed',
      exit_code: 19,
      stderr: 'boom',
    });
  });

  it('fails closed when stdin-json args do not resolve to strings', async () => {
    const dir = makeTempDir();
    const profilePath = writeProfile(dir, makeJsonProfile());

    const result = await runAdapter({
      profilePath,
      rawInput: {
        command: 'npm',
        args: [1, 2],
      },
      supervisorFn: async () => {
        throw new Error('should not execute');
      },
    });

    assert.equal(result.adapterResult.guardrail.category, 'failed');
    assert.match(result.adapterResult.guardrail.reason, /intercept\.args/);
  });

  it('blocks before supervisor when required env mappings are missing', async () => {
    const dir = makeTempDir();
    const profilePath = writeProfile(dir, makeJsonProfile({
      requires_env: ['ANTHROPIC_API_KEY'],
    }));

    let supervisorCalled = false;
    const result = await runAdapter({
      profilePath,
      rawInput: { command: 'echo', args: ['hi'] },
      supervisorFn: async () => {
        supervisorCalled = true;
        return {};
      },
    });

    assert.equal(supervisorCalled, false);
    assert.equal(result.adapterResult.guardrail.category, 'blocked');
    assert.match(result.adapterResult.guardrail.reason, /missing_auth_mapping/);
  });

  it('passes explicit env allow-list through to supervisor envPolicy', async () => {
    const dir = makeTempDir();
    const profilePath = writeProfile(dir, makeJsonProfile({
      requires_env: ['ANTHROPIC_API_KEY'],
    }));

    let seenOptions = null;
    await runAdapter({
      profilePath,
      rawInput: { command: 'echo', args: ['hi'] },
      envAllow: ['ANTHROPIC_API_KEY'],
      supervisorFn: async (options) => {
        seenOptions = options;
        return {
          runId: 'gr-env',
          status: 'success',
          reason: 'ok',
          exitCode: 0,
          worker: { launched: true, stdout: 'ok', stderr: '' },
          telemetry: { durationMs: 1 },
        };
      },
    });

    assert.deepEqual(seenOptions.envPolicy, {
      inherit: false,
      allow: ['PATH', 'ANTHROPIC_API_KEY'],
      inject: {},
    });
  });

  it('blocks before supervisor when auth runtime env mappings are not explicitly allowed', async () => {
    const dir = makeTempDir();
    const profilePath = writeProfile(dir, makeJsonProfile({
      requires_auth: [{ type: 'claude_login', env: ['HOME'] }],
    }));

    let supervisorCalled = false;
    const result = await runAdapter({
      profilePath,
      rawInput: { command: 'echo', args: ['hi'] },
      authCheckFn: async () => ({ success: true, stdout: 'logged in' }),
      supervisorFn: async () => {
        supervisorCalled = true;
        return {};
      },
    });

    assert.equal(supervisorCalled, false);
    assert.equal(result.adapterResult.guardrail.category, 'blocked');
    assert.match(result.adapterResult.guardrail.reason, /missing_auth_mapping/);
    assert.match(result.adapterResult.guardrail.reason, /HOME/);
    assert.match(result.adapterResult.guardrail.reason, /auth runtime/);
  });

  it('blocks before supervisor when a declared auth prerequisite is missing', async () => {
    const dir = makeTempDir();
    const profilePath = writeProfile(dir, makeJsonProfile({
      requires_auth: [{ type: 'claude_login', env: ['HOME'] }],
    }));

    let supervisorCalled = false;
    const result = await runAdapter({
      profilePath,
      rawInput: { command: 'echo', args: ['hi'] },
      envAllow: ['HOME'],
      authCheckFn: async () => ({ success: false, stderr: 'Not logged in' }),
      supervisorFn: async () => {
        supervisorCalled = true;
        return {};
      },
    });

    assert.equal(supervisorCalled, false);
    assert.equal(result.adapterResult.guardrail.category, 'blocked');
    assert.match(result.adapterResult.guardrail.reason, /missing_auth_prerequisite/);
    assert.match(result.adapterResult.guardrail.reason, /Claude CLI is not logged in/);
  });
});

describe('adapter stdin protocol', () => {
  it('writes the rendered JSON response, not the internal wrapper object', async () => {
    let written = '';
    const result = await runStdinAdapter('/tmp/fake-profile.json', ['node', 'adapter-stdin'], {
      stdinFn: async () => JSON.stringify({ command: 'echo', args: ['hi'] }),
      stdout: {
        write(chunk) {
          written += chunk;
        },
      },
      runAdapterFn: async () => ({
        renderedResponse: { status: 'success', stdout: 'hi\n' },
        adapterResult: { guardrail: { category: 'success' } },
        exitCode: 0,
      }),
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(written.trim()), { status: 'success', stdout: 'hi\n' });
  });

  it('writes human responses as plain text with a trailing newline', async () => {
    let written = '';
    const result = await runStdinAdapter('/tmp/fake-profile.json', ['node', 'adapter-stdin'], {
      stdinFn: async () => JSON.stringify({ command: 'echo', args: ['hi'] }),
      stdout: {
        write(chunk) {
          written += chunk;
        },
      },
      runAdapterFn: async () => ({
        renderedResponse: 'Blocked: approval required',
        adapterResult: { guardrail: { category: 'blocked' } },
        exitCode: 12,
      }),
    });

    assert.equal(result.exitCode, 12);
    assert.equal(written, 'Blocked: approval required\n');
  });
});

// ---------------------------------------------------------------------------
// adapter-extract.js
// ---------------------------------------------------------------------------

describe('adapter-extract', async () => {
  const { validatePath, extractValue, resolveTemplate } = await import('../src/adapter-extract.js');

  it('extracts top-level field via dot path', () => {
    assert.equal(extractValue({ command: 'npm' }, '$.command'), 'npm');
  });

  it('extracts nested field', () => {
    assert.equal(extractValue({ guardrail: { reason: 'drift' } }, '$.guardrail.reason'), 'drift');
  });

  it('rejects __proto__', () => {
    const r = validatePath('$.__proto__');
    assert.equal(r.valid, false);
  });

  it('rejects constructor', () => {
    const r = validatePath('$.constructor');
    assert.equal(r.valid, false);
  });

  it('rejects bracket notation', () => {
    const r = validatePath("$['command']");
    assert.equal(r.valid, false);
  });

  it('rejects wildcard', () => {
    const r = validatePath('$.*');
    assert.equal(r.valid, false);
  });

  it('rejects array indexing', () => {
    const r = validatePath('$.arr[0]');
    assert.equal(r.valid, false);
  });

  it('rejects filter expressions', () => {
    const r = validatePath('$[?(@.x)]');
    assert.equal(r.valid, false);
  });

  it('returns undefined for missing path', () => {
    assert.equal(extractValue({ a: 1 }, '$.b'), undefined);
  });

  it('handles null/undefined input gracefully', () => {
    assert.equal(extractValue(null, '$.a'), undefined);
    assert.equal(extractValue(undefined, '$.a'), undefined);
  });

  it('resolves human template placeholders', () => {
    const data = { guardrail: { reason: 'drift detected' }, process: { stdout: 'hello' } };
    const result = resolveTemplate('BLOCKED: {{guardrail.reason}} out={{process.stdout}}', data);
    assert.equal(result, 'BLOCKED: drift detected out=hello');
  });
});

// ---------------------------------------------------------------------------
// adapter-profile.js
// ---------------------------------------------------------------------------

describe('adapter-profile', async () => {
  const { VALID_PROTOCOLS, validateProfile, hashProfile, loadBundledProfile } = await import('../src/adapter-profile.js');

  it('VALID_PROTOCOLS includes stdin-json, env-shim, mcp', () => {
    assert.ok(VALID_PROTOCOLS.has('stdin-json'));
    assert.ok(VALID_PROTOCOLS.has('env-shim'));
    assert.ok(VALID_PROTOCOLS.has('mcp'));
  });

  it('accepts valid openclaw profile', () => {
    const profile = loadBundledProfile('openclaw');
    const result = validateProfile(profile);
    assert.equal(result.valid, true);
  });

  it('accepts valid aider profile', () => {
    const profile = loadBundledProfile('aider');
    const result = validateProfile(profile);
    assert.equal(result.valid, true);
  });

  it('accepts mcp profile (blocking is in CLI, not validation)', () => {
    const profile = loadBundledProfile('cline');
    const result = validateProfile(profile);
    assert.equal(result.valid, true);
    assert.equal(profile.protocol, 'mcp');
  });

  it('rejects unsupported protocol http', () => {
    const profile = makeJsonProfile({ protocol: 'http' });
    const result = validateProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('protocol') || e.includes('deferred') || e.includes('http')));
  });

  it('rejects unsupported protocol python-callable', () => {
    const profile = makeJsonProfile({ protocol: 'python-callable' });
    const result = validateProfile(profile);
    assert.equal(result.valid, false);
  });

  it('rejects unknown top-level field', () => {
    const profile = makeJsonProfile({ unknown_field: true });
    const result = validateProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('unknown')));
  });

  it('rejects invalid schema_target', () => {
    const profile = makeJsonProfile({ schema_target: 'adapter-result/v99' });
    const result = validateProfile(profile);
    assert.equal(result.valid, false);
  });

  it('hashProfile produces consistent hash', () => {
    const profile = makeJsonProfile();
    const h1 = hashProfile(profile);
    const h2 = hashProfile(profile);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });

  it('loadBundledProfile loads all three profiles', () => {
    for (const tool of ['openclaw', 'aider', 'cline']) {
      const profile = loadBundledProfile(tool);
      assert.equal(profile.tool, tool);
    }
  });

  it('rejects malformed requires_env declarations', () => {
    const profile = makeJsonProfile({ requires_env: ['ANTHROPIC_API_KEY', 42] });
    const result = validateProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('requires_env')));
  });

  it('rejects malformed requires_auth declarations', () => {
    const profile = makeJsonProfile({ requires_auth: [{ type: 'bogus' }] });
    const result = validateProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('requires_auth.type')));
  });

  it('rejects malformed requires_auth env declarations', () => {
    const profile = makeJsonProfile({ requires_auth: [{ type: 'claude_login', env: ['HOME', 'bad-var'] }] });
    const result = validateProfile(profile);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('requires_auth.env')));
  });
});

// ---------------------------------------------------------------------------
// adapter-engine.js — category mapping
// ---------------------------------------------------------------------------

describe('deriveCategory', async () => {
  const { deriveCategory } = await import('../src/adapter-engine.js');

  it('maps success to success', () => {
    assert.equal(deriveCategory('success'), 'success');
  });

  it('maps blocked statuses to blocked', () => {
    for (const s of ['approval_required', 'approval_denied', 'drift_detected', 'policy_violation', 'unsupported', 'update_denied', 'time_policy_violated', 'concurrent_blocked']) {
      assert.equal(deriveCategory(s), 'blocked', `expected ${s} -> blocked`);
    }
  });

  it('maps failed statuses to failed', () => {
    for (const s of ['validation_failed', 'timeout', 'protocol_error', 'internal_error']) {
      assert.equal(deriveCategory(s), 'failed', `expected ${s} -> failed`);
    }
  });

  it('maps unknown status to failed', () => {
    assert.equal(deriveCategory('something_weird'), 'failed');
  });
});

// ---------------------------------------------------------------------------
// adapter-cli.js
// ---------------------------------------------------------------------------

describe('parseAdapterArgs', async () => {
  const { parseAdapterArgs } = await import('../src/adapter-cli.js');

  it('parses adapter run --tool openclaw -- echo hello', () => {
    const r = parseAdapterArgs(['run', '--tool', 'openclaw', '--', 'echo', 'hello']);
    assert.equal(r.subcommand, 'adapter-run');
    assert.equal(r.tool, 'openclaw');
    assert.equal(r.command, 'echo');
    assert.deepEqual(r.args, ['hello']);
  });

  it('parses adapter run with repeated --env-allow flags', () => {
    const r = parseAdapterArgs(['run', '--tool', 'openclaw', '--env-allow', 'ANTHROPIC_API_KEY', '--env-allow', 'FOO', '--', 'echo', 'hello']);
    assert.deepEqual(r.envAllow, ['ANTHROPIC_API_KEY', 'FOO']);
  });

  it('parses adapter shim --tool aider --commands npm,git', () => {
    const r = parseAdapterArgs(['shim', '--tool', 'aider', '--commands', 'npm,git']);
    assert.equal(r.subcommand, 'adapter-shim');
    assert.equal(r.tool, 'aider');
    assert.deepEqual(r.commands, ['npm', 'git']);
  });

  it('parses adapter shim --list', () => {
    const r = parseAdapterArgs(['shim', '--list']);
    assert.equal(r.subcommand, 'adapter-shim');
    assert.equal(r.list, true);
  });

  it('parses adapter shim --remove npm', () => {
    const r = parseAdapterArgs(['shim', '--remove', 'npm']);
    assert.equal(r.subcommand, 'adapter-shim');
    assert.equal(r.remove, 'npm');
  });

  it('parses adapter shim --install-path --write', () => {
    const r = parseAdapterArgs(['shim', '--install-path', '--write']);
    assert.equal(r.subcommand, 'adapter-shim');
    assert.equal(r.installPath, true);
    assert.equal(r.write, true);
  });

  it('parses adapter profile install ./file.json', () => {
    const r = parseAdapterArgs(['profile', 'install', './file.json']);
    assert.equal(r.subcommand, 'adapter-profile-install');
    assert.equal(r.source, './file.json');
  });

  it('parses adapter profile list', () => {
    const r = parseAdapterArgs(['profile', 'list']);
    assert.equal(r.subcommand, 'adapter-profile-list');
  });

  it('parses adapter profile show openclaw', () => {
    const r = parseAdapterArgs(['profile', 'show', 'openclaw']);
    assert.equal(r.subcommand, 'adapter-profile-show');
    assert.equal(r.tool, 'openclaw');
  });

  it('returns error for unknown subcommand', () => {
    const r = parseAdapterArgs(['bogus']);
    assert.ok(r.error);
  });
});

// ---------------------------------------------------------------------------
// adapter-shim.js
// ---------------------------------------------------------------------------

describe('adapter-shim', async () => {
  const { createShim, removeShim, listShims, getInstallPathExport, writeShellRc } = await import('../src/adapter-shim.js');
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'guardrail-shim-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates an executable shim', () => {
    const result = createShim('echo', 'aider', { shimDir: tempDir });
    assert.ok(existsSync(result.path));
    const mode = statSync(result.path).mode;
    assert.ok(mode & 0o111, 'shim should be executable');
  });

  it('shim embeds absolute Guardrail path', () => {
    const result = createShim('echo', 'aider', { shimDir: tempDir });
    const content = readFileSync(result.path, 'utf8');
    assert.ok(content.includes('guardrail') || content.includes('adapter'));
    assert.ok(content.includes('aider'), 'shim should reference tool name');
  });

  it('--remove deletes existing shim', () => {
    createShim('echo', 'aider', { shimDir: tempDir });
    const result = removeShim('echo', { shimDir: tempDir });
    assert.equal(result.removed, true);
    assert.ok(!existsSync(join(tempDir, 'echo')));
  });

  it('--remove returns false for missing shim', () => {
    const result = removeShim('nonexistent', { shimDir: tempDir });
    assert.equal(result.removed, false);
  });

  it('--list returns installed shims', () => {
    createShim('npm', 'aider', { shimDir: tempDir });
    createShim('git', 'aider', { shimDir: tempDir });
    const shims = listShims({ shimDir: tempDir });
    assert.equal(shims.length, 2);
  });

  it('--install-path outputs correct export line', () => {
    const line = getInstallPathExport();
    assert.ok(line.includes('export PATH='));
    assert.ok(line.includes('.guardrail/shims'));
  });

  it('--write appends marked block once only', () => {
    const rcPath = join(tempDir, '.zshrc');
    writeFileSync(rcPath, '# existing config\n');
    writeShellRc({ write: true, rcPath });
    const content1 = readFileSync(rcPath, 'utf8');
    assert.ok(content1.includes('guardrail shim PATH'));

    // Second write should not duplicate
    writeShellRc({ write: true, rcPath });
    const content2 = readFileSync(rcPath, 'utf8');
    const count = (content2.match(/guardrail shim PATH/g) || []).length;
    assert.equal(count, 2, 'marker appears in open and close comment, so 2 occurrences');
  });
});

// ---------------------------------------------------------------------------
// adapter-profile-install.js
// ---------------------------------------------------------------------------

describe('adapter-profile-install', async () => {
  const { installAdapterProfile } = await import('../src/adapter-profile-install.js');

  it('bare-name install is rejected', async () => {
    await assert.rejects(
      () => installAdapterProfile('openclaw'),
      /not a local path/
    );
  });
});

// ---------------------------------------------------------------------------
// supervisor.js — rich result shape
// ---------------------------------------------------------------------------

describe('supervisor rich result shape', async () => {
  const { STATUS_EXIT_CODES } = await import('../src/supervisor.js');

  it('STATUS_EXIT_CODES includes all expected statuses', () => {
    assert.equal(STATUS_EXIT_CODES.success, 0);
    assert.equal(STATUS_EXIT_CODES.drift_detected, 12);
    assert.equal(STATUS_EXIT_CODES.internal_error, 19);
    assert.ok('approval_required' in STATUS_EXIT_CODES);
    assert.ok('time_policy_violated' in STATUS_EXIT_CODES);
    assert.ok('concurrent_blocked' in STATUS_EXIT_CODES);
  });
});

// ---------------------------------------------------------------------------
// cli.js — adapter subcommand routing
// ---------------------------------------------------------------------------

describe('cli adapter subcommand', async () => {
  const { parseArgs } = await import('../src/cli.js');

  it('routes adapter subcommand', () => {
    const r = parseArgs(['adapter', 'run', '--tool', 'openclaw', '--', 'echo', 'hello']);
    assert.equal(r.subcommand, 'adapter');
    assert.ok(Array.isArray(r.adapterArgv));
    assert.deepEqual(r.adapterArgv, ['run', '--tool', 'openclaw', '--', 'echo', 'hello']);
  });

  it('passes full adapter argv through', () => {
    const r = parseArgs(['adapter', 'profile', 'list']);
    assert.equal(r.subcommand, 'adapter');
    assert.deepEqual(r.adapterArgv, ['profile', 'list']);
  });

  it('blocks mcp profile paths before runtime', () => {
    const result = runNode([
      resolve('src/cli.js'),
      'adapter',
      'run',
      '--profile',
      resolve('src/adapter-profiles/cline.json'),
      '--',
      'echo',
      'hello',
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /MCP protocol is not yet supported/);
  });
});

describe('adapter-stdin entrypoint', () => {
  it('uses argv[2] as profile path and stdin as the JSON payload', () => {
    const result = runNode(
      [resolve('src/adapter-stdin.js'), resolve('src/adapter-profiles/openclaw.json')],
      { input: JSON.stringify({ command: 'echo', args: ['hello'] }) },
    );

    assert.equal(result.status, 12);
    assert.ok(result.stdout.includes('"status":"blocked"'));
    assert.ok(result.stdout.includes('No approved manifest found'));
    assert.ok(!result.stdout.includes('intercept.command did not resolve'));
  });
});
