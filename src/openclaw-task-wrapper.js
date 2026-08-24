import { spawnSync } from 'node:child_process';

const FLOW_CONFIG = {
  'fix-tests': {
    scope: 'write',
  },
  'debug-ci': {
    scope: 'read',
  },
  deploy: {
    scope: 'write',
    environments: ['preview', 'staging'],
  },
};

const TASK_FAILURE_LINES = 3;
const TASK_FAILURE_CHARS = 300;

export function parseOpenclawTaskWrapperArgs(argv) {
  const options = { flow: '', scope: '', noEscalate: false };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';

    switch (flag) {
      case '--flow':
        options.flow = value;
        i += 1;
        break;
      case '--scope':
        options.scope = value;
        i += 1;
        break;
      case '--environment':
        options.environment = value;
        i += 1;
        break;
      case '--service-manifest':
        options.serviceManifest = value;
        i += 1;
        break;
      case '--release-file':
        options.releaseFile = value;
        i += 1;
        break;
      case '--no-escalate':
        options.noEscalate = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return options;
}

function summarizeFailureText(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, TASK_FAILURE_LINES);

  if (lines.length === 0) return '';

  const summary = lines.join(' | ');
  if (summary.length <= TASK_FAILURE_CHARS) return summary;
  return `${summary.slice(0, TASK_FAILURE_CHARS - 1).trimEnd()}…`;
}

function formatFailure(phase, args, result) {
  const details = summarizeFailureText(result.stderr || result.stdout || '');
  if (details) {
    return `openclaw ${phase} failed with exit code ${result.status}: ${details}`;
  }
  return `openclaw ${phase} failed with exit code ${result.status}`;
}

function runOpenclaw(phase, args, options) {
  const result = spawnSync('openclaw', args, {
    stdio: 'inherit',
    encoding: 'utf8',
    ...options,
  });
  if (result.error) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  if (result.status !== 0) {
    throw new Error(formatFailure(phase, args, result));
  }
}

export function normalizeOpenclawTaskOptions(rawOptions = {}) {
  const flow = String(rawOptions.flow || '').trim();
  if (!flow) {
    throw new Error('--flow is required');
  }
  const config = FLOW_CONFIG[flow];
  if (!config) {
    throw new Error(`Unsupported OpenClaw task "${flow}".`);
  }

  const scope = rawOptions.scope ? String(rawOptions.scope).trim() : config.scope;
  if (scope !== config.scope) {
    throw new Error(`Flow "${flow}" is bounded to scope "${config.scope}".`);
  }

  const environment = rawOptions.environment ? String(rawOptions.environment).trim() : '';
  const serviceManifest = rawOptions.serviceManifest ? String(rawOptions.serviceManifest).trim() : '';
  const releaseFile = rawOptions.releaseFile ? String(rawOptions.releaseFile).trim() : '';

  if (flow === 'deploy') {
    if (!config.environments.includes(environment)) {
      throw new Error(`Flow "deploy" requires --environment ${config.environments.join('|')}.`);
    }
    if (!serviceManifest) {
      throw new Error('Flow "deploy" requires --service-manifest.');
    }
    if (!releaseFile) {
      throw new Error('Flow "deploy" requires --release-file.');
    }
  } else if (environment || serviceManifest || releaseFile) {
    throw new Error(`Flow "${flow}" does not accept deploy-only flags.`);
  }

  return {
    flow,
    scope,
    environment,
    serviceManifest,
    releaseFile,
    noEscalate: rawOptions.noEscalate === true || rawOptions.noEscalate === 'true' || rawOptions.noEscalate === '1',
  };
}

export function buildOpenclawTaskCommands(rawOptions = {}) {
  const options = normalizeOpenclawTaskOptions(rawOptions);
  const runArgs = ['run', '--flow', options.flow, '--scope', options.scope];
  const scopeCheckArgs = ['scope', 'check', '--flow', options.flow, '--scope', options.scope];
  const verifyArgs = ['verify', '--flow', options.flow, '--check-scope', options.scope, '--check-output'];
  if (options.environment) {
    runArgs.push('--environment', options.environment);
    scopeCheckArgs.push('--environment', options.environment);
    verifyArgs.push('--check-environment', options.environment);
  }
  if (options.serviceManifest) {
    runArgs.push('--service-manifest', options.serviceManifest);
    verifyArgs.push('--service-manifest', options.serviceManifest);
  }
  if (options.releaseFile) {
    runArgs.push('--release-file', options.releaseFile);
    verifyArgs.push('--release-file', options.releaseFile);
  }
  if (options.noEscalate) {
    runArgs.push('--no-escalate');
  }

  return {
    scopeCheck: scopeCheckArgs,
    run: runArgs,
    verify: verifyArgs,
  };
}

export function runOpenclawTaskFlow(rawOptions = {}) {
  const options = normalizeOpenclawTaskOptions(rawOptions);
  const commands = buildOpenclawTaskCommands(options);
  runOpenclaw('scope check', commands.scopeCheck);
  runOpenclaw('run', commands.run);
  runOpenclaw('verify', commands.verify);
}

export function main(argv) {
  const parsed = parseOpenclawTaskWrapperArgs(argv);
  return runOpenclawTaskFlow(parsed);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
