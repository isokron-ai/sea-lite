# Changelog

All notable changes to sea-lite. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning once past 0.x.

## [0.1.1] — 2026-10-31

### Fixed

- Every write tool now sets `destructiveHint` explicitly. The MCP default is
  `true`, so clients were treating `sea_next`, `sea_claim`, `sea_refresh`,
  `sea_create` and `sea_apply` as destructive and prompting on each call.
  Additive tools are `destructiveHint: false`; `sea_update`, `sea_transition`
  (terminal states have no exit), `sea_link` (remove) and `sea_release`
  (operator force) are `true`.

## [0.1.0] — 2026-10-31

First public release.

### Added

- Tickets (`sea_tickets`), typed links (`sea_links`), notes (`sea_notes`)
  and an FTS5 index, stored in kronicle-lite's SQLite file next to its
  chain; every mutation is one `BEGIN IMMEDIATE` transaction holding the row
  change and the chain append.
- Claim fencing: random 32-byte tokens, `sha256(token)` at rest, fixed
  `validateFence` order (token → holder → expiry presence → expiry), leases
  ≤ 600 s, bounded refresh that never shortens, holder-only release, operator
  force release (`--role operator`), lazy expiry recorded once as
  `sea_ticket.claim_expired`.
- Lifecycle: work track `idea → triaged → in_progress → resolved`, holding
  states `parked | blocked | needs_decision`, terminals `resolved | wont_fix
  | duplicate | dropped | merged`, optional design track `in_design → ready`
  behind `--tracks work,design`. Rejections carry `legal_next`.
- Links: closed vocabulary (11 idea-topology types + `duplicates`), partial
  unique index on active triples, recursive-CTE DAG check for `parent_of` /
  `depends_on` / `blocks`, tombstone on remove.
- `sea_apply`: 1–50 tickets and ≤ 100 batch-local links, validated at the
  barrier (duplicate refs, foreign refs, self-loops, duplicate links,
  cycles), all-or-nothing, `dry_run`.
- `sea_next`: atomic pick + claim of the highest-priority eligible ticket
  whose `blocks` / `depends_on` predecessors are all terminal.
- OCC via `expected_version`; idempotent replay via kronicle-lite's
  `idempotency_key` under a `sea:` prefix; non-blocking duplicate detection
  on create.
- Twelve MCP tools over stdio, a `sea://tickets/{id}` resource, and a CLI:
  `serve`, `list`, `show`, `rebuild`, `verify`.
- `skills/work-queue/SKILL.md`, `docs/MODEL.md`, `docs/THREAT-MODEL.md`.
