# Guardrail — Interactive User-Message Sessions

Status: Partially implemented for recipe/template manifest reuse; resident send-message lanes still open under `D0s` / `D0r`  
Audience: Maintainers extending AI runtime recipes, transport composition, and approval semantics  
Goal: Let a user chat directly with a guarded AI runtime without reapproving every message, while still keeping the executable boundary fixed and auditable

## Problem

Current recipe-mode approval treats prompt-bearing inputs such as `prompt` and `system_prompt` as part of the execution contract.

That is correct for automation:

- the prompt is the instruction payload
- prompt changes can materially change behavior
- Guardrail should not silently reuse approval for arbitrary automation prompts

But this is too blunt for direct interactive use:

1. the user wants to talk to the model directly
2. the model/runtime/tools/cwd/env/budget/transport should stay fixed
3. only the user's next message changes
4. Guardrail still asks for fresh approval because the message is currently modeled as a prompt input

The missing distinction is:

- automation prompt = part of the executable contract
- direct user message = content flowing inside an already-approved interactive lane

## Objective

Add a first-class interactive session mode where:

- the executable/runtime boundary is approved once
- later user messages do not force reapproval by default
- Guardrail still reapproves when the executable boundary changes
- session identity and lifecycle are explicit and auditable

## Desired User Experience

Desired V1 shape:

1. approve a named interactive AI session
2. keep model, tools, cwd, env, budget, and transport fixed
3. send repeated user messages into that session
4. do not reapprove each message
5. require reapproval only when:
   - model changes
   - tool permissions change
   - cwd/add_dirs/scope changes
   - env allow-list changes
   - budget changes
   - transport/runtime changes
   - session expires, detaches, or identity drifts

## Non-Goals

- Do not let interactive chat become an arbitrary shell tunnel.
- Do not weaken review semantics for automation recipes that still use prompt-as-contract.
- Do not hide host-runtime transport boundaries.
- Do not infer ambient local sessions from tool-private state.

## Proposed V1 Model

Two different approval concepts:

### 1. Interactive Session Contract

Approved once. Binds:

- recipe or composed transport+exec artifact
- model and tool permission mode
- working dir and additional dirs
- env allow-list intersection
- budget envelope
- runtime/transport identity
- named session slot and optional runtime session id
- TTL / idle expiry / teardown policy

### 2. Message Stream

User messages are not treated as execution drift by default.

Instead:

- they are appended to session audit
- they may be content-filtered or policy-checked if desired
- they do not trigger reapproval unless the session contract changes

## Why Existing Features Are Not Enough

### `claude-exec` / `codex-exec` recipe mode today

- `prompt` now supports `interactive_message` session-bound reuse for the same persistent named session
- `system_prompt` remains `review_each_time`
- good for direct chat inside a fixed runtime boundary, but still not a full resident send-message lane

### Session contracts (`A0g`)

- useful for named runs and attach/continue enforcement
- now sufficient to distinguish session-bound prompt traffic from executable-boundary drift when the artifact explicitly marks `prompt` as `interactive_message`

### Resident transport sessions (`D0r`)

- solves repeated outer transport approval
- does not by itself solve per-message prompt reapproval

## Likely V1 Surface

One of:

1. a dedicated interactive recipe/template/session artifact
2. an extension to AI exec recipes that separates:
   - session contract inputs
   - user message payloads
3. a new CLI/session command family for guarded chat

Recommendation:

- do not retrofit this as "bounded prompt regex"
- explicitly model user messages separately from runtime contract

## Safety Requirements

- fixed runtime boundary per session
- explicit session identity
- user-message audit trail
- TTL / idle expiry
- teardown controls
- no ambient session discovery from `~/.claude/*` or similar
- fail closed on session drift or missing runtime attachment
- optional content moderation/policy hooks for message stream if desired

## Acceptance Criteria

- one approval starts an interactive guarded AI session
- later user messages do not require fresh approval by default when they stay inside the same persistent named session
- changing runtime boundary fields still requires fresh approval
- host-runtime transport can still be explicit and composed
- audit clearly distinguishes:
  - session creation approval
  - later user messages
  - runtime-boundary drift

## Rollout Notes

- start with the existing Claude/Codex runtime recipes as the first target
- keep one-shot recipe mode unchanged for automation
- document clearly that interactive sessions and automation prompts are different approval models
