# Guardrail Roadmap Task 36 — Admin/Event API Gap Inventory

Task:
- Work on roadmap item `36` from `docs/technical-status.md`:
  `Versioned admin/event APIs and read-access auditing`
- This is an inventory + gap-report slice, not a full implementation slice.

Goal:
- Identify the current admin-surface, event-surface, and read/export access-audit seams already present in the repo.
- State what is still missing to honestly mark item `36` done.

Declared report artifact:
- `docs/plans/REPORT_v36_admin_event_api_gap_inventory.md`

Instructions:
1. Read only the files needed to answer this task.
2. Inspect the existing admin/event/read-access surfaces first. Likely starting points:
   - `docs/technical-status.md`
   - `README.md`
   - `src/audit.js`
   - `src/compliance.js`
   - `src/cli.js`
   - `src/shared.js`
   - `src/metrics.js`
3. Write the report artifact with:
   - `Status: COMPLETE`
   - current implemented surfaces
   - missing versioning/admin compatibility guarantees
   - missing read/export access-audit coverage
   - the smallest next 3 implementation slices needed to close item `36`
4. Do not start another roadmap item.
5. Do not implement code changes in this task unless a missing detail is impossible to explain without a tiny supporting diff.
6. Keep the report concrete and repo-specific.

Success condition:
- The report artifact exists and gives a credible repo-local inventory plus a small next-slice plan for item `36`.
