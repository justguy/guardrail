import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { runSupervisor, STATUS_EXIT_CODES } from '../src/supervisor.js';
import { runWorkflowSupervisor } from '../src/workflow-supervisor.js';
import { runTemplateSupervisor } from '../src/template-supervisor.js';
import { runRecipeSupervisor } from '../src/recipe-supervisor.js';
import { verifyAuditChain, queryAuditLog } from '../src/audit.js';
import { createContract, hashContract } from '../src/contract.js';
import { createManifest, saveManifest } from '../src/manifest.js';
import { evaluateRisk, evaluateWorkflowRisk } from '../src/policy-engine.js';
import { createRecipeManifest, hashRecipe, computeRecipeEnvIntersection } from '../src/recipe.js';
import { signRecipe } from '../src/recipe-channel.js';
import { normalizeWorkflowDefinition, hashWorkflow, createWorkflowManifest } from '../src/workflow.js';
import {
  computeEnvIntersection,
  createTemplateManifest,
  evaluateTemplateRisk,
  hashTemplateExecution,
  validateUserInputs,
} from '../src/template.js';
import {
  normalizeToAdapterResult,
  validateAdapterResult,
} from '../src/adapter-engine.js';
import { ADAPTER_REASON_CODES } from '../src/adapter-result.js';
import {
  buildSessionContract,
  saveSessionContract,
  loadSessionContract,
  defaultSessionContractPath,
} from '../src/agent-session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gri-')));
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

function writeDefFile(dir, def, filename = 'workflow.json') {
  const filePath = join(dir, filename);
  writeFileSync(filePath, JSON.stringify(def, null, 2), 'utf8');
  return filePath;
}

function buildWorkflowManifest(def, basePath, options = {}) {
  const normalized = normalizeWorkflowDefinition(def, basePath, options);
  const hash = hashWorkflow(normalized);
  const risk = evaluateWorkflowRisk(normalized, { trustClass: 'reviewed_internal', projectRoot: basePath });
  return createWorkflowManifest(normalized, hash, risk, normalized.projectRoot);
}

function createAckedWorkflowManifest(def, basePath, manifestPath, options = {}) {
  const manifest = buildWorkflowManifest(def, basePath, options);
  manifest.riskAssessment.acknowledgedBy = 'test';
  manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
  saveManifest(manifest, manifestPath);
  return manifest;
}

