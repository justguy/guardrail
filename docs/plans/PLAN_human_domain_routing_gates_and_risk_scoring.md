# Guardrail — Human-Domain Routing Gates and Risk Scoring

Status: Tracked roadmap plan (`H0a`) for routing-gate hardening and benchmark-runner wiring. Guardrail now ships reusable helper groundwork in `src/llm-json.js` and `src/human-domain-routing.js`; benchmark-runner integration is still open.  
Audience: Maintainers wiring LLM-based domain triage, premise-rejection gates, and human-risk scoring into evaluation pipelines  
Goal: Make routing-gate decisions fail closed, avoid sensitive-content leakage, and document the safe order of operations before rerunning the human/workplace benchmark subset

Roadmap anchor: `H0a` in `docs/technical-status.md`

## Problem

The current routing-gate sketch has the right broad shape:

1. domain triage
2. premise-rejection check
3. optional CT execution

But the current parser and gate wiring are not safe enough to trust for human-sensitive prompts yet.

Main issues:

- `parseLLMJson()` uses naive `{ ... }` boundary extraction and can parse the wrong payload or fail unpredictably on wrapped model output.
- gate outputs are trusted without runtime validation
- parser failures currently log raw model output, which can leak sensitive prompt/answer content
- `skipCT` is policy-significant but semantically ambiguous
- the bypass path returns the baseline draft answer directly, which is only safe if that policy is explicit and the draft is itself acceptable

## Current Risk Assessment

### 1. Parser risk

`indexOf('{')` + `lastIndexOf('}')` is not a trustworthy extraction strategy for safety gates.

Failure modes:

- extra braces before or after the intended JSON payload
- embedded brace content inside model prose
- false fallback on otherwise recoverable output

Impact:

- misclassification of sensitive prompts
- incorrect bypass of CT
- incorrect forced execution of CT

### 2. Runtime-shape risk

TypeScript generics do not validate runtime data.

Current gates still accept structurally invalid outputs such as:

- `{ "domain": 7 }`
- `{ "premise_rejected": "false" }`
- `{ "domain": "unknown_new_label" }`

Impact:

- invalid branch decisions
- unknown domain labels leaking into later logic

### 3. Sensitive logging risk

Raw parser-failure logging can leak:

- medical content
- legal content
- interpersonal conflict details
- sensitive model draft content

This is especially problematic because the routing gates are explicitly applied to sensitive prompts.

### 4. Policy ambiguity risk

`skipCT` reads like a transport flag, but it is really a policy decision:

- “CT is disallowed here”
- or “baseline draft is preferred here”

That needs explicit naming, documentation, and intentional use.

## Safe Wiring Pattern

The benchmark runner can still use the three-stage shape, but only after the gates are hardened.

Recommended logic:

```ts
const domainResult = await checkDomainContext(prompt, llmClient);

// Use a policy-explicit field name such as bypassCTForSensitiveDomain.
if (domainResult.skipCT) {
  return draftAnswer;
}

const premiseResult = await checkPremiseRejection(prompt, draftAnswer, llmClient);

if (premiseResult.premise_rejected) {
  return draftAnswer;
}

return await runCognitiveTools(prompt, draftAnswer);
```

Important note:

- this is only acceptable if the product policy is intentionally “do not run CT on these sensitive domains”
- otherwise the bypass behavior is backwards and should be reconsidered

## Required Hardening Before Benchmark Rerun

### 1. Replace the parser with a safer extraction path

Minimum requirement:

- parse the first valid balanced JSON object
- do not rely on first `{` / last `}`
- fail closed to the caller-provided fallback

### 2. Add per-gate runtime validation

For domain routing:

- `domain` must be one of:
  - `interpersonal_conflict`
  - `medical_advice`
  - `legal_dispute`
  - `engineering_planning`
  - `general_workplace`
- unknown values must map to a safe fallback such as `general_workplace` or `unknown`

For premise rejection:

- `premise_rejected` must be boolean
- `reason` must be a string

For human-risk scoring:

- all scores must be numeric
- all scores must be clamped to `0.0..1.0`
- `overall_score` must be recomputed locally
- `flags` must be a string array

### 3. Stop logging raw model output on parse failure

Recommended behavior:

- log only a redacted parser-failure event
- optionally include size, classifier name, and parse-error type
- never log raw prompt or answer content by default

### 4. Delimit untrusted classifier inputs

Do not embed raw prompt text directly as free prose.

Instead:

- wrap prompt content in explicit tags such as `<user_prompt>`
- wrap draft content in `<draft_answer>`
- tell the classifier these are untrusted data, not instructions

### 5. Make the bypass policy explicit

Rename:

- `skipCT`

To something like:

- `bypassCTForSensitiveDomain`
- `ctDisallowedByDomainPolicy`

This avoids silent policy drift and makes benchmark interpretation clearer.

### 6. Decide whether baseline-pass-through also needs a safety check

If the bypass path returns the baseline draft directly, then the team should decide whether that draft must also pass:

- a human-risk scorer threshold
- or a smaller rule-based safety screen

This matters most for:

- medical
- legal
- emotionally sensitive interpersonal prompts

## Recommended Next Steps

Implement in this order:

1. Harden `parseLLMJson()` or replace it with a safer structured parser.
2. Add runtime validation for `checkDomainContext()`, `checkPremiseRejection()`, and `scoreHumanRisk()`.
3. Remove raw parser-failure logging and replace it with redacted structured logging.
4. Rename `skipCT` to a policy-explicit field name.
5. Add an ambiguity path if multi-domain prompts matter for routing accuracy.
6. Decide whether bypassed baseline drafts also require a minimum human-risk score.
7. Only after steps 1–6, rerun the benchmark subset:
   - `W04`
   - `W15`
   - `S01`
   - `S13`

## Suggested Acceptance Criteria

- malformed or wrapped model output cannot silently produce a wrong gate decision
- gate outputs are schema-validated before branching
- parser failures do not leak raw sensitive content to logs
- sensitive-domain bypass behavior is explicitly documented as policy, not incidental logic
- benchmark reruns are evaluated against the hardened gate implementation, not the pre-hardening sketch

## Non-Goals

- do not treat LLM gate outputs as sufficient legal/medical safety on their own
- do not use the human-risk scorer as the sole safety boundary for production decisions
- do not rely on TypeScript types as runtime validation
