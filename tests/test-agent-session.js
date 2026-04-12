import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildSessionContract,
  hashSessionContract,
  diffSessionContracts,
  compareSessionContracts,
  defaultSessionContractPath,
  sanitizeSessionSlot,
  loadSessionContract,
  saveSessionContract,
  revokeSessionContract,
  isSessionRevoked,
} from '../src/agent-session.js';
import { evaluateSessionLifecycle } from '../src/agent-session-lifecycle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'gr-session-'));
}

function baseInput(overrides = {}) {
  return {
    tool: 'claude',
    recipeId: 'claude-exec',
    recipeVersion: '1.0.0',
    workingDir: '/repo',
    addDirs: ['/repo/src', '/repo/tests'],
    sessionName: 'work',
    sessionId: null,
    lifecycle: 'start',
    ...overrides,
  };
}

// ===========================================================================
// 1. Build + hash stability
// ===========================================================================

describe('Agent Session: buildSessionContract', () => {
  it('produces a stable canonical hash regardless of addDirs ordering', () => {
    const a = buildSessionContract(baseInput({ addDirs: ['/repo/a', '/repo/b', '/repo/c'] }));
    const b = buildSessionContract(baseInput({ addDirs: ['/repo/c', '/repo/a', '/repo/b'] }));
    assert.equal(a.contractHash, b.contractHash);
    assert.deepEqual(a.scope.addDirs, b.scope.addDirs);
  });

  it('requires a valid tool', () => {
    assert.throws(
      () => buildSessionContract(baseInput({ tool: 'bash' })),
      /tool must be one of/,
    );
  });

  it('requires a valid lifecycle', () => {
    assert.throws(
      () => buildSessionContract(baseInput({ lifecycle: 'revive' })),
      /lifecycle must be one of/,
    );
  });

  it('resolves relative addDirs against workingDir before hashing', () => {
    const c = buildSessionContract(baseInput({ workingDir: '/repo', addDirs: ['./src', './tests'] }));
    assert.ok(c.scope.addDirs.every(d => d.startsWith('/repo')));
  });

  it('stores sessionName and sessionId or null', () => {
    const c = buildSessionContract(baseInput({ sessionName: null, sessionId: 'abc123' }));
    assert.equal(c.sessionName, null);
    assert.equal(c.sessionId, 'abc123');
  });
});

describe('Agent Session: hashSessionContract', () => {
  it('is deterministic', () => {
    const c = buildSessionContract(baseInput());
    const h1 = hashSessionContract(c);
    const h2 = hashSessionContract(c);
    assert.equal(h1, h2);
    assert.equal(h1, c.contractHash);
  });

  it('excludes contractHash, createdAt and updatedAt from the hash', () => {
    const c = buildSessionContract(baseInput());
    const mutated = {
      ...c,
      contractHash: 'zzz',
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2030-01-01T00:00:00Z',
    };
    assert.equal(hashSessionContract(mutated), c.contractHash);
  });

  it('changes when an identity field changes', () => {
    const c = buildSessionContract(baseInput());
    const other = buildSessionContract(baseInput({ workingDir: '/other' }));
    assert.notEqual(c.contractHash, other.contractHash);
  });
});

// ===========================================================================
// 2. diffSessionContracts / compareSessionContracts
// ===========================================================================

describe('Agent Session: compareSessionContracts', () => {
  it('ignores createdAt/updatedAt/contractHash differences', () => {
    const c1 = buildSessionContract(baseInput());
    const c2 = {
      ...c1,
      contractHash: 'different',
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2030-01-01T00:00:00Z',
    };
    const { matches, diffs } = compareSessionContracts(c1, c2);
    assert.equal(matches, true);
    assert.deepEqual(diffs, []);
  });

  it('reports identity field drift via diff strings', () => {
    const a = buildSessionContract(baseInput());
    const b = buildSessionContract(baseInput({ workingDir: '/other-repo' }));
    const { matches, diffs } = compareSessionContracts(a, b);
    assert.equal(matches, false);
    assert.ok(diffs.some(d => d.includes('workingDir')));
  });

  it('diffSessionContracts returns empty for equivalent contracts', () => {
    const a = buildSessionContract(baseInput());
    const b = buildSessionContract(baseInput());
    assert.deepEqual(diffSessionContracts(a, b), []);
  });
});

// ===========================================================================
// 3. evaluateSessionLifecycle — start
// ===========================================================================

