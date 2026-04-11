# Guardrail — Enterprise P0 Fire Trial Report

Status: In progress

## Run Summary

- Start time: 2026-04-11
- Current packet: `P0e` next
- Current status: `P0a through P0d closed after review/fix`
- Operator follow-on: `D0y closed after review/fix`

## Packet Timeline

### P0a — Universal Authorization Seam

- Start time: 2026-04-11
- End time: 2026-04-11
- Execution path: `guardrail run --recipe claude-exec` from parent directory using installed `claude-exec@1.0.0`
- Declared artifact: `docs/plans/REPORT_enterprise_P0a_universal_authorization_seam.md`
- Outcome: `closed after review/fix`
- Repo state before launch:
  - tracked tree clean
  - unrelated untracked paths present: `.claude/`, `a.txt`, `docs/plans/REPORT_pickup_four_open_items_2026-04-09.md`, `mcp-needs-auth-cache.json`, `msg.txt`, `projects/`

### Issues Observed Before Packet Launch

1. `run --recipe claude-exec` from the Guardrail repo root hit duplicate recipe-source collision because both the bundled and installed `claude-exec` recipes were visible.
   - Resolution: rerun from the parent directory so only the installed recipe resolved.
2. The installed `~/.guardrail/recipes/claude-exec/1.0.0.json` was stale and missing the newer `preserve_runtime_env` / auth-probe contract.
   - Symptom: guarded invoke failed with `claude --print failed with exit code 1: Not logged in · Please run /login` even though direct `claude --print hi` worked in the same runtime.
   - Resolution: reinstall the current recipe with `recipe install ... --overwrite`.
3. After reinstall, the exact guarded one-line probe completed successfully.
   - Result: the fire trial can proceed on the same bounded invoke path it intends to prove.
4. The first real `P0a` packet attempt failed before producing artifacts because `claude-exec` inherited the generic 60000ms worker timeout.
   - Symptom: `Step "invoke" timed out after 60000ms` with no packet report written.
   - Resolution: update `claude-exec.recipe.json` to declare its own bounded 900000ms / 15m invoke timeout, validate/tests, and reinstall the recipe into `~/.guardrail`.
5. The second `P0a` packet attempt still made no artifact progress under `mode=default` even after the timeout fix.
   - Symptom: the Guardrail wrapper and Claude child stayed alive for multiple minutes, but the repo showed no packet report or file edits. The Claude child accumulated very little CPU time relative to elapsed time.
   - Interpretation: for autonomous edit packets, `permission-mode default` is the wrong execution shape because it can leave a non-interactive Claude CLI run idling on tool-approval behavior that Guardrail cannot see.
   - Resolution: stop the run and rerun the packet under `mode=acceptEdits`.
6. The `mode=acceptEdits` rerun improved operator visibility by creating the report heartbeat immediately, but Claude still exited without closing the packet report itself.
   - Resolution: complete review/fix in the main agent path, finish the seam, patch the adapter reason regression, wire resident-lane startup through the seam, run focused proof, and finalize the report manually.

## Monitoring Sufficiency

- Guardrail-native surfaces used:
  - `repo status`
  - Guardrail logs in the parent `.guardrail/logs` directory
- report-file heartbeat
- Host-level fallback required:
  - yes, but only for bounded process-state confirmation after Guardrail-native surfaces stopped being informative enough

## Conclusions

1. Guardrail did help solve real problems during the run.
   - It blocked duplicate recipe-source ambiguity instead of silently selecting one.
   - It exposed stale installed recipe metadata as an execution-path defect instead of letting the run fail opaquely.
   - It surfaced the too-short worker timeout as a product bug that could be fixed centrally.
   - It preserved enough bounded state to prove the packet was executing on the intended guarded runtime path.

2. Guardrail also exposed real operator-experience gaps.
   - A one-shot `claude-exec` run is still too opaque once Claude is running for several minutes.
   - Timeout increases help, but they do not provide real progress visibility.
   - The report-file heartbeat is useful, but it still depends on prompt compliance rather than a first-class product contract.

3. The fire trial still succeeded for `P0a`.
   - Claude landed a substantive partial implementation.
   - The main review/fix pass closed the remaining gaps.
   - The packet now has focused passing proof and truthful docs/reporting.

## Remaining Concerns

- `claude-exec` still needs a first-class progress side channel.
- The report heartbeat improved visibility, but Claude did not keep the report updated reliably enough during the run.
- For long-running autonomous edit packets, the resident-lane model is still a better operator surface than one-shot `claude-exec`.

## Next Required Follow-On

Implement a real `claude-exec` progress channel before relying on longer autonomous packet runs as a smooth user experience.

