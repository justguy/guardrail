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
import { validateProfile, loadProfile, resolveProfile } from './adapter-profile.js';
import { runSupervisor } from './supervisor.js';
import { checkEnvMappings, checkAuthPrerequisites } from './adapter-auth.js';
import {
  ADAPTER_REASON_CODES,
  STATUS_TO_CODE,
  DEFAULT_REASONS,
  buildBlockedResult,
  buildFailedResult,
  validateAdapterResult,
  extractFromIntercept,
} from './adapter-result.js';

export { ADAPTER_REASON_CODES, validateAdapterResult };

// --- Category + code mapping ------------------------------------------------

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

function deriveCode(nativeStatus) {
  return STATUS_TO_CODE[nativeStatus] ?? ADAPTER_REASON_CODES.INTERNAL_ERROR;
}

// --- Bounded output safety net ---------------------------------------------
// Primary clipping happens upstream in supervisor.js (1 MB). This 64 KiB cap
// is a secondary guardrail so a non-supervisor caller cannot leak larger
// strings by constructing a result directly. Never remove the upstream clip.

const ADAPTER_OUTPUT_CAP_BYTES = 64 * 1024;

function capOutputField(value, wasTruncated) {
  if (typeof value !== 'string') return { text: '', truncated: !!wasTruncated };
  if (Buffer.byteLength(value, 'utf8') <= ADAPTER_OUTPUT_CAP_BYTES) {
    return { text: value, truncated: !!wasTruncated };
  }
  const buf = Buffer.from(value, 'utf8');
  return {
    text: buf.subarray(0, ADAPTER_OUTPUT_CAP_BYTES).toString('utf8'),
    truncated: true,
  };
}

// --- Normalize to adapter-result/v1 ----------------------------------------

/** Convert a runSupervisor() result to adapter-result/v1. Pure, no mutation. */
export function normalizeToAdapterResult(supervisorResult) {
  if (supervisorResult == null || typeof supervisorResult !== 'object') {
    return buildFailedResult(
      ADAPTER_REASON_CODES.SUPERVISOR_THREW,
      'Supervisor returned null or non-object result.',
    );
  }
  const sr = supervisorResult;
  const nativeStatus = sr.status || 'internal_error';
  const worker = sr.worker || {};
  const driftDetected = sr.drift?.detected ?? false;
  const stdoutCap = capOutputField(worker.stdout ?? '', worker.stdoutTruncated);
  const stderrCap = capOutputField(worker.stderr ?? '', worker.stderrTruncated);

  return {
    schemaVersion: 'adapter-result/v1',
    guardrail: {
      nativeStatus,
      category: deriveCategory(nativeStatus),
      code: driftDetected ? ADAPTER_REASON_CODES.DRIFT_DETECTED : deriveCode(nativeStatus),
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
      stdout: stdoutCap.text,
      stderr: stderrCap.text,
      stdoutTruncated: stdoutCap.truncated,
      stderrTruncated: stderrCap.truncated,
    },
    telemetry: {
      runId: sr.runId || '',
      durationMs: sr.telemetry?.durationMs ?? 0,
    },
  };
}

// --- Response rendering -----------------------------------------------------

/** Render the profile's response template for the result's category. */
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

function resolveJsonTemplate(node, source) {
  if (node == null) return node;
  if (typeof node === 'string') return node.startsWith('$.') ? extractValue(source, node) : node;
  if (Array.isArray(node)) return node.map(item => resolveJsonTemplate(item, source));
  if (typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) out[key] = resolveJsonTemplate(node[key], source);
    return out;
  }
  return node;
}

// --- Full adapter orchestration ---------------------------------------------

/**
 * Run the full adapter pipeline. Returns { adapterResult, renderedResponse,
 * exitCode } on every terminal path — never throws, never process.exits.
 * Accepts optional supervisorFn/authCheckFn in opts for testing.
 */
