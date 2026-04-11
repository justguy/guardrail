import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { delimiter } from 'node:path';
import { tmpdir } from 'node:os';

import { loadRecipe, createRecipeManifest, compareRecipeManifests, hashRecipe } from '../src/recipe.js';
import {
  parseWrapperArgs,
  buildClaudeArgs,
  buildClaudeFailureMessage,
  emitSessionMetadata,
  buildProgressSystemAppendix,
  runClaudeExec,
} from '../src/claude-exec-wrapper.js';
import {
  parseAiProgressLine,
  emitAiProgress,
  AI_HEARTBEAT_POLICY,
  AI_SOFT_STATES,
  AI_EVENT_TO_STATE,
  AI_CHECKPOINT_EVENTS,
} from '../src/progress-events.js';
import {
  collectRecipeInputContentHashes,
  verifyRecipeInputContentHashes,
} from '../src/prompt-inputs.js';
import {
  runRecipeSupervisor,
  formatAllowUnverifiedReapprovalNotice,
  preflightRecipeAuthRuntime,
} from '../src/recipe-supervisor.js';
import { executeRecipe } from '../src/recipe-executor.js';
import { signRecipe } from '../src/recipe-channel.js';
import { saveManifest } from '../src/manifest.js';
import {
  buildSessionContract,
  saveSessionContract,
  loadSessionContract,
  defaultSessionContractPath,
} from '../src/agent-session.js';

// Must mirror recipe-supervisor.HOST_BOUNDARY_WARNING. If that constant
// changes, this test drifts and both should be updated in the same commit.
const HOST_BOUNDARY_WARNING = 'Guardrail does not sandbox host execution; this wrapper relies on the tool/runtime permission model';
const CLI_PATH = resolve(process.cwd(), 'src/cli.js');

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-claude-recipe-')));
}

function exactSearchDirs(basePath, dirs) {
  return {
    explicitSearchDirs: dirs,
    basePath,
    includeDefaults: false,
    repoConfigPath: false,
    userConfigPath: false,
  };
}

// ---------------------------------------------------------------------------
// Session-enforcement test helpers
// ---------------------------------------------------------------------------
//
// These use a stub recipe whose id is "claude-exec" so the session-enforcement
// path in src/agent-session-enforce.js activates. The session-contract layer
// keys off recipe id, not off the full recipe content, so a stub is
// sufficient (and far less brittle than pre-seeding a manifest that exactly
// matches the real community-channel claude-exec risk signature).
function makeClaudeStubRecipe(overrides = {}) {
  const recipe = {
    id: 'claude-exec',
    name: 'Claude Exec Session Test Stub',
    description: 'Stub recipe for claude-exec session contract enforcement tests',
    version: '1.0.0',
    author: 'test',
    category: 'custom',
    channel: 'verified',
    inputs: {
      working_dir: {
        type: 'string',
        approval_mode: 'path_policy',
        rules: { must_be_relative: true, deny_segments: ['..'], max_depth: 12 },
      },
      session_name: {
        type: 'string',
        pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$',
      },
      prompt: {
        type: 'string',
        approval_mode: 'interactive_message',
        required: false,
      },
      no_session_persistence: {
        type: 'boolean',
        default: true,
        required: false,
      },
      lifecycle: {
        type: 'string',
        enum: ['start', 'continue', 'attach'],
        default: 'start',
        required: false,
      },
      session_id: {
        type: 'string',
        pattern: '^[A-Za-z0-9_-]{1,128}$',
        required: false,
      },
    },
    steps: [
      {
        id: 'noop',
        description: 'No-op step stub — executorFn is injected in tests',
        run: { command: 'echo', args: ['stub'], mode: 'structured', timeoutMs: 5000 },
      },
    ],
    guardrails: { constraints: ['structured'], invariants: ['no shell'] },
    approval_required: false,
    risk_level: 'low',
    tags: ['test'],
    ...overrides,
  };
  recipe.signature = signRecipe(recipe);
  return recipe;
}

function writeStubRecipeFile(dir, recipe) {
  const filePath = join(dir, `${recipe.id}.recipe.json`);
  writeFileSync(filePath, JSON.stringify(recipe, null, 2), 'utf8');
  return filePath;
}

function stubExecutor() {
  let called = 0;
  let lastArgs = null;
  const fn = async (...args) => {
    called += 1;
    lastArgs = args;
    return { status: 'success', stepsExecuted: 1, reason: null };
  };
  return {
    fn,
    get called() { return called; },
    get lastArgs() { return lastArgs; },
  };
}

function prependPath(dir) {
  return `${dir}${delimiter}${process.env.PATH ?? ''}`;
}

function writeClaudeStub(dir, body) {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const stubPath = join(binDir, 'claude');
  writeFileSync(stubPath, body, 'utf8');
  chmodSync(stubPath, 0o755);
  return { binDir, stubPath };
}

// Pre-seed a recipe manifest matching what the supervisor will compute for
// the stub recipe so non-interactive runs bypass interactive approval.
function seedStubManifest(dir, recipesDir, recipe, resolvedInputs) {
  const riskAssessment = {
    trustClass: 'pinned_external',
    riskLevel: 'yellow',
    reasons: ['recipe declares low risk', HOST_BOUNDARY_WARNING],
    requiresStrongConfirmation: false,
  };
  const manifest = createRecipeManifest(
    recipe,
    hashRecipe(recipe),
    riskAssessment,
    resolvedInputs,
    {
      cwd: resolve(dir),
      projectRoot: resolve(dir),
      sourcePath: join(recipesDir, `${recipe.id}.recipe.json`),
    },
  );
  manifest.riskAssessment.acknowledgedBy = 'test';
  manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
  const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
  mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });
  saveManifest(manifest, manifestPath);
  return manifestPath;
}

