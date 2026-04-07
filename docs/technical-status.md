# Guardrail — Technical Status & Roadmap

**Last updated:** 2026-04-06

---

## Architecture Overview

Guardrail is a Node.js CLI (zero dependencies) that enforces contract-locked execution for CLI commands, multi-step workflows, and parameterized templates. Every execution is normalized, hashed, compared against an approved manifest, and either permitted or blocked.

```
src/
  cli.js                 Entry point, argument parsing, command routing
  contract.js            Contract creation, normalization, hashing, shell detection
  manifest.js            Manifest creation, persistence (atomic write), diff, comparison
  workflow.js            Workflow definition loading, validation, linting, normalization, hashing
  workflow-supervisor.js Workflow execution orchestrator (state machine, services, transitions)
  template.js            Template engine: load, validate, lint, interpolate, hash, explain, simulate
  template-supervisor.js Template execution supervisor with rollback support
  supervisor.js          Single-command execution orchestrator (approval, convergence, retry)
  worker-interface.js    Child process spawning (structured vs shell modes)
  policy-engine.js       Risk evaluation, trust classification, binary/env/path analysis
  validator.js           Result validation (exit_code, NDJSON protocol), convergence tracker
  service-registry.js    Service lifecycle management (start/stop/restart)
  logger.js              NDJSON structured logging, terminal output formatting
  negotiation.js         Negotiation engine: issue codes, request generation, delta application, escalation
  shared.js              Utilities (deep equality, atomic writes, env building, subprocess execution)

tests/
  test-core.js           Contract, manifest, risk, approval, drift, validator, logger tests
  test-workflow.js        Workflow parsing, hashing, drift, risk, normalization, lint tests
  test-adversarial.js    Sneaky allow-list, fake success trap, trojan step, tamper detection
  test-template.js       Template validation, lint, inputs, interpolation, env, hash, manifest tests
  test-bucket1.js        Bucket 1 coverage: symlinks, file hash, TOCTOU, ReDoS, drift, widening
  test-bucket2.js        Bucket 2 coverage: rollback, idempotency, negotiation, delta, escalation

docs/                    Product requirements, specs, invariants, implementation guides
.guardrail/              Runtime state (approved manifests, logs, state files)
```

**Stats:** ~7,700 lines of source, ~4,800 lines of tests, 392 passing tests, 0 dependencies.

---

## What's Working (v1)

### Bucket 1 — Core Contract Engine

| Feature | Status | Notes |
|---------|--------|-------|
| Command normalization | Done | Structured + shell modes, deep merge defaults, path resolution |
| Manifest creation & persistence | Done | Atomic write-to-temp-then-rename, JSON round-trip |
| Manifest matching & drift detection | Done | Field-by-field comparison, human-readable diffs |
| Contract hashing (SHA-256) | Done | Canonical JSON serialization, stable across formatting |
| Risk classification (green/yellow/red) | Done | 15+ signal detectors (binary, env, path, pattern-based) |
| Trust classification | Done | reviewed_internal, pinned_external, generated, unknown |
| Approval flow (interactive + non-interactive) | Done | TTY detection, strong confirmation for red, Enter for green/yellow |
| Non-interactive enforcement | Done | Fails closed on missing manifest or drift (exit 10/12) |
| Path canonicalization | Done | Symlink resolution via realpathSync |
| Shell metacharacter detection | Done | Blocks shorthand mode, requires explicit --shell |
| Secret pattern detection | Done | Scans inject keys + allow lists, escalates with shell/prod |
| Exit code mapping | Done | 0, 10-19 range covering all supervisor outcomes |
| NDJSON protocol validation | Done | Real-time parsing, protocol message extraction |
| Output validator engine | Done | exit_code + ndjson modes with update proposal support |
| Convergence tracker | Done | Detects repeated signatures, no-progress loops, retry limits |
| File provenance enforcement (fileHash) | Done | SHA-256 verification before execution, blocks on mismatch. All 3 supervisors. |
| Anti-interactive detection | Done | Stderr pattern scan for password/prompt patterns. All 3 supervisors. |
| Formal ReDoS rejection | Done | Blocks manifest save for unsafe regex in contracts, workflows, and templates |
| Cross-supervisor parity | Done | file hash, anti-interactive, regex validators enforced in command/workflow/template modes |
| CLI (run, demo drift) | Done | Structured + shell + shorthand string modes |

### Bucket 2 — Workflow & Negotiation Engine

