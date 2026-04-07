# Guardrail Invariant Implementation Prompts

## Purpose

These prompts guide implementation of Guardrail invariants.

------------------------------------------------------------------------

## Invariant 1: Cryptographic Separation

Ensure execution environments cannot access signing capabilities. Reject
approval attempts during runtime execution.

------------------------------------------------------------------------

## Invariant 2: Risk Escalation

Detect secrets and production context. If both present → classify RED
and require approval.

------------------------------------------------------------------------

## Invariant 3: State Machine Integrity

Reject transitions from failure to success. Fail closed on ambiguity.

------------------------------------------------------------------------

## Invariant 4: Path + File Integrity

Resolve canonical paths. Hash before execution and execute via file
descriptor.

------------------------------------------------------------------------

## Invariant 5: Temporal Enforcement

Validate time windows and counters. Fail closed if state invalid.

------------------------------------------------------------------------

## Invariant 6: Concurrency Control

Apply locks with TTL. Prevent conflicting execution.

------------------------------------------------------------------------

## Invariant 7: Anti-Interactive Execution

No TTY by default. Terminate on stdin interaction (Exit 13).

------------------------------------------------------------------------

## Invariant 8: Rollback Guarantee

Require rollback defined at approval. Execute rollback on failure.

------------------------------------------------------------------------

## Invariant 9: Output Validation

Validate output schema or regex. Fail if mismatch.

------------------------------------------------------------------------

## Invariant 10: Audit Integrity

Append hash-chained logs. Detect tampering and halt execution.
