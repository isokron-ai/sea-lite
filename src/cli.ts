#!/usr/bin/env node
/**
 * sea-lite CLI. `sea-lite help` lists every command; README.md has the tour.
 *
 * Exit codes (every command): 0 ok; 1 a conflict (scope_conflict,
 * already_claimed, a fence error, a refused commit) or a failed check
 * (verify, doctor); 2 bad input (including an unknown or misspelt option:
 * see cli-args.ts) or any other error. `scope-check` and
 * `precommit` are hook contracts: see hooks/README.md.
 */

import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { defaultDataDir } from 'kronicle-lite';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { SeaError } from './core/errors.js';
import {
  holderLabel,
  listInstances,
  newInstanceSession,
  registerInstance,
  resolveIdentity,
  sessionKeyFromEnv,
  SESSIONS_DIR,
  type ResolvedIdentity,
} from './core/identity.js';
import { findRepo, projectKeyFor, resolveProject } from './core/project.js';
import { MAX_SCOPE_PATHS } from './core/scope.js';
import { MAX_STDIO_LINE_BYTES, StdioLineGuard } from './stdio-guard.js';
import type { TicketCompact, Ticket } from './core/types.js';
import { ALL_STATES, type TicketStatus } from './model/enums.js';
import * as S from './model/schemas.js';
import {
  ACTORS_FILE_NAME,
  addActorToken,
  DEFAULT_HTTP_PORT,
  checkTokenFileMode,
  loadOrCreateBearer,
  readActorsFile,
  readBearerFile,
  serveHttp,
  type ActorToken,
} from './http.js';
import { renderDoctor, runDoctor } from './doctor.js';
import type { ScopeConflict } from './handlers/claims.js';
import type { ActorStats, StatsResult } from './handlers/stats.js';
import { createServer, PROFILES, type Profile } from './server.js';
import type { WaitInfo } from './core/wait.js';
import { DEFAULT_ACTOR, parseRole, parseTracks, SeaLite } from './store.js';
import { writePrivateFile } from './audit/export.js';
import { COMMANDS, formatZodError, strictArgs, strictInt, unknownCommand, type Args } from './cli-args.js';

export { VERSION } from './version.js';
import { VERSION } from './version.js';

function str(v: string | true | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: string | true | undefined, flag: string): number | undefined {
  return strictInt(v, flag);
}

/** Comma-separated flag values. */
function list(v: string | true | undefined): string[] {
  return typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter((x) => x.length > 0) : [];
}

function dataDirOf(flags: Args['flags']): string {
  return str(flags['data-dir']) ?? defaultDataDir();
}

const HELP = `sea-lite ${VERSION} — a work queue for parallel coding agents that can't collide

The queue, by hand (no LLM needed):
  sea-lite create TITLE [--triaged] [--body B] [--kind K] [--priority P] [--tags a,b] [--json]
  sea-lite next    [--paths a,b] [--lease S] [--wait S] [--json]      claim the next eligible ticket (and lock the paths)
  sea-lite claim   ID.. [--paths a,b] [--lease S] [--wait S] [--json]  claim tickets (and lock the paths)
                     --wait S: if held, wait up to S seconds (≤ 300) for it to free up
  sea-lite release [ID.. | --all] [--note N] [--json]      give claims back (the CLI keeps your tokens)
  sea-lite board   [--all-projects] [--all] [--json]       tickets, holders, locked paths, time left; live sessions
                     --all: closed tickets too, and the count by status
  sea-lite heartbeat [--json] [--hook]                     renew your live claims (--hook: PostToolUse, rate-limited)
  sea-lite whoami  [--json]                                the identity and project this shell acts as

Hooks and guards:
  sea-lite scope-check [--paths a,b | PATH..] [--json] | --hook
                     exit 0 if no one else's live claim covers the paths, 1 if one does, 2 on bad input.
                     PATHs may be absolute (inside the repo) or repo-relative. --hook: a whole Claude Code
                     PreToolUse hook (reads its JSON on stdin; exit 2 blocks). See hooks/README.md.
  sea-lite precommit [--install]
                     git pre-commit guard: refuse a commit that stages files inside someone else's live claim.
  sea-lite release-worktree [PATH | --hook] [--reason R] [--json]
                     release every live claim bound to a removed worktree

Serving agents:
  sea-lite serve   [--core] [--actor ID] [--session S] [--project KEY|*] [--role agent|operator] [--tracks work,design]
                     --core (= --profile core): only the day-to-day tools, short descriptions (~11 KB tools/list)
  sea-lite serve --http [--port N] [--host H] [--bearer T | --bearer-file F] [--actors-file F]
                   [--allow-origin H,..] [--allow-host H,..] [--project KEY|*] [--legacy stateless|reject]
                   [--allow-insecure-token-file]
                     Streamable HTTP on 127.0.0.1:${DEFAULT_HTTP_PORT}/mcp (2026-07-28, and 2025-era clients unless
                     --legacy reject); shared bearer from DIR/http-bearer.token; per-actor tokens from
                     DIR/http-actors.json (or --actors-file), re-read when it changes; a token file
                     group/others can read is refused unless --allow-insecure-token-file
  sea-lite add-token --actor ID [--role agent|operator] [--actors-file F]
                     mint a per-actor HTTP token (the authenticated identity), print it once

Inspecting:
  sea-lite list    [--status S,S] [--all] [--all-projects] [--query Q] [--json]
  sea-lite show ID [--json]
  sea-lite stats   [--since 24h|7d|ISO] [--for ACTOR] [--json]
  sea-lite verify | rebuild | doctor [--json]

Audits (driven by the mcp-audit runner through the library; these are the human side):
  sea-lite audit queue  AUDIT [--json]                     findings whose gates are all resolved, awaiting review
  sea-lite audit review AUDIT FINDING approved|rejected|hold [--plan P] [--note N]   (operator role)
  sea-lite audit export AUDIT [--format csv|xlsx] [--out FILE]   the findings tracker (CSV to stdout by default)
  sea-lite audit import AUDIT FILE.csv [--trusted]         upsert a findings.csv by finding id; gate results land as
                     claims unless --trusted (operator role)
  sea-lite lease show NAME [--json] | lease release NAME --force   named leases (e.g. sandbox:ID)

Common flags: --data-dir DIR (default $KRONICLE_LITE_DATA_DIR or ~/.kronicle-lite, shared with kronicle-lite),
  --actor ID, --session S, --project KEY ('*' = every project).
Identity: a claim belongs to an actor AND a session. serve takes the session from --session,
  SEA_LITE_SESSION or CLAUDE_CODE_SESSION_ID (else a random instance id) and registers it; other
  commands find the session of the agent they run for (see docs/THREAT-MODEL.md "Identity").
Env: SEA_LITE_ACTOR, SEA_LITE_SESSION, SEA_LITE_PROJECT, SEA_LITE_ROLE, SEA_LITE_TRACKS, SEA_LITE_PROFILE,
  SEA_LITE_MAX_CLOCK_SKEW_SECONDS (default 30; 0 disables the lease clock check).
`;

