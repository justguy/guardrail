import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  validateTemplate,
  lintTemplate,
  loadTemplate,
  validateUserInputs,
  interpolateArgs,
  buildResolvedSteps,
  buildResolvedRollbackSteps,
  computeEnvIntersection,
  hashTemplateExecution,
  createTemplateManifest,
  diffTemplateManifests,
  compareTemplateManifests,
  explainTemplate,
  describeSchema,
  simulateTemplate,
  evaluateTemplateRisk,
  TemplateValidationError,
} from '../src/template.js';

import { serializeStable } from '../src/contract.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeIndividualTemplate(overrides = {}) {
  return {
    version: 1,
    kind: 'template',
    name: 'lint-project',
    description: 'Run linter on the project.',
    trust_class: 'reviewed_internal',
    risk: 'green',
    risk_reasons: [],
    inputs: {
      target: {
        type: 'string',
        pattern: '^(src|lib|tests)$',
        description: 'Directory to lint',
      },
    },
    run: {
      command: 'eslint',
      args: ['{{inputs.target}}'],
      mode: 'structured',
      env: { allow: [] },
    },
    idempotent: true,
    ...overrides,
  };
}

function makeWorkflowTemplate(overrides = {}) {
  return {
    version: 1,
    kind: 'workflow_template',
    name: 'standard-npm-publish',
    description: 'Publishes a scoped package to the npm registry.',
    trust_class: 'reviewed_internal',
    risk: 'yellow',
    risk_reasons: ['installs from registry', 'writes to npm'],
    inputs: {
      package_dir: {
        type: 'string',
        pattern: '^packages/[a-z0-9-]+$',
        description: 'Relative path to the package directory',
      },
      tag: {
        type: 'string',
        enum: ['latest', 'beta', 'next'],
        default: 'latest',
        description: 'npm dist-tag to publish under',
      },
    },
    requires_env: ['NPM_TOKEN'],
    steps: [
      {
        id: 'publish',
        description: 'Publish the package',
        run: {
          command: 'npm',
          args: ['publish', '{{inputs.package_dir}}', '--tag', '{{inputs.tag}}'],
          mode: 'structured',
          env: { allow: ['NPM_TOKEN'] },
        },
        idempotent: false,
        validator: {
          regex: '\\+ [a-z@][a-z0-9@/_.-]+@[0-9]+\\.[0-9]+\\.[0-9]+',
        },
      },
    ],
    rollback: {
      steps: [
        {
          id: 'unpublish-on-failure',
          description: 'Unpublish if publish partially succeeded',
          run: {
            command: 'npm',
            args: ['unpublish', '{{inputs.package_dir}}', '--force'],
            mode: 'structured',
            env: { allow: ['NPM_TOKEN'] },
          },
          idempotent: true,
        },
      ],
    },
    ...overrides,
  };
}

// =========================================================================
// 1. Template Validation
// =========================================================================

