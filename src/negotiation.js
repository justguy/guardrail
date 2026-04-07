import { createHash } from 'node:crypto';
import { serializeStable } from './contract.js';
import { deepEqual } from './shared.js';

// ---------------------------------------------------------------------------
// Issue codes and self-resolvable classification
// ---------------------------------------------------------------------------

export const ISSUE_CODES = {
  MISSING_ROLLBACK:         { selfResolvable: true,  constraint: 'must_add' },
  MISSING_VALIDATOR:        { selfResolvable: true,  constraint: 'must_add' },
  REGEX_OVERBROAD:          { selfResolvable: true,  constraint: 'narrow_only' },
  SECRET_IN_ENV_INJECT:     { selfResolvable: true,  constraint: 'refactor_to_reference' },
  IDEMPOTENT_RETRY_ELIGIBLE:{ selfResolvable: true,  constraint: 'pre_declared_only' },
  RISK_ESCALATION:          { selfResolvable: false, constraint: 'human_required' },
  SCOPE_WIDENING:           { selfResolvable: false, constraint: 'human_required' },
  SIGNING_ATTEMPT:          { selfResolvable: false, constraint: 'hard_block' },
  ROLLBACK_MUTATION:        { selfResolvable: false, constraint: 'hard_block' },
  PTY_ADDITION:             { selfResolvable: false, constraint: 'hard_block' },
  IDEMPOTENT_ADDITION:      { selfResolvable: false, constraint: 'hard_block' },
  FINGERPRINT_MISMATCH:     { selfResolvable: false, constraint: 'hard_block' },
  TOCTOU_DETECTED:          { selfResolvable: false, constraint: 'hard_block' },
  NEGOTIATION_EXHAUSTED:    { selfResolvable: false, constraint: 'hard_escalation' },
  CUMULATIVE_WIDENING:      { selfResolvable: false, constraint: 'human_required' },
};

const HARD_BLOCK_CODES = new Set(
  Object.entries(ISSUE_CODES)
    .filter(([, v]) => v.constraint === 'hard_block')
    .map(([k]) => k),
);

const RISK_ORDER = { green: 0, yellow: 1, red: 2 };

// ---------------------------------------------------------------------------
// Negotiation state
// ---------------------------------------------------------------------------

/**
 * Create a negotiation state tracker for a workflow run.
 *
 * @param {object} originalManifest - The approved manifest before negotiation.
 * @param {number} maxRounds - Maximum negotiation rounds allowed.
 * @returns {object} Negotiation state object.
 */
export function createNegotiationState(originalManifest, maxRounds = 3) {
  return {
    originalManifest: structuredClone(originalManifest),
    currentManifest:  structuredClone(originalManifest),
    round:            0,
    maxRounds,
    rounds:           [],          // { round, delta, request, outcome }
    cumulativeDelta:  null,        // Accumulated scope changes
    terminated:       false,
    terminationCode:  null,
  };
}

// ---------------------------------------------------------------------------
// Issue detection
// ---------------------------------------------------------------------------

/**
 * Detect issues in a workflow manifest that block execution.
 * Returns an array of issue objects.
 *
 * @param {object} proposed  - The proposed workflow manifest.
 * @param {object} approved  - The approved workflow manifest.
 * @param {object} [opts]    - Additional context.
 * @returns {object[]} Array of issue objects.
 */
export function detectIssues(proposed, approved, opts = {}) {
  const issues = [];
  const pWf = proposed.workflow ?? {};
  const aWf = approved.workflow ?? {};

  // Scope widening: new steps, new services, new env vars, new flags
  detectScopeChanges(pWf, aWf, issues);

  // Risk escalation
  detectRiskEscalation(proposed, approved, issues);

  // Hard blocks: signing, rollback mutation, pty, idempotent addition
  detectHardBlocks(pWf, aWf, issues, opts);

  // Self-resolvable issues
  detectSelfResolvableIssues(pWf, issues);

  return issues;
}

