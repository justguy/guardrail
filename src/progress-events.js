/**
 * Shared progress-stream event helpers for all supervisors.
 *
 * The schema is intentionally stable and intentionally minimal:
 * - NDJSON object per line
 * - machine-readable status and identity fields
 * - optional event-specific metadata
 */

export const PROGRESS_EVENT_STATUS = {
  approval_pending: 'pending',
  execution_start: 'running',
  step_started: 'running',
  step_completed: 'success',
  step_failed: 'failed',
  step_blocked: 'blocked',
  execution_end: 'success',
};

export const PROGRESS_RESULT_STATUS = {
  success: 'success',
  approval_required: 'blocked',
  approval_denied: 'blocked',
  drift_detected: 'blocked',
  validation_failed: 'failed',
  policy_violation: 'failed',
  update_denied: 'blocked',
  protocol_error: 'failed',
  unsupported: 'failed',
  internal_error: 'failed',
  time_policy_violated: 'failed',
  concurrent_blocked: 'blocked',
  audit_chain_broken: 'failed',
  timeout: 'failed',
};

export function mapResultStatusToProgressStatus(status = '') {
  return PROGRESS_RESULT_STATUS[status] ?? 'unknown';
}

export function emitProgress(progressSink, runId, mode, event, data = {}) {
  if (typeof progressSink !== 'function') return;

  const eventData = {
    event,
    mode,
    runId,
    status: data.status ?? PROGRESS_EVENT_STATUS[event] ?? 'unknown',
  };

  if (data.mode) {
    eventData.mode = data.mode;
  }
  if (data.workflowName) eventData.workflowName = data.workflowName;
  if (data.stepId) eventData.stepId = data.stepId;
  if (data.stepType) eventData.stepType = data.stepType;
  if (data.message) eventData.message = data.message;
  if (data.reason) eventData.reason = data.reason;
  if (data.stepResult) eventData.stepResult = data.stepResult;
  if (data.finalStatus) eventData.finalStatus = data.finalStatus;
  if (data.stepsExecuted !== undefined) eventData.stepsExecuted = data.stepsExecuted;
  if (data.attempt !== undefined) eventData.attempt = data.attempt;

  progressSink(eventData);
}

export function emitExecutionEnd(progressSink, runId, mode, finalStatus, context = {}) {
  emitProgress(progressSink, runId, mode, 'execution_end', {
    ...context,
    finalStatus,
    status: mapResultStatusToProgressStatus(finalStatus),
  });
}

// ---------------------------------------------------------------------------
// AI-specific progress channel (D0y)
// ---------------------------------------------------------------------------

export const AI_CHECKPOINT_EVENTS = [
  'ai_checkpoint',
  'ai_artifact_written',
  'ai_question',
  'ai_review_requested',
  'ai_drift_warning',
  'ai_waiting_for_input',
  'ai_waiting_for_review',
  'ai_stalled',
  'ai_resumed',
];

/**
 * Non-terminal AI run states: the run is still alive but needs attention.
 * Terminal states: completed, failed.
 */
export const AI_SOFT_STATES = new Set([
  'waiting_for_review',
  'waiting_for_input',
  'drift_warning',
  'stalled',
]);

export const AI_RUN_STATES = {
  running: 'running',
  waiting_for_review: 'waiting_for_review',
  waiting_for_input: 'waiting_for_input',
  drift_warning: 'drift_warning',
  stalled: 'stalled',
  completed: 'completed',
  failed: 'failed',
};

/**
 * Heartbeat deadlines (seconds) for AI progress channel.
 * These live in progress-events.js so both the supervisor and the wrapper
 * can reference them from a single source of truth.
 */
export const AI_HEARTBEAT_POLICY = {
  firstCheckpointWarnSeconds: 30,
  stallWarnSeconds: 90,
  hardStallSeconds: 180,
};

/**
 * Map AI checkpoint event names to canonical run-state strings.
 */
export const AI_EVENT_TO_STATE = {
  ai_checkpoint: 'running',
  ai_artifact_written: 'running',
  ai_question: 'waiting_for_input',
  ai_review_requested: 'waiting_for_review',
  ai_drift_warning: 'drift_warning',
  ai_waiting_for_input: 'waiting_for_input',
  ai_waiting_for_review: 'waiting_for_review',
  ai_stalled: 'stalled',
  ai_resumed: 'running',
};

/**
 * Emit a structured AI progress event through the standard progressSink.
 * Uses an extended field set for AI-specific context (provenance, session,
 * artifact paths) on top of the base event schema.
 */
export function emitAiProgress(progressSink, runId, event, data = {}) {
  if (typeof progressSink !== 'function') return;

  const status = AI_EVENT_TO_STATE[event] ?? 'running';

  const eventData = {
    event,
    mode: 'ai_exec',
    runId,
    status,
    tool: data.tool ?? 'claude',
  };

  if (data.checkpointId) eventData.checkpointId = data.checkpointId;
  if (data.phase) eventData.phase = data.phase;
  if (data.message) eventData.message = data.message;
  if (data.severity) eventData.severity = data.severity;
  if (data.reportArtifact) eventData.reportArtifact = data.reportArtifact;
  if (data.progressArtifact) eventData.progressArtifact = data.progressArtifact;
  if (data.sessionName) eventData.sessionName = data.sessionName;
  if (data.sessionId) eventData.sessionId = data.sessionId;
  if (data.sourceRootType) eventData.sourceRootType = data.sourceRootType;
  if (data.sourceRootIdentity) eventData.sourceRootIdentity = data.sourceRootIdentity;
  if (data.continuationCommand) eventData.continuationCommand = data.continuationCommand;
  eventData.timestamp = data.timestamp ?? new Date().toISOString();

  progressSink(eventData);
}

/**
 * Parse a single `[guardrail-ai-progress]`-prefixed stderr line from the
 * claude-exec wrapper back into a structured event object.
 * Returns null for non-matching lines or malformed JSON.
 */
export function parseAiProgressLine(line) {
  if (typeof line !== 'string') return null;
  const prefix = '[guardrail-ai-progress] ';
  if (!line.startsWith(prefix)) return null;
  const json = line.slice(prefix.length).trim();
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
