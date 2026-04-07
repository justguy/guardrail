# Guardrail — Technical Status & Roadmap

**Last updated:** 2026-04-07

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
  recipe.js              Recipe packaging: schema validation, parsing, hashing, pack/unpack
  recipe-index.js        Recipe indexing, category filtering, fuzzy search
  recipe-channel.js      Verified/community trust model, signature mock, enforcement
  recipe-executor.js     Native recipe execution, runtime guardrails, dry-run
  audit.js               Hash-chained audit log, chain verification, query surface
  fingerprint.js         Environment fingerprinting (OS, arch, hostname, Node version, env vars)
  runtime-policy.js      Time policy, counter persistence, concurrency locks
  resource-bounds.js     Resource constraint schema + runtime enforcement
  learning-mode.js       Step-by-step explanation engine
  profile.js             User/environment profiles with persistence
  safe-defaults.js       Global safe default policy layer
  policy.js              Policy schema, CRUD, enforcement
  metrics.js             Structured event tracking + aggregation
  identity.js            Agent identity model + strict mode
  shared.js              Utilities (deep equality, atomic writes, env building, subprocess execution)

recipes/
  npm-publish            Packages: build, test, publish NPM package (verified, high)
  git-branch-cleanup     Git: safe merged branch deletion with preview (verified, medium)
  github-pr-merge        GitHub: batch merge approved PRs with CI gating (verified, high)
  dep-upgrade            Packages: dependency upgrade within patch/minor scope (community, medium)
  infra-deploy           Infra: Terraform validate/plan/apply scoped to env (verified, high)
  openclaw-wrapper       OpenClaw: wrapped flow with scope enforcement (community, high)

tests/
  test-core.js                Contract, manifest, risk, approval, drift, validator, logger tests
  test-workflow.js             Workflow parsing, hashing, drift, risk, normalization, lint tests
  test-adversarial.js          Sneaky allow-list, fake success trap, trojan step, tamper detection
  test-template.js             Template validation, lint, inputs, interpolation, env, hash, manifest tests
  test-bucket1.js              Bucket 1 coverage: symlinks, file hash, TOCTOU, ReDoS, drift, widening
  test-bucket2.js              Bucket 2 coverage: rollback, idempotency, negotiation, delta, escalation
  test-bucket3.js              Bucket 3 coverage: fingerprint, audit chain, tamper, time policy, locks
  test-integration-runtime.js  Integration: runtime policy + audit wired into all 3 supervisors
  test-recipe.js               Recipe packaging: schema, inputs, steps, guardrails, hash, pack/unpack
  test-recipe-system.js        Recipe system: categories, tags, index, channel, executor, dry-run
  test-bucket5.js              Bucket 5: resource bounds, learning, profiles, policy, metrics, identity

