import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { normalizePath, validatePathPolicy } from './input-validator.js';
import { serializeStable } from './contract.js';
import { deepEqual } from './shared.js';

const DEFAULT_VERSION = 1;
const COMMIT_PLAN_KIND = 'commit_plan';
const PLAN_MAX_FILES_FALLBACK = 25;
const PLAN_MAX_DEPTH = 12;
const FORBIDDEN_PATH_CHARACTERS = /[?*[\]{}]/;

function normalizePathString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${fieldName}" must be a non-empty string.`);
  }
  const normalized = normalizePath(value);
  if (FORBIDDEN_PATH_CHARACTERS.test(normalized)) {
    throw new Error(`"${fieldName}" must not include glob patterns.`);
  }
  if (isAbsolute(normalized) || normalized.startsWith('..') || normalized.includes('/../') || normalized === '..') {
    throw new Error(`"${fieldName}" must be a relative path without traversal.`);
  }
  return normalized;
}

function sanitizePathsList(values, fieldName) {
  if (!Array.isArray(values)) {
    throw new Error(`"${fieldName}" must be an array.`);
  }
  const out = [];
  const seen = new Set();
  for (const item of values) {
    const value = normalizePathString(String(item), `${fieldName}[]`);
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function isInside(candidateAbs, rootAbs) {
  const rel = relative(rootAbs, candidateAbs);
  return rel === '' || (rel.startsWith('..') === false && rel !== '' && !isAbsolute(rel));
}

function checkPlanBounds(bounds) {
  if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)) {
    throw new Error('bounds must be an object.');
  }
  const allowedRoots = sanitizePathsList(bounds.allowed_roots, 'bounds.allowed_roots');
  const hasAllowedRoots = allowedRoots.length > 0;
  if (!hasAllowedRoots) {
    throw new Error('bounds.allowed_roots must contain at least one entry.');
  }
  const maxFilesRaw = bounds.max_files;
  if (!Number.isInteger(maxFilesRaw) || maxFilesRaw < 1) {
    throw new Error('bounds.max_files must be a positive integer.');
  }
  return { allowed_roots: allowedRoots, max_files: maxFilesRaw };
}

function validateBoundedPaths(plan, normalizedRepoPath, boundsAbs, maxFiles) {
  if (plan.paths.length === 0) {
    throw new Error('paths must be a non-empty array.');
  }
  if (plan.paths.length > maxFiles) {
    throw new Error(`paths exceeds bounds.max_files (${plan.paths.length} > ${maxFiles}).`);
  }

  const bounded = [];
  for (const path of plan.paths) {
    const normalized = normalizePathString(path, 'paths');
    const check = validatePathPolicy(normalized, {
      must_be_relative: true,
      deny_segments: ['..'],
      max_depth: PLAN_MAX_DEPTH,
    });
    if (!check.valid) {
      throw new Error(`Invalid path "${normalized}": ${check.reasons.join(', ')}`);
    }

    const pathAbs = resolve(normalizedRepoPath, normalized);
    const inAnyRoot = boundsAbs.some((rootAbs) => isInside(pathAbs, rootAbs) || pathAbs === rootAbs);
    if (!inAnyRoot) {
      throw new Error(`Path "${normalized}" is outside bounds.allowed_roots.`);
    }
    bounded.push(normalized);
  }

  return bounded;
}

function normalizePlanBoundsRaw(bounds, repoAbsPath) {
  const normalized = checkPlanBounds(bounds);
  const normalizedRoots = normalized.allowed_roots.map((entry) => normalizePathString(entry, 'bounds.allowed_roots[]'));
  const resolvedRoots = normalizedRoots.map((entry) => resolve(repoAbsPath, entry));
  return {
    allowed_roots: normalizedRoots,
    max_files: normalized.max_files,
    resolved_roots: resolvedRoots,
  };
}

