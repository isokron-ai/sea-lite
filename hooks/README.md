# Hooks and guards: enforcing claims outside the model

A claim's scope only helps if something refuses the edit. sea-lite ships
three enforcement points; use all that your clients support.

| Layer | Stops | Misses |
| --- | --- | --- |
| Claude Code `PreToolUse` hook (`scope-check --hook`, or cc-anchor's scope guard) | `Edit` / `Write` / `MultiEdit` / `NotebookEdit` inside someone else's live claim, before it happens | **edits made through the Bash tool** (`sed -i`, `>` redirects, formatters, codegen, `git checkout -- file`): the hook only sees file-editing tools |
| git `pre-commit` (`sea-lite precommit`) | committing staged files inside someone else's live claim, from **any** client (Cursor, Codex, Copilot, humans), including the Bash edits above | uncommitted working-tree edits; `git commit --no-verify` |
| `scope_conflict` on `sea_claim` / `sea_next` | two holders locking overlapping paths | work done without claiming |

"Someone else" is another actor, or the same actor label in another
session (two Claude Code terminals that both run `--actor claude` are two
holders). See the README's "Identity" section.

## Claude Code: block the edit

1. Copy `scope-check.sh` to `.claude/hooks/sea-lite-scope-check.sh` (keep
   it executable), or install the cc-anchor plugin, which ships the same
   guard.
2. Merge `settings.example.json` into `.claude/settings.json`. It wires:
   - `PreToolUse` on `Edit|Write|MultiEdit|NotebookEdit` → the scope check;
   - `PostToolUse` (`async: true`) → `sea-lite heartbeat --hook`, which
     renews this session's claims at most once a minute, so a long task
     keeps its lease;
   - `WorktreeRemove` → `sea-lite release-worktree --hook`.

No `SEA_LITE_ACTOR` juggling: the hook takes `session_id` from its input
and finds the identity this session's sea-lite server claims under (the
server registers itself in `<data dir>/sessions/`; after `/clear`, when
the hook's session id changes, it is found through `CLAUDE_PID`). Every
claim of the session — main agent and subagents — is the hook's own.

What the agent sees when an edit is refused:

```
PreToolUse:Edit hook error: sea-lite: src/auth/session.ts is inside someone else's live claim (you are claude#9b1d0c22):
conflict: "claude#4f7a1e03" holds src/auth on ticket 8282b24a ("Add rate limiting to login") until 2026-10-31T17:40:00.000Z (12m31s left; src/auth/session.ts ↔ src/auth)
Claim the path (sea_claim / sea_next with scope.paths), wait for the lease to lapse, or take other work.
```

| Situation | `scope-check --hook` exit | effect |
| --- | --- | --- |
| no one else's live claim covers the file | 0 | edit proceeds |
| someone else's does | 2 | edit **blocked**; stderr (holder, ticket, title, overlap, expiry) goes to the agent |
| file outside any git repository; tool call without a file | 0 | not ours to fence |
| sea-lite itself fails | 2, or 0 with `SEA_LITE_HOOK_FAIL_OPEN=1` | block (default) or allow |

## Every client: the git pre-commit guard

```sh
sea-lite precommit --install        # writes .git/hooks/pre-commit (refuses to overwrite a foreign hook)
```

or call `sea-lite precommit` from your hook manager (`hooks/pre-commit` is
a copy-paste version). It checks every staged path (added, modified,
deleted, both sides of a rename) against the live claims of this
repository's project and exits 1 with one line per offending file:

```
sea-lite: commit refused — 1 staged file(s) lie inside someone else's live claim (you are alice):
  src/auth/login.ts: "claude#4f7a1e03" holds src/auth on ticket 8282b24a ("Add rate limiting to login") until … (12m31s left)
Unstage those files, wait for the claim to be released or lapse, or coordinate with the holder (sea-lite board).
Bypass once: git commit --no-verify
```

The committer is resolved like a hook: an agent committing through its
Bash tool carries `CLAUDE_CODE_SESSION_ID`, so its own claims never block
it; a human at a terminal is `SEA_LITE_ACTOR` or their OS user name. It
fails closed (exit 2) if the store cannot be read.

## The `scope-check` contract (for your own hooks)

```
sea-lite scope-check [--paths a,b | PATH...] [--json] [--actor ID] [--session S] [--project KEY] [--data-dir DIR]
```

- **Paths** may be repo-relative or absolute. Absolute paths are resolved
  (symlinks included) against the git repository that contains the first
  one and made repo-relative; a path outside it is `invalid_input` with
  `details.reason = "outside_repo"`. The repository also decides the
  project, so a file in an unrelated repository never conflicts.
- **Identity**: `--actor` / `--session` when given; otherwise the session
  of the agent the command runs for (see the README). Given only a session
  (as a hook is), every claim of that session counts as the caller's own.
- **Exit codes**: 0 no conflict; 1 conflict; 2 bad input or any error.
- **`--json`** prints one object. This shape is stable within
  `schema: "sea-lite.scope-check/1"`; fields may be added, none will be
  removed or renamed without a new schema value:

```json
{
  "schema": "sea-lite.scope-check/1",
  "ok": false,
  "paths": ["src/auth/login.ts"],
  "project": "github.com/acme/api",
  "identity": { "actor": "claude", "session": "9b1d0c22-…", "label": "claude#9b1d0c22", "source": "registry:key" },
  "conflicts": [
    {
      "ticket_id": "8282b24a-…",
      "title": "Add rate limiting to login",
      "holder": "claude",
      "holder_session": "4f7a1e03-…",
      "holder_label": "claude#4f7a1e03",
      "claim_expires_at": "2026-10-31T17:40:00.000Z",
      "expires_in_seconds": 751,
      "held": ["src/auth"],
      "overlapping": [{ "requested": "src/auth/login.ts", "held": "src/auth" }]
    }
  ],
  "swept_expired": 0,
  "head": { "seq": 41, "hash": "…" }
}
```

On exit 2 with `--json`, stdout is
`{ "schema": "sea-lite.scope-check/1", "ok": false, "error": "<code>", "message": "…", "details": { … } }`.

One SQLite read (plus lazy expiry sweeps); node startup dominates
(~150–300 ms). cc-anchor's guard caches verdicts per session and path.

## Worktree removal: release the claims bound to it

A claim can be bound to a git worktree (`scope: { worktree: "/abs/path" }`
on `sea_claim` / `sea_next`). When the worktree goes away, the claims bound
to it should too — otherwise its tickets and paths stay locked until the
leases lapse. `settings.example.json` wires that as a `WorktreeRemove`
hook (`sea-lite release-worktree --hook` reads `worktree_path` from the
hook's JSON). From a script:

```sh
git worktree remove ../wt-auth && sea-lite release-worktree ../wt-auth
```

Every live claim bound to that directory is released, whoever holds it —
the binding the holder declared is the authority, no claim token is needed.
Each release is chained as `sea_ticket.claim_released` with
`via: release_worktree`. Paths are compared lexically after normalization
(backslashes, `..`, trailing slash, drive-letter case), plus the realpath
when the directory still exists. `sea-lite doctor` warns about live claims
bound to a worktree that no longer exists.

## Cursor, Codex, Copilot

They have no pre-edit hook that sea-lite can rely on today, so: the
pre-commit guard above, plus the discipline in `skills/work-queue/SKILL.md`
(claim the paths with the ticket; `sea_scope_check` before touching a path
you did not claim). Each MCP server process is its own session, so two
Cursor windows on one repository are two holders even with the same
`--actor`.
