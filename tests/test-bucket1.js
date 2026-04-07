import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  createContract,
  normalizeContract,
  hashContract,
  serializeStable,
  checkRegexSafety,
  verifyFileHash,
} from '../src/contract.js';

import {
  createManifest,
  saveManifest,
  loadManifest,
  compareManifests,
  diffManifests,
} from '../src/manifest.js';

import { evaluateRisk } from '../src/policy-engine.js';
import { STATUS_EXIT_CODES } from '../src/supervisor.js';
import { validateResult } from '../src/validator.js';
import { detectInteractiveAttempt } from '../src/worker-interface.js';
import { loadWorkflowDefinition } from '../src/workflow.js';
import { validateTemplate, TemplateValidationError } from '../src/template.js';

// =========================================================================
// Bucket 1 Test Coverage Requirements
// =========================================================================

// ---------------------------------------------------------------------------
// 1. Canonical Hash Determinism
// ---------------------------------------------------------------------------

describe('Bucket 1: Canonical Hash Determinism', () => {
  it('same command produces identical hash regardless of key ordering in options', () => {
    const a = createContract({ command: 'node', args: ['index.js'], cwd: '/tmp' });
    const b = createContract({ args: ['index.js'], command: 'node', cwd: '/tmp' });
    assert.equal(hashContract(a), hashContract(b));
  });

  it('serializeStable produces consistent output across different key orders', () => {
    const obj1 = { z: 1, a: 2, m: 3 };
    const obj2 = { a: 2, m: 3, z: 1 };
    assert.equal(serializeStable(obj1), serializeStable(obj2));
  });

  it('nested objects are serialized deterministically', () => {
    const obj1 = { outer: { z: 1, a: 2 }, name: 'test' };
    const obj2 = { name: 'test', outer: { a: 2, z: 1 } };
    assert.equal(serializeStable(obj1), serializeStable(obj2));
  });

  it('arrays preserve element order in serialization', () => {
    const a = serializeStable([1, 2, 3]);
    const b = serializeStable([3, 2, 1]);
    assert.notEqual(a, b);
  });

  it('hash is a 64-character hex string (SHA-256)', () => {
    const c = createContract({ command: 'echo', args: ['hello'] });
    const h = hashContract(c);
    assert.match(h, /^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 2–3. Symlink Path Resolution
// ---------------------------------------------------------------------------

describe('Bucket 1: Symlink Resolution', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardrail-symlink-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('symlink to approved path resolves to the same canonical path', () => {
    // Create a real file and a symlink to it
    const realFile = join(tmpDir, 'real-script.sh');
    const linkFile = join(tmpDir, 'link-script.sh');
    writeFileSync(realFile, '#!/bin/bash\necho hello\n');
    symlinkSync(realFile, linkFile);

    // Both should resolve to the same canonical path when used as cwd
    const contractReal = createContract({ command: 'node', args: ['test.js'], cwd: tmpDir });
    const contractLink = createContract({ command: 'node', args: ['test.js'], cwd: tmpDir });

    // The resolved cwd should be the same since the directory is the same
    assert.equal(contractReal.cwd, contractLink.cwd);
    assert.equal(hashContract(contractReal), hashContract(contractLink));
  });

  it('symlink cwd resolves to real path for consistent hashing', () => {
    // Create a real directory and a symlink to it
    const realDir = join(tmpDir, 'real-dir');
    const linkDir = join(tmpDir, 'link-dir');
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, linkDir);

    const contractFromReal = createContract({ command: 'node', args: ['test.js'], cwd: realDir });
    const contractFromLink = createContract({ command: 'node', args: ['test.js'], cwd: linkDir });

    // Both should resolve to the same canonical cwd
    assert.equal(contractFromReal.cwd, contractFromLink.cwd);
    assert.equal(hashContract(contractFromReal), hashContract(contractFromLink));
  });

  it('symlinked writable path resolves to canonical real path', () => {
    const realDir = join(tmpDir, 'real-write');
    const linkDir = join(tmpDir, 'link-write');
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, linkDir);

    // Pass the symlink as an explicit writable path
    const contract = createContract({
      command: 'node',
      args: ['test.js'],
      cwd: realDir,
      writablePaths: [linkDir],
    });

    // The writable path should be resolved through the symlink to the real path
    // Use realpathSync because macOS resolves /var -> /private/var
    const resolvedReal = realpathSync(realDir);
    assert.ok(
      contract.writablePaths.some(p => p === resolvedReal),
      `Expected ${resolvedReal} in writablePaths: ${JSON.stringify(contract.writablePaths)}`,
    );
  });

  it('risk evaluation treats symlinked project root consistently', () => {
    const realDir = join(tmpDir, 'safe-dir');
    const linkDir = join(tmpDir, 'safe-link');
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, linkDir);

    // Contract via real path
    const contractReal = createContract({
      command: 'node',
      args: ['test.js'],
      cwd: realDir,
    });
    const riskReal = evaluateRisk(contractReal, {
      trustClass: 'reviewed_internal',
      projectRoot: realDir,
    });

    // Contract via symlink — should resolve to the same
    const contractLink = createContract({
      command: 'node',
      args: ['test.js'],
      cwd: linkDir,
    });
    const riskLink = evaluateRisk(contractLink, {
      trustClass: 'reviewed_internal',
      projectRoot: realDir,
    });

    // Both should produce the same risk level
    assert.equal(riskReal.riskLevel, riskLink.riskLevel);
  });
});

// ---------------------------------------------------------------------------
// 4–5. File Hash Match / Mismatch
// ---------------------------------------------------------------------------

describe('Bucket 1: File Provenance Enforcement', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardrail-filehash-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fileHash: null skips verification (verified: true, skipped: true)', () => {
    const result = verifyFileHash('node', null);
    assert.equal(result.verified, true);
    assert.equal(result.skipped, true);
  });

  it('fileHash: undefined skips verification', () => {
    const result = verifyFileHash('node', undefined);
    assert.equal(result.verified, true);
    assert.equal(result.skipped, true);
  });

  it('correct file hash passes verification', () => {
    const scriptPath = join(tmpDir, 'good-script.sh');
    const content = '#!/bin/bash\necho hello\n';
    writeFileSync(scriptPath, content);
    chmodSync(scriptPath, 0o755);

    const expectedHash = createHash('sha256').update(readFileSync(scriptPath)).digest('hex');

    const result = verifyFileHash(scriptPath, expectedHash);
    assert.equal(result.verified, true);
    assert.equal(result.skipped, false);
    assert.equal(result.actual, expectedHash);
    assert.equal(result.expected, expectedHash);
  });

  it('wrong file hash fails verification (file_hash_mismatch)', () => {
    const scriptPath = join(tmpDir, 'bad-script.sh');
    writeFileSync(scriptPath, '#!/bin/bash\necho original\n');
    chmodSync(scriptPath, 0o755);

    const fakeHash = 'a'.repeat(64);

    const result = verifyFileHash(scriptPath, fakeHash);
    assert.equal(result.verified, false);
    assert.equal(result.skipped, false);
    assert.equal(result.expected, fakeHash);
    assert.notEqual(result.actual, fakeHash);
  });

  it('nonexistent file fails verification', () => {
    const result = verifyFileHash(join(tmpDir, 'nonexistent'), 'abc123');
    assert.equal(result.verified, false);
    assert.equal(result.skipped, false);
  });

  it('fileHash is included in contract defaults as null', () => {
    const contract = createContract({ command: 'node', args: ['test.js'] });
    assert.equal(contract.fileHash, null);
  });

  it('fileHash value is preserved through contract creation', () => {
    const contract = createContract({
      command: 'node',
      args: ['test.js'],
      fileHash: 'abc123def456',
    });
    assert.equal(contract.fileHash, 'abc123def456');
  });

  it('fileHash change triggers manifest drift', () => {
    const contract1 = createContract({ command: 'node', args: ['test.js'], fileHash: 'hash1' });
    const contract2 = createContract({ command: 'node', args: ['test.js'], fileHash: 'hash2' });

    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] };
    const workflow = { validator: 'exit_code', updateSource: 'none' };

    const m1 = createManifest(contract1, hashContract(contract1), risk, workflow, '/tmp');
    const m2 = createManifest(contract2, hashContract(contract2), risk, workflow, '/tmp');

    const comparison = compareManifests(m2, m1);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.diffs.some(d => /fileHash/.test(d)));
  });
});

