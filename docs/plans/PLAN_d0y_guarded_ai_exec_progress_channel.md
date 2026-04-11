# Guardrail — D0y Plan: Guarded AI Exec Progress Channel

Status: Ready  
Audience: Main implementation agent plus guarded Claude execution packets  
Goal: Add a first-class Guardrail progress channel for long-running one-shot AI executions so operators can monitor, review, and respond without dropping to raw host inspection or treating every concern as a hard terminal failure.

Roadmap anchor: `D0y` in `docs/technical-status.md`

## Declared Artifact

Write this report before claiming success:

- `docs/plans/REPORT_d0y_guarded_ai_exec_progress_channel.md`

## Why This Exists

The `P0a` fire trial proved that:

- a longer invoke timeout is necessary, but not sufficient
- delayed final stdout is not an acceptable operator experience for long Claude packets
- report-file heartbeats help, but they are still prompt-dependent and too implicit
- users need Guardrail-native visibility into what the AI run is doing while it is still healthy
- users also need bounded leeway to review progress, answer questions, and address Guardrail-identified concerns without collapsing the run into a dead end

The goal of `D0y` is not just "more logs." The goal is a real monitored execution channel with:

- structured machine-readable checkpoints
- human-readable progress artifacts
- soft states like `waiting_for_review` and `waiting_for_input`
- explicit handoff into existing session or lane continuation when the run actually needs bidirectional interaction

## Operator Requirements

The shipped design must satisfy all of the following:

1. Long-running `claude-exec` runs show meaningful progress before final stdout.
2. Progress is visible through Guardrail-native surfaces, not raw terminal capture.
3. The AI can raise:
   - questions
   - drift concerns
   - review requests
   - blocked-on-input conditions
4. Operators can respond without losing run identity or pretending the packet is "done."
5. Guardrail can distinguish:
   - healthy progress
   - stalled progress
   - review-required progress
   - hard failure
6. Progress surfaces must carry source provenance when relevant:
   - project-local recipe/template root
   - user-shared root
   - org-shared root
7. The system must still fail closed if:
   - the declared report artifact never appears
   - the AI widens scope beyond the packet
   - the progress stream goes silent past bounded thresholds

## Constraints

These constraints are real and should drive the design:

- `claude --print` is still a one-shot CLI call. It is not a native interactive stream.
- Guardrail already has a supervisor-level NDJSON progress stream via `--json-stream`.
- Guardrail already supports persistent session metadata and resident lanes for follow-up interaction.
- We should extend those existing seams instead of inventing a parallel monitoring stack.
- We should not depend on raw pane capture, `ps`, or host-surface inspection for normal operation.

## Non-Goals

This slice should not try to solve everything:

- not a full web UI
- not a generic hosted-control-plane event store
- not replacing resident lanes for truly interactive chat
- not building a model-agnostic orchestration runtime for every future provider in the same patch
- not silently allowing open-ended human intervention that escapes the approved Guardrail boundary

## Existing Building Blocks To Reuse

These should be treated as the starting point, not bypassed:

- `src/progress-events.js`
  - stable supervisor progress NDJSON schema
- `src/cli.js --json-stream`
  - existing Guardrail-native progress output
- `src/recipe-supervisor.js`
  - current recipe execution lifecycle and progress sink wiring
- `src/claude-exec-wrapper.js`
  - current Claude wrapper and session metadata emission
- `src/resident-lane-core.js`
  - existing bounded session/lane continuation path
- `recipes/claude-exec.recipe.json`
  - current runtime contract, timeout, and packet guidance

## Design Summary

`D0y` should be implemented as a two-channel model:

1. A Guardrail-owned progress artifact for one-shot AI runs
2. A bounded continuation path when the run needs review or input

That means:

- one-shot `claude-exec` gets structured progress checkpoints without waiting for final stdout
- if the AI needs actual back-and-forth, Guardrail transitions to a review/input state instead of pretending the packet failed or succeeded
- follow-up interaction uses persisted session metadata or a resident lane, not raw host inspection

## Proposed Architecture

### 1. Guardrail-Owned Progress Artifact

For every guarded AI execution, Guardrail should create a machine-readable progress file inside the run state directory:

- `ai-progress.ndjson`

And one compact derived summary file:

- `ai-progress-state.json`

