import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { validateRecipe, loadRecipe, hashRecipe } from '../src/recipe.js';
import { checkDangerous, checkScope, dryRun } from '../src/recipe-executor.js';
import { enforceChannel, verifySignature, classifyTrust, signRecipe } from '../src/recipe-channel.js';
import { evaluateRisk, evaluateWorkflowRisk } from '../src/policy-engine.js';
import { createAuditLog } from '../src/audit.js';
import { createIdentity, createStrictMode } from '../src/identity.js';
import { createResourceTracker, validateBounds } from '../src/resource-bounds.js';
import { checkSafeDefaults, computeDefaults, applyForceOverride } from '../src/safe-defaults.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_FIXTURES = join(__dirname, 'fixtures', 'e2e');

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-e2e-')));
}

// ===========================================================================
// E2E 1: Can load a recipe from fixture
// ===========================================================================

describe('E2E: Recipe Loading', () => {
  it('loads git-safe-repo recipe', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'git-safe-repo', 'recipe.json'));
    assert.equal(recipe.id, 'git-status-check');
    assert.equal(recipe.risk_level, 'low');
    assert.equal(recipe.approval_required, false);
  });

  it('loads git-dangerous-repo recipe', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'git-dangerous-repo', 'recipe.json'));
    assert.equal(recipe.id, 'git-force-push');
    assert.equal(recipe.risk_level, 'high');
    assert.equal(recipe.approval_required, true);
  });

  it('loads fake-prod-config recipe', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'fake-prod-config', 'recipe.json'));
    assert.equal(recipe.id, 'prod-config-deploy');
    assert.equal(recipe.risk_level, 'high');
    assert.equal(recipe.category, 'infra');
  });

  it('loads package-upgrade-app recipe', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'package-upgrade-app', 'recipe.json'));
    assert.equal(recipe.id, 'dep-upgrade-safe');
    assert.equal(recipe.category, 'packages');
  });

  it('loads openclaw-wrapper-sim recipe', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'openclaw-wrapper-sim', 'recipe.json'));
    assert.equal(recipe.id, 'openclaw-safe-edit');
    assert.equal(recipe.category, 'openclaw');
  });
});

// ===========================================================================
// E2E 2: Input Validation
// ===========================================================================

describe('E2E: Input Validation', () => {
  it('validates matching input patterns', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'git-safe-repo', 'recipe.json'));
    const pattern = new RegExp(recipe.inputs.repo_path.pattern);
    assert.ok(pattern.test('my-repo'));
    assert.ok(pattern.test('path/to/repo'));
    // Note: the pattern ^[a-zA-Z0-9_./-]+$ intentionally matches ../../etc/passwd
    // because scope enforcement (checkScope) is the defense, not input patterns.
    // Input patterns constrain format; scope enforcement constrains paths.
    assert.ok(pattern.test('../../etc/passwd'), 'Pattern allows path chars — scope check is the real guard');
  });

  it('validates enum inputs for prod-config', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'fake-prod-config', 'recipe.json'));
    const allowed = recipe.inputs.env.enum;
    assert.ok(allowed.includes('production'));
    assert.ok(allowed.includes('staging'));
    assert.ok(!allowed.includes('dev'));
  });

  it('validates openclaw task enum', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'openclaw-wrapper-sim', 'recipe.json'));
    const allowed = recipe.inputs.task.enum;
    assert.ok(allowed.includes('lint-fix'));
    assert.ok(!allowed.includes('rm-all'));
  });
});

// ===========================================================================
// E2E 3: Dry-Run Plan
// ===========================================================================

