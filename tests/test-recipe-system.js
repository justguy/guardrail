import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateRecipe, loadRecipe, hashRecipe, VALID_CATEGORIES, VALID_CHANNELS } from '../src/recipe.js';
import { buildIndex, filterRecipes, fuzzySearch, groupByCategory, formatRecipeList } from '../src/recipe-index.js';
import { signRecipe, verifySignature, classifyTrust, enforceChannel, staticAnalysis } from '../src/recipe-channel.js';
import { checkDangerous, checkScope, dryRun, executeRecipe } from '../src/recipe-executor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-rs-')));
}

function makeRecipe(overrides = {}) {
  return {
    id: 'test-recipe',
    name: 'Test Recipe',
    description: 'A test recipe',
    version: '1.0.0',
    author: 'tester',
    category: 'custom',
    tags: ['test', 'example'],
    channel: 'community',
    inputs: { target: { type: 'string', pattern: '^[a-z]+$' } },
    steps: [{ id: 's1', description: 'echo', run: { command: 'echo', args: ['hello'], mode: 'structured' } }],
    guardrails: { constraints: ['safe only'], invariants: ['no harm'] },
    approval_required: false,
    risk_level: 'low',
    ...overrides,
  };
}

function writeRecipe(dir, recipe, filename) {
  const path = join(dir, filename || `${recipe.id}.recipe.json`);
  writeFileSync(path, JSON.stringify(recipe, null, 2));
  return path;
}

// ===========================================================================
// 1. Category + Tag Validation
// ===========================================================================

describe('Recipe System: Category + Tag Model', () => {
  it('all 6 categories are defined', () => {
    const expected = ['git', 'github', 'infra', 'packages', 'openclaw', 'custom'];
    for (const c of expected) {
      assert.ok(VALID_CATEGORIES.has(c), `Missing category: ${c}`);
    }
  });

  it('valid category passes validation', () => {
    for (const cat of VALID_CATEGORIES) {
      assert.doesNotThrow(() => validateRecipe(makeRecipe({ category: cat })));
    }
  });

  it('invalid category rejected', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({ category: 'invalid' })),
      (err) => err.errors.some(e => e.includes('category')),
    );
  });

  it('tags array validated', () => {
    assert.doesNotThrow(() => validateRecipe(makeRecipe({ tags: ['a', 'b', 'c'] })));
  });

  it('non-string tags rejected', () => {
    assert.throws(
      () => validateRecipe(makeRecipe({ tags: [42] })),
      (err) => err.errors.some(e => e.includes('tags')),
    );
  });

  it('category is optional (defaults during indexing)', () => {
    const r = makeRecipe();
    delete r.category;
    assert.doesNotThrow(() => validateRecipe(r));
  });

  it('channel must be verified or community', () => {
    assert.doesNotThrow(() => validateRecipe(makeRecipe({ channel: 'verified' })));
    assert.doesNotThrow(() => validateRecipe(makeRecipe({ channel: 'community' })));
    assert.throws(
      () => validateRecipe(makeRecipe({ channel: 'unknown' })),
      (err) => err.errors.some(e => e.includes('channel')),
    );
  });
});

// ===========================================================================
// 2. Recipe Index + Filtering
// ===========================================================================

