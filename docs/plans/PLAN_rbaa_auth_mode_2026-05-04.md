# Guardrail — RBAA+Auth Mode (Two-Mode Architecture)

Status: Draft — repaired for implementation sign-off
Audience: Maintainers wiring dynamic risk-based authorization and verifiable agent identity into Guardrail
Goal: Introduce a second mode of operation, `rbaa`, alongside the current default `static` mode, aligning Guardrail's authz vocabulary with the Hoplon Dynamic RBAA framework while preserving the deterministic-kernel discipline.
Date: 2026-05-04

Roadmap anchor: builds on landed tracker items `p0a`, `p0b`, and `p0c`; composes the shipped universal authorization seam, decision-trace shape, and sovereign record metadata model; introduces the new `runtime.authMode` configuration axis.

---

## 1. Why a Mode

Guardrail's current authorization is partly centralized through `src/authorization.js` and partly embedded in approval-time risk assessment, adapter checks, CLI governance helpers, and supervisor-specific preflight code. That works for the current statically-evaluated risk model, but it does not compose with:

- runtime risk re-evaluation as agent behavior accrues
- short-lived capability envelopes with TTL and renewal
- cryptographic agent identity and trust tiers
- approval-class taxonomy compatible with sibling enforcement systems (e.g., Hoplon at the file/AST boundary)
- continuous policy-bundle versioning and decision-trace correlation

Building these into the existing flow as conditional branches would balloon every supervisor and re-litigate every test. A second mode lets the new model land on a clean boundary, with the existing model preserved verbatim as the default.

The non-negotiable rule the new mode adopts (from the Hoplon TDD §2): **policy decision happens at the authorization seam; the kernel stays policy-engine agnostic**. The static mode already honors this in spirit (manifest hashing is deterministic, kernel never re-decides); the new mode formalizes it.

---

## 2. The Two Modes

### Mode 1 — `static` (default; current behavior)

- Risk is computed once at contract approval time by `policy-engine.js` (traffic light: `green | yellow | red`).
- `risk-traits.js` classifies traits into buckets (`allow | flag | block`).
- Manifest stores contract hash + approval state. No TTL. Approval is durable.
- Identity is declarative (`actor`, `origin`, declared `permissions`, declared `scope`).
- Approval queue stages are role-based (RBAC).
- Behavior telemetry is collected (`metrics.js`) but does not feed back into authorization.
- Quarantine is event-triggered (`incident-hooks.js`), not a persisted principal state.

This mode is the default and the only mode unless the operator explicitly opts in. Existing tests, manifests, recipes, workflows, templates, and adapter profiles continue to work unchanged.

### Mode 2 — `rbaa` (opt-in; new)

- Risk is computed at handshake AND re-computed at controlled boundaries (TTL renewal, scope expansion, behavior anomaly, environment risk change).
- Risk is expressed in **bands** `R0_LOW | R1_GUARDED | R2_ESCALATE | R3_APPROVAL | R4_QUARANTINE_OR_DENY` (Hoplon TDD §6) on top of the existing trait/traffic-light signals — not in place of them.
- Autonomy tiers `A0_OBSERVER | A1_PROPOSER | A2_SCOPED_EDITOR | A3_MULTI_FILE_EDITOR | A4_PROTECTED_OPERATOR | A5_BREAK_GLASS` apply per agent, dynamically downgradable at runtime.
- Manifest entries are wrapped in a **capability envelope** carrying `decisionId`, `policyVersion`, `grantIds`, `expiresAt`, `riskBand`, `autonomyTier`, `requiredControls[]`. The contract hash is preserved as today; the envelope adds claims around it.
- Identity is **verifiable** (cryptographic agent identity, signed delegation chain, trust tier).
- Approval queue extends RBAC stages with Hoplon-style approval classes (`cto | human | security | platform | dba | break_glass`).
- Behavior telemetry feeds back into next-evaluation risk over a bounded window.
- Quarantine is a persisted principal-state record, surviving across runs until reviewed.
- Continuous re-evaluation runs at: token renewal, scope expansion, drift detection, environment change, policy-bundle change.

Mode 2 deliberately does *not* introduce file-level / AST-level scope enforcement. That belongs to Hoplon (sibling PEP). Guardrail in `rbaa` mode enforces the same things it enforces today (command, args, env, cwd, recipe inputs) plus the envelope claims.

---

## 3. Prerequisites and Composition

`P0a Universal Authorization Seam` (`docs/plans/PLAN_enterprise_P0a_universal_authorization_seam.md`) is complete in the roadmap tracker and has shipped the current `src/authorization.js` seam. It provides:

- one `authorize(action, facts)` entry point all supervisors and lifecycle gates call
- one normalized decision shape
- one normalized decision-trace shape

This plan evolves P0a's current decision body into a pluggable adapter, where the static-mode adapter is bit-for-bit equivalent to today's authorization, runtime-policy, adapter-auth, approval, and risk-assessment paths. P0a's call-site discipline becomes the runtime guard that mode selection cannot be bypassed.

`P0b Policy Simulation and Decision Traces` (`docs/plans/PLAN_enterprise_P0b_policy_simulation_and_decision_traces.md`) is complete in the roadmap tracker and provides the trace shape the envelope `decisionId` references. The rbaa adapter emits canonical P0b-compatible traces from day one.

`P0c Sovereign Record Metadata Model` (`docs/plans/PLAN_enterprise_P0c_sovereign_record_metadata_model.md`) is complete in the roadmap tracker and provides the record metadata vocabulary used by `policyVersion`, `grantIds`, reviewer identity, and quarantine review records.

Phase 0 therefore does not wait on P0a/P0b/P0c. It verifies the landed surfaces, fills any implementation gaps, and refuses to proceed if the actual code no longer matches those completed roadmap contracts.

### Authorization Action and Outcome Taxonomy