// ───────────────────────────── identity / store ─────────────────────────────

interface Opened {
  store: SeaLite;
  identity: ResolvedIdentity;
  dataDir: string;
}

/**
 * The store for a one-shot command, acting as the identity resolved for this
 * shell (core/identity.ts) in `project` (null = every project). `sessionWide`:
 * a hook speaks for every agent of its session (scope-check, precommit,
 * heartbeat when no --actor was given).
 */
/**
 * `root`: the repository scope paths are resolved against through symlinks
 * (core/scope.ts canonicalScopePath); default: the repository of the cwd.
 */
function openAs(flags: Args['flags'], project: string | null, opts: { sessionWide?: boolean; root?: string | null } = {}): Opened {
  const dataDir = dataDirOf(flags);
  const root = opts.root !== undefined ? opts.root : (findRepo(process.cwd())?.root ?? null);
  const identity = resolveIdentity({ dataDir, actor: str(flags['actor']), session: str(flags['session']) });
  const role = str(flags['role']);
  const tracks = str(flags['tracks']);
  const base = new SeaLite({
    dataDir,
    actor: identity.actor,
    session: identity.session,
    project,
    root,
    ...(role !== undefined ? { role: parseRole(role) } : {}),
    ...(tracks !== undefined ? { tracks: parseTracks(tracks) } : {}),
  });
  const wide = opts.sessionWide === true && str(flags['actor']) === undefined && identity.session !== null;
  // A view shares the connection; close() goes through `base`.
  const store = wide ? base.as(base.actor, base.role, { sessionWide: true }) : base;
  if (wide) closers.push(() => base.close());
  else closers.push(() => base.close());
  return { store, identity, dataDir };
}

const closers: (() => void)[] = [];
function closeAll(): void {
  while (closers.length > 0) {
    try {
      closers.pop()!();
    } catch {
      // closing twice is harmless
    }
  }
}

/** Project for a one-shot command: --all-projects → every project; else --project / SEA_LITE_PROJECT / CLAUDE_PROJECT_DIR / cwd. */
function projectOf(flags: Args['flags']): string | null {
  if (flags['all-projects'] === true) return null;
  return resolveProject(str(flags['project']));
}

/** realpath of the nearest existing ancestor, with the missing tail re-appended (a Write may name a new file). */
function realish(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return abs;
      tail.push(cur.slice(up.length).replace(/^[\\/]+/, ''));
      cur = up;
    }
  }
}

/**
 * Turn the paths a hook or a human gives into repo-relative scope entries.
 * Absolute paths must lie inside one repository (the first one's); anything
 * outside is invalid_input with details.reason = "outside_repo". Relative
 * paths are taken as repo-relative (as before 0.4.0). Returns the paths and
 * the project they belong to (the absolute paths' repository decides).
 */
function repoRelative(raw: string[], flags: Args['flags']): { paths: string[]; project: string | null; root: string | null } {
  const firstAbs = raw.find((p) => isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p));
  if (firstAbs === undefined) return { paths: raw, project: projectOf(flags), root: findRepo(process.cwd())?.root ?? null };
  const repo = findRepo(firstAbs);
  if (repo === null) {
    throw new SeaError('invalid_input', `"${firstAbs}" is not inside a git repository`, { reason: 'outside_repo', path: firstAbs });
  }
  const out: string[] = [];
  for (const p of raw) {
    if (!(isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p))) {
      out.push(p);
      continue;
    }
    const rel = relative(repo.root, realish(p));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new SeaError('invalid_input', `"${p}" is outside the repository ${repo.root}`, { reason: 'outside_repo', path: p, root: repo.root });
    }
    out.push(rel.split(sep).join('/'));
  }
  const explicit = str(flags['project']);
  const project = flags['all-projects'] === true ? null : explicit !== undefined ? resolveProject(explicit) : projectKeyFor(repo.root);
  return { paths: out, project, root: repo.root };
}

// ───────────────────────────── CLI claim tokens ─────────────────────────────

/**
 * Tokens of claims taken from the CLI, so `release` needs no token juggling.
 * `<data dir>/cli-claims.json`, mode 0600, keyed by ticket id. Holding a
 * token is holding the claim: the file is as sensitive as the data dir.
 */
interface CliClaim {
  token: string;
  actor: string;
  session: string | null;
  expires_at: string;
}
const CLI_CLAIMS_FILE = 'cli-claims.json';

function readCliClaims(dataDir: string): Record<string, CliClaim> {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, CLI_CLAIMS_FILE), 'utf8')) as { claims?: Record<string, CliClaim> };
    return j.claims ?? {};
  } catch {
    return {};
  }
}

function writeCliClaims(dataDir: string, claims: Record<string, CliClaim>): void {
  const file = join(dataDir, CLI_CLAIMS_FILE);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, claims }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** A lock older than this is a crashed holder's: taken over. Every holder is one short read-modify-write. */
const CLI_CLAIMS_LOCK_STALE_MS = 30_000;
const CLI_CLAIMS_LOCK_WAIT_MS = 30_000;

/**
 * C2-02 (0.6.1): read-modify-write of cli-claims.json under an exclusive lock
 * file (`open(O_CREAT|O_EXCL)`, retried), so concurrent CLI claims and
 * releases never drop each other's tokens (40 concurrent claims lost up to 34
 * tokens on 0.6.0). The write itself stays temp file + rename.
 */
function updateCliClaims(dataDir: string, change: (claims: Record<string, CliClaim>) => void): void {
  mkdirSync(dataDir, { recursive: true });
  const lock = join(dataDir, `${CLI_CLAIMS_FILE}.lock`);
  const deadline = Date.now() + CLI_CLAIMS_LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > CLI_CLAIMS_LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        // gone already: retry at once
      }
      if (Date.now() > deadline) throw new SeaError('wait_timeout', `${lock} is held by another sea-lite process; remove it if no sea-lite command is running`, { lock });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 20));
    }
  }
  try {
    const claims = readCliClaims(dataDir);
    change(claims);
    writeCliClaims(dataDir, claims);
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      // taken over as stale: nothing to remove
    }
  }
}

function rememberTokens(dataDir: string, who: ResolvedIdentity, got: { ticket_id: string; claim_token: string; expires_at: string }[]): void {
  if (got.length === 0) return;
  updateCliClaims(dataDir, (claims) => {
    for (const g of got) claims[g.ticket_id] = { token: g.claim_token, actor: who.actor, session: who.session, expires_at: g.expires_at };
  });
}

// ───────────────────────────── formatting ─────────────────────────────

function fmtLeft(expiresAt: string, now = Date.now()): string {
  const s = Math.round((Date.parse(expiresAt) - now) / 1000);
  if (s <= 0) return 'lapsed';
  return `${fmtDuration(s)} left`;
}

