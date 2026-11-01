# Threat model

sea-lite runs on your machine, as your user, over one SQLite file shared with
kronicle-lite. Be precise about what the fencing buys you.

## What claim fencing gives you

**Mutual exclusion between cooperating agents.** Two agents that both go
through sea-lite cannot both hold a ticket. `sea_claim` and `sea_next` run in
a `BEGIN IMMEDIATE` transaction on a WAL database with a 5 s busy timeout, so
this holds across processes on one machine: the test suite races four OS
processes for one ticket and exactly one wins. A fenced write needs the
token; the token is shown once, to the claimer, and only its SHA-256 is
stored. Guessing a 256-bit token is not a realistic attack.

**Liveness without a coordinator.** A holder renews its leases by being
active: every sea-lite tool call it makes, and the `sea-lite heartbeat
--hook` a PostToolUse hook runs, push its live claims' expiry out by their
own lease (default 900 s, at most 3600 s). A holder that stops — crashed,
closed, idle — loses the ticket when the lease lapses. The next reader
notices, frees it, and records `sea_ticket.claim_expired`. There is no
background process to keep alive and no lock file to clean up after a
crash. A lapsed claim is never renewed back to life: it may already be
someone else's.

**An honest record.** Every claim, release, force release, expiry, edit,
status change and link change is an event on kronicle-lite's hash chain,
inside the same transaction as the row change. `sea_history` returns the
events and whether the chain still verifies; `sea-lite verify` also finds
rows whose `chain_seq` points at nothing. A claim that appears in the table
without an event, or an event whose hash does not recompute, is detectable.

**Atomic batches.** `sea_apply` validates the whole batch (refs, self-loops,
duplicates, cycles) before writing anything, then writes everything or
nothing. A half-written epic is not a state the file can be in.

## Identity

A claim is held by an **actor** and a **session** (0.4.0). The actor is the
human-readable label (`--actor`, `SEA_LITE_ACTOR`, a per-call `actor_id`);
the session tells apart two processes that use one label. Ownership — "is
this my claim, is this scope mine, may I rotate this token" — needs both to
match. Before 0.4.0 it needed only the actor, so every Claude Code session
configured with `--actor claude` (or with no actor at all: `local-agent`)
was one holder and their scopes never conflicted.

Where sessions come from:

- **stdio server**: `--session`, `SEA_LITE_SESSION`, else
  `CLAUDE_CODE_SESSION_ID`, else a random per-process `inst-<8 hex>`.
  Claude Code sets `CLAUDE_CODE_SESSION_ID` in stdio MCP server
  subprocesses, hooks and Bash-tool subprocesses; an MCP server keeps the
  id it was spawned with while hooks and Bash see the new one after
  `/clear`. Claude Code also sets `CLAUDE_PID` (its own pid) for hooks and
  Bash, not documented for MCP servers. Both verified against
  <https://code.claude.com/docs/en/env-vars> (2026-10-31) and observed in
  a live session. Clients that set neither (Cursor, Codex, Copilot today)
  get one random session per server process.
- **Registry**: each stdio server writes `<data dir>/sessions/<hash>-<pid>.json`
  (`0600`, directory `0700`): actor, session, the Claude Code session id it
  was spawned with, pid, ancestor pids, host, project. It is removed on exit
  and pruned on read when the pid is gone.
- **Hooks and the CLI** (`scope-check`, `precommit`, `heartbeat`, `claim`,
  `release`, …) resolve the session they act for: the given key
  (`--session`, `SEA_LITE_SESSION`, `CLAUDE_CODE_SESSION_ID`) when it names
  a live registered server; else the live registered server that has
  `CLAUDE_PID` among its ancestors (on Windows only a server's direct parent
  is recorded, so this join holds only when Claude Code spawned the server
  itself; the key lookup is unaffected); else the key itself; else none (a human
  at a terminal: `SEA_LITE_ACTOR` or the OS user, no session). A command
  given a session but no `--actor` speaks for the whole session: every
  claim of that session is its own, whatever actor label a subagent used.
- **HTTP**: no session. A per-actor token is one holder; the shared bearer
  is the server's `--actor`.

