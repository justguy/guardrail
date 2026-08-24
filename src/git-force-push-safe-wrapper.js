import { execFileSync, spawnSync } from 'node:child_process';
import {
  OID_RE,
  isTopicBranch,
  assertRemoteExists,
  normalizeRepoPath,
  validateSafePush,
} from './git-push-safe-wrapper.js';
import { getRepoStatusSummary } from './repo-status.js';

const REMOTE_OID_RE = /^[0-9a-fA-F]{40}$/;

export function parseArgs(argv) {
  const parsed = { repoPath: '.', remote: 'origin', branch: null, expectedHead: null, expectedRemoteOid: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo-path') {
      parsed.repoPath = argv[++i];
    } else if (arg === '--remote') {
      parsed.remote = argv[++i];
    } else if (arg === '--branch') {
      parsed.branch = argv[++i];
    } else if (arg === '--expected-head') {
      parsed.expectedHead = argv[++i];
    } else if (arg === '--expected-remote-oid') {
      parsed.expectedRemoteOid = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function normalizeOptions(rawOptions) {
  if (!rawOptions.branch) {
    throw new Error('--branch is required');
  }
  if (!rawOptions.expectedHead) {
    throw new Error('--expected-head is required');
  }
  if (!rawOptions.expectedRemoteOid) {
    throw new Error('--expected-remote-oid is required');
  }

  const expectedHead = String(rawOptions.expectedHead).trim();
  const expectedRemoteOid = String(rawOptions.expectedRemoteOid).trim();

  if (!OID_RE.test(expectedHead)) {
    throw new Error('expected_head must be a 7-40 char hexadecimal git object id');
  }
  if (!REMOTE_OID_RE.test(expectedRemoteOid)) {
    throw new Error('expected_remote_oid must be a full 40-char hexadecimal git object id');
  }
  if (!isTopicBranch(rawOptions.branch)) {
    throw new Error('branch must be a topic branch');
  }

  return {
    repoPath: normalizeRepoPath(rawOptions.repoPath || '.'),
    remote: rawOptions.remote || 'origin',
    branch: rawOptions.branch,
    expectedHead: expectedHead.toLowerCase(),
    expectedRemoteOid: expectedRemoteOid.toLowerCase(),
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

function getRemoteOid(repoPath, remote, branch) {
  const ref = `${remote}/${branch}`;
  const result = spawnSync('git', ['-C', repoPath, 'rev-parse', ref], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `Unable to resolve ${ref}`).trim());
  }
  const value = String(result.stdout).trim().toLowerCase();
  if (!REMOTE_OID_RE.test(value)) {
    throw new Error(`Invalid remote oid "${value}" for ${ref}`);
  }
  return value;
}

export function validateSafeForcePush({ repoPath = '.', remote = 'origin', branch, expectedHead, expectedRemoteOid, status }) {
  const errors = validateSafePush({ repoPath, remote, branch, status });
  if (!status || typeof status !== 'object') {
    return [...errors, 'git status summary is required.'];
  }

  const currentHead = getHeadOid(repoPath);
  if (!OID_RE.test(expectedHead) || !currentHead.startsWith(String(expectedHead).toLowerCase())) {
    errors.push(`expected_head "${expectedHead}" does not match current HEAD "${currentHead}".`);
  }
  if (!REMOTE_OID_RE.test(expectedRemoteOid || '')) {
    errors.push('expected_remote_oid must be a full 40-char hexadecimal git object id.');
  }
  return errors;
}

function main(argv) {
  const parsed = normalizeOptions(parseArgs(argv));
  const status = getRepoStatusSummary(parsed.repoPath);
  const errors = validateSafeForcePush({
    repoPath: parsed.repoPath,
    remote: parsed.remote,
    branch: parsed.branch,
    expectedHead: parsed.expectedHead,
    expectedRemoteOid: parsed.expectedRemoteOid,
    status,
  });
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }

  assertRemoteExists(parsed.repoPath, parsed.remote);
  const remoteOid = getRemoteOid(parsed.repoPath, parsed.remote, parsed.branch);
  if (remoteOid !== parsed.expectedRemoteOid) {
    throw new Error(`expected_remote_oid "${parsed.expectedRemoteOid}" does not match remote ${parsed.remote}/${parsed.branch} HEAD ${remoteOid}`);
  }

  execFileSync('git', [
    '-C', parsed.repoPath,
    'push',
    `--force-with-lease=${parsed.remote}/${parsed.branch}:${parsed.expectedRemoteOid}`,
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
