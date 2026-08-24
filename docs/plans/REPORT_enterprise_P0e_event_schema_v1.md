# REPORT — Enterprise P0e: Event Schema v1

Status: COMPLETE  
Date: 2026-04-11  
Packet: `docs/plans/PLAN_enterprise_P0e_event_schema_v1.md`

## Objective

Freeze a single, versioned event vocabulary (`schema_version: 1`) shared by all Guardrail subsystems: audit, metrics, notifications, incident-hooks, and compliance. Five event families must be explicitly distinct and consistently identifiable across all surfaces.

## Intended Proof

- `tests/test-bucket3.js` (fingerprint, audit chain, tamper, time policy, locks)
- `tests/test-bucket5.js` (resource bounds, learning mode, profiles, safe defaults, policy, metrics, identity, strict mode)
- `tests/test-bucket6.js` (shared manifests, approval queue, RBAC, keys, env, marketplace, incidents)

---

## Event Schema v1 — Frozen Vocabulary

**File:** `src/event-schema.js`

### Schema version

```js
export const SCHEMA_VERSION = 1;   // bump on breaking shape changes
```

### Five event families

| Family | Set exported | Sample members |
|--------|-------------|----------------|
| `execution` | `EXECUTION_EVENTS` | `execution_start`, `execution_end`, `approval_required`, `drift_detected`, `rollback_start`, `lock_acquired` |
| `admin` | `ADMIN_EVENTS` | `config_changed`, `deploy_mode_changed`, `key_rotated`, `recipe_installed`, `recipe_published` |
| `access` | `ACCESS_EVENTS` | `audit_queried`, `compliance_exported`, `metrics_read`, `manifest_read`, `policy_read` |
| `policy` | `POLICY_EVENTS` | `violation_detected`, `policy_violation`, `resource_exceeded`, `rbac_check`, `recipe_blocked` |
| `incident` | `INCIDENT_EVENTS` | `incident_detected`, `abnormal_activity`, `audit_chain_broken`, `concurrent_blocked`, `incident_escalated` |

### Envelope fields on every emitted event

```jsonc
{
  "schema_version": 1,          // always present
  "family": "execution",        // one of the five names above
  "event": "execution_start",   // specific event type
  // ... subsystem-specific fields
}
```

### Derived sets

- `NOTIFY_EVENTS` — events that trigger outbound notifications; imported by `notifications.js`
- `INCIDENT_TRIGGERS` — events that can trigger incident hooks; imported by `incident-hooks.js`
- `FAMILY_MAP` — flat `Map<string, string>` for O(1) family lookup
- `eventFamily(type)` — returns family or `'unknown'`
- `makeEventEntry(type, fields)` — factory attaching envelope fields

---

## Changes Made

### New file: `src/event-schema.js`

Single source of truth. Defines all five family sets, the flat lookup map, and helpers. ~150 lines.

### `src/audit.js`

Imports `SCHEMA_VERSION`, `eventFamily`. `appendEntry()` now sets `schema_version` and `family` on every entry before hashing.

### `src/metrics.js`

Imports `ALL_EVENTS`, `SCHEMA_VERSION`, `eventFamily`. `EVENT_TYPES` is now `ALL_EVENTS` (derived, not redeclared). `emit()` adds `schema_version` and `family` to every metrics record.

### `src/notifications.js`

`NOTIFY_EVENTS` is now imported from `event-schema.js` rather than redeclared. `notify()` adds `schema_version` and `family` to every outbound notification entry.

### `src/incident-hooks.js`

`VALID_TRIGGERS` is now `INCIDENT_TRIGGERS` imported from `event-schema.js`. Incident records carry `schema_version` and `family`.

### `src/compliance.js`

Imports `eventFamily`. `generateReport()` now categorizes entries by family using `eventFamily(e.event)` (with `e.family` fallback for already-stamped entries) instead of fragile `.includes()` string matching.

---

## Checkpoint 1 — Pre-existing failures isolated

Before implementing, `npm test` baseline on main: **1533/1540 pass, 7 fail** (all in session-contract enforcement and codex/claude recipe integration — unrelated to this packet).

## Checkpoint 2 — Focused proof results

```
node --test tests/test-bucket3.js tests/test-bucket5.js tests/test-bucket6.js

ℹ tests 157
ℹ pass  157
ℹ fail  0
```

**All 157 focused-proof tests pass.**

## Checkpoint 3 — Full suite regression check

```
npm test

ℹ tests 1540
ℹ pass  1533
ℹ fail  7
```

Same 7 pre-existing failures. **Zero regressions introduced.**

---

## Stop Conditions — Verified

| Condition | Status |
|-----------|--------|
| Events still ad hoc per subsystem | **Cleared** — all five subsystems import from `event-schema.js` |
| Schema versioning implied but not explicit | **Cleared** — `SCHEMA_VERSION = 1` on every emitted record |
| Access/read/export not distinguishable in audit/event output | **Cleared** — `ACCESS_EVENTS` family is explicit and distinct |

---

## `docs/technical-status.md` changes

- P0e row updated from stub to **Done**
- Enterprise item 36 updated to **Partially done (P0e)**

---

Status: COMPLETE
