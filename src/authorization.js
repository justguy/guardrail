/**
 * authorization.js — Universal authorization seam.
 *
 * Single authorize(action, facts) entry point for all execution surfaces.
 * Returns a normalized { allowed, decision, code, reason, trace, release, envIntersection }.
 *
 * Design contract:
 * - Fail closed on unknown action.
 * - Every deny carries a machine-readable code and human-readable reason.
 * - Every result carries a decision trace recording which checks ran.
 * - For runtime-policy actions the allowed result includes release() for the acquired lock.
 * - For recipe/adapter auth actions the allowed result includes envIntersection.
 */

import { checkTimePolicy, acquireLock } from './runtime-policy.js';
import { checkEnvMappings, checkAuthPrerequisites } from './adapter-auth.js';

// ---------------------------------------------------------------------------
// Action constants
// ---------------------------------------------------------------------------

export const ACTIONS = {
  /** Single-command supervisor */
  COMMAND_RUN:          'command.run',
  /** Recipe auth preflight + session enforcement gate */
  RECIPE_AUTH:          'recipe.auth',
  /** Recipe runtime-policy gate (time + lock) */
  RECIPE_RUN:           'recipe.run',
  /** Workflow runtime-policy gate (time + lock) */
  WORKFLOW_RUN:         'workflow.run',
  /** Per-step recipe auth preflight inside a workflow */
  WORKFLOW_RECIPE_STEP: 'workflow.recipe_step',
  /** Template runtime-policy gate (time + lock) */
  TEMPLATE_RUN:         'template.run',
  /** Resident lane bootstrap/startup lock gate */
  LANE_START:           'lane.start',
  /** Adapter env-mapping + auth-prerequisite gate */
  ADAPTER_RUN:          'adapter.run',
};

// ---------------------------------------------------------------------------
// Authorization code constants
// ---------------------------------------------------------------------------

export const AUTH_CODES = {
  TIME_POLICY_VIOLATED:      'time_policy_violated',
  CONCURRENT_BLOCKED:        'concurrent_execution_blocked',
  MISSING_AUTH_MAPPING:      'missing_auth_mapping',
  MISSING_AUTH_PREREQUISITE: 'missing_auth_prerequisite',
  SESSION_CONTRACT_BLOCKED:  'session_contract_blocked',
  UNKNOWN_ACTION:            'unknown_action',
};

// ---------------------------------------------------------------------------
// Internal result builders
// ---------------------------------------------------------------------------

/**
 * Strip non-serializable or sensitive keys from facts before embedding in trace.
 */
function sanitizeFacts(facts) {
  const { authCheckFn: _a, currentEnv: _c, preflight: _p, sessionEnforcement: _s, ...safe } = facts;
  return safe;
}

function allow(action, facts, checks, timestamp, extras = {}) {
  return {
    allowed:        true,
    decision:       'allow',
    code:           null,
    reason:         null,
    trace:          { action, facts: sanitizeFacts(facts), checks, timestamp },
    release:        null,
    envIntersection: null,
    ...extras,
  };
}

function deny(action, facts, checks, code, reason, timestamp) {
  return {
    allowed:        false,
    decision:       'deny',
    code,
    reason,
    trace:          { action, facts: sanitizeFacts(facts), checks, timestamp },
    release:        null,
    envIntersection: null,
  };
}

// ---------------------------------------------------------------------------
// Check runners
// ---------------------------------------------------------------------------

/**
 * Evaluate runtime policy: time-window/quota check then concurrency lock acquisition.
 * Returns { denied, code, reason, release } — release is set only when lock was acquired.
 */
function runRuntimePolicyChecks(facts, checks) {
  const { runtimeLimits, manifestHash, stateDir } = facts;

  if (runtimeLimits) {
    const timeCheck = checkTimePolicy(runtimeLimits, manifestHash, stateDir);
    checks.push({
      name:   'time_policy',
      result: timeCheck.allowed ? 'pass' : 'deny',
      detail: { errors: timeCheck.errors },
    });
    if (!timeCheck.allowed) {
      const detail = timeCheck.errors.map(e => e.detail).join('; ');
      return { denied: true, code: AUTH_CODES.TIME_POLICY_VIOLATED, reason: `Time policy violated: ${detail}` };
    }
  } else {
    checks.push({ name: 'time_policy', result: 'skip', detail: {} });
  }

  const lockResult = acquireLock(manifestHash, [], stateDir);
  checks.push({
    name:   'concurrency_lock',
    result: lockResult.acquired ? 'pass' : 'deny',
    detail: { code: lockResult.code, detail: lockResult.detail },
  });
  if (!lockResult.acquired) {
    return {
      denied: true,
      code:   lockResult.code,
      reason: `Concurrent execution blocked: ${lockResult.detail}`,
    };
  }

  return { denied: false, release: lockResult.release };
}

/**
 * Evaluate resident-lane startup locks.
 * facts.startupLocks = [{ key, stateDir, ttlMs, failureMessage, checkName }]
 */
function runLaneStartupChecks(facts, checks) {
  const locks = Array.isArray(facts.startupLocks) ? facts.startupLocks : [];
  const releases = [];
  for (const item of locks) {
    const lockResult = acquireLock(item.key, [], item.stateDir, item.ttlMs);
    checks.push({
      name: item.checkName || 'lane_startup_lock',
      result: lockResult.acquired ? 'pass' : 'deny',
      detail: { code: lockResult.code, detail: lockResult.detail },
    });
    if (!lockResult.acquired) {
      for (const release of releases.reverse()) {
        try { release?.(); } catch {}
      }
      return {
        denied: true,
        code: AUTH_CODES.CONCURRENT_BLOCKED,
        reason: item.failureMessage || `Concurrent execution blocked: ${lockResult.detail}`,
      };
    }
    releases.push(lockResult.release);
  }

  return {
    denied: false,
    release: () => {
      for (const release of releases.reverse()) {
        try { release?.(); } catch {}
      }
    },
  };
}

