import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { exportRecipeRegistry } from '../src/recipe-registry.js';
import { installFromRegistry, listInstalled, listRegistryRecipes } from '../src/recipe-install.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'gr-recipe-registry-'));
}

function writeOrgPolicy(dir, trustedRegistries) {
  const policyDir = join(dir, '.guardrail');
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(join(policyDir, 'org-policy.json'), JSON.stringify({
    name: 'registry-policy',
    version: '1.0.0',
    trusted_registries: trustedRegistries,
    forbidden_operations: [],
    required_approvals: [],
    trusted_recipe_roots: [],
    trusted_execution_sources: [],
    allowed_actions: [],
  }));
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

  it('lists and installs recipes from a static registry snapshot', async () => {
    const dir = tmpDir();
    const out = join(dir, 'registry');
    const registryDir = join(dir, 'installed');
    exportRecipeRegistry(out, [join(process.cwd(), 'recipes')]);

    const listed = await listRegistryRecipes(out);
    assert.ok(listed.recipes.some((entry) => entry.id === 'terraform-plan-only'));

    const result = await installFromRegistry('infra/terraform-plan-only@1.0.0', out, {
      registryDir,
    });
    assert.equal(result.installed, true);
    assert.equal(result.id, 'terraform-plan-only');
    assert.ok(existsSync(join(registryDir, 'terraform-plan-only', '1.0.0.json')));
    assert.ok(listInstalled(registryDir).some((entry) => entry.id === 'terraform-plan-only'));
  });

  it('requires exact category/id@version for registry installs', async () => {
    const dir = tmpDir();
    const out = join(dir, 'registry');
    exportRecipeRegistry(out, [join(process.cwd(), 'recipes')]);

    await assert.rejects(
      () => installFromRegistry('terraform-plan-only', out),
      /category\/id@version/
    );
  });

  it('blocks untrusted registries via active org policy', async () => {
    const dir = tmpDir();
    const out = join(dir, 'registry');
    exportRecipeRegistry(out, [join(process.cwd(), 'recipes')]);
    writeOrgPolicy(dir, ['/tmp/other-registry']);

    await assert.rejects(
      () => listRegistryRecipes(out, { orgPolicyDir: dir }),
      /trusted registries/
    );
  });
});
