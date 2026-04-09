import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadWorkflowDefinition, normalizeWorkflowDefinition, hashWorkflow, createWorkflowManifest, compareWorkflowManifests, diffWorkflowManifests, lintWorkflowDefinition, TERMINAL_STATES } from '../src/workflow.js';
import { evaluateWorkflowRisk } from '../src/policy-engine.js';
import { saveManifest, loadManifest } from '../src/manifest.js';
import { createContract } from '../src/contract.js';
import { STATUS_EXIT_CODES } from '../src/supervisor.js';
import { runWorkflowSupervisor } from '../src/workflow-supervisor.js';
import { signRecipe } from '../src/recipe-channel.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefinition(overrides = {}) {
  return {
    version: 1,
    kind: 'workflow_definition',
    name: 'test-workflow',
    projectRoot: '.',
    entryStep: 'step_a',
    maxIterations: 5,
    services: [],
    steps: [
      {
        id: 'step_a',
        type: 'task',
        run: { command: 'echo', args: ['hello'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
        validator: 'exit_code',
        updateSource: 'none',
        on: { success: 'done', validation_failed: 'abort' }
      }
    ],
    ...overrides,
  };
}

function makeDefinitionWithServices(overrides = {}) {
  return {
    version: 1,
    kind: 'workflow_definition',
    name: 'service-workflow',
    projectRoot: '.',
    entryStep: 'start_svc',
    maxIterations: 10,
    services: [
      {
        id: 'api',
        start: { command: 'node', args: ['server.js'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
        stop: { signal: 'SIGTERM', killAfterMs: 5000 }
      }
    ],
    steps: [
      {
        id: 'start_svc',
        type: 'service_start',
        serviceId: 'api',
        on: { success: 'run_task', failure: 'abort' }
      },
      {
        id: 'run_task',
        type: 'task',
        run: { command: 'echo', args: ['task'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
        validator: 'exit_code',
        updateSource: 'none',
        on: { success: 'stop_svc', validation_failed: 'restart_svc' }
      },
      {
        id: 'restart_svc',
        type: 'service_restart',
        serviceId: 'api',
        on: { success: 'run_task', failure: 'abort' }
      },
      {
        id: 'stop_svc',
        type: 'service_stop',
        serviceId: 'api',
        on: { success: 'done', failure: 'abort' }
      }
    ],
    ...overrides,
  };
}

/**
 * Write a definition to a temp JSON file and return its path.
 */
function writeDefFile(dir, def, filename = 'workflow.json') {
  const filePath = join(dir, filename);
  writeFileSync(filePath, JSON.stringify(def, null, 2), 'utf8');
  return filePath;
}

function writeRecipeFile(dir, recipe, filename = `${recipe.id}.recipe.json`) {
  const filePath = join(dir, filename);
  writeFileSync(filePath, JSON.stringify(recipe, null, 2), 'utf8');
  return filePath;
}

/**
 * Build a normalised workflow and its manifest for comparison tests.
 */
function buildManifest(def, basePath) {
  const normalized = normalizeWorkflowDefinition(def, basePath || tmpdir());
  const hash = hashWorkflow(normalized);
  const risk = evaluateWorkflowRisk(normalized, { trustClass: 'reviewed_internal', projectRoot: basePath || tmpdir() });
  return createWorkflowManifest(normalized, hash, risk, normalized.projectRoot);
}

function createAckedManifest(def, basePath, manifestPath) {
  const manifest = buildManifest(def, basePath);
  manifest.riskAssessment.acknowledgedBy = 'test';
  manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
  saveManifest(manifest, manifestPath);
  return manifest;
}

// ===========================================================================
// 1. Workflow Definition Parsing
// ===========================================================================

describe('Workflow Definition Parsing', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wf-parse-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('valid definition loads without error', () => {
    const def = makeDefinition();
    const filePath = writeDefFile(tmpDir, def, 'valid.json');
    const loaded = loadWorkflowDefinition(filePath);
    assert.equal(loaded.name, 'test-workflow');
    assert.equal(loaded.entryStep, 'step_a');
  });

  it('missing version throws', () => {
    const def = makeDefinition();
    delete def.version;
    const filePath = writeDefFile(tmpDir, def, 'no-version.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /version/);
  });

  it('wrong version throws', () => {
    const def = makeDefinition({ version: 99 });
    const filePath = writeDefFile(tmpDir, def, 'bad-version.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /version/);
  });

  it('missing kind throws', () => {
    const def = makeDefinition();
    delete def.kind;
    const filePath = writeDefFile(tmpDir, def, 'no-kind.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /kind/);
  });

  it('wrong kind throws', () => {
    const def = makeDefinition({ kind: 'pipeline' });
    const filePath = writeDefFile(tmpDir, def, 'bad-kind.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /kind/);
  });

  it('missing name throws', () => {
    const def = makeDefinition();
    delete def.name;
    const filePath = writeDefFile(tmpDir, def, 'no-name.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /name/);
  });

  it('empty string name throws', () => {
    const def = makeDefinition({ name: '  ' });
    const filePath = writeDefFile(tmpDir, def, 'empty-name.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /name/);
  });

  it('missing entryStep throws', () => {
    const def = makeDefinition();
    delete def.entryStep;
    const filePath = writeDefFile(tmpDir, def, 'no-entry.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /entryStep/);
  });

  it('entryStep referencing nonexistent step throws', () => {
    const def = makeDefinition({ entryStep: 'nonexistent_step' });
    const filePath = writeDefFile(tmpDir, def, 'bad-entry.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /entryStep.*does not reference/);
  });

  it('nonexistent file throws', () => {
    assert.throws(() => loadWorkflowDefinition(join(tmpDir, 'nope.json')), /Cannot read/);
  });

  it('invalid JSON throws', () => {
    const filePath = join(tmpDir, 'bad.json');
    writeFileSync(filePath, '{not valid json}', 'utf8');
    assert.throws(() => loadWorkflowDefinition(filePath), /Invalid JSON/);
  });

  it('definition with services loads without error', () => {
    const def = makeDefinitionWithServices();
    const filePath = writeDefFile(tmpDir, def, 'services.json');
    const loaded = loadWorkflowDefinition(filePath);
    assert.equal(loaded.name, 'service-workflow');
    assert.equal(loaded.services.length, 1);
    assert.equal(loaded.steps.length, 4);
  });

  it('recipe_ref steps require a recipe specifier', () => {
    const def = makeDefinition({
      steps: [{
        id: 'step_a',
        type: 'recipe_ref',
        inputs: {},
        on: { success: 'done', failure: 'abort' },
      }],
    });
    const filePath = writeDefFile(tmpDir, def, 'missing-recipe-ref.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /recipe specifier/);
  });
});

// ===========================================================================
// 2. Unique Step and Service IDs
// ===========================================================================

describe('Unique Step and Service IDs', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wf-ids-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('duplicate step IDs throw', () => {
    const def = makeDefinition({
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['1'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['2'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const filePath = writeDefFile(tmpDir, def, 'dup-steps.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /duplicate step id/);
  });

  it('duplicate service IDs throw', () => {
    const def = makeDefinitionWithServices();
    def.services.push({
      id: 'api',
      start: { command: 'node', args: ['other.js'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
      stop: { signal: 'SIGTERM', killAfterMs: 5000 }
    });
    const filePath = writeDefFile(tmpDir, def, 'dup-services.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /duplicate service id/);
  });

  it('service steps referencing undeclared services throw', () => {
    const def = makeDefinition({
      steps: [
        {
          id: 'step_a',
          type: 'service_start',
          serviceId: 'ghost_service',
          on: { success: 'done', failure: 'abort' }
        }
      ],
    });
    const filePath = writeDefFile(tmpDir, def, 'undeclared-svc.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /does not reference a declared service/);
  });

  it('service_stop referencing undeclared service throws', () => {
    const def = makeDefinition({
      steps: [
        {
          id: 'step_a',
          type: 'service_stop',
          serviceId: 'missing_svc',
          on: { success: 'done', failure: 'abort' }
        }
      ],
    });
    const filePath = writeDefFile(tmpDir, def, 'undeclared-stop.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /does not reference a declared service/);
  });
});

// ===========================================================================
// 3. Transition Validation
// ===========================================================================

describe('Transition Validation', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wf-trans-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('transitions to existing step IDs pass', () => {
    const def = makeDefinition({
      entryStep: 'step_a',
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['a'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'step_b', validation_failed: 'abort' }
        },
        {
          id: 'step_b',
          type: 'task',
          run: { command: 'echo', args: ['b'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const filePath = writeDefFile(tmpDir, def, 'valid-trans.json');
    const loaded = loadWorkflowDefinition(filePath);
    assert.equal(loaded.steps.length, 2);
  });

  it('transitions to done and abort pass', () => {
    const def = makeDefinition();
    // step_a already transitions to done and abort
    const filePath = writeDefFile(tmpDir, def, 'terminal-trans.json');
    const loaded = loadWorkflowDefinition(filePath);
    assert.equal(loaded.steps[0].on.success, 'done');
    assert.equal(loaded.steps[0].on.validation_failed, 'abort');
  });

  it('transitions to nonexistent step IDs throw', () => {
    const def = makeDefinition({
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['hello'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'step_nowhere', validation_failed: 'abort' }
        },
      ],
    });
    const filePath = writeDefFile(tmpDir, def, 'bad-trans.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /does not reference a declared step or terminal state/);
  });

  it('transition with invalid target type throws', () => {
    const def = makeDefinition({
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['hello'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 123, validation_failed: 'abort' }
        },
      ],
    });
    const filePath = writeDefFile(tmpDir, def, 'bad-trans-type.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /must be a string/);
  });
});

// ===========================================================================
// 4. Workflow Outputs and State References
// ===========================================================================

describe('Workflow Outputs and State References', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wf-outputs-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts valid output declarations on task and recipe_ref steps', () => {
    const def = makeDefinition({
      entryStep: 'producer',
      steps: [
        {
          id: 'producer',
          type: 'task',
          run: { command: 'echo', args: ['hello'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          outputs: {
            statusValue: { type: 'string', from: 'protocolMessages.0.status' },
          },
          on: { success: 'consumer', validation_failed: 'abort' },
        },
        {
          id: 'consumer',
          type: 'recipe_ref',
          recipe: 'demo-recipe',
          outputs: {
            resultValue: { type: 'json', from: 'status' },
          },
          inputs: {},
          on: { success: 'done', failure: 'abort' },
        },
      ],
    });
    const filePath = writeDefFile(tmpDir, def, 'outputs-valid.json');
    const loaded = loadWorkflowDefinition(filePath);
    assert.equal(loaded.steps.length, 2);
  });

  it('rejects outputs on service steps', () => {
    const def = makeDefinitionWithServices({
      steps: [
        {
          id: 'start_svc',
          type: 'service_start',
          serviceId: 'api',
          outputs: {
            bad: { type: 'string', from: 'protocolMessages' },
          },
          on: { success: 'run_task', failure: 'abort' },
        },
      ],
    });
    const filePath = writeDefFile(tmpDir, def, 'outputs-service.json');
    assert.throws(() => loadWorkflowDefinition(filePath), /outputs are not supported for service steps/);
  });

  it('rejects invalid output type and forbidden from roots', () => {
    const badType = makeDefinition({
      steps: [{
        id: 'step_a',
        type: 'task',
        run: { command: 'echo', args: ['bad'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
        outputs: {
          one: { type: 'invalid', from: 'protocolMessages' },
        },
        on: { success: 'done', validation_failed: 'abort' },
      }],
    });
    const badTypePath = writeDefFile(tmpDir, badType, 'outputs-bad-type.json');
    assert.throws(() => loadWorkflowDefinition(badTypePath), /must be one of/);

    const badRoot = makeDefinition({
      steps: [{
        id: 'step_a',
        type: 'task',
        run: { command: 'echo', args: ['bad'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
        outputs: {
          one: { type: 'string', from: 'stdout.body' },
        },
        on: { success: 'done', validation_failed: 'abort' },
      }],
    });
    const badRootPath = writeDefFile(tmpDir, badRoot, 'outputs-bad-root.json');
    assert.throws(() => loadWorkflowDefinition(badRootPath), /disallowed root/);
  });

  it('accepts valid task run arg and recipe_ref input state references', () => {
    const def = makeDefinition({
      entryStep: 'producer',
      steps: [
        {
          id: 'producer',
          type: 'task',
          run: { command: 'echo', args: ['ready'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          outputs: {
            exitValue: { type: 'number', from: 'exitCode' },
          },
          on: { success: 'consumer', validation_failed: 'abort' },
        },
        {
          id: 'consumer',
          type: 'recipe_ref',
          recipe: 'demo-recipe',
          inputs: {
            from_task: '{{state.producer.exitValue}}',
          },
          on: { success: 'done', failure: 'abort' },
        },
      ],
    });
    const filePath = writeDefFile(tmpDir, def, 'state-ref-valid.json');
    const loaded = loadWorkflowDefinition(filePath);
    assert.equal(loaded.steps[1].inputs.from_task, '{{state.producer.exitValue}}');
  });

  it('rejects malformed, missing producer, and missing output state references', () => {
    const malformed = makeDefinition({
      steps: [{
        id: 'step_a',
        type: 'task',
        run: { command: 'echo', args: ['a', '{{state.onlytwo}'] , cwd: '.', mode: 'structured', timeoutMs: 5000 },
        on: { success: 'done', validation_failed: 'abort' },
      }],
    });
    const malformedPath = writeDefFile(tmpDir, malformed, 'state-ref-malformed.json');
    assert.throws(() => loadWorkflowDefinition(malformedPath), /malformed state reference/);

    const missingProducer = makeDefinition({
      steps: [{
        id: 'step_a',
        type: 'task',
        run: { command: 'echo', args: ['x', '{{state.nope.exitValue}}'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
        on: { success: 'done', validation_failed: 'abort' },
      }],
    });
    const missingProducerPath = writeDefFile(tmpDir, missingProducer, 'state-ref-missing-producer.json');
    assert.throws(() => loadWorkflowDefinition(missingProducerPath), /does not reference a declared step/);

    const withProducer = makeDefinition({
      entryStep: 'producer',
      steps: [
        {
          id: 'producer',
          type: 'task',
          run: { command: 'echo', args: ['ok'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          on: { success: 'consumer', validation_failed: 'abort' },
        },
        {
          id: 'consumer',
          type: 'task',
          run: { command: 'echo', args: ['{{state.producer.missing}}'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          on: { success: 'done', validation_failed: 'abort' },
        },
      ],
    });
    const missingOutputPath = writeDefFile(tmpDir, withProducer, 'state-ref-missing-output.json');
    assert.throws(() => loadWorkflowDefinition(missingOutputPath), /does not match declared outputs/);
  });

  it('detects cycles in state reference graph', () => {
    const def = makeDefinition({
      entryStep: 'step_a',
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['{{state.step_b.dep}}'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          outputs: { valueA: { type: 'string', from: 'exitCode' } },
          on: { success: 'step_b', validation_failed: 'abort' },
        },
        {
          id: 'step_b',
          type: 'recipe_ref',
          recipe: 'cycle-recipe',
          outputs: { dep: { type: 'string', from: 'status' } },
          inputs: { p: '{{state.step_a.valueA}}' },
          on: { success: 'done', validation_failed: 'abort' },
        },
      ],
    });
    const cyclePath = writeDefFile(tmpDir, def, 'state-ref-cycle.json');
    assert.throws(() => loadWorkflowDefinition(cyclePath), /state reference cycle detected/);
  });
});

// ===========================================================================
// 4. Workflow Hashing Stability
// ===========================================================================

describe('Workflow Hashing Stability', () => {
  const basePath = tmpdir();

  it('same definition hashes identically', () => {
    const def1 = makeDefinition();
    const def2 = makeDefinition();
    const norm1 = normalizeWorkflowDefinition(def1, basePath);
    const norm2 = normalizeWorkflowDefinition(def2, basePath);
    assert.equal(hashWorkflow(norm1), hashWorkflow(norm2));
  });

  it('changed step args changes hash', () => {
    const def1 = makeDefinition();
    const def2 = makeDefinition();
    def2.steps[0].run.args = ['goodbye'];
    const norm1 = normalizeWorkflowDefinition(def1, basePath);
    const norm2 = normalizeWorkflowDefinition(def2, basePath);
    assert.notEqual(hashWorkflow(norm1), hashWorkflow(norm2));
  });

  it('changed maxIterations changes hash', () => {
    const def1 = makeDefinition({ maxIterations: 5 });
    const def2 = makeDefinition({ maxIterations: 50 });
    const norm1 = normalizeWorkflowDefinition(def1, basePath);
    const norm2 = normalizeWorkflowDefinition(def2, basePath);
    assert.notEqual(hashWorkflow(norm1), hashWorkflow(norm2));
  });

  it('changed step command changes hash', () => {
    const def1 = makeDefinition();
    const def2 = makeDefinition();
    def2.steps[0].run.command = 'cat';
    const norm1 = normalizeWorkflowDefinition(def1, basePath);
    const norm2 = normalizeWorkflowDefinition(def2, basePath);
    assert.notEqual(hashWorkflow(norm1), hashWorkflow(norm2));
  });

  it('changed workflow name changes hash', () => {
    const def1 = makeDefinition({ name: 'alpha' });
    const def2 = makeDefinition({ name: 'beta' });
    const norm1 = normalizeWorkflowDefinition(def1, basePath);
    const norm2 = normalizeWorkflowDefinition(def2, basePath);
    assert.notEqual(hashWorkflow(norm1), hashWorkflow(norm2));
  });

  it('hash is a 64-char hex string', () => {
    const norm = normalizeWorkflowDefinition(makeDefinition(), basePath);
    const h = hashWorkflow(norm);
    assert.match(h, /^[a-f0-9]{64}$/);
  });
});

// ===========================================================================
// 5. Workflow Manifest Save/Load
// ===========================================================================

describe('Workflow Manifest Save/Load', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wf-manifest-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('create, save, and load round-trip', () => {
    const def = makeDefinition();
    const manifest = buildManifest(def, tmpDir);
    const filePath = join(tmpDir, 'approved.json');
    saveManifest(manifest, filePath);
    const loaded = loadManifest(filePath);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.kind, 'workflow');
    assert.equal(loaded.workflowHash, manifest.workflowHash);
    assert.deepEqual(loaded.workflow, manifest.workflow);
  });

  it('missing manifest returns null', () => {
    const loaded = loadManifest(join(tmpDir, 'nonexistent.json'));
    assert.equal(loaded, null);
  });

  it('comparison of identical manifests matches', () => {
    const def = makeDefinition();
    const m1 = buildManifest(def, tmpDir);
    const m2 = buildManifest(def, tmpDir);
    const result = compareWorkflowManifests(m1, m2);
    assert.equal(result.matches, true);
    assert.equal(result.diffs.length, 0);
  });

  it('projectRoot drift is detected', () => {
    const def = makeDefinition();
    const m1 = buildManifest(def, tmpDir);
    const m2 = buildManifest(def, tmpDir);
    m2.projectRoot = join(tmpDir, 'other-root');
    const result = compareWorkflowManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(d => d.includes('projectRoot')));
  });

  it('trust-class drift is detected even when risk level is unchanged', () => {
    const def = makeDefinition();
    const m1 = buildManifest(def, tmpDir);
    const m2 = buildManifest(def, tmpDir);
    m2.riskAssessment.trustClass = 'pinned_external';
    const result = compareWorkflowManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(d => d.includes('riskAssessment.trustClass')));
  });
});

// ===========================================================================
// 6. Workflow Drift Detection
// ===========================================================================

describe('Workflow Drift Detection', () => {
  const basePath = tmpdir();

  it('adding a step triggers drift', () => {
    const def1 = makeDefinition();
    const def2 = makeDefinition({
      steps: [
        ...makeDefinition().steps,
        {
          id: 'step_b',
          type: 'task',
          run: { command: 'echo', args: ['extra'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        }
      ],
    });
    const m1 = buildManifest(def1, basePath);
    const m2 = buildManifest(def2, basePath);
    const result = compareWorkflowManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(d => d.includes('+ Add step')));
  });

  it('removing a step triggers drift', () => {
    const def1 = makeDefinition({
      entryStep: 'step_a',
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['a'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'step_b', validation_failed: 'abort' }
        },
        {
          id: 'step_b',
          type: 'task',
          run: { command: 'echo', args: ['b'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const def2 = makeDefinition({
      entryStep: 'step_a',
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['a'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const m1 = buildManifest(def1, basePath);
    const m2 = buildManifest(def2, basePath);
    const result = compareWorkflowManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(d => d.includes('- Remove step')));
  });

  it('changing step command triggers drift', () => {
    const def1 = makeDefinition();
    const def2 = makeDefinition();
    def2.steps[0].run.command = 'cat';
    const m1 = buildManifest(def1, basePath);
    const m2 = buildManifest(def2, basePath);
    const result = compareWorkflowManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(d => d.includes('command')));
  });

  it('changing transition target triggers drift', () => {
    const def1 = makeDefinition({
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['hello'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'step_b', validation_failed: 'abort' }
        },
        {
          id: 'step_b',
          type: 'task',
          run: { command: 'echo', args: ['world'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const def2 = makeDefinition({
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['hello'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
        {
          id: 'step_b',
          type: 'task',
          run: { command: 'echo', args: ['world'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const m1 = buildManifest(def1, basePath);
    const m2 = buildManifest(def2, basePath);
    const result = compareWorkflowManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(d => d.includes('Transition')));
  });

  it('changing entryStep triggers drift', () => {
    const def1 = makeDefinition({
      entryStep: 'step_a',
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['a'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'step_b', validation_failed: 'abort' }
        },
        {
          id: 'step_b',
          type: 'task',
          run: { command: 'echo', args: ['b'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const def2 = makeDefinition({
      entryStep: 'step_b',
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['a'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'step_b', validation_failed: 'abort' }
        },
        {
          id: 'step_b',
          type: 'task',
          run: { command: 'echo', args: ['b'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const m1 = buildManifest(def1, basePath);
    const m2 = buildManifest(def2, basePath);
    const result = compareWorkflowManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(d => d.includes('entryStep')));
  });

  it('changing maxIterations triggers drift', () => {
    const def1 = makeDefinition({ maxIterations: 5 });
    const def2 = makeDefinition({ maxIterations: 20 });
    const m1 = buildManifest(def1, basePath);
    const m2 = buildManifest(def2, basePath);
    const result = compareWorkflowManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(d => d.includes('maxIterations')));
  });

  it('unchanged workflow does NOT trigger drift', () => {
    const def = makeDefinition();
    const m1 = buildManifest(def, basePath);
    const m2 = buildManifest(def, basePath);
    const result = compareWorkflowManifests(m1, m2);
    assert.equal(result.matches, true);
    assert.equal(result.diffs.length, 0);
  });
});

// ===========================================================================
// 7. Workflow Risk Aggregation
// ===========================================================================

describe('Workflow Risk Aggregation', () => {
  const basePath = tmpdir();

  it('simple task workflow with reviewed_internal is green', () => {
    const def = makeDefinition();
    const normalized = normalizeWorkflowDefinition(def, basePath);
    const risk = evaluateWorkflowRisk(normalized, { trustClass: 'reviewed_internal', projectRoot: basePath });
    assert.equal(risk.riskLevel, 'green');
    assert.equal(risk.trustClass, 'reviewed_internal');
  });

  it('workflow with services is at least yellow', () => {
    const def = makeDefinitionWithServices();
    const normalized = normalizeWorkflowDefinition(def, basePath);
    const risk = evaluateWorkflowRisk(normalized, { trustClass: 'reviewed_internal', projectRoot: basePath });
    assert.ok(
      risk.riskLevel === 'yellow' || risk.riskLevel === 'red',
      `Expected at least yellow, got ${risk.riskLevel}`
    );
  });

  it('workflow with service_restart is at least yellow with reason', () => {
    const def = makeDefinitionWithServices();
    const normalized = normalizeWorkflowDefinition(def, basePath);
    const risk = evaluateWorkflowRisk(normalized, { trustClass: 'reviewed_internal', projectRoot: basePath });
    assert.ok(
      risk.riskLevel === 'yellow' || risk.riskLevel === 'red',
      `Expected at least yellow, got ${risk.riskLevel}`
    );
    assert.ok(risk.reasons.includes('service restart capability'));
  });

  it('workflow with generated trust is red', () => {
    const def = makeDefinition();
    const normalized = normalizeWorkflowDefinition(def, basePath);
    const risk = evaluateWorkflowRisk(normalized, { trustClass: 'generated', projectRoot: basePath });
    assert.equal(risk.riskLevel, 'red');
    assert.equal(risk.requiresStrongConfirmation, true);
  });

  it('workflow with unknown trust is red', () => {
    const def = makeDefinition();
    const normalized = normalizeWorkflowDefinition(def, basePath);
    const risk = evaluateWorkflowRisk(normalized, { trustClass: 'unknown', projectRoot: basePath });
    assert.equal(risk.riskLevel, 'red');
  });

  it('single-step workflow does not include "multi-step workflow" reason', () => {
    const def = makeDefinition();
    const normalized = normalizeWorkflowDefinition(def, basePath);
    const risk = evaluateWorkflowRisk(normalized, { trustClass: 'reviewed_internal', projectRoot: basePath });
    assert.ok(!risk.reasons.includes('multi-step workflow'));
  });

  it('multi-step workflow includes "multi-step workflow" reason', () => {
    const def = makeDefinitionWithServices();
    const normalized = normalizeWorkflowDefinition(def, basePath);
    const risk = evaluateWorkflowRisk(normalized, { trustClass: 'reviewed_internal', projectRoot: basePath });
    assert.ok(risk.reasons.includes('multi-step workflow'));
  });

  it('risk includes "service lifecycle capability" when services present', () => {
    const def = makeDefinitionWithServices();
    const normalized = normalizeWorkflowDefinition(def, basePath);
    const risk = evaluateWorkflowRisk(normalized, { trustClass: 'reviewed_internal', projectRoot: basePath });
    assert.ok(risk.reasons.includes('service lifecycle capability'));
  });

  it('workflow step with explicit secret inject is flagged', () => {
    const def = makeDefinition({
      steps: [{
        id: 'step_a', type: 'task',
        run: {
          command: 'node', args: ['deploy.js'], cwd: '.',
          envPolicy: { inherit: false, allow: ['PATH'], inject: { AWS_SECRET_ACCESS_KEY: 'xxx' } },
        },
        on: { success: 'done', validation_failed: 'abort' },
      }],
    });
    const normalized = normalizeWorkflowDefinition(def, basePath);
    const risk = evaluateWorkflowRisk(normalized, { trustClass: 'reviewed_internal', projectRoot: basePath });
    assert.ok(risk.reasons.includes('secret injection enabled'));
  });

  it('workflow step with default envPolicy (inherit=true, no inject) does not flag env risk', () => {
    const def = makeDefinition();
    const normalized = normalizeWorkflowDefinition(def, basePath);
    const risk = evaluateWorkflowRisk(normalized, { trustClass: 'reviewed_internal', projectRoot: basePath });
    assert.ok(!risk.reasons.includes('secret injection enabled'));
    assert.ok(!risk.reasons.includes('environment variable inheritance enabled'));
  });

  it('workflow with community recipe_ref includes recipe reference risk reasons', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-recipe-risk-'));
    try {
      mkdirSync(join(dir, 'recipes'), { recursive: true });
      writeRecipeFile(join(dir, 'recipes'), {
        id: 'community-step',
        name: 'Community Step',
        description: 'Community recipe',
        version: '1.0.0',
        author: 'tester',
        category: 'custom',
        channel: 'community',
        approval_required: true,
        risk_level: 'medium',
        inputs: {},
        steps: [{
          id: 'main',
          description: 'echo',
          run: { command: 'echo', args: ['hello'], mode: 'structured' },
        }],
        guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
      });
      const def = makeDefinition({
        steps: [{
          id: 'step_a',
          type: 'recipe_ref',
          recipe: 'community-step',
          inputs: {},
          on: { success: 'done', failure: 'abort' },
        }],
      });

      const normalized = normalizeWorkflowDefinition(def, dir);
      const risk = evaluateWorkflowRisk(normalized, { trustClass: 'reviewed_internal', projectRoot: dir });
      assert.ok(risk.riskLevel === 'yellow' || risk.riskLevel === 'red');
      assert.ok(risk.reasons.some((reason) => reason.includes('community recipe reference')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 8. TERMINAL_STATES
// ===========================================================================

describe('TERMINAL_STATES', () => {
  it('contains done and abort', () => {
    assert.ok(TERMINAL_STATES.has('done'));
    assert.ok(TERMINAL_STATES.has('abort'));
    assert.equal(TERMINAL_STATES.size, 2);
  });
});

// ===========================================================================
// 9. Workflow Diff Output
// ===========================================================================

describe('Workflow Diff Output', () => {
  const basePath = tmpdir();

  it('step addition shows "+ Add step: ..."', () => {
    const def1 = makeDefinition();
    const def2 = makeDefinition({
      steps: [
        ...makeDefinition().steps,
        {
          id: 'step_new',
          type: 'task',
          run: { command: 'echo', args: ['new'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        }
      ],
    });
    const m1 = buildManifest(def1, basePath);
    const m2 = buildManifest(def2, basePath);
    const diffs = diffWorkflowManifests(m2, m1);
    assert.ok(diffs.some(d => d.startsWith('+ Add step: step_new')));
  });

  it('step removal shows "- Remove step: ..."', () => {
    const def1 = makeDefinition({
      entryStep: 'step_a',
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['a'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'step_b', validation_failed: 'abort' }
        },
        {
          id: 'step_b',
          type: 'task',
          run: { command: 'echo', args: ['b'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const def2 = makeDefinition({
      entryStep: 'step_a',
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['a'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const m1 = buildManifest(def1, basePath);
    const m2 = buildManifest(def2, basePath);
    const diffs = diffWorkflowManifests(m2, m1);
    assert.ok(diffs.some(d => d.startsWith('- Remove step: step_b')));
  });

  it('transition change shows "~ ..." format', () => {
    const def1 = makeDefinition({
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['a'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'step_b', validation_failed: 'abort' }
        },
        {
          id: 'step_b',
          type: 'task',
          run: { command: 'echo', args: ['b'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const def2 = makeDefinition({
      steps: [
        {
          id: 'step_a',
          type: 'task',
          run: { command: 'echo', args: ['a'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
        {
          id: 'step_b',
          type: 'task',
          run: { command: 'echo', args: ['b'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const m1 = buildManifest(def1, basePath);
    const m2 = buildManifest(def2, basePath);
    const diffs = diffWorkflowManifests(m2, m1);
    assert.ok(diffs.some(d => d.startsWith('~ Transition step_a.success')));
  });

  it('recipe_ref trust boundary drift emits explicit signature/channel/verified diffs', () => {
    const basePath = mkdtempSync(join(tmpdir(), 'wf-boundary-diff-'));
    try {
      mkdirSync(join(basePath, 'recipes'), { recursive: true });
      const recipe = {
        id: 'recipe-boundary-drift',
        name: 'Boundary Drift Recipe',
        description: 'Recipe used for boundary diff coverage',
        version: '1.0.0',
        author: 'test',
        category: 'custom',
        channel: 'verified',
        approval_required: true,
        risk_level: 'low',
        inputs: {},
        steps: [{
          id: 'main',
          description: 'echo boundary',
          run: { command: 'echo', args: ['ok'], mode: 'structured' },
        }],
        guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
      };
      recipe.signature = signRecipe(recipe);
      writeRecipeFile(join(basePath, 'recipes'), recipe);

      const def = {
        version: 1,
        kind: 'workflow_definition',
        name: 'boundary-workflow',
        projectRoot: '.',
        entryStep: 'step_a',
        maxIterations: 5,
        services: [],
        steps: [{
          id: 'step_a',
          type: 'recipe_ref',
          recipe: 'recipe-boundary-drift',
          inputs: {},
          on: { success: 'done', failure: 'abort' },
        }],
      };

      const approved = buildManifest(def, basePath);
      const changed = JSON.parse(JSON.stringify(approved));
      const changedStep = changed.workflow.steps.find((step) => step.id === 'step_a');
      changedStep.recipeRef.signature = 'tampered-signature';
      changedStep.recipeRef.channel = 'community';
      if (changedStep.recipeRef.trust) {
        changedStep.recipeRef.trust.channel = 'community';
        changedStep.recipeRef.trust.verified = false;
      }
      const diffs = diffWorkflowManifests(changed, approved);

      assert.ok(diffs.some(d => d.includes('recipeRef.signature')));
      assert.ok(diffs.some(d => d.includes('recipeRef.channel')));
      assert.ok(diffs.some(d => d.includes('recipeRef.trust.channel')));
      assert.ok(diffs.some(d => d.includes('recipeRef.trust.verified')));
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  it('step command change shows "~ ..." format', () => {
    const def1 = makeDefinition();
    const def2 = makeDefinition();
    def2.steps[0].run.command = 'cat';
    const m1 = buildManifest(def1, basePath);
    const m2 = buildManifest(def2, basePath);
    const diffs = diffWorkflowManifests(m2, m1);
    assert.ok(diffs.some(d => d.startsWith('~ Step step_a command:')));
  });

  it('entryStep change appears in diff', () => {
    const def1 = makeDefinition({
      entryStep: 'step_a',
      steps: [
        {
          id: 'step_a', type: 'task',
          run: { command: 'echo', args: ['a'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code', updateSource: 'none',
          on: { success: 'step_b', validation_failed: 'abort' }
        },
        {
          id: 'step_b', type: 'task',
          run: { command: 'echo', args: ['b'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code', updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const def2 = makeDefinition({
      entryStep: 'step_b',
      steps: [
        {
          id: 'step_a', type: 'task',
          run: { command: 'echo', args: ['a'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code', updateSource: 'none',
          on: { success: 'step_b', validation_failed: 'abort' }
        },
        {
          id: 'step_b', type: 'task',
          run: { command: 'echo', args: ['b'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code', updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
      ],
    });
    const m1 = buildManifest(def1, basePath);
    const m2 = buildManifest(def2, basePath);
    const diffs = diffWorkflowManifests(m2, m1);
    assert.ok(diffs.some(d => d.includes('entryStep')));
  });
});

// ===========================================================================
// 10. Workflow Manifest Schema
// ===========================================================================

describe('Workflow Manifest Schema', () => {
  const basePath = tmpdir();

  it('manifest has version 2, kind "workflow", workflowHash field', () => {
    const def = makeDefinition();
    const manifest = buildManifest(def, basePath);
    assert.equal(manifest.version, 2);
    assert.equal(manifest.kind, 'workflow');
    assert.ok(typeof manifest.workflowHash === 'string');
    assert.match(manifest.workflowHash, /^[a-f0-9]{64}$/);
  });

  it('manifest contains riskAssessment block', () => {
    const def = makeDefinition();
    const manifest = buildManifest(def, basePath);
    assert.ok(manifest.riskAssessment);
    assert.ok(typeof manifest.riskAssessment.trustClass === 'string');
    assert.ok(typeof manifest.riskAssessment.riskLevel === 'string');
    assert.ok(Array.isArray(manifest.riskAssessment.reasons));
  });

  it('manifest contains workflow block with steps and services', () => {
    const def = makeDefinitionWithServices();
    const manifest = buildManifest(def, basePath);
    assert.ok(manifest.workflow);
    assert.ok(Array.isArray(manifest.workflow.steps));
    assert.ok(Array.isArray(manifest.workflow.services));
    assert.ok(manifest.workflow.steps.length > 0);
    assert.ok(manifest.workflow.services.length > 0);
  });

  it('command manifests (version 1) are not confused with workflow manifests', () => {
    const def = makeDefinition();
    const wfManifest = buildManifest(def, basePath);
    assert.equal(wfManifest.version, 2);

    // A command-level manifest would have version 1 and no workflowHash
    const commandManifest = { version: 1, tool: 'guardrail', contractHash: 'abc123' };
    assert.notEqual(commandManifest.version, wfManifest.version);
    assert.equal(commandManifest.workflowHash, undefined);
    assert.ok(wfManifest.workflowHash);
  });
});

// ===========================================================================
// 11. Normalization
// ===========================================================================

describe('Workflow Normalization', () => {
  const basePath = tmpdir();

  it('applies default validator and updateSource', () => {
    const def = makeDefinition();
    delete def.steps[0].validator;
    delete def.steps[0].updateSource;
    const normalized = normalizeWorkflowDefinition(def, basePath);
    assert.equal(normalized.steps[0].validator, 'exit_code');
    assert.equal(normalized.steps[0].updateSource, 'none');
  });

  it('applies default mode and timeoutMs for run blocks', () => {
    const def = makeDefinition();
    delete def.steps[0].run.mode;
    delete def.steps[0].run.timeoutMs;
    const normalized = normalizeWorkflowDefinition(def, basePath);
    assert.equal(normalized.steps[0].run.mode, 'structured');
    assert.equal(normalized.steps[0].run.timeoutMs, 60000);
  });

  it('sorts steps by ID for stable hashing', () => {
    const def = makeDefinition({
      entryStep: 'step_a',
      steps: [
        {
          id: 'step_c', type: 'task',
          run: { command: 'echo', args: ['c'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code', updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort' }
        },
        {
          id: 'step_a', type: 'task',
          run: { command: 'echo', args: ['a'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code', updateSource: 'none',
          on: { success: 'step_c', validation_failed: 'abort' }
        },
      ],
    });
    const normalized = normalizeWorkflowDefinition(def, basePath);
    assert.equal(normalized.steps[0].id, 'step_a');
    assert.equal(normalized.steps[1].id, 'step_c');
  });

  it('sorts services by ID for stable hashing', () => {
    const def = makeDefinitionWithServices();
    def.services.unshift({
      id: 'aaa_service',
      start: { command: 'node', args: ['aaa.js'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
      stop: { signal: 'SIGTERM', killAfterMs: 5000 }
    });
    // Add the step referencing the new service so validation passes when building manifest
    def.steps.push({
      id: 'start_aaa',
      type: 'service_start',
      serviceId: 'aaa_service',
      on: { success: 'done', failure: 'abort' }
    });
    const normalized = normalizeWorkflowDefinition(def, basePath);
    assert.equal(normalized.services[0].id, 'aaa_service');
    assert.equal(normalized.services[1].id, 'api');
  });

  it('normalizes recipe_ref steps into pinned recipe metadata and hashed input files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-recipe-ref-'));
    try {
      mkdirSync(join(dir, 'recipes'), { recursive: true });
      writeFileSync(join(dir, 'prompt.txt'), 'Review this file\n', 'utf8');
      writeRecipeFile(join(dir, 'recipes'), {
        id: 'recipe-step',
        name: 'Recipe Step',
        description: 'A workflow-invoked recipe',
        version: '1.0.0',
        author: 'tester',
        category: 'custom',
        channel: 'community',
        approval_required: true,
        risk_level: 'medium',
        inputs: {
          prompt_file: {
            type: 'string',
            approval_mode: 'path_policy',
            content_hash: true,
            rules: { must_be_relative: true, deny_segments: ['..'], max_depth: 8 },
          },
        },
        steps: [{
          id: 'main',
          description: 'echo file path',
          run: { command: 'echo', args: ['{{inputs.prompt_file}}'], mode: 'structured' },
        }],
        guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
      });

      const def = makeDefinition({
        steps: [{
          id: 'step_a',
          type: 'recipe_ref',
          recipe: 'recipe-step',
          inputs: { prompt_file: 'prompt.txt' },
          on: { success: 'done', failure: 'abort' },
        }],
      });

      const normalized = normalizeWorkflowDefinition(def, dir);
      const step = normalized.steps[0];
      assert.equal(step.type, 'recipe_ref');
      assert.equal(step.recipeRef.id, 'recipe-step');
      assert.equal(step.recipeRef.resolvedVersion, '1.0.0');
      assert.equal(step.recipeRef.resolvedInputs.prompt_file, 'prompt.txt');
      assert.equal(step.recipeRef.inputContentHashes.prompt_file.path, 'prompt.txt');
      assert.equal(step.recipeRef.channel, 'community');
      assert.equal(step.recipeRef.signature, null);
      assert.equal(step.recipeRef.trust.channel, 'community');
      assert.equal(step.recipeRef.trust.verified, false);
      assert.equal(step.recipeRef.allowUnverified, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes recipe_ref steps from explicit workflow recipe search dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-recipe-search-'));
    const workflowDir = join(dir, 'project');
    const externalRecipesDir = join(dir, 'guardian-recipes');

    try {
      mkdirSync(workflowDir, { recursive: true });
      mkdirSync(externalRecipesDir, { recursive: true });
      writeRecipeFile(externalRecipesDir, {
        id: 'external-recipe',
        name: 'External Recipe',
        description: 'Resolved from explicit search dir',
        version: '1.0.0',
        author: 'tester',
        category: 'custom',
        channel: 'community',
        approval_required: true,
        risk_level: 'low',
        inputs: {},
        steps: [{
          id: 'main',
          description: 'echo external',
          run: { command: 'echo', args: ['external'], mode: 'structured' },
        }],
        guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
      });

      const normalized = normalizeWorkflowDefinition(makeDefinition({
        steps: [{
          id: 'step_a',
          type: 'recipe_ref',
          recipe: 'external-recipe',
          inputs: {},
          on: { success: 'done', failure: 'abort' },
        }],
      }), workflowDir, {
        recipeSearchDirs: [externalRecipesDir],
      });

      assert.equal(normalized.steps[0].recipeRef.id, 'external-recipe');
      assert.equal(
        normalized.steps[0].recipeRef.sourcePath,
        join(externalRecipesDir, 'external-recipe.recipe.json'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes verified recipe_ref trust metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-recipe-verified-'));
    try {
      mkdirSync(join(dir, 'recipes'), { recursive: true });
      const recipe = {
        id: 'verified-step',
        name: 'Verified Step',
        description: 'A signed recipe step',
        version: '1.0.0',
        author: 'tester',
        category: 'custom',
        channel: 'verified',
        approval_required: true,
        risk_level: 'medium',
        inputs: {},
        steps: [{
          id: 'main',
          description: 'echo',
          run: { command: 'echo', args: ['hello'], mode: 'structured' },
        }],
        guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
      };
      recipe.signature = signRecipe(recipe);

      writeRecipeFile(join(dir, 'recipes'), recipe);
      const def = makeDefinition({
        steps: [{
          id: 'step_a',
          type: 'recipe_ref',
          recipe: 'verified-step',
          inputs: {},
          on: { success: 'done', failure: 'abort' },
        }],
      });
      const normalized = normalizeWorkflowDefinition(def, dir);
      const step = normalized.steps[0];

      assert.equal(step.recipeRef.channel, 'verified');
      assert.equal(step.recipeRef.signature, recipe.signature);
      assert.equal(step.recipeRef.trust.channel, 'verified');
      assert.equal(step.recipeRef.trust.verified, true);
      assert.equal(step.recipeRef.allowUnverified, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists output declarations and state-reference metadata in normalized workflow + hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-state-ref-normalize-'));
    try {
      mkdirSync(join(dir, 'recipes'), { recursive: true });
      writeRecipeFile(join(dir, 'recipes'), {
        id: 'state-source',
        name: 'State Source',
        description: 'Recipe that accepts task state',
        version: '1.0.0',
        author: 'tester',
        category: 'custom',
        channel: 'verified',
        approval_required: true,
        risk_level: 'low',
        inputs: {
          from_task: {
            type: 'string',
            pattern: '.*',
            required: false,
          },
        },
        steps: [{
          id: 'main',
          description: 'echo task state',
          run: { command: 'echo', args: ['{{inputs.from_task}}'], mode: 'structured' },
        }],
        guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
      });
      const def = makeDefinition({
        entryStep: 'producer',
        steps: [
          {
            id: 'producer',
            type: 'task',
            run: { command: 'echo', args: ['ready'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
            outputs: {
              exitValue: { type: 'number', from: 'exitCode' },
            },
            on: { success: 'consumer', validation_failed: 'abort' },
          },
          {
            id: 'consumer',
            type: 'recipe_ref',
            recipe: 'state-source',
            outputs: {
              statusValue: { type: 'string', from: 'status' },
            },
            inputs: { from_task: '{{state.producer.exitValue}}' },
            on: { success: 'done', failure: 'abort' },
          },
        ],
      });

      const normalized = normalizeWorkflowDefinition(def, dir);
      const normalizedById = new Map(normalized.steps.map((step) => [step.id, step]));
      assert.deepEqual(normalizedById.get('producer')?.outputs, {
        exitValue: { type: 'number', from: 'exitCode' },
      });
      assert.deepEqual(normalizedById.get('consumer')?.recipeRef.templateInputs, { from_task: '{{state.producer.exitValue}}' });

      const baseHash = hashWorkflow(normalized);

      const modified = JSON.parse(JSON.stringify(def));
      modified.steps[1].inputs.from_task = 'static-value';
      const modifiedNorm = normalizeWorkflowDefinition(modified, dir);
      const changedHash = hashWorkflow(modifiedNorm);
      const baseManifest = buildManifest(def, dir);
      const changedManifest = buildManifest(modified, dir);
      const drift = compareWorkflowManifests(changedManifest, baseManifest);

      assert.notEqual(baseHash, changedHash);
      assert.equal(drift.matches, false);
      assert.ok(drift.diffs.some((diff) => diff.includes('templateInputs') || diff.includes('recipeRef:')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 12. STATUS_EXIT_CODES sanity check
// ===========================================================================

describe('STATUS_EXIT_CODES', () => {
  it('success maps to 0', () => {
    assert.equal(STATUS_EXIT_CODES.success, 0);
  });

  it('drift_detected has a nonzero code', () => {
    assert.ok(STATUS_EXIT_CODES.drift_detected > 0);
  });

  it('all codes are numbers', () => {
    for (const [key, code] of Object.entries(STATUS_EXIT_CODES)) {
      assert.equal(typeof code, 'number', `${key} should be a number`);
    }
  });
});

// ===========================================================================
// 13. Workflow Non-Interactive Approval Reuse
// ===========================================================================

describe('Workflow Non-Interactive Approval Reuse', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wf-nonint-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('requires acknowledged risk assessment before non-interactive reuse', async () => {
    const def = makeDefinition();
    const defPath = writeDefFile(tmpDir, def, 'workflow.json');
    const manifest = buildManifest(def, tmpDir);
    const manifestPath = join(tmpDir, 'approved.workflow.json');

    // Simulate a matching manifest created out of band without interactive
    // acknowledgement metadata.
    manifest.riskAssessment.acknowledgedBy = null;
    manifest.riskAssessment.acknowledgedAt = null;
    saveManifest(manifest, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'approval_required');
    assert.equal(result.exitCode, STATUS_EXIT_CODES.approval_required);
  });

  it('requires reapproval for workflow recipe_ref review_each_time inputs even when manifest matches', async () => {
    mkdirSync(join(tmpDir, 'recipes'), { recursive: true });
    writeRecipeFile(join(tmpDir, 'recipes'), {
      id: 'recipe-review-each-time',
      name: 'Recipe Review Each Time',
      description: 'workflow recipe_ref review_each_time repro',
      version: '1.0.0',
      author: 'tester',
      category: 'custom',
      channel: 'community',
      approval_required: true,
      risk_level: 'low',
      inputs: {
        system_prompt: {
          type: 'string',
          approval_mode: 'review_each_time',
          required: false,
        },
      },
      steps: [{
        id: 'main',
        description: 'echo prompt',
        run: { command: 'echo', args: ['{{inputs.system_prompt}}'], mode: 'structured' },
      }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    });

    const def = makeDefinition({
      entryStep: 'step_a',
      steps: [{
        id: 'step_a',
        type: 'recipe_ref',
        recipe: 'recipe-review-each-time',
        inputs: { system_prompt: 'Follow this instruction exactly' },
        on: { success: 'done', failure: 'abort' },
      }],
    });

    const defPath = writeDefFile(tmpDir, def, 'workflow-review-each-time.json');
    const manifest = buildManifest(def, tmpDir);
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    const manifestPath = join(tmpDir, 'approved.workflow.review-each-time.json');
    saveManifest(manifest, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'approval_required');
    assert.equal(result.exitCode, STATUS_EXIT_CODES.approval_required);
    assert.match(result.terminalReason, /review_each_time/);
  });

  it('executes chained recipe_ref steps under one approved workflow manifest', async () => {
    mkdirSync(join(tmpDir, 'recipes'), { recursive: true });
    const recipeOne = {
      id: 'recipe-one',
      name: 'Recipe One',
      description: 'First recipe',
      version: '1.0.0',
      author: 'tester',
      category: 'custom',
      channel: 'verified',
      approval_required: true,
      risk_level: 'low',
      inputs: {},
      steps: [{
        id: 'main',
        description: 'echo one',
        run: { command: 'echo', args: ['one'], mode: 'structured' },
      }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    };
    recipeOne.signature = signRecipe(recipeOne);
    writeRecipeFile(join(tmpDir, 'recipes'), recipeOne);
    const recipeTwo = {
      id: 'recipe-two',
      name: 'Recipe Two',
      description: 'Second recipe',
      version: '1.0.0',
      author: 'tester',
      category: 'custom',
      channel: 'verified',
      approval_required: true,
      risk_level: 'low',
      inputs: {},
      steps: [{
        id: 'main',
        description: 'echo two',
        run: { command: 'echo', args: ['two'], mode: 'structured' },
      }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    };
    recipeTwo.signature = signRecipe(recipeTwo);
    writeRecipeFile(join(tmpDir, 'recipes'), recipeTwo);

    const def = makeDefinition({
      entryStep: 'step_a',
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
    });
    const defPath = writeDefFile(tmpDir, def, 'workflow-recipes.json');
    const manifest = buildManifest(def, tmpDir);
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    const manifestPath = join(tmpDir, 'approved.workflow.recipes.json');
    saveManifest(manifest, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'success');
    assert.equal(result.stepsExecuted, 2);
  });

  it('preserves recipe_ref failure detail in the final workflow result', async () => {
    mkdirSync(join(tmpDir, 'recipes'), { recursive: true });
    const failingRecipe = {
      id: 'recipe-fail-detail',
      name: 'Recipe Fail Detail',
      description: 'fails with actionable detail',
      version: '1.0.0',
      author: 'tester',
      category: 'custom',
      channel: 'verified',
      approval_required: true,
      risk_level: 'low',
      inputs: {},
      steps: [{
        id: 'invoke',
        description: 'emit failure detail',
        run: {
          command: 'node',
          args: ['-e', 'process.stderr.write("Not logged in\\\\nPlease run /login\\\\n"); process.exit(1)'],
          mode: 'structured',
          timeoutMs: 5000,
        },
      }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    };
    failingRecipe.signature = signRecipe(failingRecipe);
    writeRecipeFile(join(tmpDir, 'recipes'), failingRecipe);

    const def = makeDefinition({
      entryStep: 'step_a',
      rollback_policy: 'none',
      rollback_none_reason: 'single idempotent recipe step for failure detail coverage',
      steps: [
        {
          id: 'step_a',
          type: 'recipe_ref',
          recipe: 'recipe-fail-detail',
          idempotent: true,
          inputs: {},
          on: { success: 'done', failure: 'abort' },
        },
      ],
    });
    const defPath = writeDefFile(tmpDir, def, 'workflow-recipe-failure-detail.json');
    const manifest = buildManifest(def, tmpDir);
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    const manifestPath = join(tmpDir, 'approved.workflow.recipe-failure-detail.json');
    saveManifest(manifest, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'validation_failed');
    assert.equal(result.failedStep, 'step_a');
    assert.match(result.terminalReason, /Not logged in/);
    assert.match(result.terminalReason, /Please run \/login/);
  });

  it('blocks community recipe_ref execution when allow_unverified is not enabled', async () => {
    mkdirSync(join(tmpDir, 'recipes'), { recursive: true });
    writeRecipeFile(join(tmpDir, 'recipes'), {
      id: 'recipe-blocked',
      name: 'Blocked Recipe',
      description: 'community recipe',
      version: '1.0.0',
      author: 'tester',
      category: 'custom',
      channel: 'community',
      approval_required: true,
      risk_level: 'low',
      inputs: {},
      steps: [{
        id: 'main',
        description: 'echo blocked',
        run: { command: 'echo', args: ['blocked'], mode: 'structured' },
      }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    });

    const def = makeDefinition({
      entryStep: 'step_a',
      steps: [{
        id: 'step_a',
        type: 'recipe_ref',
        recipe: 'recipe-blocked',
        inputs: {},
        on: { success: 'done', failure: 'abort' },
      }],
    });
    const defPath = writeDefFile(tmpDir, def, 'workflow-recipe-blocked.json');
    const manifest = buildManifest(def, tmpDir);
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    const manifestPath = join(tmpDir, 'approved.workflow.recipe-blocked.json');
    saveManifest(manifest, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'validation_failed');
    assert.equal(result.failedStep, 'step_a');
    assert.equal(result.stepsExecuted, 1);
    assert.match(result.terminalReason, /Unverified recipe blocked/);
  });

  it('blocks verified-reported recipe when signature is not valid and allow_unverified is not enabled', async () => {
    mkdirSync(join(tmpDir, 'recipes'), { recursive: true });
    writeRecipeFile(join(tmpDir, 'recipes'), {
      id: 'recipe-verification-failure',
      name: 'Verification Failure Recipe',
      description: 'Recipe with invalid verified signature',
      version: '1.0.0',
      author: 'tester',
      category: 'custom',
      channel: 'verified',
      signature: 'not-a-real-signature',
      approval_required: true,
      risk_level: 'low',
      inputs: {},
      steps: [{
        id: 'main',
        description: 'echo would block',
        run: { command: 'echo', args: ['should-not-run'], mode: 'structured' },
      }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    });

    const def = makeDefinition({
      entryStep: 'step_a',
      steps: [{
        id: 'step_a',
        type: 'recipe_ref',
        recipe: 'recipe-verification-failure',
        inputs: {},
        on: { success: 'done', failure: 'abort' },
      }],
    });
    const defPath = writeDefFile(tmpDir, def, 'workflow-recipe-verification-failure.json');
    const manifest = buildManifest(def, tmpDir);
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    const manifestPath = join(tmpDir, 'approved.workflow.recipe-verification-failure.json');
    saveManifest(manifest, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'validation_failed');
    assert.equal(result.failedStep, 'step_a');
    assert.equal(result.stepsExecuted, 1);
    assert.match(result.terminalReason, /Unverified recipe blocked/);
  });

  it('requires reapproval when workflow trust boundary changes from allow_unverified=true to false', async () => {
    mkdirSync(join(tmpDir, 'recipes'), { recursive: true });
    writeRecipeFile(join(tmpDir, 'recipes'), {
      id: 'recipe-boundary',
      name: 'Boundary Recipe',
      description: 'community recipe',
      version: '1.0.0',
      author: 'tester',
      category: 'custom',
      channel: 'community',
      approval_required: true,
      risk_level: 'low',
      inputs: {},
      steps: [{
        id: 'main',
        description: 'echo boundary',
        run: { command: 'echo', args: ['boundary'], mode: 'structured' },
      }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    });

    const def = makeDefinition({
      entryStep: 'step_a',
      steps: [{
        id: 'step_a',
        type: 'recipe_ref',
        recipe: 'recipe-boundary',
        inputs: {},
        on: { success: 'done', failure: 'abort' },
      }],
    });
    const defPath = writeDefFile(tmpDir, def, 'workflow-trust-boundary.json');
    const manifest = buildManifest(def, tmpDir);
    manifest.workflow.steps[0].recipeRef.allowUnverified = true;
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    const manifestPath = join(tmpDir, 'approved.workflow.trust-boundary.json');
    saveManifest(manifest, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'drift_detected');
    assert.equal(result.exitCode, STATUS_EXIT_CODES.drift_detected);
    assert.ok(result.terminalReason);
  });

  it('emits stable workflow progress events for JSON-stream consumption', async () => {
    const def = makeDefinition();
    const defPath = writeDefFile(tmpDir, def, 'workflow-progress.json');
    const manifest = buildManifest(def, tmpDir);
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    const manifestPath = join(tmpDir, 'approved.workflow.progress.json');
    saveManifest(manifest, manifestPath);

    const events = [];
    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
      progressSink: (event) => {
        events.push(event);
      },
    });

    assert.equal(result.status, 'success');
    const eventNames = events.map((event) => event.event);

    assert.ok(eventNames.includes('execution_start'), 'execution_start should be emitted');
    assert.ok(eventNames.includes('step_started'), 'step_started should be emitted');
    assert.ok(eventNames.includes('step_completed'), 'step_completed should be emitted');
    assert.ok(eventNames.includes('execution_end'), 'execution_end should be emitted');

    const stepStarted = events.find((event) => event.event === 'step_started');
    const executionEnd = events.find((event) => event.event === 'execution_end');

    assert.equal(stepStarted.mode, 'workflow');
    assert.equal(stepStarted.runId, result.runId);
    assert.equal(stepStarted.stepType, 'task');
    assert.equal(stepStarted.status, 'running');
    assert.equal(executionEnd.status, 'success');
    assert.equal(executionEnd.runId, result.runId);
    assert.equal(executionEnd.stepsExecuted, 1);
  });
});

// ===========================================================================
// 14. Workflow Runtime Shared State
// ===========================================================================

describe('Workflow Runtime Shared State', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wf-shared-state-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shares typed task output into recipe_ref input', async () => {
    mkdirSync(join(tmpDir, 'recipes'), { recursive: true });
    const recipe = {
      id: 'shared-state-recipe',
      name: 'Shared State Recipe',
      description: 'Reads typed output from workflow state',
      version: '1.0.0',
      author: 'test',
      category: 'custom',
      channel: 'verified',
      approval_required: true,
      risk_level: 'low',
      inputs: {
        exit_code: { type: 'integer', min: 0, max: 10 },
      },
      steps: [{
        id: 'main',
        description: 'echo resolved exit code',
        run: {
          command: 'echo',
          args: ['{{inputs.exit_code}}'],
          mode: 'structured',
          timeoutMs: 5000,
        },
      }],
      guardrails: { constraints: ['structured'], invariants: ['mode: structured'] },
    };
    recipe.signature = signRecipe(recipe);
    writeRecipeFile(join(tmpDir, 'recipes'), recipe);

    const def = makeDefinition({
      projectRoot: tmpDir,
      entryStep: 'producer',
      steps: [
        {
          id: 'producer',
          type: 'task',
          run: { command: 'node', args: ['-e', 'process.exit(0)'], cwd: tmpDir, mode: 'structured', timeoutMs: 5000 },
          outputs: { exitCodeValue: { type: 'number', from: 'exitCode' } },
          on: { success: 'consumer', validation_failed: 'abort' },
        },
        {
          id: 'consumer',
          type: 'recipe_ref',
          recipe: 'shared-state-recipe',
          inputs: { exit_code: '{{state.producer.exitCodeValue}}' },
          on: { success: 'done', validation_failed: 'abort' },
        },
      ],
    });

    const defPath = writeDefFile(tmpDir, def, 'workflow-shared-success.json');
    const manifestPath = join(tmpDir, '.guardrail', 'workflows', 'shared-success.approved.json');
    mkdirSync(join(tmpDir, '.guardrail', 'workflows'), { recursive: true });
    createAckedManifest(def, tmpDir, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'success');
    assert.equal(result.stepsExecuted, 2);
    assert.equal(result.failedStep, null);
  });

  it('preserves resolved shared-state args across update-request retries', async () => {
    const markerPath = join(tmpDir, 'shared-state-update-marker.txt');
    const scriptPath = join(tmpDir, 'shared-state-update-check.mjs');
    writeFileSync(scriptPath, `
import { existsSync, writeFileSync } from 'node:fs';

const [, scriptPathArg, value, markerPathArg] = process.argv;

if (!existsSync(markerPathArg)) {
  writeFileSync(markerPathArg, 'ready', 'utf8');
  console.log(JSON.stringify({
    type: 'VALIDATION_FAILED_REQUIRE_UPDATE',
    payload: {
      reason: 'rerun after update',
      proposedUpdate: {
        action: 'run_script',
        command: 'node',
        args: [scriptPathArg, value, markerPathArg],
        cwd: process.cwd(),
      },
    },
  }));
  process.exit(0);
}

if (value === '0') {
  console.log(JSON.stringify({ type: 'SUCCESS', payload: { value } }));
  process.exit(0);
}

console.log(JSON.stringify({
  type: 'VALIDATION_FAILED_REQUIRE_UPDATE',
  payload: {
    reason: 'state value was not preserved on retry',
    proposedUpdate: {
      action: 'run_script',
      command: 'node',
      args: [scriptPathArg, value, markerPathArg],
      cwd: process.cwd(),
    },
  },
}));
process.exit(0);
`, 'utf8');

    const def = makeDefinition({
      projectRoot: tmpDir,
      entryStep: 'producer',
      maxIterations: 4,
      steps: [
        {
          id: 'producer',
          type: 'task',
          run: { command: 'node', args: ['-e', 'process.exit(0)'], cwd: tmpDir, mode: 'structured', timeoutMs: 5000 },
          outputs: { exitCodeValue: { type: 'number', from: 'exitCode' } },
          on: { success: 'consumer', validation_failed: 'abort' },
        },
        {
          id: 'consumer',
          type: 'task',
          run: {
            command: 'node',
            args: [scriptPath, '{{state.producer.exitCodeValue}}', markerPath],
            cwd: tmpDir,
            mode: 'structured',
            timeoutMs: 5000,
          },
          validator: 'ndjson',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort', failure: 'abort' },
        },
      ],
    });

    const defPath = writeDefFile(tmpDir, def, 'workflow-shared-update-retry.json');
    const manifestPath = join(tmpDir, '.guardrail', 'workflows', 'shared-update-retry.approved.json');
    mkdirSync(join(tmpDir, '.guardrail', 'workflows'), { recursive: true });
    createAckedManifest(def, tmpDir, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'success');
    assert.equal(result.stepsExecuted, 2);
    assert.equal(result.failedStep, null);
  });

  it('fails when a declared output resolves to an undefined runtime value', async () => {
    const def = makeDefinition({
      projectRoot: tmpDir,
      entryStep: 'producer',
      steps: [
        {
          id: 'producer',
          type: 'task',
          run: { command: 'node', args: ['-e', 'process.exit(0)'], cwd: tmpDir, mode: 'structured', timeoutMs: 5000 },
          outputs: { missingStatus: { type: 'string', from: 'protocolMessages.0.status' } },
          on: { success: 'consumer', validation_failed: 'abort' },
        },
        {
          id: 'consumer',
          type: 'task',
          run: { command: 'echo', args: ['{{state.producer.missingStatus}}'], cwd: tmpDir, mode: 'structured', timeoutMs: 5000 },
          on: { success: 'done', validation_failed: 'abort', failure: 'abort' },
        },
      ],
    });

    const defPath = writeDefFile(tmpDir, def, 'workflow-shared-missing.json');
    const manifestPath = join(tmpDir, '.guardrail', 'workflows', 'shared-missing.approved.json');
    mkdirSync(join(tmpDir, '.guardrail', 'workflows'), { recursive: true });
    createAckedManifest(def, tmpDir, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'validation_failed');
    assert.equal(result.failedStep, 'producer');
    assert.equal(result.stepsExecuted, 1);
    assert.match(result.terminalReason, /missing value/);
  });

  it('fails when output does not match declared runtime type', async () => {
    const def = makeDefinition({
      projectRoot: tmpDir,
      entryStep: 'producer',
      steps: [
        {
          id: 'producer',
          type: 'task',
          run: { command: 'node', args: ['-e', 'process.exit(0)'], cwd: tmpDir, mode: 'structured', timeoutMs: 5000 },
          outputs: { exitValue: { type: 'string', from: 'exitCode' } },
          on: { success: 'consumer', validation_failed: 'abort' },
        },
        {
          id: 'consumer',
          type: 'task',
          run: { command: 'echo', args: ['ok'], cwd: tmpDir, mode: 'structured', timeoutMs: 5000 },
          on: { success: 'done', validation_failed: 'abort', failure: 'abort' },
        },
      ],
    });

    const defPath = writeDefFile(tmpDir, def, 'workflow-shared-type-mismatch.json');
    const manifestPath = join(tmpDir, '.guardrail', 'workflows', 'shared-type-mismatch.approved.json');
    mkdirSync(join(tmpDir, '.guardrail', 'workflows'), { recursive: true });
    createAckedManifest(def, tmpDir, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'validation_failed');
    assert.equal(result.failedStep, 'producer');
    assert.match(result.terminalReason, /type mismatch/);
  });

  it('fails when resolved recipe_ref input violates recipe schema bounds', async () => {
    mkdirSync(join(tmpDir, 'recipes'), { recursive: true });
    const recipe = {
      id: 'schema-mismatch-recipe',
      name: 'Schema Mismatch Recipe',
      description: 'Consumes workflow output in typed recipe input',
      version: '1.0.0',
      author: 'test',
      category: 'custom',
      channel: 'verified',
      approval_required: true,
      risk_level: 'low',
      inputs: {
        exit_code: { type: 'integer', min: 1, max: 10 },
      },
      steps: [{
        id: 'main',
        description: 'echo numeric input',
        run: {
          command: 'echo',
          args: ['{{inputs.exit_code}}'],
          mode: 'structured',
          timeoutMs: 5000,
        },
      }],
      guardrails: { constraints: ['structured'], invariants: ['mode: structured'] },
    };
    recipe.signature = signRecipe(recipe);
    writeRecipeFile(join(tmpDir, 'recipes'), recipe);

    const def = makeDefinition({
      projectRoot: tmpDir,
      entryStep: 'producer',
      steps: [
        {
          id: 'producer',
          type: 'task',
          run: { command: 'node', args: ['-e', 'process.exit(0)'], cwd: tmpDir, mode: 'structured', timeoutMs: 5000 },
          outputs: { exitStatus: { type: 'string', from: 'validationStatus' } },
          on: { success: 'consumer', validation_failed: 'abort' },
        },
        {
          id: 'consumer',
          type: 'recipe_ref',
          recipe: 'schema-mismatch-recipe',
          inputs: { exit_code: '{{state.producer.exitStatus}}' },
          on: { success: 'done', validation_failed: 'abort' },
        },
      ],
    });

    const defPath = writeDefFile(tmpDir, def, 'workflow-shared-recipe-validation.json');
    const manifestPath = join(tmpDir, '.guardrail', 'workflows', 'shared-recipe-validation.approved.json');
    mkdirSync(join(tmpDir, '.guardrail', 'workflows'), { recursive: true });
    createAckedManifest(def, tmpDir, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'validation_failed');
    assert.equal(result.failedStep, 'consumer');
    assert.match(result.terminalReason, /Recipe input validation failed/);
  });
});

// ===========================================================================
// 14. Workflow Lint
// ===========================================================================

describe('Workflow Lint', () => {
  it('errors on failure → done transitions (fatal lint)', () => {
    const def = {
      version: 1, kind: 'workflow_definition', name: 'test', projectRoot: '.',
      entryStep: 'a', maxIterations: 5, services: [],
      rollback_policy: 'none', rollback_none_reason: 'all steps idempotent',
      steps: [{
        id: 'a', type: 'task', idempotent: true,
        run: { command: 'echo', args: ['hi'], cwd: '.' },
        on: { success: 'done', validation_failed: 'done' },
      }],
    };
    const { errors } = lintWorkflowDefinition(def);
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes('validation_failed'));
    assert.ok(errors[0].includes('done'));
    assert.ok(errors[0].includes('abort'));
  });

  it('no errors for failure → abort transitions', () => {
    const def = {
      version: 1, kind: 'workflow_definition', name: 'test', projectRoot: '.',
      entryStep: 'a', maxIterations: 5, services: [],
      rollback_policy: 'none', rollback_none_reason: 'all steps idempotent',
      steps: [{
        id: 'a', type: 'task', idempotent: true,
        run: { command: 'echo', args: ['hi'], cwd: '.' },
        on: { success: 'done', validation_failed: 'abort' },
      }],
    };
    const { errors, warnings } = lintWorkflowDefinition(def);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);
  });

  it('warns on unreachable steps', () => {
    const def = {
      version: 1, kind: 'workflow_definition', name: 'test', projectRoot: '.',
      entryStep: 'a', maxIterations: 5, services: [],
      rollback_policy: 'none', rollback_none_reason: 'all steps idempotent',
      steps: [
        { id: 'a', type: 'task', idempotent: true, run: { command: 'echo', args: ['a'], cwd: '.' },
          on: { success: 'done', validation_failed: 'abort' } },
        { id: 'orphan', type: 'task', idempotent: true, run: { command: 'echo', args: ['orphan'], cwd: '.' },
          on: { success: 'done', validation_failed: 'abort' } },
      ],
    };
    const { warnings } = lintWorkflowDefinition(def);
    assert.ok(warnings.some(w => w.includes('orphan') && w.includes('unreachable')));
  });

  it('no unreachable warning when all steps are reachable', () => {
    const def = {
      version: 1, kind: 'workflow_definition', name: 'test', projectRoot: '.',
      entryStep: 'a', maxIterations: 5, services: [],
      rollback_policy: 'none', rollback_none_reason: 'all steps idempotent',
      steps: [
        { id: 'a', type: 'task', idempotent: true, run: { command: 'echo', args: ['a'], cwd: '.' },
          on: { success: 'b', validation_failed: 'abort' } },
        { id: 'b', type: 'task', idempotent: true, run: { command: 'echo', args: ['b'], cwd: '.' },
          on: { success: 'done', validation_failed: 'abort' } },
      ],
    };
    const { errors, warnings } = lintWorkflowDefinition(def);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);
  });
});

// ===========================================================================
// 15. envPolicy Normalization
// ===========================================================================

describe('envPolicy Normalization', () => {
  it('fills full shape when envPolicy is absent', () => {
    const def = makeDefinition();
    delete def.steps[0].run.envPolicy;
    const norm = normalizeWorkflowDefinition(def, tmpdir());
    const env = norm.steps[0].run.envPolicy;
    assert.deepEqual(Object.keys(env).sort(), ['allow', 'inherit', 'inject']);
    assert.equal(env.inherit, true);
    assert.deepEqual(env.allow, []);
    assert.deepEqual(env.inject, {});
  });

  it('fills missing keys when envPolicy is partial', () => {
    const def = makeDefinition();
    def.steps[0].run.envPolicy = { inherit: true };
    const norm = normalizeWorkflowDefinition(def, tmpdir());
    const env = norm.steps[0].run.envPolicy;
    assert.equal(env.inherit, true);
    assert.deepEqual(env.allow, []);
    assert.deepEqual(env.inject, {});
  });

  it('preserves explicit values', () => {
    const def = makeDefinition();
    def.steps[0].run.envPolicy = { inherit: false, allow: ['PATH', 'HOME'], inject: { FOO: 'bar' } };
    const norm = normalizeWorkflowDefinition(def, tmpdir());
    const env = norm.steps[0].run.envPolicy;
    assert.equal(env.inherit, false);
    assert.deepEqual(env.allow, ['PATH', 'HOME']);
    assert.deepEqual(env.inject, { FOO: 'bar' });
  });

  it('normalizes service start envPolicy too', () => {
    const def = makeDefinitionWithServices();
    def.services[0].start.envPolicy = { inherit: false };
    const norm = normalizeWorkflowDefinition(def, tmpdir());
    const env = norm.services[0].start.envPolicy;
    assert.equal(env.inherit, false);
    assert.deepEqual(env.allow, []);
    assert.deepEqual(env.inject, {});
  });
});
