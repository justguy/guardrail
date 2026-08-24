import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildPromptPayload } from './prompt-inputs.js';
import { AI_EVENT_TO_STATE, AI_SOFT_STATES } from './progress-events.js';

const FAILURE_DETAIL_MAX_CHARS = 400;
const FAILURE_DETAIL_MAX_LINES = 3;

// Progress file polling interval while Claude subprocess is alive.
const PROGRESS_POLL_INTERVAL_MS = 2000;
const GUARDRAIL_AI_PROGRESS_PREFIX = '[guardrail-ai-progress] ';

function truthy(value) {
  return value === true || value === 'true' || value === '1';
}

function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveFrom(baseDir, maybePath) {
  if (!maybePath) return '';
  return resolve(baseDir, maybePath);
}

function summarizeFailureText(text) {
  if (!text || typeof text !== 'string') return '';

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, FAILURE_DETAIL_MAX_LINES);

  if (lines.length === 0) return '';

  let summary = lines.join(' | ');
  if (summary.length > FAILURE_DETAIL_MAX_CHARS) {
    summary = `${summary.slice(0, FAILURE_DETAIL_MAX_CHARS - 1).trimEnd()}…`;
  }
  return summary;
}

export function parseWrapperArgs(argv) {
  const options = {
    prompt: '',
    inputFiles: '',
    model: '',
    effort: '',
    permissionMode: '',
    outputFormat: '',
    maxBudgetUsd: '',
    allowedTools: '',
    systemPrompt: '',
    workingDir: '',
    addDirs: '',
    sessionName: '',
    noSessionPersistence: '',
    lifecycle: '',
    sessionId: '',
    // D0y progress contract flags (Guardrail-internal, not forwarded to Claude CLI)
    guardrailProgressFile: '',
    guardrailProgressStateFile: '',
    guardrailReportArtifact: '',
    guardrailHeartbeatSeconds: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    switch (flag) {
      case '--prompt':
        options.prompt = value;
        i += 1;
        break;
      case '--input-files':
        options.inputFiles = value;
        i += 1;
        break;
      case '--model':
        options.model = value;
        i += 1;
        break;
      case '--effort':
        options.effort = value;
        i += 1;
        break;
      case '--permission-mode':
        options.permissionMode = value;
        i += 1;
        break;
      case '--output-format':
        options.outputFormat = value;
        i += 1;
        break;
      case '--max-budget-usd':
        options.maxBudgetUsd = value;
        i += 1;
        break;
      case '--allowed-tools':
        options.allowedTools = value;
        i += 1;
        break;
      case '--system-prompt':
        options.systemPrompt = value;
        i += 1;
        break;
      case '--working-dir':
        options.workingDir = value;
        i += 1;
        break;
      case '--add-dirs':
        options.addDirs = value;
        i += 1;
        break;
      case '--session-name':
        options.sessionName = value;
        i += 1;
        break;
      case '--no-session-persistence':
        options.noSessionPersistence = value;
        i += 1;
        break;
      case '--lifecycle':
        options.lifecycle = value;
        i += 1;
        break;
      case '--session-id':
        options.sessionId = value;
        i += 1;
        break;
      case '--guardrail-progress-file':
        options.guardrailProgressFile = value;
        i += 1;
        break;
      case '--guardrail-progress-state-file':
        options.guardrailProgressStateFile = value;
        i += 1;
        break;
      case '--guardrail-report-artifact':
        options.guardrailReportArtifact = value;
        i += 1;
        break;
      case '--guardrail-heartbeat-seconds':
        options.guardrailHeartbeatSeconds = value;
        i += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

/**
 * Build the system prompt appendix that tells Claude about the Guardrail
 * progress contract. This is injected alongside --append-system-prompt so
 * Claude knows to emit structured checkpoints to the declared progress file.
 */
export function buildProgressSystemAppendix(opts = {}) {
  const { progressFile, reportArtifact, heartbeatSeconds } = opts;

  const lines = [
    '',
    '--- Guardrail Progress Contract ---',
    'You are running inside a Guardrail-managed execution channel.',
    'Follow these rules exactly:',
    '',
    '1. Create the declared report artifact immediately at the start of your run.',
    `   Report artifact path: ${reportArtifact || '(none declared)'}`,
    '',
    '2. Append structured JSON checkpoint lines to the Guardrail progress file.',
    `   Progress file path: ${progressFile || '(none declared)'}`,
    '   Each checkpoint must be a single NDJSON line with these fields:',
    '   {"event":"ai_checkpoint","phase":"<phase>","message":"<short description>","severity":"info","timestamp":"<ISO8601>"}',
    '',
    '3. Valid event types:',
    '   ai_checkpoint       — normal progress heartbeat',
    '   ai_artifact_written — you wrote or updated an artifact',
    '   ai_question         — you have a question that requires operator input',
    '   ai_review_requested — you want the operator to review an intermediate result',
    '   ai_drift_warning    — you detected that the task scope may be drifting',
    '',
    '4. Emit your first checkpoint early, before doing significant work.',
    `5. Emit a checkpoint at least every ${heartbeatSeconds || 60} seconds while working.`,
    '6. Never hide uncertainty in the final report — emit ai_question or ai_drift_warning instead.',
    '--- End Guardrail Progress Contract ---',
    '',
  ];

  return lines.join('\n');
}

function ensureParentDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Write one NDJSON line to the progress file and emit the same event to
 * stderr with the [guardrail-ai-progress] prefix so the supervisor can
 * relay it through the progress sink in real time.
 */
function emitWrapperProgressLine(progressFile, event) {
  const line = JSON.stringify(event);
  if (progressFile) {
    try {
      appendFileSync(progressFile, line + '\n');
    } catch {
      // Fail silently — progress file write must never crash the run.
    }
  }
  process.stderr.write(`${GUARDRAIL_AI_PROGRESS_PREFIX}${line}\n`);
}

/**
 * Tail the progress file from a known byte offset. Returns new event objects
 * for any complete NDJSON lines found since that offset, plus the new offset.
 */
function tailProgressFile(progressFile, fromOffset) {
  if (!progressFile || !existsSync(progressFile)) {
    return { events: [], nextOffset: fromOffset };
  }
  try {
    const content = readFileSync(progressFile, 'utf8');
    const relevant = content.slice(fromOffset);
    const events = [];
    let lastNewline = -1;
    let pos = 0;
    for (const line of relevant.split('\n')) {
      if (line.trim()) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // Skip malformed lines.
        }
        pos += line.length + 1;
        lastNewline = pos;
      } else {
        pos += line.length + 1;
      }
    }
    return {
      events,
      nextOffset: fromOffset + (lastNewline >= 0 ? lastNewline : 0),
    };
  } catch {
    return { events: [], nextOffset: fromOffset };
  }
}

function readProgressState(progressStateFile) {
  if (!progressStateFile || !existsSync(progressStateFile)) return null;
  try {
    return JSON.parse(readFileSync(progressStateFile, 'utf8'));
  } catch {
    return null;
  }
}

function deriveSoftStateFromProgressFile(progressFile) {
  const { events } = tailProgressFile(progressFile, 0);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const evt = events[i];
    const state = evt?.status || AI_EVENT_TO_STATE[evt?.event] || null;
    if (state && AI_SOFT_STATES.has(state)) {
      return state;
    }
  }
  return null;
}

