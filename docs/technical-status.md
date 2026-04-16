# Guardrail — Technical Status & Roadmap

**Last updated:** 2026-04-16

Active open and deferred roadmap items are also mirrored into repo-local `llm-tracker` state at [`.llm-tracker/trackers/guardrail-roadmap.json`](../.llm-tracker/trackers/guardrail-roadmap.json). The technical status doc remains the fuller narrative source of truth; the tracker is the operational queue.

---

## Recent: Repo-local Claude raw-git hook (2026-04-16)

- Added a zero-dependency Claude `PreToolUse` hook in `src/claude-git-guardrail-hook.js` and wired the current checkout's `.claude/settings.local.json` to call it before Bash tool execution.
- The hook blocks raw `git push`, `git reset --hard`, `git clean -f/-fd`, `git branch -D`, `git checkout .`, and `git restore .` in this Guardian checkout before Claude executes them.
- Raw push attempts now redirect Claude toward the bounded `git-push` or `git-force-push-safe` Guardrail recipes with concrete invocation templates instead of letting the model mutate history or remotes directly.
- Worktree/history wipe commands remain intentionally unwrapped: the hook tells Claude there is no shipped bounded recipe for those destructive forms and that the operator must approve a reviewed alternative first.
- Added focused proof coverage in `tests/test-claude-git-guardrail-hook.js`, including direct detection, PreToolUse payload handling, and end-to-end script execution.
- Added a repo-root `AGENTS.md` with the same raw-git policy so Codex and other AGENTS-aware agents receive the same guardrail instructions even though they do not share Claude Code's `PreToolUse` hook surface.

---

## Recent: Pre-egress classification and scrubbing hooks (2026-04-12, P0g)

- New `src/egress-hooks.js` module: `classifyPayload()`, `runEgressHook()`, `validateEgressHookConfig()`.
- Hook produces structured `allow`/`block`/`redact` decisions with typed labels (`public`, `internal`, `confidential`, `restricted`) and machine-readable reasons.
- Wired into `adapter-engine.js` `runAdapter()` step 7a: runs when `profile.egress_hook.enabled` is true, before final return.
- Audit callback receives `event: egress_hook_result` with `outcome`, `label`, `reason`, `matched_fields`, `payload_hash`, and `sanitized_keys` — never the blocked or redacted payload content.
- `EGRESS_BLOCKED` added to `ADAPTER_REASON_CODES` in `adapter-result.js`.
- `egress_hook` added to `ALLOWED_TOP_LEVEL` in `adapter-profile.js`.
- 26 focused tests in `test-human-domain-routing.js` + 5 wiring tests in `test-adapter-runtime.js`. All 108 focused-proof tests pass (0 failures).
- Review fix applied after the first lane run: the egress hook now inspects parsed `process.stdout` JSON when available and rewrites the actual outgoing payload surface instead of a dead synthetic field.
- This is the hook seam. Production-grade scrubbing (NLP, ML classifiers, deep stdout parsing) is explicitly out of scope.

---

## Recent: Lane health protocol + runtime extension (2026-04-11)

- Resident lane daemon now separates `healthTimeoutMs` (default 300_000 ms) from `idleTimeoutMs` (default 900_000 ms).
- New soft `stalled` state surfaced via `lane status` when no activity for `healthTimeoutMs`; hard expiry still gated by `idleTimeoutMs`.
- Daemon observes a per-lane `control.json` every poll tick, so `guardrail lane extend --id <id> --idle-timeout-ms N --health-timeout-ms N [--heartbeat]` updates take effect on the running lane without restart.
- Heartbeat path (`--heartbeat`) refreshes activity and clears `stalled` without faking a final request completion.
- Pure `evaluateLaneHealth()` helper drives both the live loop and focused tests (`tests/test-lane-health.js`).

---

## Architecture Overview

Guardrail is a Node.js CLI (zero dependencies) that enforces contract-locked execution for CLI commands, multi-step workflows, parameterized templates, and recipe-based executions. Every real execution is normalized or hashed, compared against an approved manifest, and either permitted or blocked.

```
src/
  cli.js                 Thin entry point + top-level dispatch
  cli/                   Extracted CLI parsing, usage, helpers, and command-family handlers
  contract.js            Contract creation, normalization, hashing, shell detection
  manifest.js            Manifest creation, persistence (atomic write), diff, comparison
  workflow.js            Workflow definition loading, validation, linting, normalization, hashing, recipe_ref pinning
  workflow-supervisor.js Workflow execution orchestrator (state machine, services, transitions, recipe_ref dispatch)
  template.js            Template engine: load, validate, lint, interpolate, hash, explain, simulate
  template-supervisor.js Template execution supervisor with rollback support
  recipe-supervisor.js   Recipe approval, drift detection, manifest reuse, runtime policy wiring
  prompt-inputs.js       Prompt payload assembly + prompt-bearing file content hashing helpers
  codex-exec-wrapper.js  Structured wrapper for codex exec with prompt/input_files support
  claude-exec-wrapper.js Structured wrapper for claude --print with prompt/input_files support
  git-commit-wrapper.js  Structured wrapper for exact-path staging plus git commit from a message file
  git-commit-amend-wrapper.js  Structured wrapper for bounded HEAD amendment with expected-head validation
  git-force-push-safe-wrapper.js  Structured wrapper for lease-bound force push with explicit remote/OID preconditions
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
  lane/                  Extracted resident-lane business logic: control, health, maintenance, query, runtime orchestration
  shared.js              Utilities (deep equality, atomic writes, env building, subprocess execution)
  recipe-runner.js       Recipe resolution by ID, input validation, dry-run orchestration
  recipe-install.js      Local registry, install from path/URL/github://, SHA pinning, trusted sources
  recipe-publish.js      Recipe publish: manifest→recipe, personal data scrub, gh CLI PR flow
  adapter-extract.js     Safe field extraction via allowlisted JSONPath subset
  adapter-profile.js     Adapter profile validation, loading, version selection, hashing
  adapter-engine.js      Adapter orchestration: extract → auth preflight → supervisor → normalize → render
  adapter-auth.js        Adapter auth preflight: requires_env mapping + bounded CLI auth checks
  adapter-stdin.js       stdin-json protocol handler, bounded input parsing
  adapter-shim.js        env-shim protocol: PATH shim create/remove/list/install-path
  adapter-cli.js         Adapter subcommand parsing and routing
  adapter-profile-install.js  Adapter profile install from path/URL/github://
  adapter-profiles/      Bundled profiles: openclaw (stdin-json), aider (env-shim), cline (mcp/blocked)
  adapter-result.js      Adapter-result/v1 reason codes, status-to-code mapping, shape validator, blocked/failed builders
  agent-session.js       Bounded agent session contract model, canonical hashing, atomic load/save, slot sanitization
  agent-session-lifecycle.js  Pure lifecycle evaluation: start / continue / attach → ok or fail-closed code
  agent-session-enforce.js    Recipe-supervisor glue: resolve enforcement tool, build candidate, prepare gate, persist after success
  openclaw-task-wrapper.js  Dedicated OpenClaw task wrapper (fix-tests/debug-ci): bound flow+scope execution and verification
  verify.js              Self-verification checks (core imports, signing, safe defaults, risk)
  demo-scenarios.js      Demo pack: recipe, trust, blocked scenarios

recipes/
  npm-publish            Packages: build, test, publish NPM package (verified, high)
  git-branch-cleanup     Git: safe merged branch deletion with preview (verified, medium)
  git-commit             Git: exact-path staging plus commit from a hashed message file (community, medium)
  github-pr-merge        GitHub: batch merge approved PRs with CI gating (verified, high)
  dep-upgrade            Packages: dependency upgrade within patch/minor scope (community, medium)
  infra-deploy           Infra: Terraform validate/plan/apply scoped to env (verified, high)
  openclaw-wrapper       OpenClaw: wrapped flow with scope enforcement (community, high)
  openclaw-fix-tests     OpenClaw: fixed fix-tests task flow (write scope)
  openclaw-debug-ci      OpenClaw: fixed debug-ci task flow (read scope)
  git-commit-amend       Git: bounded HEAD amendment with expected_head and approved message file
  git-force-push-safe    Git: lease-bound force push with explicit local/remote OID checks
  codex-exec             Custom: structured Codex wrapper with input_files prompt context, lifecycle-bound session contract, and host-boundary warning (community, high)
  claude-exec            Custom: structured Claude wrapper with input_files, cwd, tools, budget, lifecycle-bound session contract, and host-boundary warning (community, medium)
  cmux-claude-exec       Custom: explicit terminal-orchestration wrapper that composes the bundled claude-exec contract into one approval, executes it in a fresh cmux workspace, and captures pane state (community, high)

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
  test-agent-session.js        Pure session-contract helper coverage: build, hash, diff, compare, lifecycle evaluation, slot sanitization, atomic load/save
  test-agent-session-supervisor.js  Supervisor-level session-contract enforcement: session_missing, drift, attach mismatch, review_each_time parity
  test-adapter-install.js      Adapter profile install: local/URL/github:// paths, trusted sources, immutability, pin metadata, bundled-profile round-trip
  test-adapter-runtime.js      Adapter runtime proof: bundled profile inventory, openclaw/aider render parity, MCP-gate blocked result, shim helpers, stdin protocol limits

  fixtures/e2e/                E2E fixture repos (5 environments with recipes and expected behaviors)
    git-safe-repo/             Read-only git status, verified, low risk
    git-dangerous-repo/        Force push, community, high risk
    package-upgrade-app/       Dep upgrade, verified, medium risk
    fake-prod-config/          Prod deploy, verified, high risk
    openclaw-wrapper-sim/      Agent-bounded edit, community, medium risk

docs/                    Product requirements, specs, invariants, implementation guides
.guardrail/              Runtime state (approved manifests, logs, state files)
```

