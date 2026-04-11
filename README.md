# Guardrail

**Automate repeatable CLI and agent-assisted tasks safely, without silent scope drift.**

> I got tired of scripts silently doing more than I asked. So I built Guardrail.

---

Guardrail is a productivity layer for bounded automation. It sits above commands, workflows, templates, recipes, adapters, and long-running lanes, and it enforces the contract under which they run.

It does not do the work itself. It keeps the work honest.

The product thesis is simple:

- workers do the work
- agents manage the workers
- Guardrail manages the managers by keeping execution boundaries honest

This is not a security product. It is a local-first tool for trusted automation that reduces silent scope drift, makes repeated guarded execution practical, and preserves operator visibility as automation gets more layered.

---

## The Problem: Silent Drift

You write `npm test`. Somewhere along the way it becomes:

```bash
npm install && npm test
```

Nobody asked for `npm install`. It crept in -- through a script edit, a CI refactor, or an AI agent "helping." The command surface expanded silently, and you approved it by not noticing.

This is **scope drift**. It happens in build scripts, CI pipelines, AI-assisted workflows, and iterative repair loops. It's rarely malicious. It's almost always invisible.

---

## Limitations

> Guardrail enforces execution contracts and reduces accidental drift.
> It does not guarantee containment of malicious code.

- **Not a sandbox.** It does not isolate processes or restrict syscalls.
- **Not a container replacement.** It does not limit filesystem or network access.
- **Not safe for untrusted binaries.** It verifies *what* runs, not *what it does once running*.
- **Cannot prevent a running process from self-modifying.**

Guardrail is a contract layer, not a security boundary.

---

## The Blocked-Drift Moment

This is what Guardrail does:

```
Execution paused

Requested change:
+ Add command: npm install

This is outside your approved contract.
Run halted. Re-run with explicit approval to widen scope.
```

Nothing runs past that point. Every command is checked against what you already approved. If anything changed -- a new flag, a new binary, a wider scope -- execution stops and Guardrail requires a new manifest-backed approval.

---

## How It Works

**Contract-locked execution.** Every command, workflow, template, and non-dry-run recipe execution is normalized or hashed and stored as an approved manifest. The same approved shape produces the same hash. Anything else is a new approval unit.

**Drift detection.** Changes to command name, arguments, scope, or risk level block execution immediately. No silent pass-through.

**Traffic-light risk model.** Each command gets a risk classification:

| Level | Meaning | Example |
|-------|---------|---------|
| Green | Bounded, local, reviewed | `npm test`, `eslint .` |
| Yellow | Broader blast radius, service lifecycle, secrets in structured mode | `npm install`, service restart |
| Red | Shell + secrets, production targets, elevated privileges, unknown provenance | `curl \| sh`, shell mode injecting `DB_PASSWORD` |

Risk levels come with human-readable reasons so you know *why* something was flagged.

Secret detection scans both `envPolicy.inject` keys and `envPolicy.allow` lists for patterns like `SECRET`, `TOKEN`, `PASSWORD`, `API_KEY`, `CREDENTIAL`, `AUTH`, and `PRIVATE_KEY`. Secrets combined with shell mode or production targets escalate to Red.

**Manifest reuse.** Once you approve a manifest, it's saved. The same command, workflow, template, or recipe execution runs without re-prompting until something changes. Out-of-scope update proposals are halted and require a new approval record; Guardrail does not grant one-off in-session overrides.

**TTY note for first approval.** First interactive approval needs a real TTY. If you run Guardrail through `tpf`, use `tpf --passthrough-tty ...` for the approval-bearing command so Guardrail can render and read its own prompt. The interactive prompt expects the literal approval token `APPROVE`, not `y` or `yes`. After the manifest exists, normal non-interactive reuse can go back to the standard wrapped path.

**Approval granularity.** Template and recipe schemas can constrain inputs, but the approved manifest still binds to the exact resolved input values for that run. If `port=3001` was approved, later running `port=3002` is drift today even if the schema allows both values.

**Concurrency model.** Guardrail locks execution per approved manifest hash. Different workflows or manifests can run at the same time. The same approved execution cannot run twice concurrently.

---

## Four Execution Modes

### 1. Command Mode

Run a single command under contract:

```bash
guardrail run -- npm test
guardrail run --shell "npm test && npm run lint"
```

### 2. Workflow Mode

Run a multi-step workflow definition with services, transitions, and state machines:

```bash
guardrail workflow run --definition workflows/server-cycle.json
guardrail workflow lint --definition workflows/server-cycle.json
```

Workflow steps can be regular `task` steps, service lifecycle steps, or `recipe_ref` steps. Use `recipe_ref` when you want one workflow approval to cover a bounded chain of recipe executions instead of approving each recipe separately.

Workflow recipe discovery now shares the same default roots as standalone recipe mode:
- local `recipes/`
- `node_modules/.guardrail/recipes`
- `~/.guardrail/recipes`
- extra configured roots from repo-local `.guardrail/config.json` or user-level `~/.guardrail/config.json` via `default_recipe_roots` (`recipe_roots` is still accepted as a compatibility alias)

If the same recipe id/version appears in more than one root at the same precedence point, Guardrail fails closed with explicit collision diagnostics instead of silently choosing one.

If a workflow lives in one repo but references recipes stored in additional roots outside those defaults, pass `--recipe-search-dir <path>` one or more times on both `workflow lint` and `workflow run`:

```bash
guardrail workflow lint \
  --definition workflows/review-and-commit.json \
  --recipe-search-dir /abs/path/to/Guardian/recipes

guardrail workflow run \
  --definition workflows/review-and-commit.json \
  --recipe-search-dir /abs/path/to/Guardian/recipes
```

