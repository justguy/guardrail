import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateInputValue, inferApprovalMode, normalizePath,
  analyzeShellContent, validatePathPolicy, validateList,
} from '../src/input-validator.js';
import {
  RISK_TRAITS, classifyBucket, summarizeCapabilities,
  escalateTraits, checkExecutionShape, HARD_LIMITS,
} from '../src/risk-traits.js';

// ===========================================================================
// Risk Traits: taxonomy
// ===========================================================================

describe('Risk Traits: taxonomy', () => {
  it('every trait has severity and capability (or null)', () => {
    for (const [name, trait] of Object.entries(RISK_TRAITS)) {
      assert.ok(typeof trait.severity === 'string', `${name} missing severity`);
      assert.ok(['medium', 'high', 'critical'].includes(trait.severity), `${name} bad severity`);
    }
  });

  it('critical traits have null capability (not approvable)', () => {
    for (const [name, trait] of Object.entries(RISK_TRAITS)) {
      if (trait.severity === 'critical') {
        assert.equal(trait.capability, null, `Critical trait ${name} should not be approvable`);
      }
    }
  });
});

// ===========================================================================
// Risk Traits: bucket classification
// ===========================================================================

describe('Risk Traits: classifyBucket', () => {
  it('no traits → allow', () => {
    assert.equal(classifyBucket([]), 'allow');
    assert.equal(classifyBucket(null), 'allow');
  });

  it('critical trait → block', () => {
    assert.equal(classifyBucket(['path_escape_attempt']), 'block');
    assert.equal(classifyBucket(['unsupported_structure']), 'block');
    assert.equal(classifyBucket(['mode_transition']), 'block');
    assert.equal(classifyBucket(['exceeds_hard_limit']), 'block');
  });

  it('non-critical trait → flag', () => {
    assert.equal(classifyBucket(['execution_chaining']), 'flag');
    assert.equal(classifyBucket(['scope_widening']), 'flag');
    assert.equal(classifyBucket(['prod_target_reference']), 'flag');
    assert.equal(classifyBucket(['recursive_flag']), 'flag');
  });

  it('mixed critical + non-critical → block', () => {
    assert.equal(classifyBucket(['scope_widening', 'path_escape_attempt']), 'block');
  });
});

// ===========================================================================
// Risk Traits: capability summary
// ===========================================================================

describe('Risk Traits: summarizeCapabilities', () => {
  it('returns human-readable capabilities', () => {
    const caps = summarizeCapabilities(['execution_chaining', 'scope_widening']);
    assert.ok(caps.some(c => c.includes('multiple commands')));
    assert.ok(caps.some(c => c.includes('scope')));
  });

  it('filters null capabilities (critical traits)', () => {
    const caps = summarizeCapabilities(['path_escape_attempt', 'execution_chaining']);
    assert.equal(caps.length, 1); // only execution_chaining has capability
  });
});

// ===========================================================================
// Risk Traits: cross-parameter escalation
// ===========================================================================

describe('Risk Traits: escalateTraits', () => {
  it('scope_widening + high_cardinality → amplified_scope_risk', () => {
    const result = escalateTraits(['scope_widening', 'high_cardinality_input']);
    assert.ok(result.includes('amplified_scope_risk'));
  });

  it('execution_chaining + destructive_intent → amplified_scope_risk', () => {
    const result = escalateTraits(['execution_chaining', 'destructive_intent']);
    assert.ok(result.includes('amplified_scope_risk'));
  });

  it('prod + recursive → amplified_scope_risk', () => {
    const result = escalateTraits(['prod_target_reference', 'recursive_flag']);
    assert.ok(result.includes('amplified_scope_risk'));
  });

  it('no escalation for unrelated traits', () => {
    const result = escalateTraits(['io_redirection']);
    assert.ok(!result.includes('amplified_scope_risk'));
  });

  it('deduplicates traits', () => {
    const result = escalateTraits(['scope_widening', 'scope_widening']);
    assert.equal(result.filter(t => t === 'scope_widening').length, 1);
  });
});

// ===========================================================================
// Risk Traits: execution shape
// ===========================================================================

