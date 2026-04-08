You’re right. That file was not implementation-grade, and calling it “actual prompts” was a miss.

This document is a backlog-style feature map, not the implementation source of truth. For what Guardrail actually guarantees today, use:

- `README.md` for product boundary and user-facing behavior
- `docs/technical-status.md` for shipped status and explicit non-goals
- `docs/issues.md` for known gaps and corrected historical weaknesses

Everything below must be interpreted through the current Guardrail boundary: it is an approval, drift-control, and audit layer for trusted workflows. It is not a sandbox, not a containment boundary, and not a substitute for host hardening. Open-source additions should bias toward explicit scope, structured logs, low operational complexity, and maintainable zero-dependency implementation.

Here’s the clean version: a **build-oriented feature list** organized so you can turn it into prompts, tickets, or specs yourself.

# Core engine

## 1. Command normalization

* Normalize executable path
* Normalize argument ordering where safe
* Preserve semantic differences that matter
* Strip irrelevant formatting differences
* Produce stable canonical representation

## 2. Scope vector generation

* Represent command name
* Represent args and arg patterns
* Represent env vars accessed or injected
* Represent execution mode
* Represent write/network/elevation traits
* Represent target environment
* Represent resource locks and runtime limits

## 3. Manifest creation

* Create manifest from canonical command/workflow
* Include scope vector
* Include risk classification
* Include trust class
* Include metadata and versioning
* Include approval state
* Include hash/signature fields

## 4. Manifest matching

* Compare proposed execution to approved manifest
* Detect exact match
* Detect narrowing
* Detect widening
* Emit structured diff

## 5. Drift detection

* Binary change
* Argument change
* New flag added
* Removed constraint
* New env var
* New target
* New host/repo/registry
* Risk delta
* Trust delta
* Execution mode delta

## 6. Risk classification

* Green / Yellow / Red
* Read-only local detection
* Local mutation detection
* Network access detection
* Secret handling detection
* Elevated privilege detection
* Destructive flag detection
* Production-target detection
* Generated / unknown provenance default escalation

## 7. Trust classification

* reviewed_internal
* pinned_external
* generated
* unknown
* Provenance capture and persistence

## 8. Approval recording

* Human approval flow
* Manifest acknowledgement
* Signature attachment
* Multiple approval support
* RED two-approval enforcement
* Approval revocation / invalidation

## 9. Non-interactive enforcement

* Require approved manifest
* Fail closed on mismatch
* Exit non-zero on drift
* No one-off bypass in strict mode

# Workflow engine

## 10. Workflow definition format

* Multi-step workflow schema
* Per-step command definitions
* Transitions
* Success/failure states
* Rollback section
* Validators
* Idempotency flags

## 11. Workflow linting

* Invalid transition detection
* Missing rollback detection
* Illegal success-from-failure transition detection
* Regex complexity lint
* Missing required fields
* Disallowed runtime-mutated fields

## 12. Workflow execution

* Step sequencing
* State transitions
* Abort behavior
* Rollback execution
* Retry control
* Step-level validation

## 13. Rollback guarantees

* Rollback required or explicit rollback:none
* Rollback must exist in signed manifest
* Rollback cannot change mid-run
* Rollback uses same enforcement rules as forward path

## 14. Idempotency enforcement

* Default false
* Retry allowed only if predeclared true
* Block agent-added idempotent:true
* Human approval required for retry on non-idempotent steps

# Autonomous negotiation

## 15. Negotiation request generation

* Structured blocked response
* Issue codes
* Field references
* Self-resolvable flag
* Constraint type
* Risk delta
* Round count
* Human-required flag

## 16. Delta application engine

* Accept manifest delta, not full replacement
* Merge delta into base manifest
* Re-run full lint and classification
* Record negotiation round trip

## 17. Self-resolvable issue handling

* Missing rollback
* Missing validator
* Overbroad pattern narrowing
* Secret refactor to reference
* Retry of predeclared idempotent steps

## 18. Non-self-resolvable enforcement

* Any risk escalation
* Any scope widening
* Any signing attempt
* Any rollback mutation after start
* Any pty:true addition by agent
* Any idempotent:true addition by agent
* Any counter/lock dispute
* Any fingerprint mismatch

