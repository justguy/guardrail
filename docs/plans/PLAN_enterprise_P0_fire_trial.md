# Guardrail — Enterprise P0 Fire Trial

Status: Planned  
Audience: Maintainers, reviewers, and external stakeholders evaluating whether Guardrail can drive a high-autonomy enterprise-hardening run under its own controls  
Goal: Demonstrate that Guardrail can supervise a full multi-slice implementation campaign by invoking the Claude CLI one packet at a time, reviewing outputs, correcting gaps, updating docs, monitoring for drift, and preserving bounded operator visibility throughout

Roadmap anchor:

- `P0` execution queue in `docs/technical-status.md`
- `docs/plans/PLAN_enterprise_P0_execution_packets.md`
- `docs/plans/PLAN_enterprise_P0a_universal_authorization_seam.md`
- `docs/plans/PLAN_enterprise_P0b_policy_simulation_and_decision_traces.md`
- `docs/plans/PLAN_enterprise_P0c_sovereign_record_metadata_model.md`
- `docs/plans/PLAN_enterprise_P0d_single_crypto_boundary.md`
- `docs/plans/PLAN_enterprise_P0e_event_schema_v1.md`
- `docs/plans/PLAN_enterprise_P0f_model_gateway_seam.md`
- `docs/plans/PLAN_enterprise_P0g_pre_egress_scrubbing_and_classification_hooks.md`
- `docs/plans/PLAN_enterprise_P0h_emergency_controls.md`

## Fire Trial Objective

Run the entire enterprise `P0` queue under Guardrail itself.

For each packet:

1. invoke Claude through Guardrail
2. constrain work to one packet only
3. require the declared report artifact
4. review the result and fix gaps
5. run the focused tests
6. update docs/roadmap
7. move to the next packet only when the current one is actually closed

This is not just a coding pass. It is a proof that Guardrail can supervise an enterprise-hardening implementation campaign without losing scope control.

## Success Criteria

The fire trial is successful only if all of the following are true:

- each `P0` packet is executed under Guardrail via Claude CLI, one at a time
- each packet produces its declared report file
- each packet passes its focused tests before the next one begins
- each packet updates `README.md` and `docs/technical-status.md` to reflect landed progress
- Guardrail monitoring surfaces are used to confirm no drift and no lane/session confusion during execution
- all issues, failures, retries, and operator interventions are written down in one cumulative fire-trial report

## Non-Goals

- Do not execute multiple `P0` packets in parallel.
- Do not bypass Guardrail because a packet is “just docs.”
- Do not claim packet completion without the declared artifact and focused test proof.
- Do not treat a Claude run as successful if the underlying report or code change is missing.

## Execution Order

The trial must execute the packets in this order:

1. `P0a` universal authorization seam
2. `P0b` policy simulation and decision traces
3. `P0c` sovereign record metadata model
4. `P0d` single crypto boundary
5. `P0e` event schema v1
6. `P0f` model gateway seam
7. `P0g` pre-egress scrubbing and classification hooks
8. `P0h` emergency controls

Each packet is blocked on the previous one being closed.

## Per-Packet Execution Loop

For every packet, use this exact loop:

### 1. Preflight

Before asking Claude to implement the packet:

- verify the exact guarded Claude execution path with a trivial one-line probe
- verify the current lane/session state if resident transport is being used
- verify the current repo state so unrelated untracked files are not mistaken for landed output

Preferred Guardrail-native surfaces:

- `guardrail lane status`
- `guardrail lane inspect`
- `guardrail lane logs`
- `guardrail lane result`
- `guardrail repo status`

Raw host inspection is last resort only.

### 2. Launch One Packet

Invoke Claude through Guardrail with:

- the packet file
- the packet’s expected report artifact path
- the packet’s focused tests
- explicit instruction not to start the next packet
- an edit-capable permission mode for autonomous write-bearing packets (`acceptEdits`, not `default`)
- explicit instruction to create the declared report artifact immediately, write a short `STARTED` status plus intended proof steps, and append concise progress checkpoints there while the packet is running

The Claude run must be packet-bounded, not “finish the whole roadmap.”

### 3. Require the Packet Report

The packet is not complete unless the declared file exists, for example:

- `docs/plans/REPORT_enterprise_P0a_universal_authorization_seam.md`

No report file means no completion, even if stdout looked good.
No delayed report creation either: for long-running packets, the report file is also the live progress heartbeat.

### 4. Review and Fix

After Claude finishes:

- read the packet report
- inspect the touched code/files
- run the packet’s focused tests
- identify any mismatch between:
  - packet scope
  - landed code
  - report claims
  - test evidence

If there is a gap, fix it before advancing.

### 5. Update Documentation

After a packet is truly closed:

- update `docs/technical-status.md`
- update `README.md` if user-facing behavior or architecture framing changed
- update the fire-trial cumulative report with:
  - packet outcome
  - tests run
  - issues encountered
  - fixups applied

### 6. Advance to the Next Packet

Only advance when:

- the declared report exists
- focused tests pass
- docs are updated
- repo state is understood
- any issues from the packet are logged

## Monitoring and Drift Controls

The point of the fire trial is not just to get code landed. It is to prove that Guardrail can supervise the work without scope loss.

During execution, monitor:

- lane/session status
- pending vs completed result state
- exact packet artifact existence
- repo diff including untracked files
- approval boundaries and drift failures

Required monitoring behaviors:

- prefer Guardrail-native status/result/log surfaces over raw host-terminal capture
- treat `missing report artifact` as a hard failure
- treat `focused tests did not pass` as a hard failure
- treat `Claude completed but touched the wrong scope` as a hard failure
- treat `stale report heartbeat` as a warning, not a terminal failure, if other bounded signals still show forward motion
- only treat a long-running packet as stalled when all bounded liveness signals are silent across the stall window:
  - no Guardrail progress events
  - no update to the declared report artifact
  - no bounded file changes in the packet's declared target files
  - no process-level forward motion
- stop on packet drift instead of continuing and hoping the next packet fixes it

## Known Risks This Trial Is Meant To Surface

This run is explicitly intended to expose problems such as:

- Claude runtime/auth drift in the guarded invoke path
- resident lane/session instability during long review loops
- packet scope widening
- missing or false-positive completion reports
- documentation drift between code and roadmap
- monitoring surfaces that are still too weak and force host-level inspection

These are not side notes. They are part of the proof.

## Issue and Concern Log

The fire trial must maintain one cumulative run log:

- `docs/plans/REPORT_enterprise_P0_fire_trial.md`

For each packet, append:

- packet id
- start/end time
- execution path used
- report artifact path
- focused tests run
- pass/fail result
- issues or concerns observed
- whether Guardrail-native monitoring was sufficient
- whether any host-level fallback was required
- what had to be fixed before advancing

## What This Demonstrates Externally

If the trial succeeds, it demonstrates all of the following:

- Guardrail can supervise a multi-step enterprise-hardening campaign under its own controls
- Claude can be used as an implementation worker without silent scope expansion
- review/fix/update loops can happen inside the Guardrail model instead of outside it
- the roadmap is actionable, not just aspirational
- enterprise-aware seams are concrete enough to execute against today

If the trial fails, that is still useful:

- the failure points become concrete product gaps
- the monitoring surfaces can be judged honestly
- the roadmap can be tightened based on real operator pain instead of theory

## Proposed Operator Script

The human operator should hold the line on three rules:

1. One packet at a time.
2. No report file, no completion.
3. No passing focused tests, no advance.

That keeps the trial honest and makes the result shareable.
