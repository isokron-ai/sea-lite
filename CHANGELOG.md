# Changelog

All notable changes to sea-lite. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning once past 0.x.

## [Unreleased]

### Added (0.7.0 candidate: audit orchestration)

- **Audit tracker for the mcp-audit runner** (library + CLI; no new MCP
  tools, so `tools/list` is unchanged): named exclusive leases with a
  write-intent journal (`leaseAcquire / Renew / Release / Intent / Resolve /
  Show`; a takeover or an abandoning release turns open intents into
  `may_have_happened`, reported to the next holder, which must resolve them
  before writing again), a closed registry of typed ticket fields
  (`setFields` / `fields`), audits as epics in project `audit:<id>` with
  findings and five gate sub-tickets (`auditOpen`, `auditFinding`,
  `auditGate`), the human review queue (`auditReviewQueue`, `auditReview`;
  CLI `audit queue|review`), and export / import (`auditExport` csv|xlsx with
  the PostHog tracker's columns, `auditImport` of a findings.csv; CLI
  `audit export|import`), plus `lease show|release --force`.
- New events `sea_ticket.fields_set`, `sea_lease.acquired|released|
  intent_opened|intent_closed`, and tables `sea_fields`, `sea_field_heads`,
  `sea_leases`, `sea_lease_intents` (docs/MODEL.md). The schema version stays
  4: older builds keep opening the store and ignore the new tables / events.
- XLSX is written by a ~150-line zero-dependency writer (`src/audit/export.ts`,
  node:zlib deflate) instead of a library: CONTRIBUTING asks for minimal
  runtime dependencies. Checked with openpyxl and LibreOffice.
- Review fixes (2026-11-05): lease holder = actor + per-instance id, every
  acquire a new epoch that reports open intents (same-actor storm and
  restart-within-TTL tests); CSV formula guard covers leading whitespace,
  newlines, NBSP and fullwidth `＝＋－＠`, and import undoes it; strict import
  (unterminated quote, ragged row, duplicate / unknown column, duplicate id
  are errors naming the row; gate results from `<gate>_result` columns
  only); managed fields (`review`, gate `result`, identity) cannot be set
  through `setFields`, and an approval reopens when a gate fails or the
  verdict changes; `Object.hasOwn` for field names (`__proto__` /
  `constructor` were a TypeError); credential-shaped text redacted before it
  is chained; `audit export --out` writes 0600; the clock probe no longer
  follows a symlink or blocks on a FIFO, warns once when it cannot measure,
  and `sea-lite doctor` has a `clock` check; the duplicate skew guards in
  `sea_claim` / `sea_next` / `sweepAllExpired` / quiet heartbeat were removed
  so each remaining guard has its own test.
- Not built (scope narrowed by the toolkit council, 2026-11-05): per-pass
  audit templates via `sea_apply` — the runner orchestrates passes in code
  and creates finding tickets only after refutation.

### Fixed before release (#6, review of #5)

- **No raw credential in the chain.** A lease intent's `op` and the audit
  title were chained unredacted (a `ghp_` token was confirmed in the events
  table). Free text is now redacted everywhere the audit layer writes, and
  identity strings (ids, refs, lease names, idempotency keys, token-typed
  fields) that look like a credential are `invalid_input`.
- **Redaction gaps.** Keys glued to `_` (`_ghp_…_`, `key_phx_…`,
  `phx_…_x`) and URL-encoded or base64 / base64url keys are now caught
  (`src/audit/redact.ts`), with tests that use bare keys.
- **`--out` followed symlinks** (overwrote and chmodded the target). It now
  writes an `O_EXCL | O_NOFOLLOW` 0600 temp file and renames it over the path.
- **Self-approving CSV.** An imported `<gate>_result` is recorded as a claim
  (`claimed_result`, exported `claimed:pass`) that never counts toward
  review; `auditImport(…, { trusted: true })` / `audit import --trusted`
  (operator role) records results.