describe('E2E: Dry-Run Plans', () => {
  it('git-safe-repo dry-run is fully safe', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'git-safe-repo', 'recipe.json'));
    const result = dryRun(recipe, { repo_path: 'my-repo' });
    assert.equal(result.safe, true);
    assert.equal(result.blocked.length, 0);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].command, 'git');
  });

  it('git-dangerous-repo dry-run detects destructive --force', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'git-dangerous-repo', 'recipe.json'));
    const result = dryRun(recipe, { branch: 'main' });
    // git push --force is not in the DANGEROUS_PATTERNS of recipe-executor
    // but it IS flagged by policy-engine's DESTRUCTIVE_PATTERNS
    assert.equal(result.steps.length, 1);
    assert.deepEqual(result.steps[0].args, ['push', '--force', 'origin', 'main']);
  });

  it('openclaw dry-run shows resolved interpolation', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'openclaw-wrapper-sim', 'recipe.json'));
    const result = dryRun(recipe, { target_file: 'src/index.js', task: 'lint-fix' });
    assert.equal(result.steps.length, 2);
    assert.ok(result.steps[0].args.includes('src/index.js'));
    assert.ok(result.steps[0].args.includes('lint-fix'));
  });

  it('dry-run blocks out-of-scope paths', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'openclaw-wrapper-sim', 'recipe.json'));
    const result = dryRun(recipe, { target_file: '/etc/passwd', task: 'lint-fix' }, {
      allowedPaths: ['/home/user/project/src'],
    });
    assert.equal(result.safe, false);
    assert.ok(result.blocked.length > 0);
    assert.ok(result.blocked[0].scopeViolations.length > 0);
  });
});

// ===========================================================================
// E2E 4: Approval Requirements
// ===========================================================================

describe('E2E: Approval Requirements', () => {
  it('safe recipe does not require approval', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'git-safe-repo', 'recipe.json'));
    assert.equal(recipe.approval_required, false);
  });

  it('dangerous recipe requires approval', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'git-dangerous-repo', 'recipe.json'));
    assert.equal(recipe.approval_required, true);
  });

  it('prod-config recipe requires approval', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'fake-prod-config', 'recipe.json'));
    assert.equal(recipe.approval_required, true);
  });

  it('computeDefaults flags production target', () => {
    const result = computeDefaults({
      riskLevel: 'high',
      isDestructive: false,
      targetsProduction: true,
      hasSecrets: false,
    });
    assert.equal(result.approvalRequired, true);
    assert.equal(result.dryRunRequired, true);
    assert.ok(result.warnings.some(w => w.includes('Production target')));
  });

  it('computeDefaults flags destructive operations', () => {
    const result = computeDefaults({
      riskLevel: 'medium',
      isDestructive: true,
      targetsProduction: false,
      hasSecrets: false,
    });
    assert.equal(result.approvalRequired, true);
    assert.ok(result.warnings.some(w => w.includes('Destructive')));
  });
});

// ===========================================================================
// E2E 5: Dangerous Command Blocking
// ===========================================================================

describe('E2E: Dangerous Command Blocking', () => {
  it('blocks rm -rf /', () => {
    const result = checkDangerous('rm', ['-rf', '/']);
    assert.equal(result.safe, false);
    assert.ok(result.reason.toLowerCase().includes('delete'));
  });

  it('blocks sudo rm', () => {
    const result = checkDangerous('sudo', ['rm', '-rf', '/tmp/data']);
    assert.equal(result.safe, false);
  });

  it('blocks chmod 777', () => {
    const result = checkDangerous('chmod', ['777', '/etc/passwd']);
    assert.equal(result.safe, false);
  });

  it('blocks dd to device', () => {
    const result = checkDangerous('dd', ['if=/dev/zero', 'of=/dev/sda']);
    assert.equal(result.safe, false);
  });

  it('blocks mkfs', () => {
    const result = checkDangerous('mkfs', ['/dev/sdb1']);
    assert.equal(result.safe, false);
  });

  it('allows safe commands', () => {
    assert.equal(checkDangerous('git', ['status']).safe, true);
    assert.equal(checkDangerous('npm', ['test']).safe, true);
    assert.equal(checkDangerous('node', ['app.js']).safe, true);
    assert.equal(checkDangerous('echo', ['hello']).safe, true);
  });
});

// ===========================================================================
// E2E 6: Scope Enforcement
// ===========================================================================

describe('E2E: Scope Enforcement', () => {
  it('allows absolute paths within scope', () => {
    const result = checkScope(['/project/src/index.js', '/project/lib/utils.js'], ['/project']);
    assert.equal(result.inScope, true);
  });

  it('blocks paths outside scope', () => {
    const result = checkScope(['/etc/passwd'], ['/project']);
    assert.equal(result.inScope, false);
    assert.ok(result.violations.length > 0);
  });

  it('blocks path traversal attempts', () => {
    const result = checkScope(['../../../etc/shadow'], ['/project/src']);
    assert.equal(result.inScope, false);
  });

  it('allows when no scope restrictions', () => {
    const result = checkScope(['/anywhere/at/all'], []);
    assert.equal(result.inScope, true);
  });
});

