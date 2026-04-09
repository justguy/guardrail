# Guardrail — Pickup Tasks For Four Open Items

Status: Draft pickup plan for roadmap items `D0i`, `D0j`, `A0g`, and adapter-system hardening work across `A0a`–`A0e`  
Audience: Maintainers or coding agents preparing the next implementation batch  
Goal: Turn four open areas into bounded, handoff-ready task slices with clear sequencing, likely file ownership, and acceptance criteria

## Scope

This plan covers the four highest-signal open areas called out in `docs/technical-status.md`:

1. bounded approval reuse / range-based reuse
2. workflow outputs and typed shared state
3. agent session contracts and resumable named runs
4. adapter hardening and MCP follow-through

This is a planning document only. It does not change roadmap status by itself.

## Recommended Execution Order

1. bounded approval reuse / range-based reuse
2. workflow outputs and typed shared state
3. agent session contracts and resumable named runs
4. adapter hardening and MCP follow-through

Reasoning:

- approval semantics should settle before later workflow or session features depend on them
- typed workflow state is the cleanest way to carry session identifiers or service handles between steps
- agent-session work should reuse workflow-state machinery instead of inventing another ad hoc transport
- adapter hardening can run partly in parallel, but MCP runtime support should not ship until the current adapter contract is fully hardened and test-proven

## Parallelization / Spark Delegation Note

These four tracks can be split across separate implementation workers if ownership is explicit:

- Worker 1: approval-envelope semantics
  Files: `src/template-supervisor.js`, `src/recipe-supervisor.js`, `src/manifest.js`, `src/shared-manifest.js`, template/recipe tests
- Worker 2: workflow state and outputs
  Files: `src/workflow.js`, `src/workflow-supervisor.js`, new workflow-state helper if needed, workflow tests
- Worker 3: agent session contracts
  Files: `src/claude-exec-wrapper.js`, `src/codex-exec-wrapper.js`, AI recipes, new session helper if needed, recipe/integration tests
- Worker 4: adapter hardening
  Files: `src/adapter-*.js`, `src/adapter-profiles/*.json`, adapter tests

Collision warning:

- avoid parallel edits to `src/manifest.js`, `src/shared-manifest.js`, `src/workflow.js`, or `tests/test-integration-runtime.js` unless one worker is designated as the integrator
- if Workers 2 and 3 both need workflow-state changes, land Worker 2 first and rebase Worker 3 on top

---

## Track 1 — Bounded Approval Reuse / Range-Based Reuse

Roadmap anchors:

- `Bounded parameter approvals` in Template System Gaps
- `Range-based recipe approvals` in Bucket 4 Gaps
- `D0j` in the roadmap

### Objective

Guardrail already validates template and recipe inputs against schemas, but approval reuse still binds to exact resolved values. This track adds a bounded approval envelope so safe changes inside an approved subset or range do not force needless reapproval.

### Implementation update

- Status: Landed. Bounded reuse now compares non-interactive candidate inputs to approved envelopes for deterministic schema-constrained inputs.
- Files touched in this track include `src/template.js`, `src/recipe.js`, `src/template-supervisor.js`, and `src/recipe-supervisor.js`.
- Regression coverage includes `tests/test-template.js`, `tests/test-recipe.js`, and workflow-mode/recipe-template runtime scenarios in `tests/test-integration-runtime.js`.

### Current Gap
	
Today:

- non-deterministic or prompt-like input forms are still exact-match only
- shell-like inputs and unsupported input shapes remain outside bounded reuse
- explicit `review_each_time`/`never_reuse` inputs and missing envelope derivation still force approval

### Recommended V1 Design Choices

1. Preserve exact-value approval as the default.
2. Only allow bounded reuse when the schema or recipe/template input definition can be reduced to a deterministic safe envelope.
3. Keep `review_each_time`, `never_reuse`, and `content_hash` semantics stronger than any bounded envelope.
4. Persist the approved envelope explicitly in the manifest so drift reporting stays honest and machine-readable.
5. Reject or fall back to exact-value binding for ambiguous input shapes rather than widening silently.

### Likely Files

- `src/template.js`
- `src/template-supervisor.js`
- `src/recipe.js`
- `src/recipe-supervisor.js`
- `src/manifest.js`
- `src/shared-manifest.js`
- `tests/test-template.js`
- `tests/test-recipe.js`
- `tests/test-integration-runtime.js`
- `tests/test-feature-acceptance.js`

