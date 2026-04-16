# Guardrail — Agent Instructions

These instructions apply to the entire repository tree.

## Raw Git Guardrails

Do not execute raw destructive or remote-mutating Git commands in this repository.

Blocked raw commands:
- `git push`
- `git push --force`
- `git push --force-with-lease`
- `git reset --hard`
- `git clean -f`
- `git clean -fd`
- `git branch -D`
- `git checkout .`
- `git checkout -- .`
- `git restore .`

Required alternatives:
- For a normal push, use `guardrail run --recipe git-push --input repo_path=. --input remote=origin --input branch=feature/<name>`.
- For a force push, use `guardrail run --recipe git-force-push-safe --input repo_path=. --input remote=origin --input branch=feature/<name> --input expected_head=<sha> --input expected_remote_oid=<sha>`.

If the task appears to require `reset --hard`, `clean -f`, branch deletion, or worktree wipe commands, stop and ask the operator. There is no shipped bounded Guardrail recipe for those destructive forms.

## Approval Expectations

If you are operating in a mode that supports explicit command approval, require approval before any Git mutation.

If you are operating in an autonomous mode that can execute shell commands without per-command approval, you must still obey the raw Git guardrails above and use the Guardrail recipes instead of raw `git push` or other blocked commands.

## Validation

When you change code, run the relevant focused tests after the change. Prefer the smallest test scope that proves the new behavior.
