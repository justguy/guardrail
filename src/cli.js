#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { runSupervisor, STATUS_EXIT_CODES } from './supervisor.js';
import { DEFAULT_MANIFEST_PATH } from './manifest.js';
import {
  appendLaneAuditEntry,
  buildLaneExpiredResponse,
  buildLaneFailedResponse,
  buildLaneRecommendedCommand,
  buildLaneStartFailureResponse,
  derivePromptFileReportArtifact,
  ensureLaneKeyFile,
  formatLaneResources,
  formatLaneScope,
  formatLaneTransportSummary,
  getVersion,
  isLaneExpiredError,
  isLikelyLaneAlive,
  isTerminalAiProgressState,
  normalizeLaneCliOptions,
  printRecipeProgressText,
  readAiProgressSnapshot,
  resolveRecipeProgressStateDir,
} from './cli/helpers.js';
import { handleAuditSubcommand } from './cli/audit-commands.js';
import { handleLaneSessionSubcommand } from './cli/lane-session-commands.js';
import { handleGovernanceSubcommand } from './cli/governance-commands.js';
import { handleLaneManagementSubcommand } from './cli/lane-management-commands.js';
import { handleExecutionSubcommand } from './cli/execution-commands.js';
import { handleProgressSubcommand } from './cli/progress-commands.js';
import { handleRecipeCatalogSubcommand } from './cli/recipe-catalog-commands.js';
import { handleRecipeManagementSubcommand } from './cli/recipe-management-commands.js';
import { handleMcpSubcommand } from './cli/mcp-commands.js';
import { handleGenericRunSubcommand } from './cli/run-command.js';
import { handleTemplateSubcommand } from './cli/template-commands.js';
import { parseArgs } from './cli/parse.js';
import { USAGE } from './cli/usage.js';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  // --- Help / version ------------------------------------------------------

  if (parsed.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (parsed.version) {
    console.log(getVersion());
    process.exit(0);
  }

  // --- Errors --------------------------------------------------------------

  if (parsed.error === 'usage') {
    console.error(USAGE);
    process.exit(1);
  }

  if (parsed.error === 'shell_meta') {
    console.error(
      `Error: Shell metacharacters detected in command: ${parsed.text}\n` +
      `Use --shell to run shell scripts:\n` +
      `  guardrail run --shell "${parsed.text}"`
    );
    process.exit(1);
  }

  // --- demo drift ----------------------------------------------------------

  if (parsed.subcommand === 'demo') {
    if (parsed.demoTarget === 'drift') {
      const { default: runDemoDrift } = await import('./demo-drift.js');
      await runDemoDrift();
    } else if (parsed.demoTarget === 'list') {
      const { listScenarios } = await import('./demo-scenarios.js');
      for (const s of listScenarios()) {
        console.log(`  ${s.id.padEnd(12)} ${s.name.padEnd(22)} ${s.description}`);
      }
    } else {
      const mod = await import('./demo-scenarios.js');
      const fns = { recipe: mod.runDemoRecipe, trust: mod.runDemoTrust, blocked: mod.runDemoBlocked };
      if (fns[parsed.demoTarget]) {
        await fns[parsed.demoTarget]();
      } else {
        console.error(`Unknown demo: ${parsed.demoTarget}`);
        process.exit(1);
      }
    }
    process.exit(0);
  }

  // --- verify ---------------------------------------------------------------

  if (parsed.subcommand === 'verify') {
    const { runFullVerification } = await import('./verify.js');
    const result = await runFullVerification();
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('');
      console.log('  Guardrail Self-Verification');
      console.log('  ' + '─'.repeat(40));
      for (const c of result.checks) {
        const icon = c.passed ? '  PASS' : '  FAIL';
        const color = c.passed ? '\x1b[32m' : '\x1b[31m';
        console.log(`${color}${icon}\x1b[0m  ${c.name}: ${c.detail}`);
      }
      console.log('');
      console.log(result.passed ? '  All checks passed.' : '  Some checks failed.');
      console.log('');
    }
    process.exit(result.passed ? 0 : 1);
  }

  await handleLaneSessionSubcommand(parsed, {
    appendLaneAuditEntry,
    buildLaneExpiredResponse,
    buildLaneFailedResponse,
    buildLaneRecommendedCommand,
    buildLaneStartFailureResponse,
    derivePromptFileReportArtifact,
    ensureLaneKeyFile,
    formatLaneResources,
    formatLaneScope,
    formatLaneTransportSummary,
    isLaneExpiredError,
    isLikelyLaneAlive,
    normalizeLaneCliOptions,
  });

  await handleLaneManagementSubcommand(parsed);

  await handleGovernanceSubcommand(parsed);

  await handleTemplateSubcommand(parsed);

  await handleExecutionSubcommand(parsed, { statusExitCodes: STATUS_EXIT_CODES });

  await handleRecipeManagementSubcommand(parsed);

  await handleRecipeCatalogSubcommand(parsed);

  await handleProgressSubcommand(parsed, {
    isTerminalAiProgressState,
    printRecipeProgressText,
    readAiProgressSnapshot,
    resolveRecipeProgressStateDir,
  });

  await handleAuditSubcommand(parsed, { statusExitCodes: STATUS_EXIT_CODES });
  await handleMcpSubcommand(parsed);

  await handleGenericRunSubcommand(parsed, {
    defaultManifestPath: DEFAULT_MANIFEST_PATH,
    runSupervisor,
    statusExitCodes: STATUS_EXIT_CODES,
  });
}

export { parseArgs };

// Only run main() when executed directly (not when imported for testing)
import { resolve as _resolvePath } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';
const _thisFile = _fileURLToPath(import.meta.url);
const _entryFile = process.argv[1] ? _resolvePath(process.argv[1]) : '';
if (_thisFile === _entryFile) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
