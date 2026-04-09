# Claude Prompt — A0 Adapter Hardening And MCP Follow-Through

Audience: Claude or another external coding agent  
Goal: Finish the hardening and proof work behind partial items `A0a` through `A0e` without pretending MCP transport support is already safe

## Read First

- `docs/technical-status.md`
- `docs/plans/PLAN_pickup_four_open_items_2026-04-08.md`
- `docs/adapter-implementation-plan.md`
- `docs/agent-onboarding.md`
- `src/adapter-engine.js`
- `src/adapter-cli.js`
- `src/adapter-profile.js`
- `src/adapter-auth.js`
- `src/adapter-stdin.js`
- `src/adapter-shim.js`
- `src/adapter-profiles/openclaw.json`
- `src/adapter-profiles/aider.json`
- `src/adapter-profiles/cline.json`

## Use Subagents

Use subagents with these write scopes:

- Subagent 1: contract/result hardening
  - `src/adapter-engine.js`
  - `src/adapter-cli.js`
  - `src/adapter-profile.js`
  - `tests/test-adapter.js`
- Subagent 2: install/trust proof
  - `src/adapter-profile-install.js`
  - related install/trust helpers
  - `tests/test-gap-closure.js`
  - install-focused adapter tests
- Subagent 3: bundled profile and blocked-MCP proof
  - `src/adapter-profiles/openclaw.json`
  - `src/adapter-profiles/aider.json`
  - `src/adapter-profiles/cline.json`
  - `src/adapter-stdin.js`
  - `src/adapter-shim.js`

The integrator owns:

- `tests/test-integration-runtime.js`
- `docs/technical-status.md`
- `docs/agent-onboarding.md`
- `README.md`

## Task

Implement Track 4 Phases 1 and 2 from the pickup plan, and only the design gate from Phase 3:

1. stabilize the `adapter-result/v1` contract and blocked/failure reasons
2. tighten bounded output and parity with supervisor result shapes
3. strengthen install/pin/trust-policy proof for adapter profiles
4. prove bundled `openclaw` and `aider` profiles end to end
5. keep `cline` and generic `mcp` profiles honestly blocked until transport semantics are fully specified
6. add design-level tests and docs that distinguish:
   - recognized but blocked MCP
   - invalid profile
   - supported non-MCP profile paths

## Acceptance Criteria

- `A0a` through `A0e` move from `Partial` to the strongest defensible status the code actually supports
- machine-readable adapter results are stable on success, block, drift, and auth-preflight failures
- install and trust-policy behavior is covered end to end
- bundled profile execution paths are proven for currently supported transports
- MCP remains explicitly blocked and documented as blocked

## Hard Constraints

- do not ship runnable MCP transport in this slice
- do not silently partially enable `cline`
- do not widen adapter profiles beyond declarative bounded behavior
- do not add external dependencies

## Stop Conditions

Pause and ask for clarification if:

- a requested change would require implementing real MCP transport now
- a profile needs imperative behavior outside the current declarative model
- hardening the contract would break already-documented adapter semantics without a clear migration path
