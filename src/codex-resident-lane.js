import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  createLaneBootError,
  getResidentLaneLogs,
  getResidentLaneResult,
  getResidentLaneStatus,
  lanePaths,
  laneResultPath,
  launchResidentLaneDaemonHelper as launchResidentLaneDaemonHelperWithAdapter,
  launchResidentLaneWithAdapter,
  listResidentLanes,
  normalizeResidentLaneResources,
  normalizeResidentLaneScope,
  parseInteger,
  persistLaneFailureState,
  pruneResidentLanes,
  readSecretFromFd,
  runResidentLaneDaemon as runResidentLaneDaemonWithAdapter,
  runResidentLaneRequest,
  shellTruthy,
  signLaneRequest,
  splitCsv,
  stopResidentLane,
  trackLaneRequestId,
  validateLaneRequest,
  waitForResidentLaneResult,
  waitForResidentLaneBootstrap,
} from './resident-lane-core.js';

const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export const residentLaneAdapterMetadata = {
  id: 'codex',
  name: 'Codex',
  description: 'Resident lane adapter for Codex CLI execution.',
  source: 'bundled',
  capabilities: ['resident_session', 'interactive_prompt', 'stored_results', 'bounded_logs', 'resource_claims'],
};

export function parseResidentLaneArgs(argv) {
  const options = {
    laneDir: '',
    guardrailRepo: '',
    workingDir: '',
    model: '',
    profile: '',
    sandbox: '',
    addDirs: '',
    inputFiles: '',
    imageFiles: '',
    color: '',
    oss: '',
    localProvider: '',
    skipGitRepoCheck: '',
    ephemeral: '',
    fullAuto: '',
    laneId: '',
    keyPath: '',
    hostStateDir: '',
    identityNonce: '',
    bootNonce: '',
    sessionName: '',
    sessionId: '',
    scopeType: '',
    scopeMode: '',
    scopePaths: '',
    resourceMode: '',
    resources: '',
    authFd: '',
    pollIntervalMs: '',
    idleTimeoutMs: '',
    launchDaemonHelper: false,
    daemon: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    switch (flag) {
      case '--lane-dir':
        options.laneDir = value;
        i += 1;
        break;
      case '--guardrail-repo':
        options.guardrailRepo = value;
        i += 1;
        break;
      case '--working-dir':
        options.workingDir = value;
        i += 1;
        break;
      case '--model':
        options.model = value;
        i += 1;
        break;
      case '--profile':
        options.profile = value;
        i += 1;
        break;
      case '--sandbox':
        options.sandbox = value;
        i += 1;
        break;
      case '--add-dirs':
        options.addDirs = value;
        i += 1;
        break;
      case '--input-files':
        options.inputFiles = value;
        i += 1;
        break;
      case '--image-files':
        options.imageFiles = value;
        i += 1;
        break;
      case '--color':
        options.color = value;
        i += 1;
        break;
      case '--oss':
        options.oss = value;
        i += 1;
        break;
      case '--local-provider':
        options.localProvider = value;
        i += 1;
        break;
      case '--skip-git-repo-check':
        options.skipGitRepoCheck = value;
        i += 1;
        break;
      case '--ephemeral':
        options.ephemeral = value;
        i += 1;
        break;
      case '--full-auto':
        options.fullAuto = value;
        i += 1;
        break;
      case '--lane-id':
        options.laneId = value;
        i += 1;
        break;
      case '--key-path':
        options.keyPath = value;
        i += 1;
        break;
      case '--host-state-dir':
        options.hostStateDir = value;
        i += 1;
        break;
      case '--identity-nonce':
        options.identityNonce = value;
        i += 1;
        break;
      case '--boot-nonce':
        options.bootNonce = value;
        i += 1;
        break;
      case '--session-name':
        options.sessionName = value;
        i += 1;
        break;
      case '--session-id':
        options.sessionId = value;
        i += 1;
        break;
      case '--scope-type':
        options.scopeType = value;
        i += 1;
        break;
      case '--scope-mode':
        options.scopeMode = value;
        i += 1;
        break;
      case '--scope-path':
      case '--scope-paths':
        options.scopePaths = options.scopePaths ? `${options.scopePaths},${value}` : value;
        i += 1;
        break;
      case '--resource-mode':
        options.resourceMode = value;
        i += 1;
        break;
      case '--resource':
      case '--resources':
        options.resources = options.resources ? `${options.resources},${value}` : value;
        i += 1;
        break;
      case '--auth-fd':
        options.authFd = value;
        i += 1;
        break;
      case '--poll-interval-ms':
        options.pollIntervalMs = value;
        i += 1;
        break;
      case '--idle-timeout-ms':
        options.idleTimeoutMs = value;
        i += 1;
        break;
      case '--launch-daemon-helper':
        options.launchDaemonHelper = true;
        break;
      case '--daemon':
        options.daemon = true;
        break;
      default:
        break;
    }
  }

  return options;
}