Minimum shape:

- declared progress artifact path or stream
- bounded structured progress format
- periodic checkpoint writes independent of final stdout
- Guardrail-native command/status surface that can read and summarize those checkpoints

`P0a` is closed. The next enterprise packet is `P0b`, and the `claude-exec` progress-channel follow-on is now also closed in this repo.

## D0y Fire-Trial Extension

- Start time: 2026-04-11
- Declared artifact: `docs/plans/REPORT_d0y_guarded_ai_exec_progress_channel.md`
- Final status: `closed after review/fix`

### Launch Issues Observed

1. Running `guardrail run --recipe claude-exec` from the Guardrail repo root still produced duplicate recipe-source ambiguity between:
   - `recipes/claude-exec.recipe.json`
   - `~/.guardrail/recipes/claude-exec/1.0.0.json`
   Classification: `P0 operator-path issue`
   Blocking current run: `no`, because rerunning from the parent directory with the installed recipe worked.

2. `run --recipe` still rejects `--recipe-search-dir` at the CLI parse layer even though later resolution paths support recipe search dirs.
   Classification: `P0 Guardrail CLI bug`
   Blocking current run: `no`, because the parent-directory workaround avoided the parser gap.

3. The live `claude-exec` schema requires explicit recipe inputs that the earlier fire-trial prompt shape did not provide:
   - `model`
   - `effort`
   - `mode`
   - `output_format`
   - `max_budget_usd`
   - `system_prompt`
   - `session_name`
   Classification: `P0 recipe/operator contract issue`
   Blocking current run: `no`, because the launch was corrected to the current schema.

4. Guardrail recipe approval for this path still requires a real TTY. Launching through `tpf` without `--passthrough-tty` produced:
   - `Interactive approval needed but stdin is not a TTY.`
   Classification: `P0 transport/operator-path issue`
   Blocking current run: `yes`, until the launch was retried with `tpf --passthrough-tty`.

5. After the corrected launch and approval, the run reached real execution but still did not emit enough Guardrail-native live progress immediately.
   Classification: `P0 product gap` under `D0y`
   Blocking current run: `not yet terminal`, but it is the primary issue under test because the report heartbeat appears later than it should for a trustworthy long-running operator experience.

6. The first D0y run was stopped too early because the operator treated a stale report heartbeat as a terminal signal even though other bounded signals still showed forward motion.
   - Evidence: the process remained alive and bounded code changes continued in expected D0y files while the report artifact stayed at `CHECKPOINT 1`.
   - Correction: for long-running packets, `stale report heartbeat` must be treated as a warning unless all bounded liveness signals are silent across the stall window.
   Classification: `P0 fire-trial operator policy issue`
   Blocking current run: `no`, but it must be corrected before the rerun is evaluated honestly.

### Final Assessment

- The fire trial did surface the real product gap:
  one-shot `claude-exec` needed a Guardrail-owned progress/query/continue path instead of relying on delayed final stdout plus a prompt-dependent report heartbeat.
- The shipped review/fix pass closed that gap for the current repo scope:
  - Guardrail now writes/reads `.guardrail/ai-progress.ndjson` and `.guardrail/ai-progress-state.json`
  - `guardrail recipe progress --state-dir .guardrail --follow` now provides live monitoring
  - `guardrail recipe continue --state-dir .guardrail --prompt ...` now provides bounded continuation
  - successful exits that hand off for review/input now preserve their soft state instead of collapsing to `completed`
- The operator rule is now explicit:
  a stale report heartbeat is only a warning unless the Guardrail-owned progress channel and bounded file-diff signals also go quiet.

### D0y Remaining Caveat

- The progress side channel is Guardrail-owned and queryable in real time, but the content of the checkpoints is still model-cooperative rather than a native Claude streaming API.
- That caveat is acceptable for the current shipped scope and is now documented clearly in the D0y report, README, and roadmap.
- A later `P0b` run confirmed the failure mode precisely: Guardrail surfaced the wrapper-owned `started` and `completed` checkpoints correctly, but Claude itself emitted no intermediate NDJSON checkpoints. This was a model-cooperation gap, not a dropped Guardrail event.
- As a mitigation, the `claude-exec` contract now accepts an explicit `report_artifact` input and Guardrail treats report-file mtime changes as synthetic progress heartbeats when that path is declared.
- Even with that mitigation, the resident FIFO lane remains the preferred path for genuinely interactive review/feedback loops. The one-shot progress channel is visibility-first, not a replacement for the lane model.

## P0b — Policy Simulation and Decision Traces

