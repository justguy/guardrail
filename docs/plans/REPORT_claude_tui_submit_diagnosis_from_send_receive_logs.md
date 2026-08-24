# Claude TUI Submit Diagnosis — From Send/Receive PTY Logs

## SUPERSEDED — 2026-04-14

The hypothesis in this report (`ESC[13u]` is the correct submit key) was tested and **reverted**.

Current code default: `POST_PASTE_SUBMIT_SEQUENCE = '\r\r'` (two raw CR bytes).

Rationale: `\r\r` is the only empirically proven submit path (d0za-direct-receive7, 2026-04-13).
`ESC[13u]` was set as the default in commit 28cc5b2 but caused all live direct turns to stall at
"Claude interactive subprocess is starting". It was reverted before any successful live proof run
was completed. The kitty keyboard protocol analysis below remains accurate as a theoretical model
but the recommended "next single experiment" (`ESC[13u]` probe) was not the unblocking fix.

The remaining open question is why the current code no longer gets past the startup beacon even
with `\r\r` restored — that is a separate regression, not covered by this report.

---


Date: 2026-04-12
Source: `.guardrail/debug/p0h-atomic-singlenl-send.log`, `.guardrail/debug/p0h-atomic-singlenl-hex.log`

---

## What the logs prove

### Send side (confirmed, not inferred)

```
stdin: ESC[200~          ← bracketed paste start
stdin: <63-line prompt body with \n line breaks>
stdin: ESC[201~          ← bracketed paste end
stdin: 0a                ← LF, the submit attempt
```

Delivery is correct: the envelope is properly wrapped, the body is intact.
The submit byte was `0a` (LF, 0x0a), not `0d` (CR).

### Receive side (confirmed, not inferred)

Line 2 of stdout — Claude's first mode negotiation on startup:

```
CSI ?2004h    enable bracketed paste mode
CSI ?1004h    enable focus reporting
CSI ?2031h    SGR pixel mouse mode
CSI >1u       KITTY KEYBOARD PROTOCOL — push with flag=1 (disambiguate escape codes)
CSI >4;2m     extended mouse mode
```

Line 14 of stdout — immediately after paste acknowledgement:

```
CSI <u        KITTY KEYBOARD PROTOCOL — pop (restore prior state)
CSI >1u       KITTY KEYBOARD PROTOCOL — push flag=1 again
CSI >4;2m     extended mouse mode
```

Line 15 of stdout — eventually:

```
/exit CR ...  wrapper quiet-timeout fired; /exit sent by expect script
```

---

## Root cause (confidence: 0.80)

**Claude Code enables the kitty keyboard protocol (`CSI >1u`, flag=1) on startup.**

Under kitty keyboard protocol with flag=1 (disambiguate escape codes), the Enter key is encoded as:

```
ESC[13u    (0x1b 0x5b 0x31 0x33 0x75)
```

not as `0d` (CR) and not as `0a` (LF).

Every submit sequence that was tested maps to legacy terminal encoding:

| Tested | Encoding | Status under kitty protocol |
|--------|----------|-----------------------------|
| `0a`   | LF       | not Enter                   |
| `0d`   | CR       | ambiguous; flag=1 may not accept |
| `0d0d` | CR CR    | still CR                    |
| `ESC+Enter` | `1b 0d` | ESC followed by CR, not Enter |