describe('Template Validation', () => {
  it('accepts a valid individual template', () => {
    assert.doesNotThrow(() => validateTemplate(makeIndividualTemplate()));
  });

  it('accepts a valid workflow template', () => {
    assert.doesNotThrow(() => validateTemplate(makeWorkflowTemplate()));
  });

  it('rejects invalid version', () => {
    assert.throws(
      () => validateTemplate(makeIndividualTemplate({ version: 2 })),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /version/.test(e)),
    );
  });

  it('rejects invalid kind', () => {
    assert.throws(
      () => validateTemplate(makeIndividualTemplate({ kind: 'bad' })),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /kind/.test(e)),
    );
  });

  it('rejects name with uppercase or special chars', () => {
    assert.throws(
      () => validateTemplate(makeIndividualTemplate({ name: 'My_Template!' })),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /name/.test(e)),
    );
  });

  it('rejects empty description', () => {
    assert.throws(
      () => validateTemplate(makeIndividualTemplate({ description: '' })),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /description/.test(e)),
    );
  });

  it('rejects invalid trust_class', () => {
    assert.throws(
      () => validateTemplate(makeIndividualTemplate({ trust_class: 'trusted' })),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /trust_class/.test(e)),
    );
  });

  it('rejects invalid risk level', () => {
    assert.throws(
      () => validateTemplate(makeIndividualTemplate({ risk: 'orange' })),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /risk/.test(e)),
    );
  });

  it('rejects empty inputs object', () => {
    assert.throws(
      () => validateTemplate(makeIndividualTemplate({ inputs: {} })),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /at least one field/.test(e)),
    );
  });

  it('rejects bare string input without pattern or enum', () => {
    const def = makeIndividualTemplate({
      inputs: { name: { type: 'string', description: 'A name' } },
    });
    assert.throws(
      () => validateTemplate(def),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /pattern.*enum/.test(e)),
    );
  });

  it('rejects invalid regex pattern', () => {
    const def = makeIndividualTemplate({
      inputs: { x: { type: 'string', pattern: '[invalid' } },
    });
    assert.throws(
      () => validateTemplate(def),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /invalid pattern regex/.test(e)),
    );
  });

  it('rejects non-structured mode in run block', () => {
    const def = makeIndividualTemplate();
    def.run.mode = 'shell';
    assert.throws(
      () => validateTemplate(def),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /structured/.test(e)),
    );
  });

  it('rejects workflow_template without steps', () => {
    assert.throws(
      () => validateTemplate(makeWorkflowTemplate({ steps: [] })),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /non-empty array/.test(e)),
    );
  });

  it('rejects duplicate step ids in workflow_template', () => {
    const def = makeWorkflowTemplate();
    def.steps.push({ ...def.steps[0] }); // duplicate id
    assert.throws(
      () => validateTemplate(def),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /duplicate/.test(e)),
    );
  });

  it('requires rollback when idempotent: false', () => {
    const def = makeWorkflowTemplate({ rollback: undefined });
    assert.throws(
      () => validateTemplate(def),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /rollback/.test(e)),
    );
  });

  it('does not require rollback when all steps are idempotent', () => {
    const def = makeWorkflowTemplate();
    def.steps[0].idempotent = true;
    delete def.rollback;
    assert.doesNotThrow(() => validateTemplate(def));
  });

  it('validates requires_env', () => {
    const def = makeIndividualTemplate({ requires_env: [123] });
    assert.throws(
      () => validateTemplate(def),
      (err) => err instanceof TemplateValidationError && err.errors.some(e => /requires_env/.test(e)),
    );
  });
});

// =========================================================================
// 2. Template Lint
// =========================================================================

describe('Template Lint', () => {
  it('returns no warnings for a clean template', () => {
    const warnings = lintTemplate(makeIndividualTemplate());
    assert.equal(warnings.length, 0);
  });

  it('warns about bare strings', () => {
    // Create a template that would fail validation, but lint checks independently
    const def = {
      ...makeIndividualTemplate(),
      inputs: { x: { type: 'string', description: 'bare' } },
    };
    const warnings = lintTemplate(def);
    assert.ok(warnings.some(w => /bare string/.test(w)));
  });

  it('warns about unresolved interpolation references', () => {
    const def = makeIndividualTemplate();
    def.run.args = ['{{inputs.nonexistent}}'];
    const warnings = lintTemplate(def);
    assert.ok(warnings.some(w => /undeclared input.*nonexistent/.test(w)));
  });

  it('warns about non-structured mode', () => {
    const def = makeIndividualTemplate();
    def.run.mode = 'shell';
    const warnings = lintTemplate(def);
    assert.ok(warnings.some(w => /structured/.test(w)));
  });

  it('warns about risk inconsistency (declared < computed)', () => {
    const def = makeIndividualTemplate({ trust_class: 'unknown', risk: 'green' });
    const warnings = lintTemplate(def);
    assert.ok(warnings.some(w => /lower than computed/.test(w)));
  });

  it('warns about secret patterns in requires_env', () => {
    const def = makeIndividualTemplate({ requires_env: ['AWS_SECRET_KEY'] });
    const warnings = lintTemplate(def);
    assert.ok(warnings.some(w => /secret pattern/.test(w)));
  });

  it('detects potential ReDoS in input patterns', () => {
    const def = makeIndividualTemplate({
      inputs: {
        x: { type: 'string', pattern: '(a+)+b' },
      },
    });
    const warnings = lintTemplate(def);
    assert.ok(warnings.some(w => /ReDoS|backtracking/.test(w)));
  });
});

// =========================================================================
// 3. Input Validation
// =========================================================================

