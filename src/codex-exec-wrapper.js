import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { buildPromptPayload } from './prompt-inputs.js';

function truthy(value) {
  return value === true || value === 'true' || value === '1';
}

function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveFrom(baseDir, maybePath) {
  if (!maybePath) return '';
  return resolve(baseDir, maybePath);
}

export function parseWrapperArgs(argv) {
  const options = {
    prompt: '',
    inputFiles: '',
    model: '',
    profile: '',
    sandbox: '',
    workingDir: '',
    addDirs: '',
    imageFiles: '',
    json: '',
    outputLastMessageFile: '',
    outputSchemaFile: '',
    color: '',
    oss: '',
    localProvider: '',
    skipGitRepoCheck: '',
    ephemeral: '',
    fullAuto: '',
    lifecycle: '',
    sessionName: '',
    sessionId: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    switch (flag) {
      case '--prompt':
        options.prompt = value;
        i += 1;
        break;
      case '--input-files':
        options.inputFiles = value;
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
      case '--working-dir':
        options.workingDir = value;
        i += 1;
        break;
      case '--add-dirs':
        options.addDirs = value;
        i += 1;
        break;
      case '--image-files':
        options.imageFiles = value;
        i += 1;
        break;
      case '--json':
        options.json = value;
        i += 1;
        break;
      case '--output-last-message-file':
        options.outputLastMessageFile = value;
        i += 1;
        break;
      case '--output-schema-file':
        options.outputSchemaFile = value;
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
      case '--lifecycle':
        options.lifecycle = value;
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
      default:
        break;
    }
  }

  return options;
}

export function buildCodexExecArgs(options = {}) {
  const args = ['exec'];

  if (options.model) args.push('--model', options.model);
  if (options.profile) args.push('--profile', options.profile);
  if (options.sandbox) args.push('--sandbox', options.sandbox);
  if (options.workingDir) args.push('--cd', options.workingDir);

  for (const dir of options.addDirs || []) {
    args.push('--add-dir', dir);
  }

  for (const image of options.imageFiles || []) {
    args.push('--image', image);
  }

  if (options.json) args.push('--json');
  if (options.outputLastMessageFile) {
    args.push('--output-last-message', options.outputLastMessageFile);
  }
  if (options.outputSchemaFile) {
    args.push('--output-schema', options.outputSchemaFile);
  }
  if (options.color) args.push('--color', options.color);
  if (options.oss) args.push('--oss');
  if (options.localProvider) args.push('--local-provider', options.localProvider);
  if (options.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (options.ephemeral) args.push('--ephemeral');
  if (options.fullAuto) args.push('--full-auto');

  args.push('-');
  return args;
}

function normalizeOptions(rawOptions) {
  const baseDir = rawOptions.workingDir
    ? resolve(process.cwd(), rawOptions.workingDir)
    : process.cwd();

  const fullAuto = truthy(rawOptions.fullAuto);
  const sandbox = rawOptions.sandbox || '';
  if (fullAuto && sandbox) {
    throw new Error('full_auto and sandbox cannot be set together.');
  }

  const oss = truthy(rawOptions.oss);
  if (rawOptions.localProvider && !oss) {
    throw new Error('local_provider requires oss=true.');
  }

  return {
    prompt: rawOptions.prompt || '',
    inputFiles: splitCsv(rawOptions.inputFiles),
    model: rawOptions.model || '',
    profile: rawOptions.profile || '',
    sandbox,
    workingDir: rawOptions.workingDir ? baseDir : '',
    addDirs: splitCsv(rawOptions.addDirs).map((dir) => resolveFrom(baseDir, dir)),
    imageFiles: splitCsv(rawOptions.imageFiles).map((file) => resolveFrom(baseDir, file)),
    json: truthy(rawOptions.json),
    outputLastMessageFile: rawOptions.outputLastMessageFile
      ? resolveFrom(baseDir, rawOptions.outputLastMessageFile)
      : '',
    outputSchemaFile: rawOptions.outputSchemaFile
      ? resolveFrom(baseDir, rawOptions.outputSchemaFile)
      : '',
    color: rawOptions.color || '',
    oss,
    localProvider: rawOptions.localProvider || '',
    skipGitRepoCheck: truthy(rawOptions.skipGitRepoCheck),
    ephemeral: truthy(rawOptions.ephemeral),
    fullAuto,
    lifecycle: rawOptions.lifecycle || '',
    sessionName: rawOptions.sessionName || '',
    sessionId: rawOptions.sessionId || '',
    baseDir,
  };
}

/**
 * Emit a structured Guardrail session metadata record. Pure: builds a plain
 * object describing the session-lifecycle intent that the recipe-supervisor
 * enforcement layer already consumed. This is a trace/audit aid for
 * wrapper-level observability; it never reaches the underlying codex binary.
 */
export function emitSessionMetadata({ lifecycle, sessionName, sessionId, workingDir }) {
  return { tool: 'codex', lifecycle, sessionName, sessionId, workingDir };
}

export async function runCodexExec(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const meta = emitSessionMetadata({
    lifecycle: options.lifecycle,
    sessionName: options.sessionName,
    sessionId: options.sessionId,
    workingDir: options.workingDir || process.cwd(),
  });
  process.stderr.write(`[guardrail-session] ${JSON.stringify(meta)}\n`);

  const promptPayload = buildPromptPayload({
    prompt: options.prompt,
    inputFiles: options.inputFiles,
    baseDir: options.baseDir,
  });
  const args = buildCodexExecArgs(options);

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('codex', args, {
      cwd: options.workingDir || process.cwd(),
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    child.on('error', (err) => {
      rejectPromise(err);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`codex exited on signal ${signal}`));
        return;
      }
      if (code !== 0) {
        rejectPromise(new Error(`codex exec failed with exit code ${code}`));
        return;
      }
      resolvePromise();
    });

    child.stdin.end(promptPayload);
  });
}

async function main() {
  await runCodexExec(parseWrapperArgs(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
