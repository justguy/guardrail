# Guardrail

**Automate repeatable CLI tasks safely, without silent scope drift.**

> I got tired of scripts silently doing more than I asked. So I built Guardrail.

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

Workflow approvals now bind `recipe_ref` sources through portable source locators instead of absolute recipe file paths, so the same workflow can move between different checkout paths or runners without false drift from path changes alone. Guardrail still fails closed if the target machine cannot actually resolve the referenced recipe source.

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

# Tear the lane down explicitly when done
guardrail lane stop --id claude-live
```

Resident lanes are for direct interactive use when the executable boundary should stay fixed but later user messages should not count as execution drift. The shipped Claude lane helper:
- creates owner-only FIFOs (`0600`) under the lane directory
- stores an ephemeral per-lane HMAC key outside the workspace at `~/.guardrail/lanes/<id>.key`
- accepts only strict JSON requests with `id` and `prompt`
- can require an HMAC signature delivered through an inherited file descriptor instead of env or workspace state
- enforces prompt and payload size limits
- expires after idle timeout, removes its key/FIFOs, and records lane state under `.guardrail/lanes/<name>/state.json`

Lane startup still has to happen in a runtime where the downstream CLI auth already works. Later `lane send` turns reuse that resident lane instead of launching a fresh outer transport hop each time. If the lane has expired, `lane send` returns a structured `lane_expired` error and the correct recovery is to run `lane start` again.

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

# List available recipes
guardrail list

# Dry-run a recipe (latest version)
guardrail run --recipe git-branch-cleanup --input repo_path=. --dry-run

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

Current architecture:

- **Rich supervisor result**: `runSupervisor()` returns bounded machine-readable context including native status, drift diffs, clipped stdout/stderr, and telemetry
- **Stable public schema**: the adapter engine translates that internal result into a versioned public contract: `adapter-result/v1`
- **Pure-data profiles**: public profiles declare a `schema_target`, map fields from `adapter-result/v1`, and cannot execute arbitrary code
- **Pinned distribution**: public profiles install from SHA-pinned GitHub URLs, not from bare names
- **Protocol limits**: Phase 1 supports `stdin-json` and `env-shim`; `mcp` profiles may exist but runtime support is deferred and blocked before execution
- **Logging and audit**: adapter runs emit structured log/audit events, and any stdout/stderr exposed to adapters is clipped to bounded sizes
- **Auth preflight**: profiles may declare `requires_env` and `requires_auth`; Guardrail fails early when required env mappings or bounded CLI auth prerequisites are missing. `requires_env` requires explicit `--env-allow` mapping; missing entries fail closed with `missing_auth_mapping`. `requires_auth` runs bounded local checks (for example `claude_login` and `gh_auth`) and fails with `missing_auth_prerequisite` when the current runtime is not authenticated.

Example:

```bash
guardrail adapter run --tool openclaw -- npm test
guardrail adapter run --profile ./my-tool.json --env-allow ANTHROPIC_API_KEY -- npm test
guardrail adapter run --tool cline -- echo "blocked in v0.2"
guardrail adapter profile install github://guardrail-dev/adapter-profiles/openclaw.json@<sha>
```

Adapter command approval shape:

```bash
guardrail adapter run --tool openclaw -- npm test
```

On first run, adapter execution still requires approval in the current Guardrail context; without it, the command is blocked with `No approved manifest found`.

Adapter caveats:

- `requires_auth` is preflight-only and does not perform interactive login. If a tool reports `missing_auth_prerequisite`, authenticate the runtime first (for example `claude auth login` or `gh auth login`) and retry.
- Adapter `run` also enforces approval reuse: first approval is interactive and binds an adapter manifest; without one, `adapter run` returns a blocked result with `No approved manifest found`.
- MCP profiles are blocked at CLI level in v0.2 with a hard error. If you need IDE-style protocol execution now, use the env-shim path instead.
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