describe('Claude recipe', () => {
  it('loads the claude exec recipe', () => {
    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'claude-exec.recipe.json'));
    assert.equal(recipe.id, 'claude-exec');
    assert.equal(recipe.version, '1.0.0');
    assert.equal(recipe.steps.length, 1);
    assert.ok(Array.isArray(recipe.requires_env));
    assert.deepEqual(
      recipe.requires_env,
      ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TERM_PROGRAM', 'LANG', 'TMPDIR', 'PWD', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR'],
    );
    assert.equal(recipe.preserve_runtime_env, true);
    assert.deepEqual(recipe.requires_auth, [{ type: 'claude_exec_probe' }]);
    assert.match(recipe.description, /OS-managed secure stores|process-identity-gated runtime state/);
    assert.match(recipe.description, /exact same shell\/runtime that will later launch Guardrail/);
    assert.ok(
      recipe.guardrails?.constraints?.some((line) => line.includes('secure-store-backed CLI auth')),
    );
    assert.ok(
      recipe.guardrails?.constraints?.some((line) => line.includes('missing_auth_prerequisite')),
    );
    assert.ok(
      recipe.guardrails?.constraints?.some((line) => line.includes('--env-allow') && line.includes('requires_env')),
    );
    assert.equal(recipe.steps[0].run.timeoutMs, 900000);
    assert.ok(
      recipe.guardrails?.constraints?.some((line) => line.includes('900000ms / 15m invoke timeout')),
    );
    assert.match(recipe.inputs.system_prompt.description, /Workflow recipe_ref usage does not bypass this reapproval rule/);
    assert.ok(
      recipe.guardrails?.constraints?.some((line) => line.includes('interactive_message semantics')),
    );
    assert.ok(
      recipe.guardrails?.constraints?.some((line) => line.includes('system_prompt remains review_each_time') && line.includes('local template')),
    );
    assert.equal(recipe.inputs.prompt.approval_mode, 'interactive_message');
  });

  it('parses wrapper args by flag name', () => {
    const parsed = parseWrapperArgs([
      '--prompt', 'Review auth flow',
      '--input-files', 'src/a.js,src/b.js',
      '--model', 'sonnet',
      '--working-dir', '.',
      '--no-session-persistence', 'true',
    ]);
    assert.equal(parsed.prompt, 'Review auth flow');
    assert.equal(parsed.inputFiles, 'src/a.js,src/b.js');
    assert.equal(parsed.model, 'sonnet');
    assert.equal(parsed.workingDir, '.');
    assert.equal(parsed.noSessionPersistence, 'true');
  });

  it('builds claude args from normalized options', () => {
    const args = buildClaudeArgs({
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'plan',
      outputFormat: 'json',
      maxBudgetUsd: '1.50',
      allowedTools: 'Read Edit',
      systemPrompt: 'Focus on security',
      addDirs: ['/tmp/project/docs'],
      sessionName: 'auth-review',
      noSessionPersistence: true,
      promptPayload: 'Review this repo',
    });

    assert.deepEqual(args, [
      '--print',
      '--model', 'sonnet',
      '--effort', 'high',
      '--permission-mode', 'plan',
      '--output-format', 'json',
      '--max-budget-usd', '1.50',
      '--allowed-tools', 'Read Edit',
      '--append-system-prompt', 'Focus on security',
      '--add-dir', '/tmp/project/docs',
      '--name', 'auth-review',
      '--no-session-persistence',
      'Review this repo',
    ]);
  });

  it('formats claude failure messages with stderr detail when present', () => {
    const message = buildClaudeFailureMessage({
      code: 1,
      stderr: 'Not logged in\nRun claude login\n',
      stdout: '',
    });

    assert.equal(message, 'claude --print failed with exit code 1: Not logged in | Run claude login');
  });

  it('runs Claude auth preflight under the guarded env intersection instead of the parent shell env', async () => {
    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'claude-exec.recipe.json'));
    let seenOptions = null;

    const result = await preflightRecipeAuthRuntime({
      recipe,
      envAllow: recipe.requires_env,
      cwd: process.cwd(),
      currentEnv: {
        ...process.env,
        HOME: '/host/home',
        XDG_CONFIG_HOME: '/host/xdg',
        CLAUDE_CONFIG_DIR: '/host/claude',
        SHOULD_NOT_LEAK: '1',
      },
      authCheckFn: async (_command, _args, _cwd, options) => {
        seenOptions = options;
        return {
          success: true,
          stdout: '{"loggedIn":true}',
          stderr: '',
        };
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(seenOptions?.envPolicy, {
      inherit: true,
      inject: {
        PWD: process.cwd(),
      },
    });
  });

  it('preserves the full runtime env for secure-store-backed claude execution while still requiring declared env approval', async () => {
    const originalExtra = process.env.GUARDRAIL_CLAUDE_RUNTIME_EXTRA;
    process.env.GUARDRAIL_CLAUDE_RUNTIME_EXTRA = 'present';

    try {
      const recipe = makeClaudeStubRecipe({
        preserve_runtime_env: true,
        requires_env: ['HOME'],
        steps: [
          {
            id: 'env-check',
            description: 'assert hidden runtime env survives',
            run: {
              command: 'node',
              args: ['-e', 'if (process.env.GUARDRAIL_CLAUDE_RUNTIME_EXTRA !== "present") process.exit(7)'],
              mode: 'structured',
              timeoutMs: 5000,
            },
          },
        ],
      });

      const result = await executeRecipe(recipe, {}, {
        approved: true,
        cwd: process.cwd(),
        envAllow: ['HOME'],
        allowUnverified: false,
      });

      assert.equal(result.status, 'success');
    } finally {
      if (originalExtra === undefined) {
        delete process.env.GUARDRAIL_CLAUDE_RUNTIME_EXTRA;
      } else {
        process.env.GUARDRAIL_CLAUDE_RUNTIME_EXTRA = originalExtra;
      }
    }
  });

  it('explains reapproval when --allow-unverified widens the recipe trust boundary', () => {
    const notice = formatAllowUnverifiedReapprovalNotice(
      { recipe: { allowUnverified: true } },
      { recipe: { allowUnverified: false } },
    );

    assert.deepEqual(notice, [
      'Fresh approval required: this run newly enables execution of an unverified community recipe with --allow-unverified.',
      'The previous approval record did not authorize that trust boundary, so Guardrail requires a new approval record.',
    ]);
    assert.equal(
      formatAllowUnverifiedReapprovalNotice(
        { recipe: { allowUnverified: true } },
        { recipe: { allowUnverified: true } },
      ),
      null,
    );
  });

  it('prints a yellow reapproval notice when --allow-unverified changes trust boundary', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    const recipe = makeClaudeStubRecipe({ channel: 'community' });
    writeStubRecipeFile(recipesDir, recipe);

    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    const approvedManifest = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      {
        trustClass: 'unknown',
        riskLevel: 'red',
        reasons: ['recipe declares low risk', HOST_BOUNDARY_WARNING, 'recipe is from the community channel'],
        requiresStrongConfirmation: true,
      },
      { working_dir: '.', session_name: 'approval-test' },
      {
        cwd: resolve(dir),
        projectRoot: resolve(dir),
        sourcePath: join(recipesDir, `${recipe.id}.recipe.json`),
        allowUnverified: false,
      },
    );
    approvedManifest.riskAssessment.acknowledgedBy = 'test';
    approvedManifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    saveManifest(approvedManifest, manifestPath);

    const stdoutChunks = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalIsTTY = process.stdin.isTTY;
    process.stdout.write = (chunk, encoding, callback) => {
      stdoutChunks.push(String(chunk));
      if (typeof encoding === 'function') encoding();
      if (typeof callback === 'function') callback();
      return true;
    };
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });

    try {
      const result = await runRecipeSupervisor({
        specifier: recipe.id,
        inputs: { working_dir: '.', session_name: 'approval-test' },
        cwd: dir,
        searchDirs: exactSearchDirs(dir, [recipesDir]),
        manifestPath,
        allowUnverified: true,
        promptApprovalFn: async () => false,
        executorFn: async () => ({ status: 'success', stepsExecuted: 1, reason: null }),
      });

      assert.equal(result.status, 'approval_denied');
    } finally {
      process.stdout.write = originalWrite;
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }

    const rendered = stdoutChunks.join('');
    assert.ok(
      rendered.includes('Fresh approval required: this run newly enables execution of an unverified community recipe with --allow-unverified.'),
    );
    assert.ok(
      rendered.includes('[YELLOW]') || rendered.includes('\x1b[33m'),
      `expected yellow-highlighted output, got: ${rendered}`,
    );
  });

  it('stores input file content hashes in recipe manifests and detects drift', () => {
    const dir = tmpDir();
    const workingDir = join(dir, 'workspace');
    mkdirSync(workingDir, { recursive: true });
    const filePath = join(workingDir, 'prompt.txt');
    writeFileSync(filePath, 'Original prompt\n');

    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'claude-exec.recipe.json'));
    const resolvedInputs = {
      prompt: 'Review auth redirect logic',
      input_files: ['prompt.txt'],
      model: 'sonnet',
      effort: 'high',
      mode: 'plan',
      output_format: 'json',
      max_budget_usd: '1.50',
      allowed_tools: 'Read Edit',
      system_prompt: 'Focus on redirects',
      working_dir: workingDir,
      add_dirs: [],
      session_name: 'auth-review',
      no_session_persistence: true,
      guardrail_repo: '.',
    };

    const inputContentHashes = collectRecipeInputContentHashes(recipe, resolvedInputs, { cwd: dir });
    const manifest = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      { trustClass: 'unknown', riskLevel: 'red', reasons: ['recipe declares medium risk'] },
      resolvedInputs,
      {
        cwd: dir,
        projectRoot: dir,
        sourcePath: join(process.cwd(), 'recipes', 'claude-exec.recipe.json'),
        inputContentHashes,
      },
    );

    assert.equal(Array.isArray(manifest.inputContentHashes.input_files), true);
    assert.equal(manifest.inputContentHashes.input_files.length, 1);
    assert.equal(verifyRecipeInputContentHashes(manifest.inputContentHashes).verified, true);

    writeFileSync(filePath, 'Changed prompt\n');

    const changedHashes = collectRecipeInputContentHashes(recipe, resolvedInputs, { cwd: dir });
    const changedManifest = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      { trustClass: 'unknown', riskLevel: 'red', reasons: ['recipe declares medium risk'] },
      resolvedInputs,
      {
        cwd: dir,
        projectRoot: dir,
        sourcePath: join(process.cwd(), 'recipes', 'claude-exec.recipe.json'),
        inputContentHashes: changedHashes,
      },
    );

    const comparison = compareRecipeManifests(changedManifest, manifest);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.diffs.some((diff) => diff.includes('inputContentHashes')));

    const verify = verifyRecipeInputContentHashes(manifest.inputContentHashes);
    assert.equal(verify.verified, false);
    assert.ok(verify.errors.some((error) => error.includes('file content changed')));
  });

  it('declares session-lifecycle inputs on the real recipe', () => {
    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'claude-exec.recipe.json'));
    const lifecycle = recipe.inputs.lifecycle;
    assert.ok(lifecycle, 'lifecycle input must exist');
    assert.equal(lifecycle.type, 'string');
    assert.deepEqual(lifecycle.enum, ['start', 'continue', 'attach']);
    assert.equal(lifecycle.default, 'start');
    assert.equal(lifecycle.required, false);

    const sessionId = recipe.inputs.session_id;
    assert.ok(sessionId, 'session_id input must exist');
    assert.equal(sessionId.type, 'string');
    assert.equal(sessionId.pattern, '^[A-Za-z0-9_-]{1,128}$');
    assert.equal(sessionId.required, false);

    // session_name is still required and keeps its pattern.
    assert.ok(recipe.inputs.session_name);
    assert.equal(recipe.inputs.session_name.pattern, '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$');

    // Step args must wire both new flags after --no-session-persistence.
    const args = recipe.steps[0].run.args;
    const lifecycleIdx = args.indexOf('--lifecycle');
    const sessionIdIdx = args.indexOf('--session-id');
    assert.ok(lifecycleIdx > 0);
    assert.equal(args[lifecycleIdx + 1], '{{inputs.lifecycle}}');
    assert.ok(sessionIdIdx > 0);
    assert.equal(args[sessionIdIdx + 1], '{{inputs.session_id}}');
  });

  it('parses --lifecycle and --session-id wrapper flags', () => {
    const parsed = parseWrapperArgs([
      '--prompt', 'Continue auth review',
      '--lifecycle', 'continue',
      '--session-id', 'abc-123',
      '--session-name', 'auth-review',
      '--model', 'sonnet',
    ]);
    assert.equal(parsed.lifecycle, 'continue');
    assert.equal(parsed.sessionId, 'abc-123');
    assert.equal(parsed.sessionName, 'auth-review');
    assert.equal(parsed.prompt, 'Continue auth review');
  });

  it('buildClaudeArgs never forwards lifecycle or sessionId to the Claude CLI', () => {
    const args = buildClaudeArgs({
      model: 'sonnet',
      sessionName: 'auth-review',
      lifecycle: 'continue',
      sessionId: 'abc-123',
      promptPayload: 'Hi',
    });
    assert.ok(!args.includes('--lifecycle'), 'args must not contain --lifecycle');
    assert.ok(!args.includes('--session-id'), 'args must not contain --session-id');
    assert.ok(!args.includes('continue'), 'args must not contain the lifecycle value');
    assert.ok(!args.includes('abc-123'), 'args must not contain the session id value');
    // sanity: session-name still maps through as --name
    assert.ok(args.includes('--name'));
    assert.ok(args.includes('auth-review'));
  });

  it('emitSessionMetadata returns the structured session record', () => {
    const meta = emitSessionMetadata({
      lifecycle: 'start',
      sessionName: 'auth-review',
      sessionId: null,
      workingDir: '/tmp/work',
    });
    assert.deepEqual(meta, {
      tool: 'claude',
      lifecycle: 'start',
      sessionName: 'auth-review',
      sessionId: null,
      workingDir: '/tmp/work',
    });

    // Empty/missing fields collapse to null so downstream consumers get a
    // stable shape.
    const empty = emitSessionMetadata({});
    assert.deepEqual(empty, {
      tool: 'claude',
      lifecycle: null,
      sessionName: null,
      sessionId: null,
      workingDir: null,
    });
  });
});

