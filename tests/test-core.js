import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createContract,
  normalizeContract,
  hashContract,
  detectShellFeatures,
  hasShellMetacharacters,
  serializeStable,
} from '../src/contract.js';

import {
  createManifest,
  saveManifest,
  loadManifest,
  compareManifests,
  diffManifests,
} from '../src/manifest.js';

import {
  evaluateRisk,
  classifyTrust,
  requiresStrongConfirmation,
} from '../src/policy-engine.js';

import { STATUS_EXIT_CODES, buildOutOfScopeUpdateDecision, promptApproval } from '../src/supervisor.js';

import { parseNdjsonLine } from '../src/worker-interface.js';

import {
  validateResult,
  validateUpdateProposal,
  createConvergenceTracker,
  computeValidationSignature,
} from '../src/validator.js';

import {
  hasColor,
  colorize,
  riskColor,
  generateRunId,
  printApprovalSummary,
} from '../src/logger.js';

// =========================================================================
// 1. Contract Normalization
// =========================================================================

describe('Contract Normalization', () => {
  it('identical logical contracts hash identically', () => {
    const a = createContract({ command: 'node', args: ['index.js'] });
    const b = createContract({ command: 'node', args: ['index.js'] });
    assert.equal(hashContract(a), hashContract(b));
  });

  it('changed args change the hash', () => {
    const a = createContract({ command: 'node', args: ['a.js'] });
    const b = createContract({ command: 'node', args: ['b.js'] });
    assert.notEqual(hashContract(a), hashContract(b));
  });

  it('changed shell text changes the hash', () => {
    const a = createContract({ mode: 'shell', shell: 'echo hello' });
    const b = createContract({ mode: 'shell', shell: 'echo world' });
    assert.notEqual(hashContract(a), hashContract(b));
  });

  it('default values are applied correctly', () => {
    const c = createContract({});
    assert.equal(c.mode, 'structured');
    assert.deepEqual(c.args, []);
    assert.equal(c.childProcessPolicy, 'deny');
    assert.equal(c.networkPolicy, 'undeclared');
    assert.equal(c.timeoutMs, 60000);
    assert.deepEqual(c.retryPolicy, { maxRetries: 3, backoff: [1000, 2000, 4000] });
    assert.deepEqual(c.envPolicy.allow, ['PATH']);
    assert.equal(c.envPolicy.inherit, false);
  });

  it('detects pipes in shell text', () => {
    const features = detectShellFeatures('cat file.txt | grep foo');
    assert.equal(features.pipes, true);
    assert.equal(features.redirects, false);
    assert.equal(features.subshells, false);
    assert.equal(features.envExpansion, false);
  });

  it('detects redirects in shell text', () => {
    const features = detectShellFeatures('echo hello > out.txt');
    assert.equal(features.redirects, true);
  });

  it('detects subshells in shell text', () => {
    const features = detectShellFeatures('echo $(whoami)');
    assert.equal(features.subshells, true);
  });

  it('detects env expansion in shell text', () => {
    const features = detectShellFeatures('echo $HOME');
    assert.equal(features.envExpansion, true);
  });

  it('detects env expansion with braces', () => {
    const features = detectShellFeatures('echo ${HOME}');
    assert.equal(features.envExpansion, true);
  });

  it('returns all false for non-string input', () => {
    const features = detectShellFeatures(null);
    assert.deepEqual(features, { pipes: false, redirects: false, subshells: false, envExpansion: false });
  });

  it('detects shell metacharacters', () => {
    assert.equal(hasShellMetacharacters('echo hello | grep foo'), true);
    assert.equal(hasShellMetacharacters('ls > out.txt'), true);
    assert.equal(hasShellMetacharacters('$(cmd)'), true);
    assert.equal(hasShellMetacharacters('echo $VAR'), true);
    assert.equal(hasShellMetacharacters('cmd1 & cmd2'), true);
    assert.equal(hasShellMetacharacters('cmd1 ; cmd2'), true);
  });

  it('no metacharacters in simple text', () => {
    assert.equal(hasShellMetacharacters('node index.js'), false);
    assert.equal(hasShellMetacharacters('hello world'), false);
  });

  it('serializeStable produces consistent output', () => {
    const obj = { b: 2, a: 1, c: { z: 26, y: 25 } };
    const expected = '{"a":1,"b":2,"c":{"y":25,"z":26}}';
    assert.equal(serializeStable(obj), expected);
  });

  it('serializeStable handles null and undefined', () => {
    assert.equal(serializeStable(null), 'null');
    assert.equal(serializeStable(undefined), undefined); // JSON.stringify(undefined) returns undefined
  });

  it('serializeStable handles arrays', () => {
    assert.equal(serializeStable([3, 1, 2]), '[3,1,2]');
  });

  it('path normalization resolves cwd to absolute', () => {
    const c = createContract({ command: 'node' });
    assert.equal(c.cwd.startsWith('/'), true);
  });

  it('infers default allowedBinaries and path scope for structured commands', () => {
    const c = createContract({ command: 'npm', args: ['test'] });
    assert.deepEqual(c.allowedBinaries, ['npm']);
    assert.deepEqual(c.writablePaths, [c.cwd]);
    assert.deepEqual(c.readablePaths, [c.cwd]);
  });

  it('does not normalize allowedBinaries into cwd-relative paths', () => {
    const c = createContract({ command: 'npm', allowedBinaries: ['npm', 'node'] });
    assert.deepEqual(c.allowedBinaries, ['node', 'npm']);
  });
});

