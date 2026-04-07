import { join, resolve } from 'node:path';

import { resolveRecipeById, resolveInputs, parseRecipeSpecifier } from './recipe-runner.js';
import {
  hashRecipe,
  createRecipeManifest,
  compareRecipeManifests,
} from './recipe.js';
import { executeRecipe } from './recipe-executor.js';
import { classifyTrust } from './recipe-channel.js';
import { saveManifest, loadManifest } from './manifest.js';
import {
  createLogger,
  printBanner,
  printDenied,
  printResult,
  generateRunId,
  colorize,
  riskColor,
} from './logger.js';
import { promptApproval, STATUS_EXIT_CODES } from './supervisor.js';
import { persistStateSafe } from './shared.js';
import { checkTimePolicy, acquireLock } from './runtime-policy.js';
import { createAuditLog } from './audit.js';

function buildResult(runId, status, opts = {}) {
  return {
    runId,
    status,
    recipeId:        opts.recipeId        ?? '',
    recipeVersion:   opts.recipeVersion   ?? '',
    recipeHash:      opts.recipeHash      ?? '',
    manifestPath:    opts.manifestPath    ?? '',
    riskLevel:       opts.riskLevel       ?? '',
    riskReasons:     opts.riskReasons     ?? [],
    stepsExecuted:   opts.stepsExecuted   ?? 0,
    reason:          opts.reason          ?? null,
    sourcePath:      opts.sourcePath      ?? '',
    resolutionMode:  opts.resolutionMode  ?? 'latest',
    requestedVersion: opts.requestedVersion ?? null,
    exitCode: STATUS_EXIT_CODES[status] ?? STATUS_EXIT_CODES.internal_error,
  };
}

function makeState(runId) {
  return {
    runId,
    kind: 'recipe',
    recipeId: '',
    recipeVersion: '',
    resolutionMode: 'latest',
    stepsExecuted: 0,
    terminalReason: null,
  };
}

function mapRecipeRiskLevel(level) {
  if (level === 'low') return 'green';
  if (level === 'medium') return 'yellow';
  return 'red';
}