export function normalizeResidentLaneOptions(rawOptions, baseCwd = process.cwd()) {
  if (!rawOptions.laneDir) throw new Error('Provide --lane-dir.');
  if (!rawOptions.sessionName) throw new Error('Provide --session-name.');

  const guardrailRepo = rawOptions.guardrailRepo
    ? resolve(baseCwd, rawOptions.guardrailRepo)
    : baseCwd;
  const laneDir = resolve(guardrailRepo, rawOptions.laneDir);
  const workingDir = rawOptions.workingDir
    ? resolve(guardrailRepo, rawOptions.workingDir)
    : guardrailRepo;
  const scope = normalizeResidentLaneScope(rawOptions, guardrailRepo, workingDir);
  const resources = normalizeResidentLaneResources(rawOptions, guardrailRepo, workingDir);
  const keyPath = rawOptions.keyPath ? resolve(baseCwd, rawOptions.keyPath) : '';
  const hostStateDir = rawOptions.hostStateDir
    ? resolve(baseCwd, rawOptions.hostStateDir)
    : (keyPath ? dirname(dirname(keyPath)) : resolve(guardrailRepo, '.guardrail'));

  return {
    adapterId: 'codex',
    laneDir,
    guardrailRepo,
    workingDir,
    model: rawOptions.model || '',
    profile: rawOptions.profile || '',
    sandbox: rawOptions.sandbox || '',
    addDirs: splitCsv(rawOptions.addDirs).map((dir) => resolve(workingDir, dir)),
    inputFiles: splitCsv(rawOptions.inputFiles),
    imageFiles: splitCsv(rawOptions.imageFiles).map((file) => resolve(workingDir, file)),
    color: rawOptions.color || '',
    oss: shellTruthy(rawOptions.oss),
    localProvider: rawOptions.localProvider || '',
    skipGitRepoCheck: shellTruthy(rawOptions.skipGitRepoCheck),
    ephemeral: shellTruthy(rawOptions.ephemeral),
    fullAuto: shellTruthy(rawOptions.fullAuto),
    laneId: rawOptions.laneId || '',
    scopeType: scope.scopeType,
    scopeMode: scope.scopeMode,
    scopePaths: scope.scopePaths,
    resourceMode: resources.resourceMode,
    resources: resources.resources,
    resourceDetails: resources.resourceDetails,
    keyPath,
    hostStateDir,
    identityNonce: rawOptions.identityNonce || '',
    bootNonce: rawOptions.bootNonce || '',
    sessionName: rawOptions.sessionName,
    sessionId: rawOptions.sessionId || '',
    noSessionPersistence: false,
    authFd: parseInteger(rawOptions.authFd, null, 'auth_fd', 3),
    pollIntervalMs: parseInteger(rawOptions.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'poll_interval_ms', 50),
    idleTimeoutMs: parseInteger(rawOptions.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'idle_timeout_ms', 1000),
    launchDaemonHelper: rawOptions.launchDaemonHelper === true,
    daemon: rawOptions.daemon === true,
    transportSummary: {
      mode: 'codex-cli',
      profile: rawOptions.profile || '',
      sandbox: rawOptions.sandbox || '',
    },
  };
}

function buildWrapperArgs(options, request, lifecycle) {
  const wrapperPath = resolve(options.guardrailRepo, 'src/codex-exec-wrapper.js');
  const args = [wrapperPath, '--prompt', request.prompt];
  if (options.inputFiles.length > 0) args.push('--input-files', options.inputFiles.join(','));
  if (options.model) args.push('--model', options.model);
  if (options.profile) args.push('--profile', options.profile);
  if (options.sandbox) args.push('--sandbox', options.sandbox);
  args.push('--working-dir', options.workingDir);
  if (options.addDirs.length > 0) args.push('--add-dirs', options.addDirs.join(','));
  if (options.imageFiles.length > 0) args.push('--image-files', options.imageFiles.join(','));
  if (options.color) args.push('--color', options.color);
  if (options.oss) args.push('--oss', 'true');
  if (options.localProvider) args.push('--local-provider', options.localProvider);
  if (options.skipGitRepoCheck) args.push('--skip-git-repo-check', 'true');
  if (options.ephemeral) args.push('--ephemeral', 'true');
  if (options.fullAuto) args.push('--full-auto', 'true');
  args.push('--session-name', options.sessionName);
  args.push('--lifecycle', lifecycle);
  if (options.sessionId) args.push('--session-id', options.sessionId);
  return args;
}

async function spawnCodexWrapper(args, cwd) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      if (signal) {
        resolvePromise({ code: 1, stdout, stderr: `${stderr}\ncodex wrapper exited on signal ${signal}`.trim() });
        return;
      }
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

const selfPath = fileURLToPath(import.meta.url);