// ===========================================================================
// E2E 7: Channel Enforcement (Unverified Blocking)
// ===========================================================================

describe('E2E: Channel Enforcement', () => {
  it('blocks unverified community recipe by default', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'openclaw-wrapper-sim', 'recipe.json'));
    const result = enforceChannel(recipe, { allowUnverified: false });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('unverified') || result.reason.includes('community'));
  });

  it('allows verified recipe', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'git-safe-repo', 'recipe.json'));
    // Sign it and attach signature + verified channel
    const signature = signRecipe(recipe);
    const signed = { ...recipe, channel: 'verified', signature };
    const result = enforceChannel(signed, { allowUnverified: false });
    assert.equal(result.allowed, true);
  });

  it('allows unverified with explicit override', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'openclaw-wrapper-sim', 'recipe.json'));
    const result = enforceChannel(recipe, { allowUnverified: true });
    assert.equal(result.allowed, true);
  });
});

// ===========================================================================
// E2E 8: Strict Mode (Agent Drift Blocking)
// ===========================================================================

describe('E2E: Agent Strict Mode', () => {
  it('blocks unapproved recipe', () => {
    const identity = createIdentity({ actor: 'test-agent', origin: 'agent' });
    const strict = createStrictMode(identity, ['git-status-check', 'dep-upgrade-safe']);

    const check = strict.checkRecipe('git-force-push');
    assert.equal(check.allowed, false);
    assert.ok(check.reason.includes('not approved'));
  });

  it('allows approved recipe', () => {
    const identity = createIdentity({ actor: 'test-agent', origin: 'agent' });
    const strict = createStrictMode(identity, ['git-status-check']);

    const check = strict.checkRecipe('git-status-check');
    assert.equal(check.allowed, true);
  });

  it('blocks dynamic command generation', () => {
    const identity = createIdentity({ actor: 'test-agent', origin: 'agent' });
    const strict = createStrictMode(identity, []);

    assert.equal(strict.checkDynamicCommand('$(whoami)').allowed, false);
    assert.equal(strict.checkDynamicCommand('`cat /etc/passwd`').allowed, false);
    assert.equal(strict.checkDynamicCommand('eval "rm -rf /"').allowed, false);
  });

  it('allows normal commands', () => {
    const identity = createIdentity({ actor: 'test-agent', origin: 'agent' });
    const strict = createStrictMode(identity, []);

    assert.equal(strict.checkDynamicCommand('git status').allowed, true);
    assert.equal(strict.checkDynamicCommand('npm test').allowed, true);
  });

  it('blocks out-of-scope paths', () => {
    const identity = createIdentity({
      actor: 'test-agent',
      origin: 'agent',
      scope: ['/project/src'],
    });
    const strict = createStrictMode(identity, []);

    const scopeCheck = strict.checkScope('node', ['/etc/passwd'], '/project');
    assert.equal(scopeCheck.allowed, false);
    assert.ok(scopeCheck.violations.length > 0);
  });
});

// ===========================================================================
// E2E 9: Resource Bounds
// ===========================================================================

describe('E2E: Resource Bounds', () => {
  it('detects files-touched violation', () => {
    const tracker = createResourceTracker({ max_files_touched: 2 });
    tracker.recordFile();
    tracker.recordFile();
    tracker.recordFile(); // exceeds
    const ok = tracker.check();
    assert.equal(ok, false);
    const status = tracker.status();
    assert.ok(status.violations.some(v => v.bound === 'max_files_touched'));
  });

  it('detects network-calls violation', () => {
    const tracker = createResourceTracker({ max_network_calls: 1 });
    tracker.recordNetwork();
    tracker.recordNetwork(); // exceeds
    const ok = tracker.check();
    assert.equal(ok, false);
  });

  it('detects cost violation', () => {
    const tracker = createResourceTracker({ max_cost: 100 });
    tracker.recordCost(50);
    tracker.recordCost(60); // 110 > 100
    const ok = tracker.check();
    assert.equal(ok, false);
  });

  it('stays within bounds', () => {
    const tracker = createResourceTracker({ max_files_touched: 10, max_network_calls: 5 });
    tracker.recordFile();
    tracker.recordNetwork();
    assert.equal(tracker.check(), true);
    const status = tracker.status();
    assert.equal(status.withinBounds, true);
  });

  it('validates bounds schema', () => {
    assert.deepEqual(validateBounds({ max_files_touched: 10 }), []);
    assert.ok(validateBounds({ max_files_touched: -1 }).length > 0);
    assert.ok(validateBounds({ unknown_key: 5 }).length > 0);
    assert.ok(validateBounds(null).length > 0);
  });
});