### 3. Template Mode

Run a parameterized, contract-locked execution template with typed inputs, environment handshake, and rollback:

```bash
# Explore a template
guardrail template lint --template ./templates/npm-publish.json
guardrail template explain --template ./templates/npm-publish.json
guardrail template schema --template ./templates/npm-publish.json

# Simulate without executing
guardrail template simulate \
  --template ./templates/npm-publish.json \
  --input package_dir=packages/my-lib \
  --input tag=beta

# Execute
guardrail run \
  --template ./templates/npm-publish.json \
  --input package_dir=packages/my-lib \
  --input tag=beta

# Show diff from approved hash
guardrail template diff --template ./templates/npm-publish.json

# Generate a starter template from an approved manifest
guardrail template create \
  --from-manifest .guardrail/approved.json \
  --name npm-publish

# List local templates
guardrail template list

# Publish a command-shaped template through the recipe pipeline
guardrail template publish \
  --template .guardrail/templates/npm-publish.json \
  --name npm-publish \
  --category packages
```

Templates support two kinds:
- **`kind: "template"`** -- Single command with typed inputs
- **`kind: "workflow_template"`** -- Multi-step with rollback support

Templates enforce structured mode only (no shell), require constrained inputs (pattern or enum for strings), and use an explicit environment handshake so templates cannot silently harvest env vars.

Minimal valid template JSON example:

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

Template inputs are constrained by schema, but approval reuse is still exact-value based on the resolved input set recorded in the manifest.

Guardrail can now bridge approved executions back into authoring flow:
- `template create --from-manifest` turns an approved command or recipe manifest into a starter template with recorded source provenance
- `template list` shows local templates plus whether recorded source trust still matches
- `template publish` converts a command-shaped template into a publishable recipe

Rollback-bearing workflow templates still need manual recipe authoring; `template publish` currently rejects templates with rollback steps.

Bundled Guardrail recipes also resolve shipped wrapper helpers internally now, so cross-repo runs no longer need to thread checkout-path args just to find Guardrail-owned wrapper scripts.

Extra recipe roots remain opt-in, but they no longer bypass central governance: repo/user-configured `default_recipe_roots` and explicit extra roots are blocked when the active org policy does not trust them via `trusted_recipe_roots` in `.guardrail/org-policy.json` or `.guardrail/org-policies/default.json`.

Remote recipe installs and adapter-profile installs now load that same active org policy by default and enforce `trusted_execution_sources` before pulling GitHub or URL content.

Workflow approvals now bind `recipe_ref` sources through portable source locators instead of absolute recipe file paths, so the same workflow can move between different checkout paths or runners without false drift from path changes alone. External shared roots now record stable origin locators (`explicit`, `repo_config`, `user_config`, or `absolute`) so two different shared roots with the same relative recipe filename cannot silently reuse approval.

### 4. Resident Lane Mode

Keep an interactive AI session alive behind one bounded lane, then send later user messages without reopening the outer transport every turn:

```bash
# Start the lane once from the authenticated host runtime
guardrail lane start \
  --id claude-live \
  --system-prompt "Answer directly and briefly."

# Later turns go through the lane FIFO bridge
guardrail lane send \
  --id claude-live \
  --prompt "2x3=?"

# Inspect whether the lane is still alive before restarting it
guardrail lane status --id claude-live

# Read the latest or named result without reopening the outer transport
guardrail lane result --id claude-live

# Tear the lane down explicitly when done
guardrail lane stop --id claude-live

# Inspect all repo-local lanes in one view
guardrail lane list --json

# Remove stale/expired/stopped lane artifacts once you're done diagnosing them
guardrail lane prune --json

# Start a Codex-backed lane with the same lifecycle/status/result surface
guardrail lane start \
  --id codex-live \
  --tool codex \
  --profile dev

# Declare a bounded write/work scope when multiple lanes may coexist
guardrail lane start \
  --id docs-review \
  --scope-type paths \
  --scope-mode warn \
  --scope-path docs/plans \
  --scope-path docs/references
```

Resident lanes are for direct interactive use when the executable boundary should stay fixed but later user messages should not count as execution drift. The shipped lane control plane now supports both `claude` and `codex` adapters behind the same `lane start` / `lane send` / `lane result` / `lane status` / `lane stop` surface. The current helper:
- creates owner-only FIFOs (`0600`) under the lane directory
- stores an ephemeral per-lane HMAC key outside the workspace at `~/.guardrail/lanes/<id>.key`
- accepts only strict JSON requests with `id` and `prompt`
- can require an HMAC signature delivered through an inherited file descriptor instead of env or workspace state
- rejects duplicate request ids inside the active lane window to make signed FIFO sends one-shot
- enforces prompt and payload size limits
- expires after idle timeout, removes its key/FIFOs, and records lane state under `.guardrail/lanes/<name>/state.json`
- writes an explicit lane identity record under `.guardrail/lanes/<name>/identity.json` so Guardrail can reason about ownership and boot identity separately from leftover FIFOs or keys
- appends `lane_start`, `lane_send`, `lane_result`, and `lane_stop` lifecycle entries to `.guardrail/audit.jsonl` so later ops review can distinguish lane creation, message traffic, result reads, expiry, and explicit teardown

Resident lanes are also the first step toward the broader "manager of managers" direction for Guardrail. Today Guardrail ships lifecycle control for individual named lanes, repo-local lane registry/pruning, tool-selectable adapters, and first-pass swarm scope coordination. Broader portfolio UX, richer resource classes, and transport plugins remain roadmap items.

