# Data model

sea-lite is a projection: three tables (plus an FTS index) rebuilt from
events on kronicle-lite's hash chain. This document is the contract between
the handlers, `rebuild`, and anyone reading the file from another language.

## Storage

All tables live in kronicle-lite's SQLite file (`kronicle-lite.db`). sea-lite
adds its own meta key, `sea_schema_version` (currently `1`), and never touches
kronicle-lite's `schema_version`.

### `sea_tickets`

| column | meaning |
| --- | --- |
| `id` | uuid v4 |
| `kind` | one of the 16 kinds (CHECK) |
| `title`, `body` | text; body defaults to `''` |
| `status` | one of the lifecycle states (CHECK) |
| `priority` | `urgent` / `high` / `medium` / `low` / `parked` (CHECK) |
| `tags` | JSON array of strings |
| `assignee` | free-form actor label or NULL |
| `duplicate_of` | ticket id set by `sea_transition to=duplicate` |
| `created_by`, `created_at`, `updated_at` | provenance (ISO-8601 UTC) |
| `row_version` | optimistic-concurrency counter; starts at 1, +1 per content write |
| `claim_token_hash` | `sha256(token)` hex, or NULL when free |
| `claim_actor` | holder label |
| `claim_expires_at` | lease expiry (ISO-8601) |
| `claim_write_count` | fenced writes made under the current claim |
| `claim_scope` | JSON array of normalized repo-relative paths the claim locks, or NULL (since schema v2; added with `ALTER TABLE` on older stores) |
| `claim_worktree` | Normalized absolute worktree path the claim is bound to, or NULL (since schema v3; added with `ALTER TABLE` on older stores) |
| `claim_session` | the holder's session, or NULL for a session-less (or pre-0.4) holder (since schema v4) |
| `claim_lease_seconds` | the lease the claim was taken with; heartbeats renew by it (since schema v4) |
| `project` | project key the ticket was created in, or NULL for a legacy ticket (visible in every project) (since schema v4) |
| `created_seq`, `last_seq` | chain seq of the creating event and the latest event touching the row |

Indexes: `(status, priority, created_at)`, partial `(claim_expires_at)` where
not null, `(assignee)`, `(project)`.

**Project keys** (core/project.ts): the normalized `origin` remote of the
repository (`github.com/owner/repo`), else the absolute path of its main
working tree (linked worktrees resolve through `commondir`), else the
directory itself. Path keys use `/` separators on every OS (`C:/Users/me/repo`
on Windows). Read from `.git` files; git is not spawned. `list`,
`next` and scope checks see the current project's tickets plus those with
NULL `project`; `get` / `claim` by id and the history feed are not
filtered; `sea_list { project: "*" }` / `--all-projects` see everything.

### `sea_links`

`link_id`, `from_id`, `to_id`, `link_type` (CHECK against the closed
vocabulary), `state` (`active` | `tombstoned`), `created_by`, `created_at`,
`chain_seq`, `tombstoned_at`, `tombstoned_by`, `tombstone_seq`. A partial
unique index on `(from_id, to_id, link_type) WHERE state = 'active'` means at
most one live edge per triple; a tombstoned edge can be re-added.

### `sea_notes`

`note_id`, `ticket_id`, `author`, `body`, `created_at`, `chain_seq`. Notes are
append-only; they are the hand-off channel between agents.

### `sea_tickets_fts`

FTS5 over `title` and `body` with `ticket_id` unindexed, maintained by
triggers. It is a standalone table (not `content=`) so a `VACUUM` cannot
desynchronize it.

### `sea_fields`, `sea_field_heads` (0.7.0)

