# Guardrail — Feature Acceptance Test Results

**Source:** [tests/test-feature-acceptance.js](../tests/test-feature-acceptance.js)
**Method:** Every test derived from README claims, not from code. If a test fails, the feature is broken or the README is lying.
**Run:** `npm run test:acceptance`
**Last run:** 2026-04-08 — **56/56 PASS**

---

## Command Mode (README: "Three Execution Modes")

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 1 | `run -- echo hello` without approved manifest | Fail closed (exit != 0) | PASS |
| 2 | `run --shell "echo hi"` without manifest | Fail closed | PASS |
| 3 | `run "echo hi && rm -rf /"` (shell metacharacters) | Rejected with --shell suggestion | PASS |

## Workflow Mode

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 4 | `workflow lint` on valid definition | Exit 0, no errors | PASS |
| 5 | `workflow lint` on invalid JSON | Exit != 0 | PASS |

## Template Mode

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 6 | `template lint` on valid template | Exit 0 | PASS |
| 7 | `template explain` shows name and description | Output contains template name | PASS |
| 8 | `template schema` shows input fields | Output contains input names | PASS |
| 9 | `template simulate` with inputs | Shows resolved args | PASS |
| 10 | `template lint` rejects bare strings (no pattern/enum) | Lint error or warning about bare strings | PASS |

## Risk Classification (README: "Traffic-light risk model")

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 11 | Safe git command dry-run | "Safe: YES" | PASS |

## Recipe System (README: "Guardrail Recipes")

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 12 | `list` shows all recipes | Output includes git-branch-cleanup, npm-publish, infra-deploy | PASS |
| 13 | `list --json` returns JSON array | Valid JSON with id, version, risk_level | PASS |
| 14 | `list --category git` filters correctly | All results have category=git | PASS |
| 15 | `recipe validate` on valid recipe | Exit 0, "valid" in output | PASS |
| 16 | `recipe inspect` on packed recipe | Exit 0, "Verified: YES" | PASS |
| 17 | `recipe install` to versioned registry | Exit 0, path contains `<id>/<version>.json` | PASS |
| 18 | `recipe versions` shows installed versions | Lists version numbers | PASS |
| 19 | `recipe install <bare-name>` | Fails with `github://` guidance | PASS |
| 20 | `recipe publish --dry-run --manifest <path>` | Outputs publishable recipe preview | PASS |

## Recipe Execution + Versioning

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 21 | `run --recipe <id> --dry-run` (latest) | Shows recipe name, "Safe" status | PASS |
| 22 | `run --recipe <id>@<version> --dry-run` (pinned) | Resolves exact version | PASS |
| 23 | `run --recipe <id>@99.0.0` (nonexistent version) | Error with available versions | PASS |
| 24 | `run --recipe <id> --dry-run` missing input | Error naming the missing input | PASS |
| 25 | `run --recipe <id>` invalid enum input | Error showing allowed values | PASS |
| 26 | All 6 shipped recipes dry-run | All exit 0, all "Safe: YES" | PASS |

### 6 Recipe Dry-Runs

| Recipe | Inputs | Steps | Result |
|--------|--------|-------|--------|
| git-branch-cleanup | repo_path=. | 2 | PASS |
| dep-upgrade | package_dir=. scope=patch | 3 | PASS |
| github-pr-merge | repo=org/repo max_prs=3 label=approved | 3 | PASS |
| infra-deploy | environment=staging config_path=configs/main.tf | 3 | PASS |
| npm-publish | package_dir=pkg tag=latest | 4 | PASS |
| openclaw-wrapper | flow_id=fix-tests scope=write | 3 | PASS |

## CI / Non-Interactive Mode

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 27 | `--non-interactive` without `--approved-manifest` | Exit 10 | PASS |
| 28 | `--non-interactive` with missing manifest file | Fail closed | PASS |
| 29 | `--json` flag produces valid JSON | Parseable JSON | PASS |
| 30 | Workflow `--non-interactive` without manifest | Exit 10 | PASS |

## Drift Detection

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 31 | Mismatched manifest + `--non-interactive` | Fail (never silently succeed) | PASS |

## Self-Verification

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 32 | `verify` | Exit 0, "All checks passed" | PASS |
| 33 | `verify --json` | JSON with `passed: true`, checks array | PASS |

## Demo Commands

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 34 | `demo list` | Shows drift, recipe, trust, blocked | PASS |
| 35 | `demo recipe` | "Demo complete" | PASS |
| 36 | `demo trust` | "Demo complete" | PASS |
| 37 | `demo blocked` | BLOCKED + RED + "Demo complete" | PASS |

## Audit Commands

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 38 | `audit verify` | Runs without crash | PASS |
| 39 | `audit verify --path <empty-file>` | Exit 0 | PASS |

## Profile & Policy

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 40 | `profile list` | Runs without error | PASS |
| 41 | `policy list` | Runs without error | PASS |

## Metrics

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 42 | `metrics` | Runs without crash | PASS |

## Secret Detection (README: "Environment Policy")

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 43 | `DB_SECRET` in env inject | "secret injection enabled" reason | PASS |
| 44 | `API_TOKEN` in env allow | "secret injection enabled" reason | PASS |
| 45 | Secret + production target | Risk = RED | PASS |

## Pack Command

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 46 | `pack` recipe → creates file with hash | File exists, has content_hash, immutable=true | PASS |

## Create Command

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 47 | `create --name X --category git` | Skeleton with correct category, inputs, steps, guardrails | PASS |

## CLI Basics

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 48 | `--version` | Shows semver | PASS |
| 49 | `--help` | Shows usage with "run" | PASS |
| 50 | No args | Shows usage | PASS |

## Recipe Immutability

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 51 | Re-install same recipe | Idempotent (exit 0 both times) | PASS |
| 52 | Tampered packed recipe | Inspect shows "FAILED" | PASS |

---

## Summary

**56 feature acceptance tests, 56 passing.**

Every documented feature in the README has at least one test proving it works. Tests exercise the actual CLI binary (`node src/cli.js`) with real arguments, real files, and real output assertions — not mocked internals.