**Stats:** ~15,500 lines of source, ~16,000 lines of tests, 0 dependencies. Use `npm test` for the current passing count. The refactor business-logic gate is now `npm run test:coverage:business`, which enforces `>90%` line coverage on the decision-heavy modules instead of process-plumbing code.

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
| Workflow normalization | Done | Sorted steps/services, default envPolicy, path resolution, idempotent defaults, `recipe_ref` resolution/pinning |
| Workflow hashing | Done | SHA-256 of canonical serialized workflow (includes rollback + rollback_policy) |
| Workflow manifest (v2) | Done | Includes rollback section, rollback_policy, idempotent flags |
| Workflow drift detection | Done | Step/service/transition/rollback-level diffing, including `recipe_ref` version/hash/input-hash changes |
| Workflow execution | Done | State machine with step dispatch, service lifecycle, and native `recipe_ref` execution |
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
| CLI (workflow run, workflow lint) | Done | Full approval flow, fatal lint errors block approval, optional `--recipe-search-dir` for cross-repo `recipe_ref` resolution |

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
| Workflow recipe chaining | Done | `recipe_ref` workflow steps let one workflow approval cover multiple bounded recipe executions |
| Dangerous command blocking | Done | rm -rf /, chmod 777, sudo rm, dd, mkfs, fork bomb detection |
| Scope restriction | Done | Path-based scope enforcement, blocks out-of-scope file access |
| Dry-run mode | Done | Full simulation: interpolation, danger check, scope check, no execution |
| Recipe authoring (`guardrail create`) | Done | Generates skeleton recipe from flags with risk warnings |
| Recipe packing | Done | `guardrail pack` produces versioned artifact with content hash |
| Recipe inspect | Done | `guardrail recipe inspect` verifies hash integrity, detects tampering |
| Local + remote recipe loading | Done | Filesystem + HTTP/HTTPS fetch + validate |
| CLI commands | Done | `guardrail list`, `guardrail create`, `guardrail pack`, `guardrail recipe validate/inspect` |
| Bundled recipes | Done | npm-publish, npm-install, pip-install, git-branch-cleanup, git-push, git-commit, git-commit-amend, git-force-push-safe, github-pr-merge, dep-upgrade, infra-deploy, openclaw-wrapper, openclaw-fix-tests, openclaw-debug-ci, openclaw-deploy, codex-exec, claude-exec, cmux-claude-exec. Recent public/community additions are wrapper-backed `npm-install`, `pip-install`, `git-push`, `git-commit-amend`, `git-force-push-safe`, and the OpenClaw task recipes. `claude-exec` is now explicitly deprecated as a compatibility-only one-shot Claude surface; resident FIFO lanes are the primary Guardrail-managed Claude path. Secret mutation and destructive cloud/account-wide deploy variants remain intentionally outside the public shipped set. |

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
| Org policy engine | Logic only | Hierarchy resolution logic exists; enforcement wiring, simulation, and decision-trace work are folded into enterprise items 12 and 29 |
| RBAC | Logic only | 4 roles, 9 permissions exist; enforcement wiring and delegated-admin semantics are folded into enterprise items 11, 18, and 29 |
| Key management | Partial | AES-256-GCM client-side only; enterprise custody, secret-handle UX, and dynamic injection work are folded into enterprise items 25 and 31 |
| Notifications | Stub | Webhook/Slack/email/log dispatch framework exists; production delivery, event-bus wiring, and enterprise connectors are folded into enterprise items 23, 28, and 36 |
| Deployment modes | Done | local/team/enterprise with per-mode feature flags |
| Compliance exports | Done | JSON + CSV export of audit logs, compliance summary reports |
| Environment separation | Done | dev/staging/prod isolation, cross-env access blocked (dev ✗ prod) |
| Marketplace | Done | Recipe discovery, publishing, version conflict detection, usage stats |
| Incident response hooks | Done | Trigger on violations/failures; alert/halt/escalate/log actions |
| Identity & admin lifecycle | Designed | Approval queue, multi-stage chains, org policy hierarchy, actor/origin tracking, and RBAC logic exist; SSO/SCIM, delegated admin, service accounts, and org/workspace admin surfaces are not yet operational |
| Reliability & production operations | Designed | Hash-chained audit, runtime time/quota policy, locks, incident hooks, and compliance exports exist; HA/DR, backup/restore, failover, and SLO/ops automation still need backend infrastructure |
| Deployment flexibility & control | Designed | Deployment modes, self-hosted registries, trusted registries/indexes, and local-first runtime seams exist; private VPC, single-tenant, regional, and on-prem packaging are not yet shipped |
| Cost governance / FinOps | Designed | `max_cost`, time/rate/run caps, resource tracking, and recipe-level AI budget inputs exist; org quotas, chargeback, and provider-backed spend tripwires are not yet wired |
| Enterprise integrations & operational fit | Designed | Notifications, compliance exports, GitHub/private distribution, adapters, and CLI surfaces exist; SIEM, IdP, ticketing, webhook, and admin API integrations still need production connectors |

### Gap Closure — Pre-SaaS Readiness

| Feature | Status | Notes |
|---------|--------|-------|
| Recipe execution via CLI | Done | `guardrail run --recipe <id[@ver]> --input k=v [--dry-run]` |
| Recipe input validation | Done | Type coercion, pattern/enum/range checks, unknown input rejection |
| Recipe manifest reuse + drift | Done | Real execution uses `.guardrail/recipes/<id>.approved.json`; dry-run stays approval-free |
| Concurrency lock model | Done | Lock is per manifest hash; same approved execution is single-flight, different hashes can run concurrently |
| Recipe install (local) | Done | `guardrail recipe install <path>` to `~/.guardrail/recipes/` |
| Recipe install (remote) | Done | `guardrail recipe install <url>` with fail-closed trusted source enforcement |
| GitHub recipe distribution (`github://`, public publish flow) | Done | SHA-pinned install, `.pins/<version>.json` metadata, publish dry-run/PR flow |
| Adapter system (`adapter run`, profile install, shim flow) | Done | Core adapter runtime is live: declarative profiles, `adapter-result/v1` normalization with a stable `code` field and reason-code table, `adapter run`, `adapter shim`, `adapter profile install`, auth preflight, bundled `openclaw` / `aider` / `cline` profiles, bounded MCP discovery/call/batch support, bounded MCP routing through `adapter run` via `--mcp-tool` / `--calls-json`, safe-name enforcement on shim creation, structured `INPUT_READ_FAILED`/`INPUT_TOO_LARGE`/`INVALID_JSON` stdin errors, and parity tests for the full supervisor→adapter normalization surface. Shell-style MCP execution remains intentionally blocked. |
| Agent session contracts (`A0g`) | Done | `claude-exec` and `codex-exec` recipes take `lifecycle` (`start` / `continue` / `attach`), `session_name`, and `session_id` inputs. Recipe supervisor enforces a bounded session contract at `<projectRoot>/.guardrail/agent-sessions/<recipeId>/<slot>.json` with `session_missing`, `session_drift`, `session_attach_mismatch`, and `session_already_exists` fail-closed reasons. Prompt inputs keep `review_each_time` reapproval semantics; session contracts do not short-circuit prompt reapproval. Wrappers emit structured `[guardrail-session]` metadata to stderr before spawning the underlying CLI; no `~/.claude/*` or `~/.codex/*` scraping. |
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
| Lazy schema normalization | Tested | envPolicy normalizes to the full explicit shape and remains hash-stable |
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
| Workflow helper-script gap | Done | High — workflow step producers are now the native `task` and `recipe_ref` types, both with typed shared-state outputs and manifest-bound handoff. No helper-script-only producer path remains in the shipped workflow surface. |

### Template System Gaps

| Feature | Status | Priority |
|---------|--------|----------|
| Bounded parameter approvals | Done | High — template reuse supports enum, integer-range, and bounded-list approval envelopes for deterministic inputs. Unsupported or ambiguous schemas intentionally stay exact-match rather than widening the approval model. |
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
| Range-based recipe approvals | Done | High — recipe reuse now supports deterministic schema-constrained enum, integer-range, and bounded-list envelopes while preserving `review_each_time`, `never_reuse`, and `content_hash` hard boundaries. |
| Recipe execution via `guardrail run <recipe-id>` | Done | `run --recipe <id> --input k=v [--dry-run]` |
| Recipe install (local + remote) | Done | `recipe install <path\|url\|github://...@sha>` with trusted source config; GitHub installs support authenticated fallback for private repos |
| Recipe registry / remote publishing | Done | Local registry plus GitHub-backed community publish/install; broader hosted registry remains deferred to SaaS |

---

## Roadmap

### Phase 1 — Foundation

- [x] Core contract engine (Bucket 1 MVP)
- [x] Workflow engine (Bucket 2 MVP)
- [x] Template system (individual + workflow templates)
- [x] Adversarial test suite
- [x] Initial MVP closed; current full suite passes with 0 dependencies

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
- [x] Recipe install from GitHub (`recipe install github://owner/repo/path@sha`) with `.pins/` metadata and authenticated fallback for private repos
- [x] Recipe publish (`recipe publish --name <n> --category <c> [--manifest <path>] [--dry-run]`)
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

### Phase 9 — Codex-Inspired Extensions (2026-04-11)

Derived from a targeted review of `openai/codex` (Rust). Each item has a concrete Guardrail-local target — these are not forklifts of Codex architecture.

- [ ] **Tiered approval decisions** (highest leverage). Extend `policy-engine.js` and `recipe-supervisor.js` approval surface beyond binary approve/deny to emit a third outcome: a proposed *manifest amendment* the user can accept to convert a one-off approval into a durable rule (e.g., widen allowed-args prefix, add session-scoped allow). Reference: `codex-rs/protocol/src/approvals.rs` — `ExecApprovalRequestEvent.proposed_execpolicy_amendment`, `available_decisions`. Persistence path already exists via manifest updates + approval queue.
- [ ] **External lane event stream, separate from audit log**. Append-only `<laneDir>/events.ndjson` written by the daemon on state transitions (`health_stall`, `health_clear`, `request_queued`, `request_started`, `request_completed`, `timeout_extended`, `heartbeat`). Consumers `tail -f | jq` for live status; audit log stays immutable hash-chained record-of-truth. Hook into the existing `evaluateLaneHealth` dispatch site in `src/resident-lane-core.js`. Reference: `codex-rs/protocol/src/protocol.rs` EventMsg variants.
- [ ] **Guardrail MCP server** (`src/mcp-server.js`, zero new deps, stdio JSON-RPC). Surface tools: `lane_status`, `lane_send`, `lane_extend`, `lane_stop`, `recipe_run`, `recipe_list`, `audit_query`. Surface resources: `lane://<id>`, `audit://<range>`, `manifest://<id>`. Lets any MCP-aware agent (Claude Code, Cursor, etc.) drive Guardrail without shelling. Reference: `codex-rs/mcp-server/src/message_processor.rs`.

