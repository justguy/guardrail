# Guardrail

**Approve an execution boundary once. Reuse it until it changes.**

Guardrail is a local-first control layer for trusted CLI and agent-assisted
automation. It records the command, inputs, environment policy, and other bound
execution details you approve. The same contract can run again without a new
decision; a changed contract stops before execution and requires review.

That gives developers and operators a practical way to automate more work while
keeping its real scope visible.

## What You Get

- **Less approval churn.** Reuse an acknowledged manifest while the execution
  contract remains unchanged.
- **Drift stopped before execution.** Changed commands, arguments, inputs,
  recipe content, or other bound fields fail closed.
- **Repeatable shared operations.** Package reviewed steps and constrained
  inputs as workflows, templates, and versioned recipes.
- **Local, inspectable evidence.** Keep manifests, state, logs, and hash-linked
  audit records as files under operator control.
- **One contract model.** Apply the same approval principle across commands,
  workflows, templates, recipes, resident lanes, and delegated MCP tools.

```text
Requested change:
+ Add command: npm install

This is outside the approved contract.
Execution halted pending explicit approval.
```

Guardrail is intended for developers, release engineers, platform teams, and
operators running trusted automation, especially when an agent or wrapper is
coordinating tools on their behalf.

## Install

Guardrail requires Node.js 20 or newer.

From npm:

```bash
npm install --global guardrail
guardrail --version
```

From a source checkout:

```bash
npm install
npm link
guardrail --version
```

`npm link` exposes the checkout's `guardrail` binary. To avoid a global link,
invoke `node src/cli.js` directly.

## Quick Start

Run a command under Guardrail:

```bash
guardrail run -- npm test
```

On the first run, review the contract and risk assessment, then type `APPROVE`
in a real TTY. Repeating the same command reuses the stored approval. Changing
the command or a bound argument is drift and requires a new approval.

Use an approved manifest without prompting in CI:

```bash
guardrail run \
  --non-interactive \
  --approved-manifest .guardrail/approved.json \
  -- npm test
```

Non-interactive execution fails when the manifest is missing, unacknowledged, or
different from the candidate contract.

## Shipped Surfaces

| Surface | Purpose |
| --- | --- |
| Command | Run one structured command or explicit shell script under approval. |
| Workflow | Supervise multi-step definitions, transitions, services, and rollback. |
| Template | Validate typed inputs and resolve them into structured arguments. |
| Recipe | Run reusable, versioned execution bundles with constrained inputs. |
| Adapter | Place supported external tools behind a reviewed profile. |
| Resident lane | Reuse a named agent or command runtime across multiple turns. |
| Delegated MCP | Expose only grant-authorized Guardrail operations over stdio MCP. |

Examples:

```bash
# Preview a bundled recipe without executing it
guardrail run \
  --recipe terraform-plan-only \
  --input config_path=infra/staging \
  --dry-run

# Start and inspect a named Codex-backed lane
guardrail lane start --id review --tool codex
guardrail lane status --id review

# Start a grant-scoped MCP server
guardrail mcp serve --grant .guardrail/mcp-grant.json --agent codex
```

Use `guardrail --help` for the complete CLI surface. The bundled
[`recipes/`](recipes/) directory contains auditable examples for Git, package
management, infrastructure planning, and agent execution.

Claude Code users can manually configure
[`src/claude-git-guardrail-hook.js`](src/claude-git-guardrail-hook.js) as an
optional `PreToolUse` hook for Bash calls. It is not installed into Claude
settings by npm or `npm link`.

## Trust Boundary

Guardrail controls an execution contract and records local evidence. **It is not
a sandbox or a security boundary.**

- It does not isolate processes, restrict system calls, or replace containers.
- It does not make untrusted binaries, scripts, recipes, or agent tools safe.
- Approved processes retain the operating-system permissions of the user that
  launched Guardrail.
- Local hash-linked audit records are not an externally anchored, append-only
  ledger.
- Downstream tools retain their own authentication, permissions, and approval
  behavior.

Use operating-system isolation, least-privilege credentials, reviewed inputs,
and protected environments where those guarantees are required.

## Read More

- [Product manifesto](MANIFEST.md)
- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Concrete use cases](docs/USE_CASES.md)
- [Open items and adoption constraints](docs/OPEN_ITEMS.md)

## Development

```bash
npm test
npm run test:core
npm run test:e2e
```

The test suite uses Node's built-in test runner.
