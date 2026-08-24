export function evaluateLaneHealth(ctx) {
  const {
    status,
    currentRequestId,
    lastActivityAtMs,
    lastSeenHeartbeat,
    now,
    control = {},
    idleTimeoutMs,
    healthTimeoutMs,
  } = ctx;

  const effectiveIdleMs = (Number.isFinite(control.idleTimeoutMs) && control.idleTimeoutMs >= 1000)
    ? control.idleTimeoutMs : idleTimeoutMs;
  const effectiveHealthMs = (Number.isFinite(control.healthTimeoutMs) && control.healthTimeoutMs >= 1000)
    ? control.healthTimeoutMs : healthTimeoutMs;

  let nextActivity = lastActivityAtMs;
  let nextSeenHeartbeat = lastSeenHeartbeat;
  let nextStatus = status;
  let action = 'none';

  if (control.heartbeatAt && control.heartbeatAt !== lastSeenHeartbeat) {
    nextSeenHeartbeat = control.heartbeatAt;
    nextActivity = now;
    if (status === 'stalled') {
      nextStatus = currentRequestId ? 'busy' : 'ready';
      action = 'clear_stall';
    } else {
      action = 'heartbeat';
    }
    return { nextStatus, nextActivity, nextSeenHeartbeat, action, effectiveIdleMs, effectiveHealthMs };
  }

  const elapsed = now - nextActivity;
  if (elapsed > effectiveIdleMs) {
    return { nextStatus: status, nextActivity, nextSeenHeartbeat, action: 'expire', effectiveIdleMs, effectiveHealthMs };
  }
  if (elapsed > effectiveHealthMs && (status === 'ready' || status === 'busy')) {
    return { nextStatus: 'stalled', nextActivity, nextSeenHeartbeat, action: 'stall', effectiveIdleMs, effectiveHealthMs };
  }
  return { nextStatus: status, nextActivity, nextSeenHeartbeat, action: 'none', effectiveIdleMs, effectiveHealthMs };
}