function fmtRow(t: Ticket | TicketCompact): string {
  const claim = t.claim ? ` [${holderLabel(t.claim.holder, t.claim.session)} until ${t.claim.expires_at.slice(11, 19)}Z]` : '';
  return `${t.id.slice(0, 8)}  ${t.status.padEnd(14)} ${t.priority.padEnd(7)} ${t.kind.padEnd(13)} ${t.title}${claim}`;
}

function waitedLine(w: WaitInfo | undefined): string {
  return w === undefined ? '' : `waited ${w.seconds}s for "${w.blocked_by.holder_label}" (ticket ${w.blocked_by.ticket_id.slice(0, 8)}): ${w.freed.replace('_', ' ')}\n`;
}

function fmtConflict(c: ScopeConflict): string {
  return (
    `conflict: "${c.holder_label}" holds ${c.held.join(', ')} on ticket ${c.ticket_id.slice(0, 8)} ("${c.title}") until ${c.claim_expires_at}` +
    ` (${fmtLeft(c.claim_expires_at)}; ${c.overlapping.map((o) => `${o.requested} ↔ ${o.held}`).join('; ')})`
  );
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd()).join('\n') + '\n';
}

function out(flags: Args['flags'], json: unknown, text: () => string): void {
  process.stdout.write(flags['json'] === true ? JSON.stringify(json, null, 2) + '\n' : text());
}

// ───────────────────────────── commands ─────────────────────────────

