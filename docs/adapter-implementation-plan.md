# Adapter System: Rich Supervisor Context + Versioned Translation Layer

## Context

Guardrail already enforces contract-locked execution for direct CLI commands, workflows, templates, and recipes. To capture the AI tooling ecosystem (OpenClaw, Aider, Cline, LangChain, internal wrappers), we need an **adapter layer** that intercepts tool-originated commands and routes them through Guardrail's existing enforcement pipeline.

The key constraint is open-source durability:

- adapter profiles will be public artifacts
- public profiles must not depend on unstable Guardrail internals
- adapters must not scrape terminal text to figure out why Guardrail blocked something
- profile install must be safe to distribute over GitHub without SaaS infrastructure

The design therefore uses three layers:

1. **Engine layer**: `runSupervisor()` returns a richer, bounded machine-readable execution result.
2. **Translation layer**: `adapter-engine.js` converts that internal result into a stable public schema: `adapter-result/v1`.
3. **Public artifact layer**: JSON profiles map `adapter-result/v1` fields to tool-specific output formats.

This keeps the adapter runtime maintainable and makes GitHub a viable public registry for profiles.

---

## Phase 1 Goals

- intercept structured commands from external tools
- reuse Guardrail's existing approval, drift, risk, timeout, and concurrency enforcement
- support two real protocols in Phase 1: `stdin-json` and `env-shim`
- recognize `mcp` profiles but block them at CLI level with an actionable message
- ship bundled profiles for `openclaw`, `aider`, and `cline`
- support SHA-pinned GitHub install for public adapter profiles
- log adapter activity with enough detail for debugging and audit

## Phase 1 Non-Goals

- no terminal scraping to infer drift
- no arbitrary embedded code in profiles
- no `http`, `python-callable`, or `node-callable` runtime handlers in Phase 1
- no bare-name public install like `guardrail adapter profile install openclaw` until a signed index exists
- no change to workflow/template/recipe supervisors beyond their existing result contracts

---

## Open-Source Invariants

These invariants are mandatory because the adapter system is intended for public contribution and GitHub distribution:

- **Pure-data profiles only.** Profiles can map fields and define constants, but cannot execute code.
- **Stable public schema.** Public profiles target `adapter-result/v1`, never raw supervisor return fields.
- **Fail-closed validation.** Unknown profile fields, unsupported protocols, invalid extraction paths, or oversized inputs are rejected before execution.
- **Bounded memory.** Any stdout/stderr exposed to adapters is clipped and marked as truncated.
- **Pinned distribution.** Public profile install uses SHA-pinned GitHub sources in Phase 1.
- **Observable behavior.** Adapter operations produce structured log/audit events with run id, tool, protocol, profile source, and outcome.

---

## Architecture

### 1. Engine Layer: Rich Supervisor Context

The adapter plan requires richer machine-readable data than `runSupervisor()` returns today. Phase 1 must therefore extend `src/supervisor.js` so command-mode execution returns a bounded result object rather than a minimal pass/fail summary.

This is an internal Guardrail contract, not the public profile contract.

### Required `runSupervisor()` Result Shape

```js
{
  runId: "gr-123",
  status: "drift_detected", // native Guardrail status, unchanged taxonomy
  attempt: 1,
  contractHash: "sha256-...",
  manifestPath: "/abs/path/.guardrail/approved.json",
  riskLevel: "yellow",
  riskReasons: ["shell mode enabled"],
  exitCode: 12,

  // New: stable machine-readable reason for adapters and future APIs
  reason: "Contract drift detected in non-interactive mode.",

  // New: bounded drift context
  drift: {
    detected: true,
    diffs: [
      { "description": "~ args[0]: \"test\" -> \"install\"" }
    ]
  },

  // New: bounded worker context
  worker: {
    launched: false,
    exitCode: null,
    timedOut: false,
    interactivePromptDetected: false,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false
  },

  // New: execution telemetry
  telemetry: {
    durationMs: 45
  }
}
```

### Required Semantics

- `status` remains the native Guardrail status (`success`, `approval_required`, `drift_detected`, etc.). Do not collapse this in the supervisor.
- `reason` is a short machine-readable/human-readable summary suitable for adapters, APIs, and logs.
- `drift.diffs` reuses Guardrail's existing diff output structure. Phase 1 does **not** invent a new trait taxonomy.
- `worker.stdout` and `worker.stderr` are clipped before they are returned. They must always be bounded.
- `telemetry.durationMs` measures full supervisor runtime, including approval/drift checks.

