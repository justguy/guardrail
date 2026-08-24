# REPORT — D0y: Guarded AI Exec Progress Channel

Status: CLOSED AFTER REVIEW/FIX  
Date: 2026-04-11  
Plan: `docs/plans/PLAN_d0y_guarded_ai_exec_progress_channel.md`

## Outcome

`D0y` is now implemented for the shipped Guardrail scope.

The fire trial proved that timeout tuning plus final stdout was not enough for long one-shot `claude-exec` packets. The resulting implementation now provides a Guardrail-owned progress/query/continue path instead of forcing operators to choose between blind waiting and raw host inspection.

## What Landed

### Execution-path changes

- `src/progress-events.js`
  - stable AI progress event vocabulary
  - heartbeat policy constants
  - soft-state mapping
  - structured progress-line parsing

- `src/claude-exec-wrapper.js`
  - Guardrail-only progress flags:
    - `--guardrail-progress-file`
    - `--guardrail-progress-state-file`
    - `--guardrail-report-artifact`
    - `--guardrail-heartbeat-seconds`
  - injected progress contract appendix for Claude
  - wrapper-owned first checkpoint before Claude spawn
  - progress-file polling/final drain
  - final state persistence
  - successful exits now preserve soft review/input states from the current invocation instead of collapsing them to `completed`

- `src/recipe-supervisor.js`
  - progress artifact creation in the run state dir
  - stderr relay for `[guardrail-ai-progress]`
  - state-file updates and continuation hints
  - stall detection timer with warning and hard-stall thresholds

- `src/cli.js`
  - `guardrail recipe progress --state-dir <dir> [--json] [--follow]`
  - `guardrail recipe progress --run-id <id>` resolves the local `.guardrail` state dir when it matches the requested run id
  - `guardrail recipe continue --state-dir <dir> --prompt "<response>"`

- `recipes/claude-exec.recipe.json`
  - explicit `progress_channel` contract
  - heartbeat thresholds
  - soft-state declarations
  - operator-facing guardrails for progress/continuation semantics

### Documentation updates

- `README.md`
- `docs/agent-onboarding.md`
- `docs/technical-status.md`

These now describe:

- the Guardrail-owned AI progress files
- the `recipe progress --follow` operator path
- bounded continuation via `recipe continue`
- the caveat that checkpoint content remains model-cooperative

## Fire-Trial Findings That Changed The Design

The D0y fire trial exposed several real issues:

1. Duplicate recipe-source ambiguity in the Guardrail repo root.
2. TTY requirements for live recipe approval.
3. A stale report heartbeat was initially treated too aggressively as terminal failure.
4. A successful Claude subprocess that asked for review/input could still be incorrectly collapsed to `completed`.

Only the fourth item required code to make the operator loop trustworthy. The first three were documented as operator-path rules and monitoring policy corrections in the cumulative fire-trial report.

## Focused Proof

Focused tests run:

```bash
node --test tests/test-claude-recipe.js
node --test tests/test-recipe.js
```

What the focused D0y proof now covers:

- AI progress schema/constants
- progress-line parsing and emission
- wrapper progress flags and prompt appendix
- supervisor progress env injection and relay setup
- soft-state preservation on successful exit
- `recipe progress` snapshot output
- `recipe progress --follow` live update behavior
- `recipe continue` resuming through the same Guardrail wrapper path

## Remaining Caveat

The progress channel is now Guardrail-owned and queryable in real time, but the checkpoint content is still model-cooperative rather than a native Claude streaming protocol.

That means:

- Guardrail owns the progress files, state summary, stall policy, and continuation contract.
- Guardrail can detect silence/stalls and expose soft states.
- Guardrail cannot force high-quality checkpoint text if the model ignores the contract.

This is acceptable for the current shipped scope because the operator surface is now bounded, queryable, and continuation-capable. It should not be marketed as a native Claude streaming API.

## Recommended Next Use

For the next Guardrail-supervised Claude fire trial:

1. launch the one-shot packet normally
2. monitor with `guardrail recipe progress --state-dir .guardrail --follow`
3. if the run raises a soft state, respond with `guardrail recipe continue --state-dir .guardrail --prompt "..."`
4. keep the report artifact as the proof-of-completion artifact, not the only live liveness signal
