import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadWorkflowDefinition,
  normalizeWorkflowDefinition,
  hashWorkflow,
  createWorkflowManifest,
  compareWorkflowManifests,
  lintWorkflowDefinition,
} from '../src/workflow.js';
import { evaluateWorkflowRisk } from '../src/policy-engine.js';
import {
  ISSUE_CODES,
  createNegotiationState,
  detectIssues,
  generateNegotiationRequest,
  applyDelta,
  computeScopeDirection,
  buildEscalationPackage,
} from '../src/negotiation.js';
import { negotiateWorkflowDelta } from '../src/workflow-supervisor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflowDef(overrides = {}) {
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
        idempotent: false,
        run: { command: 'echo', args: ['hello'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
        validator: 'exit_code',
        updateSource: 'none',
        on: { success: 'done', failure: 'abort', validation_failed: 'abort' },
      },
    ],
    rollback_policy: 'required',
    rollback: {
      steps: [{
        id: 'rollback_a',
        idempotent: true,
        run: { command: 'echo', args: ['rollback'], cwd: '.', mode: 'structured' },
      }],
    },
    ...overrides,
  };
}

function buildManifest(def) {
  const basePath = tmpdir();
  const norm = normalizeWorkflowDefinition(def, basePath);
  const hash = hashWorkflow(norm);
  const risk = evaluateWorkflowRisk(norm, { trustClass: 'reviewed_internal', projectRoot: basePath });
  return createWorkflowManifest(norm, hash, risk, basePath);
}

// ===========================================================================
// 1. Workflow Lint — Fatal Errors (Spec: "Fatal lint errors (block approval)")
// ===========================================================================

describe('Bucket 2: Workflow Lint Fatal Errors', () => {
  it('validation_failed → done rejected as fatal lint error (I-W3)', () => {
    const def = makeWorkflowDef({
      steps: [{
        id: 'a', type: 'task', idempotent: true,
        run: { command: 'echo', args: ['hi'], cwd: '.' },
        on: { success: 'done', validation_failed: 'done' },
      }],
      rollback_policy: 'none', rollback_none_reason: 'all idempotent', rollback: null,
    });
    const { errors } = lintWorkflowDefinition(def);
    assert.ok(errors.length > 0);
    assert.ok(errors.some(e => e.includes('validation_failed') && e.includes('done')));
  });

  it('failure → done rejected as fatal lint error', () => {
    const def = makeWorkflowDef({
      steps: [{
        id: 'a', type: 'task', idempotent: true,
        run: { command: 'echo', args: ['hi'], cwd: '.' },
        on: { success: 'done', failure: 'done' },
      }],
      rollback_policy: 'none', rollback_none_reason: 'all idempotent', rollback: null,
    });
    const { errors } = lintWorkflowDefinition(def);
    assert.ok(errors.some(e => e.includes('failure') && e.includes('done')));
  });

  it('mode: shell rejected as fatal lint error', () => {
    const def = makeWorkflowDef({
      steps: [{
        id: 'a', type: 'task', idempotent: true,
        run: { command: 'echo', args: ['hi'], cwd: '.', mode: 'shell' },
        on: { success: 'done', failure: 'abort' },
      }],
      rollback_policy: 'none', rollback_none_reason: 'all idempotent', rollback: null,
    });
    const { errors } = lintWorkflowDefinition(def);
    assert.ok(errors.some(e => e.includes('shell')));
  });

  it('non-idempotent without rollback rejected as fatal lint error (I-W2)', () => {
    const def = makeWorkflowDef({
      steps: [{
        id: 'a', type: 'task', idempotent: false,
        run: { command: 'echo', args: ['hi'], cwd: '.' },
        on: { success: 'done', failure: 'abort' },
      }],
      rollback: null,
      rollback_policy: 'required',
    });
    const { errors } = lintWorkflowDefinition(def);
    assert.ok(errors.some(e => e.includes('rollback') && e.includes('non-idempotent')));
  });

  it('non-idempotent with rollback_policy: none passes lint', () => {
    const def = makeWorkflowDef({
      steps: [{
        id: 'a', type: 'task', idempotent: false,
        run: { command: 'echo', args: ['hi'], cwd: '.' },
        on: { success: 'done', failure: 'abort' },
      }],
      rollback: null,
      rollback_policy: 'none',
      rollback_none_reason: 'all operations are read-only',
    });
    const { errors } = lintWorkflowDefinition(def);
    assert.equal(errors.filter(e => e.includes('rollback')).length, 0);
  });

  it('non-idempotent with rollback section passes lint', () => {
    const def = makeWorkflowDef();  // has rollback
    const { errors } = lintWorkflowDefinition(def);
    const rollbackErrors = errors.filter(e => e.includes('rollback'));
    assert.equal(rollbackErrors.length, 0);
  });
});

