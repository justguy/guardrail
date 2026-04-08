import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseWrapperArgs(argv) {
  const options = {
    repoPath: '',
    paths: '',
    messageFile: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    switch (flag) {
      case '--repo-path':
        options.repoPath = value;
        i += 1;
        break;
      case '--paths':
        options.paths = value;
        i += 1;
        break;
      case '--message-file':
        options.messageFile = value;
        i += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

function normalizeOptions(rawOptions) {
  const repoPath = rawOptions.repoPath ? resolve(process.cwd(), rawOptions.repoPath) : process.cwd();
  const paths = Array.from(new Set(splitCsv(rawOptions.paths)));
  const messageFile = rawOptions.messageFile
    ? resolve(repoPath, rawOptions.messageFile)
    : '';

  if (paths.length === 0) {
    throw new Error('Provide at least one staged path via --paths.');
  }
  if (!messageFile) {
    throw new Error('Provide --message-file.');
  }

  return { repoPath, paths, messageFile };
}

export function buildGitDiffCachedArgs(options = {}) {
  return ['-C', options.repoPath, 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRD', '--'];
}

export function buildGitDiffCachedForPathsArgs(options = {}) {
  return ['-C', options.repoPath, 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRD', '--', ...(options.paths || [])];
}

export function buildGitAddArgs(options = {}) {
  return ['-C', options.repoPath, 'add', '--', ...(options.paths || [])];
}

export function buildGitCommitArgs(options = {}) {
  return ['-C', options.repoPath, 'commit', '--only', '-F', options.messageFile, '--', ...(options.paths || [])];
}

function parseNameOnlyOutput(output = '') {
  return output
    .split('\0')
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function isPathCoveredByApproval(approvedSet, entry) {
  for (const path of approvedSet) {
    if (entry === path || entry.startsWith(`${path}/`)) {
      return true;
    }
  }
  return false;
}

function runGit(args, captureOutput = false) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('git', args, {
      stdio: ['ignore', captureOutput ? 'pipe' : 'inherit', captureOutput ? 'pipe' : 'inherit'],
    });

    if (captureOutput) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on('error', (err) => {
      rejectPromise(err);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`git exited on signal ${signal}`));
        return;
      }
      if (code !== 0) {
        rejectPromise(new Error(`git ${args[2]} failed with exit code ${code}`));
        return;
      }
      resolvePromise(captureOutput ? { stdout, stderr } : {});
    });
  });
}

export async function runGitCommit(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const approvedSet = new Set(options.paths);
  const stagedOutput = await runGit(buildGitDiffCachedArgs(options), true);
  const alreadyStaged = parseNameOnlyOutput(stagedOutput.stdout);
  const unrelatedStaged = alreadyStaged.filter((entry) => !isPathCoveredByApproval(approvedSet, entry));

  if (unrelatedStaged.length > 0) {
    throw new Error(
      `Blocked: unrelated staged changes already present outside approved paths: ${unrelatedStaged.join(', ')}`,
    );
  }

  await runGit(buildGitAddArgs(options));

  const stagedForApprovedOutput = await runGit(buildGitDiffCachedForPathsArgs(options), true);
  const stagedForApproved = parseNameOnlyOutput(stagedForApprovedOutput.stdout);

  if (stagedForApproved.length === 0) {
    return;
  }

  await runGit(buildGitCommitArgs(options));
}

async function main() {
  await runGitCommit(parseWrapperArgs(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