## 19. Negotiation round limits

* Max rounds
* Escalate on exhaustion
* Log negotiation_exhausted
* Preserve full trace

## 20. Cumulative drift detection

* Track deltas across rounds
* Prevent multi-step “small safe changes” from widening total scope
* Escalate cumulative widening

# Runtime integrity

## 21. Path canonicalization

* Resolve symlinks
* Compare canonical absolute paths
* Block path mismatch

## 22. File provenance enforcement

* Optional file hash in manifest
* Hash actual target before exec
* Block mismatch

## 23. TOCTOU mitigation

* Open file descriptor
* Hash opened file / fd
* Execute from verified fd
* Prevent hash-then-path-exec flow

## 24. Environment fingerprinting

* Capture PATH
* Capture runtime versions
* Capture binary hashes
* Compare at execution time
* Block mismatch

## 25. Secret detection

* Key-name secret matching
* Value-format secret matching
* Base64 / obfuscation checks where practical
* RED escalation with production-like context

## 26. Production-like target detection

* env: prod/production
* hostnames containing prod/live/release
* deploy/publish/release command semantics
* explicit target: production

# Execution policy controls

## 27. Time policy enforcement

* allowedWindow
* validUntil
* maxRuns
* maxExecutionsPerMinute
* Fail closed if counters missing/corrupt

## 28. Counter persistence

* Store outside repo by default
* Atomic updates
* File locking
* Recovery semantics
* Manual reset flow

## 29. Resource bounds

* cpuShares / CPU limits
* memoryMB / memory limits
* ulimit integration
* cgroup integration where available

## 30. Concurrency locks

* Named resource locks
* Queue on collision
* Heartbeat
* TTL
* Auto-release on TTL expiry
* lock_ttl_expired logging

## 31. Anti-interactive execution

* No PTY by default
* Detect stdin blocking
* Exit 13 on interactive prompt
* PTY only if predeclared and human-approved

# Validation and output controls

## 32. Output validator engine

* Regex validator
* JSON schema validator
* Structured parse support
* Treat validator mismatch as failure even on exit 0

## 33. Regex safety lint

* Reject catastrophic backtracking risk
* Complexity budget checks
* Approval-time validation

# Audit and observability

## 34. Local audit log

* Append-only jsonl
* Outside repo by default
* All executions recorded
* All blocks recorded
* All negotiations recorded
* Last stdout/stderr lines attached

## 35. Tamper resistance

* Sequence hashing / prev_hash chain
* Verification on read
* audit_tamper_detected behavior
* Suspend execution pending review if configured

## 36. Audit query surface

* History by trace id
* Filter by blocked/succeeded/escalated
* JSON output
* Agent-specific history

## 37. Metrics and events

* Drift count
* Block count
* Negotiation success rate
* Frequent escalations
* Risk distribution
* Agent behavior signals

# CLI UX

## 38. Core commands

* `guardrail run`
* `guardrail approve`
* `guardrail diff`
* `guardrail explain`
* `guardrail init`
* `guardrail simulate`

## 39. Workflow commands

* `guardrail workflow lint`
* `guardrail workflow run`

## 40. Audit commands

* `guardrail audit history`
* `guardrail audit verify`
* `guardrail audit timeline`
* `guardrail audit heatmap`

## 41. Recipe commands

* `guardrail recipe install`
* `guardrail recipe list`
* `guardrail recipe inspect`
* `guardrail recipe validate`

## 42. Policy commands

* `guardrail policy audit`
* `guardrail policy test`

## 43. Explainability UX

* Explain last block
* Explain manifest
* Explain diff in plain English
* Explain risk reasons
* Explain required next action

# Recipe system

## 44. Recipe packaging

* Packaged safe workflow definitions
* Metadata
* Constraints
* Supported tools
* Example usage
* Risk/trust defaults

## 45. Recipe categories

* GitHub
* Git
* npm/pip
* Terraform
* AWS
* Docker
* OpenClaw
* CI debugging

## 46. Verified recipe channel

