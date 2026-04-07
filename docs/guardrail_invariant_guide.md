# Guardrail Invariant Implementation Guide

I1: Cryptographic Separation - Signing isolated from execution

I2: Risk Escalation - Detect secrets and production targets

I3: State Machine - Default deny, fail closed

I4: Path Reality - Resolve canonical paths, prevent TOCTOU

I5: Time Policies - Enforce counters and windows

I6: Concurrency - Locks with TTL

I7: Anti-Interactive - No TTY by default

I8: Rollback - Must exist and execute on failure

I9: Output Validation - Regex/JSON schema enforcement

I10: Audit Log - Append-only, hash chained