The adapter contract uses the existing `ACTIONS` constants as the starting action taxonomy and adds explicit status semantics so rbaa can represent non-binary outcomes without overloading `allowed: false`.

Actions covered by Phase 0:
- `command.run`
- `recipe.auth`
- `recipe.run`
- `workflow.run`
- `workflow.recipe_step`
- `template.run`
- `lane.start`
- `adapter.run`
- `approval.request`
- `approval.decide`
- `governance.permission`
- `risk.assess`
- `manifest.reuse`
- `auth_mode.set`
- `auth_mode.test`

Normalized adapter result:
```json
{
  "allowed": true,
  "status": "allow | escalate | approval | deny | quarantine",
  "exitCode": 0,
  "code": null,
  "reason": null,
  "decisionId": "p0b-trace-id",
  "policyVersion": "guardrail-static-v1",
  "authMode": "static | rbaa",
  "trace": {},
  "release": null,
  "envIntersection": null,
  "envelope": null
}
```

Status mapping:
- `allow`: proceed; CLI exit code `0`; `allowed: true`.
- `escalate`: pause before execution for a higher-confidence or higher-tier decision; CLI exit code `2`; `allowed: false`.
- `approval`: create or refresh an approval request; CLI exit code `3`; `allowed: false`.
- `deny`: fail closed without quarantine; CLI exit code `1`; `allowed: false`.
- `quarantine`: persist or honor a principal quarantine record, block execution, and emit a P0c audit record; CLI exit code `4`; `allowed: false`.

Static mode may only return `allow`, `approval`, or `deny` unless an existing incident hook has already placed a principal in quarantine. RBAA mode may return all statuses. Existing callers that only understand `allowed` continue to fail closed for every non-allow result during migration.

---

## 4. Boundary Discipline (Same in Both Modes)

The Hoplon TDD's most important architectural rule applies verbatim to Guardrail:

```
Policy and RBAA decide whether Guardrail may issue a capability envelope.
Guardrail mints the envelope.
Guardrail enforces the envelope deterministically.
```

These modules MUST NOT call the `AuthorizationAdapter` or any policy logic, regardless of mode:

- `src/contract.js` — canonical serialization and hashing
- `src/manifest.js` — atomic writes, read-side comparisons
- `src/worker-interface.js` — child process spawning
- `src/validator.js` — result validation, convergence
- `src/audit.js` — hash-chain append (it consumes audit records, never decides them)

These modules are the deterministic kernel. They run after a decision has been made. A test in `tests/test-bucket3.js` (or a dedicated new test) asserts no import of `authz-adapter.js` from any kernel module.

Before designing or placing rbaa enforcement, Phase 0 must inventory every surface that can approve, refresh, authorize, gate lifecycle, write audit, or spawn work. The minimum inventory includes:

- **Approval and risk surfaces:** `src/supervisor.js`, `src/template-supervisor.js`, `src/workflow-supervisor.js`, `src/recipe-supervisor.js`, `src/policy-simulate.js`, `src/recipe-install.js`, `src/recipe-runner.js`, `src/recipe-executor.js`, `src/recipe-channel.js`, `src/recipe-publish.js`, `src/adapter-profile-install.js`, and any CLI command that reads or refreshes an approved manifest.
- **Existing runtime authorization surfaces:** `src/authorization.js`, `src/identity.js`, `src/org-policy.js`, `src/rbac.js`, `src/runtime-policy.js`, `src/agent-session-enforce.js`, `src/agent-session-lifecycle.js`, `src/adapter-auth.js`, and lane/session policy entry points under `src/lane/`.
- **Lifecycle gates:** agent session start/continue/attach/close flows, resident lane start/continue flows, recipe/template/workflow manifest reuse, approval refreshes for interactive inputs, and mode-mismatch checks on manifest reuse.
- **Spawn and execution surfaces:** `src/worker-interface.js`, `src/claude-exec-wrapper.js`, `src/codex-exec-wrapper.js`, `src/openclaw-task-wrapper.js`, `src/claude-resident-lane.js`, `src/local-exec-resident-lane.js`, `src/service-registry.js`, `src/adapter-mcp-stdio-call.js`, `src/adapter-mcp-stdio-probe.js`, and wrapper modules for git/npm/pip/cmux prompt execution.
- **Audit surfaces:** `src/audit.js`, `src/event-schema.js`, `src/metrics.js`, supervisor audit writes, lane/session events, approval queue events, quarantine events, and envelope renewal/revocation events.

The enforcement design cannot stop at "the four supervisors" if this inventory shows another path can authorize or spawn work. Either that path must route through the adapter/envelope boundary, be proven kernel-only, or be explicitly marked out of scope with a failing stop condition before rbaa can activate.

---

## 5. Phases

Phase 0 is a refactor with no behavior change. Phases 1–6 build the new mode. Each phase ends with `npm test` passing. Tests for Mode 2 features run in both modes by default — the static mode test asserts the feature is inert (off), the rbaa mode test asserts the feature is enforced.

### Phase 0 — Adapter Seam Extraction (no behavior change)

Define the typed seam and route every existing call through it. Static-mode adapter wraps today's policy-engine + RBAC + org-policy + approval-queue calls in their current order and returns the same decisions.

Phase 0 starts with the §4 surface inventory. The static adapter scope is not limited to the four supervisors: it also covers approval-time risk calls, approval refresh/reuse checks, lifecycle gates, existing runtime authorization checks, and any non-kernel module that currently imports `policy-engine.js`, `rbac.js`, `org-policy.js`, or `approval-queue.js`.

New files:
- `src/authz-adapter.js` — interface, decision normalization, default error handling. <120 lines.
- `src/authz-static-adapter.js` — wraps existing `policy-engine.js`, `rbac.js`, `org-policy.js`, `approval-queue.js`. <300 lines.
- `src/auth-mode.js` — `resolveAuthConfigRoot(context)` and `resolveAuthMode(context)` return `"static"` or `"rbaa"` from the deployment auth root, not from arbitrary surface-local state. Defaults to `"static"`. Mode is resolved once per process. <120 lines.

