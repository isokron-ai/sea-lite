# Changelog

All notable changes to sea-lite. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning once past 0.x.

## [0.3.0] — 2026-11-01

### Added

- **`sea-lite serve --http`** — Streamable HTTP, mirroring kronicle-lite's:
  one POST endpoint (`/mcp`), stateless, MCP 2026-07-28 only (a 2025
  `initialize` gets `400` / `-32022`; stdio still serves both eras),
  `127.0.0.1:7418` by default, `Host` and `Origin` validated before the
  bearer, bearer compared in constant time. Flags: `--port`, `--host`,
  `--bearer` / `--bearer-file`, `--actors-file`, `--allow-origin`,
  `--allow-host`. The shared bearer is `<data dir>/http-bearer.token`
  (created `0600`; the same file kronicle-lite uses) and acts as `--actor`.
- **Per-actor HTTP tokens.** `sea-lite add-token --actor NAME [--role R]`
  mints a token, stores only its sha256 in `<data dir>/http-actors.json`
  (`0600`) and prints it once. A request with that token is served as that
  actor and role; a per-call `actor_id` naming anyone else is refused with
  `forbidden`. `SeaLite.as(actor, role)` (a view over the open store) and
  `createServer(store, { bindActor })` are the building blocks.
- **`sea_stats`** (read-only tool) and **`sea-lite stats [--since] [--for]
  [--json]`**: per actor — claims taken / rotated / scoped, released,
  released on a terminal transition, expired, force-released, force
  releases issued, lease-seconds held, live claims, transitions, tickets
  created — derived from the chain and the projection; no new write path.
  `scope_conflict` refusals are not chained and so are not counted.
- **`sea-lite doctor [--json]`**: read-only checks (Node, data dir and
  permissions, HTTP token files, DB `quick_check`, sea schema version,
  full chain verify + dangling `chain_seq`, stale and orphaned claims,
  catalog fingerprint vs the one pinned in `src/catalog.ts`); exit 0/1.
- **`sea_apply` links to existing tickets**: a link end may be `from_id` /
  `to_id` instead of a batch ref. A `from_id` needs its claim token in the
  new optional `claims` list and bumps that ticket's `row_version`; the
  cycle check runs over existing links plus the batch. New problem codes in
  `batch_invalid`: `bad_endpoint`, `unknown_ticket`, `fence_missing`,
  `link_exists`.
- **Worktree-bound claims**: `scope.worktree` (absolute path) on
  `sea_claim` / `sea_next`, with or without `scope.paths`; reported as
  `claim.worktree`; **`sea-lite release-worktree <path> | --hook`** releases
  every live claim bound to it (chained as `claim_released`,
  `via: release_worktree`), with a `WorktreeRemove` hook example.
- CI on Linux, macOS and Windows × Node 20 and 22; `.gitattributes` pins LF.

### Changed

- Schema v3: `sea_tickets.claim_worktree`, added with `ALTER TABLE` on open.
  A 0.2.0 process refuses to open a store a 0.3.0 process has touched
  (its newer-schema guard); upgrade every process sharing the file.
- `sea_apply` output: `links[].from_ref` / `to_ref` are `null` for an
  existing-ticket end. `ClaimView` and `sea_claim` output gain `worktree`.
- `sea_ticket.claimed` payloads carry `worktree` only when the claim is
  bound to one; unbound claims are byte-for-byte unchanged. No hash recipe,
  cursor or existing payload field changed.
- `hooks/scope-check.sh` relativizes paths in Node, so Windows paths work.

### Dependencies

- `@modelcontextprotocol/node` ^2.1.2 (new; the Node HTTP adapter, as in
  kronicle-lite).

## [0.2.0] — 2026-10-31

### Changed

- **MCP 2026-07-28.** Built on `@modelcontextprotocol/server` 2.4 (the v2
  SDK) instead of `@modelcontextprotocol/sdk` 1.x. The stdio server is a
  dual-era entry: a 2026-07-28 client (per-request `_meta`,
  `server/discover`) and a 2025 client (`initialize` handshake) are both
  served by the same process; a v1-SDK client is part of the test suite.
  `server/discover`, `tools/list` and `resources/templates/list` carry
  `ttlMs` / `cacheScope` (1 h, public); `resources/read` is private.
  Every tool publishes an `outputSchema` derived from its real return
  shape and returns `structuredContent` alongside the text block. Server
  `instructions` are ≤ 512 characters.
- **`sea_transition` into a terminal state asks for confirmation.**
  Terminal states have no exit and release the claim, so unless
  `confirm: true` is passed the server answers with an `input_required`
  result (multi round-trip: an embedded form elicitation under the key
  `confirm_terminal`); the client's retry carries the answer. Declining
  returns `confirmation_declined` and changes nothing. A client that did
  not declare the elicitation capability gets `confirmation_required`
  (a tool error, not a protocol error) telling it to pass `confirm: true`.
  2025-era clients with elicitation are served through the SDK's legacy
  shim. Dry runs and non-terminal moves never ask.
- Tool catalog is now a reviewed artifact: `.mcp-catalog/sea-lite.json`
  (mcp-catalog-snap), `npm run catalog:check` in CI.
- zod 4.

### Added

- **Path-scoped claims.** `sea_claim` and `sea_next` accept
  `scope: { paths: string[] }` — repo-relative prefixes or picomatch globs
  (`.` = whole repo) naming what the holder will edit. The scope is stored
  with the claim (`sea_tickets.claim_scope`, schema v2, added additively)
  and on the `sea_ticket.claimed` payload; release, force release, expiry
  and terminal transitions clear it; `rebuild` restores it. Claiming a
  scope that overlaps another actor's live, unexpired scope fails with
  `scope_conflict` naming every holder, ticket, overlapping pair and
  expiry. `sea_get` / `sea_list` surface `claim.scope`.
- `sea_scope_check { paths }` (read-only) → `{ ok, conflicts }`: the hot
  path for an edit hook; no claim taken; the caller's own scopes never
  conflict; expired leases are swept first.
- `sea-lite scope-check --paths a,b [--actor] [--json]` CLI subcommand
  (exit 1 on a conflict) and `hooks/` — a Claude Code `PreToolUse`
  example that blocks an `Edit`/`Write` inside someone else's scope.
- `skills/work-queue/SKILL.md`: claim the paths you will touch, worktree =
  scope, check scope before editing, confirm terminal moves.
- README wiring for Cursor, Codex and the GitHub Copilot coding agent
  (read-only tools that qualify for Copilot: `sea_get`, `sea_list`,
  `sea_history`, `sea_scope_check`).
- Error codes `scope_conflict`, `confirmation_required`,
  `confirmation_declined`.

### Dependencies

- `@modelcontextprotocol/server` ^2.4.0 (replaces `@modelcontextprotocol/sdk`),
  `zod` ^4.2.0, `picomatch` ^4.0.7 (new; one small runtime dependency for
  glob matching). `kronicle-lite` stays at `^0.2.0`.

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
