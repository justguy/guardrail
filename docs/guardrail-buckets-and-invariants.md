# Guardrail — Feature Buckets, Priorities, and Invariant Prompts

---

## Feature Buckets (Priority Order)

---

### Bucket 1 — Core Contract Engine
*The irreducible minimum. Nothing else works without this.*

| # | Feature | Features |
|---|---|---|
| 1 | Command normalization | 1 |
| 2 | Scope vector generation | 2 |
| 3 | Manifest creation | 3 |
| 4 | Manifest matching | 4 |
| 5 | Drift detection | 5 |
| 6 | Risk classification | 6 |
| 7 | Trust classification | 7 |
| 8 | Approval recording | 8 |
| 9 | Non-interactive enforcement | 9 |
| 10 | Path canonicalization | 21 |
| 11 | File provenance enforcement | 22 |
| 12 | TOCTOU mitigation | 23 |
| 13 | Anti-interactive execution | 31 |
| 14 | Output validator engine | 32 |
| 15 | Regex safety lint | 33 |
| 16 | Core CLI commands | 38 |

---

### Bucket 2 — Workflow and Negotiation Engine
*Enables multi-step workflows and autonomous LLM negotiation without human involvement for resolvable issues.*

| # | Feature | Features |
|---|---|---|
| 1 | Workflow definition format | 10 |
| 2 | Workflow linting | 11 |
| 3 | Workflow execution | 12 |
| 4 | Rollback guarantees | 13 |
| 5 | Idempotency enforcement | 14 |
| 6 | Negotiation request generation | 15 |
| 7 | Delta application engine | 16 |
| 8 | Self-resolvable issue handling | 17 |
| 9 | Non-self-resolvable enforcement | 18 |
| 10 | Negotiation round limits | 19 |
| 11 | Cumulative drift detection | 20 |
| 12 | Workflow CLI commands | 39 |

---

### Bucket 3 — Audit, Observability, and Runtime Integrity
*Required for enterprise readiness and meaningful security posture. Enables teams to trust what Guardrail reports.*

| # | Feature | Features |
|---|---|---|
| 1 | Environment fingerprinting | 24 |
| 2 | Secret detection | 25 |
| 3 | Production-like target detection | 26 |
| 4 | Time policy enforcement | 27 |
| 5 | Counter persistence | 28 |
| 6 | Concurrency locks | 30 |
| 7 | Local audit log | 34 |
| 8 | Tamper resistance | 35 |
| 9 | Audit query surface | 36 |
| 10 | Audit CLI commands | 40 |
| 11 | Explainability UX | 43 |

---

### Bucket 4 — Recipe System and OpenClaw Integration
*The go-to-market wedge. Enables distribution, ecosystem adoption, and the OpenClaw adapter strategy.*

| # | Feature | Features |
|---|---|---|
| 1 | Recipe packaging | 44 |
| 2 | Recipe categories | 45 |
| 3 | Verified recipe channel | 46 |
| 4 | Custom recipe authoring | 47 |
| 5 | OpenClaw wrapper integration | 48 |
| 6 | Native executor integration | 49 |
| 7 | Recipe CLI commands | 41 |
| 8 | GitHub recipes | 64 |
| 9 | Package recipes | 65 |
| 10 | Git recipes | 66 |
| 11 | Infra recipes | 67 |
| 12 | OpenClaw recipes | 68 |
| 13 | Demo scenarios | 63 |

---

### Bucket 5 — Policy, UX, and Adoption
*Reduces friction for teams adopting Guardrail. Enables org-level configuration and self-serve onboarding.*

| # | Feature | Features |
|---|---|---|
| 1 | Resource bounds | 29 |
| 2 | Learning mode | 60 |
| 3 | Profiles | 61 |
| 4 | Safe defaults | 62 |
| 5 | Policy CLI commands | 42 |
| 6 | Metrics and events | 37 |
| 7 | Agent identity and governance | 50 |
| 8 | Agent strict mode | 51 |

---

### Bucket 6 — Enterprise and Team Features
*Monetization surface. Shared manifests, approval queues, org policy, identity, compliance.*

