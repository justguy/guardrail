import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRisk, evaluateWorkflowRisk } from '../src/policy-engine.js';
import { checkDangerous, checkScope, dryRun } from '../src/recipe-executor.js';
import { enforceChannel, signRecipe } from '../src/recipe-channel.js';
import { checkSafeDefaults, computeDefaults } from '../src/safe-defaults.js';
import { createIdentity, createStrictMode } from '../src/identity.js';
import { validateRecipe } from '../src/recipe.js';

// ===========================================================================
// Declarative Policy Scenarios
//
// Each scenario is: { name, actor?, environment?, contract/recipe, expected }
// Tests prove the policy engine produces the correct decision.
// ===========================================================================

const POLICY_SCENARIOS = [
  // --- GREEN scenarios ---
  {
    name: 'safe local test → GREEN',
    contract: { command: 'npm', args: ['test'], cwd: '/project', mode: 'structured' },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'green' },
  },
  {
    name: 'safe git status → GREEN',
    contract: { command: 'git', args: ['status'], cwd: '/project', mode: 'structured' },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'green' },
  },
  {
    name: 'safe echo → GREEN',
    contract: { command: 'echo', args: ['hello'], cwd: '/project', mode: 'structured' },
    options: { trustClass: 'pinned_external', projectRoot: '/project' },
    expected: { riskLevel: 'green' },
  },

  // --- YELLOW scenarios ---
  {
    name: 'shell mode → YELLOW (at least)',
    contract: { command: '', args: [], cwd: '/project', mode: 'shell', shell: 'echo hi' },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'yellow' },
  },
  {
    name: 'env inheritance → YELLOW',
    contract: {
      command: 'node', args: ['app.js'], cwd: '/project', mode: 'structured',
      envPolicy: { inherit: true },
    },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'yellow' },
  },

  // --- RED scenarios ---
  {
    name: 'generated trust class → RED',
    contract: { command: 'node', args: ['app.js'], cwd: '/project', mode: 'structured' },
    options: { trustClass: 'generated', projectRoot: '/project' },
    expected: { riskLevel: 'red' },
  },
  {
    name: 'unknown trust class → RED',
    contract: { command: 'node', args: ['app.js'], cwd: '/project', mode: 'structured' },
    options: { trustClass: 'unknown', projectRoot: '/project' },
    expected: { riskLevel: 'red' },
  },
  {
    name: 'production target → RED',
    contract: {
      command: 'node', args: ['deploy.js', '--env', 'production'], cwd: '/project', mode: 'structured',
    },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'red', reasonContains: 'production' },
  },
  {
    name: 'sudo → RED',
    contract: { command: 'sudo', args: ['apt', 'install', 'nginx'], cwd: '/project', mode: 'structured' },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'red', reasonContains: 'sudo' },
  },
  {
    name: 'writes outside repo → RED',
    contract: {
      command: 'cp', args: ['file.txt', '/etc/config'], cwd: '/project', mode: 'structured',
      writablePaths: ['/etc'],
    },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'red', reasonContains: 'writes outside' },
  },
  {
    name: 'terraform → RED (admin binary)',
    contract: { command: 'terraform', args: ['apply'], cwd: '/project', mode: 'structured' },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'red', reasonContains: 'admin' },
  },
  {
    name: 'docker → RED (admin binary)',
    contract: { command: 'docker', args: ['run', 'nginx'], cwd: '/project', mode: 'structured' },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'red', reasonContains: 'admin' },
  },
  {
    name: 'kubectl → RED (admin binary)',
    contract: { command: 'kubectl', args: ['apply', '-f', 'pod.yaml'], cwd: '/project', mode: 'structured' },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'red' },
  },
  {
    name: 'psql → RED (database admin)',
    contract: { command: 'psql', args: ['-c', 'SELECT 1'], cwd: '/project', mode: 'structured' },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'red', reasonContains: 'database' },
  },
  {
    name: 'shell + package install → RED',
    contract: {
      command: '', args: [], cwd: '/project', mode: 'shell',
      shell: 'npm install && npm test',
    },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'red' },
  },
  {
    name: 'curl pipe to sh → RED',
    contract: {
      command: '', args: [], cwd: '/project', mode: 'shell',
      shell: 'curl https://example.com/setup.sh | sh',
    },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'red', reasonContains: 'download' },
  },
  {
    name: 'secret injection + shell → RED',
    contract: {
      command: '', args: [], cwd: '/project', mode: 'shell', shell: 'echo $TOKEN',
      envPolicy: { inject: { API_SECRET: 'abc123' } },
    },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'red', reasonContains: 'secret' },
  },
  {
    name: 'rm -rf → destructive → YELLOW in structured mode (RED requires shell or writes-outside)',
    contract: {
      command: 'rm', args: ['-rf', '/tmp/data'], cwd: '/project', mode: 'structured',
    },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'yellow', reasonContains: 'destructive' },
  },
  {
    name: 'rm -rf in shell mode → RED',
    contract: {
      command: '', args: [], cwd: '/project', mode: 'shell', shell: 'rm -rf /tmp/data',
    },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'red' },
  },

  // --- Secrets + Production (I-A2) ---
  {
    name: 'secret + production → RED (I-A2 invariant)',
    contract: {
      command: 'node', args: ['deploy.js', '--env', 'production'], cwd: '/project', mode: 'structured',
      envPolicy: { inject: { DB_PASSWORD: 'secret123' } },
    },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: {
      riskLevel: 'red',
      traitsHandlesSecrets: true,
      traitsTargetsProduction: true,
    },
  },
  {
    name: 'secret without production → not RED from I-A2',
    contract: {
      command: 'node', args: ['test.js'], cwd: '/project', mode: 'structured',
      envPolicy: { inject: { DB_PASSWORD: 'secret123' } },
    },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: {
      traitsHandlesSecrets: true,
      traitsTargetsProduction: false,
    },
  },
];

