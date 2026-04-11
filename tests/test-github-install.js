import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseGitHubUrl, pinPathForRecipePath, installFromGitHub, listInstalled, listVersions } from '../src/recipe-install.js';
import { hashRecipe, loadRawJson } from '../src/recipe.js';
import { verifyPinnedRecipeSource } from '../src/recipe-runner.js';
import { parseArgs } from '../src/cli.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  const dir = join(tmpdir(), `guardrail-test-gh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function writeOrgPolicy(dir, trustedExecutionSources) {
  const policyDir = join(dir, '.guardrail');
  mkdirSync(policyDir, { recursive: true });
  const policyPath = join(policyDir, 'org-policy.json');
  writeFileSync(policyPath, JSON.stringify({
    name: 'exec-policy',
    version: '1.0.0',
    trusted_execution_sources: trustedExecutionSources,
    forbidden_operations: [],
    required_approvals: [],
    allowed_actions: [],
  }));
  return policyPath;
}

// ---------------------------------------------------------------------------
// parseGitHubUrl
// ---------------------------------------------------------------------------

describe('parseGitHubUrl', () => {
  it('parses valid github://owner/repo/path@sha', () => {
    const result = parseGitHubUrl('github://guardrail-dev/recipes/github/open-pr.json@a3f9c12e4b7d8f0a1c2e3d4f5a6b7c8d9e0f1a2b');
    assert.equal(result.owner, 'guardrail-dev');
    assert.equal(result.repo, 'recipes');
    assert.equal(result.path, 'github/open-pr.json');
    assert.equal(result.sha, 'a3f9c12e4b7d8f0a1c2e3d4f5a6b7c8d9e0f1a2b');
    assert.equal(result.rawUrl, 'https://raw.githubusercontent.com/guardrail-dev/recipes/a3f9c12e4b7d8f0a1c2e3d4f5a6b7c8d9e0f1a2b/github/open-pr.json');
  });

  it('handles short SHA (7 chars)', () => {
    const result = parseGitHubUrl('github://o/r/file.json@a3f9c12');
    assert.equal(result.sha, 'a3f9c12');
  });

  it('handles full SHA (40 chars)', () => {
    const sha = 'a'.repeat(40);
    const result = parseGitHubUrl(`github://o/r/file.json@${sha}`);
    assert.equal(result.sha, sha);
  });

  it('rejects missing SHA', () => {
    assert.throws(
      () => parseGitHubUrl('github://o/r/file.json'),
      /must include a commit SHA/
    );
  });

  it('rejects invalid SHA characters', () => {
    assert.throws(
      () => parseGitHubUrl('github://o/r/file.json@ghijklm'),
      /Invalid commit SHA/
    );
  });

  it('rejects too-short SHA (< 7 chars)', () => {
    assert.throws(
      () => parseGitHubUrl('github://o/r/file.json@abc12'),
      /Invalid commit SHA/
    );
  });

  it('accepts uppercase hex in SHA', () => {
    const result = parseGitHubUrl('github://o/r/file.json@A3F9C12');
    assert.equal(result.sha, 'A3F9C12');
  });

  it('rejects missing path (owner/repo only)', () => {
    assert.throws(
      () => parseGitHubUrl('github://owner/repo@abc1234'),
      /must include owner\/repo\/path/
    );
  });

  it('handles nested paths', () => {
    const result = parseGitHubUrl('github://o/r/a/b/c/d.json@abc1234');
    assert.equal(result.path, 'a/b/c/d.json');
    assert.equal(result.owner, 'o');
    assert.equal(result.repo, 'r');
  });

  it('handles @ in path by using lastIndexOf', () => {
    // Edge case: @ in the path portion shouldn't confuse the parser
    // since we use lastIndexOf('@')
    const result = parseGitHubUrl('github://o/r/user@domain/file.json@abc1234');
    assert.equal(result.path, 'user@domain/file.json');
    assert.equal(result.sha, 'abc1234');
  });

  it('rawUrl points to raw.githubusercontent.com', () => {
    const result = parseGitHubUrl('github://org/repo/cat/file.json@abcdef1');
    assert.ok(result.rawUrl.startsWith('https://raw.githubusercontent.com/'));
    assert.ok(result.rawUrl.includes('org/repo/abcdef1/cat/file.json'));
  });

  it('rejects empty SHA after @', () => {
    assert.throws(
      () => parseGitHubUrl('github://o/r/file.json@'),
      /Invalid commit SHA/
    );
  });
});