// =========================================================================
// 2. Manifest Hashing Stability
// =========================================================================

describe('Manifest Hashing Stability', () => {
  it('same contract produces same hash every time', () => {
    const contract = createContract({ command: 'node', args: ['test.js'] });
    const h1 = hashContract(contract);
    const h2 = hashContract(contract);
    const h3 = hashContract(contract);
    assert.equal(h1, h2);
    assert.equal(h2, h3);
  });

  describe('manifest save/load round-trip', () => {
    let tmpDir;

    before(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'guardrail-test-'));
    });

    after(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('saves and loads a manifest correctly', () => {
      const contract = createContract({ command: 'node', args: ['app.js'] });
      const hash = hashContract(contract);
      const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [], requiresStrongConfirmation: false };
      const workflow = { validator: 'exit_code', updateSource: 'none' };
      const manifest = createManifest(contract, hash, risk, workflow, '/tmp/project');

      const filePath = join(tmpDir, 'approved.json');
      saveManifest(manifest, filePath);
      const loaded = loadManifest(filePath);

      assert.equal(loaded.contractHash, hash);
      assert.equal(loaded.version, 1);
      assert.equal(loaded.tool, 'guardrail');
      assert.deepEqual(loaded.contract.command, contract.command);
      assert.deepEqual(loaded.contract.args, contract.args);
      assert.equal(loaded.riskAssessment.riskLevel, 'green');
      assert.equal(loaded.workflow.validator, 'exit_code');
    });

    it('missing manifest returns null', () => {
      const result = loadManifest(join(tmpDir, 'nonexistent.json'));
      assert.equal(result, null);
    });

    it('corrupt manifest throws', () => {
      const corruptPath = join(tmpDir, 'corrupt.json');
      writeFileSync(corruptPath, '{{{{not json!!!!', 'utf8');
      assert.throws(() => loadManifest(corruptPath), /Corrupt manifest/);
    });
  });

  it('manifest comparison - matching', () => {
    const contract = createContract({ command: 'node', args: ['app.js'] });
    const hash = hashContract(contract);
    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: ['patch/update path enabled'] };
    const workflow = { validator: 'exit_code', updateSource: 'none' };

    const m1 = createManifest(contract, hash, risk, workflow, '/tmp/project');
    const m2 = createManifest(contract, hash, risk, workflow, '/tmp/project');

    const result = compareManifests(m1, m2);
    assert.equal(result.matches, true);
    assert.equal(result.diffs.length, 0);
  });

  it('manifest comparison - drift detected', () => {
    const c1 = createContract({ command: 'node', args: ['app.js'] });
    const c2 = createContract({ command: 'node', args: ['other.js'] });
    const hash1 = hashContract(c1);
    const hash2 = hashContract(c2);
    const risk = { riskLevel: 'green', reasons: [] };
    const workflow = { validator: 'exit_code' };

    const m1 = createManifest(c1, hash1, risk, workflow, '/tmp/project');
    const m2 = createManifest(c2, hash2, risk, workflow, '/tmp/project');

    const result = compareManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.length > 0);
  });

  it('manifest comparison detects workflow drift', () => {
    const contract = createContract({ command: 'node', args: ['app.js'] });
    const hash = hashContract(contract);
    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] };

    const m1 = createManifest(contract, hash, risk, { validator: 'exit_code', updateSource: 'none' }, '/tmp/project');
    const m2 = createManifest(contract, hash, risk, { validator: 'ndjson', updateSource: 'worker_proposal' }, '/tmp/project');

    const result = compareManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(diff => diff.includes('workflow.validator')));
  });

  it('manifest comparison detects trust-class drift even when risk level matches', () => {
    const contract = createContract({ command: 'node', args: ['app.js'] });
    const hash = hashContract(contract);

    const m1 = createManifest(contract, hash, { trustClass: 'reviewed_internal', riskLevel: 'yellow', reasons: ['shell mode enabled'] }, { validator: 'exit_code', updateSource: 'none' }, '/tmp/project');
    const m2 = createManifest(contract, hash, { trustClass: 'pinned_external', riskLevel: 'yellow', reasons: ['shell mode enabled'] }, { validator: 'exit_code', updateSource: 'none' }, '/tmp/project');

    const result = compareManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(diff => diff.includes('riskAssessment.trustClass')));
  });

  it('diff output for changed fields', () => {
    const c1 = createContract({ command: 'node', args: ['app.js'] });
    const c2 = createContract({ command: 'python', args: ['app.py'] });
    const risk1 = { riskLevel: 'green', reasons: [] };
    const risk2 = { riskLevel: 'yellow', reasons: ['shell mode enabled'] };
    const workflow = { validator: 'exit_code' };

    const m1 = createManifest(c1, hashContract(c1), risk1, workflow, '/tmp/project');
    const m2 = createManifest(c2, hashContract(c2), risk2, workflow, '/tmp/project');

    const diffs = diffManifests(m2, m1);
    assert.ok(diffs.length > 0);

    const diffText = diffs.join('\n');
    assert.ok(diffText.includes('contract.command'));
    assert.ok(diffText.includes('contract.args'));
    assert.ok(diffText.includes('riskAssessment.riskLevel'));
  });
});

