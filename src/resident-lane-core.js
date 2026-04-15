import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { queryAuditLog, verifyAuditChain } from './audit.js';
import { authorize, ACTIONS } from './authorization.js';
import { evaluateLaneHealth } from './lane/health.js';
import {
  extendResidentLane as extendResidentLaneControl,
  getResidentLaneLogs as getResidentLaneLogsFromControl,
  readLogTail,
  readLaneControl as readLaneControlFromControl,
  writeLaneControl as writeLaneControlFromControl,
} from './lane/control.js';
import {
  cleanupResidentLane as cleanupResidentLaneMaintenance,
  killAllResidentLanes as killAllResidentLanesMaintenance,
  killResidentLane as killResidentLaneMaintenance,
  pruneResidentLanes as pruneResidentLanesMaintenance,
  revokeAllResidentLanes as revokeAllResidentLanesMaintenance,
  revokeResidentLane as revokeResidentLaneMaintenance,
  stopResidentLane as stopResidentLaneMaintenance,
} from './lane/maintenance.js';
import {
  collectComparableLaneEntries as collectComparableLaneEntriesQuery,
  getResidentLaneHistory as getResidentLaneHistoryQuery,
  getResidentLanePortfolioTimeline as getResidentLanePortfolioTimelineQuery,
  getResidentLaneResult as getResidentLaneResultQuery,
  getResidentLaneStatus as getResidentLaneStatusQuery,
  getResidentLaneTimeline as getResidentLaneTimelineQuery,
  listResidentLanes as listResidentLanesQuery,
  residentLanePortfolioAuditPath as residentLanePortfolioAuditPathQuery,
  waitForResidentLaneResult as waitForResidentLaneResultQuery,
} from './lane/query.js';

export { evaluateLaneHealth } from './lane/health.js';

const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5 * 60 * 1000;
const STARTUP_POLL_INTERVAL_MS = 25;
// Host-runtime auth preflight can exceed a couple seconds, especially in
// keychain-backed Claude environments. Keep the default long enough for the
// daemon to finish preflight before launch is marked failed.
const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_SETTLE_MS = 150;
const POST_START_GRACE_MS = 750;
const STARTUP_LOCK_TTL_MS = 15_000;
const MAX_TRACKED_REQUEST_IDS = 1024;
const MAX_REQUEST_BYTES = 50_000;
const MAX_PROMPT_CHARS = 32_000;
const MAX_REQUEST_ID_CHARS = 128;
const PARTIAL_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 250;
const RESOURCE_CLASS_SCOPE = {
  'git-branch': 'repo',
  service: 'host',
  port: 'host',
  env: 'host',
  deployment: 'host',
  queue: 'host',
};

