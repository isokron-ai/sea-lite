/**
 * Who is calling: actor + session (0.4.0).
 *
 * An **actor** is a human-readable label (`claude`, `agent-a`, `alice`). It is
 * self-asserted on stdio and on the CLI: anything can claim to be anyone.
 * Only a per-actor HTTP token (`serve --http` + `add-token`) authenticates
 * one. See docs/THREAT-MODEL.md.
 *
 * A **session** tells apart two processes that use the same label. Before
 * 0.4.0 every Claude Code terminal ran as the same actor (`--actor claude`,
 * or the default `local-agent`), and because a holder's own scopes never
 * conflict, two sessions could lock the same paths without noticing. A claim
 * now records the holder's session, and a claim belongs to the caller only
 * when actor AND session are equal.
 *
 * Where the session comes from:
 *   - `sea-lite serve` (stdio): `--session`, else SEA_LITE_SESSION, else
 *     CLAUDE_CODE_SESSION_ID (Claude Code sets it in stdio MCP server
 *     subprocesses: the ID the server was spawned with), else a random
 *     per-process instance id `inst-<8 hex>`. The server registers itself in
 *     `<data dir>/sessions/` so hooks and the CLI can find it.
 *   - hooks and the CLI resolve the session of the agent they act for:
 *       1. the key they are given (`--session`, else SEA_LITE_SESSION, else
 *          CLAUDE_CODE_SESSION_ID, which Claude Code sets for hooks and Bash
 *          and which equals the hook input's `session_id`) when it names a
 *          live registered server;
 *       2. else the live registered server that descends from the same Claude
 *          Code process (CLAUDE_PID, set for hooks and Bash): after `/clear`
 *          the hook's session id changes but the MCP server keeps the one it
 *          was spawned with, and this is how the two are re-joined;
 *       3. else the key itself (unregistered), else none.
 *
 * Nothing here touches the chain's hashing: the session is an additive field
 * on `sea_ticket.claimed` payloads (present only when known) and a column on
 * the projection.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';

export interface Owner {
  actor: string;
  session: string | null;
}

/** A per-process instance id for a server that was given no session. */
export function newInstanceSession(): string {
  return 'inst-' + randomBytes(4).toString('hex');
}

/** First 8 alphanumerics of a session, for display (`claude#725eab64`). */
export function shortSession(session: string): string {
  const s = session.replace(/^inst-/, '').replace(/[^A-Za-z0-9]/g, '');
  return (s.length > 0 ? s : session).slice(0, 8);
}

/** `actor#session8`, or the bare actor when the session is unknown. */
export function holderLabel(actor: string, session: string | null | undefined): string {
  return session ? `${actor}#${shortSession(session)}` : actor;
}

/** True when the claim row's holder is `who` (actor and session equal; a null session equals only null). */
export function sameOwner(holderActor: string | null, holderSession: string | null, who: Owner): boolean {
  return holderActor === who.actor && (holderSession ?? null) === (who.session ?? null);
}

