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
  collectRecipeInputContentHashes,
  verifyRecipeInputContentHashes,
} from './prompt-inputs.js';
import {
  emitProgress,
  emitExecutionEnd,
  mapResultStatusToProgressStatus,
} from './progress-events.js';
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

function emitRecipeProgress(progressSink, runId, event, data = {}) {
  emitProgress(progressSink, runId, 'recipe', event, data);
}

function emitRecipeExecutionEnd(progressSink, runId, finalStatus, context = {}) {
  emitExecutionEnd(progressSink, runId, 'recipe', finalStatus, context);
}

function emitRecipeStepResult(progressSink, runId, finalStatus, context = {}) {
  const progressStatus = mapResultStatusToProgressStatus(finalStatus);
  const event = progressStatus === 'blocked'
    ? 'step_blocked'
    : progressStatus === 'failed'
      ? 'step_failed'
      : 'step_completed';

  emitRecipeProgress(progressSink, runId, event, {
    stepId: context.recipeId || 'recipe',
    stepType: 'recipe',
    stepResult: finalStatus,
    ...context,
  });
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

const HOST_BOUNDARY_RECIPE_IDS = new Set(['claude-exec', 'codex-exec']);
const HOST_BOUNDARY_WARNING = 'Guardrail does not sandbox host execution; this wrapper relies on the tool/runtime permission model';

function hasHostBoundaryWarning(recipe) {
  return HOST_BOUNDARY_RECIPE_IDS.has(recipe?.id);
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

  if (hasHostBoundaryWarning(recipe)) {
    riskReasons.push(HOST_BOUNDARY_WARNING);
    riskLevel = maxRisk(riskLevel, 'yellow');
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
  if (hasHostBoundaryWarning(recipe)) {
    line(lv('Host boundary', colorize('Guardrail does not provide outer sandboxing for this recipe.', 'yellow')));
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

function formatReviewEachTimeReason(flaggedInputs) {
  const keys = flaggedInputs
    .filter((entry) => entry?.never_reuse)
    .map((entry) => entry.key);
  if (keys.length === 0) return null;
  return `Fresh approval required for review_each_time inputs: ${keys.join(', ')}`;
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
  progressSink = null,
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
  const emitFinalResult = (status, opts = {}) => {
    const result = buildResult(runId, status, { ...resultOpts, ...opts });
    emitRecipeExecutionEnd(progressSink, runId, status, {
      message: result.reason || opts.reason || '',
      stepsExecuted: opts.stepsExecuted ?? 0,
    });
    return result;
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
      return emitFinalResult('internal_error', { ...resultOpts, reason: err.message });
    }

    const { recipe, sourcePath, version } = resolvedRecipe;
    state.recipeId = recipe.id;
    state.recipeVersion = version;
    state.resolutionMode = resultOpts.resolutionMode;
    resultOpts.recipeId = recipe.id;
    resultOpts.recipeVersion = version;
    resultOpts.sourcePath = sourcePath;

    let resolvedInputs;
    let flaggedInputs = [];
    let inputContentHashes;
    try {
      const inputResult = resolveInputs(recipe, inputs);
      resolvedInputs = inputResult.resolved;
      flaggedInputs = inputResult.flagged;
      inputContentHashes = collectRecipeInputContentHashes(recipe, resolvedInputs, {
        cwd: resolvedCwd,
      });
    } catch (err) {
      if (!jsonOutput) {
        printResult({ success: false, exitCode: 1, message: err.message });
      }
      return emitFinalResult('validation_failed', { ...resultOpts, reason: err.message });
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
      inputContentHashes,
    });

    let approved = null;
    try {
      approved = loadManifest(manifestPath);
    } catch (err) {
      logger.error('manifest_load_error', { path: manifestPath, error: err.message });
    }

    let needsApproval = false;
    let driftDiffs = [];
    const reviewEachTimeReason = formatReviewEachTimeReason(flaggedInputs);
    if (approved === null) {
      needsApproval = true;
      logger.info('no_approved_manifest', { path: manifestPath });
    } else {
      const comparison = compareRecipeManifests(candidate, approved);
      needsApproval = !comparison.matches;
      driftDiffs = comparison.diffs;
      if (!needsApproval && reviewEachTimeReason) {
        needsApproval = true;
        logger.info('recipe_review_each_time_reapproval', {
          recipeId: recipe.id,
          inputs: flaggedInputs.filter((entry) => entry?.never_reuse).map((entry) => entry.key),
        });
      }
      if (needsApproval) {
        if (driftDiffs.length > 0) {
          logger.warn('recipe_drift_detected', { diffs: driftDiffs });
        }
      } else {
        logger.info('manifest_matches', { recipeHash, manifestPath });
      }
    }

    if (nonInteractive && approved !== null && !needsApproval) {
      if (!approved.riskAssessment?.acknowledgedBy) {
        const reason = 'Approved recipe manifest has no acknowledged risk assessment. Run interactively first.';
        state.terminalReason = reason;
        persistStateSafe(stateDir, state);
        emitRecipeProgress(progressSink, runId, 'approval_pending', {
          reason,
          message: reason,
        });
        if (!jsonOutput) {
          printResult({ success: false, exitCode: STATUS_EXIT_CODES.approval_required, message: reason });
        }
        return emitFinalResult('approval_required', { ...resultOpts, reason });
      }
    }

    if (needsApproval) {
      if (nonInteractive) {
        const reason = approved === null
          ? 'No approved manifest found. Run interactively to approve.'
          : driftDiffs.length > 0
            ? 'Recipe drift detected in non-interactive mode.'
            : reviewEachTimeReason;
        state.terminalReason = reason;
        persistStateSafe(stateDir, state);
        emitRecipeProgress(progressSink, runId, 'approval_pending', {
          reason,
          message: reason,
        });
        if (!jsonOutput) {
          if (driftDiffs.length > 0) printRecipeDrift(driftDiffs);
          printResult({ success: false, exitCode: STATUS_EXIT_CODES[approved === null ? 'approval_required' : 'drift_detected'], message: reason });
        }
        const status = approved === null
          ? 'approval_required'
          : driftDiffs.length > 0
            ? 'drift_detected'
            : 'approval_required';
        return emitFinalResult(status, {
          ...resultOpts,
          reason,
        });
      }

      if (!process.stdin.isTTY) {
        const reason = 'Interactive approval needed but stdin is not a TTY.';
        state.terminalReason = reason;
        persistStateSafe(stateDir, state);
        emitRecipeProgress(progressSink, runId, 'approval_pending', {
          reason,
          message: reason,
        });
        if (!jsonOutput) {
          printResult({ success: false, exitCode: STATUS_EXIT_CODES.unsupported, message: reason });
        }
        return emitFinalResult('unsupported', { ...resultOpts, reason });
      }

      if (!jsonOutput) {
        printBanner();
        if (driftDiffs.length > 0) printRecipeDrift(driftDiffs);
        printRecipeApprovalSummary(recipe, resolvedInputs, riskAssessment, sourcePath, requestedVersion);
        if (reviewEachTimeReason) {
          process.stdout.write(colorize(`  ${reviewEachTimeReason}\n\n`, 'yellow'));
        }
      }

      emitRecipeProgress(progressSink, runId, 'approval_pending', {
        reason: 'Recipe approval required.',
        message: 'Recipe approval required.',
      });
      const userApproved = await promptApproval(riskAssessment.riskLevel);
      if (!userApproved) {
        const reason = 'Recipe approval denied by user.';
        state.terminalReason = reason;
        persistStateSafe(stateDir, state);
        if (!jsonOutput) printDenied();
        return emitFinalResult('approval_denied', { ...resultOpts, reason });
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
        return emitFinalResult('internal_error', { ...resultOpts, reason });
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
        return emitFinalResult('time_policy_violated', { ...resultOpts, reason });
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
        return emitFinalResult('concurrent_blocked', { ...resultOpts, reason });
      }
    lockRelease = lockResult.release;

    emitRecipeProgress(progressSink, runId, 'execution_start', {
      message: `Recipe execution started for ${recipe.id}`,
      recipeId: recipe.id,
      stepId: 'recipe',
      stepType: 'recipe',
    });

    const approvedForExecution = approved !== null && !needsApproval ? approved : candidate;
    const inputHashCheck = verifyRecipeInputContentHashes(approvedForExecution.inputContentHashes);
    if (!inputHashCheck.verified) {
      const reason = inputHashCheck.errors.join('; ');
      auditLog.append({ event: 'blocked', trace_id: runId, manifest_hash: recipeHash, reason });
      state.terminalReason = reason;
      persistStateSafe(stateDir, state);
      if (!jsonOutput) {
        printResult({ success: false, exitCode: STATUS_EXIT_CODES.drift_detected, message: `Recipe input file drift detected: ${reason}` });
      }
      return emitFinalResult('drift_detected', { ...resultOpts, reason });
    }

    emitRecipeProgress(progressSink, runId, 'step_started', {
      stepId: 'recipe',
      stepType: 'recipe',
      message: `Starting execution of recipe ${recipe.id}`,
      attempt: 1,
    });

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
      emitRecipeStepResult(progressSink, runId, 'success', {
        recipeId: recipe.id,
        message: `Recipe "${recipe.id}@${recipe.version}" executed successfully.`,
        attempt: 1,
        stepResult: 'success',
      });
      return emitFinalResult('success', resultOpts);
    }

    const mappedStatus = execution.status === 'blocked'
      ? 'policy_violation'
      : execution.status === 'failed'
        ? 'validation_failed'
        : execution.status;

    const reason = execution.reason || `Recipe execution ended with status: ${execution.status}`;
    state.terminalReason = reason;
    persistStateSafe(stateDir, state);
    emitRecipeStepResult(progressSink, runId, mappedStatus, {
      recipeId: recipe.id,
      message: reason,
      attempt: 1,
      stepResult: mappedStatus,
    });
    if (!jsonOutput) {
      printResult({
        success: false,
        exitCode: STATUS_EXIT_CODES[mappedStatus] ?? 1,
        message: reason,
      });
    }
    return emitFinalResult(mappedStatus, { ...resultOpts, reason });
  } catch (err) {
    const reason = err?.message || String(err);
    state.terminalReason = reason;
    persistStateSafe(stateDir, state);
    if (!jsonOutput) {
      printResult({ success: false, exitCode: STATUS_EXIT_CODES.internal_error, message: reason });
    }
    return emitFinalResult('internal_error', { ...resultOpts, reason });
  } finally {
    if (typeof lockRelease === 'function') {
      lockRelease();
    }
  }
}