### Bounded Stream Policy

Open-source adapters must never receive unbounded process output in memory.

Phase 1 policy:

- supervisor returns at most **1 MB** of `worker.stdout`
- supervisor returns at most **1 MB** of `worker.stderr`
- if more data existed, set `stdoutTruncated` / `stderrTruncated`
- full raw process output remains in Guardrail logs/state, not adapter responses

This keeps adapter JSON payloads safe while preserving enough context for tools.

### Files to Modify

| File | Change |
|------|--------|
| `src/supervisor.js` | Extend `buildResult()`, retain bounded worker context, add drift/telemetry/reason fields |
| `src/logger.js` | No schema change required, but adapter-facing reason strings should stay consistent with printed output |

---

## 2. Translation Layer: `adapter-result/v1`

`src/adapter-engine.js` is the only code that understands both Guardrail internals and the public adapter contract.

It must normalize the richer supervisor result into a versioned public schema. Public profiles map against this schema only.

### `adapter-result/v1`

```json
{
  "schemaVersion": "adapter-result/v1",
  "guardrail": {
    "nativeStatus": "drift_detected",
    "category": "blocked",
    "reason": "Contract drift detected in non-interactive mode.",
    "exitCode": 12,
    "contractHash": "sha256-...",
    "manifestPath": "/abs/path/.guardrail/approved.json",
    "riskLevel": "yellow",
    "riskReasons": ["shell mode enabled"],
    "driftDetected": true,
    "driftSummary": [
      "~ args[0]: \"test\" -> \"install\""
    ]
  },
  "process": {
    "launched": false,
    "exitCode": null,
    "timedOut": false,
    "interactivePromptDetected": false,
    "stdout": "",
    "stderr": "",
    "stdoutTruncated": false,
    "stderrTruncated": false
  },
  "telemetry": {
    "runId": "gr-123",
    "durationMs": 45
  }
}
```

### Category Mapping

The translation layer derives `guardrail.category` from native statuses:

- `success` -> `success`
- `approval_required`, `approval_denied`, `drift_detected`, `policy_violation`, `unsupported`, `update_denied`, `time_policy_violated`, `concurrent_blocked` -> `blocked`
- `validation_failed`, `timeout`, `protocol_error`, `internal_error` -> `failed`

This preserves native detail while giving adapters a stable coarse-grained bucket.

### Compatibility Rule

Any breaking change to `adapter-result/v1` requires a new public schema version such as `adapter-result/v2`.

Open-source profiles in the GitHub registry must declare which public schema they target.

---

## 3. Public Artifact Layer: Adapter Profiles

Profiles remain pure JSON mapping files. They do not know or care how Guardrail internally computes drift or approval.

### Profile JSON Schema

```json
{
  "version": "1.0.0",
  "tool": "openclaw",
  "description": "OpenClaw adapter profile",
  "schema_target": "adapter-result/v1",
  "protocol": "stdin-json",

  "intercept": {
    "command": "$.command",
    "args": "$.args",
    "cwd": "$.cwd"
  },

  "response": {
    "format": "json",
    "success": {
      "status": "success",
      "stdout": "$.process.stdout",
      "stderr": "$.process.stderr"
    },
    "blocked": {
      "status": "blocked",
      "reason": "$.guardrail.reason",
      "drift_summary": "$.guardrail.driftSummary",
      "risk_level": "$.guardrail.riskLevel"
    },
    "failed": {
      "status": "failed",
      "exit_code": "$.guardrail.exitCode",
      "stderr": "$.process.stderr"
    }
  },

  "exit_codes": {
    "success": 0,
    "blocked": 12,
    "failed": 1
  },

  "defaults": {
    "non_interactive": true,
    "json_output": true
  }
}
```

### Supported Protocols in Phase 1

`VALID_PROTOCOLS` for Phase 1:

- `stdin-json`
- `env-shim`
- `mcp`

Only `stdin-json` and `env-shim` are executable in Phase 1.

`mcp` is a recognized profile protocol so bundled profiles can exist, but `adapter-cli.js` must block execution before runtime with an actionable error.

### Deferred Protocols

These are not valid in Phase 1 and must be rejected by validation/install:

- `http`
- `python-callable`
- `node-callable`