// ===========================================================================
// End-to-end session enforcement via the recipe supervisor
// ===========================================================================

describe('Claude recipe: session enforcement via recipe supervisor', () => {
  it('fails closed with session_missing on lifecycle=continue without a prior contract', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeClaudeStubRecipe();
    writeStubRecipeFile(recipesDir, recipe);

    // Note: we deliberately skip seeding a recipe manifest. The session
    // enforcement check runs BEFORE the recipe-manifest approval branch in
    // the supervisor, so this run must fail closed before either path fires.
    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: {
        working_dir: '.',
        session_name: 'auth-review',
        lifecycle: 'continue',
      },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    assert.equal(result.status, 'policy_violation');
    assert.match(result.reason, /session_missing/);
    assert.equal(executor.called, 0, 'executor must not run when session is missing');
  });

  it('persists a session contract on successful lifecycle=start', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeClaudeStubRecipe();
    writeStubRecipeFile(recipesDir, recipe);

    const resolvedInputs = {
      working_dir: '.',
      session_name: 'auth-review',
      lifecycle: 'start',
      no_session_persistence: true,
    };
    seedStubManifest(dir, recipesDir, recipe, resolvedInputs);

    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: resolvedInputs,
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    assert.equal(result.status, 'success');
    assert.equal(executor.called, 1);

    const contractPath = defaultSessionContractPath(
      join(dir, '.guardrail'),
      recipe.id,
      'auth-review',
    );
    assert.equal(existsSync(contractPath), true, 'session contract file must exist after success');

    const stored = loadSessionContract(contractPath);
    assert.equal(stored.tool, 'claude');
    assert.equal(stored.recipeId, 'claude-exec');
    assert.equal(stored.sessionName, 'auth-review');
    assert.equal(stored.lifecycle, 'start');
  });

  it('fails closed on session_drift when continue points at a different workingDir', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeClaudeStubRecipe();
    writeStubRecipeFile(recipesDir, recipe);

    // Pre-seed an approved session contract with a DIFFERENT workingDir.
    const approvedContract = buildSessionContract({
      tool: 'claude',
      recipeId: 'claude-exec',
      recipeVersion: '1.0.0',
      workingDir: resolve('/tmp/a-completely-different-path'),
      addDirs: [],
      sessionName: 'auth-review',
      sessionId: null,
      lifecycle: 'start',
    });
    const contractPath = defaultSessionContractPath(
      join(dir, '.guardrail'),
      recipe.id,
      'auth-review',
    );
    saveSessionContract(approvedContract, contractPath);

    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: {
        working_dir: '.',
        session_name: 'auth-review',
        lifecycle: 'continue',
      },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    assert.equal(result.status, 'policy_violation');
    assert.match(result.reason, /session_drift/);
    assert.match(result.reason, /workingDir/);
    assert.equal(executor.called, 0);
  });

  it('fails closed on session_attach_mismatch when identity fields disagree', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeClaudeStubRecipe();
    writeStubRecipeFile(recipesDir, recipe);

    // Pre-seed a contract for session-A with a DIFFERENT workingDir. Attach
    // will load this contract (slot matches), compare identity, and reject.
    const approvedContract = buildSessionContract({
      tool: 'claude',
      recipeId: 'claude-exec',
      recipeVersion: '1.0.0',
      workingDir: resolve('/tmp/some-other-tree'),
      addDirs: [],
      sessionName: 'session-A',
      sessionId: null,
      lifecycle: 'start',
    });
    const contractPath = defaultSessionContractPath(
      join(dir, '.guardrail'),
      recipe.id,
      'session-A',
    );
    saveSessionContract(approvedContract, contractPath);

    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: {
        working_dir: '.',
        session_name: 'session-A',
        lifecycle: 'attach',
      },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    assert.equal(result.status, 'policy_violation');
    assert.match(result.reason, /session_attach_mismatch/);
    assert.equal(executor.called, 0);
  });

  it('reuses interactive_message prompt in the same persistent session without reapproval', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeClaudeStubRecipe();
    writeStubRecipeFile(recipesDir, recipe);

    const approvedInputs = {
      working_dir: '.',
      session_name: 'auth-review',
      lifecycle: 'continue',
      no_session_persistence: false,
      prompt: 'Original prompt contents',
    };
    seedStubManifest(dir, recipesDir, recipe, approvedInputs);

    // Pre-seed a matching session contract so the session layer is happy.
    // Identity fields must match what buildCandidateSessionContract will
    // produce for the candidate run below, so both use working_dir='.'.
    const approvedContract = buildSessionContract({
      tool: 'claude',
      recipeId: 'claude-exec',
      recipeVersion: '1.0.0',
      workingDir: '.',
      addDirs: [],
      sessionName: 'auth-review',
      sessionId: null,
      lifecycle: 'continue',
    });
    const contractPath = defaultSessionContractPath(
      join(dir, '.guardrail'),
      recipe.id,
      'auth-review',
    );
    saveSessionContract(approvedContract, contractPath);

    // Now run with a DIFFERENT prompt. The session contract still matches
    // and prompt is interactive_message, so the recipe-manifest diff should
    // treat this as session-bound user traffic rather than drift.
    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: {
        working_dir: '.',
        session_name: 'auth-review',
        lifecycle: 'continue',
        no_session_persistence: false,
        prompt: 'A completely different prompt',
      },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    assert.equal(result.status, 'success');
    assert.equal(executor.called, 1, 'executor should run when only the interactive message changes');
  });

  it('still forces fresh approval for interactive_message prompt when persistence is disabled', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeClaudeStubRecipe();
    writeStubRecipeFile(recipesDir, recipe);

    const approvedInputs = {
      working_dir: '.',
      session_name: 'auth-review',
      lifecycle: 'continue',
      no_session_persistence: true,
      prompt: 'Original prompt contents',
    };
    seedStubManifest(dir, recipesDir, recipe, approvedInputs);

    const approvedContract = buildSessionContract({
      tool: 'claude',
      recipeId: 'claude-exec',
      recipeVersion: '1.0.0',
      workingDir: '.',
      addDirs: [],
      sessionName: 'auth-review',
      sessionId: null,
      lifecycle: 'continue',
    });
    const contractPath = defaultSessionContractPath(
      join(dir, '.guardrail'),
      recipe.id,
      'auth-review',
    );
    saveSessionContract(approvedContract, contractPath);

    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: {
        working_dir: '.',
        session_name: 'auth-review',
        lifecycle: 'continue',
        no_session_persistence: true,
        prompt: 'A completely different prompt',
      },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    assert.notEqual(result.status, 'success');
    assert.equal(executor.called, 0, 'executor must not run when persistence is disabled');
  });
});

