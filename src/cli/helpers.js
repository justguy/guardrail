import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export function getVersion() {
  try {
    const pkgPath = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function defaultLaneDir(laneId) {
  return `.guardrail/lanes/${laneId}`;
}

function defaultLaneKeyPath(laneId, guardrailRepo = '.') {
  let repoPath = resolve(process.cwd(), guardrailRepo);
  try {
    repoPath = realpathSync(repoPath);
  } catch {}
  const repoId = createHash('sha256')
    .update(repoPath)
    .digest('hex')
    .slice(0, 16);
  return resolve(repoPath, '.guardrail', 'host-lanes', repoId, `${laneId}.key`);
}

function defaultLaneHostStateDir(guardrailRepo = '.') {
  let repoPath = resolve(process.cwd(), guardrailRepo);
  try {
    repoPath = realpathSync(repoPath);
  } catch {}
  return resolve(repoPath, '.guardrail', 'host-lanes');
}

export function normalizeLaneCliOptions(raw = {}) {
  const laneId = raw.id || raw.laneId || '';
  const laneDir = raw.laneDir || (laneId ? defaultLaneDir(laneId) : '');
  const guardrailRepo = raw.guardrailRepo || '.';
  const keyPath = raw.keyPath || (laneId ? defaultLaneKeyPath(laneId, guardrailRepo) : '');
  const hostStateDir = raw.hostStateDir || defaultLaneHostStateDir(guardrailRepo);
  const promptFiles = Array.isArray(raw.promptFiles)
    ? raw.promptFiles
    : (typeof raw.promptFiles === 'string' && raw.promptFiles.trim() ? [raw.promptFiles] : []);
  return {
    ...raw,
    laneId,
    laneDir,
    keyPath,
    tool: raw.tool || 'claude',
    sessionName: raw.sessionName || laneId || '',
    guardrailRepo,
    workingDir: raw.workingDir || '.',
    scopeType: raw.scopeType || 'none',
    scopeMode: raw.scopeMode || 'warn',
    scopePaths: raw.scopePaths || [],
    resourceMode: raw.resourceMode || raw.scopeMode || 'warn',
    resources: raw.resources || [],
    promptFiles,
    hostStateDir,
  };
}

export function derivePromptFileReportArtifact(promptText = '') {
  if (typeof promptText !== 'string' || !promptText.trim()) return '';
  const match = promptText.match(/Declared report artifact:\s*\n-\s*`([^`]+)`/m);
  return match ? match[1].trim() : '';
}

export function formatLaneScope(status = {}) {
  const scopeType = status.scopeType || 'none';
  if (scopeType === 'none') return 'none';
  const paths = Array.isArray(status.scopePaths) ? status.scopePaths : [];
  const details = paths.length > 0 ? ` ${paths.join(', ')}` : '';
  return `${scopeType}/${status.scopeMode || 'warn'}${details}`;
}

export function formatLaneResources(status = {}) {
  const details = Array.isArray(status.resourceDetails) ? status.resourceDetails : [];
  if (details.length > 0) {
    return `${status.resourceMode || 'warn'} ${details.map((detail) => `${detail.raw}${detail.source === 'discovered' ? ' [auto]' : ''}`).join(', ')}`;
  }
  const resources = Array.isArray(status.resources) ? status.resources : [];
  if (resources.length === 0) return 'none';
  return `${status.resourceMode || 'warn'} ${resources.join(', ')}`;
}

export function formatLaneTransportSummary(status = {}) {
  const summary = status.transportSummary;
  if (!summary || typeof summary !== 'object') return 'n/a';
  const entries = Object.entries(summary)
    .filter(([, value]) => value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`);
  return entries.length > 0 ? entries.join(' ') : 'n/a';
}

function buildLaneRefArg(status = {}) {
  if (status.laneId) return `--id ${status.laneId}`;
  if (status.laneDir) return `--lane-dir ${status.laneDir}`;
  return '';
}

