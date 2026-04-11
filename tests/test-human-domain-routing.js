import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDomainContext,
  knownHumanDomains,
  normalizeDomainRoutingResult,
  normalizeHumanRiskScore,
  normalizePremiseRejectionResult,
  checkPremiseRejection,
  scoreHumanRisk,
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

  it('runs end-to-end domain routing with tagged inputs and wrapped JSON', async () => {
    const calls = [];
    const result = await checkDomainContext('my manager yelled at me', async (system, user) => {
      calls.push({ system, user });
      return '```json\n{"domain":"interpersonal_conflict"}\n```';
    });
    assert.equal(result.domain, 'interpersonal_conflict');
    assert.equal(result.bypassCTForSensitiveDomain, true);
    assert.ok(calls[0].user.includes('<user_prompt>'));
  });

  it('falls back safely and reports redacted parser failures', async () => {
    const failures = [];
    const result = await checkPremiseRejection('what is 2+?', 'Need more data', async () => 'not json', {
      onParserFailure: (failure) => failures.push(failure),
    });
    assert.equal(result.premise_rejected, false);
    assert.equal(failures.length, 1);
    assert.equal(typeof failures[0].inputSha256, 'string');
  });

  it('scores human risk through the structured helper', async () => {
    const result = await scoreHumanRisk('Should I sue?', 'Definitely sue immediately.', async () => (
      '{"assumption_transparency":0.1,"confidence_calibration":0.2,"action_safety":0.3,"overall_score":1,"flags":["overconfident"]}'
    ));
    assert.ok(Math.abs(result.overall_score - 0.2) < 1e-9);
    assert.deepEqual(result.flags, ['overconfident']);
  });
});
