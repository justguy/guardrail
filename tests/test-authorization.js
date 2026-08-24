/**
 * test-authorization.js — Focused unit tests for the universal authorization seam.
 *
 * Covers:
 * - Normalized result shape (allowed and denied paths)
 * - command.run: skip when no limits, time-policy deny, concurrent-lock deny
 * - recipe.auth: preflight ok/fail, session enforcement pass/block
 * - workflow.recipe_step: preflight ok/fail, no session check
 * - adapter.run: no profile (skip), env mapping fail, env+auth pass, auth prereq fail
 * - Unknown action: fail-closed
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { authorize, ACTIONS, AUTH_CODES } from '../src/authorization.js';

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-auth-')));
}

// ---------------------------------------------------------------------------
// Normalized result shape
// ---------------------------------------------------------------------------

describe('Authorization seam: result shape', () => {
  it('allowed result has all expected fields', async () => {
    const stateDir = tmpDir();
    const result = await authorize(ACTIONS.COMMAND_RUN, {
      runtimeLimits: null,
      manifestHash: 'shape-allow',
      stateDir,
    });
    assert.ok(result.allowed === true);
    assert.equal(result.decision, 'allow');
    assert.equal(result.code, null);
    assert.equal(result.reason, null);
    assert.ok(result.trace !== null && typeof result.trace === 'object');
    assert.equal(result.trace.action, ACTIONS.COMMAND_RUN);
    assert.ok(Array.isArray(result.trace.checks));
    assert.ok(typeof result.trace.timestamp === 'string');
    // Lock was acquired — release is a function
    assert.ok(typeof result.release === 'function');
    result.release();
  });

  it('denied result has all expected fields with null release', async () => {
    const result = await authorize(ACTIONS.COMMAND_RUN, {
      runtimeLimits: { maxRuns: 0 },
      manifestHash: 'shape-deny',
      stateDir: tmpDir(),
    });
    assert.ok(result.allowed === false);
    assert.equal(result.decision, 'deny');
    assert.ok(typeof result.code === 'string');
    assert.ok(typeof result.reason === 'string');
    assert.ok(result.trace !== null && typeof result.trace === 'object');
    assert.ok(Array.isArray(result.trace.checks));
    assert.equal(result.release, null);
    assert.equal(result.envIntersection, null);
  });

  it('trace sanitizes authCheckFn from facts', async () => {
    const result = await authorize(ACTIONS.ADAPTER_RUN, {
      authCheckFn: () => {},
    });
    // authCheckFn must not appear in trace.facts
    assert.ok(!('authCheckFn' in result.trace.facts));
  });
});

// ---------------------------------------------------------------------------
// command.run
// ---------------------------------------------------------------------------

describe('Authorization seam: command.run', () => {
  it('allows when no runtimeLimits — time_policy check skipped', async () => {
    const stateDir = tmpDir();
    const result = await authorize(ACTIONS.COMMAND_RUN, {
      runtimeLimits: null,
      manifestHash: 'cmd-no-limits',
      stateDir,
    });
    assert.ok(result.allowed);
    const timeCheck = result.trace.checks.find(c => c.name === 'time_policy');
    assert.equal(timeCheck.result, 'skip');
    const lockCheck = result.trace.checks.find(c => c.name === 'concurrency_lock');
    assert.equal(lockCheck.result, 'pass');
    assert.ok(typeof result.release === 'function');
    result.release();
  });

  it('denies when maxRuns exhausted', async () => {
    const result = await authorize(ACTIONS.COMMAND_RUN, {
      runtimeLimits: { maxRuns: 0 },
      manifestHash: 'cmd-runs-zero',
      stateDir: tmpDir(),
    });
    assert.ok(!result.allowed);
    assert.equal(result.code, AUTH_CODES.TIME_POLICY_VIOLATED);
    assert.ok(result.reason.startsWith('Time policy violated:'));
    const timeCheck = result.trace.checks.find(c => c.name === 'time_policy');
    assert.equal(timeCheck.result, 'deny');
  });

  it('denies concurrent execution when lock already held', async () => {
    const stateDir = tmpDir();
    const hash = 'cmd-concurrent';
    const first = await authorize(ACTIONS.COMMAND_RUN, {
      runtimeLimits: null,
      manifestHash: hash,
      stateDir,
    });
    assert.ok(first.allowed, 'first lock acquisition should succeed');

    const second = await authorize(ACTIONS.COMMAND_RUN, {
      runtimeLimits: null,
      manifestHash: hash,
      stateDir,
    });
    assert.ok(!second.allowed, 'second attempt should be blocked');
    assert.equal(second.code, AUTH_CODES.CONCURRENT_BLOCKED);
    assert.ok(second.reason.includes('Concurrent execution blocked'));

    first.release();
  });

  it('release function cleans up lock so next attempt succeeds', async () => {
    const stateDir = tmpDir();
    const hash = 'cmd-release';
    const first = await authorize(ACTIONS.COMMAND_RUN, { runtimeLimits: null, manifestHash: hash, stateDir });
    assert.ok(first.allowed);
    first.release();

    const second = await authorize(ACTIONS.COMMAND_RUN, { runtimeLimits: null, manifestHash: hash, stateDir });
    assert.ok(second.allowed);
    second.release();
  });
});

// ---------------------------------------------------------------------------
// lane.start
// ---------------------------------------------------------------------------

describe('Authorization seam: lane.start', () => {
  it('allows when startup locks are free and returns a release function', async () => {
    const stateDir = tmpDir();
    const result = await authorize(ACTIONS.LANE_START, {
      startupLocks: [
        {
          key: 'lane-local',
          stateDir,
          ttlMs: 15_000,
          checkName: 'lane_local_startup_lock',
          failureMessage: 'local lane start blocked',
        },
      ],
    });
    assert.ok(result.allowed);
    assert.equal(typeof result.release, 'function');
    const lockCheck = result.trace.checks.find(c => c.name === 'lane_local_startup_lock');
    assert.equal(lockCheck.result, 'pass');
    result.release();
  });

  it('denies when a startup lock is already held', async () => {
    const stateDir = tmpDir();
    const first = await authorize(ACTIONS.LANE_START, {
      startupLocks: [
        {
          key: 'lane-global',
          stateDir,
          ttlMs: 15_000,
          checkName: 'lane_global_startup_lock',
          failureMessage: 'global lane start blocked',
        },
      ],
    });
    assert.ok(first.allowed);

    const second = await authorize(ACTIONS.LANE_START, {
      startupLocks: [
        {
          key: 'lane-global',
          stateDir,
          ttlMs: 15_000,
          checkName: 'lane_global_startup_lock',
          failureMessage: 'global lane start blocked',
        },
      ],
    });
    assert.ok(!second.allowed);
    assert.equal(second.code, AUTH_CODES.CONCURRENT_BLOCKED);
    assert.equal(second.reason, 'global lane start blocked');
    const lockCheck = second.trace.checks.find(c => c.name === 'lane_global_startup_lock');
    assert.equal(lockCheck.result, 'deny');

    first.release();
  });
});

// ---------------------------------------------------------------------------
// recipe.auth
// ---------------------------------------------------------------------------

describe('Authorization seam: recipe.auth', () => {
  const okEnvIntersection = { intersection: [], warnings: [], denied: [] };

  it('allows when preflight ok and no session enforcement', async () => {
    const preflight = { ok: true, code: null, reason: null, envIntersection: okEnvIntersection };
    const result = await authorize(ACTIONS.RECIPE_AUTH, { preflight });
    assert.ok(result.allowed);
    assert.deepEqual(result.envIntersection, okEnvIntersection);
    const preflightCheck = result.trace.checks.find(c => c.name === 'recipe_auth_preflight');
    assert.equal(preflightCheck.result, 'pass');
    const sessionCheck = result.trace.checks.find(c => c.name === 'session_contract');
    assert.equal(sessionCheck.result, 'skip');
  });

  it('denies when preflight fails', async () => {
    const preflight = { ok: false, code: AUTH_CODES.MISSING_AUTH_MAPPING, reason: 'env vars not in allow list' };
    const result = await authorize(ACTIONS.RECIPE_AUTH, { preflight });
    assert.ok(!result.allowed);
    assert.equal(result.code, AUTH_CODES.MISSING_AUTH_MAPPING);
    assert.equal(result.reason, 'env vars not in allow list');
    assert.equal(result.envIntersection, null);
    const preflightCheck = result.trace.checks.find(c => c.name === 'recipe_auth_preflight');
    assert.equal(preflightCheck.result, 'deny');
  });

  it('denies when session enforcement blocks execution', async () => {
    const preflight = { ok: true, code: null, reason: null, envIntersection: okEnvIntersection };
    const sessionEnforcement = {
      enforced: true,
      evaluation: { ok: false, code: 'scope_widened', reason: 'touched extra file', diffs: ['file.txt'] },
    };
    const result = await authorize(ACTIONS.RECIPE_AUTH, { preflight, sessionEnforcement });
    assert.ok(!result.allowed);
    assert.equal(result.code, AUTH_CODES.SESSION_CONTRACT_BLOCKED);
    assert.ok(result.reason.includes('session contract blocked'));
    const sessionCheck = result.trace.checks.find(c => c.name === 'session_contract');
    assert.equal(sessionCheck.result, 'deny');
  });

  it('allows when session enforcement is satisfied', async () => {
    const preflight = { ok: true, code: null, reason: null, envIntersection: okEnvIntersection };
    const sessionEnforcement = {
      enforced: true,
      evaluation: { ok: true, code: null, reason: null, diffs: [] },
    };
    const result = await authorize(ACTIONS.RECIPE_AUTH, { preflight, sessionEnforcement });
    assert.ok(result.allowed);
    const sessionCheck = result.trace.checks.find(c => c.name === 'session_contract');
    assert.equal(sessionCheck.result, 'pass');
  });

  it('fails closed when preflight is missing', async () => {
    const result = await authorize(ACTIONS.RECIPE_AUTH, {});
    assert.ok(!result.allowed);
    assert.equal(result.code, 'missing_preflight');
  });
});

// ---------------------------------------------------------------------------
// workflow.recipe_step
// ---------------------------------------------------------------------------

describe('Authorization seam: workflow.recipe_step', () => {
  const okEnvIntersection = { intersection: [], warnings: [], denied: [] };

  it('allows when preflight ok', async () => {
    const preflight = { ok: true, code: null, reason: null, envIntersection: okEnvIntersection };
    const result = await authorize(ACTIONS.WORKFLOW_RECIPE_STEP, { preflight });
    assert.ok(result.allowed);
    assert.deepEqual(result.envIntersection, okEnvIntersection);
  });

  it('denies when preflight fails', async () => {
    const preflight = { ok: false, code: AUTH_CODES.MISSING_AUTH_PREREQUISITE, reason: 'claude not logged in' };
    const result = await authorize(ACTIONS.WORKFLOW_RECIPE_STEP, { preflight });
    assert.ok(!result.allowed);
    assert.equal(result.code, AUTH_CODES.MISSING_AUTH_PREREQUISITE);
  });

  it('does NOT apply session enforcement for workflow.recipe_step', async () => {
    // Session enforcement is a recipe-only concern; workflow step auth ignores it
    const preflight = { ok: true, code: null, reason: null, envIntersection: okEnvIntersection };
    const sessionEnforcement = {
      enforced: true,
      evaluation: { ok: false, code: 'scope_widened', reason: 'blocked', diffs: [] },
    };
    const result = await authorize(ACTIONS.WORKFLOW_RECIPE_STEP, { preflight, sessionEnforcement });
    assert.ok(result.allowed);
    // No session_contract check appears in trace
    const sessionCheck = result.trace.checks.find(c => c.name === 'session_contract');
    assert.equal(sessionCheck, undefined);
  });
});

// ---------------------------------------------------------------------------
// adapter.run
// ---------------------------------------------------------------------------

describe('Authorization seam: adapter.run', () => {
  it('allows with no profile — skips all checks', async () => {
    const result = await authorize(ACTIONS.ADAPTER_RUN, {});
    assert.ok(result.allowed);
    const check = result.trace.checks.find(c => c.name === 'adapter_profile');
    assert.equal(check.result, 'skip');
  });

  it('denies when requires_env not in envAllow', async () => {
    const profile = { requires_env: ['SECRET_TOKEN'], requires_auth: [] };
    const result = await authorize(ACTIONS.ADAPTER_RUN, {
      profile,
      envAllow: [],
    });
    assert.ok(!result.allowed);
    assert.equal(result.code, AUTH_CODES.MISSING_AUTH_MAPPING);
    const envCheck = result.trace.checks.find(c => c.name === 'env_mapping');
    assert.equal(envCheck.result, 'deny');
  });

  it('allows when requires_env is in envAllow and no auth requirements', async () => {
    const profile = { requires_env: ['SECRET_TOKEN'], requires_auth: [] };
    const result = await authorize(ACTIONS.ADAPTER_RUN, {
      profile,
      envAllow: ['SECRET_TOKEN'],
    });
    assert.ok(result.allowed);
    const envCheck = result.trace.checks.find(c => c.name === 'env_mapping');
    assert.equal(envCheck.result, 'pass');
    // No auth prerequisite check since requires_auth is empty
    const authCheck = result.trace.checks.find(c => c.name === 'auth_prerequisite');
    assert.equal(authCheck.result, 'pass');
  });

  it('denies when auth prerequisite fails (fake runner returns not-logged-in)', async () => {
    const profile = {
      requires_env: [],
      requires_auth: [{ type: 'claude_login', message: 'Login required' }],
    };
    const fakeRunner = async () => ({ success: true, stdout: '{"loggedIn":false}', stderr: '' });
    const result = await authorize(ACTIONS.ADAPTER_RUN, {
      profile,
      envAllow: ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'HOME'],
      authCheckFn: fakeRunner,
    });
    assert.ok(!result.allowed);
    assert.equal(result.code, AUTH_CODES.MISSING_AUTH_PREREQUISITE);
    const authCheck = result.trace.checks.find(c => c.name === 'auth_prerequisite');
    assert.equal(authCheck.result, 'deny');
  });
});

// ---------------------------------------------------------------------------
// Unknown action: fail closed
// ---------------------------------------------------------------------------

describe('Authorization seam: unknown action', () => {
  it('fails closed with unknown_action code', async () => {
    const result = await authorize('not.a.real.action', {});
    assert.ok(!result.allowed);
    assert.equal(result.code, AUTH_CODES.UNKNOWN_ACTION);
    assert.ok(result.reason.includes('Unknown authorization action'));
  });
});
