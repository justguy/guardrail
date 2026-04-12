# REPORT — Resident Claude Lane Auth Runtime Debug

Date: 2026-04-11
Scope: `src/claude-resident-lane.js`, `src/resident-lane-core.js`, `src/model-gateway.js`
Symptom: lane boots OK, `lane run-sequence` packet submits, then
`claude --print failed with exit code 1: Not logged in · Please run /login`.
No packet report artifact produced. Resident-lane path only — one-shot is out of scope.

## Local auth state (observed on this host)

- `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`: **not set** in the parent env.
- `~/.claude/.credentials.json`: **absent**.
- `CLAUDE_CONFIG_DIR`: **not set** (defaults to `~/.claude`).
- macOS login keychain contains service **`Claude Code-credentials`**.

Conclusion: on this box Claude auth is **keychain-derived**, not env-derived.
`buildClaudeRuntimeEnv()` (`claude-resident-lane.js:485`) therefore returns
`process.env` unchanged — it does NOT redirect `CLAUDE_CONFIG_DIR`. Good in
theory; the keychain service-name hash stays stable.

## Execution topology (how the lane reaches `claude`)

1. `launch` spawns a **detached daemon** (`resident-lane-core.js:2606`)
   `detached: true`, stdio `['ignore', logFd, logFd, maybeAuthFd]`, `env: process.env`.
2. Daemon receives packets, calls `CLAUDE_LANE_ADAPTER.runRequest` →
   `spawnClaudeWrapper` (`claude-resident-lane.js:502`) with
   `buildClaudeRuntimeEnv(options)`.
3. Wrapper `claude-exec-wrapper.js` execs the `claude --print` CLI, which
   reads credentials from keychain (hash of `CLAUDE_CONFIG_DIR`).

The daemon is detached from the TTY, has no controlling terminal, and runs
outside the interactive Claude Code harness even if launched from inside it.

## Ranked candidate causes

### 1. macOS Security-framework denies keychain read from the detached daemon  — **HIGH (≈0.6)**
The `Claude Code-credentials` keychain item has an ACL. First access from a
*new* binary path / signature context triggers a GUI prompt
("Claude Code wants to use your confidential information..."). Under the
resident lane, `claude` is invoked:

- from a **detached** child process (`daemon.unref()`),
- with `stdio: ['ignore', file, file, fd]` (no TTY, no user-facing stdio),
- cwd `options.guardrailRepo` (different from where the operator originally
  granted "Always Allow").

If the ACL entry does not already include an "Always Allow" grant for this
exact `claude` binary path in this spawn context, `SecKeychainFindGenericPassword`
returns `errSecAuthFailed` / user-cancelled. Claude's CLI surfaces that as
`Not logged in · Please run /login` — the same error as no credential at all.
This is consistent with: one-shot works from an interactive shell (prompt
can appear / was pre-granted), lane does not (detached daemon, no UI).

### 2. Stale / stripped auth env in the detached daemon  — **MEDIUM (≈0.25)**
`spawn(..., { env: process.env })` is captured at the moment the daemon is
launched. If the operator starts the lane from an outer shell that does have
`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` set, Guardrail takes the
"env-auth" branch and redirects `CLAUDE_CONFIG_DIR` to
`.guardrail/claude-runtime/<slot>` (line 493). That directory is empty, so
Claude falls back to looking up a keychain entry hashed from that *new* path
— which does not exist — and reports "Not logged in". Token auth should
bypass keychain entirely, so this only bites when the token has expired or is
invalid and Claude silently falls back. Not observed here (no token set on
this host) but very plausible in CI / other developer machines.

### 3. `HOME` drift / project-bridge side effect  — **LOW (≈0.08)**
`ensureClaudeProjectBridge` symlinks `~/projects/<slug>` → repo-local dir.
That path is **not** where the Claude CLI stores sessions (it uses
`~/.claude/projects/<slug>`). Harmless for auth, but worth deleting — it
can mask a real conflict error behind a misleading filename. `HOME` itself
is not being overridden anywhere in the lane path.

### 4. Wrapper argv drops auth fd or token  — **LOW (≈0.05)**
`buildWrapperArgs` never forwards `--auth-fd` to the child wrapper. The
`authFd` only reaches the daemon process, not the per-request `claude --print`
invocation. If the intended design is "pipe an ephemeral OAuth token via fd 3
into `claude` at request time", that wiring is missing — but the current
design doesn't do that either way, so this is a latent gap, not today's bug.

### 5. Keychain hash mismatch from operator-set `CLAUDE_CONFIG_DIR`  — **VERY LOW (≈0.02)**
If operator had exported `CLAUDE_CONFIG_DIR`, the lane would pass it through
(line 486). Not set on this host.

