#!/usr/bin/env node

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { runSupervisor, STATUS_EXIT_CODES } from './supervisor.js';
import { DEFAULT_MANIFEST_PATH } from './manifest.js';
import {
  appendLaneAuditEntry,
  appendRepoAuditEntry,
  authorizeEmergencyLaneAction,
  authorizeRepoAction,
  buildLaneExpiredResponse,
  buildLaneFailedResponse,
  buildLaneHistoryBundle,
  buildLaneInspectBundle,
  buildLanePortfolioBundle,
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
  laneHasSelectionFilter,
  normalizeLaneCliOptions,
  printRecipeProgressText,
  readAiProgressSnapshot,
  resolveRecipeProgressStateDir,
} from './cli/helpers.js';
import { handleGovernanceSubcommand } from './cli/governance-commands.js';
import { handleLaneManagementSubcommand } from './cli/lane-management-commands.js';
import { handleExecutionSubcommand } from './cli/execution-commands.js';
import { handleRecipeManagementSubcommand } from './cli/recipe-management-commands.js';
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

  // --- lane start/send -----------------------------------------------------

  if (parsed.subcommand === 'lane-start') {
    const { assertValidResidentLaneTool, launchResidentLane, normalizeResidentLaneOptions: validateResidentLaneOptions } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane start');
      process.exit(1);
    }
    if (!laneOpts.sessionName) {
      console.error('Error: --session-name <name> or --id <lane-id> is required for lane start');
      process.exit(1);
    }
    try {
      assertValidResidentLaneTool(laneOpts);
      validateResidentLaneOptions(laneOpts, resolve(laneOpts.guardrailRepo || '.'));
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    if (laneOpts.keyPath && existsSync(laneOpts.keyPath) && !isLikelyLaneAlive(laneOpts.laneDir)) {
      unlinkSync(laneOpts.keyPath);
    }
    if (laneOpts.keyPath && !existsSync(laneOpts.keyPath)) {
      ensureLaneKeyFile(laneOpts.keyPath);
    }
    const keyFd = laneOpts.keyPath ? openSync(laneOpts.keyPath, 'r') : null;
    let summary;
    try {
      try {
        summary = await launchResidentLane({
          ...laneOpts,
          authFd: keyFd ?? '',
        });
      } catch (err) {
        const failure = buildLaneStartFailureResponse(err);
        await appendLaneAuditEntry(laneOpts, 'lane_start', {
          status: 'error',
          reason: failure.reason,
          pid: failure.pid,
          failure_stage: failure.failureStage,
        });
        if (parsed.json) {
          console.log(JSON.stringify(failure, null, 2));
        } else {
          console.error(failure.message);
          if (failure.failureStage) console.error(`Failure stage: ${failure.failureStage}`);
          if (failure.logPath) console.error(`Log path: ${failure.logPath}`);
          if (failure.statePath) console.error(`State path: ${failure.statePath}`);
          if (failure.scopeConflicts.length > 0) {
            console.error('Scope conflicts:');
            for (const conflict of failure.scopeConflicts) {
              console.error(`  ${conflict.laneId || conflict.laneDir} (${conflict.enforcement})`);
            }
          }
          if (failure.resourceConflicts.length > 0) {
            console.error('Resource conflicts:');
            for (const conflict of failure.resourceConflicts) {
              console.error(`  ${conflict.laneId || conflict.laneDir} (${conflict.enforcement})`);
            }
          }
        }
        process.exit(1);
      }
    } finally {
      if (keyFd !== null) closeSync(keyFd);
    }
      await appendLaneAuditEntry(laneOpts, 'lane_start', {
        reused: !!summary.reused,
        pid: summary.pid ?? null,
        auth_mode: summary.authMode ?? 'none',
        scope_type: summary.scopeType ?? 'none',
        scope_mode: summary.scopeMode ?? 'warn',
        scope_conflict_count: Array.isArray(summary.scopeConflicts) ? summary.scopeConflicts.length : 0,
        resource_mode: summary.resourceMode ?? 'warn',
        resource_count: Array.isArray(summary.resources) ? summary.resources.length : 0,
        resource_conflict_count: Array.isArray(summary.resourceConflicts) ? summary.resourceConflicts.length : 0,
        status: 'success',
      });
    if (parsed.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Lane started: ${summary.sessionName}`);
      if (laneOpts.laneId) console.log(`  Lane id:       ${laneOpts.laneId}`);
      console.log(`  Tool:          ${summary.tool || summary.adapterId || laneOpts.tool || 'claude'}`);
      console.log(`  Transport:     ${formatLaneTransportSummary(summary)}`);
      console.log(`  Scope:         ${formatLaneScope(summary)}`);
      console.log(`  Resources:     ${formatLaneResources(summary)}`);
      console.log(`  Lane dir:      ${summary.laneDir}`);
      if (summary.keyPath) console.log(`  Key path:      ${summary.keyPath}`);
      console.log(`  Request FIFO:  ${summary.requestFifo}`);
      console.log(`  Response FIFO: ${summary.responseFifo}`);
      console.log(`  State path:    ${summary.statePath}`);
      console.log(`  PID:           ${summary.pid}`);
      if (summary.logPath) console.log(`  Log path:      ${summary.logPath}`);
      if (summary.reused) {
        console.log('  Reused:        yes');
      }
      if (Array.isArray(summary.scopeConflicts) && summary.scopeConflicts.length > 0) {
        console.log('  Scope conflicts:');
        for (const conflict of summary.scopeConflicts) {
          console.log(`    ${conflict.laneId || conflict.laneDir} (${conflict.enforcement})`);
        }
      }
      if (Array.isArray(summary.resourceConflicts) && summary.resourceConflicts.length > 0) {
        console.log('  Resource conflicts:');
        for (const conflict of summary.resourceConflicts) {
          console.log(`    ${conflict.laneId || conflict.laneDir} (${conflict.enforcement})`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-send' || parsed.subcommand === 'lane-chat') {
    const { sendResidentLaneMessage } = await import('./resident-lane-client.js');
    const {
      assertValidResidentLaneTool,
      getResidentLaneResult,
      getResidentLaneStatus,
      waitForResidentLaneResult,
    } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    const chatMode = parsed.subcommand === 'lane-chat';
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error(`Error: --id <lane-id> or --lane-dir <path> is required for lane ${chatMode ? 'chat' : 'send'}`);
      process.exit(1);
    }
    if (!laneOpts.prompt) {
      console.error(`Error: --prompt <text> is required for lane ${chatMode ? 'chat' : 'send'}`);
      process.exit(1);
    }
    try {
      assertValidResidentLaneTool(laneOpts);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    const preflightStatus = getResidentLaneStatus(laneOpts);
    if (preflightStatus.status === 'failed') {
      const failed = buildLaneFailedResponse(preflightStatus);
      await appendLaneAuditEntry(laneOpts, 'lane_send', {
        request_id: laneOpts.requestId || null,
        status: 'error',
        reason: failed.reason,
      });
      if (parsed.json) {
        console.log(JSON.stringify(failed, null, 2));
      } else {
        console.error(failed.message);
        if (failed.failureReason) console.error(`Failure reason: ${failed.failureReason}`);
        if (failed.failureStage) console.error(`Failure stage: ${failed.failureStage}`);
        if (failed.logPath) console.error(`Log path: ${failed.logPath}`);
      }
      process.exit(1);
    }
    if (laneOpts.keyPath && !existsSync(laneOpts.keyPath)) {
      const expired = buildLaneExpiredResponse();
      await appendLaneAuditEntry(laneOpts, 'lane_send', {
        request_id: laneOpts.requestId || null,
        status: 'error',
        reason: expired.reason,
      });
      if (parsed.json) {
        console.log(JSON.stringify(expired, null, 2));
      } else {
        console.error(expired.message);
      }
      process.exit(1);
    }

    const requestId = laneOpts.requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const keyFd = laneOpts.keyPath ? openSync(laneOpts.keyPath, 'r') : null;
    let response;
    try {
      response = await sendResidentLaneMessage([
        '--lane-dir', laneOpts.laneDir,
        '--request-id', requestId,
        '--prompt', laneOpts.prompt,
        ...(laneOpts.reportArtifact ? ['--report-artifact', laneOpts.reportArtifact] : []),
        '--completion-mode', laneOpts.completionMode || (laneOpts.reportArtifact ? 'artifact' : 'direct'),
        '--timeout-ms', laneOpts.timeoutMs || '30000',
        ...(keyFd !== null ? ['--auth-fd', String(keyFd)] : []),
      ]);
    } catch (err) {
      if (err?.code === 'LANE_TIMEOUT') {
        const status = getResidentLaneStatus(laneOpts);
        const result = getResidentLaneResult({ ...laneOpts, requestId });
        if (result.status === 'completed') {
          response = result.result;
        } else if (!status.alive && status.status !== 'busy') {
          response = buildLaneExpiredResponse();
        } else {
          response = {
            status: 'pending',
            reason: 'request_still_running',
            message: 'Resident lane request is still running. Use `guardrail lane wait` or `guardrail lane inspect` instead of restarting it.',
            requestId,
            currentRequestId: status.currentRequestId,
            currentRequestStartedAt: status.currentRequestStartedAt,
            lastActivityAt: status.lastActivityAt,
            resultPath: result.resultPath,
            ok: false,
            exitCode: 0,
          };
        }
      } else if (isLaneExpiredError(err)) {
        response = buildLaneExpiredResponse();
      } else {
        throw err;
      }
    } finally {
      if (keyFd !== null) closeSync(keyFd);
    }

    if (response?.status === 'pending' && (chatMode || laneOpts.wait === true || laneOpts.wait === 'true')) {
      response = await waitForResidentLaneResult({
        ...laneOpts,
        requestId,
      });
    }

    await appendLaneAuditEntry(laneOpts, chatMode ? 'lane_chat' : 'lane_send', {
      request_id: requestId,
      status: response.status === 'pending'
        ? 'pending'
        : ((response.ok || response.status === 'completed') ? 'success' : 'error'),
      reason: response.reason || response.error || null,
      exit_code: response.exitCode ?? null,
    });

    if (parsed.json) {
      console.log(JSON.stringify(response, null, 2));
    } else if (response.ok || response.status === 'completed') {
      const stdout = response.stdout ?? response.result?.stdout ?? '';
      process.stdout.write(stdout);
      const completedRequestId = response.requestId ?? response.result?.requestId ?? requestId;
      const completedResultPath = response.resultPath ?? null;
      if (completedRequestId) console.log(`Request id: ${completedRequestId}`);
      if (completedResultPath) console.log(`Result path: ${completedResultPath}`);
    } else if (response.status === 'pending') {
      console.log(response.message);
      if (response.requestId) console.log(`Request id: ${response.requestId}`);
      if (response.resultPath) console.log(`Result path: ${response.resultPath}`);
      console.log(`Next command: ${buildLaneRecommendedCommand({
        ...laneOpts,
        recommendedAction: 'result',
        currentRequestId: response.requestId,
        lastRequestId: response.requestId,
      })}`);
    } else {
      console.error(response.error || response.stderr || 'Resident lane request failed');
    }

    process.exit(response.ok || response.status === 'pending' || response.status === 'completed' ? 0 : (response.exitCode || 1));
  }

  if (parsed.subcommand === 'lane-run-sequence') {
    const { sendResidentLaneMessage } = await import('./resident-lane-client.js');
    const {
      assertValidResidentLaneTool,
      getResidentLaneResult,
      getResidentLaneStatus,
      stopResidentLane,
      waitForResidentLaneResult,
    } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    const promptFiles = Array.isArray(laneOpts.promptFiles) ? laneOpts.promptFiles : [];
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane run-sequence');
      process.exit(1);
    }
    if (promptFiles.length === 0) {
      console.error('Error: lane run-sequence requires at least one --prompt-file <path>');
      process.exit(1);
    }
    try {
      assertValidResidentLaneTool(laneOpts);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    const outputs = [];
    const waitForSequenceStep = async (requestId) => {
      for (;;) {
        const waited = await waitForResidentLaneResult({
          ...laneOpts,
          requestId,
          timeoutMs: laneOpts.timeoutMs || '5000',
        });
        if (waited.status !== 'pending') return waited;
      }
    };
    for (let index = 0; index < promptFiles.length; index += 1) {
      const promptFile = resolve(promptFiles[index]);
      const prompt = readFileSync(promptFile, 'utf8');
      const reportArtifact = derivePromptFileReportArtifact(prompt);
      const completionMode = reportArtifact ? 'artifact' : 'direct';
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const preflightStatus = getResidentLaneStatus(laneOpts);
      if (preflightStatus.status === 'failed') {
        const failed = buildLaneFailedResponse(preflightStatus);
        await appendLaneAuditEntry(laneOpts, 'lane_run_sequence', {
          request_id: requestId,
          status: 'error',
          reason: failed.reason,
          step_index: index,
          prompt_file: promptFile,
        });
        if (parsed.json) {
          process.stdout.write(`${JSON.stringify({ ok: false, step: index, promptFile, error: failed }, null, 2)}\n`);
        } else {
          console.error(`Lane sequence failed before step ${index + 1}: ${failed.reason}`);
        }
        process.exit(1);
      }
      if (laneOpts.keyPath && !existsSync(laneOpts.keyPath)) {
        const expired = buildLaneExpiredResponse();
        await appendLaneAuditEntry(laneOpts, 'lane_run_sequence', {
          request_id: requestId,
          status: 'error',
          reason: expired.reason,
          step_index: index,
          prompt_file: promptFile,
        });
        if (parsed.json) {
          process.stdout.write(`${JSON.stringify({ ok: false, step: index, promptFile, error: expired }, null, 2)}\n`);
        } else {
          console.error(`Lane sequence expired before step ${index + 1}`);
        }
        process.exit(1);
      }

      const keyFd = laneOpts.keyPath ? openSync(laneOpts.keyPath, 'r') : null;
      let response;
      try {
        response = await sendResidentLaneMessage([
          '--lane-dir', laneOpts.laneDir,
          '--request-id', requestId,
          '--prompt', prompt,
          ...(reportArtifact ? ['--report-artifact', reportArtifact] : []),
          '--completion-mode', completionMode,
          '--timeout-ms', laneOpts.timeoutMs || '30000',
          ...(keyFd !== null ? ['--auth-fd', String(keyFd)] : []),
        ]);
      } catch (err) {
        if (err?.code === 'LANE_TIMEOUT') {
          const status = getResidentLaneStatus(laneOpts);
          const result = getResidentLaneResult({ ...laneOpts, requestId });
          if (result.status === 'completed') {
            response = result.result;
          } else if (!status.alive && status.status !== 'busy' && status.status !== 'stalled') {
            response = buildLaneExpiredResponse();
          } else {
            response = {
              ok: false,
              status: 'pending',
              requestId,
              resultPath: result.resultPath || null,
            };
          }
        } else {
          throw err;
        }
      } finally {
        if (keyFd !== null) closeSync(keyFd);
      }

      if (response?.status === 'pending') {
        response = await waitForSequenceStep(requestId);
      }

      await appendLaneAuditEntry(laneOpts, 'lane_run_sequence', {
        request_id: requestId,
        status: (response.ok || response.status === 'completed') ? 'success' : 'error',
        reason: response.reason || response.error || null,
        exit_code: response.exitCode ?? null,
        step_index: index,
        prompt_file: promptFile,
      });

      if (!(response.ok || response.status === 'completed')) {
        const failurePayload = {
          ok: false,
          step: index,
          promptFile,
          requestId,
          response,
          outputs,
        };
        if (parsed.json) {
          process.stdout.write(`${JSON.stringify(failurePayload, null, 2)}\n`);
        } else {
          console.error(`Lane sequence failed at step ${index + 1}: ${promptFile}`);
          if (response.reason) console.error(`Reason: ${response.reason}`);
        }
        process.exit(response.exitCode || 1);
      }

      outputs.push({
        step: index,
        promptFile,
        requestId: response.requestId ?? response.result?.requestId ?? requestId,
        stdout: response.stdout ?? response.result?.stdout ?? '',
        resultPath: response.resultPath ?? response.result?.resultPath ?? null,
      });
    }

    const payload = { ok: true, count: outputs.length, outputs };
    if (laneOpts.stopWhenDone === true || laneOpts.stopWhenDone === 'true') {
      const stopped = stopResidentLane(laneOpts);
      payload.stoppedLane = true;
      payload.stop = stopped;
    }
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      for (const output of outputs) {
        process.stdout.write(output.stdout || '');
        if (output.requestId) console.log(`Request id: ${output.requestId}`);
        if (output.resultPath) console.log(`Result path: ${output.resultPath}`);
      }
    }
    process.exit(0);
  }

  await handleLaneManagementSubcommand(parsed);

  if (parsed.subcommand === 'repo-status') {
    await handleGovernanceSubcommand(parsed);
  }

  await handleTemplateSubcommand(parsed);

  await handleExecutionSubcommand(parsed, { statusExitCodes: STATUS_EXIT_CODES });

  await handleRecipeManagementSubcommand(parsed);

  // --- audit verify ----------------------------------------------------------

  // --- pack ----------------------------------------------------------------

  // --- list ----------------------------------------------------------------

  if (parsed.subcommand === 'list') {
    const { buildIndex, filterRecipes, formatRecipeList, deduplicateLatest } = await import('./recipe-index.js');
    const { buildRecipeSearchDirs } = await import('./recipe-runner.js');

    const dirs = buildRecipeSearchDirs({ basePath: process.cwd(), includeDefaults: true });
    const index = buildIndex(dirs);
    const deduped = deduplicateLatest(index);
    const filtered = filterRecipes(deduped, parsed.listFilters);

    if (parsed.json) {
      console.log(JSON.stringify(filtered.map(r => ({
        id: r.id, name: r.name, version: r.version,
        category: r.category, tags: r.tags, channel: r.channel,
        risk_level: r.risk_level, approval_required: r.approval_required,
      })), null, 2));
    } else {
      if (filtered.length === 0) {
        console.log('No recipes found.');
      } else {
        console.log(`  ${'ID'.padEnd(25)} ${'VERSION'.padEnd(8)} ${'RISK'.padEnd(6)} ${'CHANNEL'.padEnd(12)} NAME`);
        console.log(`  ${'─'.repeat(25)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(12)} ${'─'.repeat(30)}`);
        console.log(formatRecipeList(filtered));
        console.log(`\n  ${filtered.length} recipe(s) found.`);
      }
    }
    process.exit(0);
  }

  // --- create --------------------------------------------------------------

  if (parsed.subcommand === 'create') {
    const opts = parsed.createOpts || {};
    if (!opts.name) {
      console.error('Error: --name is required for create');
      process.exit(1);
    }

    const id = opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const category = opts.category || 'custom';
    const risk = opts.risk || 'medium';
    const outputPath = parsed.outputPath || `${id}.recipe.json`;

    const skeleton = {
      id,
      name: opts.name,
      description: `TODO: Describe what ${opts.name} does`,
      version: '0.1.0',
      author: process.env.USER || 'unknown',
      category,
      tags: [category],
      channel: 'community',
      signature: null,
      inputs: {
        target: { type: 'string', pattern: '^[a-zA-Z0-9_.-]+$', description: 'TODO: describe this input' },
      },
      steps: [
        { id: 'step-1', description: 'TODO: describe this step', run: { command: 'echo', args: ['{{inputs.target}}'], mode: 'structured' } },
      ],
      guardrails: {
        constraints: ['TODO: define constraints'],
        invariants: ['TODO: define invariants'],
      },
      approval_required: risk !== 'low',
      risk_level: risk,
    };

    const { writeFileSync } = await import('node:fs');
    writeFileSync(outputPath, JSON.stringify(skeleton, null, 2) + '\n');

    const riskWarnings = {
      high: '  WARNING: High-risk recipe — will require explicit approval before execution.',
      medium: '  Note: Medium-risk recipe — approval required by default.',
      low: '',
    };

    if (!parsed.json) {
      console.log(`Created recipe skeleton: ${outputPath}`);
      console.log(`  ID:       ${id}`);
      console.log(`  Category: ${category}`);
      console.log(`  Risk:     ${risk}`);
      if (riskWarnings[risk]) console.log(riskWarnings[risk]);
      console.log('\n  Edit the file to define your inputs, steps, and guardrails.');
    } else {
      console.log(JSON.stringify({ created: outputPath, id, category, risk }));
    }
    process.exit(0);
  }

  await handleGovernanceSubcommand(parsed);

  // --- recipe progress (D0y) -----------------------------------------------

  if (parsed.subcommand === 'recipe-progress') {
    const stateDir = resolveRecipeProgressStateDir(parsed.stateDir, parsed.runId);
    if (!stateDir) {
      console.error('Error: recipe progress requires --state-dir <dir> or a matching --run-id <id>');
      process.exit(1);
    }
    let snapshot = readAiProgressSnapshot(stateDir);

    if (parsed.follow) {
      let lastStateSignature = JSON.stringify(snapshot.state ?? null);
      let lastEventCount = snapshot.events.length;

      if (parsed.json) {
        console.log(JSON.stringify({
          stateDir,
          state: snapshot.state,
          events: snapshot.events,
        }));
      } else if (!snapshot.state && snapshot.events.length === 0) {
        console.log(`Waiting for AI progress data in ${stateDir}...`);
      } else {
        printRecipeProgressText(snapshot);
      }

      while (true) {
        if (isTerminalAiProgressState(snapshot.state?.status)) break;
        await delay(1000);
        const nextSnapshot = readAiProgressSnapshot(stateDir);
        const nextStateSignature = JSON.stringify(nextSnapshot.state ?? null);
        const nextEventCount = nextSnapshot.events.length;
        const stateChanged = nextStateSignature !== lastStateSignature;
        const newEvents = nextEventCount > lastEventCount
          ? nextSnapshot.events.slice(lastEventCount)
          : [];

        if (parsed.json) {
          if (stateChanged || newEvents.length > 0) {
            console.log(JSON.stringify({
              stateDir,
              state: nextSnapshot.state,
              events: newEvents,
            }));
          }
        } else {
          if (stateChanged && nextSnapshot.state) {
            console.log('');
            console.log(`Status:  ${nextSnapshot.state.status ?? 'unknown'}`);
            if (nextSnapshot.state.lastPhase) console.log(`Phase:   ${nextSnapshot.state.lastPhase}`);
            if (nextSnapshot.state.lastMessage) console.log(`Last:    ${nextSnapshot.state.lastMessage}`);
            if (nextSnapshot.state.continuationCommand) {
              console.log(`To continue: ${nextSnapshot.state.continuationCommand}`);
            }
          }
          if (newEvents.length > 0) {
            printRecipeProgressText(
              { state: nextSnapshot.state, events: nextSnapshot.events },
              lastEventCount,
              { includeHeader: false },
            );
          }
        }

        snapshot = nextSnapshot;
        lastStateSignature = nextStateSignature;
        lastEventCount = nextEventCount;
      }
    } else if (parsed.json) {
      console.log(JSON.stringify({ stateDir, state: snapshot.state, events: snapshot.events }, null, 2));
    } else {
      if (!snapshot.state && snapshot.events.length === 0) {
        console.log(`No AI progress data found in ${stateDir}`);
        process.exit(0);
      }
      printRecipeProgressText(snapshot);
    }
    process.exit(0);
  }

  // --- recipe continue (D0y) -----------------------------------------------

  if (parsed.subcommand === 'recipe-continue') {
    const stateDir = parsed.stateDir || '';
    const prompt = parsed.prompt || '';

    const { join: pathJoin } = await import('node:path');
    const stateFile = pathJoin(stateDir, 'ai-progress-state.json');

    let state = null;
    if (existsSync(stateFile)) {
      try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* ignore */ }
    }

    if (!state) {
      console.error(`Error: no progress state found in ${stateDir}`);
      process.exit(1);
    }

    const eligibleStates = new Set(['waiting_for_review', 'waiting_for_input', 'drift_warning', 'stalled', 'running']);
    if (!eligibleStates.has(state.status)) {
      console.error(`Error: run is in state "${state.status}" which is not continuation-eligible`);
      process.exit(1);
    }

    // Resume the same bounded session using persisted identity.
    const { runClaudeExec } = await import('./claude-exec-wrapper.js');
    try {
      await runClaudeExec({
        prompt,
        sessionName: state.sessionName ?? '',
        sessionId: state.sessionId ?? '',
        lifecycle: 'continue',
        workingDir: state.workingDir ?? '',
        guardrailProgressFile: state.progressArtifact ?? '',
        guardrailProgressStateFile: stateFile,
      });
    } catch (err) {
      console.error(`Error: continuation failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // --- audit verify --------------------------------------------------------

  if (parsed.subcommand === 'audit-verify') {
    const auditPath = parsed.auditPath || '.guardrail/audit.jsonl';
    const { verifyAuditChain } = await import('./audit.js');

    const result = verifyAuditChain(auditPath);

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.valid) {
      console.log(`Audit chain verified: ${result.entries} entries, no tampering detected.`);
    } else {
      console.error(`Audit chain broken: ${result.error}`);
    }
    process.exit(result.valid ? 0 : STATUS_EXIT_CODES.audit_chain_broken);
  }

  // --- audit query -----------------------------------------------------------

  if (parsed.subcommand === 'audit-query') {
    const auditPath = parsed.auditPath || '.guardrail/audit.jsonl';
    const { queryAuditLog, verifyAuditChain } = await import('./audit.js');

    // Verify chain first
    const chainResult = verifyAuditChain(auditPath);
    const entries = queryAuditLog(auditPath, parsed.auditFilters);

    if (parsed.json) {
      console.log(JSON.stringify({ chainValid: chainResult.valid, entries }, null, 2));
    } else {
      if (!chainResult.valid) {
        console.error(`Warning: audit chain is broken — ${chainResult.error}\n`);
      }
      if (entries.length === 0) {
        console.log('No matching entries.');
      } else {
        for (const entry of entries) {
          console.log(`${entry.timestamp} [${entry.event}] trace=${entry.trace_id ?? '-'} manifest=${entry.manifest_hash?.slice(0, 12) ?? '-'}...`);
        }
        console.log(`\n${entries.length} entries found.`);
      }
    }
    process.exit(0);
  }

  // --- run -----------------------------------------------------------------

  // Validate --non-interactive requires --approved-manifest
  if (parsed.nonInteractive && parsed.manifest === null) {
    console.error(
      'Error: --non-interactive requires --approved-manifest <path>'
    );
    process.exit(10);
  }

  const options = {
    manifestPath: parsed.manifest ?? DEFAULT_MANIFEST_PATH,
    nonInteractive: parsed.nonInteractive,
    jsonOutput: parsed.json || parsed.jsonStream,
    trustClass: parsed.trust,
    validator: parsed.validator,
    updateSource: parsed.updateSource,
    cwd: process.cwd(),
    progressSink: parsed.jsonStream ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : null,
  };

  if (parsed.shell !== null) {
    options.shell = parsed.shell;
    options.command = parsed.shell;
    options.args = [];
  } else {
    options.command = parsed.command;
    options.args = parsed.args;
  }

  const result = await runSupervisor(options);

  if (parsed.json || parsed.jsonStream) {
    console.log(JSON.stringify(result, null, 2));
  }

  const exitCode = STATUS_EXIT_CODES[result.status] ?? 1;
  process.exit(exitCode);
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
