# Claude Prompt — D0d Unified Workflow Recipe Discovery

Audience: Claude or another external coding agent  
Goal: Make workflow `recipe_ref` discovery share the same installed/home/global model as standalone recipe mode, while preserving explicit overrides and deterministic diagnostics

## Read First

- `docs/plans/PLAN_unified_workflow_recipe_discovery.md`
- `docs/technical-status.md`
- `src/workflow.js`
- `src/recipe-runner.js`
- `src/recipe-index.js`
- `src/cli.js`
- `tests/test-workflow.js`
- `tests/test-recipe-system.js`
- `tests/test-feature-acceptance.js`

## Use Subagents

Use subagents with these write scopes:

- Subagent 1: shared discovery helper
  - new helper such as `src/recipe-discovery.js`
  - `src/recipe-runner.js`
  - `src/recipe-index.js`
- Subagent 2: workflow integration and diagnostics
  - `src/workflow.js`
  - `src/cli.js`
  - workflow/discovery tests

The integrator owns:

- collision diagnostics and final precedence semantics
- docs updates for the new common-case behavior

## Task

Implement the unified discovery model:

1. explicit `--recipe-search-dir` roots stay highest priority
2. workflow-local or repo-local roots come next
3. installed/home recipe roots used by standalone mode come next
4. bundled recipes remain available

Make misses and collisions explicit. Preserve workflow manifest pinning to the resolved artifact.

## Acceptance Criteria

- workflows using installed or bundled recipes can lint and run without manual `--recipe-search-dir` in the common case
- explicit search dirs still override defaults deterministically
- collisions produce user-visible structured diagnostics
- an approved workflow fails closed if discovery now resolves to a different artifact than the pinned manifest

## Hard Constraints

- do not weaken workflow recipe hash/version pinning
- do not blur recipe discovery with wrapper portability or provenance policy
- do not add external dependencies

## Stop Conditions

Pause and ask for clarification if:

- the current standalone resolver cannot be unified without breaking documented standalone behavior
- collision handling cannot be made deterministic with the available root metadata
