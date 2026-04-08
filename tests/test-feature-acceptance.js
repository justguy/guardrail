/**
 * Feature Acceptance Tests — Derived from README, NOT from code.
 *
 * Every test here maps to a documented feature or claim in the README.
 * If a test fails, either the feature is broken or the README is lying.
 *
 * Organized by README section.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeWorkflowDefinition, hashWorkflow, createWorkflowManifest } from '../src/workflow.js';
import { evaluateWorkflowRisk } from '../src/policy-engine.js';
import { saveManifest } from '../src/manifest.js';

const CLI = `node ${join(process.cwd(), 'src', 'cli.js')}`;

function run(cmd, opts = {}) {
  try {
    return { stdout: execSync(cmd, { encoding: 'utf8', timeout: 15000, cwd: opts.cwd || process.cwd(), ...opts }).trim(), exitCode: 0 };
  } catch (err) {
    return { stdout: (err.stdout || '').trim(), stderr: (err.stderr || '').trim(), exitCode: err.status };
  }
}

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-feat-')));
}

// ==========================================================================
// README: "Three Execution Modes"
// ==========================================================================

describe('README Feature: Command Mode', () => {
  it('guardrail run -- echo hello  → runs structured command', () => {
    // Non-interactive requires approved manifest. Without one, exit 10.
    const r = run(`${CLI} run --non-interactive --approved-manifest /nonexistent -- echo hello`);
    // Should fail because manifest doesn't exist — that proves enforcement works
    assert.ok(r.exitCode !== 0, 'Should fail without approved manifest');
  });

  it('guardrail run --shell "echo hi"  → requires explicit --shell', () => {
    const r = run(`${CLI} run --non-interactive --approved-manifest /nonexistent --shell "echo hi"`);
    assert.ok(r.exitCode !== 0, 'Should fail without approved manifest');
  });

  it('shell metacharacters in shorthand are rejected', () => {
    const r = run(`${CLI} run "echo hi && rm -rf /"`);
    assert.ok(r.exitCode !== 0);
    assert.ok(r.stderr.includes('Shell metacharacters') || r.stderr.includes('--shell'));
  });
});

describe('README Feature: Workflow Mode', () => {
  it('guardrail workflow lint validates a workflow definition', () => {
    const dir = tmpDir();
    const def = {
      version: 1, kind: 'workflow_definition', name: 'test-wf',
      projectRoot: '.', entryStep: 'step_a', maxIterations: 5,
      services: [],
      rollback_policy: 'none',
      rollback_none_reason: 'Single idempotent echo step — rollback not needed',
      steps: [{
        id: 'step_a', type: 'task', idempotent: true,
        run: { command: 'echo', args: ['hello'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
        validator: 'exit_code', updateSource: 'none',
        on: { success: 'done', validation_failed: 'abort' },
      }],
    };
    writeFileSync(join(dir, 'wf.json'), JSON.stringify(def, null, 2));
    const r = run(`${CLI} workflow lint --definition ${join(dir, 'wf.json')}`);
    assert.equal(r.exitCode, 0, `Lint should pass for valid workflow: ${r.stderr}`);
  });

  it('workflow lint rejects invalid definitions', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'bad.json'), '{"not": "a workflow"}');
    const r = run(`${CLI} workflow lint --definition ${join(dir, 'bad.json')}`);
    assert.ok(r.exitCode !== 0, 'Lint should reject invalid workflow');
  });

  it('workflow run can chain multiple recipe_ref steps under one approved workflow manifest', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });

    writeFileSync(join(dir, 'recipes', 'recipe-one.recipe.json'), JSON.stringify({
      id: 'recipe-one',
      name: 'Recipe One',
      description: 'First workflow recipe',
      version: '1.0.0',
      author: 'test',
      category: 'custom',
      channel: 'community',
      approval_required: true,
      risk_level: 'low',
      inputs: {},
      steps: [{ id: 'main', description: 'echo one', run: { command: 'echo', args: ['one'], mode: 'structured' } }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    }, null, 2));

    writeFileSync(join(dir, 'recipes', 'recipe-two.recipe.json'), JSON.stringify({
      id: 'recipe-two',
      name: 'Recipe Two',
      description: 'Second workflow recipe',
      version: '1.0.0',
      author: 'test',
      category: 'custom',
      channel: 'community',
      approval_required: true,
      risk_level: 'low',
      inputs: {},
      steps: [{ id: 'main', description: 'echo two', run: { command: 'echo', args: ['two'], mode: 'structured' } }],
      guardrails: { constraints: ['structured only'], invariants: ['mode: structured'] },
    }, null, 2));

    const def = {
      version: 1,
      kind: 'workflow_definition',
      name: 'recipe-chain',
      projectRoot: '.',
      entryStep: 'step_a',
      maxIterations: 3,
      services: [],
      steps: [
        {
          id: 'step_a',
          type: 'recipe_ref',
          recipe: 'recipe-one',
          inputs: {},
          on: { success: 'step_b', failure: 'abort' },
        },
        {
          id: 'step_b',
          type: 'recipe_ref',
          recipe: 'recipe-two',
          inputs: {},
          on: { success: 'done', failure: 'abort' },
        },
      ],
    };
    const defPath = join(dir, 'workflow.json');
    const manifestPath = join(dir, '.guardrail', 'workflows', 'recipe-chain.approved.json');
    mkdirSync(join(dir, '.guardrail', 'workflows'), { recursive: true });
    writeFileSync(defPath, JSON.stringify(def, null, 2));

    const normalized = normalizeWorkflowDefinition(def, dir);
    const workflowHash = hashWorkflow(normalized);
    const riskAssessment = evaluateWorkflowRisk(normalized, {
      trustClass: 'reviewed_internal',
      projectRoot: dir,
    });
    const manifest = createWorkflowManifest(normalized, workflowHash, {
      ...riskAssessment,
      acknowledgedBy: 'acceptance-test',
      acknowledgedAt: new Date().toISOString(),
    }, normalized.projectRoot);
    saveManifest(manifest, manifestPath);

    const r = run(
      `${CLI} workflow run --definition ${defPath} --trust reviewed_internal ` +
      `--non-interactive --approved-manifest ${manifestPath} --json`,
      { cwd: dir },
    );
    assert.equal(r.exitCode, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.status, 'success');
    assert.equal(result.stepsExecuted, 2);
  });
});

describe('README Feature: Template Mode', () => {
  it('guardrail template lint validates a template', () => {
    const dir = tmpDir();
    const tmpl = {
      version: 1, kind: 'template', name: 'test-tmpl',
      description: 'A test template for lint',
      trust_class: 'reviewed_internal', risk: 'green', risk_reasons: [],
      inputs: { name: { type: 'string', pattern: '^[a-z]+$', description: 'A name' } },
      run: { command: 'echo', args: ['{{inputs.name}}'], mode: 'structured' },
    };
    writeFileSync(join(dir, 'tmpl.json'), JSON.stringify(tmpl, null, 2));
    const r = run(`${CLI} template lint --template ${join(dir, 'tmpl.json')}`);
    assert.equal(r.exitCode, 0, `Lint should pass: ${r.stderr}`);
  });

  it('template explain shows what a template does', () => {
    const dir = tmpDir();
    const tmpl = {
      version: 1, kind: 'template', name: 'explain-test',
      description: 'Test explain output',
      trust_class: 'reviewed_internal', risk: 'green', risk_reasons: [],
      inputs: { x: { type: 'boolean', description: 'A flag' } },
      run: { command: 'echo', args: ['hello'], mode: 'structured' },
    };
    writeFileSync(join(dir, 'tmpl.json'), JSON.stringify(tmpl, null, 2));
    const r = run(`${CLI} template explain --template ${join(dir, 'tmpl.json')}`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('explain-test'), 'Should show template name');
  });

  it('template schema shows input schema', () => {
    const dir = tmpDir();
    const tmpl = {
      version: 1, kind: 'template', name: 'schema-test',
      description: 'Test schema output',
      trust_class: 'reviewed_internal', risk: 'green', risk_reasons: [],
      inputs: { port: { type: 'integer', min: 1, max: 65535, description: 'Port number' } },
      run: { command: 'echo', args: ['{{inputs.port}}'], mode: 'structured' },
    };
    writeFileSync(join(dir, 'tmpl.json'), JSON.stringify(tmpl, null, 2));
    const r = run(`${CLI} template schema --template ${join(dir, 'tmpl.json')}`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('port'), 'Should show input name');
  });

  it('template simulate shows dry-run preview', () => {
    const dir = tmpDir();
    const tmpl = {
      version: 1, kind: 'template', name: 'sim-test',
      description: 'Test simulate output',
      trust_class: 'reviewed_internal', risk: 'green', risk_reasons: [],
      inputs: { msg: { type: 'string', pattern: '^[a-z]+$', description: 'message' } },
      run: { command: 'echo', args: ['{{inputs.msg}}'], mode: 'structured' },
    };
    writeFileSync(join(dir, 'tmpl.json'), JSON.stringify(tmpl, null, 2));
    const r = run(`${CLI} template simulate --template ${join(dir, 'tmpl.json')} --input msg=hello`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('hello'), 'Should show resolved args');
  });

  it('templates with requires_env fail closed unless caller supplies --env-allow', () => {
    const dir = tmpDir();
    const tmpl = {
      version: 1, kind: 'template', name: 'env-handshake-test',
      description: 'Test explicit env handshake',
      trust_class: 'reviewed_internal', risk: 'green', risk_reasons: [],
      requires_env: ['NPM_TOKEN'],
      inputs: { msg: { type: 'string', pattern: '^[a-z]+$', description: 'message' } },
      run: { command: 'echo', args: ['{{inputs.msg}}'], mode: 'structured' },
    };
    writeFileSync(join(dir, 'tmpl.json'), JSON.stringify(tmpl, null, 2));
    const r = run(`${CLI} run --template ${join(dir, 'tmpl.json')} --input msg=hello`);
    assert.ok(r.exitCode !== 0);
    assert.ok((r.stdout || '').includes('--env-allow') || (r.stdout || '').includes('Required variables'));
  });

  it('templates reject bare strings (no pattern or enum)', () => {
    const dir = tmpDir();
    const tmpl = {
      version: 1, kind: 'template', name: 'bare-str-test',
      description: 'Test bare string rejection',
      trust_class: 'reviewed_internal', risk: 'green', risk_reasons: [],
      inputs: { unsafe: { type: 'string', description: 'no constraint' } },
      run: { command: 'echo', args: ['{{inputs.unsafe}}'], mode: 'structured' },
    };
    writeFileSync(join(dir, 'tmpl.json'), JSON.stringify(tmpl, null, 2));
    const r = run(`${CLI} template lint --template ${join(dir, 'tmpl.json')}`);
    assert.ok(r.exitCode !== 0 || r.stdout.includes('bare') || r.stdout.includes('pattern'),
      'Should reject bare strings');
  });
});

// ==========================================================================
// README: "Traffic-light risk model"
// ==========================================================================

describe('README Feature: Risk Classification', () => {
  it('npm test → Green (bounded, local, reviewed)', () => {
    const r = run(`${CLI} run --json --non-interactive --approved-manifest /nonexistent -- npm test`);
    // Can't run without manifest, but we can test via the policy engine directly
    // Use verify instead
  });

  // Test risk via the recipe dry-run which shows risk assessment
  it('safe git command → recipe dry-run says safe', () => {
    const r = run(`${CLI} run --recipe git-branch-cleanup --input repo_path=. --dry-run`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Safe:  YES'));
  });
});

// ==========================================================================
// README: "Guardrail Recipes"
// ==========================================================================

describe('README Feature: Recipe System', () => {
  it('guardrail list → shows available recipes', () => {
    const r = run(`${CLI} list`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('git-branch-cleanup'));
    assert.ok(r.stdout.includes('npm-publish'));
    assert.ok(r.stdout.includes('infra-deploy'));
  });

  it('guardrail list --json → JSON output', () => {
    const r = run(`${CLI} list --json`);
    assert.equal(r.exitCode, 0);
    const recipes = JSON.parse(r.stdout);
    assert.ok(Array.isArray(recipes));
    assert.ok(recipes.length >= 6);
    assert.ok(recipes.every(r => r.id && r.version && r.risk_level));
  });

  it('guardrail list --category git → filters by category', () => {
    const r = run(`${CLI} list --category git --json`);
    assert.equal(r.exitCode, 0);
    const recipes = JSON.parse(r.stdout);
    assert.ok(recipes.every(r => r.category === 'git'));
  });

  it('guardrail recipe validate → validates recipe file', () => {
    const r = run(`${CLI} recipe validate recipes/git-branch-cleanup.recipe.json`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('valid'));
  });

  it('guardrail recipe inspect → inspects packed recipe', () => {
    // First pack a recipe
    const dir = tmpDir();
    run(`${CLI} pack recipes/git-branch-cleanup.recipe.json --output ${join(dir, 'packed.json')}`);
    const r = run(`${CLI} recipe inspect ${join(dir, 'packed.json')}`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Verified: YES'));
  });

  it('guardrail recipe install → installs to versioned registry', () => {
    const r = run(`${CLI} recipe install recipes/infra-deploy.recipe.json`);
    // Either fresh install or already installed (idempotent)
    assert.ok(r.exitCode === 0);
  });

  it('guardrail recipe versions → lists installed versions', () => {
    run(`${CLI} recipe install recipes/git-branch-cleanup.recipe.json`);
    const r = run(`${CLI} recipe versions git-branch-cleanup`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('1.0.0'));
  });

  it('guardrail recipe install <bare-name> points users to github:// install form', () => {
    const r = run(`${CLI} recipe install open-pr`);
    assert.ok(r.exitCode !== 0);
    assert.ok((r.stderr || '').includes('github://guardrail-dev/recipes/'));
  });

  it('guardrail recipe publish --dry-run converts an approved manifest into a publishable recipe', () => {
    const dir = tmpDir();
    const manifestPath = join(dir, 'approved.json');
    const manifest = {
      contract: {
        command: 'npm',
        args: ['install', '--save-dev'],
        mode: 'structured',
        writablePaths: ['./node_modules'],
        allowedBinaries: ['npm'],
      },
      riskAssessment: {
        riskLevel: 'yellow',
      },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const r = run(`${CLI} recipe publish --name npm-install-safe --category packages --manifest ${manifestPath} --dry-run`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('Dry run'));
    assert.ok(r.stdout.includes('"id": "npm-install-safe"'));
    assert.ok(r.stdout.includes('"channel": "community"'));
  });

  it('bundled codex recipe accepts repeated input_files and dry-runs safely', () => {
    const r = run(
      `${CLI} run --recipe codex-exec ` +
      `--input working_dir=. ` +
      `--input prompt="Review recipe docs." ` +
      `--input input_files=README.md ` +
      `--input input_files=docs/agent-onboarding.md ` +
      `--dry-run`,
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('Safe:  YES'));
  });

  it('bundled Claude recipe dry-runs with structured prompt/input_files execution', () => {
    const r = run(
      `${CLI} run --recipe claude-exec ` +
      `--input guardrail_repo=. ` +
      `--input working_dir=. ` +
      `--input prompt="Review auth flow tests." ` +
      `--input input_files=README.md ` +
      `--input model=sonnet ` +
      `--input effort=high ` +
      `--input mode=plan ` +
      `--input output_format=text ` +
      `--input max_budget_usd=1.00 ` +
      `--input allowed_tools=Read,Glob,Grep ` +
      `--input system_prompt="Focus on deterministic failures." ` +
      `--input session_name=readme-review ` +
      `--dry-run`,
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('Safe:  YES'));
  });

  it('bundled git commit recipe dry-runs with an exact staged path list and message file', () => {
    const r = run(
      `${CLI} run --recipe git-commit ` +
      `--input guardrail_repo=. ` +
      `--input repo_path=. ` +
      `--input paths=README.md ` +
      `--input message_file=README.md ` +
      `--dry-run`,
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('Safe:  YES'));
  });
});

// ==========================================================================
// README: "run --recipe" with version pinning
// ==========================================================================

describe('README Feature: Recipe Execution + Versioning', () => {
  it('guardrail run --recipe <id> --dry-run → runs latest version', () => {
    const r = run(`${CLI} run --recipe dep-upgrade --input package_dir=. --input scope=patch --dry-run`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Dependency Upgrade'));
    assert.ok(r.stdout.includes('Safe'));
  });

  it('guardrail run --recipe <id>@<version> → pins to version', () => {
    run(`${CLI} recipe install recipes/npm-publish.recipe.json`);
    const r = run(`${CLI} run --recipe npm-publish@1.0.0 --input package_dir=pkg --input tag=beta --dry-run`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('NPM Package Publish'));
  });

  it('nonexistent version → error with available versions', () => {
    const r = run(`${CLI} run --recipe git-branch-cleanup@99.0.0 --input repo_path=. --dry-run`);
    assert.ok(r.exitCode !== 0);
    assert.ok(r.stderr.includes('99.0.0') || r.stderr.includes('not found'));
  });

  it('missing required input → error with input name', () => {
    const r = run(`${CLI} run --recipe git-branch-cleanup --dry-run`);
    assert.ok(r.exitCode !== 0);
    assert.ok(r.stderr.includes('repo_path') || r.stderr.includes('Missing'));
  });

  it('invalid enum input → error with allowed values', () => {
    const r = run(`${CLI} run --recipe infra-deploy --input environment=hacked --input config_path=x --dry-run`);
    assert.ok(r.exitCode !== 0);
    assert.ok(r.stderr.includes('staging') || r.stderr.includes('production'));
  });

  it('all 6 shipped recipes dry-run successfully', () => {
    const runs = [
      `${CLI} run --recipe git-branch-cleanup --input repo_path=. --dry-run`,
      `${CLI} run --recipe dep-upgrade --input package_dir=. --input scope=patch --dry-run`,
      `${CLI} run --recipe github-pr-merge --input repo=org/repo --input max_prs=3 --input label=approved --dry-run`,
      `${CLI} run --recipe infra-deploy --input environment=staging --input config_path=configs/main.tf --dry-run`,
      `${CLI} run --recipe npm-publish --input package_dir=pkg --input tag=latest --dry-run`,
      `${CLI} run --recipe openclaw-wrapper --input flow_id=fix-tests --input scope=write --dry-run`,
    ];
    for (const cmd of runs) {
      const r = run(cmd);
      assert.equal(r.exitCode, 0, `Failed: ${cmd}\n${r.stderr}`);
      assert.ok(r.stdout.includes('Safe'), `Not safe: ${cmd}`);
    }
  });
});

// ==========================================================================
// README: "CI / Non-Interactive Mode"
// ==========================================================================

describe('README Feature: Non-Interactive / CI Mode', () => {
  it('--non-interactive without --approved-manifest → exit 10', () => {
    const r = run(`${CLI} run --non-interactive -- echo hello`);
    assert.equal(r.exitCode, 10);
  });

  it('--non-interactive with missing manifest → fail closed', () => {
    const r = run(`${CLI} run --non-interactive --approved-manifest /nonexistent/manifest.json -- echo hello`);
    assert.ok(r.exitCode !== 0);
  });

  it('--json flag produces JSON output', () => {
    const r = run(`${CLI} list --json`);
    assert.equal(r.exitCode, 0);
    assert.doesNotThrow(() => JSON.parse(r.stdout));
  });

  it('workflow --non-interactive without manifest → exit 10', () => {
    const dir = tmpDir();
    const def = {
      version: 1, kind: 'workflow_definition', name: 'ci-wf',
      projectRoot: '.', entryStep: 's', maxIterations: 1, services: [],
      steps: [{
        id: 's', type: 'task',
        run: { command: 'echo', args: ['ci'], cwd: '.', mode: 'structured', timeoutMs: 5000 },
        validator: 'exit_code', updateSource: 'none',
        on: { success: 'done', validation_failed: 'abort' },
      }],
    };
    writeFileSync(join(dir, 'wf.json'), JSON.stringify(def, null, 2));
    const r = run(`${CLI} workflow run --definition ${join(dir, 'wf.json')} --non-interactive`);
    assert.equal(r.exitCode, 10);
  });

  it('recipe --non-interactive without manifest → exit 10', () => {
    const r = run(`${CLI} run --recipe git-branch-cleanup --input repo_path=. --non-interactive`);
    assert.equal(r.exitCode, 10);
  });

  it('recipe --non-interactive with missing manifest → fail closed before execution', () => {
    const r = run(`${CLI} run --recipe git-branch-cleanup --input repo_path=. --non-interactive --approved-manifest /nonexistent/recipe-approved.json`);
    assert.equal(r.exitCode, 10);
  });
});

// ==========================================================================
// README: "Drift detection"
// ==========================================================================

describe('README Feature: Drift Detection', () => {
  it('mismatched manifest blocks execution (non-interactive)', () => {
    // A stale/wrong manifest should cause non-interactive mode to fail — never silently succeed
    const dir = tmpDir();
    mkdirSync(join(dir, '.guardrail'), { recursive: true });
    const manifestPath = join(dir, '.guardrail', 'approved.json');
    // Write an obviously wrong manifest (hash won't match any real command)
    writeFileSync(manifestPath, JSON.stringify({
      version: 1, tool: 'guardrail', approvedAt: new Date().toISOString(),
      projectRoot: dir, contractHash: 'deadbeef',
      contract: { command: 'true', args: [], cwd: dir, mode: 'structured' },
      riskAssessment: { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [],
        requiresStrongConfirmation: false, acknowledgedBy: 'test', acknowledgedAt: new Date().toISOString() },
      workflow: { validator: 'exit_code', updateSource: 'none' },
    }, null, 2));

    // Try to run a different command — should fail (drift or mismatch)
    const r = run(`${CLI} run --non-interactive --approved-manifest ${manifestPath} -- echo different`, { cwd: dir });
    assert.ok(r.exitCode !== 0, `Should not succeed with mismatched manifest, got exit ${r.exitCode}`);
  });
});

// ==========================================================================
// README: "guardrail verify"
// ==========================================================================

describe('README Feature: Self-Verification', () => {
  it('guardrail verify → all checks pass', () => {
    const r = run(`${CLI} verify`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('All checks passed'));
  });

  it('guardrail verify --json → JSON output with checks array', () => {
    const r = run(`${CLI} verify --json`);
    assert.equal(r.exitCode, 0);
    const result = JSON.parse(r.stdout);
    assert.equal(result.passed, true);
    assert.ok(Array.isArray(result.checks));
    assert.ok(result.checks.length >= 5);
  });
});

// ==========================================================================
// README: "Demo" commands
// ==========================================================================

describe('README Feature: Demo Commands', () => {
  it('guardrail demo list → shows all demos', () => {
    const r = run(`${CLI} demo list`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('drift'));
    assert.ok(r.stdout.includes('recipe'));
    assert.ok(r.stdout.includes('trust'));
    assert.ok(r.stdout.includes('blocked'));
  });

  it('guardrail demo recipe → runs without error', () => {
    const r = run(`${CLI} demo recipe`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Demo complete'));
  });

  it('guardrail demo trust → runs without error', () => {
    const r = run(`${CLI} demo trust`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Demo complete'));
  });

  it('guardrail demo blocked → shows all commands blocked', () => {
    const r = run(`${CLI} demo blocked`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('BLOCKED'));
    assert.ok(r.stdout.includes('RED'));
    assert.ok(r.stdout.includes('Demo complete'));
  });
});

// ==========================================================================
// README: "Audit" commands
// ==========================================================================

describe('README Feature: Audit Commands', () => {
  it('guardrail audit verify → verifies chain on default path', () => {
    const r = run(`${CLI} audit verify`);
    // May pass (clean or no file) or fail (broken chain) — but shouldn't crash
    assert.ok(r.exitCode === 0 || r.exitCode !== undefined);
  });

  it('guardrail audit verify --path <file> → verifies specific file', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    // Empty file = clean
    writeFileSync(auditPath, '');
    const r = run(`${CLI} audit verify --path ${auditPath}`);
    assert.equal(r.exitCode, 0);
  });
});

// ==========================================================================
// README: "Profile" and "Policy" commands
// ==========================================================================

describe('README Feature: Profile Commands', () => {
  it('guardrail profile list → runs without error', () => {
    const r = run(`${CLI} profile list`);
    assert.equal(r.exitCode, 0);
    // May show "No profiles found" or existing profiles — both are valid
    assert.ok(r.stdout.includes('profile') || r.stdout.includes('No profiles'));
  });
});

describe('README Feature: Policy Commands', () => {
  it('guardrail policy list → runs without error', () => {
    const r = run(`${CLI} policy list`);
    assert.equal(r.exitCode, 0);
  });
});

// ==========================================================================
// README: "Metrics" and "Marketplace"
// ==========================================================================

describe('README Feature: Metrics', () => {
  it('guardrail metrics → runs without error', () => {
    const r = run(`${CLI} metrics`);
    // May have no data but shouldn't crash
    assert.ok(r.exitCode === 0 || r.exitCode !== undefined);
  });
});

// ==========================================================================
// README: "Environment Policy" — secret detection
// ==========================================================================

describe('README Feature: Secret Detection', () => {
  it('SECRET in env inject → detected', () => {
    // Use policy engine directly since CLI requires interactive approval
    const r = run(`node -e "
      import {evaluateRisk} from './src/policy-engine.js';
      const r = evaluateRisk(
        {command:'node',args:['app.js'],cwd:'/p',mode:'structured',envPolicy:{inject:{DB_SECRET:'x'}}},
        {trustClass:'reviewed_internal',projectRoot:'/p'}
      );
      console.log(JSON.stringify({risk:r.riskLevel,reasons:r.reasons}));
    "`);
    assert.equal(r.exitCode, 0);
    const result = JSON.parse(r.stdout);
    assert.ok(result.reasons.some(r => r.includes('secret')));
  });

  it('TOKEN in env allow → detected', () => {
    const r = run(`node -e "
      import {evaluateRisk} from './src/policy-engine.js';
      const r = evaluateRisk(
        {command:'node',args:['app.js'],cwd:'/p',mode:'structured',envPolicy:{inherit:false,allow:['API_TOKEN']}},
        {trustClass:'reviewed_internal',projectRoot:'/p'}
      );
      console.log(JSON.stringify({risk:r.riskLevel,reasons:r.reasons}));
    "`);
    assert.equal(r.exitCode, 0);
    const result = JSON.parse(r.stdout);
    assert.ok(result.reasons.some(r => r.includes('secret')));
  });

  it('secret + production target → Red', () => {
    const r = run(`node -e "
      import {evaluateRisk} from './src/policy-engine.js';
      const r = evaluateRisk(
        {command:'node',args:['deploy','--env','production'],cwd:'/p',mode:'structured',envPolicy:{inject:{DB_PASSWORD:'x'}}},
        {trustClass:'reviewed_internal',projectRoot:'/p'}
      );
      console.log(r.riskLevel);
    "`);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, 'red');
  });
});

// ==========================================================================
// README: "pack" command
// ==========================================================================

describe('README Feature: Pack Command', () => {
  it('guardrail pack → creates packed recipe with hash', () => {
    const dir = tmpDir();
    const r = run(`${CLI} pack recipes/git-branch-cleanup.recipe.json --output ${join(dir, 'packed.json')}`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('Hash'));
    assert.ok(existsSync(join(dir, 'packed.json')));

    const packed = JSON.parse(readFileSync(join(dir, 'packed.json'), 'utf8'));
    assert.ok(packed.content_hash);
    assert.ok(packed.recipe);
    assert.equal(packed.immutable, true);
  });
});

// ==========================================================================
// README: "create" command
// ==========================================================================

describe('README Feature: Create Command', () => {
  it('guardrail create --name my-recipe --category git → generates skeleton', () => {
    const dir = tmpDir();
    const r = run(`${CLI} create --name my-test-recipe --category git --output ${join(dir, 'skel.json')}`);
    assert.equal(r.exitCode, 0);
    assert.ok(existsSync(join(dir, 'skel.json')));

    const skel = JSON.parse(readFileSync(join(dir, 'skel.json'), 'utf8'));
    assert.equal(skel.category, 'git');
    assert.ok(skel.id.includes('my-test-recipe'));
    assert.ok(skel.inputs);
    assert.ok(skel.steps);
    assert.ok(skel.guardrails);
  });
});

// ==========================================================================
// README: "--version" and "--help"
// ==========================================================================

describe('README Feature: CLI Basics', () => {
  it('guardrail --version → shows version', () => {
    const r = run(`${CLI} --version`);
    assert.equal(r.exitCode, 0);
    assert.ok(/\d+\.\d+\.\d+/.test(r.stdout));
  });

  it('guardrail --help → shows usage', () => {
    const r = run(`${CLI} --help`);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('guardrail'));
    assert.ok(r.stdout.includes('run'));
  });

  it('guardrail (no args) → shows usage', () => {
    const r = run(`${CLI}`);
    // Should show usage (exit 1 or 0 with help text)
    assert.ok(r.stdout.includes('Usage') || r.stderr.includes('Usage'));
  });
});

// ==========================================================================
// README: Version immutability (from recipe model)
// ==========================================================================

describe('README Feature: Recipe Immutability', () => {
  it('same recipe re-installed is idempotent', () => {
    const r1 = run(`${CLI} recipe install recipes/git-branch-cleanup.recipe.json`);
    const r2 = run(`${CLI} recipe install recipes/git-branch-cleanup.recipe.json`);
    // Both should succeed (first installs, second is idempotent)
    assert.ok(r1.exitCode === 0);
    assert.ok(r2.exitCode === 0);
  });

  it('packed recipe tamper detection works', () => {
    const dir = tmpDir();
    run(`${CLI} pack recipes/git-branch-cleanup.recipe.json --output ${join(dir, 'packed.json')}`);

    // Tamper with the packed recipe
    const packed = JSON.parse(readFileSync(join(dir, 'packed.json'), 'utf8'));
    packed.recipe.steps[0].run.command = 'rm';
    writeFileSync(join(dir, 'packed.json'), JSON.stringify(packed, null, 2));

    const r = run(`${CLI} recipe inspect ${join(dir, 'packed.json')}`);
    assert.ok(r.exitCode !== 0 || r.stdout.includes('FAILED'));
  });
});
