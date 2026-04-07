# Guardrail — Agent Instructions

## What This Project Is

Guardrail is a Node.js CLI (zero dependencies) that enforces contract-locked execution for CLI commands, multi-step workflows, and parameterized templates. It prevents scope drift by hashing execution contracts and blocking anything that doesn't match a previously approved manifest.

## Project Structure

```
src/cli.js                  Entry point, argument parsing, command routing
src/contract.js             Contract creation, normalization, canonical hashing
src/manifest.js             Manifest CRUD (atomic writes), diff, comparison
src/workflow.js             Workflow definition loading, validation, linting, hashing
src/workflow-supervisor.js  Workflow execution orchestrator (state machine, rollback, negotiation)
src/negotiation.js          Negotiation engine: issue codes, delta application, escalation
src/recipe.js               Recipe packaging: schema validation, parsing, hashing, pack/unpack
src/recipe-index.js         Recipe indexing, category filtering, fuzzy search
src/recipe-channel.js       Verified/community trust model, signature mock, enforcement
src/recipe-executor.js      Native recipe execution, runtime guardrails, dry-run
src/resource-bounds.js      Resource constraint schema + runtime enforcement
src/learning-mode.js        Step-by-step explanation engine for learning mode
src/profile.js              User/environment profiles with persistence
src/safe-defaults.js        Global safe default policy layer
src/policy.js               Policy schema, CRUD, enforcement, CLI
src/metrics.js              Structured event tracking + metrics aggregation
src/identity.js             Agent identity model + strict mode enforcement
src/shared-manifest.js      Shared manifest sync, versioning, pin
src/approval-queue.js       Approval queue, multi-stage chains, state machine
src/org-policy.js           Org-wide policy engine, hierarchy resolution
src/rbac.js                 RBAC: 4 roles, 9 permissions, enforcement
src/key-management.js       AES-256-GCM encrypted key storage, scoped access
src/notifications.js        Webhook/Slack/email/log notification adapters
src/deployment-mode.js      local/team/enterprise mode + feature flags
src/compliance.js           JSON + CSV compliance exports
src/environment.js          dev/staging/prod isolation
src/marketplace.js          Recipe marketplace: publish, discover, usage stats
src/incident-hooks.js       Incident response triggers + actions
src/audit.js                Hash-chained audit log, chain verification, query surface
src/fingerprint.js          Environment fingerprinting for audit entries
src/runtime-policy.js       Time policy, counter persistence, concurrency locks
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
tests/test-bucket1.js       Bucket 1 coverage: symlinks, file hash, TOCTOU, ReDoS, anti-interactive
tests/test-bucket2.js       Bucket 2 coverage: rollback, idempotency, negotiation, delta, escalation
tests/test-bucket3.js       Bucket 3 coverage: fingerprint, audit chain, tamper, time policy, locks
tests/test-recipe.js        Recipe packaging: schema, inputs, steps, guardrails, hash, pack/unpack
tests/test-recipe-system.js Recipe system: categories, tags, index, channel, executor, dry-run
tests/test-bucket5.js       Bucket 5: resource bounds, learning mode, profiles, safe defaults, policy, metrics, identity, strict mode
tests/test-bucket6.js       Bucket 6: shared manifests, approval queue, RBAC, keys, env, marketplace, incidents
docs/technical-status.md    Current implementation status and roadmap
```

## How to Run Tests

```bash
npm test
```

All tests use Node.js built-in test runner (`node:test`). No test framework dependencies. Currently 645 tests, all passing.

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
- Run `npm test` after changes — all 645+ tests must pass.
- Follow existing patterns: pure validation functions return error arrays, supervisors handle approval flow, workers handle process spawning.
- Keep zero dependencies. Only Node.js built-ins.
- The test pattern uses `node:test` with `describe/it/assert`. Fixtures are built with helper functions (e.g., `makeIndividualTemplate()`).

## tpf — MANDATORY

tpf saves 40-90% tokens on file reads and command output. **Failure to use tpf is a bug.**