async function main(argv: string[]): Promise<number> {
  const first = argv[0] ?? 'help';
  if (first === 'help' || first === '--help' || first === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (first === '--version' || first === 'version') {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (!COMMANDS.includes(first)) {
    process.stderr.write(`${unknownCommand(first)}\n\n${HELP}`);
    return 2;
  }
  // SL-1: strict. An option the command does not take is an error ("did you mean"), never a no-op.
  const { cmd, sub, positional, flags } = strictArgs(argv);
  if (flags['help'] === true) {
    process.stdout.write(HELP);
    return 0;
  }

  switch (cmd) {
    case 'serve':
      return serveCmd(flags);
    case 'create': {
      const title = positional.join(' ').trim();
      if (title === '') throw new SeaError('invalid_input', 'create needs a TITLE');
      const { store } = openAs(flags, projectOf(flags));
      const status = flags['triaged'] === true ? 'triaged' : (str(flags['status']) ?? 'idea');
      const input = S.CreateInput.parse({
        title,
        status,
        ...(str(flags['body']) !== undefined ? { body: str(flags['body']) } : {}),
        ...(str(flags['kind']) !== undefined ? { kind: str(flags['kind']) } : {}),
        ...(str(flags['priority']) !== undefined ? { priority: str(flags['priority']) } : {}),
        ...(str(flags['assignee']) !== undefined ? { assignee: str(flags['assignee']) } : {}),
        tags: list(flags['tags']),
      });
      const r = store.create(input);
      out(flags, r, () => {
        let s = `created ${r.ticket.id.slice(0, 8)}  ${r.ticket.title}  (${r.ticket.status}, ${r.ticket.priority}, ${r.ticket.kind}${r.ticket.project ? `; project ${r.ticket.project}` : ''})\n`;
        for (const d of r.possible_duplicates) s += `  possible duplicate: ${d.ticket_id.slice(0, 8)} ${d.title} (${d.status})\n`;
        return s;
      });
      return 0;
    }
    case 'claim':
    case 'next': {
      const rawPaths = list(flags['paths']);
      const rel = rawPaths.length > 0 ? repoRelative(rawPaths, flags) : { paths: [], project: projectOf(flags), root: null };
      const { store, identity, dataDir } = openAs(flags, rel.project, { root: rel.root });
      const lease = num(flags['lease'], 'lease');
      const wait = num(flags['wait'], 'wait');
      const worktree = str(flags['worktree']);
      const scope =
        rel.paths.length > 0 || worktree !== undefined
          ? { ...(rel.paths.length > 0 ? { paths: rel.paths } : {}), ...(worktree !== undefined ? { worktree: resolve(worktree) } : {}) }
          : undefined;
      if (cmd === 'claim') {
        if (positional.length === 0) throw new SeaError('invalid_input', 'claim needs one or more ticket ids (or use `sea-lite next`)');
        const r = await store.claimWait(
          S.ClaimInput.parse({ ticket_ids: positional, ...(lease !== undefined ? { lease_seconds: lease } : {}), ...(scope ? { scope } : {}), ...(wait !== undefined ? { wait_seconds: wait } : {}) }),
        );
        rememberTokens(dataDir, identity, r.claims);
        out(flags, { ...r, holder: holderLabel(identity.actor, identity.session) }, () =>
          r.claims
            .map(
              (c) =>
                `claimed ${c.ticket_id.slice(0, 8)} as ${holderLabel(identity.actor, identity.session)} until ${c.expires_at.slice(11, 19)}Z (${fmtLeft(c.expires_at)})` +
                `${r.scope ? `; locks ${r.scope.paths.join(', ')}` : ''}${c.rotated ? '; token rotated' : ''}\n`,
            )
            .join('') + waitedLine(r.waited),
        );
        return 0;
      }
      const kinds = list(flags['kind']);
      const r = await store.nextWait(
        S.NextInput.parse({
          ...(wait !== undefined ? { wait_seconds: wait } : {}),
          ...(lease !== undefined ? { lease_seconds: lease } : {}),
          ...(scope ? { scope } : {}),
          ...(kinds.length > 0 ? { kind: kinds } : {}),
          ...(str(flags['tag']) !== undefined ? { tag: str(flags['tag']) } : {}),
        }),
      );
      if (r.ticket && r.claim_token && r.expires_at) rememberTokens(dataDir, identity, [{ ticket_id: r.ticket.id, claim_token: r.claim_token, expires_at: r.expires_at }]);
      out(flags, r, () =>
        r.ticket
          ? `claimed ${r.ticket.id.slice(0, 8)}  ${r.ticket.title}  as ${holderLabel(identity.actor, identity.session)} until ${r.expires_at!.slice(11, 19)}Z` +
            ` (${fmtLeft(r.expires_at!)})${r.ticket.claim?.scope ? `; locks ${r.ticket.claim.scope.paths.join(', ')}` : ''}\n` +
            waitedLine(r.waited)
          : `nothing eligible (${r.considered} considered)\n`,
      );
      return 0;
    }
    case 'release': {
      const { store, identity, dataDir } = openAs(flags, projectOf(flags));
      const held = readCliClaims(dataDir);
      const mine = (id: string) => {
        const c = held[id];
        return c !== undefined && c.actor === identity.actor && c.session === identity.session;
      };
      let ids: string[];
      if (flags['all'] === true || flags['mine'] === true) ids = Object.keys(held).filter(mine);
      else {
        if (positional.length === 0) throw new SeaError('invalid_input', 'release needs ticket ids, or --all for every claim this identity took from the CLI');
        ids = positional.map((p) => store.get({ id: p }).ticket.id);
      }
      const force = flags['force'] === true;
      const results: { ticket_id: string; released: boolean; reason?: string }[] = [];
      for (const id of ids) {
        if (!force && !mine(id)) {
          throw new SeaError(
            'invalid_input',
            `no CLI claim token for ticket ${id.slice(0, 8)} held by "${holderLabel(identity.actor, identity.session)}"; only the holder can release ` +
              '(an operator can force: --force with --role operator)',
            { ticket_id: id, actor: identity.actor, session: identity.session },
          );
        }
        try {
          store.release(
            S.ReleaseInput.parse({
              ticket_id: id,
              ...(force ? { force: true } : { claim_token: held[id]!.token }),
              ...(str(flags['note']) !== undefined ? { note: str(flags['note']) } : {}),
              ...(str(flags['reason']) !== undefined ? { reason: str(flags['reason']) } : {}),
            }),
          );
          results.push({ ticket_id: id, released: true });
        } catch (e) {
          // A lapsed or rotated claim is not ours to release any more: forget the token, report it.
          if (e instanceof SeaError && /^fence_/.test(e.code)) results.push({ ticket_id: id, released: false, reason: e.code });
          else throw e;
        }
      }
      // Forget only the tokens this command used, re-read under the lock (another CLI may have added its own since).
      updateCliClaims(dataDir, (claims) => {
        for (const id of ids) if (claims[id]?.token === held[id]?.token) delete claims[id];
      });
      out(flags, { released: results }, () =>
        results.length === 0
          ? 'nothing to release\n'
          : results.map((r) => (r.released ? `released ${r.ticket_id.slice(0, 8)}\n` : `not released ${r.ticket_id.slice(0, 8)}: ${r.reason}\n`)).join(''),
      );
      return 0;
    }
    case 'board':
      return boardCmd(flags);
    case 'heartbeat': {
      if (flags['hook'] === true) return heartbeatHook(flags);
      const { store, identity } = openAs(flags, null, { sessionWide: true });
      const r = store.heartbeat();
      out(flags, { identity: { actor: identity.actor, session: identity.session, source: identity.source }, ...r }, () => {
        let s = `${holderLabel(identity.actor, identity.session)}: renewed ${r.renewed.length} claim(s)`;
        s += r.renewed.length > 0 ? `: ${r.renewed.map((x) => `${x.ticket_id.slice(0, 8)} until ${x.expires_at.slice(11, 19)}Z`).join(', ')}\n` : '\n';
        for (const l of r.lapsed) s += `lapsed: ${l.ticket_id.slice(0, 8)} "${l.title}" expired at ${l.expired_at}; claim it again if you are still on it\n`;
        return s;
      });
      return 0;
    }
    case 'whoami': {
      const dataDir = dataDirOf(flags);
      const identity = resolveIdentity({ dataDir, actor: str(flags['actor']), session: str(flags['session']) });
      const project = projectOf(flags);
      const j = {
        actor: identity.actor,
        session: identity.session,
        label: holderLabel(identity.actor, identity.session),
        source: identity.source,
        project,
        data_dir: dataDir,
        instance: identity.instance,
      };
      out(flags, j, () => `${j.label}  (session via ${j.source}; project ${project ?? '*'}; data dir ${dataDir})\n`);
      return 0;
    }
    case 'list': {
      const { store } = openAs(flags, projectOf(flags));
      const statusFlag = str(flags['status']);
      const status = statusFlag
        ? statusFlag.split(',').map((s) => {
            if (!(ALL_STATES as readonly string[]).includes(s)) throw new SeaError('invalid_input', `unknown status "${s}"`);
            return s as TicketStatus;
          })
        : undefined;
      const r = store.list(
        S.ListInput.parse({
          ...(status !== undefined ? { status } : {}),
          include_terminal: flags['all'] === true,
          limit: 200,
          ...(str(flags['query']) !== undefined ? { query: str(flags['query'])! } : {}),
        }),
      );
      out(flags, r, () => r.tickets.map((t) => fmtRow(t) + '\n').join('') + `${r.count} ticket(s); head seq ${r.head.seq}\n`);
      return 0;
    }
    case 'show': {
      const id = positional[0];
      if (!id) throw new SeaError('invalid_input', 'show requires a ticket id or prefix');
      const { store } = openAs(flags, null);
      const r = store.get({ id });
      out(flags, r, () => {
        const t = r.ticket;
        let s = `${t.id}\n${t.title}\n`;
        s += `status ${t.status}  priority ${t.priority}  kind ${t.kind}  v${t.row_version}  tags ${t.tags.join(',') || '-'}  project ${t.project ?? '-'}\n`;
        s += `assignee ${t.assignee ?? '-'}  claim ${t.claim ? `${holderLabel(t.claim.holder, t.claim.session)} until ${t.claim.expires_at} (${fmtLeft(t.claim.expires_at)})${t.claim.scope ? `; locks ${t.claim.scope.paths.join(', ')}` : ''}` : 'none'}\n`;
        s += `created ${t.created_at} by ${t.created_by}; updated ${t.updated_at}; seq ${t.created_seq}..${t.last_seq}\n`;
        if (t.body) s += `\n${t.body}\n`;
        if (r.links.length) {
          s += `\nlinks:\n`;
          for (const l of r.links) s += `  ${l.direction === 'out' ? '→' : '←'} ${l.link_type} ${l.peer.id.slice(0, 8)} ${l.peer.title} (${l.peer.status})\n`;
        }
        if (r.notes.length) {
          s += `\nnotes:\n`;
          for (const n of r.notes) s += `  [${n.created_at}] ${n.author}: ${n.body}\n`;
        }
        s += `\nlegal next: ${r.legal_next.join(', ') || '(terminal)'}\n`;
        return s;
      });
      return 0;
    }
    case 'rebuild': {
      const { store } = openAs(flags, null);
      process.stdout.write(JSON.stringify(store.rebuild(), null, 2) + '\n');
      return 0;
    }
    case 'verify': {
      const { store } = openAs(flags, null);
      const r = store.verify();
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      return r.ok ? 0 : 1;
    }
    case 'scope-check':
      return scopeCheckCmd(positional, flags);
    case 'precommit':
      return precommitCmd(flags);
    case 'release-worktree': {
      let raw = positional[0];
      if (raw === undefined && flags['hook'] === true) raw = worktreeFromHookInput(readFileSync(0, 'utf8'));
      if (raw === undefined) throw new SeaError('invalid_input', 'release-worktree needs a PATH (or --hook with the hook JSON on stdin)');
      // As given (made absolute) and, when it still exists, its realpath: a claim bound under either spelling is released.
      const abs = resolve(raw);
      const spellings = [abs];
      // An absolute path in another platform's form (a POSIX path given on Windows) is kept as given too.
      if (/^([A-Za-z]:[\\/]|[\\/])/.test(raw) && raw !== abs) spellings.push(raw);
      try {
        const real = realpathSync(abs);
        if (real !== abs) spellings.push(real);
      } catch {
        // already removed: the lexical path is all there is
      }
      const { store } = openAs(flags, null);
      const reason = str(flags['reason']);
      const r = store.releaseWorktree({ worktree: spellings, ...(reason !== undefined ? { reason } : {}) });
      out(flags, r, () => {
        let s = '';
        for (const x of r.released) s += `released ${x.ticket_id.slice(0, 8)} (held by ${x.holder})\n`;
        for (const x of r.expired) s += `expired  ${x.ticket_id.slice(0, 8)} (lease of ${x.holder} had lapsed)\n`;
        return s + `${r.released.length} claim(s) released for worktree ${r.worktree}\n`;
      });
      return 0;
    }
    case 'doctor': {
      const cwd = str(flags['cwd']);
      const actorsFile = str(flags['actors-file']);
      const r = await runDoctor({
        dataDir: dataDirOf(flags),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(actorsFile !== undefined ? { actorsFile } : {}),
      });
      process.stdout.write(flags['json'] === true ? JSON.stringify(r, null, 2) + '\n' : renderDoctor(r));
      return r.ok ? 0 : 1;
    }
    case 'stats': {
      const { store } = openAs(flags, null);
      const since = str(flags['since']);
      const forActor = str(flags['for']);
      const r = store.stats({ ...(since !== undefined ? { since } : {}), ...(forActor !== undefined ? { actor: forActor } : {}) });
      out(flags, r, () => formatStats(r));
      return 0;
    }
    case 'add-token': {
      const actor = str(flags['actor']);
      if (actor === undefined) throw new SeaError('invalid_input', 'add-token needs --actor ID');
      const role = str(flags['role']);
      const file = str(flags['actors-file']) ?? join(dataDirOf(flags), ACTORS_FILE_NAME);
      const r = addActorToken(file, actor, role !== undefined ? parseRole(role) : undefined);
      process.stderr.write(`token for "${actor}" added to ${r.file}${r.created ? ' (created, mode 0600)' : ''}; only its sha256 is stored, so copy it now:\n`);
      process.stdout.write(r.token + '\n');
      return 0;
    }
    case 'audit':
      return auditCmd(sub!, positional, flags);
    case 'lease': {
      const [name] = positional;
      if ((sub !== 'show' && sub !== 'release') || name === undefined) throw new SeaError('invalid_input', 'usage: sea-lite lease show NAME | lease release NAME --force (operator)');
      const { store } = openAs(flags, null);
      if (sub === 'show') {
        const r = store.leaseShow(name);
        out(flags, r, () => `${r.name}  epoch ${r.epoch}  ${r.live ? `held by ${r.holder} until ${r.expires_at}` : 'free'}  open ${r.open}  may_have_happened ${r.may_have_happened}\n`);
        return 0;
      }
      if (flags['force'] !== true) throw new SeaError('invalid_input', 'the CLI holds no lease tokens: lease release needs --force (operator role)');
      const r = store.leaseRelease({ name, force: true });
      out(flags, r, () => `released ${name} (epoch ${r.epoch}); ${r.may_have_happened} intent(s) now may_have_happened\n`);
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

// ───────────────────────────── serve ─────────────────────────────

/** `--core`, `--profile core|full`, or SEA_LITE_PROFILE; default full. */
function profileOf(flags: Args['flags']): Profile {
  if (flags['core'] === true) return 'core';
  const p = str(flags['profile']) ?? (process.env['SEA_LITE_PROFILE'] || undefined) ?? 'full';
  if (!(PROFILES as readonly string[]).includes(p)) throw new SeaError('invalid_input', `--profile must be ${PROFILES.join(' or ')}, got "${p}"`);
  return p as Profile;
}

async function serveCmd(flags: Args['flags']): Promise<number> {
  const dataDir = dataDirOf(flags);
  const profile = profileOf(flags);
  const role = str(flags['role']);
  const tracks = str(flags['tracks']);
  const actor = str(flags['actor']) ?? (process.env['SEA_LITE_ACTOR'] || undefined) ?? DEFAULT_ACTOR;
  const common = {
    dataDir,
    actor,
    ...(role !== undefined ? { role: parseRole(role) } : {}),
    ...(tracks !== undefined ? { tracks: parseTracks(tracks) } : {}),
  };
  if (flags['http']) {
    // A team server answers many clients on many machines: no server-wide
    // session, and every project unless one is named (paths are only
    // comparable within one repository, so run one server per repository or
    // name it with --project).
    const explicit = str(flags['project']) ?? (process.env['SEA_LITE_PROJECT'] || undefined);
    const store = new SeaLite({ ...common, session: null, project: explicit !== undefined ? resolveProject(explicit) : null });
    return serveHttpCmd(store, flags);
  }
  const claudeSession = process.env['CLAUDE_CODE_SESSION_ID'] && process.env['CLAUDE_CODE_SESSION_ID'] !== '' ? process.env['CLAUDE_CODE_SESSION_ID'] : null;
  const session = str(flags['session']) ?? sessionKeyFromEnv() ?? newInstanceSession();
  const project = resolveProject(str(flags['project']));
  // Scope paths are resolved through symlinks against the repository the agent works in.
  const projectDir = process.env['CLAUDE_PROJECT_DIR'] && process.env['CLAUDE_PROJECT_DIR'] !== '' ? process.env['CLAUDE_PROJECT_DIR'] : process.cwd();
  const store = new SeaLite({ ...common, session, project, root: findRepo(projectDir)?.root ?? null });
  const reg = registerInstance(store.kronicle.dataDir ?? dataDir, { actor, session, claude_session: claudeSession, project });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => {
      reg.unregister();
      process.exit(0);
    });
  }
  process.stderr.write(
    `sea-lite ${VERSION} serving on stdio as ${holderLabel(actor, session)}; project ${project ?? '*'}; data dir ${store.kronicle.dataDir}; ` +
      `role ${store.role}; tracks ${store.lifecycle.tracks.join(',')}; tools ${profile}\n`,
  );
  // serveStdio owns the era decision for the connection: a 2026-07-28
  // client (per-request _meta) and a 2025 client (initialize handshake)
  // are both served from the same factory. The store is shared; each
  // pinned instance is a fresh McpServer over it.
  // P2-05 / F11: an over-limit stdin line is answered with a JSON-RPC error instead of closing the server.
  const guard = new StdioLineGuard(
    (line) => process.stdout.write(line),
    (msg) => process.stderr.write(msg + '\n'),
  );
  process.stdin.pipe(guard);
  const transport = new StdioServerTransport(guard, process.stdout, { maxBufferSize: MAX_STDIO_LINE_BYTES + 1024 * 1024 });
  const handle = serveStdio(() => createServer(store, { version: VERSION, profile }), {
    transport,
    onerror: (err) => process.stderr.write(`sea-lite: ${err.message}\n`),
  });
  await new Promise<void>((resolve) => {
    process.stdin.once('end', () => resolve());
    process.stdin.once('close', () => resolve());
  });
  await handle.close();
  reg.unregister();
  store.close();
  return 0;
}

// ───────────────────────────── board ─────────────────────────────

function boardCmd(flags: Args['flags']): number {
  const project = projectOf(flags);
  const { store, dataDir } = openAs(flags, project);
  const all = flags['all'] === true;
  const r = store.list(S.ListInput.parse({ include_terminal: all, limit: 200, view: 'compact', ...(project === null ? { project: '*' } : {}) }));
  // SL-5: the header counts by status, not the rows shown (`--all` lists closed tickets too; 0.6 called them all "open").
  const counts = store.statusCounts(project === null ? '*' : undefined);
  const now = Date.now();
  const tickets = (r.tickets as TicketCompact[]).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    kind: t.kind,
    project: t.project,
    claim: t.claim
      ? {
          holder: t.claim.holder,
          session: t.claim.session,
          holder_label: holderLabel(t.claim.holder, t.claim.session),
          scope: t.claim.scope?.paths ?? null,
          worktree: t.claim.worktree,
          expires_at: t.claim.expires_at,
          expires_in_seconds: Math.max(0, Math.round((Date.parse(t.claim.expires_at) - now) / 1000)),
        }
      : null,
  }));
  const sessions = listInstances(dataDir).filter((e) => project === null || e.project === null || e.project === project);
  const json = {
    project,
    now: new Date(now).toISOString(),
    counts,
    tickets,
    sessions: sessions.map((e) => ({ label: holderLabel(e.actor, e.session), actor: e.actor, session: e.session, pid: e.pid, project: e.project, started_at: e.started_at })),
    head: r.head,
  };
  out(flags, json, () => {
    const shown = tickets.length < (all ? counts.open + counts.closed : counts.open) ? ` (showing ${tickets.length})` : '';
    const tally = all ? `${counts.open} open, ${counts.closed} closed ticket(s)` : `${counts.open} open ticket(s)`;
    let s = `sea-lite board — project ${project ?? '* (all)'}; ${tally}${shown}; ${new Date(now).toISOString().slice(11, 19)}Z\n`;
    if (tickets.length > 0) {
      const rows = [['ID', 'STATUS', 'PRI', 'TITLE', 'HOLDER', 'LOCKS', 'LEASE']];
      for (const t of tickets) {
        rows.push([
          t.id.slice(0, 8),
          t.status,
          t.priority,
          trunc(t.title, 44),
          t.claim ? t.claim.holder_label : '-',
          t.claim ? trunc(t.claim.scope?.join(', ') ?? (t.claim.worktree ? `worktree ${t.claim.worktree}` : '(no scope)'), 32) : '-',
          t.claim ? fmtLeft(t.claim.expires_at, now) : '-',
        ]);
      }
      s += table(rows);
    } else {
      s += '(no open tickets — `sea-lite create "title" --triaged` adds one)\n';
    }
    // SL-7: the end-of-queue summary (what an audit closes with), without `list --json | jq`.
    if (all && counts.open + counts.closed > 0) {
      s += `by status: ${Object.entries(counts.by_status).map(([k, n]) => `${k} ${n}`).join(', ')}\n`;
    }
    if (sessions.length > 0) {
      s += `live sea-lite servers: ${sessions.map((e) => `${holderLabel(e.actor, e.session)} (pid ${e.pid})`).join(', ')}\n`;
    }
    return s;
  });
  return 0;
}