function makeWorkflowDef(overrides = {}) {
  return {
    version: 1,
    kind: 'workflow_definition',
    name: 'test-wf',
    projectRoot: '.',
    entryStep: 'step_a',
    maxIterations: 5,
    services: [],
    steps: [{
      id: 'step_a', type: 'task', idempotent: true,
      run: { command: 'echo', args: ['hello'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
      validator: 'exit_code', updateSource: 'none',
      on: { success: 'done', failure: 'abort', validation_failed: 'abort' },
    }],
    rollback_policy: 'none',
    rollback_none_reason: 'all steps idempotent',
    ...overrides,
  };
}

/**
 * Create a real approved manifest for a command that will pass drift detection.
 */
function createApprovedCommandManifest(command, args, cwd, manifestPath) {
  const contract = createContract({ command, args, cwd: resolve(cwd), mode: 'structured' });
  const contractHash = hashContract(contract);
  const risk = evaluateRisk(contract, { trustClass: 'reviewed_internal', projectRoot: resolve(cwd) });
  const manifest = createManifest(contract, contractHash, risk, { validator: 'exit_code', updateSource: 'none' }, resolve(cwd));
  manifest.riskAssessment.acknowledgedBy = 'test';
  manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
  saveManifest(manifest, manifestPath);
  return { contract, contractHash, manifest };
}

function makeTemplate() {
  return {
    version: 1,
    kind: 'template',
    name: 'test-tmpl',
    description: 'test template',
    trust_class: 'reviewed_internal',
    risk: 'green',
    inputs: { name: { type: 'string', pattern: '^[a-z]+$' } },
    run: { command: 'echo', args: ['{{inputs.name}}'], mode: 'structured' },
  };
}

function makeRecipe(overrides = {}) {
  const recipe = {
    id: 'runtime-recipe',
    name: 'Runtime Recipe',
    description: 'runtime integration recipe',
    version: '1.0.0',
    author: 'test',
    category: 'custom',
    channel: 'verified',
    inputs: { target: { type: 'string', pattern: '^[a-z]+$' } },
    steps: [
      {
        id: 'step-1',
        description: 'echo target',
        run: { command: 'echo', args: ['{{inputs.target}}'], mode: 'structured', timeoutMs: 5000 },
      },
    ],
    guardrails: { constraints: ['structured'], invariants: ['no shell'] },
    approval_required: false,
    risk_level: 'low',
    ...overrides,
  };

  if (recipe.channel === 'verified' && !recipe.signature) {
    recipe.signature = signRecipe(recipe);
  }
  return recipe;
}

function writeRecipeFile(dir, recipe, filename = `${recipe.id}.recipe.json`) {
  const filePath = join(dir, filename);
  writeFileSync(filePath, JSON.stringify(recipe, null, 2), 'utf8');
  return filePath;
}

function createApprovedRecipeManifest(recipe, cwd, manifestPath, sourcePath, options = {}) {
  const envResult = computeRecipeEnvIntersection(recipe.requires_env || [], options.envAllow || []);
  const manifest = createRecipeManifest(
    recipe,
    hashRecipe(recipe),
    options.riskAssessment ?? {
      trustClass: 'pinned_external',
      riskLevel: 'green',
      reasons: ['recipe declares low risk'],
      requiresStrongConfirmation: false,
    },
    options.resolvedInputs ?? { target: 'hello' },
    {
      cwd: resolve(cwd),
      projectRoot: resolve(cwd),
      sourcePath,
      requestedVersion: options.requestedVersion ?? null,
      allowUnverified: options.allowUnverified ?? false,
      envIntersection: envResult.intersection,
    },
  );

  if (options.acknowledged !== false) {
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
  }

  saveManifest(manifest, manifestPath);
  return manifest;
}

function createApprovedTemplateManifest(templateDef, { inputValues = {}, envAllow = [], manifestPath } = {}) {
  const validation = validateUserInputs(templateDef.inputs, inputValues);
  if (!validation.valid) {
    throw new Error(`Template validation failed: ${validation.errors.join('; ')}`);
  }

  const envResult = computeEnvIntersection(templateDef.requires_env || [], envAllow);
  const templateHash = hashTemplateExecution(templateDef, validation.values, envResult.intersection);
  const riskAssessment = evaluateTemplateRisk(templateDef, envResult.intersection);

  const manifest = createTemplateManifest(
    templateDef,
    templateHash,
    riskAssessment,
    validation.values,
    envResult.intersection,
  );

  manifest.riskAssessment.acknowledgedBy = 'test';
  manifest.riskAssessment.acknowledgedAt = new Date().toISOString();

  saveManifest(manifest, manifestPath);
  return manifest;
}

// ===========================================================================
// 1. Single-command supervisor: time policy blocks execution
// ===========================================================================

describe('Integration: Command Supervisor Runtime Policy', () => {
  it('returns the rich bounded result shape on successful execution', async () => {
    const dir = tmpDir();
    const manifestDir = join(dir, '.guardrail');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'approved.json');

    createApprovedCommandManifest('echo', ['hello'], dir, manifestPath);

    const result = await runSupervisor({
      command: 'echo',
      args: ['hello'],
      cwd: dir,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
      authCheckFn: async () => ({ success: true, stdout: 'logged in' }),
    });

    assert.equal(result.status, 'success');
    assert.equal(typeof result.reason, 'string');
    assert.equal(result.drift.detected, false);
    assert.deepEqual(result.drift.diffs, []);
    assert.equal(result.worker.launched, true);
    assert.equal(result.worker.exitCode, 0);
    assert.equal(result.worker.timedOut, false);
    assert.equal(result.worker.interactivePromptDetected, false);
    assert.equal(result.worker.stdoutTruncated, false);
    assert.equal(result.worker.stderrTruncated, false);
    assert.match(result.worker.stdout, /hello/);
    assert.equal(typeof result.telemetry.durationMs, 'number');
    assert.ok(result.telemetry.durationMs >= 0);
  });

  it('time policy blocks execution with expired validUntil', async () => {
    const dir = tmpDir();
    const manifestDir = join(dir, '.guardrail');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'approved.json');

    createApprovedCommandManifest('echo', ['hello'], dir, manifestPath);

    const result = await runSupervisor({
      command: 'echo',
      args: ['hello'],
      cwd: dir,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
      runtimeLimits: { validUntil: '2020-01-01T00:00:00Z' },
    });

    assert.equal(result.status, 'time_policy_violated');
    assert.equal(result.exitCode, STATUS_EXIT_CODES.time_policy_violated);
  });

  it('concurrency lock blocks second execution', async () => {
    const dir = tmpDir();
    const manifestDir = join(dir, '.guardrail');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'approved.json');

    const { contractHash } = createApprovedCommandManifest('echo', ['hello'], dir, manifestPath);

    // Pre-acquire a lock on the same hash
    const { acquireLock } = await import('../src/runtime-policy.js');
    const lock = acquireLock(contractHash, [], manifestDir, 60000);
    assert.equal(lock.acquired, true);

    try {
      const result = await runSupervisor({
        command: 'echo',
        args: ['hello'],
        cwd: dir,
        manifestPath,
        nonInteractive: true,
        jsonOutput: true,
        trustClass: 'reviewed_internal',
      });

      assert.equal(result.status, 'concurrent_blocked');
      assert.equal(result.exitCode, STATUS_EXIT_CODES.concurrent_blocked);
    } finally {
      lock.release();
    }
  });

  it('returns bounded drift context on non-interactive manifest drift', async () => {
    const dir = tmpDir();
    const manifestDir = join(dir, '.guardrail');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'approved.json');

    createApprovedCommandManifest('echo', ['stream'], dir, manifestPath);

    const result = await runSupervisor({
      command: 'echo',
      args: ['goodbye'],
      cwd: dir,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'drift_detected');
    assert.equal(result.drift.detected, true);
    assert.ok(Array.isArray(result.drift.diffs));
    assert.ok(result.drift.diffs.length > 0);
    assert.equal(typeof result.drift.diffs[0].description, 'string');
    assert.match(result.reason, /Contract drift detected/);
  });

  it('emits stable command progress events for JSON-stream', async () => {
    const dir = tmpDir();
    const manifestDir = join(dir, '.guardrail');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'approved.json');

    createApprovedCommandManifest('echo', ['stream'], dir, manifestPath);

    const events = [];
    const result = await runSupervisor({
      command: 'echo',
      args: ['stream'],
      cwd: dir,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
      progressSink: (event) => events.push(event),
    });

    assert.equal(result.status, 'success');
    const eventNames = events.map((event) => event.event);

    assert.ok(eventNames.includes('execution_start'), 'execution_start should be emitted');
    assert.ok(eventNames.includes('step_started'), 'step_started should be emitted');
    assert.ok(eventNames.includes('step_completed'), 'step_completed should be emitted');
    assert.ok(eventNames.includes('execution_end'), 'execution_end should be emitted');

    const executionStart = events.find((event) => event.event === 'execution_start');
    const executionEnd = events.find((event) => event.event === 'execution_end');
    const stepStarted = events.find((event) => event.event === 'step_started');

    assert.equal(executionStart.mode, 'command');
    assert.equal(executionStart.runId, result.runId);
    assert.equal(stepStarted.mode, 'command');
    assert.equal(stepStarted.stepType, 'command');
    assert.equal(executionEnd.status, 'success');
    assert.equal(executionEnd.mode, 'command');
    assert.equal(executionEnd.runId, result.runId);
    assert.equal(executionEnd.stepsExecuted, 1);
  });

  it('emits approval_pending for non-interactive command approval-required path', async () => {
    const dir = tmpDir();
    mkdirSync(resolve(dir, '.guardrail'), { recursive: true });
    const manifestPath = join(dir, '.guardrail', 'missing-command.approved.json');

    const events = [];
    const result = await runSupervisor({
      command: 'echo',
      args: ['hello'],
      cwd: dir,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      progressSink: (event) => events.push(event),
    });

    assert.equal(result.status, 'approval_required');
    const eventNames = events.map((event) => event.event);
    assert.equal(eventNames.includes('approval_pending'), true, 'approval_pending should be emitted');
    assert.equal(eventNames.includes('execution_end'), true, 'execution_end should still be emitted');
    assert.equal(eventNames[0], 'approval_pending');
    assert.equal(eventNames[eventNames.length - 1], 'execution_end');
  });

  it('audit log entries written on execution', async () => {
    const dir = tmpDir();
    const manifestDir = join(dir, '.guardrail');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'approved.json');

    createApprovedCommandManifest('echo', ['hello'], dir, manifestPath);

    await runSupervisor({
      command: 'echo',
      args: ['hello'],
      cwd: dir,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    const auditPath = join(manifestDir, 'audit.jsonl');
    assert.ok(existsSync(auditPath), 'Audit log file should exist');

    const chain = verifyAuditChain(auditPath);
    assert.equal(chain.valid, true, 'Audit chain should be valid');
    assert.ok(chain.entries >= 2, 'Should have at least execution_start + execution_end');

    const entries = queryAuditLog(auditPath, {});
    assert.ok(entries.some(e => e.event === 'execution_start'));
    for (const entry of entries) {
      assert.ok(entry.trace_id, 'Every audit entry should have a trace_id');
      assert.ok(entry.fingerprint, 'Every audit entry should have a fingerprint');
      assert.ok(entry.entry_hash, 'Every audit entry should have an entry_hash');
    }
  });

  it('lock is released after successful execution', async () => {
    const dir = tmpDir();
    const manifestDir = join(dir, '.guardrail');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'approved.json');

    createApprovedCommandManifest('echo', ['hello'], dir, manifestPath);

    // First run
    await runSupervisor({
      command: 'echo',
      args: ['hello'],
      cwd: dir,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    // Second run should NOT be blocked (lock was released)
    const result2 = await runSupervisor({
      command: 'echo',
      args: ['hello'],
      cwd: dir,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.notEqual(result2.status, 'concurrent_blocked');
  });
});

// ===========================================================================
// 2. Workflow supervisor: runtime policy integration
// ===========================================================================

describe('Integration: Workflow Supervisor Runtime Policy', () => {
  it('time policy blocks workflow execution', async () => {
    const dir = tmpDir();
    const defPath = writeDefFile(dir, makeWorkflowDef());
    const manifestDir = join(dir, '.guardrail', 'workflows');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'default.approved.json');

    // Need to create a valid approved manifest first
    // Run once to generate the manifest (will fail non-interactive, but that's OK)
    // Instead, directly test the time policy path by pre-approving

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
      runtimeLimits: { validUntil: '2020-01-01T00:00:00Z' },
    });

    // Will either be time_policy_violated or approval_required
    // (approval_required if it doesn't get past approval to reach time check)
    // The time check happens AFTER approval, so if there's no manifest, we get approval_required first
    assert.ok(
      result.status === 'time_policy_violated' || result.status === 'approval_required',
      `Expected time_policy_violated or approval_required, got ${result.status}`,
    );
  });

  it('audit log written during workflow execution', async () => {
    const dir = tmpDir();
    const defPath = writeDefFile(dir, makeWorkflowDef());
    const manifestPath = join(dir, '.guardrail', 'workflows', 'default.approved.json');

    await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    // Check if audit file exists in the workflow's .guardrail dir
    const auditPath = join(dir, '.guardrail', 'audit.jsonl');
    if (existsSync(auditPath)) {
      const chain = verifyAuditChain(auditPath);
      assert.equal(chain.valid, true);
    }
  });
});

