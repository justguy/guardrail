import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

const SHELL_METACHARACTERS = /[|><&;$`()]/;

const DEFAULTS = {
  command: '',
  args: [],
  cwd: process.cwd(),
  mode: 'structured',
  shell: null,
  shellFeatures: {
    pipes: false,
    redirects: false,
    subshells: false,
    envExpansion: false,
  },
  allowedBinaries: [],
  writablePaths: [],
  readablePaths: [],
  envPolicy: {
    inherit: false,
    allow: ['PATH'],
    inject: {},
  },
  childProcessPolicy: 'deny',
  networkPolicy: 'undeclared',
  retryPolicy: {
    maxRetries: 3,
    backoff: [1000, 2000, 4000],
  },
  timeoutMs: 60000,
  fileHash: null,
  updatePolicy: {
    allowedActions: ['apply_patch', 'run_script'],
  },
};

function deepMergeDefaults(defaults, provided) {
  const result = {};
  for (const key of Object.keys(defaults)) {
    if (!(key in provided) || provided[key] === undefined) {
      result[key] = structuredClone(defaults[key]);
    } else if (
      defaults[key] !== null &&
      typeof defaults[key] === 'object' &&
      !Array.isArray(defaults[key]) &&
      typeof provided[key] === 'object' &&
      provided[key] !== null &&
      !Array.isArray(provided[key])
    ) {
      result[key] = deepMergeDefaults(defaults[key], provided[key]);
    } else {
      result[key] = structuredClone(provided[key]);
    }
  }
  for (const key of Object.keys(provided)) {
    if (!(key in defaults)) {
      result[key] = structuredClone(provided[key]);
    }
  }
  return result;
}

function resolveAbsolutePath(p, cwd) {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  try {
    return realpathSync(abs);
  } catch {
    return resolve(abs);
  }
}

function inferDefaultBinary(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  return trimmed;
}

export function detectShellFeatures(shellText) {
  if (typeof shellText !== 'string') {
    return { pipes: false, redirects: false, subshells: false, envExpansion: false };
  }
  return {
    pipes: /\|/.test(shellText),
    redirects: />{1,2}|</.test(shellText),
    subshells: /\$\(|`/.test(shellText),
    envExpansion: /\$[A-Za-z_]|\$\{/.test(shellText),
  };
}

export function hasShellMetacharacters(text) {
  return SHELL_METACHARACTERS.test(text);
}

export function serializeStable(obj) {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(item => serializeStable(item)).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const entries = keys.map(k => JSON.stringify(k) + ':' + serializeStable(obj[k]));
  return '{' + entries.join(',') + '}';
}

export function createContract(options = {}) {
  const merged = deepMergeDefaults(DEFAULTS, options);

  if (
    merged.mode !== 'shell' &&
    Array.isArray(merged.allowedBinaries) &&
    merged.allowedBinaries.length === 0
  ) {
    const inferredBinary = inferDefaultBinary(merged.command);
    if (inferredBinary) {
      merged.allowedBinaries = [inferredBinary];
    }
  }

  if (Array.isArray(merged.writablePaths) && merged.writablePaths.length === 0 && merged.cwd) {
    merged.writablePaths = [merged.cwd];
  }

  if (Array.isArray(merged.readablePaths) && merged.readablePaths.length === 0 && merged.cwd) {
    merged.readablePaths = [merged.cwd];
  }

  if (merged.mode === 'shell' && merged.shell) {
    merged.shellFeatures = detectShellFeatures(merged.shell);
  }

  return normalizeContract(merged);
}

export function normalizeContract(contract) {
  const result = deepMergeDefaults(DEFAULTS, contract);

  const cwd = resolveAbsolutePath(result.cwd, process.cwd());
  result.cwd = cwd;

  if (result.allowedBinaries.length > 0) {
    result.allowedBinaries = result.allowedBinaries
      .map(b => String(b))
      .sort();
  }

  if (result.writablePaths.length > 0) {
    result.writablePaths = result.writablePaths
      .map(p => resolveAbsolutePath(p, cwd))
      .sort();
  }

  if (result.readablePaths.length > 0) {
    result.readablePaths = result.readablePaths
      .map(p => resolveAbsolutePath(p, cwd))
      .sort();
  }

  if (result.envPolicy && Array.isArray(result.envPolicy.allow)) {
    result.envPolicy.allow = [...result.envPolicy.allow].sort();
  }

  if (result.updatePolicy && Array.isArray(result.updatePolicy.allowedActions)) {
    result.updatePolicy.allowedActions = [...result.updatePolicy.allowedActions].sort();
  }

  if (result.mode === 'shell' && result.shell) {
    result.shellFeatures = detectShellFeatures(result.shell);
  }

  return result;
}

export function hashContract(contract) {
  const normalized = normalizeContract(contract);
  const serialized = serializeStable(normalized);
  return createHash('sha256').update(serialized).digest('hex');
}

// ---------------------------------------------------------------------------
// ReDoS regex safety check
// ---------------------------------------------------------------------------

const REDOS_PATTERNS = [
  { re: /\([^)]*[+*][^)]*\)[+*{]/, desc: 'nested quantifier on group (e.g. (a+)+)' },
  { re: /\([^)]*[+*][^)]*\)\{/, desc: 'quantified group with inner quantifier and brace quantifier (e.g. (a+){2,})' },
  { re: /(\.\*){2,}/, desc: 'multiple adjacent greedy wildcards' },
  { re: /\([^)]*\|[^)]*\)[+*]\{?/, desc: 'alternation in quantified group (e.g. (a|b)+)' },
];

/**
 * Check whether a regex pattern is safe from catastrophic backtracking (ReDoS).
 *
 * @param {string} pattern - The regex pattern string to check.
 * @returns {{ safe: boolean, reason: string|null }}
 */
export function checkRegexSafety(pattern) {
  if (typeof pattern !== 'string') {
    return { safe: true, reason: null };
  }

  for (const { re, desc } of REDOS_PATTERNS) {
    if (re.test(pattern)) {
      return { safe: false, reason: `ReDoS risk: ${desc} detected in pattern "${pattern}"` };
    }
  }

  return { safe: true, reason: null };
}

// ---------------------------------------------------------------------------
// File provenance enforcement
// ---------------------------------------------------------------------------

function resolveCommandPath(command) {
  if (!command || typeof command !== 'string') return null;

  // Absolute path — resolve symlinks directly
  if (isAbsolute(command)) {
    try { return realpathSync(command); } catch { return null; }
  }

  // Search PATH
  const pathDirs = (process.env.PATH || '').split(':');
  for (const dir of pathDirs) {
    const candidate = resolve(dir, command);
    try {
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Verify that a command binary matches a declared SHA-256 file hash.
 *
 * @param {string} command      - Command name or path.
 * @param {string|null} declaredHash - Expected SHA-256 hex digest, or null to skip.
 * @returns {{ verified: boolean, expected?: string, actual?: string, path?: string, skipped: boolean }}
 */
export function verifyFileHash(command, declaredHash) {
  if (declaredHash == null) {
    return { verified: true, skipped: true };
  }

  const resolvedPath = resolveCommandPath(command);
  if (!resolvedPath) {
    return { verified: false, expected: declaredHash, actual: null, path: null, skipped: false };
  }

  let contents;
  try {
    contents = readFileSync(resolvedPath);
  } catch {
    return { verified: false, expected: declaredHash, actual: null, path: resolvedPath, skipped: false };
  }

  const actual = createHash('sha256').update(contents).digest('hex');
  return {
    verified: actual === declaredHash,
    expected: declaredHash,
    actual,
    path: resolvedPath,
    skipped: false,
  };
}