| # | Feature | Features |
|---|---|---|
| 1 | Shared manifests | 52 |
| 2 | Approval queue | 53 |
| 3 | Org policy engine | 54 |
| 4 | Identity and access control | 55 |
| 5 | Centralized audit | 56 |
| 6 | Hosted key management | 57 |
| 7 | Notifications and integrations | 58 |
| 8 | Deployment modes | 59 |
| 9 | Compliance exports | 69 |
| 10 | Multi-stage approval policies | 70 |
| 11 | Environment separation | 71 |
| 12 | Org-wide recipe marketplace | 72 |
| 13 | Incident response hooks | 73 |

---

---

# Invariant Prompt — Bucket 1: Core Contract Engine

## Role

You are implementing the Core Contract Engine for Guardrail. This is the irreducible foundation of the system. Every other subsystem depends on what you build here being correct. Nothing may execute without passing through this engine. There are no exceptions.

---

## What This Engine Does

Takes a proposed command or workflow, produces a deterministic canonical representation, compares it against an approved manifest, classifies its risk and trust, and either permits or blocks execution. It never guesses. It never assumes. When uncertain, it fails closed.

---

## Invariants

These are absolute. No feature request, performance concern, or developer convenience overrides them.

**I-1: Fail Closed**
When any state is missing, ambiguous, corrupt, or unverifiable, execution is blocked. The engine never assumes the safe path is to proceed.

**I-2: Canonical Determinism**
The same command on any machine with any formatting must produce the same hash. Normalization must be fully deterministic across OS, locale, shell, and whitespace.

**I-3: No Bypass Surface**
There is no flag, env var, or configuration that permits execution without a valid approved manifest in strict mode. `--force`, `--skip-check`, and similar escape hatches do not exist in the enforcement path.

**I-4: Immutable Approval**
An approved manifest records what was approved, when, and by whom. It cannot be modified after signing. A new approval is required for any change, including narrowing.

**I-5: Scope Can Only Narrow via Self-Resolution**
Any proposed execution that widens scope relative to the approved manifest requires human approval. The engine never auto-approves widening.

**I-6: Risk Is Computed, Not Declared**
The engine computes risk classification independently. A manifest may declare a risk level; if the computed level is higher, the computed level wins. Downward declaration does not override upward computation.

**I-7: Symlinks Are Not Trust Boundaries**
All file paths are resolved to their canonical absolute form before any comparison. A symlink that resolves to an approved path is still an approved path. A symlink that resolves to an unapproved path is blocked.

**I-8: Exit Code Zero Does Not Mean Success**
If a step's output fails its declared validator, the step is treated as failed regardless of exit code.

---

## Implementation Directives

### 1. Command Normalization

Input: raw command string or args array from any source (user, agent, CI).

Output: a stable canonical representation used as the basis for hashing and comparison.

Rules:
- Resolve the executable to its absolute path using `PATH` at normalization time. Store the resolved path, not the alias.
- Normalize argument ordering only where reordering is semantically safe and explicitly defined. Do not infer safety. Default is: preserve order.
- Strip whitespace differences, quoting differences, and redundant separators.
- Preserve all flags, values, and argument positions that affect execution behavior.
- Two commands that would behave identically on the OS must produce the same canonical form. Two commands that would behave differently must produce different canonical forms. When in doubt, preserve the difference.

### 2. Scope Vector Generation

The scope vector is a structured representation of everything a proposed execution can do. It is the unit of comparison between proposed and approved.

Fields:
```json
{
  "command": "string — resolved absolute path",
  "args": ["array of strings — fully expanded"],
  "arg_patterns": ["array of regexes if pattern matching is declared"],
  "env_accessed": ["env var names read at runtime"],
  "env_injected": ["env var names explicitly provided"],
  "execution_mode": "structured | shell",
  "traits": {
    "writes_local": true,
    "reads_network": false,
    "writes_network": false,
    "requires_elevation": false,
    "is_destructive": false
  },
  "target_environment": "string or null",
  "resource_locks": ["array of named lock identifiers"],
  "runtime_limits": {
    "maxRuns": "integer or null",
    "validUntil": "ISO8601 or null",
    "maxExecutionsPerMinute": "integer or null",
    "allowedWindow": "string or null"
  }
}
```

The scope vector is hashed as canonical JSON (keys sorted, whitespace stripped) and stored in the manifest.

### 3. Manifest Structure