Modified files:
- `src/supervisor.js`, `src/template-supervisor.js`, `src/workflow-supervisor.js`, `src/recipe-supervisor.js` — replace direct policy/rbac/approval-queue calls with a single `await adapter.evaluateAccess(req)` per execution boundary. Note: each supervisor is currently 681–1349 lines, well above the 300-line architecture rule; this phase does NOT split them, but Phase 0.5 (optional) may.
- Inventory-derived surfaces from §4 — replace direct approval-time risk evaluation, approval refresh/reuse authorization, lifecycle gate authorization, and existing runtime authorization checks with the same adapter seam where they are policy decisions rather than deterministic comparisons.
- `src/cli.js` — new subcommand `guardrail auth-mode show|set` to read/set the mode at the deployment level.

Tests:
- `tests/test-authz-adapter.js` — interface contract, decision-shape stability, mode resolution, single-call-site discipline (asserts no kernel module imports adapter, asserts no non-adapter module imports policy-engine/rbac/org-policy/approval-queue directly except approved deterministic helpers).
- All existing tests keep passing unchanged. This is the proof that Phase 0 is a no-op refactor.

DoD:
- `npm test` passes.
- The §4 inventory is committed in the plan and reflected in tests before Phase 1 begins.
- `git grep "from './policy-engine.js'" src/` returns only `src/authz-static-adapter.js`, explicit simulation/test-only modules, and existing internal callers within policy-engine itself.
- Approval-time risk calls, approval refreshes, lifecycle gates, and existing runtime authorization checks either route through the adapter or have a written deterministic-kernel justification.
- `auth-mode show` returns `static` on a fresh state directory.

### Phase 1 — Mode Toggle Scaffolding

Wire the mode into every supervisor and audit record. No new authorization behavior yet — just the toggle.

New behavior:
- Every audit entry gains `authMode: "static" | "rbaa"`.
- Every adapter decision gains `authMode` in the trace.
- `auth-mode set rbaa` is wired but remains blocked until the activation gate in Phase 4/Phase 5 is satisfied. Before then, CLI rejects `set rbaa` with an explicit "rbaa activation blocked: envelope enforcement and verifiable identity are not complete" message.
- Auth-mode config is read from the canonical `authConfigRoot`, defined in §6. Existing `stateDir` values remain execution/checkpoint roots and must not be assumed to own deployment auth config.
- Per-environment override (`<authConfigRoot>/environments/<env>/auth-mode.json`) so an operator can run `static` in dev and `rbaa` in prod. This directory is distinct from existing environment definition files such as `<executionStateDir>/environments/<env>.json`.
- Lookup order is deterministic: process-pinned environment override, global auth config, then default `static`; malformed JSON, unknown mode, or ambiguous root fails closed.

Tests:
- `tests/test-mode-toggle.js` — set/get/override; command/template/workflow/recipe surfaces resolve the same root when given the same repo context; mode is recorded on every audit entry; mode-mismatch detection on manifest reuse in both directions (`static` manifests cannot satisfy `rbaa`; `rbaa` manifests/envelopes cannot satisfy `static`).

DoD:
- Audit chain entries include `authMode`.
- Mode resolution is process-immutable: CLI entrypoints and imported module entrypoints call `resolveAuthMode()` once, store `{ authConfigRoot, environmentName, authMode, configVersion }` in process context, and pass that object downward. No downstream module re-reads auth-mode files.
- Static ↔ rbaa manifest reuse is rejected symmetrically; switching modes requires a fresh target-mode handshake or approval.

### Phase 2 — RBAA Primitives (schemas only, not yet wired)

Define the new types and stores. No supervisor changes.

New files:
- `src/risk-band.js` — R0–R4 enum, score thresholds, band-from-score function. Exports a `mapStaticToBand(staticDecision)` helper for cross-mode parity tests. <100 lines.
- `src/autonomy-tier.js` — A0–A5 enum, default-tier-by-role config, runtime-downgrade function. <100 lines.
- `src/authz-decision-taxonomy.js` — canonical statuses (`allow`, `escalate`, `approval`, `deny`, `quarantine`) and exit-code mapping (`0`, `2`, `3`, `1`, `4`). Static mode imports only the `allow`/`approval`/`deny` subset. <100 lines.
- `src/capability-envelope.js` — envelope shape (`tokenId`, `chainId`, `manifestRef: {path, hash}`, `authMode: "rbaa"`, `principalId`, `taskId`, `sessionId`, `capabilities`, `limits`, `risk: {band, tier, controls}`, `policy: {decisionId, policyVersion, grantIds}`, `issuedAt`, `expiresAt`, `previousTokenId`, `replacedByTokenId`, `status`), validation, JSON serialization. Envelope is *not* a JWT in v1 — it is a Guardrail-internal persisted record. Cryptographic signing is deferred to Phase 5 once verifiable identity exists. <220 lines.
- `src/envelope-store.js` — atomic CRUD under `<authConfigRoot>/rbaa/envelopes/<tokenId>.json`; lookup by tokenId; status transitions `active -> renewed|revoked|expired`. Malformed or missing envelope records fail closed. <200 lines.
- `src/envelope-counter-store.js` — atomic counters under `<authConfigRoot>/rbaa/counters/<chainId>.json`; counters are mutable runtime state and never update immutable manifests. <150 lines.
- `src/envelope-revocation-store.js` — atomic revocation records under `<authConfigRoot>/rbaa/revocations/<tokenId>.json`; records include tokenId, decisionId, revokedAt, revokedBy, reason, scope. <150 lines.
- `src/quarantine-store.js` — persistent principal-quarantine records: who, why, decisionId, since, until, reviewer. Atomic writes per manifest convention. <150 lines.
- `src/behavior-window.js` — read events from `metrics.js`, return windowed signals (`scopeDrift`, `repeatedDenials`, `unexpectedTraitFamily`, `requestBreadth`, `confidenceDrop`) over a configured window (default: last 50 operations OR last 24h, whichever is shorter). <200 lines.

