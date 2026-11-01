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
- Claims are **leases** (default 15 min, up to 1 h) that **renew while the
  holder is active**: every sea-lite tool call by the holder, and the
  `sea-lite heartbeat` a hook runs, push the expiry out again. An agent
  that dies stops renewing; the next reader sees the lapsed lease, treats
  the ticket as free, and records that it did. No sweeper, no cron.
- A claim can carry a **scope**: the paths the holder will edit. Two
  holders' live scopes may not overlap (`scope_conflict` names the holder,
  ticket, paths and expiry), and `sea_scope_check` lets an edit hook refuse
  a write inside someone else's scope. A **holder is an actor label plus a
  session**, so two Claude Code terminals that both run `--actor claude`
  are still two holders (see [Identity](#identity-who-holds-a-claim)). The
  numbers that motivated it: PR pairs from different agents conflicted
  41.7% of the time, pairs from one agent 19.8%
  ([arXiv 2607.04697](https://arxiv.org/abs/2607.04697)) — agents could
  lock tickets but not each other's files.
- **Enforcement outside the model**: an edit hook for Claude Code, and a
  **git pre-commit guard** (`sea-lite precommit --install`) that refuses a
  commit staging files inside someone else's live claim, which works the
  same for Cursor, Codex, Copilot and humans.
- Tickets belong to the **project** (git repository) they were created in,
  so one shared store serves many repositories without one repo's queue or
  locks leaking into another.
- Tickets carry **typed links** (`depends_on`, `blocks`, `parent_of`, …).
  `sea_next` will not hand out a ticket whose predecessors are still open, and
  the precedence graph is kept acyclic on every write.
- `sea_apply` lays down up to 50 tickets and 100 links in **one all-or-nothing
  write**, so an epic with its children and dependency edges lands as a unit
  or not at all — and its links may point at tickets that already exist.
- A claim can be **bound to a git worktree**; removing the worktree
  (`sea-lite release-worktree`, a `WorktreeRemove` hook) releases it.
- Every change is an event on a **hash chain** — the one
  [kronicle-lite](https://github.com/rafe-walker/kronicle-lite) keeps. The
  same SQLite file holds both. `sea_history` shows a ticket's record and
  whether the chain still verifies; `sea-lite rebuild` replays the tables from
  the chain.

One process, one file, no accounts. Speaks MCP **2026-07-28** (per-request
metadata, `server/discover`, cacheable `tools/list`, `outputSchema` +
`structuredContent` on every tool, multi round-trip confirmation) and still
serves 2025-era clients that open with `initialize`, over stdio and over
HTTP — the same process answers both. Runs over stdio next to Claude Code, Cursor, Codex, Copilot,
Claude Desktop or any MCP client, or over **Streamable HTTP**
(`serve --http`, loopback, bearer tokens, one token per actor if you want
attributable claims). `sea_stats` / `sea-lite stats` account for who held
what for how long; `sea-lite doctor` checks the install. Several server processes (one per agent,
or one shared) can point at the same file; SQLite's write lock and
`BEGIN IMMEDIATE` make claims exclusive across processes.

## Install

Requires Node ≥ 20. Data lives in `~/.kronicle-lite/kronicle-lite.db` (or
`--data-dir`, or `$KRONICLE_LITE_DATA_DIR`), shared with kronicle-lite if
you run that too. One store serves every repository: tickets are keyed by
project. The `--actor` label is what humans see on the board; you do
**not** need a different label per terminal — each server process is its
own session (see [Identity](#identity-who-holds-a-claim)).

### Claude Code

```sh
claude mcp add sea-lite -- npx -y sea-lite serve --actor claude
```

Each Claude Code session's server picks up `CLAUDE_CODE_SESSION_ID` and
`CLAUDE_PROJECT_DIR`, so two sessions in one repo are two holders and
their queue is that repo's. Copy `skills/work-queue/` into
`.claude/skills/work-queue/` so the agent knows the claim → scope → work →
release loop, wire the edit hook from `hooks/README.md` (or install the
cc-anchor plugin, which ships it) so an `Edit`/`Write` inside someone
else's scope is blocked before it happens, and add the git guard:

```sh
npx sea-lite precommit --install     # .git/hooks/pre-commit
```

### Cursor

`.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for everywhere):

```json
{
  "mcpServers": {
    "sea-lite": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sea-lite", "serve", "--actor", "cursor"],
      "env": { "KRONICLE_LITE_DATA_DIR": "${userHome}/.kronicle-lite" }
    }
  }
}
```

Cursor asks before running MCP tools unless you allowlist them; the
read-only ones (`sea_get`, `sea_list`, `sea_history`, `sea_scope_check`,
`sea_stats`) are safe to allow. Put `skills/work-queue/SKILL.md` into a project rule so
the agent claims its paths before editing.

### Codex (CLI, IDE extension, app)

`~/.codex/config.toml` (or `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.sea_lite]
command = "npx"
args = ["-y", "sea-lite", "serve", "--actor", "codex"]
env_vars = ["KRONICLE_LITE_DATA_DIR"]
startup_timeout_sec = 20
default_tools_approval_mode = "writes"   # prompt only on write tools

[mcp_servers.sea_lite.tools.sea_transition]
approval_mode = "prompt"                 # terminal states are irreversible
```

Codex reads the server `instructions`; the loop is in them.

### GitHub Copilot coding agent

Repository **Settings → Copilot → MCP servers**, "MCP configuration". The
coding agent runs in a fresh Actions sandbox, so point it at a store the
run can reach, and allowlist tools explicitly: GitHub recommends read-only
tools, and Copilot code review only loads tools whose
`annotations.readOnlyHint` is `true`. Ours that qualify: **`sea_get`,
`sea_list`, `sea_history`, `sea_scope_check`, `sea_stats`**.

```json
{
  "mcpServers": {
    "sea-lite": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "sea-lite", "serve", "--actor", "copilot", "--data-dir", "/tmp/sea-lite"],
      "env": { "SEA_LITE_ROLE": "agent" },
      "tools": ["sea_get", "sea_list", "sea_history", "sea_scope_check", "sea_stats"]
    }
  }
}
```

Once a server is configured Copilot calls its tools without asking, so add
the write tools (`sea_create`, `sea_apply`, `sea_claim`, `sea_next`,
`sea_update`, `sea_transition`, `sea_link`, `sea_refresh`, `sea_release`)
only if you want the agent taking and closing tickets on its own. Secrets
and variables for the `env` block must be named `COPILOT_MCP_*`.

### Any other client

```json
{ "mcpServers": { "sea-lite": { "command": "npx", "args": ["-y", "sea-lite", "serve", "--actor", "me"] } } }
```

A 2026-07-28 client probes with `server/discover`; a 2025 client sends
`initialize`; both are served.

### Over HTTP (`serve --http`)

For a client that cannot spawn a process, or several agents sharing one
queue server:

```sh
npx sea-lite serve --http --actor owner          # http://127.0.0.1:7418/mcp
npx sea-lite add-token --actor agent-a           # prints a token once; stores its sha256
npx sea-lite add-token --actor agent-b
```

```json
{ "mcpServers": { "sea-lite": { "type": "http", "url": "http://127.0.0.1:7418/mcp",
  "headers": { "Authorization": "Bearer <agent-a's token>" } } } }
```

| Flag | Default | |
| --- | --- | --- |
| `--port N` / `--host H` | `7418` / `127.0.0.1` | kronicle-lite's `serve --http` is 7417 |
| `--bearer T` / `--bearer-file F` | `<data dir>/http-bearer.token` (created `0600`) | the shared owner token (same file kronicle-lite uses) |
| `--actors-file F` | `<data dir>/http-actors.json` if present | per-actor tokens from `add-token` (sha256 only, `0600`) |
| `--allow-origin H,..` / `--allow-host H,..` | loopback only | DNS-rebinding defence; add the names clients use |
| `--legacy stateless\|reject` | `stateless` | serve 2025-era `initialize` clients, or refuse them with -32022 |
| `--project KEY\|*` | `*` (every project) | the project this server's queue belongs to |

- **Identity per request.** The shared bearer acts as `--actor` (role
  `--role`), and a per-call `actor_id` is a self-asserted label, as on
  stdio. An actor token acts as *its* actor (and its entry's `role`); an
  `actor_id` naming anyone else is refused with `forbidden`. So claims,
  notes, chain events and `sea_stats` are attributable per token.
- **Both protocol eras, stateless.** POST to one endpoint; no session id;
  `GET`/`DELETE` → 405. 2026-07-28 clients send per-request `_meta`;
  2025-era clients (Cursor today) open with `initialize` and are served by
  the SDK's stateless legacy fallback from the same tools and the same
  per-request identity. `--legacy reject` makes the endpoint modern-only
  (`initialize` → 400 / `-32022`). Missing or wrong bearer → 401; foreign
  `Origin` or `Host` → 403.
- **Projects.** A team server sees every project unless started with
  `--project KEY` (scopes are repo-relative, so run one server per
  repository or name it).
- **One trust domain.** Every token reaches the whole store; there are no
  per-ticket permissions, no read isolation, no TLS. Off-box, put TLS in
  front. Read `docs/THREAT-MODEL.md` → "HTTP transport" before exposing it.

## Sixty-second tour

No MCP client and no LLM needed: the CLI drives the same queue the agents
use. Every line below is run by the test suite against a fresh store.

```sh
npm i -g sea-lite                            # or: alias sea-lite='npx -y sea-lite'
export KRONICLE_LITE_DATA_DIR=$(mktemp -d)   # a scratch store
cd "$(mktemp -d)" && git init -q             # any repository: tickets belong to it
```

<!-- tour:start -->
```sh
sea-lite create "Add rate limiting to login" --triaged
sea-lite create "Fix session expiry" --triaged
sea-lite next --paths src/auth --actor alice              # alice takes the first ticket and locks src/auth
sea-lite next --paths src/auth/session.ts --actor bob     # exit 1: refused, alice holds src/auth
sea-lite next --paths src/billing --actor bob             # bob takes the other ticket instead
sea-lite board                                            # who holds what, which paths, time left
sea-lite scope-check src/auth/login.ts --actor bob        # exit 1: what an edit hook or pre-commit asks
sea-lite release --all --actor alice                      # alice is done; src/auth is free again
sea-lite scope-check src/auth/login.ts --actor bob        # exit 0
sea-lite verify                                           # every chain hash recomputed
```
<!-- tour:end -->

`board` prints:

```
sea-lite board — project /tmp/tmp.BUtjgMu1sO; 2 open ticket(s); 02:45:16Z
ID        STATUS   PRI     TITLE                       HOLDER  LOCKS        LEASE
cecadce3  triaged  medium  Fix session expiry          bob     src/billing  15m00s left
a57e63b8  triaged  medium  Add rate limiting to login  alice   src/auth     14m59s left
```

Agents show up as `claude#9b1d0c22` (actor#session); `watch -n1 sea-lite
board` in a spare pane is the live view.

The agent's loop, in tool calls:

```
sea_next  scope.paths=[src/handlers]   → { ticket, claim_token, expires_at }  (paths locked too)
sea_scope_check paths=[...]            before touching a path you did not claim
sea_update   (notes, tags)             fenced by claim_token; any call renews your leases
sea_transition to=resolved confirm     terminal states release the claim and the scope
   — or —
sea_release  note="where I stopped"
```

Also: `sea-lite list`, `show ID`, `stats --since 7d`, `rebuild`,
`doctor`, `whoami`, `heartbeat`. `sea-lite help` lists everything.

## Tools

| Tool | What it does |
| --- | --- |
| `sea_create` | One ticket (`idea`, or `triaged` to make it dispatchable). Returns `possible_duplicates` (exact + full-text title match) but never blocks. `claim_seconds` claims it in the same call. |
| `sea_apply` | 1–50 tickets + ≤ 100 links, all-or-nothing. A link end is a batch `ref` or an existing ticket (`from_id` fenced by its token in `claims`; `to_id` unfenced). Rejects duplicate refs, unknown refs/ids, self-loops, duplicate links and cycles (over existing links too) with a list of every problem. `dry_run`. |
| `sea_get` | Ticket by id or ≥ 8-char prefix: fields, `row_version`, claim holder/expiry (never the token), active links with peer title/status, notes, `legal_next`. |
| `sea_list` | Filters (status, kind, priority, assignee `me`/`none`, tag, claimed `any`/`yes`/`no`/`mine`), FTS5 `query`, cursor paging, `compact`/`full`. This project's tickets (plus legacy ones without a project) unless `project` names another or `*`. |
| `sea_claim` | Lease one or a set of tickets (all-or-nothing, locked in id order). Returns a token per ticket. Re-claiming your own ticket rotates the token. `scope.paths` locks the paths you will edit for the lease; `scope_conflict` if they overlap someone else's live scope. `scope.worktree` binds the claim to a git worktree. |
| `sea_refresh` | Extend a lease to now + N (default: the claim's own lease, ≤ 3600); never shortens; holder-only. Not chained. Rarely needed: any sea-lite call by the holder renews its claims. |
| `sea_release` | Holder gives the ticket back (with a hand-off `note`). `force: true` for operators (`--role operator`), recorded as a force release. |
| `sea_update` | Title/body/kind/priority/assignee, tags add/remove, append a note. Fenced; `expected_version` (OCC); `idempotency_key`; `dry_run`. |
| `sea_transition` | Move status. Fenced. Rejections carry `legal_next`. `duplicate` needs `duplicate_of` and records a `duplicates` link. Terminal states release the claim (and scope) and ask for confirmation: `confirm: true`, or answer the `input_required` prompt. |
| `sea_link` | `add` / `remove` a typed link, fenced on `from`. `parent_of` / `depends_on` / `blocks` stay acyclic across existing links. Remove tombstones. |
| `sea_next` | Pick + claim the highest-priority unclaimed `triaged`/`in_progress` ticket assigned to me or unassigned whose predecessors are all terminal. Takes `scope.paths` like `sea_claim`. |
| `sea_history` | Events for one ticket, or a `since_seq` feed of all sea events, with chain verification status. |
| `sea_scope_check` | Read-only: would editing these paths collide with someone else's live scope? `{ ok, conflicts }` (holder, session, ticket title, overlap, expiry). No claim needed. |
| `sea_stats` | Read-only, per actor, derived from the chain: claims taken / rotated / released / expired / force-released, lease-seconds held, transitions, tickets created, live claims. `since: 24h \| 7d \| ISO`. |

Plus a `sea://tickets/{id}` resource (same shape as `sea_get`).

Every tool publishes an `outputSchema` and returns the same JSON as
`structuredContent` and as text. Every error is `{ error: <code>, message,
details }` with a closed code set (`fence_invalid`, `fence_foreign_holder`,
`fence_expired`, `already_claimed`, `scope_conflict`, `version_conflict`,
`illegal_transition`, `cycle`, `batch_invalid`, `confirmation_required`,
`confirmation_declined`, …) so an agent can branch on it.

## Scopes: locking the files, not just the ticket

A ticket lock stops two agents from doing the same work. It does not stop
them from editing the same file for different tickets — and that is where
most cross-agent merge conflicts come from. So a claim can carry the paths
its holder is going to touch:

```
sea_claim { ticket_ids: [id], scope: { paths: ["src/handlers", "docs/*.md"] } }
```

- An entry without glob characters is a **prefix**: the path and, when it
  is a directory, everything beneath it. `src/handlers/claims.ts` is one
  file; `src/handlers` is the subtree; `next.js/` (trailing slash) says a
  dotted name is a directory. A git worktree or a package directory is a
  natural scope.
- An entry with `* ? [ ] { }` is a **glob** (picomatch): exactly the paths
  it matches. `*` stays inside one segment, `**` crosses. `.` is the whole
  repository.
- Two scopes overlap when any entry of one can name the same file as any
  entry of the other (`src` ↔ `src/**/*.ts`, `docs/x.md` ↔ `docs/*.md`;
  not `src` ↔ `src2`, not `*.ts` ↔ `*.md`). The full rule is in
  `docs/MODEL.md`.
- Overlap with **someone else's** live, unexpired scope — another actor,
  or the same actor in another session — is refused with `scope_conflict`
  listing every holder, ticket, overlapping pair and expiry. Your own
  scopes never conflict with each other. Only claims of the same project
  are compared.
- The scope lives and dies with the claim: release, a terminal transition,
  or lease expiry frees it. It is on the chain (`sea_ticket.claimed`), so
  `sea-lite rebuild` restores it.
- `sea_scope_check { paths }` / `sea-lite scope-check` is the fast path
  for a hook: one read, no claim. See
  [Enforcement](#enforcement-what-actually-stops-an-edit).
- Paths are repo-relative with `/`; backslashes are accepted and
  normalized, so Windows agents and POSIX agents lock the same entries.

### Worktree-bound claims

An agent working in a git worktree can bind its claim to it:

```
sea_next { scope: { paths: ["src/auth"], worktree: "/home/me/repo-wt-auth" } }
```

`worktree` is an absolute path (normalized: `C:\Repo\wt\` → `c:/Repo/wt`),
may come with or without `paths` (alone it locks no paths), and shows up
as `claim.worktree` in `sea_get` / `sea_list`. When the worktree is
removed, `sea-lite release-worktree <path>` — or the `WorktreeRemove` hook
in `hooks/` (`release-worktree --hook`) — releases every live claim bound
to it, whoever holds it, chained as `claim_released` with
`via: release_worktree`. `sea-lite doctor` warns about live claims bound
to a worktree that no longer exists.

## Identity: who holds a claim

A claim belongs to an **actor** (a label: `claude`, `alice`, `agent-a`)
**and a session**. Two claims are the same holder's only when both match.

| Where | Actor | Session |
| --- | --- | --- |
| `sea-lite serve` (stdio) | `--actor`, `SEA_LITE_ACTOR`, else `local-agent` | `--session`, `SEA_LITE_SESSION`, `CLAUDE_CODE_SESSION_ID` (Claude Code sets it for stdio MCP servers), else a random per-process `inst-xxxxxxxx` |
| hooks and CLI commands | `--actor`, else the session's server's actor, else `SEA_LITE_ACTOR` / your OS user | found, in order: the session key (`--session`, `SEA_LITE_SESSION`, `CLAUDE_CODE_SESSION_ID`) when it names a live registered server; the server that descends from the same Claude Code process (`CLAUDE_PID`); else the key itself; else none |
| `serve --http` | the token's actor (per-actor token), or `--actor` for the shared bearer | none: one token is one holder |
| library (`new SeaLite()`) | `actor` option | `session` option, default none (pre-0.4 behaviour) |

Every stdio server writes a small entry to `<data dir>/sessions/`
(`0600`: actor, session, pid, ancestor pids, project) and removes it on
exit; dead entries are pruned on read. That registry is how the
`PreToolUse` hook of a Claude Code session, which only knows the hook
input's `session_id`, finds the identity its own MCP server claims under —
including after `/clear`, when the hook's session id changes but the
server keeps the one it was spawned with (verified against the
[Claude Code environment variable reference](https://code.claude.com/docs/en/env-vars):
`CLAUDE_CODE_SESSION_ID` reaches hooks, Bash and stdio MCP servers;
`CLAUDE_PID` reaches hooks and Bash). A hook that gives only a session
speaks for every agent of that session (main agent and subagents).

`sea-lite whoami` shows what a shell resolves to; `sea-lite board` lists
the live servers. **Labels are self-asserted** on stdio and on the CLI:
this separates honest sessions, it does not authenticate anyone. The
authenticated path is a per-actor token over HTTP. See
`docs/THREAT-MODEL.md`.

## Enforcement: what actually stops an edit

| Layer | Stops | Misses |
| --- | --- | --- |
| `scope_conflict` on `sea_claim` / `sea_next` | two holders locking overlapping paths | edits made without claiming |
| Claude Code `PreToolUse` hook (`hooks/`, or cc-anchor's scope guard) | `Edit` / `Write` / `MultiEdit` / `NotebookEdit` inside someone else's live scope, before it happens | **anything done through the Bash tool** (`sed -i`, `>` redirects, formatters, codegen, `git checkout`): the hook only sees file-editing tools |
| `sea-lite precommit` (git `pre-commit`) | committing staged files inside someone else's live claim — for every client (Cursor, Codex, Copilot, humans), and catches the Bash edits above at commit time | uncommitted working-tree edits; `git commit --no-verify` |

Install the git guard per clone with `sea-lite precommit --install` (it
refuses to overwrite a pre-commit hook that is not its own; add
`sea-lite precommit` to yours). It resolves the committer like a hook
does: an agent committing through its Bash tool is recognised as its own
session, so its own claims never block it.

## Accounting and health

`sea_stats` (MCP, read-only) and `sea-lite stats [--since 24h|7d|ISO]
[--for ACTOR] [--json]` report, per actor: claims taken (and token
rotations, scoped claims), released by the holder, released by a terminal
transition, expired, force-released (and force releases issued as
operator), lease-seconds held, live claims, status transitions and tickets
created. Everything is derived from the chain plus the live projection, so
it costs no writes and gives the same answer after `rebuild`. Lease time
runs from each `claimed` event to whatever ended it (the recorded expiry
for a lapsed lease, which includes unchained refreshes) and is clipped to
the window. `scope_conflict` refusals are not chained, so they are not
counted. Over `serve --http` with actor tokens the actor column is tied to
a credential; on stdio it is the label each agent chose.

`sea-lite doctor [--json] [--cwd DIR] [--actors-file F]` is read-only (the
database is opened `readonly`; nothing is created or swept) and exits 1 if
any check fails: Node ≥ 20, data dir present and `0700`, HTTP token files
`0600` and well-formed, the database opens and passes `quick_check`,
`sea_schema_version` vs this build, the full chain verifies and every sea
row's `chain_seq` exists, claims (live; lapsed leases nobody swept for an
hour; claims on vanished worktrees), and the served tool catalog matches
the fingerprint pinned for this release.

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
- **Self-asserted actors and sessions.** On stdio, on the CLI and with the
  shared HTTP bearer, `--actor`, `--session` and per-call `actor_id` are
  values the caller chooses. Sessions keep honest agents apart; they do not
  stop a process that lies. Per-actor HTTP tokens bind the actor to a
  credential, within one trust domain. See `docs/THREAT-MODEL.md`.
- **The edit hook does not see Bash.** See the
  [enforcement table](#enforcement-what-actually-stops-an-edit); the
  pre-commit guard is the backstop.
- **Lazy expiry.** A lapsed lease is noticed by the next read or write that
  touches the ticket (or by `sea_list` / `sea_next`, which sweep). Leases
  renew on activity; a holder that goes quiet for the whole lease (one
  build longer than 15 min with no tool call) loses it — claim with a
  longer `lease_seconds` (≤ 3600) for that.
- **Legacy tickets** created before 0.4.0 carry no project and stay visible
  in every project; claims taken before 0.4.0 carry no session (they lapse
  within 10 minutes of the upgrade).
- **One file, one trust domain.** stdio, or loopback HTTP with bearer
  tokens; no TLS, no per-ticket permissions, no multi-tenant isolation.

## Roadmap

See `ROADMAP.md`. Next up: scope-aware dispatch, bulk mutate.

## Development

```sh
npm install
npm run build && npm test && npm run lint && npm run typecheck
npm run catalog:check    # tools/list etc. must match .mcp-catalog/sea-lite.json byte for byte
```

The tool catalog is a reviewed artifact: `.mcp-catalog/sea-lite.json` is
the canonical snapshot (via [mcp-catalog-snap](https://github.com/rafe-walker/mcp-catalog-snap))
and CI fails on drift. Changed a description or schema on purpose? Run
`npm run catalog:snapshot`, copy the new `sha256` into
`CATALOG_FINGERPRINT` in `src/catalog.ts` (what `doctor` checks a
running build against; a test keeps the two equal), and commit the diff.
CI runs on Linux, macOS and Windows, Node 20 and 22.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.

---

Built off-grid in Cochise County, AZ — https://theexiledentrepreneur.com