// ───────────────────────────── scope-check / precommit ─────────────────────────────

const SCOPE_CHECK_SCHEMA = 'sea-lite.scope-check/1';

/** A Claude Code hook payload (PreToolUse / PostToolUse), as far as we read it. */
interface HookPayload {
  session_id?: unknown;
  cwd?: unknown;
  tool_input?: { file_path?: unknown; notebook_path?: unknown } | null;
}

function readHookPayload(): HookPayload {
  let text = '';
  try {
    text = readFileSync(0, 'utf8');
  } catch {
    return {};
  }
  try {
    const j = JSON.parse(text) as unknown;
    return j !== null && typeof j === 'object' ? (j as HookPayload) : {};
  } catch {
    return {};
  }
}

/**
 * `scope-check --hook`: a complete Claude Code PreToolUse hook. Reads the
 * hook JSON on stdin (tool_input.file_path / notebook_path, session_id),
 * answers with Claude Code's exit-code protocol: 0 lets the edit through, 2
 * blocks it with the reason on stderr. A path outside any repository, or a
 * tool call without a file, is let through. Any other failure blocks unless
 * SEA_LITE_HOOK_FAIL_OPEN=1.
 */
function scopeCheckHook(flags: Args['flags']): number {
  const p = readHookPayload();
  const file = [p.tool_input?.file_path, p.tool_input?.notebook_path].find((f): f is string => typeof f === 'string' && f !== '');
  if (file === undefined) return 0;
  const cwd = typeof p.cwd === 'string' && p.cwd !== '' ? p.cwd : process.cwd();
  const abs = isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) ? file : resolve(cwd, file);
  const hookFlags: Args['flags'] = { ...flags };
  if (str(flags['session']) === undefined && typeof p.session_id === 'string' && p.session_id !== '') hookFlags['session'] = p.session_id;
  try {
    const rel = repoRelative([abs], hookFlags);
    const { store, identity } = openAs(hookFlags, rel.project, { sessionWide: true, root: rel.root });
    const r = store.scopeCheck({ paths: rel.paths });
    if (r.ok) return 0;
    process.stderr.write(
      `sea-lite: ${rel.paths[0]} is inside someone else's live claim (you are ${holderLabel(identity.actor, identity.session)}):\n` +
        r.conflicts.map((c) => fmtConflict(c) + '\n').join('') +
        'Claim the path (sea_claim / sea_next with scope.paths), wait for the lease to lapse, or take other work.\n',
    );
    return 2;
  } catch (e) {
    if (e instanceof SeaError && e.details['reason'] === 'outside_repo') return 0;
    const msg = e instanceof Error ? e.message : String(e);
    if (process.env['SEA_LITE_HOOK_FAIL_OPEN'] === '1') {
      process.stderr.write(`sea-lite scope-check unavailable (${msg}); allowing the edit\n`);
      return 0;
    }
    process.stderr.write(`sea-lite scope-check failed: ${msg} (set SEA_LITE_HOOK_FAIL_OPEN=1 to allow edits when sea-lite is broken)\n`);
    return 2;
  }
}

