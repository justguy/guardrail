# Guardrail Use Cases

Guardrail is most useful when the underlying tools are trusted but the execution
shape should remain explicit, repeatable, and reviewable.

## Target Users

- Developers who want local scripts and AI-assisted tasks to stop when their
  command surface changes.
- Release engineers who need repeatable, parameter-bound operational recipes.
- Platform teams providing approved automation patterns to multiple projects.
- Operators supervising long-running or concurrent agent sessions in one
  workspace.
- Agent-tool authors that need a narrow delegated interface instead of broad
  shell access.

## 1. Lock a Repeated Local Command

**Situation:** A developer repeatedly runs tests through a wrapper or agent and
wants package installation or extra flags to require a fresh decision.

```bash
guardrail run -- npm test
```

The first approved run writes a manifest. Later identical runs reuse it; a
changed command, argument, directory, or bound environment policy is drift.

**Value:** Less repetitive approval for stable work and a clear stop when the
execution request changes.

## 2. Fail Closed in CI

**Situation:** A pipeline should run only a contract that was reviewed before the
job started.

```bash
guardrail run \
  --non-interactive \
  --approved-manifest .guardrail/approved.json \
  -- npm test
```

The job does not prompt. It fails if the manifest is missing, lacks recorded
acknowledgment, or differs from the candidate contract.

**Value:** The pipeline cannot silently approve its own widened execution shape.

## 3. Publish a Bounded Operational Recipe

**Situation:** A platform team wants developers or agents to use a reviewed Git,
package, or infrastructure workflow with constrained inputs.

```bash
guardrail run \
  --recipe terraform-plan-only \
  --input config_path=infra/staging \
  --dry-run
```

Recipes package typed inputs, versioned content, steps, and runtime guardrails.
The operator can inspect or dry-run the artifact before real execution.

**Value:** Teams share an auditable operation instead of copying an opaque shell
snippet. A recipe remains code to review, not a safety certificate.

## 4. Parameterize Without Building Shell Strings

**Situation:** A repeated task needs user-selected values such as a package
directory or release tag.

```bash
guardrail template simulate \
  --template ./templates/npm-publish.json \
  --input package_dir=packages/my-lib \
  --input tag=beta
```

Templates validate typed inputs and interpolate them into structured argument
arrays. Workflow templates can also declare rollback behavior.

**Value:** Callers get a discoverable input contract and a preview of resolved
execution without ad hoc shell interpolation.

## 5. Reuse a Guarded Agent Runtime

**Situation:** An operator wants several prompts handled by the same agent
runtime without approving the outer executable boundary for every turn.

```bash
guardrail lane start --id review --tool codex --scope-type paths --scope-path docs
guardrail lane chat --id review --prompt "Review the public documentation."
guardrail lane status --id review
guardrail lane stop --id review
```

A resident lane binds its tool, runtime options, identity, and declared work
scope. Later messages reuse that lane while lifecycle and result state remain
locally inspectable.

**Value:** Lower transport approval churn and clearer ownership for multi-turn
work. The agent's own tool permissions still apply.

## 6. Coordinate Concurrent Lanes

**Situation:** Review, implementation, and verification agents are active in the
same repository.

Each lane can declare path scope and typed resources with `warn` or `block`
conflict behavior. `lane list`, `lane status`, and `lane portfolio` expose the
current local view.

**Value:** Operators can identify overlapping declared ownership before two
Guardrail lanes work on the same area. This is coordination metadata, not a
filesystem lock on arbitrary external processes.

## 7. Delegate a Narrow Tool Surface over MCP

**Situation:** An MCP client needs approved recipe execution, bounded local
service control, loopback HTTP probes, or read-only repository inspection without
receiving a general-purpose shell tool.

```bash
guardrail mcp serve --grant .guardrail/mcp-grant.json --agent codex
```

The server advertises only grant-authorized tools and validates their arguments.
Delegated recipes still pass through Guardrail's recipe supervisor.

**Value:** The delegation boundary is explicit and machine-readable. It remains
limited by the authority of the processes that approved tools launch.

## 8. Preview Policy Effects

**Situation:** A team wants to know whether a proposed command context would be
allowed before connecting it to real execution.

```bash
guardrail policy simulate \
  --contract '{"command":"terraform","args":["apply"],"cwd":"/infra","mode":"structured"}' \
  --trust-class reviewed_internal \
  --project-root /infra
```

**Value:** Policy authors can inspect the decision, matched checks, and reasons
without launching a worker or creating an approval record.

## When Not to Use Guardrail Alone

Guardrail is insufficient when the task requires containment of untrusted code,
hard network or filesystem isolation, production-grade secrets brokerage,
externally anchored audit retention, or a hosted fleet-management service. Pair
it with the operating-system, container, identity, and monitoring controls that
provide those guarantees.
