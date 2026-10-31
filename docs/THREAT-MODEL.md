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
fence does not separate them.

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
