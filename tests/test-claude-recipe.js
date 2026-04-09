import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { loadRecipe, createRecipeManifest, compareRecipeManifests, hashRecipe } from '../src/recipe.js';
import {
  parseWrapperArgs,
  buildClaudeArgs,
  buildClaudeFailureMessage,
  emitSessionMetadata,
} from '../src/claude-exec-wrapper.js';
import {
  collectRecipeInputContentHashes,
  verifyRecipeInputContentHashes,
} from '../src/prompt-inputs.js';
import {
  runRecipeSupervisor,
  formatAllowUnverifiedReapprovalNotice,
} from '../src/recipe-supervisor.js';
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

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-claude-recipe-')));
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
        approval_mode: 'review_each_time',
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
    assert.match(recipe.description, /OS-managed secure stores|process-identity-gated runtime state/);
    assert.match(recipe.description, /exact same shell\/runtime that will later launch Guardrail/);
    assert.ok(
      recipe.guardrails?.constraints?.some((line) => line.includes('secure-store-backed CLI auth')),
    );
    assert.ok(
      recipe.guardrails?.constraints?.some((line) => line.includes('--env-allow') && line.includes('requires_env')),
    );
    assert.match(recipe.inputs.system_prompt.description, /Workflow recipe_ref usage does not bypass this reapproval rule/);
    assert.ok(
      recipe.guardrails?.constraints?.some((line) => line.includes('recipe_ref chaining') && line.includes('local template')),
    );
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
        searchDirs: [recipesDir],
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
      searchDirs: [recipesDir],
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
    };
    seedStubManifest(dir, recipesDir, recipe, resolvedInputs);

    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: resolvedInputs,
      cwd: dir,
      searchDirs: [recipesDir],
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
      searchDirs: [recipesDir],
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
      searchDirs: [recipesDir],
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    assert.equal(result.status, 'policy_violation');
    assert.match(result.reason, /session_attach_mismatch/);
    assert.equal(executor.called, 0);
  });

  it('still forces fresh approval for review_each_time prompt even when session matches', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeClaudeStubRecipe();
    writeStubRecipeFile(recipesDir, recipe);

    const approvedInputs = {
      working_dir: '.',
      session_name: 'auth-review',
      lifecycle: 'continue',
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

    // Now run with a DIFFERENT prompt. The session contract still matches,
    // but prompt is review_each_time so the recipe-manifest diff must force
    // fresh approval. In non-interactive mode that surfaces as drift.
    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: {
        working_dir: '.',
        session_name: 'auth-review',
        lifecycle: 'continue',
        prompt: 'A completely different prompt',
      },
      cwd: dir,
      searchDirs: [recipesDir],
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    // The prompt change must block the run — session match must NOT bypass
    // prompt reapproval.
    assert.notEqual(result.status, 'success');
    assert.equal(executor.called, 0, 'executor must not run when prompt drift is detected');
    assert.ok(
      result.status === 'drift_detected' || result.status === 'approval_required',
      `expected drift_detected or approval_required, got ${result.status}`,
    );
  });
});
