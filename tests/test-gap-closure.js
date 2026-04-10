import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  resolveRecipeById,
  resolveInputs,
  runRecipeById,
  parseRecipeSpecifier,
  runRunbook,
  buildRecipeSearchDirs,
} from '../src/recipe-runner.js';
import { ensureRegistryDir, installFromPath, installFromUrl, listInstalled, listVersions, loadConfig, checkTrustedSource } from '../src/recipe-install.js';
import { runRecipeSupervisor } from '../src/recipe-supervisor.js';
import { createRecipeManifest, hashRecipe } from '../src/recipe.js';
import { saveManifest } from '../src/manifest.js';
import { signRecipe } from '../src/recipe-channel.js';
import { runFullVerification } from '../src/verify.js';
import { listScenarios } from '../src/demo-scenarios.js';
import { collectRecipeInputContentHashes } from '../src/prompt-inputs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-gc-')));
}

function writeRecipe(dir, recipe) {
  const path = join(dir, `${recipe.id}.recipe.json`);
  writeFileSync(path, JSON.stringify(recipe, null, 2));
  return path;
}

function makeRecipe(overrides = {}) {
  const recipe = {
    id: 'test-recipe', name: 'Test Recipe', description: 'A test recipe',
    version: '1.0.0', author: 'tester', category: 'custom',
    tags: ['test'], channel: 'community',
    inputs: { target: { type: 'string', pattern: '^[a-z]+$' } },
    steps: [{ id: 's1', description: 'echo', run: { command: 'echo', args: ['{{inputs.target}}'], mode: 'structured' } }],
    guardrails: { constraints: ['safe'], invariants: ['no harm'] },
    approval_required: false, risk_level: 'low',
    ...overrides,
  };
  if (recipe.channel === 'verified' && !recipe.signature) {
    recipe.signature = signRecipe(recipe);
  }
  return recipe;
}

// ===========================================================================
// 1. Recipe Runner: resolveRecipeById
// ===========================================================================

