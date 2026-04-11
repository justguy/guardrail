import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  const dir = join(tmpdir(), `guardrail-test-pub-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeValidRecipe(overrides = {}) {
  return {
    id: 'test-recipe',
    name: 'Test Recipe',
    description: 'A test recipe for unit tests',
    version: '1.0.0',
    author: 'tester',
    approval_required: true,
    risk_level: 'medium',
    category: 'custom',
    channel: 'community',
    inputs: {},
    steps: [{
      id: 'main',
      description: 'echo hello',
      run: { command: 'echo', args: ['hello'], mode: 'structured' },
    }],
    guardrails: { constraints: [], invariants: ['mode: structured'] },
    ...overrides,
  };
}

function makeStructuredManifest(overrides = {}) {
  return {
    contract: {
      command: 'npm',
      args: ['install', '--save-dev'],
      mode: 'structured',
      writablePaths: ['./node_modules'],
      allowedBinaries: ['npm'],
      ...overrides.contract,
    },
    riskAssessment: {
      riskLevel: 'yellow',
      ...overrides.riskAssessment,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// scrubPersonalData
// ---------------------------------------------------------------------------

describe('scrubPersonalData', async () => {
  const { scrubPersonalData } = await import('../src/recipe-publish.js');

  it('replaces /Users/alice/... with {{working_dir}} in description', () => {
    const recipe = makeValidRecipe({ description: 'Run from /Users/alice/project' });
    const scrubbed = scrubPersonalData(recipe);
    assert.equal(scrubbed.description, 'Run from {{working_dir}}/project');
  });

  it('replaces /home/bob/... with {{working_dir}} in description', () => {
    const recipe = makeValidRecipe({ description: 'Deploy /home/bob/app' });
    const scrubbed = scrubPersonalData(recipe);
    assert.equal(scrubbed.description, 'Deploy {{working_dir}}/app');
  });

  it('replaces C:\\Users\\... with {{working_dir}} in description', () => {
    const recipe = makeValidRecipe({ description: 'Build at C:\\Users\\charlie\\project' });
    const scrubbed = scrubPersonalData(recipe);
    assert.equal(scrubbed.description, 'Build at {{working_dir}}\\project');
  });

  it('handles multiple path occurrences', () => {
    const recipe = makeValidRecipe({
      description: '/Users/alice/a and /Users/alice/b',
    });
    const scrubbed = scrubPersonalData(recipe);
    assert.ok(!scrubbed.description.includes('/Users/alice'));
    assert.ok(scrubbed.description.includes('{{working_dir}}'));
  });

  it('replaces approved_by with ["author"]', () => {
    const recipe = makeValidRecipe();
    recipe.approved_by = ['alice@example.com'];
    const scrubbed = scrubPersonalData(recipe);
    assert.deepEqual(scrubbed.approved_by, ['author']);
  });

  it('replaces acknowledgedBy with "author"', () => {
    const recipe = makeValidRecipe();
    recipe.acknowledgedBy = 'alice@example.com';
    const scrubbed = scrubPersonalData(recipe);
    assert.equal(scrubbed.acknowledgedBy, 'author');
  });

  it('nulls approvedAt and acknowledgedAt', () => {
    const recipe = makeValidRecipe();
    recipe.approvedAt = '2026-01-01T00:00:00Z';
    recipe.acknowledgedAt = '2026-01-01T00:00:00Z';
    const scrubbed = scrubPersonalData(recipe);
    assert.equal(scrubbed.approvedAt, null);
    assert.equal(scrubbed.acknowledgedAt, null);
  });

  it('rejects user-specific paths in executable fields', () => {
    const recipe = makeValidRecipe();
    recipe.steps[0].run.args = ['/Users/alice/script.sh'];
    assert.throws(
      () => scrubPersonalData(recipe),
      /cannot safely scrub.*executable fields/
    );
  });

  it('preserves recipe structure after scrub', () => {
    const recipe = makeValidRecipe();
    const scrubbed = scrubPersonalData(recipe);
    assert.equal(scrubbed.id, recipe.id);
    assert.equal(scrubbed.name, recipe.name);
    assert.equal(scrubbed.version, recipe.version);
    assert.deepEqual(scrubbed.steps, recipe.steps);
    assert.deepEqual(scrubbed.guardrails, recipe.guardrails);
  });

  it('handles recipe with no personal data (no-op)', () => {
    const recipe = makeValidRecipe();
    const scrubbed = scrubPersonalData(recipe);
    assert.equal(scrubbed.description, recipe.description);
  });

  it('scrubs author field containing user path', () => {
    const recipe = makeValidRecipe({ author: '/Users/alice' });
    const scrubbed = scrubPersonalData(recipe);
    assert.equal(scrubbed.author, '{{working_dir}}');
  });

  it('scrubs input default containing user path', () => {
    const recipe = makeValidRecipe({
      inputs: {
        dir: { type: 'string', pattern: '^.*$', default: '/Users/alice/project', description: 'Working dir' },
      },
    });
    const scrubbed = scrubPersonalData(recipe);
    assert.equal(scrubbed.inputs.dir.default, '{{working_dir}}');
  });

  it('scrubs input description containing user path', () => {
    const recipe = makeValidRecipe({
      inputs: {
        dir: { type: 'string', pattern: '^.*$', description: 'Located at /home/bob/code' },
      },
    });
    const scrubbed = scrubPersonalData(recipe);
    assert.ok(scrubbed.inputs.dir.description.includes('{{working_dir}}'));
  });

  it('rejects user-specific paths in rollback executable fields', () => {
    const recipe = makeValidRecipe({
      rollback: {
        steps: [{
          id: 'rb',
          description: 'undo',
          run: { command: 'bash', args: ['/Users/alice/undo.sh'], mode: 'structured' },
        }],
      },
    });
    assert.throws(
      () => scrubPersonalData(recipe),
      /cannot safely scrub.*executable fields/
    );
  });
});

// ---------------------------------------------------------------------------
// manifestToRecipe
// ---------------------------------------------------------------------------

describe('manifestToRecipe', async () => {
  const { manifestToRecipe } = await import('../src/recipe-publish.js');
  const { validateRecipe } = await import('../src/recipe.js');

  it('converts manifest to valid recipe', () => {
    const manifest = makeStructuredManifest();
    const recipe = manifestToRecipe(manifest, { name: 'npm-install', category: 'packages' });
    // Should not throw
    validateRecipe(recipe);
  });

  it('maps green → low', () => {
    const manifest = makeStructuredManifest({ riskAssessment: { riskLevel: 'green' } });
    const recipe = manifestToRecipe(manifest, { name: 'safe-cmd', category: 'custom' });
    assert.equal(recipe.risk_level, 'low');
  });

  it('maps yellow → medium', () => {
    const manifest = makeStructuredManifest({ riskAssessment: { riskLevel: 'yellow' } });
    const recipe = manifestToRecipe(manifest, { name: 'mid-cmd', category: 'custom' });
    assert.equal(recipe.risk_level, 'medium');
  });

  it('maps red → high', () => {
    const manifest = makeStructuredManifest({ riskAssessment: { riskLevel: 'red' } });
    const recipe = manifestToRecipe(manifest, { name: 'risky-cmd', category: 'custom' });
    assert.equal(recipe.risk_level, 'high');
  });

  it('defaults to medium when riskLevel missing', () => {
    const manifest = makeStructuredManifest({ riskAssessment: {} });
    const recipe = manifestToRecipe(manifest, { name: 'unknown-cmd', category: 'custom' });
    assert.equal(recipe.risk_level, 'medium');
  });

  it('requires --name', () => {
    const manifest = makeStructuredManifest();
    assert.throws(
      () => manifestToRecipe(manifest, { category: 'custom' }),
      /--name is required/
    );
  });

  it('requires --category', () => {
    const manifest = makeStructuredManifest();
    assert.throws(
      () => manifestToRecipe(manifest, { name: 'test' }),
      /--category is required/
    );
  });

  it('rejects shell manifests', () => {
    const manifest = makeStructuredManifest({ contract: { command: 'npm', args: [], mode: 'shell' } });
    assert.throws(
      () => manifestToRecipe(manifest, { name: 'shell-cmd', category: 'custom' }),
      /only supports structured/
    );
  });

  it('preserves command + args as structured recipe fields', () => {
    const manifest = makeStructuredManifest();
    const recipe = manifestToRecipe(manifest, { name: 'npm-install', category: 'packages' });
    assert.equal(recipe.steps[0].run.command, 'npm');
    assert.deepEqual(recipe.steps[0].run.args, ['install', '--save-dev']);
    assert.equal(recipe.steps[0].run.mode, 'structured');
  });

  it('builds guardrails from contract constraints', () => {
    const manifest = makeStructuredManifest();
    const recipe = manifestToRecipe(manifest, { name: 'npm-install', category: 'packages' });
    assert.ok(recipe.guardrails.constraints.some(c => c.includes('writable paths')));
    assert.ok(recipe.guardrails.constraints.some(c => c.includes('allowed binaries')));
    assert.ok(recipe.guardrails.invariants.includes('mode: structured'));
  });

  it('sets channel to "community"', () => {
    const manifest = makeStructuredManifest();
    const recipe = manifestToRecipe(manifest, { name: 'test', category: 'custom' });
    assert.equal(recipe.channel, 'community');
  });

  it('sets approval_required=false only for green', () => {
    const greenManifest = makeStructuredManifest({ riskAssessment: { riskLevel: 'green' } });
    const yellowManifest = makeStructuredManifest({ riskAssessment: { riskLevel: 'yellow' } });

    const greenRecipe = manifestToRecipe(greenManifest, { name: 'safe', category: 'custom' });
    const yellowRecipe = manifestToRecipe(yellowManifest, { name: 'mid', category: 'custom' });

    assert.equal(greenRecipe.approval_required, false);
    assert.equal(yellowRecipe.approval_required, true);
  });

  it('includes tags when provided', () => {
    const manifest = makeStructuredManifest();
    const recipe = manifestToRecipe(manifest, { name: 'tagged', category: 'custom', tags: ['npm', 'install'] });
    assert.deepEqual(recipe.tags, ['npm', 'install']);
  });
});

// ---------------------------------------------------------------------------
// templateToRecipe
// ---------------------------------------------------------------------------

describe('templateToRecipe', async () => {
  const { templateToRecipe } = await import('../src/recipe-publish.js');
  const { validateRecipe } = await import('../src/recipe.js');

  function makeTemplate(overrides = {}) {
    return {
      version: 1,
      kind: 'template',
      name: 'npm-publish',
      description: 'Publish a package',
      trust_class: 'reviewed_internal',
      risk: 'yellow',
      inputs: {
        package_dir: { type: 'string', pattern: '^packages/[a-z0-9-]+$' },
      },
      run: {
        command: 'npm',
        args: ['publish', '{{inputs.package_dir}}'],
        mode: 'structured',
      },
      ...overrides,
    };
  }

  it('converts a template to a valid recipe', () => {
    const recipe = templateToRecipe(makeTemplate(), { name: 'npm-publish', category: 'packages' });
    validateRecipe(recipe);
    assert.equal(recipe.steps[0].run.command, 'npm');
    assert.equal(recipe.risk_level, 'medium');
  });

  it('preserves requires_env when present', () => {
    const recipe = templateToRecipe(
      makeTemplate({ requires_env: ['NPM_TOKEN'] }),
      { name: 'npm-publish', category: 'packages' },
    );
    assert.deepEqual(recipe.requires_env, ['NPM_TOKEN']);
  });

  it('maps rollback-bearing templates into recipe rollback steps', () => {
    const recipe = templateToRecipe(
      makeTemplate({
        idempotent: false,
        rollback: {
          steps: [{
            id: 'rb',
            description: 'Undo publish',
            run: { command: 'npm', args: ['unpublish'], mode: 'structured' },
          }],
        },
      }),
      { name: 'npm-publish', category: 'packages' },
    );
    validateRecipe(recipe);
    assert.equal(recipe.steps[0].idempotent, false);
    assert.equal(recipe.rollback.steps.length, 1);
    assert.equal(recipe.rollback.steps[0].run.command, 'npm');
  });
});

// ---------------------------------------------------------------------------
// buildPRBody
// ---------------------------------------------------------------------------

describe('buildPRBody', async () => {
  const { buildPRBody } = await import('../src/recipe-publish.js');
  const { hashRecipe } = await import('../src/recipe.js');

  it('includes category, risk, channel', () => {
    const recipe = makeValidRecipe();
    const hash = hashRecipe(recipe);
    const body = buildPRBody(recipe, hash);
    assert.ok(body.includes('**Category:** custom'));
    assert.ok(body.includes('**Risk:** MEDIUM'));
    assert.ok(body.includes('**Channel:** community'));
  });

  it('includes input table with types and constraints', () => {
    const recipe = makeValidRecipe({
      inputs: {
        branch: { type: 'string', pattern: '^[a-z]+$' },
        count: { type: 'integer', min: 1, max: 10 },
      },
    });
    const hash = hashRecipe(recipe);
    const body = buildPRBody(recipe, hash);
    assert.ok(body.includes('| branch | string |'));
    assert.ok(body.includes('| count | integer |'));
  });

  it('handles recipe with no inputs', () => {
    const recipe = makeValidRecipe({ inputs: {} });
    const hash = hashRecipe(recipe);
    const body = buildPRBody(recipe, hash);
    assert.ok(body.includes('No inputs required'));
  });

  it('includes steps list', () => {
    const recipe = makeValidRecipe();
    const hash = hashRecipe(recipe);
    const body = buildPRBody(recipe, hash);
    assert.ok(body.includes('`echo`'));
  });

  it('includes idempotency flags', () => {
    const recipe = makeValidRecipe();
    recipe.steps[0].idempotent = true;
    const hash = hashRecipe(recipe);
    const body = buildPRBody(recipe, hash);
    assert.ok(body.includes('idempotent: true'));
  });

  it('includes validator patterns from step definitions', () => {
    const recipe = makeValidRecipe();
    recipe.steps[0].validator = { regex: '^success' };
    const hash = hashRecipe(recipe);
    const body = buildPRBody(recipe, hash);
    assert.ok(body.includes('`^success`'));
  });

  it('includes rollback commands', () => {
    const recipe = makeValidRecipe();
    recipe.rollback = { steps: [{ run: { command: 'rollback-cmd' }, description: 'undo' }] };
    const hash = hashRecipe(recipe);
    const body = buildPRBody(recipe, hash);
    assert.ok(body.includes('`rollback-cmd`'));
  });

  it('handles recipe with no rollback', () => {
    const recipe = makeValidRecipe();
    const hash = hashRecipe(recipe);
    const body = buildPRBody(recipe, hash);
    // Should show em-dash for no rollback
    assert.ok(body.includes('\u2014') || body.includes('—'));
  });

  it('includes content hash', () => {
    const recipe = makeValidRecipe();
    const hash = hashRecipe(recipe);
    const body = buildPRBody(recipe, hash);
    assert.ok(body.includes(`sha256:${hash}`));
  });

  it('includes lint checklist with 7 checks', () => {
    const recipe = makeValidRecipe();
    const hash = hashRecipe(recipe);
    const body = buildPRBody(recipe, hash);
    const checkboxes = body.match(/- \[x\]/g);
    assert.equal(checkboxes.length, 7);
  });

  it('includes install command with fork path', () => {
    const recipe = makeValidRecipe();
    const hash = hashRecipe(recipe);
    const body = buildPRBody(recipe, hash, { fork: 'alice/recipes' });
    assert.ok(body.includes('github://alice/recipes/'));
  });
});

// ---------------------------------------------------------------------------
// publishRecipe
// ---------------------------------------------------------------------------

describe('publishRecipe', async () => {
  const { publishRecipe } = await import('../src/recipe-publish.js');
  let tempDir;

  beforeEach(() => {
    tempDir = tmpDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeManifest(manifest) {
    const manifestPath = join(tempDir, 'approved.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return manifestPath;
  }

  it('rejects RED risk level before any GitHub call', async () => {
    const manifest = makeStructuredManifest({ riskAssessment: { riskLevel: 'red' } });
    const manifestPath = writeManifest(manifest);

    await assert.rejects(
      () => publishRecipe({
        name: 'red-recipe',
        category: 'custom',
        manifestPath,
        dryRun: true,
      }),
      /RED-risk recipes cannot be published/
    );
  });

  it('rejects when no manifest exists', async () => {
    await assert.rejects(
      () => publishRecipe({
        name: 'ghost',
        category: 'custom',
        manifestPath: join(tempDir, 'nonexistent.json'),
        dryRun: true,
      }),
      /No approved manifest found/
    );
  });

  it('rejects shell manifests before any GitHub call', async () => {
    const manifest = makeStructuredManifest({ contract: { command: 'bash', args: ['-c', 'echo'], mode: 'shell' } });
    const manifestPath = writeManifest(manifest);

    await assert.rejects(
      () => publishRecipe({
        name: 'shell-recipe',
        category: 'custom',
        manifestPath,
        dryRun: true,
      }),
      /only supports structured/
    );
  });

  it('dry-run returns recipe without GitHub ops', async () => {
    const manifest = makeStructuredManifest();
    const manifestPath = writeManifest(manifest);
    const logs = [];

    const result = await publishRecipe({
      name: 'test-recipe',
      category: 'custom',
      manifestPath,
      dryRun: true,
      log: (msg) => logs.push(msg),
    });

    assert.equal(result.dryRun, true);
    assert.ok(result.recipe);
    assert.ok(result.hash);
    assert.ok(logs.some(l => l.includes('Dry run')));
  });

  it('dry-run skips gh CLI check', async () => {
    const manifest = makeStructuredManifest();
    const manifestPath = writeManifest(manifest);

    // This should succeed even if gh is not installed
    const result = await publishRecipe({
      name: 'no-gh-recipe',
      category: 'custom',
      manifestPath,
      dryRun: true,
      log: () => {},
    });

    assert.equal(result.dryRun, true);
  });

  it('validates recipe schema before GitHub ops', async () => {
    // Create a manifest that would produce an invalid recipe
    const manifest = {
      contract: { command: '', args: [], mode: 'structured' },
      riskAssessment: { riskLevel: 'yellow' },
    };
    const manifestPath = writeManifest(manifest);

    await assert.rejects(
      () => publishRecipe({
        name: 'invalid-recipe',
        category: 'custom',
        manifestPath,
        dryRun: true,
        log: () => {},
      }),
      /validation failed/i
    );
  });

  it('scrub runs after lint', async () => {
    const manifest = makeStructuredManifest();
    manifest.contract.command = 'npm';
    manifest.contract.args = ['install'];
    const manifestPath = writeManifest(manifest);

    const result = await publishRecipe({
      name: 'scrub-test',
      category: 'custom',
      manifestPath,
      dryRun: true,
      log: () => {},
      author: '/Users/alice',
    });

    // Author should be scrubbed
    assert.equal(result.recipe.author, '{{working_dir}}');
    assert.ok(result.steps.includes('Personal data scrubbed'));
  });

  it('recipe channel is always community', async () => {
    const manifest = makeStructuredManifest();
    const manifestPath = writeManifest(manifest);

    const result = await publishRecipe({
      name: 'channel-test',
      category: 'custom',
      manifestPath,
      dryRun: true,
      log: () => {},
    });

    assert.equal(result.recipe.channel, 'community');
  });
});

// ---------------------------------------------------------------------------
// requireGhCli (basic export check)
// ---------------------------------------------------------------------------

describe('requireGhCli', async () => {
  const { requireGhCli } = await import('../src/recipe-publish.js');

  it('is exported as a function', () => {
    assert.equal(typeof requireGhCli, 'function');
  });
});

// ---------------------------------------------------------------------------
// ensureFork (basic export check)
// ---------------------------------------------------------------------------

describe('ensureFork', async () => {
  const { ensureFork } = await import('../src/recipe-publish.js');

  it('is exported as a function', () => {
    assert.equal(typeof ensureFork, 'function');
  });
});