Claims taken before 0.4.0 carry no session. They belong to a caller with
the same actor and no session (a library user, a human) and to no one else;
they lapse within 10 minutes of an upgrade (the old maximum lease).

Nothing about identity touches the chain's hashing: `claim_session` is an
additive field on `sea_ticket.claimed` payloads, present only when known.

## What it does not give you

**It is not authentication.** On stdio and on the CLI, `--actor`,
`--session`, the per-call `actor_id` and the registry are all
**self-asserted**: any process can name any actor and any session, and any
process that can write the data dir can write a registry entry. Sessions
keep *honest* agents apart — two Claude Code terminals no longer silently
share one lock — they do not stop a process that lies about who it is.
Nothing checks that a process calling itself `alice` is the process that
was `alice` a minute ago. The `fence_foreign_holder` check exists so a
token that leaks into another agent's context (a pasted log, a shared
scratchpad) is refused unless that agent also impersonates the holder; it
is defence in depth, not identity. If two agents are hostile to each other,
the fence does not separate them. **The authenticated path is a per-actor
token over `serve --http`** (below): there the actor is bound to a
credential, though it is still one trust domain.

**The edit hook does not see every edit.** Claude Code's `PreToolUse` hook
on `Edit|Write|MultiEdit|NotebookEdit` runs before file-editing tools only.
An agent that edits through the Bash tool — `sed -i`, `cat >`, `>`
redirects, a formatter, a code generator, `git checkout -- path` — is not
checked. `sea-lite precommit` (git `pre-commit`) checks every staged path
at commit time, for every client; it misses uncommitted edits and
`git commit --no-verify`. Outside Claude Code the committer cannot be
matched to its MCP server's session unless both are given the same
`SEA_LITE_SESSION`, so an agent there may be refused its own claimed files
until it releases them.

**`--role operator` is self-asserted.** Whoever starts the server picks the
role. Force release is gated on it so an *agent* configured as an agent cannot
reach for it by accident, and so the record says `claim_force_released` with a
`released_by`. It is an audit distinction, not an access control.

**It is not file-level protection.** Any process that can open the SQLite
file can `UPDATE sea_tickets SET claim_token_hash = NULL` and take a ticket.
The chain makes that visible (`sea-lite verify` reports a row whose state
disagrees with its events after a `rebuild`; kronicle-lite's `verify_chain`
catches edits to the events themselves), but it does not prevent it. The
same applies to the signing key, which lives next to the database — see
kronicle-lite's threat model for what a local signature does and does not
prove.

**Refresh is not recorded.** Heartbeats (`sea_refresh`, the per-call
auto-renewal, `sea-lite heartbeat`) update the row only, so the chain does
not say how long a holder actually kept a ticket between the claim and the
release — only that it did. After a `rebuild` the lease expiry reverts to
the last chained value. We chose this so a long-running agent renewing every
minute does not generate an event per minute for every other agent to wade
through.

**Activity-based renewal can outlive attention.** A session that keeps
making tool calls keeps its claims even if it has wandered off the ticket.
Leases are a crash detector, not a timeout on work; release explicitly.

**Lazy expiry has a window.** Between the moment a lease lapses and the next
read or write that touches the ticket, the row still shows the old holder.
Readers go through `sweepExpired`, so what sea-lite *returns* is consistent;
what a raw `SELECT` returns may not be.

**Idempotency keys are caller-chosen.** They share kronicle-lite's unique
column under a `sea:` prefix. A caller that reuses a key for a different
operation gets an `invalid_input` error; a caller that reuses *another
caller's* key gets that caller's result. Namespace your keys per agent if
agents are not fully trusted with each other's results.

**Dedup is advisory.** `possible_duplicates` on create is an FTS/exact-title
hint. It never blocks, and it can miss paraphrases.

## HTTP transport (`serve --http`)

The Streamable HTTP mode (0.3.0; legacy clients since 0.4.0) mirrors kronicle-lite's. It does not change
the trust domain; it changes who can reach the process and, with actor
tokens, ties an actor label to a credential. Be precise about what the knobs
do.

