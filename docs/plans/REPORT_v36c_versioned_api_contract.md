# REPORT v36c — Versioned API Contract + JSON Envelope

**Status: COMPLETE**

## Objective

Close the external compatibility/documentation gap for Guardrail's admin/event read and export CLI surfaces by:

1. Adding a repo-local contract document (`docs/event-schema-v1.md`) declaring what fields are stable, what counts as a breaking change, and when `schema_version` must increment.
2. Wrapping the JSON output of relevant read/export CLI surfaces in a versioned envelope (`{ schema_version, data, … }`).
3. Adding focused tests for the new envelope shape.

---

## Surfaces Under Change

- [src/event-schema.js](/Users/adilevinshtein/Documents/dev/Guardian/src/event-schema.js)
  - added `wrapApiResponse(data)` returning `{ schema_version: SCHEMA_VERSION, data }`
- [src/cli.js](/Users/adilevinshtein/Documents/dev/Guardian/src/cli.js)
  - wrapped JSON output for:
    - `guardrail audit verify --json`
    - `guardrail audit query --json`
    - `guardrail metrics --json`
    - `guardrail export --format json`
    - `guardrail marketplace list --json`

---

## Contract Document

- [docs/event-schema-v1.md](/Users/adilevinshtein/Documents/dev/Guardian/docs/event-schema-v1.md)
- Documents:
  - stable top-level envelope shape `{ schema_version, data }`
  - additive vs breaking changes
  - schema bump policy
  - stable audit entry fields
  - externally supported payload shapes for the wrapped CLI surfaces

---

## Envelope Shape

All wrapped surfaces now return:

```json
{
  "schema_version": 1,
  "data": { ... }
}
```

or, for array payloads:

```json
{
  "schema_version": 1,
  "data": [ ... ]
}
```

---

## Tests

- [tests/test-bucket6.js](/Users/adilevinshtein/Documents/dev/Guardian/tests/test-bucket6.js)
  - `Versioned API response envelope (wrapApiResponse)` suite passes
- Direct CLI proofs in clean temp repos:
  - `guardrail audit query --json` returned `{ schema_version: 1, data: { chainValid, entries } }`
  - `guardrail metrics --json` returned `{ schema_version: 1, data: { totalEvents, ... } }`
  - `guardrail export --format json` returned `{ schema_version: 1, data: [ ... ] }`

---

## Result

Slice C is complete. Guardrail now has a documented v1 external contract and versioned JSON envelopes on the relevant read/export CLI surfaces needed for item 36.

---

## Status: COMPLETE
