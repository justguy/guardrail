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

Template authoring and publishing:

```bash
cd /Users/adilevinshtein/Documents/dev/Guardian
node src/cli.js template create --from-manifest .guardrail/approved.json --name my-template
node src/cli.js template list
node src/cli.js template publish --template .guardrail/templates/my-template.json --name my-template --category custom
```

Template bridge rules:

- `template create --from-manifest` can generate a starter template from an approved command manifest or approved recipe manifest.
- Generated templates record source provenance. If the template later drifts from its recorded source hash, Guardrail demotes source trust instead of silently preserving it.
- `template publish` currently supports command-shaped templates. If a template includes rollback steps, stop and author the target recipe manually.

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

- Duplicate-source collision is a separate failure mode from “recipe not found.” If the same recipe id/version is visible from more than one root at the same precedence point, Guardrail fails closed instead of silently choosing one.
- The common concrete case is running from the Guardrail repo while the same bundled recipe is also installed in `~/.guardrail/recipes` or `node_modules/.guardrail/recipes`.
- If that happens, do not guess which source Guardrail “meant.” Fix it by changing `cwd` so only the intended root is visible, or by removing the duplicate installed/local copy.
- For example, if `claude-exec` is bundled in the Guardrail checkout and also installed globally, launching `run --recipe claude-exec` from a target workflow repo is the correct fix; launching it from the Guardrail checkout is what creates the ambiguity.

- Bundled recipes in the local `recipes/` directory are already runnable by id. They do not need a separate `recipe install` step just because `recipe versions` reports no installed versions.
- `recipe versions <recipe-id>` reports registry-installed versions, not every bundled flat recipe file under local `recipes/`. Use `list` and normal recipe resolution for bundled recipes.
- To find the bundled Claude recipe specifically, look for `claude-exec` in `node src/cli.js list` output. `node src/cli.js recipe versions claude-exec` may still say `No installed versions` even when the bundled local recipe file exists.
- For required inputs and defaults on a bundled recipe, read the local recipe file itself (`recipes/<id>.recipe.json`). Do not infer the canonical input shape from old logs or plan docs.

- Recipe lookup locations: `recipes`, `node_modules/.guardrail/recipes`, `~/.guardrail/recipes`.
- Workflow `recipe_ref` now uses those same default lookup roots automatically. Use `--recipe-search-dir` only for extra ad hoc roots outside those defaults.
- Workflow approvals bind `recipe_ref` sources through portable source locators instead of absolute recipe file paths, so moving the same repo between laptop/CI/shared-runner checkout paths does not cause drift by itself.
- Extra configured roots can now come from:
  - repo-local `.guardrail/config.json` via `"default_recipe_roots": ["../shared-recipes"]`
  - user-level `~/.guardrail/config.json` via `"default_recipe_roots": ["/abs/path/to/shared-recipes"]`
- `recipe_roots` is still accepted as a compatibility alias for `default_recipe_roots`.
- Configured default recipe roots are additional search roots, not silent overrides. Explicit `--recipe-search-dir` still wins, and missing configured roots fail closed.
- If the active org policy defines `trusted_recipe_roots`, extra configured roots and explicit extra roots must stay inside that allowlist. Guardrail loads the active policy from `.guardrail/org-policy.json` or `.guardrail/org-policies/default.json` before accepting those extra roots.
- Remote recipe installs and adapter-profile installs now load that same active org policy by default and enforce `trusted_execution_sources` before they fetch GitHub or URL content. Do not assume a remote install is allowed just because `trusted_sources` in config would permit it.
- Self-hosted recipe registries are a separate trust boundary. `guardrail recipe registry list <registry>` and `guardrail recipe install <category/id@version> --registry <registry>` enforce org-policy `trusted_registries`, not `trusted_execution_sources`.
- If the same recipe id/version is discoverable from more than one root at the same precedence point, Guardrail fails closed with an explicit collision error instead of silently picking one candidate.
- Workflow manifests bind `recipe_ref` source provenance through portable source locators (`sourceRootKind` + relative locator), not absolute checkout paths. That avoids false drift when the repo checkout path changes.
- External workflow roots now record stable origin locators (`explicit`, `repo_config`, `user_config`, or `absolute`). That keeps repo-configured shared roots portable across machines while still forcing drift if a workflow resolves the same recipe filename from a different shared root.
- The source class still matters. If a workflow was approved against `node_modules/.guardrail/recipes` and later resolves the same recipe from local `recipes/` or an external root, Guardrail treats that as workflow drift and stops for reapproval.
- When a recipe cannot be found, Guardrail now includes the current search order in the error. Use that before assuming the recipe id is wrong.

