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

**Contract-locked execution.** Every command, workflow, or template is normalized, hashed, and stored as an approved manifest. The same approved shape produces the same hash. Anything else is a new approval unit.

**Drift detection.** Changes to command name, arguments, scope, or risk level block execution immediately. No silent pass-through.

**Traffic-light risk model.** Each command gets a risk classification:

| Level | Meaning | Example |
|-------|---------|---------|
| Green | Bounded, local, reviewed | `npm test`, `eslint .` |
| Yellow | Broader blast radius, service lifecycle, secrets in structured mode | `npm install`, service restart |
| Red | Shell + secrets, production targets, elevated privileges, unknown provenance | `curl \| sh`, shell mode injecting `DB_PASSWORD` |

Risk levels come with human-readable reasons so you know *why* something was flagged.

Secret detection scans both `envPolicy.inject` keys and `envPolicy.allow` lists for patterns like `SECRET`, `TOKEN`, `PASSWORD`, `API_KEY`, `CREDENTIAL`, `AUTH`, and `PRIVATE_KEY`. Secrets combined with shell mode or production targets escalate to Red.

**Manifest reuse.** Once you approve a manifest, it's saved. The same command or workflow runs without re-prompting until something changes. Out-of-scope update proposals are halted and require a new approval record; Guardrail does not grant one-off in-session overrides.

---

## Three Execution Modes

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
```

Templates support two kinds:
- **`kind: "template"`** -- Single command with typed inputs
- **`kind: "workflow_template"`** -- Multi-step with rollback support

Templates enforce structured mode only (no shell), require constrained inputs (pattern or enum for strings), and use an explicit environment handshake so templates cannot silently harvest env vars.

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

Guardrail Recipes are not a template gallery or a config repo. Each recipe is a packaged, contract-locked workflow -- validated inputs, enforced environment handshake, cryptographic hash, and rollback where needed. Install a recipe and run it knowing the execution surface is exactly what was reviewed.

### Browse the Recipe Library

| Category | Examples |
|----------|----------|
| **GitHub** | `open_pr`, `clone_repo`, `release_safe` |
| **Package** | `npm_install_safe`, `pip_install_safe` |
| **Cloud** | `aws_s3_sync_safe`, `terraform_plan_only` |
| **AI / Agent** | `fix_tests`, `debug_ci`, `safe_deploy` |

### Using Recipes

```bash
# Install a recipe
guardrail recipe install github/open_pr

# Inspect before running
guardrail template explain --template recipes/open_pr.json
guardrail template lint --template recipes/open_pr.json

# Simulate
guardrail template simulate \
  --template recipes/open_pr.json \
  --input repo=my-org/my-repo \
  --input branch=feature-x

# Execute
guardrail run \
  --template recipes/open_pr.json \
  --input repo=my-org/my-repo \
  --input branch=feature-x
```

### How Recipes Work

Every recipe is a Guardrail template under the hood:

- **`kind: "template"`** -- single-command recipe (e.g., `npm_install_safe`)
- **`kind: "workflow_template"`** -- multi-step recipe with rollback (e.g., `safe_deploy`)

The same contract enforcement applies: typed inputs, environment handshake, canonical hashing, and drift detection. A recipe that changes requires re-approval -- no silent updates.

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

A command manifest does not also approve a workflow or template. Each is an independent approval unit.

---

## Environment Policy

Guardrail controls what environment variables reach each process.

**Single-command mode** defaults to `inherit: false` -- only `PATH` is passed. This is the restrictive default for one-off commands.

**Workflow steps** default to `inherit: true` -- the full parent environment is passed. Workflow adapter scripts typically need the caller's env vars to function.

**Template steps** use an explicit handshake -- only variables in both `requires_env` (template) and the caller's allow list are passed.

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
```

JSON output for structured logging and CI integration:

```bash
guardrail run --json --non-interactive --approved-manifest .guardrail/approved.json -- npm test
```

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

See drift detection in action with a built-in demo:

```bash
guardrail demo drift
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
