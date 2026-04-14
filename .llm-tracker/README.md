# LLM Project Tracker — Agent Contract

A human operator asked you to read this because they want you to register or update a project in their LLM Project Tracker.

Writes are **frequent and tiny**. Reads are **rare and only at decision points**. The hub is the authority for project structure (task order, which tasks exist, human-owned UI state). You (the LLM) are the authority for content (status, assignee, dependencies, context, scratchpad, new tasks, priority/swimlane changes).

---

## 1. Workspace layout

This README lives at the root of a workspace folder. All the paths below are relative to that folder.

```
README.md                        ← you are here
settings.json                    ← hub config (port, etc.) — hub-managed, do not touch
trackers/<slug>.json             ← canonical project state — hub writes this
trackers/<slug>.errors.json      ← hub writes here when your update is rejected
patches/<slug>.<anything>.json   ← drop small update patches here (Mode A, bash-less)
patches/<slug>.<anything>.errors.json  ← hub writes here when your patch is invalid
templates/default.json           ← copy this to start a new project
.snapshots/<slug>/<rev>.json     ← hub-managed full snapshot per rev (for rollback)
.history/<slug>.jsonl            ← hub-managed append-only event log (rev + delta)
```

**Absolute workspace path** (what you pass to file tools): the operator will tell you, or it defaults to `~/.llm-tracker/`.

---

## 2. The contract — READ THIS FIRST

**What you can write freely:**

- `status` — flip `not_started` → `in_progress` when you start, → `complete` when shipped, → `deferred` when intentionally parked
- `assignee` — your model ID when you claim a task
- `dependencies` — task IDs this one blocks on; drives derived **block state** (§5)
- `blocker_reason` — one sentence when stuck
- `context.*` — `tags`, `files_touched`, `notes`, anything diagnostic (shallow-merged per key)
- `placement.priorityId` and `placement.swimlaneId` — you *can* change these; last-write-wins against human drags
- `meta.scratchpad` — your status banner to the human
- `meta.name`, `meta.priorities[]`, `meta.swimlanes[].{id,label,description}` — project structure (set at registration, rarely after)
- **New tasks** — include them; the hub appends them to the end of `tasks[]` automatically