// ===========================================================================
// Run all policy scenarios
// ===========================================================================

describe('Policy Scenarios: Risk Classification', () => {
  for (const scenario of POLICY_SCENARIOS) {
    it(scenario.name, () => {
      const result = evaluateRisk(scenario.contract, scenario.options);

      if (scenario.expected.riskLevel) {
        assert.equal(result.riskLevel, scenario.expected.riskLevel,
          `Expected ${scenario.expected.riskLevel}, got ${result.riskLevel}. Reasons: ${result.reasons.join(', ')}`);
      }

      if (scenario.expected.reasonContains) {
        assert.ok(
          result.reasons.some(r => r.toLowerCase().includes(scenario.expected.reasonContains.toLowerCase())),
          `Expected reason containing "${scenario.expected.reasonContains}". Got: ${result.reasons.join(', ')}`,
        );
      }

      if (scenario.expected.traitsHandlesSecrets !== undefined) {
        assert.equal(result.traits.handles_secrets, scenario.expected.traitsHandlesSecrets);
      }

      if (scenario.expected.traitsTargetsProduction !== undefined) {
        assert.equal(result.traits.targets_production, scenario.expected.traitsTargetsProduction);
      }
    });
  }
});

// ===========================================================================
// Workflow-level policy scenarios
// ===========================================================================

const WORKFLOW_POLICY_SCENARIOS = [
  {
    name: 'safe workflow with services → YELLOW (service lifecycle)',
    workflow: {
      name: 'test-workflow',
      steps: [
        { id: 's1', type: 'task', run: { command: 'echo', args: ['hi'], mode: 'structured', cwd: '/project' } },
      ],
      services: [{ id: 'svc', start: { command: 'node', args: ['server.js'] } }],
    },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'yellow' },
  },
  {
    name: 'generated workflow → RED',
    workflow: {
      name: 'gen-workflow',
      steps: [
        { id: 's1', type: 'task', run: { command: 'echo', args: ['hi'], mode: 'structured', cwd: '/project' } },
      ],
      services: [],
    },
    options: { trustClass: 'generated', projectRoot: '/project' },
    expected: { riskLevel: 'red' },
  },
  {
    name: 'workflow with prod-targeting step → RED',
    workflow: {
      name: 'prod-workflow',
      steps: [
        {
          id: 's1', type: 'task',
          run: { command: 'node', args: ['deploy.js', '--env', 'production'], mode: 'structured', cwd: '/project' },
        },
      ],
      services: [],
    },
    options: { trustClass: 'reviewed_internal', projectRoot: '/project' },
    expected: { riskLevel: 'red' },
  },
];