They may be reintroduced in a future schema version once runtime and security constraints are fully specified.

### Response Format Modes

- **`json`**: response templates are JSON objects whose leaf values may be constants or path references into `adapter-result/v1`
- **`human`**: response templates are plain text strings with `{{guardrail.reason}}`-style placeholders resolved from `adapter-result/v1`

Example human blocked response:

```json
{
  "format": "human",
  "blocked": "BLOCKED: {{guardrail.reason}}\n{{guardrail.driftSummary}}"
}
```

### Validation Rules

- `tool`: must match `^[a-z0-9]+(-[a-z0-9]+)*$`
- `version`: required semver `^\d+\.\d+\.\d+$`
- `schema_target`: required, must equal `adapter-result/v1`
- `protocol`: must be one of Phase 1 `VALID_PROTOCOLS`
- `intercept.command`: required, must pass extraction grammar
- `response.format`: optional, must be `json` or `human`
- unknown top-level fields rejected
- max profile size: **256 KB**
- all path references inside `response` must start with one of:
  - `$.guardrail`
  - `$.process`
  - `$.telemetry`
- all extraction paths scanned for:
  - `__proto__`, `constructor`, `prototype`
  - `eval`, `exec`, `require`, `Function`, `import`

### Maintainability Rule

Profiles may only reference declared public fields in `adapter-result/v1`. They must never target raw `runSupervisor()` fields directly.

---

## JSONPath Grammar (`adapter-extract.js`)

### Allowed Subset

The extractor supports a strict minimal subset of JSONPath: dot notation only.

```
VALID_PATH = /^\$(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/
```

Allowed:

- `$.command`
- `$.args`
- `$.cwd`
- `$.guardrail.reason`
- `$.process.stdout`

Rejected:

- bracket notation `$['command']`
- wildcards `$.*`
- array indexing `$.arr[0]`
- filters `$[?(@.x)]`
- recursive descent `$..command`

### Behavior

- missing path -> `undefined`
- invalid path -> validation error
- missing extracted `command` -> adapter returns `failed` response before execution

### Security Notes

The extractor is security-critical because profiles are public artifacts. It must be:

- pure
- fully unit-tested
- free of code execution features
- free of mutation side effects on input objects

---

## Engine Core Algorithm (`adapter-engine.js`)

All functions are async.

```text
async runAdapter({ tool?, profilePath?, command?, args?, cwd?, rawInput? })
  1. Load profile via loadAdapterProfile()
  2. Validate profile -> fail closed
  3. Resolve command/args/cwd:
     - direct CLI command wins
     - otherwise extract from rawInput via profile.intercept
     - if command missing -> return failed adapter result
  4. Build supervisor options:
     {
       command,
       args,
       cwd,
       nonInteractive: true,
       jsonOutput: true,
       ...profile.defaults
     }
  5. await runSupervisor(supervisorOptions)
  6. Normalize to adapter-result/v1
  7. Render profile.response[category]
  8. Return { adapterResult, renderedResponse, exitCode }
```

### Important Rules

- extracted `cwd` must be forwarded to `runSupervisor()`
- adapter engine never scrapes terminal output
- adapter engine never recomputes drift
- adapter engine never mutates native Guardrail statuses
- adapter engine is the only compatibility boundary between core internals and public profiles

### Error Handling

Entry points must wrap the full async chain:

```js
async function main() {
  // ...
}

main().catch((err) => {
  console.error(err.message);
  process.exit(19);
});
```

Also set:

```js
process.on('unhandledRejection', (err) => {
  console.error(err);
  process.exit(19);
});
```

---

## Logging, Audit, and Observability

Open-source adapters need enough telemetry to debug field-mapping problems without exposing secrets or full unbounded output.

### Logging Requirements

Adapter entry points must emit structured logs through Guardrail's logger with at least:

- `adapter_start`
- `adapter_profile_loaded`
- `adapter_command_extracted`
- `adapter_supervisor_result`
- `adapter_response_rendered`
- `adapter_end`

Required fields:

- `runId`
- `tool`
- `protocol`
- `schemaTarget`
- `profileSource`
- `profileVersion`
- `category`
- `nativeStatus`
- `exitCode`

### Audit Requirements

Adapter runs should append audit events that include:

- `event: adapter_invocation`
- `trace_id`
- `tool`
- `protocol`
- `profile_hash`
- `command`
- `cwd`
- `result_status`

