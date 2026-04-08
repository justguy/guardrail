# Guardrail Technical Specification

Status: Implemented MVP v1.0  
Source: Prompt intake 1-3, resolved into a single v1 definition  
Runtime target: Node.js v20+  
Dependency policy: Zero external dependencies

## Purpose

Guardrail is a Node.js CLI that enforces a user-approved execution contract for trusted CLI workflows.

Guardrail guarantees:

- explicit approval before first execution
- manifest reuse when the contract is unchanged
- drift detection before execution
- fail-closed refusal on changed contracts
- deterministic logging and state handling

Guardrail does not guarantee malicious-code containment.

Guardrail is a facilitator and approval system, not a security authority. The user remains responsible for approving host-executed workflows.

Guardrail approval is the system of record for approval reuse. Host-level shell prompts or platform approval mechanisms may coexist, but Guardrail must not rely on them for correctness.

## v1 Scope

Guardrail v1 is optimized for:

- macOS and Linux
- structured repo-local commands
- explicit multi-step workflows defined up front
- local developer usage
- CI execution with pre-approved manifests
- shipped demo and Guardrail-aware validator workflows

Guardrail v1 is not a sandbox and does not attempt full OS-level policy enforcement.

## System Architecture

Guardrail uses a two-tier model.

### Supervisor

Trusted process responsible for:

- CLI parsing
- manifest loading and saving
- contract normalization and hashing
- approval UX
- drift detection
- policy checks
- timeout enforcement
- retry and backoff
- update orchestration
- structured logging
- state persistence

### Worker

Task process responsible for:

- running the approved command
- optionally emitting NDJSON protocol messages
- optionally proposing updates through approved channels

The worker is trusted only as much as the user trusts the command being run. Guardrail constrains workflow approval, not code intent.

## CLI Grammar

Guardrail v1 supports these entry points.

### Structured Mode

Preferred and default form:

```text
guardrail run [guardrail flags] -- <command> [args...]
```

Example:

```text
guardrail run -- npm test -- --runInBand
```

Behavior:

- everything after `--` becomes the structured command
- Guardrail stores the top-level binary and args exactly
- no shell is used

### Shorthand Structured String

Accepted only for a single command with no shell operators:

```text
guardrail run "npm test"
```

Behavior:

- Guardrail tokenizes the string into `command + args`
- if the string contains shell metacharacters or ambiguous quoting, Guardrail refuses and tells the user to use `--shell`

### Shell Mode

Explicit opt-in:

```text
guardrail run --shell "npm test && npm run lint"
```

Behavior:

- Guardrail stores the exact shell script text
- Guardrail requires explicit shell approval
- Guardrail compares shell-mode contracts by exact script text

### Workflow Mode

First-class workflow entry point:

```text
guardrail workflow run --definition <path>
```

Canonical non-interactive form:

```text
guardrail workflow run --definition workflows/server-cycle.json --non-interactive --approved-manifest .guardrail/workflows/server-cycle.approved.json
```

Behavior:

- the workflow definition is a checked-in user-authored file
- Guardrail normalizes and hashes the workflow definition into an approval candidate
- Guardrail stores workflow approvals separately from command approvals
- one workflow manifest path stores one approved workflow definition

## Default Paths

By default, Guardrail stores files relative to the invocation root directory:

- manifest: `.guardrail/approved.json`
- workflow manifest: `.guardrail/workflows/default.approved.json`
- state: `.guardrail/state.json`
- logs: `.guardrail/logs/<runId>.ndjson`

Alternative manifest paths may be supplied with:

```text
--manifest <path>
```

In non-interactive mode, the canonical flag is:

```text
--approved-manifest <path>
```

Host/session approval state must not be treated as approval reuse input.

## Approved Manifest

The persisted approval unit is the manifest, not just the raw contract.

### Command Manifest Schema

v1 command manifest schema:

```json
{
  "version": 1,
  "tool": "guardrail",
  "approvedAt": "ISO-8601 timestamp",
  "projectRoot": "/absolute/path",
  "contractHash": "sha256-hex",
  "contract": {
    "command": "string",
    "args": ["string"],
    "cwd": "string",
    "mode": "structured | shell",
    "shell": "string | null",
    "shellFeatures": {
      "pipes": false,
      "redirects": false,
      "subshells": false,
      "envExpansion": false
    },
    "allowedBinaries": ["string"],
    "writablePaths": ["string"],
    "readablePaths": ["string"],
    "envPolicy": {
      "inherit": false,
      "allow": ["PATH"],
      "inject": {}
    },
    "childProcessPolicy": "deny | allow-listed",
    "networkPolicy": "undeclared",
    "retryPolicy": {
      "maxRetries": 3,
      "backoff": [1000, 2000, 4000]
    },
    "timeoutMs": 60000,
    "updatePolicy": {
      "allowedActions": ["apply_patch", "run_script"]
    }
  },
  "riskAssessment": {
    "trustClass": "reviewed_internal | pinned_external | generated | unknown",
    "riskLevel": "green | yellow | red",
    "reasons": ["string"],
    "requiresStrongConfirmation": true,
    "acknowledgedBy": "string | null",
    "acknowledgedAt": "ISO-8601 timestamp | null"
  },
  "workflow": {
    "validator": "exit_code | ndjson",
    "updateSource": "none | worker_proposal | demo"
  }
}
```

### Workflow Manifest Schema

v1 workflow manifest schema:

```json
{
  "version": 2,
  "tool": "guardrail",
  "kind": "workflow",
  "approvedAt": "ISO-8601 timestamp",
  "projectRoot": "/absolute/path",
  "workflowHash": "sha256-hex",
  "workflow": {
    "name": "string",
    "entryStep": "string",
    "maxIterations": 10,
    "services": [],
    "steps": []
  },
  "riskAssessment": {
    "trustClass": "reviewed_internal | pinned_external | generated | unknown",
    "riskLevel": "green | yellow | red",
    "reasons": ["string"],
    "requiresStrongConfirmation": true,
    "acknowledgedBy": "string | null",
    "acknowledgedAt": "ISO-8601 timestamp | null"
  }
}
```

## Manifest Semantics

Approval reuse rules:

- Guardrail loads the manifest at the selected path
- Guardrail normalizes the requested run into a manifest candidate
- Guardrail hashes the normalized contract plus workflow metadata
- Guardrail computes a risk assessment and records the reasons
- if the hash and risk assessment match, the run proceeds without prompting
- if the hash differs, or if the risk assessment changes, Guardrail shows drift and requires re-approval
- approving the new run overwrites the manifest at that path

Approval source-of-truth rule:

- only the Guardrail manifest counts as reusable approval
- shell/session/platform approval prompts are ignored for reuse semantics

In v1, a manifest is reused only for:

- the same project root
- the same execution mode
- the same normalized contract
- the same workflow validator/update configuration
- the same recorded trust and risk assessment

In workflow mode, drift detection also compares:

- workflow entry step
- max iterations
- service definitions
- step definitions and transitions
- project root
- `riskAssessment.trustClass`
- `riskAssessment.requiresStrongConfirmation`

One manifest path stores one approval unit. Reusing a path for a different command or workflow intentionally overwrites the previous approval.

Workflow definitions may include `recipe_ref` steps. In that case, the workflow manifest remains the single approval unit and captures each referenced recipe's resolved version, recipe hash, resolved inputs, trust metadata (`channel`, `trust`, `signature`), and any prompt-bearing file hashes that were part of the approved workflow.

## Contract Normalization

Normalization rules:

- convert `cwd` and all declared paths to absolute `realpath` values
- sort unordered arrays before hashing
- preserve ordered arrays such as `args` and retry backoff
- preserve exact shell text in shell mode
- apply default values before hashing
- use stable JSON serialization before hashing

Hash algorithm:

- SHA-256 over the stable serialized manifest approval payload

## Trust and Risk Evaluation

Guardrail does not prove trust. It evaluates visible signals and surfaces risk to the user before approval.

### Trust Classes

- `reviewed_internal`
- `pinned_external`
- `generated`
- `unknown`

### Risk Levels

- `green`
- `yellow`
- `red`

### Risk Display

The supervisor must present risk using traffic-light colors when terminal color is available:

- `green` -> green text
- `yellow` -> yellow text
- `red` -> red text

When color is unavailable or disabled, the supervisor must fall back to explicit uppercase labels:

- `GREEN`
- `YELLOW`
- `RED`

### Required Risk Factors

The supervisor must evaluate at least:

- provenance of the workflow source
- execution mode: structured or shell
- target environment: local, shared, staging, or production-like
- top-level binary set
- declared writable path breadth
- secrets exposure via env injection, env allow-list, or env inheritance
- privilege indicators such as `sudo`, root-owned paths, or system directories
- package installation or download behavior
- patching/restart capability
- destructive action indicators

### Baseline Classification Rules

Guardrail should classify as `green` only when the workflow is tightly bounded, reviewed, and does not show high-risk signals.

Guardrail should classify as `yellow` when the workflow is trusted enough to run but has meaningful operational risk or broader blast radius.

Guardrail must classify as `red` when any of the following are true:

- trust class is `generated` or `unknown`
- shell mode is combined with package install, download, or destructive behavior
- the workflow targets production-like environments
- writes extend outside explicitly approved project boundaries
- `sudo`, root-level, or system-path modification is present
- cloud, infrastructure, or database admin commands are present
- secret injection or secret allow-list exposure combined with shell mode or production targets

### Risk Reasons

The supervisor must produce human-readable reasons such as:

- `generated workflow source`
- `shell mode enabled`
- `writes outside repo root`
- `package installation requested`
- `service restart capability`
- `production-like target`
- `secret injection enabled`

Guardrail must store these reasons in the manifest and present them at approval time.

## Approval UX

Interactive approval requirements:

- print the mandatory Guardrail warning banner
- render a concise human-readable summary
- allow Enter as approve
- treat `n`, Ctrl-C, EOF, or timeout as deny
- provide a raw manifest view on demand
- display the traffic-light risk level and all risk reasons
- display a plain-language responsibility statement
- require a stronger typed confirmation for red-risk approvals

The approval screen must also disclose:

- Guardrail approval is the reusable approval record
- host-level prompts, if any, are separate and not a substitute

Minimum approval summary:

- command
- mode
- cwd
- allowed binaries
- writable paths
- child-process policy
- retries
- timeout
- trust class
- risk level
- risk reasons

Canonical approval target:

```text
Protected Execution Enabled
- Contract locked
- Not a secure sandbox
- Only safe for trusted tasks
- Changes require re-approval

Command: npm test
Mode: structured
Directory: /repo
Writes: /repo
Allowed binaries: npm
Child processes: deny
Retries: 3
Timeout: 60s
Trust: reviewed_internal
Risk: YELLOW
Reasons:
- service restart capability
- patch/update path enabled

You are responsible for approving this workflow. Guardrail highlights risk; it does not certify safety.

[Enter] Approve
```

For `red` workflows, quick approval is insufficient. Guardrail must require an explicit typed confirmation phrase before storing the manifest.

## Drift Detection

Drift is an exact mismatch between the requested normalized manifest candidate and the persisted approved manifest.

Guardrail must compare:

- command
- args
- cwd
- execution mode
- shell text
- shell feature flags
- allowed binaries
- readable and writable paths
- env policy
- child-process policy
- retry policy
- timeout
- update policy
- validator/update workflow metadata

Drift behavior:

- stop before execution
- show a concise diff first
- allow raw manifest diff inspection
- require explicit re-approval

Risk changes alone are sufficient to trigger re-approval even when the command text is unchanged.

Canonical blocked-drift output:

```text
Execution paused

Requested change:
+ Add command: npm install

This is outside your approved contract.
Run halted. Re-run with explicit approval to widen scope.
```

## Validator and Update Model

This closes the largest ambiguity from the prompt set.

### Core Rule

Guardrail does not infer fixes from arbitrary stderr or exit codes.

Guardrail only executes update proposals that come from an approved workflow source.

Guardrail only governs what it launches and what Guardrail-mediated updates perform. It does not control arbitrary behavior that an already-started host process performs internally.

### v1 Validator Types

`exit_code`

- success when the command exits `0`
- failure when the command exits non-zero
- no autonomous update proposal

`ndjson`

- for Guardrail-aware tasks that emit protocol messages on stdout
- may emit a structured update proposal

### Update Proposal Source

In v1, update proposals may come from:

- a shipped demo workflow
- a Guardrail-aware worker using `ndjson`

Ordinary third-party CLI commands do not gain autonomous repair just by being wrapped in Guardrail.

### Update Proposal Schema

When a worker requests an update, it must emit:

```json
{
  "type": "VALIDATION_FAILED_REQUIRE_UPDATE",
  "payload": {
    "validationSignature": "sha256-hex",
    "reason": "string",
    "proposedUpdate": {
      "action": "apply_patch | run_script",
      "summary": "string",
      "command": "string | null",
      "args": ["string"],
      "cwd": "string",
      "patch": "string | null"
    }
  }
}
```

