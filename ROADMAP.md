# Roadmap

Things deliberately left out so far, roughly in the order they are likely
to land. Open an issue if one matters to you.

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

- **Links to existing tickets in `sea_apply`** — today links are batch-local
  (ref → ref). Allowing `to_id` / `from_id` of existing tickets needs the
  batch cycle check to run over the union with existing edges and a fence on
  every existing `from` endpoint.
- **Bulk mutate** — set priority / tags / assignee / status across a filter
  in one transaction, with a dry run that lists the affected ids.
- **HTTP transport** — Streamable HTTP alongside stdio, for clients that
  cannot spawn a process, with a bearer token read from the data dir.
- **Web board** — a read-only board over the same file: columns by status,
  claim holders, lease countdowns.

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