function detectScopeChanges(pWf, aWf, issues) {
  const pStepIds = new Set((pWf.steps ?? []).map(s => s.id));
  const aStepIds = new Set((aWf.steps ?? []).map(s => s.id));
  const pSvcIds  = new Set((pWf.services ?? []).map(s => s.id));
  const aSvcIds  = new Set((aWf.services ?? []).map(s => s.id));

  // New steps = widening
  for (const id of pStepIds) {
    if (!aStepIds.has(id)) {
      issues.push(makeIssue('SCOPE_WIDENING', `steps`, `New step "${id}" added`, null, id));
    }
  }

  // New services = widening
  for (const id of pSvcIds) {
    if (!aSvcIds.has(id)) {
      issues.push(makeIssue('SCOPE_WIDENING', `services`, `New service "${id}" added`, null, id));
    }
  }

  // Step-level widening: new args, new env vars, changed command
  for (const pStep of (pWf.steps ?? [])) {
    const aStep = (aWf.steps ?? []).find(s => s.id === pStep.id);
    if (!aStep) continue;

    const pRun = pStep.run ?? {};
    const aRun = aStep.run ?? {};

    if (pRun.command !== aRun.command) {
      issues.push(makeIssue('SCOPE_WIDENING', `steps.${pStep.id}.run.command`,
        `Command changed from "${aRun.command}" to "${pRun.command}"`, aRun.command, pRun.command));
    }

    // New args = widening (more args than approved)
    const pArgs = pRun.args ?? [];
    const aArgs = aRun.args ?? [];
    if (pArgs.length > aArgs.length) {
      issues.push(makeIssue('SCOPE_WIDENING', `steps.${pStep.id}.run.args`,
        `Args expanded from ${aArgs.length} to ${pArgs.length}`, aArgs, pArgs));
    }

    // Mode change to shell = widening
    if (pRun.mode === 'shell' && aRun.mode !== 'shell') {
      issues.push(makeIssue('SCOPE_WIDENING', `steps.${pStep.id}.run.mode`,
        'Mode changed to shell', aRun.mode, 'shell'));
    }
  }
}

function detectRiskEscalation(proposed, approved, issues) {
  const pRisk = proposed.riskAssessment?.riskLevel ?? 'red';
  const aRisk = approved.riskAssessment?.riskLevel ?? 'red';

  if ((RISK_ORDER[pRisk] ?? 2) > (RISK_ORDER[aRisk] ?? 2)) {
    issues.push(makeIssue('RISK_ESCALATION', 'riskAssessment.riskLevel',
      `Risk escalated from ${aRisk} to ${pRisk}`, aRisk, pRisk));
  }
}

function detectHardBlocks(pWf, aWf, issues, opts) {
  // PTY addition
  for (const pStep of (pWf.steps ?? [])) {
    const aStep = (aWf.steps ?? []).find(s => s.id === pStep.id);
    if (pStep.run?.pty === true && (!aStep || aStep.run?.pty !== true)) {
      issues.push(makeIssue('PTY_ADDITION', `steps.${pStep.id}.run.pty`,
        `pty: true added to step "${pStep.id}"`, false, true));
    }
  }

  // Idempotent addition (I-W4)
  for (const pStep of (pWf.steps ?? [])) {
    const aStep = (aWf.steps ?? []).find(s => s.id === pStep.id);
    if (aStep && pStep.idempotent === true && aStep.idempotent !== true) {
      issues.push(makeIssue('IDEMPOTENT_ADDITION', `steps.${pStep.id}.idempotent`,
        `idempotent: true added to step "${pStep.id}" — must be in original signed manifest`, false, true));
    }
  }

  // Rollback mutation after workflow started (I-W2)
  if (opts.workflowStarted && !deepEqual(pWf.rollback, aWf.rollback)) {
    issues.push(makeIssue('ROLLBACK_MUTATION', 'workflow.rollback',
      'Rollback section modified after workflow execution started', null, null));
  }

  // Signing attempt by agent (I-W7)
  if (opts.agentSigned) {
    issues.push(makeIssue('SIGNING_ATTEMPT', 'manifest.signature',
      'Agent attempted to sign the manifest — only humans or pre-authorized CI may sign', null, null));
  }
}

function detectSelfResolvableIssues(pWf, issues) {
  const steps = pWf.steps ?? [];

  // Missing validator
  for (const step of steps) {
    if (step.type === 'task' && !step.validator) {
      issues.push(makeIssue('MISSING_VALIDATOR', `steps.${step.id}.validator`,
        `Step "${step.id}" has no validator`, null, null));
    }
  }

  // Missing rollback for non-idempotent steps
  const hasNonIdempotent = steps.some(s => !(s.idempotent ?? false));
  if (hasNonIdempotent && !pWf.rollback?.steps?.length && pWf.rollback_policy !== 'none') {
    issues.push(makeIssue('MISSING_ROLLBACK', 'workflow.rollback',
      'Non-idempotent steps present but no rollback section', null, null));
  }
}

function makeIssue(code, field, detail, currentValue, afterValue) {
  const codeDef = ISSUE_CODES[code];
  return {
    code,
    field,
    detail,
    self_resolvable: codeDef?.selfResolvable ?? false,
    constraint:      codeDef?.constraint ?? 'human_required',
    current_value:   currentValue ?? null,
    allowed_values:  afterValue ?? null,
  };
}

