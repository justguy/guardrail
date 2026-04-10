import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, sep } from 'node:path';
import { serializeStable, checkRegexSafety } from './contract.js';
import { deepEqual, pretty, indexById, resolvePath } from './shared.js';
import {
  buildRecipeSearchDirs,
  classifyRecipeSourceRoot,
  resolveRecipeById,
  resolveInputs,
  parseRecipeSpecifier,
} from './recipe-runner.js';
import { computeRecipeEnvIntersection, hashRecipe } from './recipe.js';
import { collectRecipeInputContentHashes } from './prompt-inputs.js';
import { classifyTrust } from './recipe-channel.js';
import { normalizePathForRecipeLookup } from './recipe-index.js';
import { deriveAuthEnvRequirements } from './adapter-auth.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TERMINAL_STATES = new Set(['done', 'abort']);

const WORKFLOW_MANIFEST_VERSION = 2;

const VALID_STEP_TYPES = new Set([
  'task',
  'recipe_ref',
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
const VALID_OUTPUT_TYPES = new Set(['string', 'number', 'boolean', 'json']);
const OUTPUT_PATH_SEGMENT_RE = /^[A-Za-z0-9_]+$/;
const OUTPUT_FROM_ALLOWED_ROOTS = new Map([
  ['task', new Set(['protocolMessages', 'validationStatus', 'exitCode'])],
  ['recipe_ref', new Set(['status', 'stepsExecuted', 'reason', 'results'])],
]);
const STATE_REF_RE = /^\{\{state\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}\}$/;
const STATE_REF_TOKEN_RE = /\{\{|}}/;

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

function parseStateReference(value) {
  if (typeof value !== 'string') return { type: 'not_reference' };
  const match = value.match(STATE_REF_RE);
  if (!match) {
    if (STATE_REF_TOKEN_RE.test(value)) {
      return { type: 'malformed', value };
    }
    return { type: 'not_reference' };
  }
  const [, path] = match;
  const segments = path.split('.');
  if (segments.length !== 2 || segments.some(segment => !OUTPUT_PATH_SEGMENT_RE.test(segment))) {
    return { type: 'malformed', value };
  }
  return {
    type: 'reference',
    segments,
    producerId: segments[0],
    outputKey: segments[1],
    value,
  };
}

function parseOutputFromPath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { type: 'error', message: 'from must be a non-empty string' };
  }
  const segments = value.split('.');
  if (!segments.length || segments.some(segment => !OUTPUT_PATH_SEGMENT_RE.test(segment))) {
    return { type: 'error', message: `from path must be dot-delimited segments of [A-Za-z0-9_]` };
  }
  return { type: 'ok', segments };
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

  if (step.type === 'recipe_ref') {
    if (typeof step.recipe !== 'string' || step.recipe.trim() === '') {
      errors.push(`${prefix}: steps of type "recipe_ref" must have a recipe specifier`);
    }
    if (step.inputs !== undefined && (!step.inputs || typeof step.inputs !== 'object' || Array.isArray(step.inputs))) {
      errors.push(`${prefix}: recipe_ref inputs must be an object when provided`);
    }
  }

  return errors;
}

function validateStepOutputs(step, errors) {
  const prefix = `step ${JSON.stringify(step.id)}`;
  const { outputs } = step;

  if (outputs === undefined) return;

  if (SERVICE_STEP_TYPES.has(step.type)) {
    errors.push(`${prefix}: outputs are not supported for service steps`);
    return;
  }

  if (step.type !== 'task' && step.type !== 'recipe_ref') {
    errors.push(`${prefix}: outputs are only supported for task and recipe_ref steps`);
    return;
  }

  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
    errors.push(`${prefix}: outputs must be an object`);
    return;
  }

  const allowedFromRoots = OUTPUT_FROM_ALLOWED_ROOTS.get(step.type);

  for (const [outputKey, outputSpec] of Object.entries(outputs)) {
    if (!OUTPUT_PATH_SEGMENT_RE.test(outputKey)) {
      errors.push(`${prefix}.outputs: output key ${JSON.stringify(outputKey)} must use only [A-Za-z0-9_]`);
      continue;
    }
    if (!outputSpec || typeof outputSpec !== 'object' || Array.isArray(outputSpec)) {
      errors.push(`${prefix}.outputs.${JSON.stringify(outputKey)}: must be an object`);
      continue;
    }
    if (!VALID_OUTPUT_TYPES.has(outputSpec.type)) {
      errors.push(`${prefix}.outputs.${JSON.stringify(outputKey)}.type must be one of ${[...VALID_OUTPUT_TYPES].join(', ')}`);
    }
    const parsedFrom = parseOutputFromPath(outputSpec.from);
    if (parsedFrom.type === 'error') {
      errors.push(`${prefix}.outputs.${JSON.stringify(outputKey)}.from: ${parsedFrom.message}`);
      continue;
    }
    if (!allowedFromRoots.has(parsedFrom.segments[0])) {
      errors.push(
        `${prefix}.outputs.${JSON.stringify(outputKey)}.from has disallowed root ${JSON.stringify(parsedFrom.segments[0])}`
      );
    }
  }
}