- Standalone `run --recipe` resolves the local `recipes/` directory relative to the current working directory, not relative to `src/cli.js`.
- Portability is not the same as availability: if another machine cannot resolve the referenced recipe from its local/default/shared roots, workflow normalization still fails closed until that recipe source exists there.
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
- Standalone `run --recipe` can now declare `requires_env` and bounded `requires_auth`. When a recipe does, pass the matching vars with repeated `--env-allow` flags and treat that env contract as part of approval drift.
- Workflow `recipe_ref` steps now honor the same bounded auth/runtime contract as standalone recipe mode. Guardrail preflights declared `requires_auth` before the child recipe launches, passes the recipe's declared env requirements through the workflow execution contract, and stops with `missing_auth_prerequisite` instead of letting the downstream tool die late.
- Recipe-mode `requires_auth` now fails before launch with `missing_auth_prerequisite` instead of letting the downstream tool die late. Do not go hunting for adapter-only auth flags when a recipe run blocks on that reason; fix auth in the selected runtime and rerun the same approved recipe.

AI execution recipes:

- Use recipe mode when an agent needs a bounded wrapper around an external AI CLI instead of calling that tool directly.
- Communication matrix:
  - `prompt`: one user message for the current turn. In interactive recipes this is usually `interactive_message`, so later text may change without reapproval only inside the same persistent named session.
  - `input_files`: stable prompt-bearing context set. Approve the full planned file set up front and keep it stable through the review loop.
  - `system_prompt`: executable-boundary instruction layer. Keep it fixed for the whole session; changing it triggers reapproval.
  - `lifecycle=start`: create a fresh bounded session.
  - `lifecycle=continue` / `attach`: send later turns into the same bounded session identity.
  - `session_name` / `session_id`: session identity keys. Changing them changes the session boundary.
  - `lane start`: one-time host-runtime startup for a resident interactive lane.
  - `lane send`: later turn/message traffic through an existing resident lane.
  - `lane result`: read the stored output for the latest or named resident-lane request.
  - `lane status`: inspect whether the lane is ready, busy, failed, expired, stale, or stopped before sending again.
  - `lane stop`: explicit teardown of the resident lane.
- Fast decision sequence for AI runtimes:
  - resolve the intended recipe source first; if Guardrail reports a duplicate-source collision, fix `cwd` or remove the duplicate source before doing anything else
  - prove whether the current shell/runtime can run the downstream CLI directly with the subprocess test
  - if the current runtime already works, use the direct exec recipe
  - if the tool only works in a different already-authenticated host runtime, use the transport/orchestration recipe for that runtime
  - if the workflow needs repeated interaction or repeated monitoring after startup, prefer the resident FIFO lane instead of repeating transport launches
  - if direct exec and the composed host-runtime path both fail with the same downstream auth error, stop retrying Guardrail shapes and fix tool auth in the target host runtime
  - if a guarded lane or hosted recipe later fails, check Guardrail-managed status/audit first and use raw host-surface inspection only as a last resort
