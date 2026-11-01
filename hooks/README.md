# Edit hook: refuse edits inside someone else's claim scope

`sea_scope_check` exists so a hook can ask, before every edit, whether the
file is inside a path another agent has claimed. This directory is the
reference wiring for Claude Code; the packaged, installable version ships
in the cc-anchor hooks plugin.

## Claude Code

1. Copy `scope-check.sh` to `.claude/hooks/sea-lite-scope-check.sh` in the
   repo (keep it executable).
2. Merge `settings.example.json` into `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/sea-lite-scope-check.sh", "timeout": 20 }
        ]
      }
    ]
  }
}
```

3. Give the hook the same actor label the agent's sea-lite server runs
   with, so its own claims never read as conflicts:

```json
{ "mcpServers": { "sea-lite": { "command": "npx", "args": ["-y", "sea-lite", "serve", "--actor", "agent-a"] } } }
```

```sh
export SEA_LITE_ACTOR=agent-a          # the hook reads this
export KRONICLE_LITE_DATA_DIR=~/.kronicle-lite   # if not the default
```

What happens: the hook reads `tool_input.file_path` from stdin, makes it
repo-relative, and runs `sea-lite scope-check --paths <path> --actor $SEA_LITE_ACTOR`.

| scope-check exit | hook exit | effect |
| --- | --- | --- |
| 0 (no other actor's live scope overlaps) | 0 | edit proceeds |
| 1 (conflict) | 2 | edit is **blocked**; stderr (holder, ticket, overlapping paths, expiry) is fed back to the agent |
| other (sea-lite unreachable) | 2, or 0 with `SEA_LITE_HOOK_FAIL_OPEN=1` | block (default) or allow |

The agent sees, for example:

```
PreToolUse:Edit hook error: sea-lite scope conflict on src/handlers/claims.ts:
conflict: "agent-b" holds src/handlers on ticket 7f3a9c12 until 2026-10-31T17:40:00.000Z (src/handlers/claims.ts ↔ src/handlers)
Claim the path (sea_claim / sea_next with scope.paths), wait for the lease to lapse, or take other work.
```

Paths outside the repo and tool calls without a file are let through.

## Worktree removal: release the claims bound to it

A claim can be bound to a git worktree (`scope: { worktree: "/abs/path" }`
on `sea_claim` / `sea_next`). When the worktree goes away, the claims bound
to it should too — otherwise its tickets and paths stay locked until the
leases lapse. `settings.example.json` wires that as a `WorktreeRemove`
hook:

```json
{ "hooks": { "WorktreeRemove": [ { "hooks": [ { "type": "command", "command": "npx -y sea-lite release-worktree --hook" } ] } ] } }
```

`--hook` reads the hook's JSON from stdin and takes `worktree_path` from
it. If your client's event carries the path under another name, or you
remove worktrees from a script, pass it positionally instead:

```sh
git worktree remove ../wt-auth && npx -y sea-lite release-worktree ../wt-auth
```

Every live claim bound to that directory is released, whoever holds it —
the binding the holder declared is the authority, no claim token is needed.
Each release is chained as `sea_ticket.claim_released` with
`via: release_worktree`, the hook's `--actor` as `actor_id` and the holder
as `claim_actor`. Paths are compared lexically after normalization
(backslashes, `..`, trailing slash, drive-letter case), plus the realpath
when the directory still exists. `sea-lite doctor` warns about live claims
bound to a worktree that no longer exists.

## The CLI subcommand

```
sea-lite scope-check [--paths a,b | PATH...] [--actor ID] [--data-dir DIR] [--json]
```

Exit 0 when no other actor's live, unexpired scope overlaps; 1 when one
does (each conflict printed, or the full `sea_scope_check` result with
`--json`); 2 on bad input. It sweeps lapsed leases first, never takes a
claim, and your own scopes are never conflicts. One SQLite read; hundreds
of calls per second on a laptop.

## Other agents

Any agent that can run a command before an edit can use the same
subcommand. Cursor and Copilot have no pre-edit hook today; for them the
discipline lives in the skill (`skills/work-queue/SKILL.md`): claim the
paths with the ticket, call `sea_scope_check` before touching a path you
did not claim.