// ---------------------------------------------------------------------------
// D0y: Guarded AI Exec Progress Channel tests
// ---------------------------------------------------------------------------

describe('D0y: progress-events schema', () => {
  it('AI_HEARTBEAT_POLICY declares all three thresholds', () => {
    assert.ok(typeof AI_HEARTBEAT_POLICY.firstCheckpointWarnSeconds === 'number');
    assert.ok(typeof AI_HEARTBEAT_POLICY.stallWarnSeconds === 'number');
    assert.ok(typeof AI_HEARTBEAT_POLICY.hardStallSeconds === 'number');
    assert.ok(AI_HEARTBEAT_POLICY.stallWarnSeconds > AI_HEARTBEAT_POLICY.firstCheckpointWarnSeconds);
    assert.ok(AI_HEARTBEAT_POLICY.hardStallSeconds > AI_HEARTBEAT_POLICY.stallWarnSeconds);
  });

  it('AI_SOFT_STATES contains exactly the four non-terminal states', () => {
    assert.ok(AI_SOFT_STATES.has('waiting_for_review'));
    assert.ok(AI_SOFT_STATES.has('waiting_for_input'));
    assert.ok(AI_SOFT_STATES.has('drift_warning'));
    assert.ok(AI_SOFT_STATES.has('stalled'));
    assert.equal(AI_SOFT_STATES.size, 4);
  });

  it('AI_CHECKPOINT_EVENTS includes all required event names', () => {
    const required = [
      'ai_checkpoint', 'ai_artifact_written', 'ai_question',
      'ai_review_requested', 'ai_drift_warning',
      'ai_waiting_for_input', 'ai_waiting_for_review',
      'ai_stalled', 'ai_resumed',
    ];
    for (const name of required) {
      assert.ok(AI_CHECKPOINT_EVENTS.includes(name), `missing event: ${name}`);
    }
  });

  it('AI_EVENT_TO_STATE maps review/question events to soft states', () => {
    assert.equal(AI_EVENT_TO_STATE['ai_question'], 'waiting_for_input');
    assert.equal(AI_EVENT_TO_STATE['ai_review_requested'], 'waiting_for_review');
    assert.equal(AI_EVENT_TO_STATE['ai_drift_warning'], 'drift_warning');
    assert.equal(AI_EVENT_TO_STATE['ai_stalled'], 'stalled');
    assert.equal(AI_EVENT_TO_STATE['ai_checkpoint'], 'running');
    assert.equal(AI_EVENT_TO_STATE['ai_resumed'], 'running');
  });
});