- Treat the selected local recipe file (`recipes/<id>.recipe.json`) as the source of truth for required inputs, defaults, enums, and path rules. Do not infer the live shape from old logs, plan docs, or another recipe.
- Read the recipe description and guardrails for tool-specific auth/runtime notes. Bundled AI recipes may require a pre-authenticated CLI runtime, and recipes that declare `requires_auth` now fail before launch with the same bounded `missing_auth_prerequisite` semantics adapter mode uses.
- Bundled Guardrail recipes now resolve shipped wrapper helpers through internal bundled-wrapper aliases. Do not assume `guardrail_repo` is required just because older examples passed it; keep it only when a specific recipe still declares it as an optional override or compatibility input.
- If the recipe declares `requires_env`, pass the matching vars with repeated `--env-allow` flags. The approved recipe manifest binds to the resolved env intersection, so widening that list later triggers re-approval.
- If the recipe declares `input_files`, those files are prompt-bearing context owned by Guardrail. In current bundled wrappers they are read by the wrapper and injected into the initial prompt payload directly, so do not add a second instruction telling the downstream tool to open them just to provide the same context.
- Keep stable prompt material in `input_files` when the recipe supports it. Inline prompt-bearing inputs marked `review_each_time` require fresh approval every run, even if unchanged.
- Some AI recipes and templates now distinguish between automation prompts and direct user messages. `approval_mode: "interactive_message"` means later prompt text may change without reapproval only when the run is continuing or attaching to the same persistent named session and the executable boundary is otherwise unchanged. It does not bypass approval for new sessions, changed session identity, changed runtime/tool/model/env/cwd budget, or any `review_each_time` companion input such as `system_prompt`.
- For a human-in-the-loop multi-doc review loop, approve the full planned document set up front in `input_files`, keep `system_prompt` fixed, and then advance slice by slice with later `interactive_message` follow-ups in the same persistent named session. Do not add or swap prompt files mid-loop unless you intend to trigger fresh approval.
- For that multi-doc loop, read “one approval” narrowly: one Guardrail approval can cover the approved doc set and session boundary, but an outer host-runtime or sandbox approval may still be needed to start the session in the correct runtime.
- Bounded reuse now supports list-shaped inputs too, when the recipe or template declares an explicit `approval_mode: "list"` plus a bounded `item_validator` and `max_items`. This is the right shape for approved test-file lists or similar fixed-command multi-file runs.
- `content_hash` and `review_each_time` are still stronger than bounded list reuse. If a file-bearing input is content-hash bound, changing the file set or file contents still causes drift/reapproval even when the input itself is a list.
- Some AI recipes include other required prompt-bearing inputs, which can make the recipe effectively approval-per-run. Check the recipe file before assuming unattended reuse is possible.
- For direct interactive chat that must survive repeated host-runtime turns, prefer the resident lane CLI surface over repeated outer transport launches:
  - `node src/cli.js lane start --id <lane-id> [--tool claude|codex] ...`
  - `node src/cli.js lane send --id <lane-id> --prompt "<message>"`
  - `node src/cli.js lane result --id <lane-id> [--request-id <id>]`
  - `node src/cli.js lane status --id <lane-id>`
  - `node src/cli.js lane stop --id <lane-id>`
- `node src/cli.js lane list [--json]`
- `node src/cli.js lane prune [--include-failed true] [--json]`
- `lane start` is the one-time host-runtime step. It launches the resident daemon through a short-lived helper in the authenticated runtime, creates owner-only request/response FIFOs (`0600`), generates an ephemeral per-lane key under `~/.guardrail/lanes/<id>.key`, writes an explicit `.guardrail/lanes/<id>/identity.json` record plus a fresh boot nonce, records the selected tool, and fixes the executable boundary for later messages.
- Lanes can also declare optional work ownership up front:
  - `--scope-type repo|worktree|paths`
  - `--scope-mode warn|block`
  - repeated `--scope-path <repo-relative-path>` when `scope-type=paths`