describe('Recipe Runner: resolveRecipeById', () => {
  it('finds recipe by ID in search directory', () => {
    const dir = tmpDir();
    writeRecipe(dir, makeRecipe({ id: 'my-recipe' }));
    const { recipe, sourcePath } = resolveRecipeById('my-recipe', [dir]);
    assert.equal(recipe.id, 'my-recipe');
    assert.ok(sourcePath.endsWith('.recipe.json'));
  });

  it('deduplicates search roots with equivalent normalized paths', () => {
    const dir = tmpDir();
    const nested = join(dir, 'recipes');
    mkdirSync(nested, { recursive: true });
    writeRecipe(nested, makeRecipe({ id: 'norm', version: '1.0.0' }));
    const result = resolveRecipeById('norm', [nested, resolve(nested, '.')]);
    assert.equal(result.version, '1.0.0');
  });

  it('fails closed when same recipe/version exists in multiple active roots', () => {
    const left = mkdtempSync(join(tmpdir(), 'gr-collision-a-'));
    const right = mkdtempSync(join(tmpdir(), 'gr-collision-b-'));
    writeRecipe(left, makeRecipe({ id: 'ambiguous', version: '1.0.0' }));
    writeRecipe(right, makeRecipe({ id: 'ambiguous', version: '1.0.0' }));
    assert.throws(
      () => resolveRecipeById('ambiguous', [left, right]),
      (err) => err.message.includes('ambiguous resolution')
    );
  });

  it('builds canonical workflow/standalone discovery roots deterministically', () => {
    const base = mkdtempSync(join(tmpdir(), 'gr-roots-'));
    const project = join(base, 'project');
    const override = join(base, 'override');
    const global = join(base, 'recipes');
    const sharedDefaults = join(base, 'node_modules/.guardrail/recipes');
    mkdirSync(project, { recursive: true });
    mkdirSync(join(project, 'recipes'), { recursive: true });
    mkdirSync(override, { recursive: true });
    mkdirSync(global, { recursive: true });
    mkdirSync(sharedDefaults, { recursive: true });

    const roots = buildRecipeSearchDirs({
      explicitSearchDirs: [override],
      projectRoot: project,
      basePath: base,
      includeDefaults: true,
    });

    assert.equal(roots[0], resolve(override));
    assert.equal(roots[1], resolve(project, 'recipes'));
    assert.equal(roots[2], resolve(base, 'recipes'));
    assert.equal(roots[3], resolve(sharedDefaults));
    assert.equal(roots[4], resolve(homedir(), '.guardrail', 'recipes'));
  });

  it('includes configured repo and user recipe roots after local defaults', () => {
    const base = mkdtempSync(join(tmpdir(), 'gr-config-roots-'));
    const project = join(base, 'project');
    const repoExtra = join(base, 'repo-extra');
    const userHome = join(base, 'fake-home');
    const userExtra = join(base, 'user-extra');
    const localRecipes = join(base, 'recipes');
    const repoConfigPath = join(project, '.guardrail', 'config.json');
    const userConfigPath = join(userHome, '.guardrail', 'config.json');

    mkdirSync(join(project, 'recipes'), { recursive: true });
    mkdirSync(join(project, '.guardrail'), { recursive: true });
    mkdirSync(localRecipes, { recursive: true });
    mkdirSync(repoExtra, { recursive: true });
    mkdirSync(userExtra, { recursive: true });
    mkdirSync(join(base, 'node_modules/.guardrail/recipes'), { recursive: true });
    mkdirSync(join(userHome, '.guardrail'), { recursive: true });

    writeFileSync(repoConfigPath, JSON.stringify({ recipe_roots: [repoExtra] }));
    writeFileSync(userConfigPath, JSON.stringify({ recipe_roots: [userExtra] }));

    const roots = buildRecipeSearchDirs({
      projectRoot: project,
      basePath: base,
      includeDefaults: true,
      repoConfigPath,
      userConfigPath,
    });

    assert.equal(roots[0], resolve(project, 'recipes'));
    assert.equal(roots[1], resolve(base, 'recipes'));
    assert.equal(roots[2], resolve(repoExtra));
    assert.equal(roots[3], resolve(base, 'node_modules/.guardrail/recipes'));
    assert.equal(roots[4], resolve(userExtra));
    assert.equal(roots[5], resolve(homedir(), '.guardrail', 'recipes'));
  });

  it('resolves standalone recipes through repo-configured default roots', () => {
    const base = mkdtempSync(join(tmpdir(), 'gr-standalone-config-root-'));
    const project = join(base, 'project');
    const repoExtra = join(base, 'shared-recipes');
    const repoConfigPath = join(project, '.guardrail', 'config.json');

    mkdirSync(join(project, '.guardrail'), { recursive: true });
    mkdirSync(repoExtra, { recursive: true });
    writeFileSync(repoConfigPath, JSON.stringify({ default_recipe_roots: ['../shared-recipes'] }));
    writeRecipe(repoExtra, makeRecipe({ id: 'configured-standalone' }));

    const { recipe, sourcePath } = resolveRecipeById('configured-standalone', {
      basePath: project,
      repoConfigPath,
      userConfigPath: false,
    });

    assert.equal(recipe.id, 'configured-standalone');
    assert.ok(sourcePath.endsWith('configured-standalone.recipe.json'));
  });

  it('allows repo-configured recipe roots when org policy trusts them', () => {
    const base = mkdtempSync(join(tmpdir(), 'gr-config-roots-policy-'));
    const project = join(base, 'project');
    const repoExtra = join(base, 'shared-recipes');
    const repoConfigPath = join(project, '.guardrail', 'config.json');

    mkdirSync(join(project, '.guardrail'), { recursive: true });
    mkdirSync(repoExtra, { recursive: true });
    writeFileSync(repoConfigPath, JSON.stringify({ recipe_roots: [repoExtra] }));
    writeRecipe(repoExtra, makeRecipe({ id: 'policy-allow-root' }));

    const roots = buildRecipeSearchDirs({
      projectRoot: project,
      basePath: base,
      includeDefaults: false,
      repoConfigPath,
      userConfigPath: false,
      orgPolicy: {
        name: 'policy-allow',
        version: '1.0.0',
        trusted_recipe_roots: [repoExtra],
        forbidden_operations: [],
        required_approvals: [],
        allowed_actions: [],
      },
    });

    assert.ok(roots.includes(resolve(repoExtra)));
  });

  it('blocks repo-configured recipe roots when org policy blocks them', () => {
    const base = mkdtempSync(join(tmpdir(), 'gr-config-roots-policy-block-'));
    const project = join(base, 'project');
    const repoExtra = join(base, 'shared-recipes');
    const repoConfigPath = join(project, '.guardrail', 'config.json');

    mkdirSync(join(project, '.guardrail'), { recursive: true });
    mkdirSync(repoExtra, { recursive: true });
    writeFileSync(repoConfigPath, JSON.stringify({ recipe_roots: ['../shared-recipes'] }));

    assert.throws(
      () => buildRecipeSearchDirs({
        projectRoot: project,
        basePath: base,
        includeDefaults: false,
        repoConfigPath,
        userConfigPath: false,
        orgPolicy: {
          name: 'policy-block',
          version: '1.0.0',
          trusted_recipe_roots: ['/tmp/blocked-recipes'],
          forbidden_operations: [],
          required_approvals: [],
          allowed_actions: [],
        },
      }),
      /blocked by org policy/,
    );
  });

  it('fails closed on configured missing recipe roots', () => {
    const base = mkdtempSync(join(tmpdir(), 'gr-bad-config-roots-'));
    const project = join(base, 'project');
    const repoConfigPath = join(project, '.guardrail', 'config.json');
    mkdirSync(join(project, '.guardrail'), { recursive: true });
    writeFileSync(repoConfigPath, JSON.stringify({ recipe_roots: ['./missing-recipes'] }));

    assert.throws(
      () => buildRecipeSearchDirs({
        projectRoot: project,
        basePath: base,
        repoConfigPath,
        userConfigPath: false,
      }),
      /Configured recipe root ".\/missing-recipes".*does not exist/,
    );
  });

  it('throws on unknown ID', () => {
    const dir = tmpDir();
    writeRecipe(dir, makeRecipe({ id: 'other-recipe' }));
    assert.throws(
      () => resolveRecipeById('nonexistent', [dir]),
      (err) => err.message.includes('not found'),
    );
  });

  it('searches multiple directories', () => {
    const dir1 = tmpDir();
    const dir2 = tmpDir();
    writeRecipe(dir1, makeRecipe({ id: 'recipe-a' }));
    writeRecipe(dir2, makeRecipe({ id: 'recipe-b' }));
    const { recipe: a } = resolveRecipeById('recipe-a', [dir1, dir2]);
    const { recipe: b } = resolveRecipeById('recipe-b', [dir1, dir2]);
    assert.equal(a.id, 'recipe-a');
    assert.equal(b.id, 'recipe-b');
  });

  it('skips nonexistent directories', () => {
    const dir = tmpDir();
    writeRecipe(dir, makeRecipe({ id: 'found' }));
    const { recipe } = resolveRecipeById('found', ['/nonexistent/path', dir]);
    assert.equal(recipe.id, 'found');
  });
});

