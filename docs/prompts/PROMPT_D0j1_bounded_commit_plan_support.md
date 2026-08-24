# Claude Prompt — D0j1 Bounded Commit-Plan Support

Audience: Claude or another external coding agent  
Goal: Add a bounded commit-plan artifact and `git-commit-from-plan` flow so Guardrail can approve a reviewed commit slice without ever falling back to “commit whatever changed”

## Read First

- `docs/plans/PLAN_bounded_commit_plan_support.md`
- `docs/plans/PLAN_bounded_commit_plan_claude_review.md`
- `docs/technical-status.md`
- `recipes/git-commit.recipe.json`
- `src/git-commit-wrapper.js`
- `src/recipe-supervisor.js`
- `src/workflow.js`
- `src/workflow-supervisor.js`
- `src/prompt-inputs.js`
- `tests/test-git-commit-recipe.js`
- `tests/test-integration-runtime.js`

## Use Subagents

Use subagents with these write scopes:

- Subagent 1: commit-plan helper and schema/manifest semantics
  - new helper such as `src/commit-plan.js`
  - recipe-supervisor/manifest wiring
- Subagent 2: recipe and wrapper implementation
  - new `git-commit-from-plan` recipe
  - wrapper updates
  - recipe-focused tests
- Subagent 3: workflow integration and integration tests
  - `src/workflow.js`
  - `src/workflow-supervisor.js`
  - `tests/test-integration-runtime.js`

The integrator owns:

- docs/technical status and onboarding updates
- final exact approval summary behavior

## Task

Implement the bounded-plan path described in the plan doc:

1. add a first-class `commit_plan` artifact with validation, normalization, hashing, and comparison
2. add `git-commit-from-plan` as a new exact bounded recipe path
3. bind approval to:
   - plan file path and content hash
   - resolved repo path
   - resolved exact file list
   - message file path and content hash
   - bounds metadata
4. ensure non-interactive reuse stays exact and deterministic
5. keep existing `git-commit` unchanged as the exact-path primitive

## Acceptance Criteria

- Guardrail can approve and execute a bounded commit slice from a validated plan artifact
- no path exists that stages or commits arbitrary changed files
- plan drift, message drift, repo drift, or resolved-file drift all fail closed
- workflow-chained usage is covered by tests

## Hard Constraints

- do not widen `git-commit` into “commit changed files”
- do not add push or branch mutation
- do not add shell fallback

## Stop Conditions

Pause and ask for clarification if:

- the only viable design would commit files that were not explicitly resolved into the approved manifest
- plan validation cannot be made deterministic before approval
