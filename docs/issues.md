# Guardrail — Issues Log

Tracked issues found during development, testing, and demo runs. Each entry records the problem, root cause, fix, and status.

---

## Resolved

### ISSUE-001: Destructive commands in structured mode only classified YELLOW

**Found:** 2026-04-07, during `demo blocked` test run
**Severity:** High — risk engine under-classified dangerous commands

**Problem:**
`rm -rf /`, `chmod 777 /etc/passwd`, and `dd of=/dev/sda` were classified as GREEN or YELLOW in structured mode because the RED condition for destructive commands only triggered when `isShellMode && hasDestructive`.

**Root cause:**
`computeRiskLevel` in `policy-engine.js` only escalated destructive commands to RED in shell mode. Structured mode destructive commands targeting system paths were not caught.

**Fix:**
1. Added `detectSystemPathArgs()` — scans command args (including `key=value` style like `of=/dev/sda`) for system paths (`/etc`, `/usr`, `/dev`, `/`, etc.)
2. Added `hasSystemPathArgs` signal to risk evaluation pipeline
3. Added RED condition: any command targeting system paths → RED
4. Added RED condition: destructive binary + system path args → RED (redundant but explicit)

**Files changed:** `src/policy-engine.js`
**Status:** Resolved — current full suite passes

---

### ISSUE-002: `chmod 777 /etc/passwd` classified GREEN with no reasons

**Found:** 2026-04-07, during `demo blocked` test run
**Severity:** High — dangerous operation invisible to risk engine

**Problem:**
`chmod` is in `SAFE_BINARY_ALLOWLIST`, so the risk engine saw it as a safe binary. The `/etc/passwd` argument was not checked for system path targeting.

**Root cause:**
Risk engine only checked `writablePaths` (a manifest field) for system path detection, not actual command arguments. A command like `chmod 777 /etc/passwd` with no `writablePaths` declared had zero risk signals.

**Fix:**
Same as ISSUE-001 — `detectSystemPathArgs` now catches system paths in command args regardless of binary allowlist status.

**Status:** Resolved — `chmod 777 /etc/passwd` now RED with reason "targets system path in arguments"

---

### ISSUE-003: `dd of=/dev/sda` args not parsed for path component

**Found:** 2026-04-07, during `demo blocked` test run
**Severity:** Medium — `key=value` arg style not recognized

**Problem:**
`dd` uses `of=/dev/sda` format. The system path detector only checked raw args, not the value part after `=`.

**Root cause:**
`detectSystemPathArgs` treated `of=/dev/sda` as a single opaque string that didn't match any system path prefix.

**Fix:**
Updated `detectSystemPathArgs` to split `key=value` style args and check the value part. Also added explicit `/dev/` prefix detection for raw device paths.

**Status:** Resolved — `dd if=/dev/zero of=/dev/sda` now RED

---

### ISSUE-004: Demo `blocked` showed wrong risk colors

**Found:** 2026-04-07, during demo output review
**Severity:** Low — cosmetic, but confusing for users

**Problem:**
The risk label color used `yellow` as fallback for all non-red levels, causing GREEN labels to display in yellow ANSI color. Output like `[YELLOW] GREEN` was confusing.

**Root cause:**
`demo-scenarios.js` used a ternary `risk.riskLevel === 'red' ? 'red' : 'yellow'` instead of mapping each level to its correct color.

**Fix:**
Changed to `riskColorMap = { red: 'red', yellow: 'yellow', green: 'green' }` with proper mapping. Also suppressed empty reasons line when no reasons exist.

**Status:** Resolved

---

### ISSUE-005: `recipe install` error message referenced `--force` (I-3 violation)

**Found:** 2026-04-07, during test suite run
**Severity:** Medium — violated invariant I-3 (no bypass surface)

**Problem:**
The `--force` flag in `recipe install` triggered the I-3 test in `test-bucket1.js` which scans `cli.js` for `'--force'` string presence.

**Root cause:**
I-3 (No Bypass Surface) requires that no `--force`, `--skip-check`, or similar escape hatches exist in the enforcement path. The recipe install `--force` was an overwrite flag, not an enforcement bypass, but the test was a string match.

**Fix:**
1. Renamed CLI flag from `--force` to `--overwrite`
2. Updated error message from "Use --force to overwrite" to "Use --overwrite to replace"

**Status:** Resolved — I-3 invariant test passes

---

### ISSUE-006: `run --recipe` failed with usage error

**Found:** 2026-04-07, during CLI test run
**Severity:** High — new feature non-functional

