# Guardrail — Enterprise P0c Packet: Sovereign Record Metadata Model

Status: Ready  
Audience: Autonomous guarded implementation agent  
Goal: Standardize sovereign record metadata so future hosted records carry enterprise identity and retention fields from day one

Roadmap anchor: `P0` sovereign record model; enterprise items `24` and `32`

## Declared Artifact

- `docs/plans/REPORT_enterprise_P0c_sovereign_record_metadata_model.md`

## Scope

Standardize metadata helpers and schema fields for:

- `organization_id`
- `workspace_id`
- `retention_class`
- payload hash
- sensitivity/classification labels

Wire these into local audit/export/event paths now where doing so is honest without pretending hosted persistence already exists.

## Likely Files

- `src/audit.js`
- `src/compliance.js`
- `src/metrics.js`
- `src/logger.js`
- `src/shared.js`
- `src/cli.js`

## Focused Tests

- `tests/test-bucket3.js`
- `tests/test-bucket6.js`
- any compliance/audit export tests already covering JSON/CSV output

## Proof Of Done

- the metadata fields have one documented canonical shape
- audit/export tests prove they round-trip
- payload hash behavior stays deterministic where required
- docs explain these as day-1 hosted record fields, not as a fake hosted backend

## Stop Conditions

Stop and fix before moving on if:

- field names differ across audit/export/event paths
- metadata can be omitted silently where the schema claims it should exist
- the change breaks hash stability without an explicit migration note