// ---------------------------------------------------------------------------
// pinPathForRecipePath
// ---------------------------------------------------------------------------

describe('pinPathForRecipePath', () => {
  it('returns .pins/<version>.json under recipe directory', () => {
    const result = pinPathForRecipePath('/home/user/.guardrail/recipes/open-pr/1.0.0.json');
    assert.equal(result, '/home/user/.guardrail/recipes/open-pr/.pins/1.0.0.json');
  });

  it('works with different version numbers', () => {
    const result = pinPathForRecipePath('/tmp/recipes/my-recipe/2.3.1.json');
    assert.equal(result, '/tmp/recipes/my-recipe/.pins/2.3.1.json');
  });
});

// ---------------------------------------------------------------------------
// installFromGitHub
// ---------------------------------------------------------------------------

describe('installFromGitHub', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = tmpDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const fullSha = 'a'.repeat(40);
  const source = `github://guardrail-dev/recipes/custom/test-recipe.json@${fullSha}`;

  function makeConfigFile(trustedSources) {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ trusted_sources: trustedSources }));
    return configPath;
  }

  it('installs recipe and writes pin metadata', async () => {
    const recipe = makeValidRecipe();
    const configPath = makeConfigFile(['github://guardrail-dev/recipes/']);
    const registryDir = join(tempDir, 'recipes');

    const result = await installFromGitHub(source, {
      configPath,
      registryDir,
      loadRemoteRecipe: async () => recipe,
    });

    assert.equal(result.installed, true);
    assert.equal(result.id, 'test-recipe');
    assert.ok(result.pin);
    assert.equal(result.pin.sha, fullSha);
    assert.equal(result.pin.source, source);
    assert.equal(result.pin.content_hash, result.hash);
    assert.equal(result.pin.input_sha, fullSha);
    assert.ok(result.pin.rawUrl.includes('raw.githubusercontent.com'));

    // Verify pin file exists on disk
    const pinPath = pinPathForRecipePath(result.path);
    assert.ok(existsSync(pinPath), 'pin metadata file should exist');
    const pinData = JSON.parse(readFileSync(pinPath, 'utf8'));
    assert.equal(pinData.sha, fullSha);
  });

  it('pin metadata stores input_sha (original user input)', async () => {
    const recipe = makeValidRecipe();
    // Use full SHA so no resolution needed
    const configPath = makeConfigFile(['github://guardrail-dev/recipes/']);
    const registryDir = join(tempDir, 'recipes');

    const result = await installFromGitHub(source, {
      configPath,
      registryDir,
      loadRemoteRecipe: async () => recipe,
    });

    assert.equal(result.pin.input_sha, fullSha);
  });

  it('rejects untrusted source', async () => {
    const recipe = makeValidRecipe();
    const configPath = makeConfigFile(['github://other-org/recipes/']);
    const registryDir = join(tempDir, 'recipes');

    await assert.rejects(
      () => installFromGitHub(source, {
        configPath,
        registryDir,
        loadRemoteRecipe: async () => recipe,
      }),
      /not in trusted sources/
    );
  });

  it('rejects org-policy blocked source even if trusted_sources allows it', async () => {
    const recipe = makeValidRecipe();
    const configPath = makeConfigFile(['github://guardrail-dev/recipes/']);
    const registryDir = join(tempDir, 'recipes');

    await assert.rejects(
      () => installFromGitHub(source, {
        configPath,
        registryDir,
        loadRemoteRecipe: async () => recipe,
        orgPolicy: {
          name: 'exec-policy',
          version: '1.0.0',
          trusted_execution_sources: ['github://other-org/'],
          forbidden_operations: [],
          required_approvals: [],
          allowed_actions: [],
        },
      }),
      /trusted execution sources/
    );
  });

  it('allows org-policy trusted execution source', async () => {
    const recipe = makeValidRecipe();
    const configPath = makeConfigFile(['github://guardrail-dev/recipes/']);
    const registryDir = join(tempDir, 'recipes');

    const result = await installFromGitHub(source, {
      configPath,
      registryDir,
      loadRemoteRecipe: async () => recipe,
      orgPolicy: {
        name: 'exec-policy',
        version: '1.0.0',
        trusted_execution_sources: ['github://guardrail-dev/'],
        forbidden_operations: [],
        required_approvals: [],
        allowed_actions: [],
      },
    });

    assert.equal(result.installed, true);
    assert.equal(result.id, 'test-recipe');
  });

  it('loads the active org policy from org-policy.json when no policy object is injected', async () => {
    const recipe = makeValidRecipe();
    const configPath = makeConfigFile(['github://guardrail-dev/recipes/']);
    const registryDir = join(tempDir, 'recipes');

    writeOrgPolicy(tempDir, ['github://other-org/']);

    await assert.rejects(
      () => installFromGitHub(source, {
        configPath,
        registryDir,
        loadRemoteRecipe: async () => recipe,
        orgPolicyDir: tempDir,
      }),
      /trusted execution sources/
    );

    writeOrgPolicy(tempDir, ['github://guardrail-dev/']);

    const result = await installFromGitHub(source, {
      configPath,
      registryDir,
      loadRemoteRecipe: async () => recipe,
      orgPolicyDir: tempDir,
    });

    assert.equal(result.installed, true);
    assert.equal(result.id, 'test-recipe');
  });

  it('rejects when no trusted_sources configured', async () => {
    const configPath = makeConfigFile([]);
    const registryDir = join(tempDir, 'recipes');

    await assert.rejects(
      () => installFromGitHub(source, {
        configPath,
        registryDir,
        loadRemoteRecipe: async () => makeValidRecipe(),
      }),
      /No trusted sources configured/
    );
  });

  it('error message includes config path', async () => {
    const configPath = makeConfigFile([]);
    const registryDir = join(tempDir, 'recipes');

    try {
      await installFromGitHub(source, {
        configPath,
        registryDir,
        loadRemoteRecipe: async () => makeValidRecipe(),
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes(configPath), `error should include config path: ${err.message}`);
    }
  });

  it('same version + same content returns already installed', async () => {
    const recipe = makeValidRecipe();
    const configPath = makeConfigFile(['github://guardrail-dev/recipes/']);
    const registryDir = join(tempDir, 'recipes');
    const opts = { configPath, registryDir, loadRemoteRecipe: async () => recipe };

    await installFromGitHub(source, opts);
    const result2 = await installFromGitHub(source, opts);
    assert.equal(result2.installed, false);
    assert.ok(result2.note?.includes('already installed'));
  });

  it('falls back to authenticated GitHub API loader when raw fetch fails', async () => {
    const recipe = makeValidRecipe();
    const configPath = makeConfigFile(['github://guardrail-dev/recipes/']);
    const registryDir = join(tempDir, 'recipes');

    const result = await installFromGitHub(source, {
      configPath,
      registryDir,
      loadRemoteRecipe: async () => {
        throw new Error('HTTP 404 fetching recipe from raw.githubusercontent.com');
      },
      loadGitHubRecipeFromApi: async (parsed, sha) => {
        assert.equal(parsed.owner, 'guardrail-dev');
        assert.equal(sha, fullSha);
        return recipe;
      },
    });

    assert.equal(result.installed, true);
    assert.equal(result.id, 'test-recipe');
  });
});