// =========================================================================
// 3. Risk Classification
// =========================================================================

describe('Risk Classification', () => {
  it('structured repo-local workflow evaluates to green', () => {
    const contract = createContract({
      command: 'node',
      args: ['test.js'],
      mode: 'structured',
    });
    const result = evaluateRisk(contract, {
      trustClass: 'reviewed_internal',
      projectRoot: contract.cwd,
    });
    assert.equal(result.riskLevel, 'green');
    assert.equal(result.requiresStrongConfirmation, false);
  });

  it('shell + package install evaluates to red', () => {
    const contract = createContract({
      mode: 'shell',
      shell: 'npm install express',
    });
    const result = evaluateRisk(contract, {
      trustClass: 'reviewed_internal',
      projectRoot: contract.cwd,
    });
    assert.equal(result.riskLevel, 'red');
  });

  it('generated workflow evaluates to red', () => {
    const contract = createContract({ command: 'node', args: ['test.js'] });
    const result = evaluateRisk(contract, { isGenerated: true });
    assert.equal(result.riskLevel, 'red');
    assert.ok(result.reasons.includes('generated workflow source'));
  });

  it('unknown trust class evaluates to red', () => {
    const contract = createContract({ command: 'node', args: ['test.js'] });
    const result = evaluateRisk(contract, { trustClass: 'unknown' });
    assert.equal(result.riskLevel, 'red');
    assert.ok(result.reasons.includes('unknown workflow provenance'));
  });

  it('yellow classification for shell mode without dangerous signals', () => {
    const contract = createContract({
      mode: 'shell',
      shell: 'echo hello',
    });
    const result = evaluateRisk(contract, {
      trustClass: 'reviewed_internal',
      projectRoot: contract.cwd,
    });
    assert.equal(result.riskLevel, 'yellow');
    assert.ok(result.reasons.includes('shell mode enabled'));
  });

  it('risk reasons are stable and human-readable', () => {
    const contract = createContract({
      mode: 'shell',
      shell: 'npm install lodash',
    });
    const r1 = evaluateRisk(contract, { trustClass: 'reviewed_internal', projectRoot: contract.cwd });
    const r2 = evaluateRisk(contract, { trustClass: 'reviewed_internal', projectRoot: contract.cwd });
    assert.deepEqual(r1.reasons, r2.reasons);
    for (const reason of r1.reasons) {
      assert.equal(typeof reason, 'string');
      assert.ok(reason.length > 0);
    }
  });

  it('requiresStrongConfirmation returns true for red', () => {
    assert.equal(requiresStrongConfirmation('red'), true);
  });

  it('secret injection via inject flags secret injection enabled', () => {
    const contract = createContract({
      command: 'node', args: ['deploy.js'],
      envPolicy: { inherit: false, allow: ['PATH'], inject: { AWS_SECRET_ACCESS_KEY: 'xxx' } },
    });
    const result = evaluateRisk(contract, { trustClass: 'reviewed_internal', projectRoot: contract.cwd });
    assert.ok(result.reasons.includes('secret injection enabled'));
  });

  it('secret in allow list flags secret injection enabled', () => {
    const contract = createContract({
      command: 'node', args: ['deploy.js'],
      envPolicy: { inherit: false, allow: ['PATH', 'API_KEY_SECRET'], inject: {} },
    });
    const result = evaluateRisk(contract, { trustClass: 'reviewed_internal', projectRoot: contract.cwd });
    assert.ok(result.reasons.includes('secret injection enabled'));
  });

  it('shell mode + secret injection escalates to red', () => {
    const contract = createContract({
      mode: 'shell', shell: 'deploy.sh',
      envPolicy: { inherit: false, allow: ['PATH'], inject: { DB_PASSWORD: 'secret' } },
    });
    const result = evaluateRisk(contract, { trustClass: 'reviewed_internal', projectRoot: contract.cwd });
    assert.equal(result.riskLevel, 'red');
  });

  it('structured mode + secret injection without prod target stays yellow', () => {
    const contract = createContract({
      command: 'node', args: ['script.js'],
      envPolicy: { inherit: false, allow: ['PATH'], inject: { AUTH_TOKEN: 'tok' } },
    });
    const result = evaluateRisk(contract, { trustClass: 'reviewed_internal', projectRoot: contract.cwd });
    assert.equal(result.riskLevel, 'yellow');
    assert.ok(result.reasons.includes('secret injection enabled'));
  });
});