**Loopback by default.** The server binds `127.0.0.1:7418` unless `--host` /
`--port` say otherwise. The `Host` header must name the bound host or
loopback, and the `Origin` header, when a browser sends one, must be
loopback or in `--allow-origin` — both are checked before the bearer is
looked at (DNS-rebinding defence per the Streamable HTTP spec). Binding
`0.0.0.0` or a LAN address is your decision: add the hostnames clients will
use with `--allow-host` and put TLS in front. sea-lite does not do TLS; a
bearer on plain HTTP off-box is a bearer anyone on the path can read.

**The shared bearer.** `<data dir>/http-bearer.token` (created with mode
`0600` when absent; or `--bearer` / `--bearer-file`). It is the same file
kronicle-lite's `serve --http` uses: one data dir, one store, one owner
secret. A request presenting it acts as the server's `--actor` with the
server's `--role`, and a per-call `actor_id` is a self-asserted label —
exactly the stdio posture. Holding it is holding the whole store. Rotate by
deleting the file and restarting.

**Actor tokens.** `sea-lite add-token --actor alice` mints a 256-bit token,
appends its SHA-256 (never the token) to `<data dir>/http-actors.json`
(mode `0600`) and prints the token once. A request presenting it acts as
`alice` with that entry's role (default `agent`), and a per-call `actor_id`
naming anyone else is refused with `forbidden`. That makes claim holders,
`created_by`, notes, chain `actor_id` and `sea_stats` attributable to a
credential rather than a label — the basis for per-seat accounting.
Comparison is constant-time over every entry (SHA-256 digests, no early
exit). An entry's `role: operator` is what lets that token force-release.
Rotate a token by deleting its entry and running `add-token` again;
restart the server to pick up changes (the file is read at start).

**What actor tokens do not give you.**

- *Single trust domain.* Every token reaches the same store with the same
  tool surface. There are no per-ticket ACLs, no read isolation (alice can
  `sea_list` and `sea_history` everything), no rate limits, no quotas. An
  actor token stops alice from writing *as bob*; it does not stop alice
  from doing anything bob could do as herself.
- *The chain is not signed per actor.* Events are appended by the server
  process; the `actor_id` on them is what the server resolved from the
  token. Anyone with the SQLite file, the shared bearer or a stdio session
  can still write events under any label. `sea_stats` is accounting for a
  cooperative team, not evidence against a hostile one.
- *No revocation list, no expiry.* A token is valid until its entry is
  removed and the server restarted.
- *The shared bearer outranks them.* It is the owner credential; do not
  hand it to teammates — give each one an actor token.

**Stateless, both eras.** No session id is minted or honored; `GET` and
`DELETE` answer `405`; a 2026-07-28 request carries its own protocol
version and client capabilities. A 2025-era client (`initialize`: Cursor
today) is served by the SDK's stateless legacy fallback (0.4.0), through
the same factory, so the same bearer check, the same per-request identity
and the same `bindActor` rule apply. `--legacy reject` restores the
modern-only endpoint (`400` / `-32022`). Each request gets a fresh MCP
server instance over a per-identity view of the one open store.

**What it is for.** A client on the same machine that cannot spawn a process,
several agents sharing one queue server with per-agent credentials, or a
trusted team box reached over a tunnel you already protect. It is not, by
itself, a multi-tenant service. Treat every token like an SSH key.

## Operational advice

- One server process per agent, or one shared: both work. Each stdio
  process is its own session, so per-agent processes need no distinct
  `--actor`; give one anyway if humans read the board. Subagents sharing
  one server should pass their own `actor_id`.
- Leave renewal to activity (any sea-lite call, the PostToolUse
  heartbeat). The default 900 s is how long a crashed holder keeps its
  lock; raise `lease_seconds` (≤ 3600) for a single step that runs longer
  than that without any tool call.
- Treat `fence_expired` as "someone else may now have it": re-read with
  `sea_get` before deciding what to do.
- Back up with `kronicle-lite export`; restore with `import` then `sea-lite
  rebuild`.
- Report a suspected fence bypass privately (see `CONTRIBUTING.md`).
