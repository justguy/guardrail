import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, lstatSync, mkdirSync, readlinkSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseAiProgressLine } from './progress-events.js';
import {
  buildAIToolArgs,
  toolSupportsNoSessionPersistence,
} from './model-gateway.js';

import {
  createLaneBootError,
  getResidentLaneLogs,
  getResidentLaneResult,
  getResidentLaneStatus,
  getResidentLaneTimeline,
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
const DEFAULT_HEALTH_TIMEOUT_MS = 5 * 60 * 1000;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CLAUDE_WRAPPER_PATH = resolve(MODULE_DIR, 'claude-exec-wrapper.js');

export const residentLaneAdapterMetadata = {
  id: 'claude',
  name: 'Claude',
  description: 'Resident lane adapter for Claude CLI execution.',
  source: 'bundled',
  capabilities: ['resident_session', 'interactive_prompt', 'stored_results', 'bounded_logs', 'resource_claims'],
};

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
    hostStateDir: '',
    identityNonce: '',
    bootNonce: '',
    sessionName: '',
    sessionId: '',
    noSessionPersistence: '',
    scopeType: '',
    scopeMode: '',
    scopePaths: '',
    resourceMode: '',
    resources: '',
    authFd: '',
    pollIntervalMs: '',
    idleTimeoutMs: '',
    healthTimeoutMs: '',
    wrapperCommand: '',
    wrapperArgs: '',
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
      case '--wrapper-command':
        options.wrapperCommand = value;
        i += 1;
        break;
      case '--wrapper-arg':
      case '--wrapper-args':
        options.wrapperArgs = options.wrapperArgs ? `${options.wrapperArgs},${value}` : value;
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
      case '--health-timeout-ms':
        options.healthTimeoutMs = value;
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
    adapterId: rawOptions.tool || 'claude',
    laneDir,
    guardrailRepo,
    workingDir,
    tool: rawOptions.tool || 'claude',
    model: rawOptions.model || 'sonnet',
    effort: rawOptions.effort || 'low',
    permissionMode: rawOptions.permissionMode || 'default',
    outputFormat: rawOptions.outputFormat || 'text',
    maxBudgetUsd: rawOptions.maxBudgetUsd || '10.00',
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
    resourceMode: resources.resourceMode,
    resources: resources.resources,
    resourceDetails: resources.resourceDetails,
    keyPath,
    hostStateDir,
    identityNonce: rawOptions.identityNonce || '',
    bootNonce: rawOptions.bootNonce || '',
    sessionName: rawOptions.sessionName,
    sessionId: rawOptions.sessionId || '',
    noSessionPersistence: (rawOptions.noSessionPersistence != null && rawOptions.noSessionPersistence !== '') ? shellTruthy(rawOptions.noSessionPersistence) : true,
    transportSummary: {
      mode: 'claude-cli',
      model: rawOptions.model || '',
      permissionMode: rawOptions.permissionMode || '',
      outputFormat: rawOptions.outputFormat || '',
      maxBudgetUsd: rawOptions.maxBudgetUsd || '10.00',
    },
    authFd: parseInteger(rawOptions.authFd, null, 'auth_fd', 3),
    pollIntervalMs: parseInteger(rawOptions.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'poll_interval_ms', 50),
    idleTimeoutMs: parseInteger(rawOptions.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'idle_timeout_ms', 1000),
    healthTimeoutMs: parseInteger(rawOptions.healthTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS, 'health_timeout_ms', 1000),
    launchDaemonHelper: rawOptions.launchDaemonHelper === true,
    daemon: rawOptions.daemon === true,
  };
}

function buildWrapperArgs(options, request, lifecycle) {
  const args = [CLAUDE_WRAPPER_PATH, '--prompt', request.prompt];
  if (options.inputFiles.length > 0) args.push('--input-files', options.inputFiles.join(','));
  if (options.model) args.push('--model', options.model);
  args.push('--working-dir', options.workingDir);
  if (options.addDirs.length > 0) args.push('--add-dirs', options.addDirs.join(','));

  // Tool-specific flags (provider routing via model-gateway seam)
  const toolArgs = buildAIToolArgs(options.tool, options, {
    progressLaneDir: options.laneDir,
    requestId: request.id,
  });
  args.push(...toolArgs);

  args.push('--session-name', options.sessionName);
  if (options.noSessionPersistence && toolSupportsNoSessionPersistence(options.tool)) {
    args.push('--no-session-persistence', 'true');
  }
  args.push('--lifecycle', lifecycle);
  if (options.sessionId) args.push('--session-id', options.sessionId);
  return args;
}

function runtimeHomeDir(options) {
  const slot = options.laneId || options.sessionName || 'default';
  return resolve(options.guardrailRepo, '.guardrail', 'claude-runtime', slot);
}

function defaultClaudeConfigDir(env = process.env) {
  const home = env.HOME || homedir();
  return resolve(home, '.claude');
}

