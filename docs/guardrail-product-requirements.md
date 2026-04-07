# Guardrail Product Requirements Document

Status: Implemented MVP v1.0  
Source: Prompt intake 1-3, resolved into a single v1 definition

## Product Summary

Guardrail is a Node.js CLI that lets a user review risk, explicitly approve an execution contract, lock that contract, and refuse any later change without re-approval.

Tagline:

> Automate repeatable CLI tasks safely, without silent scope drift.

Core promise:

> Prevents commands from doing more than you approved.

Guardrail is a trust layer for CLI execution. It is not a sandbox.

Guardrail is a facilitator and approval layer. The user remains responsible for what they authorize.

Mandatory limitation statement:

> Guardrail enforces execution contracts and reduces accidental drift. It does not guarantee containment of malicious code.

Approval authority statement:

> Guardrail uses its own approval system as the source of truth. Host-level shell or platform approval prompts may add defense in depth, but Guardrail does not rely on them.

## Why This Exists

CLI workflows drift.

What starts as:

```text
npm test
```

quietly becomes:

```text
npm install && npm test
```

That happens in shell scripts, local automation, CI glue, and AI-assisted workflows. People may not call it "scope drift," but they constantly feel the pain of commands doing more than expected.

Guardrail exists to make that impossible without explicit permission.

## What Guardrail Is

- a contract-locked execution wrapper for trusted CLI workflows
- a way to make approval, retries, and drift visible
- a low-friction local and CI tool for repeatable commands
- a trust layer for AI-generated or AI-proposed command execution

## What Guardrail Is Not

- not a security sandbox for adversarial code
- not a container replacement
- not safe for untrusted third-party binaries
- not a scheduler or distributed job runner
- not a fully autonomous agent
- not a security authority or trust certifier
- not a host-process containment system

## Target Users

- developers running repeatable local commands
- teams with repo-local automation that keeps accreting behavior
- engineers using AI tools that may propose expanded commands
- internal tool builders who want contract locking without Docker-level overhead

## Product Goals

- Make approval obvious and extremely fast.
- Make drift impossible to miss.
- Keep the v1 behavior honest, deterministic, and fail-closed.
- Support a one-command onboarding story.
- Ship a 20-30 second demo that shows Guardrail blocking unexpected scope expansion.
- Work well for both local interactive usage and CI automation.

## v1 Product Decisions

These are resolved decisions, not open questions.

- Product name: `Guardrail`
- CLI name: `guardrail`
- Default manifest directory: `.guardrail/`
- Default approved manifest path: `.guardrail/approved.json`
- Default workflow manifest path: `.guardrail/workflows/default.approved.json`
- Default state path: `.guardrail/state.json`
- Default log path: `.guardrail/logs/`
- Default mode: structured execution
- Workflow mode: first-class `guardrail workflow run`
- Shell mode: explicit opt-in only
- Primary launch platforms: macOS and Linux
- Windows support: out of v1

## Core Concepts

### Execution Contract

The execution contract is the approved scope for a run. It covers:

- command and args
- working directory
- execution mode
- shell text when shell mode is used
- allowed top-level binaries
- declared read and write scope
- environment policy
- retry policy
- timeout
- allowed update action types

### Approved Manifest

The approved manifest is the persisted file that Guardrail reuses across runs.

In v1, Guardrail stores the active approved manifest at:

- `.guardrail/approved.json`
- `.guardrail/workflows/default.approved.json` for workflow mode

If users need multiple workflows in the same repo, Guardrail also supports:

- `--manifest <path>`

Each manifest path stores one approval unit: one command contract or one workflow definition. The manifest also records the user-acknowledged risk assessment used for unattended reuse.

### Workflow Definition

Guardrail v1 supports explicit multi-step workflows through a checked-in workflow definition file.

A workflow definition names:

- the project root
- the entry step
- the maximum iteration count
- optional named services
- ordered task and service steps with explicit transitions

Workflow approval is still explicit and immutable after approval. Any change to the workflow definition, service graph, transitions, project root, or risk assessment triggers re-approval.

### Drift

Drift means the requested run no longer matches the approved manifest.

Examples:

- command changed from `npm test` to `npm run test`
- args changed
- shell text changed
- write scope expanded
- environment allowlist changed
- retry or timeout changed
- update policy changed

### Update Proposal

Guardrail supports update proposals, but Guardrail itself does not invent fixes for arbitrary CLI failures.

In v1, update proposals only come from:

- a Guardrail-aware worker speaking the NDJSON protocol
- a shipped demo workflow
- an explicit validator/update adapter defined by the workflow

For ordinary third-party commands without a Guardrail-aware validator, Guardrail still provides approval, manifest reuse, and drift blocking, but not autonomous repair.

### Trust and Risk Assessment

Guardrail does not determine whether a workflow is truly "safe."

Instead, it evaluates trust signals and risk indicators, assigns a traffic-light risk level, shows the reasons, and requires the user to explicitly approve that risk before unattended execution is allowed.

