---
name: work-queue
description: How to take work from the sea-lite queue without colliding with other agents — claim the ticket and the paths you will touch, check scope before editing, work under the fence, hand off, and re-orient. Use at the start of any task that comes from sea-lite, before any edit, before any sea_update / sea_transition / sea_link call, and after a compaction or a long pause.
---

# work-queue

You are one of several agents sharing a ticket queue and a repository. The
queue is fenced twice: you can only change a ticket you hold, and you hold
it only while your lease is live; and you can only edit paths nobody else
has claimed. Follow this loop and you will never overwrite a teammate — in
the queue or in the tree.

## 0. Scope is the files you will touch

Every claim can carry a **scope**: the repo-relative paths you are going to
edit. Two agents' live scopes may not overlap, so claiming a scope is how you
lock files the way `sea_next` locks tickets. Before you write a single
line:

- Decide which paths the ticket needs. Prefer directories (`src/handlers`,
  `docs`) or a worktree root over long file lists; use globs
  (`src/**/*.ts`) when a directory is shared. `.` is the whole repo — claim
  it only for a repo-wide change, because it blocks everyone.
- **Worktree = scope.** If you work in a git worktree or a sub-package,
  that directory is your scope; claim it as such. In a git worktree, also
  pass its absolute path as `scope.worktree`: the claim is then bound to
  the worktree and is released when the worktree is removed
  (`sea-lite release-worktree`, wired as a WorktreeRemove hook).
- Pass it with the claim: `sea_next { scope: { paths: [...] } }` or
  `sea_claim { ticket_ids, scope }`. A `scope_conflict` error names the
  holder, their ticket, the overlapping paths and when their lease lapses.
  Do not edit anyway: narrow your scope, take other work, or wait.
- **Check before editing** a path you did not claim: `sea_scope_check
  { paths: ["path/you/are/about/to/edit"] }`. `ok: false` means stop. If
  the repo has the sea-lite edit hook installed (`hooks/README.md`), it
  runs this check for you on every Edit/Write and blocks the conflicting
  one.
- Need more files than you claimed? Re-claim your ticket with the wider
  scope (`sea_claim` on a ticket you hold rotates the token and replaces
  the scope). Do not quietly widen your edits.
- A plain path with a file extension is one file; a plain directory covers
  everything beneath it; `*` stays inside one path segment, `**` crosses.
  Write a dotted directory as `name.d/`.

Scopes are released with the claim: `sea_release`, a terminal
`sea_transition`, or lease expiry free the paths for everyone.

## 1. Take a ticket

Call `sea_next` **with your scope**. It picks the best eligible ticket and
claims it (and your paths) in one step.

- Got `{ ticket, claim_token, expires_at }`: **keep `claim_token`**. It is
  shown once. Every write needs it. Do not paste it into notes, commit
  messages or shared files.
- Got `{ ticket: null, reason: "nothing_eligible" }`: the queue has nothing
  you may take right now (everything is claimed, blocked by open
  predecessors, assigned to someone else, or still `idea`). Say so; do not
  invent work. If you know of work, `sea_create` it with `status: triaged`.

To take a specific ticket instead, `sea_claim` with its id and your scope.
If it is held, the error names the holder and the expiry; do not retry in a
loop — move on.

## 2. Work under the fence

- Read the full ticket with `sea_get` (links, notes, `row_version`).
- Move it to `in_progress` with `sea_transition` as soon as you start.
- Leave notes with `sea_update { note }` at meaningful points: what you
  found, what you decided, what is left. Notes are how the next agent (or
  you after a compaction) picks up.
- Pass `expected_version` on writes when you are acting on something you
  read a while ago; a `version_conflict` means re-read first.
- Leases (default 900 s) renew while you keep calling sea-lite tools (and
  through the PostToolUse heartbeat when the hooks are installed). Before a
  single step that may run longer than the lease with no tool call (a long
  build), `sea_refresh` or claim with a longer `lease_seconds` (≤ 3600). A
  lapsed lease means the ticket is free for anyone, and your old token is
  dead.
- Edits you make through Bash (`sed -i`, redirects, formatters) are not
  checked by the edit hook; the pre-commit guard checks them at commit
  time. Keep them inside your claimed paths.

## 3. Hand off

- Done: `sea_transition { to: "resolved", confirm: true }` (or `wont_fix` /
  `duplicate` with `duplicate_of` / `dropped`). A terminal status has no
  exit and releases your claim and scope, so the server asks you to confirm
  it: pass `confirm: true`, or answer the prompt if your client shows one.
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
   it — and with it your scope: stop editing. Do not write to it; take new
   work with `sea_next`. If `claim.scope` is yours, those are still the
   only paths you may touch.
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
| `scope_conflict` | your paths overlap another agent's live scope | `details.conflicts` lists holder, ticket, paths, expiry; narrow the scope, take other work, or wait |
| `confirmation_required` | terminal transition without `confirm` on a client that cannot prompt | call again with `confirm: true` |
| `confirmation_declined` | you (or the user) said no to the terminal move | nothing changed; the ticket is still yours |
