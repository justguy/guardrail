# Claude Prompt — D0f Multiple Recipe-Root Precedence And Collision Policy

Audience: Claude or another external coding agent  
Goal: Define and implement deterministic resolution when the same recipe id exists in more than one root, including explicit precedence, drift behavior, and user-facing diagnostics

## Read First

- `docs/technical-status.md`
- `docs/prompts/PROMPT_D0d_unified_workflow_recipe_discovery.md`
- `src/recipe-runner.js`
- `src/recipe-index.js`
- `src/workflow.js`
- `src/cli.js`
- `tests/test-recipe-system.js`
- `tests/test-workflow.js`

## Use Subagents

Do not run this in parallel with `D0d` or `D0g`. Reuse the same resolver/discovery lane and keep one owner for:

- `src/recipe-runner.js`
- `src/recipe-index.js`
- `src/workflow.js`
- `src/cli.js`
- discovery and workflow resolution tests

## Task

Implement explicit multi-root resolution semantics:

1. define precedence across explicit roots, repo-local roots, installed roots, and bundled recipes
2. detect same-id collisions instead of silently taking the first hit
3. return structured diagnostics that explain:
   - which roots were searched
   - which candidates matched
   - why the winner won or why execution is blocked
4. make workflow and standalone recipe resolution use the same collision behavior

## Acceptance Criteria

- the same recipe id in multiple roots is handled deterministically
- collisions are visible and machine-readable
- approved workflow reuse fails closed if the effective winning recipe artifact changes
- standalone recipe mode and workflow `recipe_ref` mode do not diverge on the same root set

## Hard Constraints

- do not hide collisions behind first-match behavior
- do not weaken version/hash pinning
- do not turn precedence into implicit trust policy

## Stop Conditions

Pause and ask for clarification if:

- a deterministic winner cannot be chosen without policy input that does not exist yet
- resolving this item would require landing org-level root governance from `D0l`
