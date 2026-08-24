# Guardrail Resident-Lane Fire Trial Prompt Template

Purpose: reusable prompt contract for Guardrail-supervised Claude runs that must stay conversational, reviewable, and packet-bounded through the resident FIFO lane instead of a one-shot wrapper.

Use this template with:

- `guardrail lane start --tool claude --permission-mode acceptEdits ...`

If the packet must also run local proof commands autonomously, prefer:

- `guardrail lane start --tool claude --permission-mode dontAsk --allowed-tools "Bash Read Edit Write Glob Grep" ...`
- `guardrail lane chat --id <lane-id> --prompt "<filled template>"`
- later `guardrail lane send` follow-ups for review, correction, answers, and continuation

## Fill-Ins

- `{{PACKET_PLAN}}`: exact packet plan path
- `{{REPORT_ARTIFACT}}`: exact report path Claude must maintain
- `{{FOCUSED_TESTS}}`: exact test command(s) or test names
- `{{TARGET_FILES}}`: expected file set / scope
- `{{STOP_BOUNDARY}}`: explicit out-of-scope warning

## Prompt

You are executing exactly one Guardrail packet through a resident lane.

Packet:
- `{{PACKET_PLAN}}`

Declared report artifact:
- `{{REPORT_ARTIFACT}}`

Focused proof:
- `{{FOCUSED_TESTS}}`

Expected scope:
- `{{TARGET_FILES}}`

Hard stop boundary:
- `{{STOP_BOUNDARY}}`

Execution contract:
1. Work only on this packet. Do not start the next packet.
2. Create or update `{{REPORT_ARTIFACT}}` immediately before deep implementation.
3. Write `Status: STARTED`, the exact objective, intended proof, and immediate next step.
4. Keep the run conversational through this lane:
   - if you have a substantive question, ask it in the lane instead of guessing
   - if you want review, say so explicitly
   - if you detect drift, risk, or blocked assumptions, report them immediately
5. After each meaningful phase, append a short checkpoint to the report:
   - what changed
   - what proof remains
   - whether operator input is needed
6. If you finish implementation, run the focused proof, record the exact results, and then update the report to `Status: COMPLETE` only if the packet is actually closed.
7. If proof fails or scope widens, set the report to `Status: NEEDS_REVIEW` and explain why.
8. Do not silently stop. If you are waiting on review/input, say so in the lane and in the report.

Progress/reporting contract:
- the lane conversation is the live operator channel
- the report artifact is the durable audit artifact
- if the two disagree, call that out explicitly

Completion bar:
- declared report artifact exists
- focused proof has been run and recorded
- scope stayed inside `{{TARGET_FILES}}`
- any docs that changed are updated truthfully
