import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_REQUEST_BYTES = 50_000;
const MAX_PROMPT_CHARS = 32_000;
const MAX_REQUEST_ID_CHARS = 128;
const PARTIAL_REQUEST_TIMEOUT_MS = 5_000;

function shellTruthy(value) {
  return value === true || value === 'true' || value === '1';
}

function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback, label, min) {
  if (value === '' || value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${label} must be an integer >= ${min}`);
  }
  return parsed;
}

export function parseResidentLaneArgs(argv) {
  const options = {
    laneDir: '',
    guardrailRepo: '',
    workingDir: '',
    model: '',
    effort: '',
    permissionMode: '',
    outputFormat: '',
    maxBudgetUsd: '',
    allowedTools: '',
    systemPrompt: '',
    addDirs: '',
    inputFiles: '',
    sessionName: '',
    sessionId: '',
    noSessionPersistence: '',
    pollIntervalMs: '',
    idleTimeoutMs: '',
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
      case '--poll-interval-ms':
        options.pollIntervalMs = value;
        i += 1;
        break;
      case '--idle-timeout-ms':
        options.idleTimeoutMs = value;
        i += 1;
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

  return {
    laneDir,
    guardrailRepo,
    workingDir,
    model: rawOptions.model || 'sonnet',
    effort: rawOptions.effort || 'low',
    permissionMode: rawOptions.permissionMode || 'default',
    outputFormat: rawOptions.outputFormat || 'text',
    maxBudgetUsd: rawOptions.maxBudgetUsd || '1.00',
    allowedTools: rawOptions.allowedTools || '',
    systemPrompt: rawOptions.systemPrompt || '',
    addDirs: splitCsv(rawOptions.addDirs).map((dir) => resolve(workingDir, dir)),
    inputFiles: splitCsv(rawOptions.inputFiles),
    sessionName: rawOptions.sessionName,
    sessionId: rawOptions.sessionId || '',
    noSessionPersistence: shellTruthy(rawOptions.noSessionPersistence),
    pollIntervalMs: parseInteger(rawOptions.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'poll_interval_ms', 50),
    idleTimeoutMs: parseInteger(rawOptions.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'idle_timeout_ms', 1000),
    daemon: rawOptions.daemon === true,
  };
}

export function lanePaths(laneDir) {
  return {
    requestFifo: join(laneDir, 'requests.fifo'),
    responseFifo: join(laneDir, 'responses.fifo'),
    statePath: join(laneDir, 'state.json'),
    launchPath: join(laneDir, 'launch.json'),
    logPath: join(laneDir, 'logs', 'lane.log'),
  };
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

function ensureLaneLayout(laneDir) {
  mkdirSync(laneDir, { recursive: true });
  mkdirSync(join(laneDir, 'logs'), { recursive: true });
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

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildState(options, pid, startedConversation = false, extra = {}) {
  const paths = lanePaths(options.laneDir);
  return {
    laneDir: options.laneDir,
    requestFifo: paths.requestFifo,
    responseFifo: paths.responseFifo,
    guardrailRepo: options.guardrailRepo,
    workingDir: options.workingDir,
    sessionName: options.sessionName,
    sessionId: options.sessionId || null,
    noSessionPersistence: options.noSessionPersistence,
    startedConversation,
    pid,
    status: extra.status || 'ready',
    lastRequestId: extra.lastRequestId || null,
    lastActivityAt: extra.lastActivityAt || new Date().toISOString(),
    createdAt: extra.createdAt || new Date().toISOString(),
  };
}

function buildWrapperArgs(options, request, lifecycle) {
  const wrapperPath = resolve(options.guardrailRepo, 'src/claude-exec-wrapper.js');
  const args = [wrapperPath, '--prompt', request.prompt];
  if (options.inputFiles.length > 0) args.push('--input-files', options.inputFiles.join(','));
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.outputFormat) args.push('--output-format', options.outputFormat);
  if (options.maxBudgetUsd) args.push('--max-budget-usd', options.maxBudgetUsd);
  if (options.allowedTools) args.push('--allowed-tools', options.allowedTools);
  if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
  args.push('--working-dir', options.workingDir);
  if (options.addDirs.length > 0) args.push('--add-dirs', options.addDirs.join(','));
  args.push('--session-name', options.sessionName);
  if (options.noSessionPersistence) args.push('--no-session-persistence', 'true');
  args.push('--lifecycle', lifecycle);
  if (options.sessionId) args.push('--session-id', options.sessionId);
  return args;
}

function validateLaneRequest(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_request');
  }

  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'prompt') {
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

  return parsed;
}

export async function runLaneRequest(options, request, state, deps = {}) {
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

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function updateStateFile(laneDir, state) {
  writeJson(lanePaths(laneDir).statePath, state);
}

function writeResponse(fd, payload) {
  writeSync(fd, `${JSON.stringify(payload)}\n`, undefined, 'utf8');
}

async function runResidentLaneDaemon(options) {
  ensureLaneLayout(options.laneDir);
  const paths = lanePaths(options.laneDir);

  let state = buildState(options, process.pid, false);
  updateStateFile(options.laneDir, state);

  const requestFd = openSync(paths.requestFifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
  const responseFd = openSync(paths.responseFifo, fsConstants.O_RDWR);

  let lastActivityAtMs = Date.now();
  let queue = Promise.resolve();
  let requestBuffer = '';
  let partialRequestAtMs = 0;

  const enqueueRequest = (request) => {
    queue = queue.then(async () => {
      lastActivityAtMs = Date.now();
      state = {
        ...state,
        status: 'busy',
        lastRequestId: request.id,
        lastActivityAt: new Date().toISOString(),
      };
      updateStateFile(options.laneDir, state);

      const response = await runLaneRequest(options, request, state);
      state = {
        ...state,
        startedConversation: state.startedConversation || response.ok,
        status: 'ready',
        lastRequestId: request.id,
        lastActivityAt: response.completedAt,
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
      state = {
        ...state,
        status: 'ready',
        lastRequestId: request.id,
        lastActivityAt: failure.completedAt,
      };
      updateStateFile(options.laneDir, state);
      writeResponse(responseFd, failure);
    });
  };

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
              enqueueRequest(validateLaneRequest(parsed));
            } catch (err) {
              writeResponse(responseFd, {
                requestId: typeof err?.requestId === 'string' ? err.requestId : null,
                ok: false,
                error: err.message === 'invalid_request' || err.message === 'invalid_request_id' || err.message === 'invalid_prompt'
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

      if ((Date.now() - lastActivityAtMs) > options.idleTimeoutMs) {
        state = {
          ...state,
          status: 'expired',
          lastActivityAt: new Date().toISOString(),
        };
        updateStateFile(options.laneDir, state);
        return;
      }
      await sleep(options.pollIntervalMs);
    }
  } finally {
    closeSync(requestFd);
    closeSync(responseFd);
  }
}

export async function launchResidentLane(rawOptions) {
  const options = normalizeResidentLaneOptions(rawOptions);
  ensureLaneLayout(options.laneDir);
  const paths = lanePaths(options.laneDir);

  const existing = readJson(paths.statePath, null);
  if (existing?.status && existing.status !== 'expired' && isPidAlive(existing.pid)) {
    return {
      laneDir: options.laneDir,
      requestFifo: existing.requestFifo ?? paths.requestFifo,
      responseFifo: existing.responseFifo ?? paths.responseFifo,
      pid: existing.pid,
      sessionName: existing.sessionName,
      sessionId: existing.sessionId ?? null,
      workingDir: existing.workingDir,
      statePath: paths.statePath,
      reused: true,
    };
  }

  const selfPath = fileURLToPath(import.meta.url);
  const stdoutFd = openSync(paths.logPath, 'a');
  const stderrFd = openSync(paths.logPath, 'a');
  const daemonArgs = [
    selfPath,
    '--daemon',
    '--lane-dir', options.laneDir,
    '--guardrail-repo', options.guardrailRepo,
    '--working-dir', options.workingDir,
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
  ];

  const child = spawn(process.execPath, daemonArgs, {
    cwd: options.guardrailRepo,
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    env: process.env,
  });
  child.unref();

  const launchSummary = {
    laneDir: options.laneDir,
    requestFifo: paths.requestFifo,
    responseFifo: paths.responseFifo,
    pid: child.pid,
    sessionName: options.sessionName,
    sessionId: options.sessionId || null,
    workingDir: options.workingDir,
    statePath: paths.statePath,
  };
  writeJson(paths.launchPath, launchSummary);
  return launchSummary;
}

async function main() {
  const raw = parseResidentLaneArgs(process.argv.slice(2));
  const options = normalizeResidentLaneOptions(raw);
  if (options.daemon) {
    await runResidentLaneDaemon(options);
    return;
  }

  const summary = await launchResidentLane(raw);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
