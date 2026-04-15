import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { queryAuditLog, verifyAuditChain } from '../audit.js';

function laneTimelineEntryMatches(entry, rawOptions = {}, deps = {}) {
  const { splitCsv } = deps;
  if (rawOptions.event && entry.event !== rawOptions.event) return false;
  if (rawOptions.laneId && entry.lane_id !== rawOptions.laneId) return false;
  if (rawOptions.filterLaneId && entry.lane_id !== rawOptions.filterLaneId) return false;
  if (rawOptions.requestId && entry.request_id !== rawOptions.requestId) return false;
  if (rawOptions.filterSessionName && entry.session_name !== rawOptions.filterSessionName) return false;
  if (rawOptions.toolFilter) {
    const wantedTools = new Set(Array.isArray(rawOptions.toolFilter) ? rawOptions.toolFilter : splitCsv(rawOptions.toolFilter));
    if (wantedTools.size > 0 && !wantedTools.has(entry.tool || '')) return false;
  }
  if (rawOptions.status) {
    const wantedStatuses = new Set(Array.isArray(rawOptions.status) ? rawOptions.status : splitCsv(rawOptions.status));
    if (wantedStatuses.size > 0 && !wantedStatuses.has(entry.status || '')) return false;
  }
  if (rawOptions.after && entry.timestamp < rawOptions.after) return false;
  if (rawOptions.before && entry.timestamp > rawOptions.before) return false;
  if (rawOptions.repoFilter) {
    const requestedRepo = resolve(rawOptions.guardrailRepo || '.', rawOptions.repoFilter);
    const entryRepo = entry.guardrail_repo ? resolve(entry.guardrail_repo) : null;
    if (entryRepo !== requestedRepo) return false;
  }
  return true;
}

function readLaneTimelineAuditEntries(guardrailRepo, rawOptions = {}, deps = {}) {
  const auditPath = resolve(guardrailRepo, '.guardrail', 'audit.jsonl');
  const repoEntries = queryAuditLog(auditPath, {
    after: rawOptions.after || undefined,
    before: rawOptions.before || undefined,
  }).filter((entry) => String(entry.event || '').startsWith('lane_'))
    .map((entry) => ({
      source: 'audit',
      timestamp: entry.timestamp,
      event: entry.event,
      lane_id: entry.lane_id || null,
      lane_dir: entry.lane_dir ? resolve(guardrailRepo, entry.lane_dir) : null,
      session_name: entry.session_name || null,
      session_id: entry.session_id || null,
      tool: entry.tool || null,
      status: entry.status || null,
      reason: entry.reason || entry.prune_reason || entry.cleanup_reason || null,
      request_id: entry.request_id || null,
      guardrail_repo: guardrailRepo,
      detail: entry,
    }))
    .filter((entry) => laneTimelineEntryMatches(entry, rawOptions, deps));
  return {
    guardrailRepo,
    auditPath,
    chainValid: verifyAuditChain(auditPath).valid,
    entries: repoEntries,
  };
}

function laneTombstoneDir(guardrailRepo) {
  return join(resolve(guardrailRepo || process.cwd()), '.guardrail', 'lane-tombstones');
}

function readLaneTimelineTombstones(guardrailRepo, rawOptions = {}, deps = {}) {
  const { readJson } = deps;
  const dir = laneTombstoneDir(guardrailRepo);
  const entries = [];
  if (!existsSync(dir)) {
    return { tombstoneDir: dir, entries };
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const parsed = readJson(join(dir, entry.name), null);
    if (!parsed?.cleanedAt || !parsed?.laneDir) continue;
    const event = parsed.action === 'prune' ? 'lane_prune' : 'lane_cleanup';
    const normalized = {
      source: 'tombstone',
      timestamp: parsed.cleanedAt,
      event,
      lane_id: parsed.laneId || null,
      lane_dir: resolve(parsed.laneDir),
      session_name: parsed.sessionName || null,
      session_id: parsed.sessionId || null,
      tool: parsed.tool || parsed.adapterId || null,
      status: parsed.status || null,
      reason: parsed.reason || null,
      request_id: parsed.currentRequestId || parsed.lastRequestId || null,
      guardrail_repo: parsed.guardrailRepo ? resolve(parsed.guardrailRepo) : guardrailRepo,
      tombstone_path: join(dir, entry.name),
      detail: parsed,
    };
    if (laneTimelineEntryMatches(normalized, rawOptions, deps)) {
      entries.push(normalized);
    }
  }
  return { tombstoneDir: dir, entries };
}