### Task Breakdown

#### Phase 1 — Approval-envelope model

Tasks:

- define a normalized approval-envelope shape for safe bounded inputs
- support the smallest clean set first:
  - enum / allowed-values subsets
  - numeric min/max ranges
  - bounded array membership where item schema is already allowlisted
  - path subsets only when they are already reduced to rooted relative paths or explicit allowlists
- add stable serialization and diff helpers for envelope-vs-exact approval material

#### Phase 2 — Template reuse semantics

Tasks:

- teach template approval and reuse logic to compare candidate inputs against an approved envelope when one exists
- ensure `requires_env`, explicit allow-lists, and prompt-bearing inputs still use the stronger existing rules
- surface `approval_required` instead of false-success reuse when a candidate escapes the approved envelope

#### Phase 3 — Recipe reuse semantics

Tasks:

- mirror the same envelope logic in recipe approval and reuse
- ensure recipe manifests remain deterministic across pinned recipe versions and resolved input normalization
- keep `review_each_time` inputs non-reusable even if the value is inside a reusable envelope

#### Phase 4 — UX and regression coverage

Tasks:

- approval summary must show the approved envelope, not just one sample value
- JSON/machine-readable results must distinguish:
  - exact match reuse
  - bounded-envelope reuse
  - out-of-envelope approval required
  - true drift
- add regression tests for safe reuse, out-of-range rejection, and envelope serialization stability

### Acceptance Criteria

- bounded numeric or enum changes can reuse approval only when they remain inside the approved envelope
- unchanged prompt-bearing or content-hash-bound inputs do not become reusable just because another field gained envelope support
- non-interactive runs fail closed when a value leaves the approved envelope
- manifest diff output makes it obvious whether the candidate is out of bounds or simply different

### Non-Goals

- do not add arbitrary expressions or policy scripting to approval logic
- do not weaken `review_each_time`
- do not treat shell-mode inputs as bounded-safe by default

---

## Track 2 — Workflow Outputs And Typed Shared State

Roadmap anchor:

- `D0i` in the roadmap

### Objective

Workflows currently need helper scripts or temp files when one step produces data that later steps must consume. This track adds bounded, typed state and explicit output wiring between steps.

### Implementation update

- Status: Landed. Workflows now support typed output publication and shared-state reference resolution for `task` and `recipe_ref` producers.
- Files touched in this track include `src/workflow.js`, `src/workflow-supervisor.js`, and test updates in `tests/test-workflow.js` plus shared-state integration paths in `tests/test-integration-runtime.js`.
- Runtime checks now fail closed on missing outputs, output type mismatch, and recipe input schema violations derived from state references.

### Current Gap

Today:

- shared outputs are produced for `task` and `recipe_ref` only
- service lifecycle or other non-typed producers still need explicit handoff logic
- bounded consumption still applies only through supported, typed workflow input fields

### Recommended V1 Design Choices

1. Add explicit step outputs and shared workflow state instead of generic string templating.
2. Only allow extraction from bounded machine-readable step results, not arbitrary stdout scraping.
3. Keep interpolation limited to structured fields already accepted by workflow step schemas.
4. Start with a small type set:
   - `string`
   - `number`
   - `boolean`
   - `json`
5. Persist the declared output wiring in normalized workflow definitions and manifests.

### Likely Files

- `src/workflow.js`
- `src/workflow-supervisor.js`
- new helper such as `src/workflow-state.js`
- `src/service-registry.js` only if service lifecycle steps expose structured handles
- `tests/test-workflow.js`
- `tests/test-integration-runtime.js`
- `tests/test-feature-acceptance.js`

### Task Breakdown

#### Phase 1 — State contract and normalization

Tasks:

- define a workflow-level shared-state model
- define per-step output declarations with explicit type and source path
- normalize and validate output declarations during workflow lint/load, not mid-execution
- reject ambiguous or cyclic references between steps

#### Phase 2 — Producer side

Tasks:

- allow supported step types to publish outputs from bounded machine-readable results
- start with the step types that already have structured results:
  - `task`
  - `recipe_ref`
  - service lifecycle steps only if their runtime already emits stable structured fields
- persist emitted outputs into runtime shared state with type validation

#### Phase 3 — Consumer side

Tasks:

- allow later steps to reference shared state in structured input fields
- resolve references before execution and validate the resolved value against the destination input schema
- fail closed when a referenced value is missing, mistyped, or would violate the destination bounds

#### Phase 4 — Approval, audit, and drift semantics

Tasks:

- store declared output wiring in normalized workflow manifests
- ensure approval stays bound to the workflow structure, not to unpredictable runtime values
- add audit/log visibility for:
  - which step emitted a value
  - which later step consumed it
  - the value type, without leaking sensitive content unnecessarily

### Acceptance Criteria

- a workflow can carry a bounded structured value from one step to another without helper scripts
- invalid references fail before the consumer step executes
- workflow approval remains honest: structure is approved, runtime-produced values are still bounded by type and destination schema
- regression coverage includes missing-output, wrong-type, and cross-step happy-path cases

### Non-Goals

- do not add general shell templating
- do not parse raw terminal output heuristically
- do not support arbitrary user-defined code transforms in V1

---

## Track 3 — Agent Session Contracts And Resumable Named Runs

Roadmap anchor:

- `A0g` in the adapter-system roadmap

### Objective

Current AI recipes are single-shot wrappers. This track adds explicit session contracts so Guardrail-managed agent runs can create, resume, or attach to named sessions without falling back to uncontrolled local CLI state.

### Current Gap

Today:

- `claude-exec` and `codex-exec` are bounded wrappers for one-shot execution
- there is no approved session artifact describing how an agent run may be resumed
- long-lived local agent state can drift outside Guardrail visibility

### Recommended V1 Design Choices

1. Separate session-lifecycle approval from prompt approval.
2. Require explicit lifecycle intent such as `start`, `continue`, or `attach`; never auto-resume implicitly.
3. Bind session contracts to stable fields:
   - tool
   - working directory
   - allowed execution scope
   - wrapper version / recipe version
   - session name or ID
4. Keep prompt-bearing inputs under existing `review_each_time` or content-hash rules.
5. Make session IDs first-class structured outputs so workflows can pass them forward using Track 2 machinery.

### Likely Files

- `recipes/claude-exec.recipe.json`
- `recipes/codex-exec.recipe.json`
- `src/claude-exec-wrapper.js`
- `src/codex-exec-wrapper.js`
- new helper such as `src/agent-session.js`
- `src/recipe-supervisor.js`
- `src/shared-manifest.js`
- `tests/test-claude-recipe.js`
- `tests/test-codex-recipe.js`
- `tests/test-integration-runtime.js`

### Task Breakdown

#### Phase 1 — Session contract model

Tasks:

- define the bounded session artifact / manifest shape
- define allowed lifecycle operations and their preconditions
- define when a missing session is:
  - a hard error
  - a new approval requirement
  - a recoverable create-and-continue path

#### Phase 2 — Wrapper support

Tasks:

- teach `claude-exec` and `codex-exec` wrappers to accept explicit session lifecycle inputs
- emit structured session results, including the created or attached session identifier
- ensure wrappers never silently attach to an unrelated local session

#### Phase 3 — Approval and drift rules

Tasks:

- bind approval to the session contract fields listed above
- require fresh approval when a run attempts to:
  - switch tool
  - switch working directory
  - widen scope
  - attach to a different named session
- keep prompt-specific reapproval behavior unchanged

#### Phase 4 — Workflow integration and tests

Tasks:

- wire session identifiers into workflow outputs/shared state once Track 2 exists
- add coverage for:
  - first session creation
  - continue on same session
  - attach mismatch rejection
  - non-interactive reuse with unchanged contract

### Acceptance Criteria

- Guardrail can manage a named agent session without relying on opaque ambient local state
- session reuse is explicit and approval-bounded
- prompt-bearing turns do not silently inherit broader reuse rights
- workflow runs can carry a session identifier forward in a structured way

### Non-Goals

- do not implement fully generic multi-tool session brokering in V1
- do not rely on undocumented behavior from external AI CLIs
- do not make session attachment implicit

---

## Track 4 — Adapter Hardening And MCP Follow-Through

Roadmap anchors:

- partial items `A0a` through `A0e`
- blocked MCP path called out in `README.md`, `docs/agent-onboarding.md`, and `docs/technical-status.md`

### Objective

The adapter system exists and works for `stdin-json` and `env-shim`, but the public contract, trust surface, and end-to-end proof are still partial. This track hardens the current adapter surface first, then defines the clean path to future MCP transport support without pretending it is already safe.

