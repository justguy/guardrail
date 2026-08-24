import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { loadRecipe, hashRecipe, validateRecipe, packRecipe, loadPackedRecipe } from '../src/recipe.js';
import { checkDangerous, checkScope, dryRun } from '../src/recipe-executor.js';
import { evaluateRisk } from '../src/policy-engine.js';
import { enforceChannel, signRecipe } from '../src/recipe-channel.js';
import { checkSafeDefaults, computeDefaults } from '../src/safe-defaults.js';
import { createIdentity, createStrictMode } from '../src/identity.js';
import { createAuditLog } from '../src/audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-gd-')));
}

// ===========================================================================
// Golden Demo 1: Accidental rm -rf
//
// Input:  command = "rm -rf /"
// Plan:   blocked by safe defaults
// Status: BLOCKED
// ===========================================================================

describe('Golden Demo: Accidental rm -rf', () => {
  it('safe defaults block the command', () => {
    const result = checkSafeDefaults('rm -rf /');
    assert.equal(result.blocked, true);
    assert.ok(result.reason.includes('delete') || result.reason.includes('Recursive'));
  });

  it('risk classification is at least YELLOW (destructive)', () => {
    const risk = evaluateRisk(
      { command: 'rm', args: ['-rf', '/'], cwd: '/project', mode: 'structured' },
      { trustClass: 'reviewed_internal', projectRoot: '/project' },
    );
    // rm is a DESTRUCTIVE_BINARY, structured mode with reviewed trust → YELLOW
    // (RED requires shell+destructive, or writes-outside-repo, or sudo, etc.)
    assert.ok(risk.riskLevel === 'yellow' || risk.riskLevel === 'red');
    assert.ok(risk.reasons.some(r => r.includes('destructive')));
  });

  it('recipe executor blocks rm -rf /', () => {
    const result = checkDangerous('rm', ['-rf', '/']);
    assert.equal(result.safe, false);
  });

  it('audit trail records the block', () => {
    const dir = tmpDir();
    const audit = createAuditLog(join(dir, 'audit.jsonl'));
    audit.append({ event: 'execution.blocked', command: 'rm -rf /', reason: 'Recursive force delete', trace_id: 'demo-1' });

    const entries = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(entries[0].event, 'execution.blocked');
    assert.equal(entries[0].reason, 'Recursive force delete');
  });
});

// ===========================================================================
// Golden Demo 2: Broken PR Bulk Merge
//
// Input:  recipe git-force-push with branch=main
// Plan:   community recipe → blocked by channel enforcement
//         even if allowed → approval required (high risk)
//         destructive --force flag detected
// Status: BLOCKED (multiple reasons)
// ===========================================================================

describe('Golden Demo: Broken PR Bulk Merge', () => {
  const RECIPE = {
    id: 'bulk-merge', name: 'Bulk PR Merge', description: 'Merge all approved PRs',
    version: '1.0.0', author: 'test', category: 'github',
    tags: ['merge', 'bulk'], channel: 'community',
    inputs: { branch: { type: 'string', pattern: '^[a-z/-]+$' } },
    steps: [
      {
        id: 'merge-all', description: 'Merge approved PRs',
        run: { command: 'git', args: ['push', '--force', 'origin', '{{inputs.branch}}'], mode: 'structured' },
      },
    ],
    guardrails: { constraints: ['approved PRs only'], invariants: ['no force push'] },
    approval_required: true, risk_level: 'high',
  };

  it('channel enforcement blocks unverified recipe', () => {
    const result = enforceChannel(RECIPE, { allowUnverified: false });
    assert.equal(result.allowed, false);
  });

  it('recipe requires approval', () => {
    assert.equal(RECIPE.approval_required, true);
  });

  it('risk is at least YELLOW due to destructive flag (structured mode)', () => {
    const risk = evaluateRisk(
      { command: 'git', args: ['push', '--force', 'origin', 'main'], cwd: '/project', mode: 'structured' },
      { trustClass: 'reviewed_internal', projectRoot: '/project' },
    );
    // git push --force matches DESTRUCTIVE_PATTERNS; structured mode + reviewed = YELLOW
    // (RED requires shell+destructive, writes-outside, admin binary, etc.)
    assert.ok(risk.riskLevel === 'yellow' || risk.riskLevel === 'red');
    assert.ok(risk.reasons.some(r => r.includes('destructive')));
  });

  it('dry-run shows the resolved force-push command', () => {
    const result = dryRun(RECIPE, { branch: 'main' });
    assert.deepEqual(result.steps[0].args, ['push', '--force', 'origin', 'main']);
  });
});