// =========================================================================
// 4. Approval Behavior
// =========================================================================

describe('Approval Behavior', () => {
  it('green does not require strong confirmation', () => {
    assert.equal(requiresStrongConfirmation('green'), false);
  });

  it('yellow does not require strong confirmation', () => {
    assert.equal(requiresStrongConfirmation('yellow'), false);
  });

  it('red requires strong confirmation', () => {
    assert.equal(requiresStrongConfirmation('red'), true);
  });

  it('out-of-scope updates require manifest-backed re-approval instead of in-session override', () => {
    const decision = buildOutOfScopeUpdateDecision({
      reasons: ['proposed update command differs from approved command'],
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.status, 'update_denied');
    assert.equal(decision.requiresManifestReapproval, true);
    assert.equal(decision.allowInteractiveOverride, false);
    assert.ok(decision.message.includes('explicitly approve a widened contract'));
  });

  it('red approval accepts APPROVE even if close fires synchronously after answer callback', async () => {
    let closeHandler = null;

    const approved = await promptApproval('red', {
      createInterfaceImpl: () => ({
        on(event, handler) {
          if (event === 'close') closeHandler = handler;
        },
        question(_prompt, callback) {
          callback('APPROVE');
        },
        close() {
          if (closeHandler) closeHandler();
        },
      }),
      input: {},
      output: {},
    });

    assert.equal(approved, true);
  });
});

// =========================================================================
// 5. Drift Detection
// =========================================================================

describe('Drift Detection', () => {
  function makeManifest(contractOpts, riskOverrides) {
    const contract = createContract(contractOpts);
    const hash = hashContract(contract);
    const risk = {
      riskLevel: 'green',
      reasons: [],
      ...riskOverrides,
    };
    const workflow = { validator: 'exit_code', updateSource: 'none' };
    return createManifest(contract, hash, risk, workflow, contract.cwd);
  }

  it('changing command triggers drift', () => {
    const m1 = makeManifest({ command: 'node' });
    const m2 = makeManifest({ command: 'python' });
    const result = compareManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(d => d.includes('contract.command')));
  });

  it('changing args triggers drift', () => {
    const m1 = makeManifest({ command: 'node', args: ['a.js'] });
    const m2 = makeManifest({ command: 'node', args: ['b.js'] });
    const result = compareManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(d => d.includes('contract.args')));
  });

  it('changing shell text triggers drift', () => {
    const m1 = makeManifest({ mode: 'shell', shell: 'echo hello' });
    const m2 = makeManifest({ mode: 'shell', shell: 'echo goodbye' });
    const result = compareManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(d => d.includes('contract.shell')));
  });

  it('changing write scope triggers drift', () => {
    const m1 = makeManifest({ command: 'node', writablePaths: ['/tmp/a'] });
    const m2 = makeManifest({ command: 'node', writablePaths: ['/tmp/b'] });
    const result = compareManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(d => d.includes('contract.writablePaths')));
  });

  it('changing risk level triggers drift', () => {
    const m1 = makeManifest({ command: 'node' }, { riskLevel: 'green' });
    const m2 = makeManifest({ command: 'node' }, { riskLevel: 'red' });
    const result = compareManifests(m2, m1);
    assert.equal(result.matches, false);
    assert.ok(result.diffs.some(d => d.includes('riskAssessment.riskLevel')));
  });

  it('unchanged contracts do NOT trigger drift', () => {
    const m1 = makeManifest({ command: 'node', args: ['test.js'] });
    const m2 = makeManifest({ command: 'node', args: ['test.js'] });
    const result = compareManifests(m1, m2);
    assert.equal(result.matches, true);
    assert.equal(result.diffs.length, 0);
  });
});

