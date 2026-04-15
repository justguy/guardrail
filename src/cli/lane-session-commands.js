import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

export async function handleLaneSessionSubcommand(parsed, deps = {}) {
  const {
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
  } = deps;

  if (parsed.subcommand === 'lane-start') {
    const { assertValidResidentLaneTool, launchResidentLane, normalizeResidentLaneOptions: validateResidentLaneOptions } = await import('../resident-lane.js');
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
      if (summary.reused) console.log('  Reused:        yes');
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
    const { sendResidentLaneMessage } = await import('../resident-lane-client.js');
    const {
      assertValidResidentLaneTool,
      getResidentLaneResult,
      getResidentLaneStatus,
      waitForResidentLaneResult,
    } = await import('../resident-lane.js');
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
    const { sendResidentLaneMessage } = await import('../resident-lane-client.js');
    const {
      assertValidResidentLaneTool,
      getResidentLaneResult,
      getResidentLaneStatus,
      stopResidentLane,
      waitForResidentLaneResult,
    } = await import('../resident-lane.js');
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

  return false;
}
