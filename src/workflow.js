import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { serializeStable, checkRegexSafety } from './contract.js';
import { deepEqual, pretty, indexById, resolvePath } from './shared.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TERMINAL_STATES = new Set(['done', 'abort']);

const WORKFLOW_MANIFEST_VERSION = 2;

const VALID_STEP_TYPES = new Set([
  'task',
  'service_start',
  'service_stop',
  'service_restart',
]);

const SERVICE_STEP_TYPES = new Set([
  'service_start',
  'service_stop',
  'service_restart',
]);

const RUN_DEFAULTS = { mode: 'structured', timeoutMs: 60000 };
const STEP_DEFAULTS = { validator: 'exit_code', updateSource: 'none' };

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

class WorkflowValidationError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'WorkflowValidationError';
    this.errors = errors ?? [message];
  }
}

// ---------------------------------------------------------------------------
// Pure validation functions — each returns an array of error strings
// ---------------------------------------------------------------------------

function validateTopLevel(def) {
  const errors = [];
  if (def.version !== 1) {
    errors.push(`version must be 1, got ${JSON.stringify(def.version)}`);
  }
  if (def.kind !== 'workflow_definition') {
    errors.push(`kind must be "workflow_definition", got ${JSON.stringify(def.kind)}`);
  }
  if (typeof def.name !== 'string' || def.name.trim() === '') {
    errors.push(`name must be a non-empty string, got ${JSON.stringify(def.name)}`);
  }
  if (def.maxIterations !== undefined) {
    if (!Number.isInteger(def.maxIterations) || def.maxIterations < 1) {
      errors.push(`maxIterations must be a positive integer, got ${JSON.stringify(def.maxIterations)}`);
    }
  }
  if (!Array.isArray(def.services)) errors.push('services must be an array');
  if (!Array.isArray(def.steps)) errors.push('steps must be an array');
  return errors;
}

function collectUniqueIds(items, label) {
  const errors = [];
  const ids = new Set();
  for (const item of items) {
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      errors.push(`every ${label} must have a non-empty string id`);
      continue;
    }
    if (ids.has(item.id)) {
      errors.push(`duplicate ${label} id: ${JSON.stringify(item.id)}`);
    }
    ids.add(item.id);
  }
  return { ids, errors };
}

function validateEntryStep(entryStep, stepIds) {
  if (typeof entryStep !== 'string' || entryStep.trim() === '') {
    return [`entryStep must be a non-empty string, got ${JSON.stringify(entryStep)}`];
  }
  if (!stepIds.has(entryStep)) {
    return [`entryStep ${JSON.stringify(entryStep)} does not reference a declared step`];
  }
  return [];
}

function validateStepBody(step, serviceIds) {
  const errors = [];
  const prefix = `step ${JSON.stringify(step.id)}`;

  if (!VALID_STEP_TYPES.has(step.type)) {
    errors.push(`${prefix}: type must be one of ${[...VALID_STEP_TYPES].join(', ')}, got ${JSON.stringify(step.type)}`);
    return errors;
  }

  if (SERVICE_STEP_TYPES.has(step.type)) {
    if (typeof step.serviceId !== 'string' || step.serviceId.trim() === '') {
      errors.push(`${prefix}: steps of type ${JSON.stringify(step.type)} must have a serviceId`);
    } else if (!serviceIds.has(step.serviceId)) {
      errors.push(`${prefix}: serviceId ${JSON.stringify(step.serviceId)} does not reference a declared service`);
    }
  }

  if (step.type === 'task') {
    if (!step.run || typeof step.run !== 'object' || Array.isArray(step.run)) {
      errors.push(`${prefix}: steps of type "task" must have a run block`);
    } else if (typeof step.run.command !== 'string' || step.run.command.trim() === '') {
      errors.push(`${prefix}: run.command must be a non-empty string`);
    }
  }

  return errors;
}

function validateStepTransitions(step, stepIds) {
  const errors = [];
  const prefix = `step ${JSON.stringify(step.id)}`;

  if (!step.on || typeof step.on !== 'object' || Array.isArray(step.on)) {
    return [`${prefix}: must have an on block`];
  }

  if (typeof step.on.success !== 'string') {
    errors.push(`${prefix}: on.success is required`);
  }

  const failureKeys = Object.keys(step.on).filter(k => k !== 'success');
  if (failureKeys.length === 0) {
    errors.push(`${prefix}: on block must have at least one failure path (e.g. failure, validation_failed)`);
  }

  for (const [key, target] of Object.entries(step.on)) {
    if (typeof target !== 'string') {
      errors.push(`${prefix}: on.${key} must be a string, got ${JSON.stringify(target)}`);
    } else if (!stepIds.has(target) && !TERMINAL_STATES.has(target)) {
      errors.push(`${prefix}: on.${key} target ${JSON.stringify(target)} does not reference a declared step or terminal state (done, abort)`);
    }
  }

  return errors;
}