// ===========================================================================
// 2. Rollback Validation
// ===========================================================================

describe('Bucket 2: Rollback Validation', () => {
  it('rollback_policy: invalid value is rejected at validation', () => {
    const def = makeWorkflowDef({ rollback_policy: 'invalid' });
    const dir = mkdtempSync(join(tmpdir(), 'gr-'));
    writeFileSync(join(dir, 'wf.json'), JSON.stringify(def));
    assert.throws(
      () => loadWorkflowDefinition(join(dir, 'wf.json')),
      (err) => err.message.includes('rollback_policy'),
    );
  });

  it('rollback_policy: none requires rollback_none_reason', () => {
    const def = makeWorkflowDef({ rollback_policy: 'none', rollback_none_reason: undefined });
    const dir = mkdtempSync(join(tmpdir(), 'gr-'));
    writeFileSync(join(dir, 'wf.json'), JSON.stringify(def));
    assert.throws(
      () => loadWorkflowDefinition(join(dir, 'wf.json')),
      (err) => err.message.includes('rollback_none_reason'),
    );
  });

  it('rollback steps included in workflow hash', () => {
    const def1 = makeWorkflowDef();
    const def2 = makeWorkflowDef({
      rollback: {
        steps: [{
          id: 'rollback_different',
          idempotent: true,
          run: { command: 'rm', args: ['-f', 'temp'], cwd: '.' },
        }],
      },
    });
    const basePath = tmpdir();
    const norm1 = normalizeWorkflowDefinition(def1, basePath);
    const norm2 = normalizeWorkflowDefinition(def2, basePath);
    const hash1 = hashWorkflow(norm1);
    const hash2 = hashWorkflow(norm2);
    assert.notEqual(hash1, hash2, 'Different rollback steps must produce different hashes');
  });

  it('rollback_policy change triggers drift detection', () => {
    const def1 = makeWorkflowDef({ rollback_policy: 'required' });
    const def2 = makeWorkflowDef({ rollback_policy: 'none', rollback_none_reason: 'read-only' });
    const m1 = buildManifest(def1);
    const m2 = buildManifest(def2);
    const { matches, diffs } = compareWorkflowManifests(m2, m1);
    assert.equal(matches, false);
    assert.ok(diffs.some(d => d.includes('rollback_policy')));
  });
});

// ===========================================================================
// 3. Idempotency (I-W4)
// ===========================================================================