These files are Guardrail artifacts, not user prompt artifacts.

Minimum record fields per NDJSON event:

- `runId`
- `tool`
- `event`
- `status`
- `checkpointId`
- `phase`
- `message`
- `severity`
- `reportArtifact`
- `progressArtifact`
- `sessionName`
- `sessionId`
- `sourceRootType`
- `sourceRootIdentity`
- `timestamp`

Recommended event set:

- `ai_checkpoint`
- `ai_artifact_written`
- `ai_question`
- `ai_review_requested`
- `ai_drift_warning`
- `ai_waiting_for_input`
- `ai_waiting_for_review`
- `ai_stalled`
- `ai_resumed`

### 2. Wrapper-Managed Checkpoint Contract

`claude-exec` should gain a wrapper-managed progress contract.

The wrapper should receive internal Guardrail-managed flags such as:

- `--guardrail-progress-file`
- `--guardrail-progress-state-file`
- `--guardrail-report-artifact`
- `--guardrail-heartbeat-seconds`

The wrapper should append one strict system appendix that tells Claude:

- create the declared report artifact immediately
- create or append machine-readable checkpoint lines to the Guardrail progress file
- emit a first checkpoint early
- emit a checkpoint after each meaningful phase
- emit `question`, `review_requested`, or `drift_warning` checkpoints instead of hiding uncertainty in the final report

This is still model-cooperative, but it becomes a first-class recipe/wrapper contract instead of ad hoc prompt advice.

### 3. Supervisor Ingestion And Relay

`recipe-supervisor` should:

- create the progress files in the run state dir before spawn
- pass the progress paths into the wrapper
- tail or poll the progress NDJSON file during execution
- relay those checkpoints through the existing `progressSink`
- persist the latest progress summary for later CLI inspection

This lets `guardrail run --json-stream` surface AI checkpoints while the one-shot process is still alive.

### 4. Soft Runtime States Instead Of Immediate Terminal Failure

Guardrail needs new non-terminal states for AI packet runs:

- `running`
- `waiting_for_review`
- `waiting_for_input`
- `drift_warning`
- `stalled`
- `completed`
- `failed`

Rules:

- `question` and `review_requested` are not failures
- `drift_warning` is not automatically terminal, but it should block auto-advance
- `stalled` is a bounded warning state before timeout
- the run becomes terminal only if:
  - the user aborts
  - the AI exits nonzero
  - Guardrail detects a hard scope violation
  - the progress channel breaches the configured stall/timeout thresholds

### 5. Bounded Continuation Path

Pure one-shot `claude --print` cannot support true mid-run chat by itself.

So `D0y` must explicitly define the handoff rule:

- If the run emits `waiting_for_review` or `waiting_for_input`, Guardrail persists session metadata and exposes the next command to continue the same session.
- The continuation path should use:
  - existing persistent session support in `claude-exec`, and/or
  - the resident lane path when the packet should become interactive

This is how the operator can:

- review progress
- answer questions
- address Guardrail-raised concerns
- continue the run without pretending the packet is over

### 6. Guardrail-Native Monitoring Surface

Add dedicated progress inspection commands for one-shot AI runs.

Minimum CLI surface:

- `guardrail recipe progress --state-dir <dir> [--json] [--follow]`
- `guardrail recipe progress --run-id <id> [--json] [--follow]`

Recommended companion command:

- `guardrail recipe continue --state-dir <dir> --prompt <text>`

That command should only work when the run is in a bounded continuation-eligible state and has persisted session metadata.

### 7. Provenance In Progress Events

Progress must surface where the active packet/template/recipe came from:

- `project_local`
- `user_shared`
- `org_shared`

This matters for real-user trust. It should be visible in:

- the progress summary
- the progress NDJSON stream
- the final report metadata

This also aligns with the current roadmap work around shared global roots versus project-local roots.

## Timeout And Heartbeat Policy

The fire trial already proved that one minute is too short. `D0y` should not regress that.

Recommended policy:

- keep the existing longer wrapper timeout for `claude-exec`
- introduce heartbeat deadlines:
  - no first checkpoint within `N` seconds -> warning
  - no new checkpoint within `M` seconds while process still alive -> `stalled`
  - no recovery before hard timeout -> `failed`

Recommended initial values:

