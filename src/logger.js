import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Color support detection
// ---------------------------------------------------------------------------

export function hasColor() {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return !!process.stdout.isTTY;
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ANSI = {
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  reset:  '\x1b[0m',
};

const FALLBACK_LABELS = {
  green:  'GREEN',
  yellow: 'YELLOW',
  red:    'RED',
};

/**
 * Wrap `text` in an ANSI escape sequence.
 * Falls back to uppercase labels when the terminal has no color support.
 */
export function colorize(text, color) {
  if (hasColor()) {
    const code = ANSI[color];
    if (!code) return text;
    return `${code}${text}${ANSI.reset}`;
  }
  const label = FALLBACK_LABELS[color];
  if (label) return `[${label}] ${text}`;
  return text;
}

/**
 * Return the color name appropriate for a given risk level string.
 */
export function riskColor(riskLevel) {
  const lvl = (riskLevel || '').toLowerCase();
  if (lvl === 'green')  return 'green';
  if (lvl === 'yellow') return 'yellow';
  if (lvl === 'red')    return 'red';
  return 'red'; // unknown defaults to red
}

// ---------------------------------------------------------------------------
// Run ID generation
// ---------------------------------------------------------------------------

export function generateRunId() {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString('hex');
  return `${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// Structured NDJSON logger
// ---------------------------------------------------------------------------

/**
 * Create a logger that appends NDJSON lines to `.guardrail/logs/<runId>.ndjson`.
 *
 * @param {string} runId  - Unique identifier for this run.
 * @param {string} logDir - Base directory for logs (defaults to `.guardrail/logs`).
 * @returns {{ info: Function, warn: Function, error: Function }}
 */
export function createLogger(runId, logDir = join(process.cwd(), '.guardrail', 'logs')) {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${runId}.ndjson`);

  function write(level, event, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      data,
    };
    appendFileSync(logPath, JSON.stringify(entry) + '\n');
  }

  return {
    info:  (event, data) => write('info',  event, data),
    warn:  (event, data) => write('warn',  event, data),
    error: (event, data) => write('error', event, data),
  };
}

// ---------------------------------------------------------------------------
// Terminal output helpers
// ---------------------------------------------------------------------------

function line(text = '') {
  process.stdout.write(text + '\n');
}

function separator() {
  line(colorize('─'.repeat(56), 'dim'));
}

// ---------------------------------------------------------------------------
// Warning banner
// ---------------------------------------------------------------------------

export function printBanner() {
  line();
  separator();
  line(colorize('  Protected Execution Enabled', 'bold'));
  separator();
  line(colorize('  - Contract locked', 'dim'));
  line(colorize('  - Not a secure sandbox', 'dim'));
  line(colorize('  - Only safe for trusted tasks', 'dim'));
  line(colorize('  - Changes require re-approval', 'dim'));
  separator();
  line();
}

// ---------------------------------------------------------------------------
// Approval summary
// ---------------------------------------------------------------------------

function labelValue(label, value) {
  const paddedLabel = (label + ':').padEnd(20);
  return `  ${colorize(paddedLabel, 'dim')} ${value}`;
}

function formatTimeout(timeoutMs) {
  if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs)) return '';
  if (timeoutMs % 1000 === 0) {
    return `${timeoutMs / 1000}s`;
  }
  return `${timeoutMs}ms`;
}

/**
 * Print the full approval summary for a contract + risk assessment.
 *
 * @param {object} contract       - The execution contract.
 * @param {object} riskAssessment - The risk assessment result.
 */
