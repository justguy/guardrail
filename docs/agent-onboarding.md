# Agent Onboarding

Use this guide when another coding agent needs to execute commands or workflows through Guardrail.

## Core Rules

1. Guardrail is the source of truth for approval reuse and drift control.
2. Do not bypass Guardrail by running the underlying command or workflow steps directly unless the user explicitly says to.
3. Guardrail is not a sandbox. It enforces approval boundaries and highlights risk, but the user remains responsible for what they approve.
4. In non-interactive mode, only a previously approved Guardrail manifest counts as reusable approval.
5. Approval reuse is exact-value based today. If an input value changes, treat it as drift even when the template or recipe schema would allow the new value.
6. Guardrail locks execution per manifest hash. Different manifests can run concurrently; the same approved execution cannot run twice at once.
7. Prefer `README.md` and `docs/technical-status.md` over speculative design docs. If another document describes a feature that is not marked done there, treat it as planned, not available.
8. If you need one approval to cover multiple recipes, use workflow mode with `recipe_ref` steps. Do not try to reuse one recipe manifest for several different recipes.

## Local CLI Entry Point

If `guardrail` is not installed in `PATH`, use the local entrypoint:

```bash
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js
```

## TTY Note For First Approval

First interactive approval must have a real TTY. If you are invoking Guardrail through `tpf`, use:

```bash
TPF_LLM_TOOL=codex tpf --passthrough-tty node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js ...
```

Use `--passthrough-tty` only for approval-bearing interactive runs. After the manifest exists, go back to the normal wrapped non-interactive path.

## Command Mode

Interactive approval:

```bash
cd /Users/adilevinshtein/Documents/dev/Guardian
node src/cli.js run --manifest .guardrail/approved.json -- <command> [args...]
```

Non-interactive reuse:

```bash
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js run --non-interactive --approved-manifest /Users/adilevinshtein/Documents/dev/Guardian/.guardrail/approved.json -- <command> [args...]
```

## Workflow Mode

Interactive approval:

```bash
cd /Users/adilevinshtein/Documents/dev/Guardian
node src/cli.js workflow run --definition <workflow-definition-path> --manifest <approved-workflow-manifest-path>
```

Non-interactive reuse:

```bash
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js workflow run --definition <workflow-definition-path> --non-interactive --approved-manifest <approved-workflow-manifest-path>
```

Workflow note:

- Workflow steps can be `task`, `service_start`, `service_stop`, `service_restart`, or `recipe_ref`.
- `recipe_ref` is the native answer when you want one workflow approval to cover multiple bounded recipe executions.
- The workflow manifest captures each referenced recipe's resolved version, recipe hash, resolved inputs, and any prompt-bearing file hashes that were part of the approved workflow.
- If the workflow repo and the recipe repo are different, pass `--recipe-search-dir <path>` on both `workflow lint` and `workflow run`. Repeat the flag if you need more than one extra recipe root.

Cross-repo workflow example:

```bash
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js workflow lint \
  --definition /Users/adilevinshtein/Documents/dev/Project-Phalanx/workflows/review-and-commit.json \
  --recipe-search-dir /Users/adilevinshtein/Documents/dev/Guardian/recipes

node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js workflow run \
  --definition /Users/adilevinshtein/Documents/dev/Project-Phalanx/workflows/review-and-commit.json \
  --recipe-search-dir /Users/adilevinshtein/Documents/dev/Guardian/recipes \
  --manifest /Users/adilevinshtein/Documents/dev/Project-Phalanx/.guardrail/workflows/review-and-commit.approved.json
```

## Recipe Mode

Interactive approval:

```bash
cd /Users/adilevinshtein/Documents/dev/Guardian
node src/cli.js run --recipe <recipe-id[@version]> --input key=value --manifest <approved-recipe-manifest-path>
```

Non-interactive reuse:

```bash
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js run --recipe <recipe-id[@version]> --input key=value --non-interactive --approved-manifest <approved-recipe-manifest-path>
```

Default recipe manifest path:

```text
.guardrail/recipes/<recipe-id>.approved.json
```

Recipe version rules:

- If the recipe specifier includes `@version`, Guardrail uses exactly that installed version or fails.
- If the recipe specifier omits `@version`, Guardrail resolves the latest installed version.
- An approval for an unpinned recipe binds to the resolved latest version at approval time. If a newer version later becomes latest, Guardrail treats that as drift and stops for re-approval.
- Recipe dry-run remains a preview path and does not require an approved manifest.
- Recipe input constraints validate what values are allowed, but approval reuse still binds to the exact resolved input values saved in the manifest.

