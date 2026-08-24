# Guardrail — Transport + Exec Recipe Composition

Status: Partially landed implementation plan for roadmap item `D0q`  
Audience: Maintainers extending recipe/runtime composition  
Goal: Let Guardrail compose a transport/orchestration layer and an exec recipe into one honest approval unit without hiding either boundary

## Objective

Guardrail already supports:

- standalone recipes
- workflow `recipe_ref` chaining under one workflow approval
- explicit transport/orchestration recipes such as `cmux-claude-exec`

What it does not support cleanly today is the common case where:

1. the real tool must run in a different host runtime
2. the transport hop should be explicit and bounded
3. the user still wants one coherent approval surface rather than nested `guardrail run` prompts

Today that shape is implemented by launching an inner `guardrail run --recipe <exec>` from an outer transport recipe. That is honest, but it creates two approval units, two manifests, and user confusion.

Current landed proof:

- bundled `cmux-claude-exec` now uses the composed path instead of launching a nested inner Guardrail CLI run
- one approval manifest covers the explicit `cmux` transport layer plus the composed `claude-exec` contract
- the supervisor binds child recipe trust, env intersection, input hashes, and session enforcement into the outer manifest

What remains open is generalizing that composition shape into a broader reusable artifact/CLI surface rather than one bundled proof recipe.

## Current Limitation

Current nested behavior:

- outer transport/orchestration recipe approval
- inner exec recipe approval
- separate manifests for outer and inner runs
- repeated `review_each_time` prompts on the inner run
- no single artifact that says "run this bounded tool through this bounded host-runtime hop"

This is acceptable for proof and debugging, but poor as a common agent-facing flow.

## Design Goals

1. Keep transport explicit. Do not hide host-runtime hops behind an exec recipe.
2. Keep exec semantics honest. Inner recipe schema, trust, env requirements, content hashes, and `review_each_time` rules must still apply.
3. Produce one supervisor-managed approval contract for the composed run.
4. Avoid nested `guardrail run` inside another Guardrail-managed approval path.
5. Keep standalone transport recipes and standalone exec recipes usable on their own.
6. Make the feature generic across terminal surfaces, remote shells, containers, CI launchers, and similar host-runtime boundaries.

## Non-Goals

- Do not weaken `review_each_time`.
- Do not auto-approve community or unverified exec recipes because the transport layer was approved.
- Do not turn transport recipes into arbitrary shell tunnels.
- Do not special-case one launcher/runtime.

## Proposed V1 Shape

Recommended approach:

- add a first-class composition artifact or supervisor path that references:
  - one transport/orchestration recipe
  - one exec recipe
  - explicit input mapping for each layer
- resolve both artifacts before execution
- merge the approval surface into one summary and one manifest
- execute the transport layer directly with the exec contract passed as structured data, not as a nested CLI invocation

The composed approval should include:

- transport recipe id/version/hash/channel/trust
- exec recipe id/version/hash/channel/trust
- declared env requirements from both layers
- input hashes and bounded envelopes from both layers
- any `review_each_time` inputs from either layer

## Why Existing Features Are Not Enough

### Standalone nested recipes

- honest, but doubles approval prompts
- produces separate manifests and state
- encourages agents to think in nested `guardrail run` calls instead of one bounded contract

### Workflow `recipe_ref`

- good for "one approval covers several bounded recipe executions"
- not enough by itself for host-runtime transport, because the transport layer still needs a way to execute the inner recipe in another runtime without turning back into nested Guardrail CLI calls
- `review_each_time` parity is correctly enforced, so workflow chaining does not eliminate prompt-bearing reapproval

### Local templates

- useful for fixing a stable prompt or env shape
- do not by themselves solve the "transport recipe + exec recipe under one approval" problem unless Guardrail can compile both layers into one artifact

## Likely V1 Surfaces

Possible user-facing shapes:

1. a new local composition artifact under `.guardrail/`
2. an extension to templates that can bind a transport layer to an exec recipe
3. a workflow-level transport binding for `recipe_ref`

Recommendation:

- prefer a local-first composition artifact or template extension over teaching recipes to shell out to nested Guardrail runs
- keep workflow support as a later integration target once the single composed contract exists

## Likely Files

- `src/cli.js`
- `src/recipe.js`
- `src/recipe-supervisor.js`
- `src/recipe-executor.js`
- `src/template.js` or a new composition helper if templates become the host artifact
- `tests/test-recipe.js`
- `tests/test-template.js`
- `tests/test-integration-runtime.js`

## Acceptance Criteria

- a composed transport+exec run shows one approval summary
- one approved manifest can be reused for the composed run when no drift occurs
- drift in either transport or exec layer blocks reuse
- `review_each_time` in either layer still forces fresh approval
- trust/channel policy changes in either layer block reuse
- the execution path does not spawn a nested `guardrail run` process
- standalone transport recipes and standalone exec recipes still work unchanged

## Rollout Notes

- start with one bundled transport+exec pairing as proof
- keep the nested pattern documented only for transport recipes that still launch inner Guardrail runs
- once the composed path lands, update onboarding to prefer it for common host-runtime hops
