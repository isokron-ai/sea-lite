# Changelog

All notable changes to sea-lite. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning once past 0.x.

## [Unreleased]

Lean on context and fewer calls to plan and close work. Measured by
agent-memory-bench Track A (sea-lite 0.4.0 → this branch): `tools/list`
59.3 KB → 31.5 KB (full) / 11.7 KB (`--core`); S14 (1 epic + 20 tickets,
39 links) `sea_apply` ~4.8k → ~1.6k tokens (13.4 KB → 1.0 KB returned),
~0.4k with a template (617 B written); S3a–d and S13 verdicts unchanged.

### Added

- **`serve --core`** (also `--profile core`, `SEA_LITE_PROFILE=core`,
  `serve --http --core`): the nine tools an agent uses day to day —
  `sea_next`, `sea_claim`, `sea_get`, `sea_scope_check`, `sea_apply`,
  `sea_transition`, `sea_finish`, `sea_release`, `sea_refresh` — with short
  descriptions; `actor_id`, `idempotency_key`, `expected_version`,
  `sea_next`'s filters, operator-only `force` and a few more are not
  advertised (still accepted), and result schemas are field names and types
  only. `tools/list` ~11.7 KB. The full profile stays the default and is
  unchanged in tools and behaviour.
- **Templates in `sea_apply`**: `templates: [{for_each, ref, ticket,
  links}]` repeats one ticket and its links per value (`for_each` is an
  array of strings/numbers or a count n). `{i}` (1-based), `{value}`,
  `{ref}` (this item) and `{prev}` (the previous item; a link naming it is
  skipped for the first item) are substituted in every string, so a 20-step
  chain is written once. Expansion is server-side, deterministic and happens
  before validation: the 50-ticket / 100-link caps, the cycle check,
  `dry_run` and `idempotency_key` all see the expanded batch. New
  `batch_invalid` problem codes: `bad_template`, `too_many_tickets`,
  `too_many_links`, `invalid_expansion`, `empty_batch`.
- **`sea_finish`**: done in one call — optional `note`, a terminal `status`
  (default `resolved`; `wont_fix`, `dropped`, `merged`), claim and scope
  released. `tickets: [...]` closes several. No confirmation round trip:
  calling it is the confirmation. Store API `finish()`.
- **Bulk `sea_transition`**: `tickets: [{ticket_id, claim_token,
  expected_version?}, …]` (≤ 50) instead of `ticket_id` + `claim_token`.
  Each ticket is fenced by its own token; every ticket is checked first and
  if any fails nothing is written (`batch_invalid` lists each failing ticket
  with its own error). One confirmation covers a terminal move of the set.
  With `idempotency_key`, item k replays under `<key>#k`. Store API
  `transitionMany()`.
- `sea_transition` takes `note` (appended in the same transaction).

### Changed

- **`sea_apply` returns `{created: {ref: id}, links: n, idempotent_replay}`
  by default** (~1 KB for a 21-ticket plan; 0.4.0 echoed every ticket and
  link id, 13.4 KB). `verbose: true` returns the 0.4.0 result; `dry_run`
  returns `{…, dry_run: true, plan: {tickets: [{ref, title}], links: ["from
  link_type to", …]}}`, the expanded plan. `tickets` may now be empty when
  `templates` supply the tickets.
- **Lean `tools/list`** in every profile (59.3 KB → 31.5 KB for the full
  fifteen tools): descriptions rewritten shorter, no `$schema`, no string
  length / pattern constraints and no safe-integer bounds in the published
  input schemas; result schemas publish the top-level fields in full and
  nested objects as a field list (`{id,kind,title,…}`), enums as their base
  type, and a two-shape result as one merged object. The server still
  validates every argument and every result against the full zod schemas,
  and the tests check each tool's result against the strict contract
  (`additionalProperties: false`) with the SDK's own validator.
- Tool results (and the `sea://tickets/{id}` resource) are compact JSON
  text instead of pretty-printed; `structuredContent` is unchanged.
- `sea_transition`'s published input lists `ticket_id` / `claim_token` as
  optional (one of them or `tickets` is required; checked server-side). The
  store's `transition()` signature is unchanged.
- The catalog fingerprint is re-pinned (`CATALOG_FINGERPRINT`).

### Documentation

- README: profiles, templated batches (with an example), `sea_finish`,
  bulk transitions; the tool table and the agent loop updated.
- Heartbeat: sea-lite keeps renewing a holder's leases on every sea-lite
  call (unchanged). For long stretches without one, cc-anchor's PostToolUse
  heartbeat hook is the recommended keep-alive (README, hooks/README.md,
  the work-queue skill); `sea-lite heartbeat --hook` remains for setups
  without cc-anchor. Wire one, not both.

## [0.4.0] — 2026-11-01

Fixes the adoption-audit blockers: the default Claude Code setup had no
collision protection between sessions, the hook contract was unusable from
a real hook, unrelated repositories shared one queue, and leases lapsed
under working agents.

### Fixed