## Answers to the required questions

- **Why start-OK but exec-fail?** Lane bootstrap does not touch keychain; only
  the per-packet `claude --print` does. The daemon survives boot because it
  never needed credentials until a packet arrived.
- **Is the runtime mutating `HOME` / `CLAUDE_CONFIG_DIR`?** Only in the
  env-token branch (redirects `CLAUDE_CONFIG_DIR`). In keychain mode (this
  host) env is pass-through. `HOME` never changes.
- **Keychain vs config-dir vs launch-env parity?** Most likely **keychain
  ACL + detached-daemon context** (cause #1). Second-most-likely: env-token
  branch redirecting to an empty config dir and falling back to a nonexistent
  keychain entry (cause #2).
- **Smallest product fix preserving resident lanes as primary?** Add a
  **resident-lane auth preflight** (defined below). If preflight fails, fail
  the lane with a structured, actionable error — do **not** silently degrade
  to one-shot.

## Recommended next experiment (one)

Run a no-op packet through the lane with verbose Claude logging and capture
whether the keychain call is made and whether the process is denied:

```
# 1. Baseline: confirm keychain reachable from a detached context similar to the lane.
nohup /bin/sh -c 'CLAUDE_CONFIG_DIR="" claude --print "hi" > /tmp/claude-detached.out 2>&1' </dev/null &

# 2. Reproduce through the lane, with Claude tracing enabled in the daemon env.
CLAUDE_CODE_DEBUG=1 ANTHROPIC_LOG=debug \
  guardrail lane launch --tool claude --session-name auth-preflight ...
guardrail lane run-sequence --packet '{"prompt":"print: ok"}'
tail -n 200 <lane>/lane.log
```

Decision rule:

- `nohup` case succeeds, lane case fails with `Not logged in` → **cause #1 confirmed**
  (detached daemon context denies keychain access).
- Both fail identically → **cause #1 confirmed** more broadly (detached ACL issue).
- `nohup` fails but interactive `claude --print` works → keychain ACL needs a
  fresh "Always Allow" grant; fix is to prime it once from a detached context.
- Lane fails while ambient env shows `CLAUDE_CODE_OAUTH_TOKEN` set →
  **cause #2 confirmed**; fix the env-token branch (don't redirect
  `CLAUDE_CONFIG_DIR` when the creds are token-only).

## Recommended product fix — resident-lane auth preflight

Add a single, explicit preflight gate in `launchResidentLane` (or at the top
of `CLAUDE_LANE_ADAPTER.runRequest`, whichever runs under the daemon's env so
it reflects the real exec context). The preflight:

1. **Classify auth source** using the same logic as `buildClaudeRuntimeEnv`:
   operator-override, env-token, keychain, or none.
2. For **env-token**: verify the token is non-empty, non-placeholder, and
   fail early if the redirected `CLAUDE_CONFIG_DIR` is empty AND the CLI
   will end up consulting keychain under that new hash. Bias: if
   `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is set, do NOT redirect
   `CLAUDE_CONFIG_DIR` — the credentials are env-sourced and Claude should
   never need the config dir for auth. (This is the fix for cause #2.)
3. For **keychain**: run a small `claude --print --help` (or equivalent
   cheapest invocation that forces a credential read) from inside the
   daemon's env **before** consuming the first packet. If it returns the
   `Not logged in` signature, persist a structured lane-boot error
   (`auth_preflight_failed`, reason `keychain_unreachable_from_daemon`) and
   refuse further packets. The operator sees a clear, one-line remediation:
   "Run `claude /login` once from an interactive shell to grant the keychain
   ACL, then relaunch the lane." (This is the fix for cause #1.)
4. For **none**: block with `auth_source_missing`.

Preflight runs once per daemon lifetime, result cached in lane state
(`auth_preflight`: `{ source, checked_at, ok }`). Packets short-circuit with
a fail-closed result if `ok === false`. No one-shot fallback, no silent
degrade — the resident lane stays the only execution surface, and auth
failures are surfaced as structured lane state rather than per-packet exit-1
noise.

Also drop or rename the `~/projects/<slug>` bridge: it's not the Claude
session directory and only adds surface area for spurious conflict errors.

## Assumptions / weakest links

1. Keychain service name is hashed from `CLAUDE_CONFIG_DIR` (long-standing
   Claude-CLI behavior; verify against the currently-installed Claude
   version — this has changed across releases).
2. The host's keychain item ACL actually requires interactive confirmation
   for new callers. If the user previously granted "Always Allow" for
   `claude` from a non-interactive context, cause #1 weakens and cause #2
   becomes the more likely explanation.

Confidence this report identifies the real cause: **0.65**. The experiment
above should collapse that to ≥0.9 in one pass.
