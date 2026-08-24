# Report: Enterprise P0a — Universal Authorization Seam

Status: Done  
Date: 2026-04-11  
Packet: `docs/plans/PLAN_enterprise_P0a_universal_authorization_seam.md`

## Outcome

Shipped one shared `authorize(action, facts)` boundary in [src/authorization.js](/Users/adilevinshtein/Documents/dev/Guardian/src/authorization.js) and routed the following execution surfaces through it:

- command supervisor
- recipe auth/runtime gates
- workflow runtime gate
- workflow `recipe_ref` auth gate
- template runtime gate
- adapter auth/env preflight
- resident-lane startup lock gate

The seam now returns one normalized result shape:

- `allowed`
- `decision`
- `code`
- `reason`
- `trace`
- optional `release`
- optional `envIntersection`

## Touched Files

- [src/authorization.js](/Users/adilevinshtein/Documents/dev/Guardian/src/authorization.js)
- [src/supervisor.js](/Users/adilevinshtein/Documents/dev/Guardian/src/supervisor.js)
- [src/recipe-supervisor.js](/Users/adilevinshtein/Documents/dev/Guardian/src/recipe-supervisor.js)
- [src/workflow-supervisor.js](/Users/adilevinshtein/Documents/dev/Guardian/src/workflow-supervisor.js)
- [src/template-supervisor.js](/Users/adilevinshtein/Documents/dev/Guardian/src/template-supervisor.js)
- [src/adapter-engine.js](/Users/adilevinshtein/Documents/dev/Guardian/src/adapter-engine.js)
- [src/resident-lane-core.js](/Users/adilevinshtein/Documents/dev/Guardian/src/resident-lane-core.js)
- [tests/test-authorization.js](/Users/adilevinshtein/Documents/dev/Guardian/tests/test-authorization.js)
- [tests/test-claude-recipe.js](/Users/adilevinshtein/Documents/dev/Guardian/tests/test-claude-recipe.js)
- [package.json](/Users/adilevinshtein/Documents/dev/Guardian/package.json)

## Review Findings

Claude landed a useful partial implementation, but it did not fully close the packet without review/fix.

Gaps corrected in the main review pass:

1. resident-lane startup was not wired through the new seam
2. adapter blocked reasons regressed and dropped the machine-readable code string expected by existing acceptance coverage
3. the packet report never advanced from `STARTED` to a truthful final status

Those issues were fixed before closing this packet.

## Focused Proof

Passed:

- `node --test tests/test-authorization.js tests/test-claude-resident-lane.js tests/test-bucket5.js tests/test-bucket6.js tests/test-claude-recipe.js tests/test-adapter.js`
- `node --test --test-name-pattern "adapter preflight enforces requires_env before execution|adapter preflight blocks missing auth prerequisite checks via API path|returns scope conflict warnings in the launch summary when overlapping lanes are warn-only|blocks lane startup when requested resource claims overlap a block-owned live lane|fails closed when a startup lock already exists for the requested lane" tests/test-feature-acceptance.js tests/test-claude-resident-lane.js`

## Fire-Trial Issues Exposed

This packet surfaced real product issues in Guardrail’s Claude execution path:

1. stale installed recipe metadata in `~/.guardrail/recipes` can invalidate guarded runs until reinstalled
2. the generic 60000ms worker timeout was too short for packet-sized Claude CLI execution
3. `mode=default` was not suitable for unattended edit-bearing Claude packets
4. one-shot `claude --print` needs a progress heartbeat beyond final stdout

Those issues informed follow-up recipe/doc fixes during the fire trial.

## Remaining Work

`P0a` is closed.

What remains for the broader enterprise item is `P0b`:

- policy simulation
- decision-trace explain surfaces
- operator-facing “what would this do?” output