Lane startup still has to happen in a runtime where the downstream CLI auth already works. Direct AI recipes can now declare bounded `requires_auth` checks too, so Guardrail fails before launch with `missing_auth_prerequisite` instead of letting the underlying CLI die late. The same bounded preflight now applies when those recipes are executed through workflow `recipe_ref` steps, so chained recipe workflows stop before launch on missing tool auth instead of surfacing a late downstream CLI failure. `lane start` now launches the daemon through a short-lived helper so the resident lane survives the wrapped CLI process exiting, records a fresh boot nonce in the lane identity record, and fails closed if another live lane with the same lane id already exists in that repo lane registry. Lanes can also declare `--scope-type repo|worktree|paths` plus `--scope-mode warn|block` and repeated `--scope-path <relative-path>` values. Guardrail compares those declared scopes only against other live lanes in the same repo registry and surfaces overlapping ownership through `lane start`, `lane status`, and `lane list`; `block` prevents startup, while `warn` starts the lane and records the conflict set. Later `lane send` turns reuse that resident lane instead of launching a fresh outer transport hop each time. If the lane has expired, `lane send` returns a structured `lane_expired` error and the correct recovery is to run `lane start` again. Use `--tool claude` (default) or `--tool codex` to bind that lane to the right wrapped executor.
Guardrail now exposes first-class startup and long-turn state for resident lanes. If a request outlives the client-side wait window, `lane send` returns a structured `pending` response with the request id instead of collapsing into `lane_expired`. `lane start` also now fails early with `lane_boot_failed` when the daemon dies during bootstrap or in the immediate post-start window, and `lane status` reports `failureReason`, `failureStage`, and `logPath` when a lane is in `failed` state. If the daemon disappears before the first request and leaves no explicit failure metadata, Guardrail now infers that as `failed/post_start` instead of showing a bare `stale` lane. Use `lane status` to see whether the lane is `ready`, `busy`, `failed`, `expired`, `stale`, or `stopped`, including the current request id/start time, lane identity metadata, and the last completed result path. Use `lane result` to read the stored output for the latest or named request once it completes. Use `lane list` to inspect every repo-local lane in one portfolio view, and `lane prune` to remove dead lane artifacts with explicit audit entries once diagnosis is complete. Raw host inspection should be the last resort, not the default recovery path.
If a direct recipe run and a composed host-runtime recipe both fail with the same downstream tool-auth error such as `Not logged in`, treat that as missing auth in the target host runtime, not as Guardrail drift. Direct recipes now preflight in the current runtime; composed host-runtime recipes re-run the same bounded auth check inside the hosted surface before the downstream CLI starts. For Claude, the bundled recipes now use a real bounded `claude --print` probe instead of trusting `claude auth status` alone. Hosted transport wrappers still isolate the child env with `env -i` and rehydrate only the approved vars, so seeing `env -i` in a pane capture is expected; missing runtime vars or false-positive shell-level auth are the real failure modes. The bundled `cmux-claude-exec` recipe now defaults to one hosted auth repair attempt too: if the hosted probe or exec hits login, Guardrail runs `claude auth login --console` in that exact hosted runtime, reruns the probe, and retries the original exec once. If login itself still needs a human to finish it, the run now fails with `auth_repair_pending_user_input` instead of pretending the slice ran. For repeated interaction or monitoring after startup, prefer the resident FIFO lane over repeated raw host-surface inspection commands so you do not trigger another approval-bearing transport hop every turn.

Communication matrix:
- `prompt`: one user message for the current turn
- `input_files`: stable prompt-bearing context set approved up front
- `system_prompt`: fixed executable-boundary instruction layer
- `lifecycle=start`: create a fresh bounded session
- `lifecycle=continue` / `attach`: later turns in the same session
- `session_name` / `session_id`: session identity keys
- `lane start`: one-time host-runtime startup for a selected tool (`claude` by default; `--tool codex` when needed)
- `scope-type` / `scope-mode` / `scope-path`: optional lane ownership declaration for concurrent agents (`repo`, `worktree`, or explicit repo-relative paths; compare only against other live lanes)
- `lane send`: later message traffic through the resident lane
- `lane result`: read the stored output for the latest or named request
- `lane status`: inspect ready/busy/failed/expired/stale/stopped lane state plus tool, current request visibility, and startup failure detail
- `lane stop`: explicit teardown
- `lane list`: enumerate repo-local lanes and their current state
- `lane prune`: remove dead lane artifacts from the repo-local registry

Scope coordination rules:
- `scope-type=repo`: claim the whole repo as an exclusive ownership boundary; Guardrail treats this as `block`
- `scope-type=worktree`: claim the current `working_dir` subtree
- `scope-type=paths`: claim one or more explicit repo-relative paths via repeated `--scope-path`
- `scope-mode=warn`: start the lane and surface overlapping live lanes in `lane start`, `lane status`, and `lane list`
- `scope-mode=block`: fail closed before startup if any live lane overlaps the declared scope
- Conflict comparison is repo-local only: Guardrail compares declared scopes only against other live lanes in the same `.guardrail/lanes` registry
- Claude-oriented lane flags: `--system-prompt`, `--permission-mode`, `--allowed-tools`, `--max-budget-usd`, `--effort`, `--output-format`
- Codex-oriented lane flags: `--profile`, `--sandbox`, `--image-files`, `--color`, `--oss`, `--local-provider`, `--skip-git-repo-check`, `--ephemeral`, `--full-auto`

Recommended multi-doc review loop:
- approve the full planned doc set up front in repeated `input_files`
- keep `system_prompt` fixed for the whole loop
- start one persistent Claude session in the correct runtime
- ask for only the first slice/report
- review the result with the user
- continue with later prompts through the same session or resident lane
- do not add or swap prompt files mid-loop unless you want reapproval
- do not use workflow chaining for this exact pause-and-review loop unless the workflow truly can run unattended between review points

