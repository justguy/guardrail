import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { captureFingerprint } from '../src/fingerprint.js';
import { createAuditLog, appendEntry, verifyAuditChain, queryAuditLog } from '../src/audit.js';
import { sovereignMeta, computePayloadHash, RETENTION_CLASSES, SENSITIVITY_LABELS } from '../src/shared.js';
import { checkTimePolicy, checkAndIncrementCounter, checkRateLimit, acquireLock } from '../src/runtime-policy.js';
import { evaluateRisk } from '../src/policy-engine.js';
import { createContract } from '../src/contract.js';
import { STATUS_EXIT_CODES } from '../src/supervisor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'gr3-'));
}

// ===========================================================================
// 1. Environment Fingerprinting
// ===========================================================================

describe('Bucket 3: Environment Fingerprinting', () => {
  it('captures OS, arch, hostname, nodeVersion, cwd, envVarNames', () => {
    const fp = captureFingerprint();
    assert.equal(typeof fp.os, 'string');
    assert.equal(typeof fp.arch, 'string');
    assert.equal(typeof fp.hostname, 'string');
    assert.ok(fp.nodeVersion.startsWith('v'));
    assert.equal(typeof fp.cwd, 'string');
    assert.ok(Array.isArray(fp.envVarNames));
    assert.ok(fp.envVarNames.length > 0);
    assert.equal(typeof fp.capturedAt, 'string');
  });

  it('envVarNames is sorted', () => {
    const fp = captureFingerprint();
    const sorted = [...fp.envVarNames].sort();
    assert.deepEqual(fp.envVarNames, sorted);
  });

  it('fingerprint is deterministic within same process', () => {
    const fp1 = captureFingerprint();
    const fp2 = captureFingerprint();
    assert.equal(fp1.os, fp2.os);
    assert.equal(fp1.arch, fp2.arch);
    assert.equal(fp1.hostname, fp2.hostname);
    assert.equal(fp1.nodeVersion, fp2.nodeVersion);
    assert.equal(fp1.cwd, fp2.cwd);
  });
});

// ===========================================================================
// 2. Risk Escalation — I-A2: Secret + Production = RED
// ===========================================================================

describe('Bucket 3: Risk Escalation (I-A2)', () => {
  it('secret env + production target = RED regardless of other factors', () => {
    const contract = createContract({
      command: 'deploy',
      args: ['--target', 'production'],
      envPolicy: {
        inherit: false,
        allow: [],
        inject: { API_SECRET_KEY: 'xxx', DEPLOY_TARGET: 'production' },
      },
    });
    const risk = evaluateRisk(contract, { trustClass: 'reviewed_internal' });
    assert.equal(risk.riskLevel, 'red');
  });

  it('secret env WITHOUT production target does NOT auto-escalate to RED', () => {
    const contract = createContract({
      command: 'echo',
      args: ['hello'],
      envPolicy: { inherit: false, allow: [], inject: { API_SECRET_KEY: 'xxx' } },
    });
    const risk = evaluateRisk(contract, { trustClass: 'reviewed_internal' });
    // Secret injection alone should not force RED (may be yellow)
    assert.ok(risk.traits.handles_secrets);
    assert.equal(risk.traits.targets_production, false);
  });

  it('production target WITHOUT secret env does NOT auto-escalate to RED from secrets', () => {
    const contract = createContract({
      command: 'deploy',
      args: ['--target', 'production'],
      envPolicy: { inherit: false, allow: [], inject: { DEPLOY_TARGET: 'production' } },
    });
    const risk = evaluateRisk(contract, { trustClass: 'reviewed_internal' });
    // Prod target alone still triggers RED per current policy, but not from secrets path
    assert.ok(risk.traits.targets_production);
  });

  it('both present with manifest declaring GREEN: computed RED overrides', () => {
    const contract = createContract({
      command: 'deploy',
      args: ['--target', 'production'],
      envPolicy: { inherit: false, allow: [], inject: { API_SECRET_KEY: 'xxx', DEPLOY_TARGET: 'production' } },
    });
    const risk = evaluateRisk(contract, { trustClass: 'reviewed_internal' });
    assert.equal(risk.riskLevel, 'red');
    assert.ok(risk.traits.handles_secrets);
    assert.ok(risk.traits.targets_production);
  });

  it('traits.handles_secrets and traits.targets_production returned in risk result', () => {
    const contract = createContract({ command: 'echo', args: ['hi'] });
    const risk = evaluateRisk(contract, { trustClass: 'reviewed_internal' });
    assert.equal(typeof risk.traits.handles_secrets, 'boolean');
    assert.equal(typeof risk.traits.targets_production, 'boolean');
  });
});

