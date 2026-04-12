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
import {
  classifyPayload,
  runEgressHook,
  validateEgressHookConfig,
  EGRESS_OUTCOMES,
  SENSITIVITY_LABELS,
} from '../src/egress-hooks.js';

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

// ---------------------------------------------------------------------------
// Egress hooks — classification and scrubbing
// ---------------------------------------------------------------------------

describe('egress-hooks: classifyPayload', () => {
  const rules = [
    { label: 'restricted', match_fields: ['ssn', 'credit_card'], outcome: 'block', reason: 'PII detected' },
    { label: 'confidential', match_fields: ['password', 'token', 'api_key'], outcome: 'redact', reason: 'Credential detected' },
  ];

  it('returns public/no-match when no rule matches', () => {
    const result = classifyPayload({ output: 'hello' }, rules);
    assert.equal(result.label, SENSITIVITY_LABELS.PUBLIC);
    assert.equal(result.matchedRule, null);
    assert.deepEqual(result.matchedFields, []);
  });

  it('matches first rule and returns its label and reason', () => {
    const result = classifyPayload({ ssn: '123-45-6789', name: 'Alice' }, rules);
    assert.equal(result.label, 'restricted');
    assert.equal(result.reason, 'PII detected');
    assert.deepEqual(result.matchedFields, ['ssn']);
  });

  it('matches second rule when first does not match', () => {
    const result = classifyPayload({ token: 'abc123' }, rules);
    assert.equal(result.label, 'confidential');
    assert.deepEqual(result.matchedFields, ['token']);
  });

  it('is case-insensitive on field names', () => {
    const result = classifyPayload({ SSN: 'value' }, rules);
    assert.equal(result.label, 'restricted');
  });

  it('handles empty payload gracefully', () => {
    const result = classifyPayload({}, rules);
    assert.equal(result.label, SENSITIVITY_LABELS.PUBLIC);
    assert.equal(result.matchedRule, null);
  });

  it('uses provided defaultLabel when no match', () => {
    const result = classifyPayload({ x: 1 }, rules, SENSITIVITY_LABELS.INTERNAL);
    assert.equal(result.label, SENSITIVITY_LABELS.INTERNAL);
  });
});

describe('egress-hooks: runEgressHook', () => {
  const hookConfig = {
    enabled: true,
    rules: [
      { label: 'restricted', match_fields: ['ssn'], outcome: 'block', reason: 'PII detected' },
      { label: 'confidential', match_fields: ['password'], outcome: 'redact', reason: 'Credential detected' },
    ],
    default_label: 'public',
    default_outcome: 'allow',
  };

  it('allows clean payloads', () => {
    const result = runEgressHook({ output: 'safe text' }, hookConfig);
    assert.equal(result.outcome, EGRESS_OUTCOMES.ALLOW);
    assert.equal(result.label, 'public');
    assert.ok(typeof result.payloadHash === 'string' && result.payloadHash.length === 64);
  });

  it('blocks restricted payloads', () => {
    const result = runEgressHook({ ssn: '000-00-0000' }, hookConfig);
    assert.equal(result.outcome, EGRESS_OUTCOMES.BLOCK);
    assert.equal(result.label, 'restricted');
    assert.equal(result.sanitized, null);
  });

  it('redacts credential fields and returns sanitized payload', () => {
    const result = runEgressHook({ output: 'ok', password: 'secret123' }, hookConfig);
    assert.equal(result.outcome, EGRESS_OUTCOMES.REDACT);
    assert.equal(result.sanitized.password, '[REDACTED]');
    assert.equal(result.sanitized.output, 'ok');
  });

  it('sanitized result does not leak the original field value', () => {
    const result = runEgressHook({ password: 'hunter2' }, hookConfig);
    assert.equal(result.outcome, EGRESS_OUTCOMES.REDACT);
    const sanitizedStr = JSON.stringify(result.sanitized);
    assert.ok(!sanitizedStr.includes('hunter2'), 'original value must not appear in sanitized output');
  });

  it('calls audit function with no payload content', () => {
    const auditEntries = [];
    runEgressHook({ ssn: 'x' }, hookConfig, (entry) => auditEntries.push(entry));
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0].event, 'egress_hook_result');
    assert.equal(auditEntries[0].outcome, 'block');
    assert.ok(typeof auditEntries[0].payload_hash === 'string');
    // Must not contain the payload value
    const entryStr = JSON.stringify(auditEntries[0]);
    assert.ok(!entryStr.includes('"x"'), 'audit entry must not leak payload values');
  });

  it('skips hook when disabled', () => {
    const result = runEgressHook({ ssn: 'pii' }, { ...hookConfig, enabled: false });
    assert.equal(result.outcome, EGRESS_OUTCOMES.ALLOW);
  });

  it('fails closed on unknown outcome value', () => {
    const badConfig = {
      ...hookConfig,
      rules: [{ label: 'restricted', match_fields: ['ssn'], outcome: 'unknown_outcome', reason: 'test' }],
    };
    const result = runEgressHook({ ssn: 'x' }, badConfig);
    assert.equal(result.outcome, EGRESS_OUTCOMES.BLOCK);
  });
});

describe('egress-hooks: validateEgressHookConfig', () => {
  it('passes a valid config', () => {
    const errors = validateEgressHookConfig({
      enabled: true,
      default_label: 'public',
      default_outcome: 'allow',
      rules: [{ match_fields: ['ssn'], outcome: 'block' }],
    });
    assert.deepEqual(errors, []);
  });

  it('rejects non-object', () => {
    const errors = validateEgressHookConfig('bad');
    assert.ok(errors.length > 0);
  });

  it('rejects invalid default_outcome', () => {
    const errors = validateEgressHookConfig({ default_outcome: 'destroy' });
    assert.ok(errors.some(e => e.includes('default_outcome')));
  });

  it('rejects invalid default_label', () => {
    const errors = validateEgressHookConfig({ default_label: 'top_secret' });
    assert.ok(errors.some(e => e.includes('default_label')));
  });

  it('rejects rules entry without match_fields array', () => {
    const errors = validateEgressHookConfig({ rules: [{ match_fields: 'ssn' }] });
    assert.ok(errors.some(e => e.includes('match_fields')));
  });
});
