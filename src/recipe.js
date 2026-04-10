import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, extname } from 'node:path';
import { serializeStable } from './contract.js';
import { deepEqual, pretty } from './shared.js';
import { validateInputValue } from './input-validator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high']);
const VALID_INPUT_TYPES = new Set(['string', 'integer', 'boolean']);
export const VALID_CATEGORIES = new Set(['git', 'github', 'infra', 'packages', 'openclaw', 'custom']);
export const VALID_CHANNELS = new Set(['verified', 'community']);
const RECIPE_SCHEMA_VERSION = 1;
const RECIPE_MANIFEST_VERSION = 1;
const HIGH_RISK_ENV_PATTERNS = /secret|token|password|api[_-]?key|credential|auth|private[_-]?key/i;

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

export class RecipeValidationError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'RecipeValidationError';
    this.errors = errors ?? [message];
  }
}

// ---------------------------------------------------------------------------
// Pure validation functions — each returns an array of error strings
// ---------------------------------------------------------------------------

function validateTopLevel(recipe) {
  const errors = [];

  if (typeof recipe.id !== 'string' || !ID_RE.test(recipe.id)) {
    errors.push(`id must be a kebab-case string, got ${JSON.stringify(recipe.id)}`);
  }
  if (typeof recipe.name !== 'string' || recipe.name.trim() === '') {
    errors.push(`name must be a non-empty string`);
  }
  if (typeof recipe.description !== 'string' || recipe.description.trim() === '') {
    errors.push(`description must be a non-empty string`);
  }
  if (typeof recipe.version !== 'string' || !SEMVER_RE.test(recipe.version)) {
    errors.push(`version must be valid semver (e.g. "1.0.0"), got ${JSON.stringify(recipe.version)}`);
  }
  if (!validateAuthor(recipe.author)) {
    errors.push(`author must be a non-empty string or { name: string }`);
  }
  if (typeof recipe.approval_required !== 'boolean') {
    errors.push(`approval_required must be a boolean`);
  }
  if (!VALID_RISK_LEVELS.has(recipe.risk_level)) {
    errors.push(`risk_level must be one of ${[...VALID_RISK_LEVELS].join(', ')}, got ${JSON.stringify(recipe.risk_level)}`);
  }

  // Category (optional but constrained)
  if (recipe.category !== undefined && !VALID_CATEGORIES.has(recipe.category)) {
    errors.push(`category must be one of ${[...VALID_CATEGORIES].join(', ')}, got ${JSON.stringify(recipe.category)}`);
  }

  // Tags (optional, array of strings)
  if (recipe.tags !== undefined) {
    if (!Array.isArray(recipe.tags)) {
      errors.push('tags must be an array of strings');
    } else if (recipe.tags.some(t => typeof t !== 'string' || t.trim() === '')) {
      errors.push('tags must be non-empty strings');
    }
  }

  // Channel (optional but constrained)
  if (recipe.channel !== undefined && !VALID_CHANNELS.has(recipe.channel)) {
    errors.push(`channel must be one of ${[...VALID_CHANNELS].join(', ')}, got ${JSON.stringify(recipe.channel)}`);
  }

  return errors;
}

function validateAuthor(author) {
  if (typeof author === 'string') return author.trim() !== '';
  if (author && typeof author === 'object' && typeof author.name === 'string') return author.name.trim() !== '';
  return false;
}

function validateRequiresEnv(recipe) {
  if (recipe.requires_env === undefined) return [];
  if (!Array.isArray(recipe.requires_env)) return ['requires_env must be an array'];
  for (const value of recipe.requires_env) {
    if (typeof value !== 'string' || value.trim() === '') {
      return ['requires_env entries must be non-empty strings'];
    }
  }
  return [];
}