Bundled Codex recipe:

- `recipes/codex-exec.recipe.json` wraps `codex exec` through `src/codex-exec-wrapper.js`
- supports inline prompt text, `input_files` prompt context, model/profile selection, sandbox selection, workspace roots, JSON output, and schema/output file flags
- use it when an agent needs a bounded, repeatable Codex invocation instead of calling `codex exec` directly
- repeat `--input input_files=...` to pass one or more prompt-bearing files
- `input_files` are content-hash bound at approval time and rechecked immediately before execution
- inline `prompt` values are `review_each_time`: they require fresh approval every run, even if unchanged
- for unattended reuse, keep stable prompt material in `input_files` instead of inline prompt text
- `codex-exec` is not an outer sandbox. If it runs outside your host sandbox/container boundary, Codex executes with host privileges subject to Codex's own permission model.

Example interactive run:

```bash
cd /Users/adilevinshtein/Documents/dev/Guardian
node src/cli.js run --recipe codex-exec \
  --input working_dir=. \
  --input prompt="Review src/recipe-install.js for private-repo edge cases." \
  --input input_files=src/recipe-install.js \
  --input input_files=src/recipe-runner.js \
  --manifest .guardrail/recipes/codex-exec.approved.json
```

Bundled Claude recipe:

- `recipes/claude-exec.recipe.json` wraps `claude --print` through `src/claude-exec-wrapper.js`
- supports inline prompt text, `input_files` prompt context, explicit working directory control, optional `allowed_tools`, `max_budget_usd`, `system_prompt`, and `session_name`
- `working_dir` sets the Claude process cwd; `add_dirs` only grants additional tool-access roots
- omit `allowed_tools` to let Claude use its default built-in tool set
- inline `prompt` and `system_prompt` are `review_each_time`; reusable prompt context should live in `input_files`
- `claude-exec` is not an outer sandbox. If it runs outside your host sandbox/container boundary, Claude executes with host privileges subject to Claude's own permission model. Guardrail warns about this in recipe approval risk reasons.

Example interactive run:

```bash
cd /Users/adilevinshtein/Documents/dev/Guardian
node src/cli.js run --recipe claude-exec \
  --input guardrail_repo=. \
  --input working_dir=. \
  --input prompt="Review tests/integration/authRedirectFlow.test.js for flakiness." \
  --input input_files=tests/integration/authRedirectFlow.test.js \
  --input model=sonnet \
  --input effort=high \
  --input mode=plan \
  --input output_format=text \
  --input max_budget_usd=1.00 \
  --input system_prompt="Focus on concrete reproduction steps and likely root causes." \
  --input session_name=auth-review \
  --manifest .guardrail/recipes/claude-exec.approved.json
```

AI recipe naming convention:

- Use `<tool>-exec` for single-shot wrappers around one underlying AI CLI.
- Use `*-workflow` or `*-lifecycle` only when the recipe owns multiple steps or service state.
- Keep the recipe id, recipe filename, and wrapper helper aligned where possible.

Bounded operational recipe naming convention:

- Use `<domain>-<action>` for single-purpose operational recipes like `git-branch-cleanup` and `git-commit`.
- Keep each recipe focused on one bounded action. Do not widen a commit recipe into push/merge/release behavior.

Bundled git commit recipe:

- `recipes/git-commit.recipe.json` wraps git staging plus `git commit` through `src/git-commit-wrapper.js`
- it stages only the approved `paths` list and reads the commit text from `message_file`
- `message_file` is content-hash bound at approval time and rechecked before execution
- this recipe does not push; use a separate approval unit if push behavior is needed later

Example interactive run:

```bash
cd /Users/adilevinshtein/Documents/dev/Guardian
node src/cli.js run --recipe git-commit \
  --input guardrail_repo=. \
  --input repo_path=. \
  --input paths=src/cli.js \
  --input paths=README.md \
  --input message_file=.guardrail/commit-message.txt \
  --manifest .guardrail/recipes/git-commit.approved.json
```

Public GitHub recipe install rules:

- Use `guardrail recipe install github://owner/repo/path.json@sha` with an explicit commit SHA.
- Short SHAs are input sugar only; Guardrail resolves and stores a full 40-character SHA before pinning.
- Do not assume a GitHub recipe is trusted just because it is pinned. Trusted-source config and later execution approval still apply.
- The agent runtime must have access to Guardrail trusted-source config for that `github://` prefix.
- Public repos can install through raw GitHub fetch alone. Private repos require `gh` to be installed and authenticated in the same runtime the agent uses.
- If the agent runs with a different `HOME`, container, or sandbox profile, make sure GitHub CLI auth is still reachable there. In practice this may mean setting `GH_CONFIG_DIR` explicitly.
- If neither raw GitHub access nor authenticated `gh` access is available, Guardrail fails closed and the agent must stop instead of bypassing the install path.

Private-repo agent install example:

```bash
GH_CONFIG_DIR=/path/to/gh-config \
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js recipe install \
  github://owner/repo/recipes/safe.recipe.json@<full-commit-sha>
```

## Adapter Mode

Use adapter mode when an agent invokes another tool through Guardrail:

```bash
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js adapter run --tool openclaw -- npm test
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js adapter run --profile ./my-tool-profile.json --env-allow ANTHROPIC_API_KEY -- npm test
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js adapter run --tool cline -- echo "blocked in v0.2"
```

If approval is not yet established in the current context, adapter runs are blocked with:

```bash
No approved manifest found. Run interactively to approve.
```

Useful adapter subcommands:

- `guardrail adapter run --tool <name> -- <command> [args...]`
- `guardrail adapter run --profile <profile-path> -- <command> [args...]`
- `guardrail adapter profile install github://owner/repo/path.json@<sha>`
- `guardrail adapter profile list`
- `guardrail adapter profile show <tool>`

Bounded auth preflight behavior:

- `requires_env` requires explicit env mappings. If a required variable is not in `--env-allow`, `adapter run` fails before execution with `missing_auth_mapping`.
- `requires_auth` validates bounded runtime state for known checks (for example `claude_login`, `gh_auth`) before process launch; missing checks fail with `missing_auth_prerequisite`.
- Auth preflight returns blocked status and stops. It does not log the agent in for you; authentication must already exist in the same runtime (`claude auth login` / `gh auth status/login`).
- MCP profiles are intentionally blocked in v0.2 at CLI level. Use env-shim/stdin-json profiles instead or wait for the roadmap to land.

## Workflow Authoring Note

When creating a first workflow for Phalanx-style lifecycle automation, do not guess the JSON shape from prose docs. Use the workflow schema patterns in `tests/test-workflow.js` as the source of truth.

Minimal valid task-only workflow:

```json
{
  "version": 1,
  "kind": "workflow_definition",
  "name": "test-workflow",
  "projectRoot": ".",
  "entryStep": "step_a",
  "maxIterations": 5,
  "services": [],
  "steps": [
    {
      "id": "step_a",
      "type": "task",
      "run": {
        "command": "echo",
        "args": ["hello"],
        "cwd": ".",
        "mode": "structured",
        "timeoutMs": 5000
      },
      "validator": "exit_code",
      "updateSource": "none",
      "on": {
        "success": "done",
        "validation_failed": "abort"
      }
    }
  ]
}
```

Minimal valid service-lifecycle workflow:

```json
{
  "version": 1,
  "kind": "workflow_definition",
  "name": "service-workflow",
  "projectRoot": ".",
  "entryStep": "start_svc",
  "maxIterations": 10,
  "services": [
    {
      "id": "api",
      "start": {
        "command": "node",
        "args": ["server.js"],
        "cwd": ".",
        "mode": "structured",
        "timeoutMs": 5000
      },
      "stop": {
        "signal": "SIGTERM",
        "killAfterMs": 5000
      }
    }
  ],
  "steps": [
    {
      "id": "start_svc",
      "type": "service_start",
      "serviceId": "api",
      "on": {
        "success": "run_task",
        "failure": "abort"
      }
    },
    {
      "id": "run_task",
      "type": "task",
      "run": {
        "command": "echo",
        "args": ["task"],
        "cwd": ".",
        "mode": "structured",
        "timeoutMs": 5000
      },
      "validator": "exit_code",
      "updateSource": "none",
      "on": {
        "success": "stop_svc",
        "validation_failed": "restart_svc"
      }
    },
    {
      "id": "restart_svc",
      "type": "service_restart",
      "serviceId": "api",
      "on": {
        "success": "run_task",
        "failure": "abort"
      }
    },
    {
      "id": "stop_svc",
      "type": "service_stop",
      "serviceId": "api",
      "on": {
        "success": "done",
        "failure": "abort"
      }
    }
  ]
}
```