Explicitly *not* in this phase (reviewed and rejected as poor fit):
- Full rollout/replay JSONL as primary state store — our snapshot + manifest + audit chain covers resumability; event-sourcing everything doubles write path for marginal gain.
- seatbelt/landlock-style OS sandbox policies — wrong layer (we enforce contracts, not syscalls).

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
| P4 | Data deletion on request (30 days) | Enterprise trust | Not started — no cloud backend or account system exists yet; folded into enterprise item 37 for full subject-access/deletion workflow coverage |

### Paid Tier — Team (v0.3)

| # | Feature | Unlocks | Status |
|---|---------|---------|--------|
| 3 | Shared manifest registry (encrypted at rest) | Team adoption | Local sync done (shared-manifest.js); hosted registry/persistence work is folded into enterprise item 26 |
| 4 | Team approval flows (multi-identity) | Team RED workflows | Logic done (approval-queue.js); hosted identity/admin and centralized authorization work are folded into enterprise items 18 and 29 |
| 5 | Slack/email approval notifications | Team RED workflows | Mock adapters only (notifications.js); live delivery and integration work are folded into enterprise items 23, 28, and 36 |
| 6 | GitHub OAuth / Google Workspace SSO | Team login | Not started — zero auth code; folded into enterprise item 18 |
| 7 | Cloud audit log shipping (opt-in) | Team compliance | Not started — no Datadog/Splunk/CloudWatch code; folded into enterprise items 15, 28, and 36 |
| 8 | Private recipe namespace | Business stickiness | Channel system is signature-based; org/workspace and tenant-scoped namespace work is folded into enterprise items 18 and 26 |
| 9 | Usage dashboard | Manager buy-in | Metrics collection done (metrics.js); enterprise event-spine/dashboard work is folded into enterprise items 28 and P2 maturity |

### Enterprise (v0.4–v0.5)

| # | Feature | Target | Unlocks | Status |
|---|---------|--------|---------|--------|
| 10 | SAML 2.0 / SCIM provisioning | v0.4 | Enterprise IT approval | Not started — zero code |
| 11 | RBAC four roles, 9 permissions | v0.4 | Enterprise security review | Logic done (rbac.js); enforcement wiring is folded into enterprise items 18 and 29 |
| 12 | Org-level policy inheritance | v0.4 | Security team governance | Logic done (org-policy.js); enforcement, simulation, and decision-trace work are folded into enterprise item 29 |
| 13 | VPC / on-prem deployment | v0.5 | Regulated industries | Deployment modes done (deployment-mode.js), no Docker/Helm artifacts |
| 14 | Immutable audit log + compliance exports | v0.5 | Enterprise compliance | JSON/CSV export done (compliance.js), needs write-once storage backend |
| 15 | Cloud audit log shipping + retention | v0.5 | Enterprise compliance | Not started — no remote shipping code; delivery and schema work are folded into enterprise items 28 and 36 |
| 16 | HSM / KMS key management | v0.5 | Enterprise key governance | Client-side AES-256-GCM done (key-management.js); external custody and secret-governance work are folded into enterprise items 25 and 31 |
| 17 | SOC 2 Type II certification | v0.5 | Large enterprise contracts | Compliance exports done, needs process + audit |
| 18 | Org/workspace lifecycle, delegated admin, and service accounts | v0.5 | Enterprise rollout governance | Designed — approval queue, actor/origin governance, org policy hierarchy, and RBAC logic exist; needs SSO/OIDC/SAML, SCIM, delegated-admin APIs/UI, service-account credentials, and org/workspace persistence |
| 19 | HA/DR, backups, restore, failover, and SLOs | v0.5 | Production operations | Designed — local audit/state, runtime locks/timeouts, incident hooks, and compliance exports exist; needs replicated backend state, backup/restore orchestration, failover handling, and ops telemetry |
| 20 | Spend governance / FinOps / chargeback | v0.5 | Runaway-cost protection | Designed — `max_cost`, `maxRuns`, rate limits, runtime counters, and recipe-level model budgets exist; needs org/project quotas, provider cost ingestion, chargeback, and billing-backed budget tripwires |
| 21 | Private VPC / single-tenant / on-prem / regional deployment | v0.5 | Regulated buyer deployment control | Designed — deployment modes, self-hosted registry/export flows, trusted registries/indexes, and local-first execution seams exist; needs packaging/orchestration artifacts, network topology controls, and regional control-plane choices |
| 22 | BYOM / enterprise model endpoint control | v0.5 | Data governance and private-model adoption | Designed — adapter/profile abstraction plus recipe/runtime model/profile flags create the seam; needs endpoint registry, credential injection, policy enforcement, and deployment packaging for private model backends |
| 23 | Operational integrations (SIEM, IdP, ticketing, SCM/webhooks/API) | v0.5 | Fit into existing enterprise workflows | Designed — audit exports, notifications framework, private GitHub flows, adapter system, and CLI surfaces exist; needs production connectors, webhook delivery, public admin APIs, and SIEM/ticketing integrations |
| 24 | Sovereign audit/event records, retention classes, and legal-hold metadata | v0.5 | eDiscovery, immutable retention, and defensible exports | Designed — hash-chained audit, compliance export, actor/origin metadata, and org-policy seams exist; hosted control-plane persistence still needs first-class `organization_id` / `workspace_id`, `retention_class`, payload-hash metadata, legal-hold state, and write-once storage integration |
| 25 | Enterprise crypto abstraction + external KMS/Vault custody | v0.5 | Key rotation, tenant-scoped encryption, dynamic secret brokering | Designed — all local secret storage already routes through `key-management.js`, scoped access checks, and redaction helpers; still needs external KMS/Vault/HSM integration, rotation orchestration, envelope-key policy, and execution-time secret injection/revocation |
| 26 | Tenant-scoped hosted control plane and noisy-neighbor isolation | v0.5 | Multi-tenant scale without cross-tenant interference | Designed — shared manifests, org policy, approval queue, runtime counters/locks, and deployment modes provide the local seam; hosted mode still needs tenant-prefixed persistence/paths, per-tenant queues or scheduler isolation, quota partitions, and version-skew controls |
| 27 | Model gateway, model governance, and pre-egress scrubbing | v0.5 | Enterprise AI policy, BYOM, and data-governance assurance | Designed — adapter/profile abstraction, runtime model/profile flags, `max_cost`, recipe model budgets, and human-domain routing helpers provide the seam; still needs a central model gateway, provider allowlists, fallback/retention policy, token accounting, and PII/secret scrubbing before external egress |
| 28 | Event bus and enterprise integration spine | v0.5 | Billing, SIEM, ticketing, admin APIs, and operational automation | Designed — audit logs, metrics, notifications, incident hooks, compliance exports, and CLI surfaces already emit the local event vocabulary; still needs a durable event bus, delivery guarantees, public admin APIs, and production connectors for billing/observability/workflow systems |
| 29 | Central authorization seam, policy simulation, and decision traces | v0.5 | Cedar/OPA-ready enforcement and explainable enterprise policy | Done — `src/authorization.js` is the universal `authorize(action, facts)` seam for all execution paths. `src/policy-simulate.js` adds `simulatePolicy(context)` for dry-run evaluation and `guardrail policy simulate` CLI surface. Both paths return the same normalized `{ allowed, decision, code, reason, trace }` shape. Decision traces carry structured `matched_rules` array identifying which risk-engine rules and policy rules drove the result. |
| 30 | Break-glass controls, revocation, and emergency kill switch | v0.5 | Contain compromised automation and satisfy enterprise incident response | Done — P0h landed single-target lane/session emergency controls; `30a` added repo/workspace-scoped `lane revoke --all` / `lane kill --all`; `30b` added active-profile-backed RBAC gating (`operator_role` + admin-only `emergency_control`) with audited deny/allow paths; `30c` added key revocation distinct from rotation via `createKeyStore().revoke()`, `guardrail key revoke`, distinct `key_revoked` incident events, and fail-closed reads on revoked keys. |
| 31 | Secret-handle UX, write-only inputs, and access audit | v0.5 | Safe secret mutation, runtime injection, and enterprise secret governance | Designed — `key-management.js`, redaction helpers, env allowlists, and runtime guardrails already exist; still needs write-only secret inputs, secret-handle references, execution-time injection/revocation, and explicit audit trails for secret access and mutation |
| 32 | Data classification, sensitivity labels, and egress labeling | v0.5 | PII/proprietary-data governance across models, exports, and operators | Designed — model/profile seams, compliance exports, org policy hooks, and human-domain routing helpers already exist; still needs sensitivity labels on prompts/artifacts/events, classification-aware egress policy, export labeling, and scrubber policy integration |
| 33 | Hosted state snapshots, replay, and migration tooling | v0.5 | Operable long-lived hosted control plane and safe version upgrades | Designed — local audit/state, export flows, lane portfolio history, and runtime state files already exist; still needs snapshot/rehydration, event replay, schema migration, and rollback-safe hosted upgrade tooling |
| 34 | Queue admission control and tenant fairness | v0.5 | Multi-tenant SLOs and noisy-neighbor protection | Designed — runtime counters/locks, lane/resource coordination, and deployment modes already exist; still needs tenant/workspace quotas, admission control, fair scheduling, starvation prevention, and queue telemetry |
| 35 | Policy rollout management and safe rollback | v0.5 | Enterprise policy evolution without accidental lockouts | Designed — policy objects, org hierarchy, and approval surfaces already exist; still needs versioned policy bundles, canary rollout, rollback, and dry-run impact analysis against existing traces |
| 36 | Versioned admin/event APIs and read-access auditing | v0.5 | Durable enterprise integrations and forensic visibility | Done — event schema v1 is documented in `docs/event-schema-v1.md`; read/export CLI surfaces emit `audit_queried`, `metrics_read`, and `compliance_exported`; admin mutation surfaces emit `recipe_installed`, `deploy_mode_changed`, and `key_rotated`; JSON read/export responses are versioned with a stable `{ schema_version, data }` envelope. Proof: `REPORT_v36a_access_read_audit_emission.md`, `REPORT_v36b_admin_event_emission.md`, `REPORT_v36c_versioned_api_contract.md`. |
| 37 | DSAR / subject-access / deletion workflows | v0.5 | Privacy and customer data-rights operations | Designed — portability exports, planned deletion policy, and audit/compliance surfaces already exist; still needs subject access export flows, deletion orchestration, hold exceptions, and hosted account/data identity plumbing |
| 38 | Supply-chain attestations, SBOMs, and provenance packs | v0.5 | Procurement trust and regulated-enterprise security reviews | Designed — trusted sources, signed indexes, content hashing, and self-verification already exist; still needs SBOM generation, artifact attestations, provenance bundles, and enterprise evidence-pack tooling |