function validateInputs(inputs) {
  const errors = [];
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    errors.push('inputs must be an object');
    return errors;
  }

  for (const [key, schema] of Object.entries(inputs)) {
    const p = `input "${key}"`;
    if (!schema || typeof schema !== 'object') {
      errors.push(`${p}: must be an object`);
      continue;
    }
    if (!VALID_INPUT_TYPES.has(schema.type)) {
      errors.push(`${p}: type must be one of ${[...VALID_INPUT_TYPES].join(', ')}, got ${JSON.stringify(schema.type)}`);
      continue;
    }
    if (schema.type === 'string') {
      // approval_mode overrides the pattern/enum requirement
      const MODES_WITHOUT_PATTERN = new Set(['exact', 'path_policy', 'list', 'review_each_time', 'interactive_message', 'template_slots']);
      if (!schema.pattern && !schema.enum && !MODES_WITHOUT_PATTERN.has(schema.approval_mode)) {
        errors.push(`${p}: string inputs must have "pattern", "enum", or "approval_mode" constraint`);
      }
      if (schema.pattern) {
        try { new RegExp(schema.pattern); } catch (e) {
          errors.push(`${p}: invalid pattern regex: ${e.message}`);
        }
      }
      if (schema.enum && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
        errors.push(`${p}: enum must be a non-empty array`);
      }
    }
    if (schema.type === 'integer') {
      if (schema.min !== undefined && typeof schema.min !== 'number') errors.push(`${p}: min must be a number`);
      if (schema.max !== undefined && typeof schema.max !== 'number') errors.push(`${p}: max must be a number`);
    }
  }
  return errors;
}

function validateSteps(steps) {
  const errors = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push('steps must be a non-empty array');
    return errors;
  }

  const ids = new Set();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const p = `step[${i}]`;

    if (typeof step.id !== 'string' || step.id.trim() === '') {
      errors.push(`${p}: must have a non-empty string id`);
      continue;
    }
    if (ids.has(step.id)) {
      errors.push(`${p}: duplicate step id "${step.id}"`);
    }
    ids.add(step.id);

    if (typeof step.description !== 'string' || step.description.trim() === '') {
      errors.push(`${p} "${step.id}": must have a description`);
    }
    if (!step.run || typeof step.run !== 'object') {
      errors.push(`${p} "${step.id}": must have a run block`);
    } else {
      if (typeof step.run.command !== 'string' || step.run.command.trim() === '') {
        errors.push(`${p} "${step.id}": run.command must be a non-empty string`);
      }
      if (step.run.mode && step.run.mode !== 'structured') {
        errors.push(`${p} "${step.id}": run.mode must be "structured" (shell forbidden in recipes)`);
      }
    }

    if (step.composed_recipe !== undefined) {
      if (!step.composed_recipe || typeof step.composed_recipe !== 'object' || Array.isArray(step.composed_recipe)) {
        errors.push(`${p} "${step.id}": composed_recipe must be an object when present`);
      } else {
        if (typeof step.composed_recipe.recipe !== 'string' || step.composed_recipe.recipe.trim() === '') {
          errors.push(`${p} "${step.id}": composed_recipe.recipe must be a non-empty recipe specifier`);
        }
        if (
          step.composed_recipe.inputs !== undefined
          && (!step.composed_recipe.inputs || typeof step.composed_recipe.inputs !== 'object' || Array.isArray(step.composed_recipe.inputs))
        ) {
          errors.push(`${p} "${step.id}": composed_recipe.inputs must be an object when present`);
        }
      }
    }
  }
  return errors;
}

function validateGuardrails(guardrails) {
  const errors = [];
  if (!guardrails || typeof guardrails !== 'object') {
    errors.push('guardrails must be an object');
    return errors;
  }

  if (guardrails.constraints !== undefined) {
    if (!Array.isArray(guardrails.constraints)) {
      errors.push('guardrails.constraints must be an array');
    } else {
      for (let i = 0; i < guardrails.constraints.length; i++) {
        const c = guardrails.constraints[i];
        if (typeof c !== 'string' || c.trim() === '') {
          errors.push(`guardrails.constraints[${i}]: must be a non-empty string`);
        }
      }
    }
  }

  if (guardrails.invariants !== undefined) {
    if (!Array.isArray(guardrails.invariants)) {
      errors.push('guardrails.invariants must be an array');
    } else {
      for (let i = 0; i < guardrails.invariants.length; i++) {
        const inv = guardrails.invariants[i];
        if (typeof inv !== 'string' || inv.trim() === '') {
          errors.push(`guardrails.invariants[${i}]: must be a non-empty string`);
        }
      }
    }
  }

  return errors;
}