describe('Input Validation', () => {
  it('validates correct inputs', () => {
    const schema = makeIndividualTemplate().inputs;
    const result = validateUserInputs(schema, { target: 'src' });
    assert.ok(result.valid);
    assert.equal(result.values.target, 'src');
  });

  it('applies default values', () => {
    const schema = makeWorkflowTemplate().inputs;
    const result = validateUserInputs(schema, { package_dir: 'packages/my-lib' });
    assert.ok(result.valid);
    assert.equal(result.values.tag, 'latest');
  });

  it('rejects missing required inputs', () => {
    const schema = makeIndividualTemplate().inputs;
    const result = validateUserInputs(schema, {});
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => /missing required/.test(e)));
  });

  it('rejects input that fails pattern', () => {
    const schema = makeIndividualTemplate().inputs;
    const result = validateUserInputs(schema, { target: '../../../etc/passwd' });
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => /does not match pattern/.test(e)));
  });

  it('rejects input not in enum', () => {
    const schema = makeWorkflowTemplate().inputs;
    const result = validateUserInputs(schema, {
      package_dir: 'packages/my-lib',
      tag: 'experimental',
    });
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => /not in allowed values/.test(e)));
  });

  it('validates integer inputs with range', () => {
    const schema = {
      count: { type: 'integer', min: 1, max: 10, description: 'Count' },
    };
    assert.ok(validateUserInputs(schema, { count: 5 }).valid);
    assert.ok(validateUserInputs(schema, { count: '5' }).valid);
    assert.ok(!validateUserInputs(schema, { count: 0 }).valid);
    assert.ok(!validateUserInputs(schema, { count: 11 }).valid);
    assert.ok(!validateUserInputs(schema, { count: 'abc' }).valid);
  });

  it('validates boolean inputs', () => {
    const schema = {
      dry: { type: 'boolean', description: 'Dry run' },
    };
    assert.ok(validateUserInputs(schema, { dry: true }).valid);
    assert.ok(validateUserInputs(schema, { dry: 'true' }).valid);
    assert.ok(validateUserInputs(schema, { dry: 'false' }).valid);
    assert.ok(!validateUserInputs(schema, { dry: 'yes' }).valid);
  });

  it('warns about shell metacharacters in input values', () => {
    const schema = makeIndividualTemplate({
      inputs: { target: { type: 'string', enum: ['src; rm -rf /'] } },
    }).inputs;
    const result = validateUserInputs(schema, { target: 'src; rm -rf /' });
    assert.ok(result.valid); // still valid — structured mode makes it safe
    assert.ok(result.warnings.some(w => /shell metacharacters/.test(w)));
  });
});

// =========================================================================
// 4. Interpolation
// =========================================================================

describe('Interpolation', () => {
  it('interpolates {{inputs.x}} with validated values', () => {
    const result = interpolateArgs(
      ['--tag', '{{inputs.tag}}', '{{inputs.dir}}'],
      { tag: 'beta', dir: 'packages/my-lib' },
    );
    assert.deepEqual(result, ['--tag', 'beta', 'packages/my-lib']);
  });

  it('each interpolation produces exactly one arg element', () => {
    const result = interpolateArgs(
      ['{{inputs.path}}'],
      { path: 'my path with spaces' },
    );
    assert.equal(result.length, 1);
    assert.equal(result[0], 'my path with spaces');
  });

  it('unresolved references produce empty string', () => {
    const result = interpolateArgs(['{{inputs.missing}}'], {});
    assert.deepEqual(result, ['']);
  });

  it('non-template strings pass through unchanged', () => {
    const result = interpolateArgs(['--force', 'literal'], {});
    assert.deepEqual(result, ['--force', 'literal']);
  });

  it('handles mixed template and literal in same string', () => {
    const result = interpolateArgs(
      ['prefix-{{inputs.name}}-suffix'],
      { name: 'foo' },
    );
    assert.deepEqual(result, ['prefix-foo-suffix']);
  });

  it('expands exact list placeholders into multiple args', () => {
    const result = interpolateArgs(
      ['--runTestsByPath', '{{inputs.test_files}}'],
      { test_files: ['tests/a.test.js', 'tests/b.test.js'] },
    );
    assert.deepEqual(result, ['--runTestsByPath', 'tests/a.test.js', 'tests/b.test.js']);
  });
});

// =========================================================================
// 5. Build Resolved Steps
// =========================================================================

