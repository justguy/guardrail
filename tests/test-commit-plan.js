import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  compareCommitPlans,
  hashCommitPlan,
  loadCommitPlan,
  validateCommitPlan,
} from '../src/commit-plan.js';

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-commit-plan-')));
}

function makeValidPlan(overrides = {}) {
  return {
    version: 1,
    kind: 'commit_plan',
    repo_path: '.',
    summary: 'bounded commit',
    paths: ['src/a.js', 'tests/b.js'],
    message_file: '.guardrail/commit-message.txt',
    bounds: {
      allowed_roots: ['src', 'tests'],
      max_files: 2,
    },
    ...overrides,
  };
}

describe('Commit plan: load/normalize/validate', () => {
  it('loads and normalizes a valid commit plan', () => {
    const dir = tmpDir();
    const planPath = join(dir, '.guardrail', 'commit-plan.json');
    mkdirSync(join(dir, '.guardrail'), { recursive: true });
    const plan = makeValidPlan();
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
    const normalized = loadCommitPlan(planPath, { cwd: dir });

    assert.equal(normalized.version, 1);
    assert.equal(normalized.kind, 'commit_plan');
    assert.equal(normalized.repo_path, '.');
    assert.equal(normalized.message_file, '.guardrail/commit-message.txt');
    assert.deepEqual(normalized.paths, ['src/a.js', 'tests/b.js']);
    assert.equal(normalized.bounds.allowed_roots[0], 'src');
    assert.equal(normalized.bounds.max_files, 2);
    assert.equal(typeof normalized.resolved_repo_path, 'string');
    assert.equal(normalized.paths.every((entry) => !!entry), true);
  });

  it('validates wrong kind and version failures', () => {
    const dir = tmpDir();
    const planPath = join(dir, 'plan.json');
    const plan = makeValidPlan({ version: 2, kind: 'bad_plan' });
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

    assert.throws(
      () => loadCommitPlan(planPath, { cwd: dir }),
      /version must be 1/,
    );
  });

  it('rejects paths outside allowed roots', () => {
    const plan = makeValidPlan({
      paths: ['docs/readme.md'],
      bounds: { allowed_roots: ['src'], max_files: 3 },
    });
    const result = validateCommitPlan(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('outside bounds'));
  });

  it('rejects globs and absolute paths', () => {
    const absolutePathPlan = makeValidPlan({
      paths: ['/etc/passwd'],
      bounds: { allowed_roots: ['.'], max_files: 3 },
    });
    const absoluteResult = validateCommitPlan(absolutePathPlan);
    assert.equal(absoluteResult.valid, false);
    assert.ok(absoluteResult.errors[0].includes('relative'));

    const globPlan = makeValidPlan({
      paths: ['src/*.js'],
      bounds: { allowed_roots: ['src'], max_files: 3 },
    });
    const globResult = validateCommitPlan(globPlan);
    assert.equal(globResult.valid, false);
    assert.ok(globResult.errors[0].includes('glob'));
  });

  it('hashes normalized plans deterministically', () => {
    const planA = makeValidPlan();
    const planB = {
      message_file: '.guardrail/commit-message.txt',
      bounds: { max_files: 2, allowed_roots: ['src', 'tests'] },
      repo_path: '.',
      summary: 'bounded commit',
      paths: ['src/a.js', 'tests/b.js'],
      version: 1,
      kind: 'commit_plan',
    };

    assert.equal(hashCommitPlan(planA), hashCommitPlan(planB));
  });
});

describe('Commit plan: comparison', () => {
  it('compares two identical normalized plans as matching', () => {
    const result = compareCommitPlans(
      makeValidPlan(),
      makeValidPlan(),
    );
    assert.equal(result.matches, true);
    assert.equal(result.diffs.length, 0);
  });

  it('detects bounds drift', () => {
    const base = makeValidPlan({
      paths: ['src/a.js'],
      bounds: { allowed_roots: ['src'], max_files: 2 },
    });
    const drift = makeValidPlan({
      paths: ['src/a.js'],
      bounds: { allowed_roots: ['src'], max_files: 3 },
    });
    const result = compareCommitPlans(drift, base);

    assert.equal(result.matches, false);
    assert.ok(result.diffs.some((line) => line.includes('bounds.max_files')));
  });
});