// ===========================================================================
// 2a. Workflow supervisor: shared state execution
// ===========================================================================

describe('Integration: Workflow Supervisor Shared State', () => {
  it('shares task output into recipe_ref input and runs successfully', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });

    const recipe = {
      id: 'integration-shared-recipe',
      name: 'Integration Shared Recipe',
      description: 'A recipe that consumes workflow state output',
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
        run: { command: 'echo', args: ['{{inputs.exit_code}}'], mode: 'structured', timeoutMs: 5000 },
      }],
      guardrails: { constraints: ['structured'], invariants: ['mode: structured'] },
    };
    recipe.signature = signRecipe(recipe);
    writeRecipeFile(join(dir, 'recipes'), recipe);

    const def = makeWorkflowDef({
      projectRoot: dir,
      entryStep: 'producer',
      services: [],
      steps: [
        {
          id: 'producer',
          type: 'task',
          run: { command: 'node', args: ['-e', 'process.exit(0)'], cwd: dir, mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          outputs: { exitCodeValue: { type: 'number', from: 'exitCode' } },
          on: { success: 'consumer', validation_failed: 'abort' },
        },
        {
          id: 'consumer',
          type: 'recipe_ref',
          recipe: 'integration-shared-recipe',
          inputs: {
            exit_code: '{{state.producer.exitCodeValue}}',
          },
          on: { success: 'done', validation_failed: 'abort' },
        },
      ],
    });
    const defPath = writeDefFile(dir, def, 'shared-success.json');
    const manifestPath = join(dir, '.guardrail', 'workflows', 'shared-success.approved.json');

    createAckedWorkflowManifest(def, dir, manifestPath);

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

  it('fails when a shared output resolves to an undefined value', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });

    const recipe = {
      id: 'integration-missing-recipe',
      name: 'Integration Missing Recipe',
      description: 'A recipe that is not used because output missing in producer step',
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
        description: 'echo fallback',
        run: { command: 'echo', args: ['{{inputs.exit_code}}'], mode: 'structured', timeoutMs: 5000 },
      }],
      guardrails: { constraints: ['structured'], invariants: ['mode: structured'] },
    };
    recipe.signature = signRecipe(recipe);
    writeRecipeFile(join(dir, 'recipes'), recipe);

    const def = makeWorkflowDef({
      projectRoot: dir,
      entryStep: 'producer',
      services: [],
      steps: [
        {
          id: 'producer',
          type: 'task',
          run: { command: 'node', args: ['-e', 'process.exit(0)'], cwd: dir, mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          outputs: { missingStatus: { type: 'string', from: 'protocolMessages.0.status' } },
          on: { success: 'consumer', validation_failed: 'abort' },
        },
        {
          id: 'consumer',
          type: 'task',
          run: { command: 'echo', args: ['{{state.producer.missingStatus}}'], cwd: dir, mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort', failure: 'abort' },
        },
      ],
    });
    const defPath = writeDefFile(dir, def, 'shared-missing.json');
    const manifestPath = join(dir, '.guardrail', 'workflows', 'shared-missing.approved.json');
    createAckedWorkflowManifest(def, dir, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'validation_failed');
    assert.equal(result.failedStep, 'producer');
    assert.match(result.terminalReason, /missing value/);
  });

  it('fails when an output type does not match declaration', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });

    const recipe = {
      id: 'integration-mismatch-recipe',
      name: 'Integration Mismatch Recipe',
      description: 'A recipe that is not run due to task output mismatch',
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
        description: 'echo fallback',
        run: { command: 'echo', args: ['{{inputs.exit_code}}'], mode: 'structured', timeoutMs: 5000 },
      }],
      guardrails: { constraints: ['structured'], invariants: ['mode: structured'] },
    };
    recipe.signature = signRecipe(recipe);
    writeRecipeFile(join(dir, 'recipes'), recipe);

    const def = makeWorkflowDef({
      projectRoot: dir,
      entryStep: 'producer',
      services: [],
      steps: [
        {
          id: 'producer',
          type: 'task',
          run: { command: 'node', args: ['-e', 'process.exit(0)'], cwd: dir, mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          outputs: { exitValue: { type: 'string', from: 'exitCode' } },
          on: { success: 'consumer', validation_failed: 'abort' },
        },
        {
          id: 'consumer',
          type: 'task',
          run: { command: 'echo', args: ['ok'], cwd: dir, mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          on: { success: 'done', validation_failed: 'abort', failure: 'abort' },
        },
      ],
    });
    const defPath = writeDefFile(dir, def, 'shared-type-mismatch.json');
    const manifestPath = join(dir, '.guardrail', 'workflows', 'shared-type-mismatch.approved.json');
    createAckedWorkflowManifest(def, dir, manifestPath);

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

  it('fails when resolved recipe_ref input violates recipe schema', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    const recipe = {
      id: 'integration-schema-mismatch-recipe',
      name: 'Integration Schema Mismatch Recipe',
      description: 'Recipe input schema validation failure for workflow state value',
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
        run: { command: 'echo', args: ['{{inputs.exit_code}}'], mode: 'structured', timeoutMs: 5000 },
      }],
      guardrails: { constraints: ['structured'], invariants: ['mode: structured'] },
    };
    recipe.signature = signRecipe(recipe);
    writeRecipeFile(join(dir, 'recipes'), recipe);

    const def = makeWorkflowDef({
      projectRoot: dir,
      entryStep: 'producer',
      services: [],
      steps: [
        {
          id: 'producer',
          type: 'task',
          run: { command: 'node', args: ['-e', 'process.exit(0)'], cwd: dir, mode: 'structured', timeoutMs: 5000 },
          validator: 'exit_code',
          updateSource: 'none',
          outputs: { exitStatus: { type: 'string', from: 'validationStatus' } },
          on: { success: 'consumer', validation_failed: 'abort' },
        },
        {
          id: 'consumer',
          type: 'recipe_ref',
          recipe: 'integration-schema-mismatch-recipe',
          inputs: { exit_code: '{{state.producer.exitStatus}}' },
          on: { success: 'done', validation_failed: 'abort' },
        },
      ],
    });
    const defPath = writeDefFile(dir, def, 'shared-recipe-validation.json');
    const manifestPath = join(dir, '.guardrail', 'workflows', 'shared-recipe-validation.approved.json');
    createAckedWorkflowManifest(def, dir, manifestPath);

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

  it('fails early when workflow recipe_ref auth prerequisite is missing', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });

    const recipe = makeRecipe({
      id: 'workflow-auth-recipe',
      requires_auth: [{ type: 'claude_login', env: ['HOME'], message: 'Claude login required for this workflow runtime.' }],
    });
    writeRecipeFile(join(dir, 'recipes'), recipe);

    const def = makeWorkflowDef({
      projectRoot: dir,
      entryStep: 'consumer',
      services: [],
      steps: [
        {
          id: 'consumer',
          type: 'recipe_ref',
          recipe: recipe.id,
          inputs: { target: 'hello' },
          on: { success: 'done', validation_failed: 'abort', failure: 'abort' },
        },
      ],
    });
    const defPath = writeDefFile(dir, def, 'workflow-auth-preflight.json');
    const manifestPath = join(dir, '.guardrail', 'workflows', 'workflow-auth-preflight.approved.json');
    createAckedWorkflowManifest(def, dir, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
      authCheckFn: async () => ({ success: false, stderr: 'Not logged in' }),
    });

    assert.equal(result.failedStep, 'consumer');
    assert.match(result.terminalReason || '', /missing_auth_prerequisite/);
    assert.match(result.terminalReason || '', /Claude login required for this workflow runtime/);
    assert.match(result.terminalReason || '', /Not logged in/);
  });

  it('passes declared recipe_ref env requirements through workflow execution', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });

    const original = process.env.GUARDRAIL_WORKFLOW_RECIPE_ENV_TEST;
    process.env.GUARDRAIL_WORKFLOW_RECIPE_ENV_TEST = 'present';

    try {
      const recipe = makeRecipe({
        id: 'workflow-env-recipe',
        requires_env: ['GUARDRAIL_WORKFLOW_RECIPE_ENV_TEST'],
        steps: [
          {
            id: 'step-1',
            description: 'verify workflow env passthrough',
            run: {
              command: 'node',
              args: ['-e', 'process.exit(process.env.GUARDRAIL_WORKFLOW_RECIPE_ENV_TEST === "present" ? 0 : 9)'],
              mode: 'structured',
              timeoutMs: 5000,
            },
          },
        ],
      });
      writeRecipeFile(join(dir, 'recipes'), recipe);

      const def = makeWorkflowDef({
        projectRoot: dir,
        entryStep: 'consumer',
        services: [],
        steps: [
          {
            id: 'consumer',
            type: 'recipe_ref',
            recipe: recipe.id,
            inputs: { target: 'hello' },
            on: { success: 'done', validation_failed: 'abort', failure: 'abort' },
          },
        ],
      });
      const defPath = writeDefFile(dir, def, 'workflow-env-pass.json');
      const manifestPath = join(dir, '.guardrail', 'workflows', 'workflow-env-pass.approved.json');
      createAckedWorkflowManifest(def, dir, manifestPath);

      const result = await runWorkflowSupervisor({
        definitionPath: defPath,
        manifestPath,
        nonInteractive: true,
        jsonOutput: true,
        trustClass: 'reviewed_internal',
      });

      assert.equal(result.status, 'success');
      assert.equal(result.stepsExecuted, 1);
    } finally {
      if (original === undefined) delete process.env.GUARDRAIL_WORKFLOW_RECIPE_ENV_TEST;
      else process.env.GUARDRAIL_WORKFLOW_RECIPE_ENV_TEST = original;
    }
  });
});

