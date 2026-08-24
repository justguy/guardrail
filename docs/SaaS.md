# Guardrail — Enterprise SaaS Architecture

## 1. Product Scope

Guardrail is a multi-tenant control plane for safe automation. It manages recipes, approvals, policy enforcement, execution governance, identity, audit, and compliance across local CLI usage, team deployments, and enterprise-managed environments.

The SaaS product has three operating models:

* **Cloud control plane + local execution**: SaaS stores policy, manifests, approvals, audit, identity, and orchestration metadata; execution happens on customer machines, runners, or agents.
* **Cloud control plane + managed execution**: SaaS also runs approved workloads in isolated worker environments.
* **Hybrid / self-hosted execution plane**: control plane remains hosted, while execution workers, secret stores, and event sinks run inside customer infrastructure.

This architecture assumes:

* multi-tenant B2B SaaS
* API-first design
* CLI-first UX with optional web app
* strong auditability
* org-level governance and RBAC
* strict tenant isolation

---

## 2. High-Level Architecture

```text
                        +----------------------+
                        |   Web App / Admin    |
                        +----------+-----------+
                                   |
                                   v
+---------+      +-----------------+------------------+      +----------------+
| CLI /   | ---> | API Gateway / Auth / Rate Limits   | <--> | Identity SSO   |
| Agents  |      +-----------------+------------------+      | (OIDC/SAML)    |
+----+----+                        |
     |                             v
     |         +-----------------------------------------------+
     |         |               Core Control Plane              |
     |         |-----------------------------------------------|
     |         | Tenant Service                                |
     |         | Org / Project / Environment Service           |
     |         | Recipe / Manifest Service                     |
     |         | Policy Engine Service                         |
     |         | Approval Workflow Service                     |
     |         | Execution Orchestrator                        |
     |         | Audit / Events Service                        |
     |         | Notification Service                          |
     |         | Marketplace Service                           |
     |         | Compliance Export Service                     |
     |         | Secrets Metadata Service                      |
     |         +-------------------+---------------------------+
     |                             |
     |                             v
     |            +-----------------------------------+
     |            | Shared Data & Infra Layer         |
     |            |-----------------------------------|
     |            | Postgres (multi-tenant OLTP)      |
     |            | Object Storage                     |
     |            | Redis / Cache                      |
     |            | Queue / Stream Bus                 |
     |            | Search Index                       |
     |            | Observability Stack                |
     |            +----------------+------------------+
     |                             |
     |                             v
     |           +------------------------------------+
     |           | Execution Plane                    |
     |           |------------------------------------|
     |           | Local executor                     |
     |           | Hosted worker pools                |
     |           | Self-hosted customer runners       |
     |           | Provider adapters (GitHub, etc.)   |
     |           +------------------------------------+
     |
     +---- Results, attestations, logs, status events ---->
```

---

## 3. Tenancy Model

### Tenant hierarchy

* **Platform**: Guardrail operator
* **Tenant / Organization**: top-level customer boundary
* **Workspace / Project**: logical team subdivision inside an org
* **Environment**: dev, staging, prod, sandbox
* **Principal**: human user, service account, or agent identity

### Isolation model

Use **logical multi-tenancy** with strict tenant-scoped row ownership for most metadata.

Every primary business record carries:

* `tenant_id`
* `workspace_id` where relevant
* `environment_id` where relevant
* `created_by_principal_id`

Hard requirements:

* every query must be tenant scoped
* authorization must be enforced server-side, never only in client or CLI
* secrets must be isolated by tenant and environment
* audit trails must be immutable and tenant partitioned

### Recommended storage split

* **Shared Postgres cluster, tenant-scoped schema design** for most SaaS metadata
* **Tenant-partitioned object storage prefixes** for artifacts, exports, logs, bundles
* **Dedicated encryption keys per tenant or per environment tier**
* Upgrade path to **single-tenant deployments** for large enterprise accounts

---

## 4. Core Services

### 4.1 API Gateway

Responsibilities:

* TLS termination
* API authentication
* request routing
* rate limiting
* request ID injection
* tenant resolution
* coarse request validation

Interfaces:

* REST/JSON for CLI and web
* webhooks in/out
* optional GraphQL for UI aggregation only

### 4.2 Identity and Access Service

Responsibilities:

* user accounts
* org membership
* service accounts
* agent identities
* SSO integration (OIDC/SAML)
* SCIM provisioning later
* session issuance and API tokens
* RBAC and permission evaluation

### 4.3 Tenant / Org Service

Responsibilities:

* tenant lifecycle
* billing plan attachment
* org settings
* workspace/project management
* environment creation and policy inheritance boundaries

### 4.4 Recipe and Manifest Service

Responsibilities:

* recipe registry
* manifest versions
* verified vs community channels
* bundle publishing
* schema validation
* recipe provenance and signatures
* org-wide marketplace indexing

### 4.5 Policy Engine Service

Responsibilities:

* policy storage
* versioning
* inheritance resolution
* environment overrides
* policy simulation / dry-run evaluation
* enforcement decisions for executions and approvals

Policy precedence:

1. platform hard guardrails
2. org policy
3. workspace/project policy
4. environment policy
5. recipe-level constraints
6. user profile preferences

### 4.6 Approval Workflow Service

Responsibilities:

* approval queue
* multi-stage workflows
* approval templates
* conditional approver routing
* reviewer comments
* approval SLAs and expirations

### 4.7 Execution Orchestrator

Responsibilities:

* execution request intake
* policy evaluation before dispatch
* dry-run generation
* route to executor type
* manage lifecycle states
* collect attestations, logs, and outcomes
* enforce bounds and cancellation

### 4.8 Audit and Event Service

Responsibilities:

* append-only audit records
* normalized event bus emission
* policy decision logging
* action provenance
* export streams for SIEM/compliance

### 4.9 Notification Service

Responsibilities:

* Slack/email/webhook integrations
* approval needed alerts
* incident alerts
* execution completion notifications
* digesting and deduplication

### 4.10 Compliance Export Service

Responsibilities:

* generate export bundles
* signed audit snapshots
* policy history exports
* execution history exports
* CSV/JSON/NDJSON formats

### 4.11 Secrets / KMS Metadata Service

Responsibilities:

* references to secrets
* secret usage policy
* integration with hosted KMS or BYOK
* never expose raw secrets in standard APIs

### 4.12 Marketplace Service

Responsibilities:

* publish/discover org-approved recipes
* ratings or trust metadata internally
* usage metrics
* verified flags
* deprecation and migration notices

---

## 5. Execution Plane Architecture

Guardrail should separate **control plane** from **execution plane**.

### Execution modes

#### A. Local execution

* CLI downloads approved recipe and policy snapshot
* CLI performs local dry-run and submits execution intent
* control plane returns signed execution token
* local executor runs within allowed scope
* results and attestations uploaded back

Best for:

* developer workflows
* low-latency local tasks
* minimal customer trust boundary expansion

#### B. Hosted execution

* execution sent to managed worker pool
* workload placed on queue by environment / tenant / risk class
* worker fetches ephemeral credentials and execution token
* worker runs in isolated sandbox/container
* logs, diffs, and outputs streamed back

Best for:

* repeatable workflows
* approvals + managed governance
* enterprise reporting

#### C. Customer-hosted runners

* lightweight runner deployed in customer infra
* runner polls or receives work from control plane
* job includes signed execution token and policy snapshot
* runner enforces environment-local access restrictions

Best for:

* internal systems access
* regulated environments
* hybrid adoption

### Execution state machine

* `draft`
* `validated`
* `awaiting_approval`
* `approved`
* `dispatched`
* `running`
* `paused`
* `succeeded`
* `failed`
* `blocked`
* `cancelled`
* `expired`

### Runtime enforcement

Execution runtime must enforce:

* allowed command set
* file path scope
* network egress allowlist
* max duration
* max files touched
* max cost/network calls if measurable
* environment isolation
* dynamic command generation restrictions under strict mode

---

## 6. API Design

Base path:

* `/v1`

### 6.1 Auth and identity APIs

* `POST /v1/auth/token`
* `POST /v1/auth/service-accounts`
* `GET /v1/me`
* `GET /v1/organizations`
* `POST /v1/organizations/{orgId}/members`
* `POST /v1/organizations/{orgId}/agents`
* `POST /v1/organizations/{orgId}/roles/bindings`

### 6.2 Manifests and recipes APIs

