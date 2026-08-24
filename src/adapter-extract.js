/**
 * adapter-extract.js — Strict JSONPath-subset value extractor for adapter system.
 *
 * Security-critical: only dot-notation paths allowed, no code execution,
 * no mutation, no bracket notation, no wildcards, no array indexing.
 */

// --- Path grammar -----------------------------------------------------------

const VALID_PATH = /^\$(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/;

const DANGEROUS_TOKENS = [
  '__proto__',
  'constructor',
  'prototype',
  'eval',
  'exec',
  'require',
  'Function',
  'import',
];

// --- Public API -------------------------------------------------------------

/**
 * Validate a JSONPath-subset path string.
 * @param {string} path - e.g. "$.command", "$.guardrail.reason"
 * @returns {{ valid: boolean, error?: string }}
 */
export function validatePath(path) {
  if (typeof path !== 'string') {
    return { valid: false, error: 'Path must be a string' };
  }
  if (!VALID_PATH.test(path)) {
    return {
      valid: false,
      error: `Path does not match allowed grammar (dot notation only): ${path}`,
    };
  }
  const segments = path.slice(2).split('.'); // drop leading "$."
  for (const seg of segments) {
    for (const token of DANGEROUS_TOKENS) {
      if (seg === token) {
        return {
          valid: false,
          error: `Path contains dangerous token "${token}": ${path}`,
        };
      }
    }
  }
  return { valid: true };
}

/**
 * Extract a value from an object using a validated dot-notation path.
 * Returns undefined for missing paths. Throws on invalid paths.
 * Pure — never mutates obj.
 *
 * @param {object} obj - source object
 * @param {string} path - JSONPath-subset path, e.g. "$.guardrail.reason"
 * @returns {*} the value, or undefined if the path does not exist in obj
 */
export function extractValue(obj, path) {
  const result = validatePath(path);
  if (!result.valid) {
    throw new Error(`Invalid extraction path: ${result.error}`);
  }
  if (obj == null || typeof obj !== 'object') {
    return undefined;
  }
  const segments = path.slice(2).split('.'); // drop "$."
  let current = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, seg)) {
      return undefined;
    }
    current = current[seg];
  }
  return current;
}

/**
 * Resolve a human-readable template string by replacing `{{dotted.path}}`
 * placeholders with values extracted from data.
 *
 * Placeholder paths use dot notation WITHOUT the leading "$." —
 * e.g. `{{guardrail.reason}}` resolves `$.guardrail.reason` from data.
 *
 * Missing values are replaced with empty string.
 * Invalid paths inside placeholders cause a throw.
 *
 * @param {string} template - e.g. "Blocked: {{guardrail.reason}}"
 * @param {object} data - source object
 * @returns {string} resolved template
 */
export function resolveTemplate(template, data) {
  if (typeof template !== 'string') {
    throw new Error('Template must be a string');
  }
  if (data == null || typeof data !== 'object') {
    throw new Error('Data must be a non-null object');
  }

  // Match all {{placeholder}} tokens
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, inner) => {
    const trimmed = inner.trim();
    if (trimmed.length === 0) {
      throw new Error('Empty placeholder in template');
    }
    // Build full JSONPath from the placeholder
    const fullPath = `$.${trimmed}`;
    // extractValue will throw if the path is invalid
    const value = extractValue(data, fullPath);
    return value !== undefined ? String(value) : '';
  });
}