Minimal valid workflow with chained recipe executions under one approval:

```json
{
  "version": 1,
  "kind": "workflow_definition",
  "name": "recipe-chain",
  "projectRoot": ".",
  "entryStep": "review",
  "maxIterations": 3,
  "services": [],
  "steps": [
    {
      "id": "review",
      "type": "recipe_ref",
      "recipe": "codex-exec",
      "inputs": {
        "working_dir": ".",
        "input_files": ["src/cli.js", "README.md"]
      },
      "on": {
        "success": "commit",
        "failure": "abort"
      }
    },
    {
      "id": "commit",
      "type": "recipe_ref",
      "recipe": "git-commit",
      "inputs": {
        "guardrail_repo": ".",
        "repo_path": ".",
        "paths": ["README.md"],
        "message_file": ".guardrail/commit-message.txt"
      },
      "on": {
        "success": "done",
        "failure": "abort"
      }
    }
  ]
}
```

Recipe resolution inside workflows follows the same rules as standalone recipe mode:

- `recipe: "name@1.2.3"` uses that exact installed version or fails.
- `recipe: "name"` resolves the latest installed version at approval time.
- The approved workflow pins the resolved recipe version and recipe hash. If the referenced recipe later changes, Guardrail treats that as workflow drift and stops for re-approval.

For the first pass, use the smallest real route set:

- `POST /api/start-project`
- `GET /api/project/:id`
- `GET /api/health`
- `POST /api/project/:id/abort`
- optional: `POST /api/project/:id/retry`

Do not keep searching for a separate generic "mark failed" endpoint. Model the terminal failure path as `abort` unless a more specific server-supported retry or review path is explicitly required.

## What the Agent Must Have

- the exact command or workflow definition path
- the exact recipe specifier when using recipe mode
- the exact approved manifest path
- confirmation that the manifest was created by an interactive Guardrail approval run

If the approved manifest does not exist, stop and ask for an interactive approval run first.

## Stop Conditions

If Guardrail returns any of these statuses, stop and report them:

- `approval_required`
- `approval_denied`
- `drift_detected`
- `validation_failed`
- `policy_violation`
- `update_denied`
- `unsupported`
- `protocol_error`
- `internal_error`

Do not auto-approve widened scope. Do not silently retry with changed inputs.

## Sandbox and Escalation Rule

If sandboxing blocks Guardrail from writing `.guardrail/approved.json`, `.guardrail/workflows/*.json`, `.guardrail/state.json`, or `.guardrail/logs/*`, rerun the same Guardrail command with escalated permissions.

Do not use escalation to bypass Guardrail and run the underlying command directly.

## Copy-Paste Handoff Prompt

```text
You are operating in /Users/adilevinshtein/Documents/dev/Guardian.

Read /Users/adilevinshtein/Documents/dev/Guardian/docs/agent-onboarding.md first.

Use Guardrail as the source of truth for approval and drift control. Do not bypass it by running the underlying command or workflow steps directly unless the user explicitly tells you to.

Use the local CLI entrypoint:
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js

Use this approved manifest:
<APPROVED_MANIFEST_PATH>

If this is command mode, run:
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js run --non-interactive --approved-manifest <APPROVED_MANIFEST_PATH> -- <command> [args...]

If this is workflow mode, run:
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js workflow run --definition <WORKFLOW_DEFINITION_PATH> --non-interactive --approved-manifest <APPROVED_MANIFEST_PATH>

If one approval should cover multiple recipe executions, express that as a workflow whose steps are `recipe_ref` entries. Do not run the sub-recipes directly.
If that workflow references recipes stored outside the workflow repo, add `--recipe-search-dir <PATH>` for each extra recipe root on both lint and run commands.

If this is recipe mode, run:
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js run --recipe <RECIPE_ID[@VERSION]> --input key=value --non-interactive --approved-manifest <APPROVED_MANIFEST_PATH>

If the manifest is missing, or Guardrail returns approval_required, approval_denied, drift_detected, validation_failed, policy_violation, update_denied, unsupported, protocol_error, or internal_error, stop and report it.

If sandboxing blocks Guardrail from writing under .guardrail/, rerun the same Guardrail command with escalated permissions. Do not bypass Guardrail.
```