// ---------------------------------------------------------------------------
// Negotiation request generation
// ---------------------------------------------------------------------------

/**
 * Generate a structured negotiation request when execution is blocked.
 *
 * @param {object[]} issues  - Detected issues.
 * @param {object}   negState - Current negotiation state.
 * @returns {object} Negotiation request per spec.
 */
export function generateNegotiationRequest(issues, negState) {
  const humanRequired = issues.some(i =>
    !i.self_resolvable || HARD_BLOCK_CODES.has(i.code),
  );

  const riskDelta = computeRiskDelta(negState);
  const scopeDelta = negState.cumulativeDelta ?? 'unchanged';

  return {
    status:                'blocked',
    trace_id:              generateTraceId(),
    round:                 negState.round,
    max_rounds:            negState.maxRounds,
    issues,
    risk_delta:            riskDelta,
    cumulative_scope_delta: scopeDelta,
    human_required:        humanRequired,
  };
}

// ---------------------------------------------------------------------------
// Delta application engine
// ---------------------------------------------------------------------------

/**
 * Apply a proposed delta to the current manifest, re-validate,
 * and determine if the change is acceptable.
 *
 * @param {object} delta    - Agent-proposed changes (partial manifest patch).
 * @param {object} negState - Current negotiation state.
 * @returns {{ accepted: boolean, issues: object[], manifest: object|null, negState: object }}
 */
export function applyDelta(delta, negState) {
  if (negState.terminated) {
    return { accepted: false, issues: [makeIssue('NEGOTIATION_EXHAUSTED', '', 'Negotiation already terminated', null, null)], manifest: null, negState };
  }

  // Full manifest replacement is rejected
  if (delta.workflow && delta.workflow.steps && delta.workflow.services) {
    return { accepted: false, issues: [makeIssue('SCOPE_WIDENING', '', 'Full manifest replacement is rejected — submit a delta', null, null)], manifest: null, negState };
  }

  negState.round += 1;

  // Round limit (I-W8)
  if (negState.round > negState.maxRounds) {
    negState.terminated = true;
    negState.terminationCode = 'NEGOTIATION_EXHAUSTED';
    const issue = makeIssue('NEGOTIATION_EXHAUSTED', '',
      `Negotiation exhausted after ${negState.maxRounds} rounds`, null, null);
    negState.rounds.push({ round: negState.round, delta, outcome: 'exhausted' });
    return { accepted: false, issues: [issue], manifest: null, negState };
  }

  // Apply delta to a copy
  const merged = mergeManifestDelta(negState.currentManifest, delta);

  // Detect issues between merged and original
  const issues = detectIssues(merged, negState.originalManifest);

  // Check cumulative scope direction
  const scopeDir = computeScopeDirection(merged, negState.originalManifest);
  negState.cumulativeDelta = scopeDir;

  if (scopeDir === 'widened') {
    issues.push(makeIssue('CUMULATIVE_WIDENING', '',
      'Cumulative changes across rounds result in net scope widening', null, null));
  }

  const hasBlocking = issues.some(i => !i.self_resolvable);
  const accepted = !hasBlocking && issues.length === 0;

  negState.rounds.push({
    round: negState.round,
    delta,
    issues: issues.length,
    outcome: accepted ? 'accepted' : 'blocked',
  });

  if (accepted) {
    negState.currentManifest = merged;
  }

  return { accepted, issues, manifest: accepted ? merged : null, negState };
}

// ---------------------------------------------------------------------------
// Scope direction computation
// ---------------------------------------------------------------------------

/**
 * Compare a proposed manifest against the original to determine
 * whether scope has narrowed, stayed unchanged, or widened.
 *
 * @param {object} proposed - Proposed manifest.
 * @param {object} original - Original approved manifest.
 * @returns {'narrowed' | 'unchanged' | 'widened'}
 */
