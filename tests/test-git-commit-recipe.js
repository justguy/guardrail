import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadRecipe, createRecipeManifest, compareRecipeManifests, hashRecipe } from '../src/recipe.js';
import {
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
      '-F',
      '/tmp/project/.guardrail/commit-message.txt',
    ]);
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
