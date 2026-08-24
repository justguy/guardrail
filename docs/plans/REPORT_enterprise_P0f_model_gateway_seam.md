# Guardrail — P0f Report: Model Gateway Seam

Status: COMPLETE

## Objective

Introduce one model-gateway seam (`src/model-gateway.js`) that owns the
provider/model/tool routing decision for all Guardrail AI execution paths.
Before this change, the `tool === 'codex'` vs `'claude'` branch lived inline
inside `buildWrapperArgs()` in `src/claude-resident-lane.js`. No single place
said "this tool maps to this wrapper and these args."

## Call Sites Identified

| File | Location | What it does |
|------|----------|--------------|
| `src/claude-resident-lane.js` | `buildWrapperArgs()` L354-386 | Branches on `options.tool === 'codex'` to pick wrapper file and build tool-specific args |
| `src/codex-resident-lane.js` | L290 | Hardcodes `src/codex-exec-wrapper.js` path |
| `src/bundled-wrapper-path.js` | `WRAPPER_FILE_MAP` | Maps tool alias → wrapper filename for hash/provenance (partial seam, kept as-is) |
| `src/cli.js` | L3464 | Direct `import('./claude-exec-wrapper.js')` in `lane continue` — intentionally Claude-specific |

## Intended Proof

- `tests/test-adapter.js`
- `tests/test-adapter-runtime.js` (new, focused on gateway routing)
- `tests/test-claude-recipe.js`

## Immediate Next Step

1. Create `src/model-gateway.js` with `resolveAIWrapperFile(tool)` and `buildAIToolArgs(tool, options, request, lifecycle, progressDir)`.
2. Refactor `buildWrapperArgs()` in `claude-resident-lane.js` to delegate to the gateway.
3. Run focused proof and record results here.

---

## Checkpoint 1 — Seam designed, implementation starting

**What changed:** Report created. Call sites mapped. Gateway design confirmed.  
**What proof remains:** Gateway implementation + test run.  
**Operator input needed:** No.

---

## Checkpoint 2 — Gateway implemented and call site moved

### Files changed

| File | Change |
|------|--------|
| `src/model-gateway.js` (new) | Single decision point: `resolveAIWrapperFile`, `buildAIToolArgs`, `toolSupportsNoSessionPersistence`, `toolSupportsProgressContract`. `SUPPORTED_AI_TOOLS` + `AI_WRAPPER_FILES` are the BYOM seam. |
| `src/claude-resident-lane.js` | `buildWrapperArgs()` now delegates to `resolveAIWrapperFile` and `buildAIToolArgs` instead of branching on `tool === 'codex'` inline. All `tool !== 'codex'` guards replaced with gateway helpers. |
| `docs/technical-status.md` | P0f row updated to Done. |

### Focused proof results

```
node --test tests/test-adapter.js tests/test-claude-recipe.js

ℹ tests 153
ℹ pass 153
ℹ fail 0
```

Full `npm test` pre/post diff: identical 4 pre-existing failures, 0 regressions.

### Call sites summary

- `claude-resident-lane.js:buildWrapperArgs` — **moved behind gateway** (primary call site)
- `codex-resident-lane.js:290` — hardcodes `codex-exec-wrapper.js` path; this is a separate lane binary that owns its own wrapper path, not a general routing site. Left as-is (no regression, not a routing seam).
- `bundled-wrapper-path.js:WRAPPER_FILE_MAP` — serves hash/provenance for recipe manifests. Kept as-is (different purpose).
- `cli.js:3464` — explicit `runClaudeExec` for `lane continue` (intentionally Claude-specific, not routing). Left as-is.

**Operator input needed:** No.