export async function runAdapter(opts = {}) {
  const {
    tool, profilePath,
    command: directCommand, args: directArgs, cwd: directCwd,
    rawInput, supervisorFn = runSupervisor, envAllow = [], authCheckFn,
  } = opts;

  // 1. Load and validate profile (fail closed)
  let profile;
  try {
    profile = loadAdapterProfile(tool, profilePath);
  } catch (err) {
    return wrapFailed(ADAPTER_REASON_CODES.PROFILE_NOT_FOUND, err?.message || 'Failed to load adapter profile.');
  }
  const validation = validateProfile(profile);
  if (!validation.valid) {
    return wrapFailed(
      ADAPTER_REASON_CODES.PROFILE_INVALID,
      `Adapter profile validation failed: ${validation.errors.join('; ')}`,
    );
  }

  // 2. MCP gate: structured block that uses the profile's blocked exit_codes
  // mapping. See docs/adapter-implementation-plan.md#mcp-roadmap.
  if (profile.protocol === 'mcp') {
    const reason = 'MCP protocol is not yet supported in v0.2. '
      + 'For Cline integration now, use the env-shim path or install a shim-oriented profile. '
      + 'See docs/adapter-implementation-plan.md#mcp-roadmap';
    return wrapBlocked(ADAPTER_REASON_CODES.MCP_BLOCKED, reason, profile);
  }

  // 3. Auth/env preflight. Preflight blocks keep the synthetic adapter exit
  // code (16) rather than mapping through profile.exit_codes so scripted
  // auth-failure callers get a stable preflight signal across profiles.
  const envCheck = checkEnvMappings(profile.requires_env || [], envAllow, {
    authRequirements: profile.requires_auth || [],
    currentEnv: process.env,
  });
  if (!envCheck.ok) {
    return wrapBlocked(
      ADAPTER_REASON_CODES.MISSING_AUTH_MAPPING,
      `${envCheck.code}: ${envCheck.message}`,
    );
  }

  const authCheck = await checkAuthPrerequisites(profile.requires_auth || [], {
    cwd: directCwd || process.cwd(),
    checkRunner: authCheckFn,
  });
  if (!authCheck.ok) {
    const detail = authCheck.detail ? ` Detail: ${authCheck.detail}` : '';
    return wrapBlocked(
      ADAPTER_REASON_CODES.MISSING_AUTH_PREREQUISITE,
      `${authCheck.code}: ${authCheck.message}${detail}`,
    );
  }

  // 4. Resolve command/args/cwd: direct CLI wins, then rawInput via intercept
  let command = directCommand || null;
  let args = Array.isArray(directArgs) ? directArgs : [];
  let cwd = directCwd || null;

  if (!command && rawInput && profile.intercept) {
    const extracted = extractFromIntercept(rawInput, profile.intercept);
    if (extracted.error) {
      return wrapFailed(ADAPTER_REASON_CODES.INTERCEPT_INVALID, extracted.error);
    }
    command = extracted.command;
    args = extracted.args;
    cwd = extracted.cwd || cwd;
  }
  if (!command) {
    return wrapFailed(
      ADAPTER_REASON_CODES.COMMAND_UNRESOLVED,
      'No command resolved from direct input or profile intercept.',
    );
  }

  // 5. Build supervisor options
  const supervisorOptions = {
    command, args, nonInteractive: true, jsonOutput: true,
    ...(profile.defaults || {}),
    envPolicy: { inherit: false, allow: ['PATH', ...envAllow], inject: {} },
  };
  if (cwd) supervisorOptions.cwd = cwd;

  // 6. Execute supervisor
  let supervisorResult;
  try {
    supervisorResult = await supervisorFn(supervisorOptions);
  } catch (err) {
    return wrapFailed(
      ADAPTER_REASON_CODES.SUPERVISOR_THREW,
      `Supervisor execution error: ${err?.message || 'unknown'}`,
    );
  }

  // 7. Normalize, paranoia-gate, render, return
  const adapterResult = normalizeToAdapterResult(supervisorResult);
  const check = validateAdapterResult(adapterResult);
  if (!check.valid) {
    return wrapFailed(
      ADAPTER_REASON_CODES.INTERNAL_ERROR,
      `adapter-result/v1 shape invariant broken: ${check.errors.join('; ')}`,
    );
  }
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

function wrapFailed(code, reason) {
  const r = buildFailedResult(code, reason);
  return { adapterResult: r, renderedResponse: null, exitCode: r.guardrail.exitCode };
}

function wrapBlocked(code, reason, profile = null) {
  const r = buildBlockedResult(code, reason);
  const exitCode = resolveProfileExitCode(profile, 'blocked', r.guardrail.exitCode);
  return { adapterResult: r, renderedResponse: null, exitCode };
}
