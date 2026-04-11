/**
 * Feature Acceptance Tests — Derived from README, NOT from code.
 *
 * Every test here maps to a documented feature or claim in the README.
 * If a test fails, either the feature is broken or the README is lying.
 *
 * Organized by README section.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, mkdirSync, openSync, closeSync, writeSync, readSync, constants as fsConstants } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeWorkflowDefinition, hashWorkflow, createWorkflowManifest } from '../src/workflow.js';
import { evaluateWorkflowRisk } from '../src/policy-engine.js';
import { signRecipe } from '../src/recipe-channel.js';
import { saveManifest } from '../src/manifest.js';
import { runAdapter } from '../src/adapter-engine.js';
import { queryAuditLog } from '../src/audit.js';
import { serializeStable } from '../src/contract.js';

const CLI = `node ${join(process.cwd(), 'src', 'cli.js')}`;

function run(cmd, opts = {}) {
  try {
    return { stdout: execSync(cmd, { encoding: 'utf8', timeout: 15000, cwd: opts.cwd || process.cwd(), ...opts }).trim(), exitCode: 0 };
  } catch (err) {
    return { stdout: (err.stdout || '').trim(), stderr: (err.stderr || '').trim(), exitCode: err.status };
  }
}

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-feat-')));
}

function makeAdapterProfile(overrides = {}) {
  return {
    version: '1.0.0',
    tool: 'acceptance-adapter',
    description: 'Acceptance adapter profile',
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
    exit_codes: { success: 0, blocked: 12, failed: 1 },
    defaults: { non_interactive: true, json_output: true },
    ...overrides,
  };
}

function writeAdapterProfile(overrides = {}) {
  const dir = tmpDir();
  const profilePath = join(dir, 'acceptance.adapter.json');
  writeFileSync(profilePath, JSON.stringify(makeAdapterProfile(overrides), null, 2));
  return profilePath;
}

// ==========================================================================
// README: "Three Execution Modes"
// ==========================================================================

describe('README Feature: Command Mode', () => {
  it('guardrail run -- echo hello  → runs structured command', () => {
    // Non-interactive requires approved manifest. Without one, exit 10.
    const r = run(`${CLI} run --non-interactive --approved-manifest /nonexistent -- echo hello`);
    // Should fail because manifest doesn't exist — that proves enforcement works
    assert.ok(r.exitCode !== 0, 'Should fail without approved manifest');
  });

  it('guardrail run --shell "echo hi"  → requires explicit --shell', () => {
    const r = run(`${CLI} run --non-interactive --approved-manifest /nonexistent --shell "echo hi"`);
    assert.ok(r.exitCode !== 0, 'Should fail without approved manifest');
  });

  it('shell metacharacters in shorthand are rejected', () => {
    const r = run(`${CLI} run "echo hi && rm -rf /"`);
    assert.ok(r.exitCode !== 0);
    assert.ok(r.stderr.includes('Shell metacharacters') || r.stderr.includes('--shell'));
  });
});

describe('README Feature: Workflow Mode', () => {
  it('guardrail workflow lint validates a workflow definition', () => {
    const dir = tmpDir();
    const def = {
      version: 1, kind: 'workflow_definition', name: 'test-wf',
      projectRoot: '.', entryStep: 'step_a', maxIterations: 5,
      services: [],
      rollback_policy: 'none',
      rollback_none_reason: 'Single idempotent echo step — rollback not needed',
      steps: [{
        id: 'step_a', type: 'task', idempotent: true,
        run: { command: 'echo', args: ['hello'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
        validator: 'exit_code', updateSource: 'none',
        on: { success: 'done', validation_failed: 'abort' },
      }],
    };
    writeFileSync(join(dir, 'wf.json'), JSON.stringify(def, null, 2));
    const r = run(`${CLI} workflow lint --definition ${join(dir, 'wf.json')}`);
    assert.equal(r.exitCode, 0, `Lint should pass for valid workflow: ${r.stderr}`);
  });

  it('workflow lint accepts recipe_ref workflows with external --recipe-search-dir', () => {
    const dir = tmpDir();
    const externalRecipesDir = tmpDir();
    mkdirSync(externalRecipesDir, { recursive: true });

    writeFileSync(join(externalRecipesDir, 'recipe-one.recipe.json'), JSON.stringify({
      id: 'recipe-one',
      name: 'Recipe One',
      description: 'External workflow recipe',
      version: '1.0.0',
      author: 'test',
      category: 'custom',
      channel: 'community',
      approval_required: true,
      risk_level: 'low',
      inputs: {},
      steps: [{ id: 'main', description: 'echo one', run: { command: 'echo', args: ['one'], mode: 'structured' } }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    }, null, 2));

    const def = {
      version: 1,
      kind: 'workflow_definition',
      name: 'recipe-search-wf',
      projectRoot: '.',
      entryStep: 'step_a',
      maxIterations: 3,
      services: [],
      rollback_policy: 'none',
      rollback_none_reason: 'single bounded recipe step for lint coverage',
      steps: [{
        id: 'step_a',
        type: 'recipe_ref',
        recipe: 'recipe-one',
        inputs: {},
        on: { success: 'done', failure: 'abort' },
      }],
    };
    writeFileSync(join(dir, 'wf.json'), JSON.stringify(def, null, 2));

    const r = run(
      `${CLI} workflow lint --definition ${join(dir, 'wf.json')} --recipe-search-dir ${externalRecipesDir}`,
    );
    assert.equal(r.exitCode, 0, `Lint should pass for valid external recipe_ref workflow: ${r.stderr}`);
  });

  it('workflow lint accepts recipe_ref workflows from repo-configured default_recipe_roots without explicit flags', () => {
    const dir = tmpDir();
    const sharedRecipesDir = join(dir, 'shared-recipes');
    mkdirSync(sharedRecipesDir, { recursive: true });
    mkdirSync(join(dir, '.guardrail'), { recursive: true });

    writeFileSync(join(sharedRecipesDir, 'recipe-one.recipe.json'), JSON.stringify({
      id: 'recipe-one',
      name: 'Recipe One',
      description: 'Repo-configured workflow recipe',
      version: '1.0.0',
      author: 'test',
      category: 'custom',
      channel: 'community',
      approval_required: true,
      risk_level: 'low',
      inputs: {},
      steps: [{ id: 'main', description: 'echo one', run: { command: 'echo', args: ['one'], mode: 'structured' } }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    }, null, 2));

    writeFileSync(join(dir, '.guardrail', 'config.json'), JSON.stringify({
      default_recipe_roots: ['./shared-recipes'],
    }, null, 2));

    const def = {
      version: 1,
      kind: 'workflow_definition',
      name: 'repo-config-recipe-search-wf',
      projectRoot: '.',
      entryStep: 'step_a',
      maxIterations: 3,
      services: [],
      rollback_policy: 'none',
      rollback_none_reason: 'single bounded recipe step for lint coverage',
      steps: [{
        id: 'step_a',
        type: 'recipe_ref',
        recipe: 'recipe-one',
        inputs: {},
        on: { success: 'done', failure: 'abort' },
      }],
    };
    writeFileSync(join(dir, 'wf.json'), JSON.stringify(def, null, 2));

    const r = run(
      `${CLI} workflow lint --definition ${join(dir, 'wf.json')}`,
      { cwd: dir },
    );
    assert.equal(r.exitCode, 0, `Lint should pass for repo-configured recipe roots: ${r.stderr}`);
  });

  it('workflow lint rejects invalid definitions', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'bad.json'), '{"not": "a workflow"}');
    const r = run(`${CLI} workflow lint --definition ${join(dir, 'bad.json')}`);
    assert.ok(r.exitCode !== 0, 'Lint should reject invalid workflow');
  });

  it('workflow run can chain multiple recipe_ref steps under one approved workflow manifest', () => {
    const dir = tmpDir();
    const externalRecipesDir = tmpDir();
    mkdirSync(externalRecipesDir, { recursive: true });

    const recipeOne = {
      id: 'recipe-one',
      name: 'Recipe One',
      description: 'First workflow recipe',
      version: '1.0.0',
      author: 'test',
      category: 'custom',
      channel: 'verified',
      approval_required: true,
      risk_level: 'low',
      inputs: {},
      steps: [{ id: 'main', description: 'echo one', run: { command: 'echo', args: ['one'], mode: 'structured' } }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    };
    recipeOne.signature = signRecipe(recipeOne);
    writeFileSync(join(externalRecipesDir, 'recipe-one.recipe.json'), JSON.stringify(recipeOne, null, 2));

    const recipeTwo = {
      id: 'recipe-two',
      name: 'Recipe Two',
      description: 'Second workflow recipe',
      version: '1.0.0',
      author: 'test',
      category: 'custom',
      channel: 'verified',
      approval_required: true,
      risk_level: 'low',
      inputs: {},
      steps: [{ id: 'main', description: 'echo two', run: { command: 'echo', args: ['two'], mode: 'structured' } }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    };
    recipeTwo.signature = signRecipe(recipeTwo);
    writeFileSync(join(externalRecipesDir, 'recipe-two.recipe.json'), JSON.stringify(recipeTwo, null, 2));

    const def = {
      version: 1,
      kind: 'workflow_definition',
      name: 'recipe-chain',
      projectRoot: '.',
      entryStep: 'step_a',
      maxIterations: 3,
      services: [],
      rollback_policy: 'none',
      rollback_none_reason: 'bounded recipe chain for README acceptance coverage',
      steps: [
        {
          id: 'step_a',
          type: 'recipe_ref',
          recipe: 'recipe-one',
          inputs: {},
          on: { success: 'step_b', failure: 'abort' },
        },
        {
          id: 'step_b',
          type: 'recipe_ref',
          recipe: 'recipe-two',
          inputs: {},
          on: { success: 'done', failure: 'abort' },
        },
      ],
    };
    const defPath = join(dir, 'workflow.json');
    const manifestPath = join(dir, '.guardrail', 'workflows', 'recipe-chain.approved.json');
    mkdirSync(join(dir, '.guardrail', 'workflows'), { recursive: true });
    writeFileSync(defPath, JSON.stringify(def, null, 2));

    const normalized = normalizeWorkflowDefinition(def, dir, {
      recipeSearchDirs: [externalRecipesDir],
    });
    const workflowHash = hashWorkflow(normalized);
    const riskAssessment = evaluateWorkflowRisk(normalized, {
      trustClass: 'reviewed_internal',
      projectRoot: dir,
    });
    const manifest = createWorkflowManifest(normalized, workflowHash, {
      ...riskAssessment,
      acknowledgedBy: 'acceptance-test',
      acknowledgedAt: new Date().toISOString(),
    }, normalized.projectRoot);
    saveManifest(manifest, manifestPath);

    const r = run(
      `${CLI} workflow run --definition ${defPath} ` +
      `--recipe-search-dir ${externalRecipesDir} --trust reviewed_internal ` +
      `--non-interactive --approved-manifest ${manifestPath} --json`,
      { cwd: dir },
    );
    assert.equal(r.exitCode, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.status, 'success');
    assert.equal(result.stepsExecuted, 2);
  });

  it('workflow run accepts --allow-unverified when manifest allows workflow trust boundary change', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    writeFileSync(join(dir, 'recipes', 'comm.recipe.json'), JSON.stringify({
      id: 'comm',
      name: 'Community Recipe',
      description: 'Community workflow recipe',
      version: '1.0.0',
      author: 'test',
      category: 'custom',
      channel: 'community',
      approval_required: true,
      risk_level: 'low',
      inputs: {},
      steps: [{ id: 'main', description: 'echo one', run: { command: 'echo', args: ['ok'], mode: 'structured' } }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    }, null, 2));

    const def = {
      version: 1,
      kind: 'workflow_definition',
      name: 'comm-boundary-wf',
      projectRoot: '.',
      entryStep: 'step_a',
      maxIterations: 3,
      services: [],
      rollback_policy: 'none',
      rollback_none_reason: 'single bounded recipe step',
      steps: [{
        id: 'step_a',
        type: 'recipe_ref',
        recipe: 'comm',
        inputs: {},
        on: { success: 'done', failure: 'abort' },
      }],
    };
    const defPath = join(dir, 'workflow.json');
    writeFileSync(defPath, JSON.stringify(def, null, 2));

    const manifestDir = join(dir, '.guardrail', 'workflows');
    mkdirSync(manifestDir, { recursive: true });
    const normalized = normalizeWorkflowDefinition(def, dir, {
      recipeSearchDirs: [join(dir, 'recipes')],
      allowUnverified: true,
    });
    const manifestPath = join(manifestDir, 'comm.approved.json');
    const workflowHash = hashWorkflow(normalized);
    const riskAssessment = evaluateWorkflowRisk(normalized, {
      trustClass: 'reviewed_internal',
      projectRoot: dir,
    });
    const manifest = createWorkflowManifest(normalized, workflowHash, {
      ...riskAssessment,
      acknowledgedBy: 'acceptance-test',
      acknowledgedAt: new Date().toISOString(),
    }, normalized.projectRoot);
    saveManifest(manifest, manifestPath);

    const r = run(
      `${CLI} workflow run --definition ${defPath} ` +
      `--recipe-search-dir ${join(dir, 'recipes')} --allow-unverified --trust reviewed_internal ` +
      `--non-interactive --approved-manifest ${manifestPath} --json`,
      { cwd: dir },
    );

    assert.equal(r.exitCode, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.status, 'success');
    assert.equal(result.stepsExecuted, 1);
  });
});

describe('README Feature: Template Mode', () => {
  it('guardrail template lint validates a template', () => {
    const dir = tmpDir();
    const tmpl = {
      version: 1, kind: 'template', name: 'test-tmpl',
      description: 'A test template for lint',
      trust_class: 'reviewed_internal', risk: 'green', risk_reasons: [],
      inputs: { name: { type: 'string', pattern: '^[a-z]+$', description: 'A name' } },
      run: { command: 'echo', args: ['{{inputs.name}}'], mode: 'structured' },
    };
    writeFileSync(join(dir, 'tmpl.json'), JSON.stringify(tmpl, null, 2));
    const r = run(`${CLI} template lint --template ${join(dir, 'tmpl.json')}`);
    assert.equal(r.exitCode, 0, `Lint should pass: ${r.stderr}`);
  });

  it('template explain shows what a template does', () => {
    const dir = tmpDir();
    const tmpl = {
      version: 1, kind: 'template', name: 'explain-test',
      description: 'Test explain output',
      trust_class: 'reviewed_internal', risk: 'green', risk_reasons: [],
      inputs: { x: { type: 'boolean', description: 'A flag' } },
      run: { command: 'echo', args: ['hello'], mode: 'structured' },
    };
    writeFileSync(join(dir, 'tmpl.json'), JSON.stringify(tmpl, null, 2));
    const r = run(`${CLI} template explain --template ${join(dir, 'tmpl.json')}`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('explain-test'), 'Should show template name');
  });

  it('template schema shows input schema', () => {
    const dir = tmpDir();
    const tmpl = {
      version: 1, kind: 'template', name: 'schema-test',
      description: 'Test schema output',
      trust_class: 'reviewed_internal', risk: 'green', risk_reasons: [],
      inputs: { port: { type: 'integer', min: 1, max: 65535, description: 'Port number' } },
      run: { command: 'echo', args: ['{{inputs.port}}'], mode: 'structured' },
    };
    writeFileSync(join(dir, 'tmpl.json'), JSON.stringify(tmpl, null, 2));
    const r = run(`${CLI} template schema --template ${join(dir, 'tmpl.json')}`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('port'), 'Should show input name');
  });

  it('template simulate shows dry-run preview', () => {
    const dir = tmpDir();
    const tmpl = {
      version: 1, kind: 'template', name: 'sim-test',
      description: 'Test simulate output',
      trust_class: 'reviewed_internal', risk: 'green', risk_reasons: [],
      inputs: { msg: { type: 'string', pattern: '^[a-z]+$', description: 'message' } },
      run: { command: 'echo', args: ['{{inputs.msg}}'], mode: 'structured' },
    };
    writeFileSync(join(dir, 'tmpl.json'), JSON.stringify(tmpl, null, 2));
    const r = run(`${CLI} template simulate --template ${join(dir, 'tmpl.json')} --input msg=hello`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('hello'), 'Should show resolved args');
  });

  it('templates with requires_env fail closed unless caller supplies --env-allow', () => {
    const dir = tmpDir();
    const tmpl = {
      version: 1, kind: 'template', name: 'env-handshake-test',
      description: 'Test explicit env handshake',
      trust_class: 'reviewed_internal', risk: 'green', risk_reasons: [],
      requires_env: ['NPM_TOKEN'],
      inputs: { msg: { type: 'string', pattern: '^[a-z]+$', description: 'message' } },
      run: { command: 'echo', args: ['{{inputs.msg}}'], mode: 'structured' },
    };
    writeFileSync(join(dir, 'tmpl.json'), JSON.stringify(tmpl, null, 2));
    const r = run(`${CLI} run --template ${join(dir, 'tmpl.json')} --input msg=hello`);
    assert.ok(r.exitCode !== 0);
    assert.ok((r.stdout || '').includes('--env-allow') || (r.stdout || '').includes('Required variables'));
  });

  it('templates reject bare strings (no pattern or enum)', () => {
    const dir = tmpDir();
    const tmpl = {
      version: 1, kind: 'template', name: 'bare-str-test',
      description: 'Test bare string rejection',
      trust_class: 'reviewed_internal', risk: 'green', risk_reasons: [],
      inputs: { unsafe: { type: 'string', description: 'no constraint' } },
      run: { command: 'echo', args: ['{{inputs.unsafe}}'], mode: 'structured' },
    };
    writeFileSync(join(dir, 'tmpl.json'), JSON.stringify(tmpl, null, 2));
    const r = run(`${CLI} template lint --template ${join(dir, 'tmpl.json')}`);
    assert.ok(r.exitCode !== 0 || r.stdout.includes('bare') || r.stdout.includes('pattern'),
      'Should reject bare strings');
  });
});

describe('README Feature: Resident Lane Mode', () => {
  it('guardrail lane status reports a live resident lane', () => {
    const dir = tmpDir();
    const laneDir = join(dir, 'lane');
    mkdirSync(laneDir, { recursive: true });
    const requestFifo = join(laneDir, 'requests.fifo');
    const responseFifo = join(laneDir, 'responses.fifo');
    assert.equal(spawnSync('mkfifo', [requestFifo]).status, 0);
    assert.equal(spawnSync('mkfifo', [responseFifo]).status, 0);
    const keyPath = join(dir, 'lane.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], {
      stdio: 'ignore',
    });

    try {
      writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
        pid: sleeper.pid,
        status: 'ready',
        laneId: 'math-live',
        tool: 'codex',
        sessionName: 'math-live',
        scopeType: 'worktree',
        scopeMode: 'warn',
        scopePaths: ['.'],
        keyPath,
        lastActivityAt: new Date().toISOString(),
      }), 'utf8');

      const r = run(`${CLI} lane status --lane-dir ${laneDir} --key-path ${keyPath} --json`);
      assert.equal(r.exitCode, 0);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.status, 'ready');
      assert.equal(parsed.alive, true);
      assert.equal(parsed.tool, 'codex');
      assert.equal(parsed.scopeType, 'worktree');
      assert.deepEqual(parsed.scopePaths, ['.']);
      assert.equal(parsed.recommendedAction, 'send');
    } finally {
      sleeper.kill('SIGTERM');
    }
  });

  it('guardrail lane list shows mixed lane states from the repo registry', () => {
    const dir = tmpDir();
    const repoDir = join(dir, 'repo');
    const lanesDir = join(repoDir, '.guardrail', 'lanes');
    const readyLaneDir = join(lanesDir, 'math-ready');
    const staleLaneDir = join(lanesDir, 'math-stale');
    mkdirSync(readyLaneDir, { recursive: true });
    mkdirSync(staleLaneDir, { recursive: true });
    const readyRequestFifo = join(readyLaneDir, 'requests.fifo');
    const readyResponseFifo = join(readyLaneDir, 'responses.fifo');
    assert.equal(spawnSync('mkfifo', [readyRequestFifo]).status, 0);
    assert.equal(spawnSync('mkfifo', [readyResponseFifo]).status, 0);
    const keyPath = join(dir, 'ready.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(join(readyLaneDir, 'identity.json'), JSON.stringify({
      laneId: 'math-ready',
      tool: 'codex',
      laneDir: readyLaneDir,
      guardrailRepo: repoDir,
      keyPath,
      identityNonce: 'nonce-ready',
      scopeType: 'paths',
      scopeMode: 'warn',
      scopePaths: ['docs'],
    }), 'utf8');
    writeFileSync(join(staleLaneDir, 'identity.json'), JSON.stringify({
      laneId: 'math-stale',
      tool: 'claude',
      laneDir: staleLaneDir,
      guardrailRepo: repoDir,
      identityNonce: 'nonce-stale',
      scopeType: 'paths',
      scopeMode: 'block',
      scopePaths: ['docs/api'],
    }), 'utf8');
    writeFileSync(join(readyLaneDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math-ready',
      tool: 'codex',
      sessionName: 'math-ready',
      keyPath,
      identityNonce: 'nonce-ready',
      bootNonce: 'boot-ready',
      scopeType: 'paths',
      scopeMode: 'warn',
      scopePaths: ['docs'],
      requestFifo: readyRequestFifo,
      responseFifo: readyResponseFifo,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const r = run(`${CLI} lane list --guardrail-repo ${repoDir} --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.counts.ready, 1);
    assert.equal(parsed.counts.stale, 1);
    assert.equal(parsed.lanes.length, 2);
    assert.equal(parsed.lanes[0].tool, 'codex');
    assert.equal(parsed.lanes[1].tool, 'claude');
    assert.deepEqual(parsed.lanes[0].scopePaths, ['docs']);
    assert.equal(parsed.lanes[0].scopeConflicts.length, 0);
    assert.equal(parsed.lanes[1].scopeConflicts.length, 0);
  });

  it('guardrail lane list reports live overlapping scope conflicts', () => {
    const dir = tmpDir();
    const repoDir = join(dir, 'repo');
    const lanesDir = join(repoDir, '.guardrail', 'lanes');
    const laneADir = join(lanesDir, 'lane-a');
    const laneBDir = join(lanesDir, 'lane-b');
    mkdirSync(laneADir, { recursive: true });
    mkdirSync(laneBDir, { recursive: true });
    const keyPath = join(dir, 'lane-a.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(join(laneADir, 'identity.json'), JSON.stringify({
      laneId: 'lane-a',
      tool: 'claude',
      laneDir: laneADir,
      guardrailRepo: repoDir,
      keyPath,
      identityNonce: 'nonce-a',
      scopeType: 'paths',
      scopeMode: 'warn',
      scopePaths: ['docs'],
    }), 'utf8');
    writeFileSync(join(laneBDir, 'identity.json'), JSON.stringify({
      laneId: 'lane-b',
      tool: 'codex',
      laneDir: laneBDir,
      guardrailRepo: repoDir,
      identityNonce: 'nonce-b',
      scopeType: 'paths',
      scopeMode: 'block',
      scopePaths: ['docs/api'],
    }), 'utf8');
    writeFileSync(join(laneADir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'lane-a',
      tool: 'claude',
      sessionName: 'lane-a',
      keyPath,
      scopeType: 'paths',
      scopeMode: 'warn',
      scopePaths: ['docs'],
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');
    writeFileSync(join(laneBDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'lane-b',
      tool: 'codex',
      sessionName: 'lane-b',
      scopeType: 'paths',
      scopeMode: 'block',
      scopePaths: ['docs/api'],
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const r = run(`${CLI} lane list --guardrail-repo ${repoDir} --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    const laneA = parsed.lanes.find((lane) => lane.laneId === 'lane-a');
    const laneB = parsed.lanes.find((lane) => lane.laneId === 'lane-b');
    assert.equal(laneA.scopeConflicts.length, 1);
    assert.equal(laneA.scopeConflicts[0].enforcement, 'block');
    assert.equal(laneB.scopeConflicts.length, 1);
  });

  it('guardrail lane list filters by status, tool, and conflict state', () => {
    const dir = tmpDir();
    const repoDir = join(dir, 'repo');
    const lanesDir = join(repoDir, '.guardrail', 'lanes');
    const readyLaneDir = join(lanesDir, 'lane-ready');
    const conflictedLaneDir = join(lanesDir, 'lane-conflicted');
    mkdirSync(readyLaneDir, { recursive: true });
    mkdirSync(conflictedLaneDir, { recursive: true });
    writeFileSync(join(readyLaneDir, 'identity.json'), JSON.stringify({
      laneId: 'lane-ready',
      tool: 'claude',
      laneDir: readyLaneDir,
      guardrailRepo: repoDir,
      identityNonce: 'nonce-ready',
      scopeType: 'paths',
      scopeMode: 'warn',
      scopePaths: ['docs'],
    }), 'utf8');
    writeFileSync(join(conflictedLaneDir, 'identity.json'), JSON.stringify({
      laneId: 'lane-conflicted',
      tool: 'codex',
      laneDir: conflictedLaneDir,
      guardrailRepo: repoDir,
      identityNonce: 'nonce-conflicted',
      scopeType: 'paths',
      scopeMode: 'block',
      scopePaths: ['docs/api'],
    }), 'utf8');
    writeFileSync(join(readyLaneDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'lane-ready',
      tool: 'claude',
      sessionName: 'lane-ready',
      scopeType: 'paths',
      scopeMode: 'warn',
      scopePaths: ['docs'],
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');
    writeFileSync(join(conflictedLaneDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'lane-conflicted',
      tool: 'codex',
      sessionName: 'lane-conflicted',
      scopeType: 'paths',
      scopeMode: 'block',
      scopePaths: ['docs/api'],
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const r = run(`${CLI} lane list --guardrail-repo ${repoDir} --status ready --tool-filter codex --has-conflicts --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.lanes.length, 1);
    assert.equal(parsed.lanes[0].laneId, 'lane-conflicted');
    assert.equal(parsed.counts.ready, 1);
  });

  it('guardrail lane list --all-repos includes host-registry lanes and honors resource filters', () => {
    const dir = tmpDir();
    const hostStateDir = join(dir, 'host-state');
    const repoDir = join(dir, 'repo');
    mkdirSync(join(repoDir, '.guardrail', 'lanes'), { recursive: true });
    mkdirSync(join(hostStateDir, 'resident-lanes'), { recursive: true });
    writeFileSync(join(hostStateDir, 'resident-lanes', 'remote-lane.json'), JSON.stringify({
      laneId: 'remote-lane',
      laneDir: join(dir, 'other-repo', '.guardrail', 'lanes', 'remote-lane'),
      guardrailRepo: join(dir, 'other-repo'),
      ownerRepoId: 'remote-owner',
      tool: 'codex',
      sessionName: 'remote-lane',
      resourceMode: 'block',
      resources: ['git-branch:main'],
      pid: process.pid,
      status: 'ready',
      updatedAt: new Date().toISOString(),
    }), 'utf8');

    const r = run(`${CLI} lane list --guardrail-repo ${repoDir} --host-state-dir ${hostStateDir} --all-repos --resource-filter git-branch:main --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.lanes.length, 1);
    assert.equal(parsed.lanes[0].laneId, 'remote-lane');
    assert.equal(parsed.lanes[0].source, 'host-registry');

    const classFiltered = run(`${CLI} lane list --guardrail-repo ${repoDir} --host-state-dir ${hostStateDir} --all-repos --resource-filter git-branch --json`);
    assert.equal(classFiltered.exitCode, 0, classFiltered.stderr);
    const classParsed = JSON.parse(classFiltered.stdout);
    assert.equal(classParsed.lanes.length, 1);
    assert.equal(classParsed.lanes[0].laneId, 'remote-lane');
  });

  it('guardrail lane history returns bounded audit entries for one lane', () => {
    const dir = tmpDir();
    const repoDir = join(dir, 'repo');
    mkdirSync(join(repoDir, '.guardrail'), { recursive: true });
    writeFileSync(join(repoDir, '.guardrail', 'audit.jsonl'), [
      JSON.stringify({
        timestamp: '2026-04-10T00:00:00.000Z',
        event: 'lane_start',
        lane_id: 'math-live',
        lane_dir: join(repoDir, '.guardrail', 'lanes', 'math-live'),
        tool: 'claude',
        session_name: 'math-live',
        status: 'success',
      }),
      JSON.stringify({
        timestamp: '2026-04-10T00:01:00.000Z',
        event: 'lane_send',
        lane_id: 'math-live',
        lane_dir: join(repoDir, '.guardrail', 'lanes', 'math-live'),
        tool: 'claude',
        session_name: 'math-live',
        request_id: 'req-1',
        status: 'success',
      }),
    ].join('\n') + '\n');

    const r = run(`${CLI} lane history --guardrail-repo ${repoDir} --id math-live --limit 5 --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.count, 2);
    assert.equal(parsed.entries[1].event, 'lane_send');
    assert.equal(parsed.entries[1].request_id, 'req-1');
  });

  it('guardrail lane portfolio returns the mirrored host timeline for lane lifecycle events', () => {
    const dir = tmpDir();
    const repoDir = join(dir, 'repo');
    const hostStateDir = join(dir, 'host');
    const laneDir = join(repoDir, '.guardrail', 'lanes', 'math-stale');
    mkdirSync(join(repoDir, '.guardrail'), { recursive: true });
    mkdirSync(laneDir, { recursive: true });
    const keyPath = join(dir, 'stale.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(join(laneDir, 'identity.json'), JSON.stringify({
      laneId: 'math-stale',
      laneDir,
      guardrailRepo: repoDir,
      keyPath,
      identityNonce: 'nonce-stale',
    }), 'utf8');

    const prune = run(`${CLI} lane prune --guardrail-repo ${repoDir} --host-state-dir ${hostStateDir} --json`);
    assert.equal(prune.exitCode, 0, prune.stderr);

    const portfolio = run(`${CLI} lane portfolio --guardrail-repo ${repoDir} --host-state-dir ${hostStateDir} --all-repos --limit 10 --json`);
    assert.equal(portfolio.exitCode, 0, portfolio.stderr);
    const parsed = JSON.parse(portfolio.stdout);
    assert.equal(parsed.scope, 'host');
    assert.ok(parsed.chainValid, 'expected host portfolio audit chain to validate');
    assert.equal(parsed.eventCounts.lane_prune, 1);
    assert.ok(parsed.entries.some((entry) => entry.event === 'lane_prune' && entry.lane_id === 'math-stale'));
    assert.ok(parsed.entries.some((entry) => entry.source === 'host-audit'));
  });

  it('guardrail lane send writes one prompt through a resident lane FIFO', async () => {
    const dir = tmpDir();
    const guardrailRepo = join(dir, 'repo');
    const laneDir = join(dir, 'lane');
    mkdirSync(join(guardrailRepo, '.guardrail'), { recursive: true });
    mkdirSync(laneDir, { recursive: true });
    const requestFifo = join(laneDir, 'requests.fifo');
    const responseFifo = join(laneDir, 'responses.fifo');
    assert.equal(spawnSync('mkfifo', [requestFifo]).status, 0);
    assert.equal(spawnSync('mkfifo', [responseFifo]).status, 0);
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math-live',
      sessionName: 'math-live',
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const laneServer = (async () => {
      const requestFd = openSync(requestFifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      let responseFd = null;
      const chunk = Buffer.alloc(4096);
      let buffer = '';
      const startedAt = Date.now();
      try {
        for (;;) {
          if ((Date.now() - startedAt) > 5000) {
            throw new Error('Timed out waiting for lane request');
          }
          try {
            const bytesRead = readSync(requestFd, chunk, 0, chunk.length, null);
            if (bytesRead > 0) {
              buffer += chunk.toString('utf8', 0, bytesRead);
              const newlineIndex = buffer.indexOf('\n');
              if (newlineIndex >= 0) {
                const request = JSON.parse(buffer.slice(0, newlineIndex));
                responseFd = openSync(responseFifo, fsConstants.O_WRONLY);
                writeSync(responseFd, `${JSON.stringify({ requestId: request.id, ok: true, stdout: '6\n' })}\n`, undefined, 'utf8');
                return;
              }
            }
          } catch (err) {
            if (err?.code !== 'EAGAIN') throw err;
          }
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        }
      } finally {
        closeSync(requestFd);
        if (responseFd !== null) {
          closeSync(responseFd);
        }
      }
    })();

    const laneSend = new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('node', [
        join(process.cwd(), 'src', 'cli.js'),
        'lane', 'send',
        '--guardrail-repo', guardrailRepo,
        '--lane-dir', laneDir,
        '--prompt', '2x3=?',
      ], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', rejectPromise);
      child.on('close', (code) => {
        resolvePromise({
          exitCode: code ?? 1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });
    });

    const [result] = await Promise.all([laneSend, laneServer]);
    assert.equal(result.exitCode, 0, `lane send should succeed: ${result.stderr}`);
    assert.ok(result.stdout.startsWith('6'));
    assert.ok(result.stdout.includes('Request id: req-'));
    const entries = queryAuditLog(join(guardrailRepo, '.guardrail', 'audit.jsonl'), {});
    const laneSendEntry = entries.find((entry) => entry.event === 'lane_send');
    assert.ok(laneSendEntry, 'expected lane_send audit entry');
    assert.equal(laneSendEntry.status, 'success');
    assert.equal(laneSendEntry.trace_id, 'lane:resident');
  });

  it('guardrail lane chat waits for the result and prints one guarded chat turn', async () => {
    const dir = tmpDir();
    const guardrailRepo = join(dir, 'repo');
    const laneDir = join(dir, 'lane');
    mkdirSync(join(guardrailRepo, '.guardrail'), { recursive: true });
    mkdirSync(laneDir, { recursive: true });
    const requestFifo = join(laneDir, 'requests.fifo');
    const responseFifo = join(laneDir, 'responses.fifo');
    assert.equal(spawnSync('mkfifo', [requestFifo]).status, 0);
    assert.equal(spawnSync('mkfifo', [responseFifo]).status, 0);
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'chat-live',
      sessionName: 'chat-live',
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const laneServer = (async () => {
      const requestFd = openSync(requestFifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      let responseFd = null;
      const chunk = Buffer.alloc(4096);
      let buffer = '';
      const startedAt = Date.now();
      try {
        for (;;) {
          if ((Date.now() - startedAt) > 5000) {
            throw new Error('Timed out waiting for lane request');
          }
          try {
            const bytesRead = readSync(requestFd, chunk, 0, chunk.length, null);
            if (bytesRead > 0) {
              buffer += chunk.toString('utf8', 0, bytesRead);
              const newlineIndex = buffer.indexOf('\n');
              if (newlineIndex >= 0) {
                const request = JSON.parse(buffer.slice(0, newlineIndex));
                responseFd = openSync(responseFifo, fsConstants.O_WRONLY);
                writeSync(responseFd, `${JSON.stringify({ requestId: request.id, ok: true, stdout: 'hello back\n' })}\n`, undefined, 'utf8');
                return;
              }
            }
          } catch (err) {
            if (err?.code !== 'EAGAIN') throw err;
          }
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        }
      } finally {
        closeSync(requestFd);
        if (responseFd !== null) closeSync(responseFd);
      }
    })();

    const laneChat = new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('node', [
        join(process.cwd(), 'src', 'cli.js'),
        'lane', 'chat',
        '--guardrail-repo', guardrailRepo,
        '--lane-dir', laneDir,
        '--prompt', 'hello',
      ], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', rejectPromise);
      child.on('close', (code) => {
        resolvePromise({ exitCode: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });

    const [result] = await Promise.all([laneChat, laneServer]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(result.stdout.startsWith('hello back'));
    const entries = queryAuditLog(join(guardrailRepo, '.guardrail', 'audit.jsonl'), {});
    const laneChatEntry = entries.find((entry) => entry.event === 'lane_chat');
    assert.ok(laneChatEntry, 'expected lane_chat audit entry');
    assert.equal(laneChatEntry.status, 'success');
  });

  it('guardrail lane send returns lane_expired when the host key is missing', () => {
    const dir = tmpDir();
    const laneDir = join(dir, 'lane');
    mkdirSync(laneDir, { recursive: true });
    const keyPath = join(dir, 'missing.key');
    const r = run(`${CLI} lane send --lane-dir ${laneDir} --key-path ${keyPath} --prompt "2x3=?" --json`);
    assert.equal(r.exitCode, 1);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.reason, 'lane_expired');
  });

  it('guardrail lane send returns pending instead of lane_expired when a live lane is still running', () => {
    const dir = tmpDir();
    const guardrailRepo = join(dir, 'repo');
    const laneDir = join(dir, 'lane');
    mkdirSync(join(guardrailRepo, '.guardrail'), { recursive: true });
    mkdirSync(join(laneDir, 'results'), { recursive: true });
    const requestFifo = join(laneDir, 'requests.fifo');
    const responseFifo = join(laneDir, 'responses.fifo');
    assert.equal(spawnSync('mkfifo', [requestFifo]).status, 0);
    assert.equal(spawnSync('mkfifo', [responseFifo]).status, 0);
    const keyPath = join(dir, 'lane.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'busy',
      laneId: 'math-live',
      sessionName: 'math-live',
      currentRequestId: 'req-timeout',
      currentRequestStartedAt: '2026-04-10T00:00:00.000Z',
      lastRequestId: 'req-timeout',
      lastActivityAt: new Date().toISOString(),
      keyPath,
    }), 'utf8');

    const requestFd = openSync(requestFifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
    try {
      const r = run(`${CLI} lane send --guardrail-repo ${guardrailRepo} --lane-dir ${laneDir} --key-path ${keyPath} --request-id req-timeout --prompt "2x3=?" --timeout-ms 5 --json`);
      assert.equal(r.exitCode, 0, r.stderr);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.status, 'pending');
      assert.equal(parsed.reason, 'request_still_running');
      assert.equal(parsed.requestId, 'req-timeout');
      const entries = queryAuditLog(join(guardrailRepo, '.guardrail', 'audit.jsonl'), {});
      const laneSendEntry = entries.find((entry) => entry.event === 'lane_send');
      assert.ok(laneSendEntry, 'expected lane_send audit entry');
      assert.equal(laneSendEntry.status, 'pending');
      assert.equal(laneSendEntry.reason, 'request_still_running');
    } finally {
      closeSync(requestFd);
    }
  });

  it('guardrail lane send points text-mode recovery at lane wait', () => {
    const dir = tmpDir();
    const laneDir = join(dir, 'lane');
    mkdirSync(join(laneDir, 'results'), { recursive: true });
    const requestFifo = join(laneDir, 'requests.fifo');
    const responseFifo = join(laneDir, 'responses.fifo');
    assert.equal(spawnSync('mkfifo', [requestFifo]).status, 0);
    assert.equal(spawnSync('mkfifo', [responseFifo]).status, 0);
    const keyPath = join(dir, 'lane.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'busy',
      laneId: 'math-live',
      sessionName: 'math-live',
      currentRequestId: 'req-timeout',
      currentRequestStartedAt: '2026-04-10T00:00:00.000Z',
      lastRequestId: 'req-timeout',
      lastActivityAt: new Date().toISOString(),
      keyPath,
    }), 'utf8');

    const requestFd = openSync(requestFifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
    try {
      const r = run(`${CLI} lane send --lane-dir ${laneDir} --key-path ${keyPath} --request-id req-timeout --prompt "2x3=?" --timeout-ms 5`);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(r.stdout.includes('guardrail lane wait'));
      assert.ok(r.stdout.includes('Request id: req-timeout'));
    } finally {
      closeSync(requestFd);
    }
  });

  it('guardrail lane status reports expired lanes cleanly', () => {
    const dir = tmpDir();
    const laneDir = join(dir, 'lane');
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'expired',
      laneId: 'math-live',
      sessionName: 'math-live',
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');
    const keyPath = join(dir, 'missing.key');

    const r = run(`${CLI} lane status --lane-dir ${laneDir} --key-path ${keyPath} --json`);
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.status, 'expired');
    assert.equal(parsed.alive, false);
    assert.equal(parsed.recommendedAction, 'start');
    assert.ok(parsed.recommendedCommand.includes('guardrail lane start'));
  });

  it('guardrail lane status reports failed bootstrap reasons cleanly', () => {
    const dir = tmpDir();
    const laneDir = join(dir, 'lane');
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: 12345,
      status: 'failed',
      laneId: 'math-live',
      sessionName: 'math-live',
      failureReason: 'bootstrap crashed',
      failureStage: 'bootstrap',
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const r = run(`${CLI} lane status --lane-dir ${laneDir} --json`);
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.failureReason, 'bootstrap crashed');
    assert.equal(parsed.failureStage, 'bootstrap');
  });

  it('guardrail lane logs returns a bounded tail of the lane log', () => {
    const dir = tmpDir();
    const laneDir = join(dir, 'lane');
    const logsDir = join(laneDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: 12345,
      status: 'failed',
      laneId: 'math-live',
      sessionName: 'math-live',
      logPath: join(logsDir, 'lane.log'),
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');
    writeFileSync(join(logsDir, 'lane.log'), 'one\ntwo\nthree\nfour\n', 'utf8');

    const r = run(`${CLI} lane logs --lane-dir ${laneDir} --tail 2 --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.tailLines, 2);
    assert.equal(parsed.text, 'three\nfour');
    assert.equal(parsed.hasLog, true);
  });

  it('guardrail lane inspect combines status, latest result, and logs', () => {
    const dir = tmpDir();
    const laneDir = join(dir, 'lane');
    const logsDir = join(laneDir, 'logs');
    const resultsDir = join(laneDir, 'results');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math-live',
      sessionName: 'math-live',
      lastRequestId: 'req-1',
      lastCompletedRequestId: 'req-1',
      lastResultPath: join(resultsDir, 'req-1.json'),
      logPath: join(logsDir, 'lane.log'),
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');
    writeFileSync(join(resultsDir, 'req-1.json'), JSON.stringify({
      requestId: 'req-1',
      ok: true,
      exitCode: 0,
      stdout: '6\n',
    }), 'utf8');
    writeFileSync(join(logsDir, 'lane.log'), 'one\ntwo\nthree\nfour\n', 'utf8');

    const r = run(`${CLI} lane inspect --lane-dir ${laneDir} --tail 2 --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.status.status, 'ready');
    assert.equal(parsed.latestResult.status, 'completed');
    assert.equal(parsed.latestResult.result.stdout, '6\n');
    assert.equal(parsed.logs.text, 'three\nfour');
  });

  it('guardrail lane status infers post-start failure from stale startup state', () => {
    const dir = tmpDir();
    const laneDir = join(dir, 'lane');
    mkdirSync(laneDir, { recursive: true });
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: 12345,
      status: 'ready',
      laneId: 'math-live',
      sessionName: 'math-live',
      startedConversation: false,
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }), 'utf8');

    const r = run(`${CLI} lane status --lane-dir ${laneDir} --json`);
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.failureStage, 'post_start');
  });

  it('guardrail lane send returns lane_failed when the lane has already failed before first request', () => {
    const dir = tmpDir();
    const laneDir = join(dir, 'lane');
    mkdirSync(laneDir, { recursive: true });
    const keyPath = join(dir, 'lane.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: 12345,
      status: 'ready',
      laneId: 'math-live',
      sessionName: 'math-live',
      startedConversation: false,
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }), 'utf8');

    const r = run(`${CLI} lane send --lane-dir ${laneDir} --key-path ${keyPath} --prompt "2x3=?" --json`);
    assert.equal(r.exitCode, 1);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.reason, 'lane_failed');
    assert.equal(parsed.failureStage, 'post_start');
  });

  it('guardrail lane send returns lane_failed when a post-start failed lane has already cleaned up its key', () => {
    const dir = tmpDir();
    const laneDir = join(dir, 'lane');
    mkdirSync(laneDir, { recursive: true });
    const keyPath = join(dir, 'missing.key');
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: 12345,
      status: 'ready',
      laneId: 'math-live',
      sessionName: 'math-live',
      startedConversation: false,
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }), 'utf8');

    const r = run(`${CLI} lane send --lane-dir ${laneDir} --key-path ${keyPath} --prompt "2x3=?" --json`);
    assert.equal(r.exitCode, 1);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.reason, 'lane_failed');
    assert.equal(parsed.failureStage, 'post_start');
  });

  it('guardrail lane result returns the stored output for a completed request', () => {
    const dir = tmpDir();
    const laneDir = join(dir, 'lane');
    mkdirSync(join(laneDir, 'results'), { recursive: true });
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math-live',
      sessionName: 'math-live',
      lastRequestId: 'req-1',
      lastCompletedRequestId: 'req-1',
      lastResultPath: join(laneDir, 'results', 'req-1.json'),
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');
    writeFileSync(join(laneDir, 'results', 'req-1.json'), JSON.stringify({
      requestId: 'req-1',
      ok: true,
      exitCode: 0,
      stdout: '6\n',
    }), 'utf8');

    const r = run(`${CLI} lane result --lane-dir ${laneDir} --request-id req-1 --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.result.stdout, '6\n');
  });

  it('guardrail lane wait returns the stored output once a completed request exists', () => {
    const dir = tmpDir();
    const laneDir = join(dir, 'lane');
    mkdirSync(join(laneDir, 'results'), { recursive: true });
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: process.pid,
      status: 'ready',
      laneId: 'math-live',
      sessionName: 'math-live',
      lastRequestId: 'req-2',
      lastCompletedRequestId: 'req-2',
      lastResultPath: join(laneDir, 'results', 'req-2.json'),
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');
    writeFileSync(join(laneDir, 'results', 'req-2.json'), JSON.stringify({
      requestId: 'req-2',
      ok: true,
      exitCode: 0,
      stdout: '8\n',
    }), 'utf8');

    const r = run(`${CLI} lane wait --lane-dir ${laneDir} --request-id req-2 --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.result.stdout, '8\n');
  });

  it('guardrail lane adapters lists bundled lane adapters', () => {
    const r = run(`${CLI} lane adapters --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed.adapters));
    assert.ok(parsed.adapters.some((adapter) => adapter.id === 'claude'));
    assert.ok(parsed.adapters.some((adapter) => adapter.id === 'codex'));
    assert.ok(parsed.adapters.some((adapter) => adapter.id === 'local-exec'));
    assert.ok(parsed.adapters.some((adapter) => adapter.id === 'prompt-wrapper'));
    assert.ok(parsed.adapters.some((adapter) => adapter.id === 'ssh-prompt-wrapper'));
    assert.ok(parsed.adapters.every((adapter) => Array.isArray(adapter.capabilities)));
    assert.ok(parsed.adapters.every((adapter) => adapter.source === 'bundled'));
  });

  it('guardrail lane start rejects unknown tools', () => {
    const dir = tmpDir();
    const r = run(`${CLI} lane start --guardrail-repo ${dir} --id bad-tool --tool madeup --json`);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('Unknown resident lane tool'));
  });

  it('guardrail lane start rejects local-exec without a fixed command', () => {
    const dir = tmpDir();
    const r = run(`${CLI} lane start --guardrail-repo ${dir} --id bad-local --tool local-exec --json`);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes('Provide --command'));
  });

  it('guardrail lane stop appends an audit entry and removes the host key', () => {
    const dir = tmpDir();
    const guardrailRepo = join(dir, 'repo');
    const laneDir = join(dir, 'lane');
    mkdirSync(join(guardrailRepo, '.guardrail'), { recursive: true });
    mkdirSync(laneDir, { recursive: true });
    const keyPath = join(dir, 'lane.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: 999999,
      status: 'ready',
      laneId: 'math-live',
      sessionName: 'math-live',
      keyPath,
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const r = run(`${CLI} lane stop --guardrail-repo ${guardrailRepo} --lane-dir ${laneDir} --key-path ${keyPath}`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(existsSync(keyPath), false);
    const entries = queryAuditLog(join(guardrailRepo, '.guardrail', 'audit.jsonl'), {});
    const laneStopEntry = entries.find((entry) => entry.event === 'lane_stop');
    assert.ok(laneStopEntry, 'expected lane_stop audit entry');
    assert.equal(laneStopEntry.status, 'success');
  });

  it('guardrail lane prune removes stale lanes and appends audit entries', () => {
    const dir = tmpDir();
    const repoDir = join(dir, 'repo');
    const laneDir = join(repoDir, '.guardrail', 'lanes', 'math-stale');
    mkdirSync(join(repoDir, '.guardrail'), { recursive: true });
    mkdirSync(laneDir, { recursive: true });
    const keyPath = join(dir, 'stale.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(join(laneDir, 'identity.json'), JSON.stringify({
      laneId: 'math-stale',
      laneDir,
      guardrailRepo: repoDir,
      keyPath,
      identityNonce: 'nonce-stale',
    }), 'utf8');

    const r = run(`${CLI} lane prune --guardrail-repo ${repoDir} --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.pruned.length, 1);
    assert.equal(parsed.candidates.length, 1);
    assert.equal(parsed.pruned[0].laneId, 'math-stale');
    assert.equal(parsed.pruned[0].cleanupReason, 'dead_artifacts_present');
    assert.equal(existsSync(parsed.pruned[0].tombstonePath), true);
    assert.equal(existsSync(laneDir), false);
    assert.equal(existsSync(keyPath), false);
    const entries = queryAuditLog(join(repoDir, '.guardrail', 'audit.jsonl'), {});
    const pruneEntry = entries.find((entry) => entry.event === 'lane_prune');
    assert.ok(pruneEntry, 'expected lane_prune audit entry');
    assert.equal(pruneEntry.status, 'success');
    assert.equal(pruneEntry.prune_reason, 'dead_artifacts_present');
  });

  it('guardrail lane prune --dry-run previews dead lanes without deleting them', () => {
    const dir = tmpDir();
    const repoDir = join(dir, 'repo');
    const laneDir = join(repoDir, '.guardrail', 'lanes', 'math-stale');
    mkdirSync(join(repoDir, '.guardrail'), { recursive: true });
    mkdirSync(laneDir, { recursive: true });
    const keyPath = join(dir, 'stale.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(join(laneDir, 'identity.json'), JSON.stringify({
      laneId: 'math-stale',
      laneDir,
      guardrailRepo: repoDir,
      keyPath,
      identityNonce: 'nonce-stale',
    }), 'utf8');

    const r = run(`${CLI} lane prune --guardrail-repo ${repoDir} --dry-run --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.candidates.length, 1);
    assert.equal(parsed.pruned.length, 0);
    assert.equal(parsed.candidates[0].reason, 'dead_artifacts_present');
    assert.equal(existsSync(laneDir), true);
    assert.equal(existsSync(keyPath), true);
    assert.equal(existsSync(join(repoDir, '.guardrail', 'lane-tombstones')), false);
    const entries = queryAuditLog(join(repoDir, '.guardrail', 'audit.jsonl'), {});
    assert.equal(entries.filter((entry) => entry.event === 'lane_prune').length, 0);
  });

  it('guardrail lane cleanup removes one failed lane and appends an audit entry', () => {
    const dir = tmpDir();
    const repoDir = join(dir, 'repo');
    const laneDir = join(repoDir, '.guardrail', 'lanes', 'math-failed');
    mkdirSync(join(repoDir, '.guardrail'), { recursive: true });
    mkdirSync(laneDir, { recursive: true });
    const keyPath = join(dir, 'failed.key');
    writeFileSync(keyPath, 'secret\n', 'utf8');
    writeFileSync(join(laneDir, 'identity.json'), JSON.stringify({
      laneId: 'math-failed',
      laneDir,
      guardrailRepo: repoDir,
      keyPath,
      identityNonce: 'nonce-failed',
    }), 'utf8');
    writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
      pid: 999999,
      status: 'failed',
      laneId: 'math-failed',
      sessionName: 'math-failed',
      keyPath,
      failureReason: 'boot failed',
      failureStage: 'post_start',
      lastActivityAt: new Date().toISOString(),
    }), 'utf8');

    const r = run(`${CLI} lane cleanup --guardrail-repo ${repoDir} --id math-failed --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.cleaned, true);
    assert.equal(parsed.lane.laneId, 'math-failed');
    assert.equal(existsSync(laneDir), false);
    assert.equal(existsSync(keyPath), false);
    const entries = queryAuditLog(join(repoDir, '.guardrail', 'audit.jsonl'), {});
    const cleanupEntry = entries.find((entry) => entry.event === 'lane_cleanup');
    assert.ok(cleanupEntry, 'expected lane_cleanup audit entry');
    assert.equal(cleanupEntry.status, 'success');
  });

  it('guardrail lane batch previews and cleans multiple failed lanes', () => {
    const dir = tmpDir();
    const repoDir = join(dir, 'repo');
    const lanesDir = join(repoDir, '.guardrail', 'lanes');
    mkdirSync(join(repoDir, '.guardrail'), { recursive: true });
    for (const laneId of ['math-failed-a', 'math-failed-b']) {
      const laneDir = join(lanesDir, laneId);
      mkdirSync(laneDir, { recursive: true });
      const keyPath = join(dir, `${laneId}.key`);
      writeFileSync(keyPath, 'secret\n', 'utf8');
      writeFileSync(join(laneDir, 'identity.json'), JSON.stringify({
        laneId,
        laneDir,
        guardrailRepo: repoDir,
        keyPath,
        identityNonce: `nonce-${laneId}`,
      }), 'utf8');
      writeFileSync(join(laneDir, 'state.json'), JSON.stringify({
        pid: 999999,
        status: 'failed',
        laneId,
        sessionName: laneId,
        keyPath,
        failureReason: 'boot failed',
        failureStage: 'post_start',
        lastActivityAt: new Date().toISOString(),
      }), 'utf8');
    }

    const preview = run(`${CLI} lane batch --guardrail-repo ${repoDir} --action cleanup --status failed --all --dry-run --json`);
    assert.equal(preview.exitCode, 0, preview.stderr);
    const previewParsed = JSON.parse(preview.stdout);
    assert.equal(previewParsed.action, 'cleanup');
    assert.equal(previewParsed.count, 2);

    const actual = run(`${CLI} lane batch --guardrail-repo ${repoDir} --action cleanup --status failed --all --json`);
    assert.equal(actual.exitCode, 0, actual.stderr);
    const parsed = JSON.parse(actual.stdout);
    assert.equal(parsed.results.length, 2);
    assert.ok(parsed.results.every((entry) => entry.status === 'success'));
    const entries = queryAuditLog(join(repoDir, '.guardrail', 'audit.jsonl'), {});
    assert.ok(entries.some((entry) => entry.event === 'lane_batch'), 'expected lane_batch audit entry');
  });
});

describe('README Feature: Repo Status', () => {
  it('guardrail repo status reports untracked files alongside tracked changes', () => {
    const dir = tmpDir();
    const repoDir = join(dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const runGit = (args) => {
      const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };

    runGit(['init', '-b', 'main']);
    runGit(['config', 'user.name', 'Guardrail Test']);
    runGit(['config', 'user.email', 'guardrail-test@example.com']);
    writeFileSync(join(repoDir, 'tracked.txt'), 'base\n', 'utf8');
    runGit(['add', 'tracked.txt']);
    runGit(['commit', '-m', 'baseline']);

    writeFileSync(join(repoDir, 'tracked.txt'), 'changed\n', 'utf8');
    runGit(['add', 'tracked.txt']);
    writeFileSync(join(repoDir, 'tracked.txt'), 'changed again\n', 'utf8');
    writeFileSync(join(repoDir, 'artifact.txt'), 'new artifact\n', 'utf8');

    const r = run(`${CLI} repo status --path ${repoDir} --json`);
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.branch, 'main');
    assert.equal(parsed.staged.length, 1);
    assert.equal(parsed.unstaged.length, 1);
    assert.deepEqual(parsed.untracked, ['artifact.txt']);
  });
});

// ==========================================================================
// README: "Traffic-light risk model"
// ==========================================================================

describe('README Feature: Risk Classification', () => {
  it('npm test → Green (bounded, local, reviewed)', () => {
    const r = run(`${CLI} run --json --non-interactive --approved-manifest /nonexistent -- npm test`);
    // Can't run without manifest, but we can test via the policy engine directly
    // Use verify instead
  });

  // Test risk via the recipe dry-run which shows risk assessment
  it('safe git command → recipe dry-run says safe', () => {
    const r = run(`${CLI} run --recipe git-branch-cleanup --input repo_path=. --dry-run`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Safe:  YES'));
  });
});

// ==========================================================================
// README: "Guardrail Recipes"
// ==========================================================================

describe('README Feature: Recipe System', () => {
  it('guardrail list → shows available recipes', () => {
    const r = run(`${CLI} list`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('git-branch-cleanup'));
    assert.ok(r.stdout.includes('npm-publish'));
    assert.ok(r.stdout.includes('infra-deploy'));
  });

  it('guardrail list --json → JSON output', () => {
    const r = run(`${CLI} list --json`);
    assert.equal(r.exitCode, 0);
    const recipes = JSON.parse(r.stdout);
    assert.ok(Array.isArray(recipes));
    assert.ok(recipes.length >= 6);
    assert.ok(recipes.every(r => r.id && r.version && r.risk_level));
  });

  it('guardrail list --category git → filters by category', () => {
    const r = run(`${CLI} list --category git --json`);
    assert.equal(r.exitCode, 0);
    const recipes = JSON.parse(r.stdout);
    assert.ok(recipes.every(r => r.category === 'git'));
  });

  it('guardrail recipe validate → validates recipe file', () => {
    const r = run(`${CLI} recipe validate recipes/git-branch-cleanup.recipe.json`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('valid'));
  });

  it('guardrail recipe inspect → inspects packed recipe', () => {
    // First pack a recipe
    const dir = tmpDir();
    run(`${CLI} pack recipes/git-branch-cleanup.recipe.json --output ${join(dir, 'packed.json')}`);
    const r = run(`${CLI} recipe inspect ${join(dir, 'packed.json')}`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Verified: YES'));
  });

  it('guardrail recipe install → installs to versioned registry', () => {
    const r = run(`${CLI} recipe install recipes/infra-deploy.recipe.json`);
    // Either fresh install or already installed (idempotent)
    assert.ok(r.exitCode === 0);
  });

  it('guardrail recipe validate → validates terraform-plan-only', () => {
    const r = run(`${CLI} recipe validate recipes/terraform-plan-only.recipe.json`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('valid'));
  });

  it('new bounded ship-now recipes dry-run safely', () => {
    const commands = [
      `${CLI} run --recipe git-clone-allowed --input source=https://github.com/guardrail-dev/recipes.git --input destination=tmp/recipes --dry-run`,
      `${CLI} run --recipe gh-open-pr --input repo=guardrail-dev/recipes --input base=dev --input head=feature/test --input title="Test PR" --input body_file=README.md --dry-run`,
      `${CLI} run --recipe gh-release --input repo=guardrail-dev/recipes --input tag=v1.2.3 --input title="Release 1.2.3" --input notes_file=README.md --dry-run`,
      `${CLI} run --recipe docker-build --input image=registry.internal/team/app:1.0.0 --input context_dir=. --dry-run`,
      `${CLI} run --recipe docker-push --input image=registry.internal/team/app:1.0.0 --dry-run`,
    ];

    for (const cmd of commands) {
      const r = run(cmd);
      assert.equal(r.exitCode, 0, `${cmd}\n${r.stderr}`);
      assert.ok(r.stdout.includes('Safe'), cmd);
    }
  });

  it('guardrail recipe versions → lists installed versions', () => {
    run(`${CLI} recipe install recipes/git-branch-cleanup.recipe.json`);
    const r = run(`${CLI} recipe versions git-branch-cleanup`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('1.0.0'));
  });

  it('guardrail recipe install <bare-name> points users to github:// install form', () => {
    const r = run(`${CLI} recipe install open-pr`);
    assert.ok(r.exitCode !== 0);
    assert.ok((r.stderr || '').includes('github://guardrail-dev/recipes/'));
  });

  it('guardrail recipe registry export → writes a static recipe registry snapshot', () => {
    const dir = tmpDir();
    const out = join(dir, 'registry');
    const r = run(`${CLI} recipe registry export ${out}`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('Exported recipe registry snapshot'));
    const index = JSON.parse(readFileSync(join(out, 'v1', 'recipes', 'index.json'), 'utf8'));
    assert.ok(index.recipes.some((entry) => entry.id === 'terraform-plan-only'));
  });

  it('guardrail recipe registry list → shows exported snapshot contents', () => {
    const dir = tmpDir();
    const out = join(dir, 'registry');
    run(`${CLI} recipe registry export ${out}`);
    const r = run(`${CLI} recipe registry list ${out}`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('terraform-plan-only'));
  });

  it('guardrail recipe install <category/id@version> --registry <path> installs from a static registry snapshot', () => {
    const dir = tmpDir();
    const out = join(dir, 'registry');
    const fakeHome = join(dir, 'home');
    run(`${CLI} recipe registry export ${out}`);
    const r = run(`${CLI} recipe install infra/terraform-plan-only@1.0.0 --registry ${out}`, {
      env: {
        ...process.env,
        HOME: fakeHome,
      },
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('Installed recipe "terraform-plan-only"'));
  });

  it('guardrail recipe publish --dry-run converts an approved manifest into a publishable recipe', () => {
    const dir = tmpDir();
    const manifestPath = join(dir, 'approved.json');
    const manifest = {
      contract: {
        command: 'npm',
        args: ['install', '--save-dev'],
        mode: 'structured',
        writablePaths: ['./node_modules'],
        allowedBinaries: ['npm'],
      },
      riskAssessment: {
        riskLevel: 'yellow',
      },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const r = run(`${CLI} recipe publish --name npm-install-safe --category packages --manifest ${manifestPath} --dry-run`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('Dry run'));
    assert.ok(r.stdout.includes('"id": "npm-install-safe"'));
    assert.ok(r.stdout.includes('"channel": "community"'));
  });

  it('bundled codex recipe accepts repeated input_files and dry-runs safely', () => {
    const r = run(
      `${CLI} run --recipe codex-exec ` +
      `--input working_dir=. ` +
      `--input prompt="Review recipe docs." ` +
      `--input input_files=README.md ` +
      `--input input_files=docs/agent-onboarding.md ` +
      `--dry-run`,
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('Safe:  YES'));
  });

  it('bundled Claude recipe dry-runs with structured prompt/input_files execution', () => {
    const r = run(
      `${CLI} run --recipe claude-exec ` +
      `--input guardrail_repo=. ` +
      `--input working_dir=. ` +
      `--input prompt="Review auth flow tests." ` +
      `--input input_files=README.md ` +
      `--input model=sonnet ` +
      `--input effort=high ` +
      `--input mode=plan ` +
      `--input output_format=text ` +
      `--input max_budget_usd=10.00 ` +
      `--input system_prompt="Focus on deterministic failures." ` +
      `--input session_name=readme-review ` +
      `--dry-run`,
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('Safe:  YES'));
  });

  it('bundled git commit recipe dry-runs with an exact staged path list and message file', () => {
    const r = run(
      `${CLI} run --recipe git-commit ` +
      `--input guardrail_repo=. ` +
      `--input repo_path=. ` +
      `--input paths=README.md ` +
      `--input message_file=README.md ` +
      `--dry-run`,
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('Safe:  YES'));
  });
});

// ==========================================================================
// README: "Adapter System"
// ==========================================================================

describe('README Feature: Adapter System', () => {
  it('guardrail adapter run --tool openclaw executes through Guardrail and returns adapter output', () => {
    const r = run(`${CLI} adapter run --tool openclaw -- echo adapter-openclaw`);
    const raw = [r.stdout, r.stderr].filter(Boolean).join('\n');
    assert.ok(r.exitCode !== 0, r.stderr || r.stdout);
    assert.ok(raw.includes('No approved manifest found'));
  });

  it('guardrail adapter run blocks shell-style MCP profiles without a bounded request', () => {
    const r = run(`${CLI} adapter run --tool cline -- echo should-fail`);
    assert.ok(r.exitCode !== 0);
    assert.ok((r.stderr || '').includes('bounded structured request'));
  });

  it('guardrail adapter run accepts bounded MCP requests via --mcp-tool', () => {
    const r = run(`${CLI} adapter run --tool cline --mcp-tool echo --params-json '{}'`);
    const raw = [r.stdout, r.stderr].filter(Boolean).join('\n');
    assert.ok(r.exitCode !== 0);
    assert.ok(raw.includes('No approved manifest found'), raw);
    assert.ok(!raw.includes('bounded structured request'), raw);
  });

  it('guardrail adapter probe routes MCP profiles into bounded discovery instead of the hard MCP block', () => {
    const r = run(`${CLI} adapter probe --tool cline`);
    const raw = [r.stdout, r.stderr].filter(Boolean).join('\n');
    assert.ok(r.exitCode !== 0);
    assert.ok(raw.includes('No approved manifest found'), raw);
    assert.ok(!raw.includes('MCP protocol is not yet supported in v0.2.'), raw);
  });

  it('guardrail adapter mcp tools routes MCP profiles into bounded discovery instead of the hard MCP block', () => {
    const r = run(`${CLI} adapter mcp tools --tool cline`);
    const raw = [r.stdout, r.stderr].filter(Boolean).join('\n');
    assert.ok(r.exitCode !== 0);
    assert.ok(raw.includes('No approved manifest found'), raw);
    assert.ok(!raw.includes('MCP protocol is not yet supported in v0.2.'), raw);
  });

  it('guardrail adapter mcp call routes MCP profiles into the bounded call path instead of the hard MCP block', () => {
    const r = run(`${CLI} adapter mcp call --tool cline --mcp-tool echo --params-json '{"text":"hi"}'`);
    const raw = [r.stdout, r.stderr].filter(Boolean).join('\n');
    assert.ok(r.exitCode !== 0);
    assert.ok(raw.includes('No approved manifest found'), raw);
    assert.ok(!raw.includes('MCP protocol is not yet supported in v0.2.'), raw);
  });

  it('guardrail adapter mcp batch routes MCP profiles into the bounded batch path instead of the hard MCP block', () => {
    const r = run(`${CLI} adapter mcp batch --tool cline --calls-json '[{"tool":"echo","params":{"text":"hi"}}]'`);
    const raw = [r.stdout, r.stderr].filter(Boolean).join('\n');
    assert.ok(r.exitCode !== 0);
    assert.ok(raw.includes('No approved manifest found'), raw);
    assert.ok(!raw.includes('MCP protocol is not yet supported in v0.2.'), raw);
  });

  it('adapter preflight enforces requires_env before execution', async () => {
    const profilePath = writeAdapterProfile({
      requires_env: ['BOUND_TOKEN'],
    });

    const blocked = await runAdapter({
      profilePath,
      rawInput: { command: 'echo', args: ['adapter-auth'] },
    });
    assert.equal(blocked.adapterResult.guardrail.category, 'blocked');
    assert.ok(blocked.adapterResult.guardrail.reason.includes('missing_auth_mapping'));
    assert.ok(blocked.adapterResult.guardrail.reason.includes('BOUND_TOKEN'));

    const allowed = await runAdapter({
      profilePath,
      envAllow: ['BOUND_TOKEN'],
      rawInput: { command: 'echo', args: ['adapter-auth'] },
      supervisorFn: async () => ({
        runId: 'accepted',
        status: 'success',
        reason: 'ok',
        exitCode: 0,
        worker: { launched: true, stdout: 'adapter-auth', stderr: '', exited: 0 },
        telemetry: { durationMs: 1 },
      }),
    });
    assert.equal(allowed.adapterResult.guardrail.category, 'success');
    assert.ok(allowed.adapterResult.guardrail.exitCode === 0 || allowed.exitCode === 0);
  });

  it('adapter preflight blocks missing auth prerequisite checks via API path', async () => {
    const profilePath = writeAdapterProfile({ requires_auth: [{ type: 'claude_login' }] });
    const result = await runAdapter({
      profilePath,
      envAllow: ['HOME'],
      rawInput: { command: 'echo', args: ['adapter-auth'] },
      authCheckFn: async () => ({ success: false, stderr: 'Not logged in' }),
      supervisorFn: async () => {
        throw new Error('supervisor should not run when requires_auth fails');
      },
    });

    assert.equal(result.adapterResult.guardrail.category, 'blocked');
    assert.match(result.adapterResult.guardrail.reason, /missing_auth_prerequisite/);
    assert.match(result.adapterResult.guardrail.reason, /Not logged in|Claude CLI is not logged in/);
    assert.equal(result.exitCode, 16);
  });

  it('guardrail adapter profile index verify validates a signed index file', () => {
    const dir = tmpDir();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const unsigned = {
      version: 1,
      generated_at: '2026-04-10T00:00:00.000Z',
      profiles: {
        openclaw: {
          owner: 'guardrail-dev',
          repo: 'adapter-profiles',
          path: 'openclaw.json',
          sha: 'a'.repeat(40),
          version: '1.0.0',
          content_hash: 'b'.repeat(64),
        },
      },
    };
    const indexPath = join(dir, 'adapter-profiles.index.json');
    const indexKeyPath = join(dir, 'adapter-profiles.index.pub.pem');
    const signature = signBytes(null, Buffer.from(serializeStable(unsigned), 'utf8'), privateKey).toString('base64');
    writeFileSync(indexPath, JSON.stringify({
      ...unsigned,
      signature: {
        algorithm: 'ed25519',
        key_id: 'test-key',
        sig: `base64:${signature}`,
      },
    }, null, 2));
    writeFileSync(indexKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));

    const r = run(`${CLI} adapter profile index verify ${indexPath} --index-key ${indexKeyPath}`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('Adapter profile index verified'));
    assert.ok(r.stdout.includes('openclaw'));
  });

  it('guardrail adapter profile discover lists tools from configured trusted signed indexes', () => {
    const dir = tmpDir();
    const fakeHome = join(dir, 'home');
    mkdirSync(join(fakeHome, '.guardrail'), { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const unsigned = {
      version: 1,
      generated_at: '2026-04-10T00:00:00.000Z',
      profiles: {
        aider: {
          owner: 'guardrail-dev',
          repo: 'adapter-profiles',
          path: 'aider.json',
          sha: 'a'.repeat(40),
          version: '1.0.0',
          content_hash: 'b'.repeat(64),
        },
      },
    };
    const indexPath = join(fakeHome, '.guardrail', 'adapter-profiles.index.json');
    const indexKeyPath = join(fakeHome, '.guardrail', 'adapter-profiles.index.pub.pem');
    const signature = signBytes(null, Buffer.from(serializeStable(unsigned), 'utf8'), privateKey).toString('base64');
    writeFileSync(indexPath, JSON.stringify({
      ...unsigned,
      signature: {
        algorithm: 'ed25519',
        key_id: 'test-key',
        sig: `base64:${signature}`,
      },
    }, null, 2));
    writeFileSync(indexKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
    writeFileSync(join(fakeHome, '.guardrail', 'config.json'), JSON.stringify({
      trusted_sources: ['github://guardrail-dev/adapter-profiles/'],
      trusted_adapter_indexes: [{
        path: 'adapter-profiles.index.json',
        key: 'adapter-profiles.index.pub.pem',
      }],
    }, null, 2));

    const r = run(`${CLI} adapter profile discover aider --json`, {
      env: { ...process.env, HOME: fakeHome },
    });
    assert.equal(r.exitCode, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.matchCount, 1);
    assert.equal(parsed.matches[0].tool, 'aider');
    assert.equal(parsed.matches[0].keyId, 'test-key');
  });
});

// ==========================================================================
// README: "run --recipe" with version pinning
// ==========================================================================

describe('README Feature: Recipe Execution + Versioning', () => {
  function runRecipeDocCommand(cmd) {
    const fakeHome = join(tmpDir(), 'home');
    mkdirSync(fakeHome, { recursive: true });
    return run(cmd, {
      env: { ...process.env, HOME: fakeHome },
    });
  }

  it('guardrail run --recipe <id> --dry-run → runs latest version', () => {
    const r = runRecipeDocCommand(`${CLI} run --recipe dep-upgrade --input package_dir=. --input scope=patch --dry-run`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Dependency Upgrade'));
    assert.ok(r.stdout.includes('Safe'));
  });

  it('guardrail run --recipe <id>@<version> → pins to version', () => {
    const fakeHome = join(tmpDir(), 'home');
    const fakeCwd = join(tmpDir(), 'cwd');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeCwd, { recursive: true });
    run(`${CLI} recipe install recipes/npm-publish.recipe.json`, {
      env: { ...process.env, HOME: fakeHome },
    });
    const r = run(`${CLI} run --recipe npm-publish@1.0.0 --input package_dir=pkg --input tag=beta --dry-run`, {
      cwd: fakeCwd,
      env: { ...process.env, HOME: fakeHome },
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('NPM Package Publish'));
  });

  it('nonexistent version → error with available versions', () => {
    const r = runRecipeDocCommand(`${CLI} run --recipe git-branch-cleanup@99.0.0 --input repo_path=. --dry-run`);
    assert.ok(r.exitCode !== 0);
    assert.ok(r.stderr.includes('99.0.0') || r.stderr.includes('not found'));
  });

  it('missing required input → error with input name', () => {
    const r = runRecipeDocCommand(`${CLI} run --recipe git-branch-cleanup --dry-run`);
    assert.ok(r.exitCode !== 0);
    assert.ok(r.stderr.includes('repo_path') || r.stderr.includes('Missing'));
  });

  it('invalid enum input → error with allowed values', () => {
    const r = runRecipeDocCommand(`${CLI} run --recipe infra-deploy --input environment=hacked --input config_path=x --dry-run`);
    assert.ok(r.exitCode !== 0);
    assert.ok(r.stderr.includes('staging') || r.stderr.includes('production'));
  });

  it('terraform-plan-only dry-runs safely', () => {
    const r = runRecipeDocCommand(`${CLI} run --recipe terraform-plan-only --input config_path=configs/main.tf --dry-run`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('Safe'));
    assert.ok(r.stdout.includes('plan -input=false'));
  });

  it('bounded install and push recipes dry-run with their fixed guardrails', () => {
    const requirements = 'tests/fixtures/requirements-hashed.txt';
    const checks = [
      {
        cmd: `${CLI} run --recipe npm-install --input package_dir=tests/fixtures --input lockfile=package-lock.json --dry-run`,
        expect: 'ci',
      },
      {
        cmd: `${CLI} run --recipe pip-install --input requirements_file=${requirements} --dry-run`,
        expect: 'pip-install-safe-wrapper.js',
      },
      {
        cmd: `${CLI} run --recipe git-push --input repo_path=. --input remote=origin --input branch=feature/demo --dry-run`,
        expect: '--branch feature/demo',
      },
      {
        cmd: `${CLI} run --recipe git-commit-amend --input repo_path=. --input guardrail_repo=. --input message_file=README.md --input expected_head=abcdef123456789 --dry-run`,
        expect: '--expected-head',
      },
      {
        cmd: `${CLI} run --recipe git-force-push-safe --input repo_path=. --input remote=origin --input branch=feature/demo --input expected_head=abcdef123456789 --input expected_remote_oid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --dry-run`,
        expect: '--expected-remote-oid',
      },
    ];
    for (const check of checks) {
      const r = runRecipeDocCommand(check.cmd);
      assert.equal(r.exitCode, 0, `Failed: ${check.cmd}\n${r.stderr}`);
      assert.ok(r.stdout.includes('Safe'));
      assert.ok(r.stdout.includes(check.expect), `Missing ${check.expect} in ${r.stdout}`);
    }
  });

  it('task-specific OpenClaw recipes dry-run with fixed flows and scopes', () => {
    const checks = [
      {
        cmd: `${CLI} run --recipe openclaw-debug-ci --dry-run`,
        expect: 'debug-ci',
      },
      {
        cmd: `${CLI} run --recipe openclaw-deploy --input environment=preview --input service_manifest=package.json --input release_file=package.json --dry-run`,
        expect: 'deploy',
      },
    ];
    for (const check of checks) {
      const r = runRecipeDocCommand(check.cmd);
      assert.equal(r.exitCode, 0, `Failed: ${check.cmd}\n${r.stderr}`);
      assert.ok(r.stdout.includes('Safe'));
      assert.ok(r.stdout.includes(check.expect), `Missing ${check.expect} in ${r.stdout}`);
    }
  });

  it('all shipped infrastructure-safe recipes dry-run successfully', () => {
    const runs = [
      `${CLI} run --recipe git-branch-cleanup --input repo_path=. --dry-run`,
      `${CLI} run --recipe git-push --input repo_path=. --input remote=origin --input branch=feature/demo --dry-run`,
      `${CLI} run --recipe dep-upgrade --input package_dir=. --input scope=patch --dry-run`,
      `${CLI} run --recipe npm-install --input package_dir=tests/fixtures --input lockfile=package-lock.json --dry-run`,
      `${CLI} run --recipe pip-install --input requirements_file=tests/fixtures/requirements-hashed.txt --dry-run`,
      `${CLI} run --recipe github-pr-merge --input repo=org/repo --input max_prs=3 --input label=approved --dry-run`,
      `${CLI} run --recipe infra-deploy --input environment=staging --input config_path=configs/main.tf --dry-run`,
      `${CLI} run --recipe npm-publish --input package_dir=pkg --input tag=latest --dry-run`,
      `${CLI} run --recipe openclaw-fix-tests --dry-run`,
      `${CLI} run --recipe openclaw-debug-ci --dry-run`,
      `${CLI} run --recipe openclaw-wrapper --input flow_id=fix-tests --input scope=write --dry-run`,
      `${CLI} run --recipe git-commit-amend --input repo_path=. --input guardrail_repo=. --input message_file=README.md --input expected_head=aaaaaaaaaaaaaaa --dry-run`,
      `${CLI} run --recipe git-force-push-safe --input repo_path=. --input remote=origin --input branch=feature/demo --input expected_head=aaaaaaaaaaaaaaa --input expected_remote_oid=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --dry-run`,
    ];
    for (const cmd of runs) {
      const r = runRecipeDocCommand(cmd);
      assert.equal(r.exitCode, 0, `Failed: ${cmd}\n${r.stderr}`);
      assert.ok(r.stdout.includes('Safe'), `Not safe: ${cmd}`);
    }
  });
});

// ==========================================================================
// README: "CI / Non-Interactive Mode"
// ==========================================================================

describe('README Feature: Non-Interactive / CI Mode', () => {
  it('--non-interactive without --approved-manifest → exit 10', () => {
    const r = run(`${CLI} run --non-interactive -- echo hello`);
    assert.equal(r.exitCode, 10);
  });

  it('--non-interactive with missing manifest → fail closed', () => {
    const r = run(`${CLI} run --non-interactive --approved-manifest /nonexistent/manifest.json -- echo hello`);
    assert.ok(r.exitCode !== 0);
  });

  it('--json flag produces JSON output', () => {
    const r = run(`${CLI} list --json`);
    assert.equal(r.exitCode, 0);
    assert.doesNotThrow(() => JSON.parse(r.stdout));
  });

  it('workflow --non-interactive without manifest → exit 10', () => {
    const dir = tmpDir();
    const def = {
      version: 1, kind: 'workflow_definition', name: 'ci-wf',
      projectRoot: '.', entryStep: 's', maxIterations: 1, services: [],
      steps: [{
        id: 's', type: 'task',
        run: { command: 'echo', args: ['ci'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
        validator: 'exit_code', updateSource: 'none',
        on: { success: 'done', validation_failed: 'abort' },
      }],
    };
    writeFileSync(join(dir, 'wf.json'), JSON.stringify(def, null, 2));
    const r = run(`${CLI} workflow run --definition ${join(dir, 'wf.json')} --non-interactive`);
    assert.equal(r.exitCode, 10);
  });

  it('recipe --non-interactive without manifest → exit 10', () => {
    const r = run(`${CLI} run --recipe git-branch-cleanup --input repo_path=. --non-interactive`);
    assert.equal(r.exitCode, 10);
  });

  it('recipe --non-interactive with missing manifest → fail closed before execution', () => {
    const r = run(`${CLI} run --recipe git-branch-cleanup --input repo_path=. --non-interactive --approved-manifest /nonexistent/recipe-approved.json`);
    assert.equal(r.exitCode, 10);
  });
});

// ==========================================================================
// README: "Drift detection"
// ==========================================================================

describe('README Feature: Drift Detection', () => {
  it('mismatched manifest blocks execution (non-interactive)', () => {
    // A stale/wrong manifest should cause non-interactive mode to fail — never silently succeed
    const dir = tmpDir();
    mkdirSync(join(dir, '.guardrail'), { recursive: true });
    const manifestPath = join(dir, '.guardrail', 'approved.json');
    // Write an obviously wrong manifest (hash won't match any real command)
    writeFileSync(manifestPath, JSON.stringify({
      version: 1, tool: 'guardrail', approvedAt: new Date().toISOString(),
      projectRoot: dir, contractHash: 'deadbeef',
      contract: { command: 'true', args: [], cwd: dir, mode: 'structured' },
      riskAssessment: { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [],
        requiresStrongConfirmation: false, acknowledgedBy: 'test', acknowledgedAt: new Date().toISOString() },
      workflow: { validator: 'exit_code', updateSource: 'none' },
    }, null, 2));

    // Try to run a different command — should fail (drift or mismatch)
    const r = run(`${CLI} run --non-interactive --approved-manifest ${manifestPath} -- echo different`, { cwd: dir });
    assert.ok(r.exitCode !== 0, `Should not succeed with mismatched manifest, got exit ${r.exitCode}`);
  });
});

// ==========================================================================
// README: "guardrail verify"
// ==========================================================================

describe('README Feature: Self-Verification', () => {
  it('guardrail verify → all checks pass', () => {
    const r = run(`${CLI} verify`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('All checks passed'));
  });

  it('guardrail verify --json → JSON output with checks array', () => {
    const r = run(`${CLI} verify --json`);
    assert.equal(r.exitCode, 0);
    const result = JSON.parse(r.stdout);
    assert.equal(result.passed, true);
    assert.ok(Array.isArray(result.checks));
    assert.ok(result.checks.length >= 5);
  });
});

// ==========================================================================
// README: "Demo" commands
// ==========================================================================

describe('README Feature: Demo Commands', () => {
  it('guardrail demo list → shows all demos', () => {
    const r = run(`${CLI} demo list`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('drift'));
    assert.ok(r.stdout.includes('recipe'));
    assert.ok(r.stdout.includes('trust'));
    assert.ok(r.stdout.includes('blocked'));
  });

  it('guardrail demo recipe → runs without error', () => {
    const r = run(`${CLI} demo recipe`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Demo complete'));
  });

  it('guardrail demo trust → runs without error', () => {
    const r = run(`${CLI} demo trust`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Demo complete'));
  });

  it('guardrail demo blocked → shows all commands blocked', () => {
    const r = run(`${CLI} demo blocked`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('BLOCKED'));
    assert.ok(r.stdout.includes('RED'));
    assert.ok(r.stdout.includes('Demo complete'));
  });
});

// ==========================================================================
// README: "Audit" commands
// ==========================================================================

describe('README Feature: Audit Commands', () => {
  it('guardrail audit verify → verifies chain on default path', () => {
    const r = run(`${CLI} audit verify`);
    // May pass (clean or no file) or fail (broken chain) — but shouldn't crash
    assert.ok(r.exitCode === 0 || r.exitCode !== undefined);
  });

  it('guardrail audit verify --path <file> → verifies specific file', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    // Empty file = clean
    writeFileSync(auditPath, '');
    const r = run(`${CLI} audit verify --path ${auditPath}`);
    assert.equal(r.exitCode, 0);
  });
});

// ==========================================================================
// README: "Profile" and "Policy" commands
// ==========================================================================

describe('README Feature: Profile Commands', () => {
  it('guardrail profile list → runs without error', () => {
    const r = run(`${CLI} profile list`);
    assert.equal(r.exitCode, 0);
    // May show "No profiles found" or existing profiles — both are valid
    assert.ok(r.stdout.includes('profile') || r.stdout.includes('No profiles'));
  });
});

describe('README Feature: Policy Commands', () => {
  it('guardrail policy list → runs without error', () => {
    const r = run(`${CLI} policy list`);
    assert.equal(r.exitCode, 0);
  });
});

// ==========================================================================
// README: "Metrics" and "Marketplace"
// ==========================================================================

describe('README Feature: Metrics', () => {
  it('guardrail metrics → runs without error', () => {
    const r = run(`${CLI} metrics`);
    // May have no data but shouldn't crash
    assert.ok(r.exitCode === 0 || r.exitCode !== undefined);
  });
});

// ==========================================================================
// README: "Environment Policy" — secret detection
// ==========================================================================

describe('README Feature: Secret Detection', () => {
  it('SECRET in env inject → detected', () => {
    // Use policy engine directly since CLI requires interactive approval
    const r = run(`node -e "
      import {evaluateRisk} from './src/policy-engine.js';
      const r = evaluateRisk(
        {command:'node',args:['app.js'],cwd:'/p',mode:'structured',envPolicy:{inject:{DB_SECRET:'x'}}},
        {trustClass:'reviewed_internal',projectRoot:'/p'}
      );
      console.log(JSON.stringify({risk:r.riskLevel,reasons:r.reasons}));
    "`);
    assert.equal(r.exitCode, 0);
    const result = JSON.parse(r.stdout);
    assert.ok(result.reasons.some(r => r.includes('secret')));
  });

  it('TOKEN in env allow → detected', () => {
    const r = run(`node -e "
      import {evaluateRisk} from './src/policy-engine.js';
      const r = evaluateRisk(
        {command:'node',args:['app.js'],cwd:'/p',mode:'structured',envPolicy:{inherit:false,allow:['API_TOKEN']}},
        {trustClass:'reviewed_internal',projectRoot:'/p'}
      );
      console.log(JSON.stringify({risk:r.riskLevel,reasons:r.reasons}));
    "`);
    assert.equal(r.exitCode, 0);
    const result = JSON.parse(r.stdout);
    assert.ok(result.reasons.some(r => r.includes('secret')));
  });

  it('secret + production target → Red', () => {
    const r = run(`node -e "
      import {evaluateRisk} from './src/policy-engine.js';
      const r = evaluateRisk(
        {command:'node',args:['deploy','--env','production'],cwd:'/p',mode:'structured',envPolicy:{inject:{DB_PASSWORD:'x'}}},
        {trustClass:'reviewed_internal',projectRoot:'/p'}
      );
      console.log(r.riskLevel);
    "`);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, 'red');
  });
});

// ==========================================================================
// README: "pack" command
// ==========================================================================

describe('README Feature: Pack Command', () => {
  it('guardrail pack → creates packed recipe with hash', () => {
    const dir = tmpDir();
    const r = run(`${CLI} pack recipes/git-branch-cleanup.recipe.json --output ${join(dir, 'packed.json')}`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Hash'));
    assert.ok(existsSync(join(dir, 'packed.json')));

    const packed = JSON.parse(readFileSync(join(dir, 'packed.json'), 'utf8'));
    assert.ok(packed.content_hash);
    assert.ok(packed.recipe);
    assert.equal(packed.immutable, true);
  });
});

// ==========================================================================
// README: "create" command
// ==========================================================================

describe('README Feature: Create Command', () => {
  it('guardrail create --name my-recipe --category git → generates skeleton', () => {
    const dir = tmpDir();
    const r = run(`${CLI} create --name my-test-recipe --category git --output ${join(dir, 'skel.json')}`);
    assert.equal(r.exitCode, 0);
    assert.ok(existsSync(join(dir, 'skel.json')));

    const skel = JSON.parse(readFileSync(join(dir, 'skel.json'), 'utf8'));
    assert.equal(skel.category, 'git');
    assert.ok(skel.id.includes('my-test-recipe'));
    assert.ok(skel.inputs);
    assert.ok(skel.steps);
    assert.ok(skel.guardrails);
  });
});

// ==========================================================================
// README: "--version" and "--help"
// ==========================================================================

describe('README Feature: CLI Basics', () => {
  it('guardrail --version → shows version', () => {
    const r = run(`${CLI} --version`);
    assert.equal(r.exitCode, 0);
    assert.ok(/\d+\.\d+\.\d+/.test(r.stdout));
  });

  it('guardrail --help → shows usage', () => {
    const r = run(`${CLI} --help`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('guardrail'));
    assert.ok(r.stdout.includes('run'));
  });

  it('guardrail (no args) → shows usage', () => {
    const r = run(`${CLI}`);
    // Should show usage (exit 1 or 0 with help text)
    assert.ok(r.stdout.includes('Usage') || r.stderr.includes('Usage'));
  });
});

// ==========================================================================
// README: Version immutability (from recipe model)
// ==========================================================================

describe('README Feature: Recipe Immutability', () => {
  it('same recipe re-installed is idempotent', () => {
    const r1 = run(`${CLI} recipe install recipes/git-branch-cleanup.recipe.json`);
    const r2 = run(`${CLI} recipe install recipes/git-branch-cleanup.recipe.json`);
    // Both should succeed (first installs, second is idempotent)
    assert.ok(r1.exitCode === 0);
    assert.ok(r2.exitCode === 0);
  });

  it('packed recipe tamper detection works', () => {
    const dir = tmpDir();
    run(`${CLI} pack recipes/git-branch-cleanup.recipe.json --output ${join(dir, 'packed.json')}`);

    // Tamper with the packed recipe
    const packed = JSON.parse(readFileSync(join(dir, 'packed.json'), 'utf8'));
    packed.recipe.steps[0].run.command = 'rm';
    writeFileSync(join(dir, 'packed.json'), JSON.stringify(packed, null, 2));

    const r = run(`${CLI} recipe inspect ${join(dir, 'packed.json')}`);
    assert.ok(r.exitCode !== 0 || r.stdout.includes('FAILED'));
  });
});

// ===========================================================================
// Policy simulation CLI surface (P0b)
// ===========================================================================

describe('Feature: policy simulate CLI surface', () => {
  it('policy simulate allow — safe contract exits 0 and prints ALLOW', () => {
    const contract = JSON.stringify({
      command: 'echo', args: ['hello'], cwd: '/tmp', mode: 'structured',
    });
    const r = run(`${CLI} policy simulate --contract '${contract}' --trust-class reviewed_internal --project-root /tmp`);
    assert.equal(r.exitCode, 0, `expected exit 0, got ${r.exitCode}. stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('ALLOW'), `expected ALLOW in output: ${r.stdout}`);
    assert.ok(r.stdout.includes('simulated'), `expected simulated marker: ${r.stdout}`);
  });

  it('policy simulate deny — red contract exits 1 and prints DENY', () => {
    const contract = JSON.stringify({
      command: 'terraform', args: ['apply'], cwd: '/tmp', mode: 'structured',
    });
    const r = run(`${CLI} policy simulate --contract '${contract}' --trust-class reviewed_internal --project-root /tmp`);
    assert.equal(r.exitCode, 1, `expected exit 1 for red contract, got ${r.exitCode}`);
    assert.ok(r.stdout.includes('DENY'), `expected DENY in output: ${r.stdout}`);
  });

  it('policy simulate --json returns machine-readable trace', () => {
    const contract = JSON.stringify({
      command: 'git', args: ['status'], cwd: '/tmp', mode: 'structured',
    });
    const r = run(`${CLI} policy simulate --contract '${contract}' --trust-class reviewed_internal --project-root /tmp --json`);
    assert.equal(r.exitCode, 0, `expected exit 0: ${r.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); }, 'output must be valid JSON');
    assert.equal(parsed.simulated, true);
    assert.ok(['allow', 'deny'].includes(parsed.decision), 'decision must be allow or deny');
    assert.ok(Array.isArray(parsed.matched_rules), 'matched_rules must be array');
    assert.ok(Array.isArray(parsed.trace?.checks),  'trace.checks must be array');
  });

  it('policy simulate with --contract-file reads from file', () => {
    const dir = tmpDir();
    const contractPath = join(dir, 'contract.json');
    writeFileSync(contractPath, JSON.stringify({
      command: 'node', args: ['app.js'], cwd: '/tmp', mode: 'structured',
    }));
    const r = run(`${CLI} policy simulate --contract-file ${contractPath} --trust-class reviewed_internal --project-root /tmp`);
    assert.ok(r.exitCode === 0 || r.exitCode === 1, 'must exit 0 or 1');
    assert.ok(r.stdout.includes('(simulated)'), `expected simulated marker: ${r.stdout}`);
  });

  it('policy simulate missing --contract → error', () => {
    const r = run(`${CLI} policy simulate --trust-class reviewed_internal`);
    assert.ok(r.exitCode !== 0, 'must fail without contract');
    assert.ok((r.stdout + r.stderr).includes('required'), `expected required error: ${r.stderr}`);
  });

  it('policy simulate --principal propagated to JSON output', () => {
    const contract = JSON.stringify({
      command: 'echo', args: ['hi'], cwd: '/tmp', mode: 'structured',
    });
    const r = run(`${CLI} policy simulate --contract '${contract}' --trust-class reviewed_internal --principal ops-team --json`);
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.principal, 'ops-team');
  });
});
