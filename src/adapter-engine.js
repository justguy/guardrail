/**
 * adapter-engine.js — Core adapter orchestrator for Guardrail adapter system.
 *
 * The only code that understands both Guardrail internals and the public
 * adapter contract. Translates supervisor results to adapter-result/v1,
 * applies profile response templates, returns structured adapter output.
 *
 * Rules: never scrapes terminal output, never recomputes drift, never
 * mutates native statuses, is the sole compatibility boundary.
 */

import { extractValue, resolveTemplate } from './adapter-extract.js';
import { validateProfile, loadProfile, loadBundledProfile, resolveProfile } from './adapter-profile.js';
import { runSupervisor } from './supervisor.js';
import { checkEnvMappings, checkAuthPrerequisites } from './adapter-auth.js';

// --- Category mapping -------------------------------------------------------

const BLOCKED_STATUSES = new Set([
  'approval_required', 'approval_denied', 'drift_detected',
  'policy_violation', 'unsupported', 'update_denied',
  'time_policy_violated', 'concurrent_blocked',
]);

const FAILED_STATUSES = new Set([
  'validation_failed', 'timeout', 'protocol_error', 'internal_error',
]);

/** Map native Guardrail status to success/blocked/failed. */
export function deriveCategory(nativeStatus) {
  if (nativeStatus === 'success') return 'success';
  if (BLOCKED_STATUSES.has(nativeStatus)) return 'blocked';
  if (FAILED_STATUSES.has(nativeStatus)) return 'failed';
  return 'failed'; // unknown -> fail closed
}

// --- Default reason map -----------------------------------------------------

const DEFAULT_REASONS = {
  success: 'Command executed successfully.',
  approval_required: 'Approval required in non-interactive mode.',
  approval_denied: 'Approval was denied.',
  drift_detected: 'Contract drift detected in non-interactive mode.',
  validation_failed: 'Result validation failed.',
  timeout: 'Execution timed out.',
  policy_violation: 'Policy violation detected.',
  unsupported: 'Unsupported operation.',
  update_denied: 'Update proposal was denied.',
  protocol_error: 'Protocol error occurred.',
  internal_error: 'Internal error occurred.',
  time_policy_violated: 'Time-based policy constraint violated.',
  concurrent_blocked: 'Blocked by concurrency lock.',
};

// --- Normalize to adapter-result/v1 ----------------------------------------

/** Convert a runSupervisor() result to adapter-result/v1. Pure, no mutation. */
export function normalizeToAdapterResult(supervisorResult) {
  if (supervisorResult == null || typeof supervisorResult !== 'object') {
    return buildFailedResult('Supervisor returned null or non-object result.');
  }
  const sr = supervisorResult;
  const nativeStatus = sr.status || 'internal_error';
  const worker = sr.worker || {};
  const driftDetected = sr.drift?.detected ?? false;

  return {
    schemaVersion: 'adapter-result/v1',
    guardrail: {
      nativeStatus,
      category: deriveCategory(nativeStatus),
      reason: sr.reason || DEFAULT_REASONS[nativeStatus] || `Status: ${nativeStatus}`,
      exitCode: sr.exitCode ?? 19,
      contractHash: sr.contractHash || '',
      manifestPath: sr.manifestPath || '',
      riskLevel: sr.riskLevel || '',
      riskReasons: Array.isArray(sr.riskReasons) ? sr.riskReasons : [],
      driftDetected,
      driftSummary: buildDriftSummary(sr.drift),
    },
    process: {
      launched: worker.launched ?? false,
      exitCode: worker.exitCode ?? null,
      timedOut: worker.timedOut ?? false,
      interactivePromptDetected: worker.interactivePromptDetected ?? false,
      stdout: worker.stdout ?? '',
      stderr: worker.stderr ?? '',
      stdoutTruncated: worker.stdoutTruncated ?? false,
      stderrTruncated: worker.stderrTruncated ?? false,
    },
    telemetry: {
      runId: sr.runId || '',
      durationMs: sr.telemetry?.durationMs ?? 0,
    },
  };
}

