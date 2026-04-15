# REPORT — Enterprise Item 30: Break-Glass Rollout Inventory

**Status: COMPLETE**
**Date:** 2026-04-14
**Lane:** enterprise-30-inventory-lane
**Roadmap anchor:** `enterprise-30-break-glass-rollout` / technical-status.md item 30

---

## Summary

Item 30 promises: *break-glass controls, revocation, and emergency kill switch* to satisfy enterprise incident response. P0h landed the local single-target seam. `30a` closed the bulk repo/workspace kill switch, `30b` closed the local RBAC gate, and `30c` closed key revocation distinct from rotation. The local item is now closable honestly.

---

## 1. What P0h Already Satisfied

| Promise | Evidence |
|---------|----------|
| Lane-level revocation (SIGTERM + non-restartable sentinel) | `revokeResidentLane()` in `src/resident-lane-core.js`; `guardrail lane revoke` CLI |
| Break-glass lane kill (SIGKILL + non-restartable sentinel) | `killResidentLane()` in `src/resident-lane-core.js`; `guardrail lane kill` CLI |
| Session contract revocation (blocks all future lifecycle evaluation) | `revokeSessionContract()` + `isSessionRevoked()` in `src/agent-session.js`; `evaluateSessionLifecycle` returns distinct `session_revoked` code |
| Auditable emergency events | `lane_revoked`, `lane_emergency_stop`, `session_revoked` added to `INCIDENT_EVENTS` + `INCIDENT_TRIGGERS` in `src/event-schema.js`; each CLI command appends a distinct audit entry |
| Restart permanently blocked | `REVOKED` sentinel file check in `runResidentLaneDaemon` at boot, before any lane logic |
| Distinction from ordinary stop | Three-way table documented in P0h report: `lane stop` vs `lane revoke` vs `lane kill` produce different signals, states, events, and restart semantics |

P0h is a complete local seam for single-target emergency controls.

---

## 2. What Is Still Missing

### Gap A — Org/workspace-scoped bulk kill switch (HIGH)

**Item 30 language:** *"org/workspace kill switches"*

`guardrail lane revoke` and `guardrail lane kill` each require a known `--lane-dir`. There is no path to revoke **all** lanes in a repo, workspace, or org scope in a single auditable operation.

`listResidentLanes()` already enumerates active lanes (used by `guardrail lane list` and `guardrail lane stop --all`). The bulk-revoke path is not wired through it.

**Missing:** `guardrail lane revoke --all [--repo-root <path>] [--actor <str>] [--reason <str>]` and `guardrail lane kill --all` that iterate `listResidentLanes()`, call `revokeResidentLane()`/`killResidentLane()` per lane, and emit one audit entry per lane revoked. The aggregate result should include a count summary.

**Why this matters for item 30:** Enterprise operators responding to an incident need to contain **all** compromised automation under a repo or workspace, not hunt for individual lane-dir paths.

---

### Gap B — RBAC gate on break-glass commands (MEDIUM) — CLOSED by `30b`

**Item 30 language:** *"break-glass approval flows"*

P0h wired the commands but added no authorization check before they execute. That gap is now closed locally: active Guardrail profiles carry `operator_role`, RBAC defines admin-only `emergency_control`, and both `guardrail lane revoke` and `guardrail lane kill` enforce that permission before either single-target or bulk action executes.

**Delivered in `30b`:** denied callers now append `rbac_check` and `emergency_denied` audit evidence before exiting non-zero. Allowed callers append an `rbac_check` allow event before the emergency action executes.

**Why this matters for item 30:** "Break-glass approval flows" implies the override path is gated — not just audited after the fact. The local role check now satisfies this without requiring SSO or a hosted admin UI.

---

### Gap C — Key/approval-token revocation (LOW) — CLOSED by `30c`

**Item 30 language:** *"token/session/lane revocation"*

P0h satisfied session and lane. The remaining local revocation seam is now delivered through key-store revocation in `src/key-management.js`.

`key-management.js` currently supports `set`, `get`, `list`, `rotate`, `redact`. No `revoke` path exists. A revoked key should block future `get()` with a distinct error (distinct from `not_found`).

