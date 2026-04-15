# Guardrail Event Schema v1 — External API Contract

**Version:** 1  
**Status:** Stable  
**Source of truth:** `src/event-schema.js` (`SCHEMA_VERSION = 1`)

---

## 1. JSON Response Envelope

All read/export CLI surfaces that accept `--json` emit a **versioned envelope**:

```json
{
  "schema_version": 1,
  "data": { ... }
}
```

External consumers **MUST** branch on `schema_version` before parsing `data`.

### 1.1 Stable Envelope Fields

| Field | Type | Notes |
|---|---|---|
| `schema_version` | `integer` | Always `1` at v1. Incremented only on breaking changes. |
| `data` | `object \| array` | Surface-specific payload (see section 3). |

### 1.2 Additive Changes (Non-Breaking)

The following changes to `data` do **not** increment `schema_version`:

- Adding new fields inside `data`
- Adding new event type strings to an existing family
- Adding a new event family
- Adding a new CLI surface that emits this envelope

### 1.3 Breaking Changes (Require Schema Version Bump)

`schema_version` **must** be incremented when:

- The top-level envelope shape changes (field removed, renamed, or type changed)
- A field inside `data` is removed or its type changes for an existing surface
- The semantics of a field change (e.g., `chainValid` inverts its meaning)
- An event type string is removed from a family

---

## 2. Audit Event Fields

Every audit entry (both emitted and queryable) carries:

| Field | Type | Stable? | Notes |
|---|---|---|---|
| `schema_version` | `integer` | Yes | Always `1` at v1 |
| `family` | `string` | Yes | One of the five families below |
| `event` | `string` | Yes | One of the registered event type strings |
| `timestamp` | `ISO8601 string` | Yes | UTC |
| `trace_id` | `string \| null` | Yes | Cross-entry correlation handle |
| `manifest_hash` | `string \| null` | Yes | SHA256 hex of the associated manifest |
| `prev_hash` | `string \| null` | Yes | Hash chain link (audit integrity) |
| `hash` | `string` | Yes | Hash of this entry |

Fields not listed above are additive and may be absent.

---

## 3. CLI Surface Payload Shapes

### `guardrail audit verify --json`

```json
{
  "schema_version": 1,
  "data": {
    "valid": true,
    "entries": 42
  }
}
```

On failure: `"valid": false, "error": "<reason>"`.

### `guardrail audit query [filters] --json`

```json
{
  "schema_version": 1,
  "data": {
    "chainValid": true,
    "entries": [ { ... audit entry ... } ]
  }
}
```

### `guardrail metrics --json`

```json
{
  "schema_version": 1,
  "data": {
    "total": 10,
    "by_event": { "execution_start": 3, ... },
    "by_actor": { ... },
    "by_recipe": { ... }
  }
}
```

### `guardrail marketplace list --json`

```json
{
  "schema_version": 1,
  "data": [
    { "id": "...", "version": "1.0.0", "channel": "verified", "author": "..." }
  ]
}
```

---

## 4. Event Families

All events belong to exactly one of five families:

| Family | Purpose |
|---|---|
| `execution` | Command/workflow/recipe run lifecycle, approval, drift, rollback, locking |
| `admin` | Configuration changes, deploy mode, key rotation, recipe lifecycle admin |
| `access` | Read queries, compliance exports, metrics reads, manifest reads |
| `policy` | Policy evaluation outcomes, RBAC checks, resource limit enforcement |
| `incident` | Abnormal activity, audit chain breaks, escalations |

---

## 5. Stability Guarantees for External Integrations

External consumers may safely depend on:

1. The versioned envelope shape `{ schema_version, data }` at v1.
2. The five event family names (strings will not change).
3. The registered event type strings listed in `src/event-schema.js`.
4. The audit entry fields listed in section 2.
5. The `data` payload shapes documented in section 3.

Any dependency on fields not listed here is at the consumer's own risk.

---

## 6. Bump Policy

When a breaking change is required:

1. Increment `SCHEMA_VERSION` in `src/event-schema.js`.
2. Update the envelope documentation in this file.
3. Update the affected surface's payload shape in section 3.
4. Add a migration note at the end of this file under "Version History".
5. Add or update tests in `tests/test-bucket6.js` or `tests/test-feature-acceptance.js`.

---

## Version History

| Version | Date | Change |
|---|---|---|
| 1 | 2026-04-14 | Initial stable contract: envelope + five families + four CLI surfaces |
