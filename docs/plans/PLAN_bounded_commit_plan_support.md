# Guardrail — Bounded Commit-Plan Support

Status: Draft implementation plan for roadmap item `D0j1`  
Audience: Maintainers or coding agents extending Guardrail's workflow + recipe system  
Goal: Let a workflow propose a commit slice after unknown-file edits settle, then require human approval of that bounded slice before any commit runs

## Objective

Guardrail already supports:

- `recipe_ref` workflow chaining under one workflow approval
- exact-path `git-commit` via `recipes/git-commit.recipe.json`
- content-hash binding for prompt-bearing files and commit message files

What it does **not** support yet is the gap between:

1. an agent does work and the final changed file set is not known up front
2. Guardrail must still refuse to "commit whatever changed"

This plan adds a bounded commit-plan artifact so a workflow can stop with a proposed file set, let a human review and approve that specific slice, and then execute commit only within that approved slice.

## Current State

Relevant files:

- `src/git-commit-wrapper.js`
- `recipes/git-commit.recipe.json`
- `src/recipe-supervisor.js`
- `src/workflow.js`
- `src/workflow-supervisor.js`
- `src/prompt-inputs.js`

Current behavior:

- `git-commit` stages only an exact approved `paths` list and commits from a hashed `message_file`
- `recipe_ref` already pins recipe version/hash and hashes `content_hash` inputs
- workflow approval already gives one approval unit over multiple bounded recipe executions

Current limitation:

- if a prior step edits an unknown set of files, Guardrail has no native artifact for "these are the proposed files, within these bounds, now let the human bless that exact slice"

## Resolved Design Choices

1. Keep existing `git-commit` unchanged. It remains the exact-path primitive.
2. Add a new bounded artifact instead of widening `git-commit` into an implicit "commit changed files" recipe.
3. Add a new recipe `git-commit-from-plan` for the bounded-plan path.
4. Treat the commit plan as a first-class input file with content hashing and pre-execution recheck.
5. Make `message_file` an explicit second recipe input with `content_hash: true`; the wrapper must reject any mismatch between the plan's `message_file` field and the recipe input value.
6. Store the resolved approved file list in the manifest or approval summary path so non-interactive reuse stays exact and deterministic.
7. Fail closed if the plan file, message file, repo path, bounds, or resolved file set changes.
8. Do not add `git push` or branch mutation in this feature.

## Proposed V1 Artifact

Add a checked-in or generated JSON file, for example:

- `.guardrail/commit-plans/auth-slice.json`

Schema:

```json
{
  "version": 1,
  "kind": "commit_plan",
  "repo_path": ".",
  "summary": "Auth redirect stabilization slice",
  "paths": [
    "src/routes/auth.js",
    "tests/integration/authRedirectFlow.test.js"
  ],
  "message_file": ".guardrail/commit-messages/auth-slice.txt",
  "bounds": {
    "allowed_roots": ["src/routes", "tests/integration"],
    "max_files": 5
  }
}
```

## V1 Validation Rules

Plan validation must enforce:

- `version === 1`
- `kind === "commit_plan"`
- `repo_path` is a relative path with the same path-policy rules as current git recipes
- `paths` is a non-empty array of relative paths
- every path is unique
- every path is inside one of `bounds.allowed_roots`
- `paths.length <= bounds.max_files`
- `message_file` is a relative path
- no globs, no `..`, no absolute paths

This keeps the plan bounded even before approval.

## Approval Model

Interactive flow:

1. workflow or operator produces a commit plan file
2. Guardrail runs `git-commit-from-plan`
3. Guardrail loads the plan, validates it, resolves the exact path list, hashes the plan file, and hashes the `message_file`
4. approval summary shows:
   - repo path
   - proposed file list
   - allowed roots
   - max files
   - message file path
5. user approves or denies

Persisted approval stores:

- recipe version/hash
- plan file path
- plan file content hash
- resolved `repo_path`
- resolved exact `paths`
- resolved `message_file`
- `message_file` content hash
- bounds metadata used for the approval

Non-interactive reuse is allowed only if:

- plan file content hash still matches
- message file content hash still matches
- plan still validates
- resolved file list matches the approved manifest exactly

## Execution Model

### New helper module

Add `src/commit-plan.js` with:

