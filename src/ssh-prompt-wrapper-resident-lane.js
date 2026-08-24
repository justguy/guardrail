import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  createLaneBootError,
  getResidentLaneLogs,
  getResidentLaneResult,
  getResidentLaneStatus,
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
import { parseResidentLaneArgs as parseBaseArgs } from './claude-resident-lane.js';

const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export const residentLaneAdapterMetadata = {
  id: 'ssh-prompt-wrapper',
  name: 'SSH Prompt Wrapper',
  description: 'Resident lane adapter for remote wrapper commands executed over SSH with the Guardrail prompt-wrapper contract.',
  source: 'bundled',
  capabilities: ['resident_session', 'interactive_prompt', 'stored_results', 'bounded_logs', 'plugin_adapter', 'remote_transport'],
};

export function parseResidentLaneArgs(argv) {
  return parseBaseArgs(argv);
}

export function normalizeResidentLaneOptions(rawOptions, baseCwd = process.cwd()) {
  if (!rawOptions.laneDir) throw new Error('Provide --lane-dir.');
  if (!rawOptions.sessionName) throw new Error('Provide --session-name.');
  if (!rawOptions.wrapperCommand) throw new Error('Provide --wrapper-command for --tool ssh-prompt-wrapper.');
  if (!rawOptions.sshTarget) throw new Error('Provide --ssh-target for --tool ssh-prompt-wrapper.');

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
    adapterId: 'ssh-prompt-wrapper',
    laneDir,
    guardrailRepo,
    workingDir,
    sshTarget: rawOptions.sshTarget,
    sshArgs: Array.isArray(rawOptions.sshArgs)
      ? rawOptions.sshArgs.flatMap((entry) => splitCsv(entry))
      : splitCsv(rawOptions.sshArgs || ''),
    remoteWorkingDir: rawOptions.remoteWorkingDir || '.',
    wrapperCommand: rawOptions.wrapperCommand,
    wrapperArgs: Array.isArray(rawOptions.wrapperArgs)
      ? rawOptions.wrapperArgs.flatMap((entry) => splitCsv(entry))
      : splitCsv(rawOptions.wrapperArgs || ''),
    addDirs: splitCsv(rawOptions.addDirs),
    inputFiles: splitCsv(rawOptions.inputFiles),
    systemPrompt: rawOptions.systemPrompt || '',
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
    noSessionPersistence: shellTruthy(rawOptions.noSessionPersistence),
    authFd: parseInteger(rawOptions.authFd, null, 'auth_fd', 3),
    pollIntervalMs: parseInteger(rawOptions.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'poll_interval_ms', 50),
    idleTimeoutMs: parseInteger(rawOptions.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'idle_timeout_ms', 1000),
    launchDaemonHelper: rawOptions.launchDaemonHelper === true,
    daemon: rawOptions.daemon === true,
    transportSummary: {
      mode: 'ssh-prompt-wrapper',
      sshTarget: rawOptions.sshTarget,
      sshArgs: Array.isArray(rawOptions.sshArgs)
        ? rawOptions.sshArgs.flatMap((entry) => splitCsv(entry))
        : splitCsv(rawOptions.sshArgs || ''),
      remoteWorkingDir: rawOptions.remoteWorkingDir || '.',
      wrapperCommand: rawOptions.wrapperCommand,
      wrapperArgs: Array.isArray(rawOptions.wrapperArgs)
        ? rawOptions.wrapperArgs.flatMap((entry) => splitCsv(entry))
        : splitCsv(rawOptions.wrapperArgs || ''),
    },
    tool: 'ssh-prompt-wrapper',
  };
}

function buildRemoteWrapperCommand(options, request, lifecycle) {
  const args = [
    ...options.wrapperArgs,
    '--prompt', request.prompt,
    '--working-dir', options.remoteWorkingDir,
    '--session-name', options.sessionName,
    '--lifecycle', lifecycle,
  ];
  if (options.sessionId) args.push('--session-id', options.sessionId);
  if (options.inputFiles.length > 0) args.push('--input-files', options.inputFiles.join(','));
  if (options.addDirs.length > 0) args.push('--add-dirs', options.addDirs.join(','));
  if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
  const renderedArgs = args.map(shellQuote).join(' ');
  return `cd ${shellQuote(options.remoteWorkingDir)} && ${shellQuote(options.wrapperCommand)}${renderedArgs ? ` ${renderedArgs}` : ''}`;
}

