import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { exportRecipeRegistry } from '../src/recipe-registry.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'gr-recipe-registry-'));
}

describe('recipe registry export', () => {
  it('writes static v1 recipe registry documents', () => {
    const dir = tmpDir();
    const out = join(dir, 'registry');
    const searchRoot = join(dir, 'recipes');
    mkdirSync(searchRoot, { recursive: true });

    const result = exportRecipeRegistry(out, [join(process.cwd(), 'recipes')]);
    assert.equal(result.count > 0, true);

    const index = JSON.parse(readFileSync(join(out, 'v1', 'recipes', 'index.json'), 'utf8'));
    assert.equal(index.version, 1);
    assert.ok(Array.isArray(index.recipes));
    const terraform = index.recipes.find((entry) => entry.id === 'terraform-plan-only');
    assert.ok(terraform);

    const recipeDoc = JSON.parse(
      readFileSync(join(out, 'v1', 'recipes', 'infra', 'terraform-plan-only', 'index.json'), 'utf8'),
    );
    assert.equal(recipeDoc.id, 'terraform-plan-only');
    assert.equal(recipeDoc.latest_version, '1.0.0');

    const versionsDoc = JSON.parse(
      readFileSync(join(out, 'v1', 'recipes', 'infra', 'terraform-plan-only', 'versions', 'index.json'), 'utf8'),
    );
    assert.deepEqual(versionsDoc.versions.map((entry) => entry.version), ['1.0.0']);
  });
});
