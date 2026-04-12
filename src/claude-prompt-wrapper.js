import { resolve, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildPromptPayload } from './prompt-inputs.js';
import { AI_EVENT_TO_STATE, AI_SOFT_STATES } from './progress-events.js';

const FAILURE_DETAIL_MAX_CHARS = 400;
const FAILURE_DETAIL_MAX_LINES = 3;
const PROGRESS_POLL_INTERVAL_MS = 2000;
const GUARDRAIL_AI_PROGRESS_PREFIX = '[guardrail-ai-progress] ';
const STARTUP_PROMPT_DELAY_MS = 300;
const POST_PASTE_SUBMIT_DELAY_MS = 300;
const POST_PASTE_SUBMIT_SEQUENCE = '\r\r';
const READY_MARKER_TIMEOUT_MS = 15000;
const EXIT_GRACE_MS = 5000;
const HARD_TIMEOUT_MS = 5 * 60 * 1000;
export const EXPECT_INTERACTIVE_SCRIPT = String.raw`
proc append_hex_log {file_path label text} {
  if {$file_path eq ""} {
    return
  }
  binary scan $text H* hex
  set f [open $file_path a]
  puts $f "$label $hex"
  close $f
}

proc send_logged {file_path label text} {
  append_hex_log $file_path $label $text
  send -- $text
}

proc maybe_send_control {control_file} {
  if {$control_file eq ""} {
    return
  }
  if {![file exists $control_file]} {
    return
  }
  set f [open $control_file r]
  set payload [read $f]
  close $f
  if {$payload eq ""} {
    return
  }
  set fw [open $control_file w]
  puts -nonewline $fw ""
  close $fw
  send -- $payload
}

proc strip_ansi {text} {
  regsub -all {\x1b\[[0-9;?]*[ -/]*[@-~]} $text "" cleaned
  regsub -all {\x1b\][^\x07]*(\x07|\x1b\\)} $cleaned "" cleaned
  regsub -all {\r} $cleaned "" cleaned
  return $cleaned
}

proc ready_beacon_seen {text} {
  set cleaned [strip_ansi $text]
  set compact [string map {" " "" "\n" "" "\t" "" "\r" ""} $cleaned]
  if {[regexp {(^|\n)[[:space:]]*([>❯›»\?])[[:space:]]*$} $cleaned]} {
    return 1
  }
  if {[string first "ClaudeCode" $compact] >= 0
      && [string first "shift+tab" $compact] >= 0
      && [string first "/effort" $compact] >= 0} {
    return 1
  }
  return 0
}

proc turn_completion_seen {text} {
  set cleaned [strip_ansi $text]
  if {[string first "Claude is waiting for your input" $cleaned] >= 0} {
    return 1
  }
  return 0
}

proc assistant_output_seen {text} {
  set cleaned [strip_ansi $text]
  if {[regexp {(^|\n)[[:space:]]*[⏺●•]\s+\S+} $cleaned]} {
    return 1
  }
  return 0
}

proc send_bracketed_paste {log_file text} {
  send_logged $log_file "stdin" "\033\[200~"
  send_logged $log_file "stdin" $text
  send_logged $log_file "stdin" "\033\[201~"
}

set prompt_file $env(GUARDRAIL_PROMPT_FILE)
set prompt_handle [open $prompt_file r]
set prompt_input [read $prompt_handle]
close $prompt_handle
if {[info exists env(GUARDRAIL_PTY_SEND_HEX_LOG)]} {
  set send_hex_log $env(GUARDRAIL_PTY_SEND_HEX_LOG)
} else {
  set send_hex_log ""
}
set control_file $env(GUARDRAIL_CONTROL_FILE)
set startup_delay_ms $env(GUARDRAIL_STARTUP_PROMPT_DELAY_MS)
if {$startup_delay_ms eq ""} {
  set startup_delay_ms 300
}
set submit_delay_ms $env(GUARDRAIL_SUBMIT_DELAY_MS)
if {$submit_delay_ms eq ""} {
  set submit_delay_ms 300
}
if {[info exists env(GUARDRAIL_SUBMIT_SEQUENCE)]} {
  set submit_sequence $env(GUARDRAIL_SUBMIT_SEQUENCE)
} else {
  set submit_sequence ""
}
if {![info exists env(GUARDRAIL_SUBMIT_SEQUENCE)]} {
  set submit_sequence "\r\r"
}
if {[info exists env(GUARDRAIL_READY_TIMEOUT_MS)]} {
  set ready_timeout_ms $env(GUARDRAIL_READY_TIMEOUT_MS)
} else {
  set ready_timeout_ms ""
}
if {$ready_timeout_ms eq ""} {
  set ready_timeout_ms 15000
}
set prompt_sent 0
set startup_buffer ""
set recent_buffer ""
set assistant_response_seen 0
set post_submit_bytes 0
set ready_deadline [expr {[clock milliseconds] + $ready_timeout_ms}]
log_user 1
set timeout 1
spawn -noecho sh -lc $env(GUARDRAIL_CLAUDE_COMMAND)
while {1} {
  maybe_send_control $control_file
  expect {
    -re {.+} {
      set chunk $expect_out(0,string)
      append startup_buffer $chunk
      if {!$prompt_sent && [ready_beacon_seen $startup_buffer]} {
        after $startup_delay_ms
        send_bracketed_paste $send_hex_log $prompt_input
        after $submit_delay_ms
        send_logged $send_hex_log "stdin" $submit_sequence
        set prompt_sent 1
        set startup_buffer ""
        set recent_buffer ""
        set assistant_response_seen 0
        set post_submit_bytes 0
        exp_continue
      }
      if {$prompt_sent} {
        append recent_buffer $chunk
        if {[string length $recent_buffer] > 12000} {
          set recent_buffer [string range $recent_buffer end-11999 end]
        }
        incr post_submit_bytes [string length $chunk]
        if {!$assistant_response_seen && [assistant_output_seen $recent_buffer]} {
          set assistant_response_seen 1
        }
        if {[turn_completion_seen $recent_buffer]} {
          exit 0
        }
        if {$assistant_response_seen && [ready_beacon_seen $recent_buffer]} {
          exit 0
        }
      }
      exp_continue
    }
    eof {
      catch wait result
      if {[llength $result] >= 4} {
        exit [lindex $result 3]
      }
      exit 0
    }
    timeout {
      if {!$prompt_sent && [clock milliseconds] >= $ready_deadline} {
        send_error "guardrail_ready_timeout\n"
        exit 124
      }
      continue
    }
  }
}
`;

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

function shellQuoteArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

function emitWrapperProgressLine(progressFile, event) {
  const line = JSON.stringify(event);
  if (progressFile) {
    try {
      appendFileSync(progressFile, `${line}\n`);
    } catch {
      // Best effort only.
    }
  }
  process.stderr.write(`${GUARDRAIL_AI_PROGRESS_PREFIX}${line}\n`);
}

function tailProgressFile(progressFile, fromOffset = 0) {
  if (!progressFile || !existsSync(progressFile)) {
    return { events: [], nextOffset: fromOffset };
  }
  try {
    const content = readFileSync(progressFile, 'utf8');
    const slice = content.slice(fromOffset);
    const lines = slice.split('\n');
    const events = [];
    let pos = 0;
    let lastNewline = -1;
    for (const line of lines) {
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
  const args = [];
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.allowedTools) args.push('--allowed-tools', options.allowedTools);
  if (options.sessionName) args.push('--name', options.sessionName);
  if (options.sessionId) args.push('--session-id', options.sessionId);
  for (const dir of options.addDirs || []) {
    args.push('--add-dir', dir);
  }
  if (options.systemPrompt) {
    args.push('--append-system-prompt', options.systemPrompt);
  }
  return args;
}

export function buildClaudeFailureMessage({ code, stderr = '', stdout = '' }) {
  const detail = summarizeFailureText(stderr) || summarizeFailureText(stdout);
  if (detail) {
    return `claude interactive failed with exit code ${code}: ${detail}`;
  }
  return `claude interactive failed with exit code ${code}`;
}

export function buildInteractivePromptInput(promptPayload = '') {
  return `${promptPayload}`;
}

export function progressEventRequestsExit(event) {
  if (!event || typeof event !== 'object') return false;
  const explicitState = typeof event.status === 'string' ? event.status : null;
  if (explicitState && AI_SOFT_STATES.has(explicitState)) return true;
  const mappedState = AI_EVENT_TO_STATE[event.event] || null;
  if (mappedState && AI_SOFT_STATES.has(mappedState)) return true;
  const phase = String(event.phase || '').trim().toLowerCase();
  return phase === 'complete' || phase === 'completed' || phase === 'awaiting_operator';
}

export function resolveInteractiveSubmitSequence(env = process.env) {
  return env.GUARDRAIL_SUBMIT_SEQUENCE_OVERRIDE ?? POST_PASTE_SUBMIT_SEQUENCE;
}

export function resolveInteractiveSubmitDelayMs(env = process.env) {
  return env.GUARDRAIL_SUBMIT_DELAY_MS_OVERRIDE ?? String(POST_PASTE_SUBMIT_DELAY_MS);
}

function reportArtifactRequestsExit(reportArtifact) {
  if (!reportArtifact || !existsSync(reportArtifact)) return false;
  try {
    const text = readFileSync(reportArtifact, 'utf8');
    return /^Status:\s*(COMPLETE|NEEDS_REVIEW)\s*$/m.test(text);
  } catch {
    return false;
  }
}

function normalizeOptions(rawOptions) {
  const baseDir = rawOptions.workingDir
    ? resolve(process.cwd(), rawOptions.workingDir)
    : process.cwd();
  const progressFile = rawOptions.guardrailProgressFile || process.env.GUARDRAIL_AI_PROGRESS_FILE || '';
  const progressStateFile = rawOptions.guardrailProgressStateFile || process.env.GUARDRAIL_AI_PROGRESS_STATE_FILE || '';
  const reportArtifact = rawOptions.guardrailReportArtifact || process.env.GUARDRAIL_AI_REPORT_ARTIFACT || '';
  const heartbeatSeconds = rawOptions.guardrailHeartbeatSeconds || process.env.GUARDRAIL_AI_HEARTBEAT_SECONDS || '';
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
    systemPrompt: [rawOptions.systemPrompt || '', progressAppendix].filter(Boolean).join('\n'),
    workingDir: rawOptions.workingDir ? baseDir : '',
    addDirs: splitCsv(rawOptions.addDirs).map((dir) => resolveFrom(baseDir, dir)),
    sessionName: rawOptions.sessionName || '',
    noSessionPersistence: truthy(rawOptions.noSessionPersistence),
    lifecycle: rawOptions.lifecycle || '',
    sessionId: rawOptions.sessionId || '',
    baseDir,
    progressFile,
    progressStateFile,
    reportArtifact,
    heartbeatSeconds,
    ptyRawLog: process.env.GUARDRAIL_PTY_RAW_LOG || '',
    ptyHexLog: process.env.GUARDRAIL_PTY_HEX_LOG || '',
    ptySendHexLog: process.env.GUARDRAIL_PTY_SEND_HEX_LOG || '',
    submitSequence: resolveInteractiveSubmitSequence(process.env),
    submitDelayMs: resolveInteractiveSubmitDelayMs(process.env),
  };
}