| Feature | Status | Notes |
|---------|--------|-------|
| Workflow definition format | Done | JSON with steps, services, transitions, typed step dispatch |
| Workflow validation | Done | Top-level schema, unique IDs, transitions, entry step, rollback validation |
| Workflow linting | Done | Fatal errors (failure→done, shell mode, missing rollback) + advisory warnings |
| Workflow normalization | Done | Sorted steps/services, default envPolicy, path resolution, idempotent defaults |
| Workflow hashing | Done | SHA-256 of canonical serialized workflow (includes rollback + rollback_policy) |
| Workflow manifest (v2) | Done | Includes rollback section, rollback_policy, idempotent flags |
| Workflow drift detection | Done | Step/service/transition/rollback-level diffing |
| Workflow execution | Done | State machine with step dispatch, service lifecycle |
| Rollback guarantees (I-W2) | Done | Pre-approved rollback, auto-execute on abort/non-idempotent failure |
| Idempotency enforcement (I-W4) | Done | Steps default false, non-idempotent failure forces rollback+abort |
| Negotiation request generation | Done | Structured issue codes, self_resolvable field, round tracking |
| Delta application engine | Done | Merge, re-validate, scope direction, cumulative drift |
| Self-resolvable issue handling | Done | 5 self-resolvable codes (MISSING_ROLLBACK, MISSING_VALIDATOR, etc.) |
| Non-self-resolvable enforcement | Done | Hard blocks (SIGNING_ATTEMPT, PTY_ADDITION, etc.) + human escalation |
| Negotiation round limits (I-W8) | Done | Hard ceiling, NEGOTIATION_EXHAUSTED on exceed |
| Cumulative drift detection (I-W6) | Done | Net widening across rounds triggers CUMULATIVE_WIDENING |
| Human escalation package | Done | Full trace: original manifest, all rounds, blocking reason, recommendation |
| Service registry | Done | Start/stop/restart with signal handling and cleanup |
| Workflow risk aggregation | Done | Per-step evaluation rolled up to workflow level |
| envPolicy normalization | Done | Workflow steps default inherit=true, single commands inherit=false |
| CLI (workflow run, workflow lint) | Done | Full approval flow, fatal lint errors block approval |

### Template System (New)

| Feature | Status | Notes |
|---------|--------|-------|
| Template schema (individual + workflow) | Done | `kind: "template"` (single) and `kind: "workflow_template"` (multi-step) |
| Input type system | Done | string (pattern/enum), integer (min/max), boolean; bare strings rejected |
| Input validation pipeline | Done | Stage 1 (type), Stage 2 (constraint), Stage 3 (injection scan) |
| Interpolation engine | Done | `{{inputs.x}}` → single arg element, resolved after validation |
| Environment handshake | Done | requires_env intersection caller allow, secret pattern warnings |
| Cryptographic provenance | Done | SHA-256(template + inputs + env), drift detection on re-run |
| Template manifest | Done | Per-template approval at `.guardrail/templates/<name>.approved.json` |
| Template lint (8 checks) | Done | Bare strings, structured mode, interpolation, rollback, ReDoS, risk, secrets |
| Template explain | Done | Human-readable what-it-does/what-it-needs/what-it-cannot-do |
| Template schema command | Done | Input type, constraints, defaults, required env vars |
| Template simulate | Done | Full dry-run with resolved args, env, rollback preview |
| Template diff | Done | Current vs approved hash comparison with change details |
| Template execution | Done | Step-by-step with env scoping, validator regex, rollback on failure |
| Rollback support | Done | Automatic for non-idempotent step failures |
| CLI (template lint/explain/schema/simulate/diff, run --template) | Done | Full command surface per spec |

### Adversarial Testing

| Scenario | Status | Notes |
|----------|--------|-------|
| Sneaky allow-list inheritance | Tested | Secret env escalation detected |
| Fake success trap | Tested | failure-to-done caught at lint |
| Trojan horse step | Tested | Hidden secret in step 2 escalates to red |
| Lazy schema normalization | Tested | Partial envPolicy normalizes to full shape, hash stable |
| Silent tamper detection | Tested | Tampered manifest triggers drift in non-interactive mode |

---

## What's Not Working / Not Yet Implemented

### Bucket 1 Gaps

| Feature | Status | Priority |
|---------|--------|----------|
| TOCTOU mitigation (hash → fd → exec) | Documented limitation | Node.js lacks fexecve; fileHash provides best-effort guard |
| Executable path resolution (resolve via PATH) | Not started | Low — currently uses command name, not abs path |

### Bucket 2 Gaps

| Feature | Status | Priority |
|---------|--------|----------|
| CLI negotiate command | Not started | Low — agent round-trip via CLI (API available via negotiateWorkflowDelta) |
| Agent-initiated retry for idempotent steps | Not started | Low — transition system handles retries, but no agent-triggered retry API |

### Template System Gaps

| Feature | Status | Priority |
|---------|--------|----------|
| Remote template pinning (SHA + URI) | Not started | Medium — `github://org/repo/file.json@SHA` |
| Template composition / imports | Deferred | Intentionally out of v1 scope |
| Trusted registries config | Not started | Needed for remote templates |
| `mode: shell` in templates | Rejected | Intentionally forbidden in v1 |

### Bucket 3 — Audit, Observability, Runtime Integrity

| Feature | Status | Priority |
|---------|--------|----------|
| NDJSON audit log | Done | Per-run log files in `.guardrail/logs/` |
| Environment fingerprinting | Not started | Medium |
| Time policy enforcement | Not started | Low |
| Counter persistence | Not started | Low |
| Concurrency locks | Not started | Low |
| Tamper resistance | Partial | Atomic writes, but no manifest signing |
| Audit query surface | Not started | Low |