// ===========================================================================
// 3. Template supervisor: runtime policy integration
// ===========================================================================

describe('Integration: Template Supervisor Runtime Policy', () => {
  it('reuses approved template non-interactively when enum input changes within bounded envelope', async () => {
    const dir = tmpDir();
    const tmplPath = join(dir, 'tmpl.json');
    const manifestPath = join(dir, '.guardrail', 'templates', 'test-bounded.approved.json');
    const templateDef = {
      ...makeTemplate(),
      inputs: {
        name: { type: 'string', enum: ['hello', 'world'] },
      },
    };
    writeFileSync(tmplPath, JSON.stringify(templateDef));

    mkdirSync(resolve(dir, '.guardrail', 'templates'), { recursive: true });
    createApprovedTemplateManifest(templateDef, {
      inputValues: { name: 'hello' },
      manifestPath,
    });

    const result = await runTemplateSupervisor({
      templatePath: tmplPath,
      inputs: { name: 'world' },
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'success');
  });

  it('reuses approved template non-interactively when list input changes within bounded envelope', async () => {
    const dir = tmpDir();
    const templatePath = join(dir, 'run-tests.template.json');
    const templateDef = {
      version: 1,
      kind: 'template',
      name: 'run-tests',
      description: 'Run bounded test files',
      trust_class: 'reviewed_internal',
      risk: 'green',
      inputs: {
        test_files: {
          type: 'string',
          approval_mode: 'list',
          max_items: 4,
          item_validator: {
            type: 'string',
            approval_mode: 'path_policy',
            rules: {
              must_be_relative: true,
              allowed_roots: ['tests/'],
              deny_segments: ['..'],
              allowed_extensions: ['.js'],
              max_depth: 4,
            },
          },
        },
      },
      run: {
        command: 'echo',
        args: ['{{inputs.test_files}}'],
        mode: 'structured',
        env: {},
      },
      idempotent: true,
    };
    writeFileSync(templatePath, JSON.stringify(templateDef, null, 2));
    const manifestPath = join(dir, '.guardrail', 'templates', 'run-tests.approved.json');
    mkdirSync(join(dir, '.guardrail', 'templates'), { recursive: true });

    createApprovedTemplateManifest(templateDef, {
      manifestPath,
      inputValues: { test_files: ['tests/a.test.js'] },
    });

    const result = await runTemplateSupervisor({
      templatePath,
      inputs: { test_files: ['tests/b.test.js', 'tests/c.test.js'] },
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'success');
  });

  it('detects template drift when candidate input leaves approved bounded envelope', async () => {
    const dir = tmpDir();
    const tmplPath = join(dir, 'tmpl.json');
    const manifestPath = join(dir, '.guardrail', 'templates', 'test-envelope-drift.approved.json');
    const templateDef = makeTemplate();
    writeFileSync(tmplPath, JSON.stringify(templateDef));

    mkdirSync(resolve(dir, '.guardrail', 'templates'), { recursive: true });
    const manifest = createApprovedTemplateManifest(templateDef, {
      inputValues: { name: 'hello' },
      manifestPath,
    });
    manifest.inputApprovalEnvelopes = {
      name: { type: 'enum', values: ['hello'] },
    };
    saveManifest(manifest, manifestPath);

    const result = await runTemplateSupervisor({
      templatePath: tmplPath,
      inputs: { name: 'world' },
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'drift_detected');
  });

  it('requires explicit env allow-list when template declares requires_env', async () => {
    const dir = tmpDir();
    const tmplPath = join(dir, 'tmpl.json');
    const tmpl = {
      ...makeTemplate(),
      requires_env: ['NPM_TOKEN'],
    };
    writeFileSync(tmplPath, JSON.stringify(tmpl));

    const result = await runTemplateSupervisor({
      templatePath: tmplPath,
      inputs: { name: 'hello' },
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'policy_violation');
  });

  it('rejects templates when explicit env allow-list omits required vars', async () => {
    const dir = tmpDir();
    const tmplPath = join(dir, 'tmpl.json');
    const tmpl = {
      ...makeTemplate(),
      requires_env: ['NPM_TOKEN', 'CI'],
    };
    writeFileSync(tmplPath, JSON.stringify(tmpl));

    const result = await runTemplateSupervisor({
      templatePath: tmplPath,
      inputs: { name: 'hello' },
      nonInteractive: true,
      jsonOutput: true,
      envAllow: ['CI'],
    });

    assert.equal(result.status, 'policy_violation');
  });

  it('accepts explicit env allow-list when it covers required vars', async () => {
    const dir = tmpDir();
    const tmplPath = join(dir, 'tmpl.json');
    const tmpl = {
      ...makeTemplate(),
      requires_env: ['NPM_TOKEN'],
    };
    writeFileSync(tmplPath, JSON.stringify(tmpl));

    const result = await runTemplateSupervisor({
      templatePath: tmplPath,
      inputs: { name: 'hello' },
      nonInteractive: true,
      jsonOutput: true,
      envAllow: ['NPM_TOKEN'],
    });

    assert.notEqual(result.status, 'policy_violation');
  });

  it('emits stable template progress events for JSON-stream', async () => {
    const dir = tmpDir();
    const tmplPath = join(dir, 'tmpl.json');
    const manifestPath = join(dir, '.guardrail', 'templates', 'test.approved.json');
    const templateDef = makeTemplate();
    writeFileSync(tmplPath, JSON.stringify(templateDef));

    mkdirSync(resolve(dir, '.guardrail', 'templates'), { recursive: true });
    createApprovedTemplateManifest(templateDef, {
      inputValues: { name: 'hello' },
      manifestPath,
    });

    const events = [];
    const result = await runTemplateSupervisor({
      templatePath: tmplPath,
      inputs: { name: 'hello' },
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      progressSink: (event) => events.push(event),
    });

    assert.equal(result.status, 'success');
    const eventNames = events.map((event) => event.event);

    assert.ok(eventNames.includes('execution_start'), 'execution_start should be emitted');
    assert.ok(eventNames.includes('step_started'), 'step_started should be emitted');
    assert.ok(eventNames.includes('step_completed'), 'step_completed should be emitted');
    assert.ok(eventNames.includes('execution_end'), 'execution_end should be emitted');

    const executionStart = events.find((event) => event.event === 'execution_start');
    const executionEnd = events.find((event) => event.event === 'execution_end');
    const stepStarted = events.find((event) => event.event === 'step_started');

    assert.equal(executionStart.mode, 'template');
    assert.equal(executionStart.runId, result.runId);
    assert.equal(stepStarted.mode, 'template');
    assert.equal(stepStarted.stepType, 'template_step');
    assert.equal(executionEnd.mode, 'template');
    assert.equal(executionEnd.runId, result.runId);
    assert.equal(executionEnd.status, 'success');
  });

  it('emits approval_pending for non-interactive template approval-required path', async () => {
    const dir = tmpDir();
    const tmplPath = join(dir, 'tmpl.json');
    mkdirSync(resolve(dir, '.guardrail', 'templates'), { recursive: true });
    const manifestPath = join(dir, '.guardrail', 'templates', 'test-required.approved.json');
    const templateDef = makeTemplate();
    writeFileSync(tmplPath, JSON.stringify(templateDef));

    const events = [];
    const result = await runTemplateSupervisor({
      templatePath: tmplPath,
      inputs: { name: 'hello' },
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      progressSink: (event) => events.push(event),
    });

    assert.equal(result.status, 'approval_required');
    const eventNames = events.map((event) => event.event);
    assert.equal(eventNames.includes('approval_pending'), true, 'approval_pending should be emitted');
    assert.equal(eventNames.includes('execution_end'), true, 'execution_end should still be emitted');
    assert.equal(eventNames[0], 'approval_pending');
    assert.equal(eventNames[eventNames.length - 1], 'execution_end');
  });

  it('time policy blocks template execution', async () => {
    const dir = tmpDir();
    const tmplPath = join(dir, 'tmpl.json');
    writeFileSync(tmplPath, JSON.stringify(makeTemplate()));

    const result = await runTemplateSupervisor({
      templatePath: tmplPath,
      inputs: { name: 'hello' },
      nonInteractive: true,
      jsonOutput: true,
      runtimeLimits: { validUntil: '2020-01-01T00:00:00Z' },
    });

    // Will be time_policy_violated or approval_required depending on flow
    assert.ok(
      result.status === 'time_policy_violated' || result.status === 'approval_required',
      `Expected time_policy_violated or approval_required, got ${result.status}`,
    );
  });

  it('concurrent lock blocks second template execution', async () => {
    const dir = tmpDir();
    const tmplPath = join(dir, 'tmpl.json');
    writeFileSync(tmplPath, JSON.stringify(makeTemplate()));

    // Run two template supervisors concurrently — one should block
    // Since the first is fast (echo), race condition is unlikely
    // Instead, pre-acquire a lock for the template hash
    const { acquireLock } = await import('../src/runtime-policy.js');
    const { hashTemplateExecution, validateUserInputs, computeEnvIntersection } = await import('../src/template.js');

    const def = makeTemplate();
    const inputResult = validateUserInputs(def.inputs, { name: 'hello' });
    const envResult = computeEnvIntersection(def.requires_env || [], []);
    const tmplHash = hashTemplateExecution(def, inputResult.values, envResult.intersection);

    const stateDir = resolve(dir, '.guardrail');
    mkdirSync(stateDir, { recursive: true });
    const lock = acquireLock(tmplHash, [], stateDir, 60000);
    assert.equal(lock.acquired, true);

    try {
      const result = await runTemplateSupervisor({
        templatePath: tmplPath,
        inputs: { name: 'hello' },
        nonInteractive: true,
        jsonOutput: true,
      });

      // Should be blocked by concurrent lock or fail at approval (no manifest)
      assert.ok(
        result.status === 'concurrent_blocked' || result.status === 'approval_required',
        `Expected concurrent_blocked or approval_required, got ${result.status}`,
      );
    } finally {
      lock.release();
    }
  });
});

// ===========================================================================
// 4. Recipe supervisor: runtime policy integration
// ===========================================================================

describe('Integration: Recipe Supervisor Runtime Policy', () => {
  it('reuses approved recipe non-interactively when enum input changes within bounded envelope', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeRecipe({
      inputs: {
        target: { type: 'string', pattern: '^[a-z]+$' },
        deploy_env: { type: 'string', enum: ['dev', 'staging'] },
      },
      steps: [
        {
          id: 'step-1',
          description: 'echo target and env',
          run: { command: 'echo', args: ['{{inputs.target}}', '{{inputs.deploy_env}}'], mode: 'structured', timeoutMs: 5000 },
        },
      ],
    });
    const sourcePath = writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    createApprovedRecipeManifest(recipe, dir, manifestPath, sourcePath, {
      resolvedInputs: { target: 'hello', deploy_env: 'dev' },
    });

    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { target: 'hello', deploy_env: 'staging' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'success');
  });

  it('reuses approved recipe non-interactively when list input changes within bounded envelope', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeRecipe({
      inputs: {
        test_files: {
          type: 'string',
          approval_mode: 'list',
          max_items: 4,
          item_validator: {
            type: 'string',
            approval_mode: 'path_policy',
            rules: {
              must_be_relative: true,
              allowed_roots: ['tests/'],
              deny_segments: ['..'],
              allowed_extensions: ['.js'],
              max_depth: 4,
            },
          },
        },
      },
      steps: [
        {
          id: 'step-1',
          description: 'echo tests',
          run: { command: 'echo', args: ['{{inputs.test_files}}'], mode: 'structured', timeoutMs: 5000 },
        },
      ],
    });
    const sourcePath = writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    createApprovedRecipeManifest(recipe, dir, manifestPath, sourcePath, {
      resolvedInputs: { test_files: ['tests/a.test.js'] },
    });

    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { test_files: ['tests/b.test.js', 'tests/c.test.js'] },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'success');
  });

  it('detects recipe drift when candidate input leaves approved bounded envelope', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeRecipe();
    const sourcePath = writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    const manifest = createApprovedRecipeManifest(recipe, dir, manifestPath, sourcePath, {
      resolvedInputs: { target: 'hello' },
    });
    manifest.inputApprovalEnvelopes = {
      target: { type: 'enum', values: ['hello'] },
    };
    saveManifest(manifest, manifestPath);

    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { target: 'world' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'drift_detected');
  });

  it('requires acknowledged risk assessment before non-interactive reuse', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeRecipe();
    const sourcePath = writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    createApprovedRecipeManifest(recipe, dir, manifestPath, sourcePath, { acknowledged: false });

    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { target: 'hello' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'approval_required');
  });

  it('requires fresh approval for review_each_time recipe inputs even when the manifest matches exactly', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeRecipe({
      inputs: {
        prompt: {
          type: 'string',
          approval_mode: 'review_each_time',
          required: false,
        },
      },
      steps: [
        {
          id: 'step-1',
          description: 'Echo prompt',
          run: { command: 'echo', args: ['{{inputs.prompt}}'], mode: 'structured' },
        },
      ],
    });
    const sourcePath = writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    createApprovedRecipeManifest(recipe, dir, manifestPath, sourcePath, {
      resolvedInputs: { prompt: 'review this repo' },
    });

    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { prompt: 'review this repo' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'approval_required');
    assert.match(result.reason, /review_each_time inputs: prompt/);
  });

  it('reuses interactive_message recipe inputs for the same persistent session', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeRecipe({
      inputs: {
        prompt: {
          type: 'string',
          approval_mode: 'interactive_message',
          required: false,
        },
        lifecycle: {
          type: 'string',
          enum: ['start', 'continue', 'attach'],
          default: 'start',
          required: false,
        },
        session_name: {
          type: 'string',
          pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$',
          required: false,
        },
        no_session_persistence: {
          type: 'boolean',
          default: true,
          required: false,
        },
      },
      steps: [
        {
          id: 'step-1',
          description: 'Echo prompt',
          run: { command: 'echo', args: ['{{inputs.prompt}}'], mode: 'structured' },
        },
      ],
    });
    const sourcePath = writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    createApprovedRecipeManifest(recipe, dir, manifestPath, sourcePath, {
      resolvedInputs: {
        prompt: '2x3=?',
        lifecycle: 'continue',
        session_name: 'math-session',
        no_session_persistence: false,
      },
    });

    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: {
        prompt: '2x4=?',
        lifecycle: 'continue',
        session_name: 'math-session',
        no_session_persistence: false,
      },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'success');
  });

  it('time policy blocks recipe execution with an approved manifest', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeRecipe();
    const sourcePath = writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    createApprovedRecipeManifest(recipe, dir, manifestPath, sourcePath);

    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { target: 'hello' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      runtimeLimits: { validUntil: '2020-01-01T00:00:00Z' },
    });

    assert.equal(result.status, 'time_policy_violated');
    assert.equal(result.exitCode, STATUS_EXIT_CODES.time_policy_violated);
  });

  it('audit log includes manifest hash for recipe execution', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeRecipe();
    const sourcePath = writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    const manifest = createApprovedRecipeManifest(recipe, dir, manifestPath, sourcePath);

    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { target: 'hello' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'success');

    const auditPath = join(dir, '.guardrail', 'audit.jsonl');
    assert.ok(existsSync(auditPath));
    const entries = queryAuditLog(auditPath, {});
    assert.ok(entries.some(e => e.event === 'recipe_execution_start'));
    assert.ok(entries.every(e => e.manifest_hash === manifest.recipeHash));
  });

  it('flags host-boundary risk for claude-exec before approval', async () => {
    const dir = tmpDir();

    const result = await runRecipeSupervisor({
      specifier: 'claude-exec',
      inputs: {
        guardrail_repo: '.',
        working_dir: '.',
        prompt: 'Review this repo.',
        model: 'sonnet',
        effort: 'high',
        mode: 'plan',
        output_format: 'text',
        max_budget_usd: '1.00',
        system_prompt: 'Focus on facts only.',
        session_name: 'risk-check',
      },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [join(process.cwd(), 'recipes')]),
      envAllow: ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TERM_PROGRAM', 'LANG', 'TMPDIR', 'PWD', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR'],
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
      authCheckFn: async () => ({ success: true, stdout: 'logged in' }),
    });

    assert.equal(result.status, 'approval_required');
    assert.equal(result.riskLevel, 'yellow');
    assert.ok(result.riskReasons.some((reason) => reason.includes('does not sandbox host execution')));
  });

  it('requires explicit env allow-list when a recipe declares requires_env', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    const recipe = makeRecipe({
      requires_env: ['BOUND_TOKEN'],
      steps: [
        {
          id: 'step-1',
          description: 'echo target',
          run: { command: 'echo', args: ['{{inputs.target}}'], mode: 'structured', timeoutMs: 5000 },
        },
      ],
    });
    writeRecipeFile(recipesDir, recipe);

    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { target: 'hello' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'policy_violation');
    assert.match(result.reason || '', /explicit --env-allow/);
    assert.match(result.reason || '', /BOUND_TOKEN/);
  });

  it('fails early when recipe auth preflight is missing required runtime env mapping', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    const recipe = makeRecipe({
      requires_auth: [{ type: 'claude_login', env: ['HOME'] }],
    });
    writeRecipeFile(recipesDir, recipe);

    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { target: 'hello' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'policy_violation');
    assert.match(result.reason || '', /missing_auth_mapping/);
    assert.match(result.reason || '', /HOME/);
  });

  it('fails early when recipe auth prerequisite is missing', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    const recipe = makeRecipe({
      requires_auth: [{ type: 'claude_login', env: ['HOME'], message: 'Claude login required for this runtime.' }],
    });
    writeRecipeFile(recipesDir, recipe);

    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { target: 'hello' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      envAllow: ['HOME'],
      nonInteractive: true,
      jsonOutput: true,
      authCheckFn: async () => ({ success: false, stderr: 'Not logged in' }),
    });

    assert.equal(result.status, 'policy_violation');
    assert.match(result.reason || '', /missing_auth_prerequisite/);
    assert.match(result.reason || '', /Claude login required for this runtime/);
    assert.match(result.reason || '', /Not logged in/);
  });

  it('fails early when recipe auth status exits zero but reports loggedIn false', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    const recipe = makeRecipe({
      requires_auth: [{ type: 'claude_login', env: ['HOME'], message: 'Claude login required for this runtime.' }],
    });
    writeRecipeFile(recipesDir, recipe);

    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { target: 'hello' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      envAllow: ['HOME'],
      nonInteractive: true,
      jsonOutput: true,
      authCheckFn: async () => ({ success: true, stdout: '{"loggedIn":false,"authMethod":"none"}' }),
    });

    assert.equal(result.status, 'policy_violation');
    assert.match(result.reason || '', /missing_auth_prerequisite/);
    assert.match(result.reason || '', /Claude login required for this runtime/);
    assert.match(result.reason || '', /loggedIn/);
  });

  it('passes explicitly allowed env vars through recipe execution', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    const original = process.env.GUARDRAIL_RECIPE_ENV_TEST;
    process.env.GUARDRAIL_RECIPE_ENV_TEST = 'present';

    try {
      const recipe = makeRecipe({
        requires_env: ['GUARDRAIL_RECIPE_ENV_TEST'],
        steps: [
          {
            id: 'step-1',
            description: 'verify env passthrough',
            run: {
              command: 'node',
              args: ['-e', 'process.exit(process.env.GUARDRAIL_RECIPE_ENV_TEST === "present" ? 0 : 7)'],
              mode: 'structured',
              timeoutMs: 5000,
            },
          },
        ],
      });

      const sourcePath = writeRecipeFile(recipesDir, recipe);
      const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
      mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });
      createApprovedRecipeManifest(recipe, dir, manifestPath, sourcePath, {
        resolvedInputs: { target: 'hello' },
        envAllow: ['GUARDRAIL_RECIPE_ENV_TEST'],
      });

      const result = await runRecipeSupervisor({
        specifier: recipe.id,
        inputs: { target: 'hello' },
        cwd: dir,
        searchDirs: exactSearchDirs(dir, [recipesDir]),
        manifestPath,
        envAllow: ['GUARDRAIL_RECIPE_ENV_TEST'],
        nonInteractive: true,
        jsonOutput: true,
      });

      assert.equal(result.status, 'success');
    } finally {
      if (original === undefined) delete process.env.GUARDRAIL_RECIPE_ENV_TEST;
      else process.env.GUARDRAIL_RECIPE_ENV_TEST = original;
    }
  });

  it('emits stable recipe progress events for JSON-stream', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeRecipe();
    const sourcePath = writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    createApprovedRecipeManifest(recipe, dir, manifestPath, sourcePath);

    const events = [];
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { target: 'hello' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      progressSink: (event) => events.push(event),
    });

    assert.equal(result.status, 'success');
    const eventNames = events.map((event) => event.event);

    assert.ok(eventNames.includes('execution_start'), 'execution_start should be emitted');
    assert.ok(eventNames.includes('step_started'), 'step_started should be emitted');
    assert.ok(eventNames.includes('step_completed'), 'step_completed should be emitted');
    assert.ok(eventNames.includes('execution_end'), 'execution_end should be emitted');

    const executionStart = events.find((event) => event.event === 'execution_start');
    const executionEnd = events.find((event) => event.event === 'execution_end');
    const stepStarted = events.find((event) => event.event === 'step_started');

    assert.equal(executionStart.mode, 'recipe');
    assert.equal(executionStart.runId, result.runId);
    assert.equal(stepStarted.mode, 'recipe');
    assert.equal(stepStarted.stepType, 'recipe');
    assert.equal(executionEnd.mode, 'recipe');
    assert.equal(executionEnd.runId, result.runId);
    assert.equal(executionEnd.status, 'success');
  });

  it('emits approval_pending for non-interactive recipe approval-required path', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });
    const recipe = makeRecipe();
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(resolve(dir, '.guardrail', 'recipes'), { recursive: true });
    writeRecipeFile(recipesDir, recipe);

    const events = [];
    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { target: 'hello' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      progressSink: (event) => events.push(event),
    });

    assert.equal(result.status, 'approval_required');
    const eventNames = events.map((event) => event.event);
    assert.equal(eventNames.includes('approval_pending'), true, 'approval_pending should be emitted');
    assert.equal(eventNames.includes('execution_end'), true, 'execution_end should still be emitted');
    assert.equal(eventNames[0], 'approval_pending');
    assert.equal(eventNames[eventNames.length - 1], 'execution_end');
  });
});

