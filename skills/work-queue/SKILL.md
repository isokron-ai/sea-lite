---
name: work-queue
description: How to take work from the sea-lite queue without colliding with other agents — claim, work under the fence, hand off, and re-orient. Use at the start of any task that comes from sea-lite, before any sea_update / sea_transition / sea_link call, and after a compaction or a long pause.
---

# work-queue

You are one of several agents sharing a ticket queue. The queue is fenced:
you can only change a ticket you hold, and you hold it only while your lease
is live. Follow this loop and you will never overwrite a teammate.

## 1. Take a ticket

Call `sea_next`. It picks the best eligible ticket and claims it in one step.

- Got `{ ticket, claim_token, expires_at }`: **keep `claim_token`**. It is
  shown once. Every write needs it. Do not paste it into notes, commit
  messages or shared files.
- Got `{ ticket: null, reason: "nothing_eligible" }`: the queue has nothing
  you may take right now (everything is claimed, blocked by open
  predecessors, assigned to someone else, or still `idea`). Say so; do not
  invent work. If you know of work, `sea_create` it with `status: triaged`.

To take a specific ticket instead, `sea_claim` with its id. If it is held,
the error names the holder and the expiry; do not retry in a loop — move on.

## 2. Work under the fence

- Read the full ticket with `sea_get` (links, notes, `row_version`).
- Move it to `in_progress` with `sea_transition` as soon as you start.
- Leave notes with `sea_update { note }` at meaningful points: what you
  found, what you decided, what is left. Notes are how the next agent (or
  you after a compaction) picks up.
- Pass `expected_version` on writes when you are acting on something you
  read a while ago; a `version_conflict` means re-read first.
- If the work will run longer than the lease (default 300 s), call
  `sea_refresh` before it lapses. A lapsed lease means the ticket is free
  for anyone, and your old token is dead.

## 3. Hand off

- Done: `sea_transition { to: "resolved" }` (or `wont_fix` / `duplicate`
  with `duplicate_of` / `dropped`). A terminal status releases your claim.
- Blocked on something: add the link (`sea_link add from=<this>
  to=<blocker> link_type=depends_on`), set `blocked` with a `reason`, then
  `sea_release` with a `note`. `sea_next` will not hand the ticket out again
  until the blocker is terminal.
- Stopping early: `sea_release { note: "where I stopped and why" }`.

Never leave a ticket `in_progress` and claimed when you stop. If you are
being shut down, release first.

## 4. Re-orient

After a compaction, a long pause, or any time you are unsure whether you
still hold a ticket:

1. `sea_get` the ticket. If `claim` is null or names someone else, you lost
   it. Do not write to it; take new work with `sea_next`.
2. If kronicle-lite is also installed, `get_system_state` with your last
   cursor shows every ticket, status and link change since you last looked.
   Treat that delta as authority over your memory of the queue.
3. `sea_history { ticket_id }` is the full record if you need to know what
   happened while you were away.

## Errors you will see

| code | meaning | do |
| --- | --- | --- |
| `fence_invalid` | wrong or dead token | re-read with `sea_get`; `sea_claim` again if free |
| `fence_foreign_holder` | someone else holds it | stop; do not retry |
| `fence_expired` | your lease lapsed | assume someone else may have it; `sea_get`, then re-claim or move on |
| `already_claimed` | claim refused | pick other work |
| `version_conflict` | row moved since you read it | re-read, then redo the write with the new `row_version` |
| `illegal_transition` | not a legal move | pick from `details.legal_next` |
| `cycle` | the link would loop | reconsider the dependency; the path is in `details` |