export function residentLanePortfolioAuditPath(rawOptions = {}, deps = {}) {
  const { defaultHostStateDir } = deps;
  return join(resolve(rawOptions.hostStateDir || defaultHostStateDir()), 'resident-lane-portfolio.jsonl');
}

function readLaneTimelinePortfolioAuditEntries(rawOptions = {}, deps = {}) {
  const auditPath = residentLanePortfolioAuditPath(rawOptions, deps);
  const entries = queryAuditLog(auditPath, {
    after: rawOptions.after || undefined,
    before: rawOptions.before || undefined,
  }).filter((entry) => String(entry.event || '').startsWith('lane_'))
    .map((entry) => ({
      source: 'host-audit',
      timestamp: entry.timestamp,
      event: entry.event,
      lane_id: entry.lane_id || null,
      lane_dir: entry.lane_dir ? resolve(entry.lane_dir) : null,
      session_name: entry.session_name || null,
      session_id: entry.session_id || null,
      tool: entry.tool || null,
      status: entry.status || null,
      reason: entry.reason || entry.prune_reason || entry.cleanup_reason || null,
      request_id: entry.request_id || null,
      guardrail_repo: entry.guardrail_repo ? resolve(entry.guardrail_repo) : null,
      tombstone_path: entry.tombstone_path || null,
      detail: entry,
    }))
    .filter((entry) => laneTimelineEntryMatches(entry, rawOptions, deps));
  return {
    auditPath,
    chainValid: verifyAuditChain(auditPath).valid,
    entries,
  };
}

function portfolioReposForLaneTimeline(rawOptions = {}, deps = {}) {
  const { readHostLaneRegistryEntries } = deps;
  const guardrailRepo = resolve(rawOptions.guardrailRepo || '.');
  const repos = new Set([guardrailRepo]);
  if (rawOptions.allRepos === true || rawOptions.allRepos === 'true') {
    const hostEntries = readHostLaneRegistryEntries(rawOptions).entries;
    for (const entry of hostEntries) {
      if (entry.guardrailRepo) repos.add(resolve(entry.guardrailRepo));
    }
  }
  return Array.from(repos).sort();
}

function annotateScopeConflicts(entries, deps = {}) {
  const {
    buildResourceConflict,
    buildScopeConflict,
    laneResourcesOverlap,
    laneScopesOverlap,
  } = deps;

  return entries.map((entry) => {
    const scopeConflicts = entries
      .filter((other) => (
        other.laneDir !== entry.laneDir
        && other.alive
        && entry.alive
        && laneScopesOverlap(entry, other)
      ))
      .map((other) => buildScopeConflict(entry, other));
    const resourceConflicts = entries
      .filter((other) => (
        other.laneDir !== entry.laneDir
        && other.alive
        && entry.alive
        && laneResourcesOverlap(entry, other)
      ))
      .map((other) => buildResourceConflict(entry, other));
    return {
      ...entry,
      scopeConflicts,
      resourceConflicts,
    };
  });
}

function normalizeListFilterValues(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => String(entry).split(','))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseOptionalBooleanFilter(value) {
  if (value == null || value === '') return null;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('Boolean lane filters must be true or false.');
}