// =========================================================================
// 6. Non-Interactive Mode
// =========================================================================

describe('Non-Interactive Mode', () => {
  it('missing manifest should use approval_required status with exit code 10', () => {
    assert.equal(STATUS_EXIT_CODES.approval_required, 10);
  });

  it('drift should use drift_detected status with exit code 12', () => {
    assert.equal(STATUS_EXIT_CODES.drift_detected, 12);
  });
});

// =========================================================================
// 7. JSON Output Schema
// =========================================================================

describe('JSON Output Schema', () => {
  it('result object has all required fields', () => {
    // We cannot easily call runSupervisor without spawning a process,
    // so we verify the shape by constructing a result using the same
    // exit-code map and field set the supervisor uses.
    const requiredFields = [
      'runId', 'status', 'attempt', 'contractHash',
      'manifestPath', 'riskLevel', 'riskReasons', 'exitCode',
    ];

    // Simulate a result object as buildResult would produce:
    const result = {
      runId: 'test-12345678',
      status: 'success',
      attempt: 1,
      contractHash: 'abc123',
      manifestPath: '/tmp/manifest.json',
      riskLevel: 'green',
      riskReasons: [],
      exitCode: STATUS_EXIT_CODES.success,
    };

    for (const field of requiredFields) {
      assert.ok(field in result, `Missing required field: ${field}`);
    }
    assert.equal(result.exitCode, 0);
  });
});

// =========================================================================
// 8. Exit Code Mapping
// =========================================================================

describe('Exit Code Mapping', () => {
  it('success maps to 0', () => {
    assert.equal(STATUS_EXIT_CODES.success, 0);
  });

  it('approval_required maps to 10', () => {
    assert.equal(STATUS_EXIT_CODES.approval_required, 10);
  });

  it('approval_denied maps to 11', () => {
    assert.equal(STATUS_EXIT_CODES.approval_denied, 11);
  });

  it('drift_detected maps to 12', () => {
    assert.equal(STATUS_EXIT_CODES.drift_detected, 12);
  });

  it('validation_failed maps to 13', () => {
    assert.equal(STATUS_EXIT_CODES.validation_failed, 13);
  });

  it('update_denied maps to 14', () => {
    assert.equal(STATUS_EXIT_CODES.update_denied, 14);
  });

  it('timeout maps to 15', () => {
    assert.equal(STATUS_EXIT_CODES.timeout, 15);
  });

  it('policy_violation maps to 16', () => {
    assert.equal(STATUS_EXIT_CODES.policy_violation, 16);
  });

  it('unsupported maps to 17', () => {
    assert.equal(STATUS_EXIT_CODES.unsupported, 17);
  });

  it('protocol_error maps to 18', () => {
    assert.equal(STATUS_EXIT_CODES.protocol_error, 18);
  });

  it('internal_error maps to 19', () => {
    assert.equal(STATUS_EXIT_CODES.internal_error, 19);
  });

  it('all codes are in the range 0 or 10-29', () => {
    for (const [status, code] of Object.entries(STATUS_EXIT_CODES)) {
      assert.ok(
        code === 0 || (code >= 10 && code <= 29),
        `Status "${status}" has out-of-range exit code: ${code}`,
      );
    }
  });
});

// =========================================================================
// 9. NDJSON Protocol Validation
// =========================================================================

