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

**Contract-locked execution.** Every command or workflow is normalized, hashed, and stored as an approved manifest. The same approved shape produces the same hash. Anything else is a new approval unit.

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

## Workflow Manifests

Guardrail supports both one-command manifests and first-class workflow manifests.

For agent handoff and automation onboarding, see [Agent Onboarding](docs/agent-onboarding.md).

Command mode:

```bash
guardrail run -- npm test
```

Workflow mode:

```bash
guardrail workflow run --definition workflows/server-cycle.json
```

Each manifest path stores one approval unit. A command manifest does not also approve a workflow, and a workflow manifest does not implicitly approve ad hoc commands.

Lint a definition before running it:

```bash
guardrail workflow lint --definition workflows/server-cycle.json
```

Catches issues like failure transitions that silently report success, and unreachable steps.

Default paths:

- command manifest: `.guardrail/approved.json`
- workflow manifest: `.guardrail/workflows/default.approved.json`

---

## Environment Policy

Guardrail controls what environment variables reach each process.

**Single-command mode** defaults to `inherit: false` -- only `PATH` is passed. This is the restrictive default for one-off commands.

**Workflow steps** default to `inherit: true` -- the full parent environment is passed. Workflow adapter scripts typically need the caller's env vars to function.

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

## When to Use It

- **Repo-local build, test, lint commands** -- lock down what your dev scripts actually run
- **CI automation** -- pre-approve a manifest, fail the build on drift
- **AI-assisted command execution** -- stop agents from expanding their own scope
- **Explicit server/task lifecycles** -- approve a named multi-step workflow instead of many loose commands
- **Any repeatable workflow that shouldn't silently expand**

> Guardrail doesn't try to be smarter than your workflow. It just ensures your workflow never does more than you approved.

---

## CI / Non-Interactive Mode

Pre-approve a manifest, then run without prompts. Any drift fails the build.

```bash
guardrail run --non-interactive --approved-manifest .guardrail/approved.json -- npm test
```

JSON output for structured logging and CI integration:

```bash
guardrail run --json --non-interactive --approved-manifest .guardrail/approved.json -- npm test
```

Workflow CI example -- lint first, then run:

```bash
guardrail workflow lint --definition workflows/server-cycle.json
guardrail workflow run --definition workflows/server-cycle.json --non-interactive --approved-manifest .guardrail/workflows/server-cycle.approved.json
```

Lint catches intent-level issues (failure transitions that silently report success, unreachable steps) before the workflow runs. Both commands return non-zero on failure. No silent pass-through.

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