- Start time: 2026-04-11
- End time: 2026-04-11
- Execution path: resident Claude lane (`guardrail lane start` + `lane send` / `lane inspect`)
- Declared artifact: `docs/plans/REPORT_enterprise_P0b_policy_simulation_and_decision_traces.md`
- Outcome: `closed after review/fix`

### Issues Observed During Lane-First Execution

1. The resident lane solved the core operator problem from the one-shot runs.
   - Guardrail could query live status and fetch Claude's current assessment mid-run through `lane status` / `lane inspect`.
   - This proved the lane path is the right primary surface for multi-shot execution.

2. Claude initially still could not run the focused `node --test` proof from inside the lane.
   - This happened first under `--permission-mode acceptEdits`, then again after restarting the lane under `--permission-mode dontAsk`.
   - Claude reported its inner shell/Bash tool as blocked, even though the Guardrail lane itself remained healthy and queryable.
   - Follow-up debug confirmed the missing requirement: explicit tool exposure.
   - Restarting the lane with `--allowed-tools "Bash Read Edit Write Glob Grep"` fixed the problem.
   - This also clarified an important boundary: Guardrail can configure the bounded lane contract, but it does not control Claude's own internal tool policy. Claude-side tool approvals or tool availability remain operator-managed downstream behavior.

3. After that restart, Claude itself ran the focused proof successfully through the live lane:
   - `node --test tests/test-policy-scenarios.js` → `43 pass, 0 fail`
   - `node --test --test-name-pattern "policy simulate CLI surface" tests/test-feature-acceptance.js` → `2 passed, 0 failed`

### P0b Conclusion

- The lane-first contract is correct and now documented in the recipe, onboarding, README, and fire-trial plan.
- Guardrail can now supervise a live multi-shot Claude run and retrieve real status updates without collapsing back to one-shot.
- The remaining follow-on is narrower than before: preserve the exact lane-start contract for proof-bearing runs (`--permission-mode dontAsk --allowed-tools "Bash Read Edit Write Glob Grep"`) and expand that pattern into the next packet runs.

### Outer-Sandbox Boundary

- Guardrail resident lanes are implemented and are the intended multi-shot autonomous path inside Guardrail.
- Guardrail now defaults resident-lane key and host-state paths to repo-local `.guardrail/host-lanes/...` for autonomous repo-scoped runs.
- That removes the repeated outer-sandbox approval churn for ordinary `lane start`, `lane send`, `lane status`, `lane inspect`, `lane wait`, and `lane result` traffic in this repo-scoped fire-trial mode.
- Broader host-wide portfolio views remain an explicit widening step rather than the default.
- This gap was tracked as `D0z` and is now closed in the roadmap.

### Operator Rule: Approved Lane Prefix Reuse

- If the supervising environment has already approved the `node src/cli.js lane` command prefix, later lane operations inside that same boundary must reuse the approved prefix directly.
- Do not reissue routine `lane send`, `lane status`, `lane inspect`, `lane wait`, or `lane result` calls as new escalated requests once that prefix is already approved.
- Ask for a fresh approval only when the boundary truly changes:
  - widened scope
  - different runtime/tool/model/system prompt/budget in an approval-bound way
  - widened host-level operations outside the repo-local lane mode
  - raw host inspection outside Guardrail

### P0c — Sovereign Record Metadata Model

- Start time: 2026-04-11
- End time: 2026-04-11
- Execution path: resident Claude lane (`enterprise-p0cd-lane`) with `dontAsk`, explicit allowed tools, and visible `$10.00` budget
- Declared artifact: `docs/plans/REPORT_enterprise_P0c_sovereign_record_metadata_model.md`
- Outcome: `closed after review/fix`
- Focused proof:
  - `node --test tests/test-bucket3.js tests/test-bucket6.js`
  - result: `108 pass, 0 fail`
- Notes:
  - `organization_id`, `workspace_id`, `retention_class`, `payload_hash`, `sensitivity`, and `source_provenance` are now standardized through shared helpers and carried into audit/metrics/compliance export paths.
  - The packet held up under local review after the lane run; no follow-up rerun was needed.

### P0d — Single Crypto Boundary

- Start time: 2026-04-11
- End time: 2026-04-11
- Execution path: same resident Claude lane/session as `P0c`
- Declared artifact: `docs/plans/REPORT_enterprise_P0d_single_crypto_boundary.md`
- Outcome: `closed after review/fix`
- Focused proof:
  - `node --test tests/test-bucket6.js`
  - result: `59 pass, 0 fail`
- Notes:
  - The packet confirmed that secret-at-rest writes stay behind `src/key-management.js` and documented the intentionally-plaintext governance/workflow state paths.
  - The lane remained healthy through the packet transition; Guardrail monitoring stayed inside lane-native surfaces.