- Scope conflicts are compared only against other live lanes in the same repo lane registry. `warn` allows startup but surfaces the conflicting live lanes in `lane start`, `lane status`, and `lane list`. `block` fails closed before startup.
- `lane send` is the per-message step. It reads the host-side key through the Guardrail CLI, signs the request, writes the strict JSON payload into the lane FIFO, and reads the matching response back without reopening the outer transport/runtime hop.
- If a request outlives the client-side wait window, `lane send` now returns a structured `pending` result with the request id instead of reporting `lane_expired`. Treat that as “the lane accepted the request and it is still running,” not as proof that Claude failed.
- `lane result` is the bounded recovery/read step for those cases. Use it to fetch the stored output for the latest or named request after a long-running turn completes.
- `lane stop` is the explicit teardown step. It terminates the daemon, removes the lane FIFOs, and purges the host-side key.
- `lane status` is the introspection step. Use it before assuming a lane is dead or starting a replacement. It reports whether the lane is ready, busy, failed, expired, stale, or stopped, includes the current request id/start time plus the last completed result path, and surfaces `failureReason`, `failureStage`, `logPath`, lane identity, and boot nonce metadata when bootstrap, immediate post-start, or runtime startup failed. If the daemon disappears before the first request and no explicit failure metadata was written, Guardrail now infers that as `failed/post_start` instead of leaving a silent stale lane.
- `lane list` is the portfolio view. Use it before starting another lane when multiple agents may already be active in the same repo.
- `lane list` and `lane status` now surface declared scope ownership and overlapping live-lane conflicts. Read those first instead of guessing whether another agent already owns the same write surface.
- `lane prune` removes dead lane artifacts (`stale`, `expired`, `stopped` by default). Use it after diagnosis/cleanup, not as a first reaction to a live lane you have not inspected yet.
- Claude-oriented lane flags: `--system-prompt`, `--permission-mode`, `--allowed-tools`, `--max-budget-usd`, `--effort`, `--output-format`.
- Codex-oriented lane flags: `--profile`, `--sandbox`, `--image-files`, `--color`, `--oss`, `--local-provider`, `--skip-git-repo-check`, `--ephemeral`, `--full-auto`.
- The practical review-loop shape is:
  - start one approved Claude session with the full planned doc set in `input_files`
  - keep `system_prompt` fixed for the entire loop
  - ask for only the first slice/report
  - review the output with the user
  - send the next prompt through the same session or resident lane
  - repeat until the pre-approved doc set is exhausted
- Treat that as one Guardrail approval for the doc-set/session contract, not as a promise that no outer host-runtime approval will be needed to reach the authenticated runtime in the first place.
- Workflow chaining is usually the wrong tool for that specific review loop because it is optimized for bounded multi-step execution, not for pause-and-review interaction between each doc slice.
- If a guarded lane, transport recipe, or composed host-runtime recipe already exists, debug it through Guardrail-managed signals first:
  - `lane result`
  - `lane status`
  - the current repo audit/log entries for the active trace/session
  - recipe/lane-managed status outputs
- Do not jump straight to raw host-surface inspection commands just because a hosted run exited nonzero. Listing host surfaces, selecting runtimes, or capturing host-side output directly are escalation-only fallbacks and can trigger additional user approvals one command at a time.
- Do not jump straight to raw host process inspection (`ps`, `lsof`, direct pane capture, etc.) just because a resident lane is busy or a client timed out. First use `lane status`, `lane result`, and any lane-owned artifacts. Raw host inspection is a separate approval-bearing capability and will keep retriggering approvals.
- If `lane start` returns `lane_boot_failed`, treat that as a bounded Guardrail diagnosis first, not as an instruction to capture the host pane immediately. Read `lane status` and the lane log path first; only fall back to raw host inspection if those Guardrail-owned surfaces still do not explain the failure.
- For proof validation after a Guardrail run, prefer `node src/cli.js repo status --path <repo> --json` over ad hoc `git diff --name-only`. The Guardrail command surfaces staged, unstaged, and untracked files together so review does not silently miss newly created artifacts.
- If the task declared a specific output artifact, such as a report file, patch file, or generated manifest, do not report the slice as complete until that exact artifact exists at the declared path. A green-looking run without the promised file is still an incomplete result.
- The rule is: bounded surface first, raw surface second. Only fall back to direct host-surface commands when Guardrail does not already expose the needed state.
- Treat host-runtime selection as an expected routing decision, not as a surprising late-stage workaround. If a tool is authenticated or functional only in a different launcher, terminal surface, remote shell, container, or similar runtime, choose that runtime early and explain it plainly as “this tool must run in the already-working host runtime,” not as a mysterious new failure after several retries.
- When switching runtimes, name the reason in one sentence: same tool contract, different host runtime. Example: “the guarded Claude wrapper is unchanged; only the host runtime changes because the authenticated terminal surface is where Claude CLI login is currently valid.”
- Do not present a runtime switch as if Guardrail has changed its approval model or as if the user must infer hidden state. The agent should make the boundary explicit: exec contract stays the same, host runtime changes, and the switch is to avoid repeating known-failing paths in an unauthenticated shell.
- Resident lane CLI actions also append lifecycle entries to the repo audit log: `lane_start`, `lane_send`, `lane_result`, `lane_stop`, and `lane_prune`. Use `.guardrail/audit.jsonl` when you need to reconstruct whether a lane was started, reused, queried for results, expired, explicitly torn down, or pruned after it went dead.
- The resident FIFO bridge is intentionally narrow:
  - request schema is exactly `{ "id": "...", "prompt": "..." }`
  - request ids are bounded and pattern-checked
  - request ids are one-shot inside a live lane; duplicate ids are rejected as replay attempts
  - prompts are size-limited
  - oversized or malformed payloads are dropped
  - partial/incomplete writes time out and are discarded