* `GET /v1/orgs/{orgId}/manifests`
* `POST /v1/orgs/{orgId}/manifests`
* `GET /v1/orgs/{orgId}/recipes`
* `POST /v1/orgs/{orgId}/recipes`
* `GET /v1/orgs/{orgId}/recipes/{recipeId}`
* `POST /v1/orgs/{orgId}/recipes/{recipeId}/publish`
* `POST /v1/orgs/{orgId}/recipes/{recipeId}/verify`
* `GET /v1/orgs/{orgId}/marketplace`

### 6.3 Policy APIs

* `GET /v1/orgs/{orgId}/policies`
* `POST /v1/orgs/{orgId}/policies`
* `GET /v1/orgs/{orgId}/policies/{policyId}`
* `POST /v1/orgs/{orgId}/policies/{policyId}/validate`
* `POST /v1/orgs/{orgId}/policy-decisions/simulate`

### 6.4 Approval APIs

* `GET /v1/orgs/{orgId}/approvals`
* `POST /v1/orgs/{orgId}/approvals/{approvalId}/approve`
* `POST /v1/orgs/{orgId}/approvals/{approvalId}/reject`
* `POST /v1/orgs/{orgId}/approvals/{approvalId}/request-changes`

### 6.5 Execution APIs

* `POST /v1/orgs/{orgId}/executions`
* `GET /v1/orgs/{orgId}/executions/{executionId}`
* `POST /v1/orgs/{orgId}/executions/{executionId}/cancel`
* `POST /v1/orgs/{orgId}/executions/{executionId}/pause`
* `GET /v1/orgs/{orgId}/executions/{executionId}/logs`
* `GET /v1/orgs/{orgId}/executions/{executionId}/artifacts`

### 6.6 Audit and compliance APIs

* `GET /v1/orgs/{orgId}/audit`
* `POST /v1/orgs/{orgId}/exports`
* `GET /v1/orgs/{orgId}/exports/{exportId}`

### 6.7 Notifications and hooks APIs

* `GET /v1/orgs/{orgId}/integrations`
* `POST /v1/orgs/{orgId}/integrations/slack`
* `POST /v1/orgs/{orgId}/webhooks`
* `POST /v1/orgs/{orgId}/incident-rules`

### Example execution creation payload

```json
{
  "workspaceId": "ws_123",
  "environmentId": "env_prod",
  "recipeVersionId": "rv_456",
  "inputs": {
    "repository": "acme/service-a",
    "pullRequestIds": [101, 102]
  },
  "mode": "dry_run",
  "executorType": "hosted",
  "profileId": "prof_prod_safe",
  "strictMode": true,
  "reason": "approved weekly dependency update"
}
```

### Example policy decision response

```json
{
  "allowed": false,
  "decision": "deny",
  "reasons": [
    "production environment requires stage-2 approval",
    "recipe risk level exceeds caller permission"
  ],
  "requiredApprovals": [
    "team_lead",
    "security"
  ],
  "appliedPolicies": [
    "org-prod-protection-v3",
    "env-prod-restrictions-v2"
  ]
}
```

---

## 7. Data Model and Database Schema

Use **PostgreSQL** for transactional system-of-record storage.

### 7.1 Core tables

#### tenants

* `id` PK
* `name`
* `slug`
* `plan`
* `status`
* `created_at`
* `updated_at`

#### workspaces

* `id` PK
* `tenant_id` FK
* `name`
* `slug`
* `created_at`

#### environments

* `id` PK
* `tenant_id` FK
* `workspace_id` FK nullable
* `name` (dev/staging/prod/custom)
* `type`
* `is_protected` boolean
* `created_at`

#### principals

* `id` PK
* `tenant_id` FK
* `type` enum (`user`, `service_account`, `agent`)
* `display_name`
* `email` nullable
* `status`
* `created_at`

#### roles

* `id` PK
* `tenant_id` FK nullable for platform roles
* `name`
* `description`

#### role_bindings

* `id` PK
* `tenant_id` FK
* `principal_id` FK
* `role_id` FK
* `scope_type` enum (`tenant`, `workspace`, `environment`)
* `scope_id`

#### manifests

* `id` PK
* `tenant_id` FK
* `workspace_id` FK nullable
* `name`
* `channel` enum (`verified`, `community`, `org`)
* `version`
* `status`
* `content_blob_id`
* `signature`
* `published_at`

#### recipes