/**
 * `heartbeat --hook`: for a PostToolUse hook (run it `async`). Renews the
 * session's live claims, at most once per --min-interval seconds (default 60;
 * a stamp file per session under <data dir>/sessions/), and never fails the
 * tool call: exit 0 always.
 */
function heartbeatHook(flags: Args['flags']): number {
  try {
    const p = readHookPayload();
    const hookFlags: Args['flags'] = { ...flags };
    if (str(flags['session']) === undefined && typeof p.session_id === 'string' && p.session_id !== '') hookFlags['session'] = p.session_id;
    const dataDir = dataDirOf(hookFlags);
    const key = str(hookFlags['session']) ?? sessionKeyFromEnv() ?? '';
    const minInterval = num(flags['min-interval'], 'min-interval') ?? 60;
    const stamp = join(dataDir, SESSIONS_DIR, `hb-${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}.stamp`);
    try {
      if (Date.now() - statSync(stamp).mtimeMs < minInterval * 1000) return 0;
    } catch {
      // no stamp yet
    }
    const { store } = openAs(hookFlags, null, { sessionWide: true });
    const r = store.heartbeat();
    mkdirSync(dirname(stamp), { recursive: true });
    writeFileSync(stamp, new Date().toISOString() + '\n', { mode: 0o600 });
    for (const l of r.lapsed) process.stderr.write(`sea-lite: your claim on ${l.ticket_id.slice(0, 8)} ("${l.title}") lapsed at ${l.expired_at}; claim it again if you are still on it\n`);
  } catch {
    // a heartbeat must never fail the tool call it follows
  }
  return 0;
}

