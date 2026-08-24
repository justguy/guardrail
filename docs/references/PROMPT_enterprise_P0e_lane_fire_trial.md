# Guardrail Resident-Lane Fire Trial Prompt — P0e

Use this prompt with a Claude resident lane. This is the authoritative launch contract for the `P0e` fire-trial run.

Packet:
- `docs/plans/PLAN_enterprise_P0e_event_schema_v1.md`

Declared report artifact:
- `docs/plans/REPORT_enterprise_P0e_event_schema_v1.md`

Focused proof:
- `tests/test-bucket3.js`
- `tests/test-bucket5.js`
- `tests/test-bucket6.js`
- any acceptance coverage directly needed for audit/export/notifications

Expected scope:
- `src/audit.js`
- `src/metrics.js`
- `src/notifications.js`
- `src/incident-hooks.js`
- `src/compliance.js`
- `src/cli.js`
- focused tests directly needed for the packet
- `README.md`
- `docs/technical-status.md`
- `docs/plans/REPORT_enterprise_P0e_event_schema_v1.md`

Hard stop boundary:
- Do not begin `P0f` or touch unrelated enterprise P0 packets.
- Do not invent a hosted event bus or external SIEM backend.
- Do not leave event families implicit or inconsistent across subsystems.

## Prompt

You are executing exactly one Guardrail packet through a resident lane.

Execution contract:
1. Work only on `P0e`. Do not start the next packet.
2. Create or update `docs/plans/REPORT_enterprise_P0e_event_schema_v1.md` immediately before deep implementation.
3. Write `Status: STARTED`, the exact objective, intended proof, and immediate next step.
4. Keep the run conversational through this lane:
   - if you have a substantive question, ask it here instead of guessing
   - if you want review, say so explicitly
   - if you detect drift, risk, or blocked assumptions, report them immediately
5. After each meaningful phase, append a short checkpoint to the report:
   - what changed
   - what proof remains
   - whether operator input is needed
6. Freeze one explicit event schema version and one event vocabulary for:
   - execution
   - admin/control
   - read/access/export
   - policy/authorization
   - incident/emergency
7. Wire notifications/incidents/compliance/audit surfaces to that shared event vocabulary without claiming external integrations exist.
8. Before claiming completion, run the focused proof listed above and record the exact results in the report.
9. Set the report to `Status: COMPLETE` only if the packet is actually closed.
10. If proof fails, scope widens, or you need a decision from the operator, set the report to `Status: NEEDS_REVIEW` and explain why.

Completion bar:
- declared report artifact exists
- focused proof has been run and recorded
- event families are explicit and versioned
- README and technical status are updated truthfully if behavior/roadmap changed