// ===========================================================================
// 2. Recipe Runner: resolveInputs
// ===========================================================================

describe('Recipe Runner: resolveInputs', () => {
  it('validates and resolves string inputs', () => {
    const recipe = makeRecipe();
    const { resolved } = resolveInputs(recipe, { target: 'hello' });
    assert.equal(resolved.target, 'hello');
  });

  it('rejects input that does not match pattern', () => {
    const recipe = makeRecipe();
    assert.throws(
      () => resolveInputs(recipe, { target: 'INVALID!' }),
      (err) => err.message.includes('Does not match pattern') || err.message.includes('does not match'),
    );
  });

  it('rejects missing required input', () => {
    const recipe = makeRecipe();
    assert.throws(
      () => resolveInputs(recipe, {}),
      (err) => err.message.includes('Missing required'),
    );
  });

  it('rejects unknown input', () => {
    const recipe = makeRecipe();
    assert.throws(
      () => resolveInputs(recipe, { target: 'hello', unknown: 'bad' }),
      (err) => err.message.includes('Unknown input'),
    );
  });

  it('validates enum inputs', () => {
    const recipe = makeRecipe({
      inputs: { env: { type: 'string', enum: ['dev', 'staging'] } },
    });
    const { resolved } = resolveInputs(recipe, { env: 'dev' });
    assert.equal(resolved.env, 'dev');
    assert.throws(() => resolveInputs(recipe, { env: 'invalid' }));
  });

  it('validates integer inputs with range', () => {
    const recipe = makeRecipe({
      inputs: { count: { type: 'integer', min: 1, max: 10 } },
    });
    const { resolved } = resolveInputs(recipe, { count: '5' });
    assert.equal(resolved.count, 5);
    assert.throws(() => resolveInputs(recipe, { count: '0' }));
    assert.throws(() => resolveInputs(recipe, { count: '11' }));
  });

  it('validates boolean inputs', () => {
    const recipe = makeRecipe({
      inputs: { verbose: { type: 'boolean' } },
    });
    const { resolved: r1 } = resolveInputs(recipe, { verbose: 'true' });
    assert.equal(r1.verbose, true);
    const { resolved: r2 } = resolveInputs(recipe, { verbose: 'false' });
    assert.equal(r2.verbose, false);
    assert.throws(() => resolveInputs(recipe, { verbose: 'maybe' }));
  });
});

