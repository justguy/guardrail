import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  loadWorkflowDefinition,
  normalizeWorkflowDefinition,
  hashWorkflow,
  createWorkflowManifest,
  compareWorkflowManifests,
  lintWorkflowDefinition,
} from '../src/workflow.js';
import { evaluateWorkflowRisk } from '../src/policy-engine.js';
import { saveManifest, loadManifest } from '../src/manifest.js';
import { runWorkflowSupervisor } from '../src/workflow-supervisor.js';
import { STATUS_EXIT_CODES } from '../src/supervisor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

// ===========================================================================
// Test 1: The "Sneaky Inheritance" — allow list secret detection
// ===========================================================================

describe('Adversarial: Sneaky Allow-List Inheritance', () => {
  it('loads and validates the fixture', () => {
    const def = loadWorkflowDefinition(join(FIXTURES, 'sneaky-allow.json'));
    assert.equal(def.name, 'stress-sneaky-allow');
  });

  it('detects AWS_SECRET_ACCESS_KEY in the allow list as secret exposure', () => {
    const def = loadWorkflowDefinition(join(FIXTURES, 'sneaky-allow.json'));
    const norm = normalizeWorkflowDefinition(def, FIXTURES);
    const risk = evaluateWorkflowRisk(norm, {
      trustClass: 'reviewed_internal',
      projectRoot: FIXTURES,
    });

    assert.ok(
      risk.reasons.includes('secret injection enabled'),
      `Expected "secret injection enabled" in reasons, got: ${risk.reasons.join(', ')}`,
    );
  });

  it('escalates to yellow (structured mode + secret, no prod target)', () => {
    // The fixture uses mode: "structured", not "shell", so it stays yellow
    // (RED requires shell + secrets or prod + secrets)
    const def = loadWorkflowDefinition(join(FIXTURES, 'sneaky-allow.json'));
    const norm = normalizeWorkflowDefinition(def, FIXTURES);
    const risk = evaluateWorkflowRisk(norm, {
      trustClass: 'reviewed_internal',
      projectRoot: FIXTURES,
    });

    assert.equal(risk.riskLevel, 'yellow');
  });

  it('escalates to RED when the same allow list is used with shell mode', () => {
    // Modify the fixture in-memory to use shell mode
    const def = loadWorkflowDefinition(join(FIXTURES, 'sneaky-allow.json'));
    def.steps[0].run.mode = 'shell';
    def.steps[0].run.shell = 'bash scripts/deploy.sh';

    const norm = normalizeWorkflowDefinition(def, FIXTURES);
    const risk = evaluateWorkflowRisk(norm, {
      trustClass: 'reviewed_internal',
      projectRoot: FIXTURES,
    });

    assert.equal(risk.riskLevel, 'red');
    assert.ok(risk.requiresStrongConfirmation);
  });
});

// ===========================================================================
// Test 2: The "Fake Success" Trap — lint catches failure→done
// ===========================================================================

describe('Adversarial: Fake Success Trap', () => {
  it('loads the fixture without validation errors', () => {
    const def = loadWorkflowDefinition(join(FIXTURES, 'fake-success.json'));
    assert.equal(def.name, 'stress-fake-success');
  });

  it('lint catches validation_failed → done as a fatal error', () => {
    const def = loadWorkflowDefinition(join(FIXTURES, 'fake-success.json'));
    const { errors } = lintWorkflowDefinition(def);

    assert.ok(errors.length > 0, 'Expected at least one lint error');
    assert.ok(
      errors.some(e => e.includes('validation_failed') && e.includes('done')),
      `Expected error about validation_failed → done, got: ${errors.join('; ')}`,
    );
  });

  it('lint suggests using "abort" instead', () => {
    const def = loadWorkflowDefinition(join(FIXTURES, 'fake-success.json'));
    const { errors } = lintWorkflowDefinition(def);

    assert.ok(
      errors.some(e => e.includes('abort')),
      'Error should suggest "abort" as the alternative',
    );
  });
});

// ===========================================================================
// Test 3: The "Trojan Horse" — hidden secret in a multi-step workflow
// ===========================================================================

describe('Adversarial: Trojan Horse Step', () => {
  it('loads and validates the fixture', () => {
    const def = loadWorkflowDefinition(join(FIXTURES, 'trojan-horse.json'));
    assert.equal(def.steps.length, 2);
  });

  it('detects the hidden secret in step 2 at workflow level', () => {
    const def = loadWorkflowDefinition(join(FIXTURES, 'trojan-horse.json'));
    const norm = normalizeWorkflowDefinition(def, FIXTURES);
    const risk = evaluateWorkflowRisk(norm, {
      trustClass: 'reviewed_internal',
      projectRoot: FIXTURES,
    });

    assert.ok(
      risk.reasons.includes('secret injection enabled'),
      `Tainted step must surface "secret injection enabled", got: ${risk.reasons.join(', ')}`,
    );
  });

  it('escalates to RED because step 2 combines shell mode + secret inject', () => {
    const def = loadWorkflowDefinition(join(FIXTURES, 'trojan-horse.json'));
    const norm = normalizeWorkflowDefinition(def, FIXTURES);
    const risk = evaluateWorkflowRisk(norm, {
      trustClass: 'reviewed_internal',
      projectRoot: FIXTURES,
    });

    assert.equal(risk.riskLevel, 'red');
    assert.ok(risk.requiresStrongConfirmation);
  });

  it('safe_build step alone would be green', () => {
    // Verify the first step in isolation isn't tainted
    const def = loadWorkflowDefinition(join(FIXTURES, 'trojan-horse.json'));
    const isolatedDef = {
      ...def,
      entryStep: 'safe_build',
      steps: [{
        ...def.steps[0],
        on: { success: 'done', validation_failed: 'abort' },
      }],
    };
    const norm = normalizeWorkflowDefinition(isolatedDef, FIXTURES);
    const risk = evaluateWorkflowRisk(norm, {
      trustClass: 'reviewed_internal',
      projectRoot: FIXTURES,
    });

    assert.equal(risk.riskLevel, 'green');
    assert.ok(!risk.reasons.includes('secret injection enabled'));
  });
});