Tests:
- `tests/test-rbaa-primitives.js` — band thresholds, tier downgrade rules, taxonomy status/exit mapping, envelope validation, envelope rejects missing claims or non-rbaa mode, quarantine store CRUD + atomicity, behavior-window decay (an old anomaly drops out).
- `tests/test-mode-parity.js` — for a fixed corpus of contracts (re-using `tests/test-policy-scenarios.js` fixtures), assert that `mapStaticToBand(staticDecision)` is consistent with the rbaa adapter's band when implemented in Phase 3. Phase 2 only sets up the corpus; the assertion is empty until Phase 3.

DoD:
- All new modules importable, validate inputs, persist atomically, fail closed on malformed data.
- Envelope, counter, renewal, revocation, and quarantine stores are rooted at `authConfigRoot`; existing manifests carry only stable references (`tokenId`, `chainId`, `decisionId`, `policyVersion`, `manifestRef`) and do not churn on renewal/counter updates.
- Each new file ≤300 lines (architecture rule).

### Phase 3 — RBAAAuthorizationAdapter

Implement the rbaa-mode adapter. Uses primitives from Phase 2.

New file:
- `src/authz-rbaa-adapter.js` — `RBAAAuthorizationAdapter` class. Implements the same `evaluateAccess(request)` interface as the static adapter. Composes:
  1. quarantine check (deny early on quarantined principal)
  2. identity verification (Phase 5 requirement; pre-Phase-5, falls back to declared identity with a warning trait)
  3. risk computation: identity + mission + resource + operation + behavior + environment scores → band
  4. autonomy tier resolution
  5. outcome mapping: R0/R1 → `allow`; R2 → `escalate`; R3 → `approval`; R4 → `quarantine` when a persisted principal block is required, otherwise `deny`
  6. capability envelope minting (allow only)
  7. decisionId + policyVersion stamping
  Approx. 400–500 lines; split into helper modules if it exceeds 300.

Modified:
- `src/auth-mode.js` — can resolve and instantiate the rbaa adapter for tests and dry-runs, but `set rbaa` still fails in normal operation until envelope enforcement and verifiable identity are complete. Phase 3 must not create a half-secure mode where envelopes are minted but not enforced.

Tests:
- `tests/test-rbaa-adapter.js` — for the parity corpus from Phase 2, assert each contract maps to a sane band; assert `allow`/`escalate`/`approval`/`quarantine`/`deny` coverage; assert envelope minted only on `allow`; assert decisionId/policyVersion non-empty; assert status-to-exit-code mapping is stable.
- `tests/test-mode-parity.js` — populated. For a fixed corpus, assert: `static` GREEN ⇒ `rbaa` R0 or R1 (never R2+); `static` RED ⇒ `rbaa` R3 or R4 (never R1 or below). Middle band (R2) is allowed to diverge — that's where the new mode adds escalation granularity.

DoD:
- Both modes produce a decision for every contract in the parity corpus.
- Boundary contracts (the deliberately middle-risk fixtures) are allowed to diverge; extremes must match.
- Quarantined principal in store ⇒ `quarantine` status and exit code 4 on every request, regardless of band.
- `auth-mode set rbaa` still fails outside an explicit test/dry-run harness because Phase 4 enforcement and Phase 5 identity are not yet complete.

### Phase 4 — Envelope Enforcement at the Operation Boundary

Make the envelope load-bearing in rbaa mode. Without this phase, the envelope is an audit veneer.

New behavior:
- Every execution path discovered in the §4 inventory that can spawn or delegate work in rbaa mode loads the persisted envelope by `tokenId` and calls `assertCapabilityEnvelope(envelope, operation)` after manifest/authorization lookup and before spawn/delegation. Checks:
  - `expiresAt` not in the past
  - persisted envelope `status === "active"` and no revocation record exists for `tokenId`
  - `principalId` matches current identity
  - `taskId` matches current task context
  - `manifestRef` matches the approved manifest hash/path used for this operation
  - `capabilities[op].command` allowed; `args` within scope; `env` within allow-list; `cwd` within scope
  - `limits.maxOperations` not exceeded (counter persisted in `envelope-counter-store` by `chainId`)
  - `riskBand` within currently-tolerated band (a renewal handshake may have downgraded an active envelope)

Counter rule: one count is consumed for each attempted worker spawn after envelope assertion and before launch. Retries, workflow steps, recipe steps, and continuation resumes count. Dry-run simulation, denied preflight, and approval prompts do not count because no worker spawn is attempted. Renewals keep the same `chainId`, so `maxOperations` is chain-wide unless a fresh approval explicitly starts a new chain.

New file:
- `src/capability-enforcer.js` — `assertCapabilityEnvelope` plus the per-claim check helpers. <250 lines.

Modified:
- All four supervisors — single `assertCapabilityEnvelope` call site each, inserted between approved-manifest-lookup and worker-spawn.
- Inventory-derived spawn/delegation surfaces (`worker-interface` callers, resident lanes, service registry, MCP stdio adapters, and execution wrappers) either receive an already-verified operation from a supervisor/lifecycle gate or perform their own envelope assertion before spawn/delegation. Kernel-only spawn code remains policy-free but must be unreachable without a verified operation in rbaa mode.