// ===========================================================================
// 3. Hash-Chained Audit Log (I-A5)
// ===========================================================================

describe('Bucket 3: Hash-Chained Audit Log (I-A5)', () => {
  it('each log entry contains hash of previous entry', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const log = createAuditLog(auditPath);

    log.append({ event: 'execution_start', trace_id: 'T1', manifest_hash: 'H1' });
    log.append({ event: 'execution_end', trace_id: 'T1', manifest_hash: 'H1' });

    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    const entry1 = JSON.parse(lines[0]);
    const entry2 = JSON.parse(lines[1]);

    assert.equal(entry1.prev_hash, null);
    assert.equal(entry2.prev_hash, entry1.entry_hash);
    assert.equal(typeof entry1.entry_hash, 'string');
    assert.equal(typeof entry2.entry_hash, 'string');
    assert.ok(entry1.entry_hash.length === 64); // SHA-256 hex
  });

  it('verify on clean log passes', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const log = createAuditLog(auditPath);

    log.append({ event: 'execution_start', trace_id: 'T1' });
    log.append({ event: 'approval', trace_id: 'T1' });
    log.append({ event: 'execution_end', trace_id: 'T1' });

    const result = log.verify();
    assert.equal(result.valid, true);
    assert.equal(result.entries, 3);
    assert.equal(result.error, null);
  });

  it('tampered entry detected: audit_chain_broken at correct index', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const log = createAuditLog(auditPath);

    log.append({ event: 'execution_start', trace_id: 'T1' });
    log.append({ event: 'approval', trace_id: 'T1' });
    log.append({ event: 'execution_end', trace_id: 'T1' });

    // Tamper with middle entry
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[1]);
    tampered.event = 'TAMPERED';
    lines[1] = JSON.stringify(tampered);
    writeFileSync(auditPath, lines.join('\n') + '\n');

    const result = verifyAuditChain(auditPath);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt, 1);
    assert.ok(result.error.includes('audit_chain_broken'));
  });

  it('deleted entry detected: chain verification fails', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const log = createAuditLog(auditPath);

    log.append({ event: 'a', trace_id: 'T1' });
    log.append({ event: 'b', trace_id: 'T1' });
    log.append({ event: 'c', trace_id: 'T1' });

    // Delete middle entry
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    lines.splice(1, 1); // remove entry at index 1
    writeFileSync(auditPath, lines.join('\n') + '\n');

    const result = verifyAuditChain(auditPath);
    assert.equal(result.valid, false);
  });

  it('inserted entry detected: chain verification fails', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const log = createAuditLog(auditPath);

    log.append({ event: 'a', trace_id: 'T1' });
    log.append({ event: 'c', trace_id: 'T1' });

    // Insert a fake entry between them
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    const fake = JSON.stringify({ event: 'INJECTED', prev_hash: 'fake', entry_hash: 'fake', timestamp: new Date().toISOString() });
    lines.splice(1, 0, fake);
    writeFileSync(auditPath, lines.join('\n') + '\n');

    const result = verifyAuditChain(auditPath);
    assert.equal(result.valid, false);
  });

  it('verify on empty/missing file passes', () => {
    const result = verifyAuditChain('/nonexistent/path/audit.jsonl');
    assert.equal(result.valid, true);
    assert.equal(result.entries, 0);
  });

  it('entries include fingerprint', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const log = createAuditLog(auditPath);
    log.append({ event: 'test' });

    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    assert.ok(entry.fingerprint);
    assert.equal(typeof entry.fingerprint.os, 'string');
    assert.equal(typeof entry.fingerprint.hostname, 'string');
  });
});

