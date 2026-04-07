# Guardrail Template System — Implementation Guide

**Scope:** Parameterized, contract-locked execution templates for general-purpose CLI use.
**Not in scope:** Agent swarm integration, remote registries, template composition.

---

## Architecture in One Sentence

A Guardrail template is a typed, signed execution contract that maps validated user inputs to
structured OS process arguments — never to a shell string.

---

## The Core Distinction

```
OpenClaw:  user input → shell string → OS
Guardrail: user input → schema validation → args array → OS (no shell)
```

The shell is where injection lives. Removing it from the path is the entire security model.

---

## Phase 1 — Template Schema Engine

### 1.1 Template Manifest Format

Every template is a JSON file with a fixed structure. No fields are optional unless marked.

```json
{
  "version": 1,
  "kind": "workflow_template",
  "name": "standard-npm-publish",
  "description": "Publishes a scoped package to the npm registry.",
  "trust_class": "reviewed_internal",
  "risk": "yellow",
  "risk_reasons": ["installs from registry", "writes to npm"],

  "inputs": {
    "package_dir": {
      "type": "string",
      "pattern": "^packages/[a-z0-9-]+$",
      "description": "Relative path to the package directory"
    },
    "tag": {
      "type": "string",
      "enum": ["latest", "beta", "next"],
      "default": "latest",
      "description": "npm dist-tag to publish under"
    }
  },

  "requires_env": ["NPM_TOKEN"],

  "steps": [
    {
      "id": "publish",
      "description": "Publish the package",
      "run": {
        "command": "npm",
        "args": ["publish", "{{inputs.package_dir}}", "--tag", "{{inputs.tag}}"],
        "mode": "structured",
        "env": {
          "allow": ["NPM_TOKEN"]
        }
      },
      "idempotent": false,
      "validator": {
        "regex": "\\+ [a-z@][a-z0-9@/_.-]+@[0-9]+\\.[0-9]+\\.[0-9]+"
      }
    }
  ],

  "rollback": {
    "steps": [
      {
        "id": "unpublish-on-failure",
        "description": "Unpublish if publish partially succeeded",
        "run": {
          "command": "npm",
          "args": ["unpublish", "{{inputs.package_dir}}", "--force"],
          "mode": "structured",
          "env": {
            "allow": ["NPM_TOKEN"]
          }
        },
        "idempotent": true
      }
    ]
  }
}
```

### 1.2 Field Rules

| Field | Required | Notes |
|---|---|---|
| `version` | Yes | Always `1` until a breaking schema change |
| `kind` | Yes | Must be `workflow_template` |
| `name` | Yes | Alphanumeric, hyphens only. Used as manifest key |
| `trust_class` | Yes | `reviewed_internal`, `pinned_external`, `generated`, `unknown` |
| `risk` | Yes | `green`, `yellow`, `red` — computed at lint time, author declares a value, lint may escalate it |
| `inputs` | Yes | At least one field required. Empty inputs object is rejected |
| `requires_env` | No | Env vars the template needs. Must be explicitly mapped by caller |
| `steps` | Yes | At least one step. Each step must declare `mode: structured` |
| `rollback` | Conditional | Required if any step is `idempotent: false` |

### 1.3 Input Type System

Supported types and their validation behavior:

| Type | Validation | Injection Risk |
|---|---|---|
| `string` with `pattern` | Regex match at parse time | None — treated as literal arg |
| `string` with `enum` | Exact match against allowed values | None |
| `integer` with `min`/`max` | Range check | None |
| `boolean` | Must be `true` or `false` | None |
| `string` (bare, no pattern or enum) | **Rejected at lint time** | Rejected before it becomes a risk |

A bare string with no constraint is not a valid input type. Every string input must have
either a `pattern` or an `enum`. This is enforced at lint, not at runtime.

---

## Phase 2 — Input Validation Pipeline

This pipeline runs before any process is spawned. All stages must pass.

```
User-supplied inputs
        │
        ▼
┌─────────────────────────────┐
│  Stage 1: Schema Validation │  ← JSON Schema parse and type check
└─────────────────────────────┘
        │ fail → reject, print schema error, exit non-zero
        ▼
┌─────────────────────────────┐
│  Stage 2: Pattern/Enum Check│  ← Regex match or enum membership
└─────────────────────────────┘
        │ fail → reject, print constraint violated, exit non-zero
        ▼
┌─────────────────────────────┐
│  Stage 3: Injection Scan    │  ← Check for shell metacharacters in values
└─────────────────────────────┘
        │ flag → log warning, still safe because mode: structured
        ▼
┌─────────────────────────────┐
│  Stage 4: Interpolation     │  ← Replace {{inputs.x}} with validated values
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│  Stage 5: Args Array Build  │  ← Produce final []string, never a shell string
└─────────────────────────────┘
        │
        ▼
   execve(command, args[])   ← OS call, no shell involved
```

### 2.1 Interpolation Rules

- `{{inputs.x}}` is the only interpolation syntax.
- Interpolation is resolved **after** validation. A value that fails schema validation is
  never interpolated.
