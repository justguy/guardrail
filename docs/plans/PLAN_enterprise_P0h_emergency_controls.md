# Guardrail — Enterprise P0h Packet: Emergency Controls

Status: Ready  
Audience: Autonomous guarded implementation agent  
Goal: Add revocation, break-glass, and kill-switch seams for lanes, sessions, and future hosted actors

Roadmap anchor: `P0` emergency controls; enterprise item `30`

## Declared Artifact

- `docs/plans/REPORT_enterprise_P0h_emergency_controls.md`

## Scope

Add explicit emergency-control primitives rather than relying on ad hoc stop/cleanup behavior.

Must include:

- revocation state or API
- break-glass control path
- kill-switch concept for current local execution surfaces
- auditable emergency events

Must not include:

- full enterprise admin UI
- hosted org control plane

## Likely Files

- `src/cli.js`
- `src/resident-lane-core.js`
- `src/agent-session.js`
- `src/agent-session-lifecycle.js`
- `src/agent-session-enforce.js`
- `src/incident-hooks.js`
- `src/audit.js`
- `src/runtime-policy.js`

## Focused Tests

- `tests/test-claude-resident-lane.js`
- `tests/test-agent-session.js`
- `tests/test-agent-session-supervisor.js`
- `tests/test-bucket6.js`
- `tests/test-feature-acceptance.js` for lane/session controls

## Proof Of Done

- an active lane/session can be explicitly revoked or emergency-stopped through one auditable path
- docs distinguish ordinary stop/cleanup from emergency controls
- report artifact exists and names the commands/state transitions added

## Stop Conditions

Stop and fix before moving on if:

- emergency controls reuse normal cleanup paths without distinct audit/state
- revocation does not actually prevent later reuse
- the packet introduces a kill switch with no bounded scope definition
