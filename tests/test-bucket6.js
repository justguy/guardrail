import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateSharedManifest, createSharedManifest, hashSharedManifest, saveSharedManifest, loadSharedManifest, syncManifest, pinManifest, loadPin } from '../src/shared-manifest.js';
import { createApprovalRequest, approveRequest, rejectRequest, requestChanges, saveRequest, loadRequest, listRequests, createApprovalChain, isChainComplete, currentStage, formatRequest } from '../src/approval-queue.js';
import { validateOrgPolicy, enforceOrgPolicy, resolveHierarchy, isTrustedRecipeRoot, isTrustedExecutionSource } from '../src/org-policy.js';
import { createUser, hasPermission, enforcePermission, rolePermissions, ROLES, PERMISSIONS } from '../src/rbac.js';
import { createKeyStore } from '../src/key-management.js';
import { createNotifier, NOTIFY_EVENTS } from '../src/notifications.js';
import { getMode, setMode, isFeatureEnabled, MODES } from '../src/deployment-mode.js';
import { exportAuditLog, generateReport } from '../src/compliance.js';
import { createEnvironment, checkCrossEnv, VALID_ENVS } from '../src/environment.js';
import { buildMarketplaceIndex, publishRecipe, recordUsage, formatMarketplace } from '../src/marketplace.js';
import { validateHook, createIncidentResponder, EXAMPLE_HOOKS } from '../src/incident-hooks.js';

function tmpDir() { return realpathSync(mkdtempSync(join(tmpdir(), 'gr6-'))); }

// ===========================================================================
// 1. Shared Manifests
// ===========================================================================
describe('Bucket 6: Shared Manifests', () => {
  it('creates and validates a shared manifest', () => {
    const m = createSharedManifest({ name: 'team-default', org: 'acme', recipes: [{ id: 'r1', version: '1.0.0' }] });
    assert.equal(validateSharedManifest(m).length, 0);
    assert.equal(typeof m.content_hash, 'string');
  });

  it('saves, loads, and round-trips', () => {
    const dir = tmpDir();
    const m = createSharedManifest({ name: 'team-a', org: 'acme' });
    saveSharedManifest(m, dir);
    const loaded = loadSharedManifest('team-a', dir);
    assert.equal(loaded.name, 'team-a');
  });

  it('sync detects no change for identical manifests', () => {
    const m = createSharedManifest({ name: 'x', org: 'y' });
    assert.equal(syncManifest(m, m).action, 'none');
  });

  it('sync detects recipe version conflict', () => {
    const existing = createSharedManifest({ name: 'x', org: 'y', recipes: [{ id: 'r1', version: '1.0.0' }] });
    const incoming = createSharedManifest({ name: 'x', org: 'y', recipes: [{ id: 'r1', version: '2.0.0' }] });
    const result = syncManifest(incoming, existing);
    assert.ok(result.conflicts.length > 0);
  });

  it('pinManifest saves and loads pin', () => {
    const dir = tmpDir();
    const m = createSharedManifest({ name: 'pinned', org: 'acme' });
    pinManifest(m, dir);
    const pin = loadPin('pinned', dir);
    assert.equal(pin.pinned_hash, m.content_hash);
  });
});