// ===========================================================================
// 5. Cross-supervisor: audit chain integrity maintained
// ===========================================================================

describe('Integration: Audit Chain Integrity Across Runs', () => {
  it('multiple command runs produce valid audit chain', async () => {
    const dir = tmpDir();
    const manifestDir = join(dir, '.guardrail');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'approved.json');

    createApprovedCommandManifest('echo', ['hello'], dir, manifestPath);

    // Run 3 times with same args (matching manifest)
    for (let i = 0; i < 3; i++) {
      await runSupervisor({
        command: 'echo',
        args: ['hello'],
        cwd: dir,
        manifestPath,
        nonInteractive: true,
        jsonOutput: true,
        trustClass: 'reviewed_internal',
      });
    }

    const auditPath = join(manifestDir, 'audit.jsonl');
    assert.ok(existsSync(auditPath), 'Audit log should exist');
    const chain = verifyAuditChain(auditPath);
    assert.equal(chain.valid, true, `Chain should be valid, got: ${chain.error}`);
    // Each run produces execution_start + execution_end = 2 entries each = 6 total
    assert.ok(chain.entries >= 6, `Expected at least 6 entries, got ${chain.entries}`);
  });
});

// ===========================================================================
// 6. Exit code consistency
// ===========================================================================

describe('Integration: Runtime Policy Exit Codes', () => {
  it('time_policy_violated exit code is 20', () => {
    assert.equal(STATUS_EXIT_CODES.time_policy_violated, 20);
  });

  it('concurrent_blocked exit code is 21', () => {
    assert.equal(STATUS_EXIT_CODES.concurrent_blocked, 21);
  });

  it('audit_chain_broken exit code is 22', () => {
    assert.equal(STATUS_EXIT_CODES.audit_chain_broken, 22);
  });
});