/**
 * Evaluate adapter auth: env-mapping check then auth-prerequisite check.
 * Returns { denied, code, reason }.
 */
async function runAdapterAuthChecks(profile, facts, checks) {
  const requiredEnv      = profile.requires_env  || [];
  const authRequirements = profile.requires_auth  || [];

  const envCheck = checkEnvMappings(requiredEnv, facts.envAllow || [], {
    authRequirements,
    currentEnv: process.env,
  });
  checks.push({
    name:   'env_mapping',
    result: envCheck.ok ? 'pass' : 'deny',
    detail: { code: envCheck.code, missing: envCheck.missing },
  });
  if (!envCheck.ok) {
    return { denied: true, code: envCheck.code, reason: envCheck.message };
  }

  const authCheck = await checkAuthPrerequisites(authRequirements, {
    cwd:         facts.cwd,
    checkRunner: facts.authCheckFn,
  });
  checks.push({
    name:   'auth_prerequisite',
    result: authCheck.ok ? 'pass' : 'deny',
    detail: { code: authCheck.code },
  });
  if (!authCheck.ok) {
    const detail = authCheck.detail ? ` Detail: ${authCheck.detail}` : '';
    return { denied: true, code: authCheck.code, reason: `${authCheck.code}: ${authCheck.message}${detail}` };
  }

  return { denied: false };
}

/**
 * Evaluate session enforcement result (already prepared by caller).
 * Returns { denied, code, reason }.
 */
function runSessionEnforcementCheck(sessionEnforcement, checks) {
  if (!sessionEnforcement?.enforced) {
    checks.push({ name: 'session_contract', result: 'skip', detail: {} });
    return { denied: false };
  }

  const evaluation = sessionEnforcement.evaluation;
  checks.push({
    name:   'session_contract',
    result: evaluation.ok ? 'pass' : 'deny',
    detail: { code: evaluation.code, diffs: evaluation.diffs },
  });
  if (!evaluation.ok) {
    return {
      denied: true,
      code:   AUTH_CODES.SESSION_CONTRACT_BLOCKED,
      reason: `Agent session contract blocked: ${evaluation.code} — ${evaluation.reason}`,
    };
  }

  return { denied: false };
}

// ---------------------------------------------------------------------------
// Universal entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate whether action is allowed given facts.
 *
 * @param {string} action - One of ACTIONS.*
 * @param {object} facts  - Context required by the action's checks (see ACTIONS docs).
 * @returns {Promise<{ allowed, decision, code, reason, trace, release, envIntersection }>}
 */
export async function authorize(action, facts = {}) {
  const timestamp = new Date().toISOString();
  const checks    = [];

  // ---- Runtime-policy gate (command / recipe / workflow / template) ---------
  if (action === ACTIONS.COMMAND_RUN  ||
      action === ACTIONS.RECIPE_RUN   ||
      action === ACTIONS.WORKFLOW_RUN ||
      action === ACTIONS.TEMPLATE_RUN) {
    const result = runRuntimePolicyChecks(facts, checks);
    if (result.denied) {
      return deny(action, facts, checks, result.code, result.reason, timestamp);
    }
    return allow(action, facts, checks, timestamp, { release: result.release });
  }

  // ---- Resident-lane startup gate -----------------------------------------
  if (action === ACTIONS.LANE_START) {
    const result = runLaneStartupChecks(facts, checks);
    if (result.denied) {
      return deny(action, facts, checks, result.code, result.reason, timestamp);
    }
    return allow(action, facts, checks, timestamp, { release: result.release });
  }

  // ---- Recipe / workflow-step auth gate ------------------------------------
  if (action === ACTIONS.RECIPE_AUTH || action === ACTIONS.WORKFLOW_RECIPE_STEP) {
    // facts.preflight is the result of preflightRecipeAuthRuntime() called by the supervisor.
    const preflight = facts.preflight;
    checks.push({
      name:   'recipe_auth_preflight',
      result: preflight?.ok ? 'pass' : 'deny',
      detail: { code: preflight?.code ?? null },
    });
    if (!preflight?.ok) {
      return deny(
        action, facts, checks,
        preflight?.code ?? 'missing_preflight',
        preflight?.reason ?? 'Recipe auth preflight missing or failed',
        timestamp,
      );
    }

    if (action === ACTIONS.RECIPE_AUTH) {
      const sessionResult = runSessionEnforcementCheck(facts.sessionEnforcement, checks);
      if (sessionResult.denied) {
        return deny(action, facts, checks, sessionResult.code, sessionResult.reason, timestamp);
      }
    }

    return allow(action, facts, checks, timestamp, { envIntersection: preflight.envIntersection });
  }

  // ---- Adapter auth gate ---------------------------------------------------
  if (action === ACTIONS.ADAPTER_RUN) {
    const profile = facts.profile;
    if (!profile) {
      checks.push({ name: 'adapter_profile', result: 'skip', detail: {} });
      return allow(action, facts, checks, timestamp);
    }
    const result = await runAdapterAuthChecks(profile, facts, checks);
    if (result.denied) {
      return deny(action, facts, checks, result.code, result.reason, timestamp);
    }
    return allow(action, facts, checks, timestamp);
  }

  // ---- Unknown action: fail closed -----------------------------------------
  return deny(
    action, facts, checks,
    AUTH_CODES.UNKNOWN_ACTION,
    `Unknown authorization action: ${action}`,
    timestamp,
  );
}
