# Guardrail — Parameter Approval & Risk Taxonomy Implementation Plan

**Revision 2** — incorporates 10 review fixes

## What This Is

An implementation plan to upgrade Guardrail's parameter system from structural-only validation to a capability-aware execution contract system. Derived from:

1. **Parameter Approval Model** — typed validators (exact, enum, range, path_policy, list, review_each_time)
2. **Risk Taxonomy** — three-bucket model (allow/flag/block), risk traits not denylists, capability-based approval
3. **Review Feedback** — 10 fixes: execution shape locking, capability-level approvals, parsing over regex, cross-parameter escalation, normalization binding, review_each_time enforcement, safe fallback, capability summaries, hard size limits, one-time-only policy for v1

## Current State

- **3 input types**: string (pattern/enum), integer (min/max), boolean
- **Structural validation only**: constraints checked at recipe load, NOT enforced against runtime values
- **Hard-coded deny patterns**: `BLOCKED_PATTERNS` in recipe-executor.js and safe-defaults.js
- **No per-parameter approval**: entire recipe approved or not
- **No execution shape tracking**: no constraint on single vs multi-command

## Target State

```
User input
    │
    ▼
Normalize (path, list, json, whitespace)
    │
    ▼
Validate (typed: exact/enum/range/path_policy/list)
    │
    ▼
Analyze (shell content → parse commands, detect capabilities)
    │
    ▼
Emit risk traits + compute cross-parameter escalation
    │
    ▼
Enforce hard limits (max length, max depth, max items)
    │
    ▼
Classify bucket
    │
    ├─── ALLOW (no traits) → proceed silently
    ├─── FLAG (non-critical traits) → pause, show capabilities, require approval
    └─── BLOCK (critical traits OR hard limit exceeded) → halt
```

---

## Phase 1 — Risk Trait Taxonomy (`src/risk-traits.js`, ~180 lines)

Foundation for everything else.

### Risk traits

```javascript
export const RISK_TRAITS = {
  // Execution shape
  execution_chaining:    { severity: 'high',    capability: 'Execute multiple commands' },
  command_substitution:  { severity: 'high',    capability: 'Inject dynamic command output' },
  io_redirection:        { severity: 'medium',  capability: 'Redirect I/O to filesystem or pipe' },

  // Scope
  scope_widening:        { severity: 'high',    capability: 'Expand file/target scope' },
  path_escape_attempt:   { severity: 'critical', capability: null },  // always block
  recursive_flag:        { severity: 'medium',  capability: 'Expand blast radius (recursive/global)' },

  // Target
  prod_target_reference: { severity: 'high',    capability: 'Target production environment' },
  secret_reference:      { severity: 'high',    capability: 'Access secrets or credentials' },

  // Cardinality
  high_cardinality_input:{ severity: 'medium',  capability: 'Operate on broad target set' },
  unbounded_pattern:     { severity: 'medium',  capability: 'Match files with broad glob' },

  // Text
  free_text_instruction: { severity: 'medium',  capability: 'Provide free-form instructions' },
  destructive_intent:    { severity: 'high',    capability: 'Perform destructive action' },

  // Structure
  unsupported_structure: { severity: 'critical', capability: null },  // always block
  mode_transition:       { severity: 'critical', capability: null },  // always block

  // Composite (emitted by cross-parameter analysis)
  amplified_scope_risk:  { severity: 'high',    capability: 'Broad scope + high cardinality combined' },
};
```

### Bucket classification

```javascript
export function classifyBucket(traits) {
  if (traits.some(t => RISK_TRAITS[t]?.severity === 'critical'))
    return 'block';
  if (traits.length > 0)
    return 'flag';
  return 'allow';
}
```

### Capability summary (for UX, not just trait names)

```javascript
export function summarizeCapabilities(traits) {
  return traits
    .map(t => RISK_TRAITS[t]?.capability)
    .filter(Boolean);
  // Returns: ["Execute multiple commands", "Expand file scope"]
}
```

### Cross-parameter escalation

```javascript
export function escalateTraits(traits) {
  const out = [...traits];
  if (traits.includes('scope_widening') && traits.includes('high_cardinality_input'))
    out.push('amplified_scope_risk');
  if (traits.includes('execution_chaining') && traits.includes('destructive_intent'))
    out.push('amplified_scope_risk');
  if (traits.includes('prod_target_reference') && traits.includes('recursive_flag'))
    out.push('amplified_scope_risk');
  return [...new Set(out)];
}
```

---