describe('Recipe System: Indexing + Filtering', () => {
  it('buildIndex scans directory for .recipe.json files', () => {
    const dir = tmpDir();
    writeRecipe(dir, makeRecipe({ id: 'r1' }), 'r1.recipe.json');
    writeRecipe(dir, makeRecipe({ id: 'r2' }), 'r2.recipe.json');
    writeFileSync(join(dir, 'not-recipe.json'), '{}'); // should be skipped

    const index = buildIndex([dir]);
    assert.equal(index.length, 2);
  });

  it('filter by category', () => {
    const recipes = [
      makeRecipe({ id: 'a', category: 'git' }),
      makeRecipe({ id: 'b', category: 'infra' }),
      makeRecipe({ id: 'c', category: 'git' }),
    ];
    const result = filterRecipes(recipes, { category: 'git' });
    assert.equal(result.length, 2);
  });

  it('filter by tag', () => {
    const recipes = [
      makeRecipe({ id: 'a', tags: ['ci', 'build'] }),
      makeRecipe({ id: 'b', tags: ['deploy'] }),
    ];
    const result = filterRecipes(recipes, { tag: 'ci' });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'a');
  });

  it('filter by channel', () => {
    const recipes = [
      makeRecipe({ id: 'a', channel: 'verified' }),
      makeRecipe({ id: 'b', channel: 'community' }),
    ];
    assert.equal(filterRecipes(recipes, { channel: 'verified' }).length, 1);
  });

  it('filter by risk_level', () => {
    const recipes = [
      makeRecipe({ id: 'a', risk_level: 'high' }),
      makeRecipe({ id: 'b', risk_level: 'low' }),
    ];
    assert.equal(filterRecipes(recipes, { risk_level: 'high' }).length, 1);
  });

  it('groupByCategory groups correctly', () => {
    const recipes = [
      makeRecipe({ id: 'a', category: 'git' }),
      makeRecipe({ id: 'b', category: 'git' }),
      makeRecipe({ id: 'c', category: 'infra' }),
    ];
    const groups = groupByCategory(recipes);
    assert.equal(groups.get('git').length, 2);
    assert.equal(groups.get('infra').length, 1);
  });

  it('formatRecipeList produces output', () => {
    const recipes = [makeRecipe({ id: 'test', name: 'Test', channel: 'verified', risk_level: 'low' })];
    const output = formatRecipeList(recipes);
    assert.ok(output.includes('test'));
    assert.ok(output.includes('verified'));
  });
});

// ===========================================================================
// 3. Fuzzy Search
// ===========================================================================

describe('Recipe System: Fuzzy Search', () => {
  it('matches by id substring', () => {
    const recipes = [makeRecipe({ id: 'git-branch-cleanup' }), makeRecipe({ id: 'npm-publish' })];
    const results = fuzzySearch(recipes, 'branch');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'git-branch-cleanup');
  });

  it('matches by name substring', () => {
    const recipes = [makeRecipe({ id: 'a', name: 'Deploy Infrastructure' }), makeRecipe({ id: 'b', name: 'Run Tests' })];
    const results = fuzzySearch(recipes, 'infra');
    assert.equal(results.length, 1);
  });

  it('matches by tag', () => {
    const recipes = [
      makeRecipe({ id: 'a', tags: ['terraform', 'aws'] }),
      makeRecipe({ id: 'b', tags: ['npm'] }),
    ];
    const results = fuzzySearch(recipes, 'terraform');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'a');
  });

  it('returns empty for no match', () => {
    const recipes = [makeRecipe({ id: 'git-cleanup' })];
    assert.equal(fuzzySearch(recipes, 'zzzznotfound').length, 0);
  });

  it('ranks exact id match higher than description match', () => {
    const recipes = [
      makeRecipe({ id: 'deploy', name: 'Deploy', description: 'Deploys things' }),
      makeRecipe({ id: 'test', name: 'Test', description: 'Tests deploy scripts' }),
    ];
    const results = fuzzySearch(recipes, 'deploy');
    assert.equal(results[0].id, 'deploy');
  });
});

// ===========================================================================
// 4. Verified Channel + Signatures
// ===========================================================================

describe('Recipe System: Verified Channel', () => {
  it('signRecipe produces a hex string', () => {
    const sig = signRecipe(makeRecipe());
    assert.ok(/^[a-f0-9]{64}$/.test(sig));
  });

  it('same recipe produces same signature', () => {
    const r = makeRecipe();
    assert.equal(signRecipe(r), signRecipe(r));
  });

  it('different recipe produces different signature', () => {
    const r1 = makeRecipe({ version: '1.0.0' });
    const r2 = makeRecipe({ version: '2.0.0' });
    assert.notEqual(signRecipe(r1), signRecipe(r2));
  });

  it('verifySignature passes for correct signature', () => {
    const r = makeRecipe();
    const sig = signRecipe(r);
    const result = verifySignature(r, sig);
    assert.equal(result.valid, true);
  });

  it('verifySignature fails for wrong signature', () => {
    const r = makeRecipe();
    const result = verifySignature(r, 'deadbeef'.repeat(8));
    assert.equal(result.valid, false);
  });

  it('classifyTrust: verified with valid signature', () => {
    const r = makeRecipe({ channel: 'verified' });
    r.signature = signRecipe(r);
    const trust = classifyTrust(r);
    assert.equal(trust.channel, 'verified');
    assert.equal(trust.verified, true);
  });

  it('classifyTrust: verified without signature → community', () => {
    const r = makeRecipe({ channel: 'verified' });
    const trust = classifyTrust(r);
    assert.equal(trust.channel, 'community');
    assert.equal(trust.verified, false);
    assert.ok(trust.warnings.length > 0);
  });

  it('classifyTrust: verified with invalid signature → community', () => {
    const r = makeRecipe({ channel: 'verified', signature: 'invalid' });
    const trust = classifyTrust(r);
    assert.equal(trust.verified, false);
  });

  it('classifyTrust: community channel', () => {
    const r = makeRecipe({ channel: 'community' });
    const trust = classifyTrust(r);
    assert.equal(trust.channel, 'community');
    assert.equal(trust.verified, false);
  });
});

