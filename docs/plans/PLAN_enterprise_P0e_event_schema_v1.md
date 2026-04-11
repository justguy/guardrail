# Guardrail — Enterprise P0e Packet: Event Schema v1

Status: Ready  
Audience: Autonomous guarded implementation agent  
Goal: Freeze a versioned event vocabulary for execution, admin, access, policy, and incident events

Roadmap anchor: `P0` event spine; enterprise items `28` and `36`

## Declared Artifact

- `docs/plans/REPORT_enterprise_P0e_event_schema_v1.md`

## Scope

Define and document an event schema version that future SIEM, billing, admin API, and webhook integrations can rely on.

Must include:

- schema version field
- distinct event families for:
  - execution
  - admin/control
  - read/access/export
  - policy/authorization
  - incident/emergency
- tests/docs proving the distinctions

## Likely Files

- `src/audit.js`
- `src/metrics.js`
- `src/notifications.js`
- `src/incident-hooks.js`
- `src/compliance.js`
- `src/cli.js`

## Focused Tests

- `tests/test-bucket3.js`
- `tests/test-bucket5.js`
- `tests/test-bucket6.js`
- any acceptance coverage for audit/export/notifications

## Proof Of Done

- one event schema version is documented
- read/access events are distinct from execution events
- notifications/incidents consume the same event vocabulary rather than bespoke shapes
- report artifact exists and names the event families and fields

## Stop Conditions

Stop and fix before moving on if:

- events are still ad hoc per subsystem
- schema versioning is implied but not explicit
- access/read/export actions are not distinguishable in audit/event output
