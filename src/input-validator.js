import { resolve, isAbsolute, extname } from 'node:path';
import { RISK_TRAITS, HARD_LIMITS, checkExecutionShape } from './risk-traits.js';

// ---------------------------------------------------------------------------
// Approval mode inference (backwards compat)
// ---------------------------------------------------------------------------

/**
 * Infer approval mode from legacy schema fields.
 */
export function inferApprovalMode(schema) {
  if (schema.approval_mode) return schema.approval_mode;
  if (schema.type === 'boolean') return 'exact';
  if (schema.enum) return 'enum';
  if (schema.type === 'integer' && (schema.min !== undefined || schema.max !== undefined)) return 'range';
  if (schema.type === 'string' && schema.pattern) return 'string_pattern';
  // No constraints → review_each_time (safe fallback)
  return 'review_each_time';
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a path value: collapse separators, strip ./, reject nulls.
 */
export function normalizePath(value) {
  let p = String(value).replace(/\\/g, '/').replace(/\/+/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  if (p.endsWith('/') && p.length > 1) p = p.slice(0, -1);
  return p;
}

/**
 * Normalize a value based on its type/mode.
 */
export function normalizeValue(value, schema) {
  const mode = inferApprovalMode(schema);
  if (mode === 'path_policy') return normalizePath(value);
  if (schema.type === 'string') return String(value).trim();
  if (schema.type === 'integer') return Number(value);
  if (schema.type === 'boolean') return value === 'true' || value === true;
  return value;
}

// ---------------------------------------------------------------------------
// Shell content parser (structural, not just regex)
// ---------------------------------------------------------------------------

const PROD_PATTERNS = /\bprod(uction)?\b|\bstaging\b|\blive\b|\brelease\b/i;
const SECRET_PATTERNS = /secret|token|password|api[_-]?key|credential|auth|private[_-]?key/i;
const DESTRUCTIVE_VERBS = /\b(delete|remove|drop|wipe|destroy|truncate|purge|force.push|rm\s+-[a-zA-Z]*r[a-zA-Z]*f|mkfs|shred)\b/i;

/**
 * Parse a string for shell operators and return structured shape + traits.
 */
export function analyzeShellContent(value) {
  const traits = [];
  const commands = [];
  const operators = [];

  // Tokenize on shell operators
  const segments = String(value).split(/(\s*(?:&&|\|\||;|\|)\s*)/);
  let current = [];

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (/^(&&|\|\||;|\|)$/.test(trimmed)) {
      if (current.length > 0) commands.push(current);
      operators.push(trimmed);
      current = [];
      if (trimmed === '&&' || trimmed === ';') traits.push('execution_chaining');
      if (trimmed === '|' || trimmed === '||') traits.push('io_redirection');
    } else if (trimmed) {
      current.push(...trimmed.split(/\s+/));
    }
  }
  if (current.length > 0) commands.push(current);

  // Additional detection
  if (/\$\(|`/.test(value)) traits.push('command_substitution');
  if (/>{1,2}|</.test(value)) traits.push('io_redirection');
  if (/--force\b/.test(value)) traits.push('recursive_flag');
  if (/--all\b|-[a-zA-Z]*R/.test(value)) traits.push('recursive_flag');
  if (/\.\.\//.test(value)) traits.push('scope_widening');

  return { traits: [...new Set(traits)], parsed: { commands, operators } };
}

// ---------------------------------------------------------------------------
// Semantic scanners (applied to any string value)
// ---------------------------------------------------------------------------

function scanSemanticTraits(value) {
  const traits = [];
  if (PROD_PATTERNS.test(value)) traits.push('prod_target_reference');
  if (SECRET_PATTERNS.test(value)) traits.push('secret_reference');
  if (DESTRUCTIVE_VERBS.test(value)) traits.push('destructive_intent');

  // Glob breadth
  const stars = (value.match(/\*/g) || []).length;
  if (stars > HARD_LIMITS.max_glob_star_count) traits.push('unbounded_pattern');
  else if (stars > 0) traits.push('high_cardinality_input');

  return traits;
}

// ---------------------------------------------------------------------------
// Hard limit checks (block, not flag)
// ---------------------------------------------------------------------------

function checkHardLimits(value, schema) {
  const mode = inferApprovalMode(schema);

  if (typeof value === 'string' && value.length > HARD_LIMITS.max_string_length)
    return `String exceeds max length (${value.length} > ${HARD_LIMITS.max_string_length})`;

  if (mode === 'path_policy' || (schema.type === 'string' && typeof value === 'string')) {
    const depth = String(value).split('/').filter(Boolean).length;
    if (depth > HARD_LIMITS.max_path_depth)
      return `Path depth exceeds limit (${depth} > ${HARD_LIMITS.max_path_depth})`;
  }

  if (mode === 'list' && Array.isArray(value)) {
    if (value.length > HARD_LIMITS.max_list_items)
      return `List exceeds max items (${value.length} > ${HARD_LIMITS.max_list_items})`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Path policy validator
// ---------------------------------------------------------------------------

/**
 * Validate a path against a path_policy.
 *
 * @param {string} value
 * @param {object} rules - { must_be_relative, allowed_roots[], deny_segments[], max_depth, allowed_extensions[] }
 * @returns {{ valid: boolean, normalized: string, risk_traits: string[], reasons: string[] }}
 */
export function validatePathPolicy(value, rules) {
  const normalized = normalizePath(value);
  const traits = [];
  const reasons = [];

  // Hard blocks
  if (rules.must_be_relative && isAbsolute(normalized))
    return { valid: false, normalized, risk_traits: ['unsupported_structure'], reasons: ['Must be relative path'] };

  const segments = normalized.split('/');
  if (rules.deny_segments) {
    for (const seg of segments) {
      if (rules.deny_segments.includes(seg))
        return { valid: false, normalized, risk_traits: ['path_escape_attempt'], reasons: [`Denied segment: "${seg}"`] };
    }
  }

  // Traversal check
  if (segments.includes('..')) {
    // After normalization, still has .. → escape attempt
    return { valid: false, normalized, risk_traits: ['path_escape_attempt'], reasons: ['Path traversal detected'] };
  }

  // Scope check (flag, not block)
  if (rules.allowed_roots && rules.allowed_roots.length > 0) {
    const inRoot = rules.allowed_roots.some(r => normalized.startsWith(normalizePath(r)));
    if (!inRoot) {
      traits.push('scope_widening');
      reasons.push(`Outside approved roots: ${rules.allowed_roots.join(', ')}`);
    }
  }

  // Depth check
  if (rules.max_depth && segments.length > rules.max_depth) {
    traits.push('high_cardinality_input');
    reasons.push(`Path depth ${segments.length} exceeds max ${rules.max_depth}`);
  }

  // Extension check
  if (rules.allowed_extensions) {
    const ext = extname(normalized);
    if (ext && !rules.allowed_extensions.includes(ext)) {
      traits.push('scope_widening');
      reasons.push(`Extension "${ext}" not in allowed: ${rules.allowed_extensions.join(', ')}`);
    }
  }

  return { valid: true, normalized, risk_traits: traits, reasons };
}

// ---------------------------------------------------------------------------
// List validator
// ---------------------------------------------------------------------------

/**
 * Validate a list of values.
 *
 * @param {any[]} values
 * @param {object} schema - { max_items, item_validator: { ... } }
 * @returns {{ valid: boolean, normalized: any[], risk_traits: string[], reasons: string[] }}
 */
export function validateList(values, schema) {
  if (!Array.isArray(values))
    return { valid: false, normalized: [], risk_traits: ['unsupported_structure'], reasons: ['Expected array'] };

  if (schema.max_items && values.length > schema.max_items)
    return { valid: false, normalized: [], risk_traits: ['exceeds_hard_limit'], reasons: [`Too many items: ${values.length} > ${schema.max_items}`] };

  const traits = [];
  const reasons = [];
  const normalized = [];

  for (let i = 0; i < values.length; i++) {
    if (schema.item_validator) {
      const r = validateInputValue(values[i], schema.item_validator);
      if (!r.valid) return { valid: false, normalized: [], risk_traits: r.risk_traits, reasons: [`Item ${i}: ${r.reasons.join(', ')}`] };
      traits.push(...r.risk_traits);
      normalized.push(r.normalized ?? values[i]);
    } else {
      normalized.push(values[i]);
    }
  }

  if (values.length > 10) {
    traits.push('high_cardinality_input');
    reasons.push(`List has ${values.length} items`);
  }

  return { valid: true, normalized, risk_traits: [...new Set(traits)], reasons };
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

/**
 * Validate a user-provided input value against its schema.
 *
 * @param {any} value
 * @param {object} schema - Input schema with optional approval_mode.
 * @param {object} [opts] - { execution_shape }
 * @returns {{ valid: boolean, normalized: any, risk_traits: string[], reasons: string[], parsed_shape?: object, never_reuse?: boolean }}
 */
export function validateInputValue(value, schema, opts = {}) {
  const mode = inferApprovalMode(schema);

  // Hard limits first
  const limitError = checkHardLimits(value, schema);
  if (limitError)
    return { valid: false, normalized: value, risk_traits: ['exceeds_hard_limit'], reasons: [limitError] };

  // review_each_time: always flag, never auto-approve
  if (mode === 'review_each_time') {
    const normalized = normalizeValue(value, schema);
    const semTraits = typeof value === 'string' ? scanSemanticTraits(String(value)) : [];
    return {
      valid: true, normalized,
      risk_traits: ['free_text_instruction', ...semTraits],
      reasons: ['This parameter requires fresh approval every time'],
      never_reuse: true,
    };
  }

  // interactive_message: free-form user text that is intended to flow
  // inside an already-approved interactive session. Approval reuse policy is
  // handled at manifest/session comparison time, not here.
  if (mode === 'interactive_message') {
    const normalized = normalizeValue(value, schema);
    return {
      valid: true,
      normalized,
      risk_traits: [],
      reasons: [],
      never_reuse: false,
    };
  }

  // boolean type: validate before mode dispatch
  if (schema.type === 'boolean') {
    if (value === 'true' || value === true)
      return { valid: true, normalized: true, risk_traits: [], reasons: [] };
    if (value === 'false' || value === false)
      return { valid: true, normalized: false, risk_traits: [], reasons: [] };
    return { valid: false, normalized: value, risk_traits: ['unsupported_structure'], reasons: [`Must be a boolean, got "${value}"`] };
  }

  // exact
  if (mode === 'exact') {
    const normalized = normalizeValue(value, schema);
    if (schema.value !== undefined && normalized !== schema.value)
      return { valid: false, normalized, risk_traits: [], reasons: [`Must be exactly "${schema.value}"`] };
    return { valid: true, normalized, risk_traits: [], reasons: [] };
  }

  // enum
  if (mode === 'enum') {
    const str = String(value).trim();
    if (!schema.enum.includes(str))
      return { valid: false, normalized: str, risk_traits: [], reasons: [`Must be one of [${schema.enum.join(', ')}]`] };
    const traits = scanSemanticTraits(str);
    return { valid: true, normalized: str, risk_traits: traits, reasons: traits.map(t => RISK_TRAITS[t]?.capability || t) };
  }

  // range
  if (mode === 'range') {
    const n = Number(value);
    if (!Number.isFinite(n))
      return { valid: false, normalized: value, risk_traits: ['unsupported_structure'], reasons: ['Not a valid number'] };
    if (schema.min !== undefined && n < schema.min)
      return { valid: false, normalized: n, risk_traits: [], reasons: [`Must be >= ${schema.min}`] };
    if (schema.max !== undefined && n > schema.max)
      return { valid: false, normalized: n, risk_traits: [], reasons: [`Must be <= ${schema.max}`] };
    const traits = [];
    if (schema.min !== undefined && schema.max !== undefined && (schema.max - schema.min) > 1000)
      traits.push('high_cardinality_input');
    return { valid: true, normalized: n, risk_traits: traits, reasons: [] };
  }

  // path_policy
  if (mode === 'path_policy') {
    return validatePathPolicy(value, schema.rules || schema);
  }

  // list
  if (mode === 'list') {
    const arr = Array.isArray(value) ? value : String(value).split(',').map(s => s.trim());
    return validateList(arr, schema);
  }

  // string_pattern (legacy: string with pattern, inferred mode)
  if (mode === 'string_pattern') {
    const str = String(value).trim();
    if (schema.pattern && !new RegExp(schema.pattern).test(str))
      return { valid: false, normalized: str, risk_traits: [], reasons: [`Does not match pattern ${schema.pattern}`] };

    // Analyze for shell content + semantic traits
    const shell = analyzeShellContent(str);
    const semantic = scanSemanticTraits(str);
    const allTraits = [...new Set([...shell.traits, ...semantic])];

    // Check execution shape if provided
    if (opts.execution_shape && shell.parsed.commands.length > 0) {
      const shapeTraits = checkExecutionShape(shell.parsed.commands, opts.execution_shape);
      allTraits.push(...shapeTraits);
    }

    const reasons = allTraits.map(t => RISK_TRAITS[t]?.capability || t);
    return {
      valid: true, normalized: str,
      risk_traits: [...new Set(allTraits)], reasons,
      parsed_shape: shell.parsed.commands.length > 1 ? shell.parsed : undefined,
    };
  }

  // Fallback: unknown mode → review_each_time
  const normalized = normalizeValue(value, schema);
  return {
    valid: true, normalized,
    risk_traits: ['free_text_instruction'],
    reasons: ['Unknown approval mode — requires fresh approval'],
    never_reuse: true,
  };
}