describe('Build Resolved Steps', () => {
  it('builds resolved steps for individual template', () => {
    const def = makeIndividualTemplate();
    const steps = buildResolvedSteps(def, { target: 'src' });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].id, 'lint-project');
    assert.deepEqual(steps[0].run.args, ['src']);
    assert.equal(steps[0].run.mode, 'structured');
  });

  it('builds resolved steps for workflow template', () => {
    const def = makeWorkflowTemplate();
    const steps = buildResolvedSteps(def, {
      package_dir: 'packages/my-lib',
      tag: 'beta',
    });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].id, 'publish');
    assert.deepEqual(steps[0].run.args, ['publish', 'packages/my-lib', '--tag', 'beta']);
  });

  it('builds resolved rollback steps', () => {
    const def = makeWorkflowTemplate();
    const steps = buildResolvedRollbackSteps(def, {
      package_dir: 'packages/my-lib',
      tag: 'beta',
    });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].id, 'unpublish-on-failure');
    assert.deepEqual(steps[0].run.args, ['unpublish', 'packages/my-lib', '--force']);
  });

  it('returns empty array for templates without rollback', () => {
    const def = makeIndividualTemplate();
    const steps = buildResolvedRollbackSteps(def, { target: 'src' });
    assert.equal(steps.length, 0);
  });
});

// =========================================================================
// 6. Environment Handshake
// =========================================================================

describe('Environment Handshake', () => {
  it('computes intersection correctly', () => {
    const result = computeEnvIntersection(
      ['NPM_TOKEN', 'AWS_KEY'],
      ['NPM_TOKEN', 'HOME'],
    );
    assert.deepEqual(result.intersection, ['NPM_TOKEN']);
    assert.deepEqual(result.denied, ['AWS_KEY']);
  });

  it('passes all when caller allows all', () => {
    const result = computeEnvIntersection(
      ['NPM_TOKEN', 'CI'],
      ['NPM_TOKEN', 'CI', 'HOME'],
    );
    assert.deepEqual(result.intersection, ['CI', 'NPM_TOKEN']);
    assert.deepEqual(result.denied, []);
  });

  it('warns about secret patterns in intersection', () => {
    const result = computeEnvIntersection(
      ['NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY'],
      ['NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY'],
    );
    assert.ok(result.warnings.some(w => /secret.*NPM_TOKEN/.test(w)));
    assert.ok(result.warnings.some(w => /secret.*AWS_SECRET_ACCESS_KEY/.test(w)));
  });

  it('empty requires_env produces empty intersection', () => {
    const result = computeEnvIntersection([], ['NPM_TOKEN']);
    assert.deepEqual(result.intersection, []);
    assert.deepEqual(result.denied, []);
  });
});

// =========================================================================
// 7. Cryptographic Provenance
// =========================================================================

describe('Cryptographic Provenance', () => {
  it('same template + inputs + env produce same hash', () => {
    const def = makeWorkflowTemplate();
    const inputs = { package_dir: 'packages/my-lib', tag: 'beta' };
    const env = ['NPM_TOKEN'];
    const h1 = hashTemplateExecution(def, inputs, env);
    const h2 = hashTemplateExecution(def, inputs, env);
    assert.equal(h1, h2);
  });

  it('different inputs change the hash', () => {
    const def = makeWorkflowTemplate();
    const env = ['NPM_TOKEN'];
    const h1 = hashTemplateExecution(def, { package_dir: 'packages/a', tag: 'latest' }, env);
    const h2 = hashTemplateExecution(def, { package_dir: 'packages/b', tag: 'latest' }, env);
    assert.notEqual(h1, h2);
  });

  it('different env intersection changes the hash', () => {
    const def = makeWorkflowTemplate();
    const inputs = { package_dir: 'packages/a', tag: 'latest' };
    const h1 = hashTemplateExecution(def, inputs, ['NPM_TOKEN']);
    const h2 = hashTemplateExecution(def, inputs, []);
    assert.notEqual(h1, h2);
  });

  it('template definition change changes the hash', () => {
    const def1 = makeWorkflowTemplate();
    const def2 = makeWorkflowTemplate({ description: 'Modified description' });
    const inputs = { package_dir: 'packages/a', tag: 'latest' };
    const env = ['NPM_TOKEN'];
    const h1 = hashTemplateExecution(def1, inputs, env);
    const h2 = hashTemplateExecution(def2, inputs, env);
    assert.notEqual(h1, h2);
  });
});

