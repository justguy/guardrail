import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { evaluateAuthCheckResult, resolveAuthCheckDefinition } from './adapter-auth.js';

const EXIT_SENTINEL_PREFIX = '[guardrail-exec-exit:';

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function shellQuote(value) {
  const text = String(value ?? '');
  if (text === '') return "''";
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseWrapperArgs(argv) {
  const options = {
    socketPath: '',
    workspaceName: '',
    launchCwd: '',
    execContractB64: '',
    captureLines: '',
    captureDelayMs: '',
    pollIntervalMs: '',
    waitTimeoutMs: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    switch (flag) {
      case '--socket-path':
        options.socketPath = value;
        i += 1;
        break;
      case '--workspace-name':
        options.workspaceName = value;
        i += 1;
        break;
      case '--launch-cwd':
        options.launchCwd = value;
        i += 1;
        break;
      case '--exec-contract-b64':
        options.execContractB64 = value;
        i += 1;
        break;
      case '--capture-lines':
        options.captureLines = value;
        i += 1;
        break;
      case '--capture-delay-ms':
        options.captureDelayMs = value;
        i += 1;
        break;
      case '--poll-interval-ms':
        options.pollIntervalMs = value;
        i += 1;
        break;
      case '--wait-timeout-ms':
        options.waitTimeoutMs = value;
        i += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

function normalizeInteger(value, fallback, label, min, max) {
  if (value === '' || value === null || value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

export function decodeExecContract(encoded) {
  if (!encoded) {
    throw new Error('Provide --exec-contract-b64.');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'));
  } catch (err) {
    throw new Error(`Invalid exec contract payload: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Exec contract payload must decode to an object.');
  }
  if (typeof parsed.command !== 'string' || parsed.command.trim() === '') {
    throw new Error('Exec contract requires a non-empty command.');
  }
  if (!Array.isArray(parsed.args) || parsed.args.some((arg) => typeof arg !== 'string')) {
    throw new Error('Exec contract args must be an array of strings.');
  }
  if (typeof parsed.cwd !== 'string' || parsed.cwd.trim() === '') {
    throw new Error('Exec contract requires a cwd.');
  }
  if (parsed.authPreflight !== undefined) {
    const requirements = parsed.authPreflight?.requirements;
    if (!Array.isArray(requirements) || requirements.some((entry) => !entry || typeof entry !== 'object')) {
      throw new Error('Exec contract authPreflight.requirements must be an array of objects when present.');
    }
  }

  return parsed;
}

function normalizeOptions(rawOptions) {
  if (!rawOptions.socketPath) {
    throw new Error('Provide --socket-path.');
  }
  if (!rawOptions.workspaceName) {
    throw new Error('Provide --workspace-name.');
  }

  return {
    socketPath: rawOptions.socketPath,
    workspaceName: rawOptions.workspaceName,
    launchCwd: rawOptions.launchCwd ? resolve(process.cwd(), rawOptions.launchCwd) : process.cwd(),
    execContract: decodeExecContract(rawOptions.execContractB64),
    captureLines: normalizeInteger(rawOptions.captureLines, 200, 'capture_lines', 20, 500),
    captureDelayMs: normalizeInteger(rawOptions.captureDelayMs, 200, 'capture_delay_ms', 0, 10000),
    pollIntervalMs: normalizeInteger(rawOptions.pollIntervalMs, 400, 'poll_interval_ms', 50, 5000),
    waitTimeoutMs: normalizeInteger(rawOptions.waitTimeoutMs, 20000, 'wait_timeout_ms', 500, 120000),
  };
}

function buildEnvPrefix(envPolicy = {}) {
  const allow = Array.isArray(envPolicy.allow) ? envPolicy.allow : [];
  const inject = envPolicy.inject && typeof envPolicy.inject === 'object' ? envPolicy.inject : {};

  if (allow.length === 0 && Object.keys(inject).length === 0) {
    return '';
  }

  const parts = ['env', '-i'];
  for (const name of allow) {
    parts.push(`${name}="$${name}"`);
  }
  for (const [name, value] of Object.entries(inject)) {
    parts.push(`${name}=${shellQuote(value)}`);
  }
  return `${parts.join(' ')} `;
}

export function renderExecCommand(contract = {}) {
  const envPrefix = buildEnvPrefix(contract.envPolicy);
  const renderedArgs = Array.isArray(contract.args) ? contract.args.map(shellQuote).join(' ') : '';
  const renderedCommand = `${envPrefix}${shellQuote(contract.command)}${renderedArgs ? ` ${renderedArgs}` : ''}`;
  return `cd ${shellQuote(contract.cwd)} && ${renderedCommand}`;
}

function buildWrappedRenderedCommand(rendered, token = null) {
  const sentinel = token
    ? `${EXIT_SENTINEL_PREFIX}${token}:%s]`
    : `${EXIT_SENTINEL_PREFIX}%s]`;
  return `${rendered}; __guardrail_status=$?; printf '\\n${sentinel}\\n' "$__guardrail_status"`;
}

export function buildWrappedSurfaceCommand(contract = {}, token = null) {
  const rendered = renderExecCommand(contract);
  return buildWrappedRenderedCommand(rendered, token);
}

export function parseWorkspaceRef(text = '') {
  const match = String(text).match(/workspace:\d+/);
  if (!match) {
    throw new Error(`Could not parse workspace ref from cmux output: ${String(text).trim()}`);
  }
  return match[0];
}

export function parseSurfaceRef(text = '') {
  const match = String(text).match(/surface:\d+/);
  if (!match) {
    throw new Error(`Could not parse surface ref from cmux output: ${String(text).trim()}`);
  }
  return match[0];
}

export function extractExecExitCode(text = '', token = null) {
  const pattern = token
    ? new RegExp(`\\[guardrail-exec-exit:${escapeRegex(token)}:(\\d+)\\]`)
    : /\[guardrail-exec-exit:(\d+)\]/;
  const match = String(text).match(pattern);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function stripExitSentinels(text = '') {
  return String(text)
    .replace(/\n?\[guardrail-exec-exit:[^\]]+\]\n?/g, '\n')
    .trim();
}

async function runCmuxCommand(args, options = {}) {
  const {
    socketPath,
    captureOutput = true,
  } = options;

  return await new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('cmux', args, {
      stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', captureOutput ? 'pipe' : 'pipe'],
      env: {
        ...process.env,
        CMUX_SOCKET_PATH: socketPath,
      },
    });

    if (captureOutput) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      rejectPromise(err);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`cmux exited on signal ${signal}`));
        return;
      }
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || `cmux ${args[0]} failed with exit code ${code}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function capturePane(runner, socketPath, workspace, surface, captureLines) {
  const captureResult = await runner(
    ['capture-pane', '--workspace', workspace, '--surface', surface, '--scrollback', '--lines', String(captureLines)],
    { socketPath },
  );
  return (captureResult.stdout || captureResult.stderr || '').trim();
}

async function runHostedSurfaceCommand(runner, wait, options, workspace, surface, commandText, token) {
  await runner(
    ['send', '--workspace', workspace, '--surface', surface, `${commandText}\n`],
    { socketPath: options.socketPath, captureOutput: false },
  );

  if (options.captureDelayMs > 0) {
    await wait(options.captureDelayMs);
  }

  const startedAt = Date.now();
  let capture = '';
  let execExitCode = null;

  while (Date.now() - startedAt <= options.waitTimeoutMs) {
    capture = await capturePane(
      runner,
      options.socketPath,
      workspace,
      surface,
      options.captureLines,
    );
    execExitCode = extractExecExitCode(capture, token);
    if (execExitCode !== null) break;
    await wait(options.pollIntervalMs);
  }

  if (execExitCode === null) {
    throw new Error(`Timed out waiting for hosted exec completion after ${options.waitTimeoutMs}ms.`);
  }

  return { capture, execExitCode };
}

function buildHostedAuthCommand(contract = {}, requirement) {
  const definition = resolveAuthCheckDefinition(requirement);
  if (!definition) {
    throw new Error(`Unsupported auth prerequisite type for hosted exec: ${requirement?.type ?? '<unknown>'}`);
  }

  const envPrefix = buildEnvPrefix(contract.envPolicy);
  const renderedArgs = Array.isArray(definition.args) ? definition.args.map(shellQuote).join(' ') : '';
  const rendered = `cd ${shellQuote(contract.cwd)} && ${envPrefix}${shellQuote(definition.command)}${renderedArgs ? ` ${renderedArgs}` : ''}`;
  return {
    commandText: rendered,
    failureMessage: definition.message,
  };
}

export async function runCmuxClaudeRecipe(rawOptions, deps = {}) {
  const options = normalizeOptions(rawOptions);
  const runner = deps.runner || runCmuxCommand;
  const wait = deps.wait || sleep;
  const emitStdout = deps.emitStdout !== false;

  const workspaceResult = await runner(
    ['new-workspace', '--name', options.workspaceName, '--cwd', options.launchCwd],
    { socketPath: options.socketPath },
  );
  const workspace = parseWorkspaceRef(workspaceResult.stdout || workspaceResult.stderr);

  const panelsResult = await runner(
    ['list-panels', '--workspace', workspace],
    { socketPath: options.socketPath },
  );
  const surface = parseSurfaceRef(panelsResult.stdout || panelsResult.stderr);

  const requirements = options.execContract.authPreflight?.requirements || [];
  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const token = `auth-${index}`;
    const { commandText, failureMessage } = buildHostedAuthCommand(options.execContract, requirement);
    const authResult = await runHostedSurfaceCommand(
      runner,
      wait,
      options,
      workspace,
      surface,
      buildWrappedRenderedCommand(commandText, token),
      token,
    );
    const detail = stripExitSentinels(authResult.capture);
    const evaluated = evaluateAuthCheckResult(requirement, {
      success: authResult.execExitCode === 0,
      stdout: detail,
      stderr: '',
    });
    if (!evaluated.ok) {
      throw new Error(`missing_auth_prerequisite: ${failureMessage}${detail ? ` Detail: ${detail}` : ''}`);
    }
  }

  const execCommand = buildWrappedSurfaceCommand(options.execContract, 'main');
  const execResult = await runHostedSurfaceCommand(
    runner,
    wait,
    options,
    workspace,
    surface,
    execCommand,
    'main',
  );
  const capture = execResult.capture;
  const execExitCode = execResult.execExitCode;

  if (execExitCode !== 0) {
    throw new Error(`Hosted exec failed with exit code ${execExitCode}.`);
  }

  const result = {
    workspace,
    surface,
    launchCwd: options.launchCwd,
    execCommand,
    execExitCode,
    capture,
  };

  if (emitStdout) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

async function main() {
  await runCmuxClaudeRecipe(parseWrapperArgs(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