function withinPathScope(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function defaultHostStateDir() {
  return resolve(homedir(), '.guardrail');
}

function laneHostRegistryDir(options = {}) {
  return join(resolve(options.hostStateDir || hostLaneRootDir(options.keyPath || '')), 'resident-lanes');
}

function laneStartupStateDir(options = {}) {
  return join(resolve(options.hostStateDir || hostLaneRootDir(options.keyPath || '')), 'resident-lane-startup');
}

function laneDirFingerprint(laneDir) {
  return createHash('sha256')
    .update(safeRealpath(laneDir))
    .digest('hex')
    .slice(0, 24);
}

function normalizeRelativeRepoPath(maybePath, guardrailRepo, label = 'scope path') {
  const raw = String(maybePath || '').trim();
  if (!raw) throw new Error(`${label} cannot be empty`);
  const repoRoot = resolve(guardrailRepo);
  const resolved = resolve(repoRoot, raw);
  if (!withinPathScope(resolved, repoRoot)) {
    throw new Error(`${label} must stay within the Guardrail repo`);
  }
  const rel = relative(repoRoot, resolved);
  return rel || '.';
}

export function normalizeResidentLaneScope(rawOptions, guardrailRepo, workingDir) {
  const explicitScopeType = rawOptions.scopeType || rawOptions.writeScopeType || '';
  const inferredWorktree = !explicitScopeType
    && resolve(workingDir || guardrailRepo) !== resolve(guardrailRepo);
  const scopeType = explicitScopeType || (inferredWorktree ? 'worktree' : 'none');
  const scopeMode = rawOptions.scopeMode || 'warn';

  if (!['none', 'repo', 'worktree', 'paths'].includes(scopeType)) {
    throw new Error('scope_type must be one of: none, repo, worktree, paths');
  }
  if (!['warn', 'block'].includes(scopeMode)) {
    throw new Error('scope_mode must be one of: warn, block');
  }

  if (scopeType === 'none') {
    return {
      scopeType,
      scopeMode,
      scopePaths: [],
    };
  }

  if (scopeType === 'repo') {
    return {
      scopeType,
      scopeMode: 'block',
      scopePaths: ['.'],
    };
  }

  if (scopeType === 'worktree') {
    const rel = normalizeRelativeRepoPath(workingDir, guardrailRepo, 'working_dir');
    return {
      scopeType,
      scopeMode,
      scopePaths: [rel],
    };
  }

  const rawScopePaths = Array.isArray(rawOptions.scopePaths)
    ? rawOptions.scopePaths.flatMap((entry) => splitCsv(entry))
    : splitCsv(rawOptions.scopePaths || rawOptions.scopePath || '');
  if (rawScopePaths.length === 0) {
    throw new Error('scope_type=paths requires at least one --scope-path');
  }
  return {
    scopeType,
    scopeMode,
    scopePaths: rawScopePaths.map((entry) => normalizeRelativeRepoPath(entry, guardrailRepo)),
  };
}

export function shellTruthy(value) {
  return value === true || value === 'true' || value === '1';
}

export function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeResourceClaim(rawClaim) {
  const claim = String(rawClaim || '').trim();
  if (!claim) throw new Error('resource claim cannot be empty');
  if (!/^[A-Za-z0-9._:/=-]+$/.test(claim)) {
    throw new Error(`resource claim "${claim}" contains unsupported characters`);
  }
  return claim;
}

function parseResourceClaim(rawClaim) {
  const claim = normalizeResourceClaim(rawClaim);
  const sepIndex = claim.indexOf(':');
  if (sepIndex <= 0 || sepIndex === claim.length - 1) {
    return { raw: claim, className: 'generic', name: claim, scope: 'global', source: 'explicit' };
  }
  const rawClassName = claim.slice(0, sepIndex);
  const className = rawClassName === 'branch' ? 'git-branch' : rawClassName;
  const name = claim.slice(sepIndex + 1);
  const canonicalRaw = `${className}:${name}`;
  return {
    raw: canonicalRaw,
    className,
    name,
    scope: RESOURCE_CLASS_SCOPE[className] || 'global',
    source: 'explicit',
  };
}

function findGitHeadPath(startDir) {
  let current = safeRealpath(startDir);
  while (true) {
    const gitDir = join(current, '.git');
    const gitDirStatExists = existsSync(gitDir);
    if (gitDirStatExists) {
      try {
        const stat = lstatSync(gitDir);
        if (stat.isDirectory()) {
          const headPath = join(gitDir, 'HEAD');
          if (existsSync(headPath)) return headPath;
        }
      } catch {}
      try {
        const pointer = readFileSync(gitDir, 'utf8').trim();
        if (pointer.startsWith('gitdir:')) {
          const target = pointer.slice('gitdir:'.length).trim();
          const headPath = resolve(current, target, 'HEAD');
          if (existsSync(headPath)) return headPath;
        }
      } catch {}
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function inferGitBranchResource(guardrailRepo, workingDir) {
  const headPath = findGitHeadPath(workingDir || guardrailRepo);
  if (!headPath) return null;
  try {
    const head = readFileSync(headPath, 'utf8').trim();
    if (!head.startsWith('ref:')) return null;
    const ref = head.slice(4).trim();
    const prefix = 'refs/heads/';
    if (!ref.startsWith(prefix)) return null;
    const branch = ref.slice(prefix.length).trim();
    return branch ? `git-branch:${branch}` : null;
  } catch {
    return null;
  }
}

export function normalizeResidentLaneResources(rawOptions = {}, guardrailRepo = process.cwd(), workingDir = guardrailRepo) {
  const rawClaims = Array.isArray(rawOptions.resourceClaims)
    ? rawOptions.resourceClaims.flatMap((entry) => splitCsv(entry))
    : splitCsv(rawOptions.resourceClaims || rawOptions.resourceClaim || rawOptions.resources || rawOptions.resource || '');
  const resourceClaims = rawClaims.map((entry) => parseResourceClaim(entry).raw);
  const inferredGitBranch = inferGitBranchResource(guardrailRepo, workingDir);
  if (inferredGitBranch && !resourceClaims.some((claim) => parseResourceClaim(claim).className === 'git-branch')) {
    resourceClaims.push(inferredGitBranch);
  }
  const dedupedClaims = Array.from(new Set(resourceClaims));
  const resourceMode = rawOptions.resourceMode || (resourceClaims.length > 0 ? 'warn' : 'none');
  if (!['none', 'warn', 'block'].includes(resourceMode)) {
    throw new Error('resource_mode must be one of: none, warn, block');
  }
  const resourceDetails = dedupedClaims.map((claim) => {
    const detail = parseResourceClaim(claim);
    if (inferredGitBranch && detail.raw === inferredGitBranch && !rawClaims.some((entry) => parseResourceClaim(entry).raw === detail.raw)) {
      return { ...detail, source: 'discovered' };
    }
    return detail;
  });
  return {
    resourceMode: dedupedClaims.length === 0 ? 'none' : resourceMode,
    resourceClaims: dedupedClaims,
    resources: dedupedClaims,
    resourceDetails,
  };
}

export function parseInteger(value, fallback, label, min) {
  if (value === '' || value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${label} must be an integer >= ${min}`);
  }
  return parsed;
}

export function lanePaths(laneDir) {
  return {
    requestFifo: join(laneDir, 'requests.fifo'),
    responseFifo: join(laneDir, 'responses.fifo'),
    statePath: join(laneDir, 'state.json'),
    identityPath: join(laneDir, 'identity.json'),
    launchPath: join(laneDir, 'launch.json'),
    logPath: join(laneDir, 'logs', 'lane.log'),
    resultsDir: join(laneDir, 'results'),
    controlPath: join(laneDir, 'control.json'),
  };
}

export function laneResultPath(laneDir, requestId) {
  return join(lanePaths(laneDir).resultsDir, `${requestId}.json`);
}

function ensureFifo(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isFIFO()) {
      chmodSync(path, 0o600);
      return;
    }
    throw new Error(`${path} exists but is not a FIFO`);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const result = spawnSync('mkfifo', [path], { stdio: 'ignore' });
  if (result.status !== 0) {
    throw new Error(`Failed to create FIFO: ${path}`);
  }
  chmodSync(path, 0o600);
}

export function ensureLaneLayout(laneDir) {
  mkdirSync(laneDir, { recursive: true });
  mkdirSync(join(laneDir, 'logs'), { recursive: true });
  mkdirSync(join(laneDir, 'results'), { recursive: true });
  const paths = lanePaths(laneDir);
  ensureFifo(paths.requestFifo);
  ensureFifo(paths.responseFifo);
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function stableRepoOwnerId(guardrailRepo) {
  return createHash('sha256')
    .update(safeRealpath(guardrailRepo))
    .digest('hex')
    .slice(0, 16);
}

function laneHostRegistryPathFor(options) {
  const registryDir = laneHostRegistryDir(options);
  const laneHash = laneDirFingerprint(options.laneDir);
  return join(registryDir, `${laneHash}.json`);
}

function writeHostLaneRegistryEntry(options, state = {}) {
  mkdirSync(laneHostRegistryDir(options), { recursive: true });
  writeJson(laneHostRegistryPathFor(options), {
    laneId: options.laneId || state.laneId || null,
    laneDir: options.laneDir,
    guardrailRepo: options.guardrailRepo,
    ownerRepoId: stableRepoOwnerId(options.guardrailRepo),
    tool: options.tool || options.adapterId || state.tool || state.adapterId || null,
    adapterId: options.adapterId || state.adapterId || null,
    sessionName: options.sessionName || state.sessionName || null,
    sessionId: options.sessionId || state.sessionId || null,
    transportSummary: options.transportSummary || state.transportSummary || null,
    workingDir: options.workingDir || state.workingDir || null,
    keyPath: options.keyPath || state.keyPath || null,
    scopeType: options.scopeType || state.scopeType || 'none',
    scopeMode: options.scopeMode || state.scopeMode || 'warn',
    scopePaths: Array.isArray(options.scopePaths) ? options.scopePaths : (state.scopePaths || []),
    resourceMode: options.resourceMode || state.resourceMode || 'warn',
    resources: Array.isArray(options.resources) ? options.resources : (state.resources || []),
    resourceDetails: Array.isArray(options.resourceDetails) ? options.resourceDetails : (state.resourceDetails || []),
    identityNonce: options.identityNonce || state.identityNonce || null,
    bootNonce: options.bootNonce || state.bootNonce || null,
    pid: state.pid ?? process.pid,
    status: state.status || 'ready',
    updatedAt: new Date().toISOString(),
  });
}

function removeHostLaneRegistryEntry(options = {}) {
  removeIfExists(laneHostRegistryPathFor(options));
}

function readHostLaneRegistryEntries(rawOptions = {}) {
  const registryDir = laneHostRegistryDir(rawOptions);
  const entries = [];
  if (!existsSync(registryDir)) {
    return { registryDir, entries };
  }
  for (const entry of readdirSync(registryDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const parsed = readJson(join(registryDir, entry.name), null);
    if (!parsed?.laneDir) continue;
    const alive = isPidAlive(parsed.pid);
    if (!alive) {
      removeIfExists(join(registryDir, entry.name));
      continue;
    }
    entries.push({
      ...parsed,
      laneDir: resolve(parsed.laneDir),
      guardrailRepo: parsed.guardrailRepo ? resolve(parsed.guardrailRepo) : null,
      workingDir: parsed.workingDir ? resolve(parsed.workingDir) : null,
      alive: true,
      status: parsed.status || 'ready',
      source: 'host-registry',
    });
  }
  return { registryDir, entries };
}

function hydrateStateFromResultArtifact(laneDir, paths, state) {
  if (!state) return state;
  const candidateRequestIds = [
    state.currentRequestId,
    state.lastCompletedRequestId,
    state.lastRequestId,
  ].filter(Boolean);

  let result = null;
  let resultPath = null;
  for (const requestId of candidateRequestIds) {
    const candidatePath = laneResultPath(laneDir, requestId);
    const parsed = readJson(candidatePath, null);
    if (parsed) {
      result = parsed;
      resultPath = candidatePath;
      break;
    }
  }

  if (!result || !resultPath) return state;

  const completedAt = result.completedAt || result.startedAt || state.lastCompletedAt || state.lastActivityAt || null;
  const stateLastActivityMs = state.lastActivityAt ? Date.parse(state.lastActivityAt) : Number.NaN;
  const completedAtMs = completedAt ? Date.parse(completedAt) : Number.NaN;
  const resultIsNewer = Number.isFinite(completedAtMs)
    && (!Number.isFinite(stateLastActivityMs) || completedAtMs >= stateLastActivityMs);
  const shouldHydrate = resultIsNewer
    || state.status === 'busy'
    || state.status === 'stalled'
    || state.currentRequestId === result.requestId;

  if (!shouldHydrate) return state;

  return {
    ...state,
    status: result.ok ? 'ready' : 'failed',
    lastRequestId: result.requestId || state.lastRequestId || null,
    currentRequestId: null,
    currentRequestStartedAt: null,
    lastCompletedRequestId: result.requestId || state.lastCompletedRequestId || null,
    lastCompletedAt: completedAt,
    lastExitCode: result.exitCode ?? state.lastExitCode ?? null,
    lastResultPath: resultPath,
    lastActivityAt: completedAt || state.lastActivityAt || null,
    currentAiState: null,
    currentAiEvent: null,
    currentAiPhase: null,
    currentAiMessage: null,
    currentAiTimestamp: null,
    failureReason: result.ok ? null : (state.failureReason || summarizeFailureReasonFromResult(result)),
    failureStage: result.ok ? null : (state.failureStage || 'runtime'),
  };
}

function summarizeFailureReasonFromResult(result) {
  const stderr = String(result?.stderr || '').trim();
  if (stderr) {
    const firstLine = stderr.split('\n').map((line) => line.trim()).filter(Boolean)[0];
    if (firstLine) return firstLine;
  }
  if (typeof result?.exitCode === 'number') {
    return `Resident lane request exited with code ${result.exitCode}.`;
  }
  return 'Resident lane request failed.';
}

function stableLaneClaimId(laneId) {
  return createHash('sha256')
    .update(String(laneId || ''))
    .digest('hex')
    .slice(0, 24);
}

function hostLaneRootDir(keyPath = '', guardrailRepo = '.') {
  if (keyPath) {
    return dirname(dirname(resolve(keyPath)));
  }
  return resolve(guardrailRepo, '.guardrail', 'host-lanes');
}

function hostLaneRegistryPaths(options = {}) {
  const hostRoot = hostLaneRootDir(options.keyPath || '', options.guardrailRepo || '.');
  return {
    hostRoot,
    liveDir: join(hostRoot, 'live'),
    startupStateDir: join(hostRoot, 'startup-state'),
  };
}

function buildLaneClaimPayload(options, pid, status = 'ready') {
  return {
    laneId: options.laneId || null,
    laneDir: options.laneDir,
    guardrailRepo: options.guardrailRepo,
    sessionName: options.sessionName || null,
    sessionId: options.sessionId || null,
    tool: options.tool || options.adapterId || 'unknown',
    ownerRepoId: stableRepoOwnerId(options.guardrailRepo),
    identityNonce: options.identityNonce || null,
    bootNonce: options.bootNonce || null,
    pid,
    status,
    updatedAt: new Date().toISOString(),
  };
}

function laneClaimPath(laneId, keyPath = '') {
  if (!laneId) return '';
  const { liveDir } = hostLaneRegistryPaths({ keyPath });
  return join(liveDir, `${stableLaneClaimId(laneId)}.json`);
}

function readLaneClaim(laneId, keyPath = '') {
  const path = laneClaimPath(laneId, keyPath);
  return path ? readJson(path, null) : null;
}

function writeLaneClaim(options, payload) {
  if (!options.laneId) return null;
  const claimPath = laneClaimPath(options.laneId, options.keyPath || '');
  mkdirSync(dirname(claimPath), { recursive: true });
  writeJson(claimPath, payload);
  return claimPath;
}

function removeLaneClaim(laneId, keyPath = '', match = null) {
  const claimPath = laneClaimPath(laneId, keyPath);
  if (!claimPath || !existsSync(claimPath)) return;
  if (match) {
    const current = readJson(claimPath, null);
    if (!current) return;
    if (match.bootNonce && current.bootNonce !== match.bootNonce) return;
    if (match.laneDir && resolve(current.laneDir || '') !== resolve(match.laneDir)) return;
  }
  removeIfExists(claimPath);
}

function laneClaimIsLive(claim) {
  if (!claim?.pid || !isPidAlive(claim.pid)) return false;
  if (!claim.laneDir) return true;
  const state = readJson(lanePaths(claim.laneDir).statePath, null);
  if (!state) return true;
  if (claim.bootNonce && state.bootNonce && state.bootNonce !== claim.bootNonce) return false;
  return !['expired', 'stopped', 'failed'].includes(state.status);
}

function normalizeLiveLaneClaim(claim, keyPath = '') {
  if (!claim?.laneId) return null;
  if (!laneClaimIsLive(claim)) {
    removeLaneClaim(claim.laneId, keyPath, {
      laneDir: claim.laneDir || null,
      bootNonce: claim.bootNonce || null,
    });
    return null;
  }
  return claim;
}

function buildLaneIdentity(options, existing = null) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    adapterId: options.adapterId || existing?.adapterId || 'unknown',
    tool: options.tool || existing?.tool || options.adapterId || existing?.adapterId || 'unknown',
    scopeType: options.scopeType || existing?.scopeType || 'none',
    scopeMode: options.scopeMode || existing?.scopeMode || 'warn',
    scopePaths: Array.isArray(options.scopePaths)
      ? options.scopePaths
      : (existing?.scopePaths || []),
    resourceMode: options.resourceMode || existing?.resourceMode || 'warn',
    resources: Array.isArray(options.resources)
      ? options.resources
      : (Array.isArray(options.resourceClaims) ? options.resourceClaims : (existing?.resources || existing?.resourceClaims || [])),
    resourceClaims: Array.isArray(options.resourceClaims)
      ? options.resourceClaims
      : (Array.isArray(options.resources) ? options.resources : (existing?.resourceClaims || existing?.resources || [])),
    resourceDetails: Array.isArray(options.resourceDetails)
      ? options.resourceDetails
      : (existing?.resourceDetails || []),
    laneId: options.laneId || existing?.laneId || null,
    laneDir: options.laneDir,
    guardrailRepo: options.guardrailRepo,
    workingDir: options.workingDir,
    keyPath: options.keyPath || existing?.keyPath || null,
    hostStateDir: options.hostStateDir || existing?.hostStateDir || defaultHostStateDir(),
    sessionName: options.sessionName,
    sessionId: options.sessionId || null,
    transportSummary: options.transportSummary || existing?.transportSummary || null,
    ownerRepoId: stableRepoOwnerId(options.guardrailRepo),
    identityNonce: existing?.identityNonce || options.identityNonce || randomBytes(12).toString('hex'),
    bootNonce: options.bootNonce || existing?.bootNonce || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function validateLaneIdentity(identity, options) {
  if (!identity) return;
  if (identity.laneDir && resolve(identity.laneDir) !== options.laneDir) {
    throw createLaneBootError('Resident lane identity does not match the requested lane directory.', {
      failureStage: 'bootstrap',
    });
  }
  if (identity.guardrailRepo && resolve(identity.guardrailRepo) !== options.guardrailRepo) {
    throw createLaneBootError('Resident lane identity belongs to a different Guardrail repo.', {
      failureStage: 'bootstrap',
    });
  }
  if (identity.laneId && options.laneId && identity.laneId !== options.laneId) {
    throw createLaneBootError('Resident lane identity belongs to a different lane id.', {
      failureStage: 'bootstrap',
    });
  }
}

function writeLaneIdentity(options, existing = null) {
  const identity = buildLaneIdentity(options, existing);
  writeJson(lanePaths(options.laneDir).identityPath, identity);
  return identity;
}

export function getResidentLaneLogs(rawOptions = {}) {
  return getResidentLaneLogsFromControl(rawOptions, {
    getResidentLaneStatus,
    parseInteger,
  });
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'EPERM') return true;
    return false;
  }
}

function buildState(options, pid, startedConversation = false, extra = {}) {
  const paths = lanePaths(options.laneDir);
  return {
    adapterId: options.adapterId || 'unknown',
    tool: options.tool || options.adapterId || 'unknown',
    scopeType: options.scopeType || 'none',
    scopeMode: options.scopeMode || 'warn',
    scopePaths: Array.isArray(options.scopePaths) ? options.scopePaths : [],
    resourceMode: options.resourceMode || 'warn',
    resources: Array.isArray(options.resources)
      ? options.resources
      : (Array.isArray(options.resourceClaims) ? options.resourceClaims : []),
    resourceClaims: Array.isArray(options.resourceClaims)
      ? options.resourceClaims
      : (Array.isArray(options.resources) ? options.resources : []),
    resourceDetails: Array.isArray(options.resourceDetails) ? options.resourceDetails : [],
    laneDir: options.laneDir,
    requestFifo: paths.requestFifo,
    responseFifo: paths.responseFifo,
    identityPath: paths.identityPath,
    guardrailRepo: options.guardrailRepo,
    workingDir: options.workingDir,
    laneId: options.laneId || null,
    keyPath: options.keyPath || null,
    hostStateDir: options.hostStateDir || defaultHostStateDir(),
    sessionName: options.sessionName,
    sessionId: options.sessionId || null,
    transportSummary: options.transportSummary || extra.transportSummary || null,
    identityNonce: options.identityNonce || null,
    bootNonce: options.bootNonce || null,
    ownerRepoId: stableRepoOwnerId(options.guardrailRepo),
    noSessionPersistence: options.noSessionPersistence,
    authMode: options.authFd ? 'hmac_fd' : 'none',
    authSource: extra.authSource || null,
    authPreflightStatus: extra.authPreflightStatus || null,
    authPreflightReason: extra.authPreflightReason || null,
    authPreflightMessage: extra.authPreflightMessage || null,
    authPreflightCheckedAt: extra.authPreflightCheckedAt || null,
    logPath: paths.logPath,
    startedConversation,
    pid,
    status: extra.status || 'ready',
    lastRequestId: extra.lastRequestId || null,
    currentRequestId: extra.currentRequestId || null,
    currentRequestStartedAt: extra.currentRequestStartedAt || null,
    lastCompletedRequestId: extra.lastCompletedRequestId || null,
    lastCompletedAt: extra.lastCompletedAt || null,
    lastExitCode: extra.lastExitCode ?? null,
    lastResultPath: extra.lastResultPath || null,
    failureReason: extra.failureReason || null,
    failureStage: extra.failureStage || null,
    lastActivityAt: extra.lastActivityAt || new Date().toISOString(),
    createdAt: extra.createdAt || new Date().toISOString(),
    pollIntervalMs: options.pollIntervalMs,
    idleTimeoutMs: options.idleTimeoutMs,
    healthTimeoutMs: options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
  };
}

export function readLaneControl(laneDir) {
  return readLaneControlFromControl(laneDir, lanePaths, readJson);
}

export function writeLaneControl(laneDir, patch) {
  return writeLaneControlFromControl(laneDir, patch, lanePaths, readJson, writeJson);
}

export function extendResidentLane(laneDir, updates = {}) {
  return extendResidentLaneControl(laneDir, updates, {
    readLaneControl,
    writeLaneControl,
  });
}

function canonicalRequestPayload(request) {
  return JSON.stringify({
    id: request.id,
    prompt: request.prompt,
    reportArtifact: request.reportArtifact || '',
    completionMode: request.completionMode || '',
  });
}

export function readSecretFromFd(fd) {
  if (!Number.isInteger(fd) || fd < 3) return '';
  const chunks = [];
  const buffer = Buffer.alloc(4096);
  for (;;) {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead <= 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

export function signLaneRequest(request, secret) {
  return createHmac('sha256', secret)
    .update(canonicalRequestPayload(request))
    .digest('hex');
}

export function verifyLaneRequestSignature(request, secret) {
  if (!secret) return true;
  if (typeof request.signature !== 'string' || request.signature.length !== 64 || !/^[a-f0-9]{64}$/.test(request.signature)) {
    throw new Error('invalid_signature');
  }
  const expected = Buffer.from(signLaneRequest(request, secret), 'utf8');
  const actual = Buffer.from(request.signature, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('invalid_signature');
  }
  return true;
}

export function validateLaneRequest(parsed, secret = '') {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_request');
  }

  const allowedKeys = new Set(['id', 'prompt', 'reportArtifact', 'completionMode', ...(secret ? ['signature'] : [])]);
  const keys = Object.keys(parsed).sort();
  if (!keys.every((key) => allowedKeys.has(key))) {
    throw new Error('invalid_request');
  }

  if (
    typeof parsed.id !== 'string' ||
    parsed.id.length < 1 ||
    parsed.id.length > MAX_REQUEST_ID_CHARS ||
    !/^[A-Za-z0-9._:-]+$/.test(parsed.id)
  ) {
    throw new Error('invalid_request_id');
  }

  if (
    typeof parsed.prompt !== 'string' ||
    parsed.prompt.length < 1 ||
    parsed.prompt.length > MAX_PROMPT_CHARS
  ) {
    throw new Error('invalid_prompt');
  }

  if (parsed.reportArtifact !== undefined) {
    if (typeof parsed.reportArtifact !== 'string' || parsed.reportArtifact.length < 1 || parsed.reportArtifact.length > 1024) {
      throw new Error('invalid_request');
    }
  }

  if (parsed.completionMode !== undefined) {
    if (parsed.completionMode !== 'direct' && parsed.completionMode !== 'artifact') {
      throw new Error('invalid_request');
    }
  }

  verifyLaneRequestSignature(parsed, secret);
  return parsed;
}

export function trackLaneRequestId(seenRequestIds, requestId, nowMs = Date.now(), ttlMs = DEFAULT_IDLE_TIMEOUT_MS) {
  if (!(seenRequestIds instanceof Map)) {
    throw new Error('seenRequestIds must be a Map');
  }

  for (const [seenId, seenAtMs] of seenRequestIds.entries()) {
    if ((nowMs - seenAtMs) > ttlMs) {
      seenRequestIds.delete(seenId);
    }
  }

  if (seenRequestIds.has(requestId)) {
    throw new Error('duplicate_request_id');
  }

  seenRequestIds.set(requestId, nowMs);

  while (seenRequestIds.size > MAX_TRACKED_REQUEST_IDS) {
    const oldest = seenRequestIds.keys().next().value;
    if (oldest === undefined) break;
    seenRequestIds.delete(oldest);
  }

  return seenRequestIds;
}

export async function runResidentLaneRequest(adapter, options, request, state, deps = {}) {
  if (!adapter || typeof adapter.runRequest !== 'function') {
    throw new Error('Resident lane adapter must provide runRequest(options, request, state, deps).');
  }
  return adapter.runRequest(options, request, state, deps);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function updateStateFile(laneDir, state) {
  writeJson(lanePaths(laneDir).statePath, state);
}

function appendLaneLogLine(logPath, line) {
  if (!logPath || typeof line !== 'string') return;
  const text = line.trimEnd();
  if (!text) return;
  try {
    appendFileSync(logPath, `${text}\n`);
  } catch {
    // Best effort.
  }
}

function writeLaneResult(laneDir, response) {
  const resultPath = laneResultPath(laneDir, response.requestId);
  writeJson(resultPath, response);
  return resultPath;
}

function deriveFailureReason(err, fallback = 'Resident lane bootstrap failed.') {
  const message = String(err?.message || '').trim();
  return message || fallback;
}

export function persistLaneFailureState(options, err, failureStage = 'bootstrap') {
  try {
    mkdirSync(options.laneDir, { recursive: true });
    mkdirSync(join(options.laneDir, 'logs'), { recursive: true });
    if (options.laneId) {
      removeLaneClaim(options.laneId, options.keyPath || '', {
        laneDir: options.laneDir,
        bootNonce: options.bootNonce || null,
      });
    }
    const pid = err?.details?.pid ?? process.pid;
    const state = buildState(options, pid, false, {
      status: 'failed',
      failureReason: deriveFailureReason(err),
      failureStage,
      lastActivityAt: new Date().toISOString(),
    });
    writeJson(lanePaths(options.laneDir).statePath, state);
  } catch {
    // Best effort.
  }
}

export function createLaneBootError(message, details = {}) {
  const err = new Error(message);
  err.code = 'LANE_BOOT_FAILED';
  err.details = details;
  return err;
}

export async function waitForResidentLaneBootstrap(options, child, deps = {}) {
  const readState = deps.readState || ((path) => readJson(path, null));
  const isAlive = deps.isAlive || isPidAlive;
  const sleepFn = deps.sleep || sleep;
  const nowFn = deps.now || Date.now;
  const logTailFn = deps.readLogTail || readLogTail;
  const timeoutMs = deps.timeoutMs || STARTUP_TIMEOUT_MS;
  const postStartGraceMs = deps.postStartGraceMs || POST_START_GRACE_MS;
  const paths = lanePaths(options.laneDir);
  const expectedPid = child?.pid ?? null;
  const exitState = { code: null, signal: null, error: null };

  if (child instanceof EventEmitter) {
    child.once('error', (err) => {
      exitState.error = err;
    });
    child.once('exit', (code, signal) => {
      exitState.code = code;
      exitState.signal = signal;
    });
  }

  const startedAtMs = nowFn();
  let healthySinceMs = null;
  let postStartSinceMs = null;

  for (;;) {
    const state = readState(paths.statePath);
    const alive = expectedPid ? isAlive(expectedPid) : false;

    if (state?.status === 'failed') {
      throw createLaneBootError(
        state.failureReason || 'Resident lane daemon failed during startup.',
        {
          pid: state.pid ?? expectedPid,
          statePath: paths.statePath,
          logPath: paths.logPath,
          failureReason: state.failureReason || null,
          failureStage: state.failureStage || null,
        },
      );
    }

    if (exitState.error) {
      const logTail = logTailFn(paths.logPath);
      throw createLaneBootError(
        deriveFailureReason(exitState.error),
        {
          pid: expectedPid,
          statePath: paths.statePath,
          logPath: paths.logPath,
          failureReason: deriveFailureReason(exitState.error),
          failureStage: postStartSinceMs === null ? 'bootstrap' : 'post_start',
          logTail,
        },
      );
    }

    if ((exitState.code !== null || exitState.signal !== null) && !alive) {
      const logTail = logTailFn(paths.logPath);
      throw createLaneBootError(
        logTail || `Resident lane daemon exited during startup (code=${exitState.code ?? 'null'}, signal=${exitState.signal ?? 'null'}).`,
        {
          pid: expectedPid,
          statePath: paths.statePath,
          logPath: paths.logPath,
          failureReason: logTail || null,
          failureStage: postStartSinceMs === null ? 'bootstrap' : 'post_start',
          exitCode: exitState.code,
          signal: exitState.signal,
        },
      );
    }

    const appearsHealthy = !!(
      state
      && state.pid === expectedPid
      && alive
      && state.status !== 'bootstrapping'
      && state.status !== 'failed'
      && state.status !== 'expired'
      && state.status !== 'stopped'
    );

    if (appearsHealthy) {
      if (healthySinceMs === null) {
        healthySinceMs = nowFn();
      } else if ((nowFn() - healthySinceMs) >= STARTUP_SETTLE_MS) {
        if (postStartSinceMs === null) {
          postStartSinceMs = nowFn();
        } else if ((nowFn() - postStartSinceMs) >= postStartGraceMs) {
          return state;
        }
      }
    } else {
      healthySinceMs = null;
    }

    if ((nowFn() - startedAtMs) >= timeoutMs) {
      const logTail = logTailFn(paths.logPath);
      throw createLaneBootError(
        logTail || 'Resident lane daemon did not become ready before the startup deadline.',
        {
          pid: expectedPid,
          statePath: paths.statePath,
          logPath: paths.logPath,
          failureReason: logTail || null,
          failureStage: postStartSinceMs === null ? 'bootstrap' : 'post_start',
        },
      );
    }

    await sleepFn(STARTUP_POLL_INTERVAL_MS);
  }
}

function writeResponse(fd, payload) {
  writeSync(fd, `${JSON.stringify(payload)}\n`, undefined, 'utf8');
}

function removeIfExists(path) {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function isFifo(path) {
  try {
    return lstatSync(path).isFIFO();
  } catch {
    return false;
  }
}

function classifyLaneStatus(state, identityPresent, keyPresent, requestFifoPresent, responseFifoPresent) {
  const alive = !!(state?.pid && isPidAlive(state.pid) && state.status !== 'expired' && state.status !== 'stopped' && state.status !== 'failed');
  const allArtifactsPresent = keyPresent && requestFifoPresent && responseFifoPresent;

  if (!state && !identityPresent && !keyPresent && !requestFifoPresent && !responseFifoPresent) {
    return { status: 'missing', alive: false, recommendedAction: 'start' };
  }
  if (state?.status === 'expired' || state?.status === 'stopped') {
    return { status: state.status, alive: false, recommendedAction: 'start' };
  }
  if (state?.status === 'failed') {
    return { status: 'failed', alive: false, recommendedAction: allArtifactsPresent ? 'cleanup' : 'start' };
  }
  if (alive) {
    if (state?.status === 'busy') {
      return { status: 'busy', alive: true, recommendedAction: 'result' };
    }
    if (state?.status === 'stalled') {
      return { status: 'stalled', alive: true, recommendedAction: 'result' };
    }
    return { status: state?.status || 'ready', alive: true, recommendedAction: 'send' };
  }
  if (state || identityPresent || keyPresent || requestFifoPresent || responseFifoPresent) {
    return { status: 'stale', alive: false, recommendedAction: allArtifactsPresent ? 'cleanup' : 'start' };
  }
  return { status: 'missing', alive: false, recommendedAction: 'start' };
}

function inferImplicitFailure(status, state) {
  if (!state) return null;
  if (status.status !== 'stale') return null;
  if (state.failureReason || state.failureStage) return null;
  if (state.startedConversation) return null;
  if (state.currentRequestId || state.lastCompletedRequestId) return null;
  if (state.status !== 'ready' && state.status !== 'busy') return null;

  return {
    status: 'failed',
    alive: false,
    recommendedAction: 'start',
    failureStage: 'post_start',
    failureReason: 'Resident lane daemon exited before processing the first request.',
  };
}

function scopeRootsForLane(entry) {
  const repoRoot = resolve(entry.guardrailRepo || process.cwd());
  const scopeType = entry.scopeType || 'none';
  const scopePaths = Array.isArray(entry.scopePaths) ? entry.scopePaths : [];
  if (scopeType === 'none' || scopePaths.length === 0) return [];
  return scopePaths.map((scopePath) => resolve(repoRoot, scopePath));
}

function laneScopesOverlap(a, b) {
  const aRoots = scopeRootsForLane(a);
  const bRoots = scopeRootsForLane(b);
  if (aRoots.length === 0 || bRoots.length === 0) return false;
  for (const aRoot of aRoots) {
    for (const bRoot of bRoots) {
      if (withinPathScope(aRoot, bRoot) || withinPathScope(bRoot, aRoot)) {
        return true;
      }
    }
  }
  return false;
}

function buildScopeConflict(entry, other) {
  const enforcement = (
    entry.scopeType === 'repo'
    || entry.scopeMode === 'block'
    || other.scopeType === 'repo'
    || other.scopeMode === 'block'
  ) ? 'block' : 'warn';
  return {
    laneId: other.laneId || null,
    laneDir: other.laneDir,
    guardrailRepo: other.guardrailRepo || null,
    tool: other.tool || other.adapterId || null,
    scopeType: other.scopeType || 'none',
    scopeMode: other.scopeMode || 'warn',
    scopePaths: Array.isArray(other.scopePaths) ? other.scopePaths : [],
    enforcement,
  };
}

function laneResourcesOverlap(a, b) {
  const ownerRepoIdFor = (entry) => entry.ownerRepoId || (entry.guardrailRepo ? stableRepoOwnerId(entry.guardrailRepo) : null);
  const aResources = (Array.isArray(a.resourceClaims) ? a.resourceClaims : (Array.isArray(a.resources) ? a.resources : []))
    .map((resource) => parseResourceClaim(resource));
  const bResources = (Array.isArray(b.resourceClaims) ? b.resourceClaims : (Array.isArray(b.resources) ? b.resources : []))
    .map((resource) => parseResourceClaim(resource));
  return aResources.some((left) => bResources.some((right) => {
    if (left.className !== right.className || left.name !== right.name) return false;
    if (left.scope === 'repo' || right.scope === 'repo') {
      const leftOwner = ownerRepoIdFor(a);
      const rightOwner = ownerRepoIdFor(b);
      return !!leftOwner && !!rightOwner && leftOwner === rightOwner;
    }
    return true;
  }));
}

function buildResourceConflict(entry, other) {
  const enforcement = (
    entry.resourceMode === 'block'
    || other.resourceMode === 'block'
  ) ? 'block' : 'warn';
  return {
    laneId: other.laneId || null,
    laneDir: other.laneDir,
    guardrailRepo: other.guardrailRepo || null,
    tool: other.tool || other.adapterId || null,
    resourceMode: other.resourceMode || 'warn',
    resources: Array.isArray(other.resources) ? other.resources : (Array.isArray(other.resourceClaims) ? other.resourceClaims : []),
    resourceDetails: Array.isArray(other.resourceDetails) ? other.resourceDetails : [],
    enforcement,
  };
}

export function getResidentLaneHistory(rawOptions = {}) {
  return getResidentLaneHistoryQuery(rawOptions, { parseInteger });
}

export function residentLanePortfolioAuditPath(rawOptions = {}) {
  return residentLanePortfolioAuditPathQuery(rawOptions, { defaultHostStateDir });
}

export function getResidentLaneTimeline(rawOptions = {}) {
  return getResidentLaneTimelineQuery(rawOptions, {
    buildResourceConflict,
    buildScopeConflict,
    classifyLaneStatus,
    defaultHostStateDir,
    hydrateStateFromResultArtifact,
    inferImplicitFailure,
    isFifo,
    lanePaths,
    laneResourcesOverlap,
    laneScopesOverlap,
    parseInteger,
    parseResourceClaim,
    readHostLaneRegistryEntries,
    readJson,
    splitCsv,
    writeJson,
  });
}

export function getResidentLanePortfolioTimeline(rawOptions = {}) {
  return getResidentLanePortfolioTimelineQuery(rawOptions, {
    buildResourceConflict,
    buildScopeConflict,
    classifyLaneStatus,
    defaultHostStateDir,
    hydrateStateFromResultArtifact,
    inferImplicitFailure,
    isFifo,
    lanePaths,
    laneResourcesOverlap,
    laneScopesOverlap,
    laneTombstoneDir,
    parseInteger,
    parseResourceClaim,
    readHostLaneRegistryEntries,
    readJson,
    splitCsv,
    writeJson,
  });
}

export function getResidentLaneStatus(rawOptions) {
  return getResidentLaneStatusQuery(rawOptions, {
    buildResourceConflict,
    buildScopeConflict,
    classifyLaneStatus,
    defaultHostStateDir,
    hydrateStateFromResultArtifact,
    inferImplicitFailure,
    isFifo,
    lanePaths,
    laneResourcesOverlap,
    laneScopesOverlap,
    parseResourceClaim,
    readHostLaneRegistryEntries,
    readJson,
    writeJson,
  });
}

export function listResidentLanes(rawOptions = {}) {
  return listResidentLanesQuery(rawOptions, {
    buildResourceConflict,
    buildScopeConflict,
    classifyLaneStatus,
    defaultHostStateDir,
    hydrateStateFromResultArtifact,
    inferImplicitFailure,
    isFifo,
    lanePaths,
    laneResourcesOverlap,
    laneScopesOverlap,
    parseResourceClaim,
    readHostLaneRegistryEntries,
    readJson,
    writeJson,
  });
}

export function pruneResidentLanes(rawOptions = {}) {
  return pruneResidentLanesMaintenance(rawOptions, {
    laneDirFingerprint,
    laneClaimIsLive,
    listResidentLanes,
    readLaneClaim,
    removeHostLaneRegistryEntry,
    removeIfExists,
    removeLaneClaim,
    writeJson,
  });
}

export function cleanupResidentLane(rawOptions = {}) {
  return cleanupResidentLaneMaintenance(rawOptions, {
    cleanupLaneArtifacts,
    isPidAlive,
    laneDirFingerprint,
    lanePaths,
    listResidentLanes,
    readJson,
    readLaneClaim,
    removeHostLaneRegistryEntry,
    removeIfExists,
    removeLaneClaim,
    writeJson,
  });
}

export function getResidentLaneResult(rawOptions) {
  return getResidentLaneResultQuery(rawOptions, {
    getResidentLaneStatus,
    laneResultPath,
    readJson,
  });
}

export async function waitForResidentLaneResult(rawOptions = {}) {
  return waitForResidentLaneResultQuery(rawOptions, {
    getResidentLaneResult,
    getResidentLaneStatus,
    parseInteger,
    waitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
    waitPollIntervalMs: DEFAULT_WAIT_POLL_INTERVAL_MS,
  });
}

function cleanupLaneArtifacts(options, status, extra = {}) {
  const paths = lanePaths(options.laneDir);
  const finalState = {
    ...buildState(options, process.pid, false, {
      status,
      lastRequestId: extra.lastRequestId || null,
      currentRequestId: extra.currentRequestId || null,
      currentRequestStartedAt: extra.currentRequestStartedAt || null,
      lastCompletedRequestId: extra.lastCompletedRequestId || null,
      lastCompletedAt: extra.lastCompletedAt || null,
      lastExitCode: extra.lastExitCode ?? null,
      lastResultPath: extra.lastResultPath || null,
      failureReason: extra.failureReason || null,
      failureStage: extra.failureStage || null,
      lastActivityAt: new Date().toISOString(),
      createdAt: extra.createdAt || undefined,
    }),
    pid: process.pid,
  };
  writeJson(paths.statePath, finalState);
  removeHostLaneRegistryEntry(options);
  if (options.laneId) {
    removeLaneClaim(options.laneId, options.keyPath || '', {
      laneDir: options.laneDir,
      bootNonce: options.bootNonce || finalState.bootNonce || null,
    });
  }
  removeIfExists(options.keyPath);
  removeIfExists(paths.requestFifo);
  removeIfExists(paths.responseFifo);
  removeIfExists(paths.controlPath);
}

export async function runResidentLaneDaemon(options, adapter, deps = {}) {
  ensureLaneLayout(options.laneDir);
  const paths = lanePaths(options.laneDir);

  // Revocation sentinel check — must run before any state is written.
  // A revoked lane must never restart, regardless of ordinary cleanup or
  // re-launch attempts.
  if (existsSync(join(options.laneDir, 'REVOKED'))) {
    throw createLaneBootError('Lane has been revoked and cannot be restarted.', {
      failureStage: 'revocation_check',
    });
  }

  let state = buildState(options, process.pid, false, { status: 'bootstrapping' });
  const authSecret = options.authFd ? readSecretFromFd(options.authFd) : '';
  updateStateFile(options.laneDir, state);

  if (adapter && typeof adapter.preflightDaemon === 'function') {
    const preflight = await adapter.preflightDaemon(options, deps);
    state = {
      ...state,
      authSource: preflight?.source || null,
      authPreflightStatus: preflight?.ok ? 'passed' : 'failed',
      authPreflightReason: preflight?.reason || null,
      authPreflightMessage: preflight?.message || null,
      authPreflightCheckedAt: preflight?.checkedAt || new Date().toISOString(),
      lastActivityAt: preflight?.checkedAt || new Date().toISOString(),
    };
    if (!preflight?.ok) {
      state = {
        ...state,
        status: 'failed',
        failureReason: preflight?.message || preflight?.reason || 'Resident lane auth preflight failed.',
        failureStage: 'auth_preflight',
      };
      updateStateFile(options.laneDir, state);
      throw createLaneBootError(state.failureReason, {
        failureStage: 'auth_preflight',
        authSource: state.authSource,
        authPreflightStatus: state.authPreflightStatus,
        authPreflightReason: state.authPreflightReason,
        authPreflightMessage: state.authPreflightMessage,
        authPreflightCheckedAt: state.authPreflightCheckedAt,
      });
    }
    state = { ...state, status: 'ready' };
    updateStateFile(options.laneDir, state);
  } else {
    state = { ...state, status: 'ready' };
    updateStateFile(options.laneDir, state);
  }

  const requestFd = openSync(paths.requestFifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
  const responseFd = openSync(paths.responseFifo, fsConstants.O_RDWR);

  let lastActivityAtMs = Date.now();
  let lastSeenHeartbeat = null;
  let queue = Promise.resolve();
  let requestBuffer = '';
  let partialRequestAtMs = 0;
  const seenRequestIds = new Map();

  const enqueueRequest = (request) => {
    queue = queue.then(async () => {
      lastActivityAtMs = Date.now();
      state = {
        ...state,
        status: 'busy',
        lastRequestId: request.id,
        currentRequestId: request.id,
        currentRequestStartedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        currentAiState: 'running',
        currentAiEvent: 'ai_checkpoint',
        currentAiPhase: 'supervisor_init',
        currentAiMessage: 'Resident lane request accepted.',
        currentAiTimestamp: new Date().toISOString(),
      };
      updateStateFile(options.laneDir, state);

      const response = await runResidentLaneRequest(adapter, options, request, state, {
        ...deps,
        onProgress: (event) => {
          const nowIso = event?.timestamp || new Date().toISOString();
          lastActivityAtMs = Date.now();
          if (state.status === 'stalled') {
            state = { ...state, status: 'busy' };
          }
          state = {
            ...state,
            lastActivityAt: nowIso,
            currentAiState: event?.status || 'running',
            currentAiEvent: event?.event || null,
            currentAiPhase: event?.phase || null,
            currentAiMessage: event?.message || null,
            currentAiTimestamp: nowIso,
          };
          updateStateFile(options.laneDir, state);
        },
        onStderrLine: (line) => {
          appendLaneLogLine(paths.logPath, line);
        },
      });
      const resultPath = writeLaneResult(options.laneDir, response);
      state = {
        ...state,
        startedConversation: state.startedConversation || response.ok,
        status: 'ready',
        lastRequestId: request.id,
        currentRequestId: null,
        currentRequestStartedAt: null,
        lastCompletedRequestId: request.id,
        lastCompletedAt: response.completedAt,
        lastExitCode: response.exitCode,
        lastResultPath: resultPath,
        lastActivityAt: response.completedAt,
        currentAiState: null,
        currentAiEvent: null,
        currentAiPhase: null,
        currentAiMessage: null,
        currentAiTimestamp: null,
      };
      updateStateFile(options.laneDir, state);
      writeResponse(responseFd, response);
    }).catch((err) => {
      const failure = {
        requestId: request.id,
        prompt: request.prompt,
        ok: false,
        exitCode: 1,
        error: err.message,
        completedAt: new Date().toISOString(),
      };
      const resultPath = writeLaneResult(options.laneDir, failure);
      state = {
        ...state,
        status: 'ready',
        lastRequestId: request.id,
        currentRequestId: null,
        currentRequestStartedAt: null,
        lastCompletedRequestId: request.id,
        lastCompletedAt: failure.completedAt,
        lastExitCode: failure.exitCode,
        lastResultPath: resultPath,
        lastActivityAt: failure.completedAt,
        currentAiState: null,
        currentAiEvent: null,
        currentAiPhase: null,
        currentAiMessage: null,
        currentAiTimestamp: null,
      };
      updateStateFile(options.laneDir, state);
      writeResponse(responseFd, failure);
    });
  };

  let shuttingDown = false;
  const shutdown = (status, err = null, failureStage = 'runtime') => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      cleanupLaneArtifacts(options, status, {
        lastRequestId: state.lastRequestId,
        currentRequestId: state.currentRequestId,
        currentRequestStartedAt: state.currentRequestStartedAt,
        lastCompletedRequestId: state.lastCompletedRequestId,
        lastCompletedAt: state.lastCompletedAt,
        lastExitCode: state.lastExitCode,
        lastResultPath: state.lastResultPath,
        failureReason: err ? deriveFailureReason(err) : state.failureReason,
        failureStage: err ? failureStage : state.failureStage,
        createdAt: state.createdAt,
      });
    } finally {
      try { closeSync(requestFd); } catch {}
      try { closeSync(responseFd); } catch {}
      process.exit(0);
    }
  };

  process.once('SIGINT', () => shutdown('stopped'));
  process.once('SIGTERM', () => shutdown('stopped'));
  process.on('SIGHUP', () => {});
  process.once('uncaughtException', (err) => shutdown('failed', err, 'runtime'));
  process.once('unhandledRejection', (err) => shutdown('failed', err instanceof Error ? err : new Error(String(err)), 'runtime'));
  process.once('exit', (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      cleanupLaneArtifacts(options, 'failed', {
        lastRequestId: state.lastRequestId,
        currentRequestId: state.currentRequestId,
        currentRequestStartedAt: state.currentRequestStartedAt,
        lastCompletedRequestId: state.lastCompletedRequestId,
        lastCompletedAt: state.lastCompletedAt,
        lastExitCode: state.lastExitCode,
        lastResultPath: state.lastResultPath,
        failureReason: state.failureReason || `Resident lane daemon exited unexpectedly (code=${code ?? 'null'}).`,
        failureStage: state.failureStage || (state.startedConversation ? 'runtime' : 'post_start'),
        createdAt: state.createdAt,
      });
    } catch {
      // Best effort during process exit.
    }
  });

  try {
    const chunk = Buffer.alloc(4096);
    for (;;) {
      try {
        const bytesRead = readSync(requestFd, chunk, 0, chunk.length, null);
        if (bytesRead > 0) {
          requestBuffer += chunk.toString('utf8', 0, bytesRead);
          if (!partialRequestAtMs) partialRequestAtMs = Date.now();
          if (requestBuffer.length > MAX_REQUEST_BYTES) {
            requestBuffer = '';
            partialRequestAtMs = 0;
            writeResponse(responseFd, { ok: false, error: 'request_too_large' });
          }
          while (requestBuffer.includes('\n')) {
            const newlineIndex = requestBuffer.indexOf('\n');
            const line = requestBuffer.slice(0, newlineIndex).trim();
            requestBuffer = requestBuffer.slice(newlineIndex + 1);
            partialRequestAtMs = requestBuffer.length > 0 ? Date.now() : 0;
            if (!line) continue;
            try {
              const parsed = JSON.parse(line);
              const request = validateLaneRequest(parsed, authSecret);
              trackLaneRequestId(seenRequestIds, request.id, Date.now(), options.idleTimeoutMs);
              enqueueRequest(request);
            } catch (err) {
              writeResponse(responseFd, {
                requestId: typeof err?.requestId === 'string' ? err.requestId : null,
                ok: false,
                error: err.message === 'invalid_request'
                  || err.message === 'invalid_request_id'
                  || err.message === 'invalid_prompt'
                  || err.message === 'invalid_signature'
                  || err.message === 'duplicate_request_id'
                  ? err.message
                  : 'invalid_json',
              });
            }
          }
        }
      } catch (err) {
        if (err?.code !== 'EAGAIN') throw err;
      }

      if (requestBuffer && partialRequestAtMs && (Date.now() - partialRequestAtMs) > PARTIAL_REQUEST_TIMEOUT_MS) {
        requestBuffer = '';
        partialRequestAtMs = 0;
        writeResponse(responseFd, { ok: false, error: 'request_timeout' });
      }

      const control = readLaneControl(options.laneDir) || {};
      const evalResult = evaluateLaneHealth({
        status: state.status,
        currentRequestId: state.currentRequestId,
        lastActivityAtMs,
        lastSeenHeartbeat,
        now: Date.now(),
        control,
        idleTimeoutMs: options.idleTimeoutMs,
        healthTimeoutMs: options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      });
      lastActivityAtMs = evalResult.nextActivity;
      lastSeenHeartbeat = evalResult.nextSeenHeartbeat;
      if (evalResult.action === 'expire') {
        shutdown('expired');
      } else if (evalResult.action === 'stall') {
        state = { ...state, status: 'stalled' };
        updateStateFile(options.laneDir, state);
      } else if (evalResult.action === 'clear_stall') {
        state = {
          ...state,
          status: state.currentRequestId ? 'busy' : 'ready',
          lastActivityAt: new Date().toISOString(),
        };
        updateStateFile(options.laneDir, state);
      }
      await sleep(options.pollIntervalMs);
    }
  } finally {
    if (!shuttingDown) {
      try { closeSync(requestFd); } catch {}
      try { closeSync(responseFd); } catch {}
    }
  }
}

export async function launchResidentLaneWithAdapter(options, adapter, deps = {}) {
  ensureLaneLayout(options.laneDir);
  const paths = lanePaths(options.laneDir);
  const existingIdentity = readJson(paths.identityPath, null);
  validateLaneIdentity(existingIdentity, options);

  const seededOptions = {
    ...options,
    identityNonce: existingIdentity?.identityNonce || randomBytes(12).toString('hex'),
    bootNonce: randomBytes(12).toString('hex'),
  };
  const identity = buildLaneIdentity(seededOptions, existingIdentity);
  const optionsWithIdentity = {
    ...seededOptions,
    identityNonce: identity.identityNonce,
    bootNonce: seededOptions.bootNonce,
  };
  const existing = readJson(paths.statePath, null);
  const startupLockKey = createHash('sha256')
    .update(`resident-lane-start:${optionsWithIdentity.laneId || optionsWithIdentity.laneDir}`)
    .digest('hex');
  const localStartupStateDir = join(optionsWithIdentity.laneDir, '.startup-locks');
  mkdirSync(localStartupStateDir, { recursive: true });
  const startupStateDir = laneStartupStateDir(optionsWithIdentity);
  mkdirSync(startupStateDir, { recursive: true });
  const globalStartupLockKey = createHash('sha256')
    .update(`resident-lane-global-start:${stableRepoOwnerId(optionsWithIdentity.guardrailRepo)}:${optionsWithIdentity.laneId || laneDirFingerprint(optionsWithIdentity.laneDir)}`)
    .digest('hex');
  const startupAuth = await authorize(ACTIONS.LANE_START, {
    startupLocks: [
      {
        key: startupLockKey,
        stateDir: localStartupStateDir,
        ttlMs: STARTUP_LOCK_TTL_MS,
        checkName: 'lane_local_startup_lock',
        failureMessage: 'Another Guardrail process is already starting this resident lane.',
      },
      {
        key: globalStartupLockKey,
        stateDir: startupStateDir,
        ttlMs: STARTUP_LOCK_TTL_MS,
        checkName: 'lane_global_startup_lock',
        failureMessage: 'Another Guardrail process is already starting this resident lane from another checkout or repo surface.',
      },
    ],
  });
  if (!startupAuth.allowed) {
    throw createLaneBootError(startupAuth.reason, {
      failureStage: 'bootstrap',
      startupLockDetail: startupAuth.trace?.checks?.find((check) => check.result === 'deny')?.detail?.detail || null,
    });
  }
  const startupLock = { release: startupAuth.release };

  try {
    const comparableLanes = collectComparableLaneEntriesQuery({
      guardrailRepo: optionsWithIdentity.guardrailRepo,
      keyPath: optionsWithIdentity.keyPath || '',
      hostStateDir: optionsWithIdentity.hostStateDir || undefined,
    }, {
      classifyLaneStatus,
      defaultHostStateDir,
      hydrateStateFromResultArtifact,
      inferImplicitFailure,
      isFifo,
      lanePaths,
      readHostLaneRegistryEntries,
      readJson,
      writeJson,
    }).entries;
    const duplicates = optionsWithIdentity.laneId
      ? comparableLanes.filter((lane) => (
        lane.laneId === optionsWithIdentity.laneId
        && lane.laneDir !== optionsWithIdentity.laneDir
        && lane.alive
        && (
          lane.ownerRepoId === stableRepoOwnerId(optionsWithIdentity.guardrailRepo)
          || resolve(lane.workingDir || '') === optionsWithIdentity.workingDir
          || laneResourcesOverlap(optionsWithIdentity, lane)
        )
      ))
      : [];
    const globalClaim = optionsWithIdentity.laneId
      ? normalizeLiveLaneClaim(readLaneClaim(optionsWithIdentity.laneId, optionsWithIdentity.keyPath || ''), optionsWithIdentity.keyPath || '')
      : null;
    const crossRepoConflict = globalClaim
      && resolve(globalClaim.laneDir || '') !== optionsWithIdentity.laneDir
      ? globalClaim
      : null;
    if (duplicates.length > 0 || crossRepoConflict) {
      const conflictingLane = duplicates[0] || crossRepoConflict;
      throw createLaneBootError(`Duplicate live resident lane detected for lane id "${optionsWithIdentity.laneId}".`, {
        failureStage: 'bootstrap',
        conflictingLaneDir: conflictingLane?.laneDir || null,
        conflictingPid: conflictingLane?.pid || null,
        conflictingRepo: conflictingLane?.guardrailRepo || null,
        conflictingOwnerRepoId: conflictingLane?.ownerRepoId || null,
      });
    }
    const scopeConflicts = optionsWithIdentity.scopeType && optionsWithIdentity.scopeType !== 'none'
      ? comparableLanes
        .filter((lane) => (
          lane.laneDir !== optionsWithIdentity.laneDir
          && lane.alive
          && laneScopesOverlap(optionsWithIdentity, lane)
        ))
        .map((lane) => buildScopeConflict(optionsWithIdentity, lane))
      : [];
    const resourceConflicts = Array.isArray(optionsWithIdentity.resources) && optionsWithIdentity.resources.length > 0
      ? comparableLanes
        .filter((lane) => (
          lane.laneDir !== optionsWithIdentity.laneDir
          && lane.alive
          && laneResourcesOverlap(optionsWithIdentity, lane)
        ))
        .map((lane) => buildResourceConflict(optionsWithIdentity, lane))
      : [];
    if (scopeConflicts.some((conflict) => conflict.enforcement === 'block')) {
      throw createLaneBootError('Resident lane scope conflicts with another live lane in this Guardrail repo.', {
        failureStage: 'bootstrap',
        scopeConflicts,
      });
    }
    if (resourceConflicts.some((conflict) => conflict.enforcement === 'block')) {
      throw createLaneBootError('Resident lane resource claims conflict with another live lane in this Guardrail repo.', {
        failureStage: 'bootstrap',
        resourceConflicts,
      });
    }
    writeJson(paths.identityPath, identity);

    if (existing?.status && existing.status !== 'expired' && isPidAlive(existing.pid)) {
      const reusedSummary = {
        adapterId: existing.adapterId ?? optionsWithIdentity.adapterId ?? adapter.adapterId ?? null,
        tool: existing.tool ?? optionsWithIdentity.tool ?? existing.adapterId ?? optionsWithIdentity.adapterId ?? adapter.adapterId ?? null,
        scopeType: existing.scopeType ?? optionsWithIdentity.scopeType ?? 'none',
        scopeMode: existing.scopeMode ?? optionsWithIdentity.scopeMode ?? 'warn',
        scopePaths: existing.scopePaths ?? optionsWithIdentity.scopePaths ?? [],
        resourceMode: existing.resourceMode ?? optionsWithIdentity.resourceMode ?? 'warn',
        resources: existing.resources ?? optionsWithIdentity.resources ?? [],
        resourceDetails: existing.resourceDetails ?? optionsWithIdentity.resourceDetails ?? [],
        transportSummary: existing.transportSummary ?? optionsWithIdentity.transportSummary ?? null,
        scopeConflicts,
        resourceConflicts,
        laneDir: optionsWithIdentity.laneDir,
        requestFifo: existing.requestFifo ?? paths.requestFifo,
        responseFifo: existing.responseFifo ?? paths.responseFifo,
        pid: existing.pid,
        sessionName: existing.sessionName,
        sessionId: existing.sessionId ?? null,
        workingDir: existing.workingDir,
        statePath: paths.statePath,
        reused: true,
        authMode: existing.authMode ?? 'none',
        keyPath: existing.keyPath ?? optionsWithIdentity.keyPath ?? null,
        identityPath: paths.identityPath,
        identityNonce: existing.identityNonce ?? identity.identityNonce ?? null,
        bootNonce: existing.bootNonce ?? identity.bootNonce ?? null,
      };
      if (optionsWithIdentity.laneId) {
        writeLaneClaim(optionsWithIdentity, {
          laneId: optionsWithIdentity.laneId,
          laneDir: reusedSummary.laneDir,
          guardrailRepo: optionsWithIdentity.guardrailRepo,
          ownerRepoId: stableRepoOwnerId(optionsWithIdentity.guardrailRepo),
          keyPath: reusedSummary.keyPath,
          pid: reusedSummary.pid,
          tool: reusedSummary.tool,
          sessionName: reusedSummary.sessionName,
          identityNonce: reusedSummary.identityNonce,
          bootNonce: reusedSummary.bootNonce,
          updatedAt: new Date().toISOString(),
        });
      }
      writeHostLaneRegistryEntry(optionsWithIdentity, {
        ...existing,
        pid: reusedSummary.pid,
        status: existing.status || 'ready',
      });
      return reusedSummary;
    }

    if (!adapter || typeof adapter.buildHelperArgs !== 'function') {
      throw new Error('Resident lane adapter must provide buildHelperArgs(options, helperAuthFd).');
    }

    const helperAuthFd = optionsWithIdentity.authFd ? 3 : null;
    const helperArgs = adapter.buildHelperArgs(optionsWithIdentity, helperAuthFd);
    const helperStdio = ['ignore', 'pipe', 'pipe'];
    if (optionsWithIdentity.authFd) {
      helperStdio.push(optionsWithIdentity.authFd);
    }

    const spawnProcess = deps.spawnProcess || spawn;
    const child = spawnProcess(process.execPath, helperArgs, {
      cwd: optionsWithIdentity.guardrailRepo,
      detached: false,
      stdio: helperStdio,
      env: process.env,
    });

    let helperStdout = '';
    let helperStderr = '';
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        helperStdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        helperStderr += chunk.toString();
      });
    }

    await new Promise((resolvePromise, rejectPromise) => {
      child.on('error', rejectPromise);
      child.on('close', (code) => {
        if (code !== 0) {
          rejectPromise(new Error(helperStderr.trim() || `Resident lane launch helper exited with code ${code}.`));
          return;
        }
        resolvePromise();
      });
    });

    let daemonPid = null;
    try {
      daemonPid = JSON.parse(helperStdout.trim()).pid ?? null;
    } catch {
      daemonPid = null;
    }
    if (!Number.isInteger(daemonPid) || daemonPid <= 0) {
      throw createLaneBootError(helperStderr.trim() || 'Resident lane launch helper did not return a daemon pid.', {
        statePath: paths.statePath,
        logPath: paths.logPath,
        failureStage: 'bootstrap',
      });
    }

    const launchSummary = {
      adapterId: optionsWithIdentity.adapterId || adapter.adapterId || null,
      tool: optionsWithIdentity.tool || optionsWithIdentity.adapterId || adapter.adapterId || null,
      scopeType: optionsWithIdentity.scopeType || 'none',
      scopeMode: optionsWithIdentity.scopeMode || 'warn',
      scopePaths: optionsWithIdentity.scopePaths || [],
      resourceMode: optionsWithIdentity.resourceMode || 'warn',
      resources: optionsWithIdentity.resources || [],
      resourceDetails: optionsWithIdentity.resourceDetails || [],
      transportSummary: optionsWithIdentity.transportSummary || null,
      scopeConflicts,
      resourceConflicts,
      laneDir: optionsWithIdentity.laneDir,
      requestFifo: paths.requestFifo,
      responseFifo: paths.responseFifo,
      pid: daemonPid,
      sessionName: optionsWithIdentity.sessionName,
      sessionId: optionsWithIdentity.sessionId || null,
      workingDir: optionsWithIdentity.workingDir,
      statePath: paths.statePath,
      authMode: optionsWithIdentity.authFd ? 'hmac_fd' : 'none',
      laneId: optionsWithIdentity.laneId || null,
      keyPath: optionsWithIdentity.keyPath || null,
      logPath: paths.logPath,
      identityPath: paths.identityPath,
      identityNonce: optionsWithIdentity.identityNonce,
      bootNonce: optionsWithIdentity.bootNonce,
    };
    writeJson(paths.launchPath, launchSummary);
    writeLaneIdentity(optionsWithIdentity, identity);
    if (optionsWithIdentity.laneId) {
      writeLaneClaim(optionsWithIdentity, {
        laneId: optionsWithIdentity.laneId,
        laneDir: launchSummary.laneDir,
        guardrailRepo: optionsWithIdentity.guardrailRepo,
        ownerRepoId: stableRepoOwnerId(optionsWithIdentity.guardrailRepo),
        keyPath: launchSummary.keyPath,
        pid: launchSummary.pid,
        tool: launchSummary.tool,
        sessionName: launchSummary.sessionName,
        identityNonce: launchSummary.identityNonce,
        bootNonce: launchSummary.bootNonce,
        updatedAt: new Date().toISOString(),
      });
    }
    writeHostLaneRegistryEntry(optionsWithIdentity, {
      pid: launchSummary.pid,
      status: 'ready',
      tool: launchSummary.tool,
      adapterId: launchSummary.adapterId,
      sessionName: launchSummary.sessionName,
      sessionId: launchSummary.sessionId,
      workingDir: launchSummary.workingDir,
      keyPath: launchSummary.keyPath,
      scopeType: launchSummary.scopeType,
      scopeMode: launchSummary.scopeMode,
      scopePaths: launchSummary.scopePaths,
      resourceMode: launchSummary.resourceMode,
      resourceClaims: launchSummary.resources,
      resourceDetails: launchSummary.resourceDetails,
      transportSummary: launchSummary.transportSummary,
      identityNonce: launchSummary.identityNonce,
      bootNonce: launchSummary.bootNonce,
    });

    try {
      const waitForBootstrap = deps.waitForBootstrap || waitForResidentLaneBootstrap;
      await waitForBootstrap(optionsWithIdentity, { pid: daemonPid }, deps.waitForBootstrapDeps || {});
    } catch (err) {
      persistLaneFailureState(optionsWithIdentity, err, err?.details?.failureStage || 'bootstrap');
      throw err;
    }
    return launchSummary;
  } finally {
    startupLock.release?.();
  }
}

export function launchResidentLaneDaemonHelper(options, adapter) {
  ensureLaneLayout(options.laneDir);
  const paths = lanePaths(options.laneDir);
  const stdoutFd = openSync(paths.logPath, 'a');
  const stderrFd = openSync(paths.logPath, 'a');
  const daemonAuthFd = options.authFd ? 3 : null;

  if (!adapter || typeof adapter.buildDaemonArgs !== 'function') {
    throw new Error('Resident lane adapter must provide buildDaemonArgs(options, daemonAuthFd).');
  }

  const daemonArgs = adapter.buildDaemonArgs(options, daemonAuthFd);
  const daemonStdio = ['ignore', stdoutFd, stderrFd];
  if (options.authFd) {
    daemonStdio.push(options.authFd);
  }

  const daemon = spawn(process.execPath, daemonArgs, {
    cwd: options.guardrailRepo,
    detached: true,
    stdio: daemonStdio,
    env: process.env,
  });
  daemon.unref();
  process.stdout.write(`${JSON.stringify({ pid: daemon.pid })}\n`);
}

export function stopResidentLane(rawOptions) {
  return stopResidentLaneMaintenance(rawOptions, {
    cleanupLaneArtifacts,
    isPidAlive,
    lanePaths,
    readJson,
  });
}
export function revokeResidentLane(rawOptions) {
  return revokeResidentLaneMaintenance(rawOptions, {
    cleanupLaneArtifacts,
    isPidAlive,
    lanePaths,
    readJson,
  });
}

export function killResidentLane(rawOptions) {
  return killResidentLaneMaintenance(rawOptions, {
    cleanupLaneArtifacts,
    isPidAlive,
    lanePaths,
    readJson,
  });
}

export function revokeAllResidentLanes(rawOptions = {}) {
  return revokeAllResidentLanesMaintenance(rawOptions, {
    cleanupLaneArtifacts,
    isPidAlive,
    laneDirFingerprint,
    lanePaths,
    listResidentLanes,
    readJson,
    readLaneClaim,
    removeHostLaneRegistryEntry,
    removeIfExists,
    removeLaneClaim,
    writeJson,
  });
}

export function killAllResidentLanes(rawOptions = {}) {
  return killAllResidentLanesMaintenance(rawOptions, {
    cleanupLaneArtifacts,
    isPidAlive,
    laneDirFingerprint,
    lanePaths,
    listResidentLanes,
    readJson,
    readLaneClaim,
    removeHostLaneRegistryEntry,
    removeIfExists,
    removeLaneClaim,
    writeJson,
  });
}
