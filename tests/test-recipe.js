import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  validateRecipe,
  RecipeValidationError,
  loadRecipe,
  hashRecipe,
  createRecipeManifest,
  compareRecipeManifests,
  packRecipe,
  writePackedRecipe,
  loadPackedRecipe,
} from '../src/recipe.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-recipe-')));
}

function makeRecipe(overrides = {}) {
  return {
    id: 'test-recipe',
    name: 'Test Recipe',
    description: 'A test recipe for validation',
    version: '1.0.0',
    author: 'test-author',
    inputs: {
      target: { type: 'string', pattern: '^[a-z]+$', description: 'Target name' },
    },
    steps: [
      {
        id: 'step-1',
        description: 'Run the command',
        run: { command: 'echo', args: ['{{inputs.target}}'], mode: 'structured' },
      },
    ],
    guardrails: {
      constraints: ['Must run in structured mode'],
      invariants: ['No shell execution'],
    },
    approval_required: true,
    risk_level: 'medium',
    ...overrides,
  };
}

function writeRecipeFile(dir, recipe, filename = 'test.recipe.json') {
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(recipe, null, 2));
  return path;
}

// ===========================================================================
// 1. Schema Validation — Required Fields
// ===========================================================================

describe('Recipe: Schema Validation', () => {
  it('valid recipe passes validation', () => {
    assert.doesNotThrow(() => validateRecipe(makeRecipe()));
  });

  it('id must be kebab-case', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({ id: 'Invalid ID!' })),
      (err) => err.errors.some(e => e.includes('id')),
    );
  });

  it('name must be non-empty string', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({ name: '' })),
      (err) => err.errors.some(e => e.includes('name')),
    );
  });

  it('description must be non-empty string', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({ description: '' })),
      (err) => err.errors.some(e => e.includes('description')),
    );
  });

  it('version must be valid semver', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({ version: 'not-semver' })),
      (err) => err.errors.some(e => e.includes('version')),
    );
  });

  it('version with prerelease is valid', () => {
    assert.doesNotThrow(() => validateRecipe(makeRecipe({ version: '2.0.0-beta.1' })));
  });

  it('author as string is valid', () => {
    assert.doesNotThrow(() => validateRecipe(makeRecipe({ author: 'Jane Doe' })));
  });

  it('author as object with name is valid', () => {
    assert.doesNotThrow(() => validateRecipe(makeRecipe({ author: { name: 'Jane', email: 'j@e.com' } })));
  });

  it('author must be present', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({ author: '' })),
      (err) => err.errors.some(e => e.includes('author')),
    );
  });

  it('approval_required must be boolean', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({ approval_required: 'yes' })),
      (err) => err.errors.some(e => e.includes('approval_required')),
    );
  });

  it('risk_level must be low, medium, or high', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({ risk_level: 'critical' })),
      (err) => err.errors.some(e => e.includes('risk_level')),
    );
  });

  it('risk_level: low is valid', () => {
    assert.doesNotThrow(() => validateRecipe(makeRecipe({ risk_level: 'low' })));
  });

  it('risk_level: high is valid', () => {
    assert.doesNotThrow(() => validateRecipe(makeRecipe({ risk_level: 'high' })));
  });
});

// ===========================================================================
// 2. Input Validation
// ===========================================================================

describe('Recipe: Input Schema Validation', () => {
  it('string input requires pattern or enum', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({
        inputs: { bare: { type: 'string' } },
      })),
      (err) => err.errors.some(e => e.includes('pattern') || e.includes('enum')),
    );
  });

  it('integer input with min/max is valid', () => {
    assert.doesNotThrow(() => validateRecipe(makeRecipe({
      inputs: { count: { type: 'integer', min: 1, max: 100 } },
    })));
  });

  it('boolean input is valid', () => {
    assert.doesNotThrow(() => validateRecipe(makeRecipe({
      inputs: { verbose: { type: 'boolean' } },
    })));
  });

  it('invalid input type is rejected', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({
        inputs: { x: { type: 'float' } },
      })),
      (err) => err.errors.some(e => e.includes('type')),
    );
  });

  it('invalid regex pattern is rejected', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({
        inputs: { x: { type: 'string', pattern: '[invalid(' } },
      })),
      (err) => err.errors.some(e => e.includes('regex')),
    );
  });
});

// ===========================================================================
// 3. Step Validation
// ===========================================================================