function laneMatchesFilters(entry, rawOptions = {}, deps = {}) {
  const { parseResourceClaim } = deps;
  const statuses = normalizeListFilterValues(rawOptions.status);
  if (statuses.length > 0 && !statuses.includes(entry.status)) return false;

  const tools = normalizeListFilterValues(rawOptions.toolFilter);
  if (tools.length > 0 && !tools.includes(entry.tool || entry.adapterId || '')) return false;

  const laneIds = normalizeListFilterValues(rawOptions.filterLaneId || rawOptions.laneId);
  if (laneIds.length > 0 && !laneIds.includes(entry.laneId || '')) return false;

  const sessionNames = normalizeListFilterValues(rawOptions.filterSessionName);
  if (sessionNames.length > 0 && !sessionNames.includes(entry.sessionName || '')) return false;

  const scopeTypes = normalizeListFilterValues(rawOptions.scopeTypeFilter);
  if (scopeTypes.length > 0 && !scopeTypes.includes(entry.scopeType || 'none')) return false;

  const scopeModes = normalizeListFilterValues(rawOptions.scopeModeFilter);
  if (scopeModes.length > 0 && !scopeModes.includes(entry.scopeMode || 'warn')) return false;

  const resourceFilter = normalizeListFilterValues(rawOptions.resourceFilter);
  if (resourceFilter.length > 0) {
    const entryResources = (Array.isArray(entry.resourceDetails) && entry.resourceDetails.length > 0 ? entry.resourceDetails : (
      Array.isArray(entry.resourceClaims) ? entry.resourceClaims : (Array.isArray(entry.resources) ? entry.resources : [])
    ).map((resource) => parseResourceClaim(resource)));
    const matchesFilter = (filterValue) => {
      if (filterValue.includes(':')) {
        const parsed = parseResourceClaim(filterValue);
        return entryResources.some((resource) => resource.className === parsed.className && resource.name === parsed.name);
      }
      return entryResources.some((resource) => resource.className === filterValue || resource.raw === filterValue);
    };
    if (!resourceFilter.every((resource) => matchesFilter(resource))) return false;
  }

  const alive = parseOptionalBooleanFilter(rawOptions.alive);
  if (alive !== null && alive !== entry.alive) return false;

  const hasConflicts = parseOptionalBooleanFilter(rawOptions.hasConflicts);
  const totalConflicts = (entry.scopeConflicts?.length || 0) + (entry.resourceConflicts?.length || 0);
  if (hasConflicts !== null && hasConflicts !== (totalConflicts > 0)) return false;

  return true;
}

function registryDirFor(rawOptions = {}) {
  const guardrailRepo = rawOptions.guardrailRepo
    ? resolve(process.cwd(), rawOptions.guardrailRepo)
    : process.cwd();
  const registryDir = rawOptions.lanesDir
    ? resolve(guardrailRepo, rawOptions.lanesDir)
    : join(guardrailRepo, '.guardrail', 'lanes');
  return { guardrailRepo, registryDir };
}

