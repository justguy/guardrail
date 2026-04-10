import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  createLaneBootError,
  getResidentLaneResult,
  getResidentLaneStatus,
  lanePaths,
  laneResultPath,
  launchResidentLaneDaemonHelper as launchResidentLaneDaemonHelperWithAdapter,
  launchResidentLaneWithAdapter,
  listResidentLanes,
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
  waitForResidentLaneBootstrap,
} from './resident-lane-core.js';

const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export function parseResidentLaneArgs(argv) {
  const options = {
    laneDir: '',
    guardrailRepo: '',
    workingDir: '',
    tool: '',
    model: '',
    effort: '',
    permissionMode: '',
    outputFormat: '',
    maxBudgetUsd: '',
    allowedTools: '',
    systemPrompt: '',
    addDirs: '',
    inputFiles: '',
    profile: '',
    sandbox: '',
    imageFiles: '',
    color: '',
    oss: '',
    localProvider: '',
    skipGitRepoCheck: '',
    ephemeral: '',
    fullAuto: '',
    laneId: '',
    keyPath: '',
    identityNonce: '',
    bootNonce: '',
    sessionName: '',
    sessionId: '',
    noSessionPersistence: '',
    scopeType: '',
    scopeMode: '',
    scopePaths: '',
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
      case '--tool':
        options.tool = value;
        i += 1;
        break;
      case '--model':
        options.model = value;
        i += 1;
        break;
      case '--effort':
        options.effort = value;
        i += 1;
        break;
      case '--permission-mode':
        options.permissionMode = value;
        i += 1;
        break;
      case '--output-format':
        options.outputFormat = value;
        i += 1;
        break;
      case '--max-budget-usd':
        options.maxBudgetUsd = value;
        i += 1;
        break;
      case '--allowed-tools':
        options.allowedTools = value;
        i += 1;
        break;
      case '--system-prompt':
        options.systemPrompt = value;
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
      case '--profile':
        options.profile = value;
        i += 1;
        break;
      case '--sandbox':
        options.sandbox = value;
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
      case '--no-session-persistence':
        options.noSessionPersistence = value;
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

  return {
    adapterId: rawOptions.tool || 'claude',
    laneDir,
    guardrailRepo,
    workingDir,
    tool: rawOptions.tool || 'claude',
    model: rawOptions.model || 'sonnet',
    effort: rawOptions.effort || 'low',
    permissionMode: rawOptions.permissionMode || 'default',
    outputFormat: rawOptions.outputFormat || 'text',
    maxBudgetUsd: rawOptions.maxBudgetUsd || '1.00',
    allowedTools: rawOptions.allowedTools || '',
    systemPrompt: rawOptions.systemPrompt || '',
    addDirs: splitCsv(rawOptions.addDirs).map((dir) => resolve(workingDir, dir)),
    inputFiles: splitCsv(rawOptions.inputFiles),
    profile: rawOptions.profile || '',
    sandbox: rawOptions.sandbox || '',
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
    keyPath: rawOptions.keyPath ? resolve(baseCwd, rawOptions.keyPath) : '',
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
  };
}

function buildWrapperArgs(options, request, lifecycle) {
  const wrapperName = options.tool === 'codex' ? 'src/codex-exec-wrapper.js' : 'src/claude-exec-wrapper.js';
  const wrapperPath = resolve(options.guardrailRepo, wrapperName);
  const args = [wrapperPath, '--prompt', request.prompt];
  if (options.inputFiles.length > 0) args.push('--input-files', options.inputFiles.join(','));
  if (options.model) args.push('--model', options.model);
  args.push('--working-dir', options.workingDir);
  if (options.addDirs.length > 0) args.push('--add-dirs', options.addDirs.join(','));
  if (options.tool === 'codex') {
    if (options.profile) args.push('--profile', options.profile);
    if (options.sandbox) args.push('--sandbox', options.sandbox);
    if (options.imageFiles.length > 0) args.push('--image-files', options.imageFiles.join(','));
    if (options.color) args.push('--color', options.color);
    if (options.oss) args.push('--oss', 'true');
    if (options.localProvider) args.push('--local-provider', options.localProvider);
    if (options.skipGitRepoCheck) args.push('--skip-git-repo-check', 'true');
    if (options.ephemeral) args.push('--ephemeral', 'true');
    if (options.fullAuto) args.push('--full-auto', 'true');
  } else {
    if (options.effort) args.push('--effort', options.effort);
    if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
    if (options.outputFormat) args.push('--output-format', options.outputFormat);
    if (options.maxBudgetUsd) args.push('--max-budget-usd', options.maxBudgetUsd);
    if (options.allowedTools) args.push('--allowed-tools', options.allowedTools);
    if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
  }
  args.push('--session-name', options.sessionName);
  if (options.noSessionPersistence && options.tool !== 'codex') args.push('--no-session-persistence', 'true');
  args.push('--lifecycle', lifecycle);
  if (options.sessionId) args.push('--session-id', options.sessionId);
  return args;
}

async function spawnClaudeWrapper(args, cwd) {
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
        resolvePromise({ code: 1, stdout, stderr: `${stderr}\nclaude wrapper exited on signal ${signal}`.trim() });
        return;
      }
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

const selfPath = fileURLToPath(import.meta.url);

const CLAUDE_LANE_ADAPTER = {
  adapterId: 'claude',
  buildHelperArgs(options, helperAuthFd) {
    const args = [
      selfPath,
      '--launch-daemon-helper',
      '--lane-dir', options.laneDir,
      '--guardrail-repo', options.guardrailRepo,
      '--working-dir', options.workingDir,
      '--tool', options.tool || 'claude',
      '--lane-id', options.laneId || '',
      '--scope-type', options.scopeType || 'none',
      '--scope-mode', options.scopeMode || 'warn',
      '--scope-paths', (options.scopePaths || []).join(','),
      '--key-path', options.keyPath || '',
      '--session-name', options.sessionName,
      '--session-id', options.sessionId || '',
      '--no-session-persistence', String(options.noSessionPersistence),
      '--poll-interval-ms', String(options.pollIntervalMs),
      '--idle-timeout-ms', String(options.idleTimeoutMs),
      '--model', options.model,
      '--effort', options.effort,
      '--permission-mode', options.permissionMode,
      '--output-format', options.outputFormat,
      '--max-budget-usd', options.maxBudgetUsd,
      '--allowed-tools', options.allowedTools,
      '--system-prompt', options.systemPrompt,
      '--add-dirs', options.addDirs.join(','),
      '--input-files', options.inputFiles.join(','),
      '--profile', options.profile || '',
      '--sandbox', options.sandbox || '',
      '--image-files', options.imageFiles.join(','),
      '--color', options.color || '',
      '--oss', String(options.oss),
      '--local-provider', options.localProvider || '',
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
      '--tool', options.tool || 'claude',
      '--lane-id', options.laneId || '',
      '--scope-type', options.scopeType || 'none',
      '--scope-mode', options.scopeMode || 'warn',
      '--scope-paths', (options.scopePaths || []).join(','),
      '--key-path', options.keyPath || '',
      '--session-name', options.sessionName,
      '--session-id', options.sessionId || '',
      '--no-session-persistence', String(options.noSessionPersistence),
      '--poll-interval-ms', String(options.pollIntervalMs),
      '--idle-timeout-ms', String(options.idleTimeoutMs),
      '--model', options.model,
      '--effort', options.effort,
      '--permission-mode', options.permissionMode,
      '--output-format', options.outputFormat,
      '--max-budget-usd', options.maxBudgetUsd,
      '--allowed-tools', options.allowedTools,
      '--system-prompt', options.systemPrompt,
      '--add-dirs', options.addDirs.join(','),
      '--input-files', options.inputFiles.join(','),
      '--profile', options.profile || '',
      '--sandbox', options.sandbox || '',
      '--image-files', options.imageFiles.join(','),
      '--color', options.color || '',
      '--oss', String(options.oss),
      '--local-provider', options.localProvider || '',
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
    const runner = deps.runner || spawnClaudeWrapper;
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
  return runResidentLaneRequest(CLAUDE_LANE_ADAPTER, options, request, state, deps);
}

export async function launchResidentLane(rawOptions, deps = {}) {
  const options = normalizeResidentLaneOptions(rawOptions);
  return launchResidentLaneWithAdapter(options, CLAUDE_LANE_ADAPTER, deps);
}

export function launchResidentLaneDaemonHelper(rawOptions) {
  const options = normalizeResidentLaneOptions(rawOptions);
  return launchResidentLaneDaemonHelperWithAdapter(options, CLAUDE_LANE_ADAPTER);
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
      await runResidentLaneDaemonWithAdapter(options, CLAUDE_LANE_ADAPTER);
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
};