- The host-side lane key is ephemeral by default. If the daemon idles out, crashes, or is stopped, the key is deleted. Later `lane send` calls should treat missing key/FIFO state as `lane_expired` and start a fresh lane instead of trying to resume stale secrets.
- Treat lane startup as the approval-bearing/runtime-bearing step. Treat later `lane send` turns as bounded session traffic, not as a new launcher/surface request.
- Guardrail now fails closed if another live lane with the same lane id already exists in the same repo lane registry. Do not work around that by inventing a second lane with the same purpose; use `lane list` first and either reuse the live lane or stop/prune the dead one explicitly.
- For multi-agent work, declare the narrowest honest lane scope you can. Use `repo` only when the whole repo is the intentional ownership boundary, `worktree` when a lane should claim its working directory subtree, and `paths` for explicit repo-relative write surfaces such as `src/api` or `docs/plans`.
- For bundled `claude-exec`, the current standalone recipe env handshake is: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TERM_PROGRAM`, `LANG`, `TMPDIR`, `PWD`, `XDG_CONFIG_HOME`, and `CLAUDE_CONFIG_DIR`. Pass them with repeated `--env-allow` flags when present in the runtime you are validating.
- For bundled `claude-exec`, use the recipe path to prove the CLI runtime works and to establish the bounded approval/unit. In current shipped recipe mode, `prompt` is session-bound `interactive_message` while `system_prompt` remains `review_each_time`. That means later user messages can change inside the same persistent named session, but a changed `system_prompt` or a new session still re-prompts. If you need unattended reruns with a fixed `system_prompt`, switch to a local template that wraps `src/claude-exec-wrapper.js` directly.
- Transport/orchestration is a separate boundary. `claude-exec` does not include “launch this in another host runtime” behavior. If the tool must run through a different launcher, terminal surface, remote shell, container, or other host-runtime hop, use a separate transport/orchestration recipe instead of treating that outer hop as part of the exec recipe itself.
- A transport/orchestration recipe should make the extra hop explicit: create or select the target surface, execute a bounded composed exec contract there or, if composition is not available yet, send a bounded inner `guardrail run --recipe <exec-recipe> ...` command, and capture resulting state. It does not bypass the inner exec recipe approval semantics, `review_each_time`, or auth/runtime requirements.
- Today, if a transport/orchestration recipe launches an inner `guardrail run`, the outer transport layer and inner exec layer are separate approval units with separate manifests. Do not assume nested runs collapse into one approval automatically.
- If that transport/orchestration path later fails, do not immediately switch to ad hoc host-surface commands for investigation. Check the bounded Guardrail status path first, because raw host-surface inspection is itself another approval-bearing boundary.
- Bundled `cmux-claude-exec` now uses the composed single-approval path instead of a nested inner Guardrail run. Use it when Claude must run inside that terminal surface and you want one approval that still binds the composed `claude-exec` trust/env/input/session semantics honestly.
- For composed host-runtime Claude runs, the wrapper intentionally isolates the child environment with `env -i` and then rehydrates only the approved env intersection. If you see `env -i` in a pane capture, do not treat that alone as the bug; the real questions are whether the required vars were explicitly approved and whether the bounded wrapped-runtime Claude exec probe succeeds.
- Bundled `cmux-claude-exec` now defaults to one hosted auth-repair attempt. If the hosted Claude probe or exec hits login in that selected runtime, Guardrail will run `claude auth login --console` there, rerun the bounded probe, and retry the original exec once before giving up.
- If that hosted login still needs a human to finish it, expect the machine-readable failure `auth_repair_pending_user_input`. That means Guardrail already reached the right runtime and started the right repair command; the remaining action is to finish login there and rerun the same approved contract, not to invent a new execution path.
- Diagnosis rule for host-runtime auth failures:
  - if direct exec in the current shell fails with a tool-auth error such as `Not logged in`
  - and the composed host-runtime recipe for the same tool fails with the same tool-auth error
  - stop treating it as Guardrail approval drift or recipe failure
  - conclude that the target host runtime is missing tool auth
  - next step: repair login in that exact host runtime, then rerun the same approved Guardrail contract
- Hosted Claude auth-repair sequence:
  - start `cmux-claude-exec` with the approved doc packet
  - let Guardrail run its hosted `claude --print` probe
  - if that hosted probe or exec hits login, Guardrail now starts `claude auth login --console` in that exact runtime automatically once
  - if the hosted login completes and the wrapped probe passes, Guardrail retries the original Claude exec automatically
  - if Guardrail returns `auth_repair_pending_user_input`, finish login in that already-selected host runtime and rerun the same approved manifest
  - do not call the slice complete unless the declared output artifact now exists
- Wording rule for those cases:
  - say `blocked by tool auth in the host runtime`
  - do not just say `blocked` without naming whether the block is Guardrail policy or downstream tool auth
- Repeated reuse of the same host-runtime lane is still a separate problem. Current composition gives one approval per composed run, not "approve the lane once and trigger it forever." If the workflow needs that shape, treat it as a not-yet-shipped resident transport/session feature rather than assuming the composed recipe already covers it.
- For repeated interaction or repeated monitoring in the same authenticated host runtime, prefer the resident FIFO lane over repeated transport recipe launches or repeated raw host-surface inspection. The FIFO lane exists specifically to avoid paying another approval-bearing host-surface hop for every send/capture/debug turn.
- Guardrail transcripts and execution reports are accelerators, not proof. Before accepting a result, validate the actual branch state, changed files, and requested proof artifacts rather than trusting the session narrative alone.
- The simplest branch-state proof check is `node src/cli.js repo status --path <repo> --json`. Use it when you need one bounded snapshot that includes tracked changes plus untracked outputs.
- The completion rule is strict: if the promised artifact is missing, the slice is not done, even if the run produced logs, approvals, or partial stdout that look successful.
- Apply that rule to hosted AI runs too: an approved manifest or a successful transport launch does not count as slice completion without the declared output artifact.
- Path-bearing inputs like `guardrail_repo`, `working_dir`, `input_files`, `add_dirs`, or output-file paths usually use relative-path policy and often block `..`. If Guardrail lives in one repo and the target run lives in a sibling repo, choose a current working directory where both can be named without `..` segments.
- Omit optional tool-capability knobs unless the caller actually needs them. Extra inputs widen the approval surface and create more drift opportunities.
- When a structured command needs multiple files, use an exact `{{inputs.some_list}}` placeholder in the args array so the validated list expands into multiple structured argv entries. Do not fall back to a freeform string of space-separated paths.
- Guardrail session-lifecycle inputs such as `lifecycle`, `session_name`, and `session_id` are Guardrail-side contract metadata. They do not by themselves restore local tool state or bypass `review_each_time` inputs, but recipes that explicitly mark `prompt` as `interactive_message` can use the same session identity to distinguish later user messages from executable-boundary drift.
- Session contracts are stored at `<projectRoot>/.guardrail/agent-sessions/<recipeId>/<slot>.json` and are independent from the recipe manifest. They bind tool, recipeId, recipeVersion, workingDir, scope, sessionName, and sessionId.
- `continue` and `attach` fail closed with stable machine-readable reasons such as `session_missing`, `session_drift`, `session_attach_mismatch`, or `session_already_exists`. Any identity-field change forces fresh approval.
- Guardrail never reads tool-private home directories to discover session ids or prompt state. If a session id is part of the recipe contract, it must come from explicit recipe input.
- The common interactive shape is: keep `system_prompt` fixed in the recipe or template, mark the user-facing `prompt` as `interactive_message`, and then reuse the same approved manifest only for later messages in the same persistent named session.
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

Bundled commit-plan recipe:

- `recipes/git-commit-from-plan.recipe.json` wraps bounded commit execution through `src/git-commit-plan-wrapper.js`
- it accepts a content-hash-bound `plan_file` plus a content-hash-bound `message_file`
- Guardrail approval stores derived execution details from the plan: repo path, exact resolved file list, approved bounds, and message file path
- the wrapper rejects any mismatch between `plan.message_file` and the recipe input `message_file`
- use this path when an earlier workflow step proposes a reviewed commit slice after the final changed file set becomes known

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
- For self-hosted or air-gapped distribution, Guardrail can now export a static recipe registry snapshot with `guardrail recipe registry export <output-dir>`. That snapshot writes `v1/recipes/index.json`, per-recipe metadata, and per-version JSON documents for static hosting.
- The same static layout is now consumable through Guardrail too:

```bash
node src/cli.js recipe registry list /srv/guardrail-registry
node src/cli.js recipe install infra/terraform-plan-only@1.0.0 --registry /srv/guardrail-registry
```

- Registry installs are exact-version only today. Keep discovery and bare-name install separate from this path.

Private-repo agent install example:

```bash
GH_CONFIG_DIR=/path/to/gh-config \
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js recipe install \
  github://owner/repo/recipes/safe.recipe.json@<full-commit-sha>