describe('Agent Session: evaluateSessionLifecycle — start', () => {
  it('ok when no approved contract exists', () => {
    const candidate = buildSessionContract(baseInput({ lifecycle: 'start' }));
    const result = evaluateSessionLifecycle(candidate, null, 'start');
    assert.equal(result.ok, true);
  });

  it('ok on idempotent re-start (candidate matches approved exactly)', () => {
    const candidate = buildSessionContract(baseInput({ lifecycle: 'start' }));
    const result = evaluateSessionLifecycle(candidate, candidate, 'start');
    assert.equal(result.ok, true);
  });

  it('blocks with session_already_exists when approved contract differs', () => {
    const approved = buildSessionContract(baseInput({ lifecycle: 'start' }));
    const candidate = buildSessionContract(baseInput({
      lifecycle: 'start',
      workingDir: '/other-repo',
    }));
    const result = evaluateSessionLifecycle(candidate, approved, 'start');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'session_already_exists');
    assert.ok(Array.isArray(result.diffs));
  });
});

// ===========================================================================
// 4. evaluateSessionLifecycle — continue
// ===========================================================================

describe('Agent Session: evaluateSessionLifecycle — continue', () => {
  it('blocks with session_missing when no approved contract exists', () => {
    const candidate = buildSessionContract(baseInput({ lifecycle: 'continue' }));
    const result = evaluateSessionLifecycle(candidate, null, 'continue');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'session_missing');
  });

  it('ok when approved contract matches all identity fields', () => {
    const approved = buildSessionContract(baseInput({ lifecycle: 'start' }));
    const candidate = buildSessionContract(baseInput({ lifecycle: 'continue' }));
    const result = evaluateSessionLifecycle(candidate, approved, 'continue');
    assert.equal(result.ok, true);
  });

  it('blocks with session_drift when workingDir differs', () => {
    const approved = buildSessionContract(baseInput({ lifecycle: 'start' }));
    const candidate = buildSessionContract(baseInput({
      lifecycle: 'continue',
      workingDir: '/other-repo',
    }));
    const result = evaluateSessionLifecycle(candidate, approved, 'continue');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'session_drift');
    assert.ok(result.diffs.some(d => d.includes('workingDir')));
  });

  it('blocks with session_drift on sessionId mismatch', () => {
    const approved = buildSessionContract(baseInput({ lifecycle: 'start', sessionId: 'abc' }));
    const candidate = buildSessionContract(baseInput({ lifecycle: 'continue', sessionId: 'xyz' }));
    const result = evaluateSessionLifecycle(candidate, approved, 'continue');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'session_drift');
  });
});

// ===========================================================================
// 5. evaluateSessionLifecycle — attach
// ===========================================================================

describe('Agent Session: evaluateSessionLifecycle — attach', () => {
  it('blocks with session_attach_mismatch when sessionName is missing', () => {
    const candidate = buildSessionContract(baseInput({ lifecycle: 'attach', sessionName: null }));
    const approved = buildSessionContract(baseInput({ lifecycle: 'start', sessionName: 'anything' }));
    const result = evaluateSessionLifecycle(candidate, approved, 'attach');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'session_attach_mismatch');
  });

  it('blocks with session_attach_mismatch when sessionName differs', () => {
    const approved = buildSessionContract(baseInput({ lifecycle: 'start', sessionName: 'alpha' }));
    const candidate = buildSessionContract(baseInput({ lifecycle: 'attach', sessionName: 'beta' }));
    const result = evaluateSessionLifecycle(candidate, approved, 'attach');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'session_attach_mismatch');
  });

  it('blocks with session_missing when no approved contract exists', () => {
    const candidate = buildSessionContract(baseInput({ lifecycle: 'attach', sessionName: 'alpha' }));
    const result = evaluateSessionLifecycle(candidate, null, 'attach');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'session_missing');
  });

  it('ok when name matches and identity is equivalent', () => {
    const approved = buildSessionContract(baseInput({ lifecycle: 'start', sessionName: 'alpha' }));
    const candidate = buildSessionContract(baseInput({ lifecycle: 'attach', sessionName: 'alpha' }));
    const result = evaluateSessionLifecycle(candidate, approved, 'attach');
    assert.equal(result.ok, true);
  });
});

// ===========================================================================
// 6. sanitizeSessionSlot
// ===========================================================================

