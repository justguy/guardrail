import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { resolveRecipeById, resolveInputs, runRecipeById, parseRecipeSpecifier, runRunbook } from '../src/recipe-runner.js';
import { ensureRegistryDir, installFromPath, installFromUrl, listInstalled, listVersions, loadConfig, checkTrustedSource } from '../src/recipe-install.js';
import { runRecipeSupervisor } from '../src/recipe-supervisor.js';
import { createRecipeManifest, hashRecipe } from '../src/recipe.js';
import { saveManifest } from '../src/manifest.js';
import { signRecipe } from '../src/recipe-channel.js';
import { runFullVerification } from '../src/verify.js';
import { listScenarios } from '../src/demo-scenarios.js';

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
    const resolved = resolveInputs(recipe, { target: 'hello' });
    assert.equal(resolved.target, 'hello');
  });

  it('rejects input that does not match pattern', () => {
    const recipe = makeRecipe();
    assert.throws(
      () => resolveInputs(recipe, { target: 'INVALID!' }),
      (err) => err.message.includes('does not match pattern'),
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
    assert.equal(resolveInputs(recipe, { env: 'dev' }).env, 'dev');
    assert.throws(() => resolveInputs(recipe, { env: 'production' }));
  });

  it('validates integer inputs with range', () => {
    const recipe = makeRecipe({
      inputs: { count: { type: 'integer', min: 1, max: 10 } },
    });
    assert.equal(resolveInputs(recipe, { count: '5' }).count, 5);
    assert.throws(() => resolveInputs(recipe, { count: '0' }));
    assert.throws(() => resolveInputs(recipe, { count: '11' }));
  });

  it('validates boolean inputs', () => {
    const recipe = makeRecipe({
      inputs: { verbose: { type: 'boolean' } },
    });
    assert.equal(resolveInputs(recipe, { verbose: 'true' }).verbose, true);
    assert.equal(resolveInputs(recipe, { verbose: 'false' }).verbose, false);
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
  });

  it('loadConfig reads trusted_sources', () => {
    const dir = tmpDir();
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ trusted_sources: ['https://safe.dev'] }));
    const config = loadConfig(configPath);
    assert.deepEqual(config.trusted_sources, ['https://safe.dev']);
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