// =========================================================================
// 8. Template Manifest
// =========================================================================

describe('Template Manifest', () => {
  it('creates a manifest with expected fields', () => {
    const def = makeWorkflowTemplate();
    const hash = 'abc123';
    const risk = { trustClass: 'reviewed_internal', riskLevel: 'yellow', reasons: ['writes to npm'] };
    const inputs = { package_dir: 'packages/my-lib', tag: 'beta' };
    const env = ['NPM_TOKEN'];

    const manifest = createTemplateManifest(def, hash, risk, inputs, env);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.tool, 'guardrail');
    assert.equal(manifest.kind, 'template');
    assert.equal(manifest.template, 'standard-npm-publish');
    assert.equal(manifest.templateKind, 'workflow_template');
    assert.equal(manifest.templateHash, 'abc123');
    assert.equal(typeof manifest.templateDefHash, 'string');
    assert.deepEqual(manifest.inputApprovalEnvelopes, {
      tag: { type: 'enum', values: ['latest', 'beta', 'next'] },
    });
    assert.deepEqual(manifest.resolvedInputs, inputs);
    assert.deepEqual(manifest.envIntersection, env);
    assert.equal(manifest.riskAssessment.riskLevel, 'yellow');
  });

  it('diff detects template definition change', () => {
    const base = createTemplateManifest(
      makeWorkflowTemplate(), 'hash1',
      { trustClass: 'reviewed_internal', riskLevel: 'yellow', reasons: [] },
      { package_dir: 'packages/a' }, ['NPM_TOKEN'],
    );
    const changed = createTemplateManifest(
      makeWorkflowTemplate({ description: 'Updated workflow template description' }), 'hash1',
      { trustClass: 'reviewed_internal', riskLevel: 'yellow', reasons: [] },
      { package_dir: 'packages/a' }, ['NPM_TOKEN'],
    );

    const diffs = diffTemplateManifests(changed, base);
    assert.ok(diffs.some(d => /templateDefHash/.test(d)));
  });

  it('diff detects input change', () => {
    const risk = { trustClass: 'reviewed_internal', riskLevel: 'yellow', reasons: [] };
    const base = createTemplateManifest(makeWorkflowTemplate(), 'h', risk, { package_dir: 'packages/a' }, []);
    const changed = createTemplateManifest(makeWorkflowTemplate(), 'h', risk, { package_dir: 'packages/b' }, []);

    const diffs = diffTemplateManifests(changed, base);
    assert.ok(diffs.some(d => /package_dir/.test(d)));
  });

  it('compare returns matches: true for identical manifests', () => {
    const risk = { trustClass: 'reviewed_internal', riskLevel: 'yellow', reasons: [] };
    const m = createTemplateManifest(makeWorkflowTemplate(), 'h', risk, {}, []);
    const result = compareTemplateManifests(m, m);
    assert.ok(result.matches);
    assert.equal(result.diffs.length, 0);
  });

  it('allows enum input drift within approved approval envelope', () => {
    const risk = { trustClass: 'reviewed_internal', riskLevel: 'yellow', reasons: [] };
    const base = createTemplateManifest(
      makeWorkflowTemplate(),
      'h-base',
      risk,
      { package_dir: 'packages/a', tag: 'latest' },
      ['NPM_TOKEN'],
    );
    const candidate = createTemplateManifest(
      makeWorkflowTemplate(),
      'h-candidate',
      risk,
      { package_dir: 'packages/a', tag: 'beta' },
      ['NPM_TOKEN'],
    );

    const result = compareTemplateManifests(candidate, base);
    assert.ok(result.matches);
    assert.equal(result.diffs.length, 0);
  });

  it('does not widen explicit exact approval mode even when enum is present', () => {
    const def = makeWorkflowTemplate({
      inputs: {
        package_dir: { type: 'string', pattern: '^packages/[a-z0-9-]+$' },
        tag: { type: 'string', enum: ['latest', 'beta'], approval_mode: 'exact' },
      },
    });

    const risk = { trustClass: 'reviewed_internal', riskLevel: 'yellow', reasons: [] };
    const base = createTemplateManifest(def, 'h-base', risk, { package_dir: 'packages/a', tag: 'latest' }, []);
    const candidate = createTemplateManifest(def, 'h-candidate', risk, { package_dir: 'packages/a', tag: 'beta' }, []);

    const result = compareTemplateManifests(candidate, base);
    assert.ok(!result.matches);
    assert.ok(result.diffs.some(d => /input "tag"/.test(d)));
  });

  it('allows integer range input drift within approved approval envelope', () => {
    const def = makeIndividualTemplate({
      name: 'bounded-retries',
      description: 'Bounded integer retry demo',
      inputs: { retries: { type: 'integer', min: 1, max: 5, description: 'retry count' } },
      run: { command: 'sleep', args: ['{{inputs.retries}}'], mode: 'structured', env: {} },
    });

    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] };
    const base = createTemplateManifest(def, 'h-base', risk, { retries: 2 }, []);
    const candidate = createTemplateManifest(def, 'h-candidate', risk, { retries: 4 }, []);

    const result = compareTemplateManifests(candidate, base);
    assert.ok(result.matches);
    assert.equal(result.diffs.length, 0);
  });

  it('allows list input drift within approved approval envelope', () => {
    const def = makeIndividualTemplate({
      name: 'bounded-test-runner',
      description: 'Run bounded test files',
      inputs: {
        test_files: {
          type: 'string',
          approval_mode: 'list',
          max_items: 4,
          item_validator: {
            type: 'string',
            approval_mode: 'path_policy',
            rules: {
              must_be_relative: true,
              allowed_roots: ['tests/'],
              deny_segments: ['..'],
              allowed_extensions: ['.js'],
              max_depth: 4,
            },
          },
          description: 'Relative test files',
        },
      },
      run: { command: 'node', args: ['--test', '{{inputs.test_files}}'], mode: 'structured', env: {} },
    });

    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] };
    const base = createTemplateManifest(def, 'h-base', risk, { test_files: ['tests/a.test.js'] }, []);
    const candidate = createTemplateManifest(def, 'h-candidate', risk, { test_files: ['tests/b.test.js', 'tests/c.test.js'] }, []);

    const result = compareTemplateManifests(candidate, base);
    assert.ok(result.matches);
    assert.equal(result.diffs.length, 0);
  });

  it('fails when list input leaves approved approval envelope', () => {
    const def = makeIndividualTemplate({
      name: 'bounded-test-runner',
      description: 'Run bounded test files',
      inputs: {
        test_files: {
          type: 'string',
          approval_mode: 'list',
          max_items: 2,
          item_validator: {
            type: 'string',
            approval_mode: 'path_policy',
            rules: {
              must_be_relative: true,
              allowed_roots: ['tests/'],
              deny_segments: ['..'],
              allowed_extensions: ['.js'],
              max_depth: 4,
            },
          },
          description: 'Relative test files',
        },
      },
      run: { command: 'node', args: ['--test', '{{inputs.test_files}}'], mode: 'structured', env: {} },
    });

    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] };
    const approved = createTemplateManifest(def, 'h-base', risk, { test_files: ['tests/a.test.js'] }, []);
    const candidate = createTemplateManifest(def, 'h-candidate', risk, { test_files: ['src/not-allowed.js'] }, []);

    const result = compareTemplateManifests(candidate, approved);
    assert.ok(!result.matches);
    assert.ok(result.diffs.some(d => /outside approved envelope/.test(d)));
    assert.ok(result.diffs.some(d => /test_files/.test(d)));
  });

  it('fails when integer input drifts outside approved approval envelope', () => {
    const def = makeIndividualTemplate({
      name: 'bounded-retries',
      description: 'Bounded integer retry demo',
      inputs: { retries: { type: 'integer', min: 1, max: 5, description: 'retry count' } },
      run: { command: 'sleep', args: ['{{inputs.retries}}'], mode: 'structured', env: {} },
    });

    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] };
    const approved = createTemplateManifest(def, 'h-base', risk, { retries: 2 }, []);
    const candidate = createTemplateManifest(def, 'h-candidate', risk, { retries: 11 }, []);

    const result = compareTemplateManifests(candidate, approved);
    assert.ok(!result.matches);
    assert.ok(result.diffs.some(d => /outside approved envelope/.test(d)));
    assert.ok(result.diffs.some(d => /retries/.test(d)));
  });

  it('falls back to exact matching when approval envelope metadata is missing', () => {
    const risk = { trustClass: 'reviewed_internal', riskLevel: 'yellow', reasons: [] };
    const oldApproved = createTemplateManifest(
      makeWorkflowTemplate(),
      'h-base',
      risk,
      { package_dir: 'packages/a', tag: 'latest' },
      ['NPM_TOKEN'],
    );
    delete oldApproved.inputApprovalEnvelopes;
    delete oldApproved.templateDefHash;

    const candidate = createTemplateManifest(
      makeWorkflowTemplate(),
      'h-candidate',
      risk,
      { package_dir: 'packages/b', tag: 'beta' },
      ['NPM_TOKEN'],
    );

    const result = diffTemplateManifests(candidate, oldApproved);
    assert.ok(result.some(d => /package_dir/.test(d)));
    assert.ok(result.some(d => /templateHash/.test(d)));
  });
});