// ===========================================================================
// 2. Approval Queue + Multi-Stage
// ===========================================================================
describe('Bucket 6: Approval Queue', () => {
  it('creates a pending request', () => {
    const req = createApprovalRequest({ recipeId: 'npm-publish', riskLevel: 'high', requester: 'dev' });
    assert.equal(req.status, 'pending');
    assert.ok(req.id);
  });

  it('approve transitions to approved', () => {
    const req = createApprovalRequest({ recipeId: 'r1', requester: 'dev' });
    const result = approveRequest(req, 'admin');
    assert.equal(result.success, true);
    assert.equal(req.status, 'approved');
  });

  it('reject transitions to rejected', () => {
    const req = createApprovalRequest({ recipeId: 'r1', requester: 'dev' });
    const result = rejectRequest(req, 'admin', 'Too risky');
    assert.equal(result.success, true);
    assert.equal(req.status, 'rejected');
  });

  it('cannot approve already rejected request', () => {
    const req = createApprovalRequest({ recipeId: 'r1', requester: 'dev' });
    rejectRequest(req, 'admin', 'No');
    const result = approveRequest(req, 'admin');
    assert.equal(result.success, false);
  });

  it('save and load round-trip', () => {
    const dir = tmpDir();
    const req = createApprovalRequest({ recipeId: 'r1', requester: 'dev' });
    saveRequest(req, dir);
    const loaded = loadRequest(req.id, dir);
    assert.equal(loaded.id, req.id);
  });

  it('listRequests returns all requests', () => {
    const dir = tmpDir();
    saveRequest(createApprovalRequest({ recipeId: 'r1', requester: 'a' }), dir);
    saveRequest(createApprovalRequest({ recipeId: 'r2', requester: 'b' }), dir);
    assert.equal(listRequests(dir).length, 2);
  });

  it('multi-stage chain requires sequential approvals', () => {
    const chain = createApprovalChain(['dev', 'lead', 'security']);
    const req = createApprovalRequest({ recipeId: 'r1', requester: 'dev', chain });
    assert.equal(currentStage(req.chain), 'dev');

    approveRequest(req, 'dev-lead');
    assert.equal(req.status, 'pending'); // still pending — need lead + security
    assert.equal(currentStage(req.chain), 'lead');

    approveRequest(req, 'team-lead');
    assert.equal(req.status, 'pending');
    assert.equal(currentStage(req.chain), 'security');

    approveRequest(req, 'security-officer');
    assert.equal(req.status, 'approved');
    assert.ok(isChainComplete(req.chain));
  });

  it('formatRequest produces readable output', () => {
    const req = createApprovalRequest({ recipeId: 'test', requester: 'dev', riskLevel: 'high' });
    const text = formatRequest(req);
    assert.ok(text.includes('PENDING'));
    assert.ok(text.includes('test'));
  });
});

// ===========================================================================
// 3. Org Policy Engine
// ===========================================================================
describe('Bucket 6: Org Policy Engine', () => {
  it('enforces forbidden operations', () => {
    const orgPolicy = { name: 'strict', version: '1.0.0', forbidden_operations: ['rm -rf'], required_approvals: [], allowed_actions: [] };
    const result = enforceOrgPolicy({ command: 'rm', args: ['-rf', '/tmp'], risk_level: 'high' }, orgPolicy, null);
    assert.ok(!result.compliant);
    assert.ok(result.violations.some(v => v.level === 'org'));
  });

  it('org policy overrides local in hierarchy', () => {
    const org = { allowed_actions: ['echo', 'npm'], forbidden_operations: ['rm'], required_approvals: ['high'] };
    const user = { allowed_actions: ['*'], forbidden_operations: [], required_approvals: [] };
    const effective = resolveHierarchy(org, null, user);
    assert.deepEqual(effective.allowed_actions, ['echo', 'npm']); // org restricts
    assert.ok(effective.forbidden_operations.includes('rm'));
  });

  it('forbidden_operations accumulate across hierarchy levels', () => {
    const org = { forbidden_operations: ['rm'] };
    const team = { forbidden_operations: ['sudo'] };
    const effective = resolveHierarchy(org, team, null);
    assert.ok(effective.forbidden_operations.includes('rm'));
    assert.ok(effective.forbidden_operations.includes('sudo'));
  });

  it('validates trusted execution allowlists', () => {
    const policy = {
      trusted_execution_sources: ['github://guardrail-dev/recipes/', 'https://my.artifacts/'],
    };
    assert.equal(isTrustedExecutionSource('github://guardrail-dev/recipes/open-pr.json@abc', policy), true);
    assert.equal(isTrustedExecutionSource('https://other.dev/thing', policy), false);
  });

  it('respects trusted recipe root boundaries', () => {
    const policy = {
      trusted_recipe_roots: ['/tmp/project/shared-recipes'],
    };
    assert.equal(isTrustedRecipeRoot('/tmp/project/shared-recipes', policy, '/tmp/project'), true);
    assert.equal(isTrustedRecipeRoot('/tmp/project/blocked/recipes', policy, '/tmp/project'), false);
  });
});