describe('D0y: parseAiProgressLine', () => {
  it('parses a well-formed [guardrail-ai-progress] line', () => {
    const payload = { event: 'ai_checkpoint', phase: 'started', message: 'hello', timestamp: '2026-01-01T00:00:00Z' };
    const line = `[guardrail-ai-progress] ${JSON.stringify(payload)}`;
    const result = parseAiProgressLine(line);
    assert.deepEqual(result, payload);
  });

  it('returns null for lines without the prefix', () => {
    assert.equal(parseAiProgressLine('{"event":"ai_checkpoint"}'), null);
    assert.equal(parseAiProgressLine('some random log line'), null);
  });

  it('returns null for null / non-string input', () => {
    assert.equal(parseAiProgressLine(null), null);
    assert.equal(parseAiProgressLine(undefined), null);
    assert.equal(parseAiProgressLine(42), null);
  });

  it('returns null for malformed JSON after prefix', () => {
    assert.equal(parseAiProgressLine('[guardrail-ai-progress] {not json}'), null);
  });
});

describe('D0y: emitAiProgress', () => {
  it('calls progressSink with expected AI event fields', () => {
    const events = [];
    emitAiProgress((evt) => events.push(evt), 'run-1', 'ai_checkpoint', {
      phase: 'init',
      message: 'starting',
      severity: 'info',
      tool: 'claude',
    });
    assert.equal(events.length, 1);
    const evt = events[0];
    assert.equal(evt.event, 'ai_checkpoint');
    assert.equal(evt.mode, 'ai_exec');
    assert.equal(evt.runId, 'run-1');
    assert.equal(evt.status, 'running');
    assert.equal(evt.tool, 'claude');
    assert.equal(evt.phase, 'init');
    assert.equal(evt.message, 'starting');
    assert.ok(typeof evt.timestamp === 'string');
  });

  it('maps review event to waiting_for_review status', () => {
    const events = [];
    emitAiProgress((evt) => events.push(evt), 'run-2', 'ai_review_requested', {
      message: 'please review',
    });
    assert.equal(events[0].status, 'waiting_for_review');
  });

  it('maps question event to waiting_for_input status', () => {
    const events = [];
    emitAiProgress((evt) => events.push(evt), 'run-3', 'ai_question', {
      message: 'what should I do?',
    });
    assert.equal(events[0].status, 'waiting_for_input');
  });

  it('is a no-op when progressSink is not a function', () => {
    // Must not throw
    emitAiProgress(null, 'run-4', 'ai_checkpoint', {});
    emitAiProgress(undefined, 'run-4', 'ai_checkpoint', {});
    emitAiProgress('not-a-fn', 'run-4', 'ai_checkpoint', {});
  });
});