**Delivered in `30c`:** `createKeyStore().revoke(name, { actor, reason })` stamps `revoked`, `revokedAt`, `revokedBy`, and `revocationReason`; `get()` now fails closed with code `key_revoked`; `guardrail key revoke <name> --state-dir <dir>` exposes the control path; and `key_revoked` is now an incident event.

**Why this matters for item 30:** Without key revocation, an operator who suspects a compromised key cannot invalidate it — they can only rotate it. That local gap is now closed.

---

## 3. Gap Ranking by Implementation Leverage

| Rank | Gap | Size | Satisfies item 30 language | Risk if skipped |
|------|-----|------|---------------------------|-----------------|
| 1 | **Gap A** — Bulk-revoke `--all` | ~50 LOC in `cli.js` + one loop in a new helper | "org/workspace kill switches" directly | Operator must manually `ls` and invoke per-lane; incident response degrades to manual grep |
| 2 | **Gap B** — RBAC gate on revoke/kill | Closed by `30b` — active profile `operator_role`, admin-only `emergency_control`, audited deny path | "break-glass approval flows" at local level | Closed |
| 3 | **Gap C** — Key revocation | Closed by `30c` — revoke state, fail-closed reads, CLI surface, audited `key_revoked` event | "token revocation" | Closed |

---

## 4. Recommended First Slice: `lane revoke/kill --all` (Gap A)

**Why first:** It directly closes the "org/workspace kill switch" requirement, is purely additive over existing primitives, requires no new concepts, and produces an immediately verifiable audit trail. It is also the highest-leverage gap: a single misfire in an incident response is worse than missing a role gate.

**What the slice must include:**

1. `--all` flag wired into both `lane-revoke` and `lane-kill` CLI handlers in `src/cli.js`
2. Calls `listResidentLanes(laneOpts)` to enumerate targets; iterates and calls `revokeResidentLane()`/`killResidentLane()` per lane
3. Each lane emits its own `lane_revoked` / `lane_emergency_stop` audit entry (reuses existing event types — no schema additions needed)
4. Handler prints a summary: `N lane(s) revoked, N already-REVOKED skipped, N errors`
5. Exit non-zero if any target fails; do not silently skip errors
6. Focused tests: `--all` with 0/1/N lanes, already-REVOKED skip behavior, error on partial failure

**Proof of done:** `guardrail lane revoke --all --actor operator --reason "incident-2026-04-14"` revokes all enumerated lanes, audit log contains one `lane_revoked` entry per lane, command exits 0 on full success and 1 on partial failure.

---

## 5. What Should Remain Out of Scope After Gap A

The following are **not** required to close item 30 at the local-seam level:

- Hosted admin UI or control plane
- SSO/OIDC/SAML-backed operator authentication (item 18 scope)
- Cross-node or cross-machine bulk revocation (requires hosted state — item 33 scope)
- Workspace/org directory model (item 26 scope)
- Real-time webhook delivery of emergency events (item 23/28 scope)
- DSAR / legal-hold interactions (item 37 scope)

Item 30 is now closed locally by the already-delivered P0h + `30a` + `30b` + `30c` slices. Hosted enterprise rollout (multi-tenant kill switches, OIDC-backed approval) is explicitly a separate funded item and should not be backfilled here.

---

## 6. Answers to Required Questions

**Q1. What exact promises in enterprise item 30 are already satisfied by P0h?**
Single-target lane revocation, single-target break-glass lane kill, single-target session revocation, auditable emergency events for all three, and permanent restart blocking via REVOKED sentinel.

**Q2. What exact promises are still missing?**
- None at the local seam. Hosted rollout remains out of scope.

**Q3. Which missing pieces are small enough to implement now without introducing a hosted admin plane?**
Gap A, Gap B, and Gap C are now all closed locally.

**Q4. What is the best first slice to run next through Guardrail?**
No further local slice is required for item `30`.

**Q5. What should remain explicitly out of scope after that first slice?**
Hosted control plane, SSO-backed operator auth, cross-node revocation, workspace directory model, real-time event delivery. All of these are later funded items (18, 23, 26, 28, 33).

---

*Inventory produced by enterprise-30-inventory-lane resident agent and later updated after `30a`, `30b`, and `30c` landed.*