function normalizeSchemaPlan(plan, cwd = process.cwd()) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('Commit plan must be an object.');
  }
  if (plan.version !== DEFAULT_VERSION) {
    throw new Error(`version must be ${DEFAULT_VERSION}.`);
  }
  if (plan.kind !== COMMIT_PLAN_KIND) {
    throw new Error(`kind must be "${COMMIT_PLAN_KIND}".`);
  }

  const normalizedRepoPath = normalizePathString(plan.repo_path ?? '.', 'repo_path');
  if (FORBIDDEN_PATH_CHARACTERS.test(normalizedRepoPath)) {
    throw new Error('repo_path must not include glob patterns.');
  }
  const repoPathCheck = validatePathPolicy(normalizedRepoPath, {
    must_be_relative: true,
    deny_segments: ['..'],
    max_depth: PLAN_MAX_DEPTH,
  });
  if (!repoPathCheck.valid) {
    throw new Error(`repo_path invalid: ${repoPathCheck.reasons.join(', ')}`);
  }
  const repoAbsPath = resolve(cwd, normalizedRepoPath);

  const normalizedPaths = sanitizePathsList(plan.paths || [], 'paths');
  const messageFile = normalizePathString(plan.message_file, 'message_file');
  const messageFilePolicy = validatePathPolicy(messageFile, {
    must_be_relative: true,
    deny_segments: ['..'],
    max_depth: PLAN_MAX_DEPTH,
  });
  if (!messageFilePolicy.valid) {
    throw new Error(`message_file invalid: ${messageFilePolicy.reasons.join(', ')}`);
  }
  const bounds = normalizePlanBoundsRaw(plan.bounds || {}, repoAbsPath);
  const normalizedPathsBounded = validateBoundedPaths(
    { paths: normalizedPaths },
    repoAbsPath,
    bounds.resolved_roots,
    bounds.max_files,
  );

  const maxFiles = bounds.max_files ?? PLAN_MAX_FILES_FALLBACK;
  if (normalizedPathsBounded.length > maxFiles) {
    throw new Error(`paths exceeds max_files bound (${normalizedPathsBounded.length} > ${maxFiles}).`);
  }

  return {
    version: DEFAULT_VERSION,
    kind: COMMIT_PLAN_KIND,
    repo_path: normalizedRepoPath,
    summary: plan.summary ? String(plan.summary) : '',
    paths: normalizedPathsBounded,
    message_file: messageFile,
    bounds: {
      allowed_roots: bounds.allowed_roots,
      max_files: bounds.max_files,
    },
    resolved_repo_path: repoAbsPath,
    resolved_message_file: resolve(repoAbsPath, messageFile),
    resolved_paths: normalizedPathsBounded.map((entry) => resolve(repoAbsPath, entry)),
  };
}

export function validateCommitPlan(plan, options = {}) {
  try {
    const normalized = normalizeCommitPlan(plan, options);
    return { valid: true, normalized, errors: [] };
  } catch (err) {
    return { valid: false, normalized: null, errors: [err.message] };
  }
}

export function normalizeCommitPlan(plan, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  return normalizeSchemaPlan(plan, cwd);
}

export function hashCommitPlan(plan, options = {}) {
  const normalized = normalizeCommitPlan(plan, options);
  const payload = {
    version: normalized.version,
    kind: normalized.kind,
    repo_path: normalized.repo_path,
    summary: normalized.summary,
    paths: normalized.paths,
    message_file: normalized.message_file,
    bounds: normalized.bounds,
  };
  return createHash('sha256')
    .update(serializeStable(payload))
    .digest('hex');
}

export function compareCommitPlans(candidatePlan, approvedPlan, options = {}) {
  let candidate;
  let approved;
  try {
    candidate = normalizeCommitPlan(candidatePlan, options);
    approved = normalizeCommitPlan(approvedPlan, options);
  } catch (err) {
    return { matches: false, diffs: [err.message] };
  }

  const diffs = [];
  const fields = ['version', 'kind', 'repo_path', 'summary', 'message_file'];
  for (const field of fields) {
    if (!deepEqual(candidate[field], approved[field])) {
      diffs.push(`~ ${field}: ${JSON.stringify(approved[field])} -> ${JSON.stringify(candidate[field])}`);
    }
  }

  if (!deepEqual(candidate.paths, approved.paths)) {
    diffs.push(`~ paths: ${JSON.stringify(approved.paths)} -> ${JSON.stringify(candidate.paths)}`);
  }
  if (!deepEqual(candidate.bounds?.allowed_roots, approved.bounds?.allowed_roots)) {
    diffs.push(`~ bounds.allowed_roots: ${JSON.stringify(approved.bounds?.allowed_roots)} -> ${JSON.stringify(candidate.bounds?.allowed_roots)}`);
  }
  if (candidate.bounds?.max_files !== approved.bounds?.max_files) {
    diffs.push(`~ bounds.max_files: ${JSON.stringify(approved.bounds?.max_files)} -> ${JSON.stringify(candidate.bounds?.max_files)}`);
  }

  return { matches: diffs.length === 0, diffs };
}

export function loadCommitPlan(path, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const resolvedPath = resolve(cwd, path);
  const raw = readFileSync(resolvedPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in commit-plan at ${resolvedPath}: ${err.message}`);
  }
  return normalizeCommitPlan(parsed, { ...options, cwd });
}
