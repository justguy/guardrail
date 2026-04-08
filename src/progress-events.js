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
