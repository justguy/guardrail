# Sonnet Direct Lane Submit Blocker — Diagnosis

Date: 2026-04-12
Source: `src/claude-prompt-wrapper.js`, `.guardrail/lanes/sonnet-direct-debug/state.json`,
`.guardrail/lanes/sonnet-direct-debug/progress/req-1776025302833-kpfoqt.ndjson`,
`.guardrail/debug/p0h-atomic-singlenl-send.log`, `.guardrail/debug/p0h-atomic-singlenl-hex.log`

---

## What the artifacts show

Progress file contains exactly one line:

```json
{"event":"ai_checkpoint","phase":"started","message":"Claude interactive subprocess is starting","severity":"info","runId":"sonnet-direct-debug",...}
```

Lane state: `status: busy`, `currentAiPhase: started`, `lastCompletedRequestId: null`. Identical to every prior stuck run.

No send hex log is captured for this lane. `ptySendHexLog` is not in the env for the sonnet-direct-debug daemon. **There is no artifact that proves what bytes were actually sent to Claude's stdin for this run.**

---

## Root cause

### 1. The live lane almost certainly sent `\r\r`, not `ESC[13u]` — confidence: 0.80

Trace:

```
const POST_PASTE_SUBMIT_SEQUENCE = '\r\r';        // line 14
resolveInteractiveSubmitSequence(env)              // line 443
  → env.GUARDRAIL_SUBMIT_SEQUENCE_OVERRIDE ?? POST_PASTE_SUBMIT_SEQUENCE
  → options.submitSequence                         // set in normalizeOptions line 497
  → GUARDRAIL_SUBMIT_SEQUENCE env var              // passed to Tcl at line 559
  → submit_sequence Tcl var                        // read from env at line 98–105
  → send_logged $send_hex_log "stdin" $submit_sequence
```

The override path reads `GUARDRAIL_SUBMIT_SEQUENCE_OVERRIDE`. This env var must be present in the process environment **when the lane daemon itself starts** — not when the request is submitted. If the daemon was started without that override set, `options.submitSequence` defaults to `'\r\r'` (two raw CR bytes, 0x0d 0x0d) and that is what gets sent.

The sonnet-direct-debug state.json shows no evidence that the daemon was started with `GUARDRAIL_SUBMIT_SEQUENCE_OVERRIDE`. The "kitty-enter override" was confirmed as a diagnostic recommendation, but whether it was actually applied as a live env var when `launchResidentLane` was invoked is unverifiable from the artifacts.

**This means the live proof run almost certainly sent `\r\r` again**, which all prior tests already proved does not submit.

### 2. Even if `ESC[13u]` was sent, the submit may have been wrongly timed — confidence: 0.50

The Tcl script sends in this order:
```tcl
send_bracketed_paste $send_hex_log $prompt_input   ← paste
after $submit_delay_ms                              ← 300ms
send_logged $send_hex_log "stdin" $submit_sequence  ← submit
```

The 300ms delay is between paste-end and submit. That is the right structure. But without a send log for this run, we cannot verify the timing or whether the ready beacon fired at the correct moment.

### 3. `ESC[13u]` may also not be the correct submit key — confidence: 0.35

Prior diagnosis (grounding_score 0.80) identified kitty keyboard protocol as the most likely mechanism. But the kitty spec for flag=1 (disambiguate only) is ambiguous on whether legacy `\r` is still accepted. Claude Code's Ink input handler is the authoritative source. If Claude internally normalizes `\r` to "Enter" even in kitty mode, then kitty mismatch is not the blocker at all, and the real cause is something else (paste-pending UX state, double-delivery trace, or a completely different control-path submission).

---

## Answers to required questions

**Did the live direct Sonnet probe actually send the kitty-enter bytes?**

Unknown. No send hex log was captured for sonnet-direct-debug. Based on code trace, the default path sends `\r\r`. Unless `GUARDRAIL_SUBMIT_SEQUENCE_OVERRIDE=$'\x1b[13u'` was explicitly in the environment when the daemon started, `ESC[13u]` was not sent. We are inferring from configuration intent only.