```json
{
  "version": 1,
  "kind": "command | workflow_template",
  "name": "string",
  "created_at": "ISO8601",
  "approved_at": "ISO8601 or null",
  "approved_by": ["array of approver identities"],
  "approval_state": "pending | approved | revoked",
  "trust_class": "reviewed_internal | pinned_external | generated | unknown",
  "risk": "green | yellow | red",
  "risk_reasons": ["array of human-readable strings"],
  "scope_vector": { },
  "scope_vector_hash": "SHA256 hex string",
  "manifest_hash": "SHA256 of full manifest canonical JSON",
  "signature": "string or null"
}
```

- `manifest_hash` covers everything except the `signature` field.
- `signature` is applied by an external approval step, never by the engine itself.
- `approval_state: pending` manifests do not permit execution.

### 4. Manifest Matching

Given a proposed scope vector and an approved manifest:

1. Hash the proposed scope vector.
2. Compare against `scope_vector_hash` in the manifest.
3. **Exact match:** proceed to execution.
4. **No match:** compute a structured diff and emit it. Block execution.

Diff output format:
```json
{
  "status": "drift_detected",
  "trace_id": "string",
  "changes": [
    {
      "field": "args[2]",
      "type": "added | removed | modified | widened | narrowed",
      "before": "value or null",
      "after": "value or null",
      "risk_delta": "green→yellow | none | etc"
    }
  ]
}
```

Narrowing is reported but does not block. Widening blocks unconditionally.

### 5. Drift Detection

Drift categories and their handling:

| Category | Block? | Self-Resolvable? |
|---|---|---|
| Binary name changed | Yes | No |
| Argument value changed | Yes | Case-by-case |
| New flag added | Yes | No |
| Constraint removed | Yes | No |
| New env var accessed | Yes | No |
| New target | Yes | No |
| Risk delta upward | Yes | No |
| Trust delta downward | Yes | No |
| Mode changed to shell | Yes | No |
| Argument narrowed | No | N/A |
| Whitespace/formatting only | No | N/A |

### 6. Risk Classification

Classification is computed by the engine. Author declarations are a starting point only.

**GREEN** — all of the following are true:
- No network access
- No writes outside the working directory
- No elevated privileges
- No secret handling
- No destructive flags
- No production-like target
- Trust class is `reviewed_internal` or `pinned_external`

**YELLOW** — any of the following:
- Local filesystem writes
- Package installation
- Service lifecycle commands
- Shell mode execution
- Patch or restart behavior
- Trust class is `generated` or `unknown` (with no other RED triggers)

**RED** — any of the following:
- Network read or write
- Elevated privileges (`sudo`, `chmod`, `chown`, admin flags)
- Destructive flags (`--force`, `--delete`, `--destroy`, `-rf`)
- Secret-shaped env var with production-like target
- Trust class is `generated` or `unknown` combined with network or destructive
- Command installs, deploys, publishes, or releases to a non-local target
- `curl | sh` or equivalent piped execution patterns

Risk can only escalate. It cannot be manually downgraded.

### 7. Trust Classification

| Class | Definition |
|---|---|
| `reviewed_internal` | First-party, committed to version control, manually reviewed |
| `pinned_external` | External source, pinned to a specific immutable commit SHA |
| `generated` | Produced by an LLM, script, or automated process |
| `unknown` | Provenance cannot be determined |

`generated` and `unknown` default to YELLOW and escalate to RED if any network, destructive, or secret trait is present.

### 8. Approval Recording

- Human approval requires an explicit acknowledgement action (`guardrail approve`).
- Approval is recorded with: approver identity, timestamp, manifest hash, and signature.
- RED-classified manifests require two distinct approver identities.
- Approval is invalidated if the manifest hash changes for any reason.
- Revocation is a write-once operation. A revoked manifest cannot be un-revoked; a new manifest must be created.

### 9. Non-Interactive Enforcement

In strict/non-interactive mode:
- A missing manifest is a hard failure. Exit non-zero.
- A manifest that does not match the proposed execution is a hard failure. Exit 12.
- A manifest with `approval_state` other than `approved` is a hard failure.
- No prompt, no bypass, no fallback to permissive mode.

### 10. Path Canonicalization

- All file paths are resolved via the OS to their canonical absolute path before comparison.
- Symlinks are resolved. The resolved path is what is compared, not the declared path.
- If resolution fails (path does not exist), fail closed.