- `loadCommitPlan(path, cwd)`
- `validateCommitPlan(plan)`
- `normalizeCommitPlan(plan, cwd)`
- `hashCommitPlan(plan)`
- `compareCommitPlans(candidate, approved)`

### New wrapper

Add `src/git-commit-plan-wrapper.js` with structured args only:

- `--repo-path`
- `--plan-file`

Runtime behavior:

1. parse and validate plan
2. resolve repo + exact paths + message file
3. stage only `plan.paths`
4. run `git commit -F <message_file>`

No shell and no path discovery at execution time beyond the approved plan file.

### New recipe

Add `recipes/git-commit-from-plan.recipe.json`

Inputs:

- `guardrail_repo`
- `plan_file` with `content_hash: true`
- `message_file` with `content_hash: true`

The recipe description and constraints must state:

- commit scope comes only from the approved plan file
- plan file is content-hash bound at approval time
- commit message file is content-hash bound as an explicit recipe input
- wrapper rejects any `plan.message_file !== recipe_input.message_file`
- no push

## Workflow Integration

The intended flow is:

1. workflow runs analysis/edit steps
2. one step writes a proposed commit-plan artifact and message file
3. workflow stops before commit or branches into a commit gate
4. human reviews the plan artifact
5. Guardrail runs `git-commit-from-plan`

This can be expressed either as:

- a separate explicit recipe run after the fix workflow, or
- a second workflow whose first step is a reviewed `recipe_ref` to `git-commit-from-plan`

V1 should **not** auto-approve a generated plan in the same workflow run that created it. Treat this as a workflow design constraint and documentation requirement unless a separate runtime enforcement mechanism is added later.

## Drift Rules

Treat each of the following as drift:

- changed plan file content hash
- changed message file content hash
- changed `repo_path`
- changed `paths`
- changed `allowed_roots`
- changed `max_files`
- changed recipe version/hash

Guardrail should report these as manifest diffs, not silently recompute and continue.

## File-by-File Execution Plan

### Phase 1 — Commit plan core

Files:

- `src/commit-plan.js`
- tests: `tests/test-commit-plan.js`

Tasks:

- implement schema validation
- normalize relative paths
- compare approved vs candidate plan material
- expose a helper that resolves the exact approved `paths` array from the plan without CSV conversion

### Phase 2 — Recipe + wrapper

Files:

- `src/git-commit-plan-wrapper.js`
- `recipes/git-commit-from-plan.recipe.json`
- tests: `tests/test-git-commit-plan-recipe.js`

Tasks:

- execute exact-path commit from a plan file
- require explicit `message_file` recipe input and verify it matches the plan
- keep `git-commit` unchanged
- ensure structured-only execution

### Phase 3 — Approval and manifest reuse

Files:

- `src/recipe-supervisor.js`
- `src/prompt-inputs.js` if small helper extraction is needed
- tests: `tests/test-integration-runtime.js`

Tasks:

- hash and recheck the plan file
- hash and recheck the explicit `message_file` recipe input
- surface plan-derived approval summary fields

### Phase 4 — Workflow chain coverage

Files:

- `src/workflow.js`
- `src/workflow-supervisor.js`
- tests: `tests/test-workflow.js`
- tests: `tests/test-feature-acceptance.js`

Tasks:

- verify `recipe_ref` can pin and recheck `git-commit-from-plan`
- document the two-phase "fix then commit" flow honestly

## Acceptance Criteria

- a valid commit plan can be approved interactively and reused non-interactively
- changing only the plan file contents triggers drift
- changing only the message file contents triggers drift
- a plan with paths outside approved roots is rejected before approval
- a plan exceeding `max_files` is rejected before approval
- workflow `recipe_ref` can chain into `git-commit-from-plan` under one workflow approval, but only after the bounded plan artifact is already the approved input
- no implementation path ever falls back to "stage all changed files"

## Non-Goals

- no `git push`
- no branch creation
- no automatic path discovery from `git status` inside the commit step
- no approval of arbitrary globs in v1
- no same-run auto-approval of a freshly generated commit plan unless a later feature adds an explicit enforcement mechanism

## Review Focus

Before implementation is accepted, review should specifically trace:

- plan validation vs path escape/root-limit edge cases
- manifest comparison fields for plan drift
- message file hash recheck before execution through an explicit hashed recipe input
- workflow `recipe_ref` behavior for plan-file drift
- any place the code could accidentally widen from exact plan paths to ambient repo changes
