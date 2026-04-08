import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { buildPromptPayload } from './prompt-inputs.js';

const FAILURE_DETAIL_MAX_CHARS = 400;
const FAILURE_DETAIL_MAX_LINES = 3;

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

function summarizeFailureText(text) {
  if (!text || typeof text !== 'string') return '';

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, FAILURE_DETAIL_MAX_LINES);

  if (lines.length === 0) return '';

  let summary = lines.join(' | ');
  if (summary.length > FAILURE_DETAIL_MAX_CHARS) {
    summary = `${summary.slice(0, FAILURE_DETAIL_MAX_CHARS - 1).trimEnd()}…`;
  }
  return summary;
}

export function parseWrapperArgs(argv) {
  const options = {
    prompt: '',
    inputFiles: '',
    model: '',
    effort: '',
    permissionMode: '',
    outputFormat: '',
    maxBudgetUsd: '',
    allowedTools: '',
    systemPrompt: '',
    workingDir: '',
    addDirs: '',
    sessionName: '',
    noSessionPersistence: '',
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
      case '--working-dir':
        options.workingDir = value;
        i += 1;
        break;
      case '--add-dirs':
        options.addDirs = value;
        i += 1;
        break;
      case '--session-name':
        options.sessionName = value;
        i += 1;
        break;
      case '--no-session-persistence':
        options.noSessionPersistence = value;
        i += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

export function buildClaudeArgs(options = {}) {
  const args = ['--print'];

  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.outputFormat) args.push('--output-format', options.outputFormat);
  if (options.maxBudgetUsd) args.push('--max-budget-usd', options.maxBudgetUsd);
  if (options.allowedTools) args.push('--allowed-tools', options.allowedTools);
  if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);
  for (const dir of options.addDirs || []) {
    args.push('--add-dir', dir);
  }
  if (options.sessionName) args.push('--name', options.sessionName);
  if (options.noSessionPersistence) args.push('--no-session-persistence');
  if (options.promptPayload) args.push(options.promptPayload);

  return args;
}

export function buildClaudeFailureMessage({ code, stderr = '', stdout = '' }) {
  const detail = summarizeFailureText(stderr) || summarizeFailureText(stdout);
  if (detail) {
    return `claude --print failed with exit code ${code}: ${detail}`;
  }
  return `claude --print failed with exit code ${code}`;
}

function normalizeOptions(rawOptions) {
  const baseDir = rawOptions.workingDir
    ? resolve(process.cwd(), rawOptions.workingDir)
    : process.cwd();

  return {
    prompt: rawOptions.prompt || '',
    inputFiles: splitCsv(rawOptions.inputFiles),
    model: rawOptions.model || '',
    effort: rawOptions.effort || '',
    permissionMode: rawOptions.permissionMode || '',
    outputFormat: rawOptions.outputFormat || '',
    maxBudgetUsd: rawOptions.maxBudgetUsd || '',
    allowedTools: rawOptions.allowedTools || '',
    systemPrompt: rawOptions.systemPrompt || '',
    workingDir: rawOptions.workingDir ? baseDir : '',
    addDirs: splitCsv(rawOptions.addDirs).map((dir) => resolveFrom(baseDir, dir)),
    sessionName: rawOptions.sessionName || '',
    noSessionPersistence: truthy(rawOptions.noSessionPersistence),
    baseDir,
  };
}

export async function runClaudeExec(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const promptPayload = buildPromptPayload({
    prompt: options.prompt,
    inputFiles: options.inputFiles,
    baseDir: options.baseDir,
  });
  const args = buildClaudeArgs({
    ...options,
    promptPayload,
  });

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('claude', args, {
      cwd: options.workingDir || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', (err) => {
      rejectPromise(err);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`claude exited on signal ${signal}`));
        return;
      }
      if (code !== 0) {
        rejectPromise(new Error(buildClaudeFailureMessage({ code, stderr, stdout })));
        return;
      }
      resolvePromise();
    });
  });
}

async function main() {
  await runClaudeExec(parseWrapperArgs(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