function validateWorkflowDefinition(def) {
  const errors = [
    ...validateTopLevel(def),
  ];

  const services = Array.isArray(def.services) ? def.services : [];
  const steps = Array.isArray(def.steps) ? def.steps : [];

  const svcResult = collectUniqueIds(services, 'service');
  const stepResult = collectUniqueIds(steps, 'step');
  errors.push(...svcResult.errors, ...stepResult.errors);

  errors.push(...validateEntryStep(def.entryStep, stepResult.ids));

  for (const step of steps) {
    if (typeof step.id !== 'string' || step.id.trim() === '') continue;
    errors.push(...validateStepBody(step, svcResult.ids));
    errors.push(...validateStepTransitions(step, stepResult.ids));
  }

  // ReDoS safety check: reject any validator regex with catastrophic backtracking potential
  for (const step of steps) {
    if (step.validator?.regex) {
      const safety = checkRegexSafety(step.validator.regex);
      if (!safety.safe) {
        errors.push(`step ${JSON.stringify(step.id)}: validator regex rejected — ${safety.reason}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new WorkflowValidationError(
      `Workflow definition validation failed:\n  - ${errors.join('\n  - ')}`,
      errors,
    );
  }
}

// ---------------------------------------------------------------------------
// Lint — intent-level warnings (non-blocking, advisory)
// ---------------------------------------------------------------------------

const FAILURE_OUTCOMES = new Set([
  'failure', 'validation_failed', 'error', 'timeout',
]);

function lintFailureToSuccessTransitions(steps) {
  const warnings = [];
  for (const step of steps) {
    if (!step.on || typeof step.on !== 'object') continue;
    for (const [outcome, target] of Object.entries(step.on)) {
      if (FAILURE_OUTCOMES.has(outcome) && target === 'done') {
        warnings.push(
          `step "${step.id}": ${outcome} → done will report workflow success on failure. ` +
          `Use "abort" if a failed step should fail the workflow.`,
        );
      }
    }
  }
  return warnings;
}

function lintUnreachableSteps(entryStep, steps) {
  const warnings = [];
  const reachable = new Set();
  const queue = [entryStep];

  while (queue.length > 0) {
    const id = queue.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    const step = steps.find(s => s.id === id);
    if (!step?.on) continue;
    for (const target of Object.values(step.on)) {
      if (typeof target === 'string' && target !== 'done' && target !== 'abort') {
        queue.push(target);
      }
    }
  }

  for (const step of steps) {
    if (!reachable.has(step.id)) {
      warnings.push(`step "${step.id}" is unreachable from entry step "${entryStep}".`);
    }
  }
  return warnings;
}

/**
 * Lint a validated workflow definition for intent-level issues.
 * Returns an array of warning strings. These are advisory — they don't
 * block execution but indicate likely mistakes in the workflow design.
 *
 * @param {object} def - A validated workflow definition.
 * @returns {string[]} Warning messages.
 */
export function lintWorkflowDefinition(def) {
  const steps = Array.isArray(def.steps) ? def.steps : [];
  return [
    ...lintFailureToSuccessTransitions(steps),
    ...lintUnreachableSteps(def.entryStep, steps),
  ];
}

// ---------------------------------------------------------------------------
// Pure normalization functions
// ---------------------------------------------------------------------------

function normalizeRunBlock(run, projectRoot) {
  if (!run) return undefined;
  const normalized = {
    ...run,
    mode: run.mode ?? RUN_DEFAULTS.mode,
    timeoutMs: run.timeoutMs ?? RUN_DEFAULTS.timeoutMs,
    cwd: resolvePath(run.cwd ?? '.', projectRoot),
    args: run.args ?? [],
  };
  // Normalize envPolicy to a full shape. Workflow steps default to inherit=true
  // (unlike single-command contracts which default to inherit=false) because
  // workflow adapter scripts typically need the caller's env vars.
  const env = normalized.envPolicy ?? {};
  normalized.envPolicy = {
    inherit: env.inherit ?? true,
    allow:   Array.isArray(env.allow) ? env.allow : [],
    inject:  (env.inject && typeof env.inject === 'object') ? env.inject : {},
  };
  return normalized;
}

function normalizeService(svc, projectRoot) {
  const normalized = { ...svc };
  if (svc.start) {
    normalized.start = normalizeRunBlock(svc.start, projectRoot);
  }
  return normalized;
}

function normalizeStep(step, projectRoot) {
  return {
    ...step,
    validator: step.validator ?? STEP_DEFAULTS.validator,
    updateSource: step.updateSource ?? STEP_DEFAULTS.updateSource,
    run: step.run ? normalizeRunBlock(step.run, projectRoot) : step.run,
  };
}

// ---------------------------------------------------------------------------
// Pure diff functions
// ---------------------------------------------------------------------------

function diffTopLevelFields(cWf, aWf) {
  const diffs = [];
  if (cWf.entryStep !== aWf.entryStep) {
    diffs.push(`~ entryStep: ${pretty(aWf.entryStep)} -> ${pretty(cWf.entryStep)}`);
  }
  if (cWf.maxIterations !== aWf.maxIterations) {
    diffs.push(`~ maxIterations: ${pretty(aWf.maxIterations)} -> ${pretty(cWf.maxIterations)}`);
  }
  return diffs;
}

function diffServiceBlock(id, cBlock, aBlock, blockName) {
  const diffs = [];
  const allKeys = new Set([...Object.keys(aBlock ?? {}), ...Object.keys(cBlock ?? {})]);
  for (const field of allKeys) {
    if (!deepEqual(cBlock?.[field], aBlock?.[field])) {
      diffs.push(`~ Service ${id} ${blockName}.${field}: ${pretty(aBlock?.[field])} -> ${pretty(cBlock?.[field])}`);
    }
  }
  return diffs;
}

function diffServices(cServices, aServices) {
  const diffs = [];
  const cMap = indexById(cServices);
  const aMap = indexById(aServices);

  for (const id of aMap.keys()) {
    if (!cMap.has(id)) diffs.push(`- Remove service: ${id}`);
  }
  for (const id of cMap.keys()) {
    if (!aMap.has(id)) diffs.push(`+ Add service: ${id}`);
  }

  for (const [id, cSvc] of cMap) {
    const aSvc = aMap.get(id);
    if (!aSvc) continue;
    if (!deepEqual(cSvc.start, aSvc.start)) diffs.push(...diffServiceBlock(id, cSvc.start, aSvc.start, 'start'));
    if (!deepEqual(cSvc.stop, aSvc.stop)) diffs.push(...diffServiceBlock(id, cSvc.stop, aSvc.stop, 'stop'));
  }

  return diffs;
}

function diffStepFields(id, cStep, aStep) {
  const diffs = [];

  if (cStep.type !== aStep.type) {
    diffs.push(`~ Step ${id} type: ${pretty(aStep.type)} -> ${pretty(cStep.type)}`);
  }

  if (cStep.serviceId !== aStep.serviceId && (cStep.serviceId !== undefined || aStep.serviceId !== undefined)) {
    diffs.push(`~ Step ${id} serviceId: ${pretty(aStep.serviceId)} -> ${pretty(cStep.serviceId)}`);
  }

  if (!deepEqual(cStep.run, aStep.run)) {
    const allKeys = new Set([...Object.keys(aStep.run ?? {}), ...Object.keys(cStep.run ?? {})]);
    for (const field of allKeys) {
      if (!deepEqual(cStep.run?.[field], aStep.run?.[field])) {
        diffs.push(`~ Step ${id} ${field}: ${pretty(aStep.run?.[field])} -> ${pretty(cStep.run?.[field])}`);
      }
    }
  }

  if (cStep.validator !== aStep.validator) {
    diffs.push(`~ Step ${id} validator: ${pretty(aStep.validator)} -> ${pretty(cStep.validator)}`);
  }
  if (cStep.updateSource !== aStep.updateSource) {
    diffs.push(`~ Step ${id} updateSource: ${pretty(aStep.updateSource)} -> ${pretty(cStep.updateSource)}`);
  }

  return diffs;
}

function diffStepTransitions(id, cOn, aOn) {
  const diffs = [];
  const allKeys = new Set([...Object.keys(cOn ?? {}), ...Object.keys(aOn ?? {})]);

  for (const key of allKeys) {
    if (cOn?.[key] !== aOn?.[key]) {
      if (!(key in (aOn ?? {}))) {
        diffs.push(`+ Transition ${id}.${key}: ${pretty(cOn[key])}`);
      } else if (!(key in (cOn ?? {}))) {
        diffs.push(`- Transition ${id}.${key}: ${pretty(aOn[key])}`);
      } else {
        diffs.push(`~ Transition ${id}.${key}: ${pretty(aOn[key])} -> ${pretty(cOn[key])}`);
      }
    }
  }

  return diffs;
}

function diffSteps(cSteps, aSteps) {
  const diffs = [];
  const cMap = indexById(cSteps);
  const aMap = indexById(aSteps);

  for (const id of aMap.keys()) {
    if (!cMap.has(id)) diffs.push(`- Remove step: ${id}`);
  }
  for (const id of cMap.keys()) {
    if (!aMap.has(id)) diffs.push(`+ Add step: ${id}`);
  }

  for (const [id, cStep] of cMap) {
    const aStep = aMap.get(id);
    if (!aStep) continue;
    diffs.push(...diffStepFields(id, cStep, aStep));
    if (!deepEqual(cStep.on, aStep.on)) {
      diffs.push(...diffStepTransitions(id, cStep.on, aStep.on));
    }
  }

  return diffs;
}

function diffRiskAssessment(cRisk, aRisk) {
  const diffs = [];
  if (cRisk.trustClass !== aRisk.trustClass) {
    diffs.push(`~ riskAssessment.trustClass: ${pretty(aRisk.trustClass)} -> ${pretty(cRisk.trustClass)}`);
  }
  if (cRisk.riskLevel !== aRisk.riskLevel) {
    diffs.push(`~ riskAssessment.riskLevel: ${pretty(aRisk.riskLevel)} -> ${pretty(cRisk.riskLevel)}`);
  }
  if (!deepEqual(cRisk.reasons, aRisk.reasons)) {
    diffs.push(`~ riskAssessment.reasons: ${pretty(aRisk.reasons)} -> ${pretty(cRisk.reasons)}`);
  }
  if (cRisk.requiresStrongConfirmation !== aRisk.requiresStrongConfirmation) {
    diffs.push(`~ riskAssessment.requiresStrongConfirmation: ${pretty(aRisk.requiresStrongConfirmation)} -> ${pretty(cRisk.requiresStrongConfirmation)}`);
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadWorkflowDefinition(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read workflow definition at ${filePath}: ${err.message}`);
  }

  let def;
  try {
    def = JSON.parse(raw);
  } catch (parseErr) {
    throw new Error(`Invalid JSON in workflow definition at ${filePath}: ${parseErr.message}`);
  }

  validateWorkflowDefinition(def);
  return def;
}

export function normalizeWorkflowDefinition(definition, basePath) {
  const projectRoot = resolvePath(definition.projectRoot ?? '.', basePath);

  const services = (definition.services ?? [])
    .map(svc => normalizeService(svc, projectRoot))
    .sort((a, b) => a.id.localeCompare(b.id));

  const steps = (definition.steps ?? [])
    .map(step => normalizeStep(step, projectRoot))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    version: definition.version,
    kind: definition.kind,
    name: definition.name,
    projectRoot,
    entryStep: definition.entryStep,
    maxIterations: definition.maxIterations ?? 10,
    services,
    steps,
  };
}

export function hashWorkflow(normalizedWorkflow) {
  const hashable = {
    name: normalizedWorkflow.name,
    entryStep: normalizedWorkflow.entryStep,
    maxIterations: normalizedWorkflow.maxIterations,
    services: normalizedWorkflow.services,
    steps: normalizedWorkflow.steps,
  };
  return createHash('sha256').update(serializeStable(hashable)).digest('hex');
}

export function createWorkflowManifest(normalizedWorkflow, workflowHash, riskAssessment, projectRoot) {
  return {
    version: WORKFLOW_MANIFEST_VERSION,
    tool: 'guardrail',
    kind: 'workflow',
    approvedAt: new Date().toISOString(),
    projectRoot,
    workflowHash,
    workflow: {
      name: normalizedWorkflow.name,
      entryStep: normalizedWorkflow.entryStep,
      maxIterations: normalizedWorkflow.maxIterations,
      services: normalizedWorkflow.services,
      steps: normalizedWorkflow.steps,
    },
    riskAssessment: {
      trustClass:                 riskAssessment.trustClass   ?? 'unknown',
      riskLevel:                  riskAssessment.riskLevel    ?? 'red',
      reasons:                    riskAssessment.reasons      ?? [],
      requiresStrongConfirmation: riskAssessment.requiresStrongConfirmation ?? false,
      acknowledgedBy:             riskAssessment.acknowledgedBy ?? null,
      acknowledgedAt:             riskAssessment.acknowledgedAt ?? null,
    },
  };
}

export function diffWorkflowManifests(candidate, approved) {
  const cWf = candidate.workflow ?? {};
  const aWf = approved.workflow ?? {};

  return [
    ...(candidate.projectRoot !== approved.projectRoot
      ? [`~ projectRoot: ${pretty(approved.projectRoot)} -> ${pretty(candidate.projectRoot)}`]
      : []),
    ...diffTopLevelFields(cWf, aWf),
    ...diffServices(cWf.services, aWf.services),
    ...diffSteps(cWf.steps, aWf.steps),
    ...diffRiskAssessment(candidate.riskAssessment ?? {}, approved.riskAssessment ?? {}),
    ...(candidate.workflowHash !== approved.workflowHash
      ? [`~ workflowHash: ${pretty(approved.workflowHash)} -> ${pretty(candidate.workflowHash)}`]
      : []),
  ];
}

export function compareWorkflowManifests(candidate, approved) {
  const diffs = diffWorkflowManifests(candidate, approved);
  return { matches: diffs.length === 0, diffs };
}
