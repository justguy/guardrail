# Guardrail Resident-Lane Fire Trial Prompt — P0f

Use this prompt with a Claude resident lane. This is the authoritative launch contract for the `P0f` fire-trial run.

Packet:
- `docs/plans/PLAN_enterprise_P0f_model_gateway_seam.md`

Declared report artifact:
- `docs/plans/REPORT_enterprise_P0f_model_gateway_seam.md`

Focused proof:
- `tests/test-adapter.js`
- `tests/test-adapter-runtime.js`
- `tests/test-claude-recipe.js`
- any focused acceptance coverage directly needed for adapter/AI paths

Expected scope:
- `src/adapter-engine.js`
- `src/adapter-profile.js`
- `src/adapter-cli.js`
- `src/human-domain-routing.js`
- `src/claude-exec-wrapper.js`
- `src/codex-exec-wrapper.js`
- focused tests directly needed for the packet
- `README.md`
- `docs/technical-status.md`
- `docs/plans/REPORT_enterprise_P0f_model_gateway_seam.md`

Hard stop boundary:
- Do not begin `P0g` or touch unrelated enterprise P0 packets.
- Do not invent a hosted model registry or BYOM packaging system.
- Do not leave provider/model routing duplicated across wrappers if you can move it behind one seam.

## Prompt

You are executing exactly one Guardrail packet through a resident lane.

Execution contract:
1. Work only on `P0f`. Do not start the next packet.
2. Create or update `docs/plans/REPORT_enterprise_P0f_model_gateway_seam.md` immediately before deep implementation.
3. Write `Status: STARTED`, the exact objective, intended proof, and immediate next step.
4. Keep the run conversational through this lane:
   - if you have a substantive question, ask it here instead of guessing
   - if you want review, say so explicitly
   - if you detect drift, risk, or blocked assumptions, report them immediately
5. After each meaningful phase, append a short checkpoint to the report:
   - what changed
   - what proof remains
   - whether operator input is needed
6. Add one model-gateway seam that owns provider/model/profile routing for Guardrail AI paths, even if the initial implementation still delegates to existing wrappers/adapters.
7. Move real call sites behind that seam; do not leave a fake pass-through with no decision point.
8. Before claiming completion, run the focused proof listed above and record the exact results in the report.
9. Set the report to `Status: COMPLETE` only if the packet is actually closed.
10. If proof fails, scope widens, or you need a decision from the operator, set the report to `Status: NEEDS_REVIEW` and explain why.

Completion bar:
- declared report artifact exists
- focused proof has been run and recorded
- model/provider routing resolves through one gateway seam
- README and technical status are updated truthfully if behavior/roadmap changed