Tests:
- `tests/test-capability-enforcement.js` — expired envelope blocks; missing/malformed envelope record blocks; revoked envelope blocks; principal mismatch blocks; task mismatch blocks; manifestRef mismatch blocks; capability missing blocks; out-of-scope arg/env/cwd blocks; over-limit operations block; band-downgrade-while-active blocks.
- `tests/test-mode-isolation.js` — a manifest minted under `static` is rejected under `rbaa`; a manifest minted under `rbaa` is rejected under `static`; switching modes mid-session forces a fresh handshake.
- Architecture test: every §4 spawn/delegation surface is either listed as kernel-only and unreachable without prior envelope assertion, or has a direct/asserted caller path in rbaa mode.

DoD:
- Every rbaa-mode execution, lifecycle continuation, approval refresh, and delegation path verifies the envelope before spawn/delegation or proves it is deterministic-kernel-only behind a verified caller.
- Static-mode paths are unaffected (no envelope check; current contract-hash check stands).
- `auth-mode set rbaa` remains blocked until Phase 5 identity handling is also present.

### Phase 5 — Verifiable Identity and Trust Tiers (the "+Auth")

Replace declared identity with verifiable identity in rbaa mode.

New behavior:
- Agent identity is presented as a signed assertion (Ed25519 by default; key via `key-management.js`). The identity asserts: principalId, type, roles, trustTier, modelProfile, identityAssurance.
- Delegation chain is a list of signed steps (`human → ceo → cto → swe`). Each signature must verify with a key registered in `key-management.js` for that delegating principal.
- Trust tier is derived from identityAssurance + role registration (`unverified | declared | signed | hardware_backed`). Trust tier feeds the identity-risk score.
- `identity.js` extends with `verifyIdentity(identityAssertion)`, `verifyDelegationChain(chain)`. Static mode continues to accept declared identity.

New files:
- `src/agent-identity-store.js` — registered agent principals with their signing keys (consumed by `verifyIdentity`). <200 lines.
- `src/delegation-chain.js` — signed delegation step format, chain validation. <200 lines.

Modified:
- `src/identity.js` — extend, do not break. Existing strict-mode users keep working in static mode.
- `src/key-management.js` — add scope `"identity"` for agent signing keys.
- `src/authz-rbaa-adapter.js` — wire `verifyIdentity` + `verifyDelegationChain` into the identity-risk component; bind `principalId` from the verified assertion (not the request) into the envelope.

Tests:
- `tests/test-verifiable-identity.js` — unsigned identity in rbaa mode → R3/R4 (declared-identity warning); signed identity verifies; tampered signature rejects; replayed assertion (same nonce) rejects; broken delegation chain rejects.

DoD:
- rbaa mode rejects requests where the principal is not cryptographically verifiable, OR routes them through R3 approval with an `identity_unverified` trait.
- Envelope `principalId` derives from the verified assertion, not the request payload.
- Static mode is unchanged.

### Phase 6 — Continuous Re-evaluation

Wire the renewal/expansion/anomaly loop.

New behavior:
- TTL renewal: when an envelope is within 10% of expiry and the supervisor needs to keep working, re-evaluate. New envelope replaces old (same `taskId`, fresh `decisionId`).
- Scope expansion: any operation outside the current envelope's capability scope triggers a fresh handshake instead of a deny — but only if the policy allows scope expansion for the current band.
- Behavior anomaly: `behavior-window.js` exposes a `wasAnomalousSince(t)` helper. The supervisor calls it before each operation; on true, mark envelope `anomaly_pending`, force re-evaluation.
- Environment change: `EnvironmentRiskFeed` (currently a stub; can be a polled JSON file in v1) bumps environment risk on incident, freeze, or policy-bundle change. Active envelopes become subject to forced re-evaluation.
- Local revocation: revocation records under `<authConfigRoot>/rbaa/revocations/`, checked on every enforcement. Revoked envelopes fail enforcement immediately; malformed revocation state fails closed.
- Renewal state: the old envelope is atomically marked `renewed` with `replacedByTokenId`; the new envelope keeps the same `chainId`, records `previousTokenId`, and writes a JSONL event to `<authConfigRoot>/rbaa/renewals/<chainId>.jsonl`. A broken renewal chain blocks the next operation instead of falling back to the old envelope.

New files:
- `src/envelope-renewal.js` — renewal/expansion logic, no policy decisions of its own. Calls back into the rbaa adapter. <200 lines.
- `src/environment-risk-feed.js` — polled JSON file consumer; emits a `RuntimeRiskEvent` to subscribers (the rbaa adapter and supervisors). <150 lines.

Modified:
- All enforcement-covered paths from §4 — call `envelope-renewal` before each operation; honor renewal outcomes; on revocation, terminate the run with a clear audit entry.

Tests:
- `tests/test-continuous-rbaa.js` — TTL expiry triggers renewal; scope expansion outside envelope triggers handshake (allow if policy permits, escalate otherwise); revocation record invalidates envelope mid-run; malformed revocation/renewal state fails closed; environment risk bump downgrades active envelope.

DoD:
- An rbaa-mode workflow with a 60-second envelope TTL completes a 5-minute task via renewals.
- A revoked envelope cannot complete a pending operation.
- A behavior anomaly mid-run forces re-evaluation before the next operation.
- Counter state survives renewal and blocks once the chain-level operation limit is reached.

### Phase 7 — External Policy Adapter (DEFERRED — not in v1)

OPA-equivalent or other external policy bundle support. Out of scope for the initial RBAA+Auth release. When implemented, it slots behind the same `AuthorizationAdapter` interface as `OpaAuthorizationAdapter` and consumes versioned policy bundles.

Phase 7 is not required to activate `rbaa`; the activation gate is envelope enforcement plus identity handling. Until Phase 7 lands, "Hoplon-compatible" claims must be qualified: Mode 2 v1 implements the *vocabulary and runtime model* of RBAA; external policy-bundle compatibility is a follow-up.

---

## 6. Configuration

The auth-mode root is explicit because command, template, workflow, recipe, lane, adapter, and test surfaces use different `stateDir` meanings today.