### Enterprise Adoption Requirements (Designed Seams, Pending Operationalization)

| Theme | Already in the system | What still needs time/funding |
|-------|------------------------|-------------------------------|
| Identity and admin lifecycle | Approval queue + multi-stage chains, org policy hierarchy, RBAC logic, actor/origin governance, shared manifests | SSO/SAML/OIDC, SCIM, delegated admin, service accounts, org/workspace directory model, hosted persistence |
| Reliability and production operations | Hash-chained audit, runtime time/quota policy, concurrency locks, incident hooks, compliance exports | HA/DR, backups, restore tooling, failover, SLOs, remote ops/state backends |
| Deployment flexibility and control | Deployment modes, local-first execution, self-hosted recipe registry/export flows, trusted registries/indexes | Private VPC, single-tenant packaging, regional deployment, on-prem/air-gapped artifacts, enterprise deployment automation |
| Cost governance / FinOps | `max_cost`, max-runs, rate limits, runtime counters, recipe-level model budgets | Provider spend ingestion, org/project quotas, chargeback, billing-backed budget tripwires, FinOps dashboards |
| Integrations and operational fit | Notifications abstraction, compliance exports, private GitHub flows, adapter/profile system, CLI/admin surfaces | SIEM shipping, IdP sync, ticketing, live webhooks, SCM integrations, stable public admin APIs |

### Enterprise Architecture Pillars (Day-1 Design Commitments)

| Pillar | Day-1 architectural commitment | Already in the system | What still needs time/funding |
|--------|-------------------------------|------------------------|-------------------------------|
| Sovereign Data & Defense | Hosted enterprise records must preserve organization/workspace identity, retention class, and payload hash from day one, and all sensitive-at-rest material must flow through one crypto abstraction | Hash-chained audit, compliance exports, actor/origin metadata, org policy hierarchy, `key-management.js`, trusted-source/registry checks, signed indexes | Legal hold / eDiscovery state, write-once storage, backup/restore backends, external KMS/Vault/HSM custody, supply-chain attestations, remote retention enforcement |
| Multi-Tenant Architecture & Scale | Tenant identity must be a first-class routing key across persistence, scheduling, queues, quotas, and filesystem/state layout | Deployment modes, shared manifests, org policy, approval queue, runtime counters, concurrency locks, lane/resource coordination | Tenant-prefixed hosted state, per-tenant queues or scheduler isolation, noisy-neighbor controls, upgrade/version-skew controls, hosted tenant lifecycle APIs |
| AI-Specific Governance | All model calls must traverse a central gateway seam that can enforce allowlists, budgets, fallback, logging, and pre-egress scrubbing before prompts leave the trust boundary | Adapter/profile abstraction, recipe/runtime model/profile flags, `max_cost`, recipe-level model budgets, human-domain routing helpers | Model gateway service, provider allowlists, BYOM endpoint registry, fallback/retention policy, token-cost accounting, PII/secret scrubbing pipeline, policy-backed model approval |
| Commercial Surface | Enterprise integrations should hang off a durable event spine and admin surface rather than being embedded into execution logic | Audit logs, metrics, notifications abstraction, incident hooks, compliance exports, CLI/admin surfaces | Event bus with delivery guarantees, billing/chargeback hooks, SIEM and ticketing connectors, stable admin APIs, webhook delivery, operational dashboards |

**Architecture traps already called out in the roadmap:**

- Do not build custom key rotation; keep all sensitive-at-rest flows behind the existing crypto abstraction and swap in KMS/Vault later.
- Do not let hosted multi-tenant work collapse into one global worker pool; noisy-neighbor isolation needs tenant-aware scheduling/queues.
- Do not hardcode provider SDK calls into agent execution; model traffic needs a gateway seam so policy, fallback, and scrubbing stay centralized.
- Do not treat enterprise integrations as point-to-point code in the executor; wire them off a durable event spine instead.

### Enterprise Priority Breakdown (P0/P1/P2)

P0 means the architecture must carry the seam now even if the hosted backend does not exist yet. P1 means the seam is in place but the operational backend has to be built before real enterprise rollout. P2 is maturity/commercial hardening after hosted enterprise deployment is already real.

| Priority | Item | Need the full infrastructure now to honestly call Guardrail enterprise-aware? | Can we say it is already integrated as a seam? | What still has to change in the current architecture |
|----------|------|--------------------------------------------|-----------------------------------|-----------------------------------------------------|
| P0 | Sovereign record model + crypto boundary | No. We do not need a remote event store or KMS today, but we do need the record model and crypto abstraction fixed now. | Yes, partially. Hash-chained audit, compliance export, actor/origin metadata, and `key-management.js` already give the local seam. | Future hosted records must standardize on `organization_id` / `workspace_id`, `retention_class`, payload-hash metadata, and durable classification labels. All sensitive-at-rest flows must continue to route through a single encrypt/decrypt boundary so KMS/Vault can replace local storage later. Folds items 24, 25, 31, and 32. |
| P0 | Central policy seam (Cedar/OPA-ready), simulation, and decision traces | No. Full external policy infrastructure can wait, but the decision point cannot be scattered through the codebase. | Yes, partially. Org policy, RBAC logic, approval chains, and risk/policy evaluation already exist locally. | Normalize execution authorization behind one policy decision interface with structured facts, add simulation/impact preview, and expose decision traces/explainability so Cedar/OPA can be plugged in later without unwinding executor logic. Folds items 11, 12, and 29. |
| P0 | Model gateway + pre-egress scrubber seam | No. We do not need a hosted model router yet, but provider-specific calls cannot leak into agent execution. | Yes, partially. Adapter/profile abstractions, model/profile flags, `max_cost`, recipe budgets, and human-domain routing helpers already provide the seam. | Keep all model invocation behind a gateway interface that can enforce allowlists, fallback, logging, classification-aware policy, and a pre-egress PII/secret scrubbing hook before prompts leave the trust boundary. Folds items 22, 27, and 32. |
| P0 | Event spine, stable event schema, and runtime tripwires | No Kafka-class backend is required yet, but event emission, admin/event schema, and budget/timeout hooks must exist now. | Yes. Audit logs, metrics, incident hooks, notifications, `max_cost`, rate limits, locks, and runtime counters are already part of the system. | Standardize the event vocabulary and schema versioning, separate execution events from read/admin/access events, and keep billing, SIEM, ticketing, and webhook integrations attached to emitted events instead of executor code paths. Folds items 28 and 36. |
| P0 | Emergency controls: break-glass, revocation, and kill switch | No. Hosted infrastructure can come later, but the control-plane seam must exist now. | Yes, as a design seam only. Incident hooks, approval queue, lane/session lifecycle, and bounded stop/cleanup surfaces are already present. | Add explicit revocation APIs, break-glass approvals, org/workspace kill switches, and auditable emergency overrides so enterprise operators can immediately contain compromised automation. Folds item 30. |
| P1 | Tenant-scoped hosted control plane + noisy-neighbor isolation | Yes, before a real multi-tenant hosted product. Not required for the current local-first enterprise-aware claim. | Yes, as a design seam only. Deployment modes, shared manifests, org policy, lane/resource coordination, and runtime locks show the intended boundaries. | Add tenant-prefixed persistence, queue/scheduler isolation, quota partitions, queue admission control, fair scheduling, starvation prevention, and version-skew controls so one tenant cannot starve or contaminate another. Folds items 26 and 34. |
| P1 | Identity/admin lifecycle + deployment control + BYOM | Yes, before broad enterprise rollout. Not required to claim the architecture already anticipates it. | Yes, as a design seam only. RBAC, approval queue, deployment modes, and adapter/profile abstractions are already present. | Add SSO/OIDC/SAML, SCIM, delegated admin, service accounts, org/workspace management, private VPC/single-tenant/on-prem packaging, and a governed endpoint registry for private models. Folds items 18 and 21–22. |
| P1 | Reliability/ops backends, snapshots/replay, and FinOps | Yes, before production commitments and autonomous enterprise usage. | Yes, as a design seam only. Incident hooks, compliance export, notifications, deployment modes, `max_cost`, and runtime counters are already present. | Add backup/restore/failover/SLO telemetry, snapshot/rehydration, event replay, migration tooling, provider spend ingestion, org/project quotas, and chargeback. Folds items 19, 20, and 33. |
| P1 | Operational integrations, admin APIs, and access auditing | Yes, before enterprises can rely on integrations for real operations. | Yes, as a design seam only. Audit/metrics/notifications/compliance/CLI surfaces already exist. | Add production SIEM/webhook/ticketing connectors, stable admin APIs, read/view/export audit events, and compatibility guarantees for external integrations. Folds items 23, 28, and 36. |
| P1 | Secret mutation + runtime secret governance | Yes, before honest enterprise secret-management automation ships. | Yes, as a design seam only. Local key management, redaction, and env/runtime guardrails already exist. | Add write-only secret-input UX, secret-handle references, execution-time injection/revocation, and secret access audit trails so deferred secret-mutation recipes can eventually ship honestly. Folds item 31 and unblocks `R0b`. |
| P2 | Regulated-enterprise maturity work | No for the enterprise-aware architecture claim. Yes for highly regulated or large-scale procurement. | Partial. Trusted registries/indexes, signed index verification, audit exports, portability, and local compliance surfaces exist. | Add legal-hold workflows/UI, WORM retention backends, DSAR/subject-access flows, supply-chain attestations, certification programs, enterprise dashboards, and deeper air-gapped/upgrade automation. Folds items 24, 37, and 38. |