export function printApprovalSummary(contract, riskAssessment) {
  line();
  line(colorize('  Contract Summary', 'bold'));
  separator();

  const allowedBinaries = Array.isArray(contract.allowedBinaries) && contract.allowedBinaries.length > 0
    ? contract.allowedBinaries
    : (contract.command ? [contract.command] : []);
  const writablePaths = Array.isArray(contract.writablePaths) ? contract.writablePaths : [];
  const retryCount = contract.retryPolicy?.maxRetries;

  if (contract.command) line(labelValue('Command', contract.command));
  if (contract.mode) line(labelValue('Mode', contract.mode));
  if (contract.cwd) line(labelValue('Directory', contract.cwd));
  if (writablePaths.length > 0) line(labelValue('Writes', writablePaths.join(', ')));
  if (allowedBinaries.length > 0) line(labelValue('Allowed binaries', allowedBinaries.join(', ')));
  if (contract.childProcessPolicy) line(labelValue('Child processes', contract.childProcessPolicy));
  if (retryCount !== undefined) line(labelValue('Retries', String(retryCount)));
  if (contract.timeoutMs !== undefined) line(labelValue('Timeout', formatTimeout(contract.timeoutMs)));

  separator();

  // Risk assessment
  if (riskAssessment) {
    if (riskAssessment.trustClass) {
      line(labelValue('Trust class', riskAssessment.trustClass));
    }
    if (riskAssessment.riskLevel) {
      const color = riskColor(riskAssessment.riskLevel);
      line(labelValue('Risk level', colorize(riskAssessment.riskLevel.toUpperCase(), color)));
    }
    if (riskAssessment.reasons && riskAssessment.reasons.length > 0) {
      line(labelValue('Risk reasons', ''));
      for (const reason of riskAssessment.reasons) {
        line(`                       ${colorize('- ' + reason, 'yellow')}`);
      }
    }

    separator();
  }

  // Responsibility notice
  line();
  line(colorize('  You are responsible for approving this workflow.', 'bold'));
  line(colorize('  Guardrail highlights risk; it does not certify safety.', 'dim'));
  line(colorize('  Guardrail approval is the reusable approval record for future runs.', 'dim'));
  line();
}

// ---------------------------------------------------------------------------
// Drift display
// ---------------------------------------------------------------------------

/**
 * Print drift diffs. Each diff is an object with at least a `description` field.
 *
 * @param {Array<{ description: string }>} diffs
 */
export function printDrift(diffs) {
  line();
  line(colorize('  Execution paused', 'yellow'));
  line();

  if (diffs && diffs.length > 0) {
    line(colorize('  Requested change:', 'bold'));
    for (const diff of diffs) {
      line(colorize(`  + ${diff.description || diff}`, 'green'));
    }
  }

  line();
  line(colorize('  This is outside your approved contract.', 'yellow'));
  line();
}

// ---------------------------------------------------------------------------
// Denied message
// ---------------------------------------------------------------------------

export function printDenied() {
  line();
  line(colorize('  Execution denied.', 'red'));
  line(colorize('  The contract was not approved. No changes were made.', 'dim'));
  line();
}

// ---------------------------------------------------------------------------
// Result summary
// ---------------------------------------------------------------------------

/**
 * Print the outcome of a run.
 *
 * @param {object} result - Execution result with `success`, `exitCode`, `message`, `errors`.
 */
export function printResult(result) {
  line();
  separator();

  if (result.success) {
    line(colorize('  Run completed successfully', 'green'));
  } else {
    line(colorize('  Run failed', 'red'));
  }

  if (result.exitCode !== undefined) {
    line(labelValue('Exit code', String(result.exitCode)));
  }
  if (result.message) {
    line(labelValue('Message', result.message));
  }
  if (result.errors && result.errors.length > 0) {
    line(labelValue('Errors', ''));
    for (const err of result.errors) {
      line(`                       ${colorize('- ' + err, 'red')}`);
    }
  }

  separator();
  line();
}

// ---------------------------------------------------------------------------
// Workflow approval summary
// ---------------------------------------------------------------------------

/**
 * Print a workflow-specific approval summary.
 *
 * @param {object} workflow       - The workflow definition.
 * @param {object} riskAssessment - The risk assessment result.
 */
export function printWorkflowApprovalSummary(workflow, riskAssessment) {
  line();
  line(colorize('  Workflow Summary', 'bold'));
  separator();

  if (workflow.name) line(labelValue('Name', workflow.name));
  if (workflow.entryStep) line(labelValue('Entry step', workflow.entryStep));
  if (workflow.maxIterations !== undefined) line(labelValue('Max iterations', String(workflow.maxIterations)));

  if (Array.isArray(workflow.steps) && workflow.steps.length > 0) {
    const stepNames = workflow.steps.map(s => (typeof s === 'string' ? s : s.id || s.name)).join(' -> ');
    line(labelValue('Steps', stepNames));
  }

  if (Array.isArray(workflow.services) && workflow.services.length > 0) {
    line(labelValue('Services', workflow.services.join(', ')));
  }

  separator();

  if (riskAssessment) {
    if (riskAssessment.trustClass) {
      line(labelValue('Trust class', riskAssessment.trustClass));
    }
    if (riskAssessment.riskLevel) {
      const color = riskColor(riskAssessment.riskLevel);
      line(labelValue('Risk level', colorize(riskAssessment.riskLevel.toUpperCase(), color)));
    }
    if (riskAssessment.reasons && riskAssessment.reasons.length > 0) {
      line(colorize('  Reasons:', 'dim'));
      for (const reason of riskAssessment.reasons) {
        line(`    ${colorize('- ' + reason, 'yellow')}`);
      }
    }

    separator();
  }

  line();
  line(colorize('  You are responsible for approving this workflow.', 'bold'));
  line(colorize('  Guardrail highlights risk; it does not certify safety.', 'dim'));
  line(colorize('  Guardrail approval is the reusable approval record for future runs.', 'dim'));
  line();
}