- Canonical config root: `authConfigRoot`, a deployment-level directory resolved once before any adapter or supervisor runs.
- Repo-scoped default: `<repo>/.guardrail/auth/`, where `<repo>` is the resolved Guardrail project/repo root, not the template/workflow definition directory unless that is also the project root.
- Host/lane default: `<hostStateDir>/auth/` only for resident-lane and portfolio operations that already receive a host state directory.
- Test/managed override: `GUARDRAIL_AUTH_ROOT`, allowed only when it resolves inside an approved Guardrail state area.
- Execution state remains separate: existing `stateDir` values such as `cwd/.guardrail`, `dirname(templatePath)/.guardrail`, `dirname(workflowPath)/.guardrail`, and `resolvedCwd/.guardrail` continue to hold checkpoints, logs, manifests, and audit writes. They do not own auth-mode config unless they are also the resolved `authConfigRoot`.
- Per-environment override root: `<authConfigRoot>/environments/<env>/`, where `<env>` comes from `GUARDRAIL_ENV`, `<executionStateDir>/current-env`, or default `dev` via `getCurrentEnv()`. Workflow inputs cannot select the auth environment.

```
<authConfigRoot>/auth-mode.json                    # global default
<authConfigRoot>/environments/<env>/auth-mode.json # per-environment override
<authConfigRoot>/rbaa/envelopes/<tokenId>.json     # active envelope record
<authConfigRoot>/rbaa/counters/<chainId>.json      # chain-wide operation counters
<authConfigRoot>/rbaa/revocations/<tokenId>.json   # local revocation marker
<authConfigRoot>/rbaa/renewals/<chainId>.jsonl     # renewal/expansion history
<authConfigRoot>/rbaa/quarantine/<principalId>.json # principal quarantine state
```

Format:
```json
{
  "mode": "static" | "rbaa",
  "set_at": "2026-05-04T...",
  "set_by": "<actor>",
  "rbaa": {
    "default_ttl_seconds": 900,
    "behavior_window": { "max_operations": 50, "max_age_seconds": 86400 },
    "policy_bundle_path": null,
    "environment_risk_feed": null
  },
  "exit_codes": {
    "allow": 0,
    "deny": 1,
    "escalate": 2,
    "approval": 3,
    "quarantine": 4
  }
}
```

Envelope records are sibling state, not manifest fields. They are load-bearing in rbaa mode: every operation reads the active envelope from `rbaa/envelopes/`, increments or validates chain counters from `rbaa/counters/`, checks `rbaa/revocations/`, and appends renewal/expansion decisions to `rbaa/renewals/`. Manifests retain the contract hash and approval identity plus stable envelope references; envelopes bind that approval to a short-lived runtime grant.

CLI:
- `guardrail auth-mode show` — current mode and rbaa config (if any).
- `guardrail auth-mode set <static|rbaa> [--env <name>]` — set global or per-env.
- `guardrail auth-mode test <contract.json>` — dry-run the active adapter against a contract; print the adapter status, mapped exit code, trace, and (in rbaa) the envelope it would mint. Useful for migration.

Mode is **process-immutable**: `authConfigRoot`, environment name, config version, and mode are resolved once at CLI/supervisor/lifecycle entry, included in every audit entry and decision trace, and passed down as values. Imported module usage must accept this resolved context instead of calling `resolveAuthMode()` internally. Mid-process mode changes are not honored — the new mode applies on next invocation.

---

## 7. What Stays the Same in Both Modes

