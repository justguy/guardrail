# Guardrail — Workflow `recipe_ref` Review-Each-Time Parity

Status: Draft implementation plan for roadmap item `D0p`  
Audience: Maintainers or coding agents extending workflow mode  
Goal: Make workflow `recipe_ref` reuse honor the same `review_each_time` / `never_reuse` semantics as standalone recipe mode

## Objective

Standalone recipe mode already does the right thing:

- `resolveInputs()` returns flagged inputs
- `recipe-supervisor.js` detects `never_reuse`
- matching manifests still force fresh approval for `review_each_time` inputs

Workflow mode currently falls short:

- `workflow.js` stores `recipeRef.flaggedInputs`
- `workflow-supervisor.js` never uses `flaggedInputs.neverReuse`
- unchanged workflow manifests can therefore be reused non-interactively even when a recipe input was declared `review_each_time`

This is most visible in bundled AI recipes:

- `claude-exec` inline `prompt`
- `claude-exec` `system_prompt`
- `codex-exec` inline `prompt`

## Current State

Relevant files:

- `src/workflow.js`
- `src/workflow-supervisor.js`
- `src/recipe-supervisor.js`
- `recipes/claude-exec.recipe.json`
- `recipes/codex-exec.recipe.json`

Current behavior:

- workflow normalization persists `recipeRef.flaggedInputs`
- workflow drift catches changed `resolvedInputs`
- workflow execution rechecks `inputContentHashes`

Missing behavior:

- unchanged `review_each_time` inputs do not trigger fresh approval in workflow mode

## Resolved Design Choices

1. Match standalone recipe semantics exactly.
2. Do not invent a workflow-only policy model.
3. Treat `review_each_time` as approval-required even when the manifest matches exactly.
4. Make the reason agent-visible in non-interactive mode.
5. Apply this to all `recipe_ref` steps, not just Claude/Codex wrappers.

## Proposed Behavior

If any `recipeRef.flaggedInputs` entry has `neverReuse === true`:

- interactive workflow run:
  - still requires approval even if manifest matches
  - approval summary should mention the affected inputs

- non-interactive workflow run:
  - fail closed with `approval_required`
  - reason should name the recipe step and the flagged inputs

Example reason:

```text
Fresh approval required for workflow recipe_ref inputs: step "review" -> system_prompt, prompt; step "commit-message" -> prompt
```

## Smallest Clean Implementation

Add a workflow-side helper mirroring the recipe supervisor helper:

- `formatWorkflowReviewEachTimeReason(stepDef)`

Then update the approval decision path so a matching manifest still requires approval when any workflow step contains `recipeRef.flaggedInputs` with `neverReuse`.

This should happen before execution begins, not inside `executeRecipeRefStep`.

The helper must scan all workflow steps and aggregate every affected `recipe_ref` step. Use the normalized camelCase field already stored in workflow manifests:

- `recipeRef.flaggedInputs[].neverReuse`

## File-by-File Plan

### Phase 1 — Helper + approval decision

Files:

- `src/workflow-supervisor.js`

Tasks:

- scan `candidate.workflow.steps` for `recipe_ref` entries with `flaggedInputs[].neverReuse`
- compute a stable reason string
- if manifest matches but such inputs exist:
  - treat workflow as `needsApproval = true`
  - in non-interactive mode return `approval_required`

### Phase 2 — UX parity

Files:

- `src/workflow-supervisor.js`
- `src/logger.js` only if a visible approval note is needed

Tasks:

- print the reason during interactive approval
- keep machine-readable `terminalReason` in JSON mode

### Phase 3 — Tests

Files:

- `tests/test-workflow.js`
- `tests/test-integration-runtime.js`
- `tests/test-feature-acceptance.js`

Tasks:

- workflow with `recipe_ref` + `review_each_time` input requires reapproval even when manifest matches exactly
- non-interactive workflow run returns `approval_required` with the correct reason
- multiple `recipe_ref` steps with `neverReuse` inputs are all named in the reason string
- changed prompt-bearing file hashes still continue to use normal drift behavior
- unchanged file-bound inputs remain reusable when they are not `review_each_time`

## Acceptance Criteria

- standalone recipe mode and workflow `recipe_ref` mode behave the same for `review_each_time`
- a workflow with unchanged inline `system_prompt` does not silently reuse approval
- workflow JSON results contain enough detail for an agent to know what must be reapproved
- no regression to content-hash-based reusable inputs like `input_files`

## Non-Goals

- do not add range-based or partial approval reuse here
- do not special-case Claude or Codex recipes
- do not rework the workflow manifest schema beyond using the already-stored `flaggedInputs`

## Review Focus

- ensure the workflow-side helper matches standalone recipe semantics
- ensure the check happens before execution, not after a recipe step starts
- ensure `approval_required` vs `drift_detected` stays consistent and honest
