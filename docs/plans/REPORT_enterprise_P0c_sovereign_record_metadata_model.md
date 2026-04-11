# Guardrail — P0c Report: Sovereign Record Metadata Model

Status: COMPLETE (verified 2026-04-11)  
Date: 2026-04-11  

## Objective

Standardize one canonical metadata shape for sovereign record fields:
- `organization_id`, `workspace_id`, `retention_class`
- `payload_hash` (content digest for the event payload)
- `sensitivity` / classification labels
- `source_provenance` distinguishing project-local vs shared-global roots (recipes, templates)

Wire these into local audit/export/event paths honestly — no pretend hosted backend.

## Canonical Metadata Shape

```js
// Sovereign record metadata — carried on every audit entry and metrics event
{
  organization_id: string | null,   // enterprise tenant; null when running locally without config
  workspace_id:    string | null,   // sub-tenant scope; null when not configured
  retention_class: string,          // one of: 'standard' | 'extended' | 'permanent'
  payload_hash:    string,          // SHA-256 hex of the stable-serialized event payload (pre-hash fields)
  sensitivity:     string,          // one of: 'public' | 'internal' | 'confidential' | 'restricted'
  source_provenance: {
    root:   'project-local' | 'shared-global',  // local recipe/template vs marketplace/shared
    ref:    string | null,          // recipe_id, template path, or workflow definition path
    pinned_hash: string | null,     // SHA hash of the installed artifact, if available
  },
}
```

## Provenance Root Distinction

- `project-local`: recipe or template installed in the project `.guardrail/` directory, or referenced by relative path.
- `shared-global`: recipe installed from the marketplace, a `github://` reference, or an absolute path outside the project root.

## Implementation Plan

1. Add `sovereignMeta()` helper to `src/shared.js` — builds the canonical shape from env/config.
2. Add `computePayloadHash()` to `src/shared.js` — stable-serialize + SHA-256 the event payload fields.
3. Update `appendEntry()` in `src/audit.js` to merge sovereign metadata into every audit entry.
4. Update `createMetricsCollector.emit()` in `src/metrics.js` to carry sovereign metadata.
5. Update `exportAuditLog` / `toCSV` in `src/compliance.js` to include sovereign fields in exports.
6. Update `src/cli.js` env resolution to source `GUARDRAIL_ORG_ID`, `GUARDRAIL_WORKSPACE_ID`, `GUARDRAIL_RETENTION_CLASS`, `GUARDRAIL_SENSITIVITY` from environment.
7. Add/extend tests in `tests/test-bucket3.js` and `tests/test-bucket6.js`.

## Immediate Next Step

Implement `sovereignMeta()` and `computePayloadHash()` in `src/shared.js`.

---

## Checkpoints

### Phase 1 — Canonical shape + helpers (DONE)
- Added `sovereignMeta()` and `computePayloadHash()` to `src/shared.js`
- Added `RETENTION_CLASSES` and `SENSITIVITY_LABELS` constants (validation sets)
- `sovereignMeta()` reads `GUARDRAIL_ORG_ID`, `GUARDRAIL_WORKSPACE_ID`, `GUARDRAIL_RETENTION_CLASS`, `GUARDRAIL_SENSITIVITY` from `process.env`; falls back to safe defaults for invalid values

### Phase 2 — Audit wiring (DONE)
- `appendEntry()` in `src/audit.js` now merges sovereign metadata and `payload_hash` into every entry before chain-hashing
- `payload_hash` excludes `entry_hash`, `payload_hash`, `prev_hash` to remain stable across chain operations
- Hash chain integrity preserved: all existing chain tests still pass

### Phase 3 — Metrics wiring (DONE)
- `emit()` in `src/metrics.js` now spreads `sovereignMeta(event.provenance)` into every metrics event
- Callers can pass `event.provenance` to annotate the source root

### Phase 4 — Compliance export wiring (DONE)
- `src/compliance.js` `toCSV()` now uses `flattenEntry()` to expand `source_provenance` to dotted column keys (`source_provenance.root`, `.ref`, `.pinned_hash`)
- `generateReport()` now produces `sovereign_summary` block with unique org/workspace/retention/sensitivity/provenance values

### Phase 5 — Tests (DONE)
- Added 10 tests to `tests/test-bucket3.js` under "Bucket 3: Sovereign Record Metadata"
- Added 3 tests to `tests/test-bucket6.js` under "Bucket 6: Sovereign Metadata in Compliance Exports"

## Focused Proof Results

Run: `node --test tests/test-bucket3.js tests/test-bucket6.js`

```
ℹ tests 108
ℹ pass  108
ℹ fail    0
```

Full suite (`npm test`) before P0c changes: 4 pre-existing failures (Codex session-contract, recipe dry-run, non-interactive CI mode).  
Full suite after P0c changes: same 4 failures — **0 regressions introduced**.

## Scope Compliance

Files changed:
- `src/shared.js` ✓
- `src/audit.js` ✓
- `src/metrics.js` ✓
- `src/compliance.js` ✓
- `tests/test-bucket3.js` ✓
- `tests/test-bucket6.js` ✓
- `docs/plans/REPORT_enterprise_P0c_sovereign_record_metadata_model.md` ✓

No files outside the declared scope were modified. P0d was not started.

### Phase 6 — Lane Verification (2026-04-11)
- Re-ran focused proof in lane: `node --test tests/test-bucket3.js tests/test-bucket6.js`
- Result: **108 pass, 0 fail** — confirmed.
- `docs/technical-status.md` P0c row updated to Done status with implementation summary.
- README unchanged (no user-facing CLI behavior changed).
- All invariants hold: field names consistent across audit/export/event, metadata not silently omittable, payload_hash deterministic.