function encodeClaudeProjectSlug(workingDir) {
  return resolve(workingDir).replace(/[\\/]/g, '-');
}

function runtimeProjectRoot(options) {
  return resolve(options.guardrailRepo, '.guardrail', 'claude-runtime', 'projects');
}

function runtimeProjectDir(options) {
  return resolve(runtimeProjectRoot(options), encodeClaudeProjectSlug(options.workingDir));
}

function hostClaudeProjectDir(options) {
  const home = process.env.HOME || homedir();
  return resolve(home, 'projects', encodeClaudeProjectSlug(options.workingDir));
}

function isLegacyRepoLocalClaudeProjectTarget(target, options) {
  const slug = encodeClaudeProjectSlug(options.workingDir);
  const legacyBase = resolve(options.guardrailRepo, '.guardrail', 'claude-runtime');
  return target !== runtimeProjectDir(options)
    && target.startsWith(`${legacyBase}/`)
    && target.endsWith(`/projects/${slug}`);
}

function ensureClaudeProjectBridge(options) {
  const localProjectDir = runtimeProjectDir(options);
  const hostProjectDir = hostClaudeProjectDir(options);
  mkdirSync(localProjectDir, { recursive: true });
  mkdirSync(dirname(hostProjectDir), { recursive: true });

  if (!existsSync(hostProjectDir)) {
    try {
      const stat = lstatSync(hostProjectDir);
      if (stat.isSymbolicLink()) {
        const target = resolve(dirname(hostProjectDir), readlinkSync(hostProjectDir));
        if (target === localProjectDir || isLegacyRepoLocalClaudeProjectTarget(target, options)) {
          mkdirSync(target, { recursive: true });
          return;
        }
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    symlinkSync(localProjectDir, hostProjectDir, 'dir');
    return;
  }

  const stat = lstatSync(hostProjectDir);
  if (stat.isSymbolicLink()) {
    const target = resolve(dirname(hostProjectDir), readlinkSync(hostProjectDir));
    if (target !== localProjectDir) {
      if (isLegacyRepoLocalClaudeProjectTarget(target, options)) {
        // Backward compatibility: older D0z builds stored this repo-local
        // project state under a lane-scoped target. Reuse it instead of
        // rewriting a host-global symlink outside the repo boundary.
        return;
      }
      throw new Error(
        `Claude project bridge conflict: ${hostProjectDir} already points to ${target}, expected ${localProjectDir}`,
      );
    }
    return;
  }

  if (stat.isDirectory()) {
    if (readdirSync(hostProjectDir).length === 0) {
      rmSync(hostProjectDir, { recursive: true, force: false });
      symlinkSync(localProjectDir, hostProjectDir, 'dir');
      return;
    }
    throw new Error(`Claude project bridge conflict: ${hostProjectDir} exists as a non-empty directory`);
  }

  throw new Error(`Claude project bridge conflict: ${hostProjectDir} exists and is not a directory symlink`);
}

/**
 * Build the environment for a Claude subprocess.
 *
 * D0z: Inject CLAUDE_CONFIG_DIR pointing to a repo-local runtime directory when
 * auth comes from env vars. Claude also attempts to create a separate host-global
 * per-project directory under ~/projects/<encoded-cwd>, so Guardrail bridges that
 * path back into the same repo-local runtime dir before spawn.
 *
 * This is only safe when the auth credential does NOT depend on the
 * CLAUDE_CONFIG_DIR value being exactly ~/.claude:
 *   - ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN — credentials come from the
 *     environment; the keychain is not consulted.
 *   - Operator-set CLAUDE_CONFIG_DIR — already points where the operator wants
 *     it; pass through unchanged.
 *
 * For macOS keychain auth (no API key, no operator override): the Claude
 * binary derives the keychain service name from a hash of CLAUDE_CONFIG_DIR.
 * Changing the value breaks the service name lookup and loses credentials.
 * Guardrail falls back to process.env in that case so keychain lookup stays intact.
 * The per-project write surface is still redirected through the project bridge.
 */
function buildClaudeRuntimeEnv(options) {
  if (process.env.CLAUDE_CONFIG_DIR) {
    // Operator already configured a state directory; respect it unconditionally.
    return process.env;
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    // Token auth: preserve the operator/runtime config path exactly. Redirecting
    // CLAUDE_CONFIG_DIR can make Claude fall back to a different keychain hash.
    return process.env;
  }
  // Keychain auth: cannot change CLAUDE_CONFIG_DIR without breaking the keychain
  // service name hash. Pass env through; --no-session-persistence limits writes.
  return process.env;
}

export function classifyClaudeAuthSource(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) {
    return {
      source: 'operator_config_dir',
      claudeConfigDir: env.CLAUDE_CONFIG_DIR,
    };
  }
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      source: 'env_token',
      claudeConfigDir: defaultClaudeConfigDir(env),
    };
  }
  return {
    source: 'keychain',
    claudeConfigDir: defaultClaudeConfigDir(env),
  };
}