**If kitty-enter really was sent, what is the strongest remaining hypothesis?**

Claude's TUI treats bracketed paste as a two-step interaction: paste lands in a "preview/pending" buffer, the first Enter confirms/expands the paste into the editable input, and a SECOND Enter submits. Under this model, no single submit keystroke works — it needs two. But this contradicts the observation that `\r\r` (two CRs) also failed. Unless the two CRs arrived too close together to be processed as two distinct events.

**Should the next experiment keep bracketed paste and change only submit?**

No. The next experiment must first confirm what bytes were actually sent. Without a send log, all further keystroke experiments are ungrounded.

**Should the next experiment abandon bracketed paste and simulate typed input?**

Only as a fallback. Typed simulation is impractical for 63-line prompts. For "Reply with exactly: PONG" (4 words), it is viable.

**What is the minimum change most likely to make "Reply with exactly: PONG" execute?**

Enable send hex logging AND set `GUARDRAIL_SUBMIT_SEQUENCE_OVERRIDE` to literal ESC bytes (`$'\x1b[13u'`) in the same experiment. Run with the minimal 4-word prompt. Check the send log to verify the bytes were delivered. This is the only path that produces falsifiable evidence.

---

## Ranked causes

| Rank | Cause | Confidence |
|------|-------|------------|
| 1 | Override not applied: live lane sent `\r\r` not `ESC[13u]` | 0.80 |
| 2 | `ESC[13u]` correctly sent but timing gap allows race before Ink commits paste state | 0.50 |
| 3 | `ESC[13u]` is not the correct submit key; different Ink binding is in effect | 0.35 |
| 4 | Ready beacon fired too early; paste sent before input area truly active | 0.20 |

---

## Next single experiment

**Restart the sonnet-direct-debug lane with both overrides explicitly set, enable send hex logging, and confirm bytes delivered:**

```bash
# Set these in the environment before starting the daemon:
export GUARDRAIL_SUBMIT_SEQUENCE_OVERRIDE=$'\x1b[13u'   # actual ESC bytes
export GUARDRAIL_PTY_SEND_HEX_LOG=/path/to/send.log
export GUARDRAIL_PTY_HEX_LOG=/path/to/recv.log
```

Then fire the minimal proof prompt: `Reply with exactly: PONG`

After the run (whether it succeeds or times out), immediately read the send hex log:

```
Expected if override applied: ...1b 5b 31 33 75...   (ESC [ 1 3 u)
Expected if override missing: ...0d 0d...              (\r\r)
```

**Decision tree:**

- Send log shows `0d 0d` → override was not applied → set it and re-run. No new hypothesis needed.
- Send log shows `1b 5b 31 33 75` AND Claude processes → kitty-enter confirmed, done.
- Send log shows `1b 5b 31 33 75` AND Claude still does not process → inspect installed `@anthropic-ai/claude-code` bundle for the Ink input handler's `useInput` keybinding for submit. Kitty-enter is wrong; source is required.

This experiment generates falsifiable data. Do not run another submit variant without first running this one and reading the send log.

---

## Joint confidence ceiling

| Assumption | Confidence |
|-----------|-----------|
| Default path sends `\r\r` if override not set | 0.95 (code read) |
| Override env var was not present when daemon started | 0.80 (no evidence in state.json) |
| Send hex log is the correct diagnostic instrument | 0.99 (code read confirms it captures all `send_logged` calls) |
| `ESC[13u]` is the correct submit key if override applied | 0.65 |

Joint ceiling for "kitty-enter will work once properly applied": 0.95 × 0.80 × 0.99 × 0.65 = **0.49**

Ceiling for "override was not applied and fixing it will unblock": 0.95 × 0.80 = **0.76**

The 0.76 scenario (just apply the override correctly) is the first thing to verify. If it was already applied and still failed, the ceiling drops to 0.35 and source inspection becomes the only remaining path.