// ---------------------------------------------------------------------------
// Workflow drift display
// ---------------------------------------------------------------------------

/**
 * Print workflow drift diffs in readable form.
 *
 * @param {Array<{ type: string, description: string }>} diffs
 */
export function printWorkflowDrift(diffs) {
  line();
  line(colorize('  Workflow drift detected', 'yellow'));
  line();

  if (diffs && diffs.length > 0) {
    line(colorize('  Requested changes:', 'bold'));
    for (const diff of diffs) {
      const desc = diff.description || String(diff);
      if (diff.type === 'add' || desc.startsWith('+')) {
        line(colorize(`  + ${desc.replace(/^\+\s*/, '')}`, 'green'));
      } else if (diff.type === 'remove' || desc.startsWith('-')) {
        line(colorize(`  - ${desc.replace(/^-\s*/, '')}`, 'red'));
      } else if (diff.type === 'change' || desc.startsWith('~')) {
        line(colorize(`  ~ ${desc.replace(/^~\s*/, '')}`, 'cyan'));
      } else {
        line(`  ${desc}`);
      }
    }
  }

  line();
  line(colorize('  This is outside your approved workflow contract.', 'yellow'));
  line(colorize('  Run halted. Re-run with explicit approval to widen scope.', 'yellow'));
  line();
}

// ---------------------------------------------------------------------------
// Step progress display
// ---------------------------------------------------------------------------

/**
 * Print step execution progress.
 *
 * @param {string} stepId   - Step identifier (e.g. "[step 1/5] start_server").
 * @param {string} stepType - Step type (e.g. "service_start", "task").
 * @param {string} status   - One of "running", "done", "failed", "skipped".
 */
export function printStepProgress(stepId, stepType, status) {
  const prefix = `  ${stepId} (${stepType}) ... `;

  if (status === 'done') {
    line(prefix + colorize('done \u2713', 'green'));
  } else if (status === 'failed') {
    line(prefix + colorize('failed \u2717', 'red'));
  } else if (status === 'running') {
    line(prefix + colorize('running', 'yellow'));
  } else if (status === 'skipped') {
    line(prefix + colorize('skipped', 'dim'));
  } else {
    line(prefix + status);
  }
}

// ---------------------------------------------------------------------------
// Workflow result summary
// ---------------------------------------------------------------------------

/**
 * Print workflow execution result.
 *
 * @param {object} result - Workflow result with `success`, `failedStep`, `reason`,
 *                          `stepsExecuted`, `servicesStarted`, `totalIterations`.
 */
export function printWorkflowResult(result) {
  line();
  separator();

  if (result.success) {
    line(colorize('  Workflow completed successfully.', 'green'));
    if (result.stepsExecuted !== undefined) {
      line(labelValue('Steps executed', String(result.stepsExecuted)));
    }
    if (result.servicesStarted !== undefined) {
      line(labelValue('Services started', String(result.servicesStarted)));
    }
    if (result.totalIterations !== undefined) {
      line(labelValue('Total iterations', String(result.totalIterations)));
    }
  } else {
    if (result.failedStep) {
      line(colorize(`  Workflow failed at step: ${result.failedStep}`, 'red'));
    } else {
      line(colorize('  Workflow failed.', 'red'));
    }
    if (result.reason) {
      line(labelValue('Reason', result.reason));
    }
    if (result.stepsExecuted !== undefined) {
      line(labelValue('Steps executed', String(result.stepsExecuted)));
    }
  }

  separator();
  line();
}