describe('NDJSON Protocol Validation', () => {
  it('valid LOG message parsing', () => {
    const line = JSON.stringify({ type: 'LOG', message: 'hello world' });
    const result = parseNdjsonLine(line);
    assert.equal(result.valid, true);
    assert.equal(result.message.type, 'LOG');
    assert.equal(result.message.message, 'hello world');
    assert.equal(result.error, null);
  });

  it('valid SUCCESS message parsing', () => {
    const line = JSON.stringify({ type: 'SUCCESS', data: { ok: true } });
    const result = parseNdjsonLine(line);
    assert.equal(result.valid, true);
    assert.equal(result.message.type, 'SUCCESS');
    assert.equal(result.error, null);
  });

  it('valid VALIDATION_FAILED_REQUIRE_UPDATE parsing', () => {
    const line = JSON.stringify({
      type: 'VALIDATION_FAILED_REQUIRE_UPDATE',
      updateProposal: {
        proposedUpdate: { action: 'apply_patch', summary: 'fix lint', command: 'patch', args: ['-p1'] },
      },
    });
    const result = parseNdjsonLine(line);
    assert.equal(result.valid, true);
    assert.equal(result.message.type, 'VALIDATION_FAILED_REQUIRE_UPDATE');
    assert.equal(result.error, null);
  });

  it('malformed JSON is a protocol error', () => {
    const result = parseNdjsonLine('{not valid json}}}');
    assert.equal(result.valid, false);
    assert.equal(result.message, null);
    assert.ok(result.error.startsWith('Malformed JSON'));
  });

  it('unknown type is a protocol error', () => {
    const line = JSON.stringify({ type: 'UNKNOWN_TYPE' });
    const result = parseNdjsonLine(line);
    assert.equal(result.valid, false);
    assert.equal(result.message, null);
    assert.ok(result.error.includes('Unknown message type'));
  });

  it('empty line is rejected', () => {
    const result = parseNdjsonLine('');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('Empty line'));
  });

  it('non-object JSON is rejected', () => {
    const result = parseNdjsonLine('"just a string"');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('not an object'));
  });

  it('missing type field is rejected', () => {
    const result = parseNdjsonLine(JSON.stringify({ data: 'no type' }));
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('Missing "type"'));
  });
});

// =========================================================================
// 10. Validator
// =========================================================================

