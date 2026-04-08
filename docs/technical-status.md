# Guardrail — Technical Status & Roadmap

**Last updated:** 2026-04-07

---

## Architecture Overview

Guardrail is a Node.js CLI (zero dependencies) that enforces contract-locked execution for CLI commands, multi-step workflows, parameterized templates, and recipe-based executions. Every real execution is normalized or hashed, compared against an approved manifest, and either permitted or blocked.

```
src/
  cli.js                 Entry point, argument parsing, command routing
  contract.js            Contract creation, normalization, hashing, shell detection
  manifest.js            Manifest creation, persistence (atomic write), diff, comparison
  workflow.js            Workflow definition loading, validation, linting, normalization, hashing
  workflow-supervisor.js Workflow execution orchestrator (state machine, services, transitions)
  template.js            Template engine: load, validate, lint, interpolate, hash, explain, simulate
  template-supervisor.js Template execution supervisor with rollback support
  recipe-supervisor.js   Recipe approval, drift detection, manifest reuse, runtime policy wiring
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
  shared-manifest.js     Shared manifest sync, versioning, pin
  approval-queue.js      Approval queue, multi-stage chains, state machine
  org-policy.js          Org-wide policy engine, hierarchy resolution
  rbac.js                Role-based access control, 4 roles, 9 permissions
  key-management.js      AES-256-GCM encrypted key storage, scoped access
  notifications.js       Webhook/Slack/email/log notification adapters
  deployment-mode.js     local/team/enterprise mode config + feature flags
  compliance.js          JSON + CSV compliance exports, summary reports
  environment.js         dev/staging/prod isolation, cross-env enforcement
  marketplace.js         Recipe discovery, publishing, usage tracking
  incident-hooks.js      Incident response triggers + actions
  shared.js              Utilities (deep equality, atomic writes, env building, subprocess execution)
  recipe-runner.js       Recipe resolution by ID, input validation, dry-run orchestration
  recipe-install.js      Local registry management, install from path/URL, trusted sources
  verify.js              Self-verification checks (core imports, signing, safe defaults, risk)
  demo-scenarios.js      Demo pack: recipe, trust, blocked scenarios

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
  test-integration-runtime.js  Integration: runtime policy + audit wired into command/workflow/template/recipe supervisors
  test-recipe.js               Recipe packaging: schema, inputs, steps, guardrails, hash, pack/unpack
  test-recipe-system.js        Recipe system: categories, tags, index, channel, executor, dry-run
  test-bucket5.js              Bucket 5: resource bounds, learning, profiles, policy, metrics, identity
  test-bucket6.js              Bucket 6: shared manifests, approval queue, RBAC, keys, env, marketplace, incidents
  test-e2e.js                  E2E: recipe loading, dry-run, approval, scope, channel, strict mode, bounds, audit
  test-policy-scenarios.js     Declarative policy scenarios: risk classification, workflow risk, channel, strict mode
  test-golden-demos.js         Golden demo regressions: rm -rf, PR merge, dep upgrade, prod rollout, tamper, version swap
  test-adversarial-e2e.js      Adversarial e2e: path traversal, wildcards, destructive flags, agent bypass, schema bypass

  fixtures/e2e/                E2E fixture repos (5 environments with recipes and expected behaviors)
    git-safe-repo/             Read-only git status, verified, low risk
    git-dangerous-repo/        Force push, community, high risk
    package-upgrade-app/       Dep upgrade, verified, medium risk
    fake-prod-config/          Prod deploy, verified, high risk
    openclaw-wrapper-sim/      Agent-bounded edit, community, medium risk

docs/                    Product requirements, specs, invariants, implementation guides
.guardrail/              Runtime state (approved manifests, logs, state files)
```