// --- Response rendering -----------------------------------------------------

/**
 * Render the profile's response template for the result's category.
 * JSON format: walk template, "$." leaf strings extracted from result.
 * Human format: resolveTemplate() from adapter-extract.js.
 */
export function renderResponse(profile, adapterResult) {
  if (!profile?.response) return null;
  const category = adapterResult?.guardrail?.category;
  if (!category) return null;
  const template = profile.response[category];
  if (template == null) return null;

  if ((profile.response?.format || 'json') === 'human') {
    return typeof template === 'string' ? resolveTemplate(template, adapterResult) : null;
  }
  return resolveJsonTemplate(template, adapterResult);
}

/** Recursively resolve "$." paths in a JSON response template. */
function resolveJsonTemplate(node, source) {
  if (node == null) return node;
  if (typeof node === 'string') return node.startsWith('$.') ? extractValue(source, node) : node;
  if (Array.isArray(node)) return node.map(item => resolveJsonTemplate(item, source));
  if (typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) out[key] = resolveJsonTemplate(node[key], source);
    return out;
  }
  return node; // primitives pass through
}

// --- Full adapter orchestration ---------------------------------------------

/**
 * Run the full adapter pipeline: load profile, resolve command, execute
 * supervisor, normalize result, render response.
 * Accepts optional supervisorFn in opts for testing (defaults to runSupervisor).
 */
export async function runAdapter(opts = {}) {
  const {
    tool, profilePath,
    command: directCommand, args: directArgs, cwd: directCwd,
    rawInput, supervisorFn = runSupervisor, envAllow = [], authCheckFn,
  } = opts;

  // 1-2. Load and validate profile (fail closed)
  const profile = loadAdapterProfile(tool, profilePath);
  const validation = validateProfile(profile);
  if (!validation.valid) {
    return wrapFailed(`Adapter profile validation failed: ${validation.errors.join('; ')}`);
  }

  const envCheck = checkEnvMappings(profile.requires_env || [], envAllow, {
    authRequirements: profile.requires_auth || [],
    currentEnv: process.env,
  });
  if (!envCheck.ok) {
    return wrapBlocked(`${envCheck.code}: ${envCheck.message}`);
  }

  const authCheck = await checkAuthPrerequisites(profile.requires_auth || [], {
    cwd: directCwd || process.cwd(),
    checkRunner: authCheckFn,
  });
  if (!authCheck.ok) {
    const detail = authCheck.detail ? ` Detail: ${authCheck.detail}` : '';
    return wrapBlocked(`${authCheck.code}: ${authCheck.message}${detail}`);
  }

  // 3. Resolve command/args/cwd: direct CLI wins, then rawInput via intercept
  let command = directCommand || null;
  let args = Array.isArray(directArgs) ? directArgs : [];
  let cwd = directCwd || null;

  if (!command && rawInput && profile.intercept) {
    const extracted = extractFromIntercept(rawInput, profile.intercept);
    if (extracted.error) {
      return wrapFailed(extracted.error);
    }
    command = extracted.command;
    args = extracted.args;
    cwd = extracted.cwd || cwd;
  }
  if (!command) {
    return wrapFailed('No command resolved from direct input or profile intercept.');
  }

  // 4. Build supervisor options
  const supervisorOptions = {
    command, args, nonInteractive: true, jsonOutput: true,
    ...(profile.defaults || {}),
    envPolicy: {
      inherit: false,
      allow: ['PATH', ...envAllow],
      inject: {},
    },
  };
  if (cwd) supervisorOptions.cwd = cwd;

  // 5. Execute supervisor
  let supervisorResult;
  try {
    supervisorResult = await supervisorFn(supervisorOptions);
  } catch (err) {
    return wrapFailed(`Supervisor execution error: ${err?.message || 'unknown'}`);
  }

  // 6-8. Normalize, render, return
  const adapterResult = normalizeToAdapterResult(supervisorResult);
  const category = adapterResult.guardrail.category;
  return {
    adapterResult,
    renderedResponse: renderResponse(profile, adapterResult),
    exitCode: resolveProfileExitCode(profile, category, adapterResult.guardrail.exitCode),
  };
}

