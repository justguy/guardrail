import { createHash, createHmac } from 'node:crypto';
import { serializeStable } from './contract.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Mock signing key — in production, this would be an asymmetric key pair.
const SIGNING_KEY = 'guardrail-verified-channel-v1';

const TRUST_LEVELS = {
  verified:  { label: 'VERIFIED',  description: 'Signed by Guardrail, passed static analysis' },
  community: { label: 'COMMUNITY', description: 'Unverified — use at your own risk' },
};

// ---------------------------------------------------------------------------
// Signature generation (mock — HMAC-SHA256)
// ---------------------------------------------------------------------------

/**
 * Sign a recipe, producing a signature string.
 * In a real system this would use asymmetric cryptography.
 *
 * @param {object} recipe - The recipe to sign.
 * @returns {string} HMAC-SHA256 hex signature.
 */
export function signRecipe(recipe) {
  const payload = serializeStable({
    id:                recipe.id,
    name:              recipe.name,
    version:           recipe.version,
    steps:             recipe.steps,
    guardrails:        recipe.guardrails,
    risk_level:        recipe.risk_level,
    approval_required: recipe.approval_required,
  });
  return createHmac('sha256', SIGNING_KEY).update(payload).digest('hex');
}

/**
 * Verify a recipe signature.
 *
 * @param {object} recipe    - The recipe to verify.
 * @param {string} signature - The signature to check.
 * @returns {{ valid: boolean, expected: string }}
 */
export function verifySignature(recipe, signature) {
  const expected = signRecipe(recipe);
  return { valid: expected === signature, expected };
}

// ---------------------------------------------------------------------------
// Trust classification
// ---------------------------------------------------------------------------

/**
 * Classify the trust level of a recipe.
 *
 * @param {object} recipe - Recipe with optional channel + signature fields.
 * @returns {{ channel: string, verified: boolean, label: string, description: string, warnings: string[] }}
 */
export function classifyTrust(recipe) {
  const warnings = [];
  const channel = recipe.channel ?? 'community';

  if (channel === 'verified') {
    if (!recipe.signature) {
      warnings.push('Recipe claims verified channel but has no signature');
      return { channel: 'community', verified: false, ...TRUST_LEVELS.community, warnings };
    }

    const sigCheck = verifySignature(recipe, recipe.signature);
    if (!sigCheck.valid) {
      warnings.push('Recipe signature is invalid — treating as community');
      return { channel: 'community', verified: false, ...TRUST_LEVELS.community, warnings };
    }

    return { channel: 'verified', verified: true, ...TRUST_LEVELS.verified, warnings };
  }

  // Community channel
  if (recipe.signature) {
    warnings.push('Community recipe has a signature — ignored (not in verified channel)');
  }

  return { channel: 'community', verified: false, ...TRUST_LEVELS.community, warnings };
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/**
 * Check whether a recipe is allowed to execute based on trust policy.
 *
 * @param {object} recipe          - The recipe to check.
 * @param {{ allowUnverified: boolean }} policy - Trust policy.
 * @returns {{ allowed: boolean, reason: string|null, trust: object }}
 */
export function enforceChannel(recipe, policy = {}) {
  const trust = classifyTrust(recipe);

  if (trust.verified) {
    return { allowed: true, reason: null, trust };
  }

  if (policy.allowUnverified) {
    return { allowed: true, reason: null, trust };
  }

  return {
    allowed: false,
    reason: 'Unverified recipe blocked. Use --allow-unverified to run community recipes.',
    trust,
  };
}

/**
 * Static validation checks that verified recipes must pass.
 *
 * @param {object} recipe - The recipe to check.
 * @returns {{ passed: boolean, checks: object[] }}
 */
export function staticAnalysis(recipe) {
  const checks = [];

  // Check 1: All steps use structured mode
  const allStructured = (recipe.steps || []).every(s => !s.run?.mode || s.run.mode === 'structured');
  checks.push({ name: 'structured_mode', passed: allStructured, detail: allStructured ? 'All steps use structured mode' : 'Some steps use shell mode' });

  // Check 2: Has guardrails defined
  const hasGuardrails = recipe.guardrails && (recipe.guardrails.constraints?.length > 0 || recipe.guardrails.invariants?.length > 0);
  checks.push({ name: 'has_guardrails', passed: !!hasGuardrails, detail: hasGuardrails ? 'Guardrails defined' : 'No guardrails defined' });

  // Check 3: Risk level declared
  const hasRisk = !!recipe.risk_level;
  checks.push({ name: 'risk_declared', passed: hasRisk, detail: hasRisk ? `Risk: ${recipe.risk_level}` : 'No risk level' });

  // Check 4: Has description
  const hasDesc = typeof recipe.description === 'string' && recipe.description.trim().length > 10;
  checks.push({ name: 'has_description', passed: hasDesc, detail: hasDesc ? 'Description present' : 'Description too short or missing' });

  // Check 5: Inputs constrained (no bare strings)
  const inputsConstrained = Object.values(recipe.inputs || {}).every(s =>
    s.type !== 'string' || s.pattern || s.enum,
  );
  checks.push({ name: 'inputs_constrained', passed: inputsConstrained, detail: inputsConstrained ? 'All inputs constrained' : 'Bare string inputs detected' });

  return { passed: checks.every(c => c.passed), checks };
}

export { TRUST_LEVELS };