export function buildClaudeArgs(options = {}) {
  const args = ['--print'];

  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.outputFormat) args.push('--output-format', options.outputFormat);
  if (options.maxBudgetUsd) args.push('--max-budget-usd', options.maxBudgetUsd);
  if (options.allowedTools) args.push('--allowed-tools', options.allowedTools);
  if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);
  for (const dir of options.addDirs || []) {
    args.push('--add-dir', dir);
  }
  if (options.sessionName) args.push('--name', options.sessionName);
  if (options.noSessionPersistence) args.push('--no-session-persistence');
  if (options.promptPayload) args.push(options.promptPayload);

  return args;
}

export function buildClaudeFailureMessage({ code, stderr = '', stdout = '' }) {
  const detail = summarizeFailureText(stderr) || summarizeFailureText(stdout);
  if (detail) {
    return `claude --print failed with exit code ${code}: ${detail}`;
  }
  return `claude --print failed with exit code ${code}`;
}

function normalizeOptions(rawOptions) {
  const baseDir = rawOptions.workingDir
    ? resolve(process.cwd(), rawOptions.workingDir)
    : process.cwd();

  // Progress contract fields can be supplied as explicit flags OR as env vars
  // (set by the supervisor via GUARDRAIL_AI_PROGRESS_FILE etc.). Explicit
  // flags win over env vars.
  const progressFile =
    rawOptions.guardrailProgressFile ||
    process.env.GUARDRAIL_AI_PROGRESS_FILE ||
    '';
  const progressStateFile =
    rawOptions.guardrailProgressStateFile ||
    process.env.GUARDRAIL_AI_PROGRESS_STATE_FILE ||
    '';
  const reportArtifact =
    rawOptions.guardrailReportArtifact ||
    process.env.GUARDRAIL_AI_REPORT_ARTIFACT ||
    '';
  const heartbeatSeconds =
    rawOptions.guardrailHeartbeatSeconds ||
    process.env.GUARDRAIL_AI_HEARTBEAT_SECONDS ||
    '';

  // Append progress contract appendix to system prompt when a progress file
  // has been declared. This is injected here so it is never part of the
  // approval manifest (it is Guardrail-internal guidance, not user content).
  const progressAppendix = progressFile
    ? buildProgressSystemAppendix({ progressFile, reportArtifact, heartbeatSeconds })
    : '';

  return {
    prompt: rawOptions.prompt || '',
    inputFiles: splitCsv(rawOptions.inputFiles),
    model: rawOptions.model || '',
    effort: rawOptions.effort || '',
    permissionMode: rawOptions.permissionMode || '',
    outputFormat: rawOptions.outputFormat || '',
    maxBudgetUsd: rawOptions.maxBudgetUsd || '',
    allowedTools: rawOptions.allowedTools || '',
    systemPrompt: (rawOptions.systemPrompt || '') + progressAppendix,
    workingDir: rawOptions.workingDir ? baseDir : '',
    addDirs: splitCsv(rawOptions.addDirs).map((dir) => resolveFrom(baseDir, dir)),
    sessionName: rawOptions.sessionName || '',
    noSessionPersistence: truthy(rawOptions.noSessionPersistence),
    lifecycle: rawOptions.lifecycle || '',
    sessionId: rawOptions.sessionId || '',
    baseDir,
    // D0y progress contract (Guardrail-internal, not forwarded to Claude CLI)
    progressFile,
    progressStateFile,
    reportArtifact,
    heartbeatSeconds,
  };
}

