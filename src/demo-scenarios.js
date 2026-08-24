import { colorize } from './logger.js';
import { evaluateRisk } from './policy-engine.js';
import { checkDangerous, dryRun } from './recipe-executor.js';
import { enforceChannel } from './recipe-channel.js';
import { checkSafeDefaults } from './safe-defaults.js';

// ---------------------------------------------------------------------------
// Helpers (match demo-drift.js pattern)
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function line(text = '') { process.stdout.write(text + '\n'); }
function separator() { line(colorize('─'.repeat(56), 'dim')); }

// ---------------------------------------------------------------------------
// Scenario registry
// ---------------------------------------------------------------------------

/**
 * List all available demo scenarios.
 * @returns {{ id: string, name: string, description: string }[]}
 */
export function listScenarios() {
  return [
    { id: 'drift',   name: 'Drift Detection',    description: 'Shows Guardrail blocking silent scope expansion' },
    { id: 'recipe',  name: 'Recipe Execution',    description: 'Shows recipe dry-run, risk assessment, and guardrails' },
    { id: 'trust',   name: 'Trust & Channels',    description: 'Shows verified vs community recipe enforcement' },
    { id: 'blocked', name: 'Blocked Execution',    description: 'Shows dangerous commands being blocked' },
  ];
}

// ---------------------------------------------------------------------------
// Demo: Recipe Execution
// ---------------------------------------------------------------------------

export async function runDemoRecipe() {
  separator();
  line(colorize('  Demo: Recipe Execution', 'bold'));
  separator();
  line();

  await sleep(300);
  line('  Loading recipe: git-branch-cleanup');
  line();

  const recipe = {
    id: 'git-branch-cleanup', name: 'Git Branch Cleanup',
    description: 'Delete merged branches safely with preview.',
    version: '1.0.0', author: 'guardrail',
    category: 'git', channel: 'verified', risk_level: 'medium',
    inputs: { remote: { type: 'string', enum: ['origin', 'upstream'] } },
    steps: [
      { id: 'list-merged', description: 'List merged branches', run: { command: 'git', args: ['branch', '--merged'], mode: 'structured' } },
      { id: 'delete-merged', description: 'Delete merged branches', run: { command: 'git', args: ['branch', '-d', '{{inputs.remote}}'], mode: 'structured' } },
    ],
    guardrails: { constraints: ['merged branches only'], invariants: ['no force delete'] },
    approval_required: false,
  };

  await sleep(400);
  line(colorize('  Recipe: git-branch-cleanup v1.0.0', 'bold'));
  line(`  Category: ${recipe.category}`);
  line(`  Risk:     ${colorize(recipe.risk_level.toUpperCase(), 'yellow')}`);
  line(`  Channel:  ${colorize(recipe.channel, 'green')}`);
  line();

  await sleep(400);
  separator();
  line(colorize('  Dry-Run Preview:', 'bold'));
  separator();

  const result = dryRun(recipe, { remote: 'origin' });
  for (const step of result.steps) {
    line(`  Step: ${step.id}`);
    line(`    Command: ${step.command} ${step.args.join(' ')}`);
    line(`    Mode:    ${step.mode}`);
    line(`    Safe:    ${step.dangerous ? colorize('NO', 'red') : colorize('YES', 'green')}`);
    line();
  }

  await sleep(500);
  line(colorize(`  Result: ${result.safe ? 'All steps safe' : 'BLOCKED — unsafe steps detected'}`, result.safe ? 'green' : 'red'));
  line();
  separator();
  line(colorize('  Demo complete.', 'bold'));
  separator();
  line();
}

// ---------------------------------------------------------------------------
// Demo: Trust & Channels
// ---------------------------------------------------------------------------

export async function runDemoTrust() {
  separator();
  line(colorize('  Demo: Trust & Channel Enforcement', 'bold'));
  separator();
  line();

  await sleep(300);

  // Scenario 1: Community recipe blocked
  const communityRecipe = {
    id: 'untrusted-tool', name: 'Untrusted Tool', channel: 'community',
    risk_level: 'medium', approval_required: false,
  };

  line(colorize('  Scenario 1: Community recipe (unverified)', 'yellow'));
  line(`  Recipe: ${communityRecipe.id}`);
  line(`  Channel: ${colorize('community', 'yellow')}`);
  line();

  await sleep(400);
  const blocked = enforceChannel(communityRecipe, { allowUnverified: false });
  line(`  Decision: ${colorize('BLOCKED', 'red')}`);
  line(`  Reason:   ${blocked.reason}`);
  line();

  await sleep(500);

  // Scenario 2: Override with --allow-unverified
  line(colorize('  Scenario 2: Same recipe with --allow-unverified', 'yellow'));
  const allowed = enforceChannel(communityRecipe, { allowUnverified: true });
  line(`  Decision: ${colorize('ALLOWED', 'green')}`);
  line(`  Warning:  Unverified recipe — use at your own risk`);
  line();

  await sleep(500);

  // Scenario 3: Verified recipe
  line(colorize('  Scenario 3: Verified recipe (signed)', 'yellow'));
  const verifiedRecipe = {
    id: 'safe-tool', name: 'Safe Tool', channel: 'verified',
    signature: 'mock-valid', risk_level: 'low',
  };
  line(`  Recipe: ${verifiedRecipe.id}`);
  line(`  Channel: ${colorize('verified', 'green')}`);
  line(`  Decision: ${colorize('ALLOWED', 'green')} — trusted channel`);
  line();

  separator();
  line(colorize('  Demo complete.', 'bold'));
  separator();
  line();
}

// ---------------------------------------------------------------------------
// Demo: Blocked Execution
// ---------------------------------------------------------------------------

export async function runDemoBlocked() {
  separator();
  line(colorize('  Demo: Dangerous Command Blocking', 'bold'));
  separator();
  line();

  const scenarios = [
    { cmd: 'rm',        args: ['-rf', '/'],           desc: 'Recursive force delete at root' },
    { cmd: 'sudo',      args: ['rm', '-rf', '/tmp'],  desc: 'Elevated delete' },
    { cmd: 'chmod',     args: ['777', '/etc/passwd'],  desc: 'World-writable permissions' },
    { cmd: 'dd',        args: ['if=/dev/zero', 'of=/dev/sda'], desc: 'Raw device write' },
  ];

  for (const s of scenarios) {
    await sleep(400);
    line(`  Command: ${colorize(`${s.cmd} ${s.args.join(' ')}`, 'bold')}`);

    const danger = checkDangerous(s.cmd, s.args);
    const safe = checkSafeDefaults(`${s.cmd} ${s.args.join(' ')}`);

    if (!danger.safe) {
      line(`  ${colorize('BLOCKED', 'red')}: ${danger.reason}`);
    } else if (safe.blocked) {
      line(`  ${colorize('BLOCKED', 'red')}: ${safe.reason}`);
    }

    const risk = evaluateRisk(
      { command: s.cmd, args: s.args, cwd: '/project', mode: 'structured' },
      { trustClass: 'reviewed_internal', projectRoot: '/project' },
    );
    const riskColorMap = { red: 'red', yellow: 'yellow', green: 'green' };
    line(`  Risk: ${colorize(risk.riskLevel.toUpperCase(), riskColorMap[risk.riskLevel] || 'dim')}`);
    if (risk.reasons.length > 0) {
      line(`  Reasons: ${risk.reasons.join(', ')}`);
    }
    line();
  }

  separator();
  line(colorize('  All dangerous commands blocked. Demo complete.', 'bold'));
  separator();
  line();
}