describe('Agent Session: sanitizeSessionSlot', () => {
  it('accepts alphanumerics, dashes and underscores', () => {
    assert.equal(sanitizeSessionSlot('work_session-1'), 'work_session-1');
  });

  it('falls back to "default" on null/undefined/empty', () => {
    assert.equal(sanitizeSessionSlot(null), 'default');
    assert.equal(sanitizeSessionSlot(undefined), 'default');
    assert.equal(sanitizeSessionSlot(''), 'default');
    assert.equal(sanitizeSessionSlot('   '), 'default');
  });

  it('rejects shell metacharacters and path separators', () => {
    assert.equal(sanitizeSessionSlot('evil; rm -rf /'), 'default');
    assert.equal(sanitizeSessionSlot('a/b'), 'default');
    assert.equal(sanitizeSessionSlot('../escape'), 'default');
    assert.equal(sanitizeSessionSlot('$(ls)'), 'default');
    assert.equal(sanitizeSessionSlot('a`b'), 'default');
  });

  it('rejects names longer than 64 chars', () => {
    assert.equal(sanitizeSessionSlot('a'.repeat(65)), 'default');
  });
});

// ===========================================================================
// 7. defaultSessionContractPath
// ===========================================================================

describe('Agent Session: defaultSessionContractPath', () => {
  it('builds agent-sessions/<recipeId>/<slot>.json under stateDir', () => {
    const path = defaultSessionContractPath('/repo/.guardrail', 'claude-exec', 'work');
    assert.equal(path, resolve('/repo/.guardrail/agent-sessions/claude-exec/work.json'));
  });

  it('sanitizes the slot name', () => {
    const path = defaultSessionContractPath('/repo/.guardrail', 'claude-exec', 'a/b');
    assert.ok(path.endsWith('agent-sessions/claude-exec/default.json'));
  });

  it('rejects empty recipeId and stateDir', () => {
    assert.throws(() => defaultSessionContractPath('', 'claude-exec', 'work'));
    assert.throws(() => defaultSessionContractPath('/repo/.guardrail', '', 'work'));
  });
});

// ===========================================================================
// 8. save + load round-trip
// ===========================================================================

describe('Agent Session: save + load round-trip', () => {
  it('persists and re-reads an identical contract', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'agent-sessions/claude-exec/work.json');
    const candidate = buildSessionContract(baseInput({ workingDir: dir }));

    const stored = saveSessionContract(candidate, filePath);
    assert.ok(existsSync(filePath));
    assert.equal(typeof stored.createdAt, 'string');
    assert.equal(typeof stored.updatedAt, 'string');

    const loaded = loadSessionContract(filePath);
    assert.equal(loaded.tool, 'claude');
    assert.equal(loaded.recipeId, 'claude-exec');
    assert.equal(loaded.contractHash, candidate.contractHash);
    assert.equal(loaded.kind, 'agent_session_contract');
  });

  it('preserves createdAt across repeat saves', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'agent-sessions/claude-exec/work.json');
    const candidate = buildSessionContract(baseInput({ workingDir: dir }));

    const first = saveSessionContract(candidate, filePath);
    const again = saveSessionContract(candidate, filePath);
    assert.equal(first.createdAt, again.createdAt);
  });

  it('loadSessionContract returns null when file is absent', () => {
    const dir = tmpDir();
    const path = join(dir, 'missing.json');
    assert.equal(loadSessionContract(path), null);
  });

  it('loadSessionContract throws on corrupt JSON', () => {
    const dir = tmpDir();
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{ not valid', 'utf8');
    assert.throws(() => loadSessionContract(path), /Corrupt agent session contract/);
  });

  it('loadSessionContract throws when kind is wrong', () => {
    const dir = tmpDir();
    const path = join(dir, 'wrong-kind.json');
    writeFileSync(path, JSON.stringify({ kind: 'not_a_session' }), 'utf8');
    assert.throws(() => loadSessionContract(path), /Corrupt agent session contract/);
  });
});

// ===========================================================================
// 9. Session revocation (P0h emergency controls)
// ===========================================================================