Shim create/remove/install-path actions should also be audited:

- `adapter_shim_created`
- `adapter_shim_removed`
- `adapter_shell_rc_write`

### Secret Handling

- logs must not dump full raw adapter input by default
- logs must not include full environment values
- rendered adapter responses may include bounded stdout/stderr, but logs should prefer clipped summaries

---

## Profile Resolution and Version Selection

When resolving a profile by tool name, the loader checks:

1. installed profiles in `~/.guardrail/adapter-profiles/<tool>/`
2. bundled profiles in `src/adapter-profiles/<tool>.json`

### Selection Rule

- if multiple installed versions exist, pick the **newest semver**
- if `--version <x.y.z>` is provided later, require an exact installed match
- if the selected installed version is older than the bundled version, log a warning but keep the installed version

This mirrors the recipe system and avoids ambiguity when multiple installed profile versions exist.

---

## Public GitHub Registry (Phase 1)

For open source launch, GitHub is the public adapter-profile registry.

### Registry Repo

Public repo:

- `github.com/guardrail-dev/adapter-profiles`

Example layout:

```text
adapter-profiles/
  openclaw.json
  aider.json
  cline.json
```

### Install Syntax

Phase 1 public install uses full SHA-pinned GitHub URLs:

```bash
guardrail adapter profile install github://guardrail-dev/adapter-profiles/openclaw.json@<sha>
```

Bare-name install is deferred until a signed index exists, exactly like recipe distribution.

### Trust Model

- GitHub profile install must be SHA-pinned
- installed profile metadata must record source URL, resolved SHA, content hash, and install timestamp
- trusted source configuration reuses `~/.guardrail/config.json`
- public profiles are treated as untrusted data until they pass local validation

### Install Flow (`adapter-profile-install.js`)

Mirrors the hardened recipe install flow:

1. accept local path, HTTPS URL, or `github://...@sha`
2. require trusted source match for remote install
3. validate profile before writing
4. hash profile with `serializeStable()` + SHA-256
5. install to `~/.guardrail/adapter-profiles/<tool>/<version>.json`
6. write remote pin metadata to `~/.guardrail/adapter-profiles/<tool>/.pins/<version>.json` for GitHub installs
7. same hash -> idempotent skip
8. different hash same version -> immutable error unless `--force`

### Open-Source Contribution Rule

The public repo accepts profile PRs because profiles are declarative and validated locally. No profile should require Guardrail maintainers to review arbitrary executable code.

---

## Protocol Handlers

## Auth Prerequisites and Preflight

Adapter and recipe invocation need an explicit auth-preflight layer for tools whose execution depends on credentials or prior CLI login state.

This solves the **early diagnosis** problem, not the **authentication** problem itself.

Preflight must convert vague runtime failures like:

```text
claude --print failed with exit code 1: Not logged in · Please run /login
```

into explicit contract failures before Guardrail starts the recipe or adapter-managed command.

### Two Auth Requirement Types

#### 1. `requires_env`

Use `requires_env` when the tool is expected to authenticate through environment variables that Guardrail must explicitly plumb into the child process.

Example:

```json
{
  "requires_env": ["ANTHROPIC_API_KEY"]
}
```

Preflight behavior:

- compare the declared env names against the approved `envPolicy.allow` list
- keep `inherit: false` as the default boundary
- fail closed before execution if any required env var is not explicitly mapped

Expected failure shape:

```json
{
  "status": "blocked",
  "reason": "missing_auth_mapping",
  "message": "This recipe requires ANTHROPIC_API_KEY. Please map it in your Guardrail manifest."
}
```

#### 2. `requires_auth`

Use `requires_auth` when the tool depends on a runtime-local authentication state that is not just an environment variable, such as a logged-in CLI session, keychain entry, or credential file in the active runtime.

Example:

```json
{
  "requires_auth": [
    {
      "type": "claude_login",
      "check": "claude auth status",
      "env": ["HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"]
    }
  ]
}
```

Preflight behavior:

- require explicit `--env-allow` plumbing for any env vars needed to expose the auth runtime to the guarded child process
- run a bounded, tool-specific auth check before the real invocation
- return a machine-readable failure if the required auth state is missing in the current runtime
- distinguish “tool not logged in” from “tool logged in somewhere else, but not in this runtime/user/home directory”

Suggested failure reasons:

- `missing_auth_prerequisite`
- `auth_runtime_mismatch`

Example failure:

```json
{
  "status": "blocked",
  "reason": "missing_auth_prerequisite",
  "message": "Claude CLI is not logged in for this runtime. Run claude login."
}
```

### Important Boundary

Preflight does **not** create credentials, log the tool in, or repair the runtime automatically.

It only:

- makes the auth mode explicit in the contract
- checks that the runtime satisfies that contract
- fails early with an actionable reason instead of a late step-level exit code

For example, adding `requires_env: ["ANTHROPIC_API_KEY"]` to `claude-exec` only helps if the recipe is actually meant to run via API-key auth and the approved manifest maps that variable through `envPolicy.allow`.

Adding `requires_auth: [{ "type": "claude_login", ... }]` only helps if the selected runtime really has Claude CLI login state available.

If the tool's auth state lives behind runtime-local env such as `HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, or `GH_CONFIG_DIR`, those values must still be explicitly passed through `--env-allow` so the guarded child process can see the same auth location the preflight just checked.

### Phase Scope

Phase 1 now includes env-based auth preflight because it aligns directly with Guardrail's existing `envPolicy` boundary and the `missing_auth_mapping` contract in `docs/auth_req.txt`.

Current shipped `requires_auth` coverage is intentionally bounded to explicit, known CLI checks:

- Claude CLI via `claude auth status`
- GitHub CLI via `gh auth status --hostname github.com`

Current shipped auth-runtime env handling is intentionally bounded too:

- `claude_login` may require explicit mapping of `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, or `HOME`
- `gh_auth` may require explicit mapping of `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, or `HOME`
- profiles may override those defaults with an explicit `requires_auth[].env` list

Broader `requires_auth` coverage for stateful CLIs remains Phase 1.5 / v0.3 work, including:

- Claude CLI
- Codex CLI
- `gh`
- cloud CLIs that rely on local SSO/session state

This keeps the implementation honest:

- `requires_env` and `requires_auth` improve diagnosis and contract clarity
- runtime-local CLI auth also needs its auth-location env plumbed explicitly, or Guardrail will fail closed before execution
- actual credentials, login, or session state still must be provisioned by the human, CI runner, or runtime environment

### stdin-json (`adapter-stdin.js`)

- entry: `async runStdinAdapter(profile, argv)`
- reads JSON from `argv[2]` or stdin
- default max adapter input size: **5 MB**
- this limit is intentionally lower than worker process buffering and exists to protect the adapter boundary
- invalid JSON -> structured error response + exit 19
- calls `await runAdapter({ rawInput: parsedJson, ... })`
- writes rendered response to stdout
- exits with profile-mapped exit code

### env-shim (`adapter-shim.js`)

`createShim(commandName, toolName)` writes to `~/.guardrail/shims/<cmd>`.

Generated shim requirements:

- embed the absolute path to the current Guardrail executable, not a bare `guardrail` lookup
- resolve the real target binary while excluding the shim directory
- fail clearly if no real binary is found
- write atomically via temp file + rename
- `chmod +x` before rename; on failure, clean up temp file

Example shape:

```bash
#!/usr/bin/env bash
# Guardrail shim for: npm (tool: aider)
# Do not edit — managed by guardrail adapter shim
REAL="$(which -a npm | grep -v "$HOME/.guardrail/shims" | head -1)"
exec "/absolute/path/to/guardrail" adapter run --tool aider -- "$REAL" "$@"
```

#### `--install-path`

`guardrail adapter shim --install-path` prints:

```bash
export PATH="$HOME/.guardrail/shims:$PATH"
```

`--write` may append this to the detected shell rc file, but must:

- require the explicit flag
- write a clearly marked Guardrail block
- avoid duplicate blocks
- log/audit the change

### mcp (Phase 1: recognized, blocked)

When `--tool cline` or any `mcp` profile is used, the CLI must block before runtime:

```text
Error: MCP protocol is not yet supported in v0.2.

For Cline integration now, use the env-shim path or install a shim-oriented profile.
See: docs/adapter-implementation-plan.md#mcp-roadmap
```

This check belongs in `adapter-cli.js`, not `adapter-engine.js`.

### MCP Roadmap

Deferred to v0.3:

- additive, opt-in MCP transport support that does not replace `stdin-json` or `env-shim`
- parity with existing approval, drift, trust, and auth-preflight semantics before any MCP path is considered runnable
- MCP server transport handling
- bidirectional request/response correlation
- streaming partial tool results
- structured tool capability discovery

