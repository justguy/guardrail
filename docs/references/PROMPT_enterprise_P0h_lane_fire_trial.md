# Guardrail Resident-Lane Fire Trial Prompt — P0h

Use this prompt with a Claude resident lane. This is the authoritative launch contract for the `P0h` fire-trial run.

Packet:
- `docs/plans/PLAN_enterprise_P0h_emergency_controls.md`

Declared report artifact:
- `docs/plans/REPORT_enterprise_P0h_emergency_controls.md`

Focused proof:
- `tests/test-claude-resident-lane.js`
- `tests/test-agent-session.js`
- `tests/test-agent-session-supervisor.js`
- `tests/test-bucket6.js`
- any focused acceptance coverage directly needed for lane/session controls

Expected scope:
- `src/cli.js`
- `src/resident-lane-core.js`
- `src/agent-session.js`
- `src/agent-session-lifecycle.js`
- `src/agent-session-enforce.js`
- `src/incident-hooks.js`
- `src/audit.js`
- `src/runtime-policy.js`
- focused tests directly needed for the packet
- `README.md`
- `docs/technical-status.md`
- `docs/plans/REPORT_enterprise_P0h_emergency_controls.md`

Hard stop boundary:
- Do not begin any later enterprise packets.
- Do not invent a hosted admin UI or org control plane.
- Do not reuse ordinary cleanup semantics as the only emergency path.

## Prompt

You are executing exactly one Guardrail packet through a resident lane.

Execution contract:
1. Work only on `P0h`. Do not start any later packet.
2. Create or update `docs/plans/REPORT_enterprise_P0h_emergency_controls.md` immediately before deep implementation.
3. Write `Status: STARTED`, the exact objective, intended proof, and immediate next step.
4. Keep the run conversational through this lane:
   - if you have a substantive question, ask it here instead of guessing
   - if you want review, say so explicitly
   - if you detect drift, risk, or blocked assumptions, report them immediately
5. After each meaningful phase, append a short checkpoint to the report:
   - what changed
   - what proof remains
   - whether operator input is needed
6. Add explicit revocation, break-glass, and kill-switch seams for current local execution surfaces, with distinct audited state transitions.
7. Make sure emergency controls are distinguishable from ordinary stop/cleanup behavior and actually prevent later reuse where appropriate.
8. Before claiming completion, run the focused proof listed above and record the exact results in the report.
9. Set the report to `Status: COMPLETE` only if the packet is actually closed.
10. If proof fails, scope widens, or you need a decision from the operator, set the report to `Status: NEEDS_REVIEW` and explain why.

Completion bar:
- declared report artifact exists
- focused proof has been run and recorded
- emergency controls are auditable and distinct from normal cleanup
- README and technical status are updated truthfully if behavior/roadmap changed
