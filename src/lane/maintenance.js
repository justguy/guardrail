import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function removeLaneDirectory(laneDir) {
  try {
    rmSync(laneDir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

function laneTombstoneDir(guardrailRepo) {
  return join(resolve(guardrailRepo || process.cwd()), '.guardrail', 'lane-tombstones');
}

function laneTombstonePathFor(lane, cleanedAt, deps = {}) {
  const { laneDirFingerprint } = deps;
  const stamp = String(cleanedAt || new Date().toISOString()).replaceAll(':', '-');
  return join(laneTombstoneDir(lane.guardrailRepo), `${stamp}-${laneDirFingerprint(lane.laneDir)}.json`);
}

function writeLaneTombstone(lane, details = {}, deps = {}) {
  const { writeJson } = deps;
  if (!lane?.laneDir) return null;
  const cleanedAt = new Date().toISOString();
  const tombstonePath = laneTombstonePathFor(lane, cleanedAt, deps);
  mkdirSync(dirname(tombstonePath), { recursive: true });
  writeJson(tombstonePath, {
    schemaVersion: 1,
    action: details.action || 'cleanup',
    reason: details.reason || null,
    cleanedAt,
    laneId: lane.laneId || null,
    laneDir: lane.laneDir,
    guardrailRepo: lane.guardrailRepo || null,
    ownerRepoId: lane.ownerRepoId || null,
    tool: lane.tool || lane.adapterId || null,
    adapterId: lane.adapterId || null,
    status: lane.status || null,
    aliveBeforeCleanup: !!lane.alive,
    sessionName: lane.sessionName || null,
    sessionId: lane.sessionId || null,
    keyPath: lane.keyPath || null,
    bootNonce: lane.bootNonce || null,
    identityNonce: lane.identityNonce || null,
    keyPresent: lane.keyPresent === true,
    requestFifoPresent: lane.requestFifoPresent === true,
    responseFifoPresent: lane.responseFifoPresent === true,
    currentRequestId: lane.currentRequestId || null,
    lastRequestId: lane.lastRequestId || null,
    lastCompletedRequestId: lane.lastCompletedRequestId || null,
    lastActivityAt: lane.lastActivityAt || null,
    logPath: lane.logPath || null,
    transportSummary: lane.transportSummary || null,
    scopeType: lane.scopeType || 'none',
    scopeMode: lane.scopeMode || 'warn',
    scopePaths: Array.isArray(lane.scopePaths) ? lane.scopePaths : [],
    resourceMode: lane.resourceMode || 'none',
    resourceClaims: Array.isArray(lane.resourceClaims) ? lane.resourceClaims : [],
    resourceDetails: Array.isArray(lane.resourceDetails) ? lane.resourceDetails : [],
  });
  return tombstonePath;
}

function lanePruneSignals(lane, deps = {}) {
  const { readLaneClaim, laneClaimIsLive } = deps;
  const claim = lane.laneId ? readLaneClaim(lane.laneId, lane.keyPath || '') : null;
  const claimAlive = !!claim && laneClaimIsLive(claim);
  return {
    alive: !!lane.alive,
    status: lane.status,
    identityPresent: !!lane.identityPath && existsSync(lane.identityPath),
    statePresent: !!lane.statePath && existsSync(lane.statePath),
    keyPresent: lane.keyPresent === true,
    requestFifoPresent: lane.requestFifoPresent === true,
    responseFifoPresent: lane.responseFifoPresent === true,
    bootNonce: lane.bootNonce || null,
    claimPresent: !!claim,
    claimAlive,
  };
}

function classifyResidentLaneForPrune(lane, options = {}, deps = {}) {
  const includeFailed = options.includeFailed === true;
  const signals = lanePruneSignals(lane, deps);
  const prunableStates = new Set(includeFailed ? ['stale', 'expired', 'stopped', 'failed'] : ['stale', 'expired', 'stopped']);

  if (signals.alive) return { prunable: false, reason: 'lane_alive', signals };
  if (signals.claimAlive) return { prunable: false, reason: 'live_claim_present', signals };
  if (!prunableStates.has(lane.status)) return { prunable: false, reason: 'not_prunable', signals };

  const reasonByStatus = {
    stale: 'dead_artifacts_present',
    expired: 'lane_expired',
    stopped: 'lane_stopped',
    failed: 'lane_failed',
  };
  return {
    prunable: true,
    reason: reasonByStatus[lane.status] || 'dead_artifacts_present',
    signals,
  };
}

function cleanupLaneWithReason(lane, action, reason, deps = {}) {
  const { removeHostLaneRegistryEntry, removeLaneClaim, removeIfExists } = deps;
  const tombstonePath = writeLaneTombstone(lane, { action, reason }, deps);
  removeHostLaneRegistryEntry(lane);
  if (lane.laneId) {
    removeLaneClaim(lane.laneId, lane.keyPath || '', {
      laneDir: lane.laneDir,
      bootNonce: lane.bootNonce || null,
    });
  }
  if (lane.keyPath) removeIfExists(lane.keyPath);
  removeLaneDirectory(lane.laneDir);
  return {
    laneDir: lane.laneDir,
    laneId: lane.laneId || null,
    adapterId: lane.adapterId || null,
    tool: lane.tool || lane.adapterId || null,
    status: lane.status,
    keyPath: lane.keyPath || null,
    aliveBeforeCleanup: lane.alive,
    tombstonePath,
    cleanupReason: reason || null,
  };
}

function resolveEmergencyOptions(rawOptions) {
  if (!rawOptions.laneDir) throw new Error('Provide --lane-dir.');
  const guardrailRepo = rawOptions.guardrailRepo
    ? resolve(process.cwd(), rawOptions.guardrailRepo)
    : process.cwd();
  const laneDir = resolve(guardrailRepo, rawOptions.laneDir);
  return {
    adapterId: rawOptions.adapterId || 'unknown',
    laneDir,
    keyPath: rawOptions.keyPath ? resolve(process.cwd(), rawOptions.keyPath) : '',
    guardrailRepo,
    workingDir: rawOptions.workingDir ? resolve(guardrailRepo, rawOptions.workingDir) : guardrailRepo,
    laneId: rawOptions.laneId || '',
    scopeType: 'none',
    scopeMode: 'warn',
    scopePaths: [],
    resourceMode: 'warn',
    resources: [],
    sessionName: rawOptions.sessionName || rawOptions.laneId || '',
    sessionId: rawOptions.sessionId || '',
    noSessionPersistence: false,
    authFd: null,
    actor: rawOptions.actor || 'operator',
    reason: rawOptions.reason || '',
  };
}

function writeRevocationSentinel(laneDir) {
  const sentinelPath = join(laneDir, 'REVOKED');
  writeFileSync(sentinelPath, `${JSON.stringify({ revokedAt: new Date().toISOString() })}\n`, 'utf8');
}

export function pruneResidentLanes(rawOptions = {}, deps = {}) {
  const { listResidentLanes } = deps;
  const includeFailed = rawOptions.includeFailed === true || rawOptions.includeFailed === 'true';
  const dryRun = rawOptions.dryRun === true || rawOptions.dryRun === 'true';
  const listing = listResidentLanes(rawOptions);
  const candidates = [];
  const pruned = [];
  const skipped = [];

  for (const lane of listing.lanes) {
    const classification = classifyResidentLaneForPrune(lane, { includeFailed }, deps);
    const summary = {
      laneDir: lane.laneDir,
      laneId: lane.laneId || null,
      tool: lane.tool || lane.adapterId || null,
      status: lane.status,
      reason: classification.reason,
      signals: classification.signals,
    };
    if (!classification.prunable) {
      skipped.push(summary);
      continue;
    }

    candidates.push(summary);
    if (dryRun) continue;
    pruned.push(cleanupLaneWithReason(lane, 'prune', classification.reason, deps));
  }

  return { registryDir: listing.registryDir, includeFailed, dryRun, candidates, pruned, skipped };
}

export function stopResidentLane(rawOptions = {}, deps = {}) {
  const { cleanupLaneArtifacts, isPidAlive, lanePaths, readJson } = deps;
  if (!rawOptions.laneDir) throw new Error('Provide --lane-dir.');
  const guardrailRepo = rawOptions.guardrailRepo
    ? resolve(process.cwd(), rawOptions.guardrailRepo)
    : process.cwd();
  const laneDir = resolve(guardrailRepo, rawOptions.laneDir);
  const keyPath = rawOptions.keyPath ? resolve(process.cwd(), rawOptions.keyPath) : '';
  const options = {
    adapterId: rawOptions.adapterId || 'unknown',
    laneDir,
    keyPath,
    guardrailRepo,
    workingDir: rawOptions.workingDir ? resolve(guardrailRepo, rawOptions.workingDir) : guardrailRepo,
    laneId: rawOptions.laneId || '',
    scopeType: rawOptions.scopeType || 'none',
    scopeMode: rawOptions.scopeMode || 'warn',
    scopePaths: Array.isArray(rawOptions.scopePaths) ? rawOptions.scopePaths : [],
    resourceMode: rawOptions.resourceMode || 'warn',
    resources: Array.isArray(rawOptions.resources) ? rawOptions.resources : [],
    sessionName: rawOptions.sessionName || rawOptions.laneId || '',
    sessionId: rawOptions.sessionId || '',
    noSessionPersistence: false,
    authFd: null,
  };
  const paths = lanePaths(options.laneDir);
  const state = readJson(paths.statePath, null);
  options.scopeType = state?.scopeType ?? options.scopeType;
  options.scopeMode = state?.scopeMode ?? options.scopeMode;
  options.scopePaths = state?.scopePaths ?? options.scopePaths;
  options.resourceMode = state?.resourceMode ?? options.resourceMode;
  options.resources = state?.resources ?? options.resources;
  options.bootNonce = state?.bootNonce ?? rawOptions.bootNonce ?? '';
  options.identityNonce = state?.identityNonce ?? rawOptions.identityNonce ?? '';
  if (state?.pid && isPidAlive(state.pid)) {
    try { process.kill(state.pid, 'SIGTERM'); } catch {}
  }
  cleanupLaneArtifacts(options, 'stopped', {
    lastRequestId: state?.lastRequestId || null,
    currentRequestId: state?.currentRequestId || null,
    currentRequestStartedAt: state?.currentRequestStartedAt || null,
    lastCompletedRequestId: state?.lastCompletedRequestId || null,
    lastCompletedAt: state?.lastCompletedAt || null,
    lastExitCode: state?.lastExitCode ?? null,
    lastResultPath: state?.lastResultPath || null,
    createdAt: state?.createdAt,
  });
  try {
    rmSync(join(options.laneDir, 'logs'), { recursive: true, force: true });
  } catch {}
  return {
    adapterId: state?.adapterId ?? options.adapterId,
    tool: state?.tool ?? options.tool ?? state?.adapterId ?? options.adapterId,
    laneDir: options.laneDir,
    statePath: paths.statePath,
    keyPath: options.keyPath || null,
    stopped: true,
  };
}

export function cleanupResidentLane(rawOptions = {}, deps = {}) {
  const { listResidentLanes } = deps;
  const listing = listResidentLanes(rawOptions);
  const explicitLaneDir = rawOptions.laneDir
    ? resolve(rawOptions.guardrailRepo ? resolve(process.cwd(), rawOptions.guardrailRepo) : process.cwd(), rawOptions.laneDir)
    : null;
  const selected = explicitLaneDir
    ? listing.lanes.filter((lane) => lane.laneDir === explicitLaneDir)
    : listing.lanes;

  if (selected.length === 0) {
    return {
      status: 'missing',
      cleaned: false,
      message: 'No resident lane matched the requested cleanup target.',
      registryDir: listing.registryDir,
      matches: [],
    };
  }

  if (selected.length > 1) {
    return {
      status: 'ambiguous',
      cleaned: false,
      message: 'More than one resident lane matched the requested cleanup target.',
      registryDir: listing.registryDir,
      matches: selected.map((lane) => ({
        laneDir: lane.laneDir,
        laneId: lane.laneId || null,
        status: lane.status,
        tool: lane.tool || lane.adapterId || null,
      })),
    };
  }

  const lane = selected[0];
  const stopped = lane.alive ? stopResidentLane({
    ...rawOptions,
    laneDir: lane.laneDir,
    laneId: lane.laneId || rawOptions.laneId || '',
    keyPath: lane.keyPath || rawOptions.keyPath || '',
    tool: lane.tool || rawOptions.tool || lane.adapterId || 'claude',
    sessionName: lane.sessionName || rawOptions.sessionName || lane.laneId || '',
    sessionId: lane.sessionId || rawOptions.sessionId || '',
  }, deps) : null;
  const cleaned = cleanupLaneWithReason({
    ...lane,
    alive: false,
    status: stopped ? 'stopped' : lane.status,
    keyPath: stopped?.keyPath || lane.keyPath || null,
  }, 'cleanup', stopped ? 'manual_stop_then_cleanup' : 'manual_cleanup', deps);

  return {
    status: 'cleaned',
    cleaned: true,
    registryDir: listing.registryDir,
    lane: cleaned,
    stoppedLiveLane: !!stopped,
  };
}

export function revokeResidentLane(rawOptions = {}, deps = {}) {
  const { cleanupLaneArtifacts, isPidAlive, lanePaths, readJson } = deps;
  const options = resolveEmergencyOptions(rawOptions);
  const paths = lanePaths(options.laneDir);
  const state = readJson(paths.statePath, null);
  options.bootNonce = state?.bootNonce ?? rawOptions.bootNonce ?? '';
  options.identityNonce = state?.identityNonce ?? rawOptions.identityNonce ?? '';

  if (state?.pid && isPidAlive(state.pid)) {
    try { process.kill(state.pid, 'SIGTERM'); } catch {}
  }

  cleanupLaneArtifacts(options, 'revoked', {
    lastRequestId: state?.lastRequestId || null,
    currentRequestId: state?.currentRequestId || null,
    currentRequestStartedAt: state?.currentRequestStartedAt || null,
    lastCompletedRequestId: state?.lastCompletedRequestId || null,
    lastCompletedAt: state?.lastCompletedAt || null,
    lastExitCode: state?.lastExitCode ?? null,
    lastResultPath: state?.lastResultPath || null,
    createdAt: state?.createdAt,
    failureReason: options.reason || null,
    failureStage: 'revoked',
  });

  writeRevocationSentinel(options.laneDir);

  return {
    adapterId: state?.adapterId ?? options.adapterId,
    tool: state?.tool ?? options.adapterId,
    laneDir: options.laneDir,
    statePath: paths.statePath,
    revoked: true,
    actor: options.actor,
    reason: options.reason || null,
  };
}

export function killResidentLane(rawOptions = {}, deps = {}) {
  const { cleanupLaneArtifacts, isPidAlive, lanePaths, readJson } = deps;
  const options = resolveEmergencyOptions(rawOptions);
  const paths = lanePaths(options.laneDir);
  const state = readJson(paths.statePath, null);
  options.bootNonce = state?.bootNonce ?? rawOptions.bootNonce ?? '';
  options.identityNonce = state?.identityNonce ?? rawOptions.identityNonce ?? '';

  if (state?.pid && isPidAlive(state.pid)) {
    try { process.kill(state.pid, 'SIGKILL'); } catch {}
  }

  cleanupLaneArtifacts(options, 'revoked', {
    lastRequestId: state?.lastRequestId || null,
    currentRequestId: state?.currentRequestId || null,
    currentRequestStartedAt: state?.currentRequestStartedAt || null,
    lastCompletedRequestId: state?.lastCompletedRequestId || null,
    lastCompletedAt: state?.lastCompletedAt || null,
    lastExitCode: state?.lastExitCode ?? null,
    lastResultPath: state?.lastResultPath || null,
    createdAt: state?.createdAt,
    failureReason: options.reason || 'break-glass emergency kill',
    failureStage: 'killed',
  });

  writeRevocationSentinel(options.laneDir);

  return {
    adapterId: state?.adapterId ?? options.adapterId,
    tool: state?.tool ?? options.adapterId,
    laneDir: options.laneDir,
    statePath: paths.statePath,
    killed: true,
    revoked: true,
    actor: options.actor,
    reason: options.reason || null,
  };
}

export function revokeAllResidentLanes(rawOptions = {}, deps = {}) {
  const { listResidentLanes } = deps;
  const listing = listResidentLanes(rawOptions);
  const lanes = listing.lanes || [];
  const targeted = lanes.length;
  let revoked = 0;
  let skipped = 0;
  let failed = 0;
  const results = [];

  for (const lane of lanes) {
    if (lane.status === 'revoked' || existsSync(join(lane.laneDir, 'REVOKED'))) {
      skipped += 1;
      results.push({ laneDir: lane.laneDir, laneId: lane.laneId || null, outcome: 'skipped', reason: 'already_revoked' });
      continue;
    }
    try {
      const result = revokeResidentLane({ ...rawOptions, laneDir: lane.laneDir, laneId: lane.laneId }, deps);
      revoked += 1;
      results.push({ laneDir: lane.laneDir, laneId: lane.laneId || null, outcome: 'revoked', result });
    } catch (err) {
      failed += 1;
      results.push({ laneDir: lane.laneDir, laneId: lane.laneId || null, outcome: 'failed', error: err.message });
    }
  }

  return { targeted, revoked, skipped, failed, results };
}

export function killAllResidentLanes(rawOptions = {}, deps = {}) {
  const { listResidentLanes } = deps;
  const listing = listResidentLanes(rawOptions);
  const lanes = listing.lanes || [];
  const targeted = lanes.length;
  let killed = 0;
  let skipped = 0;
  let failed = 0;
  const results = [];

  for (const lane of lanes) {
    if (lane.status === 'revoked' || existsSync(join(lane.laneDir, 'REVOKED'))) {
      skipped += 1;
      results.push({ laneDir: lane.laneDir, laneId: lane.laneId || null, outcome: 'skipped', reason: 'already_revoked' });
      continue;
    }
    try {
      const result = killResidentLane({ ...rawOptions, laneDir: lane.laneDir, laneId: lane.laneId }, deps);
      killed += 1;
      results.push({ laneDir: lane.laneDir, laneId: lane.laneId || null, outcome: 'killed', result });
    } catch (err) {
      failed += 1;
      results.push({ laneDir: lane.laneDir, laneId: lane.laneId || null, outcome: 'failed', error: err.message });
    }
  }

  return { targeted, killed, skipped, failed, results };
}