// ===========================================================================
// 3. Recipe Runner: runRecipeById (dry-run)
// ===========================================================================

describe('Recipe Runner: runRecipeById', () => {
  it('dry-run returns safe result', async () => {
    const dir = tmpDir();
    writeRecipe(dir, makeRecipe({ id: 'echo-recipe' }));
    const result = await runRecipeById('echo-recipe', {
      inputs: { target: 'hello' },
      searchDirs: [dir],
      dryRunOnly: true,
    });
    assert.equal(result.status, 'dry_run');
    assert.equal(result.safe, true);
    assert.equal(result.steps.length, 1);
  });

  it('dry-run with dangerous command is not safe', async () => {
    const dir = tmpDir();
    writeRecipe(dir, makeRecipe({
      id: 'dangerous-recipe',
      steps: [{ id: 's1', description: 'rm', run: { command: 'rm', args: ['-rf', '/'], mode: 'structured' } }],
    }));
    const result = await runRecipeById('dangerous-recipe', {
      inputs: { target: 'anything' },
      searchDirs: [dir],
      dryRunOnly: true,
    });
    assert.equal(result.status, 'dry_run');
    assert.equal(result.safe, false);
  });
});

// ===========================================================================
// 4. Recipe Install: ensureRegistryDir
// ===========================================================================

describe('Recipe Install: ensureRegistryDir', () => {
  it('creates directory if it does not exist', () => {
    const dir = join(tmpDir(), 'registry');
    const result = ensureRegistryDir(dir);
    assert.ok(existsSync(result));
  });

  it('returns existing directory', () => {
    const dir = tmpDir();
    const result = ensureRegistryDir(dir);
    assert.equal(result, dir);
  });
});

// ===========================================================================
// 5. Recipe Install: installFromPath
// ===========================================================================

describe('Recipe Install: installFromPath', () => {
  it('installs valid recipe', () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    const recipePath = writeRecipe(sourceDir, makeRecipe({ id: 'install-me' }));
    const result = installFromPath(recipePath, { registryDir });
    assert.equal(result.installed, true);
    assert.equal(result.id, 'install-me');
    assert.ok(existsSync(result.path));
  });

  it('returns already-installed for identical content', () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    const recipePath = writeRecipe(sourceDir, makeRecipe({ id: 'dup-recipe' }));
    installFromPath(recipePath, { registryDir });
    const result = installFromPath(recipePath, { registryDir });
    assert.equal(result.installed, false);
    assert.ok(result.note.includes('identical'));
  });

  it('blocks overwrite of same version with different content (immutable)', () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    const r1 = makeRecipe({ id: 'immut-recipe', description: 'original' });
    const r2 = makeRecipe({ id: 'immut-recipe', description: 'changed' });
    writeRecipe(sourceDir, r1);
    installFromPath(join(sourceDir, 'immut-recipe.recipe.json'), { registryDir });
    // Write modified version with same version number
    writeFileSync(join(sourceDir, 'immut-recipe.recipe.json'), JSON.stringify(r2, null, 2));
    assert.throws(
      () => installFromPath(join(sourceDir, 'immut-recipe.recipe.json'), { registryDir }),
      (err) => err.message.includes('immutable'),
    );
  });

  it('installs different versions of same recipe', () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    writeRecipe(sourceDir, makeRecipe({ id: 'multi-ver', version: '1.0.0' }));
    installFromPath(join(sourceDir, 'multi-ver.recipe.json'), { registryDir });
    writeRecipe(sourceDir, makeRecipe({ id: 'multi-ver', version: '2.0.0' }));
    const result = installFromPath(join(sourceDir, 'multi-ver.recipe.json'), { registryDir });
    assert.equal(result.installed, true);
    assert.equal(result.version, '2.0.0');
  });
});

