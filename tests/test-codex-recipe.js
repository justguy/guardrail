import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { loadRecipe, createRecipeManifest, hashRecipe } from '../src/recipe.js';
import { saveManifest } from '../src/manifest.js';
import { buildPromptPayload } from '../src/prompt-inputs.js';
import {
  parseWrapperArgs,
  buildCodexExecArgs,
  emitSessionMetadata,
} from '../src/codex-exec-wrapper.js';
import { runRecipeSupervisor } from '../src/recipe-supervisor.js';
import { signRecipe } from '../src/recipe-channel.js';
import {
  buildSessionContract,
  saveSessionContract,
  defaultSessionContractPath,
} from '../src/agent-session.js';

// Mirrors recipe-supervisor.HOST_BOUNDARY_WARNING for deterministic test
// fixtures. If the supervisor text changes, this test will drift and the
// integrator should update both in the same commit.
const HOST_BOUNDARY_WARNING = 'Guardrail does not sandbox host execution; this wrapper relies on the tool/runtime permission model';

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-codex-recipe-')));
}

function makeCodexSessionStubRecipe(overrides = {}) {
  const recipe = {
    id: 'codex-exec',
    name: 'Codex Exec Test Stub',
    description: 'Test stub matching the codex-exec wrapper id for session enforcement tests',
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
      lifecycle: {
        type: 'string',
        enum: ['start', 'continue', 'attach'],
        default: 'start',
      },
      session_name: {
        type: 'string',
        pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$',
        required: false,
      },
      prompt: {
        type: 'string',
        approval_mode: 'interactive_message',
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

function writeRecipeFile(dir, recipe) {
  const filePath = join(dir, `${recipe.id}.recipe.json`);
  writeFileSync(filePath, JSON.stringify(recipe, null, 2), 'utf8');
  return filePath;
}

function stubExecutor() {
  let called = 0;
  const fn = async () => {
    called += 1;
    return { status: 'success', stepsExecuted: 1, reason: null };
  };
  return { fn, get called() { return called; } };
}

function seedApprovedRecipeManifest(recipe, inputs, dir, recipesDir, manifestPath) {
  const manifest = createRecipeManifest(
    recipe,
    hashRecipe(recipe),
    {
      trustClass: 'pinned_external',
      riskLevel: 'yellow',
      reasons: ['recipe declares low risk', HOST_BOUNDARY_WARNING],
      requiresStrongConfirmation: false,
    },
    inputs,
    {
      cwd: resolve(dir),
      projectRoot: resolve(dir),
      sourcePath: join(recipesDir, `${recipe.id}.recipe.json`),
    },
  );
  manifest.riskAssessment.acknowledgedBy = 'test';
  manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
  saveManifest(manifest, manifestPath);
  return manifest;
}

describe('Codex recipe', () => {
  it('loads the codex exec recipe', () => {
    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'codex-exec.recipe.json'));
    assert.equal(recipe.id, 'codex-exec');
    assert.equal(recipe.version, '1.0.0');
    assert.equal(recipe.risk_level, 'high');
    assert.equal(recipe.steps.length, 1);
    assert.equal(recipe.inputs.prompt.approval_mode, 'interactive_message');
    assert.ok(
      recipe.guardrails?.constraints?.some((line) => line.includes('interactive_message semantics')),
    );
  });

  it('loads the codex exec recipe with session lifecycle inputs', () => {
    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'codex-exec.recipe.json'));
    assert.ok(recipe.inputs.lifecycle, 'lifecycle input must be declared');
    assert.equal(recipe.inputs.lifecycle.type, 'string');
    assert.deepEqual(recipe.inputs.lifecycle.enum, ['start', 'continue', 'attach']);
    assert.equal(recipe.inputs.lifecycle.default, 'start');

    assert.ok(recipe.inputs.session_name, 'session_name input must be declared');
    assert.equal(recipe.inputs.session_name.type, 'string');
    assert.equal(recipe.inputs.session_name.pattern, '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$');

    assert.ok(recipe.inputs.session_id, 'session_id input must be declared');
    assert.equal(recipe.inputs.session_id.type, 'string');
    assert.equal(recipe.inputs.session_id.pattern, '^[A-Za-z0-9_-]{1,128}$');
  });

  it('parses wrapper args by flag name', () => {
    const parsed = parseWrapperArgs([
      '--prompt', 'Fix the bug',
      '--input-files', 'src/a.js,src/b.js',
      '--sandbox', 'workspace-write',
      '--json', 'true',
      '--full-auto', 'false',
    ]);
    assert.equal(parsed.prompt, 'Fix the bug');
    assert.equal(parsed.inputFiles, 'src/a.js,src/b.js');
    assert.equal(parsed.sandbox, 'workspace-write');
    assert.equal(parsed.json, 'true');
    assert.equal(parsed.fullAuto, 'false');
  });

  it('parses session lifecycle flags', () => {
    const parsed = parseWrapperArgs([
      '--lifecycle', 'continue',
      '--session-name', 'refactor-sprint',
      '--session-id', 'codex-123',
    ]);
    assert.equal(parsed.lifecycle, 'continue');
    assert.equal(parsed.sessionName, 'refactor-sprint');
    assert.equal(parsed.sessionId, 'codex-123');
  });

  it('builds prompt payload from inline prompt and input files', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'context.txt'), 'Injected context\n');
    writeFileSync(join(dir, 'notes.md'), 'More context\n');

    const payload = buildPromptPayload({
      prompt: 'Inline instruction',
      inputFiles: ['context.txt', 'notes.md'],
      baseDir: dir,
    });

    assert.match(payload, /Inline instruction/);
    assert.match(payload, /<input_file path="context.txt">/);
    assert.match(payload, /Injected context/);
    assert.match(payload, /<input_file path="notes.md">/);
    assert.match(payload, /More context/);
  });

  it('builds codex exec args from normalized options', () => {
    const args = buildCodexExecArgs({
      model: 'gpt-5-codex',
      profile: 'default',
      sandbox: 'workspace-write',
      workingDir: '/tmp/project',
      addDirs: ['/tmp/project/docs'],
      imageFiles: ['/tmp/project/diagram.png'],
      json: true,
      outputLastMessageFile: '/tmp/project/last.txt',
      outputSchemaFile: '/tmp/project/schema.json',
      color: 'never',
      oss: true,
      localProvider: 'ollama',
      skipGitRepoCheck: true,
      ephemeral: true,
      fullAuto: false,
    });

    assert.deepEqual(args, [
      'exec',
      '--model', 'gpt-5-codex',
      '--profile', 'default',
      '--sandbox', 'workspace-write',
      '--cd', '/tmp/project',
      '--add-dir', '/tmp/project/docs',
      '--image', '/tmp/project/diagram.png',
      '--json',
      '--output-last-message', '/tmp/project/last.txt',
      '--output-schema', '/tmp/project/schema.json',
      '--color', 'never',
      '--oss',
      '--local-provider', 'ollama',
      '--skip-git-repo-check',
      '--ephemeral',
      '-',
    ]);
  });

  it('buildCodexExecArgs never leaks lifecycle/session fields into codex argv', () => {
    const args = buildCodexExecArgs({
      model: 'gpt-5',
      sandbox: 'workspace-write',
      lifecycle: 'continue',
      sessionName: 'refactor-sprint',
      sessionId: 'codex-123',
    });

    // Positive assertions: the real codex-visible flags are still there.
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('gpt-5'));
    assert.ok(args.includes('--sandbox'));
    assert.ok(args.includes('workspace-write'));

    // Negative assertions: Guardrail-internal session fields must NOT leak
    // into the argv that reaches the codex binary.
    for (const forbidden of [
      '--lifecycle',
      '--session-name',
      '--session-id',
      'continue',
      'refactor-sprint',
      'codex-123',
    ]) {
      assert.ok(
        !args.includes(forbidden),
        `codex exec argv must not contain ${forbidden}; got ${JSON.stringify(args)}`,
      );
    }
  });

  it('emitSessionMetadata returns a structured codex metadata record', () => {
    const meta = emitSessionMetadata({
      lifecycle: 'continue',
      sessionName: 'refactor',
      sessionId: 'cid-1',
      workingDir: '/tmp/work',
    });
    assert.deepEqual(meta, {
      tool: 'codex',
      lifecycle: 'continue',
      sessionName: 'refactor',
      sessionId: 'cid-1',
      workingDir: '/tmp/work',
    });
  });
});

