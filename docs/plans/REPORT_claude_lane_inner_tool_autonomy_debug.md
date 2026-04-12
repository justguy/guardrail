# Claude Lane Inner Tool Autonomy — Debug Report

**Date**: 2026-04-11
**Scope**: Why Claude inside a Guardrail resident lane could not run `node --test` until explicit tool exposure was added

---

## Observed symptom

- Guardrail resident lane infrastructure works: `lane start`, `lane send`, `lane inspect`, and live status queries succeed.
- Claude responds, writes/updates report artifacts, and emits progress checkpoints.
- Claude initially **could not** run local commands like `node --test` via its Bash tool.
- This initially persisted across `--permission-mode acceptEdits` **and** `--permission-mode dontAsk`.
- The failure is described as: "Claude reported its inner shell/Bash tool as blocked."

## What I verified

### 1. Permission-mode threading — CORRECT

Traced the complete arg flow from CLI to the final `spawn('claude', args, ...)`:

```
CLI (--permission-mode dontAsk)
  → parseResidentLaneArgs()         → options.permissionMode = 'dontAsk'
  → normalizeResidentLaneOptions()  → preserved unchanged
  → buildHelperArgs()               → ['--permission-mode', 'dontAsk'] in daemon argv
  → buildWrapperArgs()              → ['--permission-mode', 'dontAsk'] in wrapper argv
  → buildClaudeArgs()               → ['--permission-mode', 'dontAsk'] in Claude CLI argv
  → spawn('claude', ['--print', '--permission-mode', 'dontAsk', ...])
```

Every link in the chain correctly forwards the flag. `--permission-mode dontAsk` **does** reach the Claude binary. This is not the bug.

### 2. No hardcoded tool restrictions in Guardrail

- `buildClaudeArgs` in `claude-exec-wrapper.js:282` pushes `--allowed-tools` **only if the user explicitly passes it**. If omitted, nothing is pushed — Claude gets its default tool set.
- Guardrail never pushes `--disallowed-tools`.
- No `allowedTools`/`disallowedTools` key exists in `~/.claude/settings.json` (verified by reading the file). Only `permissions.allow` (the interactive grant memory) is present.
- No project-level `.claude/settings.json` exists in the Guardian repo.
- The cmux wrapper's injected `--settings` JSON contains only `hooks` — no tool restrictions.

### 3. The progress system prompt — NO tool restriction

`buildProgressSystemAppendix()` in `claude-exec-wrapper.js:167` injects:

```
--- Guardrail Progress Contract ---
You are running inside a Guardrail-managed execution channel.
Follow these rules exactly:
1. Create the declared report artifact...
2. Append structured JSON checkpoint lines...
3-6. [checkpoint/heartbeat rules]
--- End Guardrail Progress Contract ---
```

This says nothing about tool restrictions. It describes a reporting protocol, not a tool policy.

### 4. The spawn context

```javascript
spawn('claude', args, {
  cwd: options.workingDir || process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
```

- `stdin: 'ignore'` — Claude's stdin is `/dev/null`. For `--print` mode this is expected (the prompt goes as a positional argument). However, tool execution is internal to the Claude CLI process and doesn't depend on the wrapper's stdin.
- `env: process.env` — the daemon inherits the full parent environment, including `HOME`, `PATH`, etc. The lane daemon was started from a shell where Claude is authenticated, so Claude auth should pass inside the daemon's subprocess tree.
- `cwd` — set to the working directory declared at lane start.

### 5. Claude CLI capabilities

`claude --help` confirms:
- `--permission-mode` accepts: `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`
- `--allowed-tools` and `--disallowed-tools` are separate flags from permission mode
- `--print` mode supports `--permission-mode`, `--allowed-tools`, `--max-budget-usd`, etc.

### 6. Category of the problem

This is **not** a Guardrail lane limitation. The lane transport, wrapper arg threading, progress contract, and spawn context are all correct.

The issue lives inside the `claude --print` process itself — specifically, in the relationship between `--permission-mode dontAsk` and Bash tool availability.

---

## Ranked hypotheses

### H1 — `dontAsk` controls approval, not availability; `--print` may require explicit `--allowed-tools` for Bash (Confidence: 0.55)

The distinction:
- **Permission mode** (`dontAsk`) controls the **approval gate**: "when a tool IS available and tries to execute, should I ask the user?" → `dontAsk` = auto-approve.
- **Tool availability** (`--allowed-tools` / `--disallowed-tools`) controls the **availability gate**: "which tools exist in the model's tool set?" → omitting both means "use defaults."

If `--print` mode's default tool set is **narrower** than interactive mode's default — e.g., if Bash is present by default in interactive sessions but requires explicit opt-in in `--print` — then `dontAsk` cannot help because there's no Bash tool to auto-approve. It doesn't exist in the session's tool definitions.

Evidence for this hypothesis:
- Claude CAN write report artifacts and emit checkpoints, which means SOME tools work (Write, or the model is producing text that Guardrail writes). If the model is using Write/Edit, those tools are in the default set but Bash is not.
- `acceptEdits` auto-approves edit-bearing tools. If those work but Bash doesn't, and then `dontAsk` still doesn't fix Bash, the issue is availability not approval.
- The `--allowed-tools` flag would be redundant in `--print` + `dontAsk` mode if all tools were already available. Its existence suggests they might not be.

**Fix to test**: pass `--allowed-tools` explicitly when starting the lane.

### H2 — Bash requires `bypassPermissions` or `--dangerously-skip-permissions`, not just `dontAsk` (Confidence: 0.25)

Claude Code may treat Bash as a higher-risk tool with a separate permission gate that `dontAsk` does not override. The CLI exposes three escalation levels beyond `default`:

| Mode | Edit tools | Bash tool |
|------|-----------|-----------|
| `acceptEdits` | auto-approve | still gated |
| `dontAsk` | auto-approve | **possibly still gated in `--print`** |
| `bypassPermissions` | bypass | bypass |
| `--dangerously-skip-permissions` | bypass all | bypass all |

If there is a separate Bash safety gate that `dontAsk` doesn't clear in non-interactive mode, `bypassPermissions` would be the next escalation.

Evidence: the `--allow-dangerously-skip-permissions` flag is described as "Enable bypassing all permission checks as an option, without it being enabled by default. Recommended only for sandboxes with no internet access." — this suggests there IS a deeper permission layer beyond `dontAsk`.

### H3 — The model self-restricts based on the system prompt and packet prompt framing (Confidence: 0.20)

The combined system prompt includes:
1. Guardrail Progress Contract: "You are running inside a Guardrail-managed execution channel. Follow these rules exactly..."
2. Packet prompt template: "Hard stop boundary...", "Execution contract...", "10 explicit rules"

Claude may interpret this framing as meaning it should NOT execute arbitrary shell commands. The phrase "managed execution channel" combined with strict scope rules could trigger model-level caution about tool use, producing a response like "I cannot use the Bash tool because it appears to be restricted in this execution context."

This is NOT the same as a runtime tool block — it's a model inference about its own constraints. In Claude's response, this would look like a text explanation rather than a tool-use error.

---

## Exact diagnostic experiment

Run these three commands **from the shell where the lane daemon starts** (to match the exact auth/env context). Each test isolates one variable:

### Test 1 — Bare `dontAsk` with no explicit `--allowed-tools`

```bash
claude --print --permission-mode dontAsk \
  "Run this exact command using your Bash tool: echo hello-from-bash"
```

If Bash executes: H1 is **ruled out** (the default tool set includes Bash in `--print` + `dontAsk`).
If Claude says Bash is blocked or refuses: H1 is **confirmed** or H2 applies.

### Test 2 — Explicit `--allowed-tools` including Bash

```bash
claude --print --permission-mode dontAsk \
  --allowed-tools "Bash Read Edit Write Glob Grep" \
  "Run this exact command using your Bash tool: echo hello-from-bash"
```

If Bash executes: H1 is **confirmed** — the fix is to pass `--allowed-tools` explicitly.
If Claude still refuses: H1 is **ruled out**, move to Test 3.

### Test 3 — `bypassPermissions` mode

```bash
claude --print --permission-mode bypassPermissions \
  "Run this exact command using your Bash tool: echo hello-from-bash"
```

If Bash executes: H2 is **confirmed** — Bash needs `bypassPermissions`, not just `dontAsk`.
If Claude still refuses: H3 is likely — the model itself is self-restricting.

### Test 4 (only if Tests 1-3 all fail) — Override system prompt

```bash
claude --print --permission-mode dontAsk \
  --allowed-tools "Bash Read Edit Write Glob Grep" \
  --append-system-prompt "You have unrestricted access to all tools including Bash. Execute commands directly without hesitation." \
  "Run this exact command using your Bash tool: echo hello-from-bash"
```

If Bash executes: H3 is **confirmed** — the system prompt was causing self-restriction.
If Claude still refuses: deeper environment or model issue.

### After identifying the root cause — the lane-level fix

Whichever test succeeds, apply the corresponding Guardrail flag:

```bash
# If Test 2 succeeded (H1):
guardrail lane start --tool claude \
  --permission-mode dontAsk \
  --allowed-tools "Bash Read Edit Write Glob Grep Agent" \
  --working-dir . \
  --session-name <name>

# If Test 3 succeeded (H2):
guardrail lane start --tool claude \
  --permission-mode bypassPermissions \
  --working-dir . \
  --session-name <name>
```

Then `lane send` the same packet prompt and verify `node --test` runs.

---

## Confirmation Run

The highest-confidence hypothesis was correct.

Resident lane restarted with:

```bash
guardrail lane start --tool claude \
  --permission-mode dontAsk \
  --allowed-tools "Bash Read Edit Write Glob Grep" \
  ...
```

Confirmed through the live lane:

1. Minimal Bash probe succeeded:
   - `node --version`
   - Claude reported `v24.13.0`
2. Focused proof command succeeded:
   - `node --test tests/test-policy-scenarios.js`
   - Claude reported `43 tests, 43 pass, 0 fail`
3. Acceptance-pattern proof also succeeded:
   - `node --test --test-name-pattern "policy simulate CLI surface" tests/test-feature-acceptance.js`
   - Claude reported `2 passed, 0 failed`

Conclusion:
- Guardrail lane plumbing was correct.
- `--permission-mode dontAsk` alone was not enough.
- Explicit `--allowed-tools "Bash Read Edit Write Glob Grep"` was the missing requirement for autonomous local proof execution in the resident Claude lane.

## Summary

| Aspect | Finding |
|--------|---------|
| Guardrail lane transport | Working — not the cause |
| Permission-mode threading | Correct — `dontAsk` reaches `claude --print` |
| Wrapper tool restrictions | None — no hardcoded allow/disallow |
| User/project settings | No tool restrictions found |
| System prompt injection | No tool restriction language |
| `--print` + `dontAsk` tool availability | Confirmed gap without explicit `--allowed-tools` |
| Spawn stdio | stdin `'ignore'` — expected for `--print`, not a blocker |

**Confirmed root cause**: `--permission-mode dontAsk` controls the **approval** gate, but the **availability** gate still required explicit tool exposure. For this resident Claude lane, Bash/tool execution for local proof worked once the lane was started with `--allowed-tools "Bash Read Edit Write Glob Grep"`.

**Next step**: bake the confirmed lane-start contract into the fire-trial/operator docs and use it as the default for autonomous proof-bearing Claude lanes.