export function emitSessionMetadata({ lifecycle, sessionName, sessionId, workingDir }) {
  return {
    tool: 'claude',
    lifecycle: lifecycle || null,
    sessionName: sessionName || null,
    sessionId: sessionId || null,
    workingDir: workingDir || null,
    backend: 'interactive_prompt_wrapper',
  };
}

function prepareDebugLog(filePath) {
  if (!filePath) return;
  try {
    ensureParentDir(filePath);
    writeFileSync(filePath, '');
  } catch {
    // Best effort only.
  }
}

function appendDebugRaw(filePath, chunk) {
  if (!filePath) return;
  try {
    appendFileSync(filePath, chunk);
  } catch {
    // Best effort only.
  }
}

function appendDebugHex(filePath, chunk, source) {
  if (!filePath) return;
  try {
    const hex = Buffer.from(chunk).toString('hex');
    appendFileSync(filePath, `${source} ${hex}\n`);
  } catch {
    // Best effort only.
  }
}

async function runClaudeInteractive(args, options) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const controlDir = mkdtempSync(join(tmpdir(), 'guardrail-claude-prompt-wrapper-'));
    const controlFile = join(controlDir, 'control.txt');
    const promptFile = join(controlDir, 'prompt.txt');
    writeFileSync(controlFile, '');
    writeFileSync(promptFile, buildInteractivePromptInput(options.promptPayload || ''), 'utf8');
    const child = spawn('expect', ['-c', EXPECT_INTERACTIVE_SCRIPT], {
      cwd: options.workingDir || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GUARDRAIL_CLAUDE_COMMAND: `claude ${args.map((arg) => shellQuoteArg(arg)).join(' ')}`.trim(),
        GUARDRAIL_PROMPT_FILE: promptFile,
        GUARDRAIL_CONTROL_FILE: controlFile,
        GUARDRAIL_STARTUP_PROMPT_DELAY_MS: String(STARTUP_PROMPT_DELAY_MS),
        GUARDRAIL_SUBMIT_DELAY_MS: options.submitDelayMs,
        GUARDRAIL_SUBMIT_SEQUENCE: options.submitSequence,
        GUARDRAIL_PTY_SEND_HEX_LOG: options.ptySendHexLog,
      },
    });
    prepareDebugLog(options.ptyRawLog);
    prepareDebugLog(options.ptyHexLog);
    prepareDebugLog(options.ptySendHexLog);

    let stdout = '';
    let stderr = '';
    let closeSeen = false;
    let exitRequested = false;
    let forcedExitTimer = null;
    let hardTimeoutTimer = null;
    let progressPollTimer = null;
    let progressOffset = options.initialProgressOffset || 0;

    const cleanup = () => {
      if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
      if (progressPollTimer) clearInterval(progressPollTimer);
      if (forcedExitTimer) clearTimeout(forcedExitTimer);
      try {
        rmSync(controlDir, { recursive: true, force: true });
      } catch {
        // Best effort only.
      }
    };

    const sendControlInput = (text) => {
      if (closeSeen) return;
      try {
        writeFileSync(controlFile, text);
      } catch {
        // Best effort only.
      }
    };

    const requestExit = (reason, forceAfterMs = EXIT_GRACE_MS) => {
      if (exitRequested || closeSeen) return;
      exitRequested = true;
      sendControlInput('/exit\r');
      forcedExitTimer = setTimeout(() => {
        if (!closeSeen) {
          try {
            child.kill('SIGTERM');
          } catch {
            // Best effort.
          }
        }
      }, forceAfterMs);
      if (reason) {
        stderr += `${stderr ? '\n' : ''}${reason}`;
      }
    };

    const flushProgress = () => {
      if (!options.progressFile) return;
      const { events, nextOffset } = tailProgressFile(options.progressFile, progressOffset);
      progressOffset = nextOffset;
      for (const evt of events) {
        process.stderr.write(`${GUARDRAIL_AI_PROGRESS_PREFIX}${JSON.stringify(evt)}\n`);
        if (progressEventRequestsExit(evt)) {
          requestExit(`Guardrail interactive wrapper requested exit after progress sentinel (${evt.phase || evt.event || 'unknown'})`);
        }
      }
      if (reportArtifactRequestsExit(options.reportArtifact)) {
        requestExit('Guardrail interactive wrapper requested exit after report-artifact sentinel');
      }
    };

    hardTimeoutTimer = setTimeout(() => {
      requestExit(`Guardrail interactive wrapper hit hard wall-clock timeout (${HARD_TIMEOUT_MS}ms)`, 1000);
    }, HARD_TIMEOUT_MS);

    progressPollTimer = setInterval(() => {
      flushProgress();
    }, PROGRESS_POLL_INTERVAL_MS);

    child.stdout.on('data', (chunk) => {
      appendDebugRaw(options.ptyRawLog, chunk);
      appendDebugHex(options.ptyHexLog, chunk, 'stdout');
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
      flushProgress();
    });

    child.stderr.on('data', (chunk) => {
      appendDebugHex(options.ptyHexLog, chunk, 'stderr');
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
      flushProgress();
    });

    child.on('error', (err) => {
      closeSeen = true;
      cleanup();
      rejectPromise(err);
    });

    child.on('close', (code, signal) => {
      closeSeen = true;
      cleanup();
      flushProgress();
      if (signal) {
        rejectPromise(new Error(`claude interactive exited on signal ${signal}`));
        return;
      }
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function runClaudeInteractiveExec(rawOptions) {
  const options = normalizeOptions(rawOptions);
  const promptPayload = buildPromptPayload({
    prompt: options.prompt,
    inputFiles: options.inputFiles,
    baseDir: options.baseDir,
  });
  const args = buildClaudeArgs(options);

  const sessionMeta = emitSessionMetadata({
    lifecycle: options.lifecycle,
    sessionName: options.sessionName,
    sessionId: options.sessionId,
    workingDir: options.workingDir || process.cwd(),
  });
  process.stderr.write(`[guardrail-session] ${JSON.stringify(sessionMeta)}\n`);

  const { progressFile, progressStateFile, reportArtifact } = options;
  const runId = sessionMeta.sessionName || sessionMeta.sessionId || 'unknown';

  if (progressFile) {
    try {
      ensureParentDir(progressFile);
      writeFileSync(progressFile, '');
    } catch {
      // Non-fatal.
    }
  }

  emitWrapperProgressLine(progressFile, {
    event: 'ai_checkpoint',
    phase: 'started',
    message: 'Claude interactive subprocess is starting',
    severity: 'info',
    runId,
    tool: 'claude',
    reportArtifact: reportArtifact || null,
    progressArtifact: progressFile || null,
    timestamp: new Date().toISOString(),
  });

  let tailOffset = 0;
  if (progressFile && existsSync(progressFile)) {
    try {
      tailOffset = readFileSync(progressFile, 'utf8').length;
    } catch {
      tailOffset = 0;
    }
  }

  const result = await runClaudeInteractive(args, {
    ...options,
    promptPayload,
    initialProgressOffset: tailOffset,
  }).catch((err) => {
    emitWrapperProgressLine(progressFile, {
      event: 'ai_checkpoint',
      phase: 'failed',
      message: err.message,
      severity: 'error',
      runId,
      tool: 'claude',
      reportArtifact: reportArtifact || null,
      progressArtifact: progressFile || null,
      timestamp: new Date().toISOString(),
    });
    throw err;
  });

  const existingState = readProgressState(progressStateFile) || {};
  const currentSoftState = deriveSoftStateFromProgressFile(progressFile);
  const preserveSoftState = result.code === 0 && typeof currentSoftState === 'string';
  const finalStatus = preserveSoftState ? currentSoftState : result.code === 0 ? 'completed' : 'failed';
  const finalPhase = preserveSoftState ? 'awaiting_operator' : result.code === 0 ? 'completed' : 'failed';

  emitWrapperProgressLine(progressFile, {
    event: preserveSoftState ? 'ai_resumed' : 'ai_checkpoint',
    phase: finalPhase,
    message: preserveSoftState
      ? `Claude interactive subprocess exited after signaling ${currentSoftState}`
      : result.code === 0
        ? 'Claude interactive subprocess completed successfully'
        : `Claude interactive subprocess exited with code ${result.code}`,
    severity: result.code === 0 ? 'info' : 'error',
    runId,
    tool: 'claude',
    reportArtifact: reportArtifact || null,
    progressArtifact: progressFile || null,
    timestamp: new Date().toISOString(),
  });

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

  if (result.code !== 0) {
    throw new Error(buildClaudeFailureMessage(result));
  }
}

async function main() {
  await runClaudeInteractiveExec(parseWrapperArgs(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