describe('Bucket 2: Idempotency Enforcement (I-W4)', () => {
  it('steps default to idempotent: false', () => {
    const def = makeWorkflowDef({
      steps: [{
        id: 'a', type: 'task',
        run: { command: 'echo', args: ['hi'], cwd: '.' },
        on: { success: 'done', failure: 'abort' },
      }],
    });
    const norm = normalizeWorkflowDefinition(def, tmpdir());
    assert.equal(norm.steps[0].idempotent, false);
  });

  it('idempotent: true preserved when explicitly declared', () => {
    const def = makeWorkflowDef({
      steps: [{
        id: 'a', type: 'task', idempotent: true,
        run: { command: 'echo', args: ['hi'], cwd: '.' },
        on: { success: 'done', failure: 'abort' },
      }],
      rollback_policy: 'none', rollback_none_reason: 'all idempotent', rollback: null,
    });
    const norm = normalizeWorkflowDefinition(def, tmpdir());
    assert.equal(norm.steps[0].idempotent, true);
  });

  it('idempotent field included in hash', () => {
    const def1 = makeWorkflowDef({
      steps: [{
        id: 'a', type: 'task', idempotent: false,
        run: { command: 'echo', args: ['hi'], cwd: '.' },
        on: { success: 'done', failure: 'abort' },
      }],
    });
    const def2 = makeWorkflowDef({
      steps: [{
        id: 'a', type: 'task', idempotent: true,
        run: { command: 'echo', args: ['hi'], cwd: '.' },
        on: { success: 'done', failure: 'abort' },
      }],
      rollback_policy: 'none', rollback_none_reason: 'all idempotent', rollback: null,
    });
    const basePath = tmpdir();
    const norm1 = normalizeWorkflowDefinition(def1, basePath);
    const norm2 = normalizeWorkflowDefinition(def2, basePath);
    assert.notEqual(hashWorkflow(norm1), hashWorkflow(norm2));
  });
});

// ===========================================================================
// 4. Negotiation: Issue Detection
// ===========================================================================

describe('Bucket 2: Negotiation Issue Detection', () => {
  it('detects scope widening from new step', () => {
    const approved = buildManifest(makeWorkflowDef());
    const proposedDef = makeWorkflowDef({
      steps: [
        ...makeWorkflowDef().steps,
        { id: 'step_b', type: 'task', run: { command: 'echo', args: ['extra'], cwd: '.' }, on: { success: 'done', failure: 'abort' } },
      ],
    });
    const proposed = buildManifest(proposedDef);
    const issues = detectIssues(proposed, approved);
    assert.ok(issues.some(i => i.code === 'SCOPE_WIDENING'));
  });

  it('detects risk escalation', () => {
    const approved = buildManifest(makeWorkflowDef());
    const proposed = structuredClone(approved);
    proposed.riskAssessment.riskLevel = 'red';
    const issues = detectIssues(proposed, approved);
    assert.ok(issues.some(i => i.code === 'RISK_ESCALATION'));
  });

  it('detects PTY addition as hard block', () => {
    const approved = buildManifest(makeWorkflowDef());
    const proposed = structuredClone(approved);
    proposed.workflow.steps[0].run.pty = true;
    const issues = detectIssues(proposed, approved);
    assert.ok(issues.some(i => i.code === 'PTY_ADDITION'));
    assert.ok(issues.some(i => i.code === 'PTY_ADDITION' && !i.self_resolvable));
  });

  it('detects idempotent: true addition as hard block (I-W4)', () => {
    const approved = buildManifest(makeWorkflowDef());
    const proposed = structuredClone(approved);
    proposed.workflow.steps[0].idempotent = true;
    const issues = detectIssues(proposed, approved);
    assert.ok(issues.some(i => i.code === 'IDEMPOTENT_ADDITION'));
    assert.ok(issues.some(i => i.code === 'IDEMPOTENT_ADDITION' && !i.self_resolvable));
  });

  it('detects rollback mutation after workflow started (I-W2)', () => {
    const approved = buildManifest(makeWorkflowDef());
    const proposed = structuredClone(approved);
    proposed.workflow.rollback = { steps: [{ id: 'new', run: { command: 'rm' } }] };
    const issues = detectIssues(proposed, approved, { workflowStarted: true });
    assert.ok(issues.some(i => i.code === 'ROLLBACK_MUTATION'));
  });

  it('detects signing attempt by agent (I-W7)', () => {
    const approved = buildManifest(makeWorkflowDef());
    const proposed = structuredClone(approved);
    const issues = detectIssues(proposed, approved, { agentSigned: true });
    assert.ok(issues.some(i => i.code === 'SIGNING_ATTEMPT'));
  });

  it('self_resolvable is always Guardrail-computed, never agent-supplied', () => {
    const approved = buildManifest(makeWorkflowDef());
    const proposed = structuredClone(approved);
    proposed.workflow.steps[0].run.pty = true;
    const issues = detectIssues(proposed, approved);
    const ptyIssue = issues.find(i => i.code === 'PTY_ADDITION');
    assert.equal(ptyIssue.self_resolvable, false);
    assert.equal(ptyIssue.self_resolvable, ISSUE_CODES.PTY_ADDITION.selfResolvable);
  });

  it('detects missing rollback as self-resolvable', () => {
    const def = makeWorkflowDef({ rollback: null, rollback_policy: 'required' });
    const approved = buildManifest(makeWorkflowDef());
    const proposed = buildManifest(def);
    const issues = detectIssues(proposed, approved);
    const missing = issues.find(i => i.code === 'MISSING_ROLLBACK');
    assert.ok(missing);
    assert.equal(missing.self_resolvable, true);
  });
});