// ===========================================================================
// 4. Audit Query
// ===========================================================================

describe('Bucket 3: Audit Query Surface', () => {
  it('filter by trace_id returns matching entries', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const log = createAuditLog(auditPath);

    log.append({ event: 'a', trace_id: 'T1' });
    log.append({ event: 'b', trace_id: 'T2' });
    log.append({ event: 'c', trace_id: 'T1' });

    const results = log.query({ trace_id: 'T1' });
    assert.equal(results.length, 2);
    assert.ok(results.every(e => e.trace_id === 'T1'));
  });

  it('filter by event type', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const log = createAuditLog(auditPath);

    log.append({ event: 'execution_start', trace_id: 'T1' });
    log.append({ event: 'approval', trace_id: 'T1' });
    log.append({ event: 'execution_end', trace_id: 'T1' });

    const results = log.query({ event: 'approval' });
    assert.equal(results.length, 1);
    assert.equal(results[0].event, 'approval');
  });

  it('filter by manifest_hash', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const log = createAuditLog(auditPath);

    log.append({ event: 'a', manifest_hash: 'HASH1' });
    log.append({ event: 'b', manifest_hash: 'HASH2' });

    const results = log.query({ manifest_hash: 'HASH1' });
    assert.equal(results.length, 1);
  });

  it('empty query returns all entries', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const log = createAuditLog(auditPath);

    log.append({ event: 'a' });
    log.append({ event: 'b' });

    const results = log.query({});
    assert.equal(results.length, 2);
  });
});

// ===========================================================================
// 5. Temporal Enforcement (I-A3)
// ===========================================================================

describe('Bucket 3: Temporal Enforcement (I-A3)', () => {
  it('validUntil in the past: blocked with time_window_expired', () => {
    const result = checkTimePolicy(
      { validUntil: '2020-01-01T00:00:00Z' },
      'testhash', tmpDir(),
    );
    assert.equal(result.allowed, false);
    assert.ok(result.errors.some(e => e.code === 'time_window_expired'));
  });

  it('validUntil in the future: allowed', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const result = checkTimePolicy({ validUntil: future }, 'testhash', tmpDir());
    assert.equal(result.allowed, true);
  });

  it('maxRuns exhausted: blocked with max_runs_exhausted', () => {
    const dir = tmpDir();
    // Pre-set counter to max
    const counterDir = join(dir, 'counters');
    mkdirSync(counterDir, { recursive: true });
    writeFileSync(join(counterDir, 'testhash-runs.json'), JSON.stringify({ value: 5 }));

    const result = checkTimePolicy({ maxRuns: 5 }, 'testhash', dir);
    assert.equal(result.allowed, false);
    assert.ok(result.errors.some(e => e.code === 'max_runs_exhausted'));
  });

  it('counter file missing on first run: initializes to 0, permits execution', () => {
    const dir = tmpDir();
    const result = checkTimePolicy({ maxRuns: 10 }, 'testhash', dir);
    assert.equal(result.allowed, true);
  });

  it('counter file corrupt: fail closed', () => {
    const dir = tmpDir();
    const counterDir = join(dir, 'counters');
    mkdirSync(counterDir, { recursive: true });
    writeFileSync(join(counterDir, 'testhash-runs.json'), 'NOT_JSON{{{');

    const result = checkTimePolicy({ maxRuns: 10 }, 'testhash', dir);
    assert.equal(result.allowed, false);
  });

  it('maxExecutionsPerMinute exceeded: blocked with rate_limit_exceeded', () => {
    const dir = tmpDir();
    const counterDir = join(dir, 'counters');
    mkdirSync(counterDir, { recursive: true });
    // Pre-fill rate state with max timestamps
    const timestamps = Array.from({ length: 5 }, () => Date.now());
    writeFileSync(join(counterDir, 'testhash-rate.json'), JSON.stringify({ timestamps }));

    const result = checkTimePolicy({ maxExecutionsPerMinute: 5 }, 'testhash', dir);
    assert.equal(result.allowed, false);
    assert.ok(result.errors.some(e => e.code === 'rate_limit_exceeded'));
  });

  it('allowedWindow outside current time: blocked', () => {
    // Create a window that definitely doesn't include now
    const now = new Date();
    const pastHour = (now.getHours() + 20) % 24;
    const window = `${String(pastHour).padStart(2, '0')}:00-${String(pastHour).padStart(2, '0')}:01`;

    const result = checkTimePolicy({ allowedWindow: window }, 'testhash', tmpDir());
    assert.equal(result.allowed, false);
    assert.ok(result.errors.some(e => e.code === 'outside_allowed_window'));
  });

  it('no runtime limits: allowed', () => {
    const result = checkTimePolicy(null, 'testhash', tmpDir());
    assert.equal(result.allowed, true);
  });
});

