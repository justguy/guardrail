import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { composeRecipeArtifact } from '../src/recipe-compose.js';
import { loadRecipe } from '../src/recipe.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'gr-compose-'));
}

function writeRecipe(dir, fileName, recipe) {
  const path = join(dir, fileName);
  writeFileSync(path, `${JSON.stringify(recipe, null, 2)}\n`, 'utf8');
  return path;
}

describe('recipe compose', () => {
  it('writes a composed recipe artifact from transport and exec recipes', () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    writeRecipe(recipesDir, 'transport-hop.recipe.json', {
      id: 'transport-hop',
      name: 'Transport Hop',
      description: 'Hop to another runtime',
      version: '1.0.0',
      author: 'tester',
      approval_required: true,
      risk_level: 'medium',
      category: 'custom',
      channel: 'verified',
      inputs: {
        prompt: { type: 'string', approval_mode: 'interactive_message' },
        workspace_name: { type: 'string', pattern: '^[a-z-]+$' },
      },
      steps: [{
        id: 'hop',
        description: 'Launch transport hop',
        run: { command: 'node', args: ['transport.js', '{{inputs.workspace_name}}'], mode: 'structured' },
      }],
      guardrails: { constraints: ['bounded transport'], invariants: ['structured only'] },
    });

    writeRecipe(recipesDir, 'exec-ai.recipe.json', {
      id: 'exec-ai',
      name: 'Exec AI',
      description: 'Run the AI tool',
      version: '2.0.0',
      author: 'tester',
      approval_required: true,
      risk_level: 'high',
      category: 'custom',
      channel: 'verified',
      inputs: {
        prompt: { type: 'string', approval_mode: 'interactive_message' },
        system_prompt: { type: 'string', approval_mode: 'review_each_time' },
      },
      steps: [{
        id: 'exec',
        description: 'Execute tool',
        run: { command: 'node', args: ['exec.js', '{{inputs.prompt}}'], mode: 'structured' },
      }],
      guardrails: { constraints: ['bounded exec'], invariants: ['structured only'] },
    });

    const outputPath = join(dir, '.guardrail', 'recipes', 'transport-hop-exec-ai.recipe.json');
    const result = composeRecipeArtifact({
      transportSpecifier: 'transport-hop',
      execSpecifier: 'exec-ai',
      searchDirs: [recipesDir],
      outputPath,
      name: 'transport-hop-exec-ai',
    });

    assert.equal(result.recipe.id, 'transport-hop-exec-ai');
    const loaded = loadRecipe(outputPath);
    assert.equal(loaded.steps.length, 1);
    assert.equal(loaded.steps[0].composed_recipe.recipe, 'exec-ai');
    assert.equal(loaded.steps[0].composed_recipe.inputs.prompt, '{{inputs.prompt}}');
    assert.equal(loaded.inputs.system_prompt.type, 'string');
    assert.equal(loaded.risk_level, 'high');
  });

  it('propagates requires_env, requires_auth, and preserve_runtime_env into the composed artifact', () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    writeRecipe(recipesDir, 'transport-hop.recipe.json', {
      id: 'transport-hop',
      name: 'Transport Hop',
      description: 'Hop to another runtime',
      version: '1.0.0',
      author: 'tester',
      approval_required: true,
      risk_level: 'medium',
      category: 'custom',
      channel: 'verified',
      requires_env: ['TERM'],
      inputs: {},
      steps: [{
        id: 'hop',
        description: 'Launch transport hop',
        run: { command: 'node', args: ['transport.js'], mode: 'structured' },
      }],
      guardrails: { constraints: ['bounded transport'], invariants: ['structured only'] },
    });

    writeRecipe(recipesDir, 'exec-ai.recipe.json', {
      id: 'exec-ai',
      name: 'Exec AI',
      description: 'Run the AI tool',
      version: '2.0.0',
      author: 'tester',
      approval_required: true,
      risk_level: 'high',
      category: 'custom',
      channel: 'verified',
      preserve_runtime_env: true,
      requires_env: ['HOME'],
      requires_auth: [{ type: 'claude_login', env: ['HOME'] }],
      inputs: {
        prompt: { type: 'string', approval_mode: 'interactive_message' },
      },
      steps: [{
        id: 'exec',
        description: 'Execute tool',
        run: { command: 'node', args: ['exec.js', '{{inputs.prompt}}'], mode: 'structured' },
      }],
      guardrails: { constraints: ['bounded exec'], invariants: ['structured only'] },
    });

    const result = composeRecipeArtifact({
      transportSpecifier: 'transport-hop',
      execSpecifier: 'exec-ai',
      searchDirs: [recipesDir],
      outputPath: join(dir, 'composed.recipe.json'),
    });

    assert.deepEqual(result.recipe.requires_env, ['TERM', 'HOME']);
    assert.equal(result.recipe.preserve_runtime_env, true);
    assert.deepEqual(result.recipe.requires_auth, [{ type: 'claude_login', env: ['HOME'] }]);
  });

  it('fails closed on conflicting shared input schemas', () => {
    const dir = tmpDir();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir, { recursive: true });

    writeRecipe(recipesDir, 'transport-hop.recipe.json', {
      id: 'transport-hop',
      name: 'Transport Hop',
      description: 'Hop to another runtime',
      version: '1.0.0',
      author: 'tester',
      approval_required: true,
      risk_level: 'medium',
      category: 'custom',
      channel: 'verified',
      inputs: {
        prompt: { type: 'string', pattern: '^transport$' },
      },
      steps: [{
        id: 'hop',
        description: 'Launch transport hop',
        run: { command: 'node', args: ['transport.js'], mode: 'structured' },
      }],
      guardrails: { constraints: ['bounded transport'], invariants: ['structured only'] },
    });

    writeRecipe(recipesDir, 'exec-ai.recipe.json', {
      id: 'exec-ai',
      name: 'Exec AI',
      description: 'Run the AI tool',
      version: '1.0.0',
      author: 'tester',
      approval_required: true,
      risk_level: 'high',
      category: 'custom',
      channel: 'verified',
      inputs: {
        prompt: { type: 'string', pattern: '^exec$' },
      },
      steps: [{
        id: 'exec',
        description: 'Execute tool',
        run: { command: 'node', args: ['exec.js'], mode: 'structured' },
      }],
      guardrails: { constraints: ['bounded exec'], invariants: ['structured only'] },
    });

    assert.throws(
      () => composeRecipeArtifact({
        transportSpecifier: 'transport-hop',
        execSpecifier: 'exec-ai',
        searchDirs: [recipesDir],
        outputPath: join(dir, 'composed.recipe.json'),
      }),
      /Input schema conflict/,
    );
  });
});
