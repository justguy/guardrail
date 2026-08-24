# Claude CLI Interactive TUI — Paste Submit Semantics

Date: 2026-04-12
Scope: Resident Claude lane wrapper, interactive TUI path only. Not `--print`, not API.

Honest framing: these are high-confidence inferences from TUI / bracketed-paste conventions and Claude Code's observable behavior, not verified against Claude Code's Ink input source.

## Most likely correct submit sequence

**Single bare carriage return `\r` (0x0D), sent outside the bracketed-paste envelope, after `\e[201~` has closed the paste.**

Deterministic byte stream:

```
\e[200~            ← begin bracketed paste
<prompt body, with embedded \n line breaks — NOT \r>
\e[201~            ← end bracketed paste
\r                 ← Enter, now interpreted as submit
```

Confidence: 0.75.

Rationale:
- "[Pasted text #N +M lines]" is the known UI collapse of a bracketed-paste block. It is an acknowledgement that the paste landed as one logical input token — not auto-submit.
- Inside `\e[200~ … \e[201~`, `\r` / `\n` are buffered as literal newline content, never as Enter. That is the definition of bracketed paste.
- Once `\e[201~` closes, the next `\r` reaches the input component as Enter. In Ink line inputs (Claude Code, Codex, Gemini CLI all follow this) `\r` is submit; Shift+Enter / `\\<Enter>` / `\n` alone is insert-newline.

## Fallbacks to test in order

1. **Plain `\r` only** (no envelope, no `\n`). Confidence: 0.5.
   Use if the wrapper is already emitting the bracketed envelope correctly and only the trailing Enter outside it is missing.

2. **`\r\n`** (CRLF). Confidence: 0.25.
   PTYs don't do CRLF translation by default; unlikely to matter, but cheap.

3. **`\e\r`** (Alt/Meta + Enter). Confidence: 0.15.
   In several Ink inputs this is *insert-newline*, the wrong direction. Listed only to rule out — not a submit candidate.

Do **not** use `\n` (Ctrl-J, 0x0A) as submit. Ink line inputs treat it as insert-newline.

## Answers to the specific questions

1. **Submit keystroke after multiline paste:** `\r` alone, after the paste envelope closes. Not `\n`, not double-Enter, not meta combos. Bracketed paste does not change the submit key — only how `\r`/`\n` *inside* the paste are interpreted.

2. **Pasted vs typed:** Different. Bracketed paste becomes one opaque input token rendered as "[Pasted text #N +M lines]" and is never auto-submitted. Typed input renders character-by-character and submits on `\r`. Submit key is identical.

3. **"[Pasted text #1 +63 lines]" semantics:** UI acknowledgement only. Buffering succeeded. Execution requires a subsequent submit keystroke.

4. **Ready marker before sending input:** the input-box prompt glyph (`│ >`) and/or the shortcuts hint line. "Claude Code" banner alone is too early. Wait until the input prompt glyph renders.

5. **Post-paste processing-started signal:** spinner frame (`✢` / `✻`) with status text ("Thinking…" / tool-running lines) beneath the input area, or the first streamed assistant text. Absence means submit never landed.

6. **Deterministic PTY wrapper sequence:**

   ```
   a. wait until PTY output contains the input-prompt glyph AND quiesces briefly
   b. write "\e[200~"
   c. write prompt body with \n separators (strip \r from source)
   d. write "\e[201~"
   e. delay ~50–100 ms to let the Ink reducer commit the paste token
   f. write "\r"
   g. wait for processing marker (spinner / first streamed token)
   h. if no processing marker within N seconds, resend "\r" once; if still nothing, abort
   ```

   (e) and (h) are robustness hedges: (e) guards a race where the paste token hasn't committed before Enter arrives; (h) guards the single `\r` being absorbed by a focus/transition frame.

## Verification step

Capture raw PTY bytes the wrapper currently sends post-paste. If no `\r` after `\e[201~` → that is the bug. If a `\r` appears *inside* the envelope → same bug, different location. Instrument the `expect send --` call in `src/claude-prompt-wrapper.js`.

Overall diagnosis-path confidence: **0.34** (product of independent assumptions: Ink-binds-submit-on-`\r` 0.75 × bracketed-paste-swallows-internal-CR 0.9 × paste-collapse-is-ack-not-submit 0.85 × wrapper-currently-omits-trailing-CR 0.6). The chain is plausible but not strong — two of the four assumptions lack cheap one-shot falsification (`\r`-inside-envelope and no-keystroke-at-all both require a live TUI test). Treat the recommended sequence as the first experiment, not a settled fix. Primary uncertainty: whether Claude Code's current Ink input binds submit on `\r` versus a less common key, and whether the wrapper is already sending a trailing `\r` that's being absorbed elsewhere.

## Observed live probe results

Three live resident-lane PTY probes were run against the current Guardrail interactive wrapper on the host Claude runtime. All three reached:

- stable Claude startup frame
- input-ready UI
- successful prompt paste acknowledgement

Raw PTY evidence in each case showed one or two:

- `[Pasted text #N +M lines]`

and then no processing marker, no streamed assistant output, and no Guardrail progress beyond the wrapper's initial `phase: started` checkpoint.

### Probe A — no-submit control

Wrapper override:

```text
GUARDRAIL_SUBMIT_SEQUENCE_OVERRIDE=''
```

Observed result:

- prompt paste landed
- Claude did not start processing
- confirms paste-only does **not** auto-submit

Artifacts:

- `.guardrail/debug/p0h-nosubmit-hex.log`

### Probe B — single carriage return

Wrapper override:

```text
GUARDRAIL_SUBMIT_SEQUENCE_OVERRIDE=$'\r'
```

Observed result:

- same behavior as Probe A
- prompt paste landed
- no processing marker appeared

Artifacts:

- `.guardrail/debug/p0h-singlecr-hex.log`

### Probe C — single newline

Wrapper override:

```text
GUARDRAIL_SUBMIT_SEQUENCE_OVERRIDE=$'\n'
```

Observed result:

- same behavior as Probe A
- prompt paste landed
- no processing marker appeared

Artifacts:

- `.guardrail/debug/p0h-singlenl-hex.log`

## What these probes prove

1. Guardrail readiness detection is no longer the blocker.
2. Prompt delivery is no longer the blocker.
3. Claude interactive TUI does **not** execute on:
   - paste only
   - paste + single `\r`
   - paste + single `\n`

## Updated next step

The next experiment should not revisit readiness or paste delivery. It should test a different submit model entirely, for example:

- a Claude-specific alternate submit binding beyond plain `\r` / `\n`
- a post-paste control-path submission strategy
- or a different Guardrail-managed interactive bridge if Claude's TUI submit contract is not deterministic enough for PTY wrapping