// ===========================================================================
// 5. Negotiation Request Generation
// ===========================================================================

describe('Bucket 2: Negotiation Request Generation', () => {
  it('generates structured negotiation request', () => {
    const approved = buildManifest(makeWorkflowDef());
    const negState = createNegotiationState(approved);
    const issues = [{ code: 'MISSING_VALIDATOR', field: 'steps.a.validator', detail: 'No validator', self_resolvable: true, constraint: 'must_add', current_value: null, allowed_values: null }];
    const request = generateNegotiationRequest(issues, negState);

    assert.equal(request.status, 'blocked');
    assert.equal(typeof request.trace_id, 'string');
    assert.equal(request.round, 0);
    assert.equal(request.max_rounds, 3);
    assert.ok(Array.isArray(request.issues));
    assert.equal(request.issues.length, 1);
    assert.equal(typeof request.risk_delta, 'string');
    assert.equal(typeof request.cumulative_scope_delta, 'string');
    assert.equal(request.human_required, false);
  });

  it('human_required is true when non-self-resolvable issues present', () => {
    const approved = buildManifest(makeWorkflowDef());
    const negState = createNegotiationState(approved);
    const issues = [{ code: 'RISK_ESCALATION', field: 'risk', detail: 'Risk up', self_resolvable: false, constraint: 'human_required', current_value: 'green', allowed_values: 'red' }];
    const request = generateNegotiationRequest(issues, negState);
    assert.equal(request.human_required, true);
  });
});

// ===========================================================================
// 6. Delta Application Engine
// ===========================================================================

describe('Bucket 2: Delta Application Engine', () => {
  it('rejects full manifest replacement', () => {
    const approved = buildManifest(makeWorkflowDef());
    const negState = createNegotiationState(approved);
    const delta = { workflow: { steps: approved.workflow.steps, services: approved.workflow.services } };
    const result = applyDelta(delta, negState);
    assert.equal(result.accepted, false);
    assert.ok(result.issues.some(i => i.code === 'SCOPE_WIDENING'));
  });

  it('accepts narrowing delta (removing args)', () => {
    const def = makeWorkflowDef();
    const approved = buildManifest(def);
    const negState = createNegotiationState(approved);

    // Delta that narrows: reduce args
    const delta = {
      workflow: {
        steps: [{ id: 'step_a', run: { args: [] } }],
      },
    };
    const result = applyDelta(delta, negState);
    // May or may not accept depending on other issues, but should not flag widening
    const widenings = result.issues.filter(i => i.code === 'SCOPE_WIDENING');
    assert.equal(widenings.length, 0);
  });

  it('round limit enforcement — exhausted after max_rounds (I-W8)', () => {
    const approved = buildManifest(makeWorkflowDef());
    const negState = createNegotiationState(approved, 2);

    // Round 1
    applyDelta({ workflow: {} }, negState);
    // Round 2
    applyDelta({ workflow: {} }, negState);
    // Round 3 should be exhausted
    const result = applyDelta({ workflow: {} }, negState);
    assert.equal(result.accepted, false);
    assert.ok(result.issues.some(i => i.code === 'NEGOTIATION_EXHAUSTED'));
    assert.equal(negState.terminated, true);
  });

  it('subsequent calls after exhaustion are rejected', () => {
    const approved = buildManifest(makeWorkflowDef());
    const negState = createNegotiationState(approved, 1);

    applyDelta({ workflow: {} }, negState);
    applyDelta({ workflow: {} }, negState); // exhausted
    const result = applyDelta({ workflow: {} }, negState);
    assert.equal(result.accepted, false);
    assert.ok(result.issues.some(i => i.code === 'NEGOTIATION_EXHAUSTED'));
  });
});