// ---------------------------------------------------------------------------
// listInstalled / listVersions ignore .pins
// ---------------------------------------------------------------------------

describe('listInstalled and listVersions ignore .pins', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = tmpDir();
    // Create a recipe with a .pins directory
    const recipeDir = join(tempDir, 'test-recipe');
    mkdirSync(recipeDir, { recursive: true });
    mkdirSync(join(recipeDir, '.pins'), { recursive: true });
    writeFileSync(join(recipeDir, '1.0.0.json'), JSON.stringify(makeValidRecipe()));
    writeFileSync(join(recipeDir, '.pins', '1.0.0.json'), JSON.stringify({ sha: 'abc' }));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('listInstalled does not include .pins entries', () => {
    const results = listInstalled(tempDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'test-recipe');
  });

  it('listVersions does not include .pins entries', () => {
    const versions = listVersions('test-recipe', tempDir);
    assert.equal(versions.length, 1);
    assert.equal(versions[0], '1.0.0');
  });
});

// ---------------------------------------------------------------------------
// verifyPinnedRecipeSource
// ---------------------------------------------------------------------------

describe('verifyPinnedRecipeSource', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = tmpDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setupRecipeWithPin(recipe, pinOverrides = {}) {
    const recipeDir = join(tempDir, recipe.id);
    mkdirSync(recipeDir, { recursive: true });
    const recipePath = join(recipeDir, `${recipe.version}.json`);
    writeFileSync(recipePath, JSON.stringify(recipe, null, 2));

    const pinsDir = join(recipeDir, '.pins');
    mkdirSync(pinsDir, { recursive: true });
    const pinPath = join(pinsDir, `${recipe.version}.json`);
    const pin = {
      source: 'github://guardrail-dev/recipes/custom/test-recipe.json@' + 'a'.repeat(40),
      sha: 'a'.repeat(40),
      rawUrl: 'https://raw.githubusercontent.com/guardrail-dev/recipes/' + 'a'.repeat(40) + '/custom/test-recipe.json',
      content_hash: hashRecipe(recipe),
      ...pinOverrides,
    };
    writeFileSync(pinPath, JSON.stringify(pin));

    return recipePath;
  }

  it('passes when local hash matches pin', async () => {
    const recipe = makeValidRecipe();
    const recipePath = setupRecipeWithPin(recipe);

    // Should not throw
    await verifyPinnedRecipeSource(recipe, recipePath, { skipRemoteVerify: true });
  });

  it('exit 12 when local hash diverges from pin', async () => {
    const recipe = makeValidRecipe();
    const recipePath = setupRecipeWithPin(recipe, {
      content_hash: 'wrong_hash_value',
    });

    try {
      await verifyPinnedRecipeSource(recipe, recipePath, { skipRemoteVerify: true });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.exitCode, 12);
      assert.ok(err.message.includes('Pin verification failed'));
    }
  });

  it('error message includes expected vs got hashes', async () => {
    const recipe = makeValidRecipe();
    const actualHash = hashRecipe(recipe);
    const recipePath = setupRecipeWithPin(recipe, {
      content_hash: 'expected_hash_here',
    });

    try {
      await verifyPinnedRecipeSource(recipe, recipePath, { skipRemoteVerify: true });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('Expected: expected_hash_here'));
      assert.ok(err.message.includes(`Got:      ${actualHash}`));
    }
  });

  it('error message includes re-install command', async () => {
    const recipe = makeValidRecipe();
    const recipePath = setupRecipeWithPin(recipe, {
      content_hash: 'wrong_hash',
    });

    try {
      await verifyPinnedRecipeSource(recipe, recipePath, { skipRemoteVerify: true });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('guardrail recipe install'));
    }
  });

  it('proceeds when no pin metadata exists', async () => {
    const recipe = makeValidRecipe();
    const recipeDir = join(tempDir, recipe.id);
    mkdirSync(recipeDir, { recursive: true });
    const recipePath = join(recipeDir, `${recipe.version}.json`);
    writeFileSync(recipePath, JSON.stringify(recipe));

    // No .pins directory — should not throw
    await verifyPinnedRecipeSource(recipe, recipePath, { skipRemoteVerify: true });
  });

  it('skipRemoteVerify=true skips remote check', async () => {
    const recipe = makeValidRecipe();
    const recipePath = setupRecipeWithPin(recipe);

    // With skipRemoteVerify, even if rawUrl is bogus, it should pass
    await verifyPinnedRecipeSource(recipe, recipePath, { skipRemoteVerify: true });
  });

  it('network error during remote verify is not fatal', async () => {
    const recipe = makeValidRecipe();
    const recipePath = setupRecipeWithPin(recipe, {
      // rawUrl points to something that won't resolve
      rawUrl: 'https://localhost:1/nonexistent',
    });

    // Should not throw — network failure is non-fatal
    await verifyPinnedRecipeSource(recipe, recipePath, { skipRemoteVerify: false });
  });

  it('falls back to authenticated GitHub API loader during remote verify', async () => {
    const recipe = makeValidRecipe();
    const recipePath = setupRecipeWithPin(recipe);

    await verifyPinnedRecipeSource(recipe, recipePath, {
      skipRemoteVerify: false,
      loadRemoteRecipe: async () => {
        throw new Error('HTTP 404 fetching recipe from raw.githubusercontent.com');
      },
      loadGitHubRecipeFromApi: async (parsed, sha) => {
        assert.equal(parsed.owner, 'guardrail-dev');
        assert.equal(sha, 'a'.repeat(40));
        return recipe;
      },
    });
  });
});