// ===========================================================================
// Test 4: The "Lazy Schema" — normalization stability
// ===========================================================================

describe('Adversarial: Lazy Schema Normalization', () => {
  it('normalizes partial envPolicy to full shape', () => {
    const def = loadWorkflowDefinition(join(FIXTURES, 'lazy-schema.json'));
    const norm = normalizeWorkflowDefinition(def, FIXTURES);

    const env = norm.steps[0].run.envPolicy;
    assert.equal(env.inherit, true);
    assert.deepEqual(env.allow, []);
    assert.deepEqual(env.inject, {});
  });

  it('produces identical hash whether envPolicy is partial or full', () => {
    // Hash with partial envPolicy
    const defPartial = loadWorkflowDefinition(join(FIXTURES, 'lazy-schema.json'));
    const normPartial = normalizeWorkflowDefinition(defPartial, FIXTURES);
    const hashPartial = hashWorkflow(normPartial);

    // Hash with explicitly full envPolicy
    const defFull = loadWorkflowDefinition(join(FIXTURES, 'lazy-schema.json'));
    defFull.steps[0].run.envPolicy = { inherit: true, allow: [], inject: {} };
    const normFull = normalizeWorkflowDefinition(defFull, FIXTURES);
    const hashFull = hashWorkflow(normFull);

    assert.equal(hashPartial, hashFull);
  });

  it('saved manifest contains the full envPolicy shape', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'lazy-schema-'));
    const manifestPath = join(tmpDir, 'approved.json');

    try {
      const def = loadWorkflowDefinition(join(FIXTURES, 'lazy-schema.json'));
      const norm = normalizeWorkflowDefinition(def, FIXTURES);
      const hash = hashWorkflow(norm);
      const risk = evaluateWorkflowRisk(norm, {
        trustClass: 'reviewed_internal',
        projectRoot: FIXTURES,
      });

      const manifest = createWorkflowManifest(norm, hash, risk, FIXTURES);
      saveManifest(manifest, manifestPath);

      const loaded = loadManifest(manifestPath);
      const savedEnv = loaded.workflow.steps[0].run.envPolicy;

      assert.equal(savedEnv.inherit, true);
      assert.deepEqual(savedEnv.allow, []);
      assert.deepEqual(savedEnv.inject, {});
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Test 5: The "Silent Tamper" — non-interactive drift on manifest edit
// ===========================================================================

describe('Adversarial: Silent Tamper Detection', () => {
  let tmpDir;
  let defPath;
  let manifestPath;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'silent-tamper-'));

    // Copy the lazy-schema fixture into tmpDir so paths resolve
    const def = loadWorkflowDefinition(join(FIXTURES, 'lazy-schema.json'));
    defPath = join(tmpDir, 'workflow.json');
    writeFileSync(defPath, JSON.stringify(def, null, 2), 'utf8');

    manifestPath = join(tmpDir, 'approved.json');

    // Generate a legitimate approved manifest
    const norm = normalizeWorkflowDefinition(def, tmpDir);
    const hash = hashWorkflow(norm);
    const risk = evaluateWorkflowRisk(norm, {
      trustClass: 'reviewed_internal',
      projectRoot: tmpDir,
    });

    const manifest = createWorkflowManifest(norm, hash, risk, tmpDir);
    manifest.riskAssessment.acknowledgedBy = 'interactive_user';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    saveManifest(manifest, manifestPath);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clean rerun succeeds in non-interactive mode', async () => {
    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'success');
    assert.equal(result.exitCode, 0);
  });

  it('tampered manifest (secret added to allow) triggers drift in non-interactive mode', async () => {
    // Tamper: add a secret to the approved manifest's allow list
    // WITHOUT updating the hash — simulating an out-of-band edit
    const loaded = loadManifest(manifestPath);
    loaded.workflow.steps[0].run.envPolicy.allow = ['GITHUB_TOKEN'];
    // Do NOT update workflowHash — this is the tamper
    saveManifest(loaded, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'drift_detected');
    assert.equal(result.exitCode, STATUS_EXIT_CODES.drift_detected);
    assert.equal(result.exitCode, 12);
  });

  it('tampered manifest (risk reasons changed) also triggers drift', async () => {
    // Tamper: change the risk reasons to hide the secret flag
    const loaded = loadManifest(manifestPath);
    loaded.riskAssessment.reasons = ['nothing to see here'];
    saveManifest(loaded, manifestPath);

    const result = await runWorkflowSupervisor({
      definitionPath: defPath,
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
      trustClass: 'reviewed_internal',
    });

    assert.equal(result.status, 'drift_detected');
    assert.equal(result.exitCode, 12);
  });
});
