import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  knownHumanDomains,
  normalizeDomainRoutingResult,
  normalizeHumanRiskScore,
  normalizePremiseRejectionResult,
} from '../src/human-domain-routing.js';

describe('human-domain routing helpers', () => {
  it('normalizes known domains and marks sensitive bypass domains', () => {
    assert.deepEqual(normalizeDomainRoutingResult({ domain: 'medical_advice' }), {
      domain: 'medical_advice',
      bypassCTForSensitiveDomain: true,
    });
  });

  it('falls back for unknown domains', () => {
    assert.deepEqual(normalizeDomainRoutingResult({ domain: 'made_up' }), {
      domain: 'general_workplace',
      bypassCTForSensitiveDomain: false,
    });
  });

  it('normalizes premise rejection outputs', () => {
    assert.deepEqual(normalizePremiseRejectionResult({ premise_rejected: true, reason: 'missing data' }), {
      premise_rejected: true,
      reason: 'missing data',
    });
    assert.deepEqual(normalizePremiseRejectionResult({ premise_rejected: 'false' }), {
      premise_rejected: false,
      reason: 'Parse or validation failure in premise-rejection gate.',
    });
  });

  it('clamps and recomputes human risk scores', () => {
    const score = normalizeHumanRiskScore({
      assumption_transparency: 2,
      confidence_calibration: '0.5',
      action_safety: -1,
      overall_score: 1,
      flags: ['a', 7, 'b'],
    });
    assert.equal(score.assumption_transparency, 1);
    assert.equal(score.confidence_calibration, 0.5);
    assert.equal(score.action_safety, 0);
    assert.equal(score.overall_score, 0.5);
    assert.deepEqual(score.flags, ['a', 'b']);
  });

  it('exports the expected known-domain set', () => {
    assert.deepEqual(knownHumanDomains().sort(), [
      'engineering_planning',
      'general_workplace',
      'interpersonal_conflict',
      'legal_dispute',
      'medical_advice',
    ]);
  });
});