describe('D0y: buildProgressSystemAppendix', () => {
  it('includes the progress file path', () => {
    const appendix = buildProgressSystemAppendix({
      progressFile: '/tmp/progress.ndjson',
      reportArtifact: '/tmp/report.md',
      heartbeatSeconds: 60,
    });
    assert.ok(appendix.includes('/tmp/progress.ndjson'));
    assert.ok(appendix.includes('/tmp/report.md'));
    assert.ok(appendix.includes('Guardrail Progress Contract'));
  });

  it('lists all valid event types', () => {
    const appendix = buildProgressSystemAppendix({
      progressFile: '/tmp/p.ndjson',
      reportArtifact: '',
      heartbeatSeconds: 30,
    });
    assert.ok(appendix.includes('ai_checkpoint'));
    assert.ok(appendix.includes('ai_question'));
    assert.ok(appendix.includes('ai_review_requested'));
    assert.ok(appendix.includes('ai_drift_warning'));
  });

  it('falls back gracefully when no options are provided', () => {
    const appendix = buildProgressSystemAppendix({});
    assert.ok(appendix.includes('Guardrail Progress Contract'));
    assert.ok(appendix.includes('(none declared)'));
  });
});

describe('D0y: parseWrapperArgs D0y flags', () => {
  it('parses --guardrail-progress-file', () => {
    const opts = parseWrapperArgs(['--guardrail-progress-file', '/tmp/p.ndjson']);
    assert.equal(opts.guardrailProgressFile, '/tmp/p.ndjson');
  });

  it('parses --guardrail-progress-state-file', () => {
    const opts = parseWrapperArgs(['--guardrail-progress-state-file', '/tmp/state.json']);
    assert.equal(opts.guardrailProgressStateFile, '/tmp/state.json');
  });

  it('parses --guardrail-report-artifact', () => {
    const opts = parseWrapperArgs(['--guardrail-report-artifact', '/tmp/report.md']);
    assert.equal(opts.guardrailReportArtifact, '/tmp/report.md');
  });

  it('parses --guardrail-heartbeat-seconds', () => {
    const opts = parseWrapperArgs(['--guardrail-heartbeat-seconds', '45']);
    assert.equal(opts.guardrailHeartbeatSeconds, '45');
  });

  it('D0y flags are absent from buildClaudeArgs output (never forwarded to Claude CLI)', () => {
    const args = buildClaudeArgs({
      model: 'claude-3-5-sonnet',
      guardrailProgressFile: '/tmp/p.ndjson',
      guardrailProgressStateFile: '/tmp/state.json',
      guardrailReportArtifact: '/tmp/report.md',
      guardrailHeartbeatSeconds: '60',
      promptPayload: 'hello',
    });
    for (const arg of args) {
      assert.ok(!String(arg).startsWith('--guardrail-'), `D0y flag leaked into Claude CLI args: ${arg}`);
    }
  });
});

