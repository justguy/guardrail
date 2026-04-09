# Guardrail — Bundled Wrapper Portability

Status: Draft implementation plan for roadmap item `D0e`  
Audience: Maintainers improving cross-repo agent workflows  
Goal: Remove manual `guardrail_repo` plumbing for Guardrail-shipped wrapper recipes so bundled wrappers are discoverable from the installed Guardrail runtime itself

## Objective

Several bundled recipes depend on helper scripts inside the Guardrail checkout:

- `git-commit`
- `codex-exec`
- `claude-exec`

Today callers pass `guardrail_repo` so recipes can locate wrapper helpers under `src/`. That is workable inside one repo, but awkward and brittle for cross-repo workflows.

This roadmap item makes bundled wrappers portable by resolving them from the Guardrail installation/runtime instead of from a caller-supplied repository path.

## Current State

Documented current behavior:

- bundled wrapper recipes expose `guardrail_repo` inputs
- README and onboarding examples tell callers to pass `guardrail_repo=.`
- cross-repo workflows therefore need both recipe discovery and wrapper-location plumbing

Current limitation:

- a recipe may resolve successfully but still require manual knowledge of where the Guardrail checkout lives
- bundled recipes behave less like installed product features and more like local path conventions

## Resolved Design Choices

1. Bundled wrapper lookup should come from the running Guardrail installation, not from user input.
2. This change applies only to Guardrail-shipped wrapper recipes, not arbitrary external recipes.
3. Preserve backward compatibility for existing approved manifests where practical, but make `guardrail_repo` unnecessary in the steady state.
4. Keep wrapper resolution structured and local; do not shell out to `which` or similar ad hoc discovery.
5. Keep provenance coupling work separate from this feature; that is `D0k`.

## Proposed V1 Design

Add a runtime helper that resolves bundled wrapper helper paths relative to the active Guardrail install/package location.

Then:

- bundled recipe definitions stop requiring `guardrail_repo` as a caller input
- wrappers are referenced through a stable internal resolver
- user-facing examples omit `guardrail_repo`

Compatibility path:

- allow `guardrail_repo` temporarily if old manifests still include it
- mark it deprecated in recipe/docs output until old approvals are rotated out

## Likely Files

- `recipes/git-commit.recipe.json`
- `recipes/codex-exec.recipe.json`
- `recipes/claude-exec.recipe.json`
- `src/git-commit-wrapper.js`
- `src/codex-exec-wrapper.js`
- `src/claude-exec-wrapper.js`
- new helper such as `src/bundled-wrapper-path.js`
- `src/recipe.js`
- `tests/test-git-commit-recipe.js`
- `tests/test-codex-recipe.js`
- `tests/test-claude-recipe.js`
- `README.md`
- `docs/agent-onboarding.md`

## File-By-File Plan

### Phase 1 — Internal bundled-wrapper resolution

Tasks:

- add one helper to resolve Guardrail-shipped wrapper files from the active install
- keep resolution local, deterministic, and platform-safe
- expose a small API recipes/helpers can call without caller path knowledge

### Phase 2 — Bundled recipe cleanup

Tasks:

- update bundled wrapper recipes to stop requiring `guardrail_repo`
- keep runtime compatibility for older manifests if needed
- make the new path the default for fresh approvals

### Phase 3 — Workflow and cross-repo ergonomics

Tasks:

- update examples and workflow snippets to omit `guardrail_repo`
- verify bundled `recipe_ref` use no longer needs manual Guardrail checkout plumbing once discovery resolves the recipe

### Phase 4 — Regression coverage

Tasks:

- add tests for bundled wrapper execution without `guardrail_repo`
- keep compatibility coverage for old manifests if a deprecation bridge is implemented
- verify cross-repo recipe usage does not regress

## Acceptance Criteria

- fresh runs of bundled wrapper recipes work without `guardrail_repo`
- cross-repo workflows using bundled wrapper recipes no longer need to pass a Guardrail checkout path
- older approved manifests either keep working or fail with a clear, migration-friendly message
- docs/examples stop teaching `guardrail_repo` as the normal path

## Non-Goals

- do not solve wrapper/version provenance policy here; keep that in `D0k`
- do not generalize this feature to external community recipes
- do not couple bundled wrapper lookup to enterprise registry or policy work
