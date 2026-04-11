# Guardrail — Enterprise P0d Report: Single Crypto Boundary

Status: COMPLETE  
Date: 2026-04-11  
Packet: `docs/plans/PLAN_enterprise_P0d_single_crypto_boundary.md`

## Objective

Audit all sensitive-at-rest state writes in Guardrail and consolidate covered writes behind one documented encrypt/decrypt boundary. Eliminate or explicitly flag bypass paths. Document what is covered and what is intentionally deferred.

---

## Audit Findings

### Data Classification

**Class A — Credentials/Secrets** (API keys, tokens, passphrases)

| Write path | Module | Encrypted? |
|---|---|---|
| `createKeyStore(dir, passphrase).set(name, value)` | `src/key-management.js` | YES — AES-256-GCM + scrypt |

All Class A writes are encrypted. No unencrypted credential write path exists anywhere in the codebase. The `*.key.json` suffix is only accessed from within `key-management.js` — confirmed by grep.

**Class B — Governance/Workflow State** (policies, approval records, manifests, audit events)

| Write path | Module | Encrypted? | Justification |
|---|---|---|---|
| `saveOrgPolicy(policy, dir)` | `src/org-policy.js` | NO | Policy config — no credentials; integrity via access control |
| `saveRequest(request, dir)` | `src/approval-queue.js` | NO | Approval workflow metadata — no credentials |
| `saveSharedManifest(manifest, dir)`, `pinManifest(manifest, dir)` | `src/shared-manifest.js` | NO | Recipe/policy distribution records — no credentials |
| `appendEntry(auditPath, entry)` | `src/audit.js` | NO | Hash-chained append-only audit record — integrity via chain, not encryption |
| `persistStateSafe(stateDir, state)` | `src/shared.js` | NO | Supervisor execution checkpoint — no credentials |
| `exportAuditLog`, `generateReport` | `src/compliance.js` | NO (read-only) | No disk writes at all |

Class B writes are **intentionally plaintext**. None contain credentials. Their integrity model is hash-chaining (audit log) and access controls (policy/manifest), not encryption at rest.

---

## Crypto Boundary

**Module**: `src/key-management.js`  
**Boundary marker**: `CRYPTO BOUNDARY (P0d — single sensitive-at-rest boundary)` comment block at top of module  

**Write path**: `createKeyStore(stateDir, passphrase).set(name, value, scope?)`
- Calls `encrypt(value, passphrase)` → AES-256-GCM, per-write random salt (16 bytes) + IV (12 bytes)
- Writes `{ salt, iv, encrypted, tag }` envelope — plaintext never reaches disk

**Read path**: `createKeyStore(stateDir, passphrase).get(name, requiredScope?)`
- Reads encrypted envelope
- Enforces scope check before decryption
- Calls `decrypt(envelope, passphrase)` → returns plaintext

**Key derivation**: `scryptSync(passphrase, salt, 32)` — per-value random salt, no salt reuse

---

## Bypass Audit

No bypass path found.

- `*.key.json` files: only accessed inside `src/key-management.js` (confirmed by grep — zero results outside this module)
- No `--force` flag, env var, or alternative write path for credentials
- No caller writes raw secret values to disk via `writeFileSync` outside this module

---

## Covered vs. Deferred

### Covered
- All credential/secret writes via `createKeyStore.set()`
- Scope enforcement at read time
- Redact surface (`createKeyStore.redact()`) — callers get `[REDACTED:name]`, never the plaintext

### Intentionally Deferred (not in P0d scope)
- KMS/Vault integration — not included per hard stop boundary
- Dynamic secret brokering — not included per hard stop boundary
- Encryption of governance/workflow state (Class B) — not secrets; deferred by design

---

## Checkpoints

### CHECKPOINT 1 — Audit complete

- All 6 declared files audited
- Credential writes: 1 path (`key-management.js`) — already encrypted
- Governance writes: 5 paths — plaintext by design, not secrets
- No bypass found

### CHECKPOINT 2 — Crypto boundary documented

Added `CRYPTO BOUNDARY (P0d)` comment block to top of `src/key-management.js` (after file-level header). The block:
- Names the boundary
- Declares covered data class (credentials)
- Lists intentionally plaintext paths and their justification
- States the no-bypass guarantee

No behavioral code changes — the boundary already existed and worked correctly; this packet adds the documentation and formal audit record.

### CHECKPOINT 3 — Focused proof results

Command: `node --test tests/test-bucket6.js`

```
ℹ tests 59
ℹ suites 12
ℹ pass 59
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 637.149764
```

All 59 tests pass. Key Management suite (5 tests) covered:
- store/retrieve round-trip
- cross-scope denial
- matching-scope access
- redact
- listSync without exposing raw values

---

## README / Technical Status

- `docs/technical-status.md`: Updated to record P0d as complete under the enterprise crypto boundary item.
- `README.md`: No behavioral change — documentation-only packet; no README update required.