describe('D0y: supervisor progress channel wiring', () => {
  it('supervisor injects progress env vars and emits supervisor_init checkpoint when progress_channel.enabled', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    const recipe = makeClaudeStubRecipe({
      progress_channel: { enabled: true },
    });
    writeStubRecipeFile(recipesDir, recipe);
    seedStubManifest(dir, recipesDir, recipe, {
      working_dir: '.',
      session_name: 'progress-test',
      lifecycle: 'start',
      no_session_persistence: true,
      prompt: 'test prompt',
    });

    const capturedEnv = {};
    const progressEvents = [];
    const executor = {
      called: 0,
      fn: async (_recipe, _inputs, opts) => {
        executor.called += 1;
        if (opts.envExtra) Object.assign(capturedEnv, opts.envExtra);
        return { status: 'success', stepsExecuted: 1, reason: null };
      },
    };

    await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: {
        working_dir: '.',
        session_name: 'progress-test',
        lifecycle: 'start',
        no_session_persistence: true,
        prompt: 'test prompt',
      },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
      progressSink: (evt) => progressEvents.push(evt),
    });

    assert.equal(executor.called, 1);
    assert.ok(capturedEnv.GUARDRAIL_AI_PROGRESS_FILE, 'progress file env var missing');
    assert.ok(capturedEnv.GUARDRAIL_AI_PROGRESS_STATE_FILE, 'progress state file env var missing');

    const stateFile = join(dir, '.guardrail', 'ai-progress-state.json');
    assert.ok(existsSync(stateFile), 'ai-progress-state.json not created');

    const initEvt = progressEvents.find((e) => e.event === 'ai_checkpoint' && e.phase === 'supervisor_init');
    assert.ok(initEvt, 'supervisor_init checkpoint not emitted to progress sink');
  });

  it('does not activate progress channel for recipes without progress_channel.enabled', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    const recipe = makeClaudeStubRecipe({ id: 'no-channel-recipe' });
    writeStubRecipeFile(recipesDir, recipe);
    seedStubManifest(dir, recipesDir, recipe, {
      working_dir: '.',
      session_name: 'no-progress',
      prompt: 'noop',
    });

    const progressEvents = [];
    const executor = stubExecutor();
    await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { working_dir: '.', session_name: 'no-progress', prompt: 'noop' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
      progressSink: (evt) => progressEvents.push(evt),
    });

    const aiEvents = progressEvents.filter((e) => String(e.event ?? '').startsWith('ai_'));
    assert.equal(aiEvents.length, 0, 'unexpected AI events emitted for non-progress recipe');
  });
});