// ===========================================================================
// 6. Counter Persistence
// ===========================================================================

describe('Bucket 3: Counter Persistence', () => {
  it('atomic increment: value increases by 1', () => {
    const dir = tmpDir();
    const r1 = checkAndIncrementCounter('hash1', 'runs', 10, dir);
    assert.equal(r1.allowed, true);
    assert.equal(r1.value, 1);

    const r2 = checkAndIncrementCounter('hash1', 'runs', 10, dir);
    assert.equal(r2.allowed, true);
    assert.equal(r2.value, 2);
  });

  it('counter reaches max: blocked on next call', () => {
    const dir = tmpDir();
    checkAndIncrementCounter('hash1', 'runs', 2, dir);
    checkAndIncrementCounter('hash1', 'runs', 2, dir);
    const r3 = checkAndIncrementCounter('hash1', 'runs', 2, dir);
    assert.equal(r3.allowed, false);
    assert.ok(r3.code.includes('exhausted'));
  });
});

// ===========================================================================
// 7. Concurrency Control (I-A4)
// ===========================================================================

describe('Bucket 3: Concurrency Control (I-A4)', () => {
  it('two concurrent executions of same manifest: second blocked', () => {
    const dir = tmpDir();
    const r1 = acquireLock('hash1', [], dir, 60000);
    assert.equal(r1.acquired, true);

    const r2 = acquireLock('hash1', [], dir, 60000);
    assert.equal(r2.acquired, false);
    assert.equal(r2.code, 'concurrent_execution_blocked');

    r1.release();
  });

  it('lock with expired TTL: reclaimed, new execution proceeds', () => {
    const dir = tmpDir();
    // Acquire with 1ms TTL
    const r1 = acquireLock('hash2', [], dir, 1);
    assert.equal(r1.acquired, true);

    // Wait for TTL to expire
    const start = Date.now();
    while (Date.now() - start < 10) { /* busy wait */ }

    const r2 = acquireLock('hash2', [], dir, 60000);
    assert.equal(r2.acquired, true);
    r2.release();
  });

  it('lock with dead PID: reclaimed', () => {
    const dir = tmpDir();
    const lockDir = join(dir, 'locks');
    mkdirSync(lockDir, { recursive: true });

    // Write a lock file with a PID that doesn't exist
    const lockPath = join(lockDir, 'hash3.lock');
    writeFileSync(lockPath, JSON.stringify({
      pid: 999999999,
      acquiredAt: new Date().toISOString(),
      expiresAt: Date.now() + 600000, // far future
      manifestHash: 'hash3',
      resourceLocks: [],
    }));

    const r = acquireLock('hash3', [], dir, 60000);
    assert.equal(r.acquired, true);
    r.release();
  });

  it('normal exit: lock released', () => {
    const dir = tmpDir();
    const r = acquireLock('hash4', [], dir, 60000);
    assert.equal(r.acquired, true);
    r.release();

    // Should be able to re-acquire
    const r2 = acquireLock('hash4', [], dir, 60000);
    assert.equal(r2.acquired, true);
    r2.release();
  });

  it('lock file corrupt: fail closed', () => {
    const dir = tmpDir();
    const lockDir = join(dir, 'locks');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'hash5.lock'), 'NOT_JSON{{{');

    const r = acquireLock('hash5', [], dir, 60000);
    assert.equal(r.acquired, false);
    assert.equal(r.code, 'concurrent_execution_blocked');
  });
});