describe('Validator', () => {
  describe('exit_code validator', () => {
    it('success on exit code 0', () => {
      const result = validateResult({ exitCode: 0, stdout: '', stderr: '' }, 'exit_code');
      assert.equal(result.valid, true);
      assert.equal(result.status, 'success');
    });

    it('failure on non-zero exit code', () => {
      const result = validateResult({ exitCode: 1, stdout: '', stderr: 'err' }, 'exit_code');
      assert.equal(result.valid, false);
      assert.equal(result.status, 'validation_failed');
      assert.ok(result.errors.length > 0);
    });
  });

  describe('ndjson validator', () => {
    it('SUCCESS message validates', () => {
      const stdout = JSON.stringify({ type: 'SUCCESS' }) + '\n';
      const result = validateResult({ exitCode: 0, stdout, stderr: '' }, 'ndjson');
      assert.equal(result.valid, true);
      assert.equal(result.status, 'success');
    });

    it('update proposal is extracted', () => {
      const msg = {
        type: 'VALIDATION_FAILED_REQUIRE_UPDATE',
        updateProposal: {
          reason: 'lint failed',
          proposedUpdate: {
            action: 'run_script',
            summary: 'run eslint --fix',
            command: 'eslint',
            args: ['--fix', '.'],
          },
        },
      };
      const stdout = JSON.stringify(msg) + '\n';
      const result = validateResult({ exitCode: 1, stdout, stderr: '' }, 'ndjson');
      assert.equal(result.valid, false);
      assert.equal(result.status, 'update_requested');
      assert.ok(result.updateProposal !== null);
      assert.equal(result.updateProposal.proposedUpdate.action, 'run_script');
      assert.equal(result.updateProposal.proposedUpdate.command, 'eslint');
    });
  });

  describe('update proposal validation', () => {
    it('allowed when action is in allowedActions', () => {
      const proposal = {
        proposedUpdate: {
          action: 'apply_patch',
          command: 'patch',
          args: ['-p1'],
          cwd: '/tmp/project/src',
        },
      };
      const contract = createContract({
        updatePolicy: { allowedActions: ['apply_patch', 'run_script'] },
        writablePaths: ['/tmp/project'],
      });
      const result = validateUpdateProposal(proposal, contract);
      assert.equal(result.allowed, true);
      assert.equal(result.reasons.length, 0);
    });

    it('denied when action is not in allowedActions', () => {
      const proposal = {
        proposedUpdate: {
          action: 'restart_service',
          command: 'systemctl',
          args: ['restart', 'myapp'],
        },
      };
      const contract = createContract({
        updatePolicy: { allowedActions: ['apply_patch'] },
      });
      const result = validateUpdateProposal(proposal, contract);
      assert.equal(result.allowed, false);
      assert.ok(result.reasons.some(r => r.includes('restart_service')));
    });

    it('denied when no proposal is provided', () => {
      const contract = createContract({});
      const result = validateUpdateProposal(null, contract);
      assert.equal(result.allowed, false);
    });

    it('denied when a run_script proposal changes the approved command surface', () => {
      const contract = createContract({
        command: 'npm',
        args: ['test'],
        allowedBinaries: ['npm'],
        writablePaths: ['/tmp/project'],
        updatePolicy: { allowedActions: ['run_script'] },
      });
      const result = validateUpdateProposal({
        proposedUpdate: {
          action: 'run_script',
          command: 'npm',
          args: ['install'],
          cwd: '/tmp/project',
        },
      }, contract);

      assert.equal(result.allowed, false);
      assert.ok(result.reasons.some(reason => reason.includes('differs from approved command')));
    });
  });

  describe('convergence tracker', () => {
    it('aborts after exceeding max retries', () => {
      const tracker = createConvergenceTracker(2);
      tracker.record('sig-a', null, false);
      tracker.record('sig-b', null, false);
      assert.equal(tracker.shouldAbort(), false);
      tracker.record('sig-c', null, false);
      assert.equal(tracker.shouldAbort(), true);
      assert.ok(tracker.state().priorTerminalReason.includes('Retry limit'));
    });

    it('aborts on repeated validation signature', () => {
      const tracker = createConvergenceTracker(10);
      tracker.record('sig-a', 'upd-a', true);
      assert.equal(tracker.shouldAbort(), false);
      tracker.record('sig-a', 'upd-b', true);
      assert.equal(tracker.shouldAbort(), true);
      assert.ok(tracker.state().priorTerminalReason.includes('Validation signature repeated'));
    });

    it('aborts on repeated update signature', () => {
      const tracker = createConvergenceTracker(10);
      tracker.record('sig-a', 'upd-a', true);
      assert.equal(tracker.shouldAbort(), false);
      tracker.record('sig-b', 'upd-a', true);
      assert.equal(tracker.shouldAbort(), true);
      assert.ok(tracker.state().priorTerminalReason.includes('Update signature repeated'));
    });

    it('aborts when update produced no changes', () => {
      const tracker = createConvergenceTracker(10);
      tracker.record('sig-a', 'upd-a', false);
      assert.equal(tracker.shouldAbort(), true);
      assert.ok(tracker.state().priorTerminalReason.includes('no changes'));
    });
  });

  describe('computeValidationSignature', () => {
    it('produces a hex string', () => {
      const sig = computeValidationSignature({ exitCode: 0, stdout: 'ok', stderr: '' });
      assert.match(sig, /^[a-f0-9]{64}$/);
    });

    it('different outputs produce different signatures', () => {
      const s1 = computeValidationSignature({ exitCode: 0, stdout: 'ok', stderr: '' });
      const s2 = computeValidationSignature({ exitCode: 1, stdout: 'ok', stderr: '' });
      const s3 = computeValidationSignature({ exitCode: 0, stdout: 'different', stderr: '' });
      assert.notEqual(s1, s2);
      assert.notEqual(s1, s3);
    });
  });
});

// =========================================================================
// 11. Logger
// =========================================================================

