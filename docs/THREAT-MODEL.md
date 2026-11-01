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

**Liveness without a coordinator.** A holder that stops refreshing loses the
ticket when the lease lapses (≤ 600 s). The next reader notices, frees it,
and records `sea_ticket.claim_expired`. There is no background process to
keep alive and no lock file to clean up after a crash.

**An honest record.** Every claim, release, force release, expiry, edit,
status change and link change is an event on kronicle-lite's hash chain,
inside the same transaction as the row change. `sea_history` returns the
events and whether the chain still verifies; `sea-lite verify` also finds
rows whose `chain_seq` points at nothing. A claim that appears in the table
without an event, or an event whose hash does not recompute, is detectable.

**Atomic batches.** `sea_apply` validates the whole batch (refs, self-loops,
duplicates, cycles) before writing anything, then writes everything or
nothing. A half-written epic is not a state the file can be in.

## What it does not give you

**It is not authentication.** `--actor` and the per-call `actor_id` are
labels. Nothing checks that a process calling itself `alice` is the process
that was `alice` a minute ago. The `fence_foreign_holder` check exists so a
token that leaks into another agent's context (a pasted log, a shared
scratchpad) is refused unless that agent also impersonates the holder; it is
defence in depth, not identity. If two agents are hostile to each other, the
fence does not separate them. The one exception is an actor token over
`serve --http` (below): there the actor is bound to the credential, though
it is still one trust domain.

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

**Refresh is not recorded.** Heartbeats update the row only, so the chain
does not say how long a holder actually kept a ticket between the claim and
the release — only that it did. After a `rebuild` the lease expiry reverts to
the last chained value. We chose this so a long-running agent refreshing every
minute does not generate an event per minute for every other agent to wade
through.

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

The Streamable HTTP mode (0.3.0) mirrors kronicle-lite's. It does not change
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

**Stateless, 2026-07-28 only.** No session id is minted or honored; `GET` and
`DELETE` answer `405`; every request carries its own protocol version and
client capabilities. A 2025-era client that sends `initialize` gets `400`
with `UnsupportedProtocolVersionError` (`-32022`) naming `2026-07-28`; point
it at stdio, which serves both eras. Each request gets a fresh MCP server
instance over a per-identity view of the one open store.

**What it is for.** A client on the same machine that cannot spawn a process,
several agents sharing one queue server with per-agent credentials, or a
trusted team box reached over a tunnel you already protect. It is not, by
itself, a multi-tenant service. Treat every token like an SSH key.

## Operational advice

- One server process per agent, or one shared: both work. Per-agent gives
  each a stable `--actor` without passing `actor_id` on every call.
- Keep leases short and refresh from the agent's own loop. The default
  300 s is sized for "one unit of work"; use 600 s only with refreshes.
- Treat `fence_expired` as "someone else may now have it": re-read with
  `sea_get` before deciding what to do.
- Back up with `kronicle-lite export`; restore with `import` then `sea-lite
  rebuild`.
- Report a suspected fence bypass privately (see `CONTRIBUTING.md`).
