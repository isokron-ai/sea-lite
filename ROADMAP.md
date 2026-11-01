# Roadmap

Things deliberately left out so far, roughly in the order they are likely
to land. Open an issue if one matters to you.

## Landed in 0.3.0

- Streamable HTTP (`serve --http`), loopback + bearer, with per-actor tokens
  (`add-token`) so the actor is bound to a credential.
- Per-actor accounting (`sea_stats`, `sea-lite stats`), derived from the chain.
- `sea-lite doctor`.
- `sea_apply` links to existing tickets (fenced on existing `from`, cycle
  check over the union with existing edges).
- Worktree-bound claims and `release-worktree` for a WorktreeRemove hook.
- CI on Linux, macOS and Windows.

## Landed in 0.2.0

- MCP 2026-07-28 on the v2 SDK, dual-era stdio, `outputSchema` everywhere,
  cacheable catalog, multi round-trip confirmation on terminal transitions.
- Path-scoped claims (`scope.paths` on `sea_claim` / `sea_next`,
  `scope_conflict`, `sea_scope_check`, the `scope-check` CLI and the
  Claude Code edit-hook example).

## Next

- **Scope-aware dispatch** — `sea_next` today refuses a dispatch whose
  scope conflicts. A `scope_mode: skip` that walks on to the next eligible
  ticket whose *ticket-declared* paths (a new `paths` field on tickets,
  set at authoring time) are free, so a swarm self-partitions the tree.
- **Scope on the hook, packaged** — the `PreToolUse` wiring in `hooks/`
  ships as a plugin from cc-anchor; `sea_scope_check` is its only call.
- **Filesystem-aware overlap** — the overlap rule reads a prefix with an
  extension as a file. When the server runs inside the repo it could stat
  the path instead and drop the heuristic (`next.js/` marker).
- **Confirmation on `sea_release force`** — the same multi round-trip gate
  for operator force releases.

- **Bulk mutate** — set priority / tags / assignee / status across a filter
  in one transaction, with a dry run that lists the affected ids.
- **Web board** — a read-only board over the same file: columns by status,
  claim holders, lease countdowns. Served by `serve --http`.
- **Team mode on HTTP** — what actor tokens leave out: token expiry and
  revocation without a restart, per-actor rate limits, read scoping, and
  `sea_stats` exported per seat.
- **Scope-conflict accounting** — `sea_stats` cannot count `scope_conflict`
  refusals because a refusal writes nothing. Counting them needs either a
  chained refusal event (orient-delta volume) or a separate, unchained
  counter table; see "Scope lineage" below.

## Later

- **Explicit claim refresh events (opt-in)** — for deployments that want the
  chain to show lease extensions, at the cost of orient-delta volume.
- **Per-ticket watchers** — `sea_history` feed filtered by tag or assignee.
- **Pluggable eligibility** — let `sea_next` take a custom predecessor rule
  (e.g. `parent_of` children before parents).
- **Scope lineage in `sea_history`** — a feed filter for `scope_conflict`
  refusals (today they are not chained; only successful claims are) so a
  team can see where its agents keep bumping into each other.
- **Design-track tooling** — a `ready` queue and a `sea_next` mode that
  dispatches design work.