// ===========================================================================
// 6. Recipe Install: listInstalled
// ===========================================================================

describe('Recipe Install: listInstalled', () => {
  it('lists installed recipes', () => {
    const registryDir = join(tmpDir(), 'registry');
    const recipePath = join(tmpDir(), 'r.recipe.json');
    writeFileSync(recipePath, JSON.stringify(makeRecipe({ id: 'listed-recipe' }), null, 2));
    installFromPath(recipePath, { registryDir });
    const list = listInstalled(registryDir);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'listed-recipe');
  });

  it('returns empty for nonexistent directory', () => {
    const list = listInstalled('/nonexistent/dir');
    assert.deepEqual(list, []);
  });
});

// ===========================================================================
// 7. Recipe Install: trusted sources
// ===========================================================================

describe('Recipe Install: Trusted Sources', () => {
  it('loadConfig returns empty for missing file', () => {
    const config = loadConfig('/nonexistent/config.json');
    assert.deepEqual(config.trusted_sources, []);
    assert.deepEqual(config.recipe_roots, []);
    assert.deepEqual(config.default_recipe_roots, []);
  });

  it('loadConfig reads trusted_sources', () => {
    const dir = tmpDir();
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      trusted_sources: ['https://safe.dev'],
      default_recipe_roots: ['./recipes'],
    }));
    const config = loadConfig(configPath);
    assert.deepEqual(config.trusted_sources, ['https://safe.dev']);
    assert.deepEqual(config.default_recipe_roots, ['./recipes']);
  });

  it('checkTrustedSource: empty list rejects all remote sources', () => {
    assert.equal(checkTrustedSource('https://any.dev/recipe.json', []), false);
  });

  it('checkTrustedSource: matches prefix', () => {
    assert.equal(checkTrustedSource('https://safe.dev/recipes/a.json', ['https://safe.dev']), true);
    assert.equal(checkTrustedSource('https://evil.dev/recipes/a.json', ['https://safe.dev']), false);
  });

  it('installFromUrl rejects when no trusted sources are configured', async () => {
    await assert.rejects(
      () => installFromUrl('https://safe.dev/recipes/a.json', {
        configPath: '/nonexistent/config.json',
        registryDir: join(tmpDir(), 'registry'),
      }),
      /No trusted sources configured/,
    );
  });

  it('installFromUrl fetches and installs from a trusted source via the remote loader', async () => {
    const recipe = makeRecipe({ id: 'remote-recipe' });
    const registryDir = join(tmpDir(), 'registry');
    const configDir = tmpDir();
    const configPath = join(configDir, 'config.json');
    const baseUrl = 'https://safe.dev';
    let requestedUrl = null;
    writeFileSync(configPath, JSON.stringify({ trusted_sources: [baseUrl] }));

    const result = await installFromUrl(`${baseUrl}/recipes/remote-recipe.recipe.json`, {
      configPath,
      registryDir,
      loadRemoteRecipe: async (url) => {
        requestedUrl = url;
        return recipe;
      },
    });

    assert.equal(requestedUrl, `${baseUrl}/recipes/remote-recipe.recipe.json`);
    assert.equal(result.installed, true);
    assert.equal(result.id, 'remote-recipe');
    assert.ok(existsSync(result.path));
  });
});

// ===========================================================================
// 8. Verify: runFullVerification
// ===========================================================================

describe('Verify: runFullVerification', () => {
  it('returns checks array with results', async () => {
    const result = await runFullVerification();
    assert.ok(Array.isArray(result.checks));
    assert.ok(result.checks.length >= 5);
    for (const c of result.checks) {
      assert.ok(typeof c.name === 'string');
      assert.ok(typeof c.passed === 'boolean');
      assert.ok(typeof c.detail === 'string');
    }
  });

  it('core checks pass in healthy environment', async () => {
    const result = await runFullVerification();
    const coreModules = result.checks.find(c => c.name === 'core_modules');
    assert.ok(coreModules.passed, `core_modules failed: ${coreModules.detail}`);

    const signing = result.checks.find(c => c.name === 'signing_roundtrip');
    assert.ok(signing.passed, `signing_roundtrip failed: ${signing.detail}`);

    const safeDefaults = result.checks.find(c => c.name === 'safe_defaults');
    assert.ok(safeDefaults.passed, `safe_defaults failed: ${safeDefaults.detail}`);

    const risk = result.checks.find(c => c.name === 'risk_classification');
    assert.ok(risk.passed, `risk_classification failed: ${risk.detail}`);

    const danger = result.checks.find(c => c.name === 'dangerous_detection');
    assert.ok(danger.passed, `dangerous_detection failed: ${danger.detail}`);
  });
});

