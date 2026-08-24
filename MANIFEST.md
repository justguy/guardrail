# Guardrail Manifesto

Software automation is increasingly managed by other software. Scripts invoke
tools, workflows coordinate scripts, and agents coordinate entire workflows.
Each layer can save time, but each layer can also make the real execution
boundary harder to see.

Guardrail exists to keep that boundary explicit.

## The Product Thesis

Workers do the work. Managers coordinate workers. Guardrail keeps those managers
inside a contract the operator can inspect, approve, and reuse.

This is not about slowing automation down. It is about making repeated
automation dependable enough to use: approve a known execution shape once,
reuse it while it remains the same, and stop when it changes.

## Principles

**Scope must be concrete.** A command, input set, recipe version, environment
handshake, or lane ownership claim should be represented as data, not inferred
from intent after execution begins.

**Reuse requires equality.** A prior approval is useful only when the candidate
contract still matches it. A broader request is a new approval decision.

**Failure should be legible.** Missing state, conflicting scope, invalid policy,
or ambiguous provenance should produce a bounded refusal with a reason and a
recovery path.

**Evidence should remain inspectable.** Local manifests, state, logs, and audit
records let operators understand what Guardrail decided without depending on a
hosted control plane.

**Composition must preserve boundaries.** Workflows, templates, recipes,
adapters, resident lanes, and delegated tools should not become shortcuts around
the underlying approval and policy model.

**Security claims must stay narrow.** Guardrail reduces accidental scope drift.
It does not contain malicious code, replace least privilege, or turn untrusted
automation into trusted automation.

## What Guardrail Provides Today

Guardrail implements contract normalization and hashing, manifest comparison,
risk and trust classification, interactive and non-interactive approval flows,
runtime limits, execution locks, result validation, and local hash-chained audit
records.

Those controls are available across direct commands and higher-level execution
surfaces, including workflows, typed templates, versioned recipes, tool adapter
profiles, persistent agent lanes, and grant-scoped MCP delegation.

The result is a practical operating model for trusted automation: the operator
can move quickly inside an approved boundary and gets a hard stop when that
boundary changes.

## What Guardrail Does Not Promise

Guardrail is not a sandbox, container, endpoint security agent, hosted compliance
service, or guarantee of safe downstream behavior. Its worker processes inherit
the authority of the user and environment that launch them.

The project should be judged by whether it makes execution scope clearer,
approval reuse more honest, and automation easier to inspect. Claims beyond that
belong to separate controls.

See the [architecture](docs/ARCHITECTURE.md), [use cases](docs/USE_CASES.md), and
[open items](docs/OPEN_ITEMS.md) for the current implementation boundary.
