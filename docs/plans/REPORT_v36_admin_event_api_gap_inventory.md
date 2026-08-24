# REPORT v36 — Admin/Event API Gap Inventory

**Status: COMPLETE**
**Date: 2026-04-14**
**Roadmap Item:** 36 — Versioned admin/event APIs and read-access auditing

---

## 1. What Item 36 Requires

From `docs/technical-status.md` (line 581):

> Partially done (P0e) — event schema v1 frozen: all emitted events carry
> `schema_version: 1` and `family`; access/read/export events are a distinct
> vocabulary family; still needs **versioned API contracts**, **admin-surface
> versioning**, and **compatibility guarantees** for external integrations.

Three sub-goals:
1. Versioned event schema with frozen vocabulary (access, admin, execution, policy, incident families)
2. Versioned admin/CLI surface — callers can depend on stable output shape
3. Read/export operations emit access-family audit events (read-access auditing)

---

## 2. Currently Implemented Surfaces

### 2a. Event Schema (`src/event-schema.js`)

- `SCHEMA_VERSION = 1` (integer constant, comment says "bumped on breaking changes")
- Five event families defined as `Set<string>` constants: `EXECUTION_EVENTS`, `ADMIN_EVENTS`, `ACCESS_EVENTS`, `POLICY_EVENTS`, `INCIDENT_EVENTS`
- `eventFamily(type)` maps any event string → family name (`'execution'|'admin'|'access'|'policy'|'incident'|'unknown'`)
- `makeEventEntry(type, fields)` stamps `schema_version: 1` and `family` on every entry
- `ALL_EVENTS` is the flat union of all families — subsystems are expected to import from here instead of defining their own strings
- **Vocabulary for all three relevant families is declared:**
  - `ADMIN_EVENTS`: `config_changed`, `deploy_mode_changed`, `key_rotated`, `recipe_installed`, `recipe_published`, `profile_updated`
  - `ACCESS_EVENTS`: `audit_queried`, `compliance_exported`, `metrics_read`, `manifest_read`, `policy_read`

### 2b. Audit Log (`src/audit.js`)

- `createAuditLog(auditPath)` + `appendEntry(auditPath, entry, provenance)` — hash-chained NDJSON log
- `appendEntry` stamps `schema_version` and `family` (via `eventFamily`) on every entry
- `queryAuditLog(auditPath, filters)` — filter by `trace_id`, `manifest_hash`, `event`, `after`, `before`
- `verifyAuditChain(auditPath)` — integrity check

### 2c. Compliance Export (`src/compliance.js`)

- `exportAuditLog(auditPath, opts)` — JSON or CSV export with optional date range / type filters
- `exportPolicies(policyDir, opts)` — policy snapshot export
- `generateReport(auditPath, opts)` — summary statistics

### 2d. Metrics (`src/metrics.js`)

- `createMetricsCollector(logDir)` — returns `{ emit, path }` — emits to `metrics.jsonl`
- Each emitted entry carries `schema_version`, `family`, `event`, `actor`, `origin`, `recipe_id`, `trace_id`, `details`
- `aggregateMetrics(metricsPath)` + `formatMetrics(metrics)` — aggregate and display

### 2e. CLI Surfaces (`src/cli.js`)

| Subcommand | Action |
|---|---|
| `guardrail audit verify` | Verify hash chain integrity |
| `guardrail audit query [--trace-id] [--event] [--after] [--before] [--json]` | Query audit log |
| `guardrail metrics [--path] [--json]` | Read and aggregate metrics |
| `guardrail export [--format json\|csv] [--output]` | Export audit log via `compliance.exportAuditLog` |
| `guardrail approve list / approve / reject` | Approval queue management |
| `guardrail marketplace list` | Recipe marketplace index |

### 2f. Adapter Result Versioning (`src/adapter-result.js`, `src/adapter-engine.js`)

- `schemaVersion: 'adapter-result/v1'` — stable output contract for adapters (OpenClaw, Aider, Cline)
- Shape invariant checked on every result via `checkAdapterResult()`

### 2g. Recipe Registry Versioning (`src/recipe-registry.js`, `src/recipe-install.js`)

- Registry paths follow `/v1/recipes/<category>/<id>/versions/<ver>.json` layout
- SHA-pinned install with content hash verification

---

## 3. What Is Still Missing

### Gap 1 — ACCESS_EVENTS are declared but never emitted

**This is the critical read-access auditing gap.**

`ACCESS_EVENTS` (`audit_queried`, `compliance_exported`, `metrics_read`, `manifest_read`, `policy_read`) exist in `event-schema.js` but no call site in `src/` actually emits them:

- `cli.js` dispatches `guardrail audit query` → calls `queryAuditLog()` → **no `audit_queried` event appended**
- `cli.js` dispatches `guardrail export` → calls `exportAuditLog()` → **no `compliance_exported` event appended**
- `cli.js` dispatches `guardrail metrics` → calls `aggregateMetrics()` → **no `metrics_read` event appended**

Grep confirms zero occurrences of these string literals outside `event-schema.js`.

**Effect:** Every read/export operation on the audit log is itself unaudited, defeating the forensic visibility goal.

### Gap 2 — ADMIN_EVENTS are declared but never emitted

`ADMIN_EVENTS` (`config_changed`, `deploy_mode_changed`, `key_rotated`, `recipe_installed`, `recipe_published`, `profile_updated`) exist in `event-schema.js` but are not emitted at the action call sites:

- `recipe-install.js` installs a recipe but does not emit `recipe_installed`
- `key-management.js` rotates a key but does not emit `key_rotated`
- `deployment-mode.js` changes mode but does not emit `deploy_mode_changed`

**Effect:** The admin event trail is silent; SIEM/audit integrations built on the event spine would miss all admin lifecycle events.

### Gap 3 — No versioned API contract document or stability guarantee

`SCHEMA_VERSION = 1` exists as a constant with a one-line comment. There is no:
- Machine-readable schema document (JSON Schema or equivalent) consumers can validate against
- Documented policy for what constitutes a breaking change and how `SCHEMA_VERSION` gets bumped
- Compatibility guarantee for CLI output shapes (e.g., `--json` flag output fields for `audit query`, `export`, `metrics`)
- Changelog section tracking schema evolution

**Effect:** External integrations (SIEM shippers, dashboards, webhook consumers) cannot reliably depend on output stability or detect schema migration.

### Gap 4 — `audit query` output shape is unversioned

The `guardrail audit query --json` output is raw array of audit entries with no envelope carrying `schema_version`. If the audit entry shape changes, consumers have no version field to branch on at the response level (only at the per-entry level).

---

## 4. Smallest Next 3 Implementation Slices

### Slice A — Emit ACCESS_EVENTS at all read/export dispatch points (1–2 files)

Wire `appendEntry` calls for `audit_queried`, `compliance_exported`, and `metrics_read` in the three `cli.js` dispatch blocks that currently call the underlying read functions without auditing themselves. Optionally move this into the `queryAuditLog`/`exportAuditLog`/`aggregateMetrics` functions directly so all call paths are covered.

**Files touched:** `src/cli.js` (dispatch blocks) or `src/audit.js` + `src/compliance.js` + `src/metrics.js`
**Test coverage:** Add assertions to `tests/test-bucket3.js` that a `guardrail audit query` call produces an `audit_queried` entry in the log.

### Slice B — Emit ADMIN_EVENTS at install/rotate/mode-change call sites (2–3 files)

Add `appendEntry`/`metrics.emit` calls for `recipe_installed`, `key_rotated`, and `deploy_mode_changed` inside the respective action functions in `recipe-install.js`, `key-management.js`, and `deployment-mode.js`. Each call site already has access to actor/trace context.

**Files touched:** `src/recipe-install.js`, `src/key-management.js`, `src/deployment-mode.js`
**Test coverage:** Add to `tests/test-bucket5.js` or `tests/test-bucket6.js`.

### Slice C — Add a schema stability document and `--json` envelope versioning for read commands (1 new file + 1 edit)

1. Create `docs/event-schema-v1.md` documenting: what fields are guaranteed stable, what constitutes a breaking change, and what the bump policy for `SCHEMA_VERSION` is.
2. Wrap the `--json` output of `guardrail audit query` and `guardrail export` in an envelope `{ schema_version: 1, entries: [...] }` so consumers can branch on version at the response level.

**Files touched:** new `docs/event-schema-v1.md`, `src/cli.js` (two `--json` output sites)

---

## 5. Summary Table

| Sub-goal | Declared | Implemented | Gap |
|---|---|---|---|
| Event schema v1 frozen, `schema_version` + `family` on all entries | Yes | Yes (audit + metrics) | None |
| ACCESS_EVENTS vocabulary defined | Yes | Yes (`event-schema.js`) | Not emitted at read sites |
| ADMIN_EVENTS vocabulary defined | Yes | Yes (`event-schema.js`) | Not emitted at admin action sites |
| Read operations produce audit trail | No | No | Slice A needed |
| Admin operations produce audit trail | No | No | Slice B needed |
| Versioned API contract + stability doc | No | No | Slice C needed |
| `adapter-result/v1` stable output shape | Yes | Yes | Done |
| Recipe registry `/v1/` path layout | Yes | Yes | Done |

Item 36 can be closed after Slices A, B, and C are complete and tested.