### Current Gap

Today:

- adapter runtime, translation, auth preflight, and bundled profiles exist
- public proof is still partial across contract hardening, trust policy, and real-tool coverage
- `mcp` profiles are recognized but intentionally blocked at CLI level
- `cline` remains a blocked placeholder until transport support exists

### Recommended V1 Design Choices

1. Do not ship runnable MCP adapter support in the same slice as basic contract hardening.
2. Harden current `stdin-json` and `env-shim` behavior first.
3. Keep the MCP gate explicit until transport, approval, trust, and auth semantics are fully designed and tested.
4. Treat `cline` as a policy boundary artifact, not as a half-enabled runtime.
5. Prefer end-to-end contract proofs over additional surface area.

### Likely Files

- `src/adapter-engine.js`
- `src/adapter-cli.js`
- `src/adapter-profile.js`
- `src/adapter-extract.js`
- `src/adapter-auth.js`
- `src/adapter-stdin.js`
- `src/adapter-shim.js`
- `src/adapter-profiles/openclaw.json`
- `src/adapter-profiles/aider.json`
- `src/adapter-profiles/cline.json`
- `tests/test-adapter.js`
- `tests/test-integration-runtime.js`
- `tests/test-gap-closure.js`

### Task Breakdown

#### Phase 1 — Current adapter contract hardening

Tasks:

- audit and stabilize the `adapter-result/v1` surface
- ensure every blocked or failed path returns stable machine-readable reasons
- tighten clipping / bounded output guarantees so adapters never depend on unbounded stdout or stderr
- add end-to-end tests proving parity between supervisor results and adapter-normalized results

#### Phase 2 — Trust and installation proof

Tasks:

- strengthen tests around GitHub/path profile install, pin metadata, and trust-policy enforcement
- prove bundled profile behavior for `openclaw` and `aider` end to end
- ensure error paths stay specific when auth mapping, trusted source, or profile shape is wrong

#### Phase 3 — MCP follow-through design gate

Tasks:

- define the minimum transport contract required before `mcp` stops being CLI-blocked
- specify how approval, trust, and auth preflight interact with a long-lived MCP transport
- specify whether `cline` remains a bundled profile or moves behind a separate feature gate until transport is ready
- write the blocking tests first so the repo clearly distinguishes:
  - recognized but blocked MCP
  - invalid profile
  - future supported MCP transport

#### Phase 4 — MCP implementation slice, only after the gate is settled

Tasks:

- add the actual transport/runtime only once the contract from Phase 3 is agreed
- keep the implementation bounded to a clearly testable minimal transport
- add explicit end-to-end proof for approval, drift, auth preflight, and blocked-path behavior

### Acceptance Criteria

- current `stdin-json` and `env-shim` adapters have stable, well-tested machine-readable results
- bundled profile install and execution paths are proven end to end
- MCP remains honestly blocked until transport support is fully designed and landed
- when MCP support eventually lands, it does so behind dedicated transport tests rather than by weakening the current gate

### Non-Goals

- do not silently partially enable `cline`
- do not widen adapter profile power beyond pure-data profiles
- do not introduce transport support without explicit approval/drift semantics

---

## Cross-Track Dependencies

The main dependency edges are:

1. Track 1 before any attempt to broaden non-interactive reuse semantics elsewhere
2. Track 2 before Track 3 workflow-based session continuation
3. Track 4 Phase 1 and Phase 2 can run in parallel with Tracks 1 through 3
4. Track 4 Phase 4 must wait until Track 3 has clarified long-lived session expectations if MCP transport is expected to support resumable agent interactions

## Suggested Pickup Sequence For The Next Four Implementation Passes

Pass 1:

- Track 1 only
- goal: land the bounded approval-envelope model without touching workflow state or adapter transport

Pass 2:

- Track 2 only
- goal: land typed workflow state and explicit output wiring

Pass 3:

- Track 3 on top of Pass 2
- goal: reuse workflow-state plumbing for named agent sessions

Pass 4:

- Track 4 Phase 1 and Phase 2 first
- decide separately whether Track 4 Phase 3 and Phase 4 are approved for the same cycle or should stay split

## Review Focus

- keep approval semantics strict and auditable
- prefer explicit typed contracts over convenience magic
- preserve current blocked MCP stance until the transport story is real
- ensure any Spark-agent delegation uses disjoint write ownership to avoid merge churn