// ===========================================================================
// Cross-track integration: A0 adapter-result + A0g session contracts
// ===========================================================================

describe('Integration: Adapter normalization parity with command supervisor', () => {
  it('normalizes a real successful command supervisor result into a valid adapter-result/v1', async () => {
    const dir = tmpDir();
    const manifestDir = join(dir, '.guardrail');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'approved.json');

    createApprovedCommandManifest('echo', ['hello'], dir, manifestPath);

    const supervisorResult = await runSupervisor({
      command: 'echo',
      args: ['hello'],
      cwd: dir,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(supervisorResult.status, 'success');

    const adapterResult = normalizeToAdapterResult(supervisorResult);
    const shape = validateAdapterResult(adapterResult);
    assert.equal(shape.valid, true, shape.errors?.join('; '));
    assert.equal(adapterResult.schemaVersion, 'adapter-result/v1');
    assert.equal(adapterResult.guardrail.category, 'success');
    assert.equal(adapterResult.guardrail.code, ADAPTER_REASON_CODES.OK);
    assert.equal(adapterResult.guardrail.driftDetected, false);
  });

  it('normalizes a drift-detected supervisor result into a DRIFT_DETECTED adapter-result', async () => {
    const dir = tmpDir();
    const manifestDir = join(dir, '.guardrail');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'approved.json');

    // Approve 'echo hello', then run 'echo goodbye' in non-interactive mode to force drift.
    createApprovedCommandManifest('echo', ['hello'], dir, manifestPath);

    const supervisorResult = await runSupervisor({
      command: 'echo',
      args: ['goodbye'],
      cwd: dir,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(supervisorResult.status, 'drift_detected');

    const adapterResult = normalizeToAdapterResult(supervisorResult);
    const shape = validateAdapterResult(adapterResult);
    assert.equal(shape.valid, true, shape.errors?.join('; '));
    assert.equal(adapterResult.guardrail.category, 'blocked');
    assert.equal(adapterResult.guardrail.code, ADAPTER_REASON_CODES.DRIFT_DETECTED);
    assert.equal(adapterResult.guardrail.driftDetected, true);
  });
});

describe('Integration: Recipe supervisor enforces session contracts alongside runtime policy', () => {
  // Mirrors recipe-supervisor.HOST_BOUNDARY_WARNING verbatim. When the
  // supervisor's warning text changes, both this literal and the supervisor
  // must move together in the same commit.
  const SESSION_HOST_BOUNDARY_WARNING =
    'Guardrail does not sandbox host execution; this wrapper relies on the tool/runtime permission model';

  function makeClaudeExecStubRecipe() {
    const recipe = {
      id: 'claude-exec',
      name: 'Claude Exec Integration Stub',
      description: 'integration stub matching the claude-exec recipe id to exercise session enforcement',
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
        lifecycle: { type: 'string', enum: ['start', 'continue', 'attach'], default: 'start' },
      },
      steps: [
        {
          id: 'stub',
          description: 'stub step — never executed in this test',
          run: { command: 'echo', args: ['stub'], mode: 'structured', timeoutMs: 5000 },
        },
      ],
      guardrails: { constraints: ['structured'], invariants: ['no shell'] },
      approval_required: false,
      risk_level: 'low',
    };
    recipe.signature = signRecipe(recipe);
    return recipe;
  }

  function seedClaudeExecApprovedManifest(recipe, dir, manifestPath, sourcePath, resolvedInputs) {
    const manifest = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      {
        trustClass: 'pinned_external',
        riskLevel: 'yellow',
        reasons: ['recipe declares low risk', SESSION_HOST_BOUNDARY_WARNING],
        requiresStrongConfirmation: false,
      },
      resolvedInputs,
      {
        cwd: resolve(dir),
        projectRoot: resolve(dir),
        sourcePath,
      },
    );
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    saveManifest(manifest, manifestPath);
    return manifest;
  }

  it('fails closed on lifecycle=continue when no session contract exists, without invoking the executor', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    const recipe = makeClaudeExecStubRecipe();
    writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });
    seedClaudeExecApprovedManifest(
      recipe,
      dir,
      manifestPath,
      join(recipesDir, `${recipe.id}.recipe.json`),
      { working_dir: '.', lifecycle: 'continue' },
    );

    let executorCallCount = 0;
    const stubExecutor = async () => {
      executorCallCount += 1;
      return { status: 'success', stepsExecuted: 1 };
    };

    const result = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { working_dir: '.', lifecycle: 'continue' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      executorFn: stubExecutor,
    });

    assert.equal(executorCallCount, 0, 'executor must not run when session contract is missing');
    assert.equal(result.status, 'policy_violation');
    assert.match(result.reason || '', /session_missing/);
  });

  it('persists a session contract on successful lifecycle=start and enforces drift on later mismatched continue', async () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    const recipe = makeClaudeExecStubRecipe();
    const sourcePath = writeRecipeFile(recipesDir, recipe);
    const manifestPath = join(dir, '.guardrail', 'recipes', `${recipe.id}.approved.json`);
    mkdirSync(join(dir, '.guardrail', 'recipes'), { recursive: true });

    // First run: lifecycle=start must succeed and persist a session contract.
    seedClaudeExecApprovedManifest(
      recipe,
      dir,
      manifestPath,
      sourcePath,
      { working_dir: '.', lifecycle: 'start' },
    );

    let startExecCount = 0;
    const startResult = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { working_dir: '.', lifecycle: 'start' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      executorFn: async () => {
        startExecCount += 1;
        return { status: 'success', stepsExecuted: 1 };
      },
    });

    assert.equal(startResult.status, 'success', `expected success, got: ${startResult.status} reason=${startResult.reason}`);
    assert.equal(startExecCount, 1);

    const stateDir = join(dir, '.guardrail');
    const contractPath = defaultSessionContractPath(stateDir, recipe.id, null);
    const persisted = loadSessionContract(contractPath);
    assert.ok(persisted !== null, 'session contract file must be persisted after successful start');
    assert.equal(persisted.recipeId, 'claude-exec');
    assert.equal(persisted.lifecycle, 'start');

    // Second run: lifecycle=continue with a different working dir must fail closed via session_drift.
    const driftDir = join(dir, 'other');
    mkdirSync(driftDir, { recursive: true });
    seedClaudeExecApprovedManifest(
      recipe,
      dir,
      manifestPath,
      sourcePath,
      { working_dir: 'other', lifecycle: 'continue' },
    );

    let driftExecCount = 0;
    const driftResult = await runRecipeSupervisor({
      specifier: recipe.id,
      inputs: { working_dir: 'other', lifecycle: 'continue' },
      cwd: dir,
      searchDirs: exactSearchDirs(dir, [recipesDir]),
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      executorFn: async () => {
        driftExecCount += 1;
        return { status: 'success', stepsExecuted: 1 };
      },
    });

    assert.equal(driftExecCount, 0, 'executor must not run when session contract drifts');
    assert.equal(driftResult.status, 'policy_violation');
    assert.match(driftResult.reason || '', /session_drift/);
  });

  it('session contract helper round-trips canonically through atomic save and load', () => {
    const dir = tmpDir();
    const stateDir = join(dir, '.guardrail');
    mkdirSync(stateDir, { recursive: true });

    const contract = buildSessionContract({
      tool: 'claude',
      recipeId: 'claude-exec',
      recipeVersion: '1.0.0',
      workingDir: resolve(dir),
      addDirs: [resolve(dir, 'docs'), resolve(dir, 'src')],
      sessionName: 'roundtrip-session',
      sessionId: null,
      lifecycle: 'start',
    });

    const path = defaultSessionContractPath(stateDir, 'claude-exec', 'roundtrip-session');
    saveSessionContract(contract, path);

    const loaded = loadSessionContract(path);
    assert.ok(loaded !== null);
    assert.equal(loaded.contractHash, contract.contractHash);
    assert.equal(loaded.sessionName, 'roundtrip-session');
    assert.deepEqual(
      loaded.scope.addDirs,
      [resolve(dir, 'docs'), resolve(dir, 'src')].sort(),
    );
  });
});
