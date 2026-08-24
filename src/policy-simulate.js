/**
 * policy-simulate.js — Policy simulation and decision-trace surfaces.
 *
 * Provides simulatePolicy(context) which runs the same evaluation path as real
 * authorization but never acquires locks or executes side effects.
 *
 * Decision trace format matches authorize() in authorization.js:
 *   { allowed, decision, code, reason, simulated, trace, ... }
 */

import { evaluateRisk } from './policy-engine.js';
import { enforcePolicy } from './policy.js';
import { enforceOrgPolicy } from './org-policy.js';

// ---------------------------------------------------------------------------
// Simulation decision codes
// ---------------------------------------------------------------------------

export const SIMULATION_CODES = {
  RISK_LEVEL_RED:   'risk_level_red',
  POLICY_VIOLATION: 'policy_violation',
};

// ---------------------------------------------------------------------------
// Internal result builders — mirrors authorize() shape
// ---------------------------------------------------------------------------

function buildAllow(sanitizedFacts, checks, timestamp, fields) {
  return {
    allowed:    true,
    decision:   'allow',
    code:       null,
    reason:     null,
    simulated:  true,
    trace:      { action: 'policy.simulate', facts: sanitizedFacts, checks, timestamp },
    ...fields,
  };
}

function buildDeny(sanitizedFacts, checks, code, reason, timestamp, fields) {
  return {
    allowed:    false,
    decision:   'deny',
    code,
    reason,
    simulated:  true,
    trace:      { action: 'policy.simulate', facts: sanitizedFacts, checks, timestamp },
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// Main simulation entry point
// ---------------------------------------------------------------------------

/**
 * Simulate a policy decision without executing the action.
 * Uses the same evaluation path as the real authorization + supervisor flow.
 *
 * @param {object} params
 * @param {object} params.contract      - Normalized contract (command, args, cwd, mode, …)
 * @param {object} [params.options]     - Risk evaluation options (trustClass, projectRoot, …)
 * @param {string} [params.principal]   - Identifier of the requesting principal (role/user)
 * @param {object} [params.localPolicy] - Loaded local policy (policy.js format)
 * @param {object} [params.orgPolicy]   - Loaded org policy (org-policy.js format)
 * @returns {{
 *   allowed, decision, code, reason, simulated,
 *   principal, contract, risk_level, trust_class, reasons,
 *   matched_rules, requires_strong_confirmation, traits,
 *   timestamp, trace
 * }}
 */
export function simulatePolicy({ contract, options = {}, principal, localPolicy, orgPolicy }) {
  const timestamp = new Date().toISOString();
  const checks = [];

  // ---- Step 1: Risk evaluation (same path supervisors use) ------------------
  const riskResult = evaluateRisk(contract, options);
  checks.push({
    name:   'risk_evaluation',
    result: riskResult.riskLevel === 'red' ? 'deny' : 'pass',
    detail: {
      risk_level:  riskResult.riskLevel,
      trust_class: riskResult.trustClass,
      reasons:     riskResult.reasons,
      traits:      riskResult.traits,
    },
  });

  const actionContext = {
    command:    contract.command,
    args:       Array.isArray(contract.args) ? contract.args : [],
    cwd:        contract.cwd || process.cwd(),
    risk_level: riskResult.riskLevel,
  };

  // ---- Step 2: Local policy enforcement ------------------------------------
  let allViolations = [];

  if (localPolicy) {
    const policyResult = enforcePolicy(actionContext, localPolicy);
    checks.push({
      name:   'local_policy_enforcement',
      result: policyResult.compliant ? 'pass' : 'deny',
      detail: { violations: policyResult.violations },
    });
    allViolations = allViolations.concat(
      policyResult.violations.map(v => ({ ...v, level: 'local' })),
    );
  } else {
    checks.push({ name: 'local_policy_enforcement', result: 'skip', detail: {} });
  }

  // ---- Step 3: Org policy enforcement -------------------------------------
  if (orgPolicy) {
    const orgResult = enforceOrgPolicy(actionContext, orgPolicy, localPolicy);
    checks.push({
      name:   'org_policy_enforcement',
      result: orgResult.compliant ? 'pass' : 'deny',
      detail: { violations: orgResult.violations },
    });
    allViolations = allViolations.concat(orgResult.violations);
  } else {
    checks.push({ name: 'org_policy_enforcement', result: 'skip', detail: {} });
  }

  // ---- Build matched_rules from risk reasons + policy violations -----------
  const matchedRules = [
    ...riskResult.reasons.map(reason => ({ source: 'risk_engine', rule: reason })),
    ...allViolations.map(v => ({
      source: v.level === 'org' ? 'org_policy' : 'local_policy',
      rule:   v.rule,
      detail: v.detail,
    })),
  ];

  const sharedFields = {
    principal:                    principal || null,
    contract,
    risk_level:                   riskResult.riskLevel,
    trust_class:                  riskResult.trustClass,
    reasons:                      riskResult.reasons,
    matched_rules:                matchedRules,
    requires_strong_confirmation: riskResult.requiresStrongConfirmation,
    traits:                       riskResult.traits,
    timestamp,
  };

  // Sanitized facts for trace (no runtime secrets)
  const sanitizedFacts = { principal: principal || null };

  // ---- Compute final decision ----------------------------------------------
  const isDenied = riskResult.riskLevel === 'red' || allViolations.length > 0;

  if (!isDenied) {
    return buildAllow(sanitizedFacts, checks, timestamp, sharedFields);
  }

  const code = riskResult.riskLevel === 'red'
    ? SIMULATION_CODES.RISK_LEVEL_RED
    : SIMULATION_CODES.POLICY_VIOLATION;

  const reason = riskResult.riskLevel === 'red'
    ? `Risk level red: ${riskResult.reasons.join('; ')}`
    : `Policy violation: ${allViolations.map(v => v.detail).join('; ')}`;

  return buildDeny(sanitizedFacts, checks, code, reason, timestamp, sharedFields);
}

// ---------------------------------------------------------------------------
// Human-readable formatter
// ---------------------------------------------------------------------------

/**
 * Format a simulation result for terminal display.
 * @param {object} result - Output from simulatePolicy()
 * @returns {string}
 */
export function formatSimulationResult(result) {
  const lines = [];
  lines.push(`Decision: ${result.decision.toUpperCase()} (simulated)`);
  if (result.principal) lines.push(`Principal: ${result.principal}`);
  lines.push(`Risk level: ${result.risk_level}  Trust: ${result.trust_class}`);
  if (result.reason)  lines.push(`Reason: ${result.reason}`);
  if (result.reasons.length > 0) {
    lines.push('Policy inputs:');
    for (const r of result.reasons) lines.push(`  - ${r}`);
  }
  if (result.matched_rules.length > 0) {
    lines.push('Matched rules:');
    for (const mr of result.matched_rules) {
      const detail = mr.detail ? ` — ${mr.detail}` : '';
      lines.push(`  [${mr.source}] ${mr.rule}${detail}`);
    }
  }
  lines.push(`Checks run: ${result.trace.checks.map(c => `${c.name}=${c.result}`).join(', ')}`);
  return lines.join('\n');
}