describe('Agent Session: revokeSessionContract', () => {
  it('stamps status=revoked, revokedAt, revokedBy, revocationReason', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'agent-sessions/claude-exec/work.json');
    const candidate = buildSessionContract(baseInput({ workingDir: dir }));
    saveSessionContract(candidate, filePath);

    const revoked = revokeSessionContract(filePath, { actor: 'admin', reason: 'policy breach' });
    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.revokedBy, 'admin');
    assert.equal(revoked.revocationReason, 'policy breach');
    assert.ok(typeof revoked.revokedAt === 'string');
  });

  it('persists revocation to disk', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'agent-sessions/claude-exec/work.json');
    const candidate = buildSessionContract(baseInput({ workingDir: dir }));
    saveSessionContract(candidate, filePath);
    revokeSessionContract(filePath, { actor: 'test' });

    const loaded = loadSessionContract(filePath);
    assert.equal(loaded.status, 'revoked');
    assert.equal(loaded.revokedBy, 'test');
  });

  it('is idempotent — revoking an already-revoked contract returns it unchanged', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'agent-sessions/claude-exec/work.json');
    const candidate = buildSessionContract(baseInput({ workingDir: dir }));
    saveSessionContract(candidate, filePath);
    const first = revokeSessionContract(filePath, { actor: 'a' });
    const second = revokeSessionContract(filePath, { actor: 'b' });
    assert.equal(second.revokedBy, 'a');
    assert.equal(second.revokedAt, first.revokedAt);
  });

  it('throws when no contract exists — cannot revoke unknown state', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'agent-sessions/claude-exec/nonexistent.json');
    assert.throws(
      () => revokeSessionContract(filePath, { actor: 'test' }),
      /cannot revoke unknown state/,
    );
  });
});

describe('Agent Session: isSessionRevoked', () => {
  it('returns true for status=revoked contract', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'agent-sessions/claude-exec/work.json');
    const candidate = buildSessionContract(baseInput({ workingDir: dir }));
    saveSessionContract(candidate, filePath);
    revokeSessionContract(filePath, { actor: 'test' });
    const loaded = loadSessionContract(filePath);
    assert.equal(isSessionRevoked(loaded), true);
  });

  it('returns false for a normal (non-revoked) contract', () => {
    const candidate = buildSessionContract(baseInput());
    assert.equal(isSessionRevoked(candidate), false);
  });

  it('returns false for null/undefined', () => {
    assert.equal(isSessionRevoked(null), false);
    assert.equal(isSessionRevoked(undefined), false);
  });
});

describe('Agent Session: evaluateSessionLifecycle — revoked contract blocks all ops', () => {
  it('blocks start with session_revoked when approved is revoked', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'agent-sessions/claude-exec/work.json');
    const candidate = buildSessionContract(baseInput({ lifecycle: 'start', workingDir: dir }));
    saveSessionContract(candidate, filePath);
    const approved = revokeSessionContract(filePath, { actor: 'admin', reason: 'test' });
    const result = evaluateSessionLifecycle(candidate, approved, 'start');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'session_revoked');
    assert.ok(result.reason.includes('revoked'));
  });

  it('blocks continue with session_revoked', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'agent-sessions/claude-exec/work.json');
    const base = buildSessionContract(baseInput({ lifecycle: 'start', workingDir: dir }));
    saveSessionContract(base, filePath);
    const approved = revokeSessionContract(filePath, { actor: 'admin' });
    const candidate = buildSessionContract(baseInput({ lifecycle: 'continue', workingDir: dir }));
    const result = evaluateSessionLifecycle(candidate, approved, 'continue');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'session_revoked');
  });

  it('blocks attach with session_revoked', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'agent-sessions/claude-exec/work.json');
    const base = buildSessionContract(baseInput({ lifecycle: 'start', sessionName: 'alpha', workingDir: dir }));
    saveSessionContract(base, filePath);
    const approved = revokeSessionContract(filePath, { actor: 'admin' });
    const candidate = buildSessionContract(baseInput({ lifecycle: 'attach', sessionName: 'alpha', workingDir: dir }));
    const result = evaluateSessionLifecycle(candidate, approved, 'attach');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'session_revoked');
  });

  it('session_revoked code is distinct from session_missing and session_drift', () => {
    const candidate = buildSessionContract(baseInput({ lifecycle: 'start' }));
    const fakeRevoked = { ...candidate, status: 'revoked', revokedAt: new Date().toISOString(), revokedBy: 'ops' };
    const result = evaluateSessionLifecycle(candidate, fakeRevoked, 'start');
    assert.equal(result.code, 'session_revoked');
    assert.notEqual(result.code, 'session_missing');
    assert.notEqual(result.code, 'session_drift');
  });
});
