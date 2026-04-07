import { printBanner, printApprovalSummary, printDrift, printDenied, colorize, riskColor, hasColor } from './logger.js';
import { createContract, hashContract } from './contract.js';
import { evaluateRisk } from './policy-engine.js';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function line(text = '') {
  process.stdout.write(text + '\n');
}

function separator() {
  line(colorize('─'.repeat(56), 'dim'));
}

/**
 * Prompt the user and return their input (trimmed, lowercased).
 * Resolves with null on Ctrl-C / stream close.
 */
function prompt(message) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('close', () => resolve(null));
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ---------------------------------------------------------------------------
// Demo orchestration
// ---------------------------------------------------------------------------

export default async function runDemo() {
  // ========================================================================
  // Step 1 - Show initial contract for `npm test`
  // ========================================================================

  const contract = createContract({
    command: 'npm',
    args: ['test'],
    mode: 'structured',
    cwd: process.cwd(),
  });

  const risk = evaluateRisk(contract, {
    trustClass: 'reviewed_internal',
    isFirstParty: true,
    isReviewed: true,
    projectRoot: process.cwd(),
  });

  printBanner();
  printApprovalSummary(contract, risk);

  const approveInitial = await prompt('  [Enter] Approve  ');
  if (approveInitial === null) {
    // Ctrl-C during initial approval
    printDenied();
    return;
  }

  line();
  line(colorize('  Approved. Contract locked.', 'green'));
  line();

  const contractHash = hashContract(contract);
  line(colorize(`  Contract hash: ${contractHash.slice(0, 16)}...`, 'dim'));
  line();

  await sleep(600);

  // ========================================================================
  // Step 2 - Simulate running npm test
  // ========================================================================

  separator();
  line(colorize('  Running: npm test ...', 'bold'));
  separator();
  line();

  await sleep(500);

  const simOutput = [
    { delay: 300, text: '  Running test suite...' },
    { delay: 400, text: colorize('  Test 1: passed', 'green') },
    { delay: 400, text: colorize('  Test 2: passed', 'green') },
    { delay: 600, text: colorize('  Test 3: FAILED - missing dependency', 'red') },
  ];

  for (const entry of simOutput) {
    await sleep(entry.delay);
    line(entry.text);
  }

  line();
  await sleep(400);

  // ========================================================================
  // Step 3 - Show validation failure
  // ========================================================================

  separator();
  line(colorize('  Validation failed (exit code 1)', 'red'));
  separator();
  line();

  await sleep(500);

  line(colorize('  Worker proposes update:', 'yellow') + colorize(' npm install', 'bold'));
  line();

  await sleep(800);

  // ========================================================================
  // Step 4 - Drift moment (THE KEY UX MOMENT)
  // ========================================================================

  printDrift([
    { description: 'Add command: npm install' },
  ]);

  const answer = await prompt('  Approve? [y/N] ');

  // ========================================================================
  // Step 5 - Handle response
  // ========================================================================

  if (answer === 'y') {
    line();
    line(colorize('  Approved. Running npm install...', 'green'));
    line();

    await sleep(800);

    line(colorize('  npm install completed successfully.', 'green'));
    line();
    separator();
    line(colorize('  Demo complete.', 'bold'));
    separator();
    line();
  } else {
    // 'n', empty string (Enter), or null (Ctrl-C)
    printDenied();
    line();
    separator();
    line(colorize('  Demo complete. Guardrail blocked the scope expansion.', 'bold'));
    separator();
    line();
  }
}