### Update Execution Rules

The supervisor must:

- verify the proposed action type is in `updatePolicy.allowedActions`
- verify any proposed command is still within the approved binary and path scope
- halt and require a new manifest-backed approval if the proposal widens scope
- never allow a one-off interactive override for widened scope inside the same run
- refuse updates that would modify the contract implicitly

### Update Result Schema

After an approved update action runs, Guardrail records:

```json
{
  "updated": true,
  "changes": ["file"],
  "summary": "string"
}
```

## IPC Protocol

Worker-to-supervisor messages are NDJSON on stdout.

Allowed message types:

- `LOG`
- `SUCCESS`
- `VALIDATION_FAILED_REQUIRE_UPDATE`
- `ERROR`

Protocol rules:

- stdout is reserved for NDJSON in `ndjson` validator mode
- malformed JSON is a protocol error
- unknown types are protocol errors
- stderr is captured separately and logged

## Execution Loop

Supervisor loop:

1. build normalized manifest candidate
2. load approved manifest
3. if needed, request approval or re-approval
4. launch worker
5. evaluate validator result
6. if success, exit `0`
7. if update requested, validate the proposal
8. halt widened proposals and require re-approval, or continue only with in-scope proposals
9. run the approved in-scope update action
10. detect no-op or convergence
11. retry within retry policy
12. abort on drift, timeout, policy violation, unsupported behavior, or retry exhaustion

## Convergence Detection

Guardrail stores:

- validation signature
- update signature
- attempt count
- prior terminal reason

Abort conditions:

- same validation signature repeats with no successful state change
- same update signature repeats
- update result reports no changes
- retry limit is reached

## Interactive, CI, and JSON Modes

### Interactive Mode

Default mode.

Responsibilities:

- show approval prompt
- show drift diff
- show pause and deny states clearly

### Non-Interactive Mode

Canonical form:

```text
guardrail run --non-interactive --approved-manifest .guardrail/approved.json -- npm test
```

Workflow form:

```text
guardrail workflow run --definition workflows/server-cycle.json --non-interactive --approved-manifest .guardrail/workflows/server-cycle.approved.json
```

Rules:

- never prompt
- require a manifest path
- fail if the manifest is missing
- fail if drift is detected
- fail if the workflow requires interactive approval
- fail if no acknowledged risk assessment is present in the manifest

### JSON Output

Canonical form:

```text
guardrail run --json --non-interactive --approved-manifest .guardrail/approved.json -- npm test
```

Top-level JSON result shape:

```json
{
  "runId": "string",
  "status": "success | approval_required | approval_denied | drift_detected | validation_failed | update_denied | timeout | policy_violation | unsupported | protocol_error | internal_error",
  "attempt": 1,
  "contractHash": "sha256-hex",
  "manifestPath": "string",
  "riskLevel": "green | yellow | red",
  "riskReasons": ["string"],
  "exitCode": 0
}
```

Workflow JSON result shape:

```json
{
  "runId": "string",
  "status": "success | approval_required | approval_denied | drift_detected | update_denied | unsupported | protocol_error | internal_error",
  "workflowHash": "sha256-hex",
  "manifestPath": "string",
  "riskLevel": "green | yellow | red",
  "riskReasons": ["string"],
  "stepsExecuted": 3,
  "failedStep": "string | null",
  "terminalReason": "string | null",
  "exitCode": 0
}
```

## Exit Codes

Guardrail v1 exit codes:

- `0` success
- `10` approval required or approval missing in non-interactive mode
- `11` approval denied
- `12` drift detected
- `13` validation failed with no update path
- `14` update denied, no-op, or convergence abort
- `15` timeout
- `16` policy violation
- `17` unsupported workflow or compatibility issue
- `18` protocol error
- `19` internal framework error

## Enforcement Matrix

This closes the honesty gap in the earlier prompts.

### Hard Guarantees

- exact manifest hashing and drift detection
- explicit approval before first run
- explicit risk presentation before first run
- explicit re-approval on changed manifest
- Guardrail manifest as the only reusable approval source
- exact top-level command and args capture in structured mode
- exact shell script text capture in shell mode
- fail-closed non-interactive behavior
- retry and timeout policy handling
- allowed update action type checks
- secret-pattern detection in both `envPolicy.inject` keys and `envPolicy.allow` lists
- mandatory RED escalation when secret exposure combines with shell mode or production targets
- non-interactive reuse requires a previously acknowledged risk assessment in the manifest