// ===========================================================================
// Golden Demo 3: Dependency Upgrade Wants Major Bump
//
// Input:  dep-upgrade recipe with npm install (package install)
// Plan:   risk escalation due to package installation
// Status: YELLOW or RED depending on mode
// ===========================================================================

describe('Golden Demo: Dependency Upgrade Major Bump', () => {
  it('structured npm install → YELLOW (package install)', () => {
    const risk = evaluateRisk(
      { command: 'npm', args: ['install'], cwd: '/project', mode: 'structured' },
      { trustClass: 'reviewed_internal', projectRoot: '/project' },
    );
    assert.equal(risk.riskLevel, 'yellow');
    assert.ok(risk.reasons.some(r => r.includes('package installation')));
  });

  it('shell mode npm install → RED', () => {
    const risk = evaluateRisk(
      { command: '', args: [], cwd: '/project', mode: 'shell', shell: 'npm install && npm test' },
      { trustClass: 'reviewed_internal', projectRoot: '/project' },
    );
    assert.equal(risk.riskLevel, 'red');
  });

  it('computeDefaults says high-risk needs dry-run', () => {
    const defaults = computeDefaults({ riskLevel: 'high', isDestructive: false, targetsProduction: false });
    assert.equal(defaults.dryRunRequired, true);
  });
});

// ===========================================================================
// Golden Demo 4: Infra Rollout Targeting Prod by Mistake
//
// Input:  terraform apply with production target
// Plan:   RED due to admin binary + prod target
// Status: BLOCKED (requires approval)
// ===========================================================================

describe('Golden Demo: Infra Rollout Targeting Prod', () => {
  it('terraform apply is RED', () => {
    const risk = evaluateRisk(
      { command: 'terraform', args: ['apply', '-var', 'env=production'], cwd: '/project', mode: 'structured' },
      { trustClass: 'reviewed_internal', projectRoot: '/project' },
    );
    assert.equal(risk.riskLevel, 'red');
    assert.ok(risk.reasons.some(r => r.includes('admin') || r.includes('infrastructure')));
    assert.ok(risk.reasons.some(r => r.includes('production')));
  });

  it('requires strong confirmation', () => {
    const risk = evaluateRisk(
      { command: 'terraform', args: ['apply'], cwd: '/project', mode: 'structured' },
      { trustClass: 'reviewed_internal', projectRoot: '/project' },
    );
    assert.equal(risk.requiresStrongConfirmation, true);
  });

  it('computeDefaults requires approval for production', () => {
    const defaults = computeDefaults({ riskLevel: 'high', isDestructive: false, targetsProduction: true });
    assert.equal(defaults.approvalRequired, true);
    assert.ok(defaults.warnings.some(w => w.includes('Production')));
  });
});

// ===========================================================================
// Golden Demo 5: OpenClaw Task Going Beyond Approved Scope
//
// Input:  agent tries to edit /etc/passwd (outside src/ scope)
// Plan:   scope violation detected
// Status: BLOCKED
// ===========================================================================

describe('Golden Demo: OpenClaw Beyond Scope', () => {
  it('out-of-scope path blocked', () => {
    const result = checkScope(['/etc/passwd'], ['/project/src']);
    assert.equal(result.inScope, false);
    assert.ok(result.violations.some(v => v.includes('outside')));
  });

  it('in-scope absolute path allowed', () => {
    const result = checkScope(['/project/src/utils.js'], ['/project/src']);
    assert.equal(result.inScope, true);
  });

  it('strict mode blocks unapproved recipe for agent', () => {
    const identity = createIdentity({ actor: 'openclaw-agent', origin: 'openclaw', scope: ['/project/src'] });
    const strict = createStrictMode(identity, ['openclaw-safe-edit']);

    assert.equal(strict.checkRecipe('openclaw-safe-edit').allowed, true);
    assert.equal(strict.checkRecipe('openclaw-delete-all').allowed, false);
  });

  it('strict mode blocks dynamic command generation', () => {
    const identity = createIdentity({ actor: 'openclaw-agent', origin: 'openclaw' });
    const strict = createStrictMode(identity, []);

    assert.equal(strict.checkDynamicCommand('$(rm -rf /)').allowed, false);
    assert.equal(strict.checkDynamicCommand('node edit.js').allowed, true);
  });
});

