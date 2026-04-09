# Claude Prompt — Ship-Now Guardrail Recipe Launch Batch

Audience: Claude or another external coding agent  
Goal: Implement the next safe built-in recipe batch without widening Guardrail's current safety or approval model

## Read First

- `docs/plans/PLAN_recipe_launch_batch_ship_now_2026-04-09.md`
- `docs/technical-status.md`
- existing bundled recipes under `recipes/`
- `src/recipe.js`
- `src/recipe-index.js`
- `tests/test-recipe.js`
- `tests/test-recipe-system.js`
- `tests/test-feature-acceptance.js`

## Use Subagents

Use subagents with these write scopes:

- Subagent 1: GitHub lane
  - `recipes/gh-open-pr.recipe.json`
  - `recipes/gh-release.recipe.json`
  - related recipe tests
- Subagent 2: clone + container lane
  - `recipes/git-clone-allowed.recipe.json`
  - `recipes/docker-build.recipe.json`
  - `recipes/docker-push.recipe.json`
  - related recipe tests
- Subagent 3: infra lane
  - `recipes/terraform-plan-only.recipe.json`
  - related recipe tests

The integrator owns:

- `tests/test-recipe-system.js`
- `tests/test-feature-acceptance.js`
- docs updates
- any bundled recipe index or listing updates

## Task

Implement the ship-now batch from the plan doc:

- `gh-open-pr`
- `git-clone-allowed`
- `gh-release`
- `docker-build`
- `docker-push`
- `terraform-plan-only`

Requirements:

- keep every recipe in structured mode
- prefer bounded enums, patterns, ranges, and explicit allowlists
- avoid wrappers unless the recipe model cannot honestly express the safe shape without one
- write tests that prove the blocked variants, not just the happy path

## Hard Constraints

- do not add secret-writing recipes in this batch
- do not add `git push` or history-mutation recipes in this batch
- do not add general `npm install` or `pip install` recipes in this batch
- do not add destructive cloud mutation recipes in this batch
- do not use shell-mode recipes

## Acceptance Criteria

- all six recipes validate and pack
- tests cover both safe and unsafe variants
- docs explain what each recipe is for and what it deliberately does not allow
- `docs/technical-status.md` reflects the new recipe expansion state accurately

## Stop Conditions

Pause and ask for clarification if:

- a recipe requires new approval semantics not already present in Guardrail
- a safe recipe shape cannot be expressed without free-form shell or hidden wrapper logic
- a candidate's safe form is too narrow to justify shipping