/**
 * Build a structured session metadata record for audit/test consumption.
 *
 * This is Guardrail-side metadata and is NEVER passed to the Claude CLI.
 * `lifecycle` and `sessionId` originate from the recipe inputs and are
 * consumed by the recipe-supervisor's agent-session enforcement path.
 */
export function emitSessionMetadata({ lifecycle, sessionName, sessionId, workingDir }) {
  return {
    tool: 'claude',
    lifecycle: lifecycle || null,
    sessionName: sessionName || null,
    sessionId: sessionId || null,
    workingDir: workingDir || null,
  };
}

export async function runClaudeExec(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const promptPayload = buildPromptPayload({
    prompt: options.prompt,
    inputFiles: options.inputFiles,
    baseDir: options.baseDir,
  });
  const args = buildClaudeArgs({
    ...options,
    promptPayload,
  });

  // Emit structured session metadata to stderr so tests and audit logs can
  // observe it without corrupting the Claude child's stdout passthrough.
  // Guardrail-only fields (lifecycle, sessionId) live here, not in argv.
  const sessionMeta = emitSessionMetadata({
    lifecycle: options.lifecycle,
    sessionName: options.sessionName,
    sessionId: options.sessionId,
    workingDir: options.workingDir || process.cwd(),
  });
  process.stderr.write(`[guardrail-session] ${JSON.stringify(sessionMeta)}\n`);

  // D0y: Initialize the progress channel before Claude spawns.
  const { progressFile, progressStateFile, reportArtifact } = options;
  const runId = sessionMeta.sessionName || sessionMeta.sessionId || 'unknown';

  if (progressFile) {
    try {
      ensureParentDir(progressFile);
      writeFileSync(progressFile, '');
    } catch {
      // Non-fatal: progress file creation failure must not abort the run.
    }
  }

  // Emit the first (wrapper-synthetic) AI checkpoint so the supervisor sees
  // an early event even before Claude produces any output.
  emitWrapperProgressLine(progressFile, {
    event: 'ai_checkpoint',
    phase: 'started',
    message: 'Claude subprocess is starting',
    severity: 'info',
    runId,
    tool: 'claude',
    reportArtifact: reportArtifact || null,
    progressArtifact: progressFile || null,
    timestamp: new Date().toISOString(),
  });

  // Track file-tail offset for the progress poller. We skip the initial bytes
  // we just wrote (the started checkpoint) because we already emitted that
  // event above; the poller should only relay events written by Claude.
  let tailOffset = 0;
  if (progressFile && existsSync(progressFile)) {
    try {
      tailOffset = readFileSync(progressFile, 'utf8').length;
    } catch {
      tailOffset = 0;
    }
  }

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('claude', args, {
      cwd: options.workingDir || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    // D0y: Poll the progress file for new checkpoint lines written by Claude.
    // New lines are emitted to stderr with the [guardrail-ai-progress] prefix
    // so the supervisor can intercept them in real time via onStderr.
    let pollInterval = null;
    if (progressFile) {
      pollInterval = setInterval(() => {
        const { events, nextOffset } = tailProgressFile(progressFile, tailOffset);
        tailOffset = nextOffset;
        for (const evt of events) {
          process.stderr.write(`${GUARDRAIL_AI_PROGRESS_PREFIX}${JSON.stringify(evt)}\n`);
        }
      }, PROGRESS_POLL_INTERVAL_MS);
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', (err) => {
      if (pollInterval) clearInterval(pollInterval);
      rejectPromise(err);
    });
    child.on('close', (code, signal) => {
      if (pollInterval) clearInterval(pollInterval);

      // Final drain: pick up any lines Claude wrote in the last poll window.
      if (progressFile) {
        const { events } = tailProgressFile(progressFile, tailOffset);
        for (const evt of events) {
          process.stderr.write(`${GUARDRAIL_AI_PROGRESS_PREFIX}${JSON.stringify(evt)}\n`);
        }
      }

      const existingState = readProgressState(progressStateFile) || {};
      const currentSoftState = deriveSoftStateFromProgressFile(progressFile);
      const preserveSoftState = code === 0 && typeof currentSoftState === 'string';
      const finalStatus = preserveSoftState
        ? currentSoftState
        : code === 0
          ? 'completed'
          : 'failed';
      const finalPhase = preserveSoftState
        ? 'awaiting_operator'
        : (code === 0 || signal == null && code === 0)
          ? 'completed'
          : 'failed';
      emitWrapperProgressLine(progressFile, {
        event: preserveSoftState ? 'ai_resumed' : 'ai_checkpoint',
        phase: finalPhase,
        message: preserveSoftState
          ? `Claude subprocess exited after signaling ${currentSoftState}`
          : code === 0
            ? 'Claude subprocess completed successfully'
          : `Claude subprocess exited with code ${code}`,
        severity: code === 0 ? 'info' : 'error',
        runId,
        tool: 'claude',
        reportArtifact: reportArtifact || null,
        progressArtifact: progressFile || null,
        timestamp: new Date().toISOString(),
      });

      // Write compact progress-state summary for CLI inspection.
      if (progressStateFile) {
        const state = {
          ...existingState,
          runId,
          tool: 'claude',
          status: finalStatus,
          lastPhase: finalPhase,
          reportArtifact: reportArtifact || null,
          progressArtifact: progressFile || null,
          lastTimestamp: new Date().toISOString(),
          timestamp: new Date().toISOString(),
        };
        try {
          ensureParentDir(progressStateFile);
          writeFileSync(progressStateFile, JSON.stringify(state, null, 2) + '\n');
        } catch {
          // Non-fatal.
        }
      }

      if (signal) {
        rejectPromise(new Error(`claude exited on signal ${signal}`));
        return;
      }
      if (code !== 0) {
        rejectPromise(new Error(buildClaudeFailureMessage({ code, stderr, stdout })));
        return;
      }
      resolvePromise();
    });
  });
}

async function main() {
  await runClaudeExec(parseWrapperArgs(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
