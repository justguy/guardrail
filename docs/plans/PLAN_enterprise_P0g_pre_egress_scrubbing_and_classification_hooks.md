# Guardrail — Enterprise P0g Packet: Pre-Egress Scrubbing and Classification Hooks

Status: Ready  
Audience: Autonomous guarded implementation agent  
Goal: Add hook points for sensitivity classification and pre-egress scrubbing before model traffic leaves the trust boundary

Roadmap anchor: `P0` model gateway + sovereign records; enterprise items `27` and `32`

## Declared Artifact

- `docs/plans/REPORT_enterprise_P0g_pre_egress_scrubbing_and_classification_hooks.md`

## Scope

Add hook points, policy shapes, and audit surfaces for:

- sensitivity labels
- classification-aware egress policy
- scrubber/pre-egress review
- block/redact outcomes

This packet is about the seam, not about a production-grade scrubber implementation.

## Likely Files

- `src/human-domain-routing.js`
- `src/adapter-engine.js`
- `src/policy.js`
- `src/org-policy.js`
- `src/audit.js`
- `src/compliance.js`

## Focused Tests

- `tests/test-human-domain-routing.js`
- `tests/test-adapter-runtime.js`
- `tests/test-bucket5.js`
- any new focused tests for classification/scrubbing hooks

## Proof Of Done

- model gateway can call classification/scrubbing hooks before egress
- policy can block, redact, or allow with structured reasons
- audit/event output records the hook result without leaking sensitive payloads
- report artifact exists and lists the hook contracts and decision results

## Stop Conditions

Stop and fix before moving on if:

- hook outputs are raw strings instead of structured decisions
- blocked/redacted events leak the underlying payload
- classification labels exist only in docs and are not wired into code paths