The user, not Guardrail, is responsible for the approval decision.

Guardrail's approval is the durable approval record used for reuse, drift checks, and non-interactive execution. Built-in shell approvals are not sufficient for this product's guarantees.

## Primary User Experience

### First Run

The user runs a command through Guardrail.

Preferred structured form:

```text
guardrail run -- npm test
```

Workflow form:

```text
guardrail workflow run --definition workflows/server-cycle.json
```

Explicit shell form:

```text
guardrail run --shell "npm test && npm run lint"
```

Guardrail then prints:

```text
Protected Execution Enabled
- Contract locked
- Not a secure sandbox
- Only safe for trusted tasks
- Changes require re-approval
```

Then it shows a readable summary of:

- command
- directory
- execution mode
- allowed binaries
- write scope
- child-process policy
- retries
- timeout
- trust class
- risk level
- risk reasons

Pressing Enter approves in interactive mode.

### Later Runs

If the requested run matches the approved manifest exactly, Guardrail runs without asking again.

If anything changed, Guardrail pauses before execution, shows the diff, and requires re-approval.

### Drift Moment

The core UX moment is:

```text
Execution paused

Requested change:
+ Add command: npm install

This is outside your approved contract.
Run halted. Re-run with explicit approval to widen scope.
```

That moment is the center of the product, the demo, and the README.

## Approval Reuse Rules

In v1, approval is required for every executable scope before unattended execution is allowed.

In practice, that means:

- approval is tied to a specific manifest file
- the manifest is tied to an exact normalized contract hash
- the manifest is tied to the specified working directory root
- the manifest is tied to a specific risk assessment and its recorded reasons
- non-interactive reuse is allowed only when the manifest includes a prior Guardrail risk acknowledgement

If the normalized contract hash matches, Guardrail reuses approval.

If the hash changes, or if the trust/risk assessment changes, Guardrail treats it as drift and requires re-approval.

In workflow mode, Guardrail also treats changes to `projectRoot`, step transitions, services, `trustClass`, and `requiresStrongConfirmation` as drift.

If the user approves the new contract, Guardrail overwrites the manifest at that path with the new approved contract.

Retries and restart loops inside the already-approved manifest do not re-prompt. New scope does.

## Trust and Risk Model

Guardrail must make risk visible before approval, not hide it behind technical jargon.

### Trust Classes

- `reviewed_internal`: first-party workflow reviewed and intentionally maintained by the user or team
- `pinned_external`: external workflow or script pinned to a known version or commit
- `generated`: AI-generated or dynamically produced workflow content
- `unknown`: provenance is unclear or not asserted

### Traffic-Light Risk Levels

- `green`: bounded and comparatively low-risk for unattended execution
- `yellow`: meaningful operational risk or wider blast radius
- `red`: high-risk workflow that requires heightened user attention

### Typical Green Signals

- reviewed internal workflow
- structured mode
- repo-local or temp-only writes
- known binary allowlist
- no package installs
- no root/sudo
- no prod targets
- no broad secret exposure

### Typical Yellow Signals

- shell mode
- service restarts
- broader writable paths
- descendant processes
- staging/shared environment targets
- injected secrets or credentials
- patching code before rerun

### Typical Red Signals

- unknown or generated workflow source
- package installation during runtime
- `sudo`, root, or system-level writes
- cloud, database, or infrastructure admin commands
- production targets
- destructive operations
- broad external network behavior
- write scope outside approved project boundaries

### Product Rule

Guardrail must always show:

- the risk color
- the trust class
- the specific reasons that caused the risk classification

Guardrail must never say the workflow is "safe." It only says what looks risky and why.

Risk display requirements:

- `green` must render as green when terminal color is available
- `yellow` must render as yellow when terminal color is available
- `red` must render as red when terminal color is available
- when color is unavailable, Guardrail must fall back to explicit uppercase labels such as `GREEN`, `YELLOW`, and `RED`

## v1 MVP Boundary

### Best Supported Workflows

- repo-local build, test, lint, and formatting commands
- explicit multi-step workflow definitions with bounded service lifecycle steps
- structured commands that do not need interactive stdin
- trusted Node.js toolchains such as `npm`, `pnpm`, and repo scripts
- Guardrail-aware demo and validator workflows
- CI jobs using a pre-approved manifest

### Supported With Caveats

- shell scripts run via explicit `--shell`
- commands that spawn descendants, where Guardrail can detect and clean up best-effort
- AI-assisted execution, where Guardrail is the final approval and drift gate

### Out of v1

- Windows support
- full-screen TUIs
- password prompts
- interactive REPLs
- arbitrary stdin-driven workflows
- network policy enforcement
- malicious-code containment

## Competitive Positioning

- Docker gives isolation. Guardrail gives intent control.
- PM2 manages lifecycle. Guardrail locks scope.
- systemd is OS-native service control. Guardrail is developer-facing contract approval.
- agent frameworks orchestrate behavior. Guardrail blocks unapproved behavior.