These modules are unchanged by either mode:
- `src/contract.js` — canonical serialization (`serializeStable`), hashing.
- `src/manifest.js` — atomic writes, diff, comparison.
- `src/workflow.js`, `src/template.js`, `src/recipe.js` — definition loading, validation, hashing.
- `src/worker-interface.js` — child process spawning, but only after rbaa callers have produced a verified operation.
- `src/validator.js` — result validation.
- `src/audit.js` — hash-chain append (consumes records; doesn't decide).
- All four invariants (fail closed, canonical determinism, no bypass surface, immutable approval, scope can only narrow) apply to both modes.

The kernel-vs-policy boundary (Hoplon TDD §2) is now a runtime invariant Guardrail honors explicitly, not just by convention. Spawn modules may remain policy-free only if the §4 inventory proves they are unreachable without a prior adapter decision and, in rbaa mode, a load-bearing envelope assertion.

---

## 8. Migration

Manifests and envelopes are **mode-scoped**. A manifest minted under `static` mode is not automatically valid in `rbaa` mode, and an rbaa envelope is never honored under `static`. Switching modes requires a fresh target-mode handshake or approval. Rationale:

- Static manifests lack `decisionId`, `policyVersion`, `riskBand`, `autonomyTier`, `expiresAt` — backfilling these would require re-deciding, which is what the handshake does anyway.
- Auto-migration would silently assign default risk bands; if a default is wrong, the operator never learns.

The `auth-mode set rbaa` CLI command prints a clear notice: "Existing static manifests will require fresh approval under rbaa." The reverse command prints: "Existing rbaa envelopes will not be honored under static; static approval must exist or be re-created." A `--dry-run` flag previews which active manifests would need re-approval in the target mode.

No automatic backfill is allowed in either direction. A migration helper may precompute candidate approvals from the shared contract hash, but it must write new target-mode records with a new decision trace instead of mutating existing records.

---

## 9. Adversarial Self-Review

Per `CLAUDE.md` mandate, ways this plan can fail silently. At least two are structural.

1. **[Structural] Mode-selection drift across processes.** Mode is read from a file, but if it is read at multiple call sites, two concurrent executions could land on different sides of a config flip. Result: same agent, same task, mixed decisions; audit chain looks coherent, behavior is not. **Mitigation:** `resolveAuthMode()` is called exactly once per process entry; `{ authConfigRoot, environmentName, authMode, configVersion }` is captured in a process-local context; every audit entry records the context; a test asserts that no module reads `auth-mode.json` outside `auth-mode.js`.

2. **[Structural] Adapter seam used inconsistently.** Phase 0 routes only the obvious supervisors, but recipe install, recipe runner/executor, adapter profile install, lane lifecycle, workflow approval refresh, session lifecycle, policy simulation, or existing runtime authorization modules keep direct policy/RBAC/org-policy/approval calls. Mode 2 silently does not apply to those paths. **Mitigation:** Phase 0 must complete the §4 inventory first. `tests/test-authz-adapter.js` asserts that no non-adapter module imports `policy-engine.js`, `rbac.js`, `org-policy.js`, or `approval-queue.js` except explicit simulation/test-only allowances and documented deterministic helpers. Runtime lifecycle guards route pre-handshake operations through the adapter.

3. **[Structural] Envelope claims minted but unenforced.** An envelope with TTL/scope/limits is created but `worker-interface.js`, resident lanes, service registry, MCP stdio adapters, or execution wrappers still spawn based on a manifest, session, or wrapper input. Envelope semantics are an audit veneer. **Mitigation:** Phase 4 inserts `assertCapabilityEnvelope` before every spawn/delegation path discovered in §4, or documents that the path is deterministic-kernel-only behind a verified caller. Tests prove expired, mismatched, over-limit, and out-of-scope envelopes block.

4. **[Structural] Risk-model drift across the codebase.** Today the codebase already has TWO risk vocabularies: `policy-engine.js` (GREEN/YELLOW/RED) and `risk-traits.js` (allow/flag/block). Adding R0–R4 makes three. They will diverge on edge cases, and operators will not know which is "the" answer. **Mitigation:** Phase 2 defines the canonical mapping `mapStaticToBand()`; both modes read from one normalization layer; the parity corpus (Phase 2 test) regresses on divergence at the extremes (GREEN ⇒ R0/R1, RED ⇒ R3/R4). Middle-band divergence is allowed and documented as the new mode's added granularity. Long-term, traffic light is deprecated in favor of bands; near-term, both coexist with a clear mapping.

5. **[Structural] Behavior telemetry windowless or unbounded.** Mode 2 reads metrics for behavior-risk; if metrics aren't time-windowed, an agent that had a six-month-old anomaly stays quarantined forever. Risk grows monotonically and never decays. **Mitigation:** `behavior-window.js` enforces `last N operations OR last T hours, whichever is shorter`; defaults are explicit (50 ops / 24 h); a test in `tests/test-rbaa-primitives.js` asserts that a fresh agent enters at zero behavior risk and an aged anomaly drops out of the window.

6. **False-resolution / Hoplon-compat overclaim.** Calling Mode 2 "Hoplon-compatible" before Phase 7 (external policy bundles) is built. Operators expecting OPA bundle support get a closed-off implementation. **Mitigation:** Phase 7 is explicitly out of v1 scope; release notes for v1 say "RBAA-vocabulary internal adapter; Hoplon interop is a follow-up"; `auth-mode show` does not advertise Hoplon compatibility.

7. **[Structural] Half-secure rbaa activation.** Phase 3 could let `auth-mode set rbaa` succeed after the adapter mints envelopes but before Phase 4 enforcement or Phase 5 identity binding exists. Operators would believe rbaa is active while the system still trusts declared identity or unenforced envelope claims. **Mitigation:** `set rbaa` stays blocked until both activation prerequisites are complete. Tests assert the command fails after Phase 3 and Phase 4, and succeeds only once identity handling is present.

8. **[Structural] Ambiguous auth root.** Existing surfaces derive `stateDir` from different places (`cwd`, template path, workflow definition path, recipe cwd, host state). If `auth-mode.json` follows each local `stateDir`, one repo can have conflicting modes. **Mitigation:** §6 defines one `authConfigRoot`, keeps execution state separate, and tests root resolution across command/template/workflow/recipe/lane surfaces.

9. **[Structural] Envelope state not load-bearing.** Envelopes, operation counters, revocations, and renewals can be documented but not consulted on the hot path, or they can churn immutable manifests. **Mitigation:** Phase 2 adds dedicated stores under `authConfigRoot`; Phase 4 enforcement reads envelope/counter/revocation state before spawn; Phase 6 renewal updates envelope state atomically and preserves `chainId` counters.

Confidence in this plan: 0.62. Assumptions: (a) the already-landed authorization seam, simulation traces, and sovereign metadata remain stable enough to extend; (b) the §4 inventory can classify every approval/lifecycle/spawn path without forcing a large supervisor/lane refactor. Weakest link: Phase 4 envelope enforcement — if any spawn or lifecycle fast path bypasses `assertCapabilityEnvelope`, Mode 2 is cosmetic. The grep-based architecture test is necessary but not sufficient; pair it with runtime coverage over each inventory item.

---

## 10. Open Questions (Decide Before Phase 3)

1. **Score computation location** — resolved for v1: the rbaa adapter layers band semantics on top of the landed static signals and adds runtime feedback. It must not fork trait detection.
2. **Envelope persistence** — resolved for v1: use sibling stores under `<authConfigRoot>/rbaa/` (`envelopes`, `counters`, `revocations`, `renewals`), because envelopes are short-lived and renewal/counter updates would otherwise churn manifest records.
3. **Default rbaa TTL** — 900s (Hoplon TDD R0_LOW default) or shorter? Recommended: 900s for R0/R1; 300s for R2; 180s for R3 — match the Hoplon table verbatim so cross-system audit correlation is trivial.
4. **Identity assurance enrollment** — where does the agent signing key come from on first run? Recommended: explicit `guardrail identity register --principal <id> --key <path>` step; rbaa mode refuses to issue envelopes for unregistered principals.
5. **Per-mode test isolation** — resolved for v1: tests are mode-aware; a wrapper in `tests/test-mode-parity.js` runs the parity corpus across both modes; per-feature tests state their mode explicitly.

---

## 11. Out of Scope

- File-level / AST-level scope enforcement (that's Hoplon's job; Guardrail composes alongside, not in place of).
- OPA / Cedar / external policy-bundle integration (Phase 7 deferred).
- Hosted policy storage or policy admin UI.
- Network-level mTLS for agent identity (signed assertions only in v1; mTLS is a deployment concern).
- Cryptographically signed envelopes (Phase 3 envelopes are persisted records; signing comes after Phase 5 identity hardening).
- Splitting the four 681–1349-line supervisors below the 300-line architecture rule (separate refactor).

---

## 12. Definition of Done (Plan-Level)

- `npm test` passes in both modes.
- `auth-mode show` works on a fresh checkout and defaults to `static`.
- A clean install in `static` mode behaves identically to today (parity corpus regression).
- The §4 inventory is complete and every audit, approval, lifecycle, authorization, and spawn/delegation surface is covered by adapter/envelope enforcement, proven deterministic-kernel-only behind a verified caller, or explicitly documented out of scope.
- `auth-mode set rbaa` is blocked until load-bearing envelope enforcement and identity handling are present, then activates the new mode end-to-end: handshake → verified identity → envelope → enforcement → renewal → quarantine on anomaly.
- A signed identity is required for rbaa-mode handshake (or the request is routed through R3 approval with an explicit trait).
- Every audit entry records `authMode`, `decisionId`, `policyVersion`, and (in rbaa) `riskBand`, `autonomyTier`, `tokenId`.
- Every rbaa envelope has persisted envelope/counter/revocation/renewal state rooted at `authConfigRoot`; malformed or missing state fails closed before spawn.
- The kernel-boundary test asserts no kernel module imports the adapter.
- The architecture invariant test asserts no module outside the adapters or explicit simulation/test-only allowances imports `policy-engine.js`, `rbac.js`, `org-policy.js`, or `approval-queue.js`.
- `docs/technical-status.md` lists Mode 2 with its phase status.
- `docs/issues.md` has a numbered entry for any deviation discovered during implementation.

Implementation sign-off checklist before coding starts:
- P0a/P0b/P0c assumptions are current: the plan extends existing `authorization.js`, simulation traces, and sovereign audit metadata rather than inventing parallel seams.
- Adapter contract covers approval handshake, runtime operation, recipe auth preflight, lane/session lifecycle, adapter preflight, and simulation outcomes.
- Static/rbaa migration is symmetric and test expectations match it.
- §4 inventory covers audit append paths and spawn/delegation paths beyond the four supervisors.
- `authConfigRoot`, per-environment override root, and process immutability are signed off for command/template/workflow/recipe/lane/imported-module usage.
- Phase 0 includes approval-time risk calls, not only runtime authorization checks.
- `auth-mode set rbaa` remains blocked until envelope enforcement and identity handling are load-bearing.
- Envelope, counter, renewal, and revocation stores have explicit paths, keys, and fail-closed malformed-data behavior.
- Any accepted deviation is recorded in `docs/issues.md` or `docs/technical-status.md` before implementation proceeds.

---

## 13. Stop Conditions

Halt and reconcile before proceeding if:

- Any inventory item from §4 still routes a policy/approval/runtime authorization decision around the adapter seam after Phase 0.
- Any command/template/workflow/recipe/lane surface resolves auth mode from a surface-local `stateDir` instead of the process-pinned `authConfigRoot`.
- Mode 1 behavior diverges from pre-Phase-0 behavior on the parity corpus.
- An envelope is mintable without a corresponding `decisionId` and `policyVersion`.
- An envelope is mintable without `chainId`, `manifestRef`, persisted envelope state, and initialized counter state.
- `auth-mode set rbaa` can succeed before envelope enforcement and verifiable identity handling are both present.
- A static-mode manifest can satisfy an rbaa-mode handshake (or vice versa).
- Any rbaa-mode spawn/delegation path can run without a prior envelope assertion, unless it is documented as deterministic-kernel-only and proven reachable only from a verified caller.
- Missing or malformed envelope, counter, renewal, revocation, quarantine, or environment-risk state is ignored instead of failing closed.
- Renewal resets operation counters without a fresh explicit approval.
- Envelope `principalId` can be populated from a request payload instead of a verified identity assertion.
- The kernel modules acquire any import of the adapter.
- Behavior telemetry is read without a window.
- v1 release notes claim Hoplon interop without Phase 7.

---

## 14. Reference Documents

- Hoplon Dynamic RBAA TDD v1.2 — `/Users/adilevinshtein/Documents/publishing/Desiign Docs/hoplon_dynamic_rbaa_tdd_v1_2.md` (framework source for risk bands, autonomy tiers, capability envelope, kernel boundary rule, audit correlation fields).
- Hoplon Implementation Brief — `/Users/adilevinshtein/Documents/dev/Hoplon/policy_prompt.md` (for AuthorizationAdapter interface shape, OPA input/output schema, policy precedence).
- Phalanx Implementation Brief — `/Users/adilevinshtein/Documents/dev/Project-Phalanx/policy_prompt.md` (for capability request normalization, token broker pattern, escalation request flow — Guardrail plays the analogous role for command/workflow/recipe operations).
- Guardrail P0a — `docs/plans/PLAN_enterprise_P0a_universal_authorization_seam.md` (the seam this plan extends).
- Guardrail P0b — `docs/plans/PLAN_enterprise_P0b_policy_simulation_and_decision_traces.md` (decision trace shape).
- Guardrail P0c — `docs/plans/PLAN_enterprise_P0c_sovereign_record_metadata_model.md` (sovereign record metadata; envelope `policy.*` fields align here).