describe('Risk Traits: checkExecutionShape', () => {
  it('single command within single shape → no traits', () => {
    const traits = checkExecutionShape([['npm', 'test']], { type: 'single', max_commands: 1 });
    assert.deepEqual(traits, []);
  });

  it('two commands within single shape → execution_chaining', () => {
    const traits = checkExecutionShape(
      [['npm', 'test'], ['npm', 'run', 'lint']],
      { type: 'single', max_commands: 1 },
    );
    assert.ok(traits.includes('execution_chaining'));
  });

  it('unapproved binary → scope_widening', () => {
    const traits = checkExecutionShape(
      [['npm', 'test'], ['rm', '-rf', '/']],
      { type: 'single', max_commands: 2, allowed_binaries: ['npm'] },
    );
    assert.ok(traits.includes('scope_widening'));
  });

  it('no shape constraint → no traits', () => {
    assert.deepEqual(checkExecutionShape([['anything']], null), []);
  });
});

// ===========================================================================
// Input Validator: inferApprovalMode
// ===========================================================================

describe('Input Validator: inferApprovalMode', () => {
  it('explicit approval_mode is preserved', () => {
    assert.equal(inferApprovalMode({ approval_mode: 'path_policy' }), 'path_policy');
    assert.equal(inferApprovalMode({ approval_mode: 'review_each_time' }), 'review_each_time');
  });

  it('infers enum from schema.enum', () => {
    assert.equal(inferApprovalMode({ type: 'string', enum: ['a', 'b'] }), 'enum');
  });

  it('infers range from min/max', () => {
    assert.equal(inferApprovalMode({ type: 'integer', min: 1, max: 10 }), 'range');
  });

  it('infers string_pattern from pattern', () => {
    assert.equal(inferApprovalMode({ type: 'string', pattern: '^[a-z]+$' }), 'string_pattern');
  });

  it('boolean → exact', () => {
    assert.equal(inferApprovalMode({ type: 'boolean' }), 'exact');
  });

  it('no constraints → review_each_time (safe fallback)', () => {
    assert.equal(inferApprovalMode({ type: 'string' }), 'review_each_time');
    assert.equal(inferApprovalMode({}), 'review_each_time');
  });
});

// ===========================================================================
// Input Validator: normalizePath
// ===========================================================================

describe('Input Validator: normalizePath', () => {
  it('collapses double slashes', () => {
    assert.equal(normalizePath('src//utils.js'), 'src/utils.js');
  });

  it('strips leading ./', () => {
    assert.equal(normalizePath('./src/utils.js'), 'src/utils.js');
  });

  it('strips trailing /', () => {
    assert.equal(normalizePath('src/'), 'src');
  });

  it('normalizes backslashes', () => {
    assert.equal(normalizePath('src\\utils.js'), 'src/utils.js');
  });
});

// ===========================================================================
// Input Validator: analyzeShellContent
// ===========================================================================

describe('Input Validator: analyzeShellContent', () => {
  it('detects && as execution_chaining', () => {
    const r = analyzeShellContent('npm test && npm run lint');
    assert.ok(r.traits.includes('execution_chaining'));
    assert.equal(r.parsed.commands.length, 2);
    assert.deepEqual(r.parsed.commands[0], ['npm', 'test']);
    assert.deepEqual(r.parsed.commands[1], ['npm', 'run', 'lint']);
  });

  it('detects ; as execution_chaining', () => {
    const r = analyzeShellContent('echo a; echo b');
    assert.ok(r.traits.includes('execution_chaining'));
  });

  it('detects | as io_redirection', () => {
    const r = analyzeShellContent('cat file | grep x');
    assert.ok(r.traits.includes('io_redirection'));
  });

  it('detects $() as command_substitution', () => {
    const r = analyzeShellContent('echo $(whoami)');
    assert.ok(r.traits.includes('command_substitution'));
  });

  it('detects > as io_redirection', () => {
    const r = analyzeShellContent('echo hi > out.txt');
    assert.ok(r.traits.includes('io_redirection'));
  });

  it('detects --force as recursive_flag', () => {
    const r = analyzeShellContent('git push --force');
    assert.ok(r.traits.includes('recursive_flag'));
  });

  it('handles compact chaining (no spaces around &&)', () => {
    const r = analyzeShellContent('npm test&&echo hi');
    assert.ok(r.traits.includes('execution_chaining'));
    assert.equal(r.parsed.commands.length, 2);
  });

  it('safe command returns no traits', () => {
    const r = analyzeShellContent('npm test');
    assert.equal(r.traits.length, 0);
    assert.equal(r.parsed.commands.length, 1);
  });
});

// ===========================================================================
// Input Validator: validatePathPolicy
// ===========================================================================