- **Decisions survived changes.** Any change of substance (title, a
  non-bookkeeping field such as severity or summary, a gate's result / note /
  evidence) sends approved / rejected / hold back to `pending`; a gate back
  to `pending` takes the finding out of the queue.
- **Probe tampering.** A hard link at the probe path was truncated, and a
  planted symlink / FIFO switched the guard off. A plant is now unlinked
  (never touching its target) and the probe recreated exclusively; a plant
  that cannot be removed fails closed (`clock_skew`, `reason:
  probe_tampered`; doctor `clock` check fails). Only an unwritable data dir
  still fails open, with a warning.
- **Short rows.** Import refuses a row with fewer cells than the header.

### Fixed before release (#8, review of #7)

- **Probe DoS.** `mkdir <data-dir>/sea-clock.probe` made every claim, next,
  heartbeat and lease acquire fail with `probe_tampered` until someone
  removed it. A planted directory is now renamed aside to
  `sea-clock.probe.tampered-<ms>-<hex>` (kept as evidence) and the probe
  recreated; a symlink / FIFO / hard link is still unlinked. Every repair is
  a `SEA_LITE_CLOCK_PROBE` warning, and `sea-lite doctor` reports a repair
  and any moved-aside plant as a `clock` warning. A plant that cannot be
  moved is measured around with a one-shot probe under an unpredictable name.
- **Healing race.** Processes healing the same plant at once got `EEXIST`
  (or `ENOENT`, `EISDIR`) and reported tampering, refusing leases for 60 s.
  These are now retried; only a path still contested after ten attempts,
  and for the one-shot probe as well, is `probe_tampered`. Tested with 12
  processes healing 25 plants with the race window widened.