**Stats:** ~14,500 lines of source, ~14,000 lines of tests, 957 passing tests, 0 dependencies.

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
| Environment handshake | Done | explicit caller allow-list required for any `requires_env`, secret pattern warnings |
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
| Recipe supervisor | Done | Manifest-backed approval, drift detection, non-interactive acknowledgement enforcement |
| Native executor | Done | Step-by-step execution with runtime guardrail enforcement (separate from template supervisor) |
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
| Safe defaults | Done | Dangerous pattern blocking, dry-run for high-risk, approval required for widening or production-like operations |
| Policy CLI commands | Done | `guardrail policy list/inspect/validate`; allowed actions, restricted scopes, required approvals |
| Metrics and events | Done | Structured JSONL events, per-type/actor/recipe aggregation, `guardrail metrics` |
| Agent identity and governance | Done | Actor/origin tracking, scoped permissions, audit-ready identity model |
| Agent strict mode | Done | Approved recipe list, scope enforcement, dynamic command blocking |

### Bucket 6 — Enterprise & Team Features

| Feature | Status | Notes |
|---------|--------|-------|
| Shared manifests | Done | Team-level recipe/policy/profile sync, versioned, pin, conflict detection |
| Approval queue | Done | Pending/approved/rejected/changes_requested state machine, persistence |
| Multi-stage approval | Done | Sequential chains (dev → lead → security), conditional routing |
| Org policy engine | Logic only | Hierarchy resolution logic exists; not wired into CLI enforcement path |
| RBAC | Logic only | 4 roles, 9 permissions, enforcement function — not wired into CLI or supervisor |
| Key management | Partial | AES-256-GCM client-side only; no HSM/KMS integration |
| Notifications | Stub | Webhook/Slack/email/log dispatch framework; all adapters are mocks (no HTTP/SMTP calls) |
| Deployment modes | Done | local/team/enterprise with per-mode feature flags |
| Compliance exports | Done | JSON + CSV export of audit logs, compliance summary reports |
| Environment separation | Done | dev/staging/prod isolation, cross-env access blocked (dev ✗ prod) |
| Marketplace | Done | Recipe discovery, publishing, version conflict detection, usage stats |
| Incident response hooks | Done | Trigger on violations/failures; alert/halt/escalate/log actions |

### Gap Closure — Pre-SaaS Readiness

| Feature | Status | Notes |
|---------|--------|-------|
| Recipe execution via CLI | Done | `guardrail run --recipe <id[@ver]> --input k=v [--dry-run]` |
| Recipe input validation | Done | Type coercion, pattern/enum/range checks, unknown input rejection |
| Recipe manifest reuse + drift | Done | Real execution uses `.guardrail/recipes/<id>.approved.json`; dry-run stays approval-free |
| Concurrency lock model | Done | Lock is per manifest hash; same approved execution is single-flight, different hashes can run concurrently |
| Recipe install (local) | Done | `guardrail recipe install <path>` to `~/.guardrail/recipes/` |
| Recipe install (remote) | Done | `guardrail recipe install <url>` with fail-closed trusted source enforcement |
| GitHub recipe distribution (`github://`, public publish flow) | Not started | Design only today — see `docs/github-recipe-distribution.md` |
| Adapter system (`adapter run`, profile install, shim flow) | Not started | Design only today — see `docs/adapter-implementation-plan.md` |
| Local recipe registry | Done | `~/.guardrail/recipes/`, duplicate/version conflict handling |
| Trusted source config | Done | `~/.guardrail/config.json` with `trusted_sources` array |
| Self-verification | Done | `guardrail verify` — 7 checks: modules, validation, signing, safe defaults, risk, dangerous, recipes |
| Demo: recipe | Done | `guardrail demo recipe` — dry-run, risk, guardrails |
| Demo: trust | Done | `guardrail demo trust` — verified vs community enforcement |
| Demo: blocked | Done | `guardrail demo blocked` — dangerous command blocking |
| Demo: list | Done | `guardrail demo list` — all available scenarios |
| Demo pack | Done | `/demos/` directory with shell scripts |

### Adversarial Testing

| Scenario | Status | Notes |
|----------|--------|-------|
| Sneaky allow-list inheritance | Tested | Secret env escalation detected |
| Fake success trap | Tested | failure-to-done caught at lint |
| Trojan horse step | Tested | Hidden secret in step 2 escalates to red |
| Lazy schema normalization | Tested | Partial envPolicy normalizes to full shape, hash stable |
| Silent tamper detection | Tested | Tampered manifest triggers drift in non-interactive mode |