function maxRisk(a, b) {
  const rank = { green: 0, yellow: 1, red: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function evaluateRecipeRisk(recipe, options = {}) {
  const trust = classifyTrust(recipe);
  const riskReasons = [];
  let riskLevel = mapRecipeRiskLevel(recipe.risk_level);

  if (recipe.risk_level) {
    riskReasons.push(`recipe declares ${recipe.risk_level} risk`);
  }

  if ((recipe.steps || []).length > 1) {
    riskReasons.push('multi-step recipe');
    riskLevel = maxRisk(riskLevel, 'yellow');
  }

  if (recipe.approval_required) {
    riskReasons.push('recipe metadata marks execution as approval-sensitive');
  }

  if (!trust.verified) {
    riskReasons.push('recipe is from the community channel');
    riskLevel = maxRisk(riskLevel, options.trustClass ? 'yellow' : 'red');
    if (options.allowUnverified) {
      riskReasons.push('community recipe execution explicitly enabled with --allow-unverified');
    }
  }

  const trustClass = options.trustClass ?? (trust.verified ? 'pinned_external' : 'unknown');

  return {
    trustClass,
    riskLevel,
    reasons: riskReasons,
    requiresStrongConfirmation: riskLevel === 'red',
  };
}

function defaultRecipeManifestPath(cwd, recipeId) {
  return resolve(cwd, '.guardrail', 'recipes', `${recipeId}.approved.json`);
}

function printRecipeApprovalSummary(recipe, resolvedInputs, riskAssessment, sourcePath, requestedVersion) {
  const line = (text = '') => process.stdout.write(text + '\n');
  const sep = () => line(colorize('─'.repeat(56), 'dim'));
  const lv = (label, value) => {
    const padded = (label + ':').padEnd(20);
    return `  ${colorize(padded, 'dim')} ${value}`;
  };

  line();
  line(colorize('  Recipe Summary', 'bold'));
  sep();
  line(lv('Recipe', `${recipe.id}@${recipe.version}`));
  line(lv('Requested version', requestedVersion ?? '(latest)'));
  line(lv('Resolution mode', requestedVersion ? 'pinned' : 'latest'));
  line(lv('Channel', recipe.channel ?? 'community'));
  if (sourcePath) line(lv('Source', sourcePath));
  if (Object.keys(resolvedInputs).length > 0) {
    line(lv('Inputs', JSON.stringify(resolvedInputs)));
  }
  sep();
  line(lv('Trust class', riskAssessment.trustClass));
  line(lv('Risk level', colorize(riskAssessment.riskLevel.toUpperCase(), riskColor(riskAssessment.riskLevel))));
  if (riskAssessment.reasons.length > 0) {
    line(lv('Risk reasons', ''));
    for (const reason of riskAssessment.reasons) {
      line(`                       ${colorize('- ' + reason, 'yellow')}`);
    }
  }
  sep();
  line();
  line(colorize('  You are responsible for approving this recipe execution.', 'bold'));
  line(colorize('  Guardrail highlights risk; it does not certify safety.', 'dim'));
  line(colorize('  The approved manifest becomes the reusable approval record.', 'dim'));
  line();
}

function printRecipeDrift(diffs) {
  process.stdout.write('\n');
  process.stdout.write(colorize('  Recipe drift detected\n', 'yellow'));
  process.stdout.write('\n');
  if (diffs.length > 0) {
    process.stdout.write(colorize('  Requested change:\n', 'bold'));
    for (const diff of diffs) {
      process.stdout.write(colorize(`  ${diff}\n`, 'green'));
    }
  }
  process.stdout.write('\n');
  process.stdout.write(colorize('  This is outside your approved recipe contract.\n', 'yellow'));
  process.stdout.write('\n');
}

export async function runRecipeSupervisor(options) {
  const {
    specifier,
    inputs = {},
    cwd = process.cwd(),
    manifestPath: rawManifestPath,
    nonInteractive = false,
    jsonOutput = false,
    allowUnverified = false,
    trustClass = null,
    searchDirs,
    runtimeLimits = null,
  } = options;

  const runId = generateRunId();
  const resolvedCwd = resolve(cwd);
  const stateDir = join(resolvedCwd, '.guardrail');
  const logDir = join(stateDir, 'logs');
  const logger = createLogger(runId, logDir);
  const state = makeState(runId);
  const resultOpts = {
    recipeId: '',
    recipeVersion: '',
    recipeHash: '',
    manifestPath: '',
    riskLevel: '',
    riskReasons: [],
    stepsExecuted: 0,
    reason: null,
    sourcePath: '',
    resolutionMode: 'latest',
    requestedVersion: null,
  };

  let lockRelease = null;

  try {
    const { version: requestedVersion } = parseRecipeSpecifier(specifier);
    resultOpts.requestedVersion = requestedVersion;
    resultOpts.resolutionMode = requestedVersion ? 'pinned' : 'latest';

    let resolvedRecipe;
    try {
      resolvedRecipe = resolveRecipeById(specifier, searchDirs);
    } catch (err) {
      if (!jsonOutput) {
        printResult({ success: false, exitCode: 1, message: err.message });
      }
      return buildResult(runId, 'internal_error', { ...resultOpts, reason: err.message });
    }

    const { recipe, sourcePath, version } = resolvedRecipe;
    state.recipeId = recipe.id;
    state.recipeVersion = version;
    state.resolutionMode = resultOpts.resolutionMode;
    resultOpts.recipeId = recipe.id;
    resultOpts.recipeVersion = version;
    resultOpts.sourcePath = sourcePath;

    let resolvedInputs;
    try {
      const inputResult = resolveInputs(recipe, inputs);
      resolvedInputs = inputResult.resolved;
    } catch (err) {
      if (!jsonOutput) {
        printResult({ success: false, exitCode: 1, message: err.message });
      }
      return buildResult(runId, 'validation_failed', { ...resultOpts, reason: err.message });
    }

    const recipeHash = hashRecipe(recipe);
    resultOpts.recipeHash = recipeHash;

    const riskAssessment = evaluateRecipeRisk(recipe, { allowUnverified, trustClass });
    resultOpts.riskLevel = riskAssessment.riskLevel;
    resultOpts.riskReasons = riskAssessment.reasons;

    const manifestPath = resolve(rawManifestPath || defaultRecipeManifestPath(resolvedCwd, recipe.id));
    resultOpts.manifestPath = manifestPath;

    const candidate = createRecipeManifest(recipe, recipeHash, riskAssessment, resolvedInputs, {
      cwd: resolvedCwd,
      projectRoot: resolvedCwd,
      sourcePath,
      requestedVersion,
      allowUnverified,
    });

    let approved = null;
    try {
      approved = loadManifest(manifestPath);
    } catch (err) {
      logger.error('manifest_load_error', { path: manifestPath, error: err.message });
    }

    let needsApproval = false;
    let driftDiffs = [];
    if (approved === null) {
      needsApproval = true;
      logger.info('no_approved_manifest', { path: manifestPath });
    } else {
      const comparison = compareRecipeManifests(candidate, approved);
      needsApproval = !comparison.matches;
      driftDiffs = comparison.diffs;
      if (needsApproval) {
        logger.warn('recipe_drift_detected', { diffs: driftDiffs });
      } else {
        logger.info('manifest_matches', { recipeHash, manifestPath });
      }
    }

    if (nonInteractive && approved !== null && !needsApproval) {
      if (!approved.riskAssessment?.acknowledgedBy) {
        const reason = 'Approved recipe manifest has no acknowledged risk assessment. Run interactively first.';
        state.terminalReason = reason;
        persistStateSafe(stateDir, state);
        if (!jsonOutput) {
          printResult({ success: false, exitCode: STATUS_EXIT_CODES.approval_required, message: reason });
        }
        return buildResult(runId, 'approval_required', { ...resultOpts, reason });
      }
    }

    if (needsApproval) {
      if (nonInteractive) {
        const reason = approved === null
          ? 'No approved manifest found. Run interactively to approve.'
          : 'Recipe drift detected in non-interactive mode.';
        state.terminalReason = reason;
        persistStateSafe(stateDir, state);
        if (!jsonOutput) {
          if (driftDiffs.length > 0) printRecipeDrift(driftDiffs);
          printResult({ success: false, exitCode: STATUS_EXIT_CODES[approved === null ? 'approval_required' : 'drift_detected'], message: reason });
        }
        return buildResult(runId, approved === null ? 'approval_required' : 'drift_detected', {
          ...resultOpts,
          reason,
        });
      }

      if (!process.stdin.isTTY) {
        const reason = 'Interactive approval needed but stdin is not a TTY.';
        state.terminalReason = reason;
        persistStateSafe(stateDir, state);
        if (!jsonOutput) {
          printResult({ success: false, exitCode: STATUS_EXIT_CODES.unsupported, message: reason });
        }
        return buildResult(runId, 'unsupported', { ...resultOpts, reason });
      }

      if (!jsonOutput) {
        printBanner();
        if (driftDiffs.length > 0) printRecipeDrift(driftDiffs);
        printRecipeApprovalSummary(recipe, resolvedInputs, riskAssessment, sourcePath, requestedVersion);
      }

      const userApproved = await promptApproval(riskAssessment.riskLevel);
      if (!userApproved) {
        const reason = 'Recipe approval denied by user.';
        state.terminalReason = reason;
        persistStateSafe(stateDir, state);
        if (!jsonOutput) printDenied();
        return buildResult(runId, 'approval_denied', { ...resultOpts, reason });
      }

      candidate.riskAssessment.acknowledgedBy = 'interactive_user';
      candidate.riskAssessment.acknowledgedAt = new Date().toISOString();
      try {
        saveManifest(candidate, manifestPath);
      } catch (err) {
        const reason = `Failed to save approved recipe manifest: ${err.message}`;
        state.terminalReason = reason;
        persistStateSafe(stateDir, state);
        if (!jsonOutput) {
          printResult({ success: false, exitCode: STATUS_EXIT_CODES.internal_error, message: 'Failed to save manifest.' });
        }
        return buildResult(runId, 'internal_error', { ...resultOpts, reason });
      }
    }

    const auditLog = createAuditLog(resolve(stateDir, 'audit.jsonl'));

    if (runtimeLimits) {
      const timeCheck = checkTimePolicy(runtimeLimits, recipeHash, stateDir);
      if (!timeCheck.allowed) {
        const reason = timeCheck.errors.map(e => e.detail).join('; ');
        auditLog.append({ event: 'blocked', trace_id: runId, manifest_hash: recipeHash, reason });
        state.terminalReason = reason;
        persistStateSafe(stateDir, state);
        if (!jsonOutput) {
          printResult({ success: false, exitCode: STATUS_EXIT_CODES.time_policy_violated, message: `Time policy violated: ${reason}` });
        }
        return buildResult(runId, 'time_policy_violated', { ...resultOpts, reason });
      }
    }

    const lockResult = acquireLock(recipeHash, [], stateDir);
    if (!lockResult.acquired) {
      const reason = lockResult.detail;
      auditLog.append({ event: 'blocked', trace_id: runId, manifest_hash: recipeHash, reason });
      state.terminalReason = reason;
      persistStateSafe(stateDir, state);
      if (!jsonOutput) {
        printResult({ success: false, exitCode: STATUS_EXIT_CODES.concurrent_blocked, message: `Concurrent execution blocked: ${reason}` });
      }
      return buildResult(runId, 'concurrent_blocked', { ...resultOpts, reason });
    }
    lockRelease = lockResult.release;

    const execution = await executeRecipe(recipe, resolvedInputs, {
      allowUnverified,
      cwd: resolvedCwd,
      stateDir,
      approved: true,
      traceId: runId,
      auditLog,
      manifestHash: recipeHash,
    });

    state.stepsExecuted = execution.stepsExecuted ?? 0;
    resultOpts.stepsExecuted = execution.stepsExecuted ?? 0;

    if (execution.status === 'success') {
      if (!jsonOutput) {
        printResult({ success: true, exitCode: 0, message: `Recipe "${recipe.id}@${recipe.version}" executed successfully.` });
      }
      return buildResult(runId, 'success', resultOpts);
    }

    const mappedStatus = execution.status === 'blocked'
      ? 'policy_violation'
      : execution.status === 'failed'
        ? 'validation_failed'
        : execution.status;

    const reason = execution.reason || `Recipe execution ended with status: ${execution.status}`;
    state.terminalReason = reason;
    persistStateSafe(stateDir, state);
    if (!jsonOutput) {
      printResult({
        success: false,
        exitCode: STATUS_EXIT_CODES[mappedStatus] ?? 1,
        message: reason,
      });
    }
    return buildResult(runId, mappedStatus, { ...resultOpts, reason });
  } catch (err) {
    const reason = err?.message || String(err);
    state.terminalReason = reason;
    persistStateSafe(stateDir, state);
    if (!jsonOutput) {
      printResult({ success: false, exitCode: STATUS_EXIT_CODES.internal_error, message: reason });
    }
    return buildResult(runId, 'internal_error', { ...resultOpts, reason });
  } finally {
    if (typeof lockRelease === 'function') {
      lockRelease();
    }
  }
}