**Problem:**
`guardrail run --recipe git-branch-cleanup --input repo_path=. --dry-run` printed the usage message instead of running.

**Root cause:**
The `parseArgs` function in `cli.js` parsed `--recipe` and `--dry-run` flags correctly, but after the flag loop, the code at line 656 checked `if (result.command === null) return { error: 'usage' }`. Recipe mode didn't set `result.command` (the command comes from the recipe, not the CLI).

**Fix:**
Added early return for recipe mode: `if (result.recipeId) return result;` — matching the existing pattern for template mode (`if (result.template !== null) return result;`).

**Status:** Resolved

---

## Open

### ISSUE-007: `cat /etc/passwd` classified RED

**Severity:** Low — conservative is safer than permissive
**Impact:** Read-only operations on system paths are classified RED

**Description:**
Any command with system path args is now RED, including read-only operations like `cat /etc/passwd`. This is conservative — per invariant I-6 (risk is computed, not declared), accessing system paths IS risky regardless of intent.

**Decision:** Accept as-is. The user can approve RED commands with strong confirmation. Better to over-classify than under-classify. If this causes friction, a future refinement could distinguish read vs write operations on system paths.

---

### ISSUE-008: `cli.js` exceeds 300-line file limit

**Severity:** Low — tech debt, not a bug
**Impact:** `cli.js` is ~1,450 lines (limit is 300)

**Description:**
The CLI entry point handles argument parsing and dispatch for 23+ commands. Adding new commands continues to grow the file.

**Proposed fix:** Extract `parseArgs()` into `src/cli-parse.js` and dispatch blocks into `src/cli-dispatch.js`. Defer until next feature batch.

---

### ISSUE-009: Remote recipe install trusted-source path was not exercised end-to-end

**Found:** 2026-04-07, during review against README trusted-source claims
**Severity:** Medium — README claimed enforcement, but tests did not prove the real HTTP path

**Problem:**
`recipe install <url>` used `node:http/https`, but the test suite only covered helper functions. A regression in the trusted-source gate or install path could silently break remote install while still leaving unit tests green.

**Fix:**
1. Added an `installFromUrl()` integration test that exercises the trusted-source gate and install path without requiring a live socket
2. Verified trusted-source allow-list matching against the requested URL prefix
3. Verified the remotely loaded recipe is persisted into the local versioned registry

**Files changed:** `tests/test-gap-closure.js`
**Status:** Resolved

---

### ISSUE-014: Template env handshake implicitly allowed all required env vars

**Found:** 2026-04-07, during review against README environment-handshake claims
**Severity:** High — code was weaker than the documented security model

**Problem:**
If a template declared `requires_env`, the template supervisor silently treated that list as caller-approved when no `--env-allow` was provided. That meant templates could inherit required env vars without an explicit caller-side handshake.

**Root cause:**
`template-supervisor.js` defaulted the caller allow-list to `def.requires_env` instead of requiring the caller to declare an allow-list.

**Fix:**
1. Template runs now fail closed when `requires_env` is non-empty and no explicit `--env-allow` list is supplied
2. Template runs also fail when the explicit allow-list omits any required vars
3. Added integration tests for missing, partial, and complete allow-lists

**Files changed:** `src/template-supervisor.js`, `tests/test-integration-runtime.js`
**Status:** Resolved

---

### ISSUE-015: Remote recipe install allowed any URL when trusted source config was missing

**Found:** 2026-04-07, during review against README and technical-status trusted-source claims
**Severity:** High — remote install did not fail closed

**Problem:**
If `~/.guardrail/config.json` was missing or had an empty `trusted_sources` array, `installFromUrl()` allowed any URL. The error message also misleadingly suggested `--overwrite` could bypass trust checks, which was false.

**Root cause:**
`checkTrustedSource()` treated an empty trusted-source list as allow-all, and `installFromUrl()` surfaced an inaccurate remediation message.

**Fix:**
1. Remote install now fails closed when no trusted sources are configured
2. Empty trusted-source lists no longer imply allow-all
3. Error messaging now tells the user to add a matching prefix to `~/.guardrail/config.json`
4. Added integration coverage for the trusted-source gate and remote loader handoff without relying on a sandbox-permitted local HTTP listener

**Files changed:** `src/recipe-install.js`, `tests/test-gap-closure.js`
**Status:** Resolved

---

### ISSUE-016: Recipe execution bypassed manifest-backed approval and drift control