### 11. File Provenance Enforcement

- If a manifest declares `file_hash` for a target binary or script, the engine hashes the file before execution.
- If the hash does not match, execution is blocked. `file_hash_mismatch` is logged.

### 12. TOCTOU Mitigation

- The engine must not hash a file and then exec it by path name.
- The correct sequence: hash → open file descriptor → exec from that fd.
- The file descriptor must be opened before the path can be mutated.
- Any implementation that hashes then re-opens by path is incorrect.

### 13. Anti-Interactive Execution

- Processes spawn without a TTY (`pty: false`) by default.
- If a process blocks on stdin, it is killed immediately.
- Exit 13: `interactive_prompt_detected` is logged.
- `pty: true` may only appear in a human-signed manifest. It cannot be set by an agent or via a flag at runtime.

### 14. Output Validator Engine

- Each step may declare a `validator` block.
- Supported validator types: `regex`, `json_schema`.
- Evaluation: run after process exits, before recording success.
- If exit code is 0 but validator fails: step is marked `validation_failed`. Not success.
- `validation_failed` triggers failure handling in the state machine.

### 15. Regex Safety Lint

- All regexes in validator blocks are evaluated at approval time.
- A regex with catastrophic backtracking potential is rejected.
- Complexity budget: reject patterns with nested quantifiers on unbounded groups (e.g., `(a+)+`, `(.*)*`).
- A manifest containing a rejected regex cannot be approved.

---

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Execution succeeded and all validators passed |
| 12 | Drift detected — proposed execution does not match approved manifest |
| 13 | Interactive prompt detected — process attempted to block on stdin |
| 1 | General failure — manifest invalid, approval missing, or unclassified error |

---

## Test Coverage Requirements

Before this bucket is considered complete, the following must have passing automated tests:

- Same command produces identical canonical hash across three different OS environments
- Symlink to approved path: permitted
- Symlink to unapproved path: blocked
- File hash match: executes
- File hash mismatch: blocks, logs `file_hash_mismatch`
- TOCTOU swap between hash and exec: blocked via fd enforcement
- Exit 0 with failing validator: recorded as `validation_failed`
- ReDoS regex submitted at approval time: rejected before manifest is stored
- Missing manifest in strict mode: Exit 1, no prompt
- Drift detected: Exit 12, structured diff emitted
- Widening detected: blocked, human escalation required
- Narrowing detected: permitted, logged

---

---

# Invariant Prompt — Bucket 2: Workflow and Negotiation Engine

## Role

You are implementing the Workflow and Negotiation Engine for Guardrail. This engine orchestrates multi-step workflows and enables autonomous resolution of contract issues between Guardrail and an LLM agent — without requiring human involvement for issues that can be safely resolved within the existing approved scope.

This engine operates on top of the Core Contract Engine. Every invariant from Bucket 1 applies here. This engine adds workflow orchestration and negotiation on top of those foundations. It does not relax them.

---

## Invariants

**I-W1: Workflows Are Manifests**
A workflow is subject to the same signing, hashing, approval, and drift detection rules as a single command. The workflow definition is hashed at approval time. Any change to any step, transition, rollback, or validator produces a new hash and blocks execution.

**I-W2: Rollback Is Pre-Approved or Absent by Declaration**
Every workflow with any non-idempotent step must declare a rollback section in the original signed manifest. There is no runtime rollback. An aborted workflow without a pre-approved rollback section is a lint failure, not a runtime decision.

**I-W3: State Machine Default-Deny**
A failed state cannot transition to a success state. `validation_failed → done` is illegal and fatally rejected at lint time. There is no configuration to override this.

**I-W4: Idempotency Is Pre-Declared, Not Agent-Asserted**
Steps default to `idempotent: false`. The `idempotent: true` flag may only appear in the original human-signed manifest. An agent cannot add it, and it cannot be set via negotiation.

**I-W5: The Negotiation Loop Cannot Widen Scope**
A manifest delta submitted by an agent during negotiation can only narrow scope. Any widening — broader regex, new env var, new command, new flag, new target — triggers immediate human escalation regardless of which round the negotiation is in.