function makeInputApprovalEnvelope(schema) {
  if (!schema || typeof schema !== 'object') return null;
  const explicitMode = typeof schema.approval_mode === 'string'
    ? schema.approval_mode
    : null;
  if (explicitMode === 'review_each_time' || explicitMode === 'exact') return null;
  if (explicitMode === 'interactive_message') {
    return {
      type: 'interactive_message',
    };
  }
  if (schema.content_hash === true) return null;

  if (explicitMode === 'list') {
    if (!Number.isInteger(schema.max_items) || schema.max_items < 1) return null;
    if (!schema.item_validator || typeof schema.item_validator !== 'object' || Array.isArray(schema.item_validator)) return null;
    return {
      type: 'list',
      maxItems: schema.max_items,
      itemValidator: schema.item_validator,
    };
  }

  if (schema.type === 'string') {
    if (explicitMode && explicitMode !== 'enum') return null;
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) return null;
    return {
      type: 'enum',
      values: [...schema.enum],
    };
  }

  if (schema.type === 'integer') {
    if (explicitMode && explicitMode !== 'range') return null;
    if (!Number.isInteger(schema.min) || !Number.isInteger(schema.max)) return null;
    if (schema.min > schema.max) return null;
    return {
      type: 'integer_range',
      min: schema.min,
      max: schema.max,
    };
  }

  return null;
}

function buildInputApprovalEnvelopes(recipe) {
  if (!recipe || typeof recipe !== 'object' || !recipe.inputs || typeof recipe.inputs !== 'object') {
    return {};
  }

  const envelopes = {};
  for (const [key, schema] of Object.entries(recipe.inputs)) {
    const envelope = makeInputApprovalEnvelope(schema);
    if (envelope) {
      envelopes[key] = envelope;
    }
  }
  return envelopes;
}

function isWithinInputApprovalEnvelope(value, envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (envelope.type === 'enum') {
    return Array.isArray(envelope.values) && envelope.values.includes(value);
  }

  if (envelope.type === 'integer_range') {
    if (!Number.isInteger(value)) return false;
    return value >= envelope.min && value <= envelope.max;
  }

  if (envelope.type === 'list') {
    if (!Array.isArray(value) || !Number.isInteger(envelope.maxItems) || value.length > envelope.maxItems) {
      return false;
    }
    if (!envelope.itemValidator || typeof envelope.itemValidator !== 'object') {
      return false;
    }
    return value.every((entry) => {
      const result = validateInputValue(entry, envelope.itemValidator);
      return result.valid && !result.never_reuse && (result.risk_traits || []).length === 0;
    });
  }

  return false;
}

function describeInputApprovalEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return '';
  if (envelope.type === 'enum') {
    return `enum(${envelope.values.map(v => JSON.stringify(v)).join(', ')})`;
  }
  if (envelope.type === 'integer_range') {
    return `integer_range(${envelope.min}..${envelope.max})`;
  }
  if (envelope.type === 'interactive_message') {
    return 'interactive_message(session-bound)';
  }
  if (envelope.type === 'list') {
    return `list(max_items=${envelope.maxItems})`;
  }
  return '';
}

