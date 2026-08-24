# Claude Prompt — D0e Bundled Wrapper Portability

Audience: Claude or another external coding agent  
Goal: Remove manual `guardrail_repo` plumbing for Guardrail-shipped wrapper recipes by resolving bundled wrapper helpers from the active Guardrail install/runtime

## Read First

- `docs/plans/PLAN_bundled_wrapper_portability.md`
- `docs/technical-status.md`
- `recipes/git-commit.recipe.json`
- `recipes/codex-exec.recipe.json`
- `recipes/claude-exec.recipe.json`
- `src/git-commit-wrapper.js`
- `src/codex-exec-wrapper.js`
- `src/claude-exec-wrapper.js`
- `src/recipe.js`
- `tests/test-git-commit-recipe.js`
- `tests/test-codex-recipe.js`
- `tests/test-claude-recipe.js`

## Use Subagents

Use subagents with these write scopes:

- Subagent 1: bundled wrapper path helper
  - new helper such as `src/bundled-wrapper-path.js`
  - wrapper modules
- Subagent 2: bundled recipe cleanup and compatibility bridge
  - `recipes/git-commit.recipe.json`
  - `recipes/codex-exec.recipe.json`
  - `recipes/claude-exec.recipe.json`
  - recipe tests

The integrator owns:

- compatibility behavior for old manifests
- docs and onboarding updates

## Task

Implement a runtime-local bundled-wrapper resolver and use it to make fresh bundled wrapper runs work without `guardrail_repo`.

Preserve a migration-friendly path where practical for old manifests, but make the new steady-state path caller-independent.

## Acceptance Criteria

- fresh bundled wrapper recipe runs succeed without `guardrail_repo`
- cross-repo workflows using bundled wrapper recipes no longer need Guardrail checkout path plumbing
- older manifests either still work or fail with a clear migration message
- docs stop teaching `guardrail_repo` as the normal path

## Hard Constraints

- do not generalize this to arbitrary external recipes
- do not couple this item to wrapper provenance policy; that belongs to `D0k`
- do not shell out to ad hoc path discovery

## Stop Conditions

Pause and ask for clarification if:

- bundled-path resolution cannot be made deterministic across the supported runtime layouts
- backward compatibility would require silently honoring untrusted caller paths indefinitely