---

## Remaining Gaps

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
| Bounded parameter approvals | Not started | High — schemas constrain values, but manifest reuse still binds to exact resolved inputs |
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
| Range-based recipe approvals | Not started | High — recipe inputs are schema-validated, but approval reuse is still exact-value based |
| Recipe execution via `guardrail run <recipe-id>` | Done | `run --recipe <id> --input k=v [--dry-run]` |
| Recipe install (local + remote) | Done | `recipe install <path\|url>` with trusted source config; remote install blocked when config is missing or unmatched |
| Recipe registry / remote publishing | Partial | Local registry done; remote publishing deferred to SaaS |

---

## Roadmap

### Phase 1 — Foundation

- [x] Core contract engine (Bucket 1 MVP)
- [x] Workflow engine (Bucket 2 MVP)
- [x] Template system (individual + workflow templates)
- [x] Adversarial test suite
- [x] Initial MVP closed; current full suite is 957 passing tests, 0 dependencies

### Phase 2 — Hardening

- [x] File provenance enforcement (fileHash SHA-256 verification)
- [x] Anti-interactive execution detection (stderr pattern scan)
- [x] Formal ReDoS regex rejection at manifest approval time
- [x] Bucket 1 test coverage requirements satisfied
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
- [x] Bucket 2 test coverage requirements satisfied

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
- [x] Bucket 3 test coverage requirements satisfied
- [x] Runtime policy wired into all 3 supervisors (time, locks, audit — covered by integration runtime suite)

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
- [x] Recipe system covered by dedicated recipe and gap-closure suites

### Phase 6 — Policy, UX, Adoption (Bucket 5)

- [x] Resource bounds (max_execution_time, max_files, max_network, max_cost + runtime tracker)
- [x] Learning mode (--learning: step/recipe/block explanations with risk, safety, and what-could-go-wrong)
- [x] Profiles (3 builtins: cautious-dev, fast-ci, prod-safe; profile create/use/list/show CLI)
- [x] Safe defaults (dangerous pattern blocking, dry-run for high-risk, approval required for widening or production-like operations)
- [x] Policy system (schema, CRUD, enforcement: allowed actions, restricted scopes, required approvals)
- [x] Metrics + events (structured JSONL, aggregation by type/actor/recipe, guardrail metrics CLI)
- [x] Agent identity + governance (actor/origin, scoped permissions, audit-ready)
- [x] Agent strict mode (approved recipe list, scope enforcement, dynamic command blocking)
- [x] Bucket 5 coverage satisfied

### Phase 7 — Enterprise (Bucket 6)

- [x] Shared manifests (sync, versioning, pin, conflict detection)
- [x] Approval queue + multi-stage chains (dev → lead → security)
- [x] Org policy engine (hierarchy: org > team > user, forbidden ops override — logic exists, not wired into CLI)
- [x] RBAC (admin/approver/developer/viewer, 9 permissions — enforcement logic exists, not wired into CLI/supervisor)
- [x] Key management (AES-256-GCM client-side encrypted, scoped access, redact — no HSM/KMS integration)
- [x] Notifications (webhook/slack/email/log adapters — dispatch framework only, all adapters are mocks)
- [x] Deployment modes (local/team/enterprise feature flags)
- [x] Compliance exports (JSON + CSV, summary reports)
- [x] Environment separation (dev/staging/prod isolation)
- [x] Marketplace (publish, version conflict detection, usage stats)
- [x] Incident response hooks (alert/halt/escalate/log on violations)
- [x] 54 Bucket 6 tests

### Phase 8 — Gap Closure (Pre-SaaS Readiness)

