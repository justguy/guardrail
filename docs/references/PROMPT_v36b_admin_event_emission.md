# Guardrail Item 36 — Slice B: Admin Event Emission

Task:
- Work only on roadmap item `36` from `docs/technical-status.md`:
  `Versioned admin/event APIs and read-access auditing`
- This slice closes the admin-event emission gap on real existing mutation surfaces.

Declared report artifact:
- `docs/plans/REPORT_v36b_admin_event_emission.md`

Goal:
- Emit admin-family audit events for the actual public admin mutation surfaces that exist in this repo.
- Be honest about what exists and what does not.

Primary repo surfaces:
- `src/recipe-install.js`
- `src/deployment-mode.js`
- `src/key-management.js`
- `src/cli.js`
- `src/event-schema.js`
- `tests/test-bucket6.js`
- `tests/test-feature-acceptance.js`
- `docs/plans/REPORT_v36_admin_event_api_gap_inventory.md`

Required behavior:
1. Inspect the real existing admin mutation surfaces first.
2. Emit stable admin-family events for the call sites that actually exist now.
3. At minimum, cover recipe installation if that surface is real and public.
4. If `deployment-mode` and/or `key-management` expose real mutation functions, instrument them too.
5. If an event from `ADMIN_EVENTS` has no real mutation surface yet, do not fake it:
   - say so in the report
   - leave the vocabulary honest
   - keep this slice bounded to real code

Focused proof expectations:
- Add or update focused tests proving the instrumented admin actions emit admin-family events with schema metadata.
- Prefer small additions to existing bucket/acceptance tests.

Report requirements:
1. Create the report artifact immediately with `Status: STARTED`.
2. List which admin mutation surfaces were actually found.
3. List which events were emitted and where.
4. If some declared admin events still have no call site, call that out plainly.
5. End with either:
   - `Status: COMPLETE`
   - or `Status: NEEDS_REVIEW` with a precise blocker.

Constraints:
- Do not invent new public admin commands just to satisfy the vocabulary.
- Do not broaden into item 18/21/22 or other enterprise work.
- Do not do slice C here.