Read “one approval” narrowly here: one Guardrail approval can cover the approved doc set plus session boundary. An outer host-runtime or sandbox approval may still be needed to start that session in the correct authenticated runtime.

Practical agent rule:
- direct exec recipe if the current runtime already passes the downstream CLI subprocess test
- transport/orchestration recipe if the tool only works in a different authenticated host runtime
- resident lane if the workflow needs repeated messages or repeated monitoring after startup
- if `lane send` returns `pending`, check `lane status` and then `lane result` before considering a restart
- if `lane start` fails with `lane_boot_failed`, read `lane status` before dropping to raw pane capture
- if `cmux-claude-exec` returns `auth_repair_pending_user_input`, finish Claude login in that already-selected host runtime and then rerun the same approved contract
- use `guardrail repo status --path <repo>` when you need a proof check that includes staged, unstaged, and untracked files in one view
- if a run was supposed to create a specific report, patch, or other named artifact, do not report the slice as complete until that exact file exists at the declared path
- raw host-surface inspection only after Guardrail-managed status/result/audit paths are exhausted
- Guardrail transport state does not replace proof validation against the real branch state. Use Guardrail reports to narrow the path quickly, then still verify the actual branch/files before accepting the result.

Hosted Claude auth-repair flow:
- run `cmux-claude-exec` with the approved doc packet
- if the hosted probe or exec hits login, Guardrail runs `claude auth login --console` in that same hosted runtime automatically once
- if the hosted login completes and the wrapped probe passes, Guardrail retries the original Claude exec automatically
- if Guardrail returns `auth_repair_pending_user_input`, finish login in that already-selected host runtime and rerun the same approved manifest
- no report file, no completion: do not call the slice done until the declared artifact exists

---

## Trust and Risk

Guardrail separates `trust` from `risk`.

Trust classes describe provenance:

- **reviewed_internal** -- first-party and intentionally maintained
- **pinned_external** -- external but pinned to a known version or commit
- **generated** -- AI-generated or dynamically produced
- **unknown** -- provenance unclear

Risk levels describe operational danger:

- **Green** -- tightly bounded local execution
- **Yellow** -- broader blast radius, service lifecycle, shell mode, or patch/restart behavior
- **Red** -- generated/unknown provenance, installs, admin tooling, destructive behavior, production-like targets, or secret exposure combined with shell mode or production targets

Guardrail shows both the trust class and the risk reasons at approval time. Non-interactive reuse requires a previously acknowledged Guardrail manifest; a matching file without that acknowledgement is rejected.

---

## Template System

Templates are typed, signed execution contracts that map validated user inputs to structured OS process arguments -- never to a shell string.

```
OpenClaw:  user input -> shell string -> OS
Guardrail: user input -> schema validation -> args array -> OS (no shell)
```

Key properties:
- **Input validation pipeline**: Type check -> pattern/enum/range -> injection scan -> interpolation -> args array
- **Environment handshake**: Template declares `requires_env`, caller declares `allow` -- only the intersection reaches the process
- **Cryptographic provenance**: `SHA256(template + inputs + env)` -- drift detection on every re-run
- **Rollback**: Required when any step is `idempotent: false`, runs automatically on failure
- **Lint**: 8 checks including bare string rejection, ReDoS detection, risk consistency

For the full template specification, see [docs/guardrail-template-implementation.md](docs/guardrail-template-implementation.md).

---

## 🔥 Guardrail Recipes

**A library of safe, pre-approved execution patterns for real-world developer and AI workflows.**

Guardrail Recipes are not a template gallery or a config repo. Each recipe is a packaged execution bundle with typed inputs, versioned artifacts, manifest-backed approval for real execution, and runtime guardrails around danger, scope, and provenance.

For open-source distribution, treat recipes as auditable artifacts, not safety certificates. Registry review, pinning, and provenance checks reduce ambiguity; they do not guarantee that a community recipe is harmless once executed.

### Browse the Recipe Library

| Category | Examples |
|----------|----------|
| **GitHub** | `open_pr`, `clone_repo`, `release_safe` |
| **Package** | `npm_install_safe`, `pip_install_safe` |
| **Cloud** | `aws_s3_sync_safe`, `terraform_plan_only` |
| **AI / Agent** | `fix_tests`, `debug_ci`, `safe_deploy` |

### Using Recipes

```bash
# Install a recipe from a file
guardrail recipe install ./my-recipe.recipe.json

# Install from a URL (trusted sources required in ~/.guardrail/config.json)
guardrail recipe install https://registry.example.com/recipes/deploy.recipe.json

# Install from GitHub with an immutable commit pin
guardrail recipe install github://guardrail-dev/recipes/github/open-pr.json@a3f9c12e4b7d8f0a1c2e3d4f5a6b7c8d9e0f1a2b

# Export a static self-hosted recipe registry snapshot
guardrail recipe registry export ./dist/recipe-registry

# List available recipes
guardrail list

# Dry-run a recipe (latest version)
guardrail run --recipe git-branch-cleanup --input repo_path=. --dry-run

# Safe Terraform planning without apply/destroy
guardrail run --recipe terraform-plan-only --input config_path=infra/staging --dry-run

# Pin to a specific version
guardrail run --recipe git-branch-cleanup@1.0.0 --input repo_path=. --dry-run

# Execute a recipe interactively (stores approval manifest)
guardrail run --recipe git-branch-cleanup --input repo_path=.

# Create a bounded git commit from exact paths and a hashed message file
guardrail run --recipe git-commit \
  --input guardrail_repo=. \
  --input repo_path=. \
  --input paths=src/cli.js \
  --input paths=README.md \
  --input message_file=.guardrail/commit-message.txt

# Create a bounded git commit from a reviewed commit-plan artifact
guardrail run --recipe git-commit-from-plan \
  --input plan_file=.guardrail/commit-plans/auth-slice.json \
  --input message_file=.guardrail/commit-messages/auth-slice.txt

# Turn an approved manifest back into a starter template and publish it
guardrail template create --from-manifest .guardrail/approved.json --name npm-publish
guardrail template publish --template .guardrail/templates/npm-publish.json --name npm-publish --category packages

# List local templates and their current trust/provenance status
guardrail template list

```

