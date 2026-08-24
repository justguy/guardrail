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
import { parseResidentLaneArgs as parseBaseArgs } from './claude-resident-lane.js';

const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export const residentLaneAdapterMetadata = {
  id: 'prompt-wrapper',
  name: 'Prompt Wrapper',
  description: 'Resident lane adapter for local wrapper commands that honor the Guardrail prompt-wrapper flag contract.',
  source: 'bundled',
  capabilities: ['resident_session', 'interactive_prompt', 'stored_results', 'bounded_logs', 'plugin_adapter'],
};

export function parseResidentLaneArgs(argv) {
  return parseBaseArgs(argv);
}

export function normalizeResidentLaneOptions(rawOptions, baseCwd = process.cwd()) {
  if (!rawOptions.laneDir) throw new Error('Provide --lane-dir.');
  if (!rawOptions.sessionName) throw new Error('Provide --session-name.');
  if (!rawOptions.wrapperCommand) throw new Error('Provide --wrapper-command for --tool prompt-wrapper.');

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
    adapterId: 'prompt-wrapper',
    laneDir,
    guardrailRepo,
    workingDir,
    wrapperCommand: resolve(baseCwd, rawOptions.wrapperCommand),
    wrapperArgs: Array.isArray(rawOptions.wrapperArgs)
      ? rawOptions.wrapperArgs.flatMap((entry) => splitCsv(entry))
      : splitCsv(rawOptions.wrapperArgs || ''),
    addDirs: splitCsv(rawOptions.addDirs).map((dir) => resolve(workingDir, dir)),
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
      mode: 'prompt-wrapper',
      wrapperCommand: resolve(baseCwd, rawOptions.wrapperCommand),
      wrapperArgs: Array.isArray(rawOptions.wrapperArgs)
        ? rawOptions.wrapperArgs.flatMap((entry) => splitCsv(entry))
        : splitCsv(rawOptions.wrapperArgs || ''),
      inputFiles: splitCsv(rawOptions.inputFiles),
      addDirs: splitCsv(rawOptions.addDirs).map((dir) => resolve(workingDir, dir)),
    },
    tool: 'prompt-wrapper',
  };
}

function buildWrapperArgs(options, request, lifecycle) {
  const args = [
    ...options.wrapperArgs,
    '--prompt', request.prompt,
    '--working-dir', options.workingDir,
    '--session-name', options.sessionName,
    '--lifecycle', lifecycle,
  ];
  if (options.sessionId) args.push('--session-id', options.sessionId);
  if (options.inputFiles.length > 0) args.push('--input-files', options.inputFiles.join(','));
  if (options.addDirs.length > 0) args.push('--add-dirs', options.addDirs.join(','));
  if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
  return args;
}

async function spawnWrapperCommand(command, args, cwd) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
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
        resolvePromise({ code: 1, stdout, stderr: `${stderr}\nprompt wrapper exited on signal ${signal}`.trim() });
        return;
      }
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

const selfPath = fileURLToPath(import.meta.url);

const PROMPT_WRAPPER_ADAPTER = {
  adapterId: 'prompt-wrapper',
  buildHelperArgs(options, helperAuthFd) {
    const args = [
      selfPath,
      '--launch-daemon-helper',
      '--lane-dir', options.laneDir,
      '--guardrail-repo', options.guardrailRepo,
      '--working-dir', options.workingDir,
      '--tool', 'prompt-wrapper',
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
      '--tool', 'prompt-wrapper',
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
    const runner = deps.runner || spawnWrapperCommand;
    const lifecycle = state.startedConversation ? 'continue' : 'start';
    const startedAt = new Date().toISOString();
    const result = await runner(options.wrapperCommand, buildWrapperArgs(options, request, lifecycle), options.guardrailRepo);
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
  return runResidentLaneRequest(PROMPT_WRAPPER_ADAPTER, options, request, state, deps);
}

export async function launchResidentLane(rawOptions, deps = {}) {
  const options = normalizeResidentLaneOptions(rawOptions);
  return launchResidentLaneWithAdapter(options, PROMPT_WRAPPER_ADAPTER, deps);
}

export function launchResidentLaneDaemonHelper(rawOptions) {
  const options = normalizeResidentLaneOptions(rawOptions);
  return launchResidentLaneDaemonHelperWithAdapter(options, PROMPT_WRAPPER_ADAPTER);
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
      await runResidentLaneDaemonWithAdapter(options, PROMPT_WRAPPER_ADAPTER);
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
  waitForResidentLaneBootstrap,
  waitForResidentLaneResult,
};