### P0 Execution Queue (Autonomous-Slice Ready)

The P0 rows above are architectural priorities. They are still too coarse for unattended agent execution unless they are broken into one-slice-at-a-time packets with explicit proofs. The queue below is the execution order another agent should follow when using Guardrail itself to invoke Claude/Codex, land code, run focused tests, review the diff/result, update docs, and only then continue.

Detailed packets live under `docs/plans/PLAN_enterprise_P0*.md`, starting with `docs/plans/PLAN_enterprise_P0_execution_packets.md`.

| Slice | Goal | Required code changes | Proof of done before moving on |
|-------|------|-----------------------|--------------------------------|
| P0a | Universal authorization seam | Done — Guardrail now ships one shared `authorize(action, facts)` boundary and routes command, workflow, template, recipe, adapter, and resident-lane startup through it before execution. | Passed focused proof across the new seam, resident-lane startup, adapter preflight, and supervisor parity paths. |
| P0b | Policy simulation + decision traces | Done — `src/policy-simulate.js` exports `simulatePolicy(context)` and `formatSimulationResult(result)`. `guardrail policy simulate --contract <json> [--trust-class …] [--project-root …] [--principal …] [--json]` returns the same normalized decision format as `authorize()`. Decision traces carry a structured `matched_rules` array identifying each driver. | All 6 CLI acceptance tests and 9 unit tests pass; same allow/deny decisions as `evaluateRisk` for every scenario. No pre-existing failures introduced. |
| P0c | Sovereign record metadata model | Done — `src/shared.js` exports `sovereignMeta()` and `computePayloadHash()`; every audit entry and metrics event now carries `organization_id`, `workspace_id`, `retention_class`, `payload_hash`, `sensitivity`, and `source_provenance`. Compliance exports include a `sovereign_summary` block and expanded provenance columns in CSV. | 108 tests pass across `test-bucket3.js` and `test-bucket6.js` including 13 new sovereign-metadata assertions; 0 regressions. |
| P0d | Single crypto boundary | Done — Audited all sensitive-at-rest write paths in `src/key-management.js`, `src/org-policy.js`, `src/approval-queue.js`, `src/shared-manifest.js`, `src/compliance.js`, and `src/shared.js`. The single crypto boundary is `createKeyStore().set/get` in `key-management.js` (AES-256-GCM + scrypt). No bypass path exists for credentials — `*.key.json` files are only accessed inside this module. Governance/workflow state (policies, approval records, manifests, audit log) is intentionally plaintext — these are not secrets. Boundary documented via `CRYPTO BOUNDARY (P0d)` comment block in the module. | 59/59 tests pass in `test-bucket6.js` including all 5 Key Management boundary tests (store/retrieve, scope enforcement, cross-scope denial, redact, list-without-values). |
| P0e | Event schema v1 | Done — `src/event-schema.js` exports `SCHEMA_VERSION = 1`, five explicit event family sets (`EXECUTION_EVENTS`, `ADMIN_EVENTS`, `ACCESS_EVENTS`, `POLICY_EVENTS`, `INCIDENT_EVENTS`), a `FAMILY_MAP` covering all known event types, and `eventFamily(type)` / `makeEventEntry(type, fields)` helpers. All five subsystems (`audit.js`, `metrics.js`, `notifications.js`, `incident-hooks.js`, `compliance.js`) now import from this single vocabulary: emitted events carry `schema_version: 1` and `family`; `NOTIFY_EVENTS` and `INCIDENT_TRIGGERS` are derived from the schema constants rather than redeclared; `compliance.js` uses `eventFamily()` for family-based counts instead of substring matching. Access/read/export events (`audit_queried`, `compliance_exported`, `metrics_read`, `manifest_read`, `policy_read`) are now first-class members of the vocabulary and are explicitly distinct from execution events. | 157/157 tests pass across `test-bucket3.js`, `test-bucket5.js`, and `test-bucket6.js`; 0 regressions in `npm test` (1533/1540, same 7 pre-existing failures). |
| P0f | Model gateway seam | Done — `src/model-gateway.js` is the single decision point for tool → wrapper file mapping and tool-specific arg construction. `resolveAIWrapperFile(tool, repo)` and `buildAIToolArgs(tool, options, extra)` own the `claude`/`codex` branching that previously lived inline inside `buildWrapperArgs()` in `claude-resident-lane.js`. `toolSupportsNoSessionPersistence(tool)` and `toolSupportsProgressContract(tool)` replace the remaining inline `tool !== 'codex'` guards. `SUPPORTED_AI_TOOLS` and `AI_WRAPPER_FILES` are the BYOM / allowlist seam. | 153/153 adapter + claude-recipe focused tests pass; 0 regressions introduced (`npm test` pre/post diff identical — same 4 pre-existing failures). |
| P0g | Pre-egress scrubbing + classification hooks | Done — `src/egress-hooks.js` now defines the classification/scrubbing seam, `runAdapter()` calls it before return when `profile.egress_hook.enabled` is true, block returns `EGRESS_BLOCKED`, and redact rewrites the actual outgoing `process.stdout` payload (parsed as JSON when possible) plus structured `egress` metadata. Audit entries carry `payload_hash` and matched field names only. | 108/108 focused tests pass across `test-human-domain-routing.js`, `test-adapter-runtime.js`, and `test-bucket5.js`, including runtime redaction of parsed stdout JSON and no-payload-leak audit assertions. |
| P0h | Emergency controls | Done — `revokeResidentLane()` and `killResidentLane()` (break-glass, SIGKILL) added to `resident-lane-core.js`; both write a `REVOKED` sentinel file that blocks `runResidentLaneDaemon` from restarting regardless of ordinary stop/cleanup. `revokeSessionContract()` and `isSessionRevoked()` added to `agent-session.js`; `evaluateSessionLifecycle()` returns distinct `session_revoked` code (not `session_missing` or `session_drift`) when the approved contract carries `status: 'revoked'`. Three new events (`lane_revoked`, `lane_emergency_stop`, `session_revoked`) added to `INCIDENT_EVENTS` and `INCIDENT_TRIGGERS` in `event-schema.js`. CLI wired with `guardrail lane revoke`, `guardrail lane kill`, and `guardrail session revoke` — each appends a distinct audit entry. | 45 agent-session tests pass (including 17 new revocation tests); 63 lane tests pass (including 5 new emergency-control tests); 0 regressions in `npm test` (1548 total, 7 pre-existing failures unchanged). |

### Autonomous Execution Rule For P0

For each P0 slice above, the working agent should use the same loop:

1. Run a trivial probe through the exact guarded path that will be used for the real slice.
2. Execute only one slice.
3. Require the declared artifact to exist before claiming success.
4. Run focused tests for that slice.
5. Review/fix the result.
6. Update `README.md` and this roadmap entry.
7. Only then move to the next slice.

If a slice cannot produce its declared artifact or cannot pass its focused tests, the agent should stop on that slice and fix the path first instead of starting the next one.

### Recipe Distribution (v0.2–v0.5)

