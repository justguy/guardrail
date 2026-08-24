# Claude Prompt — D0c Template To Recipe Bridge

Audience: Claude or another external coding agent  
Goal: Implement the local-first template bridge so approved manifests can become templates, templates can be listed, and maintained templates can publish through the existing recipe pipeline

## Read First

- `docs/plans/PLAN_template_recipe_bridge.md`
- `docs/github-recipe-distribution.md`
- `docs/technical-status.md`
- `src/template.js`
- `src/template-supervisor.js`
- `src/recipe-publish.js`
- `src/cli.js`
- `tests/test-template.js`
- `tests/test-recipe-publish.js`
- `tests/test-feature-acceptance.js`

## Use Subagents

Use subagents with these write scopes:

- Subagent 1: template creation and local inventory
  - `src/template.js`
  - new helpers such as `src/template-create.js` and `src/template-list.js`
  - template tests
- Subagent 2: publish bridge
  - `src/recipe-publish.js`
  - `src/cli.js`
  - publish/acceptance tests

The integrator owns:

- provenance/hash semantics across the bridge
- `docs/technical-status.md`
- onboarding/README updates if examples change

## Task

Implement:

1. `template create --from-manifest`
2. `template list`
3. `template publish`
4. definition-hash provenance comparison for `_source` metadata

Keep the feature local-first:

- manifest to template first
- template to publish second
- provenance metadata separate from executable template content

## Acceptance Criteria

- an approved manifest can be converted into a starter template without hand-authoring JSON
- local templates can be listed in human and JSON-friendly forms
- `template publish` reuses the existing recipe publish pipeline instead of inventing a second distribution system
- imported/provenance-bearing templates keep honest trust behavior when unchanged and lose inherited trust when edited

## Hard Constraints

- do not reuse execution-instance hashes for provenance
- do not add a second registry or distribution model
- do not silently preserve imported trust after a local edit changes the template definition

## Stop Conditions

Pause and ask for clarification if:

- manifest-to-template inference would require speculative shell parsing
- the bridge would need to widen recipe publish semantics beyond the current reviewed flow
