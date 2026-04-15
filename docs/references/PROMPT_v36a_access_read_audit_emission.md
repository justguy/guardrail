# Guardrail Item 36 — Slice A: ACCESS_EVENTS Emission

Task:
- Work only on roadmap item `36` from `docs/technical-status.md`:
  `Versioned admin/event APIs and read-access auditing`
- This slice closes the read/export access-audit gap.

Declared report artifact:
- `docs/plans/REPORT_v36a_access_read_audit_emission.md`

Goal:
- Ensure read/export operations emit access-family audit events.
- Keep the change bounded to the existing read/export surfaces; do not broaden into unrelated roadmap work.

Primary repo surfaces:
- `src/cli.js`
- `src/audit.js`
- `src/compliance.js`
- `src/metrics.js`
- `src/event-schema.js`
- `tests/test-bucket3.js`
- `tests/test-bucket6.js`
- `tests/test-feature-acceptance.js`
- `docs/plans/REPORT_v36_admin_event_api_gap_inventory.md`

Required behavior:
1. `guardrail audit query` must append an `audit_queried` access event.
2. `guardrail export` must append a `compliance_exported` access event.
3. `guardrail metrics` must append a `metrics_read` access event.
4. Emitted entries must use the event schema v1 helpers so `schema_version: 1` and `family: "access"` are present.
5. The implementation must be honest about scope:
   - instrument all real call paths you touch
   - do not claim coverage for read paths you did not actually wire

Focused proof expectations:
- Add or update focused tests proving the three read/export commands emit the expected access events.
- Prefer the smallest existing test surfaces rather than creating a broad new suite.

Report requirements:
1. Create the report artifact immediately with `Status: STARTED`.
2. Record exactly which call sites were instrumented.
3. Record the focused tests you ran and their result.
4. End with either:
   - `Status: COMPLETE`
   - or `Status: NEEDS_REVIEW` with a precise blocker.

Constraints:
- Do not start slice B or C here.
- Do not do docs-only work.
- Do not rewrite unrelated CLI behavior.