```

Safe plan-only infrastructure recipe:

```bash
node src/cli.js run --recipe terraform-plan-only \
  --input config_path=infra/staging \
  --dry-run
```

- Use `terraform-plan-only` when the task is reviewable planning only.
- Use `infra-deploy` only when the task truly needs approval-bearing mutation (`apply`) and the operator wants that stronger contract.

Other shipped `R0a` recipe batch entries:
- `git-clone-allowed` for bounded GitHub clone operations into relative destinations
- `gh-open-pr` for opening a reviewed pull request through `gh`
- `gh-release` for creating a release from an explicit tag and reviewed notes file
- `docker-build` for bounded build-context image builds
- `docker-push` for explicit image pushes to an approval-bound registry/tag

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
- MCP profiles are still blocked at runtime, but they may now declare an explicit `mcp_transport` contract. Treat that as design-gate metadata only until Guardrail ships actual MCP transport support.
- If a blocked MCP run mentions a declared transport, that means the profile shape was recognized; it does not mean the MCP runtime is live.
- The shipped MCP exceptions are additive and explicit, not ambient. `adapter probe --tool <name>` is the discovery-only path for MCP `stdio` profiles: Guardrail approves and launches the declared transport, performs `initialize` plus `tools/list`, and reports the discovered tool inventory. `adapter mcp tools --tool <name>` is the agent-facing inventory view for that same bounded path: it returns the discovered tool metadata so you can choose an MCP tool without guessing. `adapter mcp call --tool <name> --mcp-tool <tool> --params-json <json>` is the first bounded runtime path: it performs exactly one `tools/call` over the declared transport with explicit tool name and JSON params. `adapter mcp batch --tool <name> --calls-json <json>` is the next bounded runtime path: it performs an explicit array of `{ tool, params }` MCP calls over one approved stdio session.
- Neither of those exceptions makes `adapter run` live for MCP profiles. `adapter run` still blocks on MCP profiles, so do not describe the MCP runtime as “generally supported” yet.

Useful adapter subcommands:

- `guardrail adapter run --tool <name> -- <command> [args...]`
- `guardrail adapter run --profile <profile-path> -- <command> [args...]`
- `guardrail adapter probe --tool <name>`
- `guardrail adapter mcp tools --tool <name>`
- `guardrail adapter mcp call --tool <name> --mcp-tool <tool> --params-json <json>`
- `guardrail adapter mcp batch --tool <name> --calls-json <json>`
- `guardrail adapter profile index verify <path> --index-key <pubkey.pem>`
- `guardrail adapter profile install github://owner/repo/path.json@<sha>`
- `guardrail adapter profile install <tool-name> --index <path> --index-key <pubkey.pem>`
- `guardrail adapter profile list`
- `guardrail adapter profile show <tool>`