- [x] Recipe execution via CLI (`run --recipe <id[@ver]> --input k=v [--dry-run] [--allow-unverified]`)
- [x] Recipe input validation pipeline (type coercion, pattern/enum/range, unknown rejection)
- [x] Recipe supervisor: manifest-backed approval, drift detection, acknowledged-risk reuse in non-interactive mode
- [x] Recipe install from local path (`recipe install <path> [--overwrite]`)
- [x] Recipe install from URL (`recipe install <url>`) with fail-closed trusted source enforcement
- [x] Local recipe registry (`~/.guardrail/recipes/`, duplicate/version handling)
- [x] Trusted source configuration (`~/.guardrail/config.json` with `trusted_sources`)
- [x] Self-verification command (`guardrail verify [--json]` — 7 async checks)
- [x] Demo pack: 4 scenarios (drift, recipe, trust, blocked) + `demo list`
- [x] Demo shell scripts in `/demos/` directory
- [x] 28 gap closure tests
- [x] All 6 shipped recipes tested via dry-run: git-branch-cleanup, dep-upgrade, github-pr-merge, infra-deploy, npm-publish, openclaw-wrapper
- [x] Versioned recipe storage (`~/.guardrail/recipes/<id>/<version>.json`)
- [x] Version immutability (same version + different content → blocked)
- [x] Version resolution (`id@version` or latest)
- [x] `recipe versions <id>` CLI command
- [x] Runbook support (sequential multi-recipe execution with independent guardrails)
- [x] `buildVersionIndex()` for multi-version indexing
- [x] `deduplicateLatest()` for `list` command
- [x] Backward compatibility with legacy flat recipe files
- [x] 39 gap closure + versioning tests

---

## Product Roadmap — What to Build Next

Three product phases, each with its own go-to-market motion.

### Open Source Launch (ship with v1)

| # | Feature | Unlocks | Status |
|---|---------|---------|--------|
| 1 | `guardrail init` learning mode | Individual retention | In code (learning-mode.js), needs CLI init flow |
| 2 | Free tier definition + offline guarantee | Word of mouth | Architecture supports (0 deps, local-only mode) |

### Portability & Offboarding

| # | Feature | Unlocks | Status |
|---|---------|---------|--------|
| P1 | Manifests are plain JSON (no proprietary format) | Zero lock-in | Done — `.guardrail/*.approved.json`, human-readable, works without Guardrail |
| P2 | Audit logs are standard JSONL | Data portability | Done — NDJSON with hash-chaining, `guardrail audit export` via compliance.js |
| P3 | Recipes are portable JSON | Ecosystem independence | Done — self-contained with content hash, no registry dependency |
| P4 | Data deletion on request (30 days) | Enterprise trust | Not started — no cloud backend or account system exists yet; planned SaaS policy |

### Paid Tier — Team (v0.3)

| # | Feature | Unlocks | Status |
|---|---------|---------|--------|
| 3 | Shared manifest registry (encrypted at rest) | Team adoption | Local sync done (shared-manifest.js), needs backend |
| 4 | Team approval flows (multi-identity) | Team RED workflows | Logic done (approval-queue.js), needs backend persistence |
| 5 | Slack/email approval notifications | Team RED workflows | Mock adapters only (notifications.js), needs live integration |
| 6 | GitHub OAuth / Google Workspace SSO | Team login | Not started — zero auth code |
| 7 | Cloud audit log shipping (opt-in) | Team compliance | Not started — no Datadog/Splunk/CloudWatch code |
| 8 | Private recipe namespace | Business stickiness | Channel system is signature-based, needs org-scoped namespaces |
| 9 | Usage dashboard | Manager buy-in | Metrics collection done (metrics.js), needs UI |

### Enterprise (v0.4–v0.5)

| # | Feature | Target | Unlocks | Status |
|---|---------|--------|---------|--------|
| 10 | SAML 2.0 / SCIM provisioning | v0.4 | Enterprise IT approval | Not started — zero code |
| 11 | RBAC four roles, 9 permissions | v0.4 | Enterprise security review | Logic done (rbac.js), not wired into CLI/supervisor enforcement |
| 12 | Org-level policy inheritance | v0.4 | Security team governance | Logic done (org-policy.js), not wired into CLI enforcement |
| 13 | VPC / on-prem deployment | v0.5 | Regulated industries | Deployment modes done (deployment-mode.js), no Docker/Helm artifacts |
| 14 | Immutable audit log + compliance exports | v0.5 | Enterprise compliance | JSON/CSV export done (compliance.js), needs write-once storage backend |
| 15 | Cloud audit log shipping + retention | v0.5 | Enterprise compliance | Not started — no remote shipping code |
| 16 | HSM / KMS key management | v0.5 | Enterprise key governance | Client-side AES-256-GCM done (key-management.js), no HSM/AWS KMS integration |
| 17 | SOC 2 Type II certification | v0.5 | Large enterprise contracts | Compliance exports done, needs process + audit |