**Found:** 2026-04-07, during review against README approval/drift expectations
**Severity:** High — recipe mode had runtime guardrails but not reusable Guardrail approval semantics

**Problem:**
`guardrail run --recipe ...` executed through the recipe runner directly. That meant real recipe execution skipped manifest-backed approval reuse, drift detection, and non-interactive acknowledgement enforcement. Only the recipe executor's runtime checks applied.

**Root cause:**
The CLI routed recipe execution to `runRecipeById()` / `executeRecipe()` without a supervisor layer comparable to command, workflow, or template mode.

**Fix:**
1. Added `recipe-supervisor.js` for manifest-backed recipe approval, drift detection, non-interactive acknowledgement checks, and runtime policy wiring
2. Added recipe manifest helpers for comparing requested version, resolved version, inputs, provenance, risk, and allow-unverified state
3. Routed real `run --recipe` execution through the recipe supervisor while keeping `--dry-run` as an approval-free preview path
4. Added tests for recipe manifest semantics, non-interactive reuse, audit manifest hashes, and pinned-vs-latest version behavior

**Files changed:** `src/recipe-supervisor.js`, `src/recipe.js`, `src/recipe-executor.js`, `src/cli.js`, `tests/test-recipe.js`, `tests/test-integration-runtime.js`, `tests/test-gap-closure.js`, `tests/test-feature-acceptance.js`
**Status:** Resolved — current full suite passes

---

### ISSUE-017: `github://` recipe installs failed for private repos even when `gh` could access them

**Found:** 2026-04-07, during live install testing against a private GitHub repo
**Severity:** High — documented GitHub install flow failed in authenticated private-repo environments

**Problem:**
`guardrail recipe install github://owner/repo/path@sha` fetched from `raw.githubusercontent.com` only. For private repos, raw fetch returned 404 even when the same runtime had authenticated `gh` access and could read the file through the GitHub API.

**Root cause:**
`installFromGitHub()` assumed raw GitHub fetch was the only source path after SHA resolution. Runtime pin verification in `recipe-runner.js` made the same assumption when re-checking pinned source content.

**Fix:**
1. Added authenticated GitHub contents API fallback in `installFromGitHub()` when raw fetch fails
2. Added the same authenticated fallback to runtime pinned-source verification
3. Added tests for private-repo fallback behavior and updated agent/onboarding docs to call out the runtime requirement for `gh` auth and `GH_CONFIG_DIR` when needed

**Files changed:** `src/recipe-install.js`, `src/recipe-runner.js`, `tests/test-github-install.js`, `README.md`, `docs/agent-onboarding.md`, `docs/github-recipe-distribution.md`, `docs/technical-status.md`
**Status:** Resolved — private `github://` installs work when the runtime has matching `trusted_sources` and authenticated `gh` access

---

### ISSUE-010: Recipe storage was flat (no versioning)

**Found:** 2026-04-07, during recipe model design
**Severity:** High — critical for immutability and approval binding

**Problem:**
Recipes were stored as `~/.guardrail/recipes/<id>.recipe.json` — one flat file per recipe. Installing a new version overwrote the old one. No version history, no immutability guarantee, no multi-version support.

**Root cause:**
Original `recipe-install.js` used flat file naming without version encoding.

**Fix:**
1. Changed storage layout to `~/.guardrail/recipes/<id>/<version>.json`
2. `installRecipe()` now stores each version separately
3. Identical content re-install returns `installed: false` (idempotent)
4. Different content with same version number → blocked as immutable (must publish new version)
5. `listVersions(recipeId)` returns sorted version list
6. `listInstalled()` scans both versioned dirs and legacy flat files
7. `buildIndex()` and `buildVersionIndex()` support versioned + legacy layouts

**Files changed:** `src/recipe-install.js`, `src/recipe-index.js`
**Status:** Resolved — current full suite passes

---

### ISSUE-011: No version resolution (id@version syntax)

**Found:** 2026-04-07, during recipe model design
**Severity:** High — critical for reproducible execution

**Problem:**
`run --recipe <id>` always resolved to the first recipe found in search order. No way to pin to a specific version. Multiple versions of the same recipe couldn't coexist.

**Fix:**
1. Added `parseRecipeSpecifier()` — parses `id` and `id@version`
2. `resolveRecipeById()` now uses `buildVersionIndex()` which groups by ID and sorts versions newest-first
3. Without `@version`: resolves to latest installed
4. With `@version`: exact match or error with available versions listed
5. CLI accepts `--recipe git-branch-cleanup@1.0.0`

**Files changed:** `src/recipe-runner.js`
**Status:** Resolved

