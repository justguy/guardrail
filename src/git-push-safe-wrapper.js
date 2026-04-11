import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { getRepoStatusSummary } from './repo-status.js';

export const TOPIC_BRANCH_RE = /^(feature|fix|bugfix|chore|docs|test|ci)\/[A-Za-z0-9._/-]{1,100}$/;
export const PROTECTED_BRANCH_RE = /^(main|master|production|prod|staging|release\/.+)$/;

export function isProtectedBranch(branch) {
  return typeof branch === 'string' && PROTECTED_BRANCH_RE.test(branch);
}

export function validateSafePush({ repoPath = '.', remote = 'origin', branch, status }) {
  const errors = [];
  if (remote !== 'origin') {
    errors.push('Only the "origin" remote is allowed.');
  }
  if (typeof branch !== 'string' || !TOPIC_BRANCH_RE.test(branch)) {
    errors.push('branch must be a topic branch such as feature/*, fix/*, bugfix/*, chore/*, docs/*, test/*, or ci/*');
  }
  if (isProtectedBranch(branch)) {
    errors.push(`Refusing to push protected branch "${branch}".`);
  }
  if (!status || typeof status !== 'object') {
    errors.push('git status summary is required.');
    return errors;
  }
  if (status.detached) {
    errors.push('Detached HEAD is not allowed for git-push-safe.');
  }
  if (!status.branch) {
    errors.push('Could not determine the current local branch.');
  }
  if (status.branch && branch && status.branch !== branch) {
    errors.push(`Current branch "${status.branch}" does not match requested push branch "${branch}".`);
  }
  if (status.branch && isProtectedBranch(status.branch)) {
    errors.push(`Refusing to push from protected current branch "${status.branch}".`);
  }
  if (typeof status.behind === 'number' && status.behind > 0) {
    errors.push(`Current branch is behind its upstream by ${status.behind} commit(s). Pull/rebase before pushing.`);
  }
  return errors;
}

function parseArgs(argv) {
  const parsed = { repoPath: '.', remote: 'origin', branch: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo-path') {
      parsed.repoPath = argv[++i];
    } else if (arg === '--remote') {
      parsed.remote = argv[++i];
    } else if (arg === '--branch') {
      parsed.branch = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function assertRemoteExists(repoPath, remote) {
  const result = spawnSync('git', ['-C', repoPath, 'remote', 'get-url', remote], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `Remote "${remote}" is not configured.`).trim());
  }
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.branch) {
    throw new Error('--branch is required');
  }

  const repoPath = resolve(parsed.repoPath);
  const status = getRepoStatusSummary(repoPath);
  const errors = validateSafePush({
    repoPath,
    remote: parsed.remote,
    branch: parsed.branch,
    status,
  });
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }
  assertRemoteExists(repoPath, parsed.remote);

  execFileSync('git', [
    '-C', repoPath,
    'push',
    parsed.remote,
    `HEAD:refs/heads/${parsed.branch}`,
  ], {
    stdio: 'inherit',
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
