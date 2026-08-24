# Guardrail — First-Approval TTY Failure Under `tpf`

Status: Draft implementation plan for roadmap item `D0o`  
Audience: Guardrail and `tpf` maintainers  
Goal: Reproduce the `unsupported_no_tty` failure path for first interactive approval runs, then ship a supported, documented approval-bearing path

## Objective

Guardrail correctly requires a real TTY for first interactive approval in:

- `src/supervisor.js`
- `src/recipe-supervisor.js`
- `src/workflow-supervisor.js`

However, some agent contexts that invoke Guardrail through `tpf` lose the TTY and fail with:

- `status: unsupported`
- `terminalReason: Interactive approval required but stdin is not a TTY.`

This plan splits the problem into:

1. reproduce the exact `tpf`/TTY break deterministically
2. clarify Guardrail's supported rerun path
3. decide whether the durable fix belongs in `tpf`, Guardrail, or both

## Current State

Guardrail behavior:

- non-interactive reuse works from a saved manifest
- first approval requires `process.stdin.isTTY`
- failure is logged as `unsupported_no_tty`

Open gap:

- agent shells using `tpf` may prevent Guardrail from reaching its own approval prompt
- current Guardrail error is technically correct but not actionable enough for agents

## Resolved Design Choices

1. Do **not** weaken Guardrail's TTY requirement for first approval.
2. Treat `tpf` passthrough as the likely runtime fix for approval-bearing commands.
3. Improve Guardrail's unsupported response so agents know how to rerun correctly.
4. Keep normal `tpf` wrapping for non-interactive Guardrail commands.

## Reproduction Matrix

Build a reproducible matrix covering:

- direct Guardrail command in a real terminal
- Guardrail through `tpf`
- Guardrail through agent shell wrappers
- command mode, recipe mode, and workflow mode

Target commands:

```bash
node src/cli.js run --manifest .guardrail/approved.json -- echo hello
node src/cli.js run --recipe claude-exec --manifest .guardrail/recipes/claude-exec.approved.json --input guardrail_repo=. --input working_dir=. --input prompt=\"hello\"
node src/cli.js workflow run --definition workflows/example.json --manifest .guardrail/workflows/example.approved.json
```

For each, record:

- whether `stdin.isTTY` is true
- whether approval prompt renders
- whether `unsupported_no_tty` is returned
- whether `tpf` or the agent shell altered stdio

## Guardrail-Side Improvements

Even if `tpf` is the main fix, Guardrail should improve the failure response.

### Desired behavior

When approval is needed but no TTY is available, return:

- current status/exit code unchanged
- current human-readable reason unchanged
- plus structured rerun hints

Suggested result fields:

```json
{
  "status": "unsupported",
  "terminalReason": "Interactive approval required but stdin is not a TTY.",
  "requiresTTY": true,
  "rerunDirectly": true,
  "suggestedAction": "rerun_with_direct_tty",
  "suggestedCommand": "node src/cli.js workflow run --definition ... --manifest ..."
}
```

`suggestedCommand` should be derived from the current invocation inputs already in scope for each supervisor:

- command supervisor: current command/args/shell/manifest path
- recipe supervisor: current recipe specifier, inputs, and manifest path
- workflow supervisor: current definition path, recipe search dirs, and manifest path

The hint should be specific enough that an agent can rerun the exact approval-bearing command directly in a real TTY.

### Scope

Apply consistently in:

- `src/supervisor.js`
- `src/recipe-supervisor.js`
- `src/workflow-supervisor.js`

### Non-goal

Do not attempt auto-approval or alternate approval transport in v1.

## `tpf`-Side Expectation

The likely durable behavior for `tpf` is:

- add an explicit passthrough / preserve-tty mode for interactive Guardrail approval commands
- no output filtering in that mode
- stdio inherited directly
- use only for approval-bearing commands

Guardrail should document this supported path, but `tpf` owns the stdio behavior.

## File-by-File Guardrail Plan

### Phase 1 — Reproduce and lock the failure

Files:

- `tests/test-feature-acceptance.js`
- possibly a new focused test file for unsupported approval paths

Tasks:

- add regression coverage for no-TTY approval in command, recipe, and workflow modes
- assert the error shape is stable and actionable

### Phase 2 — Structured rerun hints

Files:

- `src/supervisor.js`
- `src/recipe-supervisor.js`
- `src/workflow-supervisor.js`
- `src/logger.js` if printed output needs a short rerun hint

Tasks:

- include machine-readable rerun hints in JSON results
- include a short direct-rerun suggestion in human output
- ensure `suggestedCommand` is populated consistently in command, recipe, and workflow modes

### Phase 3 — Docs and onboarding

Files:

- `README.md`
- `docs/agent-onboarding.md`
- `docs/technical-status.md`

Tasks:

- explicitly say first approval needs a real TTY
- say `tpf` passthrough/direct invocation is the supported path for approval-bearing commands
- say normal wrapped usage is fine after manifest creation

## Acceptance Criteria

- direct first approval still works unchanged
- no-TTY approval attempts fail closed
- JSON output includes enough detail for an agent to choose the correct rerun path
- docs explicitly separate first interactive approval from later non-interactive reuse
- no implementation path weakens Guardrail's approval boundary

## Review Focus

- ensure the fix does not blur responsibility between Guardrail and `tpf`
- ensure no code path silently degrades from approval to non-approval
- ensure agent-visible rerun hints are specific enough to be useful