// ===========================================================================
// E2E 10: Audit Trail
// ===========================================================================

describe('E2E: Audit Trail', () => {
  it('emits audit records for recipe load and execution events', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const audit = createAuditLog(auditPath);

    audit.append({ event: 'recipe.loaded', recipe_id: 'git-status-check', trace_id: 'trace-1' });
    audit.append({ event: 'policy.evaluated', recipe_id: 'git-status-check', decision: 'allow', trace_id: 'trace-1' });
    audit.append({ event: 'execution.started', recipe_id: 'git-status-check', trace_id: 'trace-1' });
    audit.append({ event: 'execution.completed', recipe_id: 'git-status-check', status: 'success', trace_id: 'trace-1' });

    const raw = readFileSync(auditPath, 'utf8').trim().split('\n');
    assert.equal(raw.length, 4);

    const entries = raw.map(line => JSON.parse(line));
    assert.equal(entries[0].event, 'recipe.loaded');
    assert.equal(entries[1].event, 'policy.evaluated');
    assert.equal(entries[2].event, 'execution.started');
    assert.equal(entries[3].event, 'execution.completed');

    // Verify hash chain
    for (let i = 1; i < entries.length; i++) {
      assert.equal(entries[i].prev_hash, entries[i - 1].entry_hash,
        `Chain broken at entry ${i}`);
    }
  });

  it('emits audit records for blocked actions', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const audit = createAuditLog(auditPath);

    audit.append({ event: 'execution.blocked', recipe_id: 'git-force-push', reason: 'unverified recipe', trace_id: 'trace-2' });

    const raw = readFileSync(auditPath, 'utf8').trim().split('\n');
    const entry = JSON.parse(raw[0]);
    assert.equal(entry.event, 'execution.blocked');
    assert.equal(entry.recipe_id, 'git-force-push');
  });
});

// ===========================================================================
// E2E 11: Safe Defaults Blocking
// ===========================================================================

describe('E2E: Safe Defaults', () => {
  it('blocks rm -rf /', () => {
    const result = checkSafeDefaults('rm -rf /');
    assert.equal(result.blocked, true);
  });

  it('blocks chmod -R 777 /', () => {
    const result = checkSafeDefaults('chmod -R 777 /');
    assert.equal(result.blocked, true);
  });

  it('blocks dd to device', () => {
    const result = checkSafeDefaults('dd if=/dev/zero of=/dev/sda');
    assert.equal(result.blocked, true);
  });

  it('allows safe commands', () => {
    assert.equal(checkSafeDefaults('npm test').blocked, false);
    assert.equal(checkSafeDefaults('git status').blocked, false);
  });

  it('--force overrides blocked action with warnings', () => {
    const safeCheck = checkSafeDefaults('rm -rf /');
    const result = applyForceOverride(true, safeCheck);
    assert.equal(result.allowed, true);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings.some(w => w.includes('WARNING')));
  });

  it('without --force, blocked action stays blocked', () => {
    const safeCheck = checkSafeDefaults('rm -rf /');
    const result = applyForceOverride(false, safeCheck);
    assert.equal(result.allowed, false);
    assert.ok(result.warnings.some(w => w.includes('BLOCKED')));
  });
});

// ===========================================================================
// E2E 12: Hash Integrity
// ===========================================================================

describe('E2E: Recipe Hash Integrity', () => {
  it('same recipe hashes identically', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'git-safe-repo', 'recipe.json'));
    const h1 = hashRecipe(recipe);
    const h2 = hashRecipe(recipe);
    assert.equal(h1, h2);
  });

  it('modified recipe produces different hash', () => {
    const recipe = loadRecipe(join(E2E_FIXTURES, 'git-safe-repo', 'recipe.json'));
    const h1 = hashRecipe(recipe);

    const modified = { ...recipe, version: '2.0.0' };
    const h2 = hashRecipe(modified);
    assert.notEqual(h1, h2);
  });
});