| # | Feature | Target | Unlocks | Status |
|---|---------|--------|---------|--------|
| D0a | GitHub SHA-pinned install (`github://owner/repo/path@sha`) | v0.2 | Immutable community recipes | Done — fetches from GitHub, requires full commit pinning, stores remote metadata in `.pins/<version>.json`, re-verifies source hash on run, and falls back to authenticated GitHub contents API when raw fetches are unavailable. |
| D0b | Recipe publish (`guardrail recipe publish`) | v0.2 | One-command community contribution | Done — lint → scrub metadata only → fork → PR against guardrail-dev/recipes. Shell manifests are rejected; RED is blocked from public registry. |
| D0c | Template → recipe bridge (`template create --from-manifest`, `template publish`, `template list`, trust hash comparison) | v0.2 | Local-first authoring flow | Done — Guardrail can now generate starter templates from approved manifests, list local templates, publish templates through the recipe pipeline, preserve rollback-bearing workflow-template steps when publishing to recipes, carry step `idempotent` metadata into recipe steps, and demote source trust when a published/generated template no longer matches its recorded source hash. |
| D0d | Unified workflow recipe discovery (installed/home/global parity, no manual `--recipe-search-dir`) | v0.3 | Cross-repo recipe workflows without local glue | Done — workflow `recipe_ref` resolution uses the same normalized local `recipes/`, `node_modules/.guardrail/recipes`, configured repo/user `default_recipe_roots`, and `~/.guardrail/recipes` discovery model as standalone recipe mode, including version/latest resolution and manifest drift on latest-version changes. `--recipe-search-dir` remains available only for extra ad hoc roots outside the shared default/configured discovery surface. |
| D0e | Bundled wrapper portability (remove manual `guardrail_repo` plumbing for Guardrail-shipped recipes) | v0.3 | Easier cross-repo agent workflows | Done — Guardrail-shipped wrapper recipes now resolve helpers through bundled wrapper aliases instead of requiring manual checkout-path args in the common case. `guardrail_repo` remains only as an optional runtime override/compatibility escape hatch. |
| D0f | Multiple recipe-root precedence and collision policy | v0.3 | Safe mixed local/shared/org recipe stacks | Done — recipe search roots are normalized canonically, explicit roots stay highest precedence, and ambiguous duplicate recipe/version matches fail closed with ordered search-root diagnostics instead of silently picking one. |
| D0g | Repo/config-level default recipe roots | v0.3 | Cleaner CI and per-repo setup | Done — repo-local `.guardrail/config.json` and user-level `~/.guardrail/config.json` may now declare `default_recipe_roots` (with `recipe_roots` accepted as a compatibility alias), and those roots feed the same shared discovery path used by standalone recipe mode, `list`, and workflow `recipe_ref`. Explicit `--recipe-search-dir` remains highest precedence, and misconfigured configured roots fail closed with actionable diagnostics. |
| D0h | Cross-platform recipe-root and wrapper-path normalization | v0.4 | Reliable Windows/macOS/Linux portability | Done — canonical path normalization, portable path keys, mixed-separator handling, and case-insensitive lookup now cover workflow recipe discovery, bundled-wrapper provenance/drift binding, and portable source locators across equivalent Windows/macOS/Linux path forms. |
| D0i | Workflow outputs and typed shared state between steps | v0.3 | Helper-free dynamic workflows | Done — step-level typed outputs and shared state references are implemented for `task` and `recipe_ref`; runtime resolves shared outputs, enforces declared types, and validates schema-bound consumption in workflow execution. |
| D0j | Bounded parameter approvals (reuse within approved ranges/subsets) | v0.3 | Lower re-approval churn for safe input changes | Done — template and recipe reuse can proceed within approved bounded envelopes for deterministic input definitions, including enum, integer range, and bounded list inputs with per-item validators. Exact-match, `content_hash`, and review/never-reuse protections still take precedence. |
| D0j1 | Bounded commit-plan support | v0.3 | Safe commit automation after unknown-file edits settle | Done — Guardrail now supports validated commit-plan artifacts plus a bundled `git-commit-from-plan` recipe/wrapper. Approval binds the plan file, message file, exact bounded file set, and derived execution details so later commit execution cannot silently widen to “whatever changed.” |
| D0k | Wrapper/version coupling and provenance policy | v0.3 | Safe upgrades for Guardrail-shipped wrapper recipes | Done — bundled wrapper helpers now carry recorded provenance (`wrapperPath`, source root, package version, SHA-256) into recipe input-hash collection and replay verification. Helper drift or wrapper source changes now invalidate prior approval instead of silently reusing it. |
| D0l | Org policy for trusted recipe roots and external execution sources | v0.4 | Central governance for shared recipe libraries | Done — repo/user configured `default_recipe_roots` and explicit extra recipe roots honor the active org policy trust boundary for `trusted_recipe_roots`, and remote recipe installs plus remote adapter-profile installs now also load the active org policy by default and enforce `trusted_execution_sources` before fetching GitHub or URL content. |
| D0m | Workflow parity for private/shared installed recipe sources across machines | v0.4 | Consistent local/CI/team behavior | Done — workflow manifests ignore checkout-root-only path drift and bind `recipe_ref` sources through portable locators instead of absolute recipe file paths. External shared roots now also record stable origin locators (`explicit`, `repo_config`, `user_config`, or `absolute`) so repo-configured shared roots stay portable across machines while two different shared roots with the same relative recipe path still drift honestly. Missing-recipe errors include search order. |
| D0n | `recipe_ref` trust/signature enforcement parity with standalone recipe mode | v0.3 | Stronger provenance guarantees for workflow-chained recipes | Done — workflow `recipe_ref` records trust/signature metadata in normalized manifests, enforces `channel`/signature policy at execution time, persists trust-boundary (`allow_unverified`) in workflow approvals, and fails closed when trust policy changes after approval. |
| D0o | Reproduce and fix first-approval TTY failure under `tpf` | v0.3 | Reliable interactive approval from agent shells | Done — verified first interactive approval in command, recipe, and workflow mode through `tpf --passthrough-tty`. Guardrail keeps the TTY requirement; the supported approval-bearing path is documented in README and agent onboarding. |
| D0p | Enforce `review_each_time` parity for workflow `recipe_ref` inputs | v0.3 | Honest approval semantics for prompt-bearing chained recipes | Done — workflow approval now rechecks recipe_ref `flaggedInputs` for `never_reuse`-qualified values and forces non-interactive reapproval even on manifest matches, with dedicated workflow regression coverage. |
| D0q | Transport + exec recipe composition under one approval | v0.4 | Common host-runtime hops without nested double-approval UX | Done — Guardrail supports composed transport+exec recipe steps under one supervisor-managed approval contract, with child recipe trust/env/input-hash/session metadata bound into the outer manifest and no nested inner `guardrail run`. The bundled `cmux-claude-exec` recipe remains the primary shipped proof, and `guardrail recipe compose --transport <id> --exec <id> --output <path>` now generates reusable composed recipe artifacts while failing closed on input-schema conflicts. |
| D0r | Resident transport sessions and approval handoff | v0.4 | Approve a bounded host-runtime lane once, then trigger repeated bounded runs without repeated surface-level approval | Done — Guardrail ships a FIFO-based resident lane control plane with `lane start` / `lane send` / `lane result` / `lane wait` / `lane status` / `lane inspect` / `lane history` / `lane logs` / `lane cleanup` / `lane stop` CLI support. Lane startup creates owner-only request/response FIFOs, generates an ephemeral repo-scoped host key outside the workspace, writes host-side live-lane registry entries for cross-checkout visibility, and keeps the authenticated host-runtime session alive for later prompts. Follow-up sends use the FIFO bridge instead of reopening the outer launcher/surface hop, `lane send` returns a structured `pending` result when the request is still running and now points bounded recovery at `lane wait`/`lane inspect`, `lane wait` provides a bounded wait/read path for that same request without dropping to raw host inspection, `lane inspect` now combines status, latest result, bounded logs, and recent lane-audit history, `lane history` exposes a dedicated per-lane audit timeline with chain-validity, and lane status/list/start outputs now surface adapter-specific transport summaries so operators can see the exact approved lane contract. `lane start` fails early with `lane_boot_failed` when the daemon dies during bootstrap or the immediate post-start window, resident Claude lanes now also classify auth source and run an in-daemon auth preflight before the first packet is accepted, `lane logs` exposes a bounded local log tail for diagnosis, `lane result` reads stored output artifacts without reopening the transport, missing key/FIFO state yields a structured `lane_expired` recovery path, duplicate signed request ids are rejected inside the active lane window, and lane lifecycle actions append `lane_start` / `lane_send` / `lane_result` / `lane_wait` / `lane_cleanup` / `lane_stop` events to `.guardrail/audit.jsonl`. |
| D0s | Interactive user-message sessions without per-message reapproval | v0.4 | Direct chat with a guarded AI runtime where the user controls message content but not the executable boundary | Done — recipe/template approval envelopes support `interactive_message`, resident FIFO lanes keep later prompts inside the same approved persistent session, `lane send --wait` preserves bounded polling for long turns, `lane chat` exposes the higher-level “send one guarded turn and wait” UX, and `lane run-sequence` now keeps Guardrail attached through sequential prompt files until each long-running step completes or fails instead of returning early on `request_still_running`. `lane run-sequence --stop-when-done` also closes the lane after the final successful step when operators do not want the session left open to idle-expire. Runtime-boundary changes, session-identity changes, and `review_each_time` companions like `system_prompt` still force reapproval by design. |
| D0t | Lane registry and portfolio visibility (`lane list`, `lane prune`) | v0.4 | First-class "manager of managers" UX for concurrent lanes | Done — Guardrail ships `lane list`, `lane batch`, targeted `lane cleanup`, and `lane prune` over the repo-local lane registry, can optionally widen visibility with `lane list --all-repos` through the host-side live-lane registry, surfaces mixed ready/busy/failed/expired/stale/stopped lane state in one filtered portfolio view, appends explicit cleanup/prune/batch audit entries, and preserves prune tombstones under `.guardrail/lane-tombstones/` for post-mortem review. `lane batch` now provides the broader batch lifecycle action surface that was previously missing. |
| D0u | Stable lane identity and split-brain prevention | v0.4 | Honest lane ownership across restarts, retries, and multi-project use | Done — resident lanes now persist an explicit `identity.json` record plus fresh boot nonces, scope the default host key path by stable Guardrail repo identity instead of the bare lane id, write host-side live-lane registry claims, and use both repo-local and host-side startup lock files to fail closed before concurrent starts race into split-brain ownership. `lane start` now rejects duplicate live lane ids both within the repo-local registry and across the shared host-side registry for the same Guardrail host root. |
| D0v | Swarm scope coordination for concurrent lanes | v0.5 | Multi-agent productivity without accidental workspace collisions | Done — resident lanes can now declare optional `repo`, `worktree`, or explicit `paths` scopes plus `warn|block` enforcement at startup, and Guardrail infers a default `worktree/warn` scope when `working_dir` narrows below the repo root and callers omit explicit scope flags. Guardrail also ships typed non-path resource claims with `--resource <class:name>` and `--resource-mode warn|block`, canonicalizes legacy `branch:<name>` aliases to `git-branch:<name>`, auto-discovers the current `git-branch:<name>` when the working tree is on an attached branch and no explicit branch claim was provided, persists both explicit and discovered resource details in lane identity/state, compares repo-scoped branch claims separately from host-scoped claims like `service:<name>` or `env:<name>`, blocks startup on overlapping `block` scopes/resources, and surfaces overlapping live-lane conflicts through `lane start`, `lane status`, and filtered `lane list` views. |
| D0w | Transport-generalized resident lanes | v0.5 | Extend the lane control plane beyond the first Claude proof | Done — the resident lane CLI surface is now explicitly tool-selectable (`--tool claude|codex|local-exec|prompt-wrapper|ssh-prompt-wrapper`), unknown tool ids fail closed instead of silently falling back, `lane adapters` exposes bundled adapter inventory plus adapter capability metadata sourced from the adapter modules themselves, lane identity/state/list/status all persist the selected tool, the generic `src/resident-lane.js` entrypoint owns the shared lifecycle exports directly from the lane core, and the same FIFO lane control plane now drives Claude, Codex, fixed stdin-driven local commands, generic local prompt-wrapper adapters, and remote SSH prompt-wrapper adapters through tool-specific modules. |
| D0x | Portfolio-wide lane audit and net-intent timeline | v0.5 | Explain what the swarm owns, changed, and cleaned up across the whole host | Done — Guardrail now mirrors resident-lane lifecycle entries into a host-level `resident-lane-portfolio.jsonl` audit log and ships `guardrail lane portfolio` as the bounded portfolio timeline surface. That command can read the repo-local lane audit or the mirrored host-level timeline (`--all-repos`), filter by lane/tool/status/session/repo/event, surface a live-lane snapshot beside the timeline, summarize event/tool/status counts, and preserve prune/cleanup tombstone paths in the timeline output so operators can review startup, send, wait, result, cleanup, prune, and stop outcomes without stitching together per-lane history by hand. |
| D0y | Guarded AI exec progress channel | v0.5 | Real-time operator visibility for long-running one-shot AI packets | Done — `claude-exec` now ships a Guardrail-owned one-shot progress channel via `.guardrail/ai-progress.ndjson` plus `.guardrail/ai-progress-state.json`, wrapper-managed progress flags/system appendix, supervisor relay and stall detection, soft states (`waiting_for_review`, `waiting_for_input`, `drift_warning`, `stalled`), `guardrail recipe progress --state-dir .guardrail [--follow]`, and `guardrail recipe continue --state-dir .guardrail --prompt ...`. Successful runs that end in a soft review/input state now preserve that state instead of collapsing to `completed`, so bounded follow-up review/input can continue the same session identity. The checkpoint content is still model-cooperative rather than a native Claude streaming API, but Guardrail now also supports an explicit `report_artifact` input for `claude-exec` and treats report-file mtime changes as synthetic `ai_artifact_written` heartbeats when that path is declared. Resident FIFO lanes are the primary multi-shot execution path; `claude-exec` is deprecated and the one-shot progress channel is now a compatibility-only visibility/continuation surface. Claude-backed lanes and bundled Claude recipes now default the visible LLM budget to `$10.00` unless the operator overrides it, and the review summary surfaces that budget explicitly before execution. Guardrail governs the bounded execution contract and monitoring surface; Claude's own internal tool approvals or tool-availability decisions remain downstream operator-managed behavior. Implementation plan and fire-trial notes: `docs/plans/PLAN_d0y_guarded_ai_exec_progress_channel.md`, `docs/plans/REPORT_d0y_guarded_ai_exec_progress_channel.md`, `docs/plans/REPORT_enterprise_P0_fire_trial.md`. |
| D0z | True repo-local autonomous lane mode | v0.5 | Hands-free lane execution where both Guardrail lane state and downstream tool project/session state stay repo-local | Done — Guardrail now keeps resident-lane key and host-state paths under repo-local `.guardrail/host-lanes/...`, resolves the bundled Claude wrapper from the actual Guardian source tree instead of the operated repo root, avoids unsafe `CLAUDE_CONFIG_DIR` redirection for env-token auth, and also bridges Claude’s observed host-global per-project path `~/projects/<encoded-cwd>` back into repo-local `.guardrail/claude-runtime/...` storage. Existing operator-set `CLAUDE_CONFIG_DIR` is respected unchanged, resident Claude lanes default to `--no-session-persistence`, resident Claude lane startup now fails early with structured `auth_preflight_failed` / `auth_probe_failed` state before packet execution when the daemon runtime cannot authenticate, and conflicting preexisting host project paths fail closed instead of being silently overwritten. The host-visible `~/projects/<encoded-cwd>` shim still exists, but the writable state behind it is now repo-local. Full analysis and proof are in `docs/plans/REPORT_d0z_true_repo_local_autonomous_tool_state.md`. |
| D0za | Claude interactive submit/complete contract | v0.5 | Deterministic resident-lane execution on the interactive Claude backend without falling back to one-shot `--print` | Done — the resident interactive wrapper reliably delivers prompts and receives completions from the Claude TUI. The bracketed-paste path remains the primary delivery path; a 1-second quiet-timeout `submit_fallback` now covers Claude TUI versions (v2.1.108+) that accept paste silently without emitting the older `Pasting text…` indicator, and a bounded `startup_beacon_fallback` covers startup frame variance. Submit sequence is `\r\r` (two raw CR bytes, proven in d0za-direct-receive7 on 2026-04-13 and d0za-proof-final on 2026-04-15). Completion heuristics use `ne "artifact"` guard so direct turns and unspecified modes exit via Tcl-side beacon without being silently stuck, while artifact turns close on declared report-artifact completion. End-to-end proof now covers both modes: `guardrail lane chat --id d0za-proof-final --prompt "Reply with exactly: PONG" --completion-mode direct` returned `PONG` on Claude v2.1.108 via the full FIFO lane path, and `d0za-artifact-proof-final` wrote its declared report artifact and completed cleanly through artifact mode. |
| D1 | npm registry (`@guardrail/recipes`) | v0.3 | Developer ergonomics | Deferred — convenience layer on top of GitHub repo, not a replacement. npm versions are immutable once published; content hash is stable. Keep deferred until the GitHub-based distribution path and registry ergonomics are proven. |
| D2 | Self-hosted recipe registry (JSON API) | v0.5 | Enterprise air-gap | Done — Guardrail now ships the static registry producer and consumer surfaces together: `guardrail recipe registry export <output-dir>` writes the `v1/recipes/` JSON layout, `guardrail recipe registry list <registry>` inspects that inventory, and `guardrail recipe install <category/id@version> --registry <registry>` installs exact versions from a trusted registry root. Org policy `trusted_registries` is now enforced separately from `trusted_execution_sources`. |

