import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRedactedParserFailure,
  extractBalancedJsonObjects,
  parseFirstJsonObject,
} from '../src/llm-json.js';

describe('llm-json helpers', () => {
  it('extracts balanced JSON objects from wrapped model output', () => {
    const text = 'noise\n```json\n{"domain":"medical_advice"}\n```\ntrailing';
    assert.deepEqual(extractBalancedJsonObjects(text), ['{"domain":"medical_advice"}']);
  });

  it('parses the first valid balanced object after invalid candidates', () => {
    const text = 'oops {"domain": invalid}\nthen {"domain":"general_workplace"}';
    assert.deepEqual(parseFirstJsonObject(text, { domain: 'fallback' }), { domain: 'general_workplace' });
  });

  it('returns fallback when no valid object exists', () => {
    assert.deepEqual(parseFirstJsonObject('no json here', { ok: false }), { ok: false });
  });

  it('builds redacted parser failure metadata without raw content', () => {
    const meta = buildRedactedParserFailure('domain-router', 'secret medical content', new Error('bad json'));
    assert.equal(meta.parserName, 'domain-router');
    assert.equal(meta.errorType, 'Error');
    assert.equal(typeof meta.inputSha256, 'string');
    assert.equal(meta.inputSha256.length, 64);
    assert.equal('text' in meta, false);
  });
});