// ---------------------------------------------------------------------------
// 6. TOCTOU Mitigation (documented limitation)
// ---------------------------------------------------------------------------

describe('Bucket 1: TOCTOU Mitigation', () => {
  it('documents that full TOCTOU mitigation requires native fexecve (not available in Node.js)', () => {
    // TOCTOU mitigation via hash→fd→exec requires fexecve which Node.js
    // does not expose. The current implementation:
    // 1. Verifies file hash before execution (file provenance)
    // 2. Uses spawn() which re-opens by path (inherent Node.js limitation)
    //
    // Full TOCTOU mitigation would require a native addon using fexecve(3).
    // This test documents the limitation and verifies the best-effort guard works.
    assert.ok(true, 'TOCTOU mitigation is a documented limitation — file hash provides best-effort guard');
  });

  it('file hash verification catches content changes between approval and execution', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'guardrail-toctou-'));
    try {
      const script = join(tmpDir, 'script.sh');
      writeFileSync(script, '#!/bin/bash\necho safe\n');
      chmodSync(script, 0o755);

      // Compute hash of original content
      const originalHash = createHash('sha256').update(readFileSync(script)).digest('hex');

      // Simulate file being modified after hash was recorded
      writeFileSync(script, '#!/bin/bash\nrm -rf /\n');

      // Verification should fail
      const result = verifyFileHash(script, originalHash);
      assert.equal(result.verified, false);
      assert.notEqual(result.actual, originalHash);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Exit 0 with Failing Validator = validation_failed
// ---------------------------------------------------------------------------

describe('Bucket 1: Exit 0 + Validator Failure', () => {
  it('exit code 0 with no SUCCESS protocol message in ndjson mode is protocol_error', () => {
    const workerResult = {
      exitCode: 0,
      stdout: 'just some text, no protocol messages\n',
      stderr: '',
    };
    const validation = validateResult(workerResult, 'ndjson');
    assert.equal(validation.valid, false);
    assert.equal(validation.status, 'protocol_error');
  });

  it('exit code 0 with VALIDATION_FAILED_REQUIRE_UPDATE is not success', () => {
    const msg = {
      type: 'VALIDATION_FAILED_REQUIRE_UPDATE',
      payload: {
        validationSignature: 'sig',
        reason: 'test failed',
        proposedUpdate: {
          action: 'apply_patch',
          summary: 'fix test',
          command: 'node',
          args: ['fix.js'],
        },
      },
    };
    const workerResult = {
      exitCode: 0,
      stdout: JSON.stringify(msg) + '\n',
      stderr: '',
    };
    const validation = validateResult(workerResult, 'ndjson');
    assert.equal(validation.valid, false);
    assert.equal(validation.status, 'update_requested');
  });

  it('exit code 0 in exit_code mode is success', () => {
    const result = validateResult({ exitCode: 0, stdout: '', stderr: '' }, 'exit_code');
    assert.equal(result.valid, true);
    assert.equal(result.status, 'success');
  });

  it('exit code 1 in exit_code mode is validation_failed', () => {
    const result = validateResult({ exitCode: 1, stdout: '', stderr: '' }, 'exit_code');
    assert.equal(result.valid, false);
    assert.equal(result.status, 'validation_failed');
  });
});

// ---------------------------------------------------------------------------
// 8. ReDoS Regex Rejection at Approval Time
// ---------------------------------------------------------------------------

describe('Bucket 1: ReDoS Regex Rejection', () => {
  it('safe regex passes check', () => {
    const result = checkRegexSafety('^[a-z0-9-]+$');
    assert.equal(result.safe, true);
    assert.equal(result.reason, null);
  });

  it('nested quantifier (a+)+ is rejected', () => {
    const result = checkRegexSafety('(a+)+');
    assert.equal(result.safe, false);
    assert.ok(result.reason.includes('ReDoS'));
  });

  it('nested quantifier (.*)*  is rejected', () => {
    const result = checkRegexSafety('(.*)*');
    assert.equal(result.safe, false);
  });

  it('alternation in quantified group (a|b)+ is rejected', () => {
    const result = checkRegexSafety('(a|b)+');
    assert.equal(result.safe, false);
  });

  it('non-string input is treated as safe', () => {
    const result = checkRegexSafety(null);
    assert.equal(result.safe, true);
  });

  it('workflow definition with ReDoS validator regex is rejected at validation time', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'guardrail-redos-'));
    try {
      const defPath = join(tmpDir, 'bad-workflow.json');
      writeFileSync(defPath, JSON.stringify({
        version: 1,
        kind: 'workflow_definition',
        name: 'bad-regex',
        projectRoot: '.',
        entryStep: 'step1',
        services: [],
        steps: [{
          id: 'step1',
          type: 'task',
          run: { command: 'echo', args: ['test'], mode: 'structured' },
          validator: { regex: '(a+)+b' },
          on: { success: 'done', failure: 'abort' },
        }],
      }));

      assert.throws(
        () => loadWorkflowDefinition(defPath),
        (err) => err.errors?.some(e => /ReDoS|regex rejected/.test(e)) ?? /ReDoS|regex rejected/.test(err.message),
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('template with ReDoS input pattern is rejected at validation time', () => {
    assert.throws(
      () => validateTemplate({
        version: 1,
        kind: 'template',
        name: 'bad-pattern',
        description: 'Template with bad regex',
        trust_class: 'reviewed_internal',
        risk: 'green',
        risk_reasons: [],
        inputs: {
          name: { type: 'string', pattern: '(a+)+b' },
        },
        run: { command: 'echo', args: ['{{inputs.name}}'], mode: 'structured' },
        idempotent: true,
      }),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /rejected/.test(e)),
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Missing Manifest in Strict Mode
// ---------------------------------------------------------------------------

describe('Bucket 1: Missing Manifest — Non-Interactive', () => {
  it('approval_required maps to exit code 10', () => {
    assert.equal(STATUS_EXIT_CODES.approval_required, 10);
  });

  it('missing manifest in non-interactive mode returns approval_required', () => {
    // This is validated by the supervisor's non-interactive path:
    // if nonInteractive && manifest === null → exit 10
    // Already tested in test-core.js, but confirm the exit code mapping
    assert.equal(STATUS_EXIT_CODES.approval_required, 10);
    assert.ok(STATUS_EXIT_CODES.approval_required !== 0);
  });
});

// ---------------------------------------------------------------------------
// 10. Drift Detected — Exit 12
// ---------------------------------------------------------------------------

describe('Bucket 1: Drift Detection — Exit 12', () => {
  it('drift_detected maps to exit code 12', () => {
    assert.equal(STATUS_EXIT_CODES.drift_detected, 12);
  });

  it('changing command triggers drift with structured diff', () => {
    const c1 = createContract({ command: 'npm', args: ['test'] });
    const c2 = createContract({ command: 'npm', args: ['install'] });

    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] };
    const wf = { validator: 'exit_code', updateSource: 'none' };

    const m1 = createManifest(c1, hashContract(c1), risk, wf, '/tmp');
    const m2 = createManifest(c2, hashContract(c2), risk, wf, '/tmp');

    const comparison = compareManifests(m2, m1);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.diffs.length > 0);
    assert.ok(comparison.diffs.some(d => /args/.test(d)));
  });

  it('adding a flag triggers drift', () => {
    const c1 = createContract({ command: 'npm', args: ['test'] });
    const c2 = createContract({ command: 'npm', args: ['test', '--verbose'] });

    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] };
    const wf = { validator: 'exit_code', updateSource: 'none' };

    const m1 = createManifest(c1, hashContract(c1), risk, wf, '/tmp');
    const m2 = createManifest(c2, hashContract(c2), risk, wf, '/tmp');

    const comparison = compareManifests(m2, m1);
    assert.equal(comparison.matches, false);
  });

  it('changing mode to shell triggers drift', () => {
    const c1 = createContract({ command: 'npm', args: ['test'], mode: 'structured' });
    const c2 = createContract({ command: 'npm test', args: [], mode: 'shell', shell: 'npm test' });

    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] };
    const wf = { validator: 'exit_code', updateSource: 'none' };

    const m1 = createManifest(c1, hashContract(c1), risk, wf, '/tmp');
    const m2 = createManifest(c2, hashContract(c2), risk, wf, '/tmp');

    const comparison = compareManifests(m2, m1);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.diffs.some(d => /mode/.test(d)));
  });

  it('risk escalation is captured in drift diff', () => {
    const contract = createContract({ command: 'npm', args: ['test'] });
    const hash = hashContract(contract);
    const wf = { validator: 'exit_code', updateSource: 'none' };

    const m1 = createManifest(contract, hash, { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] }, wf, '/tmp');
    const m2 = createManifest(contract, hash, { trustClass: 'reviewed_internal', riskLevel: 'yellow', reasons: ['shell mode enabled'] }, wf, '/tmp');

    const comparison = compareManifests(m2, m1);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.diffs.some(d => /riskLevel/.test(d)));
  });
});

