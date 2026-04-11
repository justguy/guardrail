# Guardrail — Enterprise P0b Packet: Policy Simulation and Decision Traces

Status: Ready  
Audience: Autonomous guarded implementation agent  
Goal: Add explainable policy simulation and decision traces on top of the shared authorization seam

Roadmap anchor: `P0` central policy seam; enterprise item `29`

## Declared Artifact

- `docs/plans/REPORT_enterprise_P0b_policy_simulation_and_decision_traces.md`

## Scope

Add bounded simulation/explain surfaces so an operator can ask what a policy would decide without executing the action.

Must include:

- one simulation entry point
- one decision-trace format
- CLI or bounded API surface for simulation/explain
- tests that show allow/deny reasoning

Must not include:

- hosted admin UI
- Cedar/OPA backend integration

## Likely Files

- `src/policy.js`
- `src/org-policy.js`
- `src/rbac.js`
- `src/policy-engine.js`
- `src/cli.js`
- `src/audit.js`

## Focused Tests

- `tests/test-bucket5.js`
- `tests/test-bucket6.js`
- `tests/test-policy-scenarios.js`
- `tests/test-feature-acceptance.js` with any new simulation/explain coverage

## Proof Of Done

- simulation path returns the same normalized decision format as execution authorization
- decision traces identify which policy inputs/rules drove the result
- docs tell operators how to run simulation before rollout
- report artifact exists and names the exposed CLI/API surfaces

## Stop Conditions

Stop and fix before moving on if:

- simulation uses a different decision path than real authorization
- traces are free-form strings without structured fields
- allow/deny explanations differ between simulation and execution
