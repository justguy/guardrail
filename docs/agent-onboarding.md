# Agent Onboarding

Use this guide when another coding agent needs to execute commands or workflows through Guardrail.

## Core Rules

1. Guardrail is the source of truth for approval reuse and drift control.
2. Do not bypass Guardrail by running the underlying command or workflow steps directly unless the user explicitly says to.
3. Guardrail is not a sandbox. It enforces approval boundaries and highlights risk, but the user remains responsible for what they approve.
4. In non-interactive mode, only a previously approved Guardrail manifest counts as reusable approval.

## Local CLI Entry Point

If `guardrail` is not installed in `PATH`, use the local entrypoint:

```bash
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js
```

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

For the first pass, use the smallest real route set:

- `POST /api/start-project`
- `GET /api/project/:id`
- `GET /api/health`
- `POST /api/project/:id/abort`
- optional: `POST /api/project/:id/retry`

Do not keep searching for a separate generic "mark failed" endpoint. Model the terminal failure path as `abort` unless a more specific server-supported retry or review path is explicitly required.

## What the Agent Must Have

- the exact command or workflow definition path
- the exact approved manifest path
- confirmation that the manifest was created by an interactive Guardrail approval run

If the approved manifest does not exist, stop and ask for an interactive approval run first.

## Stop Conditions

If Guardrail returns any of these statuses, stop and report them:

- `approval_required`
- `approval_denied`
- `drift_detected`
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

If this is command mode, run:
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js run --non-interactive --approved-manifest <APPROVED_MANIFEST_PATH> -- <command> [args...]

If this is workflow mode, run:
node /Users/adilevinshtein/Documents/dev/Guardian/src/cli.js workflow run --definition <WORKFLOW_DEFINITION_PATH> --non-interactive --approved-manifest <APPROVED_MANIFEST_PATH>

If the manifest is missing, or Guardrail returns approval_required, approval_denied, drift_detected, update_denied, unsupported, protocol_error, or internal_error, stop and report it.

If sandboxing blocks Guardrail from writing under .guardrail/, rerun the same Guardrail command with escalated permissions. Do not bypass Guardrail.
```