Notes:
- This recipe fails closed if unrelated files are already staged outside the approved `paths`.
- If the approved paths produce no staged diff, it succeeds as a clean no-op and does not create a commit.
- The commit step only commits the approved `paths`, never unrelated staged content.

```bash
# Run Codex with an inline prompt plus reusable file-backed prompt context
guardrail run --recipe codex-exec \
  --input working_dir=. \
  --input prompt="Review this change for security issues." \
  --input input_files=src/recipe-install.js \
  --input input_files=src/recipe-runner.js

# Run Claude with an inline prompt plus one hashed prompt file
guardrail run --recipe claude-exec \
  --input guardrail_repo=. \
  --input working_dir=. \
  --input prompt="Review authRedirectFlow.test.js for flakiness." \
  --input input_files=tests/integration/authRedirectFlow.test.js \
  --input model=sonnet \
  --input effort=high \
  --input mode=plan \
  --input output_format=text \
  --input max_budget_usd=1.00 \
  --input system_prompt="Focus on reproducibility and concrete failures." \
  --input session_name=auth-review

# Reuse a previously approved recipe manifest in CI
guardrail run --recipe git-branch-cleanup \
  --input repo_path=. \
  --non-interactive \
  --approved-manifest .guardrail/recipes/git-branch-cleanup.approved.json

# List installed versions
guardrail recipe versions git-branch-cleanup

# Inspect or validate before running
guardrail recipe inspect ./packed-recipe.json
guardrail recipe validate ./my-recipe.recipe.json

# Publish a structured approved command manifest as a community recipe PR
guardrail recipe publish --name npm-install-safe --category packages --dry-run
```

### How Recipes Work

Recipes are packaged execution bundles with:

- typed input validation
- channel enforcement (`verified` vs `community`)
- version pinning and immutable install artifacts
- SHA-pinned GitHub install for public recipe distribution
- dry-run previews
- manifest-backed approval and drift detection for real execution
- runtime dangerous-command and scope checks
- optional recipe metadata that can request extra approval sensitivity

Recipe execution uses a recipe-specific supervisor in front of the native recipe executor. Dry-runs stay approval-free previews. Real execution stores and reuses a recipe manifest the same way command, workflow, and template mode do.

If you need one approval to cover multiple recipe executions, promote that chain to workflow mode and reference the recipes from workflow steps with `type: "recipe_ref"`. The approved workflow manifest captures each referenced recipe's resolved version, content hash, resolved inputs, trust metadata (including `channel`, `signature`, and trust status), `allow_unverified` policy, and any prompt-bearing file hashes.

For workflow recipe refs:

- unverified/community recipes are blocked by default;
- set `allow_unverified: true` on the step or pass `--allow-unverified` to the workflow run to request community execution explicitly and persist that decision in the approval boundary.

The bundled `codex-exec` and `claude-exec` recipes are Guardrail-managed wrappers around `codex exec` and `claude --print`. They support:

- optional tool allowlists (`allowed_tools` for `claude-exec`; omit it to let Claude use its default built-in tool set)

- inline prompt text
- `input_files` arrays for prompt-bearing file content
- working-directory control plus additional tool-access directories
- model/provider/profile/effort/tool/budget flags supported by the underlying CLI
- bounded agent session contracts via `lifecycle` (`start` / `continue` / `attach`), `session_name`, and `session_id`

Agent session contracts:

- Pass `--input lifecycle=start` for a fresh named session, `continue` to reuse an existing bounded session, or `attach` to explicitly join a previously named session.
- Guardrail persists each session contract at `<projectRoot>/.guardrail/agent-sessions/<recipeId>/<slot>.json` and binds it to tool, working directory, scope, wrapper version, and session name/id. Any identity change fails closed with a machine-readable reason (`session_missing`, `session_drift`, `session_attach_mismatch`, `session_already_exists`).
- Session contracts do NOT weaken prompt reapproval. Inline `prompt` and `system_prompt` keep their `review_each_time` semantics even when a matching session contract exists.
- Guardrail never reads `~/.claude/*` or `~/.codex/*`. Session IDs, if any, come from the caller via `--input session_id=...`, not from scraping the external CLI.

Important prompt-handling rules:

- Repeat `--input input_files=...` to pass one or more prompt-bearing files.
- Guardrail stores SHA-256 content hashes for `input_files` in the approved recipe manifest and rechecks them immediately before execution.
- Inline `prompt` and `system_prompt` values are `review_each_time` inputs: they require fresh approval every run, even if the text is unchanged.
- For repeatable unattended automation, prefer stable prompt material in `input_files` instead of inline prompt text.

Naming convention for AI wrapper recipes:

- Use `<tool>-exec` for single-shot structured wrappers around one underlying AI CLI.
- Reserve names like `*-workflow` or `*-lifecycle` for multi-step orchestrations, not one-command wrappers.
- Match the recipe id, filename, and wrapper helper name whenever practical: for example `codex-exec`, `recipes/codex-exec.recipe.json`, and `src/codex-exec-wrapper.js`.

Naming convention for bounded operational recipes:

- Use `<domain>-<action>` for task-specific operational recipes like `git-branch-cleanup` or `git-commit`.
- Prefer one clearly bounded action per recipe. If you need service state or multiple lifecycle phases, promote it to a workflow instead of widening the recipe.

Minimal workflow recipe chain:

```json
{
  "version": 1,
  "kind": "workflow_definition",
  "name": "review-and-commit",
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
      "on": { "success": "commit", "failure": "abort" }
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
      "on": { "success": "done", "failure": "abort" }
    }
  ]
}
```

For public recipe distribution:

- `guardrail recipe install github://owner/repo/path.json@sha` installs from GitHub with a required commit pin
- short SHAs are resolved to full 40-character SHAs before Guardrail stores pin metadata
- if raw GitHub fetches are unavailable but `gh` is authenticated, Guardrail falls back to the GitHub contents API so private-repo installs can still work
- agent or CI runtimes need both the matching `trusted_sources` config and, for private repos, `gh` authentication in that same runtime context
- Guardrail records `.pins/<version>.json` metadata and re-verifies pinned source content on run when the network is available
- `guardrail recipe publish` converts a structured approved command manifest into a scrubbed community recipe PR flow

Version resolution works like this:

- If you run `guardrail run --recipe name@1.2.3`, Guardrail uses exactly `1.2.3` or fails if that version is not installed.
- If you run `guardrail run --recipe name`, Guardrail resolves to the latest installed version.
- An approval for an unpinned recipe binds to the resolved version at approval time. If a newer version later becomes the latest, Guardrail detects drift and requires re-approval.

Recipe inputs are validated by schema, but approval reuse is still exact-value based on the resolved inputs recorded in the recipe manifest.

### Guardrail Cloud (Coming Soon)

| Tier | What You Get |
|------|-------------|
| **Free** | Community recipes -- open, auditable, community-maintained |
| **Verified** | 🔐 Security-reviewed, enterprise-approved recipes |
| **Custom** | 🧠 Org-specific constraints and private recipe libraries |
| **Insights** | 📊 Usage analytics, risk patterns, drift reporting |

> Think of it as the App Store for safe execution.

---

## Manifest Paths

Each mode stores its approval separately:

- Command manifest: `.guardrail/approved.json`
- Workflow manifest: `.guardrail/workflows/default.approved.json`
- Template manifest: `.guardrail/templates/<template-name>.approved.json`
- Recipe manifest: `.guardrail/recipes/<recipe-id>.approved.json`

A command manifest does not also approve a workflow, template, or recipe. Each is an independent approval unit.

A workflow manifest may include multiple `recipe_ref` steps, but that approval only applies to the workflow definition as a whole. It does not also approve standalone `guardrail run --recipe ...` executions outside that workflow.

---

## Environment Policy

Guardrail controls what environment variables reach each process.

**Single-command mode** defaults to `inherit: false` -- only `PATH` is passed. This is the restrictive default for one-off commands.

**Workflow steps** default to `inherit: true` -- the full parent environment is passed. Workflow adapter scripts typically need the caller's env vars to function.

**Template steps** use an explicit handshake -- when a template declares `requires_env`, the caller must provide `--env-allow` entries, and only the intersection is passed.

Both modes support explicit control:

```json
{
  "envPolicy": {
    "inherit": false,
    "allow": ["PATH", "HOME", "NODE_ENV"],
    "inject": { "PORT": "3000" }
  }
}
```

`inject` keys and `allow` entries are scanned for secret patterns (`SECRET`, `TOKEN`, `PASSWORD`, `API_KEY`, `CREDENTIAL`, `AUTH`, `PRIVATE_KEY`). Matches trigger the `secret injection enabled` risk reason. If combined with shell mode or production targets, risk escalates to Red.

---

## CI / Non-Interactive Mode

Pre-approve a manifest, then run without prompts. Any drift fails the build.

```bash
# Command mode
guardrail run --non-interactive --approved-manifest .guardrail/approved.json -- npm test

# Workflow mode
guardrail workflow lint --definition workflows/server-cycle.json
guardrail workflow run --definition workflows/server-cycle.json \
  --non-interactive --approved-manifest .guardrail/workflows/server-cycle.approved.json

# Template mode
guardrail run --non-interactive \
  --approved-manifest .guardrail/templates/npm-publish.approved.json \
  --template ./templates/npm-publish.json \
  --input package_dir=packages/my-lib --input tag=latest

# Recipe mode
guardrail run --recipe git-branch-cleanup \
  --input repo_path=. \
  --non-interactive \
  --approved-manifest .guardrail/recipes/git-branch-cleanup.approved.json
```

JSON output for structured logging and CI integration:

```bash
guardrail run --json --non-interactive --approved-manifest .guardrail/approved.json -- npm test
```

### Supervisor progress stream

For machine consumers, stream supervisor progress with `--json-stream` across all supported modes:

```bash
# Command mode
guardrail run --json-stream --non-interactive --approved-manifest .guardrail/approved.json -- npm test

# Workflow mode
guardrail workflow run --definition workflows/server-cycle.json \
  --non-interactive --approved-manifest .guardrail/workflows/server-cycle.approved.json \
  --json-stream

# Template mode
guardrail run --template ./templates/npm-publish.json --input package_dir=packages/my-lib \
  --non-interactive --approved-manifest .guardrail/templates/npm-publish.approved.json \
  --json-stream

# Recipe mode
guardrail run --recipe git-branch-cleanup --input repo_path=. \
  --non-interactive --approved-manifest .guardrail/recipes/git-branch-cleanup.approved.json \
  --json-stream
```

Use both `--json` and `--json-stream` when you want a pretty final structured result and a live stream:

```bash
guardrail workflow run --definition workflows/server-cycle.json \
  --non-interactive --approved-manifest .guardrail/workflows/server-cycle.approved.json \
  --json --json-stream
```

When approval is required, `approval_pending` is emitted before execution in the active mode. After harmonization of runtime approval streaming, this applies to command, template, and recipe as well as workflow mode.

Stream events are one JSON object per line (NDJSON) and include:

- `event`: one of `approval_pending`, `execution_start`, `step_started`, `step_completed`, `step_failed`, `step_blocked`, `execution_end`
- `runId`: supervisor run identifier
- `mode`: supervisor mode (`command`, `workflow`, `template`, `recipe`)
- `status`: `pending`, `running`, `success`, `failed`, or `blocked`
- `stepId` / `stepType` when a step event applies
- `message` and optional `reason` (human-readable detail)
- `finalStatus` for `execution_end`

Guaranteed:

- `execution_start` is emitted once just before runtime execution.
- `execution_end` is emitted exactly once on every terminal path when `--json-stream` is enabled.
- `mode` identifies the active supervisor mode in each event.

---

## Adapter System

Guardrail includes an **adapter system** for agent tools and local wrappers. The goal is to let tools like OpenClaw and Aider route execution through the same Guardrail enforcement pipeline without scraping terminal output or inventing adapter-specific drift logic.

MCP status:
- `stdin-json` and `env-shim` are the runnable adapter transports today
- MCP profiles are recognized and may declare a validated `mcp_transport` contract, but runtime support is still intentionally blocked
- blocked MCP runs now tell you which transport contract was recognized so users can distinguish “profile is malformed” from “transport exists on paper but is not live yet”
- `guardrail adapter probe --tool <name>` is the bounded MCP discovery path: it runs an approval-bearing stdio probe that only performs `initialize` plus `tools/list` for MCP profiles with declared `stdio` transport
- `guardrail adapter mcp tools --tool <name>` is the first explicit MCP inventory surface: it returns the discovered tool metadata Guardrail saw during that bounded `initialize` + `tools/list` exchange so agents can inspect callable tool names before invoking one
- `guardrail adapter mcp call --tool <name> --mcp-tool <tool> --params-json <json>` is the first bounded MCP runtime path: it performs exactly one `tools/call` over the declared `stdio` transport under Guardrail approval, without turning general `adapter run` into an ambient MCP execution surface
- `guardrail adapter mcp batch --tool <name> --calls-json <json>` is the next bounded MCP runtime path: it performs an explicit array of `{ "tool": "...", "params": { ... } }` calls over one approved stdio session without turning general `adapter run` into an ambient MCP execution surface

Current architecture:

- **Rich supervisor result**: `runSupervisor()` returns bounded machine-readable context including native status, drift diffs, clipped stdout/stderr, and telemetry
- **Stable public schema**: the adapter engine translates that internal result into a versioned public contract: `adapter-result/v1`
- **Pure-data profiles**: public profiles declare a `schema_target`, map fields from `adapter-result/v1`, and cannot execute arbitrary code
- **Pinned distribution**: public profiles install from SHA-pinned GitHub URLs, not from bare names
- **Protocol limits**: Phase 1 supports `stdin-json` and `env-shim`; `mcp` profiles may exist but runtime support is deferred and blocked before execution
- **Bounded MCP probe**: `adapter probe` is additive and opt-in; it uses the declared `mcp_transport` contract, runs the transport under Guardrail, and only performs capability discovery (`initialize` + `tools/list`)
- **Logging and audit**: adapter runs emit structured log/audit events, and any stdout/stderr exposed to adapters is clipped to bounded sizes
- **Auth preflight**: profiles may declare `requires_env` and `requires_auth`; Guardrail fails early when required env mappings or bounded CLI auth prerequisites are missing. `requires_env` requires explicit `--env-allow` mapping; missing entries fail closed with `missing_auth_mapping`. `requires_auth` runs bounded local checks (for example `claude_login`, `claude_exec_probe`, and `gh_auth`) and fails with `missing_auth_prerequisite` when the current runtime is not authenticated.

Example:

```bash
guardrail adapter run --tool openclaw -- npm test
guardrail adapter run --profile ./my-tool.json --env-allow ANTHROPIC_API_KEY -- npm test
guardrail adapter probe --tool cline
guardrail adapter mcp tools --tool cline
guardrail adapter mcp call --tool cline --mcp-tool echo --params-json '{"text":"hi"}'
guardrail adapter mcp batch --tool cline --calls-json '[{"tool":"echo","params":{"text":"hi"}},{"tool":"echo","params":{"text":"bye"}}]'
guardrail adapter profile install aider --index ./adapter-profiles.index.json --index-key ./adapter-profiles.index.pub.pem
guardrail adapter run --tool cline -- echo "still blocked in v0.2"
guardrail adapter profile index verify ./adapter-profiles.index.json --index-key ./adapter-profiles.index.pub.pem
guardrail adapter profile install github://guardrail-dev/adapter-profiles/openclaw.json@<sha>
```

Adapter command approval shape:

```bash
guardrail adapter run --tool openclaw -- npm test
```

On first run, adapter execution still requires approval in the current Guardrail context; without it, the command is blocked with `No approved manifest found`.

Adapter caveats:

- `requires_auth` is preflight-only and does not perform interactive login. If a tool reports `missing_auth_prerequisite`, authenticate the runtime first (for example `claude auth login` or `gh auth login`) and retry. The current exception is the bundled composed Claude host-runtime path, which can perform one bounded hosted `claude auth login --console` repair attempt before it gives up with `auth_repair_pending_user_input`.
- The same bounded auth/runtime preflight now applies to workflow `recipe_ref` execution for referenced recipes. If a chained recipe declares `requires_auth`, the workflow stops before launch with the same `missing_auth_prerequisite` semantics instead of letting the child CLI fail late.
- Adapter `run` also enforces approval reuse: first approval is interactive and binds an adapter manifest; without one, `adapter run` returns a blocked result with `No approved manifest found`.
- `adapter probe` is discovery only. It does not run user commands through MCP profiles, and it does not make `adapter run` live for MCP tools. Use it to confirm that the declared stdio transport can initialize and expose tools under Guardrail.
- `adapter mcp tools` is the agent-facing inventory view for that same bounded discovery path. Use it when you need the actual MCP tool names or input-schema-bearing metadata Guardrail observed before choosing a tool.
- `adapter mcp call` is the first bounded MCP execution slice. It still requires explicit MCP tool selection plus JSON params, and it does not reinterpret arbitrary shell commands as MCP calls. Guardrail now validates the requested MCP tool against the discovered tool set when the profile declares required capability discovery.
- `adapter mcp batch` is the next bounded execution slice. It still requires an explicit JSON array of `{ tool, params }` objects, still runs under one bounded stdio session, and now validates the requested tool set against bounded discovery when the profile requires capability discovery; it does not reinterpret arbitrary shell commands as ambient MCP execution.
- Signed adapter-profile index verification is now shipped via `guardrail adapter profile index verify <path> --index-key <pubkey.pem>`, and Guardrail can now also resolve `adapter profile install <tool-name>` through that verified local index when you pass both `--index` and `--index-key`. This is still a local/team distribution flow, not ambient public discovery.
- `adapter run` for MCP profiles is still blocked at CLI level in v0.2. If you need bounded MCP execution now, use `adapter mcp call` or `adapter mcp batch`; if you need general IDE-style protocol execution, use the env-shim path until broader MCP runtime semantics ship.
- Bare-name adapter-profile install still fails closed by default. It only succeeds when you explicitly provide a signed local index and matching public key with `--index` and `--index-key`.
- `--env-allow` is bounded and explicit. It only controls what environment keys are handed to the adapter process for that run.
- `claude-exec` and `codex-exec` are approval-bounded wrappers, not outer sandboxes. If you run them outside your host sandbox/container boundary, the underlying AI CLI runs with host privileges subject to its own permission model. Guardrail now calls this out as a yellow-to-red risk reason in approval UX.

See [docs/adapter-implementation-plan.md](docs/adapter-implementation-plan.md) for the build plan and current boundaries.

---

## When to Use It

- **Repo-local build, test, lint commands** -- lock down what your dev scripts actually run
- **CI automation** -- pre-approve a manifest, fail the build on drift
- **AI-assisted command execution** -- stop agents from expanding their own scope
- **Parameterized deployment templates** -- typed inputs, env handshake, rollback
- **Explicit server/task lifecycles** -- approve a named multi-step workflow instead of many loose commands
- **Any repeatable workflow that shouldn't silently expand**

> Guardrail doesn't try to be smarter than your workflow. It just ensures your workflow never does more than you approved.

---

## Install

Guardrail is not published to npm. Clone the repo and run it directly:

```bash
git clone <repo-url> guardrail
cd guardrail
node src/cli.js run -- npm test
```

Or symlink it for convenience:

```bash
npm link   # from the guardrail directory
guardrail run -- npm test
```

---

## Try It

See Guardrail in action with built-in demos:

```bash
# List all demos
guardrail demo list

# Drift detection — the core UX moment
guardrail demo drift

# Recipe execution — dry-run, risk, guardrails
guardrail demo recipe

# Trust channels — verified vs community enforcement
guardrail demo trust

# Dangerous command blocking — rm -rf, sudo, chmod 777
guardrail demo blocked
```

---

## Testing

Tests are automated, passing, and use only the Node.js built-in test runner. Use `npm test` for the current count.

```bash
npm test              # full suite
npm run test:e2e      # verification/e2e/adversarial suites
npm run test:core     # core unit/integration suites
```

Tests are organized in five levels:

| Level | What It Proves |
|-------|----------------|
| **Schema/unit** (645) | Deterministic functions: hashing, validation, risk classification, approval, policy |
| **Policy scenarios** (30) | Declarative policy -> expected decision (GREEN/YELLOW/RED, channel, strict mode) |
| **E2E integration** (42) | Full path: load recipe -> validate -> dry-run -> scope check -> channel -> audit |
| **Golden demos + adversarial** (68) | Viral demos as regressions + intentional breakage (path traversal, version swap, agent bypass, audit tamper) |
| **Gap closure + versioning** (39) | Recipe runner, versioned install, version resolution, runbook, verify, demos |

Five [fixture repos](tests/fixtures/e2e/) simulate real environments (safe git, dangerous git, package upgrade, prod config, OpenClaw wrapper) with known expected behaviors.

Quick self-test:

```bash
guardrail verify
```

---

## Technical Status

For detailed implementation status, what's working, what's not, and the full roadmap, see [docs/technical-status.md](docs/technical-status.md).

For agent onboarding and automation integration, see [docs/agent-onboarding.md](docs/agent-onboarding.md).

---

## Host Hardening Checklist

If you're running Guardrail in production or CI, harden the host:

- [ ] Run CI jobs in ephemeral containers
- [ ] Mount working directories as read-only where possible
- [ ] Restrict network egress at the container/VM level
- [ ] Use least-privilege service accounts
- [ ] Pin dependency versions in manifests
- [ ] Audit approved manifests in version control

Guardrail reduces accidental drift. The host environment handles the rest.

---

> AI tools keep expanding what they run. Guardrail stops that.
