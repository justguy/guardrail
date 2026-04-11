# Guardrail — Enterprise P0f Packet: Model Gateway Seam

Status: Ready  
Audience: Autonomous guarded implementation agent  
Goal: Move model/provider invocation decisions behind one gateway seam

Roadmap anchor: `P0` model gateway; enterprise items `22` and `27`

## Declared Artifact

- `docs/plans/REPORT_enterprise_P0f_model_gateway_seam.md`

## Scope

Add one model-gateway interface that decides model/provider/profile routing even if the initial implementation still delegates to existing wrappers/adapters.

Must include:

- one gateway abstraction
- one provider/model decision path
- integration with existing recipe/adapter AI surfaces

Must not include:

- hosted model registry backend
- BYOM deployment packaging

## Likely Files

- `src/adapter-engine.js`
- `src/adapter-profile.js`
- `src/adapter-cli.js`
- `src/human-domain-routing.js`
- AI wrapper files such as `src/claude-exec-wrapper.js` and `src/codex-exec-wrapper.js`

## Focused Tests

- `tests/test-adapter.js`
- `tests/test-adapter-runtime.js`
- `tests/test-claude-recipe.js`
- `tests/test-feature-acceptance.js` for adapter/AI paths

## Proof Of Done

- recipe/adapter AI flows resolve through the gateway seam
- provider/model routing is no longer scattered across wrappers
- docs explain this as the future BYOM / allowlist seam
- report artifact exists and names every call site moved behind the gateway

## Stop Conditions

Stop and fix before moving on if:

- provider-specific logic remains materially duplicated across execution paths
- the gateway is just a pass-through wrapper with no single decision point
