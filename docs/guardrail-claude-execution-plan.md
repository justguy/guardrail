# Guardrail Claude Execution Plan

Status: Historical implementation plan, MVP shipped in v1.0  
Audience: Claude or another coding agent reviewing or extending the implemented Guardrail MVP  
Goal: Preserve the original build plan and acceptance criteria for the shipped MVP

## Objective

Implement a Node.js v20+ CLI named `guardrail` that:

- stores approvals in `.guardrail/approved.json`
- performs deterministic contract hashing and drift detection
- evaluates trust and risk with traffic-light output
- supports interactive and non-interactive execution
- ships a built-in `guardrail demo drift`
- honestly enforces approval boundaries without claiming sandboxing

## Ground Rules

- zero external dependencies
- Node.js standard library only
- structured mode first, shell mode explicit
- manifest approval is the only reusable approval source
- fail closed on ambiguity
- do not expand scope silently
- do not claim containment of host processes

## Deliverables

- executable CLI entry point
- manifest persistence and hashing
- risk evaluator
- approval UI
- drift diffing
- non-interactive mode
- JSON output mode
- deterministic built-in demo
- README aligned with the current docs
- test suite for core paths

## Phase 1: Scaffold the CLI

Goal:

- create the initial module structure and argument parsing

Files:

- `cli.js`
- `supervisor.js`
- `contract.js`
- `manifest.js`
- `logger.js`

Tasks:

1. Implement `guardrail run`.
2. Implement `guardrail demo drift`.
3. Support `--`, `--shell`, `--manifest`, `--approved-manifest`, `--non-interactive`, and `--json`.
4. Print a helpful usage message on invalid input.

Acceptance criteria:

- `guardrail run -- npm test` parses correctly
- `guardrail run "npm test"` parses as shorthand structured mode
- `guardrail run --shell "npm test && npm run lint"` parses correctly
- malformed input fails with a non-zero exit code

## Phase 2: Implement Contracts and Manifests

Goal:

- normalize execution contracts and persist approved manifests

Files:

- `contract.js`
- `manifest.js`

Tasks:

1. Normalize cwd and declared paths with `realpath`.
2. Apply defaults for contract fields.
3. Implement stable serialization.
4. Hash the approval payload with SHA-256.
5. Save manifests to `.guardrail/approved.json`.
6. Load manifests from custom paths when requested.

Acceptance criteria:

- identical logical contracts hash identically
- changed args or shell text change the hash
- manifest save/load round-trips cleanly
- missing manifest in non-interactive mode fails closed

## Phase 3: Build the Risk Evaluator

Goal:

- classify workflows by trust and risk before approval

Files:

- `policy-engine.js`
- `contract.js`

Tasks:

1. Implement trust classes: `reviewed_internal`, `pinned_external`, `generated`, `unknown`.
2. Implement risk levels: `green`, `yellow`, `red`.
3. Generate human-readable risk reasons.
4. Store risk assessment in the manifest.
5. Treat risk-assessment changes as re-approval triggers.

Acceptance criteria:

- structured repo-local workflow can evaluate to `green`
- shell + package install evaluates to `red`
- generated workflow provenance evaluates to `red`
- risk reasons are stable and human-readable

## Phase 4: Build the Approval Experience

Goal:

- make approval clear, fast, and explicit

Files:

- `supervisor.js`
- `logger.js`

Tasks:

1. Print the Guardrail warning banner.
2. Render approval summary with trust/risk details.
3. Use ANSI colors for `green`, `yellow`, `red` when available.
4. Fall back to uppercase labels when color is unavailable.
5. Support Enter-to-approve for green/yellow workflows.
6. Require typed confirmation for red workflows.
7. Persist acknowledgement metadata in the manifest.

Acceptance criteria:

- green/yellow workflows can be approved quickly
- red workflows require stronger confirmation
- approval denial exits cleanly
- approval output includes the responsibility statement

## Phase 5: Implement Drift Detection

Goal:

- block changed scope before execution

Files:

- `supervisor.js`
- `manifest.js`
- `contract.js`

Tasks:

1. Compare requested manifest candidates against stored manifests.
2. Show concise diffs for changed fields.
3. Support raw manifest diff inspection.
4. Trigger re-approval on changed risk assessment alone.

Acceptance criteria:

- changing command, args, shell text, or write scope pauses execution
- changing risk reasons or risk level pauses execution
- unchanged contracts rerun without prompting

## Phase 6: Run Commands and Enforce Runtime Boundaries

Goal:

- launch approved commands and apply the v1 runtime rules

Files:

- `supervisor.js`
- `worker-interface.js`
- `policy-engine.js`

Tasks:

1. Execute structured mode with `spawn`.
2. Execute shell mode explicitly and only when approved.
3. Enforce timeout with `SIGTERM` then `SIGKILL`.
4. Capture stdout, stderr, and exit status.
5. Persist structured logs and state.
6. Detect obvious unsupported interactive/TTY conditions and fail closed.

Acceptance criteria:

- approved commands execute successfully
- timeouts terminate runaway commands
- logs are written to `.guardrail/logs/`
- state is written atomically to `.guardrail/state.json`

## Phase 7: Add Validator and Update Plumbing

Goal:

- support deterministic update proposals from approved sources only

Files:

- `validator.js`
- `worker-interface.js`
- `supervisor.js`

Tasks:

1. Implement `exit_code` validator mode.
2. Implement `ndjson` validator mode.
3. Accept only approved update sources.
4. Validate update proposals against the contract.
5. Record update results and convergence markers.

Acceptance criteria:

- non-Guardrail-aware commands do not get autonomous repair
- malformed NDJSON fails with a protocol error
- disallowed update actions are refused

## Phase 8: Implement Non-Interactive and JSON Modes

Goal:

- make Guardrail usable in CI and automation

Files:

- `cli.js`
- `supervisor.js`
- `manifest.js`

Tasks:

1. Require `--approved-manifest` in non-interactive mode.
2. Refuse runs when approval is missing.
3. Emit the documented JSON result shape.
4. Implement stable exit codes.

Acceptance criteria:

- CI reruns approved workflows without prompting
- drift fails with the documented exit code
- JSON output includes risk level and reasons

## Phase 9: Ship the Built-In Demo

Goal:

- provide a deterministic viral demo and test harness

Files:

- `demo-drift.js`
- `example-task.js`

Tasks:

1. Implement `guardrail demo drift`.
2. Make it deterministically propose `npm install` drift after approving `npm test`.
3. Ensure the output matches the documented pause screen closely.

Acceptance criteria:

- the demo works on a fresh checkout
- no external dependencies are required
- the demo is stable enough for README screenshots and short video capture

## Phase 10: Documentation and Final Verification

Goal:

- make the implementation understandable and reproducible

Files:

- `README.md`
- `docs/guardrail-product-requirements.md`
- `docs/guardrail-technical-spec.md`

Tasks:

1. Write the README around the blocked-drift moment.
2. Document the host execution hardening checklist.
3. Document the enforcement matrix and compatibility matrix.
4. Verify the CLI matches the docs.

Acceptance criteria:

- README explains value in under 10 seconds
- hardening and limitation language is prominent
- docs and CLI behavior align

## Required Test Matrix

Claude should implement automated tests covering:

- contract normalization
- manifest hashing stability
- manifest save/load
- risk classification
- green/yellow/red approval behavior
- drift detection and re-approval
- non-interactive approval reuse
- JSON output schema
- exit-code mapping
- NDJSON protocol validation
- built-in demo output

## Suggested Execution Order

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6
7. Phase 8
8. Phase 7
9. Phase 9
10. Phase 10

Rationale:

- parse and persist first
- make approval and drift real before runtime complexity
- get CI/non-interactive behavior working before advanced update plumbing
- leave NDJSON update logic until the core approval model is stable
- ship the demo after the update path exists so it exercises the real behavior instead of a one-off shortcut

## Stop Conditions

Claude should pause and ask for clarification if:

- the implementation needs stronger containment guarantees than the docs allow
- the user asks for Windows or production-targeted support in v1
- a feature would require external dependencies to implement well
- a command model conflicts with the structured-vs-shell rules

## Demo Walkthrough

Expected demo flow:

1. Run `guardrail demo drift`
2. Approve the initial contract
3. Observe a validation failure
4. Observe a proposed `npm install`
5. Watch Guardrail pause and require approval
6. Deny the update and see the run halt

This is the fastest way to verify the product concept end to end.