- first checkpoint warning: `30s`
- normal checkpoint stall warning: `90s`
- hard stall escalation: `180s`

These should live in recipe/supervisor policy, not be hidden magic numbers.

## Review / Feedback Flow

The intended operator flow should be:

1. Start the packet through Guardrail.
2. Watch `--json-stream` or `guardrail recipe progress --follow`.
3. See structured checkpoints as the AI works.
4. If the AI raises a question or review request:
   - Guardrail moves to `waiting_for_review` or `waiting_for_input`
   - Guardrail tells the operator the exact continuation command
5. Operator responds through Guardrail, not raw terminal access.
6. The AI continues in the same bounded session identity.
7. Final completion still requires:
   - declared report artifact
   - focused tests
   - post-run review/fix

## Implementation Slices

### D0y.1 — Progress Event Schema

Add AI-specific checkpoint events and stable fields.

Likely files:

- `src/progress-events.js`
- `src/cli.js`
- `tests/test-recipe.js`
- `tests/test-claude-recipe.js`

Proof:

- `--json-stream` can surface AI checkpoint events without breaking existing supervisor event consumers

### D0y.2 — Claude Wrapper Progress Contract

Teach `claude-exec` to accept Guardrail-managed progress artifact paths and inject the progress/report contract.

Likely files:

- `src/claude-exec-wrapper.js`
- `recipes/claude-exec.recipe.json`
- `tests/test-claude-recipe.js`

Proof:

- long-running packet can emit an early checkpoint and a report artifact before final stdout

### D0y.3 — Supervisor Persistence And Monitoring

Persist the latest checkpoint and expose it through Guardrail-native inspection.

Likely files:

- `src/recipe-supervisor.js`
- `src/cli.js`
- `tests/test-recipe.js`
- `tests/test-feature-acceptance.js`

Proof:

- operator can monitor progress through Guardrail without host inspection

### D0y.4 — Soft Review/Input States

Introduce non-terminal review/input states and continuation guidance.

Likely files:

- `src/recipe-supervisor.js`
- `src/claude-exec-wrapper.js`
- `src/cli.js`
- `tests/test-claude-recipe.js`
- `tests/test-feature-acceptance.js`

Proof:

- `question` or `review_requested` does not collapse to generic failure
- Guardrail prints the next bounded continuation command

### D0y.5 — Continuation Command

Add the bounded operator response path for paused one-shot runs.

Likely files:

- `src/cli.js`
- `src/recipe-supervisor.js`
- `src/claude-exec-wrapper.js`
- `tests/test-feature-acceptance.js`

Proof:

- operator can answer a question or approve a reviewed intermediate result and continue the same bounded session

## Acceptance Criteria

`D0y` is done when all of the following are true:

- `claude-exec` emits Guardrail-visible progress before final stdout
- progress can be monitored without raw host inspection
- long healthy runs do not look like silent hangs
- AI-raised questions and drift concerns surface as structured events
- Guardrail supports bounded review/input continuation instead of only stop-or-fail behavior
- the declared report artifact is still required for actual completion
- README and `docs/technical-status.md` explain the operator flow honestly

## Risks And Open Questions

### 1. Model Cooperation Risk

The progress side channel still depends on Claude honoring the wrapper-injected checkpoint contract.

Mitigation:

- require an early first checkpoint
- treat missing progress as a monitored fault
- keep the report artifact as a secondary human-readable fallback

### 2. One-Shot Versus Interactive Boundary

True mid-run back-and-forth is not native to one-shot `claude --print`.

Mitigation:

- make the continuation handoff explicit
- use persisted session identity or resident lanes when real operator interaction is needed

### 3. Artifact Drift

Progress updates should not be mistaken for proof of completion.

Mitigation:

- final success still requires the declared report artifact plus focused tests

### 4. Progress Spam

Too many checkpoints will make the stream noisy.

Mitigation:

- bounded event vocabulary
- checkpoint cadence policy
- derived summary file for quick inspection

## Recommended Execution Order

Implement in this order:

1. `D0y.1` progress schema
2. `D0y.2` wrapper progress contract
3. `D0y.3` supervisor persistence and monitor command
4. `D0y.4` soft review/input states
5. `D0y.5` continuation command

Do not start with continuation first. Without a trustworthy progress stream and persisted checkpoint state, continuation will be too opaque to operate safely.