---

## CLI Surface (`adapter-cli.js`)

```text
guardrail adapter run --tool openclaw -- npm test
guardrail adapter run --profile ./my-tool.json -- npm test
guardrail adapter run --profile ./my-tool.json --env-allow ANTHROPIC_API_KEY -- npm test
guardrail adapter shim --tool aider --commands npm,git,python
guardrail adapter shim --list
guardrail adapter shim --remove npm
guardrail adapter shim --install-path [--write]
guardrail adapter profile install github://guardrail-dev/adapter-profiles/openclaw.json@<sha>
guardrail adapter profile install ./my-profile.json
guardrail adapter profile list
guardrail adapter profile show openclaw
```

### CLI Integration with `src/cli.js`

Do **not** short-circuit from `parseArgs()`. `parseArgs()` is synchronous today.

Instead:

- `parseArgs()` should recognize `adapter` and return a parsed adapter subcommand marker
- `main()` should dispatch to `runAdapterCli()`

Minimal safe shape:

```js
// parseArgs()
if (sub === 'adapter') {
  return { subcommand: 'adapter', adapterArgv: argv.slice(i) };
}

// main()
if (parsed.subcommand === 'adapter') {
  const { runAdapterCli } = await import('./adapter-cli.js');
  await runAdapterCli(parsed.adapterArgv || []);
  process.exit(0);
}
```

### Missing `--tool` / `--profile`

If neither is provided, CLI may look for `default_adapter_tool` in `~/.guardrail/config.json`.

If absent:

```text
Error: No tool specified. Use --tool <name> or --profile <path>.
Available tools: guardrail adapter profile list
```

---

## New Files

### Core Engine

| File | Lines | Responsibility |
|------|-------|---------------|
| `src/adapter-extract.js` | ~120 | Safe field extraction via allowlisted JSONPath subset |
| `src/adapter-profile.js` | ~220 | Profile validation, loading, version selection, hashing, listing |
| `src/adapter-engine.js` | ~280 | Orchestration: extract -> auth preflight -> call supervisor -> normalize -> render |
| `src/adapter-auth.js` | ~80 | Bounded `requires_env` / `requires_auth` preflight helpers |

### Protocol Handlers

| File | Lines | Responsibility |
|------|-------|---------------|
| `src/adapter-stdin.js` | ~140 | `stdin-json` handler, bounded input parsing, stdout response |
| `src/adapter-shim.js` | ~220 | shim create/remove/list/install-path, atomic write, cleanup, absolute Guardrail path |

### CLI + Install

| File | Lines | Responsibility |
|------|-------|---------------|
| `src/adapter-cli.js` | ~180 | Adapter subcommand parsing + routing + protocol gate |
| `src/adapter-profile-install.js` | ~180 | Path/URL/GitHub install, trust checks, immutability, pin metadata |

### Bundled Profiles

| File | Lines | Responsibility |
|------|-------|---------------|
| `src/adapter-profiles/openclaw.json` | ~40 | `stdin-json` profile |
| `src/adapter-profiles/aider.json` | ~40 | `env-shim` profile |
| `src/adapter-profiles/cline.json` | ~40 | `mcp` profile for future support; blocked in v0.2 |

### Tests

| File | Lines | Responsibility |
|------|-------|---------------|
| `tests/test-adapter.js` | ~380 | Validation, engine translation, install, shim, logging, security cases |

---

## Modifications to Existing Files

| File | Change |
|------|--------|
| `src/supervisor.js` | return rich bounded execution context |
| `src/cli.js` | route `adapter` subcommand in `main()` |
| `package.json` | include adapter tests |
| `CLAUDE.md` | add adapter files to project structure |
| `docs/technical-status.md` | add adapter system to roadmap/status |

---

## Implementation Order

### Phase 1A — Core Contracts

1. Extend `src/supervisor.js` with rich execution context
2. Add/verify tests for bounded `worker` and `drift` fields
3. Define `adapter-result/v1` normalization in `src/adapter-engine.js`

### Phase 1B — Profile Safety

4. Build `src/adapter-extract.js`
5. Build `src/adapter-profile.js`
6. Add profile validation tests

### Phase 1C — Runtime Entry Points