**I-W6: Cumulative Drift Is Tracked**
Small narrowing changes across multiple negotiation rounds cannot accumulate into a net widening. The engine tracks the total scope delta across all rounds. If the cumulative delta is wider than the original approved manifest, it is treated as widening and escalated.

**I-W7: The Agent Cannot Sign**
At no point in the negotiation loop does the agent acquire signing authority. Negotiation produces a proposed delta. It does not produce an approved manifest. Execution does not resume until a human or pre-authorized CI step signs the result.

**I-W8: Round Limits Are Hard**
`max_rounds` is an absolute ceiling. When it is reached, the negotiation is terminated, `negotiation_exhausted` is logged, and the full trace is attached to a human escalation. There is no extension mechanism available to the agent.

**I-W9: Rollback Uses the Same Enforcement Rules**
Rollback steps are not a special mode. They are subject to the same invariants as forward steps: structured mode, scope vector, manifest hash, validator, and drift detection.

---

## Workflow Definition Format

```json
{
  "version": 1,
  "kind": "workflow",
  "name": "string",
  "steps": [
    {
      "id": "string",
      "description": "string",
      "run": {
        "command": "string",
        "args": ["array"],
        "mode": "structured",
        "env": {
          "allow": ["array of var names"]
        }
      },
      "idempotent": false,
      "validator": {
        "regex": "string or null",
        "json_schema": "object or null"
      },
      "on_success": "next_step_id | done",
      "on_failure": "rollback | halt"
    }
  ],
  "rollback": {
    "steps": [
      {
        "id": "string",
        "run": { },
        "idempotent": true
      }
    ]
  },
  "rollback_policy": "required | none",
  "rollback_none_reason": "string — required if rollback_policy is none"
}
```

---

## Workflow Linting

Linting runs at submission time, before approval. A manifest that fails lint cannot be approved.

Fatal lint errors (block approval):
- Any step declares `mode: shell`
- Any transition `validation_failed → done` or `failure → success` or equivalent
- Any step is `idempotent: false` and no `rollback` section exists (unless `rollback_policy: none` with reason)
- Any `{{inputs.x}}` reference that does not resolve to a declared input
- Any validator regex that fails the complexity budget check
- Any field that is declared as runtime-mutable by the agent (`idempotent`, `pty`, rollback steps)
- Declared `risk` is lower than computed `risk`

Warnings (do not block approval, logged):
- A `string` input with no `pattern` or `enum` constraint
- A `requires_env` entry matching a secret name pattern
- Rollback steps that are `idempotent: false` (unusual, logged, not blocked)

---

## Workflow Execution

Step sequencing:
1. Validate workflow manifest hash matches approved hash.
2. For each step in declared order:
   a. Run input validation and scope vector check.
   b. Spawn process per Core Contract Engine rules.
   c. Evaluate validator (if declared).
   d. Transition based on `on_success` or `on_failure`.
3. On abort (external signal or unhandled failure): execute rollback steps in declared order.
4. Log full execution trace to audit.jsonl.

Retry rules:
- A step with `idempotent: true` may be retried automatically after a non-destructive failure.
- A step with `idempotent: false` requires explicit human authorization to retry after failure.
- An agent may not request retry of a non-idempotent step via the negotiation loop.

Abort and rollback:
- Rollback steps execute in declared order.
- Rollback steps are subject to the same enforcement rules as forward steps.
- If a rollback step itself fails, it is logged and execution of subsequent rollback steps continues. The overall workflow exit code is non-zero.
- Guardrail does not silently exit without completing the rollback sequence.

---

## Negotiation Request Generation

When execution is blocked, Guardrail emits a structured `negotiation_request`:

```json
{
  "status": "blocked",
  "trace_id": "string",
  "round": 1,
  "max_rounds": 3,
  "issues": [
    {
      "code": "ISSUE_CODE",
      "field": "path.to.field",
      "detail": "human-readable explanation",
      "self_resolvable": true,
      "constraint": "narrow_only | must_add | must_remove",
      "current_value": "value or null",
      "allowed_values": "description or null"
    }
  ],
  "risk_delta": "green→green | green→yellow | etc",
  "cumulative_scope_delta": "narrowed | unchanged | widened",
  "human_required": false
}
```

- `self_resolvable` is computed by Guardrail. The agent has no input into this field.
- `human_required` is set to `true` if any issue is not self-resolvable, if risk has escalated, or if scope has widened.