describe('Input Validator: validatePathPolicy', () => {
  it('valid relative path within allowed root', () => {
    const r = validatePathPolicy('src/utils.js', {
      must_be_relative: true, allowed_roots: ['src/'], deny_segments: ['..', '.git'],
    });
    assert.equal(r.valid, true);
    assert.equal(r.risk_traits.length, 0);
  });

  it('absolute path when must_be_relative → block', () => {
    const r = validatePathPolicy('/etc/passwd', { must_be_relative: true });
    assert.equal(r.valid, false);
    assert.ok(r.risk_traits.includes('unsupported_structure'));
  });

  it('path traversal (..) → block', () => {
    const r = validatePathPolicy('../../etc/passwd', {
      must_be_relative: true, allowed_roots: ['src/'], deny_segments: ['..'],
    });
    assert.equal(r.valid, false);
    assert.ok(r.risk_traits.includes('path_escape_attempt'));
  });

  it('denied segment (.git) → block', () => {
    const r = validatePathPolicy('src/.git/config', {
      deny_segments: ['.git'],
    });
    assert.equal(r.valid, false);
    assert.ok(r.risk_traits.includes('path_escape_attempt'));
  });

  it('outside allowed root → flag scope_widening (not block)', () => {
    const r = validatePathPolicy('docs/readme.md', {
      must_be_relative: true, allowed_roots: ['src/'],
    });
    assert.equal(r.valid, true);
    assert.ok(r.risk_traits.includes('scope_widening'));
  });

  it('exceeds max_depth → flag', () => {
    const r = validatePathPolicy('a/b/c/d/e/f.js', {
      max_depth: 3,
    });
    assert.equal(r.valid, true);
    assert.ok(r.risk_traits.includes('high_cardinality_input'));
  });

  it('wrong extension → flag', () => {
    const r = validatePathPolicy('src/data.csv', {
      allowed_extensions: ['.js', '.ts'],
    });
    assert.equal(r.valid, true);
    assert.ok(r.risk_traits.includes('scope_widening'));
  });
});

// ===========================================================================
// Input Validator: validateList
// ===========================================================================

describe('Input Validator: validateList', () => {
  it('valid list within limits', () => {
    const r = validateList(['a', 'b', 'c'], { max_items: 10 });
    assert.equal(r.valid, true);
  });

  it('too many items → block', () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const r = validateList(items, { max_items: 5 });
    assert.equal(r.valid, false);
    assert.ok(r.risk_traits.includes('exceeds_hard_limit'));
  });

  it('large list → flag high_cardinality', () => {
    const items = Array.from({ length: 15 }, (_, i) => `item-${i}`);
    const r = validateList(items, { max_items: 100 });
    assert.equal(r.valid, true);
    assert.ok(r.risk_traits.includes('high_cardinality_input'));
  });

  it('non-array → block', () => {
    const r = validateList('not-an-array', {});
    assert.equal(r.valid, false);
  });
});

// ===========================================================================
// Input Validator: validateInputValue (main function)
// ===========================================================================

