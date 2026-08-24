# Guardrail — Ship-Now Recipe Launch Batch

Status: Draft implementation plan for the next safe recipe expansion batch  
Audience: Maintainers or external coding agents implementing new built-in recipes  
Goal: Ship a narrow batch of high-signal recipes that fit Guardrail's current model cleanly without waiting for broader policy or enterprise controls

## Objective

Guardrail already ships recipe primitives for git, GitHub, infra, package publishing, and agent wrappers, but there is room for a small expansion batch that still fits the current recipe model honestly.

This plan focuses only on candidates that can be expressed with today's core constraints:

- structured commands only
- bounded inputs with deterministic validation
- existing approval/risk semantics
- no hidden shell fallback
- no requirement for new multi-party approval, secret-write handling, or org-policy features

## Ship-Now Scope

Ship this batch:

- `gh-open-pr`
- `git-clone-allowed`
- `gh-release`
- `docker-build`
- `docker-push`
- `terraform-plan-only`

Do not include in this batch:

- secret mutation flows
- direct push / history rewrite flows
- broad package install flows
- destructive cloud mutation flows
- task-specific OpenClaw wrappers that should really be workflows or templates over the existing wrapper

## Why These Fit Now

These candidates can be modeled as bounded structured recipes with clear allowlists or invariants:

- GitHub repo/org binding
- branch and tag constraints
- registry allowlists
- Docker flag restrictions
- Terraform `plan`-only execution

They do not require Guardrail to invent new approval primitives just to be honest.

## Proposed Recipe Shapes

### `gh-open-pr`

Intent:

- create a PR only in approved repos and only against approved base branches

Must enforce:

- repo input constrained to approved org/repo patterns
- base branch allowlist such as `dev`, `staging`, `release/*`
- title pattern or bounded conventional-title shape
- no public-repo fallback

### `git-clone-allowed`

Intent:

- clone only from approved GitHub org/repo sources

Must enforce:

- host/org allowlist
- no arbitrary protocols or extra hosts
- destination path bounded to caller-approved workspace scope

### `gh-release`

Intent:

- create bounded GitHub releases with environment-aware repo targeting

Must enforce:

- repo/environment binding
- semver tag pattern
- production-targeting repos require explicit approval
- no uncontrolled asset upload paths

### `docker-build`

Intent:

- build bounded container images without unsafe flags or contexts

Must enforce:

- no `--privileged`
- no unsafe context outside the approved workspace
- bounded tag/repository pattern
- keep command shape structured and deterministic

### `docker-push`

Intent:

- push only to approved registries and namespaces

Must enforce:

- registry allowlist
- bounded image/tag patterns
- no public-registry fallback unless explicitly approved by policy

### `terraform-plan-only`

Intent:

- allow infra planning while blocking mutation

Must enforce:

- `plan` path only
- no `apply`, `destroy`, or equivalent mutation actions
- bounded working directory / module path
- environment or workspace input constraints where applicable

## Existing Overlaps To Respect

- do not replace `github-pr-merge`; this batch adds PR creation, not merge automation
- do not replace `infra-deploy`; this batch adds a safer `plan`-only primitive, not another deploy pipeline
- do not replace `openclaw-wrapper`; task-specific agent flows should layer on top of it later

## Likely Files

- `recipes/gh-open-pr.recipe.json`
- `recipes/git-clone-allowed.recipe.json`
- `recipes/gh-release.recipe.json`
- `recipes/docker-build.recipe.json`
- `recipes/docker-push.recipe.json`
- `recipes/terraform-plan-only.recipe.json`
- `src/recipe-index.js` if bundled-index fixtures need updates
- `tests/test-recipe.js`
- `tests/test-recipe-system.js`
- `tests/test-feature-acceptance.js`
- `docs/technical-status.md`
- `docs/agent-onboarding.md`

## Execution Plan

### Phase 1 — Recipe definitions

Tasks:

- add the six recipe JSON definitions
- keep them pure structured-mode recipes
- prefer bounded inputs and guardrail invariants over free-form string inputs

### Phase 2 — Validation and safety proof

Tasks:

- add unit coverage for schema validity and bounded input requirements
- add recipe-system coverage for indexing, inspection, and dry-run behavior
- add acceptance coverage for the unsafe cases each recipe claims to block

### Phase 3 — Docs and examples

Tasks:

- document when to use each recipe
- show one safe example per recipe
- explain which dangerous variants are intentionally out of scope

## Acceptance Criteria

- each new recipe validates and packs cleanly
- dry-run output is honest and bounded
- unsafe variants from the motivating examples are blocked by recipe shape or Guardrail policy
- docs explain the safe intent and the deliberate non-goals

## Non-Goals

- do not add secret-writing recipes here
- do not add direct `git push` or history-rewrite recipes here
- do not add general package-install recipes here
- do not add destructive cloud mutation recipes here
- do not implement new approval-queue or enterprise policy features just to make this batch work

## Stop Conditions

Pause and ask for clarification if:

- a candidate requires free-form shell or host-specific scripting to stay useful
- a candidate cannot be made honest without new approval semantics beyond the current recipe model
- a candidate's "safe version" becomes so narrow that it no longer solves the intended use case
