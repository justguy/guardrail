# Guardrail Resident-Lane Fire Trial Prompt — P0d

Use this prompt with a Claude resident lane. This is the authoritative launch contract for the `P0d` fire-trial run.

Packet:
- `docs/plans/PLAN_enterprise_P0d_single_crypto_boundary.md`

Declared report artifact:
- `docs/plans/REPORT_enterprise_P0d_single_crypto_boundary.md`

Focused proof:
- `tests/test-bucket6.js`
- any key-management-specific tests directly affected by the packet

Expected scope:
- `src/key-management.js`
- `src/shared.js`
- `src/org-policy.js`
- `src/approval-queue.js`
- `src/shared-manifest.js`
- `src/compliance.js`
- focused tests directly needed for the packet
- `README.md`
- `docs/technical-status.md`
- `docs/plans/REPORT_enterprise_P0d_single_crypto_boundary.md`

Hard stop boundary:
- Do not begin `P0e` or touch unrelated enterprise P0 packets.
- Do not add KMS/Vault integration.
- Do not pretend dynamic secret brokering exists.

## Prompt

You are executing exactly one Guardrail packet through a resident lane.

Execution contract:
1. Work only on `P0d`. Do not start the next packet.
2. Create or update `docs/plans/REPORT_enterprise_P0d_single_crypto_boundary.md` immediately before deep implementation.
3. Write `Status: STARTED`, the exact objective, intended proof, and immediate next step.
4. Keep the run conversational through this lane:
   - if you have a substantive question, ask it here instead of guessing
   - if you want review, say so explicitly
   - if you detect drift, risk, or blocked assumptions, report them immediately
5. After each meaningful phase, append a short checkpoint to the report:
   - what changed
   - what proof remains
   - whether operator input is needed
6. Audit sensitive-at-rest writes and consolidate covered writes behind one documented encrypt/decrypt boundary.
7. Explicitly list covered paths and intentionally deferred exceptions in the report.
8. Before claiming completion, run the focused proof listed above and record the exact results in the report.
9. Set the report to `Status: COMPLETE` only if the packet is actually closed.
10. If proof fails, scope widens, or you need a decision from the operator, set the report to `Status: NEEDS_REVIEW` and explain why.

Completion bar:
- declared report artifact exists
- focused proof has been run and recorded
- scope stayed inside the expected file set
- README and technical status are updated truthfully if behavior/roadmap changed
