## REPORT_enterprise_30c_key_revocation

**Status: COMPLETE**

**Roadmap Anchor:** enterprise-30-break-glass-rollout

## Goal

Close the remaining local gap in enterprise item `30` by adding key revocation distinct from rotation.

## Implementation

### Revocation state in key management

- `src/key-management.js`
  - adds `revoke(name, { actor, reason })`
  - persists:
    - `revoked: true`
    - `revokedAt`
    - `revokedBy`
    - `revocationReason`
  - `get(name)` now fails closed on revoked keys with:
    - `err.code = 'key_revoked'`
  - `listSync()` now exposes revocation metadata without exposing secret values

### Audit/event surface

- `src/event-schema.js`
  - adds `key_revoked` to incident vocabulary and incident triggers

### Narrow CLI surface

- `src/cli.js`
  - adds `guardrail key revoke <name> --state-dir <dir>`
  - requires an active Guardrail profile with `operator_role`
  - enforces existing admin-only `manage_keys` permission
  - appends:
    - `rbac_check`
    - `emergency_denied` on deny
    - `key_revoked` on success

## Proof

Focused tests run:

- `node --test --test-name-pattern "Key Management|RBAC|Profiles" tests/test-bucket5.js tests/test-bucket6.js`
- `node --test tests/test-github-install.js`
- `node --test --test-name-pattern "guardrail key revoke|guardrail lane revoke --all|guardrail lane kill --all|denies non-admin operator profiles|allows admin operator profiles" tests/test-feature-acceptance.js`

Focused outcomes:

- revoked keys no longer decrypt or return plaintext
- revoked-key reads fail with distinct `key_revoked`
- revocation metadata is visible through listing without leaking values
- CLI parsing supports `key revoke`
- non-admin profiles are denied and audited
- admin profiles can revoke keys and produce `key_revoked` audit evidence

## Result

Local enterprise item `30` is now closed.

Delivered across the full item:

- `P0h` — single-target lane/session emergency controls
- `30a` — bulk repo/workspace lane revoke/kill
- `30b` — active-profile-backed RBAC gate for break-glass commands
- `30c` — key revocation distinct from rotation

Still out of scope:

- hosted admin plane
- SSO/OIDC-backed operator identity
- cross-node/global emergency orchestration

## Files changed

- `src/key-management.js`
- `src/event-schema.js`
- `src/cli.js`
- `tests/test-bucket5.js`
- `tests/test-bucket6.js`
- `tests/test-feature-acceptance.js`
- `tests/test-github-install.js`
