import { join, resolve } from 'node:path';
import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';

import { resolveRecipeById, resolveInputs, parseRecipeSpecifier } from './recipe-runner.js';
import {
  hashRecipe,
  createRecipeManifest,
  compareRecipeManifests,
  computeRecipeEnvIntersection,
} from './recipe.js';
import { executeRecipe } from './recipe-executor.js';
import { classifyTrust } from './recipe-channel.js';
import { saveManifest, loadManifest } from './manifest.js';
import {
  collectRecipeInputContentHashes,
  verifyRecipeInputContentHashes,
} from './prompt-inputs.js';
import { loadCommitPlan } from './commit-plan.js';
import {
  emitProgress,
  emitExecutionEnd,
  mapResultStatusToProgressStatus,
  emitAiProgress,
  parseAiProgressLine,
  AI_HEARTBEAT_POLICY,
  AI_SOFT_STATES,
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
import { createAuditLog } from './audit.js';
import {
  prepareSessionEnforcement,
  persistSessionContractAfterSuccess,
} from './agent-session-enforce.js';
import { checkEnvMappings, checkAuthPrerequisites, deriveAuthEnvRequirements } from './adapter-auth.js';
import { authorize, ACTIONS } from './authorization.js';

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

const HOST_BOUNDARY_RECIPE_IDS = new Set(['claude-exec', 'codex-exec', 'cmux-claude-exec']);
const HOST_BOUNDARY_WARNING = 'Guardrail does not sandbox host execution; this wrapper relies on the tool/runtime permission model';

// D0y: Recipe IDs that support the AI progress channel.
const AI_PROGRESS_RECIPE_IDS = new Set(['claude-exec', 'cmux-claude-exec']);

function isAiProgressRecipe(recipe) {
  return AI_PROGRESS_RECIPE_IDS.has(recipe?.id) &&
    recipe?.progress_channel?.enabled === true;
}

function resolveAiReportArtifactPath(resolvedCwd, resolvedInputs) {
  const reportArtifact = resolvedInputs?.report_artifact;
  if (typeof reportArtifact !== 'string' || reportArtifact.trim() === '') return null;
  const workingDir = typeof resolvedInputs?.working_dir === 'string' && resolvedInputs.working_dir.trim() !== ''
    ? resolve(resolvedCwd, resolvedInputs.working_dir)
    : resolvedCwd;
  return resolve(workingDir, reportArtifact);
}

function initAiProgressFiles(stateDir, initialState = null) {
  const progressFile = join(stateDir, 'ai-progress.ndjson');
  const progressStateFile = join(stateDir, 'ai-progress-state.json');
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    // Create (or truncate) the progress file so it exists before Claude starts.
    writeFileSync(progressFile, '');
    // Write initial progress state so the CLI inspection surface has something
    // to show even before the first AI checkpoint arrives.
    if (initialState) {
      writeFileSync(progressStateFile, JSON.stringify(initialState, null, 2) + '\n');
    }
  } catch {
    // Non-fatal: progress file creation must not abort the run.
  }
  return { progressFile, progressStateFile };
}

function readAiProgressState(progressStateFile) {
  if (!progressStateFile || !existsSync(progressStateFile)) return null;
  try {
    return JSON.parse(readFileSync(progressStateFile, 'utf8'));
  } catch {
    return null;
  }
}

