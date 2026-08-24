# Claude Prompt — A0g Agent Session Contracts And Resumable Named Runs

Audience: Claude or another external coding agent  
Goal: Implement `A0g` so Guardrail-managed Claude/Codex runs can start, continue, or attach to named sessions through explicit, approval-bound contracts

## Read First

- `docs/technical-status.md`
- `docs/plans/PLAN_pickup_four_open_items_2026-04-08.md`
- `docs/agent-onboarding.md`
- `recipes/claude-exec.recipe.json`
- `recipes/codex-exec.recipe.json`
- `src/claude-exec-wrapper.js`
- `src/codex-exec-wrapper.js`
- `src/recipe-supervisor.js`
- `src/prompt-inputs.js`
- `tests/test-claude-recipe.js`
- `tests/test-codex-recipe.js`

## Use Subagents

Use subagents with these write scopes:

- Subagent 1: session contract helper and manifest semantics
  - `src/agent-session.js`
  - `src/recipe-supervisor.js`
- Subagent 2: Claude wrapper and recipe integration
  - `recipes/claude-exec.recipe.json`
  - `src/claude-exec-wrapper.js`
  - `tests/test-claude-recipe.js`
- Subagent 3: Codex wrapper and recipe integration
  - `recipes/codex-exec.recipe.json`
  - `src/codex-exec-wrapper.js`
  - `tests/test-codex-recipe.js`

The integrator owns:

- `tests/test-integration-runtime.js`
- `docs/technical-status.md`
- `docs/agent-onboarding.md`

## Task

Implement `A0g` in the smallest clean slice:

1. add an explicit session contract model with lifecycle intents such as `start`, `continue`, and `attach`
2. bind approval reuse to stable session-contract fields:
   - tool
   - working directory
   - declared scope
   - wrapper/recipe version
   - session name or session identifier
3. keep prompt-bearing inputs under current `review_each_time` or `content_hash` rules
4. make wrappers emit structured session results that can later feed workflow shared-state wiring
5. block silent or implicit attachment to unrelated ambient local sessions

## Acceptance Criteria

- first session creation is explicit and approval-bounded
- reuse of the same named session works only when the session contract still matches
- switching tool, cwd, scope, or target session forces fresh approval
- wrappers emit structured session metadata without inventing generic uncontrolled session brokering
- tests cover:
  - create session
  - continue same session
  - attach mismatch rejection
  - non-interactive reuse with unchanged contract

## Hard Constraints

- do not rely on undocumented external CLI session behavior
- do not make session attachment implicit
- do not weaken prompt reapproval semantics
- do not add external dependencies

## Stop Conditions

Pause and ask for clarification if:

- the external Claude or Codex CLI does not expose enough stable session behavior to implement this honestly
- the design starts turning into a generic multi-tool session broker
- the only workable implementation path depends on ambient local state Guardrail cannot bound or verify
