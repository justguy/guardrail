# Claude Review Brief — Bounded Commit-Plan Support

Audience: Claude or another external coding agent  
Goal: Review the bounded commit-plan design against the current Guardrail codebase and return a concrete execution recommendation

## Read First

- `docs/plans/PLAN_bounded_commit_plan_support.md`
- `docs/technical-status.md`
- `docs/agent-onboarding.md`
- `src/git-commit-wrapper.js`
- `recipes/git-commit.recipe.json`
- `src/recipe-supervisor.js`
- `src/workflow.js`
- `src/workflow-supervisor.js`
- `src/prompt-inputs.js`

## Task

Review the bounded commit-plan proposal and answer:

1. Does the proposed `git-commit-from-plan` path fit Guardrail's current recipe/workflow approval model cleanly?
2. What implementation sequence would you use to ship this with the smallest surface-area risk?
3. What edge cases are missing or under-specified?
4. What should remain explicitly out of scope for v1?

Do **not** assume Guardrail can safely commit arbitrary changed files. The design must preserve:

- fail-closed approval semantics
- exact or bounded explicit commit scope
- content-hash recheck before execution
- no shell fallback
- no push

## Desired Output

Return a short technical review with:

- `fit`: whether the plan is architecturally aligned with current Guardrail
- `recommended path`: the smallest clean implementation
- `gaps`: concrete missing pieces or risky assumptions
- `acceptance tests`: the minimum tests that must pass before calling it done

If you disagree with the plan, propose the safer alternative and explain why.