export function computeScopeDirection(proposed, original) {
  const pWf = proposed.workflow ?? {};
  const oWf = original.workflow ?? {};

  const pStepIds = new Set((pWf.steps ?? []).map(s => s.id));
  const oStepIds = new Set((oWf.steps ?? []).map(s => s.id));
  const pSvcIds  = new Set((pWf.services ?? []).map(s => s.id));
  const oSvcIds  = new Set((oWf.services ?? []).map(s => s.id));

  let hasWidening  = false;
  let hasNarrowing = false;

  // New steps/services = widening; removed = narrowing
  for (const id of pStepIds)  { if (!oStepIds.has(id)) hasWidening = true; }
  for (const id of oStepIds)  { if (!pStepIds.has(id)) hasNarrowing = true; }
  for (const id of pSvcIds)   { if (!oSvcIds.has(id)) hasWidening = true; }
  for (const id of oSvcIds)   { if (!pSvcIds.has(id)) hasNarrowing = true; }

  // Step-level scope changes
  for (const pStep of (pWf.steps ?? [])) {
    const oStep = (oWf.steps ?? []).find(s => s.id === pStep.id);
    if (!oStep) continue;

    const pArgs = pStep.run?.args ?? [];
    const oArgs = oStep.run?.args ?? [];

    if (pArgs.length > oArgs.length) hasWidening = true;
    if (pArgs.length < oArgs.length) hasNarrowing = true;

    if (pStep.run?.command !== oStep.run?.command) hasWidening = true;
    if (pStep.run?.mode === 'shell' && oStep.run?.mode !== 'shell') hasWidening = true;
  }

  // Risk escalation = widening
  const pRisk = RISK_ORDER[proposed.riskAssessment?.riskLevel] ?? 2;
  const oRisk = RISK_ORDER[original.riskAssessment?.riskLevel] ?? 2;
  if (pRisk > oRisk) hasWidening = true;
  if (pRisk < oRisk) hasNarrowing = true;

  if (hasWidening) return 'widened';
  if (hasNarrowing) return 'unchanged'; // narrowing alone is not widening
  return 'unchanged';
}

// ---------------------------------------------------------------------------
// Human escalation package
// ---------------------------------------------------------------------------

/**
 * Build the full escalation package for human review.
 *
 * @param {object} negState     - Negotiation state with all rounds.
 * @param {object[]} issues     - Current blocking issues.
 * @param {string} blockReason  - Final blocking reason.
 * @returns {object} Escalation package.
 */
export function buildEscalationPackage(negState, issues, blockReason) {
  return {
    originalManifest: negState.originalManifest,
    rounds:           negState.rounds,
    currentIssues:    issues,
    blockingReason:   blockReason,
    cumulativeDelta:  negState.cumulativeDelta,
    recommendation:   deriveRecommendation(issues),
  };
}

function deriveRecommendation(issues) {
  const hardBlocks = issues.filter(i => HARD_BLOCK_CODES.has(i.code));
  if (hardBlocks.length > 0) {
    return `Hard block: ${hardBlocks.map(i => i.code).join(', ')}. These cannot be resolved by the agent.`;
  }
  const widenings = issues.filter(i => i.code === 'SCOPE_WIDENING' || i.code === 'CUMULATIVE_WIDENING');
  if (widenings.length > 0) {
    return 'Scope widening detected. Review the proposed changes and approve a new manifest if acceptable.';
  }
  const riskEsc = issues.filter(i => i.code === 'RISK_ESCALATION');
  if (riskEsc.length > 0) {
    return 'Risk has escalated. Review the risk assessment and approve if acceptable.';
  }
  return 'Review the blocking issues and decide whether to approve a new manifest.';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeManifestDelta(base, delta) {
  const merged = structuredClone(base);

  if (delta.workflow) {
    const dw = delta.workflow;
    if (dw.steps) {
      // Merge step-level deltas by ID (deep-merge run block)
      for (const dStep of dw.steps) {
        const idx = merged.workflow.steps.findIndex(s => s.id === dStep.id);
        if (idx >= 0) {
          const existing = merged.workflow.steps[idx];
          if (dStep.run && existing.run) {
            merged.workflow.steps[idx] = { ...existing, ...dStep, run: { ...existing.run, ...dStep.run } };
          } else {
            merged.workflow.steps[idx] = { ...existing, ...dStep };
          }
        }
        // New steps from delta are NOT added (that's widening via full replacement)
      }
    }
    if (dw.rollback !== undefined) {
      merged.workflow.rollback = dw.rollback;
    }
    if (dw.rollback_policy !== undefined) {
      merged.workflow.rollback_policy = dw.rollback_policy;
    }
  }

  // Re-hash
  if (merged.workflow) {
    const hashable = {
      name:            merged.workflow.name,
      entryStep:       merged.workflow.entryStep,
      maxIterations:   merged.workflow.maxIterations,
      services:        merged.workflow.services,
      steps:           merged.workflow.steps,
      rollback_policy: merged.workflow.rollback_policy,
      rollback:        merged.workflow.rollback,
    };
    merged.workflowHash = createHash('sha256').update(serializeStable(hashable)).digest('hex');
  }

  return merged;
}

function computeRiskDelta(negState) {
  const orig = negState.originalManifest?.riskAssessment?.riskLevel ?? 'red';
  const curr = negState.currentManifest?.riskAssessment?.riskLevel ?? 'red';
  return `${orig}→${curr}`;
}

function generateTraceId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues?.(bytes) ?? bytes.fill(0);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
