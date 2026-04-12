# REPORT — Enterprise P0g: Pre-Egress Scrubbing and Classification Hooks

Status: COMPLETE

## Objective

Add hook points for sensitivity classification and pre-egress scrubbing before adapter output leaves the Guardrail trust boundary. Hook decisions are machine-readable (allow/block/redact) with structured reasons. Audit records capture hook outcomes without leaking blocked or redacted payload content.

## Scope Delivered

| Item | Status |
|------|--------|
| `src/egress-hooks.js` — new module | Done |
| `EGRESS_BLOCKED` in `adapter-result.js` | Done |
| `egress_hook` in `adapter-profile.js` ALLOWED_TOP_LEVEL | Done |
| Hook wired into `adapter-engine.js` `runAdapter()` step 7a | Done |
| Audit callback with no payload leak | Done |
| 26 unit tests in `test-human-domain-routing.js` | Done |
| 5 wiring tests in `test-adapter-runtime.js` | Done |
| `docs/technical-status.md` updated | Done |

## Hook Contract

### New module: `src/egress-hooks.js`

**Exports:**
- `classifyPayload(payload, rules, defaultLabel)` → `{ label, reason, matchedRule, matchedFields }`
- `runEgressHook(payload, hookConfig, auditFn?)` → `{ outcome, label, reason, matchedFields, sanitized, payloadHash }`
- `validateEgressHookConfig(hookConfig)` → `string[]` errors
- `EGRESS_OUTCOMES` — `{ ALLOW, BLOCK, REDACT }`
- `SENSITIVITY_LABELS` — `{ PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED }`

**Hook config shape (in adapter profile):**
```json
{
  "egress_hook": {
    "enabled": true,
    "rules": [
      { "label": "restricted", "match_fields": ["ssn", "credit_card"], "outcome": "block", "reason": "PII field detected" },
      { "label": "confidential", "match_fields": ["password", "token", "api_key"], "outcome": "redact", "reason": "Credential field detected" }
    ],
    "default_label": "public",
    "default_outcome": "allow"
  }
}
```

**Audit entry (no payload leak):**
```json
{
  "event": "egress_hook_result",
  "outcome": "block",
  "label": "restricted",
  "reason": "PII field detected",
  "matched_fields": ["ssn"],
  "payload_hash": "<sha256 of the original adapterResult>",
  "sanitized_keys": null
}
```

### Wiring in `adapter-engine.js`

Between step 7 (paranoia-gate) and the return, step 7a:
- Runs only when `profile.egress_hook?.enabled` is true
- Inspects parsed `process.stdout` JSON when available; otherwise falls back to the raw stdout envelope
- On `block`: returns `wrapBlocked(EGRESS_BLOCKED, reason)` — no payload in the result
- On `redact`: rewrites the actual outgoing `process.stdout` payload with `'[REDACTED]'` values and returns an `egress` metadata block (outcome, label, reason, sanitized_keys, source)
- On `allow` or hook disabled: passes through unchanged

**Invariants upheld:**
- Fail closed: unknown `outcome` value → block
- No payload leak in audit: hash only, never content
- Redact does not leak original values — verified by test

## Scope Boundary

This packet is the seam. It does not include:
- Regex or NLP scanning of `process.stdout` content
- ML-based classifiers
- Integration with SIEM or external DLP systems
- Deep recursive stdout JSON parsing for PII

These are production-grade scrubbing concerns addressed in later packets.

## Proof Results

**Command:** `node --test tests/test-human-domain-routing.js tests/test-adapter-runtime.js tests/test-bucket5.js`

```
ℹ tests 108
ℹ suites 21
ℹ pass 108
ℹ fail 0
ℹ duration_ms 2210ms
```

**Breakdown:**
- `test-human-domain-routing.js`: 26 tests (8 existing + 18 new egress-hook tests) — all pass
- `test-adapter-runtime.js`: 33 tests (28 existing + 5 new egress wiring tests) — all pass
- `test-bucket5.js`: 49 tests (existing, no changes) — all pass

**Full suite:** Pre-existing failures in recipe-supervisor, codex-recipe, and feature-acceptance are unrelated to this packet and existed before these changes.

## Checkpoint 2 — Implementation Complete

**Changed:**
- `src/egress-hooks.js` — new module (classification, scrubbing hook, audit)
- `src/adapter-result.js` — `EGRESS_BLOCKED` reason code added
- `src/adapter-profile.js` — `egress_hook` added to `ALLOWED_TOP_LEVEL`
- `src/adapter-engine.js` — step 7a pre-egress hook wiring on parsed `process.stdout` content plus actual stdout redaction
- `tests/test-human-domain-routing.js` — 18 new egress-hook tests
- `tests/test-adapter-runtime.js` — 5 new egress wiring tests
- `docs/technical-status.md` — P0g update added
- `docs/plans/REPORT_enterprise_P0g_...md` — this file

**Proof:** 108/108 focused proof tests pass.  
**Operator input needed:** No.
