# REPORT: Enterprise 30a — Bulk Lane Kill Switch

**Status: COMPLETE**
**Date:** 2026-04-14
**Roadmap Anchor:** enterprise-30-break-glass-rollout

---

## Objective

Add `--all` support to `guardrail lane revoke` and `guardrail lane kill`, enabling bulk emergency shutdown across all lanes in the current repo/workspace scope.

---

## Commands Added / Changed

- `guardrail lane revoke --all`
- `guardrail lane kill --all`

Both commands now operate over the current repo/workspace lane scope by enumerating lanes with the existing resident-lane listing logic and applying the existing single-target emergency controls per lane.

---

## Summary Shape

`lane revoke --all --json` now returns:

```json
{
  "targeted": 3,
  "revoked": 2,
  "skipped": 1,
  "failed": 0,
  "results": [
    { "laneId": "a", "laneDir": "...", "outcome": "revoked", "result": { ... } },
    { "laneId": "b", "laneDir": "...", "outcome": "skipped", "reason": "already_revoked" }
  ]
}
```

`lane kill --all --json` returns the same shape with `killed` instead of `revoked`.

Behavior:
- already revoked lanes are skipped based on the persistent `REVOKED` sentinel
- one audit entry is emitted per affected lane using existing event types
- exit code is non-zero when any lane fails
- single-target `lane revoke` / `lane kill` behavior is unchanged

---

## Tests Run

- `node --test --test-name-pattern "Bulk lane emergency controls" tests/test-claude-resident-lane.js`
- `node --test tests/test-github-install.js`
- `node --test --test-name-pattern "guardrail lane revoke --all|guardrail lane kill --all" tests/test-feature-acceptance.js`

Results:
- bulk emergency-control unit coverage: `10/10` pass
- CLI arg parse coverage: pass
- CLI acceptance for `lane revoke --all` and `lane kill --all`: `2/2` pass

---

## Residual Gap

Item `30` is not fully closed by this slice.

Still open after 30a:
- key/token revocation path distinct from rotation

Closed later by `30b`:
- RBAC / authorization gate for break-glass commands (`lane revoke`, `lane kill`)

Out of scope and still out:
- hosted org/workspace control plane
- SSO/OIDC-backed operator auth
- cross-node bulk revocation

---

## Files Changed

- `src/resident-lane-core.js`
  - added `revokeAllResidentLanes(rawOptions)`
  - added `killAllResidentLanes(rawOptions)`
  - bulk skip logic now respects the persistent `REVOKED` sentinel
- `src/resident-lane.js`
  - exports the new bulk helpers
- `src/cli.js`
  - wires `lane revoke --all`
  - wires `lane kill --all`
  - emits per-lane audit entries for bulk operations
- `tests/test-claude-resident-lane.js`
  - added bulk revoke/kill unit coverage
- `tests/test-github-install.js`
  - added parse coverage for `lane revoke` / `lane kill`
- `tests/test-feature-acceptance.js`
  - added CLI acceptance coverage for bulk revoke/kill
