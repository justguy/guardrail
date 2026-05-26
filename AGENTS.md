# Guardrail — Agent Instructions

These instructions apply to the entire repository tree.

## Raw Git Guardrails

Do not execute raw destructive or remote-mutating Git commands in this repository.

Blocked raw commands:
- `git push`
- `git push --force`
- `git push --force-with-lease`
- `git reset --hard`
- `git clean -f`
- `git clean -fd`
- `git branch -D`
- `git checkout .`
- `git checkout -- .`
- `git restore .`

Required alternatives:
- For a normal push, use `guardrail run --recipe git-push --input repo_path=. --input remote=origin --input branch=feature/<name>`.
- For a force push, use `guardrail run --recipe git-force-push-safe --input repo_path=. --input remote=origin --input branch=feature/<name> --input expected_head=<sha> --input expected_remote_oid=<sha>`.

If the task appears to require `reset --hard`, `clean -f`, branch deletion, or worktree wipe commands, stop and ask the operator. There is no shipped bounded Guardrail recipe for those destructive forms.

## Approval Expectations

If you are operating in a mode that supports explicit command approval, require approval before any Git mutation.

If you are operating in an autonomous mode that can execute shell commands without per-command approval, you must still obey the raw Git guardrails above and use the Guardrail recipes instead of raw `git push` or other blocked commands.

Git mutations include commit, amend, merge, rebase, stash, branch creation or deletion, checkout/switch, restore, reset, clean, tag creation or deletion, and push. Use the shipped Guardrail recipes for approved bounded forms, and do not perform raw Git mutations during unattended work.

## Unattended Autonomous Work

When the operator explicitly delegates unattended work, agents may continue without waiting for live human approval only inside these boundaries:

- Create or update the active goal before implementation starts, and keep working until the goal is complete, verified, or genuinely blocked.
- Fail closed. If approval state, policy state, tracker state, service state, or repository state is missing, ambiguous, or contradictory, stop the affected operation instead of guessing.
- Before code changes, check the current task scope, dirty tree, relevant service/auth prerequisites, and whether any target file has conflicting user changes.
- Keep LLM Project Tracker state current through the `lt` MCP tools. Claim or update the relevant task before code changes, write small tracker patches during work, record files touched and verification evidence, and mark tasks complete only after their definition of done is met. Do not directly rewrite tracker JSON except for initial project registration.
- Use subagents only for bounded, relevant work. Give each subagent a concrete question or disjoint write scope, tell it not to revert other changes, and review its result before relying on it. The parent agent owns coordination, conflict checks, final review, tracker closeout, and closing unneeded subagents.
- Avoid bash approval prompts during unattended work. Prefer sandbox-compatible commands, existing approved command prefixes, and Guardrail recipes. If a necessary command requires new approval and there is no safe bounded alternative, record the blocker in the tracker and continue other independent work. Stop only when the blocked command is required for the next meaningful step.
- Do not broaden execution scope to avoid approval. No unreviewed dependency installs, remote network egress beyond loopback, production targets, secrets access, destructive filesystem operations, or raw mutating Git commands.
- Do not repair missing auth, install MCP plugins, change credentials, run database migrations, touch staging/production, or widen service/network boundaries unless the task or approved recipe explicitly names that boundary.
- Start, stop, or probe services only through bounded local commands or Guardrail recipes. API probes must target `localhost` or `127.0.0.1` unless a task explicitly includes approval for another host. Preserve logs or audit evidence needed to explain service changes.
- For git, read-only commands such as `git status`, `git diff`, and `git log` are acceptable. Mutating operations must use shipped Guardrail recipes and must respect the raw Git guardrails above.
- If tests fail, debug and fix within the task scope. If full verification cannot run because approval is unavailable, run the strongest focused verification available and record the missing approval-bound check.
- Use bounded retry loops. After repeated failure of the same operation, stop that operation, record the exact blocker and evidence, and move only to independent work.

Stop and wait for the operator if the next required step involves destructive Git, a worktree wipe, force push outside the shipped safe recipe, new external credentials, production infrastructure, ambiguous scope, conflicting dirty files, tracker write rejection that cannot be repaired safely, secrets exposure, failing tests outside task scope, subagent or lane conflict, or a policy change that would let agents execute arbitrary shell commands.

## Delegated Guardrail MCP

When a delegated Guardrail MCP server is available, treat it as the authority for allowed work. At session start, after reconnect, and after any delegated-tool denial, call `guardrail_grant_status` and inspect the advertised tool inventory, grant capabilities, policy limits, and help text before acting. Use `grant.tools` or `grant.toolInventory.callableTools` as the actionable MCP inventory; entries under `grant.toolInventory.grantOnlyTools` are stale grant declarations, not callable tools, and entries under `grant.toolInventory.exposedButNotGrantedTools` are exposed by the server but unavailable under the active grant. Use those schemas and grant limits instead of guessing hidden flags, capabilities, paths, or approval state.

Use Guardrail MCP tools for delegated Guardrail work when available: recipe execution, local service lifecycle, bounded HTTP probes, read-only git status/diff, and shipped Guardrail git wrapper recipes. Do not bypass a missing or denied MCP capability with raw shell, remote network, or raw mutating Git. If the required capability is not in the active grant or tool inventory, stop or request a new grant.

For delegated recipe/template execution, call the describe or prepare tool/action before running. Prefer the omnitool-style parent `guardrail_template` tool with `action: "describe"`, `"prepare"`, `"request_approval"`, or `"run"`; this parent tool is an agent-facing entry point over the existing template supervisor, not a separate template runtime. The older template-specific tools remain compatibility aliases. Unpinned `guardrail_run_recipe` and template run actions require either MCP host form elicitation approval or an already approved CLI `approval_request_id`; normal tool arguments cannot self-approve execution. Hosts without elicitation support fail closed with `host_approval_unavailable`, and declined, cancelled, or malformed host responses fail closed before supervisor execution.

Treat MCP errors as correction hints. Read structured error payloads such as `ok: false`, `code`, `message`, `tool`, `grantHash`, and `correction.expected`; adjust only the exact tool arguments that remain inside the grant; retry boundedly. A denial means the request is outside the active grant or policy, not permission to invent another execution path.

## Subagent and Token Usage

Default to using subagents for non-trivial work, especially broad codebase exploration, test-failure triage, reviews, multi-file changes, or tasks requiring parallel investigation. Keep the main thread focused on decisions, concise summaries, and final implementation steps.

Subagents should receive narrow task briefs and return compact findings: relevant files, key facts, risks, and recommended next actions. Avoid pasting large raw outputs into the main thread.

For trivial, local, or single-command tasks, skip subagents when the overhead would exceed the benefit. Always be mindful of token usage.

## Validation

When you change code, run the relevant focused tests after the change. Prefer the smallest test scope that proves the new behavior.
