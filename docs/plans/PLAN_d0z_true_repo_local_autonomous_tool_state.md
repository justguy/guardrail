# D0z — True Repo-Local Autonomous Tool State

Roadmap anchor:
- `D0z` in `docs/technical-status.md`

Problem:
- Guardrail resident lanes now keep their own state under repo-local `.guardrail/...`.
- That solved repeated outer-sandbox approvals for Guardrail lane traffic.
- It did **not** solve downstream Claude project/session state.
- Claude still attempts host-global per-project writes under:
  - `/Users/adilevinshtein/projects/-Users-adilevinshtein-Documents-dev-Guardian`
- That breaks hands-free repo-bounded fire trials before packet work starts.

Goal:
- Make autonomous Guardrail Claude/Codex lane runs truly repo-local.
- Guardrail-owned lane state and downstream tool project/session state must both remain inside the repo boundary for normal autonomous runs.

Declared report artifact:
- `docs/plans/REPORT_d0z_true_repo_local_autonomous_tool_state.md`

Likely target files:
- `src/claude-resident-lane.js`
- `src/codex-resident-lane.js`
- `src/resident-lane-core.js`
- `src/cli.js`
- focused docs/tests directly needed for the packet

Required outcomes:
1. Document the exact downstream tool-state paths Guardrail must manage or redirect.
2. Add one real repo-local project/session-state strategy for Claude resident lanes.
3. Ensure the strategy preserves Claude auth/session viability.
4. Prove a resident Claude lane can begin packet work without attempting host-global `projects/...` writes.
5. Update docs truthfully about what D0z does and does not solve.

Focused proof:
- `tests/test-claude-resident-lane.js`
- `tests/test-feature-acceptance.js` with the resident-lane slice
- any new focused D0z tests needed for repo-local downstream tool-state behavior

Proof of done:
- the declared report artifact exists
- the report names the exact downstream tool-state path(s) being redirected or virtualized
- focused proof has been run and recorded
- at least one resident Claude lane startup/request path no longer fails on host-global `projects/...` writes
- `docs/technical-status.md` and `README.md` reflect the corrected D0z scope

Stop conditions:
- if the only viable fix requires a Claude runtime behavior Guardrail cannot influence safely, set `Status: NEEDS_REVIEW`
- if the implementation would require pretending host-global writes are repo-local when they are not, stop
- do not start `P0f`/`P0g`/`P0h` in this packet