## Trust and Safety Positioning

Guardrail must be honest with advanced users.

What Guardrail can confidently claim:

- exact approval and drift checks
- deterministic manifest reuse
- fail-closed refusal on changed contracts
- explicit shell opt-in
- structured logs and reproducible pause states
- Guardrail-managed approval as the source of truth for unattended reuse

What Guardrail must not claim:

- secure containment
- total prevention of malicious side effects
- OS-level isolation
- inability of approved host processes to bypass Guardrail from inside their own execution

Guardrail must also say plainly:

> You are responsible for approving this workflow. Guardrail highlights risk; it does not assume liability or certify safety.

And it must also say plainly:

> Once an approved host process starts, Guardrail cannot fully control or contain that process without external isolation.

## Interactive and CI Modes

### Interactive Mode

Default local mode.

Requirements:

- fast approval flow
- readable diff view
- raw manifest view on demand
- screenshot-friendly pause output
- visible traffic-light risk indicator with reasons
- stronger confirmation for red-risk workflows

### Non-Interactive Mode

Required for CI.

Canonical form:

```text
guardrail run --non-interactive --approved-manifest .guardrail/approved.json -- npm test
```

Workflow form:

```text
guardrail workflow run --definition workflows/server-cycle.json --non-interactive --approved-manifest .guardrail/workflows/server-cycle.approved.json
```

Requirements:

- never prompt
- fail closed when the manifest is missing
- fail closed on drift
- fail closed when no prior risk acknowledgement exists
- return stable exit codes
- support JSON output

Non-interactive approval reuse must come from a Guardrail-approved manifest, not from ambient shell/session approval state.

## Host Execution Hardening Checklist

Guardrail is strongest when paired with operational hardening outside the tool itself.

Before allowing unattended host execution, the user should explicitly review this checklist:

- run Guardrail under a dedicated low-privilege OS user when possible
- use a dedicated working directory instead of a broad home-directory scope
- do not grant `sudo` or administrator access to Guardrail workflows
- keep writable paths as narrow as possible
- keep the binary allowlist as narrow as possible
- minimize inherited environment variables and injected secrets
- separate development, staging, and production manifests
- avoid approving production-targeted workflows in v1 unless absolutely necessary
- ensure there is a clear stop, rollback, or cleanup path
- ensure logs are persisted and inspectable
- prefer external isolation such as a VM or container when risk is yellow-to-red and the blast radius matters

Product requirement:

- Guardrail must remind users that host hardening is their responsibility, not something Guardrail can provide internally
- Guardrail must encourage external isolation for higher-risk workflows instead of implying it can replace it

## Built-In Demo Requirement

Guardrail must ship a deterministic first-run demo, not just marketing copy.

v1 requirement:

- ship a built-in `guardrail demo drift` command

That demo must deterministically show:

1. approval of `npm test`
2. a failed validation
3. a proposed drift to `npm install`
4. Guardrail pausing and refusing the widened scope until a new approval is recorded

This removes ambiguity from launch assets and makes the viral clip reproducible.

## Claude Execution Handoff

Guardrail should be implementable by another coding agent without reinterpretation of the product intent.

Required handoff artifacts:

- the product requirements doc
- the technical spec
- a concrete execution plan with file-by-file milestones
- acceptance criteria per milestone
- test and demo checkpoints

## Approval UX Requirements

Green and yellow workflows may use a quick approval action in interactive mode.

Red workflows must require a stronger explicit approval step, such as a typed confirmation phrase, before Guardrail stores the manifest.

The approval screen must always include a plain-language responsibility statement such as:

> You are approving this workflow and accepting responsibility for what it runs.

## README Requirements

The README should optimize for conversion, not exhaustive reference.

Required story order:

1. one-line value proposition
2. what drift feels like
3. blocked-drift example
4. how Guardrail works
5. when to use it
6. limitations
7. CI/non-interactive example, including one workflow example
8. install
9. demo command

Required headline:

```md
# Guardrail

**Automate repeatable CLI tasks safely, without silent scope drift.**
```

Required philosophy line:

> Guardrail doesn’t try to be smarter than your workflow. It just ensures your workflow never does more than you approved.

## Launch Story

The launch should lead with failure prevention, not generic automation.

Best launch line:

> I got tired of scripts silently doing more than I asked. So I built Guardrail.

Best AI-angle line:

> AI tools keep expanding what they run. Guardrail stops that.

## Success Criteria

- a new user understands the value in under 10 seconds
- the blocked-drift moment is obvious in screenshots and short video
- users understand the difference between Guardrail and Docker
- advanced users trust the honesty of the limitations
- users can see why a workflow is green, yellow, or red
- users understand that Guardrail flags risk but does not certify safety
- CI usage is clear and deterministic
- the built-in demo works without custom setup

## Post-v1 Opportunities

- Windows support
- named workflow registries under `.guardrail/contracts/`
- richer diff display
- adapters for common tools
- policy packs for teams
