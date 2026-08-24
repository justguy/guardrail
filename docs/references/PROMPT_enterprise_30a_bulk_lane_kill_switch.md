# Guardrail Resident-Lane Packet — Enterprise 30a

Goal:
- Close the highest-leverage remaining gap from enterprise item `30` by adding a repo/workspace-scoped bulk kill-switch path:
  - `guardrail lane revoke --all`
  - `guardrail lane kill --all`

Roadmap anchor:
- `enterprise-30-break-glass-rollout`
- first slice from `docs/plans/REPORT_enterprise_30_break_glass_rollout_inventory.md`

Declared report artifact:
- `docs/plans/REPORT_enterprise_30a_bulk_lane_kill_switch.md`

Constraints:
- Stay additive. Reuse existing single-target emergency controls.
- Do not broaden into hosted org control plane, SSO, or RBAC gating in this slice.
- Do not create new event types if existing `lane_revoked` and `lane_emergency_stop` are sufficient.

Current state:
- `guardrail lane revoke --id/--lane-dir` already exists.
- `guardrail lane kill --id/--lane-dir` already exists.
- `revokeResidentLane()` and `killResidentLane()` already exist.
- `guardrail lane list` / portfolio logic already enumerate lanes.
- The remaining gap is bulk emergency action across the current repo/workspace scope.

Your task:
1. Implement `--all` support for both:
   - `guardrail lane revoke --all`
   - `guardrail lane kill --all`
2. Reuse existing lane enumeration and existing single-target revoke/kill behavior.
3. Emit one audit event per affected lane using the current event vocabulary.
4. Return an aggregate summary:
   - total targeted
   - revoked/killed
   - already revoked/skipped
   - failed
5. Exit non-zero on partial failure.

Likely files:
- `src/cli.js`
- `src/resident-lane.js`
- `src/resident-lane-core.js`
- `tests/test-claude-resident-lane.js`
- `tests/test-feature-acceptance.js`

Required tests:
- zero lanes in scope
- one lane in scope
- multiple lanes in scope
- already revoked lane is skipped cleanly
- partial failure returns non-zero and reports counts accurately

Report requirements:
- create/update the declared report artifact immediately
- set `Status: STARTED` first
- update to `COMPLETE` or `NEEDS_REVIEW`
- include:
  - commands added or changed
  - summary shape
  - exact tests run
  - any residual out-of-scope gap left for item `30`

Stop conditions:
- if the slice starts inventing new hosted concepts
- if bulk mode bypasses existing single-target revoke/kill logic
- if the slice weakens current audit behavior