* `id` PK
* `tenant_id` FK nullable for global recipes
* `manifest_id` FK nullable
* `name`
* `slug`
* `category`
* `risk_level`
* `author_principal_id`
* `visibility` enum (`private`, `org`, `public_verified`)
* `created_at`

#### recipe_versions

* `id` PK
* `recipe_id` FK
* `version`
* `schema_version`
* `definition_blob_id`
* `input_schema_blob_id`
* `guardrails_blob_id`
* `is_verified` boolean
* `verification_attestation_blob_id` nullable
* `created_at`

#### policies

* `id` PK
* `tenant_id` FK
* `workspace_id` FK nullable
* `environment_id` FK nullable
* `name`
* `version`
* `status`
* `precedence`
* `definition_blob_id`
* `created_by_principal_id`
* `created_at`

#### profiles

* `id` PK
* `tenant_id` FK
* `workspace_id` FK nullable
* `name`
* `risk_tolerance`
* `defaults_blob_id`
* `created_at`

#### approval_requests

* `id` PK
* `tenant_id` FK
* `workspace_id` FK
* `environment_id` FK
* `execution_id` FK nullable
* `status` enum (`pending`, `approved`, `rejected`, `changes_requested`, `expired`)
* `current_stage`
* `summary_blob_id`
* `requested_by_principal_id`
* `expires_at`
* `created_at`

#### approval_stages

* `id` PK
* `approval_request_id` FK
* `stage_order`
* `name`
* `required_role`
* `status`
* `routing_rule_blob_id`

#### approval_actions

* `id` PK
* `approval_request_id` FK
* `approval_stage_id` FK
* `actor_principal_id`
* `action` enum (`approve`, `reject`, `request_changes`)
* `comment`
* `acted_at`

#### executions

* `id` PK
* `tenant_id` FK
* `workspace_id` FK
* `environment_id` FK
* `recipe_version_id` FK
* `requested_by_principal_id` FK
* `executor_type` enum (`local`, `hosted`, `runner`)
* `mode` enum (`dry_run`, `apply`)
* `state`
* `strict_mode` boolean
* `policy_snapshot_blob_id`
* `input_blob_id`
* `result_blob_id` nullable
* `started_at` nullable
* `finished_at` nullable
* `created_at`

#### execution_bounds

* `id` PK
* `execution_id` FK
* `max_execution_time_ms`
* `max_files_touched`
* `max_network_calls`
* `max_cost_minor_units`
* `enforced` boolean

#### execution_events

* `id` PK
* `tenant_id` FK
* `execution_id` FK
* `sequence_no`
* `event_type`
* `payload_blob_id`
* `created_at`

#### audit_logs

* `id` PK
* `tenant_id` FK
* `workspace_id` FK nullable
* `environment_id` FK nullable
* `actor_principal_id` FK nullable
* `target_type`
* `target_id`
* `action`
* `outcome`
* `request_id`
* `ip_hash` nullable
* `user_agent` nullable
* `metadata_blob_id`
* `occurred_at`

#### integrations

* `id` PK
* `tenant_id` FK
* `type` enum (`slack`, `email`, `webhook`, `siem`)
* `name`
* `status`
* `config_blob_id`
* `created_at`

#### secrets

* `id` PK
* `tenant_id` FK
* `environment_id` FK nullable
* `name`
* `provider` enum (`hosted`, `aws_kms`, `gcp_kms`, `vault`, `byok`)
* `reference`
* `scope_blob_id`
* `created_at`

#### compliance_exports

* `id` PK
* `tenant_id` FK
* `requested_by_principal_id`
* `type`
* `status`
* `filters_blob_id`
* `artifact_blob_id` nullable
* `created_at`
* `completed_at` nullable

#### incident_rules

* `id` PK
* `tenant_id` FK
* `name`
* `trigger_type`
* `condition_blob_id`
* `action_blob_id`
* `enabled`
* `created_at`

### 7.2 Blob/object storage references

Large, versioned, or semi-structured fields should live in object storage:

* recipe definitions
* policy definitions
* input payloads
* execution results
* attestation bundles
* audit export archives
* large logs and diffs

Store object references in DB as `blob_id` plus checksum metadata.

### 7.3 Indexing strategy

Critical indexes:

* `(tenant_id, created_at)` on major tables
* `(tenant_id, state, created_at)` on executions
* `(tenant_id, status, expires_at)` on approval_requests
* `(tenant_id, occurred_at)` on audit_logs
* unique `(tenant_id, slug)` on user-facing slugs
* `(tenant_id, workspace_id, environment_id)` on policies/executions