**What the hub enforces (you can't break these even if you try):**

- **Array order in `tasks[]`** — the hub preserves its own order regardless of the order you submit. Reorder happens only through the UI's drag endpoint.
- **Deletion** — missing task IDs are kept, not deleted. To archive, set `status: "deferred"`. Deletion is human-only via the UI.
- **`meta.swimlanes[i].collapsed`** — human UI state. The hub always keeps the existing value and ignores anything you submit for this field.
- **`updatedAt`, `rev`** — hub-owned. `meta.rev` is a monotonic integer bumped on every accepted change. Any value you submit is ignored and overwritten. See §12 for how to read changes since a given rev.

### The workflow

1. **Start of a work burst** — read the relevant task (for full context) or the tracker index (to pick what's next). One read per decision.
2. **During the burst** — write small updates constantly. No re-reading between writes. Each write is a self-contained patch; it does not depend on you having current state.
3. **At the next decision point** — read again if needed. Human changes that happened during the burst surface here; your writes since the last decision have already landed.

You don't need to re-read the file before every write. The hub merges your patch into the canonical state under a per-project lock; the human's drags land as independent writes. Last-write-wins on any specific field, but **different fields written concurrently all land**.

---

## 3. Schema

A project file is a JSON object with two top-level keys: `meta` and `tasks`.

### 3.1 `meta`

| Field        | Type                              | Required | Notes                                                                            |
| ------------ | --------------------------------- | :------: | -------------------------------------------------------------------------------- |
| `name`       | string                            |    ✓    | Display name in the UI.                                                          |
| `slug`       | string (`^[a-z0-9][a-z0-9-]*$`)   |    ✓    | Must match the filename stem: `<slug>.json`.                                     |
| `swimlanes`  | array of swimlane objects         |    ✓    | ≥1 entry. Row axis. Schema in §3.2.                                              |
| `priorities` | array of `{id, label}`            |    ✓    | ≥1 entry. Column axis. Conventional IDs: `p0`–`p3`.                              |
| `scratchpad` | string                            |          | Your status banner to the human.                                                 |
| `updatedAt`  | string (ISO 8601) \| null         |          | **Hub-owned.** Stamped on every accepted write.                                  |
| `rev`        | integer \| null                   |          | **Hub-owned.** Monotonic, bumps on every accepted change. See §12.               |

### 3.2 Swimlane object

| Field         | Type       | Required | Notes                                                                                       |
| ------------- | ---------- | :------: | ------------------------------------------------------------------------------------------- |
| `id`          | string     |    ✓    | Stable identifier. Referenced from every task's `placement.swimlaneId`.                     |
| `label`       | string     |    ✓    | Display name for the row header.                                                            |
| `description` | string     |          | Optional one-liner shown under the label in the UI.                                         |
| `collapsed`   | boolean    |          | **Hub-enforced.** Set by the human via the UI. If you include it in a write, it's dropped.  |

### 3.3 Task object

Tasks are ordered by **array index**. The hub owns the order; you never reorder.

| Field            | Type                                           | Required | Notes                                                                            |
| ---------------- | ---------------------------------------------- | :------: | -------------------------------------------------------------------------------- |
| `id`             | string                                         |    ✓    | Unique within the project. Immutable.                                            |
| `title`          | string                                         |    ✓    | One line — card headline.                                                        |
| `goal`           | string                                         |          | One or two sentences — renders under the title.                                  |
| `status`         | enum (§4)                                      |    ✓    | `not_started` \| `in_progress` \| `complete` \| `deferred`.                      |
| `placement`      | `{swimlaneId, priorityId}`                     |    ✓    | Both values must exist in `meta`. You can change these; last-write-wins.         |
| `dependencies`   | array of task `id`s                            |          | Drives block state (§5).                                                         |
| `assignee`       | string \| null                                 |          | Your model ID when you claim the task.                                           |
| `blocker_reason` | string \| null                                 |          | One sentence when stuck.                                                         |
| `context`        | object                                         |          | Freeform; shallow-merged per key on patch.                                       |
| `updatedAt`      | string (ISO 8601) \| null                      |          | **Hub-owned.**                                                                   |
| `rev`            | integer \| null                                |          | **Hub-owned.**                                                                   |

### 3.4 Cross-reference rules

- Every task's `placement.swimlaneId` must appear in `meta.swimlanes`.
- Every task's `placement.priorityId` must appear in `meta.priorities`.
- Every `dependencies[]` entry must reference a task `id` that exists in the project.
- Every `task.id` must be unique.

Violations → the hub rejects the write and drops `<slug>.errors.json`. The prior valid state remains live.

---

## 4. Status vocabulary

Exactly four values:

| Status        | Meaning                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| `not_started` | Never picked up.                                                                     |
| `in_progress` | You are actively working on it. Set `assignee`.                                      |
| `complete`    | Shipped / merged / done.                                                             |
| `deferred`    | Intentionally parked. Use this instead of deletion.                                  |

Progress % = `round((count(complete) + 0.5 * count(in_progress)) / (total - count(deferred)) * 100)`.

---

## 5. Block state (derived)

Computed by the hub from `dependencies` on every write. You influence it by editing `dependencies` and `status`.

| Block state | Definition                                                                                |
| ----------- | ----------------------------------------------------------------------------------------- |
| `blocked`   | One or more entries in `dependencies` reference a task whose `status` is not `complete`.  |
| `open`      | `dependencies` empty **or** every referenced task is `complete`.                          |

UI renders a red `BLOCKED BY <id>` badge on blocked cards and a `[BLOCKED] / [OPEN]` filter pair.

`blocker_reason` is a separate, narrative field for "I'm stuck because…" — independent of graph-derived block state.

---

## 6. Swimlane collapse (hub-enforced, human-owned)

The human folds a swimlane closed via the UI. The state lives at `meta.swimlanes[i].collapsed` (boolean). A collapsed swimlane renders only a one-line summary; cards hide.

**Default:** if `collapsed` is unset **and** all tasks in that swimlane are `complete`, the UI renders collapsed automatically.

**Your rule:** you can't change `collapsed`. The hub always keeps whatever value is currently on disk. Anything you submit for this field is dropped.

---

## 7. How to register a new project

Registration is a **full-file write** to `trackers/<slug>.json`. This is the only time you write the whole file.

1. Read `templates/default.json`.
2. Pick a `slug` (lowercase, dash-separated, unique).
3. Write to `trackers/<slug>.json` with `meta.name`, `meta.slug`, `meta.swimlanes`, `meta.priorities`, and `tasks[]` (initial task breakdown).
4. The hub auto-discovers the file within ~500ms.

After registration, **do not write to `trackers/<slug>.json` directly**. Use one of the two update modes below.

---

## 8. How to update — TWO MODES

Pick one based on what your CLI allows.

### Mode A — File patches (bash-less, works everywhere)

Drop a small JSON patch into `patches/<slug>.<anything>.json`. The hub watches the folder, applies the patch atomically under a per-slug lock, writes the merged result to `trackers/<slug>.json`, and deletes the patch file.

**Filename convention:** must start with the slug followed by a dot, e.g. `patches/phalanx.2026-04-13T12-00-00.json` or `patches/phalanx.t1-complete.json`.

**Body** — only include what you're changing:

```json
{
  "tasks": {
    "t-001": { "status": "complete", "context": { "notes": "shipped", "files_touched": ["src/run.tsx"] } },
    "t-002": { "placement": { "priorityId": "p0" } }
  },
  "meta": { "scratchpad": "green build; pinned on t-002" }
}
```

Keys `tasks` and `meta` are both optional. `tasks` may also be an array if you prefer the full-write shape.

**If the patch is rejected** (parse or schema error), the hub writes `patches/<slug>.<anything>.errors.json` next to your patch. The patch file is kept so you can fix and retry.

**Requires** filesystem Write access to the workspace. No bash/HTTP required.

### Mode B — HTTP patches (fastest, requires pre-approved `curl`)

Same body shape, sent as a POST:

```bash
curl -X POST http://localhost:<PORT>/api/projects/<slug>/patch \
  -H "Content-Type: application/json" \
  -d '{"tasks":{"t-001":{"status":"complete"}},"meta":{"scratchpad":"..."}}'
```

Response:

```json
{
  "ok": true,
  "rev": 42,
  "notes": {
    "ignored": ["…things the hub dropped, e.g. collapsed / updatedAt attempts…"],
    "warnings": ["…e.g. tasks missing from a full-write were preserved…"],
    "appended": ["…IDs of new tasks appended…"],
    "updated": ["…IDs of tasks that changed…"]
  }
}
```

**Requires** CLI permission to run `curl` against `localhost:<PORT>`. In Claude Code, the user can pre-approve this pattern once.

### Merge semantics (both modes)

- `tasks` patch keyed by id → each listed task is field-merged with existing (shallow merge on `context` and `placement`; other fields replaced).
- `tasks` patch as an array → same, but tasks missing from the array are **preserved, not deleted**, with a warning in `notes`.
- New task IDs → **appended to the end of `tasks[]`**. You can't insert or reorder.
- `meta.swimlanes[].collapsed` → always dropped. The hub keeps whatever's on disk.
- `updatedAt`, `rev` → always dropped. Hub-owned.

---

## 9. How to claim work

1. Read the tracker (`GET` the file, or if using Mode B, `curl http://localhost:<PORT>/api/projects/<slug>`).
2. Find the highest-priority (`p0` > `p1` > `p2` > `p3`) task with `status == "not_started"` and block state `open`.
3. Send a patch: `{ tasks: { <id>: { status: "in_progress", assignee: "<your model id>", blocker_reason: null } } }`.
4. Do the work. Send patches freely as you go — status updates, context notes, files_touched.
5. On completion: patch `status: "complete"`.
6. On blocker: patch `status: "not_started"` + `blocker_reason: "<one sentence>"`, and post to `meta.scratchpad` for the human.

---

## 10. Talking to the human

Use `meta.scratchpad` as your **status banner**. Renders as a sticky line above the matrix. Overwrite freely; it's not an append-only log.

Good uses:

- What you're pinned on right now
- Green-or-not signals: test count, build status, typecheck state
- The next milestone or decision you need the human to make
- Assumptions you've made that the human should know about

For per-task diagnostics, use `context`. Suggested keys (none required):

- `context.tags: string[]` — pills on the card.
- `context.files_touched: string[]` — grey sub-pills.
- `context.notes: string` — one-liner under the goal.

Additional keys render as `key: value` rows automatically.

---

## 11. When the hub rejects your write

If your write is invalid, the hub drops an error file:

- Mode A (file patch): `patches/<same-name>.errors.json` next to your patch.
- Mode B (HTTP): the response body has `ok: false` and `error: "<message>"`.
- Direct file edit of `trackers/<slug>.json` (only used for registration): `trackers/<slug>.errors.json`.

Shape:

```json
{
  "timestamp": "2026-04-13T12:34:56.000Z",
  "kind": "schema",
  "message": "/tasks/0/placement/priorityId: \"p9\" not declared in meta.priorities",
  "path": "/path/to/the/file"
}
```

`kind` is either `parse` (malformed JSON) or `schema` (valid JSON, violates §3 or §3.4). The prior valid state of the project remains live.

---

## 12. Versioning & "changes since rev N" (avoids re-reading the whole file)

The hub stamps `meta.rev` on every accepted change. Each rev is persisted three places:

- **Tracker file** (`trackers/<slug>.json`) — current rev only, in `meta.rev`
- **Snapshot** (`.snapshots/<slug>/<rev>.json`) — full state at that rev
- **History log** (`.history/<slug>.jsonl`) — one line per rev: `{rev, ts, delta, summary}`

### Read changes since rev N (Mode B, HTTP)

When you want to know "what changed since I last looked?" without reading the whole tracker:

```bash
curl http://localhost:<PORT>/api/projects/<slug>/since/<your-last-rev>
```

Response:

```json
{
  "slug": "phalanx",
  "fromRev": 42,
  "currentRev": 47,
  "events": [
    {"rev": 43, "ts": "...", "delta": {"tasks": {"t-001": {"status": "in_progress"}}}, "summary": [...]},
    {"rev": 44, "ts": "...", "delta": {"meta": {"scratchpad": "..."}}, "summary": [...]},
    {"rev": 45, "ts": "...", "delta": {...}, "summary": [...]},
    {"rev": 46, "ts": "...", "delta": {...}, "summary": [...]},
    {"rev": 47, "ts": "...", "delta": {...}, "summary": [...]}
  ]
}
```

Apply the deltas to your mental model and update `your-last-rev` to `currentRev`. This is the **primary way an LLM should refresh its understanding between work bursts.** Don't re-read the whole tracker unless you need full task context.

Each event's `delta` has three optional keys:

- `delta.meta` → `{key: newValue, …}` — meta fields that changed
- `delta.tasks` → `{taskId: {field: newValue, …} | {__added__: {...}} | {__removed__: true}}`
- `delta.order` → `[taskIds]` — new array order (only present if order changed)

### Rollback

```bash
curl -X POST http://localhost:<PORT>/api/projects/<slug>/rollback \
  -H "Content-Type: application/json" -d '{"to": 42}'
```

Rollback does **not** overwrite history. It creates a new rev (current + 1) whose content equals the state at rev 42. Subsequent `since/:rev` queries will see the rollback as a normal event with `rolledBackTo: 42`.

Only humans should rollback (via CLI or UI). LLMs should not roll back unilaterally — if you need prior state, read the snapshot file directly.

### Listing revs

```bash
curl http://localhost:<PORT>/api/projects/<slug>/revisions
```

Returns `[{rev, ts, summary, rolledBackTo?}]` for every rev. Useful for presenting history to the human.

### From the shell

```bash
llm-tracker since <slug> <rev>        # pretty-printed event log
llm-tracker since <slug> <rev> --json # machine-readable
llm-tracker rollback <slug> <rev>     # rollback via hub
```

Requires the hub to be running. Uses the port from `settings.json` or env.

---

## 13. CLI status command

Every workspace ships a `status` subcommand. Shell-native, no hub required.

```
npx llm-tracker status                 # dashboard of all projects
npx llm-tracker status <slug>          # detail for one project
npx llm-tracker status --json          # machine-readable
```

When the human asks you to "wire up the status command" for their CLI, drop a small integration file pointing at `npx llm-tracker status`. Locations:

| Environment                                                 | File                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| Claude Code (`~/.claude/` exists)                           | `~/.claude/skills/llm-tracker-status/SKILL.md`             |
| Cursor (`.cursor/` in the repo)                             | `.cursor/rules/llm-tracker.md`                             |
| Windsurf (`.windsurfrules` / `.windsurf/` in the repo)      | Append a section to `.windsurfrules`                       |
| Aider (`.aider.conf.yml` / `CONVENTIONS.md` in the repo)    | Append to `CONVENTIONS.md`                                 |
| Generic / unknown                                           | `AGENTS.md` in the repo root                               |

Minimum content: a sentence pointing at `npx llm-tracker status`, `npx llm-tracker status <slug>`, and `--json`. Don't overwrite existing files — merge or append.

---

## 14. Hard rules (do not violate)

- Never write to `trackers/<slug>.json` after registration — use Mode A or Mode B instead.
- Never invent a `status` value outside the four in §4.
- Never invent a `priorityId` or `swimlaneId` not declared in `meta`.
- Never set `updatedAt` or `rev` — the hub ignores and overwrites.
- Never rewrite this README.
- Never touch `settings.json`, `.snapshots/`, `.history/`, `<slug>.errors.json`.
- Never call the rollback endpoint — that's the human's tool.
- Never modify the behavior of the `status` subcommand or wrap it in a way that hides its output.

You can try to delete a task, reorder `tasks[]`, or set `collapsed` — the hub will silently refuse. These are safety rails, not errors, so don't rely on them; just don't do it.
