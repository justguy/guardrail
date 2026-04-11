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

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
const MAX_MCP_PROBE_TOOLS = 64;
const MAX_MCP_PROBE_TEXT_CHARS = 240;

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

function truncateProbeText(value, maxChars = MAX_MCP_PROBE_TEXT_CHARS) {
  if (typeof value !== 'string') return '';
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function resolveMcpProbeHelperPath() {
  return resolve(__dirname, 'adapter-mcp-stdio-probe.js');
}

function resolveMcpCallHelperPath() {
  return resolve(__dirname, 'adapter-mcp-stdio-call.js');
}

function buildMcpProbeSupervisorOptions(profile, envAllow = []) {
  const transport = profile.mcp_transport || {};
  const helperArgs = [
    resolveMcpProbeHelperPath(),
    '--tool', profile.tool,
    '--transport-command', transport.command,
    '--correlation', transport.correlation,
    '--capability-discovery', transport.capability_discovery,
  ];

  for (const arg of (transport.args || [])) {
    helperArgs.push('--transport-arg', arg);
  }
  if (transport.cwd) {
    helperArgs.push('--transport-cwd', transport.cwd);
  }

  return {
    command: process.execPath,
    args: helperArgs,
    nonInteractive: true,
    jsonOutput: true,
    cwd: process.cwd(),
    envPolicy: { inherit: false, allow: ['PATH', ...envAllow], inject: {} },
  };
}

function normalizeProbePayload(payload, profile) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('MCP stdio probe returned a non-object payload.');
  }
  if (payload.transport !== 'stdio') {
    throw new Error('MCP stdio probe returned an unexpected transport.');
  }
  if (!Array.isArray(payload.tools)) {
    throw new Error('MCP stdio probe payload is missing a tools array.');
  }

  const tools = payload.tools
    .filter((tool) => tool && typeof tool === 'object' && typeof tool.name === 'string' && tool.name.trim() !== '')
    .slice(0, MAX_MCP_PROBE_TOOLS)
    .map((tool) => ({
      name: truncateProbeText(tool.name, 120),
      description: truncateProbeText(tool.description || '', MAX_MCP_PROBE_TEXT_CHARS),
      hasInputSchema: !!tool.hasInputSchema,
    }));

  return {
    tool: profile.tool,
    protocol: 'mcp',
    transport: 'stdio',
    correlation: profile.mcp_transport?.correlation || null,
    capabilityDiscovery: profile.mcp_transport?.capability_discovery || null,
    server: {
      name: truncateProbeText(payload.server?.name || '', 120),
      version: truncateProbeText(payload.server?.version || '', 80),
      protocolVersion: truncateProbeText(payload.server?.protocolVersion || '', 40),
      hasToolsCapability: !!payload.server?.hasToolsCapability,
    },
    toolCount: Number.isInteger(payload.toolCount) ? payload.toolCount : payload.tools.length,
    toolsTruncated: !!payload.toolsTruncated,
    tools,
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
  const profileResult = loadAndValidateAdapterProfile(tool, profilePath);
  if (profileResult.error) return profileResult.error;
  const profile = profileResult.profile;

  // 2. MCP gate: structured block that uses the profile's blocked exit_codes
  // mapping. See docs/adapter-implementation-plan.md#mcp-roadmap.
  if (profile.protocol === 'mcp') {
    const transportSummary = profile.mcp_transport?.type
      ? ` Declared transport: ${profile.mcp_transport.type}.`
      : '';
    const reason = 'MCP protocol is not yet supported in v0.2.'
      + transportSummary + ' '
      + 'For Cline integration now, use the env-shim path or install a shim-oriented profile. '
      + 'See docs/adapter-implementation-plan.md#mcp-roadmap';
    return wrapBlocked(ADAPTER_REASON_CODES.MCP_BLOCKED, reason, profile);
  }

  // 3. Auth/env preflight. Preflight blocks keep the synthetic adapter exit
  // code (16) rather than mapping through profile.exit_codes so scripted
  // auth-failure callers get a stable preflight signal across profiles.
  const preflightResult = await runAdapterPreflight(profile, {
    envAllow,
    cwd: directCwd || process.cwd(),
    authCheckFn,
  });
  if (preflightResult.error) return preflightResult.error;

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

export async function probeAdapterMcpStdio(opts = {}) {
  const {
    tool, profilePath,
    cwd: directCwd,
    supervisorFn = runSupervisor,
    envAllow = [],
    authCheckFn,
    timeoutMs = 5000,
  } = opts;

  const profileResult = loadAndValidateAdapterProfile(tool, profilePath);
  if (profileResult.error) return { ok: false, adapterResult: profileResult.error.adapterResult, exitCode: profileResult.error.exitCode };
  const profile = profileResult.profile;

  if (profile.protocol !== 'mcp') {
    const error = wrapBlocked(
      ADAPTER_REASON_CODES.UNSUPPORTED,
      'Adapter probe only supports profiles that declare protocol "mcp".',
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }
  if (profile.mcp_transport?.type !== 'stdio') {
    const error = wrapBlocked(
      ADAPTER_REASON_CODES.UNSUPPORTED,
      'Adapter probe currently supports only stdio MCP transports.',
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }

  const preflightResult = await runAdapterPreflight(profile, {
    envAllow,
    cwd: directCwd || process.cwd(),
    authCheckFn,
  });
  if (preflightResult.error) {
    return { ok: false, adapterResult: preflightResult.error.adapterResult, exitCode: preflightResult.error.exitCode };
  }

  const helperPath = resolve(__dirname, 'adapter-mcp-stdio-probe.js');
  const transport = profile.mcp_transport;
  const supervisorOptions = {
    command: process.execPath,
    args: [
      helperPath,
      '--command', transport.command,
      ...((transport.args || []).flatMap((value) => ['--arg', value])),
      ...(transport.cwd ? ['--cwd', transport.cwd] : []),
      '--timeout-ms', String(timeoutMs),
    ],
    nonInteractive: true,
    jsonOutput: true,
    envPolicy: { inherit: false, allow: ['PATH', ...envAllow], inject: {} },
  };
  if (directCwd) supervisorOptions.cwd = directCwd;

  let supervisorResult;
  try {
    supervisorResult = await supervisorFn(supervisorOptions);
  } catch (err) {
    const error = wrapFailed(
      ADAPTER_REASON_CODES.SUPERVISOR_THREW,
      `Supervisor execution error: ${err?.message || 'unknown'}`,
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }

  const adapterResult = normalizeToAdapterResult(supervisorResult);
  if (adapterResult.guardrail.category !== 'success') {
    return {
      ok: false,
      adapterResult,
      exitCode: adapterResult.guardrail.exitCode,
    };
  }

  let parsedProbe;
  try {
    parsedProbe = JSON.parse(supervisorResult?.worker?.stdout || '{}');
  } catch (err) {
    const error = wrapFailed(
      ADAPTER_REASON_CODES.PROTOCOL_ERROR,
      `MCP stdio probe returned invalid JSON: ${err.message}`,
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }

  if (parsedProbe?.ok !== true) {
    const error = wrapFailed(
      ADAPTER_REASON_CODES.PROTOCOL_ERROR,
      parsedProbe?.reason || 'MCP stdio probe did not complete successfully.',
    );
    return {
      ok: false,
      adapterResult: error.adapterResult,
      exitCode: error.exitCode,
      probe: parsedProbe,
    };
  }

  return {
    ok: true,
    probe: {
      tool: profile.tool,
      transport: parsedProbe.transport,
      server: parsedProbe.server,
    },
    exitCode: 0,
  };
}

export async function callAdapterMcpTool(opts = {}) {
  const {
    tool, profilePath,
    cwd: directCwd,
    supervisorFn = runSupervisor,
    envAllow = [],
    authCheckFn,
    timeoutMs = 5000,
    mcpTool,
    params = {},
  } = opts;

  const profileResult = loadAndValidateAdapterProfile(tool, profilePath);
  if (profileResult.error) return { ok: false, adapterResult: profileResult.error.adapterResult, exitCode: profileResult.error.exitCode };
  const profile = profileResult.profile;

  if (profile.protocol !== 'mcp') {
    const error = wrapBlocked(
      ADAPTER_REASON_CODES.UNSUPPORTED,
      'Adapter MCP call only supports profiles that declare protocol "mcp".',
      profile,
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }
  if (profile.mcp_transport?.type !== 'stdio') {
    const error = wrapBlocked(
      ADAPTER_REASON_CODES.UNSUPPORTED,
      'Adapter MCP call currently supports only stdio MCP transports.',
      profile,
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }
  if (typeof mcpTool !== 'string' || mcpTool.trim() === '') {
    const error = wrapFailed(
      ADAPTER_REASON_CODES.VALIDATION_FAILED,
      'Adapter MCP call requires --mcp-tool <name>.',
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }
  if (params == null || typeof params !== 'object' || Array.isArray(params)) {
    const error = wrapFailed(
      ADAPTER_REASON_CODES.VALIDATION_FAILED,
      'Adapter MCP call requires params to be a JSON object.',
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }

  const discoveryMode = profile.mcp_transport?.capability_discovery || 'required';
  if (discoveryMode === 'required') {
    const discovery = await probeAdapterMcpStdio({
      tool,
      profilePath,
      cwd: directCwd,
      supervisorFn,
      envAllow,
      authCheckFn,
      timeoutMs,
    });
    if (!discovery.ok) {
      return {
        ok: false,
        adapterResult: discovery.adapterResult,
        exitCode: discovery.exitCode,
      };
    }
    const knownTools = Array.isArray(discovery.probe?.server?.toolNames)
      ? discovery.probe.server.toolNames
      : [];
    if (!knownTools.includes(mcpTool)) {
      const error = wrapFailed(
        ADAPTER_REASON_CODES.VALIDATION_FAILED,
        `Adapter MCP call requested unknown tool "${mcpTool}". Declared transport exposed: ${knownTools.join(', ') || '<none>'}.`,
      );
      return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
    }
  }

  const preflightResult = await runAdapterPreflight(profile, {
    envAllow,
    cwd: directCwd || process.cwd(),
    authCheckFn,
  });
  if (preflightResult.error) {
    return { ok: false, adapterResult: preflightResult.error.adapterResult, exitCode: preflightResult.error.exitCode };
  }

  const transport = profile.mcp_transport;
  const supervisorOptions = {
    command: process.execPath,
    args: [
      resolveMcpCallHelperPath(),
      '--command', transport.command,
      ...((transport.args || []).flatMap((value) => ['--arg', value])),
      ...(transport.cwd ? ['--cwd', transport.cwd] : []),
      '--timeout-ms', String(timeoutMs),
      '--mcp-tool', mcpTool,
      '--params-json', JSON.stringify(params),
    ],
    nonInteractive: true,
    jsonOutput: true,
    envPolicy: { inherit: false, allow: ['PATH', ...envAllow], inject: {} },
  };
  if (directCwd) supervisorOptions.cwd = directCwd;

  let supervisorResult;
  try {
    supervisorResult = await supervisorFn(supervisorOptions);
  } catch (err) {
    const error = wrapFailed(
      ADAPTER_REASON_CODES.SUPERVISOR_THREW,
      `Supervisor execution error: ${err?.message || 'unknown'}`,
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }

  const adapterResult = normalizeToAdapterResult(supervisorResult);
  if (adapterResult.guardrail.category !== 'success') {
    return {
      ok: false,
      adapterResult,
      exitCode: resolveProfileExitCode(profile, adapterResult.guardrail.category, adapterResult.guardrail.exitCode),
    };
  }

  let parsedCall;
  try {
    parsedCall = JSON.parse(supervisorResult?.worker?.stdout || '{}');
  } catch (err) {
    const error = wrapFailed(
      ADAPTER_REASON_CODES.PROTOCOL_ERROR,
      `MCP stdio call returned invalid JSON: ${err.message}`,
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }

  if (parsedCall?.ok !== true) {
    const error = wrapFailed(
      ADAPTER_REASON_CODES.PROTOCOL_ERROR,
      parsedCall?.reason || 'MCP stdio tool call did not complete successfully.',
    );
    return {
      ok: false,
      adapterResult: error.adapterResult,
      exitCode: error.exitCode,
      call: parsedCall,
    };
  }

  return {
    ok: true,
    adapterResult,
    call: parsedCall.call,
    exitCode: resolveProfileExitCode(profile, 'success', adapterResult.guardrail.exitCode),
  };
}

export async function callAdapterMcpToolBatch(opts = {}) {
  const {
    tool, profilePath,
    cwd: directCwd,
    supervisorFn = runSupervisor,
    envAllow = [],
    authCheckFn,
    timeoutMs = 5000,
    calls = [],
  } = opts;

  const profileResult = loadAndValidateAdapterProfile(tool, profilePath);
  if (profileResult.error) return { ok: false, adapterResult: profileResult.error.adapterResult, exitCode: profileResult.error.exitCode };
  const profile = profileResult.profile;

  if (profile.protocol !== 'mcp') {
    const error = wrapBlocked(
      ADAPTER_REASON_CODES.UNSUPPORTED,
      'Adapter MCP batch only supports profiles that declare protocol "mcp".',
      profile,
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }
  if (profile.mcp_transport?.type !== 'stdio') {
    const error = wrapBlocked(
      ADAPTER_REASON_CODES.UNSUPPORTED,
      'Adapter MCP batch currently supports only stdio MCP transports.',
      profile,
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }
  if (!Array.isArray(calls) || calls.length === 0) {
    const error = wrapFailed(
      ADAPTER_REASON_CODES.VALIDATION_FAILED,
      'Adapter MCP batch requires a non-empty calls array.',
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }
  for (const call of calls) {
    if (!call || typeof call !== 'object' || Array.isArray(call)) {
      const error = wrapFailed(
        ADAPTER_REASON_CODES.VALIDATION_FAILED,
        'Adapter MCP batch requires each call to be an object with { tool, params }.',
      );
      return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
    }
    if (typeof call.tool !== 'string' || call.tool.trim() === '') {
      const error = wrapFailed(
        ADAPTER_REASON_CODES.VALIDATION_FAILED,
        'Adapter MCP batch requires each call to include a non-empty tool name.',
      );
      return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
    }
    if (call.params == null || typeof call.params !== 'object' || Array.isArray(call.params)) {
      const error = wrapFailed(
        ADAPTER_REASON_CODES.VALIDATION_FAILED,
        'Adapter MCP batch requires each call params value to be a JSON object.',
      );
      return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
    }
  }

  const preflightResult = await runAdapterPreflight(profile, {
    envAllow,
    cwd: directCwd || process.cwd(),
    authCheckFn,
  });
  if (preflightResult.error) {
    return { ok: false, adapterResult: preflightResult.error.adapterResult, exitCode: preflightResult.error.exitCode };
  }

  const transport = profile.mcp_transport;
  const supervisorOptions = {
    command: process.execPath,
    args: [
      resolveMcpCallHelperPath(),
      '--command', transport.command,
      ...((transport.args || []).flatMap((value) => ['--arg', value])),
      ...(transport.cwd ? ['--cwd', transport.cwd] : []),
      '--timeout-ms', String(timeoutMs),
      '--calls-json', JSON.stringify(calls),
    ],
    nonInteractive: true,
    jsonOutput: true,
    envPolicy: { inherit: false, allow: ['PATH', ...envAllow], inject: {} },
  };
  if (directCwd) supervisorOptions.cwd = directCwd;

  let supervisorResult;
  try {
    supervisorResult = await supervisorFn(supervisorOptions);
  } catch (err) {
    const error = wrapFailed(
      ADAPTER_REASON_CODES.SUPERVISOR_THREW,
      `Supervisor execution error: ${err?.message || 'unknown'}`,
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }

  const adapterResult = normalizeToAdapterResult(supervisorResult);
  if (adapterResult.guardrail.category !== 'success') {
    return {
      ok: false,
      adapterResult,
      exitCode: resolveProfileExitCode(profile, adapterResult.guardrail.category, adapterResult.guardrail.exitCode),
    };
  }

  let parsedBatch;
  try {
    parsedBatch = JSON.parse(supervisorResult?.worker?.stdout || '{}');
  } catch (err) {
    const error = wrapFailed(
      ADAPTER_REASON_CODES.PROTOCOL_ERROR,
      `MCP stdio batch returned invalid JSON: ${err.message}`,
    );
    return { ok: false, adapterResult: error.adapterResult, exitCode: error.exitCode };
  }

  if (parsedBatch?.ok !== true) {
    const error = wrapFailed(
      ADAPTER_REASON_CODES.PROTOCOL_ERROR,
      parsedBatch?.reason || 'MCP stdio batch did not complete successfully.',
    );
    return {
      ok: false,
      adapterResult: error.adapterResult,
      exitCode: error.exitCode,
      batch: parsedBatch,
    };
  }

  return {
    ok: true,
    batch: parsedBatch.batch,
    exitCode: 0,
  };
}

// --- Internal helpers -------------------------------------------------------

function loadAdapterProfile(tool, profilePath) {
  if (profilePath) return loadProfile(profilePath);
  if (tool) return resolveProfile(tool);
  return {}; // empty -> validation catches it
}

function loadAndValidateAdapterProfile(tool, profilePath) {
  let profile;
  try {
    profile = loadAdapterProfile(tool, profilePath);
  } catch (err) {
    return { error: wrapFailed(ADAPTER_REASON_CODES.PROFILE_NOT_FOUND, err?.message || 'Failed to load adapter profile.') };
  }
  const validation = validateProfile(profile);
  if (!validation.valid) {
    return {
      error: wrapFailed(
        ADAPTER_REASON_CODES.PROFILE_INVALID,
        `Adapter profile validation failed: ${validation.errors.join('; ')}`,
      ),
    };
  }
  return { profile };
}

async function runAdapterPreflight(profile, options) {
  const envCheck = checkEnvMappings(profile.requires_env || [], options.envAllow || [], {
    authRequirements: profile.requires_auth || [],
    currentEnv: process.env,
  });
  if (!envCheck.ok) {
    return {
      error: wrapBlocked(
        ADAPTER_REASON_CODES.MISSING_AUTH_MAPPING,
        `${envCheck.code}: ${envCheck.message}`,
      ),
    };
  }

  const authCheck = await checkAuthPrerequisites(profile.requires_auth || [], {
    cwd: options.cwd || process.cwd(),
    checkRunner: options.authCheckFn,
  });
  if (!authCheck.ok) {
    const detail = authCheck.detail ? ` Detail: ${authCheck.detail}` : '';
    return {
      error: wrapBlocked(
        ADAPTER_REASON_CODES.MISSING_AUTH_PREREQUISITE,
        `${authCheck.code}: ${authCheck.message}${detail}`,
      ),
    };
  }

  return { error: null };
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