- **Two sessions with one actor label now collide-protect each other
  (B1).** Every Claude Code session ran as the same actor (`--actor claude`
  per this README, or the default `local-agent`), and a holder's own scopes
  never conflict, so two sessions could both lock `src/auth`. A claim now
  records the holder's **session** and ownership needs actor and session to
  match. `serve` takes the session from `--session`, `SEA_LITE_SESSION` or
  `CLAUDE_CODE_SESSION_ID` (set by Claude Code for stdio MCP servers), else
  a random `inst-xxxxxxxx` per process, and registers it in
  `<data dir>/sessions/` (`0600`) so hooks find it — by session id, or by
  `CLAUDE_PID` ancestry after `/clear`. Re-claiming in the same session
  stays idempotent. `ScopeConflict` gains `title`, `holder_session`,
  `holder_label` (`claude#9b1d0c22`), `expires_in_seconds`; `ClaimView`
  gains `session`, `lease_seconds`; `already_claimed` details gain
  `held_by_session`.
- **`scope-check` is usable from a hook (B2).** Absolute paths inside the
  repository are accepted and made repo-relative (symlinks resolved); a
  path outside is `invalid_input` with `details.reason: "outside_repo"`.
  `--json` prints a documented, versioned object
  (`schema: "sea-lite.scope-check/1"`, with `project` and the resolved
  `identity`); `--actor` / `--session` select the identity; given only a
  session, every claim of that session is the caller's own. **Exit 2 (not
  1) on bad input**, so a hook can tell an error from a conflict.
  `scope-check --hook` is a complete Claude Code PreToolUse hook.
- **Unrelated repositories no longer share a queue (B3).** Tickets carry a
  project key (normalized `origin` remote, else the main working tree's
  path; worktrees share their repository's key), stamped at creation.
  `sea_list`, `sea_next` and scope checks see the current project plus
  legacy tickets without a key; `sea_list { project }` / `--all-projects`
  list across projects. `serve` derives the project from
  `CLAUDE_PROJECT_DIR` or the working directory (`--project` /
  `SEA_LITE_PROJECT` override, `*` = every project); `serve --http`
  defaults to every project.
- **Leases no longer lapse under a working agent (B5).** Default lease 900 s
  (was 300), maximum 3600 s (was 600). Every MCP tool call renews the
  caller's live claims by their own lease (row only, at most every 30 s);
  `sea-lite heartbeat [--hook]` does the same for a PostToolUse hook
  (rate-limited, reports lapsed claims). A lapsed claim is never revived.
  `sea_refresh`'s `extend_by_seconds` defaults to the claim's lease.
- **The README tour works from a fresh install.** It used to show
  `0 ticket(s)` and `not_found`; it is now run line by line by the test
  suite.

### Added

- **Human CLI**: `create`, `claim ID.. --paths`, `next --paths`,
  `release [ID.. | --all]` (the CLI keeps its claim tokens in
  `<data dir>/cli-claims.json`, `0600`), `board` (tickets, holders, locked
  paths, time left, live servers; `--json`, `--all-projects`), `heartbeat`,
  `whoami`. `list` / `show` show holder labels and projects.
- **`sea-lite precommit [--install]`**: a git pre-commit guard that refuses
  a commit staging files inside someone else's live claim — enforcement
  that works for Cursor, Codex, Copilot and humans, and catches Bash-tool
  edits the editor hook cannot see. `hooks/pre-commit` for hook managers.
- **2025-era clients over HTTP (H2)**: `serve --http` serves `initialize`
  clients (Cursor today) through the SDK's stateless legacy fallback, with
  the same bearer and per-actor identity rules. `--legacy reject` restores
  the modern-only endpoint.
- Library: `SeaLite({ session, project })`, `store.heartbeat()`,
  `store.touch()`, identity and project helpers exported.

### Changed

- Schema v4 (additive `ALTER TABLE`): `sea_tickets.claim_session`,
  `claim_lease_seconds`, `project`. Chain compatibility: `claim_session`
  (on `sea_ticket.claimed`) and `project` (on `sea_ticket.created`) are
  optional payload fields, absent when unknown; no hash, cursor or event
  type changes. Claims taken before 0.4.0 carry no session and lapse within
  10 minutes of the upgrade.
- CLI exit codes: 1 means a conflict (scope, claim, fence) or a failed
  check; 2 means bad input or any other error (was 1 for every error).
- One-shot CLI commands act as the resolved identity (see README
  "Identity"); a human at a terminal defaults to `SEA_LITE_ACTOR` or the OS
  user name instead of `local-agent`.
- Tool descriptions and server instructions describe sessions, projects and
  renewal; the catalog fingerprint changed accordingly.
- Docs: README "Identity" and "Enforcement" sections (the edit hook does
  not see Bash-tool edits), THREAT-MODEL "Identity" (labels and sessions
  are self-asserted on stdio; per-actor HTTP tokens are the authenticated
  path), `hooks/README.md` rewritten around the real contract.

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
