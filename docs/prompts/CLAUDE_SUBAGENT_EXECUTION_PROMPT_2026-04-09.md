# Claude Orchestrator Prompt — Remaining Guardrail Roadmap Batch

Use this as the top-level prompt for Claude when you want Claude to execute the remaining near-term Guardrail roadmap with subagents.

```text
Execute the remaining near-term Guardrail roadmap batch using subagents with explicit write ownership.

Read first:
- /Users/adilevinshtein/Documents/dev/Guardian/docs/technical-status.md
- /Users/adilevinshtein/Documents/dev/Guardian/docs/plans/PLAN_pickup_four_open_items_2026-04-08.md
- /Users/adilevinshtein/Documents/dev/Guardian/docs/prompts/REMAINING_ROADMAP_PROMPTS_INDEX_2026-04-09.md

Then use these prompt files as subagent assignments:
- /Users/adilevinshtein/Documents/dev/Guardian/docs/prompts/PROMPT_A0g_agent_session_contracts.md
- /Users/adilevinshtein/Documents/dev/Guardian/docs/prompts/PROMPT_A0_adapter_hardening_track.md
- /Users/adilevinshtein/Documents/dev/Guardian/docs/prompts/PROMPT_D0c_template_recipe_bridge.md
- /Users/adilevinshtein/Documents/dev/Guardian/docs/prompts/PROMPT_D0d_unified_workflow_recipe_discovery.md
- /Users/adilevinshtein/Documents/dev/Guardian/docs/prompts/PROMPT_D0e_bundled_wrapper_portability.md
- /Users/adilevinshtein/Documents/dev/Guardian/docs/prompts/PROMPT_D0f_recipe_root_precedence_and_collision.md
- /Users/adilevinshtein/Documents/dev/Guardian/docs/prompts/PROMPT_D0g_default_recipe_roots.md
- /Users/adilevinshtein/Documents/dev/Guardian/docs/prompts/PROMPT_D0h_cross_platform_recipe_root_normalization.md
- /Users/adilevinshtein/Documents/dev/Guardian/docs/prompts/PROMPT_D0j1_bounded_commit_plan_support.md
- /Users/adilevinshtein/Documents/dev/Guardian/docs/prompts/PROMPT_D0k_wrapper_version_coupling_and_provenance.md

Execution rules:
- spawn subagents only when their write scopes are disjoint
- do not let two subagents edit the same file at the same time
- keep one integrator agent responsible for cross-cutting docs, acceptance tests, and final merge logic
- preserve Guardrail's fail-closed approval model, structured execution bias, and zero-dependency constraint
- do not quietly weaken `review_each_time`, `content_hash`, provenance, or trust-boundary behavior

Suggested waves:

Wave 1 in parallel:
- A0g
- A0 adapter hardening
- D0c
- D0j1

Wave 2 on one shared resolver lane:
- D0d
- D0f
- D0g
- D0h

Wave 3 on one shared wrapper/provenance lane:
- D0e
- D0k

For each subagent:
- pass the exact prompt file as its task brief
- require explicit file ownership
- require focused tests plus any necessary integration coverage
- require docs updates inside the owned scope

Integrator responsibilities:
- reconcile overlapping docs after each wave
- rerun the relevant focused suites after each merged wave
- run the full test suite before finalizing
- update `/Users/adilevinshtein/Documents/dev/Guardian/docs/technical-status.md` so statuses match landed behavior
- produce a final summary listing what shipped, what remains partial, and what should be deferred

Stop and ask for clarification if:
- a task would require external dependencies
- a design starts relying on undocumented external CLI behavior
- an item cannot be implemented without changing Guardrail's core approval honesty model
- two workstreams turn out to require the same hot files and cannot be decoupled safely
```