// ===========================================================================
// 5. Execution Failure Detail Propagation
// ===========================================================================

describe('Recipe System: Execution Failure Detail Propagation', () => {
  it('includes bounded stderr detail in failed recipe reasons', async () => {
    const dir = tmpDir();
    const recipe = makeRecipe({
      approval_required: false,
      channel: 'community',
      steps: [{
        id: 'invoke',
        description: 'fail with detail',
        run: {
          command: 'node',
          args: ['-e', 'process.stderr.write("Not logged in\\\\nPlease run /login\\\\n"); process.exit(1)'],
          mode: 'structured',
          timeoutMs: 5000,
        },
      }],
    });

    const result = await executeRecipe(recipe, { target: 'hello' }, {
      allowUnverified: true,
      approved: true,
      cwd: dir,
      stateDir: join(dir, '.guardrail'),
    });

    assert.equal(result.status, 'failed');
    assert.match(result.reason, /Not logged in/);
    assert.match(result.reason, /Please run \/login/);
  });
});

// ===========================================================================
// 5. Channel Enforcement
// ===========================================================================

describe('Recipe System: Channel Enforcement', () => {
  it('verified recipe: allowed', () => {
    const r = makeRecipe({ channel: 'verified' });
    r.signature = signRecipe(r);
    const result = enforceChannel(r);
    assert.equal(result.allowed, true);
  });

  it('unverified recipe: blocked by default', () => {
    const r = makeRecipe({ channel: 'community' });
    const result = enforceChannel(r);
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('--allow-unverified'));
  });

  it('unverified recipe: allowed with --allow-unverified', () => {
    const r = makeRecipe({ channel: 'community' });
    const result = enforceChannel(r, { allowUnverified: true });
    assert.equal(result.allowed, true);
  });
});

// ===========================================================================
// 6. Static Analysis
// ===========================================================================

describe('Recipe System: Static Analysis', () => {
  it('well-formed recipe passes all checks', () => {
    const result = staticAnalysis(makeRecipe());
    assert.equal(result.passed, true);
    assert.ok(result.checks.length >= 4);
  });

  it('recipe with shell mode fails structured_mode check', () => {
    const r = makeRecipe({
      steps: [{ id: 's1', description: 'x', run: { command: 'echo', mode: 'shell' } }],
    });
    const result = staticAnalysis(r);
    const check = result.checks.find(c => c.name === 'structured_mode');
    assert.equal(check.passed, false);
  });

  it('recipe without guardrails fails has_guardrails check', () => {
    const r = makeRecipe({ guardrails: {} });
    const result = staticAnalysis(r);
    const check = result.checks.find(c => c.name === 'has_guardrails');
    assert.equal(check.passed, false);
  });

  it('recipe with bare string input fails inputs_constrained', () => {
    const r = makeRecipe({ inputs: { name: { type: 'string' } } });
    const result = staticAnalysis(r);
    const check = result.checks.find(c => c.name === 'inputs_constrained');
    assert.equal(check.passed, false);
  });
});

// ===========================================================================
// 7. Native Executor: Dangerous Command Detection
// ===========================================================================