function canReuseInteractiveMessage(candidate, approved) {
  const cInputs = candidate?.resolvedInputs ?? {};
  const aInputs = approved?.resolvedInputs ?? {};
  const lifecycle = cInputs.lifecycle ?? 'start';
  if (lifecycle !== 'continue' && lifecycle !== 'attach') return false;
  const sessionName = cInputs.session_name ?? null;
  if (!sessionName || sessionName !== (aInputs.session_name ?? null)) return false;
  if (cInputs.no_session_persistence === true || aInputs.no_session_persistence === true) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public API — validate
// ---------------------------------------------------------------------------

/**
 * Validate a recipe definition. Throws RecipeValidationError on failure.
 *
 * @param {object} recipe - The recipe definition object.
 */
export function validateRecipe(recipe) {
  const errors = [
    ...validateTopLevel(recipe),
    ...validateRequiresEnv(recipe),
    ...validateInputs(recipe.inputs),
    ...validateSteps(recipe.steps),
    ...validateGuardrails(recipe.guardrails),
  ];

  if (errors.length > 0) {
    throw new RecipeValidationError(
      `Recipe validation failed:\n  - ${errors.join('\n  - ')}`,
      errors,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API — load (local + remote)
// ---------------------------------------------------------------------------

/**
 * Load and validate a recipe from a local file path.
 *
 * @param {string} filePath - Path to the recipe JSON file.
 * @returns {object} Validated recipe definition.
 */
export function loadRecipe(filePath) {
  const resolved = resolve(filePath);
  let raw;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read recipe at ${resolved}: ${err.message}`);
  }

  let recipe;
  try {
    recipe = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in recipe at ${resolved}: ${err.message}`);
  }

  validateRecipe(recipe);
  return recipe;
}

// ---------------------------------------------------------------------------
// Public API — raw JSON fetch (reusable for GitHub API, signed index, etc.)
// ---------------------------------------------------------------------------

/**
 * Fetch and parse JSON from a URL with safety limits.
 *
 * - Rejects non-2xx responses with status code
 * - Limits response body to maxBytes (default 1MB) to prevent memory exhaustion
 * - Returns parsed JSON object
 *
 * @param {string} url - HTTPS URL to fetch
 * @param {object} [opts] - { headers, maxBytes, timeout }
 * @returns {Promise<object>} Parsed JSON
 */
export async function loadRawJson(url, opts = {}) {
  const { get } = await import(url.startsWith('https') ? 'node:https' : 'node:http');
  const maxBytes = opts.maxBytes || 1024 * 1024; // 1MB default
  const headers = { 'User-Agent': 'guardrail-cli', ...opts.headers };

  return new Promise((resolve, reject) => {
    const req = get(url, { headers, timeout: opts.timeout || 10000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          res.destroy();
          reject(new Error(`Response exceeded ${maxBytes} bytes from ${url}`));
          return;
        }
        body += chunk;
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Invalid JSON from ${url}: ${err.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
  });
}

/**
 * Load a recipe from a URL. Fetches, parses, and validates.
 * Returns a promise.
 *
 * @param {string} url - URL to fetch the recipe from.
 * @returns {Promise<object>} Validated recipe definition.
 */
export async function loadRemoteRecipe(url) {
  const { get } = await import(url.startsWith('https') ? 'node:https' : 'node:http');

  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching recipe from ${url}`));
        res.resume();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const recipe = JSON.parse(body);
          validateRecipe(recipe);
          resolve(recipe);
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Public API — hash + pack
// ---------------------------------------------------------------------------

/**
 * Compute the content hash of a recipe (canonical JSON, SHA-256).
 * The hash covers the recipe content, not metadata like packed_at.
 *
 * @param {object} recipe - Validated recipe definition.
 * @returns {string} SHA-256 hex digest.
 */
export function hashRecipe(recipe) {
  const hashable = {
    id:                recipe.id,
    name:              recipe.name,
    description:       recipe.description,
    version:           recipe.version,
    author:            recipe.author,
    inputs:            recipe.inputs,
    steps:             recipe.steps,
    guardrails:        recipe.guardrails,
    approval_required: recipe.approval_required,
    risk_level:        recipe.risk_level,
  };
  if (recipe.requires_env !== undefined) {
    hashable.requires_env = recipe.requires_env;
  }
  return createHash('sha256').update(serializeStable(hashable)).digest('hex');
}

/**
 * Package a recipe — validate, hash, and produce the packaged artifact.
 *
 * @param {object} recipe - Recipe definition to package.
 * @returns {object} Packaged recipe with metadata.
 */
export function packRecipe(recipe) {
  validateRecipe(recipe);
  const contentHash = hashRecipe(recipe);

  return {
    schema_version: RECIPE_SCHEMA_VERSION,
    recipe,
    content_hash:   contentHash,
    packed_at:      new Date().toISOString(),
    immutable:      true,
  };
}

/**
 * Write a packaged recipe to disk.
 *
 * @param {object} packed    - Packaged recipe from packRecipe().
 * @param {string} outputPath - File path to write.
 */
export function writePackedRecipe(packed, outputPath) {
  writeFileSync(outputPath, JSON.stringify(packed, null, 2) + '\n', 'utf8');
}

/**
 * Load a packaged recipe and verify its content hash (immutability check).
 *
 * @param {string} filePath - Path to the packaged recipe file.
 * @returns {{ recipe: object, verified: boolean, contentHash: string }}
 */
export function loadPackedRecipe(filePath) {
  const resolved = resolve(filePath);
  let raw;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read packed recipe at ${resolved}: ${err.message}`);
  }

  let packed;
  try {
    packed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in packed recipe at ${resolved}: ${err.message}`);
  }

  if (!packed.recipe || !packed.content_hash) {
    throw new Error(`Invalid packed recipe format at ${resolved}: missing recipe or content_hash`);
  }

  validateRecipe(packed.recipe);
  const computed = hashRecipe(packed.recipe);
  const verified = computed === packed.content_hash;

  return {
    recipe:      packed.recipe,
    verified,
    contentHash: packed.content_hash,
    computedHash: computed,
    packedAt:    packed.packed_at,
  };
}

// ---------------------------------------------------------------------------
// Recipe manifests
// ---------------------------------------------------------------------------

export function createRecipeManifest(recipe, recipeHash, riskAssessment, resolvedInputs, options = {}) {
  const requestedVersion = options.requestedVersion ?? null;
  const resolutionMode = requestedVersion ? 'pinned' : 'latest';
  const inputApprovalEnvelopes = buildInputApprovalEnvelopes(recipe);

  return {
    version: RECIPE_MANIFEST_VERSION,
    tool: 'guardrail',
    kind: 'recipe',
    approvedAt: new Date().toISOString(),
    projectRoot: options.projectRoot ?? resolve(options.cwd ?? process.cwd()),
    cwd: options.cwd ?? process.cwd(),
    recipeHash,
    recipe: {
      id: recipe.id,
      name: recipe.name,
      version: recipe.version,
      channel: recipe.channel ?? 'community',
      sourcePath: options.sourcePath ?? null,
      requestedVersion,
      resolutionMode,
      allowUnverified: options.allowUnverified ?? false,
    },
    resolvedInputs,
    envIntersection: options.envIntersection ?? [],
    inputApprovalEnvelopes,
    inputContentHashes: options.inputContentHashes ?? {},
    executionDetails: options.executionDetails ?? null,
    composedRecipes: options.composedRecipes ?? [],
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

export function diffRecipeManifests(candidate, approved) {
  const diffs = [];
  const cRecipe = candidate.recipe ?? {};
  const aRecipe = approved.recipe ?? {};
  const cRisk = candidate.riskAssessment ?? {};
  const aRisk = approved.riskAssessment ?? {};
  const aInputEnvelopes = approved.inputApprovalEnvelopes ?? {};
  const hasInputApprovalEnvelopes = Object.prototype.hasOwnProperty.call(approved, 'inputApprovalEnvelopes');

  if (!deepEqual(candidate.projectRoot, approved.projectRoot)) {
    diffs.push(`~ projectRoot: ${pretty(approved.projectRoot)} -> ${pretty(candidate.projectRoot)}`);
  }
  if (!deepEqual(candidate.cwd, approved.cwd)) {
    diffs.push(`~ cwd: ${pretty(approved.cwd)} -> ${pretty(candidate.cwd)}`);
  }

  for (const field of ['id', 'name', 'version', 'channel', 'sourcePath', 'requestedVersion', 'resolutionMode', 'allowUnverified']) {
    if (!deepEqual(cRecipe[field], aRecipe[field])) {
      diffs.push(`~ recipe.${field}: ${pretty(aRecipe[field])} -> ${pretty(cRecipe[field])}`);
    }
  }

  const candidateEnvIntersection = candidate.envIntersection ?? [];
  const approvedEnvIntersection = approved.envIntersection ?? [];
  if (
    (candidateEnvIntersection.length > 0 || approvedEnvIntersection.length > 0)
    && !deepEqual(candidateEnvIntersection, approvedEnvIntersection)
  ) {
    diffs.push(`~ envIntersection: ${pretty(approvedEnvIntersection)} -> ${pretty(candidateEnvIntersection)}`);
  }

  const allInputs = new Set([
    ...Object.keys(candidate.resolvedInputs ?? {}),
    ...Object.keys(approved.resolvedInputs ?? {}),
  ]);

  for (const key of allInputs) {
    const cVal = candidate.resolvedInputs?.[key];
    const aVal = approved.resolvedInputs?.[key];
    const envelope = hasInputApprovalEnvelopes ? aInputEnvelopes[key] : null;

    if (!deepEqual(cVal, aVal)) {
      if (
        envelope
        && envelope.type === 'interactive_message'
        && canReuseInteractiveMessage(candidate, approved)
        && typeof cVal === 'string'
        && typeof aVal === 'string'
      ) {
        continue;
      }

      if (
        envelope
        && envelope.type !== 'interactive_message'
        && isWithinInputApprovalEnvelope(cVal, envelope)
        && isWithinInputApprovalEnvelope(aVal, envelope)
      ) {
        continue;
      }

      if (envelope) {
        const envelopeText = describeInputApprovalEnvelope(envelope);
        diffs.push(
          `~ input "${key}": ${pretty(aVal)} -> ${pretty(cVal)} (outside approved envelope${envelopeText ? `: ${envelopeText}` : ''})`,
        );
        continue;
      }

      diffs.push(`~ input "${key}": ${pretty(aVal)} -> ${pretty(cVal)}`);
    }
  }

  const allInputHashes = new Set([
    ...Object.keys(candidate.inputContentHashes ?? {}),
    ...Object.keys(approved.inputContentHashes ?? {}),
  ]);

  for (const key of allInputHashes) {
    const cVal = candidate.inputContentHashes?.[key];
    const aVal = approved.inputContentHashes?.[key];
    if (!deepEqual(cVal, aVal)) {
      diffs.push(`~ inputContentHashes "${key}": ${pretty(aVal)} -> ${pretty(cVal)}`);
    }
  }

  const candidateExecutionDetails = candidate.executionDetails ?? null;
  const approvedExecutionDetails = approved.executionDetails ?? null;
  if (!deepEqual(candidateExecutionDetails, approvedExecutionDetails)) {
    diffs.push(
      `~ executionDetails: ${pretty(approvedExecutionDetails)} -> ${pretty(candidateExecutionDetails)}`,
    );
  }

  for (const field of ['trustClass', 'riskLevel', 'reasons', 'requiresStrongConfirmation']) {
    if (!deepEqual(cRisk[field], aRisk[field])) {
      diffs.push(`~ riskAssessment.${field}: ${pretty(aRisk[field])} -> ${pretty(cRisk[field])}`);
    }
  }

  if (!deepEqual(candidate.recipeHash, approved.recipeHash)) {
    diffs.push(`~ recipeHash: ${pretty(approved.recipeHash)} -> ${pretty(candidate.recipeHash)}`);
  }

  const candidateComposedRecipes = candidate.composedRecipes ?? [];
  const approvedComposedRecipes = approved.composedRecipes ?? [];
  if (candidateComposedRecipes.length !== approvedComposedRecipes.length) {
    diffs.push(`~ composedRecipes length: ${approvedComposedRecipes.length} -> ${candidateComposedRecipes.length}`);
  } else {
    for (let i = 0; i < candidateComposedRecipes.length; i += 1) {
      const cRecord = candidateComposedRecipes[i];
      const aRecord = approvedComposedRecipes[i];
      if ((cRecord?.stepId ?? null) !== (aRecord?.stepId ?? null)) {
        diffs.push(`~ composedRecipes[${i}].stepId: ${pretty(aRecord?.stepId)} -> ${pretty(cRecord?.stepId)}`);
        continue;
      }
      const recordComparison = compareRecipeManifests(cRecord, aRecord);
      if (!recordComparison.matches) {
        diffs.push(
          `~ composedRecipes[${cRecord?.stepId ?? i}]: ${recordComparison.diffs.join('; ')}`,
        );
      }
    }
  }

  return diffs;
}

export function compareRecipeManifests(candidate, approved) {
  const diffs = diffRecipeManifests(candidate, approved);
  return { matches: diffs.length === 0, diffs };
}

export function computeRecipeEnvIntersection(requiresEnv, callerAllow) {
  const required = new Set(requiresEnv || []);
  const allowed = new Set(callerAllow || []);
  const intersection = [];
  const denied = [];
  const warnings = [];

  for (const key of required) {
    if (allowed.has(key)) {
      intersection.push(key);
      if (HIGH_RISK_ENV_PATTERNS.test(key)) {
        warnings.push(`secret_in_env_handshake: "${key}" matches secret pattern`);
      }
    } else {
      denied.push(key);
    }
  }

  return {
    intersection: intersection.sort(),
    denied,
    warnings,
  };
}