function collectDeclaredOutputs(steps) {
  const declared = new Map();
  for (const step of steps) {
    if (typeof step.id !== 'string' || step.id.trim() === '') continue;
    const outputKeys = new Set();
    if (step.outputs && typeof step.outputs === 'object' && !Array.isArray(step.outputs)) {
      for (const key of Object.keys(step.outputs)) {
        outputKeys.add(key);
      }
    }
    declared.set(step.id, outputKeys);
  }
  return declared;
}

function validateStateReferenceGraph(steps, declaredOutputsByStep) {
  const errors = [];
  const referencesByConsumer = new Map();

  for (const step of steps) {
    if (typeof step.id !== 'string' || !step.id.trim()) continue;
    const refs = [];
    if (step.type === 'task') {
      const args = Array.isArray(step.run?.args) ? step.run.args : [];
      args.forEach((arg, index) => {
        const parsed = parseStateReference(arg);
        if (parsed.type === 'malformed') {
          errors.push(`${JSON.stringify(step.id)}.${index}: malformed state reference ${JSON.stringify(arg)}`);
        } else if (parsed.type === 'reference') {
          refs.push(parsed);
        }
      });
    }
    if (step.type === 'recipe_ref') {
      for (const [key, value] of Object.entries(step.inputs || {})) {
        if (typeof value !== 'string') continue;
        const parsed = parseStateReference(value);
        if (parsed.type === 'malformed') {
          errors.push(`${JSON.stringify(step.id)}.inputs.${key}: malformed state reference ${JSON.stringify(value)}`);
        } else if (parsed.type === 'reference') {
          refs.push(parsed);
        }
      }
    }

    for (const parsed of refs) {
      const { producerId, outputKey, value } = parsed;
      if (!declaredOutputsByStep.has(producerId)) {
        errors.push(`${JSON.stringify(step.id)}: state reference ${JSON.stringify(value)} does not reference a declared step`);
      } else if (!declaredOutputsByStep.get(producerId).has(outputKey)) {
        errors.push(`${JSON.stringify(step.id)}: state reference ${JSON.stringify(value)} does not match declared outputs on ${JSON.stringify(producerId)}`);
      }
    }
    if (refs.length > 0) {
      referencesByConsumer.set(step.id, refs.map((ref) => ref.producerId));
    }
  }

  const visited = new Set();
  const active = new Set();
  const stackPath = [];

  const dfs = (node) => {
    if (active.has(node)) {
      const start = stackPath.indexOf(node);
      const cycle = [...stackPath.slice(start), node].join(' -> ');
      errors.push(`state reference cycle detected: ${cycle}`);
      return;
    }
    if (visited.has(node)) return;

    const nextNodes = referencesByConsumer.get(node);
    if (!nextNodes || nextNodes.length === 0) {
      visited.add(node);
      return;
    }

    active.add(node);
    stackPath.push(node);
    for (const next of nextNodes) {
      dfs(next);
    }
    active.delete(node);
    stackPath.pop();
    visited.add(node);
  };

  for (const node of referencesByConsumer.keys()) {
    dfs(node);
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

function validateRollbackSection(def) {
  const errors = [];
  if (def.rollback_policy !== undefined && def.rollback_policy !== 'required' && def.rollback_policy !== 'none') {
    errors.push(`rollback_policy must be "required" or "none", got ${JSON.stringify(def.rollback_policy)}`);
  }
  if (def.rollback_policy === 'none') {
    if (typeof def.rollback_none_reason !== 'string' || def.rollback_none_reason.trim() === '') {
      errors.push('rollback_none_reason is required when rollback_policy is "none"');
    }
  }
  if (def.rollback?.steps) {
    if (!Array.isArray(def.rollback.steps)) {
      errors.push('rollback.steps must be an array');
    } else {
      const ids = new Set();
      for (const step of def.rollback.steps) {
        if (typeof step.id !== 'string' || step.id.trim() === '') {
          errors.push('every rollback step must have a non-empty string id');
          continue;
        }
        if (ids.has(step.id)) {
          errors.push(`duplicate rollback step id: ${JSON.stringify(step.id)}`);
        }
        ids.add(step.id);
        if (!step.run || typeof step.run !== 'object') {
          errors.push(`rollback step ${JSON.stringify(step.id)}: must have a run block`);
        } else if (typeof step.run.command !== 'string' || step.run.command.trim() === '') {
          errors.push(`rollback step ${JSON.stringify(step.id)}: run.command must be a non-empty string`);
        }
      }
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
    validateStepOutputs(step, errors);
  }

  errors.push(...validateRollbackSection(def));
  const declaredOutputsByStep = collectDeclaredOutputs(steps);
  errors.push(...validateStateReferenceGraph(steps, declaredOutputsByStep));

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

function lintShellMode(steps) {
  const errors = [];
  for (const step of steps) {
    if (step.run?.mode === 'shell') {
      errors.push(`step "${step.id}": mode must be "structured", got "shell"`);
    }
  }
  return errors;
}

function lintRollbackRequirement(def) {
  const steps = Array.isArray(def.steps) ? def.steps : [];
  const hasNonIdempotent = steps.some(s => (s.idempotent ?? false) === false);
  if (!hasNonIdempotent) return [];
  if (def.rollback_policy === 'none') return [];
  if (def.rollback?.steps && Array.isArray(def.rollback.steps) && def.rollback.steps.length > 0) return [];
  return ['non-idempotent step(s) present but no rollback section declared (and rollback_policy is not "none")'];
}

/**
 * Lint a validated workflow definition.
 * Returns { errors, warnings } where errors are fatal (block approval)
 * and warnings are advisory.
 *
 * @param {object} def - A validated workflow definition.
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function lintWorkflowDefinition(def) {
  const steps = Array.isArray(def.steps) ? def.steps : [];
  return {
    errors: [
      ...lintFailureToSuccessTransitions(steps),
      ...lintShellMode(steps),
      ...lintRollbackRequirement(def),
    ],
    warnings: [
      ...lintUnreachableSteps(def.entryStep, steps),
    ],
  };
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

function normalizeRecipeRefInputs(recipeInputs = {}, stepId) {
  const staticInputs = {};
  const templateInputRefs = {};

  for (const [key, value] of Object.entries(recipeInputs)) {
    const parsed = parseStateReference(value);
    if (parsed.type === 'reference') {
      templateInputRefs[key] = value;
      continue;
    }
    if (parsed.type === 'malformed') {
      throw new Error(`Workflow step "${stepId}": ${JSON.stringify(value)} is a malformed state reference in recipe inputs`);
    }
    staticInputs[key] = value;
  }

  return { staticInputs, templateInputRefs };
}

function resolveRecipeAllowUnverified(step, options = {}) {
  if (Object.prototype.hasOwnProperty.call(step, 'allow_unverified')) {
    return !!step.allow_unverified;
  }
  if (Object.prototype.hasOwnProperty.call(step, 'allowUnverified')) {
    return !!step.allowUnverified;
  }
  return options.allowUnverified === true;
}

function toPortableRelativePath(rootPath, filePath) {
  return relative(rootPath, filePath).split(sep).join('/');
}

function materializeRecipeRefForApproval(recipeRef = {}) {
  const { sourcePath, sourceRoot, ...portableRecipeRef } = recipeRef;
  return portableRecipeRef;
}

function materializeWorkflowStepsForApproval(steps = []) {
  return steps.map((step) => {
    if (step.type !== 'recipe_ref' || !step.recipeRef) return step;
    return {
      ...step,
      recipeRef: materializeRecipeRefForApproval(step.recipeRef),
    };
  });
}

export function buildWorkflowRecipeSearchDirs(projectRoot, basePath, explicitSearchDirs = [], options = {}) {
  return buildRecipeSearchDirs({
    explicitSearchDirs: explicitSearchDirs || [],
    projectRoot: resolvePath(projectRoot, basePath),
    basePath,
    includeDefaults: true,
    repoConfigPath: options.repoConfigPath,
    userConfigPath: options.userConfigPath,
    orgPolicy: options.orgPolicy,
    orgPolicyName: options.orgPolicyName,
    orgPolicyDir: options.orgPolicyDir,
  });
}

function normalizeRecipeRefStep(step, projectRoot, options = {}) {
  const searchDirs = buildWorkflowRecipeSearchDirs(
    projectRoot,
    options.basePath ?? projectRoot,
    options.recipeSearchDirs,
    options,
  );
  let resolvedRecipe;
  try {
    resolvedRecipe = resolveRecipeById(step.recipe, searchDirs);
  } catch (err) {
    throw new Error(`Workflow step "${step.id}": ${err.message}`);
  }

  const { staticInputs, templateInputRefs } = normalizeRecipeRefInputs(step.inputs || {}, step.id);

  let inputResult;
  try {
    inputResult = resolveInputs(resolvedRecipe.recipe, staticInputs, { execution_shape: 'structured' });
  } catch (err) {
    const missingTemplateReferences = Object.keys(templateInputRefs).filter((name) => !Object.prototype.hasOwnProperty.call(staticInputs, name));
    const message = err.message
      .split('\n')
      .filter((line) => {
        if (!line.startsWith('  - Missing required input: ')) return true;
        const match = line.match(/  - Missing required input: "([^"]+)"/);
        return !match || !missingTemplateReferences.includes(match[1]);
      })
      .join('\n');
    const normalizedMessage = message.trim();
    const hasOnlyHeader = normalizedMessage === 'Input validation failed:';
    if (normalizedMessage && !hasOnlyHeader) {
      throw new Error(`Workflow step "${step.id}": ${normalizedMessage}`);
    }
    inputResult = { resolved: {}, flagged: [] };
  }

  for (const refInput of Object.keys(templateInputRefs)) {
    if (!Object.prototype.hasOwnProperty.call(resolvedRecipe.recipe.inputs || {}, refInput)) {
      throw new Error(`Workflow step "${step.id}": recipe input "${refInput}" is not declared`);
    }
  }

  const { version: requestedVersion } = parseRecipeSpecifier(step.recipe);
  const recipeHash = hashRecipe(resolvedRecipe.recipe);
  const trust = classifyTrust(resolvedRecipe.recipe);
  const requiredEnv = [
    ...(resolvedRecipe.recipe.requires_env || []),
    ...deriveAuthEnvRequirements(resolvedRecipe.recipe.requires_auth || [], options.currentEnv || process.env),
  ];
  const envIntersection = computeRecipeEnvIntersection(requiredEnv, options.envAllow || []).intersection;
  const sourceRoot = resolvedRecipe.recipe._sourceRoot || dirname(resolvedRecipe.sourcePath);
  const sourceRootKind = classifyRecipeSourceRoot(sourceRoot, {
    projectRoot,
    basePath: options.basePath ?? projectRoot,
  });
  const flaggedInputs = (inputResult.flagged || []).map((entry) => ({
    key: entry.key,
    reasons: entry.reasons,
    traits: entry.traits,
    capabilities: entry.capabilities,
    neverReuse: entry.never_reuse ?? false,
  }));
  const allowUnverified = resolveRecipeAllowUnverified(step, options);

  return {
    specifier: step.recipe,
    id: resolvedRecipe.recipe.id,
    requestedVersion,
    resolvedVersion: resolvedRecipe.version,
    sourceRootKind,
    sourceLocator: `${sourceRootKind}:${toPortableRelativePath(sourceRoot, resolvedRecipe.sourcePath)}`,
    sourcePath: normalizePathForRecipeLookup(resolvedRecipe.sourcePath),
    recipeHash,
    channel: trust.channel,
    riskLevel: resolvedRecipe.recipe.risk_level,
    approvalRequired: resolvedRecipe.recipe.approval_required,
    signature: resolvedRecipe.recipe.signature ?? null,
    trust,
    allowUnverified,
    resolvedInputs: inputResult.resolved,
    flaggedInputs,
    ...(requiredEnv.length > 0 ? { envIntersection } : {}),
    ...(Object.keys(templateInputRefs).length > 0 ? { templateInputs: templateInputRefs } : {}),
    inputContentHashes: collectRecipeInputContentHashes(resolvedRecipe.recipe, inputResult.resolved, {
      cwd: projectRoot,
    }),
  };
}

function normalizeStep(step, projectRoot, options = {}) {
  const normalized = {
    ...step,
    idempotent: step.idempotent ?? false,
    validator: step.validator ?? STEP_DEFAULTS.validator,
    updateSource: step.updateSource ?? STEP_DEFAULTS.updateSource,
    run: step.run ? normalizeRunBlock(step.run, projectRoot) : step.run,
  };

  if (step.type === 'recipe_ref') {
    normalized.recipeRef = normalizeRecipeRefStep(step, projectRoot, options);
    delete normalized.recipe;
    delete normalized.inputs;
    delete normalized.run;
  }

  return normalized;
}

function normalizeRollbackStep(step, projectRoot) {
  return {
    id: step.id,
    idempotent: step.idempotent ?? true,
    run: normalizeRunBlock(step.run, projectRoot),
  };
}

function normalizeRollback(rollback, projectRoot) {
  if (!rollback?.steps || !Array.isArray(rollback.steps)) return null;
  return {
    steps: rollback.steps
      .map(step => normalizeRollbackStep(step, projectRoot))
      .sort((a, b) => a.id.localeCompare(b.id)),
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

  if (!deepEqual(cStep.recipeRef, aStep.recipeRef)) {
    diffs.push(`~ Step ${id} recipeRef: ${pretty(aStep.recipeRef)} -> ${pretty(cStep.recipeRef)}`);
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
  if (!deepEqual(cStep.outputs, aStep.outputs)) {
    diffs.push(`~ Step ${id} outputs: ${pretty(aStep.outputs)} -> ${pretty(cStep.outputs)}`);
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
    diffs.push(...diffRecipeRefTrustBoundary(id, cStep.recipeRef, aStep.recipeRef));
    diffs.push(...diffStepFields(id, cStep, aStep));
    if (!deepEqual(cStep.on, aStep.on)) {
      diffs.push(...diffStepTransitions(id, cStep.on, aStep.on));
    }
  }

  return diffs;
}

function diffRecipeRefTrustBoundary(stepId, cRecipeRef = {}, aRecipeRef = {}) {
  const diffs = [];

  const cTrust = cRecipeRef.trust ?? {};
  const aTrust = aRecipeRef.trust ?? {};

  if (cRecipeRef.channel !== aRecipeRef.channel) {
    diffs.push(`~ Step ${stepId} recipeRef.channel: ${pretty(aRecipeRef.channel)} -> ${pretty(cRecipeRef.channel)}`);
  }
  if (cRecipeRef.signature !== aRecipeRef.signature) {
    diffs.push(`~ Step ${stepId} recipeRef.signature: ${pretty(aRecipeRef.signature)} -> ${pretty(cRecipeRef.signature)}`);
  }
  if (cTrust.channel !== aTrust.channel) {
    diffs.push(`~ Step ${stepId} recipeRef.trust.channel: ${pretty(aTrust.channel)} -> ${pretty(cTrust.channel)}`);
  }
  if (cTrust.verified !== aTrust.verified) {
    diffs.push(`~ Step ${stepId} recipeRef.trust.verified: ${pretty(aTrust.verified)} -> ${pretty(cTrust.verified)}`);
  }
  if (cRecipeRef.allowUnverified !== aRecipeRef.allowUnverified) {
    diffs.push(`~ Step ${stepId} recipeRef.allowUnverified: ${pretty(aRecipeRef.allowUnverified)} -> ${pretty(cRecipeRef.allowUnverified)}`);
  }
  if (cRecipeRef.sourceRootKind !== aRecipeRef.sourceRootKind) {
    diffs.push(`~ Step ${stepId} recipeRef.sourceRootKind: ${pretty(aRecipeRef.sourceRootKind)} -> ${pretty(cRecipeRef.sourceRootKind)}`);
  }
  if (cRecipeRef.sourceLocator !== aRecipeRef.sourceLocator) {
    diffs.push(`~ Step ${stepId} recipeRef.sourceLocator: ${pretty(aRecipeRef.sourceLocator)} -> ${pretty(cRecipeRef.sourceLocator)}`);
  }

  return diffs;
}

function diffRollback(cRollback, aRollback) {
  const diffs = [];
  const cSteps = cRollback?.steps ?? [];
  const aSteps = aRollback?.steps ?? [];
  const cMap = indexById(cSteps);
  const aMap = indexById(aSteps);

  for (const id of aMap.keys()) {
    if (!cMap.has(id)) diffs.push(`- Remove rollback step: ${id}`);
  }
  for (const id of cMap.keys()) {
    if (!aMap.has(id)) diffs.push(`+ Add rollback step: ${id}`);
  }
  for (const [id, cStep] of cMap) {
    const aStep = aMap.get(id);
    if (!aStep) continue;
    if (!deepEqual(cStep.run, aStep.run)) {
      diffs.push(`~ Rollback step ${id} run block changed`);
    }
    if (cStep.idempotent !== aStep.idempotent) {
      diffs.push(`~ Rollback step ${id} idempotent: ${pretty(aStep.idempotent)} -> ${pretty(cStep.idempotent)}`);
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

export function normalizeWorkflowDefinition(definition, basePath, options = {}) {
  const projectRoot = resolvePath(definition.projectRoot ?? '.', basePath);

  const services = (definition.services ?? [])
    .map(svc => normalizeService(svc, projectRoot))
    .sort((a, b) => a.id.localeCompare(b.id));

  const steps = (definition.steps ?? [])
    .map(step => normalizeStep(step, projectRoot, { ...options, basePath }))
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
    rollback_policy: definition.rollback_policy ?? 'required',
    rollback_none_reason: definition.rollback_none_reason ?? null,
    rollback: normalizeRollback(definition.rollback, projectRoot),
  };
}

export function hashWorkflow(normalizedWorkflow) {
  const hashable = {
    name: normalizedWorkflow.name,
    entryStep: normalizedWorkflow.entryStep,
    maxIterations: normalizedWorkflow.maxIterations,
    services: normalizedWorkflow.services,
    steps: materializeWorkflowStepsForApproval(normalizedWorkflow.steps),
    rollback_policy: normalizedWorkflow.rollback_policy,
    rollback: normalizedWorkflow.rollback,
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
      steps: materializeWorkflowStepsForApproval(normalizedWorkflow.steps),
      rollback_policy: normalizedWorkflow.rollback_policy,
      rollback: normalizedWorkflow.rollback,
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
  const projectRootChanged = candidate.projectRoot !== approved.projectRoot;
  const workflowChanged = candidate.workflowHash !== approved.workflowHash;

  return [
    ...(projectRootChanged && workflowChanged
      ? [`~ projectRoot: ${pretty(approved.projectRoot)} -> ${pretty(candidate.projectRoot)}`]
      : []),
    ...diffTopLevelFields(cWf, aWf),
    ...diffServices(cWf.services, aWf.services),
    ...diffSteps(cWf.steps, aWf.steps),
    ...diffRollback(cWf.rollback, aWf.rollback),
    ...(cWf.rollback_policy !== aWf.rollback_policy
      ? [`~ rollback_policy: ${pretty(aWf.rollback_policy)} -> ${pretty(cWf.rollback_policy)}`]
      : []),
    ...diffRiskAssessment(candidate.riskAssessment ?? {}, approved.riskAssessment ?? {}),
    ...(workflowChanged
      ? [`~ workflowHash: ${pretty(approved.workflowHash)} -> ${pretty(candidate.workflowHash)}`]
      : []),
  ];
}

export function compareWorkflowManifests(candidate, approved) {
  const diffs = diffWorkflowManifests(candidate, approved);
  return { matches: diffs.length === 0, diffs };
}
