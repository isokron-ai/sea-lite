# sea-lite

**A work queue for parallel coding agents that can't collide.**

Run three agents against one backlog and the failure mode is not that they
are slow. It is that two of them pick up the same ticket, both "finish" it,
and the one that finishes second overwrites the first. Or one of them dies
holding a ticket and nobody else ever touches it.

sea-lite is a small MCP server where tickets are **fenced**:

- `sea_next` atomically picks the best eligible ticket **and** claims it. The
  caller gets a one-time **claim token**; every write (`sea_update`,
  `sea_transition`, `sea_link`) must present it. A write from anyone else is
  refused and says who holds the ticket and until when.
- Claims are **leases** (≤ 600 s). An agent that dies stops refreshing; the
  next reader sees the lapsed lease, treats the ticket as free, and records
  that it did. No sweeper, no cron.
- Tickets carry **typed links** (`depends_on`, `blocks`, `parent_of`, …).
  `sea_next` will not hand out a ticket whose predecessors are still open, and
  the precedence graph is kept acyclic on every write.
- `sea_apply` lays down up to 50 tickets and 100 links in **one all-or-nothing
  write**, so an epic with its children and dependency edges lands as a unit
  or not at all.
- Every change is an event on a **hash chain** — the one
  [kronicle-lite](https://github.com/rafe-walker/kronicle-lite) keeps. The
  same SQLite file holds both. `sea_history` shows a ticket's record and
  whether the chain still verifies; `sea-lite rebuild` replays the tables from
  the chain.

One process, one file, no accounts. Runs over stdio next to Claude Code,
Cursor, Claude Desktop or any MCP client. Several server processes (one per
agent, or one shared) can point at the same file; SQLite's write lock and
`BEGIN IMMEDIATE` make claims exclusive across processes.

## Install

Requires Node ≥ 20.

```sh
claude mcp add sea-lite -- npx -y sea-lite serve
```

Or by hand (`.cursor/mcp.json`, `claude_desktop_config.json`):

```json
{ "mcpServers": { "sea-lite": { "command": "npx", "args": ["-y", "sea-lite", "serve", "--actor", "cursor"] } } }
```

Data lives in `~/.kronicle-lite/kronicle-lite.db` (or `--data-dir`, or
`$KRONICLE_LITE_DATA_DIR`), shared with kronicle-lite if you run that too.

Optional: copy `skills/work-queue/` into `.claude/skills/work-queue/` so the
agent knows the claim → work → release loop.

## Sixty-second tour

```sh
# a scratch store
export KRONICLE_LITE_DATA_DIR=/tmp/sea-demo

# the server, as an agent would see it (stdio; Ctrl-D to stop)
npx sea-lite serve --actor me

# look at the queue from a shell
npx sea-lite list
npx sea-lite show 0060ea49
npx sea-lite verify          # recompute every chain hash, exit 1 on mismatch
npx sea-lite rebuild         # drop + replay the sea tables from the chain
```

The agent's loop, in tool calls:

```
sea_next                       → { ticket, claim_token, expires_at }
sea_update   (notes, tags)     fenced by claim_token
sea_refresh                    if the work runs long (≤ 600 s per refresh)
sea_transition to=resolved     terminal states release the claim
   — or —
sea_release  note="where I stopped"
```

## Tools

| Tool | What it does |
| --- | --- |
| `sea_create` | One ticket (`idea`, or `triaged` to make it dispatchable). Returns `possible_duplicates` (exact + full-text title match) but never blocks. `claim_seconds` claims it in the same call. |
| `sea_apply` | 1–50 tickets + ≤ 100 links between them, all-or-nothing. Rejects duplicate refs, foreign refs, self-loops, duplicate links and cycles with a list of every problem. `dry_run`. |
| `sea_get` | Ticket by id or ≥ 8-char prefix: fields, `row_version`, claim holder/expiry (never the token), active links with peer title/status, notes, `legal_next`. |
| `sea_list` | Filters (status, kind, priority, assignee `me`/`none`, tag, claimed `any`/`yes`/`no`/`mine`), FTS5 `query`, cursor paging, `compact`/`full`. |
| `sea_claim` | Lease one or a set of tickets (all-or-nothing, locked in id order). Returns a token per ticket. Re-claiming your own ticket rotates the token. |
| `sea_refresh` | Extend a lease to now + N (≤ 600); never shortens; holder-only. Not chained. |
| `sea_release` | Holder gives the ticket back (with a hand-off `note`). `force: true` for operators (`--role operator`), recorded as a force release. |
| `sea_update` | Title/body/kind/priority/assignee, tags add/remove, append a note. Fenced; `expected_version` (OCC); `idempotency_key`; `dry_run`. |
| `sea_transition` | Move status. Fenced. Rejections carry `legal_next`. `duplicate` needs `duplicate_of` and records a `duplicates` link. Terminal states release the claim. |
| `sea_link` | `add` / `remove` a typed link, fenced on `from`. `parent_of` / `depends_on` / `blocks` stay acyclic across existing links. Remove tombstones. |
| `sea_next` | Pick + claim the highest-priority unclaimed `triaged`/`in_progress` ticket assigned to me or unassigned whose predecessors are all terminal. |
| `sea_history` | Events for one ticket, or a `since_seq` feed of all sea events, with chain verification status. |

Plus a `sea://tickets/{id}` resource (same shape as `sea_get`).

Every error is `{ error: <code>, message, details }` with a closed code set
(`fence_invalid`, `fence_foreign_holder`, `fence_expired`, `already_claimed`,
`version_conflict`, `illegal_transition`, `cycle`, `batch_invalid`, …) so an
agent can branch on it.

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> idea
    idea --> triaged
    triaged --> in_progress
    in_progress --> resolved
    state holding {
        parked
        blocked
        needs_decision
    }
    idea --> holding
    triaged --> holding
    in_progress --> holding
    holding --> idea
    holding --> triaged
    holding --> in_progress
    state terminal {
        resolved
        wont_fix
        duplicate
        dropped
        merged
    }
    idea --> terminal
    triaged --> terminal
    in_progress --> terminal
    holding --> terminal
    terminal --> [*]
```

Work track moves are one step forward at a time. Any active ticket may enter a
holding state or a terminal state; holding states resume only to `idea`,
`triaged` or `in_progress`; terminals have no exit. An optional design track
(`--tracks work,design`) adds `idea → in_design → ready → in_progress`.

Kinds: `feature research investigation refactor curiosity question other bug
chore incident security epic spike log docs decision`. Priorities: `urgent
high medium low parked` (`parked` is never dispatched by `sea_next`).

Link types: `parent_of relates_to inspired_by responds_to conflicts_with
supersedes blocks depends_on condenses_into branches_from references
duplicates`. Direction reads `from <type> to`.

## Composes with kronicle-lite

sea-lite does not have its own chain. It opens the kronicle-lite store (or
adopts an already-open one) and appends `sea_ticket.*` / `sea_link.*` /
`sea.batch_applied` events to the same hash chain, inside the same
transaction as the row change. That buys you:

- **One `get_system_state`.** An agent that orients with kronicle-lite sees
  ticket creations, status changes and link changes in its delta. Routine
  claim churn (`claimed`, `claim_released`, `claim_expired`) rolls up by
  default so it does not crowd the briefing; a force release is enumerated.
- **Retractions.** A tombstoned link is classified as a safety retraction by
  kronicle-lite's classifier, like a tombstoned block.
- **One verify, one export.** `kronicle-lite verify-chain`, `checkpoint` and
  `export` cover sea events. After `kronicle-lite import`, run
  `sea-lite rebuild` to re-project the tables (import rebuilds documents
  only).
- **Shared idempotency.** `idempotency_key` lands in the chain's unique
  column under a `sea:` prefix; a replay returns the first result.

You can run sea-lite without ever running kronicle-lite's server. The
dependency is the library.

## Limitations (read these)

- **Cooperative fencing.** A claim token stops a well-behaved agent from
  writing a ticket it does not hold. It does not stop a process with the
  SQLite file from editing rows directly. The chain makes that detectable
  (`sea-lite verify`), not impossible.
- **Self-asserted actors.** `--actor` and per-call `actor_id` are labels the
  caller chooses. The "different holder" check is defence in depth against a
  leaked token, not authentication. See `docs/THREAT-MODEL.md`.
- **Lazy expiry.** A lapsed lease is noticed by the next read or write that
  touches the ticket (or by `sea_list` / `sea_next`, which sweep). Nothing
  fires on its own.
- **Local only.** stdio transport, one machine, one file.

## Roadmap

- Links from `sea_apply` to tickets that already exist (today links are
  batch-local; use `sea_link` after apply).
- Bulk mutate (set priority / tags / assignee across a filter).
- Streamable HTTP transport alongside stdio.
- A read-only web board over the same file.

## Development

```sh
npm install
npm run build && npm test && npm run lint && npm run typecheck
```

During development `kronicle-lite` is a `file:../kronicle-lite` dependency;
`package.json` carries a TODO to switch it to the published range before
release.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.

---

Built off-grid in Cochise County, AZ — https://theexiledentrepreneur.com
