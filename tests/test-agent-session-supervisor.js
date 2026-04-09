import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-session-sup-')));
}

function makeSessionCapableRecipe(overrides = {}) {
  const recipe = {
    id: 'claude-exec',
    name: 'Claude Exec Test Stub',
    description: 'Test stub matching the claude-exec wrapper id for session enforcement tests',
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

// ===========================================================================
// 1. Missing session contract with lifecycle=continue is a fail-closed branch
// ===========================================================================

describe('Recipe Supervisor: agent session enforcement', () => {
  it('fails closed with session_missing when continue has no prior contract', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeSessionCapableRecipe();
    writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { working_dir: '.', lifecycle: 'continue' },
      cwd: dir,
      searchDirs: [recipesDir],
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    assert.equal(result.status, 'policy_violation');
    assert.ok(typeof result.reason === 'string');
    assert.match(result.reason, /session_missing/);
    assert.equal(executor.called, 0, 'executor must not run when session contract is blocked');
  });

  it('persists session contract on successful start with injected executor', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeSessionCapableRecipe();
    writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    // Pre-seed an approved recipe manifest so we skip interactive approval.
    // Risk fields must match what recipe-supervisor.evaluateRecipeRisk
    // produces for a single-step verified claude-exec recipe, otherwise the
    // manifest diff check triggers before session enforcement can run.
    const { createRecipeManifest, hashRecipe } = await import('../src/recipe.js');
    const { saveManifest } = await import('../src/manifest.js');
    const manifest = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      {
        trustClass: 'pinned_external',
        riskLevel: 'yellow',
        reasons: ['recipe declares low risk', HOST_BOUNDARY_WARNING],
        requiresStrongConfirmation: false,
      },
      { working_dir: '.', lifecycle: 'start' },
      { cwd: resolve(dir), projectRoot: resolve(dir), sourcePath: join(recipesDir, `${recipe.id}.recipe.json`) },
    );
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    saveManifest(manifest, manifestPath);

    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { working_dir: '.', lifecycle: 'start' },
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
      recipe.id,
      null,
    );
    assert.equal(existsSync(contractPath), true);
  });

  it('does not enforce session contracts when lifecycle input is absent', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    // No lifecycle input on this recipe — enforcement must be skipped.
    const recipe = {
      id: 'legacy-recipe',
      name: 'Legacy Recipe',
      description: 'Legacy recipe without lifecycle input',
      version: '1.0.0',
      author: 'test',
      category: 'custom',
      channel: 'verified',
      inputs: { target: { type: 'string', pattern: '^[a-z]+$' } },
      steps: [
        {
          id: 'noop',
          description: 'noop',
          run: { command: 'echo', args: ['hello'], mode: 'structured', timeoutMs: 5000 },
        },
      ],
      guardrails: { constraints: ['structured'], invariants: ['no shell'] },
      approval_required: false,
      risk_level: 'low',
    };
    recipe.signature = signRecipe(recipe);
    writeRecipeFile(recipesDir, recipe);

    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    // Pre-seed manifest.
    const { createRecipeManifest, hashRecipe } = await import('../src/recipe.js');
    const { saveManifest } = await import('../src/manifest.js');
    const manifest = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      {
        trustClass: 'pinned_external',
        riskLevel: 'green',
        reasons: ['recipe declares low risk'],
        requiresStrongConfirmation: false,
      },
      { target: 'hello' },
      { cwd: resolve(dir), projectRoot: resolve(dir), sourcePath: join(recipesDir, `${recipe.id}.recipe.json`) },
    );
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    saveManifest(manifest, manifestPath);

    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { target: 'hello' },
      cwd: dir,
      searchDirs: [recipesDir],
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      executorFn: executor.fn,
    });

    assert.equal(result.status, 'success');
    assert.equal(executor.called, 1);

    // No session contract should be written for recipes without lifecycle input.
    const contractPath = defaultSessionContractPath(
      join(dir, '.guardrail'),
      recipe.id,
      null,
    );
    assert.equal(existsSync(contractPath), false);
  });

  it('fails closed on session_drift when continue points at a different workingDir', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeSessionCapableRecipe();
    writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    // Pre-seed an approved session contract for a different working dir.
    const approvedContract = buildSessionContract({
      tool: 'claude',
      recipeId: 'claude-exec',
      recipeVersion: '1.0.0',
      workingDir: resolve('/tmp/some-other-repo'),
      addDirs: [],
      sessionName: null,
      sessionId: null,
      lifecycle: 'start',
    });
    const contractPath = defaultSessionContractPath(join(dir, '.guardrail'), recipe.id, null);
    saveSessionContract(approvedContract, contractPath);

    const executor = stubExecutor();
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { working_dir: '.', lifecycle: 'continue' },
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
});