function scopeCheckCmd(positional: string[], flags: Args['flags']): number {
  if (flags['hook'] === true) return scopeCheckHook(flags);
  const json = flags['json'] === true;
  try {
    const fromFlag = str(flags['paths']);
    const raw = [...(fromFlag ? fromFlag.split(',') : []), ...positional].map((p) => p.trim()).filter((p) => p.length > 0);
    if (raw.length === 0) throw new SeaError('invalid_input', 'scope-check needs --paths a,b or positional paths');
    const rel = repoRelative(raw, flags);
    const { store, identity } = openAs(flags, rel.project, { sessionWide: true, root: rel.root });
    const r = store.scopeCheck({ paths: rel.paths });
    const result = {
      schema: SCOPE_CHECK_SCHEMA,
      ok: r.ok,
      paths: r.paths,
      project: rel.project,
      identity: { actor: identity.actor, session: identity.session, label: holderLabel(identity.actor, identity.session), source: identity.source },
      conflicts: r.conflicts,
      swept_expired: r.swept_expired,
      head: r.head,
    };
    if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else if (r.ok) process.stdout.write(`ok: ${r.paths.join(', ')} overlap no live claim of anyone else (you are ${result.identity.label})\n`);
    else for (const c of r.conflicts) process.stdout.write(fmtConflict(c) + '\n');
    return r.ok ? 0 : 1;
  } catch (e) {
    if (json && e instanceof SeaError) {
      process.stdout.write(JSON.stringify({ schema: SCOPE_CHECK_SCHEMA, ok: false, ...e.toJSON() }, null, 2) + '\n');
      return 2;
    }
    throw e;
  }
}

const PRECOMMIT_MARK = 'sea-lite precommit';

function git(args: string[], cwd = process.cwd()): { code: number; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw new SeaError('invalid_input', `git is not available: ${r.error.message}`);
  return { code: r.status ?? 2, out: (r.stdout ?? '') + (r.status === 0 ? '' : (r.stderr ?? '')) };
}

function precommitCmd(flags: Args['flags']): number {
  const repo = findRepo(process.cwd());
  if (repo === null) throw new SeaError('invalid_input', 'precommit must run inside a git repository');
  if (flags['install'] === true) {
    const hp = git(['rev-parse', '--git-path', 'hooks/pre-commit'], repo.root);
    if (hp.code !== 0) throw new SeaError('invalid_input', `cannot locate the hooks directory: ${hp.out.trim()}`);
    const file = resolve(repo.root, hp.out.trim());
    if (existsSync(file) && !readFileSync(file, 'utf8').includes(PRECOMMIT_MARK)) {
      throw new SeaError('invalid_input', `${file} already exists and is not sea-lite's; add \`${PRECOMMIT_MARK}\` to it yourself`, { file });
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `#!/bin/sh\n# ${PRECOMMIT_MARK}: refuse committing files inside another agent's live sea-lite claim.\n` +
        `# Bypass once with: git commit --no-verify\n` +
        `if command -v sea-lite >/dev/null 2>&1; then exec sea-lite precommit; fi\n` +
        `exec npx -y sea-lite@${VERSION} precommit\n`,
      { mode: 0o755 },
    );
    chmodSync(file, 0o755);
    process.stdout.write(`installed ${file}\n`);
    return 0;
  }
  const staged = git(['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=ACDMRT'], repo.root);
  if (staged.code !== 0) throw new SeaError('invalid_input', `git diff --cached failed: ${staged.out.trim()}`);
  const files = staged.out.split('\0').filter((f) => f.length > 0 && !f.startsWith('!'));
  if (files.length === 0) return 0;
  const project = str(flags['project']) !== undefined ? resolveProject(str(flags['project'])) : projectKeyFor(repo.root);
  const { store, identity } = openAs(flags, project, { sessionWide: true, root: repo.root });
  const conflicts = new Map<string, ScopeConflict[]>();
  for (let i = 0; i < files.length; i += MAX_SCOPE_PATHS) {
    const chunk = files.slice(i, i + MAX_SCOPE_PATHS);
    for (const f of chunk) {
      const r = store.scopeCheck({ paths: [f] });
      if (!r.ok) conflicts.set(f, r.conflicts);
    }
  }
  if (conflicts.size === 0) return 0;
  let msg = `sea-lite: commit refused — ${conflicts.size} staged file(s) lie inside someone else's live claim (you are ${holderLabel(identity.actor, identity.session)}):\n`;
  for (const [f, cs] of conflicts) {
    for (const c of cs) msg += `  ${f}: "${c.holder_label}" holds ${c.held.join(', ')} on ticket ${c.ticket_id.slice(0, 8)} ("${c.title}") until ${c.claim_expires_at} (${fmtLeft(c.claim_expires_at)})\n`;
  }
  msg += `Unstage those files, wait for the claim to be released or lapse, or coordinate with the holder (sea-lite board).\nBypass once: git commit --no-verify\n`;
  process.stderr.write(msg);
  return 1;
}

// ───────────────────────────── helpers ─────────────────────────────

/** The worktree path from a hook's JSON input (`worktree_path`, or `path`). */
function worktreeFromHookInput(text: string): string | undefined {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new SeaError('invalid_input', 'release-worktree --hook: stdin is not JSON');
  }
  const o = (j ?? {}) as Record<string, unknown>;
  for (const k of ['worktree_path', 'worktreePath', 'path']) if (typeof o[k] === 'string' && o[k] !== '') return o[k];
  throw new SeaError('invalid_input', 'release-worktree --hook: no worktree_path in the hook input');
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
}