// =========================================================================
// 9. Explain
// =========================================================================

describe('Template Explain', () => {
  it('explains individual template', () => {
    const text = explainTemplate(makeIndividualTemplate());
    assert.ok(text.includes('lint-project'));
    assert.ok(text.includes('eslint'));
    assert.ok(text.includes('GREEN'));
    assert.ok(text.includes('single command'));
    assert.ok(text.includes('target'));
  });

  it('explains workflow template', () => {
    const text = explainTemplate(makeWorkflowTemplate());
    assert.ok(text.includes('standard-npm-publish'));
    assert.ok(text.includes('npm'));
    assert.ok(text.includes('YELLOW'));
    assert.ok(text.includes('multi-step workflow'));
    assert.ok(text.includes('NPM_TOKEN'));
    assert.ok(text.includes('rollback'));
  });
});

// =========================================================================
// 10. Schema Description
// =========================================================================

describe('Template Schema', () => {
  it('describes input schema', () => {
    const text = describeSchema(makeWorkflowTemplate());
    assert.ok(text.includes('package_dir'));
    assert.ok(text.includes('pattern:'));
    assert.ok(text.includes('tag'));
    assert.ok(text.includes('enum:'));
    assert.ok(text.includes('default:'));
    assert.ok(text.includes('NPM_TOKEN'));
  });
});

