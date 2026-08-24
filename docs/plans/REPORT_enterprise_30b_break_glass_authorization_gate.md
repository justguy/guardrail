## REPORT_enterprise_30b_break_glass_authorization_gate

**Status: COMPLETE**

**Roadmap Anchor:** enterprise-30-break-glass-rollout

## Goal

Gate `guardrail lane revoke` and `guardrail lane kill` behind a real local authorization seam instead of allowing any caller to invoke break-glass controls.

## Implementation

The smallest persisted operator identity source already present in Guardrail was the active profile. This slice extends that surface with `operator_role` and uses existing RBAC primitives to enforce an admin-only emergency permission before either emergency command executes.

### Profile-backed operator role

- `src/profile.js`
  - adds optional `operator_role` validation
  - built-in profiles now carry operator roles:
    - `cautious-dev` → `developer`
    - `fast-ci` → `developer`
    - `prod-safe` → `admin`
- `src/cli.js`
  - `guardrail profile create` now accepts `--role`
  - custom profiles persist `operator_role`
  - `profile list` now displays the role for each profile

### Emergency RBAC permission

- `src/rbac.js`
  - adds `emergency_control`
  - minimum role: `admin`

### CLI authorization gate

- `src/cli.js`
  - adds `authorizeEmergencyLaneAction()`
  - reads the active profile via `getActiveProfile()`
  - resolves the operator role from `profile.operator_role`
  - enforces `emergency_control` through existing RBAC helpers before:
    - `guardrail lane revoke`
    - `guardrail lane kill`
  - applies to both:
    - single-target commands
    - bulk `--all` commands

### Audit trail

- successful checks append:
  - `rbac_check` with `status: allowed`
- denied checks append:
  - `rbac_check` with `status: blocked`
  - `emergency_denied`
- `src/event-schema.js`
  - adds `emergency_denied` to incident vocabulary and incident triggers

## Proof

Focused tests run:

- `node --test tests/test-bucket5.js tests/test-bucket6.js`
- `node --test tests/test-github-install.js`
- `node --test --test-name-pattern "guardrail lane revoke --all|guardrail lane kill --all|denies non-admin operator profiles|allows admin operator profiles" tests/test-feature-acceptance.js`

Focused outcomes:

- profile validation accepts persisted operator roles and rejects invalid ones
- RBAC enforces `emergency_control` as admin-only
- CLI parsing accepts `profile create --role`
- emergency commands now:
  - deny developer-role profiles
  - allow admin-role profiles
  - append audit evidence for both allow and deny paths

## Residual gap

At the time `30b` landed, item `30` still had one remaining local gap:

- key/token revocation distinct from rotation

That gap was later closed by `30c`.

Already closed in this item:
- single-target lane/session emergency controls via `P0h`
- bulk repo/workspace kill switch via `30a`
- break-glass authorization gate via `30b`

## Files changed

- `src/cli.js`
- `src/event-schema.js`
- `src/profile.js`
- `src/rbac.js`
- `tests/test-bucket5.js`
- `tests/test-bucket6.js`
- `tests/test-feature-acceptance.js`
- `tests/test-github-install.js`
