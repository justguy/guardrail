# Guardrail — Real Work Demo Prompt (Authentic Usage Recording)

You are preparing Guardrail to demonstrate **real-world value through actual usage**, not staged demos.

Goal:
Create a system where a developer can:

* run real workflows
* naturally hit risky situations
* have Guardrail intervene
* record the session
* share it as proof of value

This is NOT a “demo mode.”
This must feel like **real work that just happened to be recorded.**

---

# CORE PRINCIPLE

The demo should look like:

> “I was just doing my job… and this thing saved me.”

NOT:

> “Let me show you a feature.”

---

# SECTION 1 — Remove “Demo Mode” Thinking

Do NOT build:

* fake scenarios
* scripted outputs
* artificial CLI flows

Instead:

* use real recipes
* use real commands
* use real repo fixtures
* let Guardrail behave normally

---

# SECTION 2 — Define 5 REAL WORK FLOWS

Each must be something a developer actually does.

---

## Flow 1 — Cleaning up git branches

User intent:

* clean merged branches

Command:

```bash
guardrail run git-branch-cleanup
```

Real risk:

* accidental deletion of important branch

Guardrail should:

* preview deletions
* block protected branches

---

## Flow 2 — Bulk merging PRs

User intent:

* merge approved PRs quickly

Command:

```bash
guardrail run github-pr-merge
```

Real risk:

* merging failing PRs

Guardrail:

* detects CI failures
* blocks unsafe merges
* optionally proceeds safely

---

## Flow 3 — Dependency upgrade

User intent:

* update dependencies

Command:

```bash
guardrail run dep-upgrade
```

Real risk:

* major version sneaks in

Guardrail:

* detects version scope change
* blocks or requires approval

---

## Flow 4 — Infra deploy

User intent:

* deploy changes

Command:

```bash
guardrail run infra-deploy --env staging
```

Real risk:

* wrong environment (prod)

Guardrail:

* detects production target
* blocks or escalates

---

## Flow 5 — AI agent task

User intent:

* fix tests in `src/`

Command:

```bash
guardrail run openclaw-wrapper --scope src/
```

Real risk:

* agent edits entire repo

Guardrail:

* enforces scope
* blocks out-of-bounds edits

---

# SECTION 3 — Recording Mode (CRITICAL)

Implement a lightweight recording feature:

```bash
guardrail record start
guardrail record stop
```

During recording:

* capture:

  * commands executed
  * Guardrail decisions
  * outputs
* store as:

  * terminal transcript
  * structured JSON

Output:

```bash
.guardrail/recordings/<timestamp>.log
```

---

# SECTION 4 — What the Recording Must Show

Each recording must naturally include:

1. User intent (implicit via command)
2. Guardrail analysis
3. Decision:

   * allowed
   * blocked
   * approval required
4. Reasoning:

   * risk
   * scope
   * policy
5. Outcome

No fake narration.

---

# SECTION 5 — Make the Value Obvious

Guardrail output must clearly show:

* WHAT is happening
* WHY it is risky
* WHAT was prevented

Example:

```
Execution paused

Command:
git push --force origin main

⚠️ Risk: HIGH
Reason:
- Force push to protected branch

WHAT THIS WOULD DO:
- Rewrite commit history
- Potentially break collaborators

Action blocked.
```

---

# SECTION 6 — Minimal Friction

The demo should require:

1. clone repo
2. run command
3. observe behavior

No setup complexity.

---

# SECTION 7 — Shareable Output

Recording should be:

* copy-paste friendly
* readable
* optionally:

  * convertible to markdown
  * easy to paste in tweet/blog

---

# SECTION 8 — Success Criteria

The recording is successful if:

* it looks like real work
* it contains a genuine “that could’ve gone wrong” moment
* Guardrail’s value is obvious without explanation
* another developer watches it and says:
  “I need this”

---

# SECTION 9 — Deliverables

Return:

1. Recording system design
2. CLI commands for recording
3. 5 real workflows (not demos)
4. Example recorded session outputs
5. File structure for recordings
6. Improvements to Guardrail output for clarity

Do not stage anything.
Do not fake anything.
Make it feel like a real developer session that just happened.