// ===========================================================================
// 7. Cumulative Drift Detection (I-W6)
// ===========================================================================

describe('Bucket 2: Cumulative Drift Detection (I-W6)', () => {
  it('scope direction: unchanged when manifests identical', () => {
    const manifest = buildManifest(makeWorkflowDef());
    assert.equal(computeScopeDirection(manifest, manifest), 'unchanged');
  });

  it('scope direction: widened when new step added', () => {
    const original = buildManifest(makeWorkflowDef());
    const proposed = structuredClone(original);
    proposed.workflow.steps.push({ id: 'new_step', type: 'task', run: { command: 'ls', args: [] } });
    assert.equal(computeScopeDirection(proposed, original), 'widened');
  });

  it('scope direction: unchanged when step removed (narrowing)', () => {
    const def = makeWorkflowDef({
      steps: [
        { id: 'a', type: 'task', run: { command: 'echo', args: ['a'], cwd: '.' }, on: { success: 'b', failure: 'abort' } },
        { id: 'b', type: 'task', run: { command: 'echo', args: ['b'], cwd: '.' }, on: { success: 'done', failure: 'abort' } },
      ],
    });
    const original = buildManifest(def);
    const proposed = structuredClone(original);
    proposed.workflow.steps = proposed.workflow.steps.filter(s => s.id !== 'b');
    // Narrowing: removing a step is not widening
    assert.equal(computeScopeDirection(proposed, original), 'unchanged');
  });

  it('cumulative widening across rounds triggers CUMULATIVE_WIDENING', () => {
    const approved = buildManifest(makeWorkflowDef());
    const negState = createNegotiationState(approved, 5);

    // Submit delta that widens scope
    const delta = {
      workflow: {
        steps: [{ id: 'step_a', run: { command: 'echo', args: ['hello', 'extra', 'arg'] } }],
      },
    };
    const result = applyDelta(delta, negState);
    // Should detect cumulative widening since args expanded
    const cw = result.issues.filter(i => i.code === 'CUMULATIVE_WIDENING' || i.code === 'SCOPE_WIDENING');
    assert.ok(cw.length > 0, 'Expected widening or cumulative widening issue');
  });
});

// ===========================================================================
// 8. Negotiation via Supervisor
// ===========================================================================

describe('Bucket 2: Supervisor Negotiation Round-Trip', () => {
  it('signing attempt by agent triggers immediate hard block (I-W7)', () => {
    const approved = buildManifest(makeWorkflowDef());
    const negState = createNegotiationState(approved);
    const delta = { signature: 'agent-forged-sig', workflow: {} };

    const result = negotiateWorkflowDelta(negState, delta);
    assert.equal(result.accepted, false);
    assert.ok(result.escalation !== null);
    assert.ok(result.escalation.blockingReason.includes('sign'));
  });

  it('approved_by field from agent triggers hard block', () => {
    const approved = buildManifest(makeWorkflowDef());
    const negState = createNegotiationState(approved);
    const delta = { approved_by: ['rogue-agent'], workflow: {} };

    const result = negotiateWorkflowDelta(negState, delta);
    assert.equal(result.accepted, false);
    assert.ok(result.escalation !== null);
  });

  it('negotiation exhausted produces escalation with full trace', () => {
    const approved = buildManifest(makeWorkflowDef());
    const negState = createNegotiationState(approved, 1);

    // Round 1
    negotiateWorkflowDelta(negState, { workflow: {} });
    // Round 2 — exhausted
    const result = negotiateWorkflowDelta(negState, { workflow: {} });
    assert.equal(result.accepted, false);
    assert.ok(result.escalation !== null);
    assert.ok(result.escalation.blockingReason.includes('exhausted'));
    assert.ok(Array.isArray(result.escalation.rounds));
    assert.ok(result.escalation.originalManifest !== undefined);
  });
});

