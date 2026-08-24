# Guardrail Architecture

This document describes the current local runtime architecture. Guardrail is a
Node.js CLI that converts execution requests into approved contracts, applies
policy and runtime controls, launches ordinary child processes, and records the
outcome.

## System Context

```text
Operator or agent
       |
       v
CLI or delegated MCP server
       |
       v
Mode-specific entry point
(command | workflow | template | recipe | adapter | lane)
       |
       v
Contract / schema normalization and stable hashing
       |
       v
Risk, trust, policy, and manifest comparison
       |
       +---- mismatch or missing approval ----> fail closed / interactive review
       |
       v
Runtime limits and execution lock
       |
       v
Worker process or resident-lane adapter
       |
       v
Validation, result shaping, local state, logs, and audit
```

The mode-specific entry points share concepts rather than one monolithic
supervisor. Each mode binds the fields relevant to its behavior, then enforces
approval and runtime policy before execution.

## Core Components

### CLI and Dispatch

`src/cli.js` is the thin executable entry point. Modules under `src/cli/` parse
arguments and route command families such as execution, recipes, templates,
lanes, governance, and MCP service startup.

### Contracts and Manifests

`src/contract.js` creates and normalizes direct-command contracts, performs
stable serialization and hashing, distinguishes structured execution from
explicit shell mode, and supports executable file-hash checks.

`src/manifest.js` creates approval candidates, writes manifests atomically, and
compares candidates with stored approvals. Mode-specific code adds fields such
as resolved template inputs, recipe identity, or workflow step definitions.

Approval reuse is based on the stored representation matching the candidate. It
is not based on a natural-language judgment that two requests are "close
enough."

### Risk, Policy, and Authorization

`src/policy-engine.js` classifies operational risk and provenance signals.
`src/policy.js`, `src/org-policy.js`, `src/authorization.js`, and related modules
apply configured policy and role checks to supported surfaces.
`src/policy-simulate.js` evaluates a policy decision without launching a worker.

Risk classification informs the approval decision; it does not predict every
effect a downstream program can have.

### Supervisors

- `src/supervisor.js` handles direct command approval and execution.
- `src/workflow-supervisor.js` coordinates workflow state, services,
  transitions, referenced recipes, and rollback policy.
- `src/template-supervisor.js` validates typed inputs, resolves structured
  arguments, and supervises template or workflow-template execution.
- `src/recipe-supervisor.js` resolves recipe content, applies the recipe trust
  and approval model, performs supported auth preflights, and launches the
  recipe executor.
- `src/adapter-engine.js` applies an adapter profile around a tool invocation and
  normalizes its result.

`src/worker-interface.js` is the child-process boundary for ordinary execution.
Structured mode passes a command and argument array directly; shell behavior
requires explicit shell mode.

### Runtime Integrity and Evidence

`src/runtime-policy.js` enforces supported time windows, counters, rate limits,
and per-manifest execution locks. `src/validator.js` validates worker results and
tracks convergence for supported retry/update flows.

`src/audit.js` appends and verifies hash-linked local audit entries.
`src/logger.js` records structured run logs. Runtime artifacts are normally kept
under `.guardrail/` in the working project.

### Recipes and Distribution

`src/recipe.js`, `src/recipe-runner.js`, and `src/recipe-executor.js` validate and
execute packaged recipes. Installation and registry modules support local files,
configured remote sources, immutable GitHub references, and static self-hosted
registry snapshots. Source trust is controlled by local or organization policy;
installing a recipe does not make its commands intrinsically safe.

### Resident Lanes

`src/resident-lane-core.js` and modules under `src/lane/` manage named,
long-running execution lanes. A lane binds an adapter and runtime options, uses
local state and request/result files, and exposes lifecycle, health, inspection,
history, cleanup, and portfolio views.

Supported adapters include Claude, Codex, fixed local commands, local prompt
wrappers, and SSH prompt wrappers. External CLIs must already be installed and
authenticated in the runtime where the lane starts.

Lane scope and resource claims coordinate declared ownership between Guardrail
lanes. They do not provide filesystem or process isolation.

### Delegated MCP

`src/mcp-server.js` exposes a stdio MCP server. `src/delegated-policy.js`,
`src/delegated-tool-evaluators.js`, and `src/mcp-runtime.js` restrict the visible
tool inventory and arguments to an explicit grant. Delegated recipe execution
continues through the recipe supervisor, preserving its approval, policy,
locking, and audit behavior.

The grant limits what the MCP client can ask Guardrail to do. It does not limit
actions a launched program can perform with its own operating-system authority.

## Data and State

Guardrail is local-first. Depending on the selected surface, it stores some of
the following beneath the working project's `.guardrail/` directory:

- approved manifests and template approvals
- runtime counters, locks, and latest state
- structured logs and hash-linked audit entries
- generated recipe artifacts
- resident-lane identity, control, request, result, and lifecycle state

Installed recipe versions default to the user-level `~/.guardrail/recipes`
registry. Configuration can add other reviewed recipe roots.

These files make operation inspectable and portable. Operators should protect
them with normal filesystem permissions and repository policy where relevant.
Secrets should be passed only through the explicit environment handshakes
supported by the selected surface; they should not be committed with state.

## Trust Boundary

Guardrail decides whether a described execution matches an approved contract and
whether configured Guardrail policy allows it. After launch, the child process
runs with the permissions and ambient platform protections of the invoking user.

Consequently:

- Guardrail is not process, filesystem, network, or syscall isolation.
- Command hashes and recipe provenance do not prove benign runtime behavior.
- Local audit-chain verification detects inconsistency within retained data but
  is not external notarization.
- Remote transports and external agent CLIs introduce their own authentication,
  availability, and data-handling boundaries.
- Organization-grade guarantees require complementary identity, credential,
  isolation, retention, and monitoring controls.

This narrow boundary is intentional: Guardrail provides contract control and
operator evidence for trusted automation, while leaving containment to the
operating environment.