const CODEX_LANE_ADAPTER = {
  adapterId: 'codex',
  buildHelperArgs(options, helperAuthFd) {
    const args = [
      selfPath,
      '--launch-daemon-helper',
      '--lane-dir', options.laneDir,
      '--guardrail-repo', options.guardrailRepo,
      '--working-dir', options.workingDir,
      '--lane-id', options.laneId || '',
      '--scope-type', options.scopeType || 'none',
      '--scope-mode', options.scopeMode || 'warn',
      '--scope-paths', (options.scopePaths || []).join(','),
      '--resource-mode', options.resourceMode || 'warn',
      '--resources', (options.resources || []).join(','),
      '--key-path', options.keyPath || '',
      '--host-state-dir', options.hostStateDir || '',
      '--session-name', options.sessionName,
      '--session-id', options.sessionId || '',
      '--poll-interval-ms', String(options.pollIntervalMs),
      '--idle-timeout-ms', String(options.idleTimeoutMs),
      '--model', options.model,
      '--profile', options.profile,
      '--sandbox', options.sandbox,
      '--add-dirs', options.addDirs.join(','),
      '--input-files', options.inputFiles.join(','),
      '--image-files', options.imageFiles.join(','),
      '--color', options.color,
      '--oss', String(options.oss),
      '--local-provider', options.localProvider,
      '--skip-git-repo-check', String(options.skipGitRepoCheck),
      '--ephemeral', String(options.ephemeral),
      '--full-auto', String(options.fullAuto),
      '--identity-nonce', options.identityNonce,
      '--boot-nonce', options.bootNonce,
    ];
    if (helperAuthFd !== null) {
      args.push('--auth-fd', String(helperAuthFd));
    }
    return args;
  },
  buildDaemonArgs(options, daemonAuthFd) {
    const args = [
      selfPath,
      '--daemon',
      '--lane-dir', options.laneDir,
      '--guardrail-repo', options.guardrailRepo,
      '--working-dir', options.workingDir,
      '--lane-id', options.laneId || '',
      '--scope-type', options.scopeType || 'none',
      '--scope-mode', options.scopeMode || 'warn',
      '--scope-paths', (options.scopePaths || []).join(','),
      '--resource-mode', options.resourceMode || 'warn',
      '--resources', (options.resources || []).join(','),
      '--key-path', options.keyPath || '',
      '--host-state-dir', options.hostStateDir || '',
      '--session-name', options.sessionName,
      '--session-id', options.sessionId || '',
      '--poll-interval-ms', String(options.pollIntervalMs),
      '--idle-timeout-ms', String(options.idleTimeoutMs),
      '--model', options.model,
      '--profile', options.profile,
      '--sandbox', options.sandbox,
      '--add-dirs', options.addDirs.join(','),
      '--input-files', options.inputFiles.join(','),
      '--image-files', options.imageFiles.join(','),
      '--color', options.color,
      '--oss', String(options.oss),
      '--local-provider', options.localProvider,
      '--skip-git-repo-check', String(options.skipGitRepoCheck),
      '--ephemeral', String(options.ephemeral),
      '--full-auto', String(options.fullAuto),
      '--identity-nonce', options.identityNonce || '',
      '--boot-nonce', options.bootNonce || '',
    ];
    if (daemonAuthFd !== null) {
      args.push('--auth-fd', String(daemonAuthFd));
    }
    return args;
  },
  async runRequest(options, request, state, deps = {}) {
    const runner = deps.runner || spawnCodexWrapper;
    const lifecycle = state.startedConversation ? 'continue' : 'start';
    const startedAt = new Date().toISOString();
    const result = await runner(buildWrapperArgs(options, request, lifecycle), options.guardrailRepo);
    return {
      requestId: request.id,
      prompt: request.prompt,
      lifecycle,
      ok: result.code === 0,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  },
};

export async function runLaneRequest(options, request, state, deps = {}) {
  return runResidentLaneRequest(CODEX_LANE_ADAPTER, options, request, state, deps);
}

export async function launchResidentLane(rawOptions, deps = {}) {
  const options = normalizeResidentLaneOptions(rawOptions);
  return launchResidentLaneWithAdapter(options, CODEX_LANE_ADAPTER, deps);
}

export function launchResidentLaneDaemonHelper(rawOptions) {
  const options = normalizeResidentLaneOptions(rawOptions);
  return launchResidentLaneDaemonHelperWithAdapter(options, CODEX_LANE_ADAPTER);
}

async function main() {
  const raw = parseResidentLaneArgs(process.argv.slice(2));
  let options;
  try {
    options = normalizeResidentLaneOptions(raw);
    if (options.launchDaemonHelper) {
      launchResidentLaneDaemonHelper(raw);
      return;
    }
    if (options.daemon) {
      await runResidentLaneDaemonWithAdapter(options, CODEX_LANE_ADAPTER);
      return;
    }

    const summary = await launchResidentLane(raw);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (err) {
    if (raw?.daemon) {
      try {
        const failureOptions = options || normalizeResidentLaneOptions(raw);
        persistLaneFailureState(failureOptions, err, 'bootstrap');
      } catch {
        // Best effort.
      }
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

export {
  createLaneBootError,
  getResidentLaneLogs,
  getResidentLaneResult,
  getResidentLaneStatus,
  lanePaths,
  laneResultPath,
  listResidentLanes,
  pruneResidentLanes,
  readSecretFromFd,
  signLaneRequest,
  stopResidentLane,
  trackLaneRequestId,
  validateLaneRequest,
  waitForResidentLaneResult,
  waitForResidentLaneBootstrap,
};