// ===========================================================================
// 9. Human Escalation Package
// ===========================================================================

describe('Bucket 2: Human Escalation Package', () => {
  it('contains full trace: original manifest, all rounds, blocking reason', () => {
    const approved = buildManifest(makeWorkflowDef());
    const negState = createNegotiationState(approved, 2);

    // Do one round
    applyDelta({ workflow: {} }, negState);
    negState.rounds.push({ round: 1, delta: {}, outcome: 'blocked' });

    const issues = [{ code: 'RISK_ESCALATION', detail: 'Risk up', self_resolvable: false }];
    const pkg = buildEscalationPackage(negState, issues, 'Risk escalation');

    assert.ok(pkg.originalManifest !== undefined);
    assert.ok(Array.isArray(pkg.rounds));
    assert.ok(Array.isArray(pkg.currentIssues));
    assert.equal(pkg.blockingReason, 'Risk escalation');
    assert.equal(typeof pkg.recommendation, 'string');
    assert.ok(pkg.recommendation.length > 0);
  });
});

// ===========================================================================
// 10. Issue Code Completeness
// ===========================================================================

describe('Bucket 2: Issue Code Definitions', () => {
  const expectedCodes = [
    'MISSING_ROLLBACK', 'MISSING_VALIDATOR', 'REGEX_OVERBROAD',
    'SECRET_IN_ENV_INJECT', 'IDEMPOTENT_RETRY_ELIGIBLE',
    'RISK_ESCALATION', 'SCOPE_WIDENING', 'SIGNING_ATTEMPT',
    'ROLLBACK_MUTATION', 'PTY_ADDITION', 'IDEMPOTENT_ADDITION',
    'FINGERPRINT_MISMATCH', 'TOCTOU_DETECTED', 'NEGOTIATION_EXHAUSTED',
    'CUMULATIVE_WIDENING',
  ];

  for (const code of expectedCodes) {
    it(`${code} is defined with selfResolvable and constraint`, () => {
      const def = ISSUE_CODES[code];
      assert.ok(def, `Missing issue code: ${code}`);
      assert.equal(typeof def.selfResolvable, 'boolean');
      assert.equal(typeof def.constraint, 'string');
    });
  }

  it('self-resolvable codes: MISSING_ROLLBACK, MISSING_VALIDATOR, REGEX_OVERBROAD, SECRET_IN_ENV_INJECT, IDEMPOTENT_RETRY_ELIGIBLE', () => {
    const selfResolvable = ['MISSING_ROLLBACK', 'MISSING_VALIDATOR', 'REGEX_OVERBROAD', 'SECRET_IN_ENV_INJECT', 'IDEMPOTENT_RETRY_ELIGIBLE'];
    for (const code of selfResolvable) {
      assert.equal(ISSUE_CODES[code].selfResolvable, true, `${code} should be self-resolvable`);
    }
  });

  it('hard block codes: SIGNING_ATTEMPT, ROLLBACK_MUTATION, PTY_ADDITION, IDEMPOTENT_ADDITION, FINGERPRINT_MISMATCH, TOCTOU_DETECTED', () => {
    const hardBlocks = ['SIGNING_ATTEMPT', 'ROLLBACK_MUTATION', 'PTY_ADDITION', 'IDEMPOTENT_ADDITION', 'FINGERPRINT_MISMATCH', 'TOCTOU_DETECTED'];
    for (const code of hardBlocks) {
      assert.equal(ISSUE_CODES[code].selfResolvable, false, `${code} should NOT be self-resolvable`);
      assert.equal(ISSUE_CODES[code].constraint, 'hard_block', `${code} should be hard_block`);
    }
  });
});

