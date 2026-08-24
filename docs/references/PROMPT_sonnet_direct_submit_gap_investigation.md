# Sonnet Direct Investigation Prompt — Claude TUI Submit Gap

You are diagnosing a Claude interactive TUI submit bug in the Guardian repo.

Stay focused on diagnosis. Do not implement code changes yet.
Do not suggest switching back to `claude --print` one-shot.
Do not suggest bypassing Guardrail.
This is specifically about the resident-lane interactive prompt-wrapper backend.

Current state:
- Guardrail resident lanes, auth preflight, repo-local lane state, and session rotation are already working well enough.
- The active remaining blocker is Claude interactive submit semantics.
- We now have both inbound PTY logs and outbound send logs from the wrapper.

What is already proven:
1. The wrapper reaches Claude’s real interactive TUI.
2. Readiness detection works well enough to hit the input area.
3. Prompt delivery works as one atomic bracketed paste.
4. The outbound send log confirms the wrapper sent:
   - bracketed paste start
   - full prompt body
   - bracketed paste end
   - then a bare newline submit (`0a`)
5. Claude’s inbound PTY output after that still only shows:
   - `Pasting text...`
   - `[Pasted text #1 +63 lines]`
   - then UI repaint back to the prompt/status line
   - no processing marker
   - no model output
   - no report artifact
6. Earlier tested submit sequences also failed:
   - single `\r`
   - double `\r`
   - `Esc+Enter`

Additional bug already exposed:
- `lane run-sequence` previously treated a wrapper-side Tcl failure as `ok: true` because it accepted startup output + exit code 0 as success even though the packet never ran. That is a separate supervision bug, not the main TUI submit bug.

Your task:
1. Read the current wrapper and forensic logs.
2. Explain the most likely reason Claude treats the atomic paste as buffered text instead of a submitted turn.
3. Distinguish clearly between:
   - terminal key semantics
   - bracketed paste semantics
   - Claude TUI/Ink-style input handling
   - wrapper delivery mistakes
4. Decide what the next single best experiment is.
5. Also state whether the separate `run-sequence` success criteria bug should be fixed before or after the TUI submit bug.

Files/artifacts to inspect:
- `src/claude-prompt-wrapper.js`
- `tests/test-claude-prompt-wrapper.js`
- `.guardrail/debug/p0h-atomic-singlenl-send.log`
- `.guardrail/debug/p0h-atomic-singlenl-hex.log`
- `docs/plans/REPORT_claude_tui_paste_submit_semantics.md`
- `docs/plans/REPORT_p0h_interactive_startup_hang_debug.md`

Questions the report must answer:
- Given the exact outbound bytes, what does Claude likely expect instead of `0a`, `0d`, `0d0d`, or `Esc+Enter`?
- Is the bracketed paste envelope itself causing Claude to enter a “paste acknowledged but not submitted” state?
- Does the UI string `Press return to submit` likely refer to a terminal event different from the bytes we are sending?
- Is the next best move:
  - another targeted key-sequence probe, or
  - bundle/source inspection of the installed Claude binary for the actual submit binding?
- Should Guardrail fix the `run-sequence` false-success bug immediately in parallel, or keep it separate until the submit issue is solved?

Output:
- write findings to `docs/plans/REPORT_claude_tui_submit_diagnosis_from_send_receive_logs_direct.md`
- rank likely causes with confidence levels
- recommend exactly one next experiment
- recommend whether to fix the `run-sequence` false-success bug now or later
- keep it concrete and technical