* First-party reviewed recipes
* Versioning
* Signature
* Compatibility metadata

## 47. Custom recipe authoring

* Local recipe creation
* Validation
* Linting
* Org overrides that only narrow

# OpenClaw / agent integration

## 48. Wrapper integration

* Run OpenClaw through Guardrail wrapper
* Intercept proposed executions
* Enforce manifest before spawn
* Phase 1 protocols: `stdin-json` and `env-shim`
* Recognize `mcp` profiles but block runtime use until transport support exists

## 49. Native executor integration

* Guardrail as execution backend for agent tasks
* Structured negotiation exchange
* Agent identity capture
* Rich supervisor execution context for command-mode integrations
* Versioned public adapter result schema
* Translation layer between Guardrail internals and public tool contracts
* Declarative adapter profile schema with explicit schema target

## 50. Agent identity and governance

* Agent ID
* Agent trust class
* Per-agent policy
* Per-agent risk cap
* Per-agent metrics
* Per-agent revocation
* Adapter profile provenance and source hash capture
* Structured adapter log and audit events

## 51. Agent strict mode

* Generated commands default RED
* No widening via negotiation
* No non-idempotent retry
* Restricted command families

# Cloud / team / enterprise

## 52. Shared manifests

* Team-visible approved manifests
* Manifest version history
* Reuse across users/CI/agents

## 53. Approval queue

* Pending requests
* Diff review
* Risk display
* Approval/reject actions
* Two-person approval support

## 54. Org policy engine

* Global defaults
* Team-level narrowing
* Cannot widen org defaults
* Risk rules
* Environment rules
* Agent rules

## 55. Identity and access control

* SSO
* RBAC
* Approver roles
* Auditor roles
* Security-team-only approval rules

## 56. Centralized audit

* Org-wide event ingestion
* Search
* Export
* Retention controls
* Compliance reporting

## 57. Hosted key management

* Signing service
* Rotation
* HSM/KMS integration
* Approval signing audit

## 58. Notifications and integrations

* Slack approvals
* Email approvals
* PagerDuty escalation
* Datadog / Splunk / CloudWatch shipping
* GitHub checks / PR comments

## 59. Deployment modes

* SaaS
* Single-tenant
* VPC
* On-prem

# Adoption / usability features

## 60. Learning mode

* Observe current usage
* Suggest manifest
* Batch approval flow
* Reduce cold-start friction

## 61. Profiles

* dev-fast
* ci-strict
* agent-paranoid
* enterprise-controlled defaults

## 62. Safe defaults

* Fail closed
* Minimal required approvals for low-risk local cases
* Strong warnings for unsafe mode selections

## 63. Demo scenarios

* Silent drift demo
* OpenClaw runaway fix demo
* Terraform apply block demo
* Secret escalation demo

# Launch recipe pack

## 64. GitHub recipes

* open_pr
* clone_repo
* gh_release
* gh_secret_set

## 65. Package recipes

* npm_install_safe
* pip_install_safe

## 66. Git recipes

* git_commit_safe
* git_push_safe

## 67. Infra recipes

* terraform_plan_only
* aws_s3_sync_safe
* docker_build_safe
* docker_push_safe

## 68. OpenClaw recipes

* openclaw_open_pr
* openclaw_fix_tests
* openclaw_debug_ci
* openclaw_safe_deploy

# Enterprise-only or enterprise-priority features

## 69. Compliance exports

* SOC2 evidence exports
* Approval trail exports
* Drift incident reports

## 70. Multi-stage approval policies

* Security + platform approval
* Change-window enforcement
* RED dual approval

## 71. Environment separation

* Separate policies for dev/staging/prod
* Strong production-only escalation paths

## 72. Org-wide recipe marketplace

* Approved internal recipes
* Verified vendor recipes
* Revocation and deprecation controls

## 73. Incident response hooks

* Escalate suspicious blocks
* Freeze execution plane
* Review audit chain
* Force reapproval

If you want the most practical next artifact, the three files to write are:

1. **Manifest schema**
2. **Recipe schema**
3. **CLI behavior spec**

Those will turn this feature list into something directly implementable.