### Recipe Distribution (v0.2–v0.5)

| # | Feature | Target | Unlocks | Status |
|---|---------|--------|---------|--------|
| D0a | GitHub SHA-pinned install (`github://owner/repo/path@sha`) | v0.2 | Immutable community recipes | Not started — spec in docs/github-recipe-distribution.md. Fetches from GitHub, requires full commit pinning, stores remote metadata in `.pins/<version>.json`, and re-verifies source hash on run. |
| D0b | Recipe publish (`guardrail recipe publish`) | v0.2 | One-command community contribution | Not started — spec in docs/github-recipe-distribution.md. Lint → scrub metadata only → fork → PR against guardrail-dev/recipes. Shell manifests are rejected; RED is blocked from public registry. |
| D0c | Template → recipe bridge (`template create --from-manifest`, `template publish`, `template list`, trust hash comparison) | v0.2 | Local-first authoring flow | Not started — spec in docs/github-recipe-distribution.md. Templates live in `.guardrail/templates/`, become recipes via publish, and modified templates lose source trust via definition-hash comparison. |
| D1 | npm registry (`@guardrail/recipes`) | v0.3 | Developer ergonomics | Not started — convenience layer on top of GitHub repo, not a replacement. npm versions are immutable once published; content hash is stable. Requires publish pipeline. Ship after GitHub-based distribution is proven. |
| D2 | Self-hosted recipe registry (JSON API) | v0.5 | Enterprise air-gap | Not started — thin static API: `GET /v1/recipes`, `GET /v1/recipes/{category}/{name}`, `GET /v1/recipes/{category}/{name}/versions`. Simplest impl is S3+CloudFront or R2, write-once, no database. Becomes `registry.guardrail.dev`; enterprise customers run on-prem instances declared in org policy `trusted_registries`. |

### Adapter System (v0.2–v0.3)

| # | Feature | Target | Unlocks | Status |
|---|---------|--------|---------|--------|
| A0a | Rich command supervisor context | v0.2 | Stable agent/tool integrations | Not started — spec in docs/adapter-implementation-plan.md. `runSupervisor()` returns bounded worker output, drift diffs, reason, and telemetry instead of a minimal pass/fail summary. |
| A0b | `adapter-result/v1` translation layer + declarative profiles | v0.2 | Public open-source profile ecosystem | Not started — spec in docs/adapter-implementation-plan.md. Public profiles target a versioned schema, declare `schema_target`, and remain pure-data mappings. |
| A0c | Adapter CLI + Phase 1 protocols (`stdin-json`, `env-shim`) | v0.2 | OpenClaw/Aider integration | Not started — spec in docs/adapter-implementation-plan.md. `mcp` profiles are recognized but blocked until runtime support exists. |
| A0d | GitHub SHA-pinned adapter profile install | v0.2 | Safe public profile sharing | Not started — spec in docs/adapter-implementation-plan.md. Uses `github://owner/repo/path@sha`, trusted source enforcement, immutable installs, and `.pins/<version>.json` metadata. |
| A1 | Signed index + bare-name profile install | v0.3 | Discovery and easier onboarding | Not started — deferred until a signed index exists. Bare-name install should not ship before public-key verification is in place. |

---

## Verification & E2E Testing

### E2E Fixture Repos

Five fixture environments under `tests/fixtures/e2e/`, each with a recipe, known files, expected allowed/blocked scope, and expected risk level:

| Fixture | Category | Channel | Risk | Approval | Purpose |
|---------|----------|---------|------|----------|---------|
| git-safe-repo | git | verified | low | No | Read-only git status — baseline safe recipe |
| git-dangerous-repo | git | community | high | Yes | Force push — destructive, unverified |
| package-upgrade-app | packages | verified | medium | No | Dep upgrade within patch scope |
| fake-prod-config | infra | verified | high | Yes | Production config deploy |
| openclaw-wrapper-sim | openclaw | community | medium | No | Agent-bounded edit within src/ |

### Test Levels

| Level | File(s) | Count | What It Proves |
|-------|---------|-------|----------------|
| Schema/unit | test-core, test-recipe, test-bucket1-6 | 645 | Deterministic functions: hashing, validation, risk, approval, policy |
| Policy scenarios | test-policy-scenarios | 30 | Declarative policy → expected decision (GREEN/YELLOW/RED, channel, strict mode) |
| E2E integration | test-e2e | 42 | Full path: load recipe → validate → dry-run → scope check → channel → audit |
| Golden demos | test-golden-demos | 31 | Viral demo scenarios as regression tests (rm -rf, PR merge, prod rollout, tamper) |
| Adversarial | test-adversarial-e2e | 37 | Intentional breakage: path traversal, version swap, agent bypass, schema bypass |

### Must-Pass Acceptance Matrix

**Happy path:**
- [x] Can load a recipe from fixture
- [x] Can validate inputs against patterns and enums
- [x] Can show dry-run plan with resolved interpolation
- [x] Can request approval when needed (approval_required, computeDefaults)
- [x] Can block/allow based on channel enforcement
- [x] Can emit hash-chained audit trail

**Safety:**
- [x] Blocks out-of-scope file changes (checkScope)
- [x] Blocks dangerous commands (checkDangerous, checkSafeDefaults)
- [x] Blocks prod/destructive actions without approval (evaluateRisk → RED)
- [x] Blocks unverified recipes by default (enforceChannel)
- [x] Blocks agent drift in strict mode (createStrictMode)
- [x] Stops execution when resource bounds exceeded (createResourceTracker)

**Adversarial:**
- [x] Path traversal inputs blocked
- [x] Wildcard deletes blocked
- [x] Hidden destructive flags detected
- [x] Misleading recipe descriptions don't bypass dry-run
- [x] Agent outside approved recipe blocked
- [x] Recipe claiming dev but targeting prod → RED
- [x] Version swap (v1 approved, v2 content) detected via hash mismatch
- [x] Audit log tampering detected via chain verification

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
12. **Safe by default** — Dangerous patterns blocked, dry-run for high-risk, approval required for widening or production-like operations.
13. **Strict mode for agents** — Agents restricted to approved recipes and declared scope; dynamic commands blocked.
14. **Org policy overrides local** — Policy hierarchy: org > team > user. Forbidden operations accumulate; allowed actions restrict.
15. **Encrypted key storage** — AES-256-GCM with scoped access. Secrets never appear in logs (redact interface).

---

## CLI Command Reference

| Command | Status | Description |
|---------|--------|-------------|
| `run -- <cmd> [args]` | Done | Execute a command under contract |
| `run --shell "<script>"` | Done | Shell mode (explicit opt-in) |
| `run --template <path> --input k=v` | Done | Execute a parameterized template |
| `run --recipe <id> --input k=v [--dry-run]` | Done | Execute a recipe by ID |
| `workflow run --definition <path>` | Done | Execute a multi-step workflow |
| `workflow lint --definition <path>` | Done | Lint a workflow definition |
| `template lint\|explain\|schema\|simulate\|diff` | Done | Template inspection commands (5) |
| `list [--category\|--tag\|--search\|--risk\|--channel]` | Done | List and filter recipes |
| `create --name <n> --category <c>` | Done | Generate a recipe skeleton |
| `pack <recipe.json>` | Done | Package a recipe with content hash |
| `recipe validate <file>` | Done | Validate a recipe JSON |
| `recipe inspect <packed.json>` | Done | Inspect packed recipe, verify hash |
| `recipe install <path\|url> [--overwrite]` | Done | Install to versioned local registry |
| `recipe versions <id>` | Done | List installed versions of a recipe |
| `profile create\|use\|list\|show` | Done | Manage user profiles |
| `policy list\|inspect\|validate` | Done | Manage and enforce policies |
| `audit verify [--path]` | Done | Verify audit log chain integrity |
| `audit query [--trace-id\|--event\|--after\|--before]` | Done | Query audit log entries |
| `metrics [--path]` | Done | View execution metrics |
| `approve [list] [--id\|--reject]` | Done | Approval queue management |
| `marketplace [list]` | Done | Browse recipe marketplace |
| `export [--format\|--path\|--output]` | Done | Export audit/compliance data |
| `verify [--json]` | Done | Self-verification (7 checks) |
| `demo drift\|recipe\|trust\|blocked\|list` | Done | Built-in demo scenarios |