async function spawnSshWrapper(options, request, lifecycle) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('ssh', [
      ...options.sshArgs,
      options.sshTarget,
      buildRemoteWrapperCommand(options, request, lifecycle),
    ], {
      cwd: options.guardrailRepo,
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
        resolvePromise({ code: 1, stdout, stderr: `${stderr}\nssh prompt wrapper exited on signal ${signal}`.trim() });
        return;
      }
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

const selfPath = fileURLToPath(import.meta.url);

const SSH_PROMPT_WRAPPER_ADAPTER = {
  adapterId: 'ssh-prompt-wrapper',
  buildHelperArgs(options, helperAuthFd) {
    const args = [
      selfPath,
      '--launch-daemon-helper',
      '--lane-dir', options.laneDir,
      '--guardrail-repo', options.guardrailRepo,
      '--working-dir', options.workingDir,
      '--tool', 'ssh-prompt-wrapper',
      '--ssh-target', options.sshTarget,
      '--ssh-args', options.sshArgs.join(','),
      '--remote-working-dir', options.remoteWorkingDir,
      '--wrapper-command', options.wrapperCommand,
      '--wrapper-args', options.wrapperArgs.join(','),
      '--system-prompt', options.systemPrompt || '',
      '--add-dirs', options.addDirs.join(','),
      '--input-files', options.inputFiles.join(','),
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
      '--no-session-persistence', String(options.noSessionPersistence),
      '--poll-interval-ms', String(options.pollIntervalMs),
      '--idle-timeout-ms', String(options.idleTimeoutMs),
      '--identity-nonce', options.identityNonce,
      '--boot-nonce', options.bootNonce,
    ];
    if (helperAuthFd !== null) args.push('--auth-fd', String(helperAuthFd));
    return args;
  },
  buildDaemonArgs(options, daemonAuthFd) {
    const args = [
      selfPath,
      '--daemon',
      '--lane-dir', options.laneDir,
      '--guardrail-repo', options.guardrailRepo,
      '--working-dir', options.workingDir,
      '--tool', 'ssh-prompt-wrapper',
      '--ssh-target', options.sshTarget,
      '--ssh-args', options.sshArgs.join(','),
      '--remote-working-dir', options.remoteWorkingDir,
      '--wrapper-command', options.wrapperCommand,
      '--wrapper-args', options.wrapperArgs.join(','),
      '--system-prompt', options.systemPrompt || '',
      '--add-dirs', options.addDirs.join(','),
      '--input-files', options.inputFiles.join(','),
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
      '--no-session-persistence', String(options.noSessionPersistence),
      '--poll-interval-ms', String(options.pollIntervalMs),
      '--idle-timeout-ms', String(options.idleTimeoutMs),
      '--identity-nonce', options.identityNonce || '',
      '--boot-nonce', options.bootNonce || '',
    ];
    if (daemonAuthFd !== null) args.push('--auth-fd', String(daemonAuthFd));
    return args;
  },
  async runRequest(options, request, state, deps = {}) {
    const runner = deps.runner || spawnSshWrapper;
    const lifecycle = state.startedConversation ? 'continue' : 'start';
    const startedAt = new Date().toISOString();
    const result = await runner(options, request, lifecycle);
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
  return runResidentLaneRequest(SSH_PROMPT_WRAPPER_ADAPTER, options, request, state, deps);
}

export async function launchResidentLane(rawOptions, deps = {}) {
  const options = normalizeResidentLaneOptions(rawOptions);
  return launchResidentLaneWithAdapter(options, SSH_PROMPT_WRAPPER_ADAPTER, deps);
}

export function launchResidentLaneDaemonHelper(rawOptions) {
  const options = normalizeResidentLaneOptions(rawOptions);
  return launchResidentLaneDaemonHelperWithAdapter(options, SSH_PROMPT_WRAPPER_ADAPTER);
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
      await runResidentLaneDaemonWithAdapter(options, SSH_PROMPT_WRAPPER_ADAPTER);
      return;
    }

    const summary = await launchResidentLane(raw);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (err) {
    const failure = createLaneBootError(err, {
      laneDir: options?.laneDir || raw.laneDir,
      guardrailRepo: options?.guardrailRepo || raw.guardrailRepo || process.cwd(),
    });
    persistLaneFailureState(failure.statePath, {
      laneId: options?.laneId || raw.laneId || null,
      laneDir: options?.laneDir || raw.laneDir || null,
      guardrailRepo: options?.guardrailRepo || raw.guardrailRepo || process.cwd(),
      tool: 'ssh-prompt-wrapper',
      adapterId: 'ssh-prompt-wrapper',
      sessionName: options?.sessionName || raw.sessionName || null,
      sessionId: options?.sessionId || raw.sessionId || null,
      requestFifo: null,
      responseFifo: null,
      keyPath: options?.keyPath || raw.keyPath || null,
      hostStateDir: options?.hostStateDir || raw.hostStateDir || null,
      pid: null,
      identityNonce: options?.identityNonce || raw.identityNonce || null,
      bootNonce: options?.bootNonce || raw.bootNonce || null,
      failureReason: failure.failureReason,
      failureStage: failure.failureStage,
      status: 'failed',
      logPath: failure.logPath,
    });
    process.stdout.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = failure.exitCode || 1;
  }
}

const isCliEntry = process.argv[1] && resolve(process.argv[1]) === resolve(selfPath);
if (isCliEntry) {
  main();
}

export {
  getResidentLaneLogs,
  getResidentLaneResult,
  getResidentLaneStatus,
  listResidentLanes,
  pruneResidentLanes,
  readSecretFromFd,
  signLaneRequest,
  stopResidentLane,
  trackLaneRequestId,
  validateLaneRequest,
  waitForResidentLaneBootstrap,
  waitForResidentLaneResult,
};