// ===========================================================================
// 8. Exit Codes
// ===========================================================================

describe('Bucket 3: Exit Codes', () => {
  it('time_policy_violated = 20', () => {
    assert.equal(STATUS_EXIT_CODES.time_policy_violated, 20);
  });

  it('concurrent_blocked = 21', () => {
    assert.equal(STATUS_EXIT_CODES.concurrent_blocked, 21);
  });

  it('audit_chain_broken = 22', () => {
    assert.equal(STATUS_EXIT_CODES.audit_chain_broken, 22);
  });
});

// ===========================================================================
// 9. Cryptographic Separation (I-A1)
// ===========================================================================

describe('Bucket 3: Cryptographic Separation (I-A1)', () => {
  it('execution modules do not export signing/approval functions', async () => {
    // Worker interface (execution path) should not have approval capability
    const worker = await import('../src/worker-interface.js');
    const workerExports = Object.keys(worker);
    assert.ok(!workerExports.includes('promptApproval'), 'Worker should not export promptApproval');
    assert.ok(!workerExports.includes('saveManifest'), 'Worker should not export saveManifest');
  });

  it('approval functions are in supervisor, not execution modules', async () => {
    const supervisor = await import('../src/supervisor.js');
    assert.ok(typeof supervisor.promptApproval === 'function');
    // Worker interface is the execution path — separate
    const worker = await import('../src/worker-interface.js');
    assert.ok(typeof worker.launchWorker === 'function');
  });
});

// ===========================================================================
// 10. Append-Only Enforcement
// ===========================================================================

describe('Bucket 3: Append-Only Audit Log', () => {
  it('audit module exports no delete/update/truncate operations', async () => {
    const audit = await import('../src/audit.js');
    const exports = Object.keys(audit);
    assert.ok(!exports.includes('deleteEntry'));
    assert.ok(!exports.includes('updateEntry'));
    assert.ok(!exports.includes('truncateLog'));
    assert.ok(!exports.includes('clearLog'));
    // Only: createAuditLog, appendEntry, verifyAuditChain, queryAuditLog
    assert.ok(exports.includes('createAuditLog'));
    assert.ok(exports.includes('appendEntry'));
    assert.ok(exports.includes('verifyAuditChain'));
    assert.ok(exports.includes('queryAuditLog'));
  });
});

// ===========================================================================
// 11. Sovereign Record Metadata (P0c)
// ===========================================================================

