import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, resolve } from 'node:path';
import { serializeStable, checkRegexSafety } from './contract.js';
import { validateInputValue, inferApprovalMode } from './input-validator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEMPLATE_KINDS = new Set(['template', 'workflow_template']);
const VALID_TRUST_CLASSES = new Set(['reviewed_internal', 'pinned_external', 'generated', 'unknown']);
const VALID_RISK_LEVELS = new Set(['green', 'yellow', 'red']);
const VALID_INPUT_TYPES = new Set(['string', 'integer', 'boolean']);

const INTERPOLATION_RE = /\{\{inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
const SHELL_METACHARACTERS = /[;|&$`()><\n]/;
const SEMVER_RE = /^(v?)(\d+\.\d+\.\d+)(-[0-9A-Za-z-.]+)?$/;
const PATH_HINT_RE = /(^\.{0,2}[\\/])|(^\/)|([\\/].*[\\/])/;
const ENV_VALUE_SET = new Set(['dev', 'qa', 'staging', 'prod', 'production', 'test']);
const NARROW_REASONS = {
  low: 'green',
  medium: 'yellow',
  high: 'red',
};

const HIGH_RISK_ENV_PATTERNS = /secret|token|password|api[_-]?key|credential|auth|private[_-]?key/i;

// Patterns that indicate potential catastrophic backtracking (ReDoS).
const REDOS_INDICATORS = [
  /\([^)]*[+*][^)]*\)[+*]/,             // quantified group with inner quantifier
  /(\.\*){2,}/,                           // adjacent greedy wildcards
  /\([^)]*\|[^)]*\)[+*]\{/,             // alternation in quantified group
];

const TEMPLATE_MANIFEST_VERSION = 1;
const PLACEHOLDER_VALUE_FALLBACK = 'x';

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

export class TemplateValidationError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'TemplateValidationError';
    this.errors = errors ?? [message];
  }
}

// ---------------------------------------------------------------------------
// Pure validation functions
// ---------------------------------------------------------------------------

function validateTopLevel(def) {
  const errors = [];
  if (def.version !== 1) {
    errors.push(`version must be 1, got ${JSON.stringify(def.version)}`);
  }
  if (!TEMPLATE_KINDS.has(def.kind)) {
    errors.push(`kind must be "template" or "workflow_template", got ${JSON.stringify(def.kind)}`);
  }
  if (typeof def.name !== 'string' || !/^[a-z0-9-]+$/.test(def.name)) {
    errors.push(`name must be alphanumeric with hyphens only, got ${JSON.stringify(def.name)}`);
  }
  if (typeof def.description !== 'string' || def.description.trim() === '') {
    errors.push('description must be a non-empty string');
  }
  if (!VALID_TRUST_CLASSES.has(def.trust_class)) {
    errors.push(`trust_class must be one of ${[...VALID_TRUST_CLASSES].join(', ')}, got ${JSON.stringify(def.trust_class)}`);
  }
  if (!VALID_RISK_LEVELS.has(def.risk)) {
    errors.push(`risk must be one of ${[...VALID_RISK_LEVELS].join(', ')}, got ${JSON.stringify(def.risk)}`);
  }
  return errors;
}

function validateInputSchema(def) {
  const errors = [];
  const MODES_WITHOUT_PATTERN = new Set(['exact', 'path_policy', 'list', 'review_each_time', 'interactive_message', 'template_slots']);
  if (!def.inputs || typeof def.inputs !== 'object' || Array.isArray(def.inputs)) {
    errors.push('inputs must be an object');
    return errors;
  }
  if (Object.keys(def.inputs).length === 0) {
    errors.push('inputs must have at least one field');
    return errors;
  }
  for (const [key, schema] of Object.entries(def.inputs)) {
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
      if (!schema.pattern && !schema.enum && !MODES_WITHOUT_PATTERN.has(schema.approval_mode)) {
        errors.push(`${p}: string inputs must have either "pattern" or "enum" constraint`);
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
    if (schema.approval_mode === 'list') {
      if (schema.max_items !== undefined && (!Number.isInteger(schema.max_items) || schema.max_items < 1)) {
        errors.push(`${p}: max_items must be a positive integer when present`);
      }
      if (!schema.item_validator || typeof schema.item_validator !== 'object' || Array.isArray(schema.item_validator)) {
        errors.push(`${p}: list inputs must declare an object item_validator`);
      }
    }
    if (schema.type === 'integer') {
      if (schema.min !== undefined && typeof schema.min !== 'number') {
        errors.push(`${p}: min must be a number`);
      }
      if (schema.max !== undefined && typeof schema.max !== 'number') {
        errors.push(`${p}: max must be a number`);
      }
    }
  }
  return errors;
}

function validateRunBlock(run, prefix) {
  const errors = [];
  if (!run || typeof run !== 'object') {
    errors.push(`${prefix}: run block must be an object`);
    return errors;
  }
  if (typeof run.command !== 'string' || run.command.trim() === '') {
    errors.push(`${prefix}: run.command must be a non-empty string`);
  }
  if (run.mode !== 'structured') {
    errors.push(`${prefix}: run.mode must be "structured", got ${JSON.stringify(run.mode)}`);
  }
  if (run.args !== undefined && !Array.isArray(run.args)) {
    errors.push(`${prefix}: run.args must be an array`);
  }
  return errors;
}

function validateSteps(steps, prefix) {
  const errors = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push(`${prefix}: steps must be a non-empty array`);
    return errors;
  }
  const ids = new Set();
  for (const step of steps) {
    if (typeof step.id !== 'string' || step.id.trim() === '') {
      errors.push(`${prefix}: every step must have a non-empty string id`);
      continue;
    }
    if (ids.has(step.id)) {
      errors.push(`${prefix}: duplicate step id: ${JSON.stringify(step.id)}`);
    }
    ids.add(step.id);
    errors.push(...validateRunBlock(step.run, `${prefix} step "${step.id}"`));
  }
  return errors;
}

function validateRollback(def) {
  const errors = [];
  const steps = def.kind === 'template'
    ? [{ id: '_main', idempotent: def.idempotent }]
    : (def.steps || []);

  const hasNonIdempotent = steps.some(s => s.idempotent === false);

  if (hasNonIdempotent) {
    if (!def.rollback || !Array.isArray(def.rollback?.steps) || def.rollback.steps.length === 0) {
      errors.push('rollback section is required when any step has idempotent: false');
    }
  }

  if (def.rollback?.steps) {
    errors.push(...validateSteps(def.rollback.steps, 'rollback'));
  }
  return errors;
}

function validateRequiresEnv(def) {
  if (def.requires_env === undefined) return [];
  if (!Array.isArray(def.requires_env)) return ['requires_env must be an array'];
  for (const v of def.requires_env) {
    if (typeof v !== 'string' || v.trim() === '') {
      return ['requires_env entries must be non-empty strings'];
    }
  }
  return [];
}

/**
 * Structurally validate a template definition.
 * Throws TemplateValidationError on failure.
 */
export function validateTemplate(def) {
  const errors = [
    ...validateTopLevel(def),
    ...validateInputSchema(def),
    ...validateRequiresEnv(def),
  ];

  if (def.kind === 'template') {
    errors.push(...validateRunBlock(def.run, 'template'));
  } else if (def.kind === 'workflow_template') {
    errors.push(...validateSteps(def.steps, 'template'));
  }

  errors.push(...validateRollback(def));

  // ReDoS safety check: reject input patterns with catastrophic backtracking potential
  for (const [key, schema] of Object.entries(def.inputs || {})) {
    if (schema.pattern) {
      const safety = checkRegexSafety(schema.pattern);
      if (!safety.safe) {
        errors.push(`input "${key}": pattern rejected — ${safety.reason}`);
      }
    }
  }

  // ReDoS safety check: reject validator regexes with catastrophic backtracking potential
  if (def.kind === 'template' && def.validator?.regex) {
    const safety = checkRegexSafety(def.validator.regex);
    if (!safety.safe) {
      errors.push(`template validator regex rejected — ${safety.reason}`);
    }
  }
  if (def.kind === 'workflow_template') {
    for (const step of (def.steps || [])) {
      if (step.validator?.regex) {
        const safety = checkRegexSafety(step.validator.regex);
        if (!safety.safe) {
          errors.push(`step "${step.id}": validator regex rejected — ${safety.reason}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new TemplateValidationError(
      `Template validation failed:\n  - ${errors.join('\n  - ')}`,
      errors,
    );
  }
}

// ---------------------------------------------------------------------------
// Lint — advisory checks beyond structural validation
// ---------------------------------------------------------------------------

function collectInterpolationKeys(obj) {
  const keys = new Set();
  const text = JSON.stringify(obj);
  let m;
  const re = /\{\{inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
  while ((m = re.exec(text)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

function lintInterpolationResolution(def) {
  const warnings = [];
  const declaredInputs = new Set(Object.keys(def.inputs || {}));
  const scope = def.kind === 'template'
    ? { run: def.run, rollback: def.rollback }
    : { steps: def.steps, rollback: def.rollback };
  const referenced = collectInterpolationKeys(scope);

  for (const key of referenced) {
    if (!declaredInputs.has(key)) {
      warnings.push(`interpolation "{{inputs.${key}}}" references undeclared input "${key}"`);
    }
  }
  return warnings;
}

function lintRollbackPresence(def) {
  const steps = def.kind === 'template'
    ? [{ id: '_main', idempotent: def.idempotent }]
    : (def.steps || []);
  const hasNonIdempotent = steps.some(s => s.idempotent === false);
  if (hasNonIdempotent && (!def.rollback?.steps || def.rollback.steps.length === 0)) {
    return ['non-idempotent step without rollback section'];
  }
  return [];
}

function lintRegexComplexity(def) {
  const warnings = [];

  // Check input patterns
  for (const [key, schema] of Object.entries(def.inputs || {})) {
    if (schema.pattern) {
      for (const indicator of REDOS_INDICATORS) {
        if (indicator.test(schema.pattern)) {
          warnings.push(`input "${key}": pattern "${schema.pattern}" may be vulnerable to catastrophic backtracking (ReDoS)`);
          break;
        }
      }
    }
  }

  // Check validator regexes in steps
  const steps = def.kind === 'template'
    ? (def.validator?.regex ? [{ id: '_main', validator: def.validator }] : [])
    : (def.steps || []);
  for (const step of steps) {
    if (step.validator?.regex) {
      for (const indicator of REDOS_INDICATORS) {
        if (indicator.test(step.validator.regex)) {
          warnings.push(`step "${step.id}": validator regex may be vulnerable to catastrophic backtracking`);
          break;
        }
      }
    }
  }
  return warnings;
}

function lintRiskConsistency(def) {
  const warnings = [];
  const declared = def.risk;

  // Compute minimum risk based on signals
  let computed = 'green';

  if (def.trust_class === 'generated' || def.trust_class === 'unknown') {
    computed = 'red';
  }

  const requiresEnv = def.requires_env || [];
  const hasSecretEnv = requiresEnv.some(v => HIGH_RISK_ENV_PATTERNS.test(v));
  if (hasSecretEnv) {
    computed = computed === 'red' ? 'red' : 'yellow';
  }

  const riskOrder = { green: 0, yellow: 1, red: 2 };
  if (riskOrder[declared] < riskOrder[computed]) {
    warnings.push(`declared risk "${declared}" is lower than computed risk "${computed}" — lint escalates to ${computed}`);
  }

  return warnings;
}

function lintSecretPatterns(def) {
  const warnings = [];
  for (const v of (def.requires_env || [])) {
    if (HIGH_RISK_ENV_PATTERNS.test(v)) {
      warnings.push(`requires_env "${v}" matches secret pattern — ensure this is intentional`);
    }
  }
  return warnings;
}

function lintBareStrings(def) {
  const warnings = [];
  for (const [key, schema] of Object.entries(def.inputs || {})) {
    if (
      schema.type === 'string'
      && !schema.pattern
      && !schema.enum
      && !new Set(['exact', 'path_policy', 'list', 'review_each_time', 'interactive_message', 'template_slots']).has(schema.approval_mode)
    ) {
      warnings.push(`input "${key}": bare string without pattern or enum is rejected`);
    }
  }
  return warnings;
}

function lintStructuredMode(def) {
  const warnings = [];
  const allSteps = def.kind === 'template'
    ? [{ id: '_main', run: def.run }]
    : [...(def.steps || []), ...(def.rollback?.steps || [])];

  for (const step of allSteps) {
    if (step.run?.mode && step.run.mode !== 'structured') {
      warnings.push(`step "${step.id}": mode must be "structured", got "${step.run.mode}"`);
    }
  }
  return warnings;
}

/**
 * Lint a validated template for advisory issues.
 * Returns an array of warning strings.
 */
export function lintTemplate(def) {
  return [
    ...lintBareStrings(def),
    ...lintStructuredMode(def),
    ...lintInterpolationResolution(def),
    ...lintRollbackPresence(def),
    ...lintRegexComplexity(def),
    ...lintRiskConsistency(def),
    ...lintSecretPatterns(def),
  ];
}

// ---------------------------------------------------------------------------
// Load template from disk
// ---------------------------------------------------------------------------

/**
 * Load, parse, and validate a template from a JSON file.
 *
 * @param {string} filePath - Path to the template JSON file.
 * @returns {object} The validated template definition.
 */
export function loadTemplate(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read template at ${filePath}: ${err.message}`);
  }

  let def;
  try {
    def = JSON.parse(raw);
  } catch (parseErr) {
    throw new Error(`Invalid JSON in template at ${filePath}: ${parseErr.message}`);
  }

  validateTemplate(def);
  return def;
}

// ---------------------------------------------------------------------------
// Input validation pipeline (Stages 1–3)
// ---------------------------------------------------------------------------

/**
 * Validate user-supplied inputs against the template's input schema.
 *
 * @param {object} inputSchema - The template's `inputs` object.
 * @param {object} userInputs  - Map of input key → user-supplied value.
 * @returns {{ valid: boolean, values: object, errors: string[], warnings: string[] }}
 */
export function validateUserInputs(inputSchema, userInputs) {
  const errors = [];
  const warnings = [];
  const values = {};

  for (const [key, schema] of Object.entries(inputSchema)) {
    let value = userInputs[key];

    // Apply default if not provided
    if (value === undefined && schema.default !== undefined) {
      value = schema.default;
    }

    if (value === undefined) {
      if (schema.required === false) {
        continue;
      }
      errors.push(`missing required input: "${key}"`);
      continue;
    }

    if (inferApprovalMode(schema) === 'list') {
      const result = validateInputValue(value, schema);
      if (!result.valid) {
        errors.push(`input "${key}": ${result.reasons.join(', ')}`);
        continue;
      }
      values[key] = result.normalized ?? value;
      continue;
    }

    // Stage 1: Type check
    if (schema.type === 'string') {
      if (typeof value !== 'string') {
        value = String(value);
      }
    } else if (schema.type === 'integer') {
      const n = Number(value);
      if (!Number.isInteger(n)) {
        errors.push(`input "${key}": expected integer, got ${JSON.stringify(value)}`);
        continue;
      }
      value = n;
    } else if (schema.type === 'boolean') {
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      if (typeof value !== 'boolean') {
        errors.push(`input "${key}": expected boolean, got ${JSON.stringify(value)}`);
        continue;
      }
    }

    // Stage 2: Pattern / enum / range check
    if (schema.type === 'string') {
      if (schema.pattern) {
        const re = new RegExp(schema.pattern);
        if (!re.test(value)) {
          errors.push(`input "${key}": value "${value}" does not match pattern ${schema.pattern}`);
          continue;
        }
      }
      if (schema.enum) {
        if (!schema.enum.includes(value)) {
          errors.push(`input "${key}": value "${value}" not in allowed values [${schema.enum.join(', ')}]`);
          continue;
        }
      }
    }
    if (schema.type === 'integer') {
      if (schema.min !== undefined && value < schema.min) {
        errors.push(`input "${key}": value ${value} is below minimum ${schema.min}`);
        continue;
      }
      if (schema.max !== undefined && value > schema.max) {
        errors.push(`input "${key}": value ${value} is above maximum ${schema.max}`);
        continue;
      }
    }

    // Stage 3: Injection scan (warning only — structured mode is safe)
    if (typeof value === 'string' && SHELL_METACHARACTERS.test(value)) {
      warnings.push(`input "${key}": value contains shell metacharacters — safe in structured mode but logged for audit`);
    }

    values[key] = value;
  }

  return { valid: errors.length === 0, values, errors, warnings };
}

// ---------------------------------------------------------------------------
// Interpolation (Stage 4) and args build (Stage 5)
// ---------------------------------------------------------------------------

/**
 * Interpolate {{inputs.x}} references in a single string.
 * Each interpolation produces exactly one arg element (no splitting).
 */
function interpolateString(template, values) {
  return template.replace(INTERPOLATION_RE, (_, key) => {
    const v = values[key];
    return v !== undefined ? String(v) : '';
  });
}

function expandInterpolatedArg(template, values) {
  const exact = /^\{\{inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/.exec(template);
  if (exact) {
    const value = values[exact[1]];
    if (Array.isArray(value)) {
      return value.map(entry => String(entry));
    }
  }
  return [interpolateString(template, values)];
}

/**
 * Interpolate an entire args array, producing a resolved args array.
 * Exact `{{inputs.x}}` placeholders may expand list inputs into multiple
 * structured args. Mixed literal/template strings remain a single arg.
 */
export function interpolateArgs(argsTemplate, values) {
  if (!Array.isArray(argsTemplate)) return [];
  return argsTemplate.flatMap(arg => expandInterpolatedArg(arg, values));
}

/**
 * Build resolved steps from a template definition and validated inputs.
 * Normalizes both single-step templates (kind: "template") and
 * multi-step templates (kind: "workflow_template") into a uniform
 * array of resolved step objects.
 *
 * @param {object} def             - The template definition.
 * @param {object} validatedInputs - The validated input values.
 * @returns {object[]} Resolved steps with interpolated args.
 */
export function buildResolvedSteps(def, validatedInputs) {
  if (def.kind === 'template') {
    return [{
      id: def.name,
      description: def.description,
      run: {
        command: def.run.command,
        args: interpolateArgs(def.run.args || [], validatedInputs),
        mode: 'structured',
        env: def.run.env || {},
      },
      idempotent: def.idempotent !== false,
      validator: def.validator || null,
    }];
  }

  // workflow_template
  return (def.steps || []).map(step => ({
    id: step.id,
    description: step.description || '',
    run: {
      command: step.run.command,
      args: interpolateArgs(step.run.args || [], validatedInputs),
      mode: 'structured',
      env: step.run.env || {},
    },
    idempotent: step.idempotent !== false,
    validator: step.validator || null,
  }));
}

/**
 * Build resolved rollback steps (interpolated).
 */
export function buildResolvedRollbackSteps(def, validatedInputs) {
  if (!def.rollback?.steps) return [];
  return def.rollback.steps.map(step => ({
    id: step.id,
    description: step.description || '',
    run: {
      command: step.run.command,
      args: interpolateArgs(step.run.args || [], validatedInputs),
      mode: 'structured',
      env: step.run.env || {},
    },
    idempotent: step.idempotent !== false,
  }));
}

// ---------------------------------------------------------------------------
// Environment handshake
// ---------------------------------------------------------------------------

/**
 * Compute the environment intersection between a template's requires_env
 * and the caller's allow list. Only variables in BOTH sets are passed.
 *
 * @param {string[]} requiresEnv - Template's requires_env array.
 * @param {string[]} callerAllow - Caller's env allow list.
 * @returns {{ intersection: string[], denied: string[], warnings: string[] }}
 */
export function computeEnvIntersection(requiresEnv, callerAllow) {
  const required = new Set(requiresEnv || []);
  const allowed  = new Set(callerAllow || []);
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

// ---------------------------------------------------------------------------
// Cryptographic provenance
// ---------------------------------------------------------------------------

/**
 * Compute the template execution hash.
 *
 * hash = SHA256(canonical(template_def) + canonical(resolved_inputs) + canonical(env_intersection))
 *
 * @param {object} templateDef       - The raw template definition.
 * @param {object} resolvedInputs    - Validated input values.
 * @param {string[]} envIntersection - The env var intersection.
 * @returns {string} SHA-256 hex digest.
 */
export function hashTemplateExecution(templateDef, resolvedInputs, envIntersection) {
  const parts = [
    serializeStable(templateDef),
    serializeStable(resolvedInputs),
    serializeStable(envIntersection),
  ];
  return createHash('sha256').update(parts.join('+')).digest('hex');
}

// ---------------------------------------------------------------------------
// Template manifest
// ---------------------------------------------------------------------------

function schemaFromValue(name, value) {
  const inferredType = typeof value;

  if (inferredType === 'boolean') {
    return {
      type: 'boolean',
      default: value,
      description: toInputDescription(name),
    };
  }

  if (Number.isInteger(value)) {
    return {
      type: 'integer',
      min: value,
      max: value,
      default: value,
      description: toInputDescription(name),
    };
  }

  if (typeof value === 'string') {
    if (SEMVER_RE.test(value)) {
      return {
        type: 'string',
        pattern: SEMVER_RE.source,
        default: value,
        description: toInputDescription(name),
      };
    }

    if (ENV_VALUE_SET.has(value.toLowerCase())) {
      return {
        type: 'string',
        enum: [...ENV_VALUE_SET],
        default: value,
        description: toInputDescription(name),
      };
    }

    if (value === '.' || value === '..' || PATH_HINT_RE.test(value)) {
      return {
        type: 'string',
        pattern: '^([.]{1,2}/|/).*$|^[^\\s]+\\.[^\\s]+$',
        default: value,
        description: toInputDescription(name),
      };
    }

    return {
      type: 'string',
      enum: [value],
      default: value,
      description: toInputDescription(name),
    };
  }

  if (Number.isFinite(value)) {
    return {
      type: 'integer',
      min: value,
      max: value,
      default: value,
      description: toInputDescription(name),
    };
  }

  return {
    type: 'string',
    pattern: '^.*$',
    description: toInputDescription(name),
    default: PLACEHOLDER_VALUE_FALLBACK,
  };
}

function normalizeToString(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(' ');
  return String(value);
}

function mergeInputs(target, additions = {}) {
  const result = { ...target };

  for (const [name, schema] of Object.entries(additions || {})) {
    if (!result[name]) {
      result[name] = schema;
    }
  }

  return result;
}

function inferTemplateInputsFromResolvedInputs(args, resolvedInputs = {}, existingInputs = {}, usedNames = new Set()) {
  const mappedArgs = [...args];
  const inferredInputs = {};

  for (const [name, rawValue] of Object.entries(resolvedInputs || {})) {
    const safeName = toInputName(name, usedNames);
    const value = normalizeToString(rawValue);

    if (!value) {
      continue;
    }

    let replaced = false;
    for (let i = 0; i < mappedArgs.length && !replaced; i += 1) {
      if (mappedArgs[i] !== value) {
        continue;
      }

      inferredInputs[safeName] = {
        ...schemaFromValue(safeName, rawValue),
        ...(Object.prototype.hasOwnProperty.call(existingInputs, name)
          ? { default: existingInputs[name] }
          : {}),
      };
      mappedArgs[i] = `{{inputs.${safeName}}}`;
      replaced = true;
    }

    if (!replaced) {
      continue;
    }
  }

  return { args: mappedArgs, inputs: inferredInputs };
}

function toInputName(rawName, usedInputNames = new Set()) {
  const fallback = rawName && String(rawName).trim().length > 0
    ? rawName
    : 'input';

  const base = fallback
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');

  return pickInputName(base || 'input', usedInputNames);
}

function dedupeStringList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized = values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(normalized)];
}

function buildInputApprovalEnvelope(schema) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }
  const explicitMode = typeof schema.approval_mode === 'string'
    ? schema.approval_mode
    : null;
  if (explicitMode === 'review_each_time' || explicitMode === 'exact') {
    return null;
  }
  if (explicitMode === 'interactive_message') {
    return {
      type: 'interactive_message',
    };
  }

  if (explicitMode === 'list') {
    if (!Number.isInteger(schema.max_items) || schema.max_items < 1) {
      return null;
    }
    if (!schema.item_validator || typeof schema.item_validator !== 'object' || Array.isArray(schema.item_validator)) {
      return null;
    }
    return {
      type: 'list',
      maxItems: schema.max_items,
      itemValidator: schema.item_validator,
    };
  }

  if (schema.type === 'string' && Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (explicitMode && explicitMode !== 'enum') {
      return null;
    }
    return {
      type: 'enum',
      values: [...schema.enum],
    };
  }

  if (
    schema.type === 'integer' &&
    Number.isFinite(schema.min) &&
    Number.isFinite(schema.max) &&
    typeof schema.min === 'number' &&
    typeof schema.max === 'number'
  ) {
    if (explicitMode && explicitMode !== 'range') {
      return null;
    }
    return {
      type: 'integer_range',
      min: schema.min,
      max: schema.max,
    };
  }

  return null;
}

function buildInputApprovalEnvelopes(inputSchema) {
  const envelopes = {};
  for (const [key, schema] of Object.entries(inputSchema || {})) {
    const envelope = buildInputApprovalEnvelope(schema);
    if (envelope) {
      envelopes[key] = envelope;
    }
  }
  return envelopes;
}

function isBoundedInputEnvelopeMatch(value, envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return false;
  }

  if (envelope.type === 'enum') {
    return Array.isArray(envelope.values) && envelope.values.includes(value);
  }

  if (envelope.type === 'integer_range') {
    return Number.isInteger(value) && value >= envelope.min && value <= envelope.max;
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

function stringifyEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return 'unbounded';
  }
  if (envelope.type === 'interactive_message') {
    return 'interactive_message(session-bound)';
  }
  if (envelope.type === 'enum') {
    return `enum(${JSON.stringify(envelope.values)})`;
  }
  if (envelope.type === 'integer_range') {
    return `integer_range[min=${envelope.min}, max=${envelope.max}]`;
  }
  if (envelope.type === 'list') {
    return `list[max_items=${envelope.maxItems}]`;
  }
  return envelope.type;
}

function diffInputValue(key, candidateValue, approvedValue, envelope, diffs) {
  if (JSON.stringify(candidateValue) === JSON.stringify(approvedValue)) {
    return;
  }

  if (
    envelope
    && envelope.type !== 'interactive_message'
    && isBoundedInputEnvelopeMatch(candidateValue, envelope)
    && isBoundedInputEnvelopeMatch(approvedValue, envelope)
  ) {
    return;
  }

  if (envelope) {
    diffs.push(`~ input "${key}" outside approved envelope: ${JSON.stringify(approvedValue)} -> ${JSON.stringify(candidateValue)} (envelope: ${stringifyEnvelope(envelope)})`);
    return;
  }

  diffs.push(`~ input "${key}": ${JSON.stringify(approvedValue)} -> ${JSON.stringify(candidateValue)}`);
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
// Template bridge helpers
// ---------------------------------------------------------------------------

function normalizeTemplateName(rawName) {
  if (typeof rawName !== 'string') {
    return 'template-from-manifest';
  }
  const sanitized = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-+/g, '-');

  return sanitized.length > 0 ? sanitized : 'template-from-manifest';
}

function mapTemplateRisk(level) {
  if (level === 'low') return 'green';
  if (level === 'medium') return 'yellow';
  if (level === 'high') return 'red';
  if (level === 'green' || level === 'yellow' || level === 'red') {
    return level;
  }
  return 'green';
}

function toInputDescription(name) {
  return `TODO: describe this input (${name})`;
}

function pickInputName(base, usedInputs) {
  if (!usedInputs.has(base)) {
    usedInputs.add(base);
    return base;
  }
  let idx = 2;
  while (usedInputs.has(`${base}_${idx}`)) {
    idx += 1;
  }
  const name = `${base}_${idx}`;
  usedInputs.add(name);
  return name;
}

function inferInputFromArg(arg, usedInputs) {
  if (typeof arg !== 'string' || arg.trim().length === 0) {
    return null;
  }
  const value = arg.trim();

  if (SEMVER_RE.test(value)) {
    const name = pickInputName('version', usedInputs);
    return {
      name,
      schema: {
        type: 'string',
        pattern: SEMVER_RE.source,
        description: toInputDescription(name),
      },
      defaultValue: value,
    };
  }

  if (ENV_VALUE_SET.has(value.toLowerCase())) {
    const name = pickInputName('target_env', usedInputs);
    return {
      name,
      schema: {
        type: 'string',
        enum: [...ENV_VALUE_SET],
        description: toInputDescription(name),
      },
      defaultValue: value,
    };
  }

  if (value === '.' || value === '..' || PATH_HINT_RE.test(value)) {
    const base = usedInputs.has('working_dir') ? 'path' : 'working_dir';
    const name = pickInputName(base, usedInputs);
    return {
      name,
      schema: {
        type: 'string',
        pattern: '^([.]{1,2}/|/).*$|^[^\\s]+\\.[^\\s]+$',
        description: toInputDescription(name),
      },
      defaultValue: value,
    };
  }

  return null;
}

function inferTemplateInputsFromArgs(args, existingInputs = {}) {
  const resolvedInputMap = {};
  for (const [name, value] of Object.entries(existingInputs || {})) {
    if (value === undefined || value === null) {
      continue;
    }
    resolvedInputMap[normalizeToString(value)] = name;
  }

  const usedInputNames = new Set(Object.keys(existingInputs || {}));
  const inferredInputs = {};
  const mappedArgs = [];

  for (const arg of args || []) {
    const existing = inferInputFromArg(arg, usedInputNames);
    const exactResolvedName = resolvedInputMap[normalizeToString(arg)];

    if (exactResolvedName) {
      const exactName = usedInputNames.has(exactResolvedName)
        ? exactResolvedName
        : pickInputName(exactResolvedName, usedInputNames);

      if (!inferredInputs[exactName]) {
        inferredInputs[exactName] = {
          ...(schemaFromValue(exactName, existingInputs[exactResolvedName])),
          default: existingInputs[exactResolvedName],
        };
      }
      mappedArgs.push(`{{inputs.${exactName}}}`);
      continue;
    }

    if (!existing) {
      mappedArgs.push(arg);
      continue;
    }
    if (!inferredInputs[existing.name]) {
      const inputDefault = existingInputs?.[existing.name];
      inferredInputs[existing.name] = {
        ...existing.schema,
        ...(inputDefault !== undefined ? { default: inputDefault } : {}),
      };
    }
    mappedArgs.push(`{{inputs.${existing.name}}}`);
  }

  return { inputs: inferredInputs, args: mappedArgs };
}

function buildTemplateFromArgInference(manifestArgs, resolvedInputs, existingInputs = {}) {
  const argInference = inferTemplateInputsFromArgs(manifestArgs, existingInputs);
  const resolvedInference = inferTemplateInputsFromResolvedInputs(
    argInference.args,
    resolvedInputs,
    existingInputs,
    new Set(Object.keys(argInference.inputs)),
  );

  return {
    args: resolvedInference.args,
    inputs: mergeInputs(argInference.inputs, resolvedInference.inputs),
  };
}

function sourceFromManifest(manifest) {
  if (manifest?._source) {
    return {
      type: manifest._source.type || 'imported',
      source: manifest._source.source || null,
      content_hash: manifest._source.content_hash,
      trust_class:
        manifest._source.trust_class
        || manifest.riskAssessment?.trustClass
        || manifest.riskAssessment?.trust_class
        || 'reviewed_internal',
      installed_at: manifest._source.installed_at || new Date().toISOString(),
    };
  }

  if (manifest?.kind === 'recipe' && manifest.recipeHash) {
    return {
      type: 'recipe',
      source: manifest.recipe?.id || null,
      content_hash: manifest.recipeHash,
      trust_class: manifest.riskAssessment?.trustClass || 'pinned_external',
      installed_at: new Date().toISOString(),
    };
  }

  if (manifest?.kind === 'command' && manifest.contract) {
    return {
      type: 'command',
      source: manifest.contract.command || null,
      content_hash: manifest.contractHash || manifest.contract?.contractHash || null,
      trust_class: manifest.riskAssessment?.trustClass || 'reviewed_internal',
      installed_at: new Date().toISOString(),
    };
  }

  return undefined;
}

function buildTemplateFromCommandManifest(manifest, options = {}) {
  if (!manifest?.contract?.command) {
    throw new Error('Approved command manifest does not include a command');
  }

  const args = manifest.contract.args || [];
  const resolvedInputs = manifest.resolvedInputs || {};
  const existingInputs = manifest.resolvedInputs || {};
  const inference = buildTemplateFromArgInference(args, resolvedInputs, existingInputs);
  const inferredInputs = inference.inputs;
  const inferredArgs = inference.args;

  const requiresEnv = dedupeStringList([
    ...(manifest.contract.envPolicy?.allow || []),
    ...(manifest.contract.env?.allow || []),
    ...(manifest.contract.envPolicy?.allowIfSet || []),
    ...(manifest.requires_env || []),
  ]);

  return {
    version: 1,
    kind: 'template',
    name: normalizeTemplateName(options.name || manifest.template || manifest.contract.command),
    description: `Template generated from approved manifest ${basename(options.sourcePath || 'manifest')}`,
    trust_class: 'reviewed_internal',
    risk: mapTemplateRisk(manifest.riskAssessment?.riskLevel || manifest.contract?.risk || 'green'),
    risk_reasons: manifest.riskAssessment?.reasons || [],
    inputs: inferredInputs,
    run: {
      command: manifest.contract.command,
      args: inferredArgs,
      mode: 'structured',
      env: {
        allow: dedupeStringList([
          ...(manifest.contract.envPolicy?.allow || []),
          ...(manifest.contract.env?.allow || []),
        ]),
      },
    },
    idempotent: true,
    ...(requiresEnv.length > 0 ? { requires_env: requiresEnv } : {}),
    ...(options.source ? { _source: options.source } : {}),
  };
}

function buildTemplateFromRecipeManifest(manifest, options = {}) {
  const recipe = manifest.recipe;
  if (!recipe || !Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    throw new Error('Approved recipe manifest is missing steps');
  }

  const existingInputs = manifest.resolvedInputs || {};
  const steps = [];
  const mergedInputs = {};

  for (let i = 0; i < recipe.steps.length; i += 1) {
    const step = recipe.steps[i];
    if (!step?.run?.command || !Array.isArray(step.run.args)) {
      throw new Error(`Recipe step ${i} is missing a structured command`);
    }
    const inferred = inferTemplateInputsFromArgs(step.run.args, existingInputs);
    for (const key of Object.keys(inferred.inputs)) {
      if (!mergedInputs[key]) {
        mergedInputs[key] = inferred.inputs[key];
      }
    }

    steps.push({
      id: step.id,
      description: step.description || `Run ${step.run.command}`,
      run: {
        command: step.run.command,
        args: inferred.args,
        mode: 'structured',
        env: {
          allow: dedupeStringList([
            ...(step.run.env?.allow || []),
            ...(step.run.envPolicy?.allow || []),
          ]),
        },
      },
      idempotent: step.idempotent !== false,
      validator: step.validator || null,
    });
  }

  const envFromManifest = manifest.requires_env || [];
  const envFromSteps = new Set();
  for (const step of recipe.steps) {
    const stepEnv = step.run?.env?.allow || step.run?.envPolicy?.allow;
    if (Array.isArray(stepEnv)) {
      for (const key of stepEnv) {
        envFromSteps.add(key);
      }
    }
  }
  const requiresEnv = [...new Set([...envFromManifest, ...envFromSteps])];

  return {
    version: 1,
    kind: 'workflow_template',
    name: normalizeTemplateName(options.name || manifest.recipe?.id || recipe.id || recipe.name || 'recipe-template'),
    description: `Template generated from approved recipe ${recipe.id || recipe.name || 'recipe'}`,
    trust_class: 'reviewed_internal',
    risk: mapTemplateRisk(manifest.riskAssessment?.riskLevel || recipe.risk_level || 'yellow'),
    risk_reasons: manifest.riskAssessment?.reasons || [],
    inputs: Object.keys(mergedInputs).length > 0 ? mergedInputs : {},
    steps,
    ...(requiresEnv.length > 0 ? { requires_env: requiresEnv } : {}),
    ...(options.source ? { _source: options.source } : {}),
  };
}

function loadManifestFile(manifestPath) {
  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read approved manifest at ${manifestPath}: ${err.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in approved manifest at ${manifestPath}: ${err.message}`);
  }
}

export function buildTemplateFromApprovedManifest(manifestOrPath, options = {}) {
  const manifest = typeof manifestOrPath === 'string'
    ? loadManifestFile(resolve(manifestOrPath))
    : manifestOrPath;

  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Approved manifest must be an object or JSON file path');
  }

  const source = sourceFromManifest(manifest);

  if (manifest.kind === 'command') {
    return buildTemplateFromCommandManifest(manifest, {
      ...options,
      source,
      sourcePath: options.sourcePath || manifestPathOrUnknown(manifestOrPath),
    });
  }

  if (manifest.kind === 'recipe') {
    return buildTemplateFromRecipeManifest(manifest, { ...options, source });
  }

  if (manifest.kind === 'template') {
    throw new Error('Template manifests do not require conversion');
  }

  throw new Error(`Unsupported manifest kind: ${manifest.kind}`);
}

function manifestPathOrUnknown(manifestOrPath) {
  return typeof manifestOrPath === 'string' ? manifestOrPath : 'manifest';
}

export function templateDefinitionMatchesSource(templateDef) {
  if (!templateDef || typeof templateDef !== 'object') {
    return false;
  }
  const source = templateDef._source;
  if (!source || !source.content_hash || typeof source.content_hash !== 'string') {
    return false;
  }
  return hashTemplateDefinition(templateDef) === source.content_hash;
}

export function resolveTemplateTrustClass(templateDef, fallbackTrustClass = 'reviewed_internal') {
  if (!templateDef || typeof templateDef !== 'object') {
    return fallbackTrustClass;
  }
  const base = templateDef.trust_class || fallbackTrustClass;
  if (!templateDef._source?.content_hash) return base;
  return templateDefinitionMatchesSource(templateDef)
    ? (templateDef._source.trust_class || base)
    : 'reviewed_internal';
}

export function hashTemplateDefinition(templateDef) {
  const { _source, ...content } = templateDef || {};
  return createHash('sha256').update(serializeStable(content)).digest('hex');
}

export function listTemplates(templatesDir = '.guardrail/templates') {
  const resolvedDir = resolve(templatesDir);
  if (!existsSync(resolvedDir)) return [];

  const stats = statSync(resolvedDir);
  if (!stats.isDirectory()) {
    throw new Error(`Template directory is not a directory: ${resolvedDir}`);
  }

  const entries = readdirSync(resolvedDir, { withFileTypes: true });
  const rows = [];

  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.json') continue;

    const filePath = resolve(resolvedDir, entry.name);
    let raw;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    let def;
    try {
      def = JSON.parse(raw);
    } catch {
      continue;
    }

    if (def.version !== 1 || !TEMPLATE_KINDS.has(def.kind)) continue;

    try {
      validateTemplate(def);
    } catch {
      continue;
    }

    rows.push({
      path: filePath,
      name: def.name,
      kind: def.kind,
      trustClass: def.trust_class,
      effectiveTrustClass: resolveTemplateTrustClass(def, def.trust_class),
      source: def._source
        ? {
          type: def._source.type || 'imported',
          source: def._source.source || null,
          trust_class: def._source.trust_class || def.trust_class,
          content_hash: def._source.content_hash || null,
          installed_at: def._source.installed_at || null,
        }
        : null,
      sourceMatch: def._source ? templateDefinitionMatchesSource(def) : null,
    });
  }

  rows.sort((left, right) => left.name.localeCompare(right.name));
  return rows;
}

/**
 * Create a template approval manifest.
 */
export function createTemplateManifest(templateDef, templateHash, riskAssessment, resolvedInputs, envIntersection) {
  const inputApprovalEnvelopes = buildInputApprovalEnvelopes(templateDef.inputs || {});
  return {
    version: TEMPLATE_MANIFEST_VERSION,
    tool: 'guardrail',
    kind: 'template',
    template: templateDef.name,
    templateKind: templateDef.kind,
    approvedAt: new Date().toISOString(),
    templateHash,
    templateDefHash: hashTemplateDefinition(templateDef),
    resolvedInputs,
    inputApprovalEnvelopes,
    envIntersection,
    riskAssessment: {
      trustClass:                 riskAssessment.trustClass   ?? templateDef.trust_class,
      riskLevel:                  riskAssessment.riskLevel    ?? templateDef.risk,
      reasons:                    riskAssessment.reasons      ?? templateDef.risk_reasons ?? [],
      requiresStrongConfirmation: riskAssessment.requiresStrongConfirmation ?? false,
      acknowledgedBy:             riskAssessment.acknowledgedBy ?? null,
      acknowledgedAt:             riskAssessment.acknowledgedAt ?? null,
    },
  };
}

/**
 * Diff a candidate template manifest against an approved one.
 * Returns an array of human-readable diff strings.
 */
export function diffTemplateManifests(candidate, approved) {
  const diffs = [];

  if (candidate.template !== approved.template) {
    diffs.push(`~ template name: "${approved.template}" -> "${candidate.template}"`);
  }
  const hasApprovalEnvelopes = approved && Object.keys(approved.inputApprovalEnvelopes || {}).length > 0;
  const hasTemplateDefHashMetadata =
    approved?.templateDefHash !== undefined && candidate?.templateDefHash !== undefined;

  if (hasTemplateDefHashMetadata && candidate.templateDefHash !== approved.templateDefHash) {
    diffs.push(`~ templateDefHash: ${approved.templateDefHash?.slice(0, 12)}... -> ${candidate.templateDefHash?.slice(0, 12)}...`);
  }

  // Compare resolved inputs
  const cInputs = candidate.resolvedInputs || {};
  const aInputs = approved.resolvedInputs || {};
  const allKeys = new Set([...Object.keys(cInputs), ...Object.keys(aInputs)]);
  if (!hasApprovalEnvelopes) {
    for (const key of allKeys) {
      if (JSON.stringify(cInputs[key]) !== JSON.stringify(aInputs[key])) {
        diffs.push(`~ input "${key}": ${JSON.stringify(aInputs[key])} -> ${JSON.stringify(cInputs[key])}`);
      }
    }
  } else {
    for (const key of allKeys) {
      const envelope = approved.inputApprovalEnvelopes[key];
      if (
        envelope?.type === 'interactive_message'
        && canReuseInteractiveMessage(candidate, approved)
        && typeof cInputs[key] === 'string'
        && typeof aInputs[key] === 'string'
      ) {
        continue;
      }
      diffInputValue(key, cInputs[key], aInputs[key], envelope, diffs);
    }
  }

  if (!hasApprovalEnvelopes && candidate.templateHash !== approved.templateHash) {
    diffs.push(`~ templateHash: ${approved.templateHash?.slice(0, 12)}... -> ${candidate.templateHash?.slice(0, 12)}...`);
  }

  // Compare env intersection
  const cEnv = JSON.stringify(candidate.envIntersection || []);
  const aEnv = JSON.stringify(approved.envIntersection || []);
  if (cEnv !== aEnv) {
    diffs.push(`~ envIntersection: ${aEnv} -> ${cEnv}`);
  }

  // Compare risk
  const cRisk = candidate.riskAssessment || {};
  const aRisk = approved.riskAssessment || {};
  if (cRisk.riskLevel !== aRisk.riskLevel) {
    diffs.push(`~ riskLevel: ${aRisk.riskLevel} -> ${cRisk.riskLevel}`);
  }
  if (cRisk.trustClass !== aRisk.trustClass) {
    diffs.push(`~ trustClass: ${aRisk.trustClass} -> ${cRisk.trustClass}`);
  }

  return diffs;
}

export function compareTemplateManifests(candidate, approved) {
  const diffs = diffTemplateManifests(candidate, approved);
  return { matches: diffs.length === 0, diffs };
}

// ---------------------------------------------------------------------------
// Explain — human-readable description
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable explanation of what a template does.
 *
 * @param {object} def - The template definition.
 * @returns {string} Multi-line explanation.
 */
export function explainTemplate(def) {
  const lines = [];
  lines.push(`Template: ${def.name}`);
  lines.push(`Risk:     ${def.risk.toUpperCase()}${def.risk_reasons?.length ? ` (${def.risk_reasons.join(', ')})` : ''}`);
  lines.push(`Trust:    ${def.trust_class}`);
  lines.push(`Kind:     ${def.kind === 'template' ? 'single command' : 'multi-step workflow'}`);
  lines.push('');
  lines.push('What it does:');

  if (def.kind === 'template') {
    lines.push(`  1. Runs \`${def.run.command}\` in structured mode (no shell).`);
    if (def.description) {
      lines.push(`     ${def.description}`);
    }
  } else {
    (def.steps || []).forEach((step, i) => {
      lines.push(`  ${i + 1}. Runs \`${step.run.command}\` in structured mode (no shell).`);
      if (step.description) {
        lines.push(`     ${step.description}`);
      }
    });
  }

  if (def.rollback?.steps?.length) {
    lines.push(`  On failure, runs rollback: ${def.rollback.steps.map(s => s.run.command).join(', ')}`);
  }

  lines.push('');
  lines.push('What it needs from you:');
  for (const [key, schema] of Object.entries(def.inputs || {})) {
    let hint = '';
    if (schema.enum) hint = ` (one of: ${schema.enum.join(', ')})`;
    else if (schema.pattern) hint = ` (pattern: ${schema.pattern})`;
    else if (schema.type === 'integer') {
      const parts = [];
      if (schema.min !== undefined) parts.push(`min: ${schema.min}`);
      if (schema.max !== undefined) parts.push(`max: ${schema.max}`);
      if (parts.length) hint = ` (${parts.join(', ')})`;
    }
    const desc = schema.description ? ` — ${schema.description}` : '';
    lines.push(`  - Input:   ${key}${hint}${desc}`);
  }
  for (const env of (def.requires_env || [])) {
    lines.push(`  - Env var: ${env} (you must allow this in your envPolicy)`);
  }

  lines.push('');
  lines.push('What it cannot do:');
  lines.push('  - Access any env var you have not explicitly allowed.');
  lines.push('  - Run arbitrary shell commands.');
  lines.push('  - Modify its own rollback contract.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Schema — describe what inputs a template expects
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable schema description of a template's inputs.
 *
 * @param {object} def - The template definition.
 * @returns {string} Multi-line schema description.
 */
export function describeSchema(def) {
  const lines = [];
  lines.push(`Template: ${def.name}`);
  lines.push('');
  lines.push('Inputs:');
  for (const [key, schema] of Object.entries(def.inputs || {})) {
    lines.push(`  ${key}:`);
    lines.push(`    type:     ${schema.type}`);
    if (schema.description) lines.push(`    desc:     ${schema.description}`);
    if (schema.pattern) lines.push(`    pattern:  ${schema.pattern}`);
    if (schema.enum) lines.push(`    enum:     [${schema.enum.join(', ')}]`);
    if (schema.default !== undefined) lines.push(`    default:  ${JSON.stringify(schema.default)}`);
    if (schema.min !== undefined) lines.push(`    min:      ${schema.min}`);
    if (schema.max !== undefined) lines.push(`    max:      ${schema.max}`);
  }
  if (def.requires_env?.length) {
    lines.push('');
    lines.push('Required environment variables:');
    for (const env of def.requires_env) {
      lines.push(`  - ${env}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Simulate — dry-run with given inputs
// ---------------------------------------------------------------------------

/**
 * Simulate a template run with given inputs.
 *
 * @param {object} def           - The template definition.
 * @param {object} userInputs    - Map of input key → value.
 * @param {string[]} callerAllow - Caller's env allow list.
 * @returns {{ output: string, errors: string[] }}
 */
export function simulateTemplate(def, userInputs, callerAllow) {
  const validation = validateUserInputs(def.inputs, userInputs);
  if (!validation.valid) {
    return { output: '', errors: validation.errors };
  }

  const resolvedSteps = buildResolvedSteps(def, validation.values);
  const rollbackSteps = buildResolvedRollbackSteps(def, validation.values);
  const envResult = computeEnvIntersection(def.requires_env || [], callerAllow || []);

  const lines = [];
  lines.push('Simulation (no execution)');
  lines.push('');

  for (const step of resolvedSteps) {
    lines.push('Resolved args:');
    lines.push(`  Step: ${step.id}`);
    lines.push(`  Command: ${step.run.command}`);
    lines.push(`  Args:    ${JSON.stringify(step.run.args)}`);
    if (envResult.intersection.length > 0) {
      const envDisplay = {};
      for (const k of envResult.intersection) envDisplay[k] = '[from caller env]';
      lines.push(`  Env:     ${JSON.stringify(envDisplay)}`);
    }
    lines.push('  Mode:    structured');
    lines.push('');
  }

  if (rollbackSteps.length > 0) {
    lines.push('Rollback would run:');
    for (const step of rollbackSteps) {
      lines.push(`  Step: ${step.id}`);
      lines.push(`  Command: ${step.run.command}`);
      lines.push(`  Args:    ${JSON.stringify(step.run.args)}`);
      if (envResult.intersection.length > 0) {
        const envDisplay = {};
        for (const k of envResult.intersection) envDisplay[k] = '[from caller env]';
        lines.push(`  Env:     ${JSON.stringify(envDisplay)}`);
      }
      lines.push('');
    }
  }

  lines.push(`Risk classification:   ${def.risk.toUpperCase()}`);

  if (envResult.denied.length > 0) {
    lines.push('');
    lines.push('Environment warnings:');
    for (const v of envResult.denied) {
      lines.push(`  Template requires ${v} but caller does not allow it.`);
    }
  }

  if (validation.warnings.length > 0) {
    lines.push('');
    lines.push('Input warnings:');
    for (const w of validation.warnings) {
      lines.push(`  ${w}`);
    }
  }

  lines.push('');
  lines.push('No processes were spawned.');

  return { output: lines.join('\n'), errors: [] };
}

// ---------------------------------------------------------------------------
// Risk evaluation for templates
// ---------------------------------------------------------------------------

/**
 * Evaluate risk for a template based on its definition and declared properties.
 * Uses the template's trust_class, risk, and risk_reasons as the baseline,
 * then checks for signals that would escalate.
 *
 * @param {object} def - The template definition.
 * @param {string[]} envIntersection - The resolved env intersection.
 * @returns {{ trustClass: string, riskLevel: string, reasons: string[], requiresStrongConfirmation: boolean }}
 */
export function evaluateTemplateRisk(def, envIntersection) {
  const reasons = [...(def.risk_reasons || [])];
  let riskLevel = def.risk;
  const trustClass = resolveTemplateTrustClass(def, def.trust_class);

  // Escalation: trust class
  if (trustClass === 'generated' || trustClass === 'unknown') {
    riskLevel = 'red';
    if (!reasons.includes('untrusted provenance')) {
      reasons.push('untrusted provenance');
    }
  }

  if (def?._source?.content_hash && !templateDefinitionMatchesSource(def)) {
    const reason = 'template modified from source provenance';
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
  }

  // Escalation: secret env vars with yellow+ risk
  const hasSecretEnv = (envIntersection || []).some(v => HIGH_RISK_ENV_PATTERNS.test(v));
  if (hasSecretEnv && riskLevel !== 'green') {
    if (riskLevel === 'yellow') {
      // secret + yellow stays yellow (per doc), but flag it
    }
    if (!reasons.includes('secret in env handshake')) {
      reasons.push('secret in env handshake');
    }
  }

  const riskOrder = { green: 0, yellow: 1, red: 2 };
  const computedOrder = riskOrder[riskLevel] ?? 2;
  const declaredOrder = riskOrder[def.risk] ?? 0;
  if (declaredOrder < computedOrder) {
    riskLevel = Object.entries(riskOrder).find(([, v]) => v === computedOrder)?.[0] ?? 'red';
  }

  return {
    trustClass,
    riskLevel,
    reasons,
    requiresStrongConfirmation: riskLevel === 'red',
  };
}