// =========================================================================
// 11. Simulate
// =========================================================================

describe('Template Simulate', () => {
  it('simulates individual template execution', () => {
    const def = makeIndividualTemplate();
    const result = simulateTemplate(def, { target: 'src' }, []);
    assert.equal(result.errors.length, 0);
    assert.ok(result.output.includes('Simulation'));
    assert.ok(result.output.includes('eslint'));
    assert.ok(result.output.includes('"src"'));
    assert.ok(result.output.includes('No processes were spawned'));
  });

  it('simulates workflow template execution', () => {
    const def = makeWorkflowTemplate();
    const result = simulateTemplate(
      def,
      { package_dir: 'packages/my-lib', tag: 'beta' },
      ['NPM_TOKEN'],
    );
    assert.equal(result.errors.length, 0);
    assert.ok(result.output.includes('npm'));
    assert.ok(result.output.includes('packages/my-lib'));
    assert.ok(result.output.includes('beta'));
    assert.ok(result.output.includes('NPM_TOKEN'));
    assert.ok(result.output.includes('Rollback'));
  });

  it('reports validation errors in simulate', () => {
    const def = makeIndividualTemplate();
    const result = simulateTemplate(def, {}, []);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some(e => /missing required/.test(e)));
  });

  it('shows env denial warnings', () => {
    const def = makeWorkflowTemplate();
    const result = simulateTemplate(
      def,
      { package_dir: 'packages/my-lib', tag: 'beta' },
      [], // caller allows nothing
    );
    assert.equal(result.errors.length, 0);
    assert.ok(result.output.includes('NPM_TOKEN'));
    assert.ok(result.output.includes('does not allow'));
  });
});

// =========================================================================
// 12. Risk Evaluation
// =========================================================================