function collectResidentLaneStatusBase(rawOptions, deps = {}) {
  const {
    classifyLaneStatus,
    defaultHostStateDir,
    hydrateStateFromResultArtifact,
    inferImplicitFailure,
    isFifo,
    lanePaths,
    readJson,
    writeJson,
  } = deps;
  if (!rawOptions.laneDir) throw new Error('Provide --lane-dir.');
  const guardrailRepo = rawOptions.guardrailRepo
    ? resolve(process.cwd(), rawOptions.guardrailRepo)
    : process.cwd();
  const laneDir = resolve(guardrailRepo, rawOptions.laneDir);
  const keyPath = rawOptions.keyPath ? resolve(process.cwd(), rawOptions.keyPath) : '';
  const paths = lanePaths(laneDir);
  let state = readJson(paths.statePath, null);
  const hydratedState = hydrateStateFromResultArtifact(laneDir, paths, state);
  if (hydratedState !== state) {
    state = hydratedState;
    try {
      writeJson(paths.statePath, state);
    } catch {
      // Best effort only.
    }
  }
  const identity = readJson(paths.identityPath, null);
  const effectiveKeyPath = identity?.keyPath || state?.keyPath || keyPath || '';
  const keyPresent = !!(effectiveKeyPath && existsSync(effectiveKeyPath));
  const requestFifoPresent = isFifo(paths.requestFifo);
  const responseFifoPresent = isFifo(paths.responseFifo);
  const classified = classifyLaneStatus(state, !!identity, keyPresent, requestFifoPresent, responseFifoPresent);
  const implicitFailure = inferImplicitFailure(classified, state);
  const derived = implicitFailure || classified;

  return {
    adapterId: state?.adapterId ?? identity?.adapterId ?? rawOptions.adapterId ?? rawOptions.tool ?? null,
    tool: state?.tool ?? identity?.tool ?? rawOptions.tool ?? state?.adapterId ?? identity?.adapterId ?? rawOptions.adapterId ?? null,
    scopeType: state?.scopeType ?? identity?.scopeType ?? rawOptions.scopeType ?? 'none',
    scopeMode: state?.scopeMode ?? identity?.scopeMode ?? rawOptions.scopeMode ?? 'warn',
    scopePaths: state?.scopePaths ?? identity?.scopePaths ?? rawOptions.scopePaths ?? [],
    resourceMode: state?.resourceMode ?? identity?.resourceMode ?? rawOptions.resourceMode ?? 'warn',
    resources: state?.resources ?? state?.resourceClaims ?? identity?.resources ?? identity?.resourceClaims ?? rawOptions.resources ?? rawOptions.resourceClaims ?? [],
    resourceClaims: state?.resourceClaims ?? state?.resources ?? identity?.resourceClaims ?? identity?.resources ?? rawOptions.resourceClaims ?? rawOptions.resources ?? [],
    resourceDetails: state?.resourceDetails ?? identity?.resourceDetails ?? rawOptions.resourceDetails ?? [],
    laneDir,
    statePath: paths.statePath,
    status: derived.status,
    alive: derived.alive,
    pid: state?.pid ?? null,
    laneId: state?.laneId ?? identity?.laneId ?? rawOptions.laneId ?? null,
    sessionName: state?.sessionName ?? identity?.sessionName ?? rawOptions.sessionName ?? null,
    sessionId: state?.sessionId ?? identity?.sessionId ?? rawOptions.sessionId ?? null,
    transportSummary: state?.transportSummary ?? identity?.transportSummary ?? rawOptions.transportSummary ?? null,
    identityPath: paths.identityPath,
    identityNonce: state?.identityNonce ?? identity?.identityNonce ?? null,
    bootNonce: state?.bootNonce ?? identity?.bootNonce ?? null,
    ownerRepoId: state?.ownerRepoId ?? identity?.ownerRepoId ?? null,
    guardrailRepo: state?.guardrailRepo ?? identity?.guardrailRepo ?? guardrailRepo,
    workingDir: state?.workingDir ?? identity?.workingDir ?? rawOptions.workingDir ?? guardrailRepo,
    hostStateDir: state?.hostStateDir ?? identity?.hostStateDir ?? rawOptions.hostStateDir ?? defaultHostStateDir(),
    lastRequestId: state?.lastRequestId ?? null,
    currentRequestId: state?.currentRequestId ?? null,
    currentRequestStartedAt: state?.currentRequestStartedAt ?? null,
    lastCompletedRequestId: state?.lastCompletedRequestId ?? null,
    lastCompletedAt: state?.lastCompletedAt ?? null,
    lastExitCode: state?.lastExitCode ?? null,
    lastResultPath: state?.lastResultPath ?? null,
    lastActivityAt: state?.lastActivityAt ?? null,
    createdAt: state?.createdAt ?? null,
    pollIntervalMs: state?.pollIntervalMs ?? null,
    idleTimeoutMs: state?.idleTimeoutMs ?? null,
    healthTimeoutMs: state?.healthTimeoutMs ?? null,
    currentAiState: state?.currentAiState ?? null,
    currentAiEvent: state?.currentAiEvent ?? null,
    currentAiPhase: state?.currentAiPhase ?? null,
    currentAiMessage: state?.currentAiMessage ?? null,
    currentAiTimestamp: state?.currentAiTimestamp ?? null,
    control: readJson(paths.controlPath, null),
    logPath: state?.logPath ?? paths.logPath,
    keyPath: effectiveKeyPath || null,
    keyPresent,
    requestFifoPresent,
    responseFifoPresent,
    startedConversation: state?.startedConversation ?? false,
    authMode: state?.authMode ?? null,
    authSource: state?.authSource ?? null,
    authPreflightStatus: state?.authPreflightStatus ?? null,
    authPreflightReason: state?.authPreflightReason ?? null,
    authPreflightMessage: state?.authPreflightMessage ?? null,
    authPreflightCheckedAt: state?.authPreflightCheckedAt ?? null,
    failureReason: state?.failureReason ?? derived.failureReason ?? null,
    failureStage: state?.failureStage ?? derived.failureStage ?? null,
    recommendedAction: derived.recommendedAction,
  };
}