- A template string with `{{` that does not resolve to a declared input key is a lint error,
  not a runtime error. Catch it before the template ships.
- Interpolation produces a single args array element. `"{{inputs.package_dir}}"` becomes
  one element in `args[]`, regardless of what the value contains. It cannot split into
  multiple arguments.

### 2.2 Stage 3 Detail — Injection Scan

Even though `mode: structured` makes injection physically impossible (the OS receives the
literal string), Guardrail still scans for shell metacharacters in input values and logs
a warning. This serves two purposes:

1. Detects confused users who are trying to use shell features and would be surprised
   by the literal behavior.
2. Creates an audit record that an injection-shaped value was attempted, which is useful
   for security review.

Characters that trigger the warning: `;`, `|`, `&`, `$`, `` ` ``, `(`, `)`, `>`, `<`, `\n`

---

## Phase 3 — Environment Handshake

### 3.1 The Problem Being Solved

A template cannot silently harvest environment variables from the caller's shell. Without
an explicit handshake, a malicious or updated template could declare `requires_env:
["AWS_SECRET_ACCESS_KEY"]` and receive it automatically.

### 3.2 The Mechanism

The template declares what it needs:
```json
"requires_env": ["NPM_TOKEN"]
```

The caller's local manifest must explicitly map a local variable to the template's
required input:
```json
{
  "env": {
    "allow": ["NPM_TOKEN"]
  }
}
```

Guardrail intersects these two declarations. The process receives only variables present
in **both** `requires_env` and the caller's `allow` block. A variable in `requires_env`
but not in the caller's `allow` block causes a clear error:

```
Error: Template requires NPM_TOKEN but your manifest does not allow it.
Add it to your envPolicy.allow block to proceed.
```

A variable in the caller's `allow` block but not in `requires_env` is silently dropped.
The template cannot receive more than it declared.

### 3.3 Secret Pattern Enforcement at Handshake Time

When the intersection is computed, every variable name and value is checked against the
secret pattern list from Invariant 2. If a secret-shaped variable is being handed to a
template with `risk: yellow` or higher, Guardrail logs a `secret_in_env_handshake` event.
If the template target is production-like, risk immediately escalates to RED.

---

## Phase 4 — Cryptographic Provenance

### 4.1 What Gets Hashed

When a user first approves a template execution, Guardrail computes:

```
template_hash = SHA256(
  canonical_json(template_definition) +
  canonical_json(resolved_inputs) +
  canonical_json(env_intersection)
)
```

Canonical JSON: keys sorted, whitespace stripped, consistent encoding. This makes the hash
stable across machines and formatting changes.

This hash is written into the local approved manifest:

```json
{
  "template": "standard-npm-publish",
  "template_hash": "a3f9c12...",
  "approved_at": "2024-06-01T14:00:00Z",
  "approved_by": "human"
}
```

### 4.2 Drift Detection on Re-run

On every subsequent run:
1. Guardrail re-reads the template file.
2. Recomputes the hash with the same inputs.
3. Compares against the stored hash.
4. If they differ: **Exit 12 — drift detected.** Nothing executes.

The user must run `guardrail template diff` to see what changed, then re-approve.

### 4.3 Remote Template Pinning

For templates fetched from a remote URI:

```bash
guardrail run --template github://org/templates/npm-publish.json@a3f9c12
```

- The commit SHA is required. Branch names and tags are rejected.
- Guardrail fetches the file, verifies the SHA, hashes the content, and stores both.
- On re-run, it re-fetches and re-verifies. If the content at that SHA has changed
  (which should be impossible for git but isn't for all hosting providers), Exit 12.
- Redirects are not followed.
- The URI scheme must match a declared `trusted_registries` entry in org policy.

---

## Phase 5 — The `guardrail template` Command Surface

### 5.1 Commands

```bash
# Validate a template file without running it
guardrail template lint --template ./templates/npm-publish.json

# Show what a template does in plain English
guardrail template explain --template ./templates/npm-publish.json

# Show what inputs a template expects
guardrail template schema --template ./templates/npm-publish.json

# Simulate a run with given inputs (no execution)
guardrail template simulate \
  --template ./templates/npm-publish.json \
  --input package_dir=packages/my-lib \
  --input tag=beta

# Execute a template with given inputs
guardrail run \
  --template ./templates/npm-publish.json \
  --input package_dir=packages/my-lib \
  --input tag=beta

# Show diff between current template and approved hash
guardrail template diff --template ./templates/npm-publish.json
```

### 5.2 `guardrail template lint` — What It Checks

In order:

1. **Schema validity** — is the JSON well-formed and does it match the template schema?
2. **Structured mode** — every step must declare `mode: structured`. Any `mode: shell` is a lint error.
3. **Input constraints** — every `string` input must have `pattern` or `enum`. Bare strings are rejected.
4. **Interpolation resolution** — every `{{inputs.x}}` references a declared input key.
5. **Rollback presence** — if any step is `idempotent: false`, a rollback section must exist.
6. **Regex complexity** — validator regexes are checked for catastrophic backtracking potential.
7. **Risk consistency** — declared `risk` is cross-checked against the commands, env vars, and trust class. If the declared risk is lower than the computed risk, lint escalates it and warns.
8. **Secret patterns** — `requires_env` entries are checked against the secret name pattern list. Matching entries are flagged with their reason.

### 5.3 `guardrail template explain` — Sample Output

```
Template: standard-npm-publish
Risk:      YELLOW (writes to npm registry)
Trust:     reviewed_internal