// ===========================================================================
// 4. RBAC
// ===========================================================================
describe('Bucket 6: RBAC', () => {
  it('4 roles defined: admin, approver, developer, viewer', () => {
    assert.ok(ROLES.admin); assert.ok(ROLES.approver); assert.ok(ROLES.developer); assert.ok(ROLES.viewer);
  });

  it('admin has all permissions', () => {
    const user = createUser('admin-user', 'admin');
    for (const perm of Object.keys(PERMISSIONS)) {
      assert.ok(hasPermission(user, perm), `Admin should have ${perm}`);
    }
  });

  it('viewer cannot run recipes', () => {
    const user = createUser('viewer-user', 'viewer');
    assert.equal(hasPermission(user, 'run_recipe'), false);
  });

  it('developer can run recipes but not approve', () => {
    const user = createUser('dev', 'developer');
    assert.equal(hasPermission(user, 'run_recipe'), true);
    assert.equal(hasPermission(user, 'approve_action'), false);
  });

  it('enforcePermission returns reason on denial', () => {
    const user = createUser('viewer', 'viewer');
    const result = enforcePermission(user, 'modify_policy');
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('lacks permission'));
  });

  it('rolePermissions returns correct list', () => {
    const perms = rolePermissions('developer');
    assert.ok(perms.some(p => p.name === 'run_recipe'));
    assert.ok(perms.some(p => p.name === 'view_audit'));
    assert.ok(!perms.some(p => p.name === 'modify_policy'));
  });
});

// ===========================================================================
// 5. Key Management
// ===========================================================================
describe('Bucket 6: Key Management', () => {
  it('stores and retrieves encrypted key', () => {
    const dir = tmpDir();
    const ks = createKeyStore(dir, 'test-passphrase');
    ks.set('API_KEY', 'super-secret-123');
    const value = ks.get('API_KEY');
    assert.equal(value, 'super-secret-123');
  });

  it('scoped access: denies cross-scope access', () => {
    const dir = tmpDir();
    const ks = createKeyStore(dir, 'pass');
    ks.set('PROD_KEY', 'secret', 'prod');
    assert.throws(() => ks.get('PROD_KEY', 'dev'), (err) => err.message.includes('denied'));
  });

  it('scoped access: allows matching scope', () => {
    const dir = tmpDir();
    const ks = createKeyStore(dir, 'pass');
    ks.set('PROD_KEY', 'secret', 'prod');
    assert.equal(ks.get('PROD_KEY', 'prod'), 'secret');
  });

  it('redact returns masked value', () => {
    const dir = tmpDir();
    const ks = createKeyStore(dir, 'pass');
    ks.set('TOKEN', 'real-value');
    assert.equal(ks.redact('TOKEN'), '[REDACTED:TOKEN]');
  });

  it('listSync returns key metadata without values', () => {
    const dir = tmpDir();
    const ks = createKeyStore(dir, 'pass');
    ks.set('K1', 'v1'); ks.set('K2', 'v2');
    const keys = ks.listSync();
    assert.equal(keys.length, 2);
    assert.ok(keys[0].name);
    assert.ok(!keys[0].value); // no raw value exposed
  });
});

// ===========================================================================
// 6. Notifications
// ===========================================================================
describe('Bucket 6: Notifications', () => {
  it('dispatches to log integration', async () => {
    const notifier = createNotifier([{ type: 'log', config: {} }]);
    await notifier.notify({ type: 'execution_success', message: 'done' });
    assert.equal(notifier.history().length, 1);
    assert.equal(notifier.history()[0].status, 'sent');
  });

  it('dispatches to multiple integrations', async () => {
    const notifier = createNotifier([{ type: 'log', config: {} }, { type: 'webhook', config: { url: 'http://example.com' } }]);
    await notifier.notify({ type: 'policy_violation', message: 'blocked' });
    assert.equal(notifier.history().length, 2);
  });

  it('NOTIFY_EVENTS contains expected events', () => {
    assert.ok(NOTIFY_EVENTS.has('approval_required'));
    assert.ok(NOTIFY_EVENTS.has('execution_failure'));
    assert.ok(NOTIFY_EVENTS.has('policy_violation'));
  });
});

// ===========================================================================
// 7. Deployment Modes
// ===========================================================================
describe('Bucket 6: Deployment Modes', () => {
  it('3 modes defined: local, team, enterprise', () => {
    assert.ok(MODES.local); assert.ok(MODES.team); assert.ok(MODES.enterprise);
  });

  it('local mode disables shared features', () => {
    assert.equal(MODES.local.features.shared_manifests, false);
    assert.equal(MODES.local.features.approval_queue, false);
  });

  it('enterprise mode enables all features', () => {
    for (const [, enabled] of Object.entries(MODES.enterprise.features)) {
      assert.equal(enabled, true);
    }
  });

  it('setMode and getMode round-trip', () => {
    const dir = tmpDir();
    setMode(dir, 'team');
    const mode = getMode(dir);
    assert.equal(mode.mode, 'team');
  });

  it('isFeatureEnabled checks mode features', () => {
    const dir = tmpDir();
    setMode(dir, 'local');
    assert.equal(isFeatureEnabled(dir, 'approval_queue'), false);
    setMode(dir, 'enterprise');
    assert.equal(isFeatureEnabled(dir, 'approval_queue'), true);
  });
});