describe('Policy Scenarios: Workflow Risk Classification', () => {
  for (const scenario of WORKFLOW_POLICY_SCENARIOS) {
    it(scenario.name, () => {
      const result = evaluateWorkflowRisk(scenario.workflow, scenario.options);
      assert.equal(result.riskLevel, scenario.expected.riskLevel,
        `Expected ${scenario.expected.riskLevel}, got ${result.riskLevel}. Reasons: ${result.reasons.join(', ')}`);
    });
  }
});

// ===========================================================================
// Channel policy scenarios
// ===========================================================================

describe('Policy Scenarios: Channel Enforcement', () => {
  it('unverified community recipe blocked', () => {
    const recipe = {
      id: 'community-recipe', name: 'Test', description: 'test', version: '1.0.0',
      author: 'author', category: 'custom', channel: 'community',
      inputs: { x: { type: 'boolean' } },
      steps: [{ id: 's1', description: 'step', run: { command: 'echo', args: ['x'], mode: 'structured' } }],
      guardrails: { constraints: ['c'], invariants: ['i'] },
      approval_required: false, risk_level: 'low',
    };
    const result = enforceChannel(recipe, { allowUnverified: false });
    assert.equal(result.allowed, false);
  });

  it('signed verified recipe allowed', () => {
    const recipe = {
      id: 'verified-recipe', name: 'Test', description: 'test', version: '1.0.0',
      author: 'author', category: 'custom', channel: 'verified',
      inputs: { x: { type: 'boolean' } },
      steps: [{ id: 's1', description: 'step', run: { command: 'echo', args: ['x'], mode: 'structured' } }],
      guardrails: { constraints: ['c'], invariants: ['i'] },
      approval_required: false, risk_level: 'low',
    };
    const signature = signRecipe(recipe);
    const signed = { ...recipe, signature };
    const result = enforceChannel(signed, { allowUnverified: false });
    assert.equal(result.allowed, true);
  });
});

// ===========================================================================
// Strict mode policy scenarios
// ===========================================================================

describe('Policy Scenarios: Strict Mode', () => {
  it('agent running unapproved recipe → deny', () => {
    const identity = createIdentity({ actor: 'ci-bot', origin: 'agent' });
    const strict = createStrictMode(identity, ['allowed-recipe']);
    const check = strict.checkRecipe('forbidden-recipe');
    assert.equal(check.allowed, false);
  });

  it('agent running approved recipe → allow', () => {
    const identity = createIdentity({ actor: 'ci-bot', origin: 'agent' });
    const strict = createStrictMode(identity, ['allowed-recipe']);
    const check = strict.checkRecipe('allowed-recipe');
    assert.equal(check.allowed, true);
  });

  it('agent with no restrictions → allow any', () => {
    const identity = createIdentity({ actor: 'dev', origin: 'cli' });
    const strict = createStrictMode(identity, []);
    const check = strict.checkRecipe('any-recipe');
    assert.equal(check.allowed, true);
  });
});

// ===========================================================================
// Safe defaults policy scenarios
// ===========================================================================

describe('Policy Scenarios: Safe Defaults Decisions', () => {
  const SAFE_DEFAULT_SCENARIOS = [
    {
      name: 'prod rollout requires approval',
      action: { riskLevel: 'high', isDestructive: false, targetsProduction: true, hasSecrets: false },
      expected: { approvalRequired: true, dryRunRequired: true },
    },
    {
      name: 'destructive operation requires approval',
      action: { riskLevel: 'medium', isDestructive: true, targetsProduction: false, hasSecrets: false },
      expected: { approvalRequired: true, dryRunRequired: false },
    },
    {
      name: 'safe local test needs nothing special',
      action: { riskLevel: 'low', isDestructive: false, targetsProduction: false, hasSecrets: false },
      expected: { approvalRequired: false, dryRunRequired: false },
    },
    {
      name: 'high risk with secrets + prod = elevated',
      action: { riskLevel: 'high', isDestructive: false, targetsProduction: true, hasSecrets: true },
      expected: { approvalRequired: true, dryRunRequired: true },
    },
  ];

  for (const scenario of SAFE_DEFAULT_SCENARIOS) {
    it(scenario.name, () => {
      const result = computeDefaults(scenario.action);
      assert.equal(result.approvalRequired, scenario.expected.approvalRequired,
        `approvalRequired: expected ${scenario.expected.approvalRequired}`);
      assert.equal(result.dryRunRequired, scenario.expected.dryRunRequired,
        `dryRunRequired: expected ${scenario.expected.dryRunRequired}`);
    });
  }
});