docs/                    Product requirements, specs, invariants, implementation guides
.guardrail/              Runtime state (approved manifests, logs, state files)
```

**Stats:** ~11,400 lines of source, ~9,200 lines of tests, 591 passing tests, 0 dependencies.

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

### Bucket 3 — Audit, Observability, Runtime Integrity

| Feature | Status | Notes |
|---------|--------|-------|
| Environment fingerprinting | Done | OS, arch, hostname, Node version, env var names, cwd — included in audit entries |
| Secret detection (formal traits) | Done | `traits.handles_secrets` in risk evaluation result (I-A2) |
| Production-like target detection (formal traits) | Done | `traits.targets_production` in risk evaluation result (I-A2) |
| Time policy enforcement (I-A3) | Done | validUntil, allowedWindow, maxRuns, maxExecutionsPerMinute |
| Counter persistence | Done | Atomic read/increment/write, corrupt = fail closed, missing = initialize to 0 |
| Concurrency locks (I-A4) | Done | O_EXCL creation, TTL expiry, dead-PID reclaim, corrupt = fail closed |
| Hash-chained audit log (I-A5) | Done | NDJSON with prev_hash/entry_hash chain, fingerprint per entry |
| Tamper resistance | Done | Chain verification detects tampered/deleted/inserted entries |
| Audit query surface | Done | Filter by trace_id, manifest_hash, event, time range |
| Audit CLI commands | Done | `guardrail audit verify`, `guardrail audit query` with filters |
| Cryptographic separation (I-A1) | Done | Execution path (worker) cannot access signing/approval functions |
| Exit codes (20/21/22) | Done | time_policy_violated, concurrent_blocked, audit_chain_broken |

### Bucket 4 — Recipe System

| Feature | Status | Notes |
|---------|--------|-------|
| Recipe packaging | Done | JSON schema with id, name, version (semver), author, inputs, steps, guardrails, risk_level |
| Recipe categories | Done | 6 categories: git, github, infra, packages, openclaw, custom |
| Recipe tagging | Done | Multiple tags per recipe, filterable |
| Recipe indexing + fuzzy search | Done | Scan directories, filter by category/tag/risk/channel, fuzzy text search |
| Verified recipe channel | Done | Mock HMAC-SHA256 signatures, trust classification, enforcement |
| Channel enforcement | Done | Unverified blocked by default, `--allow-unverified` override |
| Static analysis | Done | 5 checks: structured mode, guardrails, risk, description, input constraints |
| Native executor | Done | Step-by-step execution with runtime guardrail enforcement |
| Dangerous command blocking | Done | rm -rf /, chmod 777, sudo rm, dd, mkfs, fork bomb detection |
| Scope restriction | Done | Path-based scope enforcement, blocks out-of-scope file access |
| Dry-run mode | Done | Full simulation: interpolation, danger check, scope check, no execution |
| Recipe authoring (`guardrail create`) | Done | Generates skeleton recipe from flags with risk warnings |
| Recipe packing | Done | `guardrail pack` produces versioned artifact with content hash |
| Recipe inspect | Done | `guardrail recipe inspect` verifies hash integrity, detects tampering |
| Local + remote recipe loading | Done | Filesystem + HTTP/HTTPS fetch + validate |
| CLI commands | Done | `guardrail list`, `guardrail create`, `guardrail pack`, `guardrail recipe validate/inspect` |
| Example recipes (6) | Done | npm-publish, git-branch-cleanup, github-pr-merge, dep-upgrade, infra-deploy, openclaw-wrapper |

### Bucket 5 — Policy, UX, Adoption

| Feature | Status | Notes |
|---------|--------|-------|
| Resource bounds | Done | max_execution_time, max_files_touched, max_network_calls, max_cost; runtime tracker with violations |
| Learning mode | Done | --learning flag: step/recipe/block explanations with risk context |
| Profiles | Done | cautious-dev, fast-ci, prod-safe builtins; `guardrail profile create/use/list/show` |
| Safe defaults | Done | Dangerous pattern blocking, dry-run for high-risk, --force with warnings |
| Policy CLI commands | Done | `guardrail policy list/inspect/validate`; allowed actions, restricted scopes, required approvals |
| Metrics and events | Done | Structured JSONL events, per-type/actor/recipe aggregation, `guardrail metrics` |
| Agent identity and governance | Done | Actor/origin tracking, scoped permissions, audit-ready identity model |
| Agent strict mode | Done | Approved recipe list, scope enforcement, dynamic command blocking |

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

### Bucket 3 Gaps

| Feature | Status | Priority |
|---------|--------|----------|
| Manifest cryptographic signing | Not started | Medium — entry_hash chain exists, but no external signature |
| Explainability UX for Bucket 3 blocks | Not started | Low — template explain exists, need generic block explanation |

### Bucket 4 Gaps

| Feature | Status | Priority |
|---------|--------|----------|
| Recipe execution via `guardrail run <recipe-id>` | Not started | Medium — executor exists, CLI wiring pending |
| Recipe registry / remote publishing | Not started | Medium — local pack/inspect done |
| Recipe versioning conflict detection | Not started | Low — hash immutability enforced, no registry dedup |

### Bucket 6 — Enterprise & Team Features

| Feature | Status | Priority |
|---------|--------|----------|
| Shared manifests | Not started | Future |
| Approval queue | Not started | Future |
| Org policy engine | Not started | Future |
| Identity and access control | Not started | Future |
| Centralized audit | Not started | Future |
| Hosted key management | Not started | Future |
| Notifications and integrations | Not started | Future |
| Deployment modes | Not started | Future |
| Compliance exports | Not started | Future |
| Multi-stage approval policies | Not started | Future |

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

### Phase 3 — Negotiation Engine

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

### Phase 4 — Observability & Audit

- [x] Environment fingerprinting (OS, arch, hostname, Node version, env var names, cwd)
- [x] Hash-chained audit log (I-A5) with prev_hash/entry_hash chain
- [x] Tamper resistance: chain verification detects tampered/deleted/inserted entries
- [x] Audit query surface: filter by trace_id, manifest_hash, event, time range
- [x] Audit CLI: `guardrail audit verify`, `guardrail audit query`
- [x] Time policy enforcement (I-A3): validUntil, allowedWindow, maxRuns, rate limiting
- [x] Counter persistence: atomic increment, corrupt=fail closed, missing=init to 0
- [x] Concurrency locks (I-A4): O_EXCL, TTL expiry, dead-PID reclaim
- [x] Cryptographic separation (I-A1): execution path cannot access signing functions
- [x] Risk traits (I-A2): handles_secrets, targets_production in evaluateRisk result
- [x] Bucket 3 test coverage requirements (40 tests)
- [x] Runtime policy wired into all 3 supervisors (time, locks, audit — 12 integration tests)

### Phase 5 — Recipe System & Distribution

- [x] Recipe packaging format (JSON schema, semver versioning, SHA-256 content hash)
- [x] Categories (6): git, github, infra, packages, openclaw, custom
- [x] Tagging: multiple tags per recipe, filterable
- [x] Recipe indexing + fuzzy search (directory scanning, relevance scoring)
- [x] Verified recipe channel (HMAC-SHA256 mock signatures, trust classification)
- [x] Channel enforcement (unverified blocked by default, --allow-unverified override)
- [x] Static analysis (5 checks: structured mode, guardrails, risk, description, inputs)
- [x] Native executor with runtime guardrails (dangerous command blocking, scope restriction)
- [x] Dry-run simulation (interpolation, danger/scope checks, no execution)
- [x] OpenClaw wrapper recipe (scope enforcement, output verification)
- [x] 6 example recipes: npm-publish, git-branch-cleanup, github-pr-merge, dep-upgrade, infra-deploy, openclaw-wrapper
- [x] CLI: `guardrail list`, `guardrail create`, `guardrail pack`, `guardrail recipe validate/inspect`
- [x] 98 recipe tests across 2 test files

### Phase 6 — Policy, UX, Adoption (Bucket 5)

- [x] Resource bounds (max_execution_time, max_files, max_network, max_cost + runtime tracker)
- [x] Learning mode (--learning: step/recipe/block explanations with risk, safety, and what-could-go-wrong)
- [x] Profiles (3 builtins: cautious-dev, fast-ci, prod-safe; profile create/use/list/show CLI)
- [x] Safe defaults (dangerous pattern blocking, dry-run for high-risk, --force with warnings)
- [x] Policy system (schema, CRUD, enforcement: allowed actions, restricted scopes, required approvals)
- [x] Metrics + events (structured JSONL, aggregation by type/actor/recipe, guardrail metrics CLI)
- [x] Agent identity + governance (actor/origin, scoped permissions, audit-ready)
- [x] Agent strict mode (approved recipe list, scope enforcement, dynamic command blocking)
- [x] 49 Bucket 5 tests

### Phase 7 — Enterprise (Bucket 6)

- [ ] Shared manifests + approval queue
- [ ] Org policy engine
- [ ] Multi-stage approval
- [ ] Centralized audit + compliance exports
- [ ] Identity and access control

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
10. **Verified channel default-deny** — Community recipes blocked unless explicitly opted in.
11. **Recipe immutability** — Content hash computed at pack time; tampered content detected on inspect.
12. **Safe by default** — Dangerous patterns blocked, dry-run for high-risk, approval for production. Override requires explicit --force.
13. **Strict mode for agents** — Agents restricted to approved recipes and declared scope; dynamic commands blocked.

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
| test-bucket3.js | 40 | Bucket 3 coverage: fingerprint, audit chain, tamper detection, time policy, counters, locks, I-A1/I-A2 |
| test-integration-runtime.js | 12 | Integration: runtime policy + audit wired into all 3 supervisors end-to-end |
| test-recipe.js | 43 | Recipe packaging: schema validation, inputs, steps, guardrails, hashing, pack/unpack |
| test-recipe-system.js | 55 | Recipe system: categories, tags, index, fuzzy search, channel, executor, dry-run |
| test-bucket5.js | 49 | Bucket 5: resource bounds, learning mode, profiles, safe defaults, policy, metrics, identity, strict mode |
| **Total** | **591** | |

Run: `npm test`