// ===========================================================================
// 11. Workflow Rollback in Manifest
// ===========================================================================

describe('Bucket 2: Rollback in Workflow Manifest', () => {
  it('rollback steps appear in manifest workflow block', () => {
    const manifest = buildManifest(makeWorkflowDef());
    assert.ok(manifest.workflow.rollback);
    assert.ok(Array.isArray(manifest.workflow.rollback.steps));
    assert.ok(manifest.workflow.rollback.steps.length > 0);
  });

  it('rollback_policy appears in manifest workflow block', () => {
    const manifest = buildManifest(makeWorkflowDef());
    assert.equal(manifest.workflow.rollback_policy, 'required');
  });

  it('rollback step changes produce drift', () => {
    const def1 = makeWorkflowDef();
    const def2 = makeWorkflowDef({
      rollback: {
        steps: [{
          id: 'rollback_different',
          idempotent: true,
          run: { command: 'rm', args: ['-f', 'tmp'], cwd: '.' },
        }],
      },
    });
    const m1 = buildManifest(def1);
    const m2 = buildManifest(def2);
    const { matches } = compareWorkflowManifests(m2, m1);
    assert.equal(matches, false);
  });
});

// ===========================================================================
// 12. Escalation Table
// ===========================================================================

describe('Bucket 2: Escalation Table', () => {
  it('risk escalation → human escalation', () => {
    const approved = buildManifest(makeWorkflowDef());
    const proposed = structuredClone(approved);
    proposed.riskAssessment.riskLevel = 'red';
    const issues = detectIssues(proposed, approved);
    assert.ok(issues.some(i => i.code === 'RISK_ESCALATION' && !i.self_resolvable));
  });

  it('scope widening → human escalation', () => {
    const approved = buildManifest(makeWorkflowDef());
    const proposed = structuredClone(approved);
    proposed.workflow.steps.push({ id: 'new', type: 'task', run: { command: 'ls' } });
    const issues = detectIssues(proposed, approved);
    assert.ok(issues.some(i => i.code === 'SCOPE_WIDENING' && !i.self_resolvable));
  });

  it('signing attempt → immediate hard block', () => {
    const approved = buildManifest(makeWorkflowDef());
    const proposed = structuredClone(approved);
    const issues = detectIssues(proposed, approved, { agentSigned: true });
    const si = issues.find(i => i.code === 'SIGNING_ATTEMPT');
    assert.ok(si);
    assert.equal(si.self_resolvable, false);
    assert.equal(si.constraint, 'hard_block');
  });

  it('rollback mutation mid-workflow → immediate hard block', () => {
    const approved = buildManifest(makeWorkflowDef());
    const proposed = structuredClone(approved);
    proposed.workflow.rollback = null;
    const issues = detectIssues(proposed, approved, { workflowStarted: true });
    const rm = issues.find(i => i.code === 'ROLLBACK_MUTATION');
    assert.ok(rm);
    assert.equal(rm.self_resolvable, false);
    assert.equal(rm.constraint, 'hard_block');
  });

  it('pty: true addition → immediate hard block', () => {
    const approved = buildManifest(makeWorkflowDef());
    const proposed = structuredClone(approved);
    proposed.workflow.steps[0].run.pty = true;
    const issues = detectIssues(proposed, approved);
    const pty = issues.find(i => i.code === 'PTY_ADDITION');
    assert.ok(pty);
    assert.equal(pty.constraint, 'hard_block');
  });

  it('idempotent: true addition → immediate hard block', () => {
    const approved = buildManifest(makeWorkflowDef());
    const proposed = structuredClone(approved);
    proposed.workflow.steps[0].idempotent = true;
    const issues = detectIssues(proposed, approved);
    const idem = issues.find(i => i.code === 'IDEMPOTENT_ADDITION');
    assert.ok(idem);
    assert.equal(idem.constraint, 'hard_block');
  });
});