// ---------------------------------------------------------------------------
// CLI bare recipe name detection
// ---------------------------------------------------------------------------

describe('CLI bare recipe name detection', () => {
  it('parses github:// source as recipe-install', () => {
    // This only tests argument parsing — not execution
    const sha = 'a'.repeat(40);
    const result = parseArgs(['recipe', 'install', `github://o/r/file.json@${sha}`]);
    assert.equal(result.subcommand, 'recipe-install');
    assert.equal(result.recipePath, `github://o/r/file.json@${sha}`);
  });

  it('parses recipe publish with flags', () => {
    const result = parseArgs(['recipe', 'publish', '--name', 'my-recipe', '--category', 'custom', '--dry-run']);
    assert.equal(result.subcommand, 'recipe-publish');
    assert.equal(result.name, 'my-recipe');
    assert.equal(result.category, 'custom');
    assert.equal(result.dryRun, true);
  });

  it('parses recipe publish with all flags', () => {
    const result = parseArgs(['recipe', 'publish', '--name', 'r', '--category', 'git', '--description', 'desc', '--version', '2.0.0', '--author', 'me']);
    assert.equal(result.subcommand, 'recipe-publish');
    assert.equal(result.name, 'r');
    assert.equal(result.category, 'git');
    assert.equal(result.description, 'desc');
    assert.equal(result.version, '2.0.0');
    assert.equal(result.author, 'me');
  });

  it('parses recipe publish --manifest alias', () => {
    const result = parseArgs(['recipe', 'publish', '--name', 'r', '--category', 'git', '--manifest', '.guardrail/approved.json']);
    assert.equal(result.subcommand, 'recipe-publish');
    assert.equal(result.manifestPath, '.guardrail/approved.json');
  });

  it('keeps accepting recipe publish --manifest-path', () => {
    const result = parseArgs(['recipe', 'publish', '--name', 'r', '--category', 'git', '--manifest-path', '.guardrail/approved.json']);
    assert.equal(result.subcommand, 'recipe-publish');
    assert.equal(result.manifestPath, '.guardrail/approved.json');
  });

  it('collects repeated --input values into arrays', () => {
    const result = parseArgs([
      'run',
      '--recipe', 'codex-exec',
      '--input', 'input_files=src/a.js',
      '--input', 'input_files=src/b.js',
      '--dry-run',
    ]);
    assert.equal(result.subcommand, 'run');
    assert.equal(result.recipeId, 'codex-exec');
    assert.deepEqual(result.inputs.input_files, ['src/a.js', 'src/b.js']);
  });

  it('collects repeated workflow --recipe-search-dir flags into arrays', () => {
    const result = parseArgs([
      'workflow', 'run',
      '--definition', 'workflows/review.json',
      '--recipe-search-dir', '/tmp/guardian-recipes',
      '--recipe-search-dir', '/opt/shared-recipes',
    ]);
    assert.equal(result.subcommand, 'workflow');
    assert.equal(result.definition, 'workflows/review.json');
    assert.deepEqual(result.recipeSearchDirs, ['/tmp/guardian-recipes', '/opt/shared-recipes']);
  });

  it('parses workflow --allow-unverified', () => {
    const result = parseArgs([
      'workflow', 'run',
      '--definition', 'workflows/review.json',
      '--allow-unverified',
    ]);
    assert.equal(result.subcommand, 'workflow');
    assert.equal(result.allowUnverified, true);
  });

  it('parses lane start flags', () => {
    const result = parseArgs([
      'lane', 'start',
      '--id', 'claude-live',
      '--tool', 'codex',
      '--scope-type', 'paths',
      '--scope-mode', 'block',
      '--scope-path', 'docs',
      '--scope-path', 'tests',
      '--profile', 'dev',
      '--system-prompt', 'Answer briefly.',
      '--json',
    ]);
    assert.equal(result.subcommand, 'lane-start');
    assert.equal(result.laneOpts.id, 'claude-live');
    assert.equal(result.laneOpts.tool, 'codex');
    assert.equal(result.laneOpts.scopeType, 'paths');
    assert.equal(result.laneOpts.scopeMode, 'block');
    assert.deepEqual(result.laneOpts.scopePaths, ['docs', 'tests']);
    assert.equal(result.laneOpts.profile, 'dev');
    assert.equal(result.laneOpts.systemPrompt, 'Answer briefly.');
    assert.equal(result.json, true);
  });

  it('parses lane send flags', () => {
    const result = parseArgs([
      'lane', 'send',
      '--id', 'claude-live',
      '--prompt', '2x3=?',
      '--timeout-ms', '5000',
    ]);
    assert.equal(result.subcommand, 'lane-send');
    assert.equal(result.laneOpts.id, 'claude-live');
    assert.equal(result.laneOpts.prompt, '2x3=?');
    assert.equal(result.laneOpts.timeoutMs, '5000');
  });

  it('parses lane status flags', () => {
    const result = parseArgs([
      'lane', 'status',
      '--id', 'claude-live',
      '--json',
    ]);
    assert.equal(result.subcommand, 'lane-status');
    assert.equal(result.laneOpts.id, 'claude-live');
    assert.equal(result.json, true);
  });

  it('parses lane list flags', () => {
    const result = parseArgs([
      'lane', 'list',
      '--guardrail-repo', '/tmp/repo',
      '--lanes-dir', '.guardrail/lanes',
      '--json',
    ]);
    assert.equal(result.subcommand, 'lane-list');
    assert.equal(result.laneOpts.guardrailRepo, '/tmp/repo');
    assert.equal(result.laneOpts.lanesDir, '.guardrail/lanes');
    assert.equal(result.json, true);
  });

  it('parses lane scope flags', () => {
    const result = parseArgs([
      'lane', 'start',
      '--id', 'claude-live',
      '--scope-type', 'paths',
      '--scope-mode', 'block',
      '--scope-path', 'src',
      '--scope-path', 'tests',
      '--json',
    ]);
    assert.equal(result.subcommand, 'lane-start');
    assert.equal(result.laneOpts.scopeType, 'paths');
    assert.equal(result.laneOpts.scopeMode, 'block');
    assert.deepEqual(result.laneOpts.scopePaths, ['src', 'tests']);
    assert.equal(result.json, true);
  });

  it('parses lane result flags', () => {
    const result = parseArgs([
      'lane', 'result',
      '--id', 'claude-live',
      '--request-id', 'req-123',
      '--json',
    ]);
    assert.equal(result.subcommand, 'lane-result');
    assert.equal(result.laneOpts.id, 'claude-live');
    assert.equal(result.laneOpts.requestId, 'req-123');
    assert.equal(result.json, true);
  });

  it('parses lane stop flags', () => {
    const result = parseArgs([
      'lane', 'stop',
      '--id', 'claude-live',
    ]);
    assert.equal(result.subcommand, 'lane-stop');
    assert.equal(result.laneOpts.id, 'claude-live');
  });

  it('parses lane prune flags', () => {
    const result = parseArgs([
      'lane', 'prune',
      '--include-failed', 'true',
      '--json',
    ]);
    assert.equal(result.subcommand, 'lane-prune');
    assert.equal(result.laneOpts.includeFailed, 'true');
    assert.equal(result.json, true);
  });

  it('parses repo status flags', () => {
    const result = parseArgs([
      'repo', 'status',
      '--path', '/tmp/example-repo',
      '--json',
    ]);
    assert.equal(result.subcommand, 'repo-status');
    assert.equal(result.repoOpts.path, '/tmp/example-repo');
    assert.equal(result.json, true);
  });

  it('parses template create flags', () => {
    const result = parseArgs([
      'template', 'create',
      '--from-manifest', '.guardrail/approved.json',
      '--name', 'npm-publish',
      '--output', '.guardrail/templates/npm-publish.json',
      '--json',
    ]);
    assert.equal(result.subcommand, 'template-create');
    assert.equal(result.manifestPath, '.guardrail/approved.json');
    assert.equal(result.name, 'npm-publish');
    assert.equal(result.outputPath, '.guardrail/templates/npm-publish.json');
    assert.equal(result.json, true);
  });

  it('parses template list flags', () => {
    const result = parseArgs([
      'template', 'list',
      '--templates-dir', '.guardrail/templates',
      '--json',
    ]);
    assert.equal(result.subcommand, 'template-list');
    assert.equal(result.templatesDir, '.guardrail/templates');
    assert.equal(result.json, true);
  });

  it('parses template publish flags', () => {
    const result = parseArgs([
      'template', 'publish',
      '--template', '.guardrail/templates/npm-publish.json',
      '--name', 'npm-publish',
      '--category', 'packages',
      '--version', '1.2.0',
      '--author', 'me',
      '--dry-run',
    ]);
    assert.equal(result.subcommand, 'template-publish');
    assert.equal(result.template, '.guardrail/templates/npm-publish.json');
    assert.equal(result.name, 'npm-publish');
    assert.equal(result.category, 'packages');
    assert.equal(result.version, '1.2.0');
    assert.equal(result.author, 'me');
    assert.equal(result.dryRun, true);
  });
});

// ---------------------------------------------------------------------------
// loadRawJson (basic tests without real network)
// ---------------------------------------------------------------------------

describe('loadRawJson', () => {
  it('rejects on network error (unresolvable host)', async () => {
    await assert.rejects(
      () => loadRawJson('https://localhost:1/nonexistent', { timeout: 1000 }),
      /Error|ECONNREFUSED/
    );
  });

  it('exported from recipe.js', () => {
    assert.equal(typeof loadRawJson, 'function');
  });
});