---

## Issue Codes

| Code | Self-Resolvable | Constraint |
|---|---|---|
| `MISSING_ROLLBACK` | Yes | `must_add` |
| `MISSING_VALIDATOR` | Yes | `must_add` |
| `REGEX_OVERBROAD` | Yes | `narrow_only` |
| `SECRET_IN_ENV_INJECT` | Yes | Refactor to reference |
| `IDEMPOTENT_RETRY_ELIGIBLE` | Yes | Pre-declared true only |
| `RISK_ESCALATION` | No | Human required |
| `SCOPE_WIDENING` | No | Human required |
| `SIGNING_ATTEMPT` | No | Hard block — Invariant I-W7 |
| `ROLLBACK_MUTATION` | No | Hard block — Invariant I-W2 |
| `PTY_ADDITION` | No | Hard block — Core Invariant |
| `IDEMPOTENT_ADDITION` | No | Hard block — Invariant I-W4 |
| `FINGERPRINT_MISMATCH` | No | Hard block |
| `TOCTOU_DETECTED` | No | Hard block |
| `NEGOTIATION_EXHAUSTED` | No | Hard escalation |
| `CUMULATIVE_WIDENING` | No | Human required |

---

## Delta Application Engine

When the agent submits a proposed delta:

1. Apply the delta to a copy of the base manifest. Never mutate the approved manifest.
2. Re-run full lint suite on the result.
3. Compute new scope vector and scope vector hash.
4. Compare scope vector to the approved manifest scope vector.
5. Compute cumulative scope delta across all rounds to date.
6. If any lint failure, scope widening, risk escalation, or cumulative widening: emit new `negotiation_request` with updated round count or escalate.
7. If all issues resolved, scope unchanged or narrowed, risk unchanged: auto-approve the delta, log the round trip, resume execution.

The agent submits a delta, not a full manifest replacement. Full manifest replacement is rejected.

---

## Escalation Table

| Condition | Action |
|---|---|
| All issues self-resolvable, scope narrowed or equal, risk unchanged | Auto-approve. Log round-trip. Resume. |
| Any risk escalation | Human escalation. Full trace attached. |
| Any scope widening | Human escalation. Full trace attached. |
| Any cumulative widening across rounds | Human escalation. Full trace attached. |
| Round limit reached | `negotiation_exhausted`. Hard escalation. |
| Signing attempt by agent | Immediate hard block. |
| Rollback mutation after workflow started | Immediate hard block. |
| `pty: true` addition | Immediate hard block. |
| `idempotent: true` addition | Immediate hard block. |
| Fingerprint mismatch | Immediate hard block. |
| TOCTOU detected | Immediate hard block. |

Human escalation packages: the original manifest, every proposed delta, every `negotiation_request`, the final blocking reason, and the recommended next action in plain English. The human reviews a resolved diff, not a raw manifest.

---

## Test Coverage Requirements

Before this bucket is considered complete, the following must have passing automated tests:

**Workflow Engine**
- `validation_failed → done` transition: rejected at lint time
- Non-idempotent step with no rollback section: rejected at lint time
- Workflow abort: rollback executes before process exits
- Rollback step failure: logged, subsequent rollback steps continue, exit non-zero
- Idempotent step failure: auto-retry authorized
- Non-idempotent step failure: retry blocked, human authorization required
- Step exits 0 with validator failure: recorded as `validation_failed`

**Negotiation Engine**
- Agent narrows overbroad regex: auto-approved in round 2
- Agent widens scope in round 2: immediate human escalation
- Three rounds of unresolved issues: `negotiation_exhausted`, hard escalation
- Agent attempts to add `idempotent: true`: immediate hard block
- Agent attempts to add `pty: true`: immediate hard block
- Agent attempts to sign manifest: immediate hard block
- Agent attempts to modify rollback mid-workflow: immediate hard block
- Small narrowing in round 1, small narrowing in round 2, net widening: `CUMULATIVE_WIDENING`, human escalation
- `self_resolvable` field: always matches Guardrail's computation, never agent-supplied value
- Human escalation package: contains full trace, all rounds, final blocking reason

---

*This document is implementation-grade. Implement Bucket 1 first. Do not begin Bucket 2 until all Bucket 1 test coverage requirements pass.*