### Best-Effort Runtime Controls

- descendant process detection and cleanup
- child process denial beyond the top-level command
- cleanup after timeout
- compatibility detection for TTY-heavy tools
- long-running service lifecycle management without consuming stdout/stderr pipes

### Declared Intent, Not Containment

- `writablePaths` and `readablePaths` bound Guardrail-mediated updates and appear in approval UX, but do not sandbox arbitrary child file I/O
- `allowedBinaries` is hard for the approved top-level command and Guardrail-mediated update commands, but not a full descendant execution sandbox
- `networkPolicy` is informational only in v1 and must remain `undeclared`
- `riskLevel` is an advisory approval aid backed by deterministic rules, not a safety certification

### Explicit Override Boundary

Once Guardrail launches an approved host process:

- Guardrail can observe exit status, timeout, and some descendant-process behavior
- Guardrail can refuse future drift and unapproved relaunches
- Guardrail cannot guarantee that the running process will not self-modify behavior, spawn helpers, or perform unintended side effects

Therefore, Guardrail is robust against accidental drift at the approval boundary, but not against adversarial or overly powerful code once execution begins.

### Explicit Non-Guarantees

- malicious-code containment
- complete filesystem isolation
- complete network isolation
- complete descendant-process prevention

## Host Execution Hardening Checklist

When Guardrail is used for unsandboxed host execution, the user should harden the runtime environment outside Guardrail itself.

Recommended checklist:

- run Guardrail under a dedicated low-privilege OS user
- use a dedicated workspace rather than a broad home-directory scope
- do not grant `sudo` or administrator access
- keep writable paths narrow and explicit
- keep the top-level binary allowlist narrow
- prefer structured mode over shell mode
- minimize inherited environment variables
- inject only the secrets strictly required for the workflow
- keep development, staging, and production manifests separate
- avoid production-targeted unattended workflows in v1 when possible
- ensure there is a documented stop, rollback, and cleanup path
- persist logs outside ephemeral terminals
- add VM or container isolation when the workflow is yellow-to-red and the blast radius matters

Hardening disclosure requirement:

- the approval UX and docs must remind the user that Guardrail does not provide these protections internally

## Compatibility Matrix

### Supported

- macOS
- Linux
- repo-local build, test, lint, and format commands
- Node.js toolchains in structured mode
- Guardrail-aware `ndjson` workers
- CI runs with pre-approved manifests

### Supported With Caveats

- shell mode with explicit `--shell`
- commands that spawn children
- AI-generated commands after Guardrail approval

### Not Supported in v1

- Windows
- full-screen terminal UIs
- password prompts
- REPLs
- stdin-driven interactive tools
- PowerShell-specific shell semantics

## Logging and State

Structured logs are written to:

- `.guardrail/logs/<runId>.ndjson`

Persistent state is written to:

- `.guardrail/state.json`

State must be written atomically.

Minimum state:

- attempt history
- last terminal result
- update history
- convergence markers

## Runtime Error Model

Required error types:

- `FrameworkError`
- `ContractViolationError`
- `TimeoutError`
- `ValidationError`
- `UpdateError`
- `ProtocolError`
- `UnsupportedWorkflowError`

## Built-In Demo

Guardrail v1 must ship:

```text
guardrail demo drift
```

Requirements:

- deterministic output
- no external dependencies beyond Node.js
- reproduces the blocked `npm install` scope expansion moment
- suitable for README screenshots and launch recording

## Initial File Structure

Required modules:

- `cli.js`
- `supervisor.js`
- `contract.js`
- `manifest.js`
- `policy-engine.js`
- `worker-interface.js`
- `validator.js`
- `logger.js`
- `demo-drift.js`

## Documentation Requirements

Docs must include:

- what Guardrail is
- what Guardrail is not
- that the user is responsible for approvals
- that Guardrail uses its own approval system and does not rely on host-level prompts
- the enforcement matrix
- the trust and risk model
- the compatibility matrix
- interactive and CI examples
- demo usage
- limitations near the top

## Post-v1

Deliberately deferred:

- Windows support
- richer manifest registries
- stronger OS-level isolation integrations
- adapters for common external tools