- **Unmeasurable clock fails closed** (review of the #8 stack). A probe
  made read-only (`chmod 0444`, same uid) gave `EACCES`, which counted as
  "cannot measure" and let every lease decision through, so a 15-minute skew
  went unnoticed. A read-only probe is now replaced like any other plant,
  and a clock that cannot be measured at all refuses lease decisions
  (`clock_skew`, `reason: probe_unavailable`; doctor `clock` fails) unless
  `SEA_LITE_MAX_CLOCK_SKEW_SECONDS=0`. Moved-aside plants are capped: the
  newest 8 are kept, older ones removed and counted
  (`sea-clock.probe.removed-count`, shown by doctor).

- **Redaction false positives.** `sk-…` and `xox?-…` matched any long
  enough id, so `sandbox:sk-prod-cluster-east-0001`,
  `sk-create-sandbox-attempt-0001`, `xoxb-prod-runner-pool-1` and
  `F-sk-learn-…` were refused and `refs/heads/sk-proj-…` was redacted from
  free text. Those two families now need a minimum length and a
  random-looking body (`randomLooking` in `src/audit/redact.ts`).
- **Quadratic redaction.** The URL-run pattern and kronicle-lite's
  `env_secret` pattern backtracked quadratically (about 130 ms per 8 KB
  cell, 0.8 s per 32 KB word), inside the write transaction. Every pattern is
  now literal-led or bounded, decoded text is scanned under a budget
  (exceeded: the text is redacted whole), and callers redact before the
  transaction opens (`prepareFields` / `prepareFinding`; `audit import`
  prepares every row first). kronicle-lite's write-time detectors are
  mirrored with bounded quantifiers; a parity test checks that everything
  they flag is still redacted. Timing tests on 17 adversarial 128 KB shapes.
- **Shape, not entropy, for known formats; prefixes at token boundaries**
  (review of the #8 stack). The randomness gate let about 1 in 6 000
  generated Anthropic keys and 1 in 8 000 `xoxb` tokens through. `sk-ant-`,
  `sk-proj-` / `sk-svcacct-` / `sk-admin-`, legacy 48-character `sk-`,
  `gh?_`, `github_pat_`, `xox?-` (numeric segments, then the secret) and
  `AKIA` / `ASIA` are now matched by documented shape and length only; the
  randomness check is left for a bare `sk-` with none of those shapes. A
  prefix counts only at a token boundary, so `task-<ULID>`, `disk-…`,
  `helpdesk-…`, `laughs_…`, `snpm_…` are ordinary ids again; a prefix glued
  to a letter or digit still counts at the format's full length (GitHub 36,
  fine-grained / project / Anthropic 80+, legacy `sk-` 48). Property test:
  100 000 generated keys of each of 13 formats, all redacted.
- **Redaction misses closed**: a letter or digit glued in front of a key,
  base64 of `x`+key, base64 in URL paths, MIME-wrapped base64, hex, and
  nested encodings (up to four levels; printable text nested deeper is
  redacted).

- **`audit export --out <existing dir>`** crashed with `EISDIR` and left a
  0600 temp file holding the tracker. A directory is now `invalid_input`
  before anything is written, and any failure after the temp file exists
  removes it (`writePrivateFile`, `src/audit/export.ts`). A file or link
  already at the temp name is never opened (`O_EXCL`); another name is tried.

### Compatibility

- **0.6.x on a store with audit data.** The new tables have no foreign key to
  `sea_tickets`, so a 0.6.x `sea-lite rebuild` (which drops `sea_tickets` with
  foreign keys on) still succeeds; 0.6.x ignores the new tables and events,
  and since ticket ids are stable across rebuilds the field rows stay
  correct. A development build of this branch from before 2026-11-05 created
  them with foreign keys: on such a store, run a 0.7 `rebuild` before using
  0.6.x `rebuild`.
- `swept_expired` counts only leases actually swept (a skewed process sweeps
  none).

### Fixed (0.6.2)

- **Lease clock skew (C2-06).** Expiry compared wall-clock instants written
  by different processes, so a process 15 min ahead took over every live
  lease, and one behind wrote leases that lapsed early for everyone else.
  Each process now measures its clock against the file-system time on a
  probe file in the data dir (re-measured at most once a minute); beyond
  `SEA_LITE_MAX_CLOCK_SKEW_SECONDS` (default 30, 0 disables) claim, next,
  refresh and heartbeat fail with the new error code `clock_skew`, the
  per-call auto-heartbeat skips, and the lazy expiry sweep leaves other
  holders' leases alone. Reads and fenced writes are unchanged. Library
  option `clockReference` supplies another reference.
- **Idempotency keys from before 0.6.0 (C2-07).** A key bound to an event
  without a `request_hash` replayed whatever request reused it after an
  upgrade (F09 again). It is now `invalid_input` with
  `reason: "unverifiable_key"` and the bound `first_seq`; nothing is written.
- **SQLite busy under load (round-3 lead, `sl-cli-tokens.sh 40`).** Not
  reproduced in 8 runs of 40/80-way CLI claim storms here; fixed the two
  ways it could happen: sea-lite lowered kronicle-lite's 10 s busy timeout to
  5 s, and every open ran a write transaction even when the schema was
  current (one extra writer per CLI command). Opening a current store now
  writes nothing, the timeout stays at ≥ 10 s, and `SQLITE_BUSY` past it —
  in a sea-lite transaction or while opening — is a typed `wait_timeout`
  ("nothing was written, retry"; CLI exit 1) instead of a raw stack trace.

## [0.6.1] — 2026-11-01

Fixes from hardening round 2 (hooks, protocol and chaos tracks) and the live
full-stack runs, plus kronicle-lite ^0.8.0.

### Fixed

- **Scope paths (H2-23).** A dangling symlink into a claim
  (`dangling → src/handlers/nope.ts`) was kept as written, so `scope-check`
  passed and a write through it created a file inside the claim. A dangling
  link now names its target, resolved lexically from the link's directory
  (chains follow; a loop stops after 40 hops and is kept as written; a target
  outside the repository is `outside_repo`, like any escaping link). And
  `src/../src/x` was refused (exit 2, "must not climb out"): `..` that stays
  inside the repository is now resolved — lexically without a root, on disk
  with one (after a symlinked directory, `..` is the target's parent, as for
  the OS). Climbing above the root, or `..` after a glob, is still
  `invalid_input`.
- **Response budget for `sea_list` / `sea_history` (P2-03).** 200 tickets with
  schema-max bodies made a 38 MiB line (34–95 s, event loop blocked) and
  killed the TS stdio client. A page now stops before the item that would
  exceed `SEA_LITE_MAX_RESPONSE_BYTES` (default 256 KiB; 1 KiB–4 MiB; store
  option `maxResponseBytes`), always with at least one item:
  `sea_list` continues with `next_cursor`, `sea_history` with
  `since_seq = last_seq` (`truncated`); both add `budget_truncated: true` when
  the budget, not `limit`, ended the page. A single history event over the
  budget (a large `sea.batch_applied`) comes back with its payload elided.
  `sea_list` sorts ids only and reads rows one at a time.
- **Concurrent first start of `serve --http` (P2-07).** The bearer file was
  check-then-create, so one of two servers starting on a fresh data dir could
  exit (`EEXIST`, or "token is empty"). It is now created exclusively (temp
  file + link, kronicle-lite's recipe), an empty file is re-read for up to
  2 s, and the data dir is created when missing.
- **Over-limit stdio messages (P2-05 / F11).** A request line over 10 MiB made
  `serve` exit 0 with no reply. It is now discarded as it streams and
  answered with JSON-RPC `-32600` carrying the request's id; the server stays
  up.
- **CLI claim tokens under concurrency (C2-02).** `cli-claims.json` was an
  unlocked read-modify-write: 40 concurrent CLI claims lost up to 34 tokens,
  and those claims could not be released until their leases lapsed. Updates
  now hold an exclusive lock file (stale after 30 s); `release` forgets only
  the tokens it used.
- **HTTP team mode (P2-12).** The actors file is re-read when it changes (one
  `stat` per request), so `add-token` after `serve --http` works without the
  restart the README never mentioned; a file that does not parse keeps the
  previous tokens. `add-token` on a machine with no data dir creates it (was
  an `ENOENT` stack trace). The force-release refusal names the caller's role
  and how an HTTP token gets `operator`.
- **Token file modes (P2-13).** A pre-existing bearer file (or
  `--bearer-file`) that group or others can read was used silently; it is now
  refused at start unless `--allow-insecure-token-file`, which warns.
- **Project keys (kronicle-lite 0.8.0 recipe).** A missing path in a non-git
  directory was keyed as spelled, so `<link>/new` and `<real>/new` were two
  projects; it now resolves through its nearest existing ancestor.
- **Server instructions overflowed** their 512-char budget (513) for an
  operator with a long actor in the core profile, which made `serve` throw.

### Changed

- **The session is kept out of kronicle-lite actor ids (L2-06).** Agents
  copied sea-lite's `agent-A#<session>` into their kronicle-lite `actor_id` in
  13 of 96 live sessions, splitting pending items and lineage by session. The
  instructions now read `You are "agent-A" (role agent; session 1a2b3c4d:
  sea-lite only, not in a kronicle-lite actor_id).`, and the work-queue skill
  and `holder_label` say the same. The instructions show the actor up to 24
  characters.
- kronicle-lite `^0.8.0` (was `^0.7.0`). sea-lite's project keys and scope
  paths are its own (no table is shared with kronicle-lite's project keys);
  the full suite passes on 0.8.0 unchanged.
- F15 (`scope-check -- PATH`) was already fixed in 0.6.0; regression cases
  added for an option-looking word after `--` and a value flag right before
  it.

## [0.6.0] — 2026-11-01

Wait for a claim instead of polling for it. Measured by agent-memory-bench
Track A S15 (Track B T3's conflict pattern: two agents, four tickets whose
scopes all overlap on CHANGELOG.md; time-compressed, 3 runs per mode):
sleep-and-retry vs `wait_seconds` — wall 9.07 s → 8.78 s, tool calls
15 → 10, model turns 20 → 10, tickets done by A / B 4 / 0 (B gave up in 3/3
runs) → 2 / 2 (0/3), release→next-claim gap 0.255 s → 0.154 s. The work
serializes on the shared file either way, so wall time barely moves; the
gains are fairness and half the turns. S3a–d verdicts unchanged.

### Added

- **`wait_seconds` on `sea_claim` and `sea_next`** (≤ 300; CLI `claim` /
  `next --wait S`): wait for a held ticket or scope to free up instead of
  failing. The result gains `waited: {seconds, attempts, blocked_by, freed}`
  (`freed`: `released` / `finished` / `lease_expired` / `changed`); a wait
  that never frees up fails with the new `wait_timeout` code naming the
  holder, ticket and expiry (CLI exit 1); a cancelled request ends it with
  `wait_cancelled`. `sea_next` also waits while nothing is free but someone
  else holds work that could free up; an empty queue still answers at once.
  Refusals waiting cannot fix (unknown ticket, bad input) fail at once.
- No lock is held and the store is not polled hard: a waiter retries only
  on a change — another process's commit (SQLite `PRAGMA data_version`,
  20–250 ms backoff), this process's commit (an in-process notifier poked by
  every write transaction, immediate) — or at the blocking lease's expiry.
  A release in another process is picked up within about 250 ms; a lapsed
  lease 20–35 ms after its expiry (stress: kill -9 of the holder).
- MCP: the waiting handlers are async, end with the request's cancellation,
  and send a progress notification every 5 s naming the holder when the
  client sends a progressToken. Clients enforce their own request timeout
  (the TypeScript SDK's default is 60 s unless it resets on progress): keep
  `wait_seconds` below it (README "Client timeouts").

### Changed

- `--core` no longer advertises `lease_seconds` on `sea_claim` /
  `sea_next` (still accepted; leases default to 900 s and renew on
  activity), so `tools/list` stays within 12 KB with `wait_seconds` added.

## [0.5.0] — 2026-11-01


- Depends on kronicle-lite ^0.7.0 (was ^0.2.0): picks up the atomic first-start fix (signing key and SQLite schema), so several `sea-lite serve` processes starting at once on a fresh data directory no longer crash.

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
  only. `tools/list` ~11.7 KB. Its server instructions name the six tools it
  leaves out (`sea_create`, `sea_update`, `sea_link`, `sea_list`,
  `sea_history`, `sea_stats`) and how to get them (`serve` without
  `--core`, or `SEA_LITE_PROFILE=full`). The full profile stays the default.
- **Templates in `sea_apply`**: `templates: [{for_each, ref, ticket,
  links}]` repeats one ticket and its links per value (`for_each` is an
  array of strings/numbers or a count n). `{i}` (1-based), `{value}`,
  `{ref}` (this item's expanded ref) and `{prev}` (the expanded ref of the
  previous item of the same template, item i−1; a link naming it is skipped
  for item 1) are substituted in every string, so a 20-step chain is
  written once. Expansion is server-side, deterministic and happens
  before validation: the 50-ticket / 100-link caps, the cycle check,
  `dry_run` and `idempotency_key` all see the expanded batch. New
  `batch_invalid` problem codes: `bad_template`, `too_many_tickets`,
  `too_many_links`, `invalid_expansion`, `empty_batch`.
- **`sea_apply` errors name exactly what failed.** Every `batch_invalid`
  problem has `where` (`tickets[2] (a)`, `links[4]`, `templates[0] item 3
  (t03)`, `templates[0] item 3 (t03) links[1]`, `claims[0]`) and the
  structured `template` / `item` (1-based) / `ref` / `link` indexes, and its
  message starts with that location; a duplicate ref or link names the
  first occurrence too; the cap errors give each part's expanded count. A
  `cycle` error gives the path by refs and `closed_by`, the link that closes
  it. Still all or nothing.
- **`sea_finish`**: end your work in one call, claim and scope released.
  Required `outcome`: `done` → `resolved`; `blocked` → `blocked` (not
  terminal, resumable; an already-blocked ticket stays blocked); `abandoned`
  → `dropped`. Required `note` (non-empty, ≤ 1000 chars); optional `commit`
  (sha, 7–64 hex). Recorded on the chain — `outcome` and `commit` on the
  status_set event, `finish: {outcome, commit, from, to}` on the note event —
  and on the ticket as the note `done @ 3f2a9c1: …`, so `sea_get` and
  `sea_history` show why. `tickets: [...]` finishes several, each fenced by
  its own token, all or nothing. No confirmation round trip: calling it is
  the confirmation. With `idempotency_key`, item k's note is keyed `<key>#k`
  and a repeat replays. Store API `finish()`.
- **Bulk `sea_transition`**: `tickets: [{ticket_id, claim_token,
  expected_version?}, …]` (≤ 50) instead of `ticket_id` + `claim_token`.
  Each ticket is fenced by its own token; every ticket is checked first and
  if any fails nothing is written (`batch_invalid` lists each failing ticket
  with its own error). One confirmation covers a terminal move of the set.
  With `idempotency_key`, item k replays under `<key>#k`. Store API
  `transitionMany()`.
- `sea_transition` takes `note` (appended in the same transaction).

### Fixed

- **Scope paths through symlinks name the files they point at.** A relative
  path through a link (`hlink/claims.ts` or `flink`, linking into a claimed
  `src/handlers`) passed `scope-check` and could be claimed by another
  session, so two live claims covered the same files; the same path given
  absolute was caught. Every claim path (`sea_claim`, `sea_next`, CLI
  `claim` / `next`) and every checked path (`sea_scope_check`,
  `scope-check`, its `--hook`, `precommit`) is now resolved through the
  realpath of its longest existing prefix (the literal part before any
  glob) against the repository root, and kept in its repo-relative form for
  display. A link that resolves outside the repository is `invalid_input`
  (`reason: "outside_repo"`). The stdio server takes the root from
  `CLAUDE_PROJECT_DIR` or its working directory; `serve --http` and library
  use without `root` keep paths lexical. Uses the platform realpath
  (canonical case on Windows) and `/` separators on every OS.
- **`sea-lite scope-check -- PATH`** checks the paths after `--` (they were
  dropped and the command exited 2); `--` ends the options for every
  command, so a path may start with `-`.

- **A reused `idempotency_key` with a different request is refused, never
  replayed.** In 0.4.0 a second `sea_apply` (or `sea_create`, `sea_update`,
  `sea_transition`, `sea_link`) under a key already used returned the first
  call's result even when the request differed — e.g. a 3-ticket batch under
  the key of an earlier 10-ticket batch came back as the 10 tickets and
  created nothing. Every keyed write now stores `request_hash` (sha256 of the
  canonical JSON of the operation and its request) on the keyed event; a
  reuse with a different hash is `invalid_input` — `idempotency_key "K"
  reused with a different request; nothing was written`, with
  `details.reason: "request_mismatch"` and the key's `first_seq`. The same
  request still replays, from any process, session or actor. The hash
  ignores the key, `dry_run`, `verbose`, `confirm` and claim tokens, uses
  full ticket ids (a prefix and the full id are the same request), and is
  taken after template expansion (the same templates, or the same plan
  written out, are the same request). Bulk `sea_transition` and
  `sea_finish` bind every item's `<key>#k` to the whole request, so a reuse
  with more tickets is refused instead of moving the extra ones. Keys
  written before this change carry no hash and still replay. Reusing a key
  for another operation stays `invalid_input` (`reason: "other_operation"`).

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