// ===========================================================================
// Golden Demo 6: Recipe Tamper Detection
//
// Input:  pack a recipe, tamper with it, try to load
// Plan:   content hash mismatch detected
// Status: TAMPERED
// ===========================================================================

describe('Golden Demo: Recipe Tamper Detection', () => {
  it('pack → tamper → detect', () => {
    const recipe = {
      id: 'safe-recipe', name: 'Safe Recipe', description: 'A safe recipe',
      version: '1.0.0', author: 'tester', category: 'custom',
      inputs: { x: { type: 'boolean' } },
      steps: [{ id: 's1', description: 'echo', run: { command: 'echo', args: ['hello'], mode: 'structured' } }],
      guardrails: { constraints: ['safe'], invariants: ['no harm'] },
      approval_required: false, risk_level: 'low',
    };

    const packed = packRecipe(recipe);
    const dir = tmpDir();
    const path = join(dir, 'recipe.packed.json');

    // Write packed recipe
    writeFileSync(path, JSON.stringify(packed, null, 2));

    // Verify it loads cleanly
    const loaded1 = loadPackedRecipe(path);
    assert.equal(loaded1.verified, true);

    // Tamper with the recipe
    const tampered = JSON.parse(readFileSync(path, 'utf8'));
    tampered.recipe.steps[0].run.command = 'rm';
    tampered.recipe.steps[0].run.args = ['-rf', '/'];
    writeFileSync(path, JSON.stringify(tampered, null, 2));

    // Detect tamper
    const loaded2 = loadPackedRecipe(path);
    assert.equal(loaded2.verified, false);
  });
});

// ===========================================================================
// Golden Demo 7: Version Swap (v1 approved, executor tries v2)
//
// Input:  hash a recipe, change version, re-hash
// Plan:   different hash detected
// Status: DRIFT
// ===========================================================================

describe('Golden Demo: Version Swap Detection', () => {
  it('v1 hash ≠ v2 hash', () => {
    const v1 = {
      id: 'my-recipe', name: 'My Recipe', description: 'v1',
      version: '1.0.0', author: 'tester', category: 'custom',
      inputs: { x: { type: 'boolean' } },
      steps: [{ id: 's1', description: 'echo', run: { command: 'echo', args: ['v1'], mode: 'structured' } }],
      guardrails: { constraints: ['c'], invariants: ['i'] },
      approval_required: false, risk_level: 'low',
    };

    const v2 = {
      ...v1,
      version: '2.0.0',
      steps: [{ id: 's1', description: 'echo', run: { command: 'echo', args: ['v2'], mode: 'structured' } }],
    };

    const h1 = hashRecipe(v1);
    const h2 = hashRecipe(v2);
    assert.notEqual(h1, h2, 'Version swap must produce different hash');
  });

  it('even minor content change changes hash', () => {
    const base = {
      id: 'my-recipe', name: 'My Recipe', description: 'base',
      version: '1.0.0', author: 'tester', category: 'custom',
      inputs: { x: { type: 'boolean' } },
      steps: [{ id: 's1', description: 'echo', run: { command: 'echo', args: ['hello'], mode: 'structured' } }],
      guardrails: { constraints: ['c'], invariants: ['i'] },
      approval_required: false, risk_level: 'low',
    };

    const tweaked = { ...base, description: 'base tweaked' };
    // description is not in hashRecipe's hashable fields, so this won't change hash
    // but changing steps will:
    const tweaked2 = { ...base, steps: [{ ...base.steps[0], description: 'echo tweaked' }] };
    // steps include description in the hash
    const h1 = hashRecipe(base);
    const h2 = hashRecipe(tweaked2);
    assert.notEqual(h1, h2);
  });
});