// ===========================================================================
// 9. Demo Scenarios: listScenarios
// ===========================================================================

describe('Demo Scenarios: listScenarios', () => {
  it('returns all scenarios', () => {
    const scenarios = listScenarios();
    assert.ok(scenarios.length >= 4);
    const ids = scenarios.map(s => s.id);
    assert.ok(ids.includes('drift'));
    assert.ok(ids.includes('recipe'));
    assert.ok(ids.includes('trust'));
    assert.ok(ids.includes('blocked'));
  });

  it('each scenario has id, name, description', () => {
    for (const s of listScenarios()) {
      assert.ok(typeof s.id === 'string');
      assert.ok(typeof s.name === 'string');
      assert.ok(typeof s.description === 'string');
    }
  });
});

// ===========================================================================
// 10. Versioned Storage
// ===========================================================================

describe('Versioned Recipe Storage', () => {
  it('installs to <id>/<version>.json path', () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    writeRecipe(sourceDir, makeRecipe({ id: 'ver-test', version: '1.0.0' }));
    const result = installFromPath(join(sourceDir, 'ver-test.recipe.json'), { registryDir });
    assert.ok(result.path.includes('ver-test/1.0.0.json'));
  });

  it('multiple versions stored side by side', () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    writeRecipe(sourceDir, makeRecipe({ id: 'multi', version: '1.0.0' }));
    installFromPath(join(sourceDir, 'multi.recipe.json'), { registryDir });
    writeRecipe(sourceDir, makeRecipe({ id: 'multi', version: '1.1.0' }));
    installFromPath(join(sourceDir, 'multi.recipe.json'), { registryDir });
    writeRecipe(sourceDir, makeRecipe({ id: 'multi', version: '2.0.0' }));
    installFromPath(join(sourceDir, 'multi.recipe.json'), { registryDir });

    const versions = listVersions('multi', registryDir);
    assert.deepEqual(versions, ['1.0.0', '1.1.0', '2.0.0']);
  });

  it('listInstalled finds versioned recipes', () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    writeRecipe(sourceDir, makeRecipe({ id: 'listed-v', version: '1.0.0' }));
    installFromPath(join(sourceDir, 'listed-v.recipe.json'), { registryDir });
    writeRecipe(sourceDir, makeRecipe({ id: 'listed-v', version: '2.0.0' }));
    installFromPath(join(sourceDir, 'listed-v.recipe.json'), { registryDir });

    const list = listInstalled(registryDir);
    assert.equal(list.length, 2);
    assert.ok(list.some(r => r.version === '1.0.0'));
    assert.ok(list.some(r => r.version === '2.0.0'));
  });
});

// ===========================================================================
// 11. Version Resolution (parseRecipeSpecifier)
// ===========================================================================

