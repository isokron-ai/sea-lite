# Roadmap

Things deliberately left out of v0.1, roughly in the order they are likely
to land. Open an issue if one matters to you.

## Next

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
- **Design-track tooling** — a `ready` queue and a `sea_next` mode that
  dispatches design work.