What it does:
  1. Runs `npm publish` in structured mode (no shell).
  2. Publishes the package at the path you provide to the npm registry.
  3. On failure, runs `npm unpublish` to clean up.

What it needs from you:
  - Input:   package_dir  (e.g. packages/my-lib)
  - Input:   tag          (one of: latest, beta, next)
  - Env var: NPM_TOKEN    (you must allow this in your envPolicy)

What it cannot do:
  - Access any env var you have not explicitly allowed.
  - Run arbitrary shell commands.
  - Modify its own rollback contract.

Approved hash: not yet approved on this machine.
```

### 5.4 `guardrail template simulate` — Sample Output

```
Simulation (no execution)

Resolved args:
  Step: publish
  Command: npm
  Args:    ["publish", "packages/my-lib", "--tag", "beta"]
  Env:     { NPM_TOKEN: [from caller env] }
  Mode:    structured

Rollback would run:
  Step: unpublish-on-failure
  Command: npm
  Args:    ["unpublish", "packages/my-lib", "--force"]
  Env:     { NPM_TOKEN: [from caller env] }

Risk classification:   YELLOW
Drift from last run:   No prior approval on this machine.

No processes were spawned.
```

---

## Phase 6 — Lint CI Integration

Add template linting to CI before any other step:

```yaml
# .github/workflows/guardrail.yml
- name: Lint Guardrail templates
  run: |
    for f in templates/*.json; do
      guardrail template lint --template "$f" || exit 1
    done

- name: Verify no approved manifest drift
  run: |
    guardrail run \
      --non-interactive \
      --approved-manifest .guardrail/approved.json \
      -- npm test
```

A template that fails lint fails the build. A template that passes lint but drifts from
its approved hash at execution time exits 12.

---

## Phase 7 — Platform Team Workflow

This is the intended distribution model for general developer use.

### Step 1 — Platform team authors a template

```bash
# Author writes template
vim templates/deploy-staging.json

# Lint before committing
guardrail template lint --template templates/deploy-staging.json

# Explain to verify it reads as intended
guardrail template explain --template templates/deploy-staging.json

# Commit to shared repo
git add templates/deploy-staging.json
git commit -m "Add standard staging deploy template"
```

### Step 2 — Developer consumes the template

```bash
# Simulate before approving anything
guardrail template simulate \
  --template ./templates/deploy-staging.json \
  --input target_env=staging \
  --input service=api

# Review, then run (first run prompts for approval)
guardrail run \
  --template ./templates/deploy-staging.json \
  --input target_env=staging \
  --input service=api

# Guardrail output:
# Template: deploy-staging
# Hash: a3f9c12... (not yet approved)
# Approve this template with these inputs? [y/N]
```

### Step 3 — Template updates, drift is caught

```bash
# Platform team updates the template (e.g. adds a health check step)
git pull

# Developer re-runs
guardrail run \
  --template ./templates/deploy-staging.json \
  --input target_env=staging \
  --input service=api

# Guardrail output:
# Exit 12: drift detected
# Template hash changed: a3f9c12 → d7b2e91
# Run `guardrail template diff --template templates/deploy-staging.json` to review.
```

The developer sees exactly what changed before re-approving. They cannot be silently
upgraded to a template that does more than they signed up for.

---

## What Not to Build in v1

| Feature | Reason to defer |
|---|---|
| Template composition / imports | Multiplies provenance surface. Flat templates only until registry trust model is solid |
| `mode: shell` in templates | Defeats the entire injection model. Not a v1 tradeoff |
| Mutable `requires_env` after pinning | A template cannot update what env vars it claims to need post-approval |
| Bare string inputs (no pattern or enum) | Rejected at lint. Not a configurable option |
| Unpinned remote URIs | Branch names and tags are mutable. SHA only |
| Agent-set `idempotent: true` | Must be in the human-signed template definition |

---

## Security Properties Summary

| Attack Vector | Defense |
|---|---|
| Command injection via user input | Structured mode — input is a literal arg, not a shell string |
| Env var harvesting by template | Explicit env handshake — intersection of requires_env and caller allow |
| Silent template update | Hash-locked approval — drift exits 12 before execution |
| Overbroad input patterns | Lint rejects bare strings; patterns validated at approval time |
| Symlink / path substitution | Canonical path resolution per Invariant 4 |
| ReDoS in validator regex | Complexity budget check at lint time |
| Malicious remote template | Pinned SHA + content hash; redirects not followed |
| Rollback manipulation | Rollback declared in signed template, immutable after approval |
