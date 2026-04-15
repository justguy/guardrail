# Guardrail Resident-Lane Packet — Enterprise Item 30 Inventory

Goal:
- Inventory what remains to close enterprise roadmap item `30` after `P0h` already landed the local emergency-control seam.
- Do not implement code changes in this packet unless a tiny fix is necessary to make the report accurate.

Roadmap anchor:
- `enterprise-30-break-glass-rollout`
- `docs/technical-status.md` item `30`

Declared report artifact:
- `docs/plans/REPORT_enterprise_30_break_glass_rollout_inventory.md`

Known current state:
- `P0h` is complete.
- Guardrail already has:
  - `guardrail lane revoke`
  - `guardrail lane kill`
  - `guardrail session revoke`
  - auditable events:
    - `lane_revoked`
    - `lane_emergency_stop`
    - `session_revoked`
  - resident-lane restart blocking via `REVOKED` sentinel
  - session lifecycle blocking via `session_revoked`
- The tracker still says the broader enterprise rollout remains.

Your task:
1. Read the current emergency-control implementation and docs.
2. Identify the exact remaining gap between:
   - the local seam already landed in `P0h`
   - the broader enterprise item `30` promise
3. Distinguish clearly between:
   - already shipped local controls
   - missing org/workspace-scoped controls
   - missing break-glass approval flow
   - missing audit / admin / API surface needed for enterprise rollout
4. Propose the smallest 2-3 implementation slices needed to close item `30` honestly.
5. Do not broaden into unrelated hosted-control-plane work.

Files to inspect first:
- `docs/technical-status.md`
- `docs/plans/PLAN_enterprise_P0h_emergency_controls.md`
- `docs/plans/REPORT_enterprise_P0h_emergency_controls.md`
- `src/cli.js`
- `src/resident-lane-core.js`
- `src/agent-session.js`
- `src/agent-session-lifecycle.js`
- `src/event-schema.js`
- `tests/test-claude-resident-lane.js`
- `tests/test-agent-session.js`
- `.llm-tracker/trackers/guardrail-roadmap.json`

Questions the report must answer:
1. What exact promises in enterprise item `30` are already satisfied by `P0h`?
2. What exact promises are still missing?
3. Which missing pieces are small enough to implement now without introducing a hosted admin plane?
4. What is the best first slice to run next through Guardrail?
5. What should remain explicitly out of scope after that first slice?

Output requirements:
- Create or update the declared report artifact immediately before deep analysis
- Set `Status: STARTED` immediately, then update to `COMPLETE` or `NEEDS_REVIEW`
- Rank the missing gaps by implementation leverage
- Recommend exactly one first slice to execute next

Constraint:
- Stay on the resident-lane Guardrail path.
- Do not suggest `claude-exec`.