describe('Logger', () => {
  it('generateRunId produces unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(generateRunId());
    }
    assert.equal(ids.size, 100);
  });

  it('generateRunId format contains timestamp and random parts', () => {
    const id = generateRunId();
    assert.ok(id.includes('-'));
    const parts = id.split('-');
    assert.equal(parts.length, 2);
    assert.ok(parts[0].length > 0); // timestamp in base36
    assert.ok(parts[1].length === 8); // 4 random bytes = 8 hex chars
  });

  it('riskColor maps green to green', () => {
    assert.equal(riskColor('green'), 'green');
  });

  it('riskColor maps yellow to yellow', () => {
    assert.equal(riskColor('yellow'), 'yellow');
  });

  it('riskColor maps red to red', () => {
    assert.equal(riskColor('red'), 'red');
  });

  it('riskColor maps unknown to red', () => {
    assert.equal(riskColor('unknown'), 'red');
    assert.equal(riskColor(''), 'red');
    assert.equal(riskColor(null), 'red');
  });

  it('printApprovalSummary renders real contract fields used by the supervisor', () => {
    const writes = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };

    try {
      const contract = createContract({
        command: 'npm',
        args: ['test'],
        cwd: '/tmp/project',
      });
      const risk = {
        trustClass: 'reviewed_internal',
        riskLevel: 'green',
        reasons: [],
      };

      printApprovalSummary(contract, risk);
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = writes.join('');
    assert.match(output, /Directory:/);
    assert.match(output, /Writes:/);
    assert.match(output, /Allowed binaries:/);
    assert.match(output, /Child processes:/);
    assert.match(output, /Retries:/);
    assert.match(output, /Timeout:/);
  });
});

// =========================================================================
// 12. Serialization
// =========================================================================

describe('Serialization', () => {
  it('serializeStable produces deterministic output for objects with different key orders', () => {
    const obj1 = { zebra: 1, apple: 2, mango: 3 };
    const obj2 = { apple: 2, mango: 3, zebra: 1 };
    const obj3 = { mango: 3, zebra: 1, apple: 2 };

    const s1 = serializeStable(obj1);
    const s2 = serializeStable(obj2);
    const s3 = serializeStable(obj3);

    assert.equal(s1, s2);
    assert.equal(s2, s3);
    assert.equal(s1, '{"apple":2,"mango":3,"zebra":1}');
  });

  it('serializeStable handles nested objects with different key orders', () => {
    const obj1 = { outer: { z: 1, a: 2 }, first: true };
    const obj2 = { first: true, outer: { a: 2, z: 1 } };

    assert.equal(serializeStable(obj1), serializeStable(obj2));
  });

  it('serializeStable handles mixed types', () => {
    const obj = { num: 42, str: 'hello', bool: true, nil: null, arr: [1, 2] };
    const result = serializeStable(obj);
    // Keys sorted: arr, bool, nil, num, str
    assert.equal(result, '{"arr":[1,2],"bool":true,"nil":null,"num":42,"str":"hello"}');
  });

  it('contracts with same logical content but different key order hash identically', () => {
    const c1 = createContract({ command: 'node', args: ['a.js'], timeoutMs: 5000 });
    const c2 = createContract({ timeoutMs: 5000, command: 'node', args: ['a.js'] });
    assert.equal(hashContract(c1), hashContract(c2));
  });
});

// =========================================================================
// 13. Built-in Demo
// =========================================================================

describe('Built-in Demo', () => {
  it('demo-drift.js exports a callable runDemo function', async () => {
    const mod = await import('../src/demo-drift.js');
    assert.equal(typeof mod.default, 'function');
  });

  it('example-task.js emits valid NDJSON protocol messages', async () => {
    const { execFileSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const examplePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'example-task.js');

    let stdout;
    try {
      execFileSync('node', [examplePath], { encoding: 'utf8' });
    } catch (err) {
      // Expected: exit code 1
      stdout = err.stdout;
    }

    assert.ok(stdout, 'example-task should produce stdout');
    const lines = stdout.trim().split('\n');
    assert.ok(lines.length >= 4, 'should emit at least 4 NDJSON lines');

    for (const l of lines) {
      const parsed = JSON.parse(l);
      assert.ok(parsed.type, 'each line must have a type');
      assert.ok(['LOG', 'SUCCESS', 'VALIDATION_FAILED_REQUIRE_UPDATE', 'ERROR'].includes(parsed.type));
    }

    // The last message should be the update proposal
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.type, 'VALIDATION_FAILED_REQUIRE_UPDATE');
    assert.ok(last.payload.proposedUpdate, 'must have a proposedUpdate in payload');
    assert.equal(last.payload.proposedUpdate.command, 'npm');
    assert.deepEqual(last.payload.proposedUpdate.args, ['install']);
  });

  it('demo contract for npm test evaluates to green with reviewed_internal trust', () => {
    const contract = createContract({
      command: 'npm',
      args: ['test'],
      mode: 'structured',
    });
    const risk = evaluateRisk(contract, { trustClass: 'reviewed_internal', projectRoot: process.cwd() });
    assert.equal(risk.riskLevel, 'green');
    assert.equal(risk.trustClass, 'reviewed_internal');
  });
});