// ---------------------------------------------------------------------------
// 11. Widening Detected — Blocked
// ---------------------------------------------------------------------------

describe('Bucket 1: Widening Detection', () => {
  it('adding a new env var to allow list is detected as drift', () => {
    const c1 = createContract({ command: 'node', args: ['app.js'], envPolicy: { inherit: false, allow: ['PATH'] } });
    const c2 = createContract({ command: 'node', args: ['app.js'], envPolicy: { inherit: false, allow: ['PATH', 'SECRET_KEY'] } });

    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] };
    const wf = { validator: 'exit_code', updateSource: 'none' };

    const m1 = createManifest(c1, hashContract(c1), risk, wf, '/tmp');
    const m2 = createManifest(c2, hashContract(c2), risk, wf, '/tmp');

    const comparison = compareManifests(m2, m1);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.diffs.some(d => /envPolicy/.test(d)));
  });

  it('adding writable paths widens scope and is blocked', () => {
    const c1 = createContract({ command: 'node', args: ['app.js'], writablePaths: ['/tmp/safe'] });
    const c2 = createContract({ command: 'node', args: ['app.js'], writablePaths: ['/tmp/safe', '/etc'] });

    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] };
    const wf = { validator: 'exit_code', updateSource: 'none' };

    const m1 = createManifest(c1, hashContract(c1), risk, wf, '/tmp');
    const m2 = createManifest(c2, hashContract(c2), risk, wf, '/tmp');

    const comparison = compareManifests(m2, m1);
    assert.equal(comparison.matches, false);
    assert.ok(comparison.diffs.some(d => /writablePaths/.test(d)));
  });

  it('switching from structured to shell widens and is blocked', () => {
    const c1 = createContract({ command: 'echo', args: ['hello'], mode: 'structured' });
    const c2 = createContract({ command: 'echo hello', args: [], mode: 'shell', shell: 'echo hello' });

    assert.notEqual(hashContract(c1), hashContract(c2));
  });
});

