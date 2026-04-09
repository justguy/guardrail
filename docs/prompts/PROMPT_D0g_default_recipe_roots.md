# Claude Prompt — D0g Repo Or Config-Level Default Recipe Roots

Audience: Claude or another external coding agent  
Goal: Let repos or user config declare trusted default recipe roots so workflows do not need to repeat `--recipe-search-dir` everywhere

## Read First

- `docs/technical-status.md`
- `docs/prompts/PROMPT_D0d_unified_workflow_recipe_discovery.md`
- `src/cli.js`
- `src/recipe-runner.js`
- `src/workflow.js`
- existing config helpers and config file paths already used by Guardrail
- `tests/test-feature-acceptance.js`
- `tests/test-recipe-system.js`
- `tests/test-workflow.js`

## Use Subagents

Do not run this in parallel with `D0d` or `D0f`. Keep one owner for:

- CLI/config plumbing
- recipe discovery defaults
- workflow/default-root tests

## Task

Implement default recipe-root configuration in the narrowest safe way:

1. support repo-level and/or user-level configured default roots
2. feed those roots into the shared recipe discovery path
3. keep explicit `--recipe-search-dir` as the strongest override
4. surface clear diagnostics when configured roots are missing, invalid, or collide

## Acceptance Criteria

- common workflow and recipe runs can rely on configured default roots without repeating CLI flags
- explicit roots still override defaults deterministically
- misconfigured roots fail closed with actionable diagnostics
- docs show when to use defaults versus explicit overrides

## Hard Constraints

- do not silently trust arbitrary extra roots
- do not add org-wide governance policy here; that belongs to later policy work
- do not create hidden precedence rules that differ from `D0d`/`D0f`

## Stop Conditions

Pause and ask for clarification if:

- the current config model has no clean place for default roots
- adding default roots would conflict with documented trust or provenance behavior