**Reading files:** Use `fullscope_context` or `fullscope_skeleton` (MCP tools) for ALL file reads. Use `Read` ONLY when the next action is `Edit` on that same file. If you catch yourself using `Read` to "understand" a file, stop and use `fullscope_context` instead. Subagents (Explore, Plan) don't have MCP access — they use `Read`, that's expected.

**Running commands:** Prefix with `TPF_LLM_TOOL=codex tpf`: `TPF_LLM_TOOL=codex tpf git status`, `TPF_LLM_TOOL=codex tpf npm test`, `TPF_LLM_TOOL=codex tpf ls -la`.
Never prefix: cd, echo, cat, head, tail, rm, cp, mv, mkdir, pwd, export, source.
Don't prefix redirections (>, <), ||, &, $(), backticks.

**Self-check:** Before every `Read` call, ask: "Am I about to `Edit` this file?" If no → `fullscope_context`.


## Workflow

**The Invariant Method:** `TRACE` → `REPORT` → `FIX` → `PROVE`

1. **Trace:** Map the full data path (A → B → C), not the isolated change point.
2. **Disprove:** Assume the fix will fail. Identify the weakest link before writing code.
3. **Round-Trip:** `write` → `read` → `confirm` before committing.
4. **Scope:** Do not modify files outside the current task. Every new file needs a purpose; every new function needs a caller.
5. **Reflect:** Before every commit, state: 2 assumptions, the weakest link, confidence (0-1).

## Adversarial Self-Review — MANDATORY before committing plans or code

1. **For every code sketch:** State 3 inputs that produce wrong output or silent failure. Fix them before committing. No empty-string returns, no unhandled nulls, no "it probably works."
2. **For every plan:** Before declaring done, list 5 ways it fails silently. If you can't find 5, you haven't looked. At least 2 must be structural (wrong ordering, scaling broken signal, missing feedback loop), not edge cases (null input, empty string). Check: missing fallbacks, wrong assumptions about return shapes, state drift between systems, capacity growth, false resolution/deprecation.
3. **For every classification/routing:** What happens on misclassification? If wrong scope → wrong route → wrong consumer, what's the blast radius? If it's "noise in SWE context" that's acceptable. If it's "constraint deleted" that's not.
4. **Verify actual return shapes.** Read the actual code, not the plan's assumption. If a plan says "returns `invariant_tested`" — grep for it. Claims about what code returns are wrong until verified.
5. **Don't scale broken signal.** Before building infrastructure (dedup, persistence, escalation) on a data source, verify the source is correct. Building on wrong signal scales noise.

## Architecture Laws

1. **300-line file limit.** Split before adding.
2. **No ambient state.** Functions receive data as parameters. Pipeline handlers receive explicit params via `deps`.
3. **Named exports, not default exports.**
4. **Single source of truth.** If data exists in one place, derive everywhere else.
5. **Zero dead code.** Delete commented-out code, unreachable branches, unused imports.
6. **Deletion over configuration.** Don't add `if` or `.env` flags to toggle features.
7. **One mechanism per concern.** Two things doing the same job = delete one.
8. **Provider-specific logic stays in the provider adapter.** Agents never branch on provider type.
9. **Keep architecture docs current.** Changes to states, agent context, data flow, or transitions → update `docs/PHALANX_ARCHITECTURE.md` + `ARCHITECTURE_CHANGELOG.md` in same commit.
10. **Verification is LLM review, not string matching.** No file.includes(), no grep-based checks, no literal string matching on generated code.
11. **Dependency direction.** Imports flow downward only: `routes → pipeline → agents → core → utils → config`. No upward imports. If a lower layer needs something from above, extract the shared piece down to the appropriate level.

## Prompt Authoring

1. **Context only, never directives.** Agent prompts describe the situation. Never tell the agent which commands to run, which files to create, or which tools to use.
2. **Abstract, never specific.** Prompts never name specific shell commands, file paths, or tool names.
3. **Fix the prompt, not the output.** Never add runtime workarounds to compensate for a bad prompt.