function formatStats(r: StatsResult): string {
  const cols = ['actor', 'taken', 'rotated', 'released', 'on_term', 'expired', 'forced', 'held', 'live', 'transitions', 'created'] as const;
  const row = (a: Omit<ActorStats, 'actor'> & { actor: string }): string[] => [
    a.actor,
    String(a.claims_taken),
    String(a.claims_rotated),
    String(a.released),
    String(a.released_on_transition),
    String(a.expired),
    String(a.force_released),
    fmtDuration(a.lease_seconds),
    String(a.live_claims),
    String(a.transitions),
    String(a.tickets_created),
  ];
  const rows = [[...cols], ...r.actors.map(row), row({ actor: 'total', ...r.totals })];
  const widths = cols.map((_, i) => Math.max(...rows.map((x) => x[i]!.length)));
  const lines = rows.map((x) => x.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  '));
  return (
    `window ${r.since ?? 'all time'} → ${r.until}; ${r.events_scanned} event(s); head seq ${r.head.seq}\n` +
    lines.join('\n') +
    '\n(scope_conflict refusals are not chained and are not counted)\n'
  );
}

async function serveHttpCmd(store: SeaLite, flags: Args['flags']): Promise<number> {
  const dataDir = store.kronicle.dataDir ?? dataDirOf(flags);
  let bearer: string;
  let bearerNote: string;
  const tokenFileOpts = { allowInsecure: flags['allow-insecure-token-file'] === true };
  if (str(flags['bearer']) !== undefined) {
    bearer = str(flags['bearer'])!;
    bearerNote = 'bearer from --bearer';
  } else if (str(flags['bearer-file']) !== undefined) {
    bearer = readBearerFile(str(flags['bearer-file'])!);
    const warning = checkTokenFileMode(str(flags['bearer-file'])!, tokenFileOpts);
    if (warning !== null) process.stderr.write(`sea-lite: ${warning}\n`);
    bearerNote = `bearer from ${str(flags['bearer-file'])}`;
  } else {
    const b = loadOrCreateBearer(dataDir, tokenFileOpts);
    if (b.warning !== null) process.stderr.write(`sea-lite: ${b.warning}\n`);
    bearer = b.token;
    bearerNote = `bearer from ${b.file}${b.created ? ' (created, mode 0600)' : ''}`;
  }
  const explicitActors = str(flags['actors-file']);
  const actorsFile = explicitActors ?? join(dataDir, ACTORS_FILE_NAME);
  let actors: ActorToken[] = [];
  if (explicitActors !== undefined || existsSync(actorsFile)) {
    actors = readActorsFile(actorsFile);
    bearerNote += `; ${actors.length} actor token(s) from ${actorsFile}`;
  }
  bearerNote += ' (re-read on change)';
  const allowedOrigins = list(flags['allow-origin']);
  const allowedHosts = list(flags['allow-host']);
  const port = num(flags['port'], 'port');
  const legacyFlag = str(flags['legacy']);
  if (legacyFlag !== undefined && legacyFlag !== 'stateless' && legacyFlag !== 'reject') {
    throw new SeaError('invalid_input', `--legacy must be stateless or reject, got "${legacyFlag}"`);
  }
  const handle = await serveHttp({
    store,
    bearer,
    actors,
    actorsFile,
    version: VERSION,
    ...(legacyFlag !== undefined ? { legacy: legacyFlag } : {}),
    profile: profileOf(flags),
    ...(str(flags['host']) !== undefined ? { host: str(flags['host'])! } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    onerror: (err) => process.stderr.write(`http: ${err.message}\n`),
  });
  process.stderr.write(
    `sea-lite ${VERSION} serving Streamable HTTP at ${handle.url}; protocol 2026-07-28${legacyFlag === 'reject' ? ' only' : ' + 2025-era clients'}; ${bearerNote}; ` +
      `data dir ${dataDir}; default actor ${store.actor}; role ${store.role}; project ${store.project ?? '*'}\n`,
  );
  await new Promise<void>((resolve) => {
    const stop = () => {
      handle.close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  store.close();
  return 0;
}

/** `sea-lite audit …`: the human side of an audit (review queue, export) and the runner's CSV import. */
function auditCmd(sub: string, positional: string[], flags: Args['flags']): number {
  const [audit, ...rest] = positional;
  if (audit === undefined) throw new SeaError('invalid_input', 'usage: sea-lite audit queue|review|export|import AUDIT_ID …');
  const { store } = openAs(flags, null);
  switch (sub) {
    case 'queue': {
      const r = store.auditReviewQueue(audit);
      out(flags, r, () =>
        r.items.length === 0
          ? 'review queue empty\n'
          : table([['ID', 'VERDICT', 'SEV', 'PLAN', 'TITLE'], ...r.items.map((i) => [i.finding_id, i.verdict ?? '', i.severity ?? '', i.submit_plan ?? '', trunc(i.title, 70)])]),
      );
      return 0;
    }
    case 'review': {
      const [finding_id, decision] = rest;
      if (finding_id === undefined || (decision !== 'approved' && decision !== 'rejected' && decision !== 'hold')) {
        throw new SeaError('invalid_input', 'usage: sea-lite audit review AUDIT_ID FINDING_ID approved|rejected|hold [--plan P] [--note N]');
      }
      const plan = str(flags['plan']);
      const note = str(flags['note']);
      const r = store.auditReview(audit, { finding_id, decision, ...(plan !== undefined ? { submit_plan: plan } : {}), ...(note !== undefined ? { note } : {}) });
      out(flags, r, () => `${finding_id}: ${decision} (fields v${r.version}; changed ${r.changed.join(', ') || 'nothing'})\n`);
      return 0;
    }
    case 'export': {
      const format = str(flags['format']) ?? 'csv';
      if (format !== 'csv' && format !== 'xlsx') throw new SeaError('invalid_input', '--format csv|xlsx');
      const file = str(flags['out']);
      const data = store.auditExport(audit, format);
      if (file === undefined) {
        if (format === 'xlsx') throw new SeaError('invalid_input', 'xlsx needs --out FILE');
        process.stdout.write(data);
        return 0;
      }
      writePrivateFile(file, data); // 0600, O_EXCL temp + rename: never written through a plant (audit/export.ts)
      process.stderr.write(`wrote ${file} (${store.auditRows(audit).length} findings)\n`);
      return 0;
    }
    case 'import': {
      const file = rest[0];
      if (file === undefined) throw new SeaError('invalid_input', 'usage: sea-lite audit import AUDIT_ID FILE.csv (- = stdin)');
      const r = store.auditImport(audit, readFileSync(file === '-' ? 0 : file, 'utf8'), { trusted: flags['trusted'] === true });
      out(flags, r, () => `created ${r.created}, updated ${r.updated}, unchanged ${r.unchanged}; ${r.queued} entered the review queue\n`);
      return 0;
    }
    default:
      throw new SeaError('invalid_input', `unknown audit subcommand: ${sub}`);
  }
}

/** Codes that mean "someone else holds it" rather than "you asked wrong". */
const CONFLICT_CODES = new Set(['scope_conflict', 'already_claimed', 'fence_invalid', 'fence_foreign_holder', 'fence_expired', 'version_conflict', 'wait_timeout']);

main(process.argv.slice(2)).then(
  (code) => {
    closeAll();
    process.exitCode = code;
  },
  (err: unknown) => {
    closeAll();
    if (err instanceof SeaError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      process.exitCode = CONFLICT_CODES.has(err.code) ? 1 : 2;
    } else if (err instanceof Error && err.name === 'ZodError') {
      // SL-6: one readable line per issue, not the raw issue array.
      process.stderr.write(`invalid_input: ${formatZodError(err as unknown as Parameters<typeof formatZodError>[0])}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 2;
    }
  },
);