function isClaudeLoginFailure(stderr = '') {
  const text = String(stderr || '');
  return /Not logged in/i.test(text) || /Please run \/login/i.test(text);
}

function buildClaudePreflightArgs(options) {
  const args = [
    CLAUDE_WRAPPER_PATH,
    '--prompt', 'Reply with OK.',
    '--working-dir', options.workingDir,
  ];
  args.push(...buildAIToolArgs(options.tool, options, {}));
  args.push('--session-name', options.sessionName);
  if (options.noSessionPersistence && toolSupportsNoSessionPersistence(options.tool)) {
    args.push('--no-session-persistence', 'true');
  }
  args.push('--lifecycle', 'start');
  if (options.sessionId) args.push('--session-id', options.sessionId);
  return args;
}

export async function preflightClaudeLaneAuth(options, deps = {}) {
  const env = buildClaudeRuntimeEnv(options);
  const auth = classifyClaudeAuthSource(env);
  const checkedAt = new Date().toISOString();
  const runner = deps.preflightRunner || deps.runner || spawnClaudeWrapper;
  const result = await runner(
    buildClaudePreflightArgs(options),
    options.guardrailRepo,
    env,
    {},
  );
  if (result.code === 0) {
    return {
      ok: true,
      source: auth.source,
      checkedAt,
      reason: null,
      message: null,
    };
  }
  if (isClaudeLoginFailure(result.stderr)) {
    return {
      ok: false,
      source: auth.source,
      checkedAt,
      reason: 'auth_preflight_failed',
      message: `Claude auth preflight failed for resident lane (${auth.source}): ${String(result.stderr).trim()}`,
      stderr: result.stderr,
      exitCode: result.code,
    };
  }
  return {
    ok: false,
    source: auth.source,
    checkedAt,
    reason: 'auth_probe_failed',
    message: `Claude auth preflight probe failed before packet execution: ${String(result.stderr || `exit code ${result.code}`).trim()}`,
    stderr: result.stderr,
    exitCode: result.code,
  };
}

async function spawnClaudeWrapper(args, cwd, env = process.env, hooks = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    let stderrLineBuffer = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrLineBuffer += text;
      while (stderrLineBuffer.includes('\n')) {
        const newlineIndex = stderrLineBuffer.indexOf('\n');
        const line = stderrLineBuffer.slice(0, newlineIndex).trimEnd();
        stderrLineBuffer = stderrLineBuffer.slice(newlineIndex + 1);
        if (line) {
          hooks.onStderrLine?.(line);
          const event = parseAiProgressLine(line);
          if (event) hooks.onProgress?.(event);
        }
      }
    });
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      const finalLine = stderrLineBuffer.trim();
      if (finalLine) {
        hooks.onStderrLine?.(finalLine);
        const event = parseAiProgressLine(finalLine);
        if (event) hooks.onProgress?.(event);
      }
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
  async preflightDaemon(options, deps = {}) {
    return preflightClaudeLaneAuth(options, deps);
  },
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
      '--resource-mode', options.resourceMode || 'warn',
      '--resources', (options.resources || []).join(','),
      '--key-path', options.keyPath || '',
      '--host-state-dir', options.hostStateDir || '',
      '--session-name', options.sessionName,
      '--session-id', options.sessionId || '',
      '--no-session-persistence', String(options.noSessionPersistence),
      '--poll-interval-ms', String(options.pollIntervalMs),
      '--idle-timeout-ms', String(options.idleTimeoutMs),
      '--health-timeout-ms', String(options.healthTimeoutMs),
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
      '--resource-mode', options.resourceMode || 'warn',
      '--resources', (options.resources || []).join(','),
      '--key-path', options.keyPath || '',
      '--host-state-dir', options.hostStateDir || '',
      '--session-name', options.sessionName,
      '--session-id', options.sessionId || '',
      '--no-session-persistence', String(options.noSessionPersistence),
      '--poll-interval-ms', String(options.pollIntervalMs),
      '--idle-timeout-ms', String(options.idleTimeoutMs),
      '--health-timeout-ms', String(options.healthTimeoutMs),
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
    ensureClaudeProjectBridge(options);
    const result = await runner(
      buildWrapperArgs(options, request, lifecycle),
      options.guardrailRepo,
      buildClaudeRuntimeEnv(options),
      {
        onProgress: deps.onProgress,
        onStderrLine: deps.onStderrLine,
      },
    );
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
  const adapter = typeof deps.preflightDaemon === 'function'
    ? { ...CLAUDE_LANE_ADAPTER, preflightDaemon: deps.preflightDaemon }
    : CLAUDE_LANE_ADAPTER;
  return launchResidentLaneWithAdapter(options, adapter, deps);
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
  getResidentLaneLogs,
  getResidentLaneResult,
  getResidentLaneStatus,
  getResidentLaneTimeline,
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
