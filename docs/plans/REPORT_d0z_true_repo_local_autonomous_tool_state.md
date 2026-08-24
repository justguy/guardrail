# REPORT — D0z: True Repo-Local Autonomous Tool State

**Status:** Done  
**Roadmap anchor:** `D0z` in `docs/technical-status.md`  
**Plan:** `docs/plans/PLAN_d0z_true_repo_local_autonomous_tool_state.md`

## Problem

Guardrail had already moved its own resident-lane state under repo-local `.guardrail/...`, but the fire trial exposed a second write surface owned by Claude itself:

```text
/Users/adilevinshtein/projects/-Users-adilevinshtein-Documents-dev-Guardian
```

That host-global per-project path was being created before packet work started, which meant resident Claude lanes were not actually repo-local end to end.

## What Was Wrong

The first D0z attempt focused too narrowly on `CLAUDE_CONFIG_DIR`. That was incomplete.

Two different Claude state surfaces matter here:

1. `CLAUDE_CONFIG_DIR`
   - controls config/session files such as `settings.json` and token-backed config state
   - safe to redirect only when auth comes from env (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`)

2. `~/projects/<encoded-cwd>`
   - this is the path that actually produced the observed `EPERM` failures in resident-lane runs
   - it is independent of the earlier `CLAUDE_CONFIG_DIR` redirect

So the real D0z fix had to cover both.

## Implemented Strategy

### 1. Repo-local config runtime when env-based auth is present

When `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is present, Guardrail injects:

```text
CLAUDE_CONFIG_DIR=<repo>/.guardrail/claude-runtime/<slot>
```

This keeps Claude config/session state inside the repo without breaking auth.

### 2. Repo-local project bridge for the actual failing path

For every resident Claude lane request, Guardrail now prepares:

```text
<repo>/.guardrail/claude-runtime/<slot>/projects/<encoded-cwd>
```

and bridges the observed host path:

```text
~/projects/<encoded-cwd>
```

to that repo-local directory.

Behavior:

- if the host path does not exist, Guardrail creates a symlink to the repo-local target
- if the host path is already the correct symlink, Guardrail reuses it
- if the host path exists as an empty real directory, Guardrail replaces it with the correct symlink
- if the host path exists as a non-empty directory or points somewhere else, Guardrail fails closed with a `Claude project bridge conflict`

This is the actual working solution for the observed Claude lane startup failure.

## Auth Behavior

### Env-based auth

- `ANTHROPIC_API_KEY`
- `CLAUDE_CODE_OAUTH_TOKEN`

These now get:

- repo-local `CLAUDE_CONFIG_DIR`
- repo-local bridged `~/projects/<encoded-cwd>` target

### Operator-set `CLAUDE_CONFIG_DIR`

If the operator already set `CLAUDE_CONFIG_DIR`, Guardrail respects it unchanged and still applies the project bridge for `~/projects/<encoded-cwd>`.

### Keychain auth

When auth depends on Claude’s keychain-backed default config behavior and no env credential is present, Guardrail leaves `CLAUDE_CONFIG_DIR` unchanged so it does not break auth. The `~/projects/<encoded-cwd>` bridge still applies, and `--no-session-persistence` remains the default for resident Claude lanes.

## Files Changed

- `src/claude-resident-lane.js`
- `tests/test-claude-resident-lane.js`
- `docs/technical-status.md`
- `docs/plans/REPORT_enterprise_P0_fire_trial.md`

## Focused Proof

Executed:

- `node --test tests/test-claude-resident-lane.js`
- `node --test --test-name-pattern "D0z|Resident Lane Mode" tests/test-claude-resident-lane.js tests/test-feature-acceptance.js`

Result:

- D0z-specific resident-lane tests: pass
- Resident Lane Mode acceptance slice: pass

Key covered cases:

- repo-local `CLAUDE_CONFIG_DIR` injection for API-key auth
- repo-local `CLAUDE_CONFIG_DIR` injection for token auth
- operator `CLAUDE_CONFIG_DIR` passthrough
- host `~/projects/<encoded-cwd>` bridge creation
- fail-closed behavior for conflicting preexisting host project dirs
- default `--no-session-persistence` behavior

## Outcome

D0z is now actually closed on the real failing path:

- Guardrail lane state is repo-local
- Claude config state is repo-local when env-based auth allows it
- the observed host-global Claude project path is bridged back into repo-local runtime state
- conflicting existing host state fails closed instead of being silently overwritten

What remains true:

- the bridge still touches a host-visible shim path under `~/projects/...`
- but the writable state behind it is repo-local
- that is the current working compromise needed to make resident Claude lanes usable without falling back to one-shot execution
