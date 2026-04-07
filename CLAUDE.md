# Guardrail — Agent Instructions

## What This Project Is

Guardrail is a Node.js CLI (zero dependencies) that enforces contract-locked execution for CLI commands, multi-step workflows, and parameterized templates. It prevents scope drift by hashing execution contracts and blocking anything that doesn't match a previously approved manifest.

## Project Structure

```
src/cli.js                  Entry point, argument parsing, command routing
src/contract.js             Contract creation, normalization, canonical hashing
src/manifest.js             Manifest CRUD (atomic writes), diff, comparison
src/workflow.js             Workflow definition loading, validation, linting, hashing
src/workflow-supervisor.js  Workflow execution orchestrator (state machine)
src/template.js             Template engine: validate, lint, interpolate, hash, explain, simulate
src/template-supervisor.js  Template execution supervisor with rollback
src/supervisor.js           Single-command execution orchestrator
src/worker-interface.js     Child process spawning (structured vs shell modes)
src/policy-engine.js        Risk evaluation, trust classification
src/validator.js            Result validation, convergence tracking
src/service-registry.js     Service lifecycle (start/stop/restart)
src/logger.js               NDJSON logging, terminal output formatting
src/shared.js               Utilities (deep equality, atomic writes, env building)
tests/test-core.js          Contract, manifest, risk, approval, drift tests
tests/test-workflow.js      Workflow parsing, hashing, drift, risk tests
tests/test-adversarial.js   Security edge case tests
tests/test-template.js      Template validation, lint, inputs, interpolation tests
docs/technical-status.md    Current implementation status and roadmap
```

## How to Run Tests

```bash
npm test
```

All tests use Node.js built-in test runner (`node:test`). No test framework dependencies. Currently 266 tests, all passing.

## Key Patterns

- **Canonical hashing**: `serializeStable()` in contract.js sorts keys for deterministic JSON. Used everywhere for hash stability.
- **Atomic writes**: Manifest persistence uses write-to-temp-then-rename via `saveManifest()` in manifest.js.
- **Fail closed**: Missing/corrupt/ambiguous state always blocks execution. Never assume safe to proceed.
- **Structured mode default**: Shell is explicit opt-in. Templates forbid shell entirely.
- **No dependencies**: Only Node.js built-ins. Do not add npm dependencies.

## Three Execution Paths

1. **Command mode** (`guardrail run -- cmd args`): Single command → contract → manifest → approval → execution
2. **Workflow mode** (`guardrail workflow run --definition file`): Multi-step state machine with services and transitions
3. **Template mode** (`guardrail run --template file --input k=v`): Parameterized contract with typed inputs, env handshake, rollback

Each has its own supervisor file, manifest path, and approval flow. They share contract.js, manifest.js, policy-engine.js, worker-interface.js, and validator.js.

## Template System (kind: "template" and "workflow_template")

Templates support two kinds:
- `kind: "template"` — Single command with a `run` block
- `kind: "workflow_template"` — Multi-step with `steps` array and optional `rollback`

Input types: `string` (must have `pattern` or `enum`), `integer` (optional `min`/`max`), `boolean`. Bare strings without constraints are rejected at both validation and lint time.

Interpolation: `{{inputs.x}}` produces exactly one args array element. Never splits. Resolved after validation.

Environment handshake: Template declares `requires_env`, caller declares allow list, only intersection reaches the process.

Hash: `SHA256(canonical(template_def) + canonical(resolved_inputs) + canonical(env_intersection))`. Changes to any component require re-approval.

## Invariants (Do Not Violate)

1. **Fail closed** — When state is missing/ambiguous/corrupt, block execution.
2. **Canonical determinism** — Same logical input must produce same hash everywhere.
3. **No bypass surface** — No `--force`, `--skip-check`, or env var to skip enforcement.
4. **Immutable approval** — Approved manifests cannot be modified; changes require new approval.
5. **Scope can only narrow via self-resolution** — Widening always requires human approval.
6. **Risk is computed, not declared** — Computed risk overrides declared risk when higher.
7. **Symlinks resolved** — All paths canonicalized before comparison.

## When Updating This Project

- Update `docs/technical-status.md` when adding features, fixing bugs, or changing the roadmap status.
- Run `npm test` after changes — all 266+ tests must pass.
- Follow existing patterns: pure validation functions return error arrays, supervisors handle approval flow, workers handle process spawning.
- Keep zero dependencies. Only Node.js built-ins.
- The test pattern uses `node:test` with `describe/it/assert`. Fixtures are built with helper functions (e.g., `makeIndividualTemplate()`).