### Recipe Expansion Candidates (v0.3–v0.4)

| # | Feature | Target | Unlocks | Status |
|---|---------|--------|---------|--------|
| R0a | Ship-now bounded recipe batch (`gh-open-pr`, `git-clone-allowed`, `gh-release`, `docker-build`, `docker-push`, `terraform-plan-only`) | v0.3 | Safe expansion of high-signal day-one recipes | Done — Guardrail now ships the full initial bounded recipe batch as structured recipes with explicit repo/registry/path/tag inputs, reviewed-file inputs where needed, and no dependence on new approval primitives. Terraform remains split between `terraform-plan-only` and the stronger mutation-bearing `infra-deploy` path. |
| R0b | Secret mutation recipes (`gh-secret-set` and similar) | v0.4 | High-value secret-management automation under Guardrail | Deferred (enterprise/high-trust) — public/community Guardrail still lacks the write-only secret-input UX, multi-stage approval, and guaranteed audit/log redaction needed to ship secret-mutation recipes honestly. |
| R0c | Broad package install recipes (`npm-install`, `pip-install`) | v0.4 | Safer dependency bootstrap and repair flows | Done — Guardrail now ships bounded `npm-install` and `pip-install` recipes backed by dedicated safe wrappers. `npm-install` is fixed to reviewed local metadata plus `npm ci --ignore-scripts --fund=false --audit=false`, requires the reviewed lockfile to live inside the approved package directory, and never accepts freeform package names. `pip-install` is fixed to a reviewed hashed requirements file plus `python -m pip install --require-hashes --no-deps --no-input --disable-pip-version-check -r <file>`, and rejects nested requirements, editable installs, direct URLs, alternate indexes, and unhashed package lines before execution. Registry overrides, extra-index URLs, and lifecycle/build-script execution remain blocked. |
| R0d | Direct push and history-mutation recipes (`git-push`, amend/force variants) | v0.4 | Git automation without silent branch or history damage | Done — Guardrail now ships `git-push`, `git-commit-amend`, and `git-force-push-safe` as bounded direct Git mutation recipes. `git-commit-amend` requires approved message file + exact HEAD precondition, and `git-force-push-safe` requires explicit local/remote OID validation before `git push --force-with-lease`. These wrappers still reject detached HEAD, topic-branch drift, protected branches, missing remotes, and missing expected OID inputs; destructive delete/unsafely-wide history-mutation remains intentionally deferred. |
| R0e | Destructive cloud mutation recipes (`aws s3 sync --delete`, `aws ec2 terminate-instances`) | v0.4 | Guardrailed cloud operations for high-trust environments | Deferred (enterprise/high-trust) — open-source Guardrail still lacks resource/account binding, dry-run parity guarantees, destructive-change summaries, and multi-stage approval strong enough to publish destructive cloud-mutation recipes honestly. |
| R0f | Task-specific OpenClaw recipes (`fix-tests`, `debug-ci`, `deploy`) | v0.3 | Safer task-oriented agent entrypoints on top of the existing wrapper | Done — `openclaw-fix-tests`, `openclaw-debug-ci`, and `openclaw-deploy` now call `{{bundled_wrapper.openclaw_task}}`, a dedicated wrapper that hard-binds each task flow to its allowed scope before running `openclaw scope check`, `openclaw run --no-escalate`, and `openclaw verify` in one command package. `openclaw-deploy` is intentionally narrow: it only allows `preview|staging`, requires approved `service_manifest` and `release_file` inputs, and keeps deploy execution bound to the reviewed environment/artifact tuple instead of a generic admin deploy surface. |

### Adapter System (v0.2–v0.3)

