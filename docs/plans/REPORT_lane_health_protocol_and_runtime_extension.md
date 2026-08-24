# REPORT — Lane Health Protocol + Runtime Extension

Status: COMPLETED
Date: 2026-04-11

## Summary

Extended the resident FIFO lane daemon with a real health protocol and live runtime extension path. The daemon now observes a per-lane `control.json` every poll tick, so timeout extensions and heartbeats take effect on the running lane without restart or `state.json` surgery.

Review follow-up:
- The first implementation pass was not quite complete. Review found two semantic gaps:
  - `stalled` only triggered from `ready`, not from in-flight `busy` requests.
  - stalled in-flight requests were not treated as pending by `lane result`.
- Those gaps are now fixed in the reviewed patch below, and the focused test count increased accordingly.

## What changed

### `src/resident-lane-core.js`
- `DEFAULT_HEALTH_TIMEOUT_MS = 5 * 60 * 1000` (separate from `DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000`).
- `lanePaths()` now includes `controlPath` (`<laneDir>/control.json`).
- `buildState()` persists `healthTimeoutMs`.
- New pure helper `evaluateLaneHealth({ status, lastActivityAtMs, lastSeenHeartbeat, now, control, idleTimeoutMs, healthTimeoutMs })` returns `{ nextStatus, nextActivity, nextSeenHeartbeat, action, effectiveIdleMs, effectiveHealthMs }`. Action ∈ `none | heartbeat | clear_stall | stall | expire`.
- The daemon poll loop in `runResidentLaneDaemon` now reads `control.json` each tick and dispatches the action returned by `evaluateLaneHealth` — transitioning to `stalled` at `healthTimeoutMs` for both `ready` and `busy` lanes, clearing `stalled` on heartbeat, and only hard-expiring past `idleTimeoutMs`.
- New exports: `readLaneControl`, `writeLaneControl`, `extendResidentLane(laneDir, { idleTimeoutMs, healthTimeoutMs, heartbeat })` — validates values (≥1000ms), rejects empty updates, and enforces `healthTimeoutMs < idleTimeoutMs`.
- Lane status object now surfaces `healthTimeoutMs` and the raw `control` doc.
- `classifyLaneStatus()` now recommends result/inspection flow for live `stalled` lanes instead of treating them like plain `ready` lanes.
- `getResidentLaneResult()` now treats stalled in-flight requests as `pending` instead of `result_not_found`.
- Cleanup removes `control.json` alongside FIFOs/keys.

### `src/claude-resident-lane.js` + `src/codex-resident-lane.js`
- Added `--health-timeout-ms` to argv parser.
- `normalizeResidentLaneOptions` defaults `healthTimeoutMs` to 300_000 (min 1000).
- Both `buildHelperArgs` and `buildDaemonArgs` forward `--health-timeout-ms` to the spawned daemon.

### `src/cli.js`
- New `guardrail lane extend` subcommand: `--idle-timeout-ms`, `--health-timeout-ms`, `--heartbeat`. Calls `extendResidentLane()`, prints updated control, appends `lane_extend` audit entry.
- Help text updated.

### Docs
- `README.md` — `lane extend` description + health/idle distinction section.
- `docs/agent-onboarding.md` — `stalled` status and `lane extend` documented.
- `docs/technical-status.md` — top-of-file recent change banner.

### Tests — `tests/test-lane-health.js` (10 passing)
1. claude normalizer default `healthTimeoutMs = 300_000` and `idleTimeoutMs > healthTimeoutMs`.
2. codex normalizer default `healthTimeoutMs = 300_000`.
3. `evaluateLaneHealth` surfaces `stalled` before expiry and then `expire` past idle timeout.
4. `evaluateLaneHealth` also surfaces `stalled` for in-flight `busy` requests before expiry.
5. Live extension via `control.json` changes the effective timeout observed by the same pure helper the daemon uses (proves daemon observes updated values, not just that they were written).
6. Heartbeat clears `stalled` and bumps `lastActivityAtMs` without faking completion.
7. Heartbeat restores stalled in-flight requests to `busy`, not `ready`.
8. `extendResidentLane` rejects empty updates, sub-1000ms values, and invalid `healthTimeoutMs >= idleTimeoutMs`.
9. `writeLaneControl` merges successive patches and timestamps `updatedAt`.
10. `getResidentLaneResult` treats stalled in-flight requests as `pending`.

## Acceptance bar check

- [x] Lane status can distinguish running normally / stalled / expired.
- [x] Live timeout extension works on an already-running lane (daemon re-reads `control.json` each poll tick via `evaluateLaneHealth`).
- [x] Docs describe health timeout vs idle expiry difference.
- [x] Focused tests prove: default health timeout exists; stalled surfaced before expiry; extending a live lane changes effective timeout behaviour; heartbeat clears stalled.

## Scope notes

- `prompt-wrapper-resident-lane.js`, `ssh-prompt-wrapper-resident-lane.js`, `local-exec-resident-lane.js`: not modified in this packet. Claude + Codex are the two primary provider adapters covered by tests; the three remaining wrappers inherit the core daemon behavior and default `healthTimeoutMs` via `buildState()` fallback to `DEFAULT_HEALTH_TIMEOUT_MS`, so `stalled`/heartbeat work even without the flag, but they do not yet accept `--health-timeout-ms` on launch. Follow-up: mirror the two-line parser + normalizer + forward pattern in those three wrappers.

## Verification

``` 
node --test tests/test-lane-health.js            → 10/10 pass
node --test tests/test-claude-resident-lane.js   → pass
node --test --test-name-pattern "Resident Lane Mode" tests/test-feature-acceptance.js → pass
```
