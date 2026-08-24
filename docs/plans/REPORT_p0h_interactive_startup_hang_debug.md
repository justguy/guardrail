# P0h Interactive Claude Resident Lane — Startup Hang Debug Report

Date: 2026-04-12
Scope: Resident Claude lane + interactive prompt-wrapper path only. One-shot / `claude --print` explicitly out of scope.

## Observed symptoms

- Fresh resident lane boots; auth preflight green.
- P0h request is accepted; wrapper subprocess spawned.
- Progress file contains exactly one line: `ai_checkpoint / phase=started / "Claude interactive subprocess is starting"`.
- No later checkpoint, no `ai_artifact_written`, no failure, no exit.
- Report artifact `docs/plans/REPORT_enterprise_P0h_emergency_controls.md` is never created.
- Lane request never resolves → the outer daemon is parked in `runLaneRequest` awaiting wrapper close.

## Where the hang lives (ranked)

### 1. Expect wrapper never reaches its quiet-exit branch (confidence: HIGH, ~0.8)

File: `src/claude-prompt-wrapper.js:347-422` (`runClaudeInteractive`).

The expect script is structurally:

```
set timeout 2.5s    # QUIET_EXIT_MS
expect {
  timeout { send "/exit\r"; bump timeout to ~302s; exp_continue }
  eof     { exit $code }
  -re ".+" { exp_continue }     # <-- any byte of PTY output resets the 2.5s timer
}
```

Claude Code's interactive mode is an Ink/TUI renderer. Even at idle it emits
continuous output (spinner frames, cursor blink, status bar, streamed tokens
during model/tool calls). Every frame matches `.+` → `exp_continue` restarts
the 2.5s timer. **Result: the `timeout` branch is never reached, `/exit` is
never sent, and there is no outer wall-clock cap in the expect script**
(`HARD_TIMEOUT_MS = 5 min` is only armed *after* the first `/exit`, via
`set timeout ${hardExitSeconds}` inside the `timeout` branch). The Node
parent also has no kill-timer around `runClaudeInteractive`. So the wrapper
hangs indefinitely, matching the observed "nothing after `started`".

This single issue is sufficient to explain every symptom. It is also the
weakest link architecturally: a 2.5s quiet-output gate is incompatible with
any TUI that animates.

### 2. Prompt is almost certainly not being submitted (confidence: MEDIUM-HIGH, ~0.65)

`buildClaudeArgs` (`claude-prompt-wrapper.js:263-279`) appends
`options.promptPayload` as a **trailing positional arg** to an interactive
`claude` invocation (no `--print`, no `-p`). In Claude Code's interactive
TUI, a positional prompt is treated as pre-filled input buffer contents, not
as an auto-submitted message (auto-submit behavior is tied to `--print` /
non-interactive mode). The wrapper never sends a literal `\r` or newline to
the PTY to commit the prompt — the only `send` in the script is `/exit`,
only on quiet timeout.

Consequence: even if (1) were fixed, Claude would sit at its TUI with the
prompt typed into the box and no actual inference running → no tool calls,
no progress checkpoints, no report artifact. This is consistent with "only
the `started` event ever appears": checkpoints after `started` come from the
model itself obeying the progress contract in the system appendix, and the
model never sees the message.

### 3. Progress ingestion side is healthy (confidence: HIGH, ~0.8)

`spawnClaudeWrapper` in `claude-resident-lane.js:598-641` line-buffers stderr
and routes `[guardrail-ai-progress]` lines through `parseAiProgressLine` to
lane hooks. It is not the bottleneck: wrapper stderr currently only emits
the initial `started` line, and the lane record reflects exactly that —
ingestion is faithfully reporting nothing-happened, not dropping events.

### 4. Session / bootstrap contract (confidence: LOW, ~0.1 that this is the
live cause)

Session-id reuse is already patched; `runtimeSessionId` is freshly randomized
on `continue` (`claude-resident-lane.js:749`). `ensureClaudeProjectBridge`
runs before spawn. No error is raised. Session layer is not the current
blocker.