7. Build `src/adapter-stdin.js`
8. Build `src/adapter-shim.js`
9. Add protocol handler tests

### Phase 1D — CLI + Distribution

10. Build `src/adapter-cli.js`
11. Patch `src/cli.js` dispatch
12. Build `src/adapter-profile-install.js`
13. Add bundled profiles

### Phase 1E — Polish

14. Add audit/log coverage tests
15. Update docs/status/package files

---

## Test Coverage

### `src/supervisor.js`

```text
✓ returns drift.diffs for blocked drift result
✓ returns bounded worker.stdout and worker.stderr
✓ marks stdoutTruncated/stderrTruncated when clipping occurs
✓ includes telemetry.durationMs
✓ preserves native status taxonomy
✓ includes reason on blocked and failed results
```

### `adapter-extract.js`

```text
✓ extracts top-level field via dot path
✓ extracts nested field
✓ rejects __proto__
✓ rejects constructor
✓ rejects bracket notation
✓ rejects wildcard
✓ rejects array indexing
✓ rejects filter expressions
✓ returns undefined for missing path
✓ handles null/undefined input gracefully
```

### `adapter-profile.js`

```text
✓ accepts valid openclaw profile
✓ accepts valid aider profile
✓ accepts mcp profile but marks it non-runnable in v0.2
✓ rejects unsupported protocol http
✓ rejects unsupported protocol python-callable
✓ rejects unknown top-level field
✓ rejects invalid schema_target
✓ rejects invalid response path outside adapter-result/v1
✓ rejects profile >256 KB
✓ installed newest version wins
✓ warns when installed version is older than bundled
```

### `adapter-engine.js`

```text
✓ forwards extracted cwd to supervisor
✓ normalizes supervisor success to adapter-result/v1
✓ normalizes blocked statuses to category=blocked
✓ preserves nativeStatus in adapter-result/v1
✓ renders json response from public schema
✓ renders human response from public schema
✓ missing command extraction returns failed response
✓ invalid profile fails closed
✓ adapter engine never reads terminal text output to classify result
```

### `adapter-stdin.js`

```text
✓ parses JSON from argv[2]
✓ parses JSON from stdin
✓ rejects input exceeding 5 MB
✓ exits with profile-mapped exit code
✓ returns structured error for invalid JSON
```

### `adapter-shim.js`

```text
✓ shim embeds absolute Guardrail path
✓ shim resolves real binary excluding shim dir
✓ shim is executable after creation
✓ cleanup on chmod failure removes temp file
✓ second identical install is no-op
✓ --remove deletes existing shim
✓ --list returns installed shims
✓ --install-path outputs correct export line
✓ --write appends marked block once only
```

### `adapter-profile-install.js`

```text
✓ install from path writes to correct location
✓ install from github:// URL writes pin metadata
✓ URL install checks trusted sources
✓ immutability prevents overwrite of different content
✓ same-hash install is idempotent
✓ list/show resolve newest installed version
✓ bare-name public install is rejected in v0.2
```

### Logging / Audit

```text
✓ adapter_start logged with tool + protocol
✓ adapter_supervisor_result logged with nativeStatus + category
✓ adapter_shim_created audit entry written
✓ adapter_profile_loaded includes source hash
✓ raw adapter input is not logged by default
```

---

## Verification

1. `npm test` passes with existing suite plus new adapter tests
2. `echo '{"command":"echo","args":["hello"]}' | node src/adapter-stdin.js openclaw` returns JSON response with exit 0
3. a blocked drift case through the adapter returns `category=blocked`, native status, drift summary, and exit 12
4. `guardrail adapter shim --tool aider --commands echo` creates an executable shim and running `~/.guardrail/shims/echo hello` routes through Guardrail
5. `guardrail adapter profile install github://guardrail-dev/adapter-profiles/openclaw.json@<sha>` installs under `~/.guardrail/adapter-profiles/`
6. adversarial cases fail closed: oversized input, invalid path grammar, unsupported protocol, response path outside public schema, malformed GitHub URL
7. `guardrail adapter run --tool cline -- ls` exits before execution with MCP-not-supported guidance

---

## Summary

This plan keeps the adapter system safe for open source by:

- moving richer machine-readable truth into the supervisor
- making the adapter engine the only internal/public translation boundary
- versioning the public adapter schema
- distributing profiles as SHA-pinned GitHub artifacts
- keeping profiles declarative, bounded, and locally validated
