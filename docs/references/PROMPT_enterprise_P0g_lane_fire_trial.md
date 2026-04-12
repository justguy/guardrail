# Guardrail Resident-Lane Fire Trial Prompt — P0g

Use this prompt with a Claude resident lane. This is the authoritative launch contract for the `P0g` fire-trial run.

Packet:
- `docs/plans/PLAN_enterprise_P0g_pre_egress_scrubbing_and_classification_hooks.md`

Declared report artifact:
- `docs/plans/REPORT_enterprise_P0g_pre_egress_scrubbing_and_classification_hooks.md`

Focused proof:
- `tests/test-human-domain-routing.js`
- `tests/test-adapter-runtime.js`
- `tests/test-bucket5.js`
- any focused tests directly needed for classification/scrubbing hooks

Expected scope:
- `src/human-domain-routing.js`
- `src/adapter-engine.js`
- `src/policy.js`
- `src/org-policy.js`
- `src/audit.js`
- `src/compliance.js`
- focused tests directly needed for the packet
- `README.md`
- `docs/technical-status.md`
- `docs/plans/REPORT_enterprise_P0g_pre_egress_scrubbing_and_classification_hooks.md`

Hard stop boundary:
- Do not begin `P0h` or touch unrelated enterprise P0 packets.
- Do not claim a production-grade scrubber exists.
- Do not leak blocked/redacted payloads in audit or report output.

## Prompt

You are executing exactly one Guardrail packet through a resident lane.

Execution contract:
1. Work only on `P0g`. Do not start the next packet.
2. Create or update `docs/plans/REPORT_enterprise_P0g_pre_egress_scrubbing_and_classification_hooks.md` immediately before deep implementation.
3. Write `Status: STARTED`, the exact objective, intended proof, and immediate next step.
4. Keep the run conversational through this lane:
   - if you have a substantive question, ask it here instead of guessing
   - if you want review, say so explicitly
   - if you detect drift, risk, or blocked assumptions, report them immediately
5. After each meaningful phase, append a short checkpoint to the report:
   - what changed
   - what proof remains
   - whether operator input is needed
6. Add structured classification and pre-egress scrubbing hook points that can produce allow/block/redact outcomes with machine-readable reasons.
7. Record hook outcomes in audit/event output without leaking the blocked/redacted payload itself.
8. Before claiming completion, run the focused proof listed above and record the exact results in the report.
9. Set the report to `Status: COMPLETE` only if the packet is actually closed.
10. If proof fails, scope widens, or you need a decision from the operator, set the report to `Status: NEEDS_REVIEW` and explain why.

Completion bar:
- declared report artifact exists
- focused proof has been run and recorded
- hook outputs are structured and wired into code paths, not docs-only
- README and technical status are updated truthfully if behavior/roadmap changed