/** The session key in the environment: SEA_LITE_SESSION, else CLAUDE_CODE_SESSION_ID. */
export function sessionKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const k of ['SEA_LITE_SESSION', 'CLAUDE_CODE_SESSION_ID']) {
    const v = env[k];
    if (v !== undefined && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/** Default actor for a human at a terminal: SEA_LITE_ACTOR, else the OS user name. */
export function humanActor(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['SEA_LITE_ACTOR'];
  if (v !== undefined && v.trim() !== '') return v.trim();
  try {
    const u = userInfo().username;
    if (u) return u;
  } catch {
    // no passwd entry (containers)
  }
  return env['USER'] ?? env['USERNAME'] ?? 'human';
}

// ───────────────────────────── processes ─────────────────────────────

/** True when a process with this pid exists (EPERM counts: it exists, we just may not signal it). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parentOf(pid: number): number | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 4, after the parenthesised comm (which may itself contain spaces or parens).
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(rest[1]);
      return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    const ppid = Number(out.trim());
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

/** Ancestor pids of `pid`, nearest first, stopping before pid 1 (at most `max`). Empty on Windows. */
export function ancestors(pid: number = process.pid, max = 16): number[] {
  const out: number[] = [];
  let cur: number | null = pid === process.pid ? process.ppid : parentOf(pid);
  while (cur !== null && cur > 1 && out.length < max && !out.includes(cur)) {
    out.push(cur);
    cur = parentOf(cur);
  }
  return out;
}

// ───────────────────────────── registry ─────────────────────────────

export interface InstanceEntry {
  v: 1;
  actor: string;
  session: string;
  /** CLAUDE_CODE_SESSION_ID the server was spawned with, when any (equals `session` unless --session overrode it). */
  claude_session: string | null;
  pid: number;
  /** Ancestor pids at registration, nearest first: the Claude Code process is one of them. */
  ancestors: number[];
  host: string;
  project: string | null;
  started_at: string;
}

export const SESSIONS_DIR = 'sessions';

function entryFile(dataDir: string, session: string, pid: number): string {
  const h = createHash('sha256').update(session, 'utf8').digest('hex').slice(0, 16);
  return join(dataDir, SESSIONS_DIR, `${h}-${pid}.json`);
}

/**
 * Record a running server so hooks and the CLI of the same Claude Code
 * session can find its identity. Returns a function that removes the entry
 * (also attempted on process exit). Best effort: a read-only data dir only
 * loses the handshake, never the server.
 */
export function registerInstance(
  dataDir: string,
  e: { actor: string; session: string; claude_session: string | null; project: string | null },
): { file: string | null; unregister: () => void } {
  const entry: InstanceEntry = {
    v: 1,
    actor: e.actor,
    session: e.session,
    claude_session: e.claude_session,
    pid: process.pid,
    ancestors: ancestors(),
    host: hostname(),
    project: e.project,
    started_at: new Date().toISOString(),
  };
  const file = entryFile(dataDir, e.session, process.pid);
  try {
    mkdirSync(join(dataDir, SESSIONS_DIR), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    return { file: null, unregister: () => {} };
  }
  let done = false;
  const unregister = (): void => {
    if (done) return;
    done = true;
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  };
  process.once('exit', unregister);
  return { file, unregister };
}

/** Live registered servers on this host (dead entries are pruned as a side effect). */
export function listInstances(dataDir: string): InstanceEntry[] {
  const dir = join(dataDir, SESSIONS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const host = hostname();
  const out: InstanceEntry[] = [];
  for (const n of names) {
    const f = join(dir, n);
    let e: InstanceEntry;
    try {
      e = JSON.parse(readFileSync(f, 'utf8')) as InstanceEntry;
    } catch {
      continue;
    }
    if (e.v !== 1 || typeof e.session !== 'string' || typeof e.actor !== 'string') continue;
    if (e.host !== host) continue;
    if (!pidAlive(e.pid)) {
      try {
        unlinkSync(f);
      } catch {
        // raced with another pruner
      }
      continue;
    }
    out.push(e);
  }
  return out.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export type IdentitySource = 'flag' | 'registry:key' | 'registry:claude_pid' | 'key' | 'env' | 'default';

export interface ResolvedIdentity extends Owner {
  /** How the session was found. */
  source: IdentitySource;
  /** The registered server the identity came from, when any. */
  instance: InstanceEntry | null;
}

/**
 * The identity a hook or a CLI command acts as (see the module comment).
 * `actor` given explicitly always wins for the actor; the session comes from
 * the registry when the key or CLAUDE_PID finds a live server.
 */
export function resolveIdentity(opts: {
  dataDir: string;
  actor?: string | undefined;
  session?: string | undefined;
  env?: NodeJS.ProcessEnv;
  defaultActor?: string;
}): ResolvedIdentity {
  const env = opts.env ?? process.env;
  const key = opts.session !== undefined && opts.session !== '' ? opts.session : sessionKeyFromEnv(env);
  const fallbackActor = opts.actor ?? (env['SEA_LITE_ACTOR'] && env['SEA_LITE_ACTOR'] !== '' ? env['SEA_LITE_ACTOR'] : (opts.defaultActor ?? humanActor(env)));
  const live = listInstances(opts.dataDir);
  if (key !== undefined) {
    const hit = live.find((e) => e.session === key || e.claude_session === key);
    if (hit) return { actor: opts.actor ?? hit.actor, session: hit.session, source: 'registry:key', instance: hit };
  }
  const claudePid = Number(env['CLAUDE_PID']);
  if (Number.isInteger(claudePid) && claudePid > 1) {
    const under = live.filter((e) => e.ancestors.includes(claudePid));
    // Every server under one Claude Code process is the same session; if they disagree, do not guess.
    const sessions = new Set(under.map((e) => `${e.actor}\u0000${e.session}`));
    if (under.length > 0 && sessions.size === 1) {
      const hit = under[0]!;
      return { actor: opts.actor ?? hit.actor, session: hit.session, source: 'registry:claude_pid', instance: hit };
    }
  }
  if (key !== undefined) return { actor: fallbackActor, session: key, source: opts.session ? 'flag' : 'key', instance: null };
  return { actor: fallbackActor, session: null, source: opts.actor !== undefined ? 'flag' : env['SEA_LITE_ACTOR'] ? 'env' : 'default', instance: null };
}
