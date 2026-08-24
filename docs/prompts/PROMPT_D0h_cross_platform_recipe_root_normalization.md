# Claude Prompt — D0h Cross-Platform Recipe-Root And Wrapper-Path Normalization

Audience: Claude or another external coding agent  
Goal: Make workflow recipe discovery and bundled wrapper path handling reliable across Windows, macOS, and Linux without changing Guardrail's fail-closed approval semantics

## Read First

- `docs/technical-status.md`
- `docs/prompts/PROMPT_D0d_unified_workflow_recipe_discovery.md`
- `docs/prompts/PROMPT_D0e_bundled_wrapper_portability.md`
- `src/workflow.js`
- `src/recipe-runner.js`
- wrapper path helpers and wrapper modules
- path-handling helpers in shared modules
- `tests/test-workflow.js`
- wrapper-focused tests

## Use Subagents

Do not run this in parallel with `D0d`, `D0f`, `D0g`, or `D0e`. Reuse the same portability owner for:

- path normalization helpers
- workflow recipe resolution path handling
- bundled wrapper path handling
- cross-platform fixture coverage

## Task

Implement the narrowest honest portability slice:

1. normalize recipe-root paths and wrapper-helper paths consistently across supported host OSes
2. handle separators, drive letters, and relative-root comparisons safely
3. add coverage that proves the discovery and bundled-wrapper paths do not rely on Unix-only assumptions
4. keep approval and drift semantics pinned to normalized canonical paths

## Acceptance Criteria

- recipe-root resolution and wrapper lookup behave predictably across Windows, macOS, and Linux path forms
- path comparisons do not break because of separator or drive-letter differences
- workflow and bundled-wrapper tests include cross-platform path coverage
- normalization does not accidentally widen scope or trust boundaries

## Hard Constraints

- do not add platform-specific shell logic
- do not weaken path validation to make portability tests pass
- do not fork platform behavior unless the underlying path models are genuinely different

## Stop Conditions

Pause and ask for clarification if:

- canonical cross-platform behavior cannot be defined without changing existing approved-manifest semantics
- the repo lacks a safe place to add platform-agnostic path normalization without duplicating logic
