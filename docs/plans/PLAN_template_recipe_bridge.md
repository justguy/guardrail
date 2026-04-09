# Guardrail — Template To Recipe Bridge

Status: Draft implementation plan for roadmap item `D0c`  
Audience: Maintainers extending local-first authoring flows  
Goal: Turn approved manifests into reusable templates, list local templates, publish templates through the existing recipe pipeline, and preserve honest trust/provenance behavior

## Objective

Guardrail already has:

- approved command/workflow/template manifests
- template execution and approval
- recipe publish/install flows

What it does not have is the local-first bridge described in `docs/github-recipe-distribution.md`:

1. `template create --from-manifest`
2. `template publish`
3. `template list`
4. trust-hash comparison for imported or published template provenance

This feature closes the gap between “I have a working approved manifest” and “I want a reusable, parameterized artifact I can refine and eventually publish.”

## Current State

Documented sources of truth:

- `docs/github-recipe-distribution.md`
- `docs/technical-status.md`

Current behavior:

- templates can be authored and run directly
- recipes can be published and installed
- imported recipe-to-template trust behavior is described in docs, but the full bridge flow is not implemented

Current limitation:

- a user with a good `.guardrail/approved.json` still has to write template JSON by hand
- local template inventory is not surfaced by CLI
- publishing starts from manifests, not from maintained templates

## Resolved Design Choices

1. Keep the bridge local-first: manifests become templates first, then templates can become recipes.
2. Make `template publish` a thin wrapper over the existing recipe publish flow rather than a separate distribution system.
3. Treat `_source` metadata as provenance metadata, not template content.
4. Use template-definition hashing for provenance comparison; do not reuse execution-instance hashing.
5. Fail closed on provenance drift, but keep local editing easy and explicit.

## Proposed V1 Commands

### `template create --from-manifest`

Purpose:

- convert an approved manifest into a starter template

Behavior:

- load the approved manifest
- infer parameterizable fields from resolved args and path-like values
- write `.guardrail/templates/<name>.json`
- lint the generated template before returning

### `template list`

Purpose:

- show local templates in `.guardrail/templates/`

Behavior:

- list id/name/path/trust class/source metadata
- support JSON output for agents
- clearly show whether a template has `_source` provenance metadata

### `template publish`

Purpose:

- publish a maintained template using the existing recipe publish pipeline

Behavior:

- load template
- resolve to recipe payload or manifest-like intermediate
- delegate to recipe publish logic
- preserve current lint/scrub/trust behavior

### Trust-hash comparison

Purpose:

- preserve honest provenance for imported templates

Behavior:

- if a template has `_source`, compare definition hash excluding `_source`
- unchanged imported template inherits source trust
- edited template becomes local work and requires fresh local approval semantics

## Likely Files

- `src/cli.js`
- `src/template.js`
- `src/template-supervisor.js`
- `src/recipe-publish.js`
- new helper such as `src/template-create.js`
- new helper such as `src/template-list.js`
- `tests/test-template.js`
- `tests/test-feature-acceptance.js`
- `tests/test-recipe-publish.js`

## File-By-File Plan

### Phase 1 — Template creation from approved manifest

Tasks:

- add CLI parsing for `template create --from-manifest`
- load and validate approved manifest path
- infer a minimal valid template shape
- write output into `.guardrail/templates/`
- lint generated template and surface warnings clearly

### Phase 2 — Local template inventory

Tasks:

- add `template list`
- scan `.guardrail/templates/`
- show source/provenance metadata, trust class, and template path
- add JSON output for agent callers

### Phase 3 — Template publish bridge

Tasks:

- add `template publish`
- map template source into the existing recipe publish pipeline
- preserve existing publish constraints and metadata scrubbing
- keep the implementation thin so one publish path remains authoritative

### Phase 4 — Trust-hash comparison

Tasks:

- add template-definition hashing that explicitly excludes `_source`
- compare imported-template provenance at approval time
- surface clear user-visible reason when an imported template has been modified

## Acceptance Criteria

- a user can create a valid template from an approved manifest without hand-authoring JSON
- `template list` shows local templates and provenance status
- `template publish` uses the existing recipe publish path instead of a duplicate system
- imported templates preserve source trust only while unchanged

## Non-Goals

- do not add a separate template registry
- do not add arbitrary manifest-to-template inference heuristics beyond bounded obvious cases
- do not mix execution-instance hashing with template-definition provenance hashing