function collectResidentLaneRegistryEntries(rawOptions = {}, deps = {}) {
  const { registryDir } = registryDirFor(rawOptions);
  const entries = [];
  if (!existsSync(registryDir)) {
    return { registryDir, entries: [] };
  }

  for (const entry of readdirSync(registryDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const laneDir = join(registryDir, entry.name);
    entries.push(collectResidentLaneStatusBase({ ...rawOptions, laneDir }, deps));
  }

  return { registryDir, entries };
}

function dedupeLaneEntries(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const key = resolve(entry.laneDir || `${entry.ownerRepoId || 'unknown'}:${entry.laneId || entry.sessionName || 'unknown'}`);
    if (!seen.has(key)) {
      seen.set(key, entry);
      continue;
    }
    const existing = seen.get(key);
    if (!existing.alive && entry.alive) {
      seen.set(key, entry);
    }
  }
  return Array.from(seen.values());
}

export function collectComparableLaneEntries(rawOptions = {}, deps = {}) {
  const { readHostLaneRegistryEntries } = deps;
  const local = collectResidentLaneRegistryEntries(rawOptions, deps);
  const host = readHostLaneRegistryEntries(rawOptions);
  return {
    registryDir: local.registryDir,
    hostRegistryDir: host.registryDir,
    entries: dedupeLaneEntries([...local.entries, ...host.entries]),
  };
}

export function getResidentLaneHistory(rawOptions = {}, deps = {}) {
  const { parseInteger } = deps;
  const guardrailRepo = resolve(rawOptions.guardrailRepo || '.');
  const auditPath = resolve(guardrailRepo, '.guardrail', 'audit.jsonl');
  const requestedLaneDir = rawOptions.laneDir ? resolve(guardrailRepo, rawOptions.laneDir) : null;
  const entries = queryAuditLog(auditPath, {
    event: rawOptions.event || undefined,
  }).filter((entry) => {
    if (rawOptions.laneId && entry.lane_id !== rawOptions.laneId) return false;
    if (requestedLaneDir) {
      const entryLaneDir = entry.lane_dir ? resolve(guardrailRepo, entry.lane_dir) : null;
      if (entryLaneDir !== requestedLaneDir) return false;
    }
    if (rawOptions.requestId && entry.request_id !== rawOptions.requestId) return false;
    return true;
  });
  const limit = parseInteger(rawOptions.limit, 20, 'limit', 1);
  const tailEntries = entries.slice(-limit);
  return {
    auditPath,
    chainValid: verifyAuditChain(auditPath).valid,
    count: tailEntries.length,
    totalMatches: entries.length,
    entries: tailEntries,
  };
}

export function getResidentLaneStatus(rawOptions = {}, deps = {}) {
  const base = collectResidentLaneStatusBase(rawOptions, deps);
  const { entries } = collectComparableLaneEntries({ ...rawOptions, guardrailRepo: base.guardrailRepo }, deps);
  const combined = entries.some((entry) => entry.laneDir === base.laneDir)
    ? entries
    : [...entries, base];
  return annotateScopeConflicts(combined, deps).find((entry) => entry.laneDir === base.laneDir) || base;
}

export function listResidentLanes(rawOptions = {}, deps = {}) {
  const { registryDir, entries: localEntries } = collectResidentLaneRegistryEntries(rawOptions, deps);
  const comparableEntries = collectComparableLaneEntries(rawOptions, deps).entries;
  const localLaneDirs = new Set(localEntries.map((entry) => entry.laneDir));
  const visibleEntries = rawOptions.allRepos === true || rawOptions.allRepos === 'true'
    ? comparableEntries
    : comparableEntries.filter((entry) => localLaneDirs.has(entry.laneDir));
  const entries = annotateScopeConflicts(visibleEntries, deps).filter((entry) => laneMatchesFilters(entry, rawOptions, deps));

  entries.sort((a, b) => {
    const byCreated = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    if (byCreated !== 0) return byCreated;
    return String(a.laneId || a.sessionName || a.laneDir).localeCompare(String(b.laneId || b.sessionName || b.laneDir));
  });

  const counts = entries.reduce((acc, entry) => {
    acc.total += 1;
    acc[entry.status] = (acc[entry.status] || 0) + 1;
    return acc;
  }, { total: 0 });

  return {
    registryDir,
    counts,
    lanes: entries,
  };
}