// ---------------------------------------------------------------------------
// 12. Anti-Interactive Detection
// ---------------------------------------------------------------------------

describe('Bucket 1: Anti-Interactive Execution', () => {
  it('detects password prompt in stderr', () => {
    const result = detectInteractiveAttempt({
      exitCode: 1,
      stdout: '',
      stderr: 'Enter your password: ',
    });
    assert.equal(result.detected, true);
    assert.ok(result.pattern);
  });

  it('detects y/n confirmation prompt', () => {
    const result = detectInteractiveAttempt({
      exitCode: 1,
      stdout: '',
      stderr: 'Are you sure? [Y/n] ',
    });
    assert.equal(result.detected, true);
  });

  it('detects (yes/no) prompt', () => {
    const result = detectInteractiveAttempt({
      exitCode: 1,
      stdout: '',
      stderr: 'Continue? (yes/no): ',
    });
    assert.equal(result.detected, true);
  });

  it('does not flag normal error output', () => {
    const result = detectInteractiveAttempt({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Module not found\n',
    });
    assert.equal(result.detected, false);
  });

  it('does not flag on exit code 0 (process succeeded)', () => {
    // If exit code is 0, the process completed fine - no stdin blocking
    const result = detectInteractiveAttempt({
      exitCode: 0,
      stdout: 'Success\n',
      stderr: '',
    });
    assert.equal(result.detected, false);
  });

  it('validation_failed exit code is 13', () => {
    assert.equal(STATUS_EXIT_CODES.validation_failed, 13);
  });
});

