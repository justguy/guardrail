# Guardrail Remaining Roadmap Prompt Pack

Audience: Maintainers coordinating external coding agents  
Goal: Provide copy-paste prompt files for the remaining near-term Guardrail roadmap batch after `D0i` and `D0j`

## Read First

- `docs/technical-status.md`
- `docs/plans/PLAN_pickup_four_open_items_2026-04-08.md`
- `docs/prompts/CLAUDE_SUBAGENT_EXECUTION_PROMPT_2026-04-09.md`

## Prompt Files

- `docs/prompts/PROMPT_A0g_agent_session_contracts.md`
- `docs/prompts/PROMPT_A0_adapter_hardening_track.md`
- `docs/prompts/PROMPT_D0c_template_recipe_bridge.md`
- `docs/prompts/PROMPT_D0d_unified_workflow_recipe_discovery.md`
- `docs/prompts/PROMPT_D0e_bundled_wrapper_portability.md`
- `docs/prompts/PROMPT_D0f_recipe_root_precedence_and_collision.md`
- `docs/prompts/PROMPT_D0g_default_recipe_roots.md`
- `docs/prompts/PROMPT_D0h_cross_platform_recipe_root_normalization.md`
- `docs/prompts/PROMPT_D0j1_bounded_commit_plan_support.md`
- `docs/prompts/PROMPT_D0k_wrapper_version_coupling_and_provenance.md`
- `docs/prompts/PROMPT_D0s_interactive_user_message_sessions.md`
- `docs/prompts/PROMPT_recipe_launch_batch_ship_now_2026-04-09.md`

## Recommended Execution Order

1. `A0g`
2. `A0` adapter hardening
3. `D0c`
4. `D0j1`
5. `D0d`
6. `D0f`
7. `D0g`
8. `D0h`
9. `D0e`
10. `D0k`

## Parallelization Rules

- `A0g`, `A0` adapter hardening, `D0c`, and `D0j1` can run in parallel if an integrator owns cross-cutting docs and shared tests.
- `D0d`, `D0f`, `D0g`, and `D0h` should stay on one resolver/discovery lane because they share `workflow`, recipe resolution, CLI config, path normalization, and discovery diagnostics.
- `D0e` and `D0k` should stay on one wrapper lane because provenance rules depend on the portability behavior they pin.
- The integrator should reserve ownership of:
  - `docs/technical-status.md`
  - `docs/agent-onboarding.md`
  - `README.md`
  - any cross-cutting acceptance/integration suite touched by more than one lane

## Definition Of Done

- each prompt lands code, tests, and docs for its own scope
- all new behavior is covered by focused tests and at least one end-to-end or integration path where appropriate
- roadmap/docs are updated so `docs/technical-status.md` reflects shipped work accurately
- no prompt widens Guardrail semantics through shell fallback, implicit trust, or non-deterministic approval reuse
