# Guardrail Resident-Lane Fire Trial Prompt — P0b

Use this prompt with a Claude resident lane. This is the authoritative launch contract for the `P0b` fire-trial run.

Packet:
- `docs/plans/PLAN_enterprise_P0b_policy_simulation_and_decision_traces.md`

Declared report artifact:
- `docs/plans/REPORT_enterprise_P0b_policy_simulation_and_decision_traces.md`

Focused proof:
- `tests/test-policy-scenarios.js`
- `tests/test-feature-acceptance.js` with the `policy simulate CLI surface` coverage

Expected scope:
- `src/policy-simulate.js`
- `src/cli.js`
- `tests/test-policy-scenarios.js`
- `tests/test-feature-acceptance.js`
- `README.md`
- `docs/technical-status.md`
- `docs/plans/REPORT_enterprise_P0b_policy_simulation_and_decision_traces.md`

Hard stop boundary:
- Do not begin `P0c` or touch unrelated enterprise P0 packets.
- Do not add hosted UI, Cedar/OPA integration, or broad refactors outside the simulation/decision-trace seam.

## Prompt

You are executing exactly one Guardrail packet through a resident Claude lane.

Execution contract:
1. Work only on `P0b`. Do not start the next packet.
2. Resume from the current repo state if partial `P0b` work already exists.
3. Create or update `docs/plans/REPORT_enterprise_P0b_policy_simulation_and_decision_traces.md` immediately before deep implementation.
4. Write `Status: STARTED`, the exact objective, intended proof, and immediate next step.
5. Keep the run conversational through this lane:
   - if you have a substantive question, ask it here instead of guessing
   - if you want review, say so explicitly
   - if you detect drift, risk, or blocked assumptions, report them immediately
6. After each meaningful phase, append a short checkpoint to the report:
   - what changed
   - what proof remains
   - whether operator input is needed
7. Before claiming completion, run the focused proof listed above and record the exact results in the report.
8. Set the report to `Status: COMPLETE` only if the packet is actually closed.
9. If proof fails, scope widens, or you need a decision from the operator, set the report to `Status: NEEDS_REVIEW` and explain why.
10. Do not silently stop. If you are waiting on review/input, say so in this lane and in the report.

Completion bar:
- declared report artifact exists
- focused proof has been run and recorded
- scope stayed inside the expected file set
- README and technical status are updated truthfully if behavior/roadmap changed
