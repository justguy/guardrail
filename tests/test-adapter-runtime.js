/**
 * test-adapter-runtime.js — End-to-end runtime proofs for bundled adapter
 * profiles, the blocked-MCP gate, and the hardened stdin/shim helpers.
 *
 * All execution is stubbed — no real external CLIs spawn. Each test works
 * in an isolated tmp dir that is cleaned up after each case.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  loadBundledProfile,
  VALID_PROTOCOLS,
} from '../src/adapter-profile.js';
import {
  runAdapter,
  renderResponse,
} from '../src/adapter-engine.js';
import {
  createShim,
  listShims,
  removeShim,
  getInstallPathExport,
  writeShellRc,
} from '../src/adapter-shim.js';
import { parseStdinInput } from '../src/adapter-stdin.js';

// --- Fixtures ---------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BUNDLED_PROFILES_DIR = join(__dirname, '..', 'src', 'adapter-profiles');

const tempDirs = [];

function makeTempDir(prefix = 'gr-adapter-runtime-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/**
 * Construct a synthetic adapter-result/v1 value for rendering tests.
 * Keeps the shape identical to what normalizeToAdapterResult would produce.
 */
function makeAdapterResult(category, overrides = {}) {
  const base = {
    schemaVersion: 'adapter-result/v1',
    guardrail: {
      nativeStatus: 'success',
      category: 'success',
      code: 'OK',
      reason: 'Command executed successfully.',
      exitCode: 0,
      contractHash: 'hash-abc',
      manifestPath: '/tmp/approved.json',
      riskLevel: 'green',
      riskReasons: [],
      driftDetected: false,
      driftSummary: [],
    },
    process: {
      launched: true,
      exitCode: 0,
      timedOut: false,
      interactivePromptDetected: false,
      stdout: 'hello\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    },
    telemetry: { runId: 'r1', durationMs: 5 },
  };
  if (category === 'blocked') {
    base.guardrail.nativeStatus = 'drift_detected';
    base.guardrail.category = 'blocked';
    base.guardrail.code = 'DRIFT_DETECTED';
    base.guardrail.reason = 'Contract drift detected in non-interactive mode.';
    base.guardrail.exitCode = 12;
    base.guardrail.driftDetected = true;
    base.guardrail.driftSummary = ['~ args: [a] -> [b]'];
    base.guardrail.riskLevel = 'yellow';
    base.process.launched = false;
    base.process.exitCode = null;
    base.process.stdout = '';
  } else if (category === 'failed') {
    base.guardrail.nativeStatus = 'validation_failed';
    base.guardrail.category = 'failed';
    base.guardrail.code = 'VALIDATION_FAILED';
    base.guardrail.reason = 'Result validation failed.';
    base.guardrail.exitCode = 1;
    base.process.launched = true;
    base.process.exitCode = 1;
    base.process.stdout = '';
    base.process.stderr = 'boom\n';
  }
  return {
    ...base,
    guardrail: { ...base.guardrail, ...(overrides.guardrail || {}) },
    process: { ...base.process, ...(overrides.process || {}) },
    telemetry: { ...base.telemetry, ...(overrides.telemetry || {}) },
  };
}

// --- 1. Bundled profile inventory -------------------------------------------

describe('bundled adapter profiles inventory', () => {
  it('ships exactly aider, cline, openclaw', () => {
    const files = readdirSync(BUNDLED_PROFILES_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    assert.deepEqual(files, ['aider', 'cline', 'openclaw']);
  });

  for (const name of ['aider', 'cline', 'openclaw']) {
    it(`loads bundled profile ${name} and matches schema`, () => {
      const profile = loadBundledProfile(name);
      assert.equal(profile.schema_target, 'adapter-result/v1');
      assert.equal(profile.tool, name);
      assert.ok(
        VALID_PROTOCOLS.has(profile.protocol),
        `protocol ${profile.protocol} must be a valid protocol`,
      );
    });
  }
});

// --- 2. openclaw stdin-json render parity -----------------------------------

describe('openclaw profile render parity (stdin-json)', () => {
  const profile = loadBundledProfile('openclaw');

  it('renders success as structured JSON with stdout/stderr fields', () => {
    const result = makeAdapterResult('success');
    const rendered = renderResponse(profile, result);
    assert.equal(rendered.status, 'success');
    assert.equal(rendered.stdout, 'hello\n');
    assert.equal(rendered.stderr, '');
  });

  it('renders blocked as structured JSON with drift_summary and reason', () => {
    const result = makeAdapterResult('blocked');
    const rendered = renderResponse(profile, result);
    assert.equal(rendered.status, 'blocked');
    assert.ok(
      typeof rendered.reason === 'string' && rendered.reason.length > 0,
      'blocked rendered reason must be a non-empty string',
    );
    assert.deepEqual(rendered.drift_summary, ['~ args: [a] -> [b]']);
    assert.equal(rendered.risk_level, 'yellow');
  });

  it('renders failed as structured JSON with exit_code and stderr', () => {
    const result = makeAdapterResult('failed');
    const rendered = renderResponse(profile, result);
    assert.equal(rendered.status, 'failed');
    assert.equal(rendered.exit_code, 1);
    assert.equal(rendered.stderr, 'boom\n');
  });
});

// --- 3. aider env-shim human render -----------------------------------------

describe('aider profile human render (env-shim)', () => {
  const profile = loadBundledProfile('aider');

  it('renders success as {{process.stdout}} substitution', () => {
    const result = makeAdapterResult('success');
    const rendered = renderResponse(profile, result);
    assert.equal(typeof rendered, 'string');
    assert.ok(rendered.includes('hello\n'), `expected stdout in: ${rendered}`);
  });

  it('renders blocked with BLOCKED: prefix and drift summary text', () => {
    const result = makeAdapterResult('blocked');
    const rendered = renderResponse(profile, result);
    assert.equal(typeof rendered, 'string');
    assert.ok(rendered.startsWith('BLOCKED: '), `expected BLOCKED: prefix in: ${rendered}`);
    assert.ok(
      rendered.includes('~ args: [a] -> [b]'),
      `expected drift summary in: ${rendered}`,
    );
    assert.ok(
      rendered.includes('Contract drift detected'),
      `expected reason in: ${rendered}`,
    );
  });

  it('renders failed with FAILED (exit prefix and stderr', () => {
    const result = makeAdapterResult('failed');
    const rendered = renderResponse(profile, result);
    assert.equal(typeof rendered, 'string');
    assert.ok(
      rendered.startsWith('FAILED (exit '),
      `expected FAILED (exit prefix in: ${rendered}`,
    );
    assert.ok(rendered.includes('boom'), `expected stderr text in: ${rendered}`);
  });
});

// --- 4. MCP block proof -----------------------------------------------------

describe('MCP block gate', () => {
  it('blocks cline bundled profile before supervisor runs', async () => {
    const bundledCline = join(BUNDLED_PROFILES_DIR, 'cline.json');
    let supervisorCalled = false;
    const result = await runAdapter({
      profilePath: bundledCline,
      command: 'echo',
      args: ['x'],
      supervisorFn: async () => {
        supervisorCalled = true;
        return {
          runId: 'should-not-happen',
          status: 'success',
          reason: 'ok',
          exitCode: 0,
          worker: { launched: true, stdout: 'nope', stderr: '' },
          telemetry: { durationMs: 0 },
        };
      },
    });

    assert.equal(supervisorCalled, false, 'supervisor must not run when MCP blocks');
    assert.equal(result.adapterResult.guardrail.category, 'blocked');
    assert.equal(result.adapterResult.guardrail.code, 'MCP_BLOCKED');
    assert.ok(
      result.adapterResult.guardrail.reason.includes('MCP'),
      `expected reason to include 'MCP': ${result.adapterResult.guardrail.reason}`,
    );
    assert.equal(typeof result.exitCode, 'number');
  });

  it('blocks a generic mcp-protocol profile (not just cline)', async () => {
    const dir = makeTempDir();
    const profile = {
      version: '1.0.0',
      tool: 'test-mcp',
      description: 'generic mcp profile under test',
      schema_target: 'adapter-result/v1',
      protocol: 'mcp',
      intercept: {
        command: '$.command',
        args: '$.args',
        cwd: '$.cwd',
      },
      response: {
        format: 'json',
        blocked: { status: 'blocked', reason: '$.guardrail.reason' },
      },
      exit_codes: { success: 0, blocked: 12, failed: 1 },
      defaults: { non_interactive: true, json_output: true },
    };
    const profilePath = join(dir, 'test-mcp.json');
    writeFileSync(profilePath, JSON.stringify(profile, null, 2));

    let supervisorCalled = false;
    const result = await runAdapter({
      profilePath,
      command: 'echo',
      args: ['x'],
      supervisorFn: async () => {
        supervisorCalled = true;
        return {};
      },
    });

    assert.equal(supervisorCalled, false);
    assert.equal(result.adapterResult.guardrail.category, 'blocked');
    assert.equal(result.adapterResult.guardrail.code, 'MCP_BLOCKED');
    assert.ok(result.adapterResult.guardrail.reason.includes('MCP'));
    assert.equal(typeof result.exitCode, 'number');
  });
});

// --- 5. Adapter shim helpers -------------------------------------------------

describe('adapter shim helpers', () => {
  it('creates, lists, and removes a shim with correct mode and safety grep', () => {
    const shimDir = makeTempDir('gr-adapter-shim-');
    const created = createShim('mycmd', 'aider', { shimDir });
    assert.equal(created.created, true);
    assert.ok(existsSync(created.path));

    const stat = statSync(created.path);
    // Lowest 9 bits should be 0o755
    assert.equal(stat.mode & 0o777, 0o755, `expected mode 0o755, got ${(stat.mode & 0o777).toString(8)}`);

    const content = readFileSync(created.path, 'utf8');
    assert.ok(
      content.includes('# Guardrail shim for: mycmd (tool: aider)'),
      'shim header must name command + tool',
    );
    assert.ok(
      content.includes('grep -v "$HOME/.guardrail/shims"'),
      'shim must filter its own directory from which lookup',
    );

    const listed = listShims({ shimDir });
    assert.deepEqual(listed, [
      { command: 'mycmd', tool: 'aider', path: created.path },
    ]);

    const firstRemove = removeShim('mycmd', { shimDir });
    assert.equal(firstRemove.removed, true);
    assert.equal(firstRemove.path, created.path);

    const secondRemove = removeShim('mycmd', { shimDir });
    assert.equal(secondRemove.removed, false);
    assert.equal(secondRemove.path, created.path);
  });

  it('rejects unsafe commandName with shell metacharacters', () => {
    const shimDir = makeTempDir('gr-adapter-shim-');
    assert.throws(
      () => createShim('bad; rm -rf /', 'aider', { shimDir }),
      /must match/,
    );
  });

  it('rejects unsafe toolName with shell metacharacters', () => {
    const shimDir = makeTempDir('gr-adapter-shim-');
    assert.throws(
      () => createShim('mycmd', 'aider; echo pwned', { shimDir }),
      /must match/,
    );
  });

  it('getInstallPathExport includes the shim directory path', () => {
    const shimDir = makeTempDir('gr-adapter-shim-');
    const exportLine = getInstallPathExport({ shimDir });
    assert.equal(typeof exportLine, 'string');
    assert.ok(
      exportLine.includes(shimDir),
      `expected shim dir in export line: ${exportLine}`,
    );
  });

  it('writeShellRc requires explicit write opt-in', () => {
    assert.throws(
      () => writeShellRc({ write: false }),
      /explicit opt-in/,
    );
  });

  it('writeShellRc adds marker block once; second call is a no-op', () => {
    const shimDir = makeTempDir('gr-adapter-shim-');
    const rcDir = makeTempDir('gr-adapter-rc-');
    const rcPath = join(rcDir, '.zshrc');
    writeFileSync(rcPath, '');

    const first = writeShellRc({ write: true, shimDir, rcPath });
    assert.equal(first.written, true);
    assert.equal(first.alreadyPresent, false);
    assert.equal(first.rcPath, rcPath);

    const content = readFileSync(rcPath, 'utf8');
    assert.ok(
      content.includes('# >>> guardrail shim PATH (do not edit) >>>'),
      'rc file must contain marker block after first write',
    );

    const second = writeShellRc({ write: true, shimDir, rcPath });
    assert.equal(second.alreadyPresent, true);
    assert.equal(second.written, false);
  });
});

// --- 6. stdin protocol limits ------------------------------------------------

describe('parseStdinInput protocol limits', () => {
  it('parses a small JSON file supplied via argv[2]', async () => {
    const dir = makeTempDir('gr-adapter-stdin-');
    const filePath = join(dir, 'input.json');
    const payload = { command: 'echo', args: ['hello'] };
    writeFileSync(filePath, JSON.stringify(payload));

    const parsed = await parseStdinInput(
      ['node', 'script', filePath],
      { maxBytes: 1024 },
    );
    assert.deepEqual(parsed, payload);
  });

  it('throws structured INPUT_READ_FAILED when argv[2] file is missing', async () => {
    const missing = join(
      makeTempDir('gr-adapter-stdin-'),
      'does-not-exist.json',
    );
    await assert.rejects(
      parseStdinInput(['node', 'script', missing], { maxBytes: 1024 }),
      (err) => {
        assert.equal(err.code, 'INPUT_READ_FAILED');
        assert.ok(
          err.message.includes('Unable to read JSON input from argv[2]'),
          `unexpected message: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('throws INPUT_TOO_LARGE when stdin exceeds maxBytes', async () => {
    await assert.rejects(
      parseStdinInput(
        ['node', 'script'],
        { maxBytes: 10, stdinFn: async () => 'x'.repeat(20) },
      ),
      (err) => {
        assert.equal(err.code, 'INPUT_TOO_LARGE');
        assert.ok(
          err.message.includes('exceeds maximum size'),
          `unexpected message: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('throws INVALID_JSON when stdin payload is not valid JSON', async () => {
    await assert.rejects(
      parseStdinInput(
        ['node', 'script'],
        { stdinFn: async () => 'not json' },
      ),
      (err) => {
        assert.equal(err.code, 'INVALID_JSON');
        assert.ok(
          err.message.includes('Invalid JSON input'),
          `unexpected message: ${err.message}`,
        );
        return true;
      },
    );
  });
});