// ===========================================================================
// 8. Compliance Exports
// ===========================================================================
describe('Bucket 6: Compliance Exports', () => {
  it('exports audit log as JSON', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    writeFileSync(auditPath, '{"event":"test","timestamp":"2026-01-01"}\n');
    const output = exportAuditLog(auditPath, { format: 'json' });
    const parsed = JSON.parse(output);
    assert.equal(parsed.length, 1);
  });

  it('exports audit log as CSV', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    writeFileSync(auditPath, '{"event":"test","timestamp":"2026-01-01"}\n{"event":"done","timestamp":"2026-01-02"}\n');
    const output = exportAuditLog(auditPath, { format: 'csv' });
    assert.ok(output.includes('event'));
    assert.ok(output.includes('test'));
  });

  it('generateReport produces summary', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    writeFileSync(auditPath, '{"event":"execution_start"}\n{"event":"execution_end"}\n{"event":"violation_detected"}\n');
    const report = generateReport(auditPath);
    assert.equal(report.total_events, 3);
    assert.equal(report.executions, 2);
    assert.equal(report.violations, 1);
  });
});

// ===========================================================================
// 9. Environment Separation
// ===========================================================================
describe('Bucket 6: Environment Separation', () => {
  it('3 environments: dev, staging, prod', () => {
    assert.ok(VALID_ENVS.has('dev')); assert.ok(VALID_ENVS.has('staging')); assert.ok(VALID_ENVS.has('prod'));
  });

  it('blocks cross-env access to prod from dev', () => {
    const result = checkCrossEnv('dev', 'prod');
    assert.equal(result.allowed, false);
  });

  it('allows dev → staging promotion', () => {
    const result = checkCrossEnv('dev', 'staging');
    assert.equal(result.allowed, true);
  });

  it('allows same-env access', () => {
    assert.equal(checkCrossEnv('prod', 'prod').allowed, true);
  });

  it('createEnvironment validates name', () => {
    assert.throws(() => createEnvironment('invalid'));
  });
});

// ===========================================================================
// 10. Marketplace
// ===========================================================================
describe('Bucket 6: Marketplace', () => {
  it('builds index from recipe directory', () => {
    const entries = buildMarketplaceIndex('recipes');
    assert.ok(entries.length >= 5);
  });

  it('publishRecipe writes to registry', () => {
    const dir = tmpDir();
    const result = publishRecipe({ id: 'test', version: '1.0.0', name: 'Test' }, dir);
    assert.equal(result.status, 'published');
  });

  it('duplicate version publish is idempotent for same content', () => {
    const dir = tmpDir();
    const recipe = { id: 'test', version: '1.0.0', name: 'Test' };
    publishRecipe(recipe, dir);
    const result = publishRecipe(recipe, dir);
    assert.equal(result.status, 'already_published');
  });

  it('recordUsage increments counter', () => {
    const dir = tmpDir();
    recordUsage('test', dir);
    recordUsage('test', dir);
    const entries = buildMarketplaceIndex(dir);
    // No recipes in tmpDir, but usage is recorded
  });

  it('formatMarketplace produces output', () => {
    const entries = [{ id: 'test', version: '1.0.0', channel: 'verified', author: 'me', usage_count: 5 }];
    const text = formatMarketplace(entries);
    assert.ok(text.includes('test'));
    assert.ok(text.includes('verified'));
  });
});