describe('Recipe Version Resolution', () => {
  it('parses id without version', () => {
    const { parseRecipeSpecifier } = require_runner();
    const result = parseRecipeSpecifier('git-branch-cleanup');
    assert.equal(result.id, 'git-branch-cleanup');
    assert.equal(result.version, null);
  });

  it('parses id@version', () => {
    const { parseRecipeSpecifier } = require_runner();
    const result = parseRecipeSpecifier('git-branch-cleanup@1.2.0');
    assert.equal(result.id, 'git-branch-cleanup');
    assert.equal(result.version, '1.2.0');
  });

  it('resolves latest version when no version specified', () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    writeRecipe(sourceDir, makeRecipe({ id: 'res-test', version: '1.0.0' }));
    installFromPath(join(sourceDir, 'res-test.recipe.json'), { registryDir });
    writeRecipe(sourceDir, makeRecipe({ id: 'res-test', version: '2.0.0' }));
    installFromPath(join(sourceDir, 'res-test.recipe.json'), { registryDir });

    const { resolveRecipeById } = require_runner();
    const result = resolveRecipeById('res-test', [registryDir]);
    assert.equal(result.version, '2.0.0');
  });

  it('resolves pinned version', () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    writeRecipe(sourceDir, makeRecipe({ id: 'pin-test', version: '1.0.0' }));
    installFromPath(join(sourceDir, 'pin-test.recipe.json'), { registryDir });
    writeRecipe(sourceDir, makeRecipe({ id: 'pin-test', version: '2.0.0' }));
    installFromPath(join(sourceDir, 'pin-test.recipe.json'), { registryDir });

    const { resolveRecipeById } = require_runner();
    const result = resolveRecipeById('pin-test@1.0.0', [registryDir]);
    assert.equal(result.version, '1.0.0');
  });

  it('throws on unknown version', () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    writeRecipe(sourceDir, makeRecipe({ id: 'noversion', version: '1.0.0' }));
    installFromPath(join(sourceDir, 'noversion.recipe.json'), { registryDir });

    const { resolveRecipeById } = require_runner();
    assert.throws(
      () => resolveRecipeById('noversion@9.9.9', [registryDir]),
      (err) => err.message.includes('version 9.9.9 not found'),
    );
  });

  it('recipe supervisor drifts when latest version changes for an unpinned specifier', async () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    const manifestDir = join(tmpDir(), '.guardrail', 'recipes');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'latest-test.approved.json');

    const v1 = makeRecipe({ id: 'latest-test', version: '1.0.0', channel: 'verified' });
    const v1Path = writeRecipe(sourceDir, v1);
    installFromPath(v1Path, { registryDir });
    const { recipe: resolvedV1, sourcePath: installedV1Path } = resolveRecipeById('latest-test', [registryDir]);

    const manifest = createRecipeManifest(
      resolvedV1,
      hashRecipe(resolvedV1),
      { trustClass: 'pinned_external', riskLevel: 'green', reasons: ['recipe declares low risk'] },
      { target: 'hello' },
      {
        cwd: registryDir,
        projectRoot: registryDir,
        sourcePath: installedV1Path,
        requestedVersion: null,
        allowUnverified: false,
      },
    );
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    saveManifest(manifest, manifestPath);

    writeRecipe(sourceDir, makeRecipe({ id: 'latest-test', version: '2.0.0', channel: 'verified' }));
    installFromPath(join(sourceDir, 'latest-test.recipe.json'), { registryDir });

    const result = await runRecipeSupervisor({
      specifier: 'latest-test',
      inputs: { target: 'hello' },
      cwd: registryDir,
      searchDirs: [registryDir],
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'drift_detected');
    assert.equal(result.recipeVersion, '2.0.0');
  });

  it('recipe supervisor keeps a pinned version stable when newer versions appear', async () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    const manifestDir = join(tmpDir(), '.guardrail', 'recipes');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'pin-stable.approved.json');

    const v1 = makeRecipe({ id: 'pin-stable', version: '1.0.0', channel: 'verified' });
    const v1Path = writeRecipe(sourceDir, v1);
    installFromPath(v1Path, { registryDir });
    const { recipe: resolvedV1, sourcePath: installedV1Path } = resolveRecipeById('pin-stable@1.0.0', [registryDir]);

    const manifest = createRecipeManifest(
      resolvedV1,
      hashRecipe(resolvedV1),
      { trustClass: 'pinned_external', riskLevel: 'green', reasons: ['recipe declares low risk'] },
      { target: 'hello' },
      {
        cwd: registryDir,
        projectRoot: registryDir,
        sourcePath: installedV1Path,
        requestedVersion: '1.0.0',
        allowUnverified: false,
      },
    );
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    saveManifest(manifest, manifestPath);

    writeRecipe(sourceDir, makeRecipe({ id: 'pin-stable', version: '2.0.0', channel: 'verified' }));
    installFromPath(join(sourceDir, 'pin-stable.recipe.json'), { registryDir });

    const result = await runRecipeSupervisor({
      specifier: 'pin-stable@1.0.0',
      inputs: { target: 'hello' },
      cwd: registryDir,
      searchDirs: [registryDir],
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'success');
    assert.equal(result.recipeVersion, '1.0.0');
  });

  it('recipe supervisor detects content drift for input_files even when the file path is unchanged', async () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    const manifestDir = join(tmpDir(), '.guardrail', 'recipes');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'claude-input-files.approved.json');
    const workspaceDir = join(registryDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    const promptFile = join(workspaceDir, 'prompt.txt');
    writeFileSync(promptFile, 'Original prompt\n');

    const recipe = makeRecipe({
      id: 'claude-input-files',
      inputs: {
        input_files: {
          type: 'string',
          approval_mode: 'list',
          content_hash: true,
          base_dir_input: 'working_dir',
          item_validator: {
            type: 'string',
            approval_mode: 'path_policy',
            rules: { must_be_relative: true, deny_segments: ['..'], max_depth: 8 },
          },
        },
        working_dir: {
          type: 'string',
          approval_mode: 'path_policy',
          rules: { must_be_relative: true, deny_segments: ['..'], max_depth: 8 },
        },
      },
      steps: [{ id: 's1', description: 'echo', run: { command: 'echo', args: ['ok'], mode: 'structured' } }],
      approval_required: true,
      risk_level: 'medium',
    });
    const recipePath = writeRecipe(sourceDir, recipe);
    installFromPath(recipePath, { registryDir });
    const { recipe: installedRecipe, sourcePath } = resolveRecipeById('claude-input-files', [registryDir]);

    const manifest = createRecipeManifest(
      installedRecipe,
      hashRecipe(installedRecipe),
      { trustClass: 'unknown', riskLevel: 'red', reasons: ['recipe declares medium risk'] },
      { input_files: ['prompt.txt'], working_dir: 'workspace' },
      {
        cwd: registryDir,
        projectRoot: registryDir,
        sourcePath,
        inputContentHashes: collectRecipeInputContentHashes(installedRecipe, { input_files: ['prompt.txt'], working_dir: 'workspace' }, { cwd: registryDir }),
      },
    );
    manifest.riskAssessment.acknowledgedBy = 'test';
    manifest.riskAssessment.acknowledgedAt = new Date().toISOString();
    saveManifest(manifest, manifestPath);

    writeFileSync(promptFile, 'Changed prompt\n');

    const result = await runRecipeSupervisor({
      specifier: 'claude-input-files',
      inputs: { input_files: ['prompt.txt'], working_dir: 'workspace' },
      cwd: registryDir,
      searchDirs: [registryDir],
      manifestPath,
      nonInteractive: true,
      jsonOutput: true,
    });

    assert.equal(result.status, 'drift_detected');
  });
});

