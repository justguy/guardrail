import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  mkdtempSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { loadRecipe } from '../src/recipe.js';
import { collectRecipeInputContentHashes, verifyRecipeInputContentHashes } from '../src/prompt-inputs.js';
import {
  extractBundledWrapperRefs,
  resolveBundledWrapperPath,
  resolveBundledWrapperProvenance,
} from '../src/bundled-wrapper-path.js';

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-bundled-wrapper-')));
}

describe('Bundled wrapper path resolver', () => {
  it('resolves bundled helper aliases to repo-local runtime paths', () => {
    const resolved = resolveBundledWrapperPath('claude');
    assert.ok(existsSync(resolved.wrapperPath));
    assert.equal(resolved.source, 'bundled_local');
    assert.ok(resolved.wrapperPath.endsWith('src/claude-exec-wrapper.js'));
  });

  it('resolves the OpenClaw task helper alias', () => {
    const resolved = resolveBundledWrapperPath('openclaw_task');
    assert.ok(existsSync(resolved.wrapperPath));
    assert.equal(resolved.source, 'bundled_local');
    assert.ok(resolved.wrapperPath.endsWith('src/openclaw-task-wrapper.js'));
  });

  it('supports legacy guardrail_repo override values as a compatibility fallback', () => {
    const workspace = tmpDir();
    const legacyRepo = join(workspace, 'legacy-repo', 'src');
    const realRepo = resolve(workspace, 'legacy-repo');
    mkdirSync(legacyRepo, { recursive: true });

    const originalCwd = process.cwd();
    const sourceRoot = resolve(process.cwd(), 'src');
    const sourceWrapper = join(sourceRoot, 'claude-exec-wrapper.js');
    const overrideWrapper = join(legacyRepo, 'claude-exec-wrapper.js');
    copyFileSync(sourceWrapper, overrideWrapper);

    try {
      process.chdir(workspace);
      const resolved = resolveBundledWrapperPath('claude', { guardrail_repo: './legacy-repo' });
      assert.equal(resolved.wrapperPath, resolve(overrideWrapper));
      assert.equal(resolved.source, 'runtime_override');
      assert.equal(resolved.sourceRoot, resolve(realRepo));
      assert.equal(resolved.wrapperPath, realpathSync(overrideWrapper));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('rejects unknown bundled-wrapper aliases', () => {
    assert.throws(() => resolveBundledWrapperPath('not-a-wrapper'), {
      message: /Unknown bundled wrapper alias/,
    });
  });

  it('collects and verifies bundled-wrapper provenance in manifest-style content hashes', () => {
    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'git-commit.recipe.json'));
    const bindings = collectRecipeInputContentHashes(recipe, {
      repo_path: '.',
      paths: ['README.md'],
      message_file: 'README.md',
    });

    const wrapperKey = Object.keys(bindings).find((key) => key.startsWith('_bundled_wrapper.'));
    assert.ok(wrapperKey, `expected bundled wrapper provenance key in ${JSON.stringify(bindings)}`);

    const verify = verifyRecipeInputContentHashes(bindings);
    assert.equal(verify.verified, true);

    const tampered = {
      ...bindings,
      [wrapperKey]: {
        ...bindings[wrapperKey],
        sha256: '0000000000000000000000000000000000000000000000000000000000000000',
      },
    };
    const tamperVerify = verifyRecipeInputContentHashes(tampered);
    assert.equal(tamperVerify.verified, false);
    assert.equal(tamperVerify.errors.length > 0, true);
  });

  it('extracts bundled wrapper aliases from recipe templates', () => {
    const cmuxRecipe = loadRecipe(join(process.cwd(), 'recipes', 'cmux-claude-exec.recipe.json'));
    const claudeRecipe = loadRecipe(join(process.cwd(), 'recipes', 'claude-exec.recipe.json'));
    const openclawFixRecipe = loadRecipe(join(process.cwd(), 'recipes', 'openclaw-fix-tests.recipe.json'));
    const openclawDebugRecipe = loadRecipe(join(process.cwd(), 'recipes', 'openclaw-debug-ci.recipe.json'));
    const refs = extractBundledWrapperRefs([
      ...(cmuxRecipe.steps?.map((step) => step?.run?.command).filter(Boolean) || []),
      ...(cmuxRecipe.steps?.flatMap((step) => Array.isArray(step?.run?.args) ? step.run.args : []).filter(Boolean) || []),
      ...(claudeRecipe.steps?.map((step) => step?.run?.command).filter(Boolean) || []),
      ...(claudeRecipe.steps?.flatMap((step) => Array.isArray(step?.run?.args) ? step.run.args : []).filter(Boolean) || []),
      ...(openclawFixRecipe.steps?.map((step) => step?.run?.command).filter(Boolean) || []),
      ...(openclawFixRecipe.steps?.flatMap((step) => Array.isArray(step?.run?.args) ? step.run.args : []).filter(Boolean) || []),
      ...(openclawDebugRecipe.steps?.map((step) => step?.run?.command).filter(Boolean) || []),
      ...(openclawDebugRecipe.steps?.flatMap((step) => Array.isArray(step?.run?.args) ? step.run.args : []).filter(Boolean) || []),
    ]);
    assert.ok(refs.includes('cmux_claude'));
    assert.ok(refs.includes('claude'));
    assert.ok(refs.includes('openclaw_task'));
  });
});

describe('Bundled wrapper provenance record', () => {
  it('builds a canonical wrapper provenance record with binding metadata', () => {
    const record = resolveBundledWrapperProvenance('codex');
    assert.equal(record.wrapper, 'codex');
    assert.ok(record.wrapperPath);
    assert.equal(record.source, 'bundled_local');
    assert.equal(record.realPath, record.wrapperPath);
    assert.equal(typeof record.packageVersion, 'string');
    assert.equal(record.sha256.length, 64);
  });

  it('distinguishes bundled wrapper provenance by resolved source root', () => {
    const workspace = tmpDir();
    const legacyA = join(workspace, 'legacy-a', 'src');
    const legacyB = join(workspace, 'legacy-b', 'src');
    const sourceRoot = resolve(process.cwd(), 'src');
    const sourceWrapper = join(sourceRoot, 'claude-exec-wrapper.js');

    mkdirSync(legacyA, { recursive: true });
    mkdirSync(legacyB, { recursive: true });
    copyFileSync(sourceWrapper, join(legacyA, 'claude-exec-wrapper.js'));
    copyFileSync(sourceWrapper, join(legacyB, 'claude-exec-wrapper.js'));

    const originalCwd = process.cwd();

    try {
      process.chdir(workspace);
      const left = resolveBundledWrapperProvenance('claude', { guardrail_repo: './legacy-a' });
      const right = resolveBundledWrapperProvenance('claude', { guardrail_repo: './legacy-b' });

      assert.equal(left.wrapperPath.endsWith('legacy-a/src/claude-exec-wrapper.js'), true);
      assert.equal(right.wrapperPath.endsWith('legacy-b/src/claude-exec-wrapper.js'), true);
      assert.notEqual(left.sourceRoot, right.sourceRoot);
      assert.notEqual(left.wrapperPath, right.wrapperPath);
      assert.notEqual(left.realPath, right.realPath);
    } finally {
      process.chdir(originalCwd);
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