Typed fields (`src/audit/fields.ts`, a closed registry; a gate's
`claimed_result` is what an untrusted import said, `result` what was
recorded): `ticket_id`, `name`,
`value` (TEXT in the field's type), `set_seq`; one row per set field.
`sea_field_heads` holds each ticket's fields `version` and `last_seq`. The
ticket row and its `row_version` are not touched, so a pre-0.7 build opens
the store and rebuilds its own tables exactly. Neither table has a foreign
key to `sea_tickets` (a 0.6.x rebuild drops that table with foreign keys on).

### `sea_leases`, `sea_lease_intents` (0.7.0)

Named exclusive leases (`src/audit/lease.ts`): `name`, `epoch` (bumped on
every acquire), `holder` (actor), `holder_session` (the holder's SeaLite
instance id, random per instance), `token_hash`,
`expires_at`, `lease_seconds`, `last_seq`. The intent journal:
`intent_id`, `lease_name`, `epoch`, `op`, `target`, `idempotency_key`,
`state` (`open | happened | not_happened | may_have_happened`),
`opened_by`, `opened_at`, `opened_seq`, `closed_seq`, `evidence_ref`.

### `sea_handoffs` (0.7.0)

The last hand-off of each ticket (a holder's `sea_release` with a `note`):
`ticket_id`, `actor`, `session`, `released_at`, `released_seq`. Projected
from `sea_ticket.claim_released` events with `handoff: true`. `sea_next`
treats it as current only while nothing else touched the ticket
(`last_seq <= released_seq + 1`: the release and its note are consecutive
events) and for `HANDOFF_HOLD_SECONDS` (the default lease); in that window
the ticket goes to another agent first. A 0.6 build ignores the table.

## Events

Every sea-lite mutation appends exactly the events below to the kronicle-lite
chain, inside the same `BEGIN IMMEDIATE` transaction as the row change. The
`occurred_at` of every event equals the `created_at` / `updated_at` it writes.

| event type | payload (fields) | projection |
| --- | --- | --- |
| `sea_ticket.created` | `ticket_id kind title body status priority tags assignee created_by created_at` (+ `batch_id ref` from apply) | insert row, `row_version=1`, `created_seq=last_seq=seq` |
| `sea_ticket.updated` | `ticket_id changes{…} tags row_version updated_at` | apply `changes` (title/body/kind/priority/assignee), set `tags`, `row_version`, `updated_at`, `last_seq`, `claim_write_count+1` |
| `sea_ticket.status_set` | `ticket_id from to reason duplicate_of duplicates_link_id row_version updated_at claim_auto_released claim_token_hash` | set status (+ `duplicate_of`), bump; clear claim when `claim_auto_released` |
| `sea_ticket.claimed` | `ticket_id claim_token_hash claim_actor expires_at lease_seconds rotated scope` (+ `worktree` when bound; + `claim_session` when the holder has one; `set` / `via` / `on_create`) | set claim fields, `claim_scope` (`scope.paths`, or NULL), `claim_worktree`, `claim_session`, `claim_lease_seconds` (from `lease_seconds`), `claim_write_count=0`, `last_seq` |
| `sea_ticket.claim_released` | `ticket_id claim_token_hash claim_actor scope reason write_count` (+ `worktree via` from `release-worktree`, where `actor_id` is the caller and `claim_actor` the holder; + `handoff: true` and `claim_session` on a release with a note, 0.7.0) | clear claim (and scope), `last_seq`; a hand-off row in `sea_handoffs` |
| `sea_ticket.claim_force_released` | `ticket_id claim_token_hash previous_holder scope released_by reason write_count` | clear claim (and scope), `last_seq` |
| `sea_ticket.claim_expired` | `ticket_id claim_token_hash claim_actor scope expired_at noticed_at noticed_by` | clear claim (and scope), `last_seq` |
| `sea_ticket.note_added` | `ticket_id note_id body created_at` | insert note, `last_seq` |
| `sea_link.created` | `link_id from_id to_id link_type created_at` (+ `from_row_version reason` via sea_link; `batch_id` via apply, plus `from_row_version` when the from end is an existing ticket; `via` via transition) | insert active link; when `from_row_version` present, bump the from ticket |
| `sea_link.tombstoned` | `link_id target_id from_id to_id link_type reason tombstoned_at from_row_version` | mark tombstoned; bump the from ticket |
| `sea_ticket.fields_set` | `ticket_id set{name: value} unset[name] version` | upsert / delete `sea_fields` rows (`set_seq=seq`); `sea_field_heads.version`, `last_seq` |
| `sea_lease.acquired` | `name epoch holder session(=instance) token_hash expires_at lease_seconds` (+ `took_over{holder,epoch,expired_at}`, `may_have_happened[intent_id]`) | listed open intents → `may_have_happened`; upsert the lease row |
| `sea_lease.released` | `name epoch holder released_by` (+ `forced`, `may_have_happened[intent_id]`) | listed open intents → `may_have_happened`; clear holder, token, expiry |
| `sea_lease.intent_opened` | `intent_id name epoch op target idempotency_key opened_by opened_at` | insert intent, `state=open` |
| `sea_lease.intent_closed` | `intent_id name outcome was closed_by evidence_ref` | `state=outcome`, `closed_seq`, `evidence_ref` |
| `sea.batch_applied` | `batch_id tickets[{ref,ticket_id,title}] links[{link_id,from_ref,to_ref,from_id,to_id,link_type}] ticket_count link_count` (`from_ref` / `to_ref` null for an existing-ticket end) | nothing (summary; carries the idempotency key for apply) |

Not chained: `sea_refresh`, and renewing a named lease. A heartbeat only
updates the expiry on the row. Consequence: after `sea-lite rebuild`, a lease shows the expiry last
chained, which is never later than the live one.

`target_id` on `sea_link.tombstoned` is the generic subject key kronicle-lite's
retraction classifier reads, so a tombstoned link is reported as a safety
retraction in `get_system_state`.

### Idempotency

`idempotency_key` on `sea_create`, `sea_apply`, `sea_update`, `sea_transition`
and `sea_link` is stored on the chain event as `sea:<key>` (kronicle-lite's
`events.idempotency_key` is UNIQUE). Before doing any row work, a handler looks
the key up; on a hit it returns a result reconstructed from the stored
payload with `replayed: true` and writes nothing. Reusing a key for a
different operation is an `invalid_input` error, not a silent replay.
A bulk `sea_transition` keys item k as `<key>#k`, one
`sea_ticket.status_set` event each; `sea_finish` keys item k's finish note
(`sea_ticket.note_added` with `finish: {outcome, commit, from, to}`) as
`<key>#k`. A templated `sea_apply` is keyed like
any batch: the key replays the expanded batch it first wrote (templates are
expanded before anything is chained, so no event records a template).

A key is bound to its request: the keyed event's payload carries
`request_hash` (sha256 of the RFC 8785 JSON of the operation and the
request, minus the key, `dry_run`, `verbose`, `confirm`, claim tokens and the
caller; ticket ids resolved; `sea_apply` after template expansion). A reuse
whose hash differs is `invalid_input` (`reason: "request_mismatch"`),
never a replay. A key bound to an event from before request hashes (< 0.6.0)
is `invalid_input` (`reason: "unverifiable_key"`), not a replay (0.7.0).

Claims are not keyed: a repeated `sea_claim` by the current holder rotates
the token, which is the useful behaviour for a retry.

## Fence semantics

- A claim token is 32 random bytes, hex-encoded (64 chars), shown to the
  caller once. The row and the chain hold `sha256(token)` only.
- `validateFence(row, token, actor, now)` checks in this order and reports
  the first failure:
  1. `fence_invalid` — no claim on the row, or `sha256(token)` does not match;
  2. `fence_foreign_holder` — hash matches but `claim_actor` is not the caller
     (a leaked token);
  3. `fence_invalid` — claim row has no expiry (corrupt);
  4. `fence_expired` — `claim_expires_at <= now`.
- Ownership: a claim is the caller's own when `claim_actor` equals the
  caller's actor **and** `claim_session` equals the caller's session (NULL
  equals only NULL). A hook view (CLI `scope-check` / `precommit` /
  `heartbeat` given a session but no actor) owns every claim of its
  session. `already_claimed`, token rotation, `claimed: mine`, scope
  conflicts and heartbeats use this rule; `validateFence` compares the
  actor only (the token is the proof of possession).
- Leases: `sea_claim` / `sea_next` / `sea_create(claim_seconds)` take
  1–3600 s (default 900; before 0.4.0: 1–600, default 300). `sea_refresh`
  sets expiry to `max(current, now + n)`, `n ≤ 3600`, default the claim's
  own lease. Renewal on activity: every MCP tool call renews the caller's
  live claims to `max(current, now + claim_lease_seconds)` (at most once per
  30 s per actor and session), as does `sea-lite heartbeat`. Row only, not
  chained; a lapsed claim is swept, never renewed.
- Lazy expiry: any handler that loads a ticket row first runs `sweepExpired`.
  If the lease has lapsed it clears the claim and appends
  `sea_ticket.claim_expired` once (the cleared row cannot trigger it again).
  `sea_list` and `sea_next` sweep every lapsed lease in the table so the
  queue view is honest.
- Claiming a set: ids are resolved, de-duplicated and sorted; rows are
  checked in that order; any conflict throws and the transaction rolls back,
  so either every ticket in the set is claimed or none is.
- Entering a terminal status releases the claim (`claim_auto_released`).
- Fenced tools: `sea_update`, `sea_transition`, `sea_finish`, `sea_link`
  (on `from`), `sea_refresh`, `sea_release` (holder path). A bulk
  `sea_transition` / `sea_finish` fences each ticket with its own token, in
  one transaction: one failure and nothing is written. `sea_release force: true`
  bypasses the fence and requires `--role operator`.

## Claim scopes

A claim may carry a scope: the repo-relative paths the holder is going to
touch (`sea_claim` / `sea_next` `scope.paths`). Entries are normalized
(forward slashes, no `./`, no `..`, no absolute paths, trailing `/` dropped
except where it marks a dotted name as a directory), deduplicated and
sorted, so the chain payload is canonical. `.` is the whole repository.

An entry without glob characters is a **prefix**: the path itself and, when
it looks like a directory (no file extension on the last segment, or a
trailing `/`), everything beneath it. An entry with `* ? [ ] { }` is a
**glob** in picomatch syntax: exactly the paths it matches; `*` does not
cross `/`, `**` does.

Two scopes **overlap** when any entry of one can name the same file as any
entry of the other. The rule is segment-wise: literal segments must be
equal; a pattern segment must match the literal it faces; `**` is tried
against every suffix; a directory prefix that runs out while the other entry
continues overlaps (the other path is inside its subtree), a glob or a file
that runs out does not. Two pattern segments are disjoint only when their
literal heads or tails disagree (`*.ts` vs `*.md`), otherwise they are taken
to overlap (`*.ts` vs `*.test.ts`).

A claim whose scope overlaps a live, unexpired scope **held by someone
else** (see Ownership above) on a ticket of the same project (or a legacy
ticket) is refused with `scope_conflict` (holder, holder session, ticket
and title, overlapping pairs, expiry — every conflicting holder is listed).
One holder may hold overlapping scopes across tickets; a scoped claim on a set applies one scope
to every ticket in the set. Release, force release, lazy expiry and a
terminal transition clear the scope with the claim; `rebuild` restores live
scopes from `sea_ticket.claimed` payloads. `sea_scope_check` answers "would
these paths collide with someone else's scope?" without taking a claim.

A claim may also be bound to a worktree (`scope.worktree`, an absolute
path). The binding is metadata, not a lock: overlap is decided on `paths`
alone, because two worktrees of one repository editing the same
repo-relative file still merge-conflict. Paths are normalized lexically —
backslashes to `/`, `.` / `..` / repeated and trailing separators resolved,
drive letter lower-cased — and Windows-style paths (`c:/…`, `//host/share/…`)
compare case-insensitively. `release-worktree` releases every live claim
bound to a worktree regardless of holder; a lapsed one is recorded as
expired instead.

## Optimistic concurrency

`row_version` increments on every content write (`sea_update` with changes,
`sea_transition`, `sea_link` add/remove on the `from` ticket). Pass
`expected_version` to refuse a write when the row has moved; the
`version_conflict` error carries `current_version` and a small snapshot so
the caller can re-read without a round-trip. Claims and notes do not bump
`row_version`.

## Taxonomy

Statuses: work track `idea → triaged → in_progress → resolved`; holding
`parked | blocked | needs_decision` (from any active state; exit only to
`idea`, `triaged`, `in_progress`, plus `in_design` when the design track is
on); terminal `resolved | wont_fix | duplicate | dropped | merged`. Design
track (`--tracks work,design` / `SEA_LITE_TRACKS`): `idea → in_design → ready
→ in_progress`. Any active state may enter any holding or terminal state.
Same-state transitions are rejected (`no_op_transition`).

`sea_next` eligibility: status `triaged` or `in_progress`, no live claim,
priority not `parked`, assignee is the caller or NULL, and every predecessor
is terminal. Predecessors of T are tickets P with an active `P blocks T` or
`T depends_on P`. Order: priority rank, then `in_progress` before `triaged`,
then `created_seq` ascending.

DAG-class link types (`parent_of`, `depends_on`, `blocks`) are kept acyclic:
`sea_link add` runs a recursive-CTE reachability query from `to` back to
`from` over active DAG edges and rejects with the cycle path; `sea_apply`
checks the batch at its barrier. Other link types may form cycles.

## Rebuild and verify

`sea-lite rebuild` drops the sea tables (and their triggers), recreates them,
and replays every event whose type starts with `sea` in chain order inside
one transaction. `sea-lite verify` runs kronicle-lite's `verify()` over the
whole chain and additionally reports any sea row whose `created_seq`,
`last_seq`, `chain_seq` or `tombstone_seq` does not resolve to an event.
