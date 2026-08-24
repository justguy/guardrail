# Guardrail Packet Prompt — D0z True Repo-Local Autonomous Tool State

Packet:
- `docs/plans/PLAN_d0z_true_repo_local_autonomous_tool_state.md`

Declared report artifact:
- `docs/plans/REPORT_d0z_true_repo_local_autonomous_tool_state.md`

Focused proof:
- `tests/test-claude-resident-lane.js`
- `tests/test-feature-acceptance.js` with the resident-lane slice

Execution contract:
1. Work only on `D0z`. Do not start `P0f`, `P0g`, or `P0h`.
2. Create or update the declared report artifact immediately.
3. Set `Status: STARTED`, the exact objective, intended proof, and immediate next step.
4. Treat the fire-trial finding as authoritative:
   - Guardrail repo-local lane state is already implemented.
   - The remaining blocker is downstream Claude project/session state still writing under host-global `/Users/.../projects/...`.
5. Identify the smallest correct implementation that makes resident Claude lanes truly repo-local without breaking Claude auth/session viability.
6. If you need review, operator input, or the runtime limitation is unavoidable, set `Status: NEEDS_REVIEW` and explain exactly why.
7. Before claiming completion, run the focused proof and record exact results in the report.

Completion bar:
- the declared report artifact exists
- the report names the exact path(s) and the implemented redirect/virtualization strategy
- focused proof has been run and recorded
- docs are updated truthfully if behavior/roadmap changed

