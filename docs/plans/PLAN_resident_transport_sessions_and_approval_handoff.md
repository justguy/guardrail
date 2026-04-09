# Guardrail — Resident Transport Sessions and Approval Handoff

Status: Proposed follow-on roadmap item for `D0r`  
Audience: Maintainers extending transport/orchestration recipes and supervisor state  
Goal: Let Guardrail approve a bounded host-runtime lane once, then trigger repeated bounded runs on that lane without repeating the same outer approval each time

## Problem

`D0q` fixes the nested double-approval problem for one composed transport+exec run.

What it does not fix is the common repetitive case:

1. the same launcher/runtime lane is used repeatedly
2. the outer transport/orchestration step has not changed
3. the user still gets asked to approve that same outer lane again and again

Examples:

- rerunning the same AI exec recipe in the same host runtime with a new bounded task input
- running multiple bounded test files through the same approved terminal/runtime lane
- reusing a trusted remote shell/container lane for repeated bounded commands

The missing feature is not "skip approval." The missing feature is "approve the lane once, then reuse it honestly under bounded trigger rules."

## Objective

Add a first-class resident transport/session model that:

- creates an approved host-runtime lane once
- keeps that lane alive for a bounded period
- allows later bounded triggers to reuse that lane
- still enforces per-trigger drift, trust, session, and input rules
- preserves an honest audit trail between lane creation and later trigger reuse

## Desired User Experience

Desired V1 shape:

1. approve creation of a named transport lane
2. later invoke bounded triggers against that lane without repeating the same outer approval
3. require reapproval only when:
   - the lane definition drifts
   - the trigger exceeds the approved trigger envelope
   - trust/channel policy changes
   - TTL or idle timeout expires
   - the lane is torn down or detached

## Non-Goals

- Do not let a resident lane become an arbitrary shell tunnel.
- Do not let lane reuse bypass inner `review_each_time` semantics.
- Do not let trigger reuse silently widen env, cwd, tool, launcher, or destination scope.
- Do not rely on ambient process state without binding it into a stored contract.

## Proposed V1 Model

Two related but separate contracts:

### 1. Lane Contract

Created by an interactive approval.

Binds:

- transport recipe id/version/hash/trust
- launcher/runtime identity
- cwd / repo root / target runtime root
- explicit env allow-list intersection
- lane name or slot
- lane creation timestamp
- TTL and idle-expiry policy
- teardown semantics

Persisted separately from the exec manifest so Guardrail can answer:

- is this the same approved lane?
- is this lane still alive?
- is this lane still within TTL/idle policy?

### 2. Trigger Contract

Evaluated per reuse event.

Binds:

- composed exec recipe id/version/hash/trust
- mapped trigger inputs
- bounded envelopes for reusable trigger inputs
- `review_each_time` inputs from the composed exec layer
- session contract requirements where applicable

This preserves honesty:

- stable bounded triggers can reuse the lane
- prompt-bearing or drifted triggers still require fresh approval

## Safety Requirements

Minimum safe shipping requirements:

- explicit lane identity and slot ownership
- replay protection for trigger requests
- teardown command and forced expiry path
- idle timeout and maximum lifetime
- lane-alive verification before trigger reuse
- trigger schema binding with exact or bounded approval envelopes
- per-trigger trust/channel drift checks
- per-trigger audit records
- user-visible distinction between:
  - "approved lane created"
  - "bounded trigger reused existing lane"

## Why Existing Features Are Not Enough

### Composed transport+exec (`D0q`)

- removes nested Guardrail prompts
- still treats each transport invocation as a fresh run
- does not keep a reusable approved lane alive

### Session contracts (`A0g`)

- bind named AI sessions
- detect session drift and missing/attach mismatches
- do not yet represent a reusable host-runtime transport lane

### Templates and bounded approvals (`D0j`)

- help reduce reapproval churn for deterministic input changes
- do not by themselves keep the outer launcher/runtime lane alive

## Likely V1 Surfaces

Possible implementation shapes:

1. extend composed transport recipes with resident lane lifecycle inputs
2. add a dedicated lane artifact under `.guardrail/transport-sessions/`
3. add CLI verbs such as:
   - `guardrail lane start`
   - `guardrail lane trigger`
   - `guardrail lane stop`

Recommendation:

- keep V1 local-first
- persist lane state under project `.guardrail/`
- reuse the existing supervisor and session-contract machinery where possible

## Acceptance Criteria

- a lane can be created with one interactive approval
- repeated bounded triggers can reuse that lane without repeating the same outer approval
- drift in either the lane definition or the trigger definition blocks reuse
- `review_each_time` in the inner exec layer still forces fresh approval
- expired, torn-down, or missing lanes fail closed
- audit clearly distinguishes lane creation from later trigger reuse

## Rollout Notes

- start with the existing bundled transport proof recipe path
- prove the model on one host-runtime transport before generalizing
- update onboarding to recommend resident lanes for repetitive host-runtime workflows once shipped