## Phase 2 — Input Value Validator (`src/input-validator.js`, ~280 lines)

### Core function

```javascript
validateInputValue(value, schema, opts)
  → { valid, normalized, risk_traits[], reasons[], parsed_shape? }
```

### Hard limits (enforced before validation)

```javascript
const HARD_LIMITS = {
  max_string_length: 4096,
  max_list_items: 100,
  max_path_depth: 20,
  max_glob_star_count: 3,
};
```

Values exceeding hard limits → BLOCK (not flag).

### Approval modes

| Mode | Validation | Normalization |
|------|------------|---------------|
| `exact` | `normalized === schema.value` | Type-specific |
| `enum` | `schema.enum.includes(normalized)` | String trim |
| `range` | `min <= value <= max` | Number coerce |
| `path_policy` | Structural path rules | Path normalize |
| `list` | Per-item + cardinality | Sort if unordered, dedup |
| `review_each_time` | Always returns `approval_required: true` | None |

Legacy inference: no `approval_mode` + has `pattern` → string, has `enum` → enum, has `min`/`max` → range. **No approval_mode and no constraints → `review_each_time`** (safe fallback, fix #7).

### Path policy validator

```javascript
function validatePathPolicy(value, rules) {
  const normalized = normalizePath(value);
  // rules: { must_be_relative, allowed_roots[], deny_segments[], max_depth, allowed_extensions[] }

  // Hard blocks (critical traits)
  if (rules.deny_segments?.some(s => normalized.split('/').includes(s)))
    return block('path_escape_attempt', `Denied segment in path`);
  if (rules.must_be_relative && isAbsolute(normalized))
    return block('unsupported_structure', 'Must be relative path');
  if (rules.allowed_roots && !rules.allowed_roots.some(r => normalized.startsWith(r)))
    // Check if it's an escape vs just widening
    if (normalized.includes('..')) return block('path_escape_attempt', 'Traversal escapes approved root');
    else return flag('scope_widening', `Outside approved roots: ${rules.allowed_roots.join(', ')}`);

  // Flags
  const traits = [];
  if (rules.max_depth && normalized.split('/').length > rules.max_depth)
    traits.push('high_cardinality_input');
  if (rules.allowed_extensions) {
    const ext = extname(normalized);
    if (ext && !rules.allowed_extensions.includes(ext))
      traits.push('scope_widening');
  }

  return { valid: true, normalized, risk_traits: traits, reasons: [] };
}
```

### Shell content analyzer (PARSING, not just regex — fix #3)

```javascript
function analyzeShellContent(value) {
  const traits = [];
  const parsed = { commands: [], operators: [] };

  // Tokenize: split on operators, preserving them
  const segments = value.split(/(\s*(?:&&|\|\||;|\|)\s*)/);
  let currentCmd = [];
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (/^(&&|\|\||;|\|)$/.test(trimmed)) {
      if (currentCmd.length > 0) parsed.commands.push(currentCmd);
      parsed.operators.push(trimmed);
      currentCmd = [];
      if (trimmed === '&&' || trimmed === ';') traits.push('execution_chaining');
      if (trimmed === '|') traits.push('io_redirection');
    } else if (trimmed) {
      currentCmd.push(...trimmed.split(/\s+/));
    }
  }
  if (currentCmd.length > 0) parsed.commands.push(currentCmd);

  // Additional detection
  if (/\$\(|`/.test(value)) traits.push('command_substitution');
  if (/>{1,2}|</.test(value)) traits.push('io_redirection');
  if (/--force\b/.test(value)) traits.push('recursive_flag');
  if (/--all\b/.test(value)) traits.push('scope_widening');
  if (/\.\.\//g.test(value)) traits.push('scope_widening');

  return { traits: [...new Set(traits)], parsed };
}
```

This returns parsed command structure, not just trait names. The approval UX can show:

```
Approved shape: ["npm", "test"]
Requested shape: ["npm", "test"] → && → ["npm", "run", "lint"]
```

### Normalization (fix #5)

Every validated value stores its normalized form alongside the raw value:

```javascript
function normalizeValue(value, schema) {
  if (schema.approval_mode === 'path_policy' || inferMode(schema) === 'path_policy')
    return normalizePath(value);  // collapse //, strip ./, resolve ..
  if (schema.type === 'string') return String(value).trim();
  if (schema.type === 'integer') return Number(value);
  if (schema.type === 'boolean') return value === 'true' || value === true;
  return value;
}
```

### `review_each_time` enforcement (fix #6)

```javascript
if (mode === 'review_each_time') {
  return {
    valid: true,
    normalized: value,
    risk_traits: ['free_text_instruction'],
    reasons: ['This parameter requires fresh approval every time'],
    approval_required: true,
    never_reuse: true,   // manifest must NOT auto-approve this
  };
}
```

---

## Phase 3 — Execution Shape Constraint (`src/risk-traits.js` extension, fix #1)

### Execution shape in manifest

```json
{
  "execution_shape": {
    "type": "single",
    "max_commands": 1,
    "allowed_binaries": ["npm"]
  }
}
```

### Enforcement

When an input value is parsed and found to contain chained commands:

```javascript
function checkExecutionShape(parsedCommands, approvedShape) {
  if (!approvedShape) return [];  // no shape constraint
  const traits = [];

  if (approvedShape.type === 'single' && parsedCommands.length > 1)
    traits.push('execution_chaining');
  if (approvedShape.max_commands && parsedCommands.length > approvedShape.max_commands)
    traits.push('execution_chaining');
  if (approvedShape.allowed_binaries) {
    for (const cmd of parsedCommands) {
      if (!approvedShape.allowed_binaries.includes(cmd[0]))
        traits.push('scope_widening');
    }
  }

  return traits;
}
```

This prevents `npm test && rm -rf /` from being approved under a "chaining allowed" umbrella — the `rm` binary isn't in `allowed_binaries`.

### Capability-level approval (fix #2)

When user approves a flagged chaining input, store what was approved:

```json
{
  "approved_capabilities": {
    "execution_chaining": {
      "max_commands": 2,
      "allowed_commands": [["npm", "test"], ["npm", "run", "lint"]],
      "approved_at": "2026-04-07T..."
    }
  }
}
```

On re-run: check actual parsed commands against approved commands. New commands or more commands → re-flag.

**For v1**: one-time approval only (fix #10). No persisted capability widening. Each flagged value requires fresh approval unless the exact normalized value matches a previously approved manifest.

---

## Phase 4 — Wire Into Recipe Runner

### Changes to `resolveInputs()`

```javascript
export function resolveInputs(recipe, cliInputs, opts = {}) {
  const resolved = {};
  const flagged = [];
  const errors = [];

  for (const [key, schema] of Object.entries(recipe.inputs || {})) {
    const raw = cliInputs[key] ?? schema.default;
    if (raw === undefined && schema.required !== false) {
      errors.push(`Missing required input: "${key}"`);
      continue;
    }
    if (raw === undefined) continue;

    const result = validateInputValue(raw, schema, {
      execution_shape: opts.execution_shape,
    });

    if (!result.valid) {
      errors.push(`Input "${key}": ${result.reasons.join(', ')}`);
      continue;
    }

    // Cross-parameter escalation (fix #4)
    // Collected after all inputs validated, applied below

    resolved[key] = result.normalized ?? raw;

    if (result.risk_traits.length > 0 || result.never_reuse) {
      flagged.push({
        key, value: raw, normalized: result.normalized,
        traits: result.risk_traits, reasons: result.reasons,
        capabilities: summarizeCapabilities(result.risk_traits),
        parsed_shape: result.parsed_shape,
        never_reuse: result.never_reuse || false,
      });
    }
  }

  // Cross-parameter escalation (fix #4)
  if (flagged.length > 0) {
    const allTraits = flagged.flatMap(f => f.traits);
    const escalated = escalateTraits(allTraits);
    const newTraits = escalated.filter(t => !allTraits.includes(t));
    if (newTraits.length > 0) {
      flagged.push({
        key: '_cross_parameter', value: null,
        traits: newTraits,
        reasons: newTraits.map(t => RISK_TRAITS[t]?.capability || t),
        capabilities: summarizeCapabilities(newTraits),
      });
    }
  }

  return { resolved, flagged, errors };
}
```

### Caller behavior

Interactive mode:
```
for (const f of flagged) {
  const bucket = classifyBucket(f.traits);
  if (bucket === 'block') → halt with block explanation
  if (bucket === 'flag')  → show capability summary, ask for approval
}
```

Non-interactive mode:
```
if (flagged.length > 0 && !allFlaggedMatchManifest()) → exit 10 (approval_required)
```

---

## Phase 5 — Manifest Storage (v1: one-time approval only, fix #10)

### What's stored

```json
{
  "approvedInputs": {
    "repo_path": {
      "approval_mode": "path_policy",
      "raw_value": "src/utils.js",
      "normalized_value": "src/utils.js",
      "risk_traits": [],
      "approved_at": "2026-04-07T..."
    },
    "command": {
      "approval_mode": "enum",
      "raw_value": "npm test && npm run lint",
      "normalized_value": "npm test && npm run lint",
      "risk_traits": ["execution_chaining"],
      "approved_capabilities": {
        "execution_chaining": {
          "allowed_commands": [["npm","test"],["npm","run","lint"]]
        }
      },
      "approved_at": "2026-04-07T..."
    }
  },
  "execution_shape": {
    "type": "multi",
    "max_commands": 2,
    "allowed_binaries": ["npm"]
  }
}
```

### Reuse check

On re-run, for each input:
1. If `never_reuse` → always flag (review_each_time)
2. If `normalized_value` matches approved `normalized_value` exactly → allow
3. If value is different → re-validate, re-flag

**No policy widening in v1.** Wider values always require fresh approval. Policy widening (approve a range/set instead of exact values) is deferred.

---

## Phase 6 — Approval UX

### Capability summary (fix #8)

```
Execution paused