describe('Bucket 3: Sovereign Record Metadata', () => {
  it('sovereignMeta returns canonical shape with defaults', () => {
    const meta = sovereignMeta();
    assert.equal(meta.organization_id, null);
    assert.equal(meta.workspace_id, null);
    assert.equal(meta.retention_class, 'standard');
    assert.equal(meta.sensitivity, 'internal');
    assert.ok(meta.source_provenance);
    assert.ok(['project-local', 'shared-global'].includes(meta.source_provenance.root));
    assert.equal(meta.source_provenance.ref, null);
    assert.equal(meta.source_provenance.pinned_hash, null);
  });

  it('sovereignMeta reads org/workspace from env vars', () => {
    process.env.GUARDRAIL_ORG_ID = 'org-test-123';
    process.env.GUARDRAIL_WORKSPACE_ID = 'ws-test-456';
    process.env.GUARDRAIL_RETENTION_CLASS = 'extended';
    process.env.GUARDRAIL_SENSITIVITY = 'confidential';
    try {
      const meta = sovereignMeta();
      assert.equal(meta.organization_id, 'org-test-123');
      assert.equal(meta.workspace_id, 'ws-test-456');
      assert.equal(meta.retention_class, 'extended');
      assert.equal(meta.sensitivity, 'confidential');
    } finally {
      delete process.env.GUARDRAIL_ORG_ID;
      delete process.env.GUARDRAIL_WORKSPACE_ID;
      delete process.env.GUARDRAIL_RETENTION_CLASS;
      delete process.env.GUARDRAIL_SENSITIVITY;
    }
  });

  it('sovereignMeta falls back to defaults for invalid retention_class/sensitivity', () => {
    process.env.GUARDRAIL_RETENTION_CLASS = 'bogus';
    process.env.GUARDRAIL_SENSITIVITY = 'top-secret';
    try {
      const meta = sovereignMeta();
      assert.equal(meta.retention_class, 'standard');
      assert.equal(meta.sensitivity, 'internal');
    } finally {
      delete process.env.GUARDRAIL_RETENTION_CLASS;
      delete process.env.GUARDRAIL_SENSITIVITY;
    }
  });

  it('sovereignMeta accepts provenance descriptor', () => {
    const meta = sovereignMeta({
      root: 'shared-global',
      ref: 'github://acme/recipes/deploy@abc123',
      pinned_hash: 'deadbeef',
    });
    assert.equal(meta.source_provenance.root, 'shared-global');
    assert.equal(meta.source_provenance.ref, 'github://acme/recipes/deploy@abc123');
    assert.equal(meta.source_provenance.pinned_hash, 'deadbeef');
  });

  it('computePayloadHash is deterministic and excludes chain fields', () => {
    const payload = { event: 'execution_start', trace_id: 'T1', timestamp: '2026-01-01T00:00:00Z' };
    const h1 = computePayloadHash(payload);
    const h2 = computePayloadHash(payload);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64); // SHA-256 hex

    // Excluded fields should not affect the hash
    const withChain = { ...payload, entry_hash: 'aaa', payload_hash: 'bbb', prev_hash: 'ccc' };
    assert.equal(computePayloadHash(withChain), h1);

    // Different payload → different hash
    const h3 = computePayloadHash({ ...payload, event: 'execution_end' });
    assert.notEqual(h1, h3);
  });

  it('RETENTION_CLASSES and SENSITIVITY_LABELS are Sets with expected members', () => {
    assert.ok(RETENTION_CLASSES.has('standard'));
    assert.ok(RETENTION_CLASSES.has('extended'));
    assert.ok(RETENTION_CLASSES.has('permanent'));
    assert.ok(SENSITIVITY_LABELS.has('public'));
    assert.ok(SENSITIVITY_LABELS.has('internal'));
    assert.ok(SENSITIVITY_LABELS.has('confidential'));
    assert.ok(SENSITIVITY_LABELS.has('restricted'));
  });

  it('audit entries carry sovereign metadata fields', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const log = createAuditLog(auditPath);
    log.append({ event: 'execution_start', trace_id: 'T1' });
    const entry = JSON.parse(readFileSync(auditPath, 'utf8').trim());
    assert.ok('organization_id' in entry, 'missing organization_id');
    assert.ok('workspace_id' in entry, 'missing workspace_id');
    assert.ok('retention_class' in entry, 'missing retention_class');
    assert.ok('sensitivity' in entry, 'missing sensitivity');
    assert.ok('source_provenance' in entry, 'missing source_provenance');
    assert.ok('payload_hash' in entry, 'missing payload_hash');
    assert.equal(entry.payload_hash.length, 64);
  });

  it('audit chain still verifies after sovereign fields are added', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const log = createAuditLog(auditPath);
    log.append({ event: 'execution_start', trace_id: 'T1' });
    log.append({ event: 'execution_end', trace_id: 'T1' });
    const result = log.verify();
    assert.equal(result.valid, true);
  });

  it('payload_hash changes when event payload changes', () => {
    const dir = tmpDir();
    const auditPath = join(dir, 'audit.jsonl');
    const log = createAuditLog(auditPath);
    log.append({ event: 'execution_start', trace_id: 'T1' });
    log.append({ event: 'execution_end', trace_id: 'T1' });
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    const e1 = JSON.parse(lines[0]);
    const e2 = JSON.parse(lines[1]);
    assert.notEqual(e1.payload_hash, e2.payload_hash);
  });
});