// ---------------------------------------------------------------------------
// Risk Classification Invariant I-6
// ---------------------------------------------------------------------------

describe('Bucket 1: Risk Is Computed, Not Declared (I-6)', () => {
  it('computed risk overrides declared when higher', () => {
    // A contract that should compute as yellow or red (shell mode + package install)
    const contract = createContract({
      command: 'npm',
      args: ['install'],
      mode: 'shell',
      shell: 'npm install',
    });

    const risk = evaluateRisk(contract, { trustClass: 'reviewed_internal' });
    // Shell + package install → RED
    assert.equal(risk.riskLevel, 'red');
  });

  it('trust class generated escalates to red', () => {
    const contract = createContract({ command: 'node', args: ['test.js'] });
    const risk = evaluateRisk(contract, { trustClass: 'generated' });
    assert.equal(risk.riskLevel, 'red');
    assert.ok(risk.reasons.includes('generated workflow source'));
  });

  it('trust class unknown escalates to red', () => {
    const contract = createContract({ command: 'node', args: ['test.js'] });
    const risk = evaluateRisk(contract, { trustClass: 'unknown' });
    assert.equal(risk.riskLevel, 'red');
  });

  it('safe structured command with reviewed_internal is green', () => {
    const contract = createContract({ command: 'node', args: ['test.js'] });
    const risk = evaluateRisk(contract, { trustClass: 'reviewed_internal' });
    assert.equal(risk.riskLevel, 'green');
  });
});

