# REPORT v36b — Admin Event Emission

**Status: COMPLETE**
**Date:** 2026-04-14
**Slice:** B — Admin Event Emission (item 36)

---

## 1. Objective

Emit stable admin-family audit events for the real public admin mutation surfaces that exist in this repo. This slice is bounded to surfaces that already exist and are callable.

---

## 2. Admin Mutation Surfaces Found

| Surface | Function | Mutation | Real? |
|---|---|---|---|
| `src/recipe-install.js` | `installFromPath`, `installFromUrl`, `installFromRegistry`, `installFromGitHub` | Writes recipe JSON to local registry | Yes — all route through `_installRecipeToStore` |
| `src/deployment-mode.js` | `setMode(stateDir, mode)` | Writes `mode.json` | Yes — real state change, no CLI entry point yet |
| `src/key-management.js` | `createKeyStore(...).set(name, value, scope)` | Writes encrypted key envelope to disk | Yes — real mutation, no CLI entry point yet |

### Not wired to CLI

`setMode` and `createKeyStore` are not yet called from `src/cli.js`. They are real mutation functions with disk side-effects but have no public CLI surface today. Instrumentation was added to the functions themselves so any future CLI wiring picks up the events automatically.

---

## 3. Events Emitted and Where

### `recipe_installed` — `src/recipe-install.js`

**Call site:** `_installRecipeToStore()` (line ~247, after `writeFileSync`)

**Trigger:** `opts.auditPath` present and recipe was newly written (not already-installed-identical short-circuit path — that path returns early before the write, so no event).

**Entry shape:**
```json
{
  "schema_version": 1,
  "family": "admin",
  "event": "recipe_installed",
  "recipe_id": "<id>",
  "version": "<semver>",
  "hash": "<sha256>",
  "actor": "<opts.actor or 'system'>"
}
```

### `deploy_mode_changed` — `src/deployment-mode.js`

**Call site:** `setMode(stateDir, mode, opts)` (after `writeFileSync`)

**Trigger:** `opts.auditPath` present.

**Entry shape:**
```json
{
  "schema_version": 1,
  "family": "admin",
  "event": "deploy_mode_changed",
  "mode": "<new mode>",
  "prev_mode": "<opts.prevMode or null>",
  "actor": "<opts.actor or 'system'>"
}
```

### `key_rotated` — `src/key-management.js`

**Call site:** `createKeyStore(stateDir, passphrase, opts).set(name, value, scope)` (after `writeFileSync`)

**Trigger:** `opts.auditPath` present on store creation.

**Entry shape:**
```json
{
  "schema_version": 1,
  "family": "admin",
  "event": "key_rotated",
  "key_name": "<name>",
  "scope": "<scope>",
  "actor": "<opts.actor or 'system'>"
}
```

**Security invariant preserved:** The plaintext secret value is never present in the audit entry (verified by test).

---

## 4. Admin Events With No Real Call Site

The following events from `ADMIN_EVENTS` still have no real mutation surface in this repo:

| Event | Why no call site |
|---|---|
| `config_changed` | No general config mutation function exists in `src/`. Not invented. |
| `recipe_published` | `src/recipe-publish.js` handles publishing via `gh` CLI subprocess — it does not have an `auditPath` opt yet. Left for a future slice as it requires async subprocess handling. |
| `profile_updated` | `src/profile.js` has a `saveProfile` function but it is not a public admin mutation surface exposed via CLI. Not instrumented to keep this slice bounded. |

---

## 5. Tests Added

**File:** `tests/test-bucket6.js` — new `describe('admin event emission', ...)` block at the end.

| Test | What it proves |
|---|---|
| `installFromPath emits recipe_installed with schema metadata when auditPath provided` | Event is appended, `family === 'admin'`, `schema_version === 1`, correct fields |
| `installFromPath does not write audit entry when auditPath is omitted` | No audit file created when opt is absent — opt-in only |
| `setMode emits deploy_mode_changed with schema metadata when auditPath provided` | Event is appended with correct family, version, mode, prev_mode, actor |
| `setMode writes mode file and emits event atomically — mode file and audit both updated` | Both the state file and audit log are updated in the same call |
| `createKeyStore.set emits key_rotated with schema metadata when auditPath provided` | Event is appended with correct family, version, key_name, scope, actor |
| `key_rotated entry does not contain secret value` | Plaintext never leaks into audit log |

**Test result:** All 6 new tests pass. Pre-existing failures (4 tests in `test-feature-acceptance.js`) are unchanged.

---

## 6. Files Changed

| File | Change |
|---|---|
| `src/recipe-install.js` | Added `import { appendEntry }` + `import { makeEventEntry }`; emit `recipe_installed` in `_installRecipeToStore` when `opts.auditPath` provided |
| `src/deployment-mode.js` | Added same imports; added `opts = {}` param to `setMode`; emit `deploy_mode_changed` when `opts.auditPath` provided |
| `src/key-management.js` | Added same imports; added `opts = {}` param to `createKeyStore`; emit `key_rotated` inside `set()` when `opts.auditPath` provided |
| `tests/test-bucket6.js` | Added `queryAuditLog` + `installFromPath` imports; added 6-test admin event emission suite |

---

## 7. What Remains for Item 36

This slice (B) is complete. The remaining gaps for full item 36 closure are:

- **Slice A** (from REPORT_v36a): Emit `ACCESS_EVENTS` at read/export dispatch points (`audit_queried`, `compliance_exported`, `metrics_read`) — covered by REPORT_v36a_access_read_audit_emission.md
- **Slice C**: Add schema stability document and `--json` envelope versioning for read commands

---

**Status: COMPLETE**