export function getResidentLaneTimeline(rawOptions = {}, deps = {}) {
  const { parseInteger } = deps;
  const allRepos = rawOptions.allRepos === true || rawOptions.allRepos === 'true';
  const listing = listResidentLanes(rawOptions, deps);
  const snapshot = {
    registryDir: listing.registryDir,
    hostRegistryDir: listing.hostRegistryDir || null,
    counts: listing.counts,
    visibleLaneCount: listing.lanes.length,
    lanes: listing.lanes.map((lane) => ({
      laneId: lane.laneId || null,
      laneDir: lane.laneDir,
      guardrailRepo: lane.guardrailRepo || null,
      tool: lane.tool || lane.adapterId || null,
      status: lane.status,
      alive: !!lane.alive,
      currentRequestId: lane.currentRequestId || null,
      sessionName: lane.sessionName || null,
      scopeType: lane.scopeType || 'none',
      scopeMode: lane.scopeMode || 'warn',
      resourceClaims: Array.isArray(lane.resourceClaims) ? lane.resourceClaims : [],
    })),
  };
  if (allRepos) {
    const hostAudit = readLaneTimelinePortfolioAuditEntries(rawOptions, deps);
    const entries = hostAudit.entries.slice(-parseInteger(rawOptions.limit, 40, 'limit', 1));
    const summary = {
      totalMatches: hostAudit.entries.length,
      byEvent: {},
      byTool: {},
      byStatus: {},
    };
    for (const entry of hostAudit.entries) {
      summary.byEvent[entry.event] = (summary.byEvent[entry.event] || 0) + 1;
      if (entry.tool) summary.byTool[entry.tool] = (summary.byTool[entry.tool] || 0) + 1;
      if (entry.status) summary.byStatus[entry.status] = (summary.byStatus[entry.status] || 0) + 1;
    }
    return {
      repos: [],
      repoCount: 0,
      allRepos: true,
      scope: 'host',
      auditPath: hostAudit.auditPath,
      chainValid: hostAudit.chainValid,
      count: entries.length,
      totalMatches: hostAudit.entries.length,
      eventCounts: summary.byEvent,
      toolCounts: summary.byTool,
      statusCounts: summary.byStatus,
      summary,
      snapshot,
      entries,
    };
  }

  const repos = portfolioReposForLaneTimeline(rawOptions, deps);
  const repoSummaries = [];
  const allEntries = [];

  for (const guardrailRepo of repos) {
    const audit = readLaneTimelineAuditEntries(guardrailRepo, rawOptions, deps);
    const tombstones = readLaneTimelineTombstones(guardrailRepo, rawOptions, deps);
    repoSummaries.push({
      guardrailRepo,
      auditPath: audit.auditPath,
      chainValid: audit.chainValid,
      auditEntryCount: audit.entries.length,
      tombstoneDir: tombstones.tombstoneDir,
      tombstoneCount: tombstones.entries.length,
    });
    allEntries.push(...audit.entries, ...tombstones.entries);
  }

  allEntries.sort((a, b) => {
    const byTs = String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
    if (byTs !== 0) return byTs;
    return String(a.lane_id || a.lane_dir || '').localeCompare(String(b.lane_id || b.lane_dir || ''));
  });

  const limit = parseInteger(rawOptions.limit, 40, 'limit', 1);
  const entries = allEntries.slice(-limit);
  const summary = {
    totalMatches: allEntries.length,
    byEvent: {},
    byTool: {},
    byStatus: {},
  };
  for (const entry of allEntries) {
    summary.byEvent[entry.event] = (summary.byEvent[entry.event] || 0) + 1;
    if (entry.tool) summary.byTool[entry.tool] = (summary.byTool[entry.tool] || 0) + 1;
    if (entry.status) summary.byStatus[entry.status] = (summary.byStatus[entry.status] || 0) + 1;
  }

  return {
    repos: repoSummaries,
    repoCount: repoSummaries.length,
    allRepos: false,
    scope: 'repo',
    auditPath: repoSummaries[0]?.auditPath || null,
    chainValid: repoSummaries.every((repo) => repo.chainValid !== false),
    count: entries.length,
    totalMatches: allEntries.length,
    eventCounts: summary.byEvent,
    toolCounts: summary.byTool,
    statusCounts: summary.byStatus,
    summary,
    snapshot,
    entries,
  };
}