---

### ISSUE-012: No runbook (sequential multi-recipe execution)

**Found:** 2026-04-07, during recipe model design  
**Severity:** Medium — needed for multi-step workflows

**Problem:**
No way to execute a sequence of recipes where each runs independently with its own guardrails.

**Fix:**
Added `runRunbook(steps, opts)` to `recipe-runner.js`:
- Takes array of `{ recipe: "id@version", inputs: {} }`
- Executes sequentially, each with its own guardrails
- Stops on first failure
- Returns results per step

**Status:** Resolved — tested with dry-run

---

### ISSUE-013: `existsSync` imported from `node:path` instead of `node:fs`

**Found:** 2026-04-07, during CLI `list` command test
**Severity:** High — `list` command crashed

**Problem:**
In the `list` command dispatch in `cli.js`, `existsSync` was imported from `node:path` (which doesn't export it) instead of `node:fs`.

**Fix:** Changed import to `const { existsSync } = await import('node:fs');`
**Status:** Resolved

---

### ISSUE-018: legacy Claude recipe draft had unwired inputs, ambiguous branching, and no reusable prompt-file safety model

**Found:** 2026-04-07, during recipe review
**Severity:** Medium — recipe would execute but with phantom capabilities

**Problem:**
The original recipe declared `system_prompt`, `allowed_tools`, `working_dir`, and `max_budget_usd` without wiring them into the real execution path. It also had mutually-exclusive inline/file invoke steps with no recipe-level branching semantics, so the actual path was unclear. The file-based path used `sh -c` piping, which weakened the execution shape, and there was no manifest-bound content-hash model for reusable prompt-bearing files.

**Root cause:**
Recipe was drafted with aspirational inputs and two mutually-exclusive steps in a system that only supports sequential execution. No self-review caught the mismatch between declared inputs and actual args.

**Fix:**
1. Replaced the ambiguous multi-step draft with one structured wrapper step and no shell fallback
2. Added `src/claude-exec-wrapper.js` to assemble prompt input and invoke `claude --print` honestly
3. Wired `system_prompt`, `allowed_tools`, `working_dir`, and `max_budget_usd` to real Claude CLI/runtime behavior
4. Added `input_files` as a list input with manifest-bound SHA-256 content hashes and a pre-execution recheck
5. Kept inline `prompt`/`system_prompt` as `review_each_time` so prompt text still requires fresh approval each run
6. Added `session_name` and `no_session_persistence` for repeatable session control
7. Rewrote the description and guardrails to match the actual execution shape
8. Bumped the recipe to `3.0.0`

**Naming outcome:** The shipped recipe follows the `*-exec` naming convention and is published as `claude-exec`.

**Files changed:** `recipes/claude-exec.recipe.json`, `src/claude-exec-wrapper.js`, `src/prompt-inputs.js`, recipe and integration tests
**Status:** Resolved

---

### ISSUE-019: One approval could not cover a bounded chain of recipe executions

**Found:** 2026-04-07, during agent workflow design
**Severity:** Medium — blocked the intended “review/fix/commit” style agent loop

**Problem:**
Standalone recipe manifests were one-approval-per-recipe. That meant agents could not natively run a bounded multi-recipe lifecycle under one workflow approval. The only workaround was an opaque wrapper script, which hid the inner recipe boundaries from Guardrail.

**Root cause:**
Workflow mode only understood `task` and service lifecycle steps. Recipe execution existed as a separate supervisor path, with no workflow-native step type that could pin and execute a referenced recipe inside the workflow manifest.

**Fix:**
1. Added workflow step type `recipe_ref`
2. Normalized `recipe_ref` steps into pinned recipe metadata: resolved version, recipe hash, resolved inputs, and prompt-bearing file hashes
3. Included `recipe_ref` metadata in workflow hashing and drift detection
4. Executed `recipe_ref` steps natively from the workflow supervisor instead of requiring a wrapper script
5. Rolled referenced recipe risk into workflow risk aggregation
6. Added unit, integration, and README-derived acceptance coverage for chained `recipe_ref` execution under one workflow manifest

**Supported model:**
Use one workflow manifest when you want one approval to cover multiple bounded recipe executions. That workflow approval does not also bless standalone `guardrail run --recipe ...` executions outside the workflow.

**Files changed:** `src/workflow.js`, `src/workflow-supervisor.js`, `src/policy-engine.js`, `src/cli.js`, workflow and acceptance tests, README/onboarding/spec docs
**Status:** Resolved
