import { resolve } from 'node:path';
import { createContract, verifyFileHash } from './contract.js';
import { launchWorker, detectInteractiveAttempt } from './worker-interface.js';
import { validateResult } from './validator.js';
import { createAuditLog } from './audit.js';
import { enforceChannel } from './recipe-channel.js';
import { generateRunId } from './logger.js';

// ---------------------------------------------------------------------------
// Dangerous command patterns (blocked at runtime)
// ---------------------------------------------------------------------------

const DANGEROUS_PATTERNS = [
  { pattern: /\brm\b.*-[a-zA-Z]*r[a-zA-Z]*f/, reason: 'Recursive force delete' },
  { pattern: /\brm\s+-rf\s+\/\s*$/, reason: 'Root filesystem delete' },
  { pattern: /\bchmod\s+777/, reason: 'World-writable permissions' },
  { pattern: /\bdd\b.*of=\/dev\//, reason: 'Raw device write' },
  { pattern: /\bmkfs\b/, reason: 'Filesystem format' },
  { pattern: /\b:(){ :|:& };:/, reason: 'Fork bomb' },
  { pattern: /\bsudo\s+rm/, reason: 'Elevated delete' },
  { pattern: />\s*\/dev\/sda/, reason: 'Raw disk overwrite' },
];

/**
 * Check a command + args string against dangerous patterns.
 *
 * @param {string} command - The command.
 * @param {string[]} args  - Command arguments.
 * @returns {{ safe: boolean, reason: string|null }}
 */
export function checkDangerous(command, args) {
  const full = [command, ...(args || [])].join(' ');
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(full)) {
      return { safe: false, reason };
    }
  }
  return { safe: true, reason: null };
}

// ---------------------------------------------------------------------------
// Scope restriction — ensure paths stay within allowed scope
// ---------------------------------------------------------------------------

/**
 * Verify that all paths in step args are within the allowed scope.
 *
 * @param {string[]} args        - Command arguments.
 * @param {string[]} allowedPaths - Allowed path prefixes.
 * @returns {{ inScope: boolean, violations: string[] }}
 */