describe('Recipe: Step Validation', () => {
  it('steps must be non-empty array', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({ steps: [] })),
      (err) => err.errors.some(e => e.includes('steps')),
    );
  });

  it('step must have id and description', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({
        steps: [{ run: { command: 'echo' } }],
      })),
      (err) => err.errors.some(e => e.includes('id')),
    );
  });

  it('step must have run block with command', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({
        steps: [{ id: 's1', description: 'test' }],
      })),
      (err) => err.errors.some(e => e.includes('run')),
    );
  });

  it('duplicate step ids rejected', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({
        steps: [
          { id: 'dup', description: 'a', run: { command: 'echo' } },
          { id: 'dup', description: 'b', run: { command: 'echo' } },
        ],
      })),
      (err) => err.errors.some(e => e.includes('duplicate')),
    );
  });

  it('shell mode in step is rejected', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({
        steps: [{ id: 's1', description: 'test', run: { command: 'echo', mode: 'shell' } }],
      })),
      (err) => err.errors.some(e => e.includes('shell')),
    );
  });

  it('structured mode is accepted', () => {
    assert.doesNotThrow(() => validateRecipe(makeRecipe()));
  });
});

// ===========================================================================
// 4. Guardrails Validation
// ===========================================================================

describe('Recipe: Guardrails Validation', () => {
  it('guardrails must be an object', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({ guardrails: 'invalid' })),
      (err) => err.errors.some(e => e.includes('guardrails')),
    );
  });

  it('constraints must be strings', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({ guardrails: { constraints: [42] } })),
      (err) => err.errors.some(e => e.includes('constraints')),
    );
  });

  it('invariants must be strings', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({ guardrails: { invariants: [null] } })),
      (err) => err.errors.some(e => e.includes('invariants')),
    );
  });

  it('empty guardrails object is valid', () => {
    assert.doesNotThrow(() => validateRecipe(makeRecipe({ guardrails: {} })));
  });
});

// ===========================================================================
// 5. Load from File
// ===========================================================================

describe('Recipe: Load from File', () => {
  it('loads and validates a valid recipe', () => {
    const dir = tmpDir();
    const path = writeRecipeFile(dir, makeRecipe());
    const recipe = loadRecipe(path);
    assert.equal(recipe.id, 'test-recipe');
    assert.equal(recipe.version, '1.0.0');
  });

  it('rejects invalid JSON', () => {
    const dir = tmpDir();
    const path = join(dir, 'bad.json');
    writeFileSync(path, 'NOT JSON{{{');
    assert.throws(() => loadRecipe(path), (err) => err.message.includes('Invalid JSON'));
  });

  it('rejects invalid recipe schema', () => {
    const dir = tmpDir();
    const path = writeRecipeFile(dir, { id: 'bad' }); // missing required fields
    assert.throws(() => loadRecipe(path), (err) => err.name === 'RecipeValidationError');
  });

  it('loads the example npm-publish recipe', () => {
    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'npm-publish.recipe.json'));
    assert.equal(recipe.id, 'npm-publish');
    assert.equal(recipe.version, '1.0.0');
    assert.equal(recipe.risk_level, 'high');
    assert.equal(recipe.approval_required, true);
    assert.equal(recipe.steps.length, 4);
  });
});

// ===========================================================================
// 6. Hashing
// ===========================================================================

describe('Recipe: Content Hashing', () => {
  it('same recipe produces same hash', () => {
    const recipe = makeRecipe();
    assert.equal(hashRecipe(recipe), hashRecipe(recipe));
  });

  it('different version produces different hash', () => {
    const r1 = makeRecipe({ version: '1.0.0' });
    const r2 = makeRecipe({ version: '2.0.0' });
    assert.notEqual(hashRecipe(r1), hashRecipe(r2));
  });

  it('different steps produce different hash', () => {
    const r1 = makeRecipe();
    const r2 = makeRecipe({
      steps: [{ id: 'other', description: 'other', run: { command: 'ls' } }],
    });
    assert.notEqual(hashRecipe(r1), hashRecipe(r2));
  });

  it('hash is 64-char hex string (SHA-256)', () => {
    const hash = hashRecipe(makeRecipe());
    assert.equal(hash.length, 64);
    assert.ok(/^[a-f0-9]{64}$/.test(hash));
  });

  it('extra fields do not affect hash', () => {
    const r1 = makeRecipe();
    const r2 = { ...makeRecipe(), extra_field: 'ignored' };
    assert.equal(hashRecipe(r1), hashRecipe(r2));
  });
});

// ===========================================================================
// 7. Pack + Unpack Round-Trip
// ===========================================================================