describe('Input Validator: validateInputValue', () => {
  // --- exact ---
  it('exact mode: matching value passes', () => {
    const r = validateInputValue('hello', { approval_mode: 'exact', value: 'hello', type: 'string' });
    assert.equal(r.valid, true);
    assert.equal(r.risk_traits.length, 0);
  });

  it('exact mode: non-matching value fails', () => {
    const r = validateInputValue('wrong', { approval_mode: 'exact', value: 'hello', type: 'string' });
    assert.equal(r.valid, false);
  });

  // --- enum ---
  it('enum mode: valid value passes', () => {
    const r = validateInputValue('patch', { type: 'string', enum: ['patch', 'minor'] });
    assert.equal(r.valid, true);
  });

  it('enum mode: invalid value fails', () => {
    const r = validateInputValue('major', { type: 'string', enum: ['patch', 'minor'] });
    assert.equal(r.valid, false);
  });

  it('enum mode: prod reference in valid enum → flagged', () => {
    const r = validateInputValue('production', { type: 'string', enum: ['staging', 'production'] });
    assert.equal(r.valid, true);
    assert.ok(r.risk_traits.includes('prod_target_reference'));
  });

  // --- range ---
  it('range mode: in range passes', () => {
    const r = validateInputValue(5, { type: 'integer', min: 1, max: 10 });
    assert.equal(r.valid, true);
    assert.equal(r.normalized, 5);
  });

  it('range mode: below min fails', () => {
    const r = validateInputValue(0, { type: 'integer', min: 1, max: 10 });
    assert.equal(r.valid, false);
  });

  it('range mode: wide range → high_cardinality', () => {
    const r = validateInputValue(500, { type: 'integer', min: 0, max: 10000 });
    assert.equal(r.valid, true);
    assert.ok(r.risk_traits.includes('high_cardinality_input'));
  });

  // --- string_pattern ---
  it('string with pattern: matching value passes', () => {
    const r = validateInputValue('hello', { type: 'string', pattern: '^[a-z]+$' });
    assert.equal(r.valid, true);
  });

  it('string with pattern: non-matching fails', () => {
    const r = validateInputValue('HELLO!', { type: 'string', pattern: '^[a-z]+$' });
    assert.equal(r.valid, false);
  });

  it('string with shell content → detects chaining', () => {
    const r = validateInputValue('npm test && npm run lint', { type: 'string', pattern: '.*' });
    assert.equal(r.valid, true);
    assert.ok(r.risk_traits.includes('execution_chaining'));
    assert.ok(r.parsed_shape);
    assert.equal(r.parsed_shape.commands.length, 2);
  });

  // --- review_each_time ---
  it('review_each_time: always flags, never_reuse', () => {
    const r = validateInputValue('anything', { approval_mode: 'review_each_time', type: 'string' });
    assert.equal(r.valid, true);
    assert.ok(r.risk_traits.includes('free_text_instruction'));
    assert.equal(r.never_reuse, true);
  });

  it('no constraints → inferred review_each_time', () => {
    const r = validateInputValue('anything', { type: 'string' });
    assert.equal(r.valid, true);
    assert.ok(r.never_reuse);
  });

  // --- path_policy ---
  it('path_policy mode delegates to validatePathPolicy', () => {
    const r = validateInputValue('src/utils.js', {
      approval_mode: 'path_policy', type: 'string',
      rules: { must_be_relative: true, allowed_roots: ['src/'] },
    });
    assert.equal(r.valid, true);
    assert.equal(r.risk_traits.length, 0);
  });

  // --- hard limits ---
  it('string exceeding max length → block', () => {
    const long = 'a'.repeat(HARD_LIMITS.max_string_length + 1);
    const r = validateInputValue(long, { type: 'string', pattern: '.*' });
    assert.equal(r.valid, false);
    assert.ok(r.risk_traits.includes('exceeds_hard_limit'));
  });

  // --- boolean ---
  it('boolean true passes', () => {
    const r = validateInputValue('true', { type: 'boolean' });
    assert.equal(r.valid, true);
    assert.equal(r.normalized, true);
  });

  it('boolean false passes', () => {
    const r = validateInputValue(false, { type: 'boolean' });
    assert.equal(r.valid, true);
    assert.equal(r.normalized, false);
  });
});

// ===========================================================================
// Integration: resolveInputs with risk traits
// ===========================================================================

describe('Integration: resolveInputs with validation', () => {
  // Import dynamically since recipe-runner imports many modules
  it('resolveInputs returns flagged for risky values', async () => {
    const { resolveInputs } = await import('../src/recipe-runner.js');
    const recipe = {
      inputs: {
        cmd: { type: 'string', pattern: '.*' },
        env: { type: 'string', enum: ['staging', 'production'] },
      },
    };
    const { resolved, flagged } = resolveInputs(recipe, {
      cmd: 'npm test && rm -rf /',
      env: 'production',
    });
    assert.ok(flagged.length > 0);
    const cmdFlag = flagged.find(f => f.key === 'cmd');
    assert.ok(cmdFlag);
    assert.ok(cmdFlag.traits.includes('execution_chaining'));
    assert.ok(cmdFlag.traits.includes('destructive_intent'));

    const envFlag = flagged.find(f => f.key === 'env');
    assert.ok(envFlag);
    assert.ok(envFlag.traits.includes('prod_target_reference'));
  });

  it('resolveInputs returns no flagged for safe values', async () => {
    const { resolveInputs } = await import('../src/recipe-runner.js');
    const recipe = {
      inputs: { name: { type: 'string', enum: ['dev', 'test'] } },
    };
    const { resolved, flagged } = resolveInputs(recipe, { name: 'dev' });
    assert.equal(flagged.length, 0);
    assert.equal(resolved.name, 'dev');
  });

  it('cross-parameter escalation fires', async () => {
    const { resolveInputs } = await import('../src/recipe-runner.js');
    const recipe = {
      inputs: {
        path: { type: 'string', pattern: '.*' },
        count: { type: 'integer', min: 0, max: 10000 },
      },
    };
    const { flagged } = resolveInputs(recipe, { path: 'src/**/*.js', count: '500' });
    const allTraits = flagged.flatMap(f => f.traits);
    // path has high_cardinality (glob) and count has high_cardinality (wide range)
    // scope_widening from glob + high_cardinality → should see escalation
    assert.ok(allTraits.includes('high_cardinality_input'));
  });
});
