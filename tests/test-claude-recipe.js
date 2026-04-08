import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadRecipe, createRecipeManifest, compareRecipeManifests, hashRecipe } from '../src/recipe.js';
import {
  parseWrapperArgs,
  buildClaudeArgs,
} from '../src/claude-exec-wrapper.js';
import {
  collectRecipeInputContentHashes,
  verifyRecipeInputContentHashes,
} from '../src/prompt-inputs.js';

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-claude-recipe-')));
}

describe('Claude recipe', () => {
  it('loads the claude exec recipe', () => {
    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'claude-exec.recipe.json'));
    assert.equal(recipe.id, 'claude-exec');
    assert.equal(recipe.version, '1.0.0');
    assert.equal(recipe.steps.length, 1);
  });

  it('parses wrapper args by flag name', () => {
    const parsed = parseWrapperArgs([
      '--prompt', 'Review auth flow',
      '--input-files', 'src/a.js,src/b.js',
      '--model', 'sonnet',
      '--working-dir', '.',
      '--no-session-persistence', 'true',
    ]);
    assert.equal(parsed.prompt, 'Review auth flow');
    assert.equal(parsed.inputFiles, 'src/a.js,src/b.js');
    assert.equal(parsed.model, 'sonnet');
    assert.equal(parsed.workingDir, '.');
    assert.equal(parsed.noSessionPersistence, 'true');
  });

  it('builds claude args from normalized options', () => {
    const args = buildClaudeArgs({
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'plan',
      outputFormat: 'json',
      maxBudgetUsd: '1.50',
      allowedTools: 'Read Edit',
      systemPrompt: 'Focus on security',
      addDirs: ['/tmp/project/docs'],
      sessionName: 'auth-review',
      noSessionPersistence: true,
      promptPayload: 'Review this repo',
    });

    assert.deepEqual(args, [
      '--print',
      '--model', 'sonnet',
      '--effort', 'high',
      '--permission-mode', 'plan',
      '--output-format', 'json',
      '--max-budget-usd', '1.50',
      '--allowed-tools', 'Read Edit',
      '--append-system-prompt', 'Focus on security',
      '--add-dir', '/tmp/project/docs',
      '--name', 'auth-review',
      '--no-session-persistence',
      'Review this repo',
    ]);
  });

  it('stores input file content hashes in recipe manifests and detects drift', () => {
    const dir = tmpDir();
    const workingDir = join(dir, 'workspace');
    mkdirSync(workingDir, { recursive: true });
    const filePath = join(workingDir, 'prompt.txt');
    writeFileSync(filePath, 'Original prompt\n');

    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'claude-exec.recipe.json'));
    const resolvedInputs = {
      prompt: 'Review auth redirect logic',
      input_files: ['prompt.txt'],
      model: 'sonnet',
      effort: 'high',
      mode: 'plan',
      output_format: 'json',
      max_budget_usd: '1.50',
      allowed_tools: 'Read Edit',
      system_prompt: 'Focus on redirects',
      working_dir: workingDir,
      add_dirs: [],
      session_name: 'auth-review',
      no_session_persistence: true,
      guardrail_repo: '.',
    };

    const inputContentHashes = collectRecipeInputContentHashes(recipe, resolvedInputs, { cwd: dir });
    const manifest = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      { trustClass: 'unknown', riskLevel: 'red', reasons: ['recipe declares medium risk'] },
      resolvedInputs,
      {
        cwd: dir,
        projectRoot: dir,
        sourcePath: join(process.cwd(), 'recipes', 'claude-exec.recipe.json'),
        inputContentHashes,
      },
    );

    assert.equal(Array.isArray(manifest.inputContentHashes.input_files), true);
    assert.equal(manifest.inputContentHashes.input_files.length, 1);
    assert.equal(verifyRecipeInputContentHashes(manifest.inputContentHashes).verified, true);

    writeFileSync(filePath, 'Changed prompt\n');

    const changedHashes = collectRecipeInputContentHashes(recipe, resolvedInputs, { cwd: dir });
    const changedManifest = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      { trustClass: 'unknown', riskLevel: 'red', reasons: ['recipe declares medium risk'] },
      resolvedInputs,
      {
        cwd: dir,
        projectRoot: dir,
        sourcePath: join(process.cwd(), 'recipes', 'claude-exec.recipe.json'),
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