// --- Internal helpers -------------------------------------------------------

function loadAdapterProfile(tool, profilePath) {
  if (profilePath) return loadProfile(profilePath);
  if (tool) return resolveProfile(tool);
  return {}; // empty -> validation catches it
}

function extractFromIntercept(rawInput, intercept) {
  if (rawInput == null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return { command: null, args: [], cwd: null, error: 'stdin-json intercept requires a JSON object input.' };
  }
  if (!intercept || typeof intercept !== 'object') {
    return { command: null, args: [], cwd: null, error: 'Adapter profile intercept must be an object.' };
  }

  const commandValue = extractValue(rawInput, intercept.command);
  if (typeof commandValue !== 'string' || commandValue.trim() === '') {
    return { command: null, args: [], cwd: null, error: 'Adapter intercept.command did not resolve to a non-empty string.' };
  }

  let args = [];
  if (typeof intercept.args === 'string') {
    const argsValue = extractValue(rawInput, intercept.args);
    if (argsValue == null) {
      args = [];
    } else if (Array.isArray(argsValue)) {
      if (!argsValue.every((entry) => typeof entry === 'string')) {
        return { command: null, args: [], cwd: null, error: 'Adapter intercept.args must resolve to an array of strings.' };
      }
      args = argsValue;
    } else if (typeof argsValue === 'string') {
      args = [argsValue];
    } else {
      return { command: null, args: [], cwd: null, error: 'Adapter intercept.args must resolve to a string or array of strings.' };
    }
  }

  let cwd = null;
  if (typeof intercept.cwd === 'string') {
    const cwdValue = extractValue(rawInput, intercept.cwd);
    if (cwdValue != null) {
      if (typeof cwdValue !== 'string' || cwdValue.trim() === '') {
        return { command: null, args: [], cwd: null, error: 'Adapter intercept.cwd must resolve to a non-empty string when present.' };
      }
      cwd = cwdValue;
    }
  }

  return { command: commandValue, args, cwd, error: null };
}

function buildDriftSummary(drift) {
  if (!drift?.detected || !Array.isArray(drift.diffs)) return [];
  return drift.diffs.map(d => {
    if (typeof d === 'string') return d;
    if (d?.description) return d.description;
    return String(d);
  });
}

function resolveProfileExitCode(profile, category, fallbackExitCode) {
  const mapped = profile?.exit_codes?.[category];
  return Number.isInteger(mapped) ? mapped : fallbackExitCode;
}

/** Wrap a reason into a failed adapter pipeline return value. */
function wrapFailed(reason) {
  const failResult = buildFailedResult(reason);
  return { adapterResult: failResult, renderedResponse: null, exitCode: failResult.guardrail.exitCode };
}

function wrapBlocked(reason) {
  const blockedResult = buildBlockedResult(reason);
  return { adapterResult: blockedResult, renderedResponse: null, exitCode: blockedResult.guardrail.exitCode };
}

function buildFailedResult(reason) {
  return {
    schemaVersion: 'adapter-result/v1',
    guardrail: {
      nativeStatus: 'internal_error', category: 'failed', reason, exitCode: 19,
      contractHash: '', manifestPath: '', riskLevel: '', riskReasons: [],
      driftDetected: false, driftSummary: [],
    },
    process: {
      launched: false, exitCode: null, timedOut: false,
      interactivePromptDetected: false,
      stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
    },
    telemetry: { runId: '', durationMs: 0 },
  };
}

function buildBlockedResult(reason) {
  return {
    schemaVersion: 'adapter-result/v1',
    guardrail: {
      nativeStatus: 'policy_violation', category: 'blocked', reason, exitCode: 16,
      contractHash: '', manifestPath: '', riskLevel: '', riskReasons: [],
      driftDetected: false, driftSummary: [],
    },
    process: {
      launched: false, exitCode: null, timedOut: false,
      interactivePromptDetected: false,
      stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
    },
    telemetry: { runId: '', durationMs: 0 },
  };
}