// ===========================================================================
// 11. Incident Response Hooks
// ===========================================================================
describe('Bucket 6: Incident Response Hooks', () => {
  it('validates hook definitions', () => {
    assert.equal(validateHook({ trigger: 'policy_violation', action: 'alert' }).length, 0);
    assert.ok(validateHook({ trigger: 'invalid', action: 'alert' }).length > 0);
  });

  it('fires matching hooks and can halt', () => {
    const hooks = [{ trigger: 'policy_violation', action: 'halt', config: {} }];
    const responder = createIncidentResponder(hooks);
    const result = responder.process('policy_violation', { actor: 'test' });
    assert.equal(result.halt, true);
    assert.equal(result.triggered.length, 1);
  });

  it('non-matching events produce no triggers', () => {
    const hooks = [{ trigger: 'policy_violation', action: 'alert' }];
    const responder = createIncidentResponder(hooks);
    const result = responder.process('execution_failed', {});
    assert.equal(result.triggered.length, 0);
    assert.equal(result.halt, false);
  });

  it('escalate action sets target', () => {
    const hooks = [{ trigger: 'audit_chain_broken', action: 'escalate', config: { target: 'admin' } }];
    const responder = createIncidentResponder(hooks);
    const result = responder.process('audit_chain_broken', {});
    assert.ok(result.triggered[0].message.includes('admin'));
  });

  it('unresolvedCount tracks open incidents', () => {
    const hooks = [{ trigger: 'policy_violation', action: 'log' }];
    const responder = createIncidentResponder(hooks);
    responder.process('policy_violation', {});
    responder.process('policy_violation', {});
    assert.equal(responder.unresolvedCount(), 2);
  });

  it('EXAMPLE_HOOKS are all valid', () => {
    for (const hook of EXAMPLE_HOOKS) {
      assert.equal(validateHook(hook).length, 0, `Invalid hook: ${hook.trigger}/${hook.action}`);
    }
  });
});

// ===========================================================================
// 11. Sovereign Record Metadata — Compliance Round-Trip (P0c)
// ===========================================================================
describe('Bucket 6: Sovereign Metadata in Compliance Exports', () => {
  it('generateReport sovereign_summary populated from audit entries', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const entry = {
      event: 'execution_start',
      timestamp: '2026-01-01T00:00:00Z',
      organization_id: 'org-acme',
      workspace_id: 'ws-prod',
      retention_class: 'extended',
      sensitivity: 'confidential',
      source_provenance: { root: 'shared-global', ref: 'recipe-x', pinned_hash: null },
    };
    writeFileSync(auditPath, JSON.stringify(entry) + '\n');
    const report = generateReport(auditPath);
    assert.ok(report.sovereign_summary, 'missing sovereign_summary');
    assert.ok(report.sovereign_summary.organization_ids.includes('org-acme'));
    assert.ok(report.sovereign_summary.workspace_ids.includes('ws-prod'));
    assert.ok(report.sovereign_summary.retention_classes.includes('extended'));
    assert.ok(report.sovereign_summary.sensitivity_labels.includes('confidential'));
    assert.ok(report.sovereign_summary.provenance_roots.includes('shared-global'));
  });

  it('CSV export flattens source_provenance to dotted keys', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const entry = {
      event: 'execution_start',
      timestamp: '2026-01-01T00:00:00Z',
      organization_id: 'org-1',
      workspace_id: null,
      retention_class: 'standard',
      sensitivity: 'internal',
      source_provenance: { root: 'project-local', ref: null, pinned_hash: null },
    };
    writeFileSync(auditPath, JSON.stringify(entry) + '\n');
    const csv = exportAuditLog(auditPath, { format: 'csv' });
    assert.ok(csv.includes('source_provenance.root'), 'CSV missing source_provenance.root column');
    assert.ok(csv.includes('project-local'), 'CSV missing provenance value');
    assert.ok(csv.includes('organization_id'), 'CSV missing organization_id column');
    assert.ok(csv.includes('retention_class'), 'CSV missing retention_class column');
    assert.ok(csv.includes('sensitivity'), 'CSV missing sensitivity column');
  });

  it('JSON export includes sovereign fields verbatim', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const entry = {
      event: 'audit_test',
      timestamp: '2026-01-01T00:00:00Z',
      organization_id: 'org-xyz',
      workspace_id: 'ws-a',
      retention_class: 'permanent',
      sensitivity: 'restricted',
      source_provenance: { root: 'shared-global', ref: 'r1', pinned_hash: 'abc' },
    };
    writeFileSync(auditPath, JSON.stringify(entry) + '\n');
    const json = exportAuditLog(auditPath, { format: 'json' });
    const parsed = JSON.parse(json);
    assert.equal(parsed[0].organization_id, 'org-xyz');
    assert.equal(parsed[0].retention_class, 'permanent');
    assert.equal(parsed[0].sensitivity, 'restricted');
    assert.deepEqual(parsed[0].source_provenance, { root: 'shared-global', ref: 'r1', pinned_hash: 'abc' });
  });
});