### 7.4 Row-level security

If using Postgres RLS, enforce:

* tenant scoping per session
* optional workspace/environment scoping
* service-only bypass for background jobs

Still keep authorization in application layer; RLS is defense-in-depth, not the only control.

---

## 8. Policy Engine Design

### Policy types

* action allow/deny
* scope restriction
* approval requirement
* resource bounds
* identity constraints
* environment restrictions
* notification/incident hooks

### Policy model

A policy bundle resolves into normalized rules like:

```json
{
  "actions": {
    "execution.run": {
      "allow": true,
      "conditions": [
        "recipe.risk_level <= caller.max_risk",
        "environment != 'prod' OR approvals.contains('team_lead')"
      ]
    }
  },
  "restrictions": {
    "filesystem": ["/repo/**"],
    "network": ["api.github.com"],
    "commands": ["git", "gh", "npm"]
  },
  "bounds": {
    "max_execution_time_ms": 600000,
    "max_files_touched": 50
  }
}
```

### Evaluation flow

1. resolve caller identity and scopes
2. resolve recipe version and risk class
3. resolve effective environment policies
4. resolve org/workspace overrides
5. compute decision
6. attach reasons and required approvals
7. emit audit event

### Decision caching

Cache policy bundles per tenant/workspace/environment/version hash to reduce latency.

---

## 9. Approval Workflow Design

### Approval policy examples

* any prod execution requires lead approval
* destructive operation requires security approval
* external network access by agent requires two-stage approval

### Multi-stage example

1. `team_lead`
2. `security`
3. `platform_admin` if blast radius > threshold

### Queue behavior

* pending requests listed by due date and risk
* one-click approve/reject with required context
* optional comment required on rejection
* stale approvals auto-expire
* execution token issued only after final approval

### Approval artifact contents

* execution summary
* recipe version + hash
* inputs diff/redacted input summary
* scope summary
* risk summary
* expected changes preview
* policy reasons

---

## 10. Audit, Events, and Observability

### Audit principles

* append-only
* tamper-evident export bundles
* actor + action + target always captured
* include policy basis when denial or approval requirement occurs

### Event bus

Use queue/stream backbone for decoupling. Examples:

* `execution.requested`
* `execution.approved`
* `execution.started`
* `execution.completed`
* `policy.denied`
* `approval.pending`
* `approval.completed`
* `incident.triggered`

### Suggested infra

* queue: SQS / PubSub / Kafka / RabbitMQ depending scale
* metrics: Prometheus/OpenTelemetry
* logs: structured JSON to centralized sink
* traces: OpenTelemetry across API, policy, approvals, execution routing

### Key metrics

* executions by state
* approval latency
* denial rates by policy
* runner health
* policy evaluation latency
* top recipes used
* incident volume
* export generation latency

---

## 11. Secrets and Key Management

### Hosted mode

* tenant secrets encrypted with per-tenant data key
* root keys held in cloud KMS
* never return plaintext via general list APIs
* use ephemeral secret materialization for workers only

### BYOK / enterprise mode

* tenant can register external KMS or Vault path
* SaaS stores metadata and wrapped references only
* workers retrieve short-lived credentials at execution time

### Secret access controls

* scoped by tenant, environment, recipe, and executor type
* audited every time a secret reference is resolved
* production secrets unavailable to non-prod runners

---

## 12. Web App Architecture

Modules:

* org settings
* manifests and marketplace
* recipes and version history
* policies and simulation
* approvals inbox
* executions monitor
* audit explorer
* integrations
* compliance exports
* identity and roles

Frontend stack can be standard SPA + API backend.

UX priorities:

* always show trust level, risk level, and scope summary
* no hidden overrides
* one-click view of "why was this blocked?"
* obvious environment separation

---

## 13. CLI Architecture

### CLI responsibilities

* auth session management
* local recipe authoring/packaging
* local validation and dry-run
* execution submission
* approval interaction
* audit/log retrieval
* profile and policy inspection

### Example commands

* `guardrail login`
* `guardrail org switch`
* `guardrail manifest pull`
* `guardrail recipe publish`
* `guardrail policy list`
* `guardrail policy inspect`
* `guardrail run <recipe>`
* `guardrail approve list`
* `guardrail approve <id>`
* `guardrail audit query`
* `guardrail export`

