# Guardrail Open Items

This document records public-facing gaps and adoption constraints. It is not a
commitment to dates or a mirror of the internal engineering backlog.

## Release and Distribution

- Verify the first public npm publication, package contents, executable behavior,
  and clean-install experience across supported Node.js 20+ environments.
- Keep source-install and npm-install instructions synchronized with the actual
  published artifact.
- Complete the public release files and automation expected by the chosen
  distribution process, then exercise them from a clean checkout.

## Security Posture

- Publish a focused threat model that separates contract drift, provenance,
  local-state tampering, downstream process behavior, and host compromise.
- Document secure defaults for manifest ownership, audit retention, secret
  handshakes, external recipe sources, and remote lane transports.
- Continue adversarial review of parsers, path containment, symlink handling,
  process spawning, and grant argument validation.

Guardrail is not waiting on these items to become a sandbox; containment remains
outside the product boundary.

## Compatibility and Integration Proof

- Expand clean-environment testing across supported operating systems and shells.
- Validate each external adapter and resident-lane runtime against documented CLI
  versions and authentication states. These integrations depend on tools that
  Guardrail does not install or authenticate.
- Exercise install, upgrade, interruption, recovery, and cleanup paths with
  realistic long-running workloads.

## Recipe and Adapter Trust

- Define a sustainable review and maintenance process for bundled recipes and
  adapter profiles as their downstream tools evolve.
- Strengthen public guidance for source pinning, signature verification, trusted
  indexes, and self-hosted registry operation.
- Avoid presenting community or locally generated artifacts as safe solely
  because Guardrail can package, hash, or install them.

There is no verified hosted recipe marketplace or hosted trust service in the
current product boundary.

## Resident Lanes and Delegation

- Continue hardening crash recovery, stale-state cleanup, duplicate-lane
  detection, and cross-checkout coordination.
- Clarify guarantees for remote prompt wrappers, which add SSH, remote host,
  wrapper, and downstream model-provider trust boundaries.
- Stabilize the delegated MCP grant format and compatibility expectations before
  treating it as a durable third-party integration contract.

Lane scope and resource claims coordinate Guardrail-managed lanes; they do not
prevent unrelated processes from editing the same files or resources.

## Audit and Operations

- Define recommended retention, export, backup, and external anchoring patterns
  for users that need evidence beyond local hash-chain verification.
- Measure behavior under large audit logs, recipe catalogs, lane portfolios, and
  concurrent local workloads.
- Improve operator guidance for diagnosing policy denial, approval drift,
  downstream authentication failure, and worker failure without exposing secret
  material.

## Product Validation

- Validate the approval model with developers and operators on real recurring
  workflows, including whether manifest diffs explain the decision clearly.
- Keep the top-level experience focused as advanced policy, adapter, lane, and
  delegation features evolve.
- Establish explicit stability levels for CLI commands and file formats before
  downstream automation relies on long-term compatibility.

For implemented behavior, see [Architecture](ARCHITECTURE.md). For intended
workflows, see [Use Cases](USE_CASES.md).
