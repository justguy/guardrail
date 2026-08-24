# Guardrail — Unified Workflow Recipe Discovery

Status: Draft implementation plan for roadmap item `D0d`  
Audience: Maintainers improving workflow portability and recipe resolution  
Goal: Remove manual `--recipe-search-dir` from common cross-repo workflow use while preserving deterministic recipe resolution and drift semantics

## Objective

Standalone recipe mode already resolves installed recipes cleanly. Workflow `recipe_ref` mode still needs explicit `--recipe-search-dir` for cross-repo usage.

This roadmap item makes workflow recipe discovery share the same installed/home/global model as standalone recipe mode so workflows work predictably without local glue.

## Current State

Documented current behavior:

- `workflow lint` and `workflow run` support repeatable `--recipe-search-dir`
- cross-repo workflows rely on those explicit flags today
- workflow manifests pin resolved recipe version/hash after resolution

Current limitation:

- workflows are portable only if the caller remembers the right extra search dirs
- standalone recipe execution and workflow `recipe_ref` do not share one canonical discovery contract

## Resolved Design Choices

1. Unify discovery through one resolver implementation shared by standalone recipe mode and workflow mode.
2. Keep `--recipe-search-dir` as an explicit override, but make it optional for the common case.
3. Preserve deterministic precedence and collision diagnostics.
4. Keep resolved version/hash pinning in workflow manifests unchanged.
5. Treat discovery differences as drift or resolution errors, never silent fallback.

## Proposed V1 Resolution Model

Resolution order:

1. explicit `--recipe-search-dir` roots in caller-supplied order
2. workflow-local or repo-local recipe roots
3. installed/home recipe registry roots already used by standalone recipe mode
4. Guardrail-bundled recipes

Rules:

- first match is not enough if multiple candidates collide; emit a deterministic collision diagnostic
- workflows must record the fully resolved recipe identity, version, and hash after discovery
- non-interactive reuse must fail if discovery now resolves to a different artifact than the approved manifest

## Likely Files

- `src/workflow.js`
- `src/recipe-runner.js`
- `src/recipe-index.js`
- `src/cli.js`
- new helper such as `src/recipe-discovery.js`
- `tests/test-workflow.js`
- `tests/test-recipe-system.js`
- `tests/test-feature-acceptance.js`

## File-By-File Plan

### Phase 1 — Shared discovery helper

Tasks:

- extract recipe discovery into one shared helper
- support explicit roots, installed/home roots, and bundled recipes
- return structured diagnostics on collisions and misses

### Phase 2 — Workflow integration

Tasks:

- switch workflow normalization/resolution to the shared helper
- keep `--recipe-search-dir` wired as highest-priority override
- preserve manifest pinning behavior after resolution

### Phase 3 — Diagnostics and drift semantics

Tasks:

- when multiple roots provide the same recipe id, emit explicit precedence/collision reasons
- when a previously approved workflow now resolves differently, fail closed with honest drift or resolution errors
- include searched roots in machine-readable diagnostics where safe

### Phase 4 — CLI/docs parity

Tasks:

- update onboarding and README examples so `--recipe-search-dir` becomes optional in the common case
- keep the flag documented for overrides, testing, and unusual layouts

## Acceptance Criteria

- a workflow using installed or bundled recipes can lint and run without manual `--recipe-search-dir`
- explicit search dirs still work and override default discovery predictably
- collisions are deterministic and user-visible
- workflow approvals remain pinned to the resolved recipe artifact, not just the recipe id

## Non-Goals

- do not add org policy or enterprise trust-root governance here
- do not weaken current workflow manifest pinning
- do not blur recipe discovery with wrapper portability or provenance policy
