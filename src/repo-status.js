import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function parseBranchLine(line) {
  const summary = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
  };

  const body = line.replace(/^##\s*/, '').trim();
  if (!body) return summary;
  if (body.startsWith('HEAD (no branch)')) {
    summary.detached = true;
    return summary;
  }

  const [branchPart, trackingPart] = body.split('...', 2);
  summary.branch = branchPart || null;
  if (!trackingPart) return summary;

  const trackingMatch = trackingPart.match(/^([^\s]+)(?: \[(.+)\])?$/);
  if (!trackingMatch) return summary;

  summary.upstream = trackingMatch[1] || null;
  const trackingState = trackingMatch[2] || '';
  const aheadMatch = trackingState.match(/ahead (\d+)/);
  const behindMatch = trackingState.match(/behind (\d+)/);
  summary.ahead = aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0;
  summary.behind = behindMatch ? Number.parseInt(behindMatch[1], 10) : 0;
  return summary;
}

function parsePorcelainLine(line) {
  if (!line) return null;
  if (line.startsWith('## ')) {
    return { type: 'branch', ...parseBranchLine(line) };
  }
  if (line.startsWith('?? ')) {
    return {
      type: 'change',
      indexStatus: '?',
      worktreeStatus: '?',
      path: line.slice(3),
      raw: line,
    };
  }
  if (line.length < 4) return null;
  return {
    type: 'change',
    indexStatus: line[0],
    worktreeStatus: line[1],
    path: line.slice(3),
    raw: line,
  };
}

export function getRepoStatusSummary(repoPath = '.') {
  const resolvedRepoPath = resolve(repoPath);
  const result = spawnSync('git', ['-C', resolvedRepoPath, 'status', '--porcelain=v1', '--branch', '--untracked-files=all'], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'git status failed').trim());
  }

  const summary = {
    repoPath: resolvedRepoPath,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    clean: true,
    staged: [],
    unstaged: [],
    untracked: [],
  };

  const seenStaged = new Set();
  const seenUnstaged = new Set();

  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const parsed = parsePorcelainLine(line);
    if (!parsed) continue;
    if (parsed.type === 'branch') {
      summary.branch = parsed.branch;
      summary.upstream = parsed.upstream;
      summary.ahead = parsed.ahead;
      summary.behind = parsed.behind;
      summary.detached = parsed.detached;
      continue;
    }

    summary.clean = false;

    if (parsed.indexStatus === '?' && parsed.worktreeStatus === '?') {
      summary.untracked.push(parsed.path);
      continue;
    }

    if (parsed.indexStatus && parsed.indexStatus !== ' ') {
      if (!seenStaged.has(parsed.path)) {
        summary.staged.push({
          path: parsed.path,
          indexStatus: parsed.indexStatus,
          worktreeStatus: parsed.worktreeStatus,
        });
        seenStaged.add(parsed.path);
      }
    }

    if (parsed.worktreeStatus && parsed.worktreeStatus !== ' ') {
      if (!seenUnstaged.has(parsed.path)) {
        summary.unstaged.push({
          path: parsed.path,
          indexStatus: parsed.indexStatus,
          worktreeStatus: parsed.worktreeStatus,
        });
        seenUnstaged.add(parsed.path);
      }
    }
  }

  return summary;
}
