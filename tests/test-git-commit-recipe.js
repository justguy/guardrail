import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { loadRecipe, createRecipeManifest, compareRecipeManifests, hashRecipe } from '../src/recipe.js';
import {
  runGitCommit,
  parseWrapperArgs,
  buildGitAddArgs,
  buildGitCommitArgs,
} from '../src/git-commit-wrapper.js';
import {
  collectRecipeInputContentHashes,
  verifyRecipeInputContentHashes,
} from '../src/prompt-inputs.js';

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-git-commit-recipe-')));
}

function runGit(dir, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout;
}

function makeRepo() {
  const dir = tmpDir();
  const repoDir = join(dir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  runGit(repoDir, ['init', '-b', 'main']);
  runGit(repoDir, ['config', 'user.name', 'Guardrail Test']);
  runGit(repoDir, ['config', 'user.email', 'guardrail-test@example.com']);
  return repoDir;
}

describe('Git commit recipe', () => {
  it('loads the git commit recipe', () => {
    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'git-commit.recipe.json'));
    assert.equal(recipe.id, 'git-commit');
    assert.equal(recipe.version, '1.0.0');
    assert.equal(recipe.steps.length, 1);
    assert.equal(recipe.category, 'git');
  });

  it('parses wrapper args by flag name', () => {
    const parsed = parseWrapperArgs([
      '--repo-path', '.',
      '--paths', 'src/a.js,src/b.js',
      '--message-file', '.guardrail/commit-message.txt',
    ]);

    assert.equal(parsed.repoPath, '.');
    assert.equal(parsed.paths, 'src/a.js,src/b.js');
    assert.equal(parsed.messageFile, '.guardrail/commit-message.txt');
  });

  it('builds git add and commit args from normalized options', () => {
    const addArgs = buildGitAddArgs({
      repoPath: '/tmp/project',
      paths: ['src/a.js', 'docs/plan.md'],
    });
    const commitArgs = buildGitCommitArgs({
      repoPath: '/tmp/project',
      paths: ['src/a.js', 'docs/plan.md'],
      messageFile: '/tmp/project/.guardrail/commit-message.txt',
    });

    assert.deepEqual(addArgs, [
      '-C', '/tmp/project',
      'add',
      '--',
      'src/a.js',
      'docs/plan.md',
    ]);
    assert.deepEqual(commitArgs, [
      '-C', '/tmp/project',
      'commit',
      '--only',
      '-F',
      '/tmp/project/.guardrail/commit-message.txt',
      '--',
      'src/a.js',
      'docs/plan.md',
    ]);
  });

  it('fails when pre-existing staged changes are outside approved paths', async () => {
    const repoDir = makeRepo();
    const allowed = join(repoDir, 'allowed.txt');
    const unrelated = join(repoDir, 'unrelated.txt');
    const messageFile = join(repoDir, '.guardrail', 'commit-message.txt');
    writeFileSync(allowed, 'base\n');
    writeFileSync(unrelated, 'base\n');
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', 'base']);

    writeFileSync(unrelated, 'blocked edit\n');
    runGit(repoDir, ['add', 'unrelated.txt']);

    mkdirSync(dirname(messageFile), { recursive: true });
    writeFileSync(messageFile, 'Guardrail bounded no-op test\n');

    await assert.rejects(
      () => runGitCommit({
        repoPath: repoDir,
        paths: ['allowed.txt'],
        messageFile,
      }),
      /Blocked: unrelated staged changes already present outside approved paths/,
    );
  });

  it('returns success without committing when approved paths have no staged changes', async () => {
    const repoDir = makeRepo();
    const allowed = join(repoDir, 'allowed.txt');
    const messageFile = join(repoDir, '.guardrail', 'commit-message.txt');
    writeFileSync(allowed, 'tracked\n');
    runGit(repoDir, ['add', 'allowed.txt']);
    runGit(repoDir, ['commit', '-m', 'baseline']);

    mkdirSync(dirname(messageFile), { recursive: true });
    writeFileSync(messageFile, 'No-op commit message\n');
    const beforeHead = runGit(repoDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    await runGitCommit({
      repoPath: repoDir,
      paths: ['allowed.txt'],
      messageFile,
    });

    const afterHead = runGit(repoDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = runGit(repoDir, ['status', '--short', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    assert.equal(beforeHead, afterHead);
    assert.equal(status, '');
  });

  it('commits only approved paths and leaves unapproved edits outside the commit', async () => {
    const repoDir = makeRepo();
    const approved = join(repoDir, 'allowed.txt');
    const unapproved = join(repoDir, 'blocked.txt');
    const messageFile = join(repoDir, '.guardrail', 'commit-message.txt');
    writeFileSync(approved, 'approved base\n');
    writeFileSync(unapproved, 'blocked base\n');
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', 'baseline']);

    writeFileSync(approved, 'approved edit\n');
    writeFileSync(unapproved, 'blocked edit\n');
    mkdirSync(dirname(messageFile), { recursive: true });
    writeFileSync(messageFile, 'Commit only approved path\n');

    await runGitCommit({
      repoPath: repoDir,
      paths: ['allowed.txt'],
      messageFile,
    });

    const committedFiles = runGit(repoDir, ['show', '--pretty=format:', '--name-only', 'HEAD'], { encoding: 'utf8' }).trim();
    const staged = runGit(repoDir, ['diff', '--name-only'], { encoding: 'utf8' }).trim();
    assert.ok(committedFiles.split('\n').includes('allowed.txt'));
    assert.equal(staged, 'blocked.txt');
  });

  it('stores commit message content hashes in recipe manifests and detects drift', () => {
    const dir = tmpDir();
    const repoDir = join(dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const messagePath = join(repoDir, '.guardrail-commit-message.txt');
    writeFileSync(messagePath, 'Initial commit message\n');

    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'git-commit.recipe.json'));
    const resolvedInputs = {
      guardrail_repo: '.',
      repo_path: 'repo',
      paths: ['src/a.js'],
      message_file: '.guardrail-commit-message.txt',
    };

    const inputContentHashes = collectRecipeInputContentHashes(recipe, resolvedInputs, { cwd: dir });
    const manifest = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      { trustClass: 'unknown', riskLevel: 'yellow', reasons: ['recipe declares medium risk'] },
      resolvedInputs,
      {
        cwd: dir,
        projectRoot: dir,
        sourcePath: join(process.cwd(), 'recipes', 'git-commit.recipe.json'),
        inputContentHashes,
      },
    );

    assert.equal(verifyRecipeInputContentHashes(manifest.inputContentHashes).verified, true);

    writeFileSync(messagePath, 'Changed commit message\n');

    const changedHashes = collectRecipeInputContentHashes(recipe, resolvedInputs, { cwd: dir });
    const changedManifest = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      { trustClass: 'unknown', riskLevel: 'yellow', reasons: ['recipe declares medium risk'] },
      resolvedInputs,
      {
        cwd: dir,
        projectRoot: dir,
        sourcePath: join(process.cwd(), 'recipes', 'git-commit.recipe.json'),
        inputContentHashes: changedHashes,
      },
    );

    const comparison = compareRecipeManifests(changedManifest, manifest);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.diffs.some((diff) => diff.includes('inputContentHashes')));

    const verify = verifyRecipeInputContentHashes(manifest.inputContentHashes);
    assert.equal(verify.verified, false);
    assert.ok(verify.errors.some((error) => error.includes('file content changed')));
  });
});
