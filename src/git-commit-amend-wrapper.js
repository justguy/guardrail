import { accessSync, constants } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { getRepoStatusSummary } from './repo-status.js';

const HEAD_OID_RE = /^[0-9a-fA-F]{7,40}$/;

export function parseArgs(argv) {
  const parsed = { repoPath: '.', messageFile: null, expectedHead: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo-path') {
      parsed.repoPath = argv[++i];
    } else if (arg === '--message-file') {
      parsed.messageFile = argv[++i];
    } else if (arg === '--expected-head') {
      parsed.expectedHead = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function assertMessageFileExists(filePath) {
  accessSync(filePath, constants.R_OK);
}

export function resolveCommitAmendOptions(rawOptions) {
  if (!rawOptions.repoPath) {
    throw new Error('--repo-path is required');
  }
  if (!rawOptions.messageFile) {
    throw new Error('--message-file is required');
  }
  if (!rawOptions.expectedHead) {
    throw new Error('--expected-head is required');
  }

  const repoPath = resolve(rawOptions.repoPath);
  const messageFile = resolve(repoPath, rawOptions.messageFile);
  const expectedHead = String(rawOptions.expectedHead).trim();

  if (!HEAD_OID_RE.test(expectedHead)) {
    throw new Error('expected_head must be a 7-40 char hexadecimal git object id');
  }

  assertMessageFileExists(messageFile);

  return {
    repoPath,
    messageFile,
    expectedHead: expectedHead.toLowerCase(),
  };
}

function getHeadOid(repoPath) {
  const result = spawnSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Unable to resolve HEAD.').trim());
  }
  const value = String(result.stdout).trim();
  if (!value) {
    throw new Error('Unable to resolve HEAD.');
  }
  return value.toLowerCase();
}

export function validateCommitAmend(options) {
  const errors = [];
  const status = options.status || {};
  if (status.detached) {
    errors.push('Detached HEAD is not allowed for git-commit-amend.');
  }

  const currentHead = getHeadOid(options.repoPath);
  const expected = String(options.expectedHead || '').toLowerCase();

  if (!currentHead.startsWith(expected) && expected !== currentHead) {
    errors.push(`expected_head "${expected}" does not match current HEAD "${currentHead}".`);
  }

  return errors;
}

function main(argv) {
  const parsed = parseArgs(argv);
  const options = resolveCommitAmendOptions({
    repoPath: parsed.repoPath,
    messageFile: parsed.messageFile,
    expectedHead: parsed.expectedHead,
  });

  const status = getRepoStatusSummary(options.repoPath);
  const errors = validateCommitAmend({
    repoPath: options.repoPath,
    expectedHead: options.expectedHead,
    status,
  });

  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }

  execFileSync('git', [
    '-C', options.repoPath,
    'commit',
    '--amend',
    '-F', options.messageFile,
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