---

## Test Matrix

`npm test` is the source of truth for exact totals. The table below is a maintained map of the major suites and what they prove, not a promise that every per-file count stays frozen as new focused suites are added.

| Suite | Tests | Focus |
|-------|-------|-------|
| test-core.js | 95 | Contract, manifest, risk, approval, drift, validator, logger |
| test-workflow.js | 56 | Workflow parsing, hashing, drift, risk, normalization, lint |
| test-adversarial.js | 15 | Security edge cases, sneaky escalation, tamper detection |
| test-template.js | 75 | Template validation, lint, inputs, interpolation, env, hash |
| test-bucket1.js | 65 | Bucket 1 coverage: symlinks, file hash, TOCTOU, ReDoS, drift, widening, anti-interactive, cross-supervisor parity |
| test-bucket2.js | 61 | Bucket 2 coverage: rollback, idempotency, negotiation, delta engine, issue codes, escalation, cumulative drift |
| test-bucket3.js | 40 | Bucket 3 coverage: fingerprint, audit chain, tamper detection, time policy, counters, locks, I-A1/I-A2 |
| test-integration-runtime.js | 18 | Integration: runtime policy + audit wired into command/workflow/template/recipe supervisors end-to-end |
| test-recipe.js | 46 | Recipe packaging: schema validation, inputs, steps, guardrails, hashing, pack/unpack, recipe manifest semantics |
| test-recipe-system.js | 55 | Recipe system: categories, tags, index, fuzzy search, channel, executor, dry-run |
| test-bucket5.js | 49 | Bucket 5: resource bounds, learning mode, profiles, safe defaults, policy, metrics, identity, strict mode |
| test-bucket6.js | 54 | Bucket 6: shared manifests, approval queue, RBAC, key mgmt, env separation, marketplace, incidents |
| test-e2e.js | 42 | E2E: recipe loading from fixtures, input validation, dry-run plans, approval requirements, dangerous command blocking, scope enforcement, channel enforcement, strict mode, resource bounds, audit trail, safe defaults, hash integrity |
| test-policy-scenarios.js | 30 | Declarative policy scenarios: 20 risk classification (GREEN/YELLOW/RED), workflow risk, channel enforcement, strict mode, safe defaults decisions |
| test-golden-demos.js | 31 | Golden demo regressions: accidental rm -rf, broken PR bulk merge, dep upgrade major bump, infra rollout targeting prod, OpenClaw beyond scope, recipe tamper detection, version swap detection |
| test-adversarial-e2e.js | 37 | Adversarial e2e: path traversal (5 vectors), wildcard deletes, hidden destructive flags, misleading recipe descriptions, agent outside approved recipe, dev-targeting-prod, version swap attacks, audit log tampering, resource bounds exhaustion, schema bypass attempts |
| test-gap-closure.js | 43 | Gap closure: recipe runner, install, verify, demo scenarios, versioned storage, version resolution, runbook |
| test-feature-acceptance.js | 54 | README-derived acceptance coverage, including recipe non-interactive enforcement |
| test-input-validator.js | 91 | Shared input parsing, coercion, enum/range/pattern validation, exact-value approval edge cases |
| **Current runner total** | **957 tests / 211 suites** | Reported by `npm test`; use the command output as the canonical count |

Run: `npm test` (all 957), `npm run test:e2e` (verification/e2e/adversarial suites), `npm run test:core` (core unit/integration suites), `npm run test:acceptance` (54 feature acceptance tests)