describe('D0y: wrapper preserves soft states for continuation', () => {
  it('keeps waiting_for_input instead of overwriting it to completed on successful exit', async () => {
    const dir = tmpDir();
    const progressFile = join(dir, 'ai-progress.ndjson');
    const stateFile = join(dir, 'ai-progress-state.json');
    const argsFile = join(dir, 'claude-args.json');

    const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const appendIndex = args.indexOf('--append-system-prompt');
const appendix = appendIndex >= 0 ? args[appendIndex + 1] || '' : '';
const match = appendix.match(/Progress file path: (.+)/);
const progressFile = match ? match[1].trim() : '';
if (progressFile) {
  const evt = {
    event: 'ai_question',
    status: 'waiting_for_input',
    phase: 'review_gate',
    message: 'Need operator confirmation',
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(progressFile, JSON.stringify(evt) + '\\n');
}
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
process.stdout.write('stub-ok\\n');
`;
    const { binDir } = writeClaudeStub(dir, stub);

    const originalPath = process.env.PATH;
    process.env.PATH = prependPath(binDir);
    try {
      await runClaudeExec({
        prompt: 'continue',
        systemPrompt: 'base system',
        sessionName: 'd0y-soft-state',
        workingDir: dir,
        guardrailProgressFile: progressFile,
        guardrailProgressStateFile: stateFile,
        guardrailReportArtifact: join(dir, 'report.md'),
      });
    } finally {
      process.env.PATH = originalPath;
    }

    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.status, 'waiting_for_input');
    assert.equal(state.lastPhase, 'awaiting_operator');

    const argv = JSON.parse(readFileSync(argsFile, 'utf8'));
    assert.ok(argv.includes('--print'));
    assert.ok(argv.includes('--name'));
  });
});

describe('D0y: CLI progress and continuation surfaces', () => {
  it('recipe progress prints a bounded snapshot from the progress files', () => {
    const dir = tmpDir();
    const stateDir = join(dir, '.guardrail');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'ai-progress-state.json'), JSON.stringify({
      runId: 'run-progress',
      status: 'running',
      lastPhase: 'implementing',
      lastMessage: 'Applying patch',
      sessionName: 'progress-session',
    }, null, 2));
    writeFileSync(join(stateDir, 'ai-progress.ndjson'), [
      JSON.stringify({
        event: 'ai_checkpoint',
        phase: 'started',
        message: 'Started',
        timestamp: '2026-04-11T10:00:00.000Z',
      }),
    ].join('\n') + '\n');

    const result = spawnSync('node', [CLI_PATH, 'recipe', 'progress', '--state-dir', stateDir], {
      cwd: resolve(process.cwd()),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Status:\s+running/);
    assert.match(result.stdout, /Checkpoints \(1\):/);
    assert.match(result.stdout, /Started/);
  });

  it('recipe progress --follow emits updates and exits on terminal state', async () => {
    const dir = tmpDir();
    const stateDir = join(dir, '.guardrail');
    mkdirSync(stateDir, { recursive: true });
    const stateFile = join(stateDir, 'ai-progress-state.json');
    const progressFile = join(stateDir, 'ai-progress.ndjson');

    writeFileSync(stateFile, JSON.stringify({
      runId: 'run-follow',
      status: 'running',
      lastPhase: 'started',
      lastMessage: 'Booting',
    }, null, 2));
    writeFileSync(progressFile, JSON.stringify({
      event: 'ai_checkpoint',
      phase: 'started',
      message: 'Booting',
      timestamp: '2026-04-11T10:00:00.000Z',
    }) + '\n');

    const child = spawn('node', [CLI_PATH, 'recipe', 'progress', '--state-dir', stateDir, '--follow'], {
      cwd: resolve(process.cwd()),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
    writeFileSync(progressFile, [
      JSON.stringify({
        event: 'ai_checkpoint',
        phase: 'started',
        message: 'Booting',
        timestamp: '2026-04-11T10:00:00.000Z',
      }),
      JSON.stringify({
        event: 'ai_checkpoint',
        phase: 'review',
        message: 'Halfway there',
        timestamp: '2026-04-11T10:00:01.000Z',
      }),
    ].join('\n') + '\n');
    writeFileSync(stateFile, JSON.stringify({
      runId: 'run-follow',
      status: 'completed',
      lastPhase: 'completed',
      lastMessage: 'Done',
    }, null, 2));

    const exitCode = await new Promise((resolvePromise, rejectPromise) => {
      child.on('error', rejectPromise);
      child.on('close', resolvePromise);
    });

    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /Status:\s+running/);
    assert.match(stdout, /Halfway there/);
    assert.match(stdout, /Status:\s+completed/);
  });

  it('recipe continue resumes an eligible run through the same Guardrail wrapper path', () => {
    const dir = tmpDir();
    const stateDir = join(dir, '.guardrail');
    mkdirSync(stateDir, { recursive: true });
    const progressFile = join(stateDir, 'ai-progress.ndjson');
    const stateFile = join(stateDir, 'ai-progress-state.json');
    const argsFile = join(dir, 'continue-args.json');

    writeFileSync(stateFile, JSON.stringify({
      runId: 'run-continue',
      status: 'waiting_for_input',
      sessionName: 'continue-session',
      sessionId: 'sess-123',
      workingDir: dir,
      progressArtifact: progressFile,
    }, null, 2));
    writeFileSync(progressFile, '');

    const stub = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('continued\\n');
`;
    const { binDir } = writeClaudeStub(dir, stub);

    const result = spawnSync('node', [
      CLI_PATH,
      'recipe',
      'continue',
      '--state-dir', stateDir,
      '--prompt', 'ship it',
    ], {
      cwd: resolve(process.cwd()),
      env: { ...process.env, PATH: prependPath(binDir) },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /continued/);

    const argv = JSON.parse(readFileSync(argsFile, 'utf8'));
    assert.ok(argv.includes('--print'));
    assert.ok(argv.includes('--name'));
    assert.ok(argv.includes('continue-session'));

    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.status, 'completed');
  });
});
