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
  id: 'local-exec',
  name: 'Local Exec',
  description: 'Resident lane adapter for a fixed local command that reads the prompt from stdin.',
  source: 'bundled',
  capabilities: ['interactive_prompt', 'stdin_prompt', 'stored_results', 'bounded_logs', 'fixed_command'],
};

export function parseResidentLaneArgs(argv) {
  const options = {
    laneDir: '',
    guardrailRepo: '',
    workingDir: '',
    command: '',
    commandArgs: '',
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
      case '--command':
        options.command = value;
        i += 1;
        break;
      case '--arg':
      case '--args':
        options.commandArgs = options.commandArgs ? `${options.commandArgs},${value}` : value;
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
  if (!rawOptions.command) throw new Error('Provide --command for --tool local-exec.');

  const guardrailRepo = rawOptions.guardrailRepo
    ? resolve(baseCwd, rawOptions.guardrailRepo)
    : baseCwd;
  const laneDir = resolve(guardrailRepo, rawOptions.laneDir);
  const workingDir = rawOptions.workingDir
    ? resolve(guardrailRepo, rawOptions.workingDir)
    : guardrailRepo;
  const scope = normalizeResidentLaneScope(rawOptions, guardrailRepo, workingDir);
  const resources = normalizeResidentLaneResources(rawOptions);
  const keyPath = rawOptions.keyPath ? resolve(baseCwd, rawOptions.keyPath) : '';
  const hostStateDir = rawOptions.hostStateDir
    ? resolve(baseCwd, rawOptions.hostStateDir)
    : (keyPath ? dirname(dirname(keyPath)) : resolve(guardrailRepo, '.guardrail'));

  return {
    adapterId: 'local-exec',
    laneDir,
    guardrailRepo,
    workingDir,
    tool: rawOptions.tool || 'local-exec',
    command: rawOptions.command,
    commandArgs: Array.isArray(rawOptions.commandArgs)
      ? rawOptions.commandArgs
      : splitCsv(rawOptions.commandArgs),
    laneId: rawOptions.laneId || '',
    scopeType: scope.scopeType,
    scopeMode: scope.scopeMode,
    scopePaths: scope.scopePaths,
    resourceMode: resources.resourceMode,
    resources: resources.resources,
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
  };
}

async function spawnLocalExecCommand(options, prompt, cwd) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(options.command, options.commandArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      shell: false,
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
        resolvePromise({ code: 1, stdout, stderr: `${stderr}\nlocal-exec command exited on signal ${signal}`.trim() });
        return;
      }
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

const selfPath = fileURLToPath(import.meta.url);

const LOCAL_EXEC_LANE_ADAPTER = {
  adapterId: 'local-exec',
  buildHelperArgs(options, helperAuthFd) {
    const args = [
      selfPath,
      '--launch-daemon-helper',
      '--lane-dir', options.laneDir,
      '--guardrail-repo', options.guardrailRepo,
      '--working-dir', options.workingDir,
      '--command', options.command,
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
      '--identity-nonce', options.identityNonce,
      '--boot-nonce', options.bootNonce,
    ];
    for (const arg of options.commandArgs || []) {
      args.push('--arg', arg);
    }
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
      '--command', options.command,
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
      '--identity-nonce', options.identityNonce || '',
      '--boot-nonce', options.bootNonce || '',
    ];
    for (const arg of options.commandArgs || []) {
      args.push('--arg', arg);
    }
    if (daemonAuthFd !== null) {
      args.push('--auth-fd', String(daemonAuthFd));
    }
    return args;
  },
  async runRequest(options, request, state, deps = {}) {
    const runner = deps.runner || spawnLocalExecCommand;
    const lifecycle = state.startedConversation ? 'continue' : 'start';
    const startedAt = new Date().toISOString();
    const result = await runner(options, request.prompt, options.workingDir);
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
  return runResidentLaneRequest(LOCAL_EXEC_LANE_ADAPTER, options, request, state, deps);
}

export async function launchResidentLane(rawOptions, deps = {}) {
  const options = normalizeResidentLaneOptions(rawOptions);
  return launchResidentLaneWithAdapter(options, LOCAL_EXEC_LANE_ADAPTER, deps);
}

export function launchResidentLaneDaemonHelper(rawOptions) {
  const options = normalizeResidentLaneOptions(rawOptions);
  return launchResidentLaneDaemonHelperWithAdapter(options, LOCAL_EXEC_LANE_ADAPTER);
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
      await runResidentLaneDaemonWithAdapter(options, LOCAL_EXEC_LANE_ADAPTER);
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