function readAiProgressEvents(progressFile) {
  if (!progressFile || !existsSync(progressFile)) return [];
  try {
    return readFileSync(progressFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Build an onStderr relay callback for executeRecipe that parses
 * [guardrail-ai-progress] lines from the wrapper and emits them through the
 * progress sink as ai_checkpoint events. Also detects soft states and stores
 * any continuation-relevant session metadata.
 */
function buildAiProgressRelay({ progressSink, runId, stateDir, progressStateFile }) {
  let lineBuffer = '';
  let lastSoftState = null;
  // D0y: track time of the most recent AI progress event for stall detection.
  let lastEventTime = Date.now();

  return {
    onStderr(chunk) {
      lineBuffer += chunk;
      const parts = lineBuffer.split('\n');
      lineBuffer = parts.pop() ?? '';

      for (const line of parts) {
        const evt = parseAiProgressLine(line);
        if (!evt) continue;

        // Refresh the heartbeat timestamp on every successfully parsed event.
        lastEventTime = Date.now();

        emitAiProgress(progressSink, runId, evt.event ?? 'ai_checkpoint', {
          ...evt,
          tool: evt.tool ?? 'claude',
        });

        // Track soft states so the supervisor can surface continuation guidance.
        const state = evt.status ?? null;
        if (state && AI_SOFT_STATES.has(state)) {
          lastSoftState = state;
          // Persist updated state file with continuation hint.
          if (progressStateFile) {
            const current = readAiProgressState(progressStateFile) || {};
            const updated = {
              ...current,
              status: state,
              lastEvent: evt.event,
              lastMessage: evt.message ?? null,
              lastTimestamp: evt.timestamp ?? new Date().toISOString(),
              continuationCommand: buildContinuationCommand(stateDir, evt),
            };
            try {
              writeFileSync(progressStateFile, JSON.stringify(updated, null, 2) + '\n');
            } catch { /* non-fatal */ }
          }
        }
      }
    },
    getLastSoftState() { return lastSoftState; },
    /** Returns the epoch-ms timestamp of the last successfully parsed AI progress event. */
    getLastEventTime() { return lastEventTime; },
    noteSyntheticProgress(event, data = {}) {
      lastEventTime = Date.now();
      emitAiProgress(progressSink, runId, event, data);
    },
  };
}

function buildContinuationCommand(stateDir, _evt) {
  if (!stateDir) return null;
  return `guardrail recipe continue --state-dir ${stateDir} --prompt "<your response>"`;
}

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

function printRecipeApprovalSummary(
  recipe,
  resolvedInputs,
  riskAssessment,
  sourcePath,
  requestedVersion,
  envIntersection = [],
  executionDetails = null,
) {
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
  const llmBudget = resolvedInputs?.max_budget_usd;
  if (typeof llmBudget === 'string' && llmBudget.trim() !== '') {
    line(lv('LLM budget (USD)', llmBudget));
  }
  if (envIntersection.length > 0) {
    line(lv('Env vars passed', envIntersection.join(', ')));
  }
  if (executionDetails?.type === 'commit_plan') {
    line(lv('Commit plan', executionDetails.planFile));
    line(lv('Commit repo', executionDetails.repoPath));
    line(lv('Commit files', JSON.stringify(executionDetails.paths || [])));
    line(lv('Message file', executionDetails.messageFile));
    if (executionDetails.bounds) {
      line(lv('Commit bounds', JSON.stringify(executionDetails.bounds)));
    }
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

function deriveRecipeExecutionDetails(recipe, resolvedInputs, resolvedCwd) {
  if (recipe?.id !== 'git-commit-from-plan') return null;

  const planFile = resolvedInputs?.plan_file;
  const explicitMessageFile = resolvedInputs?.message_file;
  if (typeof planFile !== 'string' || planFile.trim() === '') {
    throw new Error('git-commit-from-plan requires plan_file.');
  }
  if (typeof explicitMessageFile !== 'string' || explicitMessageFile.trim() === '') {
    throw new Error('git-commit-from-plan requires message_file.');
  }

  const plan = loadCommitPlan(planFile, { cwd: resolvedCwd });
  if (plan.message_file !== explicitMessageFile) {
    throw new Error(
      `Commit plan message_file drift: ${plan.message_file} != ${explicitMessageFile}`,
    );
  }

  return {
    type: 'commit_plan',
    planFile,
    repoPath: plan.repo_path,
    resolvedRepoPath: plan.resolved_repo_path,
    paths: plan.paths,
    messageFile: plan.message_file,
    resolvedMessageFile: plan.resolved_message_file,
    bounds: plan.bounds,
  };
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

export function formatAllowUnverifiedReapprovalNotice(candidate, approved) {
  if (!candidate || !approved) return null;
  if (candidate.recipe?.allowUnverified !== true) return null;
  if (approved.recipe?.allowUnverified === true) return null;
  return [
    'Fresh approval required: this run newly enables execution of an unverified community recipe with --allow-unverified.',
    'The previous approval record did not authorize that trust boundary, so Guardrail requires a new approval record.',
  ];
}

function printRecipeReapprovalNotice(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  for (const line of lines) {
    process.stdout.write(colorize(`  ${line}\n`, 'yellow'));
  }
  process.stdout.write('\n');
}

function formatReviewEachTimeReason(flaggedInputs) {
  const keys = flaggedInputs
    .filter((entry) => entry?.never_reuse)
    .map((entry) => entry.key);
  if (keys.length === 0) return null;
  return `Fresh approval required for review_each_time inputs: ${keys.join(', ')}`;
}

function interpolateCompositionTemplate(template, resolvedInputs) {
  if (Array.isArray(template)) {
    return template.map((entry) => interpolateCompositionTemplate(entry, resolvedInputs));
  }
  if (template && typeof template === 'object') {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, interpolateCompositionTemplate(value, resolvedInputs)]),
    );
  }
  if (typeof template !== 'string') return template;

  const exact = template.match(/^\{\{inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/);
  if (exact) {
    return resolvedInputs[exact[1]];
  }

  return template.replace(/\{\{inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, key) => {
    const value = resolvedInputs[key];
    return value === undefined ? '' : String(value);
  });
}

function formatComposedReviewEachTimeReason(stepId, record) {
  const keys = (record.flaggedInputs || [])
    .filter((entry) => entry?.never_reuse)
    .map((entry) => entry.key);
  if (keys.length === 0) return null;
  return `Fresh approval required for composed exec inputs: step "${stepId}" -> ${record.recipe.id}: ${keys.join(', ')}`;
}

export async function preflightRecipeAuthRuntime({
  recipe,
  envAllow,
  cwd,
  authCheckFn,
  currentEnv = process.env,
  runAuthCheck = true,
}) {
  const requiredEnv = recipe.requires_env || [];
  const authRequirements = recipe.requires_auth || [];
  const combinedRequiredEnv = [
    ...new Set([
      ...requiredEnv,
      ...deriveAuthEnvRequirements(authRequirements, currentEnv),
    ]),
  ];
  const authEnvPolicy = recipe.preserve_runtime_env === true
    ? {
        inherit: true,
        inject: cwd ? { PWD: cwd } : {},
      }
    : {
        inherit: false,
        allow: [...new Set(['PATH', ...(envAllow || [])])],
        inject: cwd ? { PWD: cwd } : {},
      };

  if (requiredEnv.length > 0 && envAllow.length === 0) {
    return {
      ok: false,
      code: 'missing_auth_mapping',
      reason: [
        'Recipe requires explicit --env-allow for environment access.',
        `Required variables: ${requiredEnv.join(', ')}`,
      ].join('\n'),
    };
  }

  const envCheck = checkEnvMappings(requiredEnv, envAllow, {
    authRequirements,
    currentEnv,
  });
  if (!envCheck.ok) {
    return {
      ok: false,
      code: envCheck.code,
      reason: `${envCheck.code}: ${envCheck.message}`,
      missing: envCheck.missing || [],
    };
  }

  if (!runAuthCheck || authRequirements.length === 0) {
    return {
      ok: true,
      code: null,
      reason: null,
      envIntersection: computeRecipeEnvIntersection(combinedRequiredEnv, envAllow),
    };
  }

  const authCheck = await checkAuthPrerequisites(authRequirements, {
    cwd,
    checkRunner: authCheckFn,
    envPolicy: authEnvPolicy,
  });
  if (!authCheck.ok) {
    const detail = authCheck.detail ? ` Detail: ${authCheck.detail}` : '';
    return {
      ok: false,
      code: authCheck.code,
      reason: `${authCheck.code}: ${authCheck.message}${detail}`,
    };
  }

  return {
    ok: true,
    code: null,
    reason: null,
    envIntersection: computeRecipeEnvIntersection(combinedRequiredEnv, envAllow),
  };
}

function buildComposedManifestRecord(stepId, recipe, recipeHash, riskAssessment, resolvedInputs, options = {}) {
  const manifest = createRecipeManifest(recipe, recipeHash, riskAssessment, resolvedInputs, options);
  return {
    stepId,
    recipeHash: manifest.recipeHash,
    recipe: manifest.recipe,
    resolvedInputs: manifest.resolvedInputs,
    envIntersection: manifest.envIntersection,
    inputApprovalEnvelopes: manifest.inputApprovalEnvelopes,
    inputContentHashes: manifest.inputContentHashes,
    riskAssessment: manifest.riskAssessment,
  };
}

function printComposedRecipeSummary(records = []) {
  if (!Array.isArray(records) || records.length === 0) return;
  const line = (text = '') => process.stdout.write(text + '\n');
  for (const record of records) {
    line(colorize(`  Composed Exec (${record.stepId})`, 'bold'));
    line(colorize('─'.repeat(56), 'dim'));
    line(`  ${colorize('Recipe:'.padEnd(20), 'dim')} ${record.recipe.id}@${record.version}`);
    line(`  ${colorize('Channel:'.padEnd(20), 'dim')} ${record.recipe.channel ?? 'community'}`);
    if (record.sourcePath) {
      line(`  ${colorize('Source:'.padEnd(20), 'dim')} ${record.sourcePath}`);
    }
    if (Object.keys(record.resolvedInputs || {}).length > 0) {
      line(`  ${colorize('Inputs:'.padEnd(20), 'dim')} ${JSON.stringify(record.resolvedInputs)}`);
    }
    if ((record.envIntersection || []).length > 0) {
      line(`  ${colorize('Env vars passed:'.padEnd(20), 'dim')} ${record.envIntersection.join(', ')}`);
    }
    line(`  ${colorize('Hosted env mode:'.padEnd(20), 'dim')} isolated (env -i; only approved vars survive)`);
    line(`  ${colorize('Risk level:'.padEnd(20), 'dim')} ${colorize(record.riskAssessment.riskLevel.toUpperCase(), riskColor(record.riskAssessment.riskLevel))}`);
    line();
  }
}

async function prepareComposedRecipeBindings({
  recipe,
  resolvedInputs,
  resolvedCwd,
  searchDirs,
  allowUnverified,
  envAllow,
  trustClass,
  stateDir,
  authCheckFn,
}) {
  const records = [];
  const byStepId = {};
  const reviewReasons = [];
  const riskReasons = [];
  let aggregateRiskLevel = 'green';

  for (const step of recipe.steps || []) {
    if (!step.composed_recipe) continue;

    const childSpecifier = step.composed_recipe.recipe;
    const { version: childRequestedVersion } = parseRecipeSpecifier(childSpecifier);
    const childResolvedRecipe = resolveRecipeById(childSpecifier, searchDirs);
    const childRecipe = childResolvedRecipe.recipe;
    const childSourcePath = childResolvedRecipe.sourcePath;
    const childVersion = childResolvedRecipe.version;
    const childMappedInputs = interpolateCompositionTemplate(step.composed_recipe.inputs || {}, resolvedInputs);
    const childInputResult = resolveInputs(childRecipe, childMappedInputs);
    const childResolvedInputs = childInputResult.resolved;
    const childFlaggedInputs = childInputResult.flagged;
    const childInputContentHashes = collectRecipeInputContentHashes(childRecipe, childResolvedInputs, {
      cwd: resolvedCwd,
    });

    const childPreflight = await preflightRecipeAuthRuntime({
      recipe: childRecipe,
      envAllow,
      cwd: resolvedCwd,
      authCheckFn,
      runAuthCheck: false,
    });
    if (!childPreflight.ok) {
      throw new Error(
        `Composed exec recipe "${childRecipe.id}" failed preflight: ${childPreflight.reason}`,
      );
    }

    const childSessionEnforcement = prepareSessionEnforcement({
      recipe: childRecipe,
      resolvedInputs: childResolvedInputs,
      resolvedCwd,
      recipeVersion: childVersion,
      stateDir,
    });

    if (childSessionEnforcement.enforced && !childSessionEnforcement.evaluation.ok) {
      const evaluation = childSessionEnforcement.evaluation;
      throw new Error(
        `Composed exec session contract blocked for ${childRecipe.id}: ${evaluation.code} — ${evaluation.reason}`,
      );
    }

    const childRecipeHash = hashRecipe(childRecipe);
    const childRiskAssessment = evaluateRecipeRisk(childRecipe, { allowUnverified, trustClass });
    aggregateRiskLevel = maxRisk(aggregateRiskLevel, childRiskAssessment.riskLevel);
    riskReasons.push(
      `composed exec recipe ${childRecipe.id}@${childVersion} declares ${childRecipe.risk_level} risk`,
      ...childRiskAssessment.reasons.map((reason) => `${childRecipe.id}: ${reason}`),
    );

    const record = {
      stepId: step.id,
      recipe: childRecipe,
      sourcePath: childSourcePath,
      version: childVersion,
      requestedVersion: childRequestedVersion,
      recipeHash: childRecipeHash,
      resolvedInputs: childResolvedInputs,
      flaggedInputs: childFlaggedInputs,
      inputContentHashes: childInputContentHashes,
      envIntersection: childPreflight.envIntersection?.intersection || [],
      riskAssessment: childRiskAssessment,
      sessionEnforcement: childSessionEnforcement,
      manifestRecord: buildComposedManifestRecord(
        step.id,
        childRecipe,
        childRecipeHash,
        childRiskAssessment,
        childResolvedInputs,
        {
          cwd: resolvedCwd,
          projectRoot: resolvedCwd,
          sourcePath: childSourcePath,
          requestedVersion: childRequestedVersion,
          allowUnverified,
          envIntersection: childPreflight.envIntersection?.intersection || [],
          inputContentHashes: childInputContentHashes,
        },
      ),
    };

    const composedReviewReason = formatComposedReviewEachTimeReason(step.id, record);
    if (composedReviewReason) {
      reviewReasons.push(composedReviewReason);
    }

    records.push(record);
    byStepId[step.id] = record;
  }

  return {
    records,
    byStepId,
    reviewReasons,
    riskReasons,
    aggregateRiskLevel,
  };
}

function verifyComposedRecipeInputContentHashes(records = []) {
  const errors = [];
  for (const record of records) {
    const check = verifyRecipeInputContentHashes(record.inputContentHashes);
    if (!check.verified) {
      errors.push(
        ...check.errors.map((error) => `composed exec "${record.recipe.id}" (${record.stepId}): ${error}`),
      );
    }
  }
  return {
    verified: errors.length === 0,
    errors,
  };
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
    envAllow = [],
    trustClass = null,
    searchDirs,
    runtimeLimits = null,
    progressSink = null,
    executorFn = executeRecipe,
    promptApprovalFn = promptApproval,
    authCheckFn = null,
    delegatedApproval = null,
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
    let composedBindings = { records: [], byStepId: {}, reviewReasons: [], riskReasons: [], aggregateRiskLevel: 'green' };
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

    const preflight = await preflightRecipeAuthRuntime({
      recipe,
      envAllow,
      cwd: resolvedCwd,
      authCheckFn,
    });

    let sessionEnforcement = { enforced: false };
    try {
      sessionEnforcement = prepareSessionEnforcement({
        recipe,
        resolvedInputs,
        resolvedCwd,
        recipeVersion: version,
        stateDir,
      });
    } catch (err) {
      const reason = `Session contract preparation failed: ${err.message || String(err)}`;
      logger.error('session_contract_error', { recipeId: recipe.id, error: reason });
      state.terminalReason = reason;
      persistStateSafe(stateDir, state);
      emitRecipeProgress(progressSink, runId, 'approval_pending', { reason, message: reason });
      if (!jsonOutput) {
        printResult({
          success: false,
          exitCode: STATUS_EXIT_CODES.policy_violation,
          message: reason,
        });
      }
      return emitFinalResult('policy_violation', { ...resultOpts, reason });
    }

    const authGate = await authorize(ACTIONS.RECIPE_AUTH, { preflight, sessionEnforcement });
    if (!authGate.allowed) {
      logger.error('recipe_auth_denied', {
        recipeId: recipe.id,
        code:     authGate.code,
        reason:   authGate.reason,
      });
      state.terminalReason = authGate.reason;
      persistStateSafe(stateDir, state);
      emitRecipeProgress(progressSink, runId, 'approval_pending', { reason: authGate.reason, message: authGate.reason });
      if (!jsonOutput) {
        printResult({ success: false, exitCode: STATUS_EXIT_CODES.policy_violation, message: authGate.reason });
      }
      return emitFinalResult('policy_violation', { ...resultOpts, reason: authGate.reason });
    }

    const envResult = authGate.envIntersection;
    for (const warning of envResult.warnings) {
      logger.warn('recipe_env_warning', { recipeId: recipe.id, warning });
    }

    try {
      composedBindings = await prepareComposedRecipeBindings({
        recipe,
        resolvedInputs,
        resolvedCwd,
        searchDirs,
        allowUnverified,
        envAllow,
        trustClass,
        stateDir,
        authCheckFn,
      });
    } catch (err) {
      const reason = err.message || String(err);
      logger.error('composed_recipe_prepare_failed', { recipeId: recipe.id, error: reason });
      state.terminalReason = reason;
      persistStateSafe(stateDir, state);
      emitRecipeProgress(progressSink, runId, 'approval_pending', { reason, message: reason });
      if (!jsonOutput) {
        printResult({
          success: false,
          exitCode: STATUS_EXIT_CODES.policy_violation,
          message: reason,
        });
      }
      return emitFinalResult('policy_violation', { ...resultOpts, reason });
    }

    let executionDetails = null;
    try {
      executionDetails = deriveRecipeExecutionDetails(recipe, resolvedInputs, resolvedCwd);
    } catch (err) {
      const reason = err.message || String(err);
      logger.error('recipe_execution_details_failed', { recipeId: recipe.id, error: reason });
      state.terminalReason = reason;
      persistStateSafe(stateDir, state);
      emitRecipeProgress(progressSink, runId, 'approval_pending', { reason, message: reason });
      if (!jsonOutput) {
        printResult({ success: false, exitCode: 1, message: reason });
      }
      return emitFinalResult('validation_failed', { ...resultOpts, reason });
    }

    const recipeHash = hashRecipe(recipe);
    resultOpts.recipeHash = recipeHash;

    const riskAssessment = evaluateRecipeRisk(recipe, { allowUnverified, trustClass });
    if (composedBindings.records.length > 0) {
      riskAssessment.riskLevel = maxRisk(riskAssessment.riskLevel, composedBindings.aggregateRiskLevel);
      riskAssessment.reasons = [...riskAssessment.reasons, ...composedBindings.riskReasons];
      riskAssessment.requiresStrongConfirmation = riskAssessment.riskLevel === 'red';
    }
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
      envIntersection: envResult.intersection,
      inputContentHashes,
      executionDetails,
      composedRecipes: composedBindings.records.map((record) => record.manifestRecord),
    });

    let approved = null;
    try {
      approved = loadManifest(manifestPath);
    } catch (err) {
      logger.error('manifest_load_error', { path: manifestPath, error: err.message });
    }

    let needsApproval = false;
    let driftDiffs = [];
    let delegatedManifestReason = '';
    const reviewEachTimeReasons = [
      formatReviewEachTimeReason(flaggedInputs),
      ...composedBindings.reviewReasons,
    ].filter(Boolean);
    const reviewEachTimeReason = [...new Set(reviewEachTimeReasons)].join('\n');
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

    if (!needsApproval && approved?.riskAssessment?.delegated) {
      const delegatedRecord = approved.riskAssessment.delegated;
      if (delegatedApproval?.allowed !== true) {
        delegatedManifestReason = 'Approved recipe manifest was created by a delegated grant and requires an active delegated grant for reuse.';
        needsApproval = true;
      } else if (delegatedRecord.tool && delegatedRecord.tool !== delegatedApproval.tool) {
        delegatedManifestReason = 'Approved recipe manifest was created by a different delegated MCP tool and must be re-approved for this tool.';
        needsApproval = true;
      }
      if (delegatedManifestReason) {
        logger.warn('recipe_delegated_manifest_reapproval_required', {
          recipeId: recipe.id,
          manifestPath,
          reason: delegatedManifestReason,
        });
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
      if (delegatedApproval?.allowed === true) {
        const expectedRecipeHash = delegatedApproval.recipeHash ?? delegatedApproval.expectedRecipeHash ?? null;
        if (!expectedRecipeHash) {
          const reason = 'Delegated recipe approval requires a recipe_hash pinned in the active grant.';
          state.terminalReason = reason;
          persistStateSafe(stateDir, state);
          if (!jsonOutput) {
            printResult({ success: false, exitCode: STATUS_EXIT_CODES.policy_violation, message: reason });
          }
          return emitFinalResult('policy_violation', { ...resultOpts, reason });
        }
        if (expectedRecipeHash !== recipeHash) {
          const reason = 'Delegated recipe approval grant does not match the resolved recipe hash.';
          state.terminalReason = reason;
          persistStateSafe(stateDir, state);
          if (!jsonOutput) {
            printResult({ success: false, exitCode: STATUS_EXIT_CODES.policy_violation, message: reason });
          }
          return emitFinalResult('policy_violation', { ...resultOpts, reason });
        }
        candidate.riskAssessment.acknowledgedBy = delegatedApproval.actor || 'delegated_grant';
        candidate.riskAssessment.acknowledgedAt = new Date().toISOString();
        candidate.riskAssessment.delegated = {
          grantHash: delegatedApproval.grantHash ?? null,
          recipeHash,
          tool: delegatedApproval.tool ?? null,
          reason: delegatedApproval.reason ?? 'delegated approval',
        };
        try {
          saveManifest(candidate, manifestPath);
          approved = candidate;
          needsApproval = false;
          logger.info('recipe_delegated_approval', {
            recipeId: recipe.id,
            manifestPath,
            grantHash: delegatedApproval.grantHash ?? null,
          });
        } catch (err) {
          const reason = `Failed to save delegated recipe approval manifest: ${err.message}`;
          state.terminalReason = reason;
          persistStateSafe(stateDir, state);
          if (!jsonOutput) {
            printResult({ success: false, exitCode: STATUS_EXIT_CODES.internal_error, message: 'Failed to save manifest.' });
          }
          return emitFinalResult('internal_error', { ...resultOpts, reason });
        }
      }
    }

    if (needsApproval) {
      if (nonInteractive) {
        const reason = approved === null
          ? 'No approved manifest found. Run interactively to approve.'
          : driftDiffs.length > 0
            ? 'Recipe drift detected in non-interactive mode.'
            : delegatedManifestReason || reviewEachTimeReason;
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
        printRecipeReapprovalNotice(formatAllowUnverifiedReapprovalNotice(candidate, approved));
        printRecipeApprovalSummary(
          recipe,
          resolvedInputs,
          riskAssessment,
          sourcePath,
          requestedVersion,
          envResult.intersection,
          executionDetails,
        );
        printComposedRecipeSummary(composedBindings.records);
        if (reviewEachTimeReason) {
          process.stdout.write(colorize(`  ${reviewEachTimeReason}\n\n`, 'yellow'));
        }
      }

      emitRecipeProgress(progressSink, runId, 'approval_pending', {
        reason: 'Recipe approval required.',
        message: 'Recipe approval required.',
      });
      const userApproved = await promptApprovalFn(riskAssessment.riskLevel);
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

    const recipeRuntimeAuth = await authorize(ACTIONS.RECIPE_RUN, {
      runtimeLimits,
      manifestHash: recipeHash,
      stateDir,
    });
    if (!recipeRuntimeAuth.allowed) {
      logger.error('recipe_runtime_authorization_denied', {
        code:   recipeRuntimeAuth.code,
        reason: recipeRuntimeAuth.reason,
      });
      auditLog.append({ event: 'blocked', trace_id: runId, manifest_hash: recipeHash, reason: recipeRuntimeAuth.reason });
      state.terminalReason = recipeRuntimeAuth.reason;
      persistStateSafe(stateDir, state);
      if (!jsonOutput) {
        const status = recipeRuntimeAuth.code === 'time_policy_violated'
          ? 'time_policy_violated'
          : 'concurrent_blocked';
        printResult({ success: false, exitCode: STATUS_EXIT_CODES[status], message: recipeRuntimeAuth.reason });
      }
      const status = recipeRuntimeAuth.code === 'time_policy_violated'
        ? 'time_policy_violated'
        : 'concurrent_blocked';
      return emitFinalResult(status, { ...resultOpts, reason: recipeRuntimeAuth.reason });
    }
    lockRelease = recipeRuntimeAuth.release;

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

    const composedInputHashCheck = verifyComposedRecipeInputContentHashes(composedBindings.records);
    if (!composedInputHashCheck.verified) {
      const reason = composedInputHashCheck.errors.join('; ');
      auditLog.append({ event: 'blocked', trace_id: runId, manifest_hash: recipeHash, reason });
      state.terminalReason = reason;
      persistStateSafe(stateDir, state);
      if (!jsonOutput) {
        printResult({ success: false, exitCode: STATUS_EXIT_CODES.drift_detected, message: `Composed recipe input file drift detected: ${reason}` });
      }
      return emitFinalResult('drift_detected', { ...resultOpts, reason });
    }

    emitRecipeProgress(progressSink, runId, 'step_started', {
      stepId: 'recipe',
      stepType: 'recipe',
      message: `Starting execution of recipe ${recipe.id}`,
      attempt: 1,
    });

    // D0y: Set up the AI progress channel for AI-exec recipes.
    let aiProgressFile = null;
    let aiProgressStateFile = null;
    let aiProgressRelay = null;
    let aiReportArtifact = null;
    const executorEnvExtra = {};

    if (isAiProgressRecipe(recipe)) {
      aiReportArtifact = resolveAiReportArtifactPath(resolvedCwd, resolvedInputs);
      // Write an initial progress-state record so CLI inspection has something
      // to show even before the first checkpoint arrives from Claude.
      const initialProgressState = {
        runId,
        tool: 'claude',
        status: 'running',
        lastPhase: 'supervisor_init',
        sessionName: resolvedInputs.session_name ?? null,
        workingDir: resolvedInputs.working_dir ?? null,
        progressArtifact: null, // filled in below after path is known
        reportArtifact: aiReportArtifact,
        timestamp: new Date().toISOString(),
      };
      const progressPaths = initAiProgressFiles(stateDir, initialProgressState);
      aiProgressFile = progressPaths.progressFile;
      aiProgressStateFile = progressPaths.progressStateFile;

      // Back-fill artifact paths into the state file now that we know them.
      try {
        const existing = JSON.parse(readFileSync(aiProgressStateFile, 'utf8'));
        existing.progressArtifact = aiProgressFile;
        existing.reportArtifact = aiReportArtifact;
        writeFileSync(aiProgressStateFile, JSON.stringify(existing, null, 2) + '\n');
      } catch { /* non-fatal */ }

      // Inject env vars so the wrapper picks them up at spawn time.
      executorEnvExtra.GUARDRAIL_AI_PROGRESS_FILE = aiProgressFile;
      executorEnvExtra.GUARDRAIL_AI_PROGRESS_STATE_FILE = aiProgressStateFile;
      executorEnvExtra.GUARDRAIL_AI_HEARTBEAT_SECONDS = String(
        AI_HEARTBEAT_POLICY.stallWarnSeconds,
      );
      if (aiReportArtifact) {
        executorEnvExtra.GUARDRAIL_AI_REPORT_ARTIFACT = aiReportArtifact;
      }

      // Build the stderr relay so AI checkpoint lines feed the progress sink.
      aiProgressRelay = buildAiProgressRelay({
        progressSink,
        runId,
        stateDir,
        progressStateFile: aiProgressStateFile,
      });

      emitAiProgress(progressSink, runId, 'ai_checkpoint', {
        phase: 'supervisor_init',
        message: `Progress channel initialized for ${recipe.id}`,
        severity: 'info',
        progressArtifact: aiProgressFile,
        reportArtifact: aiReportArtifact,
        tool: 'claude',
      });
    }

    // Build the env policy addendum — the executor will merge these into the
    // subprocess env when preserve_runtime_env is true (which claude-exec uses).
    const envExtraForExecutor = Object.keys(executorEnvExtra).length > 0
      ? executorEnvExtra
      : null;

    // D0y stall detection: run alongside the executor to warn when no AI
    // checkpoint arrives within the policy thresholds. The interval fires every
    // 10 s and emits ai_stalled at stall_warn then hard_stall severity levels.
    let aiStallMonitor = null;
    if (aiProgressRelay) {
      let stalledWarned = false;
      let hardStalledWarned = false;
      let lastReportMtimeMs = aiReportArtifact && existsSync(aiReportArtifact)
        ? statSync(aiReportArtifact).mtimeMs
        : 0;
      aiStallMonitor = setInterval(() => {
        if (aiReportArtifact && existsSync(aiReportArtifact)) {
          const reportMtimeMs = statSync(aiReportArtifact).mtimeMs;
          if (reportMtimeMs > lastReportMtimeMs) {
            lastReportMtimeMs = reportMtimeMs;
            aiProgressRelay.noteSyntheticProgress('ai_artifact_written', {
              phase: 'report_artifact',
              message: `Report artifact updated: ${aiReportArtifact}`,
              severity: 'info',
              tool: 'claude',
              reportArtifact: aiReportArtifact,
              progressArtifact: aiProgressFile,
            });
          }
        }
        const elapsed = Date.now() - aiProgressRelay.getLastEventTime();
        if (!hardStalledWarned && elapsed >= AI_HEARTBEAT_POLICY.hardStallSeconds * 1000) {
          hardStalledWarned = true;
          emitAiProgress(progressSink, runId, 'ai_stalled', {
            phase: 'hard_stall',
            message: `No AI progress for ${Math.round(elapsed / 1000)}s — hard stall threshold breached`,
            severity: 'error',
            tool: 'claude',
          });
        } else if (!stalledWarned && elapsed >= AI_HEARTBEAT_POLICY.stallWarnSeconds * 1000) {
          stalledWarned = true;
          emitAiProgress(progressSink, runId, 'ai_stalled', {
            phase: 'stall_warn',
            message: `No AI progress for ${Math.round(elapsed / 1000)}s — stall warning`,
            severity: 'warn',
            tool: 'claude',
          });
        }
      }, 10000);
    }

    let execution;
    try {
      execution = await executorFn(recipe, resolvedInputs, {
        allowUnverified,
        envAllow: envResult.intersection,
        composedSteps: composedBindings.byStepId,
        cwd: resolvedCwd,
        stateDir,
        approved: true,
        traceId: runId,
        auditLog,
        manifestHash: recipeHash,
        onStderr: aiProgressRelay ? aiProgressRelay.onStderr : null,
        envExtra: envExtraForExecutor,
      });
    } finally {
      if (aiStallMonitor) clearInterval(aiStallMonitor);
    }

    state.stepsExecuted = execution.stepsExecuted ?? 0;
    resultOpts.stepsExecuted = execution.stepsExecuted ?? 0;

    if (execution.status === 'success') {
      for (const record of composedBindings.records) {
        if (record.sessionEnforcement?.enforced) {
          const persistResult = persistSessionContractAfterSuccess(record.sessionEnforcement);
          if (!persistResult.persisted) {
            logger.warn('composed_session_contract_persist_failed', {
              recipeId: record.recipe.id,
              stepId: record.stepId,
              error: persistResult.error ?? 'unknown',
            });
          } else {
            logger.info('composed_session_contract_persisted', {
              recipeId: record.recipe.id,
              stepId: record.stepId,
              contractPath: record.sessionEnforcement.contractPath,
              lifecycle: record.sessionEnforcement.candidate.lifecycle,
            });
          }
        }
      }
      if (sessionEnforcement.enforced) {
        const persistResult = persistSessionContractAfterSuccess(sessionEnforcement);
        if (!persistResult.persisted) {
          logger.warn('session_contract_persist_failed', {
            recipeId: recipe.id,
            error: persistResult.error ?? 'unknown',
          });
        } else {
          logger.info('session_contract_persisted', {
            recipeId: recipe.id,
            contractPath: sessionEnforcement.contractPath,
            lifecycle: sessionEnforcement.candidate.lifecycle,
          });
        }
      }
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
