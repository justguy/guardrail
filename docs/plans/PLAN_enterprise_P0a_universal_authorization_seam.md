# Guardrail — Enterprise P0a Packet: Universal Authorization Seam

Status: Ready  
Audience: Autonomous guarded implementation agent  
Goal: Add one shared `authorize(action, facts)` seam and route all execution surfaces through it before execution

Roadmap anchor: `P0` central policy seam; enterprise items `11`, `12`, and `29`

## Declared Artifact

Write this report before claiming success:

- `docs/plans/REPORT_enterprise_P0a_universal_authorization_seam.md`

## Scope

Build one policy decision boundary that all execution supervisors and lane/session lifecycle checks can call.

Must include:

- one shared authorization entry point
- one normalized policy result shape
- one normalized decision-trace shape
- wiring through command/workflow/template/recipe/adapter/lane entry surfaces

Must not include:

- Cedar or OPA integration
- hosted policy storage
- policy simulation UI/API beyond what is needed for the next packet

## Likely Files

- `src/policy.js`
- `src/org-policy.js`
- `src/rbac.js`
- `src/policy-engine.js`
- `src/cli.js`
- `src/recipe-supervisor.js`
- `src/workflow-supervisor.js`
- `src/template-supervisor.js`
- `src/adapter-engine.js`
- `src/resident-lane-core.js`

## Focused Tests

- `tests/test-bucket5.js`
- `tests/test-bucket6.js`
- `tests/test-integration-runtime.js`
- `tests/test-feature-acceptance.js` with any new authorization-facing coverage you add

## Proof Of Done

- every execution surface hits the same authorization seam
- denied decisions return one structured result shape
- the report artifact exists and names the exact wired call sites
- README and roadmap mention the shipped authorization seam

## Stop Conditions

Stop and fix before moving on if:

- any supervisor still calls disjoint policy/RBAC/org-policy logic directly for allow/deny
- different surfaces emit different authorization failure shapes
- tests prove bypass around the new seam