### Bucket 4 — Recipe System & OpenClaw Integration

| Feature | Status | Priority |
|---------|--------|----------|
| All features | Not started | Deferred until core stabilizes |

### Bucket 5 — Policy, UX, Adoption

| Feature | Status | Priority |
|---------|--------|----------|
| Learning mode | Not started | Medium |
| Profiles | Not started | Low |
| Safe defaults | Partial | Defaults exist but not configurable |

### Bucket 6 — Enterprise & Team Features

| Feature | Status | Priority |
|---------|--------|----------|
| All features | Not started | Future |

---

## Roadmap

### Phase 1 — Foundation

- [x] Core contract engine (Bucket 1 MVP)
- [x] Workflow engine (Bucket 2 MVP)
- [x] Template system (individual + workflow templates)
- [x] Adversarial test suite
- [x] 266 passing tests, 0 dependencies

### Phase 2 — Hardening

- [x] File provenance enforcement (fileHash SHA-256 verification)
- [x] Anti-interactive execution detection (stderr pattern scan)
- [x] Formal ReDoS regex rejection at manifest approval time
- [x] Bucket 1 test coverage requirements (58 tests)
- [ ] TOCTOU mitigation (fd-based exec — requires native addon, documented limitation)
- [ ] Remote template pinning (SHA-locked URI)
- [ ] Executable PATH resolution to absolute

### Phase 3 (Current) — Negotiation Engine

- [x] Rollback guarantees for workflows (I-W2): pre-approved rollback, auto-execute on failure
- [x] Idempotency enforcement (I-W4): steps default false, non-idempotent failure → rollback+abort
- [x] Workflow lint upgrade: fatal errors (failure→done, shell mode, missing rollback) block approval
- [x] Negotiation request generation (15 structured issue codes, self_resolvable classification)
- [x] Delta application engine (agent-submitted narrowing with deep merge)
- [x] Self-resolvable issue handling (MISSING_ROLLBACK, MISSING_VALIDATOR, REGEX_OVERBROAD, etc.)
- [x] Cumulative drift tracking (I-W6): net widening across rounds triggers CUMULATIVE_WIDENING
- [x] Round limits (I-W8): hard ceiling, NEGOTIATION_EXHAUSTED on exceed
- [x] Human escalation package (full trace, all rounds, blocking reason, recommendation)
- [x] Hard blocks: SIGNING_ATTEMPT, ROLLBACK_MUTATION, PTY_ADDITION, IDEMPOTENT_ADDITION, etc.
- [x] Bucket 2 test coverage requirements (61 tests)
- [ ] CLI negotiate command (agent round-trip via CLI)

### Phase 4 — Observability & Audit

- [ ] Environment fingerprinting
- [ ] Audit query surface
- [ ] Tamper-resistant manifest signing
- [ ] Time policy enforcement

### Phase 5 — Recipe System & Distribution

- [ ] Recipe packaging format
- [ ] Verified recipe channel
- [ ] OpenClaw wrapper integration
- [ ] GitHub/package/git/infra recipes

### Phase 6 — Enterprise

- [ ] Shared manifests
- [ ] Org policy engine
- [ ] Multi-stage approval
- [ ] Centralized audit
- [ ] Compliance exports

---

## Key Design Decisions

1. **Zero dependencies** — Only Node.js built-ins. Reduces supply chain attack surface.
2. **Fail closed** — Missing, corrupt, or ambiguous state blocks execution.
3. **Structured mode default** — Shell is explicit opt-in; templates forbid it entirely.
4. **Separated trust and risk** — Provenance (trust) is orthogonal to operational danger (risk).
5. **Atomic manifest writes** — Write to temp, rename to prevent partial reads.
6. **Canonical JSON hashing** — Stable across formatting, key order, whitespace.
7. **No sandbox** — Contract layer, not a security boundary.
8. **Per-invocation template approval** — Hash includes template + inputs + env.
9. **Environment handshake** — Templates cannot silently harvest env vars.

---

## Test Matrix

| Suite | Tests | Focus |
|-------|-------|-------|
| test-core.js | 95 | Contract, manifest, risk, approval, drift, validator, logger |
| test-workflow.js | 56 | Workflow parsing, hashing, drift, risk, normalization, lint |
| test-adversarial.js | 15 | Security edge cases, sneaky escalation, tamper detection |
| test-template.js | 75 | Template validation, lint, inputs, interpolation, env, hash |
| test-bucket1.js | 65 | Bucket 1 coverage: symlinks, file hash, TOCTOU, ReDoS, drift, widening, anti-interactive, cross-supervisor parity |
| test-bucket2.js | 61 | Bucket 2 coverage: rollback, idempotency, negotiation, delta engine, issue codes, escalation, cumulative drift |
| **Total** | **392** | |

Run: `npm test`