export function getResidentLanePortfolioTimeline(rawOptions = {}, deps = {}) {
  return getResidentLaneTimeline(rawOptions, deps);
}

export function getResidentLaneResult(rawOptions = {}, deps = {}) {
  const { getResidentLaneStatus, laneResultPath, readJson } = deps;
  if (!rawOptions.laneDir) throw new Error('Provide --lane-dir.');
  const status = getResidentLaneStatus(rawOptions);
  const requestId = rawOptions.requestId
    || status.currentRequestId
    || status.lastCompletedRequestId
    || status.lastRequestId
    || null;

  if (!requestId) {
    return {
      status: 'missing',
      reason: 'no_request_selected',
      message: 'No resident lane request has been recorded yet.',
      requestId: null,
      resultPath: null,
    };
  }

  const resultPath = laneResultPath(status.laneDir, requestId);
  const result = readJson(resultPath, null);
  if (result) {
    return {
      status: 'completed',
      requestId,
      resultPath,
      result,
    };
  }

  if (status.currentRequestId === requestId && (status.status === 'busy' || status.status === 'stalled')) {
    return {
      status: 'pending',
      reason: 'request_still_running',
      message: 'Resident lane request is still running.',
      requestId,
      resultPath,
      currentRequestStartedAt: status.currentRequestStartedAt,
    };
  }

  return {
    status: 'missing',
    reason: 'result_not_found',
    message: 'No stored resident lane result was found for that request.',
    requestId,
    resultPath,
  };
}

export async function waitForResidentLaneResult(rawOptions = {}, deps = {}) {
  const { getResidentLaneResult, getResidentLaneStatus, parseInteger, waitTimeoutMs, waitPollIntervalMs } = deps;
  const timeoutMs = parseInteger(rawOptions.timeoutMs, waitTimeoutMs, 'timeout_ms', 1);
  const pollIntervalMs = parseInteger(rawOptions.pollIntervalMs, waitPollIntervalMs, 'poll_interval_ms', 1);
  const startedAt = Date.now();

  for (;;) {
    const result = getResidentLaneResult(rawOptions);
    if (result.status === 'completed') return result;

    const status = getResidentLaneStatus(rawOptions);
    const requestedId = rawOptions.requestId || status.currentRequestId || status.lastRequestId || null;
    if (status.status === 'failed') {
      return {
        status: 'failed',
        reason: 'lane_failed',
        message: 'Resident lane failed before the requested result was produced.',
        requestId: requestedId,
        failureReason: status.failureReason || null,
        failureStage: status.failureStage || null,
        logPath: status.logPath || null,
      };
    }
    if (status.status === 'expired' || status.status === 'stale' || status.status === 'stopped' || status.status === 'missing') {
      return {
        status: 'missing',
        reason: 'lane_unavailable',
        message: 'Resident lane is no longer available.',
        requestId: requestedId,
      };
    }
    if (
      result.status === 'missing'
      && requestedId
      && status.status === 'ready'
      && status.currentRequestId !== requestedId
    ) {
      return {
        status: 'missing',
        reason: 'result_not_found',
        message: 'The resident lane returned to ready state without storing a result for the requested id.',
        requestId: requestedId,
        resultPath: result.resultPath || null,
      };
    }

    if ((Date.now() - startedAt) >= timeoutMs) {
      return {
        status: 'pending',
        reason: 'request_still_running',
        message: 'Resident lane request is still running.',
        requestId: requestedId,
        currentRequestStartedAt: status.currentRequestStartedAt || null,
        resultPath: result.resultPath || null,
      };
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
  }
}