export function buildLaneRecommendedCommand(status = {}) {
  const ref = buildLaneRefArg(status);
  const toolSuffix = status.tool && status.tool !== 'claude' ? ` --tool ${status.tool}` : '';
  switch (status.recommendedAction) {
    case 'start':
      return ref ? `guardrail lane start ${ref}${toolSuffix}` : 'guardrail lane start --id <lane-id>';
    case 'send':
      return ref ? `guardrail lane send ${ref} --prompt "<message>"` : 'guardrail lane send --id <lane-id> --prompt "<message>"';
    case 'result':
      if (status.currentRequestId) return `guardrail lane wait ${ref} --request-id ${status.currentRequestId}`;
      if (status.lastRequestId) return `guardrail lane result ${ref} --request-id ${status.lastRequestId}`;
      return `guardrail lane result ${ref}`;
    case 'cleanup':
      return `guardrail lane cleanup ${ref}`;
    default:
      return null;
  }
}

export function readAiProgressSnapshot(stateDir) {
  const resolvedStateDir = resolve(stateDir);
  const stateFile = resolve(resolvedStateDir, 'ai-progress-state.json');
  const progressFile = resolve(resolvedStateDir, 'ai-progress.ndjson');

  let state = null;
  if (existsSync(stateFile)) {
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      state = null;
    }
  }

  let events = [];
  if (existsSync(progressFile)) {
    events = readFileSync(progressFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  return {
    stateDir: resolvedStateDir,
    state,
    events,
  };
}

export function resolveRecipeProgressStateDir(rawStateDir, runId) {
  if (rawStateDir) return resolve(rawStateDir);
  if (!runId) return '';

  const candidate = resolve(process.cwd(), '.guardrail');
  const snapshot = readAiProgressSnapshot(candidate);
  if (snapshot.state?.runId === runId) return candidate;
  return '';
}

function isTerminalAiProgressState(status) {
  return status === 'completed' || status === 'failed';
}

export function printRecipeProgressText(snapshot, startIndex = 0, options = {}) {
  const { state, events } = snapshot;
  const { includeHeader = true } = options;

  if (includeHeader && state) {
    console.log(`Status:  ${state.status ?? 'unknown'}`);
    console.log(`Run ID:  ${state.runId ?? 'unknown'}`);
    if (state.lastPhase) console.log(`Phase:   ${state.lastPhase}`);
    if (state.sessionName) console.log(`Session: ${state.sessionName}`);
    if (state.lastMessage) console.log(`Last:    ${state.lastMessage}`);
    if (state.continuationCommand) {
      console.log('');
      console.log(`To continue: ${state.continuationCommand}`);
    }
  }

  const nextEvents = events.slice(startIndex);
  if ((includeHeader && events.length > 0) || nextEvents.length > 0) {
    if (includeHeader) {
      console.log('');
      console.log(`Checkpoints (${events.length}):`);
    }
    for (const evt of nextEvents) {
      const ts = evt.timestamp ? String(evt.timestamp).slice(0, 19) : '';
      const phase = evt.phase ? ` phase=${evt.phase}` : '';
      const msg = evt.message ? ` ${evt.message}` : '';
      console.log(`  [${ts}] ${evt.event ?? 'unknown'}${phase}${msg}`);
    }
  }
}

export function laneHasSelectionFilter(laneOpts = {}) {
  return Boolean(
    laneOpts.all === true
    || laneOpts.laneId
    || laneOpts.laneDir
    || laneOpts.filterLaneId
    || laneOpts.filterSessionName
    || laneOpts.status
    || laneOpts.toolFilter
    || laneOpts.scopeTypeFilter
    || laneOpts.scopeModeFilter
    || laneOpts.resourceFilter
    || laneOpts.repoFilter
    || laneOpts.alive !== undefined
    || laneOpts.hasConflicts !== undefined
  );
}

export function buildLaneHistoryBundle(history) {
  return {
    ...history,
    entries: history.entries.map((entry) => ({
      timestamp: entry.timestamp,
      event: entry.event,
      lane_id: entry.lane_id || null,
      lane_dir: entry.lane_dir || null,
      request_id: entry.request_id || null,
      session_name: entry.session_name || null,
      tool: entry.tool || null,
      status: entry.status || null,
      reason: entry.reason || null,
      exit_code: entry.exit_code ?? null,
    })),
  };
}

export function buildLaneInspectBundle(laneOpts, status, getResidentLaneResult, getResidentLaneLogs, getResidentLaneHistory) {
  const requestId = status.currentRequestId || status.lastCompletedRequestId || status.lastRequestId || null;
  return {
    status: {
      ...status,
      recommendedCommand: buildLaneRecommendedCommand(status),
    },
    latestResult: getResidentLaneResult({
      ...laneOpts,
      requestId: laneOpts.requestId || requestId || undefined,
    }),
    logs: getResidentLaneLogs({
      ...laneOpts,
      tail: laneOpts.tail || 40,
    }),
    history: buildLaneHistoryBundle(getResidentLaneHistory({
      ...laneOpts,
      limit: laneOpts.limit || 10,
      requestId: laneOpts.requestId || requestId || undefined,
    })),
  };
}

export function lanePortfolioAuditPath(laneOpts = {}) {
  return resolve(laneOpts.hostStateDir || resolve(homedir(), '.guardrail'), 'resident-lane-portfolio.jsonl');
}

export function buildLanePortfolioBundle(timeline) {
  return {
    ...timeline,
    entries: timeline.entries.map((entry) => ({
      timestamp: entry.timestamp,
      source: entry.source || null,
      event: entry.event,
      lane_id: entry.lane_id || null,
      lane_dir: entry.lane_dir || null,
      guardrail_repo: entry.guardrail_repo || null,
      request_id: entry.request_id || null,
      session_name: entry.session_name || null,
      tool: entry.tool || null,
      status: entry.status || null,
      reason: entry.reason || entry.prune_reason || null,
      failure_stage: entry.failure_stage || null,
      scope_conflict_count: entry.scope_conflict_count ?? null,
      resource_conflict_count: entry.resource_conflict_count ?? null,
      tombstone_path: entry.tombstone_path || null,
    })),
  };
}

export function ensureLaneKeyFile(keyPath) {
  mkdirSync(dirname(keyPath), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(keyPath, `${secret}\n`, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
}

export function isLikelyLaneAlive(laneDir) {
  try {
    const state = JSON.parse(readFileSync(resolve(laneDir, 'state.json'), 'utf8'));
    if (!Number.isInteger(state?.pid) || state.pid <= 0) return false;
    process.kill(state.pid, 0);
    return state.status !== 'expired' && state.status !== 'stopped';
  } catch (err) {
    if (err?.code === 'EPERM') return true;
    return false;
  }
}

export function isLaneExpiredError(err) {
  return err?.code === 'ENOENT'
    || err?.code === 'ENXIO'
    || err?.code === 'EPIPE';
}

export function buildLaneExpiredResponse() {
  return {
    status: 'error',
    reason: 'lane_expired',
    message: 'The resident lane has idled out. Run `guardrail lane start` to initialize a new session.',
    ok: false,
    exitCode: 1,
  };
}

export function buildLaneFailedResponse(status) {
  return {
    status: 'error',
    reason: 'lane_failed',
    message: 'The resident lane failed before it could process a request.',
    failureReason: status.failureReason || null,
    failureStage: status.failureStage || null,
    logPath: status.logPath || null,
    ok: false,
    exitCode: 1,
  };
}

export function buildLaneStartFailureResponse(err) {
  const details = err?.details || {};
  return {
    status: 'error',
    reason: err?.code === 'LANE_BOOT_FAILED' ? 'lane_boot_failed' : 'lane_start_failed',
    message: err?.message || 'Resident lane failed to start.',
    failureReason: details.failureReason || err?.message || null,
    failureStage: details.failureStage || null,
    statePath: details.statePath || null,
    logPath: details.logPath || null,
    pid: details.pid ?? null,
    scopeConflicts: Array.isArray(details.scopeConflicts) ? details.scopeConflicts : [],
    resourceConflicts: Array.isArray(details.resourceConflicts) ? details.resourceConflicts : [],
  };
}

export async function appendLaneAuditEntry(laneOpts, event, details = {}) {
  try {
    const { createAuditLog } = await import('../audit.js');
    const guardrailRepo = resolve(laneOpts.guardrailRepo || '.');
    const entry = {
      event,
      trace_id: `lane:${laneOpts.laneId || laneOpts.sessionName || 'resident'}`,
      guardrail_repo: guardrailRepo,
      lane_id: laneOpts.laneId || null,
      lane_dir: laneOpts.laneDir || null,
      tool: laneOpts.tool || 'claude',
      session_name: laneOpts.sessionName || null,
      session_id: laneOpts.sessionId || null,
      ...details,
    };
    const auditLog = createAuditLog(resolve(guardrailRepo, '.guardrail', 'audit.jsonl'));
    auditLog.append(entry);
    createAuditLog(lanePortfolioAuditPath(laneOpts)).append(entry);
  } catch {
    // Best effort: lane execution must not fail solely because audit append failed.
  }
}

export async function appendRepoAuditEntry(guardrailRepo, event, details = {}) {
  try {
    const { createAuditLog } = await import('../audit.js');
    createAuditLog(resolve(guardrailRepo, '.guardrail', 'audit.jsonl')).append({ event, ...details });
  } catch {
    // Best effort only.
  }
}

export async function authorizeEmergencyLaneAction(laneOpts, action) {
  const { getActiveProfile } = await import('../profile.js');
  const { createUser, enforcePermission } = await import('../rbac.js');

  const profile = getActiveProfile();
  const actor = laneOpts.actor || profile?.name || process.env.USER || 'operator';
  const role = profile?.operator_role || null;

  if (!profile || !role) {
    const reason = 'Active Guardrail profile with operator_role is required for emergency controls';
    await appendLaneAuditEntry(laneOpts, 'emergency_denied', {
      status: 'denied',
      action,
      actor,
      reason,
    });
    return { allowed: false, actor, role, reason };
  }

  const user = createUser(actor, role);
  const decision = enforcePermission(user, 'emergency_control');
  await appendLaneAuditEntry(laneOpts, 'rbac_check', {
    status: decision.allowed ? 'allowed' : 'blocked',
    action,
    actor,
    role,
    permission: 'emergency_control',
    reason: decision.reason || null,
  });
  if (!decision.allowed) {
    await appendLaneAuditEntry(laneOpts, 'emergency_denied', {
      status: 'denied',
      action,
      actor,
      role,
      reason: decision.reason,
    });
    return { allowed: false, actor, role, reason: decision.reason };
  }

  return { allowed: true, actor, role, profile };
}

export async function authorizeRepoAction(guardrailRepo, actor, action, permission) {
  const { getActiveProfile } = await import('../profile.js');
  const { createUser, enforcePermission } = await import('../rbac.js');

  const profile = getActiveProfile();
  const resolvedActor = actor || profile?.name || process.env.USER || 'operator';
  const role = profile?.operator_role || null;

  if (!profile || !role) {
    const reason = 'Active Guardrail profile with operator_role is required for privileged actions';
    await appendRepoAuditEntry(guardrailRepo, 'emergency_denied', {
      status: 'denied',
      action,
      actor: resolvedActor,
      reason,
    });
    return { allowed: false, actor: resolvedActor, role, reason };
  }

  const user = createUser(resolvedActor, role);
  const decision = enforcePermission(user, permission);
  await appendRepoAuditEntry(guardrailRepo, 'rbac_check', {
    status: decision.allowed ? 'allowed' : 'blocked',
    action,
    actor: resolvedActor,
    role,
    permission,
    reason: decision.reason || null,
  });
  if (!decision.allowed) {
    await appendRepoAuditEntry(guardrailRepo, 'emergency_denied', {
      status: 'denied',
      action,
      actor: resolvedActor,
      role,
      reason: decision.reason,
    });
    return { allowed: false, actor: resolvedActor, role, reason: decision.reason };
  }

  return { allowed: true, actor: resolvedActor, role, profile };
}

export { isTerminalAiProgressState };