describe('Template Risk Evaluation', () => {
  it('uses declared risk for trusted templates', () => {
    const def = makeIndividualTemplate({ risk: 'green', trust_class: 'reviewed_internal' });
    const result = evaluateTemplateRisk(def, []);
    assert.equal(result.riskLevel, 'green');
    assert.equal(result.trustClass, 'reviewed_internal');
    assert.equal(result.requiresStrongConfirmation, false);
  });

  it('escalates to red for unknown trust', () => {
    const def = makeIndividualTemplate({ risk: 'green', trust_class: 'unknown' });
    const result = evaluateTemplateRisk(def, []);
    assert.equal(result.riskLevel, 'red');
    assert.equal(result.requiresStrongConfirmation, true);
    assert.ok(result.reasons.includes('untrusted provenance'));
  });

  it('escalates to red for generated trust', () => {
    const def = makeIndividualTemplate({ risk: 'green', trust_class: 'generated' });
    const result = evaluateTemplateRisk(def, []);
    assert.equal(result.riskLevel, 'red');
  });

  it('flags secret env vars in risk assessment', () => {
    const def = makeWorkflowTemplate();
    const result = evaluateTemplateRisk(def, ['NPM_TOKEN']);
    assert.ok(result.reasons.includes('secret in env handshake'));
  });
});

// =========================================================================
// 13. Load from file
// =========================================================================

describe('Load Template from File', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardrail-tpl-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid template file', () => {
    const filePath = join(tmpDir, 'valid.json');
    writeFileSync(filePath, JSON.stringify(makeIndividualTemplate()));
    const def = loadTemplate(filePath);
    assert.equal(def.name, 'lint-project');
  });

  it('loads a valid workflow template file', () => {
    const filePath = join(tmpDir, 'workflow.json');
    writeFileSync(filePath, JSON.stringify(makeWorkflowTemplate()));
    const def = loadTemplate(filePath);
    assert.equal(def.name, 'standard-npm-publish');
    assert.equal(def.kind, 'workflow_template');
  });

  it('throws on missing file', () => {
    assert.throws(() => loadTemplate(join(tmpDir, 'nope.json')), /Cannot read template/);
  });

  it('throws on invalid JSON', () => {
    const filePath = join(tmpDir, 'bad.json');
    writeFileSync(filePath, '{not json}');
    assert.throws(() => loadTemplate(filePath), /Invalid JSON/);
  });

  it('throws on structurally invalid template', () => {
    const filePath = join(tmpDir, 'invalid.json');
    writeFileSync(filePath, JSON.stringify({ version: 1, kind: 'template' }));
    assert.throws(() => loadTemplate(filePath), /Template validation failed/);
  });
});

// =========================================================================
// 14. Both template kinds use the same hash/manifest infrastructure
// =========================================================================

describe('Individual vs Workflow Template Parity', () => {
  it('both kinds produce manifests with the same structure', () => {
    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] };
    const m1 = createTemplateManifest(makeIndividualTemplate(), 'h1', risk, { target: 'src' }, []);
    const m2 = createTemplateManifest(makeWorkflowTemplate(), 'h2', risk, { package_dir: 'packages/a' }, ['NPM_TOKEN']);

    // Both manifests should have the same top-level structure
    const keys1 = Object.keys(m1).sort();
    const keys2 = Object.keys(m2).sort();
    assert.deepEqual(keys1, keys2);
  });

  it('individual template kind is recorded in manifest', () => {
    const risk = { trustClass: 'reviewed_internal', riskLevel: 'green', reasons: [] };
    const m = createTemplateManifest(makeIndividualTemplate(), 'h', risk, {}, []);
    assert.equal(m.templateKind, 'template');
  });

  it('workflow template kind is recorded in manifest', () => {
    const risk = { trustClass: 'reviewed_internal', riskLevel: 'yellow', reasons: [] };
    const m = createTemplateManifest(makeWorkflowTemplate(), 'h', risk, {}, []);
    assert.equal(m.templateKind, 'workflow_template');
  });

  it('lint works on both kinds', () => {
    assert.ok(Array.isArray(lintTemplate(makeIndividualTemplate())));
    assert.ok(Array.isArray(lintTemplate(makeWorkflowTemplate())));
  });

  it('explain works on both kinds', () => {
    assert.ok(typeof explainTemplate(makeIndividualTemplate()) === 'string');
    assert.ok(typeof explainTemplate(makeWorkflowTemplate()) === 'string');
  });

  it('simulate works on both kinds', () => {
    const r1 = simulateTemplate(makeIndividualTemplate(), { target: 'src' }, []);
    const r2 = simulateTemplate(makeWorkflowTemplate(), { package_dir: 'packages/a', tag: 'beta' }, ['NPM_TOKEN']);
    assert.equal(r1.errors.length, 0);
    assert.equal(r2.errors.length, 0);
  });
});
