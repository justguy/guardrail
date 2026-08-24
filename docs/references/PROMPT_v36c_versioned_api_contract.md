# Guardrail Item 36 — Slice C: Versioned API Contract + JSON Envelope

Task:
- Work only on roadmap item `36` from `docs/technical-status.md`:
  `Versioned admin/event APIs and read-access auditing`
- This slice closes the external compatibility/documentation gap.

Declared report artifact:
- `docs/plans/REPORT_v36c_versioned_api_contract.md`

Goal:
- Add a concrete versioned event/API contract document.
- Version the JSON response envelope for the relevant read/export surfaces so external consumers can branch on it.

Primary repo surfaces:
- `src/cli.js`
- `src/event-schema.js`
- `docs/technical-status.md`
- `README.md`
- `tests/test-feature-acceptance.js`
- `tests/test-bucket6.js`
- `docs/plans/REPORT_v36_admin_event_api_gap_inventory.md`

Required behavior:
1. Add a repo-local contract document for event/API stability, for example `docs/event-schema-v1.md`.
2. Document:
   - what fields are stable
   - what counts as a breaking change
   - when `schema_version` must change
   - what external integrations can depend on
3. Wrap the JSON output of the relevant read/export CLI surfaces in a versioned envelope, not a raw bare payload.
4. Keep the envelope change narrow and explicit.
5. Update focused tests to prove the new JSON shape.

Focused proof expectations:
- Add or update focused tests for the new JSON response envelope.
- Keep the proof bounded to the surfaces you changed.

Report requirements:
1. Create the report artifact immediately with `Status: STARTED`.
2. Record which CLI surfaces were wrapped and their new response shape.
3. Record the contract document path and the bump policy you documented.
4. End with either:
   - `Status: COMPLETE`
   - or `Status: NEEDS_REVIEW` with a precise blocker.

Constraints:
- Do not reopen slices A or B unless a tiny supporting edit is strictly required.
- Do not add a broad schema framework or hosted API layer.