describe('Codex recipe: session-contract enforcement', () => {
  it('fails closed with session_missing on continue with no prior contract', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeCodexSessionStubRecipe();
    writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { working_dir: '.', lifecycle: 'continue', session_name: 'refactor-sprint' },
      cwd: dir,
      searchDirs: [recipesDir],
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    assert.equal(result.status, 'policy_violation');
    assert.match(result.reason, /session_missing/);
    assert.equal(executor.called, 0, 'executor must not run when session contract is blocked');
  });

  it('persists a session contract on successful start with matching slot', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeCodexSessionStubRecipe();
    writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    seedApprovedRecipeManifest(
      recipe,
      { working_dir: '.', lifecycle: 'start', session_name: 'refactor-sprint' },
      dir,
      recipesDir,
      manifestPath,
    );

    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { working_dir: '.', lifecycle: 'start', session_name: 'refactor-sprint' },
      cwd: dir,
      searchDirs: [recipesDir],
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    assert.equal(result.status, 'success');
    assert.equal(executor.called, 1);

    const contractPath = defaultSessionContractPath(
      join(dir, '.guardrail'),
      'codex-exec',
      'refactor-sprint',
    );
    assert.equal(existsSync(contractPath), true);

    const { loadSessionContract } = await import('../src/agent-session.js');
    const stored = loadSessionContract(contractPath);
    assert.equal(stored.tool, 'codex');
    assert.equal(stored.recipeId, 'codex-exec');
    assert.equal(stored.lifecycle, 'start');
    assert.equal(stored.sessionName, 'refactor-sprint');
  });

  it('fails closed with session_drift when continue points at a different working dir', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeCodexSessionStubRecipe();
    writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    // Pre-seed session contract for a different working dir
    const approvedContract = buildSessionContract({
      tool: 'codex',
      recipeId: 'codex-exec',
      recipeVersion: '1.0.0',
      workingDir: resolve('/tmp/some-other-codex-repo'),
      addDirs: [],
      sessionName: 'refactor-sprint',
      sessionId: null,
      lifecycle: 'start',
    });
    const contractPath = defaultSessionContractPath(
      join(dir, '.guardrail'),
      'codex-exec',
      'refactor-sprint',
    );
    saveSessionContract(approvedContract, contractPath);

    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { working_dir: '.', lifecycle: 'continue', session_name: 'refactor-sprint' },
      cwd: dir,
      searchDirs: [recipesDir],
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    assert.equal(result.status, 'policy_violation');
    assert.match(result.reason, /session_drift/);
    assert.equal(executor.called, 0);
  });

  it('reuses interactive_message prompt when the session contract matches', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeCodexSessionStubRecipe();
    writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    // Pre-seed the recipe manifest with one prompt value.
    seedApprovedRecipeManifest(
      recipe,
      { working_dir: '.', lifecycle: 'continue', session_name: 'refactor-sprint', prompt: 'original prompt' },
      dir,
      recipesDir,
      manifestPath,
    );

    // Pre-seed a matching session contract so session enforcement passes.
    // The candidate built by the supervisor resolves `.` through
    // buildSessionContract, which calls resolve() against process.cwd().
    // We mirror that resolution here so the pre-seeded contract identity
    // matches the candidate and session enforcement passes, leaving only
    // the review_each_time prompt drift to be tested.
    const approvedContract = buildSessionContract({
      tool: 'codex',
      recipeId: 'codex-exec',
      recipeVersion: '1.0.0',
      workingDir: process.cwd(),
      addDirs: [],
      sessionName: 'refactor-sprint',
      sessionId: null,
      lifecycle: 'start',
    });
    const contractPath = defaultSessionContractPath(
      join(dir, '.guardrail'),
      'codex-exec',
      'refactor-sprint',
    );
    saveSessionContract(approvedContract, contractPath);

    // Run with a DIFFERENT prompt — session matches and prompt is
    // interactive_message, so this should reuse the approved manifest.
    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: {
        working_dir: '.',
        lifecycle: 'continue',
        session_name: 'refactor-sprint',
        prompt: 'a different prompt',
      },
      cwd: dir,
      searchDirs: [recipesDir],
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    assert.equal(result.status, 'success');
    assert.equal(executor.called, 1, 'executor must run when only the interactive message changes');
  });
});
