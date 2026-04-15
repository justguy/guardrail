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

  if (parsed.subcommand === 'lane-result') {
    const { getResidentLaneResult } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane result');
      process.exit(1);
    }
    const result = getResidentLaneResult(laneOpts);
    await appendLaneAuditEntry(laneOpts, 'lane_result', {
      request_id: result.requestId || null,
      status: result.status,
      reason: result.reason || null,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.status === 'completed') {
      process.stdout.write(result.result?.stdout || '');
      if (result.requestId) console.log(`Request id: ${result.requestId}`);
      if (result.resultPath) console.log(`Result path: ${result.resultPath}`);
    } else {
      console.log(result.message);
      if (result.requestId) console.log(`Request id: ${result.requestId}`);
      if (result.resultPath) console.log(`Result path: ${result.resultPath}`);
    }
    process.exit(result.status === 'missing' ? 1 : 0);
  }

  if (parsed.subcommand === 'lane-wait') {
    const { waitForResidentLaneResult } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane wait');
      process.exit(1);
    }
    const result = await waitForResidentLaneResult(laneOpts);
    await appendLaneAuditEntry(laneOpts, 'lane_wait', {
      request_id: result.requestId || null,
      status: result.status,
      reason: result.reason || null,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.status === 'completed') {
      process.stdout.write(result.result?.stdout || '');
      if (result.requestId) console.log(`Request id: ${result.requestId}`);
      if (result.resultPath) console.log(`Result path: ${result.resultPath}`);
    } else {
      console.log(result.message);
      if (result.requestId) console.log(`Request id: ${result.requestId}`);
      if (result.resultPath) console.log(`Result path: ${result.resultPath}`);
      if (result.failureReason) console.log(`Failure reason: ${result.failureReason}`);
      if (result.failureStage) console.log(`Failure stage: ${result.failureStage}`);
      if (result.logPath) console.log(`Log path: ${result.logPath}`);
    }
    process.exit(result.status === 'completed' ? 0 : (result.status === 'pending' ? 0 : 1));
  }

  if (parsed.subcommand === 'lane-stop') {
    const { stopResidentLane } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane stop');
      process.exit(1);
    }
    const result = stopResidentLane(laneOpts);
    if (laneOpts.keyPath) {
      try {
        unlinkSync(laneOpts.keyPath);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
    await appendLaneAuditEntry(laneOpts, 'lane_stop', {
      status: result.stopped ? 'success' : 'error',
      stopped: !!result.stopped,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Lane stopped: ${laneOpts.laneId || laneOpts.laneDir}`);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-revoke') {
    const { revokeResidentLane, revokeAllResidentLanes } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    const emergencyGate = await authorizeEmergencyLaneAction(laneOpts, laneOpts.all ? 'lane.revoke_all' : 'lane.revoke');
    if (!emergencyGate.allowed) {
      console.error(`Error: ${emergencyGate.reason}`);
      process.exit(1);
    }
    if (laneOpts.all) {
      const summary = revokeAllResidentLanes(laneOpts);
      for (const r of summary.results) {
        if (r.outcome === 'revoked') {
          await appendLaneAuditEntry({ ...laneOpts, laneDir: r.laneDir, laneId: r.laneId || '' }, 'lane_revoked', {
            status: 'revoked',
            revoked: true,
            actor: laneOpts.actor || 'operator',
            reason: laneOpts.reason || null,
          });
        }
      }
      if (parsed.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`Bulk lane revoke: ${summary.revoked} revoked, ${summary.skipped} skipped, ${summary.failed} failed (${summary.targeted} targeted)`);
      }
      process.exit(summary.failed > 0 ? 1 : 0);
    }
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id>, --lane-dir <path>, or --all is required for lane revoke');
      process.exit(1);
    }
    const result = revokeResidentLane(laneOpts);
    await appendLaneAuditEntry(laneOpts, 'lane_revoked', {
      status: 'revoked',
      revoked: true,
      actor: laneOpts.actor || 'operator',
      reason: laneOpts.reason || null,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Lane revoked: ${laneOpts.laneId || laneOpts.laneDir}`);
      if (laneOpts.reason) console.log(`  Reason: ${laneOpts.reason}`);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-kill') {
    const { killResidentLane, killAllResidentLanes } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    const emergencyGate = await authorizeEmergencyLaneAction(laneOpts, laneOpts.all ? 'lane.kill_all' : 'lane.kill');
    if (!emergencyGate.allowed) {
      console.error(`Error: ${emergencyGate.reason}`);
      process.exit(1);
    }
    if (laneOpts.all) {
      const summary = killAllResidentLanes(laneOpts);
      for (const r of summary.results) {
        if (r.outcome === 'killed') {
          await appendLaneAuditEntry({ ...laneOpts, laneDir: r.laneDir, laneId: r.laneId || '' }, 'lane_emergency_stop', {
            status: 'killed',
            killed: true,
            revoked: true,
            actor: laneOpts.actor || 'operator',
            reason: laneOpts.reason || null,
          });
        }
      }
      if (parsed.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`Bulk lane kill: ${summary.killed} killed, ${summary.skipped} skipped, ${summary.failed} failed (${summary.targeted} targeted)`);
      }
      process.exit(summary.failed > 0 ? 1 : 0);
    }
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id>, --lane-dir <path>, or --all is required for lane kill');
      process.exit(1);
    }
    const result = killResidentLane(laneOpts);
    await appendLaneAuditEntry(laneOpts, 'lane_emergency_stop', {
      status: 'killed',
      killed: true,
      revoked: true,
      actor: laneOpts.actor || 'operator',
      reason: laneOpts.reason || null,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Lane killed (break-glass): ${laneOpts.laneId || laneOpts.laneDir}`);
      if (laneOpts.reason) console.log(`  Reason: ${laneOpts.reason}`);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'key-revoke') {
    const { createKeyStore } = await import('./key-management.js');
    const keyOpts = parsed.keyOpts || {};
    const guardrailRepo = resolve(keyOpts.guardrailRepo || process.cwd());
    const permissionGate = await authorizeRepoAction(guardrailRepo, keyOpts.actor, 'key.revoke', 'manage_keys');
    if (!permissionGate.allowed) {
      console.error(`Error: ${permissionGate.reason}`);
      process.exit(1);
    }
    if (!keyOpts.name) {
      console.error('Error: key name is required');
      process.exit(1);
    }
    if (!keyOpts.stateDir) {
      console.error('Error: --state-dir <dir> is required for key revoke');
      process.exit(1);
    }
    const keyStore = createKeyStore(resolve(guardrailRepo, keyOpts.stateDir), 'guardrail-revoke-no-decrypt');
    let revoked;
    try {
      revoked = keyStore.revoke(keyOpts.name, {
        actor: permissionGate.actor,
        reason: keyOpts.reason || null,
      });
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    await appendRepoAuditEntry(guardrailRepo, 'key_revoked', {
      status: 'revoked',
      key_name: keyOpts.name,
      actor: permissionGate.actor,
      role: permissionGate.role,
      reason: keyOpts.reason || null,
      revoked_at: revoked.revokedAt || null,
    });
    if (parsed.json) {
      console.log(JSON.stringify({
        revoked: true,
        name: keyOpts.name,
        revokedAt: revoked.revokedAt || null,
        revokedBy: revoked.revokedBy || null,
        revocationReason: revoked.revocationReason || null,
      }, null, 2));
    } else {
      console.log(`Key revoked: ${keyOpts.name}`);
      if (keyOpts.reason) console.log(`  Reason: ${keyOpts.reason}`);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'session-revoke') {
    const { defaultSessionContractPath, revokeSessionContract } = await import('./agent-session.js');
    const { createAuditLog } = await import('./audit.js');
    const sessionOpts = parsed.sessionOpts || {};
    if (!sessionOpts.recipe) {
      console.error('Error: --recipe <id> is required for session revoke');
      process.exit(1);
    }
    const guardrailRepo = resolve(sessionOpts.guardrailRepo || process.cwd());
    const stateDir = sessionOpts.stateDir
      ? resolve(guardrailRepo, sessionOpts.stateDir)
      : resolve(guardrailRepo, '.guardrail');
    const contractPath = defaultSessionContractPath(stateDir, sessionOpts.recipe, sessionOpts.sessionName || null);
    let revoked;
    try {
      revoked = revokeSessionContract(contractPath, {
        actor: sessionOpts.actor || 'operator',
        reason: sessionOpts.reason || '',
      });
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    const auditLog = createAuditLog(resolve(guardrailRepo, '.guardrail', 'audit.jsonl'));
    auditLog.append({
      event: 'session_revoked',
      trace_id: `session:${sessionOpts.recipe}:${sessionOpts.sessionName || 'default'}`,
      recipe: sessionOpts.recipe,
      session_name: sessionOpts.sessionName || null,
      actor: sessionOpts.actor || 'operator',
      reason: sessionOpts.reason || null,
      contract_path: contractPath,
    });
    if (parsed.json) {
      console.log(JSON.stringify({ revoked: true, contractPath, revokedAt: revoked.revokedAt }, null, 2));
    } else {
      console.log(`Session revoked: ${sessionOpts.recipe}/${sessionOpts.sessionName || 'default'}`);
      if (sessionOpts.reason) console.log(`  Reason: ${sessionOpts.reason}`);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-extend') {
    const { extendResidentLane, getResidentLaneStatus } = await import('./resident-lane-core.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane extend');
      process.exit(1);
    }
    const updates = {
      idleTimeoutMs: laneOpts.idleTimeoutMs,
      healthTimeoutMs: laneOpts.healthTimeoutMs,
      heartbeat: laneOpts.heartbeat === true,
    };
    let control;
    try {
      control = extendResidentLane(laneOpts.laneDir, updates);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    await appendLaneAuditEntry(laneOpts, 'lane_extend', {
      status: 'success',
      idle_timeout_ms: control.idleTimeoutMs ?? null,
      health_timeout_ms: control.healthTimeoutMs ?? null,
      heartbeat_at: control.heartbeatAt ?? null,
    });
    const status = getResidentLaneStatus(laneOpts);
    const payload = { laneId: laneOpts.laneId, laneDir: laneOpts.laneDir, control, status: status?.status || null };
    if (parsed.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Lane extended: ${laneOpts.laneId || laneOpts.laneDir}`);
      if (control.idleTimeoutMs != null) console.log(`  idleTimeoutMs:   ${control.idleTimeoutMs}`);
      if (control.healthTimeoutMs != null) console.log(`  healthTimeoutMs: ${control.healthTimeoutMs}`);
      if (control.heartbeatAt) console.log(`  heartbeatAt:     ${control.heartbeatAt}`);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-cleanup') {
    const { cleanupResidentLane } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir && !laneOpts.filterLaneId && !laneOpts.filterSessionName) {
      console.error('Error: provide --id <lane-id>, --lane-dir <path>, or one narrowing lane filter for lane cleanup');
      process.exit(1);
    }
    const result = cleanupResidentLane(laneOpts);
    await appendLaneAuditEntry(laneOpts, 'lane_cleanup', {
      status: result.cleaned ? 'success' : 'error',
      reason: result.status,
      stopped_live_lane: !!result.stoppedLiveLane,
      cleaned_lane_dir: result.lane?.laneDir || null,
      cleanup_reason: result.lane?.cleanupReason || null,
      tombstone_path: result.lane?.tombstonePath || null,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.cleaned) {
      console.log(`Lane cleaned: ${result.lane.laneId || result.lane.laneDir}`);
      console.log(`  Status before cleanup: ${result.lane.status}`);
      console.log(`  Live before cleanup:   ${result.lane.aliveBeforeCleanup ? 'yes' : 'no'}`);
    } else {
      console.error(result.message);
      if (Array.isArray(result.matches) && result.matches.length > 0) {
        console.error('Matches:');
        for (const match of result.matches) {
          console.error(`  ${match.laneId || match.laneDir} (${match.status})`);
        }
      }
      process.exit(1);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-batch') {
    const { cleanupResidentLane, listResidentLanes, stopResidentLane } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    const action = String(laneOpts.action || '').trim();
    if (!['stop', 'cleanup'].includes(action)) {
      console.error('Error: lane batch requires --action stop|cleanup');
      process.exit(1);
    }
    if (!laneHasSelectionFilter(laneOpts)) {
      console.error('Error: lane batch requires at least one lane selector or --all');
      process.exit(1);
    }

    const listing = listResidentLanes(laneOpts);
    const targets = listing.lanes;
    if (laneOpts.dryRun === true || laneOpts.dryRun === 'true') {
      const preview = {
        action,
        dryRun: true,
        count: targets.length,
        lanes: targets.map((lane) => ({
          laneId: lane.laneId || null,
          laneDir: lane.laneDir,
          tool: lane.tool || lane.adapterId || null,
          status: lane.status,
          alive: !!lane.alive,
        })),
      };
      if (parsed.json) {
        console.log(JSON.stringify(preview, null, 2));
      } else {
        console.log(`Batch ${action} preview (${targets.length} lane(s))`);
        for (const lane of preview.lanes) {
          console.log(`  ${lane.laneId || lane.laneDir}: ${lane.status}${lane.alive ? ' (alive)' : ''}`);
        }
      }
      process.exit(0);
    }

    const results = [];
    for (const lane of targets) {
      const targetOpts = {
        ...laneOpts,
        laneId: lane.laneId || '',
        laneDir: lane.laneDir,
        keyPath: lane.keyPath || '',
        tool: lane.tool || lane.adapterId || laneOpts.tool || 'claude',
        sessionName: lane.sessionName || lane.laneId || laneOpts.sessionName || '',
        sessionId: lane.sessionId || laneOpts.sessionId || '',
      };
      if (action === 'stop') {
        if (!lane.alive) {
          results.push({
            laneId: lane.laneId || null,
            laneDir: lane.laneDir,
            status: 'skipped',
            reason: 'lane_not_alive',
          });
          continue;
        }
        const stopped = stopResidentLane(targetOpts);
        await appendLaneAuditEntry(targetOpts, 'lane_stop', {
          status: stopped?.stopped ? 'success' : 'error',
          stopped: !!stopped?.stopped,
          reason: stopped?.stopped ? null : 'stop_failed',
        });
        results.push({
          laneId: lane.laneId || null,
          laneDir: lane.laneDir,
          status: stopped?.stopped ? 'success' : 'error',
          stopped: !!stopped?.stopped,
        });
        continue;
      }

      const cleaned = cleanupResidentLane(targetOpts);
      await appendLaneAuditEntry(targetOpts, 'lane_cleanup', {
        status: cleaned.cleaned ? 'success' : 'error',
        reason: cleaned.status,
        stopped_live_lane: !!cleaned.stoppedLiveLane,
        cleaned_lane_dir: cleaned.lane?.laneDir || lane.laneDir,
        cleanup_reason: cleaned.lane?.cleanupReason || null,
        tombstone_path: cleaned.lane?.tombstonePath || null,
      });
      results.push({
        laneId: lane.laneId || null,
        laneDir: lane.laneDir,
        status: cleaned.cleaned ? 'success' : 'error',
        reason: cleaned.lane?.cleanupReason || cleaned.status || null,
        cleaned: !!cleaned.cleaned,
      });
    }

    await appendLaneAuditEntry(laneOpts, 'lane_batch', {
      status: results.every((entry) => entry.status === 'success' || entry.status === 'skipped') ? 'success' : 'error',
      action,
      total_matches: targets.length,
      success_count: results.filter((entry) => entry.status === 'success').length,
      skipped_count: results.filter((entry) => entry.status === 'skipped').length,
      error_count: results.filter((entry) => entry.status === 'error').length,
    });

    const payload = {
      action,
      dryRun: false,
      count: targets.length,
      results,
    };
    if (parsed.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Batch ${action} complete (${targets.length} lane(s))`);
      for (const entry of results) {
        console.log(`  ${entry.laneId || entry.laneDir}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ''}`);
      }
    }
    process.exit(results.some((entry) => entry.status === 'error') ? 1 : 0);
  }

  if (parsed.subcommand === 'lane-list') {
    const { listResidentLanes } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    const listing = listResidentLanes(laneOpts);
    const enrichedListing = {
      ...listing,
      lanes: listing.lanes.map((lane) => ({
        ...lane,
        recommendedCommand: buildLaneRecommendedCommand(lane),
      })),
    };
    if (parsed.json) {
      console.log(JSON.stringify(enrichedListing, null, 2));
    } else {
      console.log(`Lane registry: ${enrichedListing.registryDir}`);
      console.log(`  Total:   ${enrichedListing.counts.total || 0}`);
      for (const [status, count] of Object.entries(enrichedListing.counts)) {
        if (status === 'total') continue;
        console.log(`  ${status}:`.padEnd(11) + ` ${count}`);
      }
      const activeFilters = [
        laneOpts.status ? `status=${Array.isArray(laneOpts.status) ? laneOpts.status.join(',') : laneOpts.status}` : null,
        laneOpts.toolFilter ? `tool=${Array.isArray(laneOpts.toolFilter) ? laneOpts.toolFilter.join(',') : laneOpts.toolFilter}` : null,
        laneOpts.alive !== undefined ? `alive=${laneOpts.alive}` : null,
        laneOpts.hasConflicts !== undefined ? `hasConflicts=${laneOpts.hasConflicts}` : null,
        laneOpts.filterLaneId ? `laneId=${laneOpts.filterLaneId}` : null,
        laneOpts.filterSessionName ? `sessionName=${laneOpts.filterSessionName}` : null,
        laneOpts.scopeTypeFilter ? `scopeType=${laneOpts.scopeTypeFilter}` : null,
        laneOpts.scopeModeFilter ? `scopeMode=${laneOpts.scopeModeFilter}` : null,
        laneOpts.resourceFilter ? `resources=${Array.isArray(laneOpts.resourceFilter) ? laneOpts.resourceFilter.join(',') : laneOpts.resourceFilter}` : null,
        laneOpts.allRepos ? 'allRepos=true' : null,
      ].filter(Boolean);
      if (activeFilters.length > 0) {
        console.log(`  Filters: ${activeFilters.join(' ')}`);
      }
      if (enrichedListing.lanes.length > 0) {
        console.log('');
        for (const lane of enrichedListing.lanes) {
          const name = lane.laneId || lane.sessionName || lane.laneDir;
          console.log(`${name}: ${lane.status}${lane.alive ? ' (alive)' : ''}`);
          console.log(`  Tool:          ${lane.tool ?? lane.adapterId ?? 'claude'}`);
          console.log(`  Transport:     ${formatLaneTransportSummary(lane)}`);
          console.log(`  Scope:         ${formatLaneScope(lane)}`);
          console.log(`  Resources:     ${formatLaneResources(lane)}`);
          console.log(`  Repo:          ${lane.guardrailRepo ?? 'n/a'}`);
          console.log(`  Lane dir:      ${lane.laneDir}`);
          console.log(`  Session:       ${lane.sessionName ?? 'n/a'}`);
          console.log(`  Request:       ${lane.currentRequestId ?? lane.lastRequestId ?? 'n/a'}`);
          console.log(`  Last result:   ${lane.lastResultPath ?? 'n/a'}`);
          console.log(`  Action:        ${lane.recommendedAction}`);
          console.log(`  Next command:  ${lane.recommendedCommand ?? 'n/a'}`);
          const totalConflicts = (lane.scopeConflicts?.length || 0) + (lane.resourceConflicts?.length || 0);
          if (totalConflicts > 0) {
            console.log(`  Conflicts:     ${totalConflicts}`);
          }
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-adapters') {
    const { listResidentLaneAdapters } = await import('./resident-lane.js');
    const adapters = listResidentLaneAdapters();
    if (parsed.json) {
      console.log(JSON.stringify({ adapters }, null, 2));
    } else {
      console.log('Resident lane adapters:');
      for (const adapter of adapters) {
        console.log(`  ${adapter.id} - ${adapter.description}`);
        if (adapter.source) {
          console.log(`    Source: ${adapter.source}`);
        }
        if (Array.isArray(adapter.capabilities) && adapter.capabilities.length > 0) {
          console.log(`    Capabilities: ${adapter.capabilities.join(', ')}`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-inspect') {
    const { getResidentLaneHistory, getResidentLaneLogs, getResidentLaneResult, getResidentLaneStatus } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane inspect');
      process.exit(1);
    }
    const status = getResidentLaneStatus(laneOpts);
    const bundle = buildLaneInspectBundle(laneOpts, status, getResidentLaneResult, getResidentLaneLogs, getResidentLaneHistory);
    if (parsed.json) {
      console.log(JSON.stringify(bundle, null, 2));
    } else {
      console.log(`Lane status: ${bundle.status.status}`);
      console.log(`  Tool:               ${bundle.status.tool ?? bundle.status.adapterId ?? 'claude'}`);
      console.log(`  Transport:          ${formatLaneTransportSummary(bundle.status)}`);
      console.log(`  Scope:              ${formatLaneScope(bundle.status)}`);
      console.log(`  Resources:          ${formatLaneResources(bundle.status)}`);
      console.log(`  Request:            ${bundle.status.currentRequestId ?? bundle.status.lastRequestId ?? 'n/a'}`);
      console.log(`  Last result:        ${bundle.status.lastResultPath ?? 'n/a'}`);
      console.log(`  Action:             ${bundle.status.recommendedAction}`);
      console.log(`  Next command:       ${bundle.status.recommendedCommand ?? 'n/a'}`);
      if (bundle.latestResult?.status) {
        console.log(`  Result status:      ${bundle.latestResult.status}`);
      }
      if (bundle.logs?.text) {
        console.log('');
        console.log(`Lane log tail (${bundle.logs.tailLines} lines):`);
        process.stdout.write(`${bundle.logs.text}${bundle.logs.text.endsWith('\n') ? '' : '\n'}`);
      }
      if (bundle.history?.entries?.length > 0) {
        console.log('');
        console.log(`Lane history (${bundle.history.entries.length}/${bundle.history.totalMatches} entries, chain=${bundle.history.chainValid ? 'valid' : 'broken'}):`);
        for (const entry of bundle.history.entries) {
          console.log(`  ${entry.timestamp} ${entry.event} request=${entry.request_id ?? 'n/a'} status=${entry.status ?? 'n/a'} reason=${entry.reason ?? 'n/a'}`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-history') {
    const { getResidentLaneHistory } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane history');
      process.exit(1);
    }
    const history = buildLaneHistoryBundle(getResidentLaneHistory(laneOpts));
    if (parsed.json) {
      console.log(JSON.stringify(history, null, 2));
    } else {
      console.log(`Lane audit: ${history.auditPath}`);
      console.log(`  Entries: ${history.count}/${history.totalMatches}`);
      console.log(`  Chain:   ${history.chainValid ? 'valid' : 'broken'}`);
      for (const entry of history.entries) {
        console.log(`  ${entry.timestamp} ${entry.event} request=${entry.request_id ?? 'n/a'} status=${entry.status ?? 'n/a'} reason=${entry.reason ?? 'n/a'} exit=${entry.exit_code ?? 'n/a'}`);
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-portfolio') {
    const { getResidentLaneTimeline } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    const timeline = buildLanePortfolioBundle(getResidentLaneTimeline(laneOpts));
    if (parsed.json) {
      console.log(JSON.stringify(timeline, null, 2));
    } else {
      console.log(`Lane portfolio scope: ${timeline.scope}`);
      console.log(`  Audit path:     ${timeline.auditPath}`);
      console.log(`  Chain valid:    ${timeline.chainValid ? 'yes' : 'no'}`);
      console.log(`  Live lanes:     ${timeline.liveLaneCount}`);
      console.log(`  Matched events: ${timeline.totalMatches}`);
      const eventSummary = Object.entries(timeline.eventCounts || {}).map(([event, count]) => `${event}=${count}`).join(' ');
      if (eventSummary) console.log(`  Events:         ${eventSummary}`);
      if (timeline.entries.length > 0) {
        console.log('');
        for (const entry of timeline.entries) {
          console.log(`${entry.timestamp} ${entry.event} ${entry.lane_id || entry.lane_dir || 'unknown'}${entry.source ? ` [${entry.source}]` : ''}`);
          console.log(`  Repo:    ${entry.guardrail_repo || 'n/a'}`);
          console.log(`  Tool:    ${entry.tool || 'n/a'}`);
          console.log(`  Status:  ${entry.status || 'n/a'}`);
          if (entry.reason) console.log(`  Reason:  ${entry.reason}`);
          if (entry.tombstone_path) console.log(`  Tombstone: ${entry.tombstone_path}`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-logs') {
    const { getResidentLaneLogs } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane logs');
      process.exit(1);
    }
    const logs = getResidentLaneLogs(laneOpts);
    if (parsed.json) {
      console.log(JSON.stringify(logs, null, 2));
    } else {
      console.log(`Lane log: ${logs.logPath ?? 'n/a'}`);
      if (logs.text) {
        process.stdout.write(`${logs.text}${logs.text.endsWith('\n') ? '' : '\n'}`);
      } else {
        console.log('(no log output recorded)');
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-prune') {
    const { pruneResidentLanes } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    laneOpts.dryRun = parsed.dryRun === true;
    const result = pruneResidentLanes(laneOpts);
    if (!result.dryRun) {
      for (const lane of result.pruned) {
        await appendLaneAuditEntry({
          ...laneOpts,
          laneId: lane.laneId || null,
          laneDir: lane.laneDir,
          tool: lane.tool || null,
        }, 'lane_prune', {
          status: 'success',
          pruned_status: lane.status,
          prune_reason: lane.cleanupReason || null,
          tombstone_path: lane.tombstonePath || null,
        });
      }
    }
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Lane registry: ${result.registryDir}`);
      if (result.dryRun) {
        console.log('  Mode: dry-run');
      }
      console.log(`  Candidates: ${result.candidates.length}`);
      console.log(`  Pruned: ${result.pruned.length}`);
      console.log(`  Skipped: ${result.skipped.length}`);
      const visible = result.dryRun ? result.candidates : result.pruned;
      for (const lane of visible) {
        console.log(`  - ${lane.laneId || lane.laneDir} (${lane.status}; ${lane.reason || lane.cleanupReason || 'n/a'})`);
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-status') {
    const { getResidentLaneStatus } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane status');
      process.exit(1);
    }
    const status = getResidentLaneStatus(laneOpts);
    const enrichedStatus = {
      ...status,
      recommendedCommand: buildLaneRecommendedCommand(status),
    };
    if (parsed.json) {
      console.log(JSON.stringify(enrichedStatus, null, 2));
    } else {
      console.log(`Lane status: ${enrichedStatus.status}`);
      console.log(`  Tool:               ${enrichedStatus.tool ?? enrichedStatus.adapterId ?? 'claude'}`);
      console.log(`  Transport:          ${formatLaneTransportSummary(enrichedStatus)}`);
      console.log(`  Scope:              ${formatLaneScope(enrichedStatus)}`);
      console.log(`  Resources:          ${formatLaneResources(enrichedStatus)}`);
      if (laneOpts.laneId) console.log(`  Lane id:            ${laneOpts.laneId}`);
      console.log(`  Lane dir:           ${enrichedStatus.laneDir}`);
      if (enrichedStatus.sessionName) console.log(`  Session name:       ${enrichedStatus.sessionName}`);
      if (enrichedStatus.sessionId) console.log(`  Session id:         ${enrichedStatus.sessionId}`);
      console.log(`  Alive:              ${enrichedStatus.alive ? 'yes' : 'no'}`);
      console.log(`  PID:                ${enrichedStatus.pid ?? 'n/a'}`);
      console.log(`  Last request id:    ${enrichedStatus.lastRequestId ?? 'n/a'}`);
      console.log(`  Current request id: ${enrichedStatus.currentRequestId ?? 'n/a'}`);
      console.log(`  Request started at: ${enrichedStatus.currentRequestStartedAt ?? 'n/a'}`);
      console.log(`  Last completed id:  ${enrichedStatus.lastCompletedRequestId ?? 'n/a'}`);
      console.log(`  Last completed at:  ${enrichedStatus.lastCompletedAt ?? 'n/a'}`);
      console.log(`  Last result path:   ${enrichedStatus.lastResultPath ?? 'n/a'}`);
      console.log(`  Failure reason:     ${enrichedStatus.failureReason ?? 'n/a'}`);
      console.log(`  Failure stage:      ${enrichedStatus.failureStage ?? 'n/a'}`);
      console.log(`  Log path:           ${enrichedStatus.logPath ?? 'n/a'}`);
      console.log(`  Last activity at:   ${enrichedStatus.lastActivityAt ?? 'n/a'}`);
      console.log(`  Key present:        ${enrichedStatus.keyPresent ? 'yes' : 'no'}`);
      console.log(`  Request FIFO:       ${enrichedStatus.requestFifoPresent ? 'present' : 'missing'}`);
      console.log(`  Response FIFO:      ${enrichedStatus.responseFifoPresent ? 'present' : 'missing'}`);
      console.log(`  Recommended action: ${enrichedStatus.recommendedAction}`);
      console.log(`  Next command:       ${enrichedStatus.recommendedCommand ?? 'n/a'}`);
      if (Array.isArray(enrichedStatus.scopeConflicts) && enrichedStatus.scopeConflicts.length > 0) {
        console.log('  Scope conflicts:');
        for (const conflict of enrichedStatus.scopeConflicts) {
          console.log(`    ${conflict.laneId || conflict.laneDir} (${conflict.enforcement})`);
        }
      }
      if (Array.isArray(enrichedStatus.resourceConflicts) && enrichedStatus.resourceConflicts.length > 0) {
        console.log('  Resource conflicts:');
        for (const conflict of enrichedStatus.resourceConflicts) {
          console.log(`    ${conflict.laneId || conflict.laneDir} (${conflict.enforcement})`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'repo-status') {
    await handleGovernanceSubcommand(parsed);
  }

  // --- template create -----------------------------------------------------

  if (parsed.subcommand === 'template-create') {
    if (!parsed.manifestPath) {
      console.error('Error: --from-manifest <path> is required for template create');
      process.exit(1);
    }

    const { buildTemplateFromApprovedManifest, lintTemplate } = await import('./template.js');

    let templateDef;
    try {
      templateDef = buildTemplateFromApprovedManifest(parsed.manifestPath, {
        name: parsed.name,
        sourcePath: parsed.manifestPath,
      });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const outputPath = resolve(parsed.outputPath || `.guardrail/templates/${templateDef.name}.json`);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(templateDef, null, 2) + '\n');

    const warnings = lintTemplate(templateDef);
    if (parsed.json) {
      console.log(JSON.stringify({ path: outputPath, template: templateDef, warnings }, null, 2));
    } else {
      console.log(`Template created: ${outputPath}`);
      if (warnings.length > 0) {
        console.log('');
        console.log('Warnings:');
        for (const warning of warnings) {
          console.log(`  - ${warning}`);
        }
      }
    }
    process.exit(0);
  }

  // --- template list -------------------------------------------------------

  if (parsed.subcommand === 'template-list') {
    const { listTemplates } = await import('./template.js');

    let rows;
    try {
      rows = listTemplates(parsed.templatesDir || '.guardrail/templates');
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    if (parsed.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else if (rows.length === 0) {
      console.log('No templates found.');
    } else {
      for (const row of rows) {
        const provenance = row.source
          ? `${row.source.type}${row.sourceMatch === false ? ' (modified)' : ''}`
          : 'local';
        console.log(`  ${row.name.padEnd(24)} ${row.kind.padEnd(18)} ${row.effectiveTrustClass.padEnd(18)} ${provenance}`);
      }
    }
    process.exit(0);
  }

  // --- template publish ----------------------------------------------------

  if (parsed.subcommand === 'template-publish') {
    try {
      const { publishTemplate } = await import('./recipe-publish.js');
      const result = await publishTemplate({
        templatePath: parsed.template,
        name: parsed.name,
        category: parsed.category,
        description: parsed.description,
        version: parsed.version,
        author: parsed.author,
        dryRun: parsed.dryRun,
      });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // --- template lint -------------------------------------------------------

  if (parsed.subcommand === 'template-lint') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template lint');
      process.exit(1);
    }

    const { loadTemplate, lintTemplate } = await import('./template.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const warnings = lintTemplate(def);

    if (warnings.length === 0) {
      console.log('No issues found.');
      process.exit(0);
    }

    console.error(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}:\n`);
    for (const w of warnings) {
      console.error(`  ⚠ ${w}`);
    }
    process.exit(1);
  }

  // --- template explain ----------------------------------------------------

  if (parsed.subcommand === 'template-explain') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template explain');
      process.exit(1);
    }

    const { loadTemplate, explainTemplate } = await import('./template.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    console.log(explainTemplate(def));
    process.exit(0);
  }

  // --- template schema -----------------------------------------------------

  if (parsed.subcommand === 'template-schema') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template schema');
      process.exit(1);
    }

    const { loadTemplate, describeSchema } = await import('./template.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    console.log(describeSchema(def));
    process.exit(0);
  }

  // --- template simulate ---------------------------------------------------

  if (parsed.subcommand === 'template-simulate') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template simulate');
      process.exit(1);
    }

    const { loadTemplate, simulateTemplate } = await import('./template.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const result = simulateTemplate(def, parsed.inputs, parsed.envAllow);
    if (result.errors.length > 0) {
      console.error('Simulation failed:');
      for (const e of result.errors) {
        console.error(`  - ${e}`);
      }
      process.exit(1);
    }

    console.log(result.output);
    process.exit(0);
  }

  // --- template diff -------------------------------------------------------

  if (parsed.subcommand === 'template-diff') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template diff');
      process.exit(1);
    }

    const { resolve } = await import('node:path');
    const { loadTemplate, hashTemplateExecution, createTemplateManifest, diffTemplateManifests, evaluateTemplateRisk, validateUserInputs, computeEnvIntersection } = await import('./template.js');
    const { loadManifest } = await import('./manifest.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const manifestPath = resolve(parsed.manifest || `.guardrail/templates/${def.name}.approved.json`);
    const approved = loadManifest(manifestPath);

    if (!approved) {
      console.log('No approved manifest found. Nothing to diff against.');
      process.exit(0);
    }

    // Rebuild candidate with the same inputs from the approved manifest
    const savedInputs = approved.resolvedInputs || {};
    const savedEnv = approved.envIntersection || [];

    const inputValidation = validateUserInputs(def.inputs, { ...savedInputs, ...parsed.inputs });
    const inputs = inputValidation.valid ? inputValidation.values : savedInputs;
    const callerAllow = parsed.envAllow.length > 0 ? parsed.envAllow : savedEnv;
    const envResult = computeEnvIntersection(def.requires_env || [], callerAllow);
    const templateHash = hashTemplateExecution(def, inputs, envResult.intersection);
    const riskAssessment = evaluateTemplateRisk(def, envResult.intersection);
    const candidate = createTemplateManifest(def, templateHash, riskAssessment, inputs, envResult.intersection);

    const diffs = diffTemplateManifests(candidate, approved);

    if (diffs.length === 0) {
      console.log('No changes detected. Template matches approved hash.');
      process.exit(0);
    }

    console.log(`Template: ${def.name}`);
    console.log(`Approved hash: ${approved.templateHash?.slice(0, 12)}...`);
    console.log(`Current hash:  ${candidate.templateHash?.slice(0, 12)}...`);
    console.log('');
    console.log('Changes:');
    for (const diff of diffs) {
      console.log(`  ${diff}`);
    }
    process.exit(12);
  }

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

  // --- pack ----------------------------------------------------------------

  if (parsed.subcommand === 'pack') {
    const { loadRecipe, packRecipe, writePackedRecipe } = await import('./recipe.js');

    let recipe;
    try {
      recipe = loadRecipe(parsed.recipePath);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const packed = packRecipe(recipe);
    const outputPath = parsed.outputPath || parsed.recipePath.replace(/\.recipe\.json$/, '.packed.json').replace(/\.json$/, '.packed.json');

    writePackedRecipe(packed, outputPath);

    if (parsed.json) {
      console.log(JSON.stringify({ status: 'packed', outputPath, contentHash: packed.content_hash, version: recipe.version }, null, 2));
    } else {
      console.log(`Packed recipe "${recipe.name}" v${recipe.version}`);
      console.log(`  Hash:   ${packed.content_hash}`);
      console.log(`  Output: ${outputPath}`);
    }
    process.exit(0);
  }

  // --- adapter dispatch -----------------------------------------------------

  if (parsed.subcommand === 'adapter') {
    const { runAdapterCli } = await import('./adapter-cli.js');
    await runAdapterCli(parsed.adapterArgv || [], { jsonOutput: parsed.json });
    process.exit(0);
  }

  // --- recipe validate -----------------------------------------------------

  if (parsed.subcommand === 'recipe-validate') {
    const { loadRecipe } = await import('./recipe.js');

    try {
      const recipe = loadRecipe(parsed.recipePath);
      if (parsed.json) {
        console.log(JSON.stringify({ valid: true, id: recipe.id, version: recipe.version }));
      } else {
        console.log(`Recipe "${recipe.name}" v${recipe.version} is valid.`);
        console.log(`  ID:       ${recipe.id}`);
        console.log(`  Risk:     ${recipe.risk_level}`);
        console.log(`  Approval: ${recipe.approval_required ? 'required' : 'not required'}`);
        console.log(`  Steps:    ${recipe.steps.length}`);
        console.log(`  Inputs:   ${Object.keys(recipe.inputs).length}`);
      }
      process.exit(0);
    } catch (err) {
      if (parsed.json) {
        console.log(JSON.stringify({ valid: false, errors: err.errors || [err.message] }));
      } else {
        console.error(err.message);
      }
      process.exit(1);
    }
  }

  // --- recipe inspect ------------------------------------------------------

  if (parsed.subcommand === 'recipe-inspect') {
    const { loadPackedRecipe } = await import('./recipe.js');

    try {
      const result = loadPackedRecipe(parsed.recipePath);
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Recipe: ${result.recipe.name} v${result.recipe.version}`);
        console.log(`  ID:       ${result.recipe.id}`);
        console.log(`  Hash:     ${result.contentHash}`);
        console.log(`  Verified: ${result.verified ? 'YES — content matches hash' : 'FAILED — content tampered'}`);
        console.log(`  Packed:   ${result.packedAt}`);
        console.log(`  Risk:     ${result.recipe.risk_level}`);
        console.log(`  Steps:    ${result.recipe.steps.length}`);
      }
      process.exit(result.verified ? 0 : 1);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // --- recipe versions ------------------------------------------------------

  if (parsed.subcommand === 'recipe-versions') {
    const { listVersions } = await import('./recipe-install.js');
    const recipeId = parsed.recipePath; // reused field
    const versions = listVersions(recipeId);
    if (parsed.json) {
      console.log(JSON.stringify({ id: recipeId, versions }));
    } else if (versions.length === 0) {
      console.log(`No installed versions of "${recipeId}".`);
    } else {
      console.log(`Versions of "${recipeId}":`);
      for (const v of versions) {
        console.log(`  ${v}`);
      }
    }
    process.exit(0);
  }

  // --- recipe install -------------------------------------------------------

  if (parsed.subcommand === 'recipe-install') {
    const source = parsed.recipePath;
    try {
      let result;
      if (parsed.registry) {
        const { installFromRegistry } = await import('./recipe-install.js');
        result = await installFromRegistry(source, parsed.registry, { force: parsed.force });
      } else if (source.startsWith('github://')) {
        const { installFromGitHub } = await import('./recipe-install.js');
        result = await installFromGitHub(source, { force: parsed.force });
      } else if (source.startsWith('http://') || source.startsWith('https://')) {
        const { installFromUrl } = await import('./recipe-install.js');
        result = await installFromUrl(source, { force: parsed.force });
      } else if (/^[a-z][a-z0-9-]*$/.test(source) && !existsSync(source)) {
        // Looks like a recipe name, not a file path
        console.error(
          `Recipe "${source}" is not a local path, URL, or github:// source.\n` +
          'To install from the public registry, use the full GitHub URL:\n' +
          `  guardrail recipe install github://guardrail-dev/recipes/<category>/${source}.json@<sha>\n` +
          'Browse available recipes at: https://github.com/guardrail-dev/recipes'
        );
        process.exit(1);
      } else {
        const { installFromPath } = await import('./recipe-install.js');
        result = installFromPath(source, { force: parsed.force });
      }
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Installed recipe "${result.id}" v${result.version}`);
        console.log(`  Path: ${result.path}`);
        console.log(`  Hash: ${result.hash}`);
        if (result.pin) {
          console.log(`  SHA:  ${result.pin.sha}`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (parsed.subcommand === 'recipe-compose') {
    try {
      const { composeRecipeArtifact } = await import('./recipe-compose.js');
      const result = composeRecipeArtifact({
        transportSpecifier: parsed.transportRecipe,
        execSpecifier: parsed.execRecipe,
        transportStepId: parsed.transportStep || null,
        searchDirs: parsed.recipeSearchDirs || [],
        outputPath: parsed.outputPath,
        name: parsed.name,
        category: parsed.category,
        description: parsed.description,
        version: parsed.version,
      });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Wrote composed recipe: ${result.outputPath}`);
        console.log(`  Transport: ${result.transport.specifier}`);
        console.log(`  Exec:      ${result.exec.specifier}`);
        console.log(`  Recipe id: ${result.recipe.id}`);
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (parsed.subcommand === 'recipe-registry-export') {
    try {
      const { exportRecipeRegistry } = await import('./recipe-registry.js');
      const { buildRecipeSearchDirs } = await import('./recipe-runner.js');
      const searchDirs = buildRecipeSearchDirs({
        explicitSearchDirs: parsed.recipeSearchDirs || [],
        projectRoot: process.cwd(),
        basePath: process.cwd(),
        includeDefaults: true,
      });
      const result = exportRecipeRegistry(parsed.outputPath, searchDirs);
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Exported recipe registry snapshot to ${result.outputDir}`);
        console.log(`  Recipes: ${result.count}`);
        console.log(`  Generated: ${result.generatedAt}`);
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (parsed.subcommand === 'recipe-registry-list') {
    try {
      const { listRegistryRecipes } = await import('./recipe-install.js');
      const result = await listRegistryRecipes(parsed.registry, {});
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Recipe registry: ${result.registry}`);
        console.log(`  Recipes: ${result.count}`);
        if (result.generated_at) {
          console.log(`  Generated: ${result.generated_at}`);
        }
        for (const recipe of result.recipes) {
          console.log(`  ${recipe.category}/${recipe.id}@${recipe.latest_version}`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // --- recipe publish -------------------------------------------------------

  if (parsed.subcommand === 'recipe-publish') {
    try {
      const { publishRecipe } = await import('./recipe-publish.js');
      const result = await publishRecipe({
        name: parsed.name,
        category: parsed.category,
        description: parsed.description,
        version: parsed.version,
        author: parsed.author,
        dryRun: parsed.dryRun,
        manifestPath: parsed.manifestPath,
      });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

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

  // --- workflow lint --------------------------------------------------------

  if (parsed.subcommand === 'workflow-lint') {
    if (!parsed.definition) {
      console.error('Error: --definition <path> is required for workflow lint');
      process.exit(1);
    }

    const { loadWorkflowDefinition, lintWorkflowDefinition, normalizeWorkflowDefinition } = await import('./workflow.js');

    let def;
    try {
      def = loadWorkflowDefinition(parsed.definition);
      normalizeWorkflowDefinition(def, dirname(resolve(parsed.definition)), {
        recipeSearchDirs: parsed.recipeSearchDirs,
        envAllow: parsed.envAllow,
      });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const { errors, warnings } = lintWorkflowDefinition(def);

    if (errors.length === 0 && warnings.length === 0) {
      console.log('No issues found.');
      process.exit(0);
    }

    if (errors.length > 0) {
      console.error(`${errors.length} error${errors.length > 1 ? 's' : ''} (block approval):\n`);
      for (const e of errors) {
        console.error(`  ✗ ${e}`);
      }
    }
    if (warnings.length > 0) {
      console.error(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}:\n`);
      for (const w of warnings) {
        console.error(`  ⚠ ${w}`);
      }
    }
    process.exit(errors.length > 0 ? 1 : 0);
  }

  // --- workflow run ---------------------------------------------------------

  if (parsed.subcommand === 'workflow') {
    if (!parsed.definition) {
      console.error('Error: --definition <path> is required for workflow run');
      process.exit(1);
    }

    if (parsed.nonInteractive && parsed.manifest === null) {
      console.error('Error: --non-interactive requires --approved-manifest <path>');
      process.exit(10);
    }

    const { runWorkflowSupervisor } = await import('./workflow-supervisor.js');

    const wantStructuredResult = parsed.json || parsed.jsonStream;

    const result = await runWorkflowSupervisor({
      definitionPath: parsed.definition,
      manifestPath: parsed.manifest || '.guardrail/workflows/default.approved.json',
      nonInteractive: parsed.nonInteractive,
      jsonOutput: parsed.json || parsed.jsonStream,
      trustClass: parsed.trust,
      recipeSearchDirs: parsed.recipeSearchDirs,
      envAllow: parsed.envAllow,
      allowUnverified: parsed.allowUnverified || false,
      progressSink: parsed.jsonStream ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : null,
    });

    if (wantStructuredResult) {
      console.log(JSON.stringify(result, null, parsed.json ? 2 : 0));
    }

    const exitCode = STATUS_EXIT_CODES[result.status] ?? 1;
    process.exit(exitCode);
  }

  // --- run --recipe ---------------------------------------------------------

  if (parsed.subcommand === 'run' && parsed.recipeId) {
    try {
      if (parsed.dryRunOnly) {
        const { runRecipeById } = await import('./recipe-runner.js');
        const result = await runRecipeById(parsed.recipeId, {
          inputs: parsed.inputs,
          allowUnverified: parsed.allowUnverified || false,
          dryRunOnly: true,
          cwd: process.cwd(),
        });
        if (parsed.json || parsed.jsonStream) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Recipe: ${result.recipe.name} v${result.recipe.version}`);
          console.log(`  Steps: ${result.steps.length}`);
          console.log(`  Safe:  ${result.safe ? 'YES' : 'NO — blocked steps detected'}`);
          for (const step of result.steps) {
            const icon = step.dangerous || !step.inScope ? '✗' : '✓';
            console.log(`  ${icon} ${step.id}: ${step.command} ${step.args.join(' ')}`);
          }
        }
        process.exit(result.status === 'dry_run' ? 0 : 1);
      }

      if (parsed.nonInteractive && parsed.manifest === null) {
        console.error('Error: --non-interactive requires --approved-manifest <path>');
        process.exit(10);
      }

      const { runRecipeSupervisor } = await import('./recipe-supervisor.js');
      const result = await runRecipeSupervisor({
        specifier: parsed.recipeId,
        inputs: parsed.inputs,
        allowUnverified: parsed.allowUnverified || false,
        cwd: process.cwd(),
        envAllow: parsed.envAllow,
        manifestPath: parsed.manifest || null,
        nonInteractive: parsed.nonInteractive,
        jsonOutput: parsed.json || parsed.jsonStream,
        trustClass: parsed.trust,
        progressSink: parsed.jsonStream ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : null,
      });

      if (parsed.json || parsed.jsonStream) {
        console.log(JSON.stringify(result, null, 2));
      }
      const exitCode = STATUS_EXIT_CODES[result.status] ?? 1;
      process.exit(exitCode);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // --- run --template ------------------------------------------------------

  if (parsed.subcommand === 'run' && parsed.template !== null) {
    if (parsed.nonInteractive && parsed.manifest === null) {
      console.error('Error: --non-interactive requires --approved-manifest <path>');
      process.exit(10);
    }

    const { runTemplateSupervisor } = await import('./template-supervisor.js');

    const result = await runTemplateSupervisor({
      templatePath: parsed.template,
      inputs: parsed.inputs,
      manifestPath: parsed.manifest || null,
      nonInteractive: parsed.nonInteractive,
      jsonOutput: parsed.json || parsed.jsonStream,
      envAllow: parsed.envAllow,
      progressSink: parsed.jsonStream ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : null,
    });

    if (parsed.json || parsed.jsonStream) {
      console.log(JSON.stringify(result, null, 2));
    }

    const exitCode = STATUS_EXIT_CODES[result.status] ?? 1;
    process.exit(exitCode);
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