| # | Feature | Target | Unlocks | Status |
|---|---------|--------|---------|--------|
| A0a | Rich command supervisor context | v0.2 | Stable agent/tool integrations | Done — `runSupervisor()` returns bounded worker output, drift diffs, reason, risk level, telemetry, and `contractHash`/`manifestPath` on the command path. Adapter parity tests cover every terminal status. |
| A0b | `adapter-result/v1` translation layer + declarative profiles | v0.2 | Public open-source profile ecosystem | Done — `adapter-result/v1` stabilized with an additive `guardrail.code` field backed by the exported `ADAPTER_REASON_CODES` table (21 codes across success, blocked, failed). `validateAdapterResult` gates the shape on every return path. Reason strings stay human-readable; code strings are the stable machine contract. |
| A0c | Adapter CLI + Phase 1 protocols (`stdin-json`, `env-shim`) | v0.2 | OpenClaw/Aider integration | Done — `adapter run`, `adapter-stdin`, and shim management all live. MCP gate moved into `runAdapter` so every entry point produces a structured `MCP_BLOCKED` result instead of an exit-1 stack. Stdin parses with `INPUT_READ_FAILED`, `INPUT_TOO_LARGE`, and `INVALID_JSON` structured codes. `adapter-shim` rejects shell metacharacters and path separators in command/tool names. |
| A0d | GitHub SHA-pinned adapter profile install | v0.2 | Safe public profile sharing | Done — GitHub, URL, and local-path installs all share one validation-failure error prefix, require full 40-character SHAs for `github://`, write `.pins/<version>.json` metadata with owner/repo/path/sha/rawUrl/content_hash, enforce `trusted_sources` as fail-closed, and expose a `fetchJson` dependency-injection hook used by the regression suite so no test hits real network. |
| A0e | Bundled adapter profiles for `openclaw`, `aider`, and `cline` | v0.2 | Turnkey agent onboarding | Done — bundled profiles ship under `src/adapter-profiles/`; `cline` remains intentionally blocked through the MCP gate (policy-boundary artifact, not a half-enabled runtime). End-to-end render parity is covered by the `test-adapter-runtime` suite for `openclaw` (stdin-json JSON template), `aider` (env-shim human template), and the blocked-MCP path. |
| A0f | Adapter auth mapping and env-policy preflight (`missing_auth_mapping`) | v0.2 | Safe CI/OIDC credential plumbing | Done — adapter profiles may declare `requires_env` and bounded `requires_auth` checks. `adapter run` now supports repeatable `--env-allow`, compares declared env requirements against the approved allow-list, fails closed with a `missing_auth_mapping` reason, performs bounded CLI-auth preflight for supported runtime-local checks such as Claude and GitHub CLI login state, and requires explicit mapping of auth-runtime env such as `HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, or `GH_CONFIG_DIR` when those are needed to make the checked login state visible to the guarded child process. Standalone recipe mode, workflow `recipe_ref`, and composed host-runtime child recipes now use that same bounded preflight surface too; for secure-store-backed Claude exec specifically, the shipped `claude-exec` recipe preserves the wider current runtime env during the actual bounded probe/invoke path while still binding the declared env subset into approval drift so plain-shell `claude --print` parity does not depend on enumerating every opaque runtime variable. |
| A0g | Agent session contracts and resumable named runs | v0.3 | Repeatable long-lived AI workflows | Done — `claude-exec` and `codex-exec` recipes accept `lifecycle` (`start` / `continue` / `attach`), `session_name`, and `session_id` inputs. Recipe supervisor enforces bounded session contracts at `<projectRoot>/.guardrail/agent-sessions/<recipeId>/<slot>.json` with `session_missing`, `session_drift`, `session_attach_mismatch`, and `session_already_exists` fail-closed reasons. Session enforcement runs BEFORE manifest reuse so drift is detected even when the manifest would otherwise match. `review_each_time` inputs still force reapproval, but recipes/templates can now explicitly mark later user messages as `interactive_message` so prompt text may vary within the same persistent named session without widening the executable boundary. Wrappers emit structured `[guardrail-session]` metadata to stderr before spawning the underlying CLI — no scraping of `~/.claude/*` or `~/.codex/*`, no implicit attachment to ambient local sessions. |
| A0h | Additive MCP transport for adapter mode | v0.3 | Native MCP-tool integration without regressing current adapters | Done — MCP profiles now declare a validated `mcp_transport` contract (currently `stdio` only) with explicit correlation/capability-discovery expectations. Guardrail ships bounded MCP discovery (`adapter probe`, `adapter mcp tools`), bounded one-shot execution (`adapter mcp call`), bounded ordered multi-call execution (`adapter mcp batch`), and `adapter run` now routes MCP profiles through those same bounded structured request shapes when the caller supplies `--mcp-tool` / `--params-json` or `--calls-json`. Capability discovery still validates requested tools before launch when the profile requires it, and arbitrary shell-style `adapter run -- <command>` remains intentionally blocked for MCP profiles. |
| A1 | Signed index + bare-name profile install | v0.3 | Discovery and easier onboarding | Done — Guardrail ships signed adapter-profile index verification through `adapter profile index verify <path> --index-key <pubkey.pem>`, including schema validation plus signature verification over SHA-pinned `github://...@<40-char-sha>` entries. Bare-name installs now work both with explicit `--index` / `--index-key` inputs and through repo/user-configured `trusted_adapter_indexes` entries in `~/.guardrail/config.json`. `adapter profile discover [tool]` exposes the current trusted signed-index inventory, ambiguous bare-name installs fail closed until the caller disambiguates, installed pins record the chosen signed-index provenance, and Guardrail still enforces trusted execution sources on the resolved pinned GitHub source. Ambient unsigned public discovery remains intentionally blocked. |

### Human-Domain Routing & Evaluation Safety (v0.4)

| # | Feature | Target | Unlocks | Status |
|---|---------|--------|---------|--------|
| H0a | Harden human-domain routing gates and risk scoring for benchmark/evaluation use | v0.4 | Safe reruns of human/workplace benchmark subsets without leaking sensitive content or silently misrouting CT | Done — Guardrail now ships the end-to-end helper surface for this work: balanced-object LLM JSON extraction plus redacted parser-failure metadata in `src/llm-json.js`, runtime normalization/recomputation helpers in `src/human-domain-routing.js`, and ready-to-call `checkDomainContext()`, `checkPremiseRejection()`, and `scoreHumanRisk()` helpers that delimit untrusted prompt/answer content, parse the first valid JSON object, fail closed to normalized fallbacks, and optionally report redacted parser-failure metadata to the caller. Focused regression coverage covers the parser helpers plus the end-to-end gate wrappers. Downstream benchmark runners still need to import these helpers, but that consumer wiring is no longer a Guardrail repo blocker. |

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

### Business-Logic Coverage Gate

- `npm run test:coverage:business` enforces `--test-coverage-lines=90` over the decision-heavy modules rather than every orchestration file.
- Current gate includes `src/lane/control.js`, `src/lane/health.js`, `src/lane/maintenance.js`, and `src/lane/query.js`.
- `src/lane/runtime.js` is tested directly, but kept out of this coverage gate because it is process/integration plumbing rather than primary policy/business logic.

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
| `lane start --id <id> [--tool <adapter>]` | Done | Start a resident interactive lane, create FIFOs, mint the ephemeral host key, and bind the lane to a selected adapter (`claude`, `codex`, `local-exec`, `prompt-wrapper`, or `ssh-prompt-wrapper`) |
| `lane chat --id <id> --prompt "<text>"` | Done | Send one guarded chat turn and wait for the same resident-lane result |
| `lane send --id <id> --prompt "<text>"` | Done | Send one prompt through an existing resident lane |
| `lane result --id <id> [--request-id <id>]` | Done | Read the stored output for the latest or named resident-lane request |
| `lane wait --id <id> [--request-id <id>]` | Done | Wait for a resident-lane request to complete without dropping to raw host inspection |
| `lane inspect --id <id> [--tail <n>]` | Done | Read status, latest result, and bounded logs together for one resident lane |
| `lane portfolio [--all-repos] [--limit <n>]` | Done | Query the repo-level or mirrored host-level resident-lane timeline, live-lane snapshot, and event/tool/status summaries in one bounded surface |
| `lane logs --id <id> [--tail <n>]` | Done | Read a bounded resident-lane log tail without reopening the host transport |
| `lane cleanup --id <id>` | Done | Remove one diagnosed failed/dead lane without sweeping the whole registry |
| `lane list` | Done | Enumerate repo-local resident lanes and narrow the portfolio with status/tool/scope/resource/conflict filters |
| `lane batch` | Done | Preview or apply filtered stop/cleanup actions across multiple resident lanes |
| `lane prune` | Done | Classify dead lane candidates, support `--dry-run`, write lane tombstones, and remove dead lane artifacts from the repo-local lane registry with audit entries |
| `lane stop --id <id>` | Done | Stop a resident lane and purge its key/FIFOs |
| `repo status --path <repo>` | Done | Show staged, unstaged, and untracked repo changes in one proof-oriented view |
| `recipe compose --transport <id> --exec <id> --output <path>` | Done | Generate a reusable composed recipe artifact from bounded transport and exec recipes |
| `workflow run --definition <path>` | Done | Execute a multi-step workflow |
| `workflow lint --definition <path>` | Done | Lint a workflow definition |
| `template lint\|explain\|schema\|simulate\|diff` | Done | Template inspection commands (5) |
| `list [--category\|--tag\|--search\|--risk\|--channel]` | Done | List and filter recipes |
| `create --name <n> --category <c>` | Done | Generate a recipe skeleton |
| `pack <recipe.json>` | Done | Package a recipe with content hash |
| `recipe validate <file>` | Done | Validate a recipe JSON |
| `recipe inspect <packed.json>` | Done | Inspect packed recipe, verify hash |
| `recipe install <path\|url\|github://...@sha> [--overwrite]` | Done | Install to versioned local registry, including SHA-pinned GitHub sources |
| `recipe versions <id>` | Done | List installed versions of a recipe |
| `recipe publish --name <n> --category <c> [--manifest <path>] [--dry-run]` | Done | Convert a structured approved command manifest into a community recipe PR flow |
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
| test-feature-acceptance.js | 56 | README-derived acceptance coverage, including recipe non-interactive enforcement and recipe distribution UX |
| test-input-validator.js | 91 | Shared input parsing, coercion, enum/range/pattern validation, exact-value approval edge cases |
| test-github-install.js | 38 | GitHub SHA-pinned install, pin metadata, CLI parsing, remote verification, authenticated fallback, loadRawJson |
| test-recipe-publish.js | 47 | Manifest-to-recipe conversion, personal-data scrub, PR body, publish dry-run guards |
| test-codex-recipe.js | 4 | Codex exec recipe schema plus prompt/file wrapper helper assembly |
| **Current runner total** | **See `npm test` output** | Treat the live test command output as the canonical count |

Run: `npm test` (full suite), `npm run test:e2e` (verification/e2e/adversarial suites), `npm run test:core` (core unit/integration suites), `npm run test:acceptance` (feature acceptance coverage)
