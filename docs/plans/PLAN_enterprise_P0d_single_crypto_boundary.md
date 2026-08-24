# Guardrail — Enterprise P0d Packet: Single Crypto Boundary

Status: Ready  
Audience: Autonomous guarded implementation agent  
Goal: Ensure all sensitive-at-rest writes pass through one crypto abstraction

Roadmap anchor: `P0` sovereign record model + crypto boundary; enterprise items `25` and `31`

## Declared Artifact

- `docs/plans/REPORT_enterprise_P0d_single_crypto_boundary.md`

## Scope

Audit the current repo for sensitive-at-rest state and consolidate covered writes behind one encrypt/decrypt boundary.

Must include:

- one documented sensitive-at-rest boundary
- elimination or explicit flagging of bypass paths
- tests for the common crypto boundary behavior

Must not include:

- KMS/Vault integration
- dynamic secret brokering

## Likely Files

- `src/key-management.js`
- `src/shared.js`
- `src/org-policy.js`
- `src/approval-queue.js`
- `src/shared-manifest.js`
- `src/compliance.js`

## Focused Tests

- `tests/test-bucket6.js`
- any key-management-specific tests already in the bucket suites

## Proof Of Done

- one crypto boundary is documented and enforced for covered sensitive state
- search/review finds no silent direct-write bypass for covered data classes
- report artifact exists and lists the audited paths and any intentionally deferred exceptions

## Stop Conditions

Stop and fix before moving on if:

- sensitive-at-rest state still writes directly in more than one incompatible way
- the packet cannot clearly say what is covered vs intentionally deferred