describe('Recipe System: Dangerous Command Detection', () => {
  it('rm -rf / is blocked', () => {
    const result = checkDangerous('rm', ['-rf', '/']);
    assert.equal(result.safe, false);
  });

  it('chmod 777 is blocked', () => {
    const result = checkDangerous('chmod', ['777', '/etc/passwd']);
    assert.equal(result.safe, false);
  });

  it('echo hello is safe', () => {
    const result = checkDangerous('echo', ['hello']);
    assert.equal(result.safe, true);
  });

  it('npm test is safe', () => {
    const result = checkDangerous('npm', ['test']);
    assert.equal(result.safe, true);
  });

  it('sudo rm is blocked', () => {
    const result = checkDangerous('sudo', ['rm', '-rf', '/tmp/foo']);
    assert.equal(result.safe, false);
  });
});

// ===========================================================================
// 8. Native Executor: Scope Check
// ===========================================================================

describe('Recipe System: Scope Restriction', () => {
  it('path within scope is allowed', () => {
    const result = checkScope(['./src/file.js'], ['.']);
    assert.equal(result.inScope, true);
  });

  it('path outside scope is blocked', () => {
    const result = checkScope(['/etc/passwd'], ['/home/user/project']);
    assert.equal(result.inScope, false);
    assert.ok(result.violations.length > 0);
  });

  it('no scope restriction: everything allowed', () => {
    const result = checkScope(['/etc/passwd'], []);
    assert.equal(result.inScope, true);
  });

  it('non-path args are not checked', () => {
    const result = checkScope(['--flag', 'value'], ['/restricted']);
    assert.equal(result.inScope, true);
  });
});

// ===========================================================================
// 9. Native Executor: Dry Run
// ===========================================================================

describe('Recipe System: Dry Run', () => {
  it('dry run shows all steps without executing', () => {
    const recipe = makeRecipe({
      steps: [
        { id: 's1', description: 'step 1', run: { command: 'echo', args: ['a'] } },
        { id: 's2', description: 'step 2', run: { command: 'echo', args: ['b'] } },
      ],
    });
    const result = dryRun(recipe, {});
    assert.equal(result.steps.length, 2);
    assert.equal(result.safe, true);
    assert.equal(result.blocked.length, 0);
  });

  it('dry run detects dangerous steps', () => {
    const recipe = makeRecipe({
      steps: [
        { id: 'bad', description: 'danger', run: { command: 'rm', args: ['-rf', '/'] } },
      ],
    });
    const result = dryRun(recipe, {});
    assert.equal(result.safe, false);
    assert.equal(result.blocked.length, 1);
    assert.ok(result.blocked[0].dangerous);
  });

  it('dry run detects scope violations', () => {
    const recipe = makeRecipe({
      steps: [
        { id: 's1', description: 'read', run: { command: 'cat', args: ['/etc/shadow'] } },
      ],
    });
    const result = dryRun(recipe, {}, { allowedPaths: ['/home/user'] });
    assert.equal(result.safe, false);
    assert.ok(result.blocked[0].scopeViolations.length > 0);
  });

  it('dry run interpolates inputs', () => {
    const recipe = makeRecipe({
      steps: [{ id: 's1', description: 'echo', run: { command: 'echo', args: ['{{inputs.target}}'] } }],
    });
    const result = dryRun(recipe, { target: 'hello' });
    assert.equal(result.steps[0].args[0], 'hello');
  });
});

// ===========================================================================
// 10. Example Recipes
// ===========================================================================