New capabilities requested:
  - Execute multiple commands (chaining)
  - Expand file scope (glob pattern)

Details:
  Input "command": "npm test && npm run lint"
    Parsed: ["npm", "test"] → && → ["npm", "run", "lint"]
    Approved shape was: single command
    Requested shape: 2 chained commands

  Input "target": "src/**"
    Approved: exact "src/utils.js"
    Requested: glob matching all files in src/

Approve? [y/N]
```

### Block explanation

```
Execution blocked

  Input "path": "../../../etc/passwd"
  Reason: Path traversal escapes approved root after normalization
  Normalized: /etc/passwd
  Approved root: src/

  This input cannot be validated safely.
```

---

## File Plan

| File | Lines | Status | Purpose |
|------|-------|--------|---------|
| `src/risk-traits.js` | ~180 | New | Trait taxonomy, bucket classification, capability summary, cross-param escalation |
| `src/input-validator.js` | ~280 | New | Typed validation, path policy, list, shell parsing, normalization, hard limits |
| `src/recipe-runner.js` | ~50 | Modify | Wire validation into resolveInputs(), handle flagged/blocked |
| `src/recipe.js` | ~15 | Modify | Accept `approval_mode` in input schema |
| `src/cli.js` | ~40 | Modify | Capability summary UX for flagged inputs |
| `tests/test-input-validator.js` | ~350 | New | All validation modes, path policy, shell parsing, limits |
| `tests/test-risk-traits.js` | ~120 | New | Traits, buckets, capabilities, escalation |

---

## Implementation Order

1. **risk-traits.js** — foundation, no dependencies
2. **input-validator.js** — uses risk-traits, tested independently
3. **recipe-runner.js** — wire validation, handle flagged
4. **recipe.js** — accept approval_mode field
5. **cli.js** — capability summary UX
6. **Tests** alongside each module

---

## Backwards Compatibility

- No `approval_mode` + has constraints → infer mode from existing fields
- No `approval_mode` + no constraints → `review_each_time` (fix #7, safe fallback)
- Existing recipes unchanged — new fields are optional
- All 875 existing tests must pass
- New validation is additive — current hard blocks remain

---

## v1 Boundaries

**Build:**
- Typed validators (exact, enum, range, path_policy, list, review_each_time)
- Risk trait taxonomy with capability descriptions
- Shell content parsing (not just regex)
- Cross-parameter escalation
- Execution shape constraints
- Hard size/length/depth limits
- Normalization binding in manifest
- One-time approval only
- Capability summary UX

**Defer to v2:**
- Policy widening persistence (approve ranges/sets for reuse)
- Prompt template slots
- JSON schema validation
- Similarity-bounded free text reuse
- Full cross-input constraints (if env=prod then batch_size max 5)

---

## Success Criteria

1. `npm test && npm run lint` → flagged as `execution_chaining` with parsed shape, not hard-denied
2. `../../etc/passwd` → hard-blocked as `path_escape_attempt`
3. `src/utils.js` under `path_policy(allowed_roots: ["src/"])` → auto-allowed
4. `--force` → flagged as `recursive_flag` with capability "Expand blast radius"
5. `scope_widening + high_cardinality_input` → escalated to `amplified_scope_risk`
6. `review_each_time` parameter → always flagged, never auto-approved
7. No `approval_mode` + no constraints → treated as `review_each_time`
8. String > 4096 chars → hard block
9. Path with depth > 20 → hard block
10. All 875 existing tests still pass