### 5. Claude CLI startup/TTY contract (confidence: LOW, ~0.1)

Expect provides a real PTY to `claude`, so TTY detection succeeds. If TTY
contract were the issue we would expect an early error or immediate EOF, not
a silent hang. Ruled down but not fully out until (1)+(2) are addressed.

## Answers to the required questions

- **Is Claude actually receiving the prompt content?** It receives it as an
  argv token, but almost certainly does not *submit* it — interactive mode
  treats a positional prompt as pre-fill; no `\r` is ever sent on the PTY.
- **Is the expect/PTY wrapper waiting in a way that prevents submission or
  tool execution?** Yes. The `-re ".+" exp_continue` branch plus a 2.5s
  quiet-output timeout means TUI animation frames permanently starve the
  timeout branch. No `send`-submit path exists at all.
- **Is `/exit` sent too late / too early / not relevant?** Not relevant in
  the current failure mode: `/exit` is only ever sent from the `timeout`
  branch, which is unreachable under a live TUI. In the "fixed quiet gate"
  future, it would fire *during normal work* whenever the model pauses —
  too early.
- **Claude CLI issue or Guardrail wrapper issue?** Guardrail wrapper issue.
  Specifically: prompt-delivery semantics + quiet-exit design.
- **Exact next experiment:** see below.

## Recommended next experiment (single, decisive)

Run the wrapper's exact expect invocation manually, *without* sending the
prompt as a positional arg, and observe what happens when we explicitly
commit via newline:

```sh
expect -c '
  log_user 1
  spawn -noecho claude --model sonnet --session-id TEST-$(uuidgen)
  # wait for the TUI to render its input prompt
  expect -re "to quit" { }
  sleep 1
  send -- "emit a guardrail progress checkpoint then /exit\r"
  expect eof
'
```

What it proves:
- If Claude starts emitting tokens after the `\r`, it confirms interactive
  positional-prompt is *not* auto-submitted → fix #2 is required.
- If it starts emitting tokens but `expect eof` hangs, it confirms the
  quiet-exit gate is unreachable under TUI animation → fix #1 is required.
- Both will almost certainly reproduce. Run once; do not iterate blindly.

## Recommended minimal fix (if both confirm)

Do **not** abandon the interactive wrapper path. Two small, bounded changes:

1. **Commit the prompt explicitly.** Stop passing the prompt as a positional
   CLI arg. Instead, after `spawn -noecho claude ...` (no prompt token),
   wait for a render marker (e.g. the input-prompt banner), then `send --
   "${promptPayload}\r"`. Keeps the resident interactive lane intact and
   gets real submission semantics.

2. **Replace the quiet-output exit heuristic with an explicit completion
   sentinel.** The progress contract already tells the model to emit
   `ai_artifact_written` / `ai_checkpoint phase="completed"` NDJSON. Have
   the wrapper tail the progress file (it already knows its path — see
   `tailProgressFile` at line 209) and treat a terminal-phase event as the
   signal to `send "/exit\r"`. Keep `HARD_TIMEOUT_MS` as the outer
   wall-clock cap and arm it from the top of `runClaudeInteractive`, not
   only after the first `/exit`. The `-re ".+" exp_continue` branch should
   be removed entirely — it exists only to feed the broken quiet-gate.

Both changes are local to `claude-prompt-wrapper.js`; no lane-core or
session changes required. Re-run the P0h trial after.

## Reflect

- Assumption A: Claude Code positional-prompt in interactive mode is
  pre-fill, not auto-submit. (Testable with experiment above.)
- Assumption B: Claude Code TUI emits continuous output during idle/work.
  (Testable with experiment above.)
- Weakest link: assumption A. If positional prompts *do* auto-submit on a
  recent CLI version, issue #2 collapses and only the quiet-gate fix is
  needed — but the hang would still reproduce because of issue #1.
- Confidence that (1) is in the causal chain: 0.8. That (2) is also in the
  chain: 0.65. That fixing both unblocks P0h end-to-end: 0.7.