describe('Recipe: Pack and Inspect', () => {
  it('packRecipe produces valid packaged artifact', () => {
    const packed = packRecipe(makeRecipe());
    assert.equal(packed.schema_version, 1);
    assert.equal(packed.immutable, true);
    assert.equal(typeof packed.content_hash, 'string');
    assert.equal(typeof packed.packed_at, 'string');
    assert.equal(packed.recipe.id, 'test-recipe');
  });

  it('write + load round-trip preserves content', () => {
    const dir = tmpDir();
    const packed = packRecipe(makeRecipe());
    const outputPath = join(dir, 'test.packed.json');
    writePackedRecipe(packed, outputPath);

    const loaded = loadPackedRecipe(outputPath);
    assert.equal(loaded.verified, true);
    assert.equal(loaded.recipe.id, 'test-recipe');
    assert.equal(loaded.contentHash, packed.content_hash);
  });

  it('tampered packed recipe fails verification', () => {
    const dir = tmpDir();
    const packed = packRecipe(makeRecipe());
    const outputPath = join(dir, 'tampered.packed.json');
    writePackedRecipe(packed, outputPath);

    // Tamper with the recipe content
    const raw = JSON.parse(readFileSync(outputPath, 'utf8'));
    raw.recipe.name = 'TAMPERED';
    writeFileSync(outputPath, JSON.stringify(raw));

    const loaded = loadPackedRecipe(outputPath);
    assert.equal(loaded.verified, false);
  });

  it('immutability: same version + different content = different hash', () => {
    const r1 = makeRecipe({ description: 'version A' });
    const r2 = makeRecipe({ description: 'version B' });
    const p1 = packRecipe(r1);
    const p2 = packRecipe(r2);
    assert.notEqual(p1.content_hash, p2.content_hash);
  });
});

// ===========================================================================
// 8. RecipeValidationError
// ===========================================================================

describe('Recipe: Error Structure', () => {
  it('RecipeValidationError has errors array', () => {
    try {
      validateRecipe({ id: 'bad' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.equal(err.name, 'RecipeValidationError');
      assert.ok(Array.isArray(err.errors));
      assert.ok(err.errors.length > 0);
    }
  });

  it('collects all errors, not just first', () => {
    try {
      validateRecipe({});
      assert.fail('Should have thrown');
    } catch (err) {
      // Missing id, name, description, version, author, approval_required, risk_level, inputs, steps, guardrails
      assert.ok(err.errors.length >= 5, `Expected many errors, got ${err.errors.length}`);
    }
  });
});

// ===========================================================================
// 9. Recipe Manifest Semantics
// ===========================================================================

describe('Recipe: Manifest Semantics', () => {
  it('stores requestedVersion and resolutionMode for pinned executions', () => {
    const recipe = makeRecipe({ version: '2.1.0', channel: 'verified' });
    const manifest = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      { trustClass: 'pinned_external', riskLevel: 'green', reasons: ['recipe declares low risk'] },
      { target: 'hello' },
      {
        cwd: '/repo',
        projectRoot: '/repo',
        sourcePath: '/repo/recipes/test-recipe.recipe.json',
        requestedVersion: '2.1.0',
        allowUnverified: false,
      },
    );

    assert.equal(manifest.kind, 'recipe');
    assert.equal(manifest.recipe.requestedVersion, '2.1.0');
    assert.equal(manifest.recipe.resolutionMode, 'pinned');
  });

  it('treats resolved input changes as drift', () => {
    const recipe = makeRecipe();
    const base = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      { trustClass: 'unknown', riskLevel: 'red', reasons: ['recipe declares medium risk'] },
      { target: 'hello' },
      { cwd: '/repo', projectRoot: '/repo', sourcePath: '/repo/recipes/test.recipe.json' },
    );

    const changed = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      { trustClass: 'unknown', riskLevel: 'red', reasons: ['recipe declares medium risk'] },
      { target: 'world' },
      { cwd: '/repo', projectRoot: '/repo', sourcePath: '/repo/recipes/test.recipe.json' },
    );

    const comparison = compareRecipeManifests(changed, base);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.diffs.some(d => d.includes('input "target"')));
  });

  it('treats pinned-vs-latest resolution mode as drift even for same resolved version', () => {
    const recipe = makeRecipe({ version: '1.0.0' });
    const latestManifest = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      { trustClass: 'unknown', riskLevel: 'red', reasons: ['recipe declares medium risk'] },
      { target: 'hello' },
      { cwd: '/repo', projectRoot: '/repo', sourcePath: '/repo/recipes/test.recipe.json' },
    );
    const pinnedManifest = createRecipeManifest(
      recipe,
      hashRecipe(recipe),
      { trustClass: 'unknown', riskLevel: 'red', reasons: ['recipe declares medium risk'] },
      { target: 'hello' },
      { cwd: '/repo', projectRoot: '/repo', sourcePath: '/repo/recipes/test.recipe.json', requestedVersion: '1.0.0' },
    );

    const comparison = compareRecipeManifests(pinnedManifest, latestManifest);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.diffs.some(d => d.includes('resolutionMode')));
  });
});