None of them are `ESC[13u]. That is why all experiments failed identically.

### Why the pop/re-push on line 14 matters

Line 14 (`CSI <u`, `CSI >1u`) shows Claude popping and immediately re-pushing the kitty keyboard state. This sequence fires right after the paste is acknowledged and the `0a` arrives on stdin. Two interpretations:

- **Interpretation A (more likely):** This is Claude's normal UI re-render cycle after paste, restoring keyboard modes after a paint pass. The timing is coincidence; the mode cycle happens regardless of what submit byte we sent.
- **Interpretation B:** Claude's input handler received `0a`, did not recognize it as a valid key in kitty mode, and reset its keyboard state. This would further confirm kitty mismatch.

Either way, the line 14 sequence does not indicate Claude accepted or processed our `0a` as submit.

---

## Ranked causes

### 1. Kitty keyboard protocol mismatch — `ESC[13u` not sent (confidence: 0.80)

**What:** Claude enables `CSI >1u` (kitty, flag=1) on startup. Under this protocol the Enter key encodes as `ESC[13u`. The wrapper sent `0a` instead.

**Why not definitively 0.95:** The kitty spec says flag=1 (disambiguate only) should still accept legacy `\r` for backward compatibility. Whether Claude's Ink input component has implemented that backwards-compat path is unknown without reading source. If it has, then `0d` (which was also tested and failed) would rule kitty out as the sole cause — but `0d` alone without a bracketed paste envelope was the first test; `0d` inside/after the envelope might behave differently.

**Falsification:** Send bracketed paste + 150ms delay + `ESC[13u`. If Claude begins processing → confirmed. If not → kitty protocol is not the sole cause.

### 2. Submit byte arrives before Ink's paste-state commit (confidence: 0.55)

**What:** The paste body is 63 lines. Ink/React batches state updates. The `ESC[201~` closes the envelope, then `0a` is sent in the same write (no visible delay in the log). If the Enter byte arrives at Claude's input handler before the paste value has been committed to React state, it processes Enter against an empty or transitional input buffer — a no-op.

**Why this matters even if cause #1 is fixed:** Even with `ESC[13u]`, sending it with zero delay after `ESC[201~]` may race the state commit. The 100-150ms delay is a necessary companion fix.

**Falsification:** Bracketed paste + 150ms delay + `ESC[13u]`. If it works, both the key encoding AND the delay were contributing. Can isolate by then removing the delay.

### 3. Prompt passed as positional arg AND as paste — double-delivery (confidence: 0.25)

**What:** `buildClaudeArgs` in `claude-prompt-wrapper.js` (line 277) appends the prompt as a positional arg to `claude`. If the current wrapper still passes the prompt as a positional arg AND also pastes it, Claude's input buffer would contain the text twice. The UI might render the positional-arg version pre-submitted and the paste as a second pending entry.

**Evidence against this:** The receive log shows "Pasting text…" and "[Pasted text #1 +63 lines]" — exactly one paste. If the positional arg were also contributing, we would expect a second UI render or immediate execution on startup.

**Falsification:** Remove the positional arg from `buildClaudeArgs` (or verify the current wrapper already does this). Check whether `/exit` arrives sooner in the log, which would indicate the first turn auto-executed.

---

## Answers to required questions

**Given the exact outbound bytes, what does Claude likely expect instead of `0a`, `0d`, `0d0d`, `ESC+Enter`?**

`ESC[13u` (0x1b 0x5b 0x31 0x33 0x75) — the kitty keyboard protocol encoding of Enter. None of the tested sequences are this.

**Is the bracketed paste envelope causing "paste acknowledged but not submitted" state?**

The envelope itself is not the blocker — it is working correctly (Claude renders "Pasting text…" and "[Pasted text #1 +63 lines]"). The blocker is that after the paste is acknowledged, the submit keystroke that follows is not recognized. The paste creates no special "pending" UX state that requires a non-Enter action; it lands in the input buffer and waits for normal submit.

**Does "Press return to submit" refer to a terminal event different from the bytes we send?**

Yes, concretely: when a real user presses Return on a keyboard connected to a terminal that has kitty protocol enabled (`CSI >1u`), the terminal sends `ESC[13u` to the application. When our wrapper sends `0d` or `0a` from `expect`, we bypass the terminal's kitty encoding and deliver raw legacy bytes directly to Claude's stdin. Claude's Ink input handler, operating in kitty mode, sees these raw bytes and does not map them to Enter.

**Is the next best move another key-sequence probe, or source inspection?**

**Another targeted probe** — specifically `ESC[13u]` — is the right next move. Reading the installed Claude binary source is the fallback if `ESC[13u]` also fails. The reasoning:

1. The escape sequence evidence is already strong enough to justify one more experiment.
2. The installed Claude binary (`@anthropic-ai/claude-code`) is a bundled package; finding the exact Ink input handler and its `useInput` keybinding for submit requires locating the minified/bundled JS, which takes longer than running the probe.
3. If `ESC[13u]` works, source inspection is unnecessary. If it fails, source inspection becomes mandatory and the scope narrows to exactly the key-event dispatch path.

---

## Next single experiment

**Send bracketed paste + 150ms delay + `ESC[13u]`:**

```
write ESC[200~
write <prompt body with \n separators, no \r>
write ESC[201~
sleep 150ms
write ESC[13u      (bytes: 1b 5b 31 33 75)
wait for processing marker (spinner / "Thinking" / first streamed token)
timeout: 30s
```

If a processing marker appears within 30s → root cause confirmed, both the key encoding (`ESC[13u]`) and the delay are required.

Then: run the experiment again without the 150ms delay to isolate whether timing is also a factor.

---

## run-sequence false-success bug: fix NOW, in parallel

Fix it immediately, before the next submit experiment. Reason:

1. **Every experiment currently produces ambiguous signal.** The lane marks `ok: true` on wrapper exit code 0 even when the packet never ran. After fixing the submit bug, the first successful run could be misread as "already works" or an actual success could be missed under the next edge case.
2. **The fix is bounded and isolated.** It touches only the success-criteria check in `run-sequence`; it doesn't touch the PTY path, the expect script, or the wrapper delivery logic. There is no risk of introducing a regression in the active submit investigation.
3. **Signal integrity is load-bearing.** Each subsequent experiment depends on interpreting lane output. Without the fix, a "Claude ran but produced no artifact" and a "Claude never started" look identical to the orchestrator.

Fix run-sequence first, then run the `ESC[13u]` probe against the cleaned-up signal.

---

## Confidence summary (post–ct-mcp calibration)

| Assumption | Confidence | Falsification |
|-----------|-----------|--------------|
| Kitty `CSI >1u` is active during our submit attempt | 0.95 | It is in the raw log — this is observed fact |
| `ESC[13u]` is the correct Enter under kitty flag=1 | 0.85 | Kitty spec; falsified if `ESC[13u]` also fails |
| 150ms delay is required alongside key fix | 0.55 | Isolate by removing delay after submit success |
| Double-delivery is not a concurrent blocker | 0.75 | Falsified if removing positional arg changes behavior |

Joint ceiling (product): 0.95 × 0.85 × 0.55 × 0.75 = **0.33**

The joint ceiling is low because the timing assumption (0.55) is genuinely uncertain. However: if `ESC[13u]` succeeds, we learn timing isn't required. If it fails, we move to source inspection. The ceiling rises quickly with each experiment that collapses an assumption into an observation.