describe('Recipe System: Example Recipes', () => {
  const recipeDir = join(process.cwd(), 'recipes');

  it('git-branch-cleanup recipe is valid and categorized', () => {
    const r = loadRecipe(join(recipeDir, 'git-branch-cleanup.recipe.json'));
    assert.equal(r.category, 'git');
    assert.ok(r.tags.includes('git'));
    assert.equal(r.channel, 'verified');
  });

  it('github-pr-merge recipe is valid and categorized', () => {
    const r = loadRecipe(join(recipeDir, 'github-pr-merge.recipe.json'));
    assert.equal(r.category, 'github');
    assert.equal(r.risk_level, 'high');
  });

  it('gh-open-pr recipe is valid and categorized', () => {
    const r = loadRecipe(join(recipeDir, 'gh-open-pr.recipe.json'));
    assert.equal(r.category, 'github');
    assert.equal(r.approval_required, true);
  });

  it('gh-release recipe is valid and categorized', () => {
    const r = loadRecipe(join(recipeDir, 'gh-release.recipe.json'));
    assert.equal(r.category, 'github');
    assert.equal(r.approval_required, true);
  });

  it('dep-upgrade recipe is community channel', () => {
    const r = loadRecipe(join(recipeDir, 'dep-upgrade.recipe.json'));
    assert.equal(r.category, 'packages');
    assert.equal(r.channel, 'community');
  });

  it('infra-deploy recipe requires approval', () => {
    const r = loadRecipe(join(recipeDir, 'infra-deploy.recipe.json'));
    assert.equal(r.category, 'infra');
    assert.equal(r.approval_required, true);
  });

  it('terraform-plan-only recipe is valid and plan-only', () => {
    const r = loadRecipe(join(recipeDir, 'terraform-plan-only.recipe.json'));
    assert.equal(r.category, 'infra');
    assert.equal(r.approval_required, true);
    const args = r.steps.flatMap((step) => step.run?.args || []);
    assert.ok(args.includes('plan'));
    assert.ok(!args.includes('apply'));
    assert.ok(!args.includes('destroy'));
  });

  it('openclaw-wrapper recipe is categorized', () => {
    const r = loadRecipe(join(recipeDir, 'openclaw-wrapper.recipe.json'));
    assert.equal(r.category, 'openclaw');
    assert.ok(r.tags.includes('openclaw'));
  });

  it('openclaw-fix-tests recipe is fixed to the task-specific flow and write scope', () => {
    const r = loadRecipe(join(recipeDir, 'openclaw-fix-tests.recipe.json'));
    assert.equal(r.category, 'openclaw');
    assert.equal(r.approval_required, true);
    const args = r.steps.flatMap((step) => step.run?.args || []);
    assert.ok(args.includes('fix-tests'));
    assert.ok(args.includes('write'));
    assert.ok(!args.includes('admin'));
  });

  it('git-commit recipe is valid and categorized', () => {
    const r = loadRecipe(join(recipeDir, 'git-commit.recipe.json'));
    assert.equal(r.category, 'git');
    assert.ok(r.tags.includes('commit'));
    assert.equal(r.approval_required, true);
  });

  it('git-clone-allowed recipe is valid and categorized', () => {
    const r = loadRecipe(join(recipeDir, 'git-clone-allowed.recipe.json'));
    assert.equal(r.category, 'git');
    assert.equal(r.approval_required, true);
  });

  it('docker recipes are valid and categorized', () => {
    const build = loadRecipe(join(recipeDir, 'docker-build.recipe.json'));
    const push = loadRecipe(join(recipeDir, 'docker-push.recipe.json'));
    assert.equal(build.category, 'packages');
    assert.equal(push.category, 'packages');
    assert.equal(build.approval_required, true);
    assert.equal(push.approval_required, true);
  });

  it('all recipes have guardrails defined', () => {
    const files = [
      'git-branch-cleanup',
      'git-clone-allowed',
      'git-commit',
      'github-pr-merge',
      'gh-open-pr',
      'gh-release',
      'dep-upgrade',
      'docker-build',
      'docker-push',
      'infra-deploy',
      'terraform-plan-only',
      'openclaw-fix-tests',
      'openclaw-wrapper',
      'npm-publish',
    ];
    for (const name of files) {
      const r = loadRecipe(join(recipeDir, `${name}.recipe.json`));
      assert.ok(r.guardrails.constraints?.length > 0, `${name} should have constraints`);
      assert.ok(r.guardrails.invariants?.length > 0, `${name} should have invariants`);
    }
  });
});

// ===========================================================================
// 11. Category + Tags in Hash
// ===========================================================================

describe('Recipe System: Category/Tags in Hash', () => {
  it('category does not affect content hash (not security-relevant)', () => {
    const r1 = makeRecipe({ category: 'git' });
    const r2 = makeRecipe({ category: 'infra' });
    // Content hash covers core fields, not metadata like category
    // Both have same id/name/version/steps/inputs/guardrails
    const h1 = hashRecipe(r1);
    const h2 = hashRecipe(r2);
    assert.equal(h1, h2);
  });
});
