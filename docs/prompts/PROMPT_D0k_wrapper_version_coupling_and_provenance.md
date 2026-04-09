# Claude Prompt — D0k Wrapper Version Coupling And Provenance Policy

Audience: Claude or another external coding agent  
Goal: Define and implement honest drift/provenance rules when Guardrail-shipped recipes depend on local wrapper helpers that can change independently of the recipe artifact

## Read First

- `docs/technical-status.md`
- `docs/prompts/PROMPT_D0e_bundled_wrapper_portability.md`
- `recipes/git-commit.recipe.json`
- `recipes/codex-exec.recipe.json`
- `recipes/claude-exec.recipe.json`
- `src/git-commit-wrapper.js`
- `src/codex-exec-wrapper.js`
- `src/claude-exec-wrapper.js`
- `src/recipe.js`
- `src/recipe-supervisor.js`
- wrapper-focused tests

## Use Subagents

Do not run this in parallel with `D0e`. Keep one owner for:

- wrapper provenance helper logic
- bundled wrapper recipes
- recipe manifest/drift semantics
- wrapper-focused tests and docs

## Task

Implement a clear provenance policy for bundled wrappers:

1. define how bundled helper versions or hashes are pinned in recipe approval material
2. surface wrapper/helper drift explicitly when the recipe artifact is unchanged but the helper changed
3. keep the policy specific to Guardrail-shipped bundled wrappers
4. make user-facing drift output explain whether the recipe changed, the wrapper changed, or both changed

## Acceptance Criteria

- approval material captures the right bundled-wrapper coupling data
- changing a wrapper helper after approval is detected honestly
- bundled wrapper recipes stay portable after `D0e` without hiding helper drift
- tests cover unchanged recipe plus changed wrapper, changed recipe plus unchanged wrapper, and exact-match reuse

## Hard Constraints

- do not treat wrapper changes as invisible implementation details
- do not generalize this item to arbitrary third-party recipes
- do not weaken provenance or trust semantics to preserve compatibility

## Stop Conditions

Pause and ask for clarification if:

- bundled wrapper identity cannot be pinned without first changing the packaging model
- the only design path would make helper drift invisible to approved users
