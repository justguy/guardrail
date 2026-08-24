import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
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
  formatLaneResources,
  formatLaneScope,
  formatLaneTransportSummary,
  isLaneExpiredError,
  laneHasSelectionFilter,
  normalizeLaneCliOptions,
} from './helpers.js';

export async function handleLaneManagementSubcommand(parsed) {
  if (parsed.subcommand === 'lane-result') {
    const { getResidentLaneResult } = await import('../resident-lane.js');
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
    const { waitForResidentLaneResult } = await import('../resident-lane.js');
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
    const { stopResidentLane } = await import('../resident-lane.js');
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
    const { revokeResidentLane, revokeAllResidentLanes } = await import('../resident-lane.js');
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
    const { killResidentLane, killAllResidentLanes } = await import('../resident-lane.js');
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
    const { createKeyStore } = await import('../key-management.js');
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
    const { defaultSessionContractPath, revokeSessionContract } = await import('../agent-session.js');
    const { createAuditLog } = await import('../audit.js');
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
    const { extendResidentLane, getResidentLaneStatus } = await import('../resident-lane-core.js');
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
    const { cleanupResidentLane } = await import('../resident-lane.js');
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
    const { cleanupResidentLane, listResidentLanes, stopResidentLane } = await import('../resident-lane.js');
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
    const { listResidentLanes } = await import('../resident-lane.js');
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
    const { listResidentLaneAdapters } = await import('../resident-lane.js');
    const adapters = listResidentLaneAdapters();
    if (parsed.json) {
      console.log(JSON.stringify({ adapters }, null, 2));
    } else {
      console.log('Resident lane adapters:');
      for (const adapter of adapters) {
        console.log(`  ${adapter.id} - ${adapter.description}`);
        if (adapter.source) console.log(`    Source: ${adapter.source}`);
        if (Array.isArray(adapter.capabilities) && adapter.capabilities.length > 0) {
          console.log(`    Capabilities: ${adapter.capabilities.join(', ')}`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-inspect') {
    const { getResidentLaneHistory, getResidentLaneLogs, getResidentLaneResult, getResidentLaneStatus } = await import('../resident-lane.js');
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
      if (bundle.latestResult?.status) console.log(`  Result status:      ${bundle.latestResult.status}`);
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
    const { getResidentLaneHistory } = await import('../resident-lane.js');
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
    const { getResidentLaneTimeline } = await import('../resident-lane.js');
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
    const { getResidentLaneLogs } = await import('../resident-lane.js');
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
    const { pruneResidentLanes } = await import('../resident-lane.js');
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
      if (result.dryRun) console.log('  Mode: dry-run');
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
    const { getResidentLaneStatus } = await import('../resident-lane.js');
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

  return false;
}