Bounded auth preflight behavior:

- `requires_env` requires explicit env mappings. If a required variable is not in `--env-allow`, `adapter run` fails before execution with `missing_auth_mapping`.
- `requires_auth` validates bounded runtime state for known checks (for example `claude_login`, `claude_exec_probe`, `gh_auth`) before process launch; missing checks fail with `missing_auth_prerequisite`.
- The same env/auth preflight applies to `adapter probe` before the MCP stdio transport is launched. If the probe blocks on `missing_auth_mapping` or `missing_auth_prerequisite`, fix the runtime and rerun the probe; do not assume the probe can bypass adapter auth requirements.
- Auth preflight returns blocked status and stops. It does not log the agent in for you; authentication must already exist in the same runtime (`claude auth login` / `gh auth status/login`). Exception: the bundled composed Claude host-runtime recipe can perform one bounded hosted `claude auth login --console` repair attempt before it gives up with `auth_repair_pending_user_input`.
- Explicit env mapping may still be insufficient for CLIs whose login state lives in OS-managed secure stores or other process-identity-gated locations. In those cases the practical fix is to run Guardrail from the same working launcher/runtime, or to redo login from the exact shell/runtime that will later launch Guardrail.
- The same bounded `requires_env` / `requires_auth` preflight now applies to standalone recipe mode and workflow `recipe_ref` execution too. For composed host-runtime recipes, env mapping is checked before launch and the child tool-auth preflight runs again inside the selected host runtime before the downstream CLI starts.
- MCP protocol profiles are intentionally blocked for `adapter run` in v0.2. Use `adapter probe` or `adapter mcp tools` for bounded discovery and `adapter mcp call` / `adapter mcp batch` for explicit `tools/call` execution; do not reinterpret arbitrary shell commands as MCP requests. When the profile declares required capability discovery, both bounded call surfaces now validate the requested tool set against the discovered MCP inventory before they launch the runtime transport.
- When an MCP profile declares required capability discovery, Guardrail now validates `--mcp-tool <name>` against the discovered MCP tool set before it launches the bounded `tools/call`. Treat an unknown-tool validation failure as a caller error, not as proof that the transport itself is broken.
- Bare-name adapter-profile install is now supported only when you also provide a signed index plus public key: `adapter profile install <tool> --index <path> --index-key <pubkey.pem>`. Treat that as a local/team distribution flow, not ambient public discovery. Without those index inputs, bare-name install still fails closed.

Host runtime decision rule:

- For both adapter mode and recipe mode, the load-bearing question is whether the target shell can run the tool as a subprocess before Guardrail is added on top.
- If `which -a <tool>` differs, fix the binary path first.
- If the binary matches but auth/config env differs, align only the declared config inputs and rerun the subprocess test.
- If the subprocess test still fails, stop modifying env and move the Guardrail run into a shell/runtime where the tool already works, or redo login in that exact shell/runtime.
- For Claude specifically, do not over-trust shell-level green status. The exact Guardrail-launched wrapped subprocess must pass; “installed and authenticated somewhere on the machine” is not enough.

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
- Workflow `recipe_ref` now carries the same bounded recipe auth/runtime preflight as standalone recipe mode. If the referenced recipe declares `requires_auth`, Guardrail checks that before the child recipe launches and fails closed with `missing_auth_prerequisite` when the workflow runtime is not ready.

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
