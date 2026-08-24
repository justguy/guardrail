# Prompt: D0s Interactive User-Message Sessions

Implement roadmap item `D0s`: interactive user-message sessions without per-message reapproval.

## Goal

Guardrail must support direct user chat with a guarded AI runtime where:

- the executable boundary is approved once
- user messages are not treated as execution drift by default
- runtime boundary changes still force reapproval

This is not a bounded-prompt-regex feature. It is a distinct approval model for interactive sessions.

## Problem Statement

Today AI recipes such as `claude-exec` treat `prompt` as part of the approval-sensitive execution contract. That is honest for automation runs, but wrong for direct user interaction.

We need a model where Guardrail controls:

- tool/runtime
- model
- cwd/add_dirs
- env allow-list
- budget
- host-runtime transport
- session identity

But does **not** require fresh approval for each new user message.

## Required Outcomes

1. Add a first-class interactive session contract distinct from one-shot prompt-bearing recipe execution.
2. Preserve fail-closed behavior when runtime/session identity drifts.
3. Preserve current one-shot recipe behavior for automation paths.
4. Keep host-runtime transport explicit when needed.
5. Add tests proving that repeated user messages do not re-trigger approval while runtime-boundary changes still do.

## Scope

Likely files:

- `src/cli.js`
- `src/recipe.js`
- `src/recipe-supervisor.js`
- `src/template.js` or a new session-specific artifact helper
- `src/agent-session*.js`
- AI runtime wrappers if message/session separation requires wrapper updates
- `docs/agent-onboarding.md`
- `docs/technical-status.md`
- tests for recipe/session/integration coverage

## Constraints

- Do not weaken `review_each_time` for one-shot automation recipes.
- Do not model this as “prompt can be anything now” inside ordinary recipe reuse.
- Do not hide transport/runtime boundaries.
- Do not scrape ambient local tool state from home-directory internals.
- Keep the audit trail explicit for:
  - session creation approval
  - later user messages
  - boundary drift / denial

## Acceptance Tests

Add coverage for:

1. Create interactive guarded Claude session with one approval.
2. Send a second user message into that same session without fresh approval.
3. Change model or cwd and confirm reapproval is required.
4. Keep ordinary `claude-exec` recipe prompt behavior unchanged for one-shot runs.
5. If transport composition is used, confirm transport remains part of the approved session boundary.

## Deliverable

Implement the feature, add/update docs, and include a concise note explaining:

- what is newly possible
- what remains intentionally approval-sensitive
- how interactive sessions differ from automation prompts