// ===========================================================================
// 12. Runbook (sequential multi-recipe)
// ===========================================================================

describe('Runbook: Sequential Multi-Recipe', () => {
  it('dry-runs a sequence of recipes', async () => {
    const sourceDir = tmpDir();
    const registryDir = join(tmpDir(), 'registry');
    writeRecipe(sourceDir, makeRecipe({ id: 'step-a', version: '1.0.0' }));
    installFromPath(join(sourceDir, 'step-a.recipe.json'), { registryDir });
    writeRecipe(sourceDir, makeRecipe({ id: 'step-b', version: '1.0.0' }));
    installFromPath(join(sourceDir, 'step-b.recipe.json'), { registryDir });

    const { runRunbook } = require_runner();
    const result = await runRunbook(
      [
        { recipe: 'step-a', inputs: { target: 'hello' } },
        { recipe: 'step-b', inputs: { target: 'world' } },
      ],
      { searchDirs: [registryDir], dryRunOnly: true },
    );
    assert.equal(result.status, 'success');
    assert.equal(result.stepsCompleted, 2);
  });

  it('stops on first failure', async () => {
    const registryDir = join(tmpDir(), 'registry');
    const { runRunbook } = require_runner();
    const result = await runRunbook(
      [
        { recipe: 'nonexistent', inputs: {} },
        { recipe: 'also-nonexistent', inputs: {} },
      ],
      { searchDirs: [registryDir], dryRunOnly: true },
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.failedStep, 1);
  });
});

// Helper to import recipe-runner (ESM dynamic import workaround for sync tests)
function require_runner() {
  // We already imported at the top — just re-export the needed functions
  return { parseRecipeSpecifier, resolveRecipeById, runRunbook };
}