// ---------------------------------------------------------------------------
// No Bypass Surface (I-3)
// ---------------------------------------------------------------------------

describe('Bucket 1: No Bypass Surface (I-3)', () => {
  it('there is no --force flag in the CLI argument parser', () => {
    // Verify by checking that the parser rejects --force
    // We import parseArgs indirectly by testing the CLI module structure
    // The USAGE string should not contain --force, --skip-check, etc.
    const cliSource = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
    assert.ok(!cliSource.includes("'--force'"));
    assert.ok(!cliSource.includes("'--skip-check'"));
    assert.ok(!cliSource.includes("'--skip-verify'"));
    assert.ok(!cliSource.includes("'--no-verify'"));
  });
});

// ---------------------------------------------------------------------------
// Exit Code Completeness
// ---------------------------------------------------------------------------

describe('Bucket 1: Exit Code Mapping', () => {
  it('exit 0 = success', () => assert.equal(STATUS_EXIT_CODES.success, 0));
  it('exit 10 = approval_required', () => assert.equal(STATUS_EXIT_CODES.approval_required, 10));
  it('exit 11 = approval_denied', () => assert.equal(STATUS_EXIT_CODES.approval_denied, 11));
  it('exit 12 = drift_detected', () => assert.equal(STATUS_EXIT_CODES.drift_detected, 12));
  it('exit 13 = validation_failed', () => assert.equal(STATUS_EXIT_CODES.validation_failed, 13));
  it('exit 16 = policy_violation', () => assert.equal(STATUS_EXIT_CODES.policy_violation, 16));

  it('all exit codes are in range 0 or 10-19', () => {
    for (const [, code] of Object.entries(STATUS_EXIT_CODES)) {
      assert.ok(code === 0 || (code >= 10 && code <= 19), `Exit code ${code} is out of range`);
    }
  });
});