export function checkScope(args, allowedPaths) {
  if (!allowedPaths || allowedPaths.length === 0) return { inScope: true, violations: [] };

  const violations = [];
  for (const arg of (args || [])) {
    // Only check args that look like paths
    if (!arg.startsWith('/') && !arg.startsWith('./') && !arg.startsWith('../')) continue;
    const resolved = resolve(arg);
    const withinScope = allowedPaths.some(p => resolved.startsWith(resolve(p)));
    if (!withinScope) {
      violations.push(`"${arg}" is outside allowed scope`);
    }
  }
  return { inScope: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Dry-run simulation
// ---------------------------------------------------------------------------

/**
 * Simulate recipe execution without running any commands.
 *
 * @param {object} recipe       - Validated recipe.
 * @param {object} resolvedInputs - Resolved input values.
 * @param {object} [opts]       - Options: { allowedPaths }.
 * @returns {{ steps: object[], blocked: object[], safe: boolean }}
 */
export function dryRun(recipe, resolvedInputs, opts = {}) {
  const steps = [];
  const blocked = [];

  for (const step of (recipe.steps || [])) {
    const args = interpolateRecipeArgs(step.run?.args || [], resolvedInputs);
    const command = step.run?.command || '';

    const dangerCheck = checkDangerous(command, args);
    const scopeCheck = checkScope(args, opts.allowedPaths);

    const entry = {
      id: step.id,
      description: step.description,
      command,
      args,
      mode: step.run?.mode || 'structured',
      dangerous: !dangerCheck.safe,
      dangerReason: dangerCheck.reason,
      inScope: scopeCheck.inScope,
      scopeViolations: scopeCheck.violations,
    };

    steps.push(entry);
    if (!dangerCheck.safe || !scopeCheck.inScope) {
      blocked.push(entry);
    }
  }

  return {
    steps,
    blocked,
    safe: blocked.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Execute recipe
// ---------------------------------------------------------------------------

/**
 * Execute a recipe's steps with full guardrail enforcement.
 *
 * @param {object} recipe          - Validated recipe.
 * @param {object} resolvedInputs  - Resolved input values.
 * @param {object} [opts]          - Options.
 * @param {string[]} [opts.allowedPaths]    - Restrict file scope.
 * @param {boolean} [opts.allowUnverified]  - Allow community recipes.
 * @param {string} [opts.cwd]              - Working directory.
 * @param {string} [opts.stateDir]         - State directory for audit.
 * @returns {Promise<object>} Execution result.
 */
export async function executeRecipe(recipe, resolvedInputs, opts = {}) {
  const runId = opts.traceId || generateRunId();
  const cwd = resolve(opts.cwd || process.cwd());
  const stateDir = resolve(opts.stateDir || '.guardrail');
  const auditLog = opts.auditLog || createAuditLog(resolve(stateDir, 'audit.jsonl'));
  const auditContext = {
    trace_id: runId,
    recipe_id: recipe.id,
    manifest_hash: opts.manifestHash ?? null,
  };

  // Channel enforcement
  const channelCheck = enforceChannel(recipe, { allowUnverified: opts.allowUnverified });
  if (!channelCheck.allowed) {
    auditLog.append({ event: 'recipe_blocked', ...auditContext, reason: channelCheck.reason });
    return { status: 'blocked', reason: channelCheck.reason, trust: channelCheck.trust, stepsExecuted: 0 };
  }

  // Approval check
  if (recipe.approval_required && !opts.approved) {
    auditLog.append({ event: 'recipe_approval_required', ...auditContext });
    return { status: 'approval_required', reason: 'Recipe requires explicit approval', stepsExecuted: 0 };
  }

  auditLog.append({ event: 'recipe_execution_start', ...auditContext, version: recipe.version });

  const results = [];
  let stepsExecuted = 0;

  for (const step of (recipe.steps || [])) {
    const args = interpolateRecipeArgs(step.run?.args || [], resolvedInputs);
    const command = step.run?.command || '';

    // Runtime guardrail: dangerous command check
    const dangerCheck = checkDangerous(command, args);
    if (!dangerCheck.safe) {
      auditLog.append({ event: 'step_blocked', ...auditContext, step_id: step.id, reason: dangerCheck.reason });
      return {
        status: 'blocked',
        reason: `Step "${step.id}" blocked: ${dangerCheck.reason}`,
        stepsExecuted,
        results,
      };
    }

    // Runtime guardrail: scope check
    const scopeCheck = checkScope(args, opts.allowedPaths);
    if (!scopeCheck.inScope) {
      auditLog.append({ event: 'step_blocked', ...auditContext, step_id: step.id, reason: scopeCheck.violations.join('; ') });
      return {
        status: 'blocked',
        reason: `Step "${step.id}" blocked: ${scopeCheck.violations.join('; ')}`,
        stepsExecuted,
        results,
      };
    }

    // Execute step
    const contract = createContract({ command, args, cwd, mode: 'structured' });

    let workerResult;
    try {
      workerResult = await launchWorker(contract, { timeoutMs: step.run?.timeoutMs || 60000, validatorMode: 'exit_code' });
    } catch (err) {
      results.push({ step: step.id, success: false, error: err.message });
      auditLog.append({ event: 'step_failed', ...auditContext, step_id: step.id, error: err.message });
      return { status: 'failed', reason: `Step "${step.id}" failed: ${err.message}`, stepsExecuted, results };
    }

    const validation = validateResult(workerResult, 'exit_code');
    stepsExecuted++;

    results.push({
      step: step.id,
      success: validation.valid,
      exitCode: validation.exitCode,
    });

    if (!validation.valid) {
      auditLog.append({ event: 'step_failed', ...auditContext, step_id: step.id, exitCode: validation.exitCode });
      return { status: 'failed', reason: `Step "${step.id}" failed with exit code ${validation.exitCode}`, stepsExecuted, results };
    }

    auditLog.append({ event: 'step_completed', ...auditContext, step_id: step.id });
  }

  auditLog.append({ event: 'recipe_execution_end', ...auditContext, status: 'success' });
  return { status: 'success', stepsExecuted, results };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function interpolateRecipeArgs(argsTemplate, values) {
  if (!Array.isArray(argsTemplate)) return [];
  return argsTemplate.map(arg =>
    arg.replace(/\{\{inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, key) => {
      const v = values[key];
      return v !== undefined ? String(v) : '';
    }),
  );
}
