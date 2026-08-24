# D0za Closeout Attempt

Status: COMPLETE

Date: 2026-04-14

## Objective

Stabilize resident Claude lane backend so Guardrail can reliably execute Claude turns on the host runtime and close `D0za`.

## Checkpoints

### [1] Inspection started
Reviewed the current wrapper patch set, lane plumbing, and focused tests.

### [2] Local patch review
Confirmed the active patch set includes:
- default submit sequence changed back to `\r\r`
- `Seasoning` added to the assistant-output/spinner heuristic
- explicit completion-mode threading in `src/cli.js`
- existing artifact/sentinel completion helpers still present and covered by tests

### [3] Focused tests re-run
Re-ran:
- `node --test tests/test-claude-prompt-wrapper.js`
- `node --test tests/test-claude-resident-lane.js`
- `node --test --test-name-pattern "Resident Lane Mode" tests/test-feature-acceptance.js`

All focused tests passed.

### [4] Initial proof failed
Ran one bounded host-runtime direct proof on lane `d0za-closeout-host` and observed the then-current failure shape:
- only the initial `started` checkpoint was written
- no second progress event appeared
- no result artifact appeared

That failure was preserved as the regression baseline.

### [5] Root cause isolated
The remaining regression was not the submit key itself. Claude Code `v2.1.108` can accept bracketed paste silently without rendering the old `Pasting text…` indicator, so the old submit-beacon-only path could leave the wrapper waiting indefinitely after paste.

The fix added two bounded fallback paths in the interactive Tcl wrapper:
- `startup_beacon_fallback`
- `submit_fallback`

These preserve the primary beacon-based path when Claude emits the expected UI markers, while still progressing when the TUI accepts paste silently.

### [6] Direct-turn proof passed
Ran a fresh host-runtime direct proof on lane `d0za-proof-final`:
- prompt: `Reply with exactly: PONG`
- result artifact: `.guardrail/lanes/d0za-proof-final/results/req-1776218427216-6zzvch.json`
- progress artifact: `.guardrail/lanes/d0za-proof-final/progress/req-1776218427216-6zzvch.ndjson`

Observed result:
- `v2.1.108`
- `⏺ PONG`
- progress reached `completed`
- wrapper exited `0`

### [7] Artifact/report proof passed
Ran a fresh host-runtime artifact proof on lane `d0za-artifact-proof-final`:
- declared report artifact: `.guardrail/d0za-artifact-proof-final-report.md`
- result artifact: `.guardrail/lanes/d0za-artifact-proof-final/results/req-1776219084623-lbiq78.json`
- progress artifact: `.guardrail/lanes/d0za-artifact-proof-final/progress/req-1776219084623-lbiq78.ndjson`

Observed result:
- progress reached `start`
- `Creating artifact report file`
- `ai_artifact_written`
- `completed`
- wrapper exited `0`
- declared report artifact was written with the requested content

## Findings

1. The interactive Claude backend is now proven again on the real host runtime for both:
   - tiny direct turns
   - bounded artifact/report turns
2. The remaining regression was the missing submit fallback after silent paste acceptance in newer Claude TUI versions.
3. The proven current submit path is `\r\r` with bounded fallback behavior, not `ESC[13u]`.
4. Public docs and tracker state now need to match that proven behavior.

## Exact blocker

No remaining blocker for the `D0za` closeout bar.

## Conclusion

`D0za` is now honestly closed.

Closeout bar satisfied:
1. focused wrapper/lane tests passed
2. one real host-runtime tiny direct turn completed
3. one real host-runtime bounded artifact/report turn completed
4. lane/progress/result surfaces reflected both proofs coherently
