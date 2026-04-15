# REPORT v36a — ACCESS_EVENTS Emission

**Status: COMPLETE**
**Date:** 2026-04-14
**Slice:** A — Read/export access-audit emission

## Objective

Ensure read/export operations emit access-family audit events:
1. `guardrail audit query` → `audit_queried`
2. `guardrail export` → `compliance_exported`
3. `guardrail metrics` → `metrics_read`

Each emitted entry must carry `schema_version: 1` and `family: "access"`.

## Instrumented Call Sites

- [src/cli.js](/Users/adilevinshtein/Documents/dev/Guardian/src/cli.js)
  - `metrics` now appends `metrics_read` after reading/formatting metrics output
  - `export` now appends `compliance_exported` after exporting audit log output
  - `audit-query` now appends `audit_queried` after running the filtered query

Each emitted entry flows through `appendEntry(...)`, so `schema_version: 1` and `family: "access"` are added by the event schema helpers.

## Tests

- [tests/test-bucket3.js](/Users/adilevinshtein/Documents/dev/Guardian/tests/test-bucket3.js)
  - helper-level access event coverage passes
- [tests/test-feature-acceptance.js](/Users/adilevinshtein/Documents/dev/Guardian/tests/test-feature-acceptance.js)
  - added CLI-level acceptance cases for:
    - `guardrail audit query --json`
    - `guardrail metrics`
    - `guardrail export`

Direct CLI proof run locally in clean temp repos:
- `guardrail audit query --json` appended `audit_queried` with `family: "access"` and `schema_version: 1`
- `guardrail metrics` appended `metrics_read` with `family: "access"` and `schema_version: 1`
- `guardrail export` appended `compliance_exported` with `family: "access"` and `schema_version: 1`

## Result

Slice A is complete. The read/export command surfaces now emit access-family audit entries on the real CLI path instead of only declaring the vocabulary in `event-schema.js`.
