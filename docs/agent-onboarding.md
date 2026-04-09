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

Use `--passthrough-tty` only for approval-bearing interactive runs. The approval prompt expects the literal string `APPROVE` (mode-agnostic), not `y` or `yes`. After the manifest exists, go back to the normal wrapped non-interactive path.

Important channel rule:

- Approval to run an escalated shell command is not the same as approving the Guardrail execution itself.
- If Guardrail is already waiting at its TTY approval prompt, get explicit user confirmation for the Guardrail action, then send the literal `APPROVE` followed by newline to the live PTY session.
- Do not assume a chat reply automatically reached the terminal, and do not assume shell escalation approval auto-approved Guardrail.

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

Live progress stream:

```bash
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js workflow run --definition <workflow-definition-path> --non-interactive --approved-manifest <approved-workflow-manifest-path> --json-stream
```

When approval is required, `approval_pending` is the explicit approval event before runtime start in workflow mode. The runtime harmonization is intended to keep this behavior aligned for command and template/recipe modes as well.

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

## Template Mode

Template authors should include these top-level fields at minimum:
- `version`
- `kind`
- `name`
- `description`
- `trust_class`
- `risk`
- `inputs` as an object map
- `run`

Minimal valid template JSON:

```json
{
  "version": 1,
  "kind": "template",
  "name": "echo-message",
  "description": "Print one message to stdout",
  "trust_class": "reviewed_internal",
  "risk": "green",
  "inputs": {
    "message": {
      "type": "string",
      "required": true,
      "description": "Text to print",
      "pattern": "^.{1,64}$"
    }
  },
  "run": {
    "command": "echo",
    "args": ["{{message}}"],
    "mode": "structured"
  }
}
```

Interactive approval:

```bash
cd /Users/adilevinshtein/Documents/dev/Guardian
node src/cli.js run --template <TEMPLATE_PATH> --input message=hello --manifest <APPROVED_TEMPLATE_MANIFEST_PATH>
```

Non-interactive reuse:

```bash
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js run --template <TEMPLATE_PATH> --input message=hello --non-interactive --approved-manifest <APPROVED_TEMPLATE_MANIFEST_PATH>
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

- If the recipe specifier includes `@version`, Guardrail uses exactly that available version from the recipe search dirs or fails.
- If the recipe specifier omits `@version`, Guardrail resolves the latest available version from the recipe search dirs.
- An approval for an unpinned recipe binds to the resolved latest version at approval time. If a newer version later becomes latest, Guardrail treats that as drift and stops for re-approval.
- Recipe dry-run remains a preview path and does not require an approved manifest.
- Recipe input constraints validate what values are allowed, but approval reuse still binds to the exact resolved input values saved in the manifest.

Finding recipes:

- `node src/cli.js <anything> --help` prints the global CLI usage block, not a subcommand-scoped flag contract. Do not assume every flag shown there applies to `run --recipe`.
- List available recipes:

```bash
cd /Users/adilevinshtein/Documents/dev/Guardian
node src/cli.js list
node src/cli.js list --json
node src/cli.js list --category <category> --search <text>
```

- Show installed versions for one recipe id:

```bash
cd /Users/adilevinshtein/Documents/dev/Guardian
node src/cli.js recipe versions <recipe-id>
```

- Bundled recipes in the local `recipes/` directory are already runnable by id. They do not need a separate `recipe install` step just because `recipe versions` reports no installed versions.
- `recipe versions <recipe-id>` reports registry-installed versions, not every bundled flat recipe file under local `recipes/`. Use `list` and normal recipe resolution for bundled recipes.
- To find the bundled Claude recipe specifically, look for `claude-exec` in `node src/cli.js list` output. `node src/cli.js recipe versions claude-exec` may still say `No installed versions` even when the bundled local recipe file exists.
- For required inputs and defaults on a bundled recipe, read the local recipe file itself (`recipes/<id>.recipe.json`). Do not infer the canonical input shape from old logs or plan docs.

- Recipe lookup locations: `recipes`, `node_modules/.guardrail/recipes`, `~/.guardrail/recipes`.

- Standalone `run --recipe` resolves the local `recipes/` directory relative to the current working directory, not relative to `src/cli.js`.
- `--recipe-search-dir <path>` is workflow-only. Use it on `workflow lint` and `workflow run` for `recipe_ref` resolution, but do not expect `run --recipe`, `list`, or global CLI parsing to accept it.
- If you need standalone recipe execution from a different working directory, either change cwd so the intended local `recipes/` directory resolves correctly, or install the recipe into `~/.guardrail/recipes` / make it available through `node_modules/.guardrail/recipes`.
- Installing a bundled local recipe into the home registry is valid when you need standalone `run --recipe` from another cwd:

```bash
cd /Users/adilevinshtein/Documents/dev/Guardian
node src/cli.js recipe install recipes/<recipe-id>.recipe.json
```

- After install, `run --recipe <recipe-id>` can resolve from other working directories through `~/.guardrail/recipes`. This solves recipe availability only; it does not create approval.
- Guardrail state stays rooted at the actual current working directory. Logs, locks, state, default manifests, and agent-session contracts still live under `<cwd>/.guardrail` unless you pass an explicit manifest path for the manifest file itself.
- If a recipe needs two sibling repos as relative path inputs and those inputs block `..`, the only legal cwd may be their shared parent. In that shape you can still point the manifest file at the target repo explicitly, but the rest of Guardrail state remains rooted under the shared-parent cwd.
- Keep the blockers separate:
  - `recipe not found`: change cwd so local `recipes/` resolves, or install the recipe into a supported registry location
  - `No approved manifest found` / `approval_required`: stop and do an interactive Guardrail approval run; `recipe install` will not solve approval
  - path-policy rejection for `..` or absolute paths: choose a cwd where every required path input can be expressed as an allowed relative path
- Recipe availability is separate from approval reuse. If the recipe resolves but `.guardrail/recipes/<recipe-id>.approved.json` does not exist for the current repo, stop and run an interactive Guardrail approval instead of searching for another install path.
- Workflow manifests under `.guardrail/workflows/*.approved.json` do not satisfy standalone recipe mode. For `run --recipe`, only the matching recipe manifest under `.guardrail/recipes/` counts.
- Standalone `run --recipe` can now declare `requires_env`. When a recipe does, pass the matching vars with repeated `--env-allow` flags and treat that env contract as part of approval drift.
- `requires_auth` preflight still lives in Adapter Mode. Do not go hunting for adapter-only auth flags when a recipe run fails after approval.

AI execution recipes:

- Use recipe mode when an agent needs a bounded wrapper around an external AI CLI instead of calling that tool directly.
- Treat the selected local recipe file (`recipes/<id>.recipe.json`) as the source of truth for required inputs, defaults, enums, and path rules. Do not infer the live shape from old logs, plan docs, or another recipe.
- Read the recipe description and guardrails for tool-specific auth/runtime notes. Bundled AI recipes may require a pre-authenticated CLI runtime even though recipe mode itself does not perform auth preflight.
- If the recipe declares `requires_env`, pass the matching vars with repeated `--env-allow` flags. The approved recipe manifest binds to the resolved env intersection, so widening that list later triggers re-approval.
- If the recipe declares `input_files`, those files are prompt-bearing context owned by Guardrail. In current bundled wrappers they are read by the wrapper and injected into the initial prompt payload directly, so do not add a second instruction telling the downstream tool to open them just to provide the same context.
- Keep stable prompt material in `input_files` when the recipe supports it. Inline prompt-bearing inputs marked `review_each_time` require fresh approval every run, even if unchanged.
- Bounded reuse now supports list-shaped inputs too, when the recipe or template declares an explicit `approval_mode: "list"` plus a bounded `item_validator` and `max_items`. This is the right shape for approved test-file lists or similar fixed-command multi-file runs.
- `content_hash` and `review_each_time` are still stronger than bounded list reuse. If a file-bearing input is content-hash bound, changing the file set or file contents still causes drift/reapproval even when the input itself is a list.
- Some AI recipes include other required prompt-bearing inputs, which can make the recipe effectively approval-per-run. Check the recipe file before assuming unattended reuse is possible.
- For bundled `claude-exec`, the current standalone recipe env handshake is: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TERM_PROGRAM`, `LANG`, `TMPDIR`, `PWD`, `XDG_CONFIG_HOME`, and `CLAUDE_CONFIG_DIR`. Pass them with repeated `--env-allow` flags when present in the runtime you are validating.
- For bundled `claude-exec`, use the recipe path to prove the CLI runtime works and to establish the bounded approval/unit. If you need unattended reruns with a fixed `system_prompt`, switch to a local template that wraps `src/claude-exec-wrapper.js` directly, because `prompt` and `system_prompt` remain `review_each_time` in recipe mode.
- Transport/orchestration is a separate boundary. `claude-exec` does not include “launch this in another host runtime” behavior. If the tool must run through a different launcher, terminal surface, remote shell, container, or other host-runtime hop, use a separate transport/orchestration recipe instead of treating that outer hop as part of the exec recipe itself.
- A transport/orchestration recipe should make the extra hop explicit: create or select the target surface, execute a bounded composed exec contract there or, if composition is not available yet, send a bounded inner `guardrail run --recipe <exec-recipe> ...` command, and capture resulting state. It does not bypass the inner exec recipe approval semantics, `review_each_time`, or auth/runtime requirements.
- Today, if a transport/orchestration recipe launches an inner `guardrail run`, the outer transport layer and inner exec layer are separate approval units with separate manifests. Do not assume nested runs collapse into one approval automatically.
- Bundled `cmux-claude-exec` now uses the composed single-approval path instead of a nested inner Guardrail run. Use it when Claude must run inside that terminal surface and you want one approval that still binds the composed `claude-exec` trust/env/input/session semantics honestly.
- Repeated reuse of the same host-runtime lane is still a separate problem. Current composition gives one approval per composed run, not "approve the lane once and trigger it forever." If the workflow needs that shape, treat it as a not-yet-shipped resident transport/session feature rather than assuming the composed recipe already covers it.
- Path-bearing inputs like `guardrail_repo`, `working_dir`, `input_files`, `add_dirs`, or output-file paths usually use relative-path policy and often block `..`. If Guardrail lives in one repo and the target run lives in a sibling repo, choose a current working directory where both can be named without `..` segments.
- Omit optional tool-capability knobs unless the caller actually needs them. Extra inputs widen the approval surface and create more drift opportunities.
- When a structured command needs multiple files, use an exact `{{inputs.some_list}}` placeholder in the args array so the validated list expands into multiple structured argv entries. Do not fall back to a freeform string of space-separated paths.
- Guardrail session-lifecycle inputs such as `lifecycle`, `session_name`, and `session_id` are Guardrail-side contract metadata. They do not by themselves become downstream tool CLI flags, restore local tool state, or bypass prompt reapproval.
- Session contracts are stored at `<projectRoot>/.guardrail/agent-sessions/<recipeId>/<slot>.json` and are independent from the recipe manifest. They bind tool, recipeId, recipeVersion, workingDir, scope, sessionName, and sessionId.
- `continue` and `attach` fail closed with stable machine-readable reasons such as `session_missing`, `session_drift`, `session_attach_mismatch`, or `session_already_exists`. Any identity-field change forces fresh approval.
- Guardrail never reads tool-private home directories to discover session ids or prompt state. If a session id is part of the recipe contract, it must come from explicit recipe input.
- AI execution recipes are not an outer sandbox. If they run outside your host sandbox/container boundary, the underlying tool executes with host privileges subject to that tool's own permission model.
- Stateful CLI login is also outside the recipe boundary. If approval succeeds but the wrapped CLI exits with a login/auth error, do not re-approve, reinstall, or widen the recipe first. Fix the CLI auth state in the same runtime that launches Guardrail, then rerun the same approved command.
- Same runtime does not just mean the same machine. Start by comparing the same resolved tool binary on `PATH` plus the same auth-location environment and config directories, but do not assume env alignment is always sufficient.
- Some CLI login state is backed by OS-managed secure stores or launcher-specific runtime identity rather than plain files under `HOME`. In those cases `which -a <tool>` and env alignment are necessary diagnostics, not a guaranteed fix.
- Examples of host-runtime boundaries include terminal multiplexers, GUI-launched shells, SSH sessions, containers, CI runners, and any launcher that changes subprocess identity or secure-store access.
- If a working shell already exists for that CLI, prefer launching Guardrail from that same shell/runtime. If the CLI must be logged in again for Guardrail reuse, perform the login flow from the exact same shell/runtime that will later launch Guardrail.

Host runtime preflight:

- Treat the host runtime as part of the recipe contract for external CLIs. Do not tell yourself to "adjust env as needed" without a concrete mismatch.
- Before running a host CLI recipe, prove the target shell can run the tool directly:
  - `which -a <tool>`
  - `<tool> auth status`
  - `sh -c '<tool> auth status && <tool> <minimal command>'`
- Use env changes only as a targeted repair step after an observed mismatch in binary resolution or config-path inputs. Do not widen env blindly.
- Repair order:
  - align the resolved binary / `PATH`
  - align declared config env vars if they differ
  - rerun the same subprocess test
  - if that still fails, assume secure-store or process-identity gating and stop guessing
- If the subprocess test fails, Guardrail will fail too. The practical fix is to run Guardrail from a shell/runtime where that subprocess test already passes, or redo login from the exact same shell/runtime that will later launch Guardrail.
- For Claude specifically, use `claude-exec` when the current shell/runtime already passes the Claude subprocess test. Use a separate transport/orchestration recipe only when Claude must run in a different host runtime and that outer hop must be explicit.

Generic interactive example:

```bash
cd <WORKSPACE_ROOT_WITHOUT_DOTDOT_SEGMENTS>
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js run --recipe <AI_RECIPE_ID> \
  --env-allow <REQUIRED_ENV_VAR> \
  --input working_dir=<TARGET_PROJECT_DIR_RELATIVE_TO_CWD> \
  --input input_files=<PROMPT_CONTEXT_FILE_RELATIVE_TO_WORKING_DIR> \
  --input <OTHER_REQUIRED_KEY>=<value> \
  --manifest <TARGET_PROJECT_APPROVED_RECIPE_MANIFEST_PATH>
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
- it stages only the approved `paths` list, fails closed if unrelated staged changes already exist, and returns a clean no-op when approved paths have no staged diff
- it reads the commit text from `message_file`, which is content-hash bound at approval time and rechecked before execution
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
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js adapter run --tool <tool-name> -- <command> [args...]
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js adapter run --profile ./my-tool-profile.json --env-allow API_KEY -- <command> [args...]
```

If approval is not yet established in the current context, adapter runs are blocked with:

```bash
No approved manifest found. Run interactively to approve.
```

Adapter mode operator rules:

- `adapter run` does not accept `--manifest`, `--approved-manifest`, `--recipe-search-dir`, or recipe-specific input flags. Do not try to solve adapter failures with recipe-mode arguments.
- Start by discovering the profile surface you actually have: `adapter profile list` and `adapter profile show <tool>`.
- Treat the selected adapter profile as the source of truth for protocol, auth requirements, defaults, and response shape. Do not infer adapter behavior from unrelated recipe docs.
- If adapter mode reports `No approved manifest found. Run interactively to approve.`, that is an approval problem, not a recipe-install problem. Do not switch to `recipe install` or `run --recipe` unless the user explicitly wants a different execution mode.
- `adapter run` builds on the selected profile and the underlying supervisor contract. If the profile/runtime does not support the interactive approval path you need, stop and report that instead of guessing hidden flags.

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
- Explicit env mapping may still be insufficient for CLIs whose login state lives in OS-managed secure stores or other process-identity-gated locations. In those cases the practical fix is to run Guardrail from the same working launcher/runtime, or to redo login from the exact shell/runtime that will later launch Guardrail.
- This adapter auth-preflight section explains the shipped `requires_env` / `requires_auth` behavior. Standalone recipe mode does not yet run the same preflight automatically, so recipe-mode agents must rely on the selected recipe's auth/runtime notes plus direct tool checks in the Guardrail runtime.
- MCP protocol profiles are intentionally blocked in v0.2 at CLI level. Use a supported non-MCP profile shape instead or wait for the roadmap to land.

Host runtime decision rule:

- For both adapter mode and recipe mode, the load-bearing question is whether the target shell can run the tool as a subprocess before Guardrail is added on top.
- If `which -a <tool>` differs, fix the binary path first.
- If the binary matches but auth/config env differs, align only the declared config inputs and rerun the subprocess test.
- If the subprocess test still fails, stop modifying env and move the Guardrail run into a shell/runtime where the tool already works, or redo login in that exact shell/runtime.

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
  "rollback_policy": "none",
  "rollback_none_reason": "No rollback needed for this read-only example.",
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
  "rollback_policy": "none",
  "rollback_none_reason": "Example workflow shape only; add an explicit rollback policy for real service mutations.",
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
  "rollback_policy": "none",
  "rollback_none_reason": "Example approval shape only; real recipe chains should declare rollback intentionally.",
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

- `recipe: "name@1.2.3"` uses that exact available version from the recipe search dirs or fails.
- `recipe: "name"` resolves the latest available version from the recipe search dirs at approval time.
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

If the caller does not provide an approved manifest yet, stop and ask for an interactive Guardrail approval run in a real TTY. Do not try to solve a missing-manifest problem with `recipe install`, `recipe versions`, or by running the underlying command directly.

If you launch that interactive Guardrail run in a PTY session and it reaches the approval prompt, keep the session open. After the user explicitly approves the Guardrail action, write the literal `APPROVE` into that PTY session yourself.

If this is command mode, run:
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js run --non-interactive --approved-manifest <APPROVED_MANIFEST_PATH> -- <command> [args...]

If this is workflow mode, run:
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js workflow run --definition <WORKFLOW_DEFINITION_PATH> --non-interactive --approved-manifest <APPROVED_MANIFEST_PATH>

If this is template mode, run:
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js run --template <TEMPLATE_PATH> --input key=value --non-interactive --approved-manifest <APPROVED_MANIFEST_PATH>

If this is recipe mode, run:
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js run --recipe <RECIPE_ID[@VERSION]> --input key=value --non-interactive --approved-manifest <APPROVED_MANIFEST_PATH>

Use `--json-stream` if the caller wants machine-readable progress events:
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js workflow run --definition <WORKFLOW_DEFINITION_PATH> --non-interactive --approved-manifest <APPROVED_MANIFEST_PATH> --json-stream
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js run --non-interactive --approved-manifest <APPROVED_MANIFEST_PATH> --json-stream -- <command> [args...]
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js run --template <TEMPLATE_PATH> --input key=value --non-interactive --approved-manifest <APPROVED_MANIFEST_PATH> --json-stream
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js run --recipe <RECIPE_ID[@VERSION]> --input key=value --non-interactive --approved-manifest <APPROVED_MANIFEST_PATH> --json-stream

If one approval should cover multiple recipe executions, express that as a workflow whose steps are `recipe_ref` entries. Do not run the sub-recipes directly.
If that workflow references recipes stored outside the workflow repo, add `--recipe-search-dir <PATH>` for each extra recipe root on both lint and run commands.

If the manifest is missing, or Guardrail returns approval_required, approval_denied, drift_detected, validation_failed, policy_violation, update_denied, unsupported, protocol_error, or internal_error, stop and report it.

If sandboxing blocks Guardrail from writing under .guardrail/, rerun the same Guardrail command with escalated permissions. Do not bypass Guardrail.
```