### CLI trust model

* CLI should display the signed policy snapshot ID and recipe version hash before apply
* strict mode must be obvious and sticky for agent flows

---

## 14. Security Architecture

### Core controls

* short-lived access tokens
* signed execution tokens
* org-scoped RBAC
* environment isolation
* immutable audit trail
* encrypted secrets
* policy-based denial before execution
* sandboxed hosted workers

### Recommended worker isolation

* one job per container/VM sandbox
* read-only base image
* ephemeral filesystem
* outbound network restricted by policy
* no long-lived credentials in runner image

### Threats to design against

* cross-tenant data access
* privilege escalation through approval loopholes
* recipe tampering after approval
* secret leakage in logs
* agent drift beyond approved scope
* replay of old execution tokens
* confused deputy between environments

### Mitigations

* include content hashes in approvals and execution tokens
* make approvals bind to exact recipe version + inputs digest + policy snapshot
* redact secrets and sensitive inputs in logs
* expire approval and execution tokens quickly
* use per-environment credentials and runner pools

---

## 15. Deployment Topology

### Small / early-stage SaaS

* API + web in one deployable app
* single Postgres
* Redis
* managed queue
* object storage
* small hosted worker pool

### Growth stage

* separate services for:

  * auth/identity
  * policy engine
  * approvals
  * execution orchestrator
  * audit/export
* dedicated search index
* separate worker autoscaling pools by risk class

### Enterprise / regulated

* regional deployments
* dedicated tenant workers
* BYOK
* private networking / VPC peering
* customer-hosted runners
* optional single-tenant database or isolated cluster

---

## 16. Pricing / Packaging Mapping

### Team plan

* shared manifests
* approvals
* org policy basics
* centralized audit
* Slack notifications

### Business plan

* multi-stage approvals
* environment separation
* hosted execution
* compliance exports
* org marketplace

### Enterprise plan

* SSO/SAML/SCIM
* BYOK / hosted key management
* customer-hosted runners
* advanced incident hooks
* private deployment options
* dedicated isolation/SLA

---

## 17. Recommended MVP Cut

Phase 1:

* tenants, workspaces, environments
* RBAC
* recipes + recipe versions
* policies + policy simulation
* approval queue
* executions with local + hosted mode
* audit logs
* Slack/webhook notifications

Phase 2:

* org marketplace
* multi-stage approvals
* compliance exports
* hosted secrets
* incident hooks

Phase 3:

* SCIM
* BYOK
* customer-hosted runners
* advanced analytics
* regional / dedicated deployments

---

## 18. Suggested Tech Stack

A pragmatic stack:

* Backend API: TypeScript / Node.js
* Policy engine: TypeScript service, with option to move hot path to Go later
* Database: Postgres
* Cache: Redis
* Queue/Eventing: SQS + SNS, Kafka, or equivalent
* Object storage: S3-compatible
* Search: OpenSearch or Postgres FTS at first
* Auth: Auth0 / WorkOS / custom OIDC + SAML broker
* Observability: OpenTelemetry + vendor of choice
* Hosted workers: containerized jobs on Kubernetes or serverless containers

This is not mandatory, but it aligns well with CLI-heavy enterprise SaaS.

---

## 19. Example End-to-End Flow

### Scenario: approved prod infra recipe

1. developer runs `guardrail run prod-config-rollout --strict`
2. CLI validates local inputs and requests execution plan from API
3. policy engine denies direct execution but returns required approvals
4. approval request created with stage 1 lead, stage 2 security
5. approvers review exact recipe hash, policy snapshot, and change preview
6. final approval issues signed execution token
7. orchestrator dispatches job to prod-designated hosted runner pool
8. runner fetches ephemeral secret refs for prod only
9. job runs inside bounded sandbox with network/file restrictions
10. execution events stream back; audit records appended
11. notification sent to Slack on success or incident rule fires on violation
12. compliance export later includes exact decision trail and artifacts

---

## 20. What Must Never Be Implicit

The product should never hide:

* which policy caused a denial
* which approval stage is pending
* which environment a run targets
* whether recipe is verified or unverified
* whether execution is dry-run or apply
* who approved a risky action
* whether an agent is in strict mode

That clarity is part of the product’s moat.
