/**
 * An exclusive lock file for the short read-modify-writes of the small JSON
 * files that CLI processes share (`cli-claims.json`, `http-actors.json`).
 *
 * C2-02 (0.6.1) took the lock with `open(O_CREAT|O_EXCL)` and took over any
 * lock older than 30 s by its mtime alone. The 0.7.0 review showed what that
 * costs: a holder paused for over 30 s (SIGSTOP, a debugger, a suspended
 * laptop) lost its lock, then wrote its stale copy over the newer holder's
 * file, and that holder's token was gone (`release` exited 2). A lock dated
 * in the future (clock skew) was never stale, so every command waited 30 s
 * and failed. Now:
 *
 * - **The lock names its owner**: `{ pid, host, nonce, at }`, written right
 *   after the exclusive create.
 * - **Takeover goes by the owner, not the age.** Same host: the lock is taken
 *   over when its pid is gone (at once, however young), never while the owner
 *   is alive (paused or slow) unless it has held it for `LOCK_HUNG_MS` (a
 *   reused pid, a hung process). No owner to check (a lock from sea-lite
 *   ≤ 0.6, an empty or foreign file) or another host: by age, as before. A
 *   lock dated in the future is stale-suspect: its age is how long this
 *   waiter has watched it unchanged, and it is taken over after
 *   `FUTURE_GRACE_MS`.
 * - **The write is fenced.** Right before the rename that publishes a new
 *   file, the holder re-reads the lock and checks its nonce
 *   (`assertLockOwned`); a holder whose lock was taken over gets `lock_lost`
 *   and writes nothing, and `updateLocked` redoes the read-modify-write under
 *   a fresh lock.
 * - **Release removes only its own lock**, and a takeover renames the stale
 *   lock aside and checks it moved the lock it judged (a fresh one moved by
 *   mistake is linked back).
 *
 * What is left: the re-read and the rename are two steps, so a holder paused
 * exactly between them, whose lock is then taken over, can still land one
 * stale write. With the liveness check that needs another host on a shared
 * file system, a reused pid, or a pause over `LOCK_HUNG_MS`.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';

import { SeaError } from './errors.js';

/** A lock with no owner to check (sea-lite ≤ 0.6, another host) older than this is a crashed holder's. */
export const LOCK_STALE_MS = 30_000;
/** How long to wait for a live holder. */
export const LOCK_WAIT_MS = 30_000;
/** A live owner holding the lock this long is taken to be a reused pid or a hung process. */
export const LOCK_HUNG_MS = 5 * 60_000;
/** An mtime this far ahead of our clock is "in the future"... */
export const FUTURE_TOLERANCE_MS = 2_000;
/** ...and such a lock, unchanged for this long while we watch it, is stale. */
export const FUTURE_GRACE_MS = 5_000;
/** How long a rename keeps retrying a transient sharing violation. */
const RENAME_RETRY_MS = 5_000;
/** How many times `updateLocked` redoes a read-modify-write whose lock was taken over. */
const LOST_RETRIES = 5;

/** Codes Windows returns while another process has the file open or it is delete-pending. */
export const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

export interface LockOptions {
  waitMs?: number;
  staleMs?: number;
  hungMs?: number;
  futureGraceMs?: number;
}

export interface LockOwner {
  pid: number;
  host: string;
  nonce: string;
  at: string;
}

/** Counters for tests and diagnostics: how often this process waited for, took over or lost a lock. */
export const lockCounters = { waits: 0, takeovers: 0, lost: 0, retries: 0 };

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

/** Locks this process holds, by absolute path. */
const held = new Map<string, LockOwner>();

/** The owner a lock file names, or null (gone, empty, a pre-0.7 lock, not ours to parse). */
export function readLockOwner(lock: string): LockOwner | null {
  let text: string;
  try {
    text = fs.readFileSync(lock, 'utf8');
  } catch {
    return null;
  }
  try {
    const o = JSON.parse(text) as Partial<LockOwner>;
    if (typeof o.pid === 'number' && typeof o.host === 'string' && typeof o.nonce === 'string') return { pid: o.pid, host: o.host, nonce: o.nonce, at: String(o.at ?? '') };
  } catch {
    // not ours
  }
  return null;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM'; // exists, someone else's
  }
}

function describeOwner(o: LockOwner | null): string {
  return o === null ? 'another sea-lite process' : `pid ${o.pid} on ${o.host} since ${o.at}`;
}

function lockLost(lock: string, mine: LockOwner, now: LockOwner | null): SeaError {
  lockCounters.lost++;
  return new SeaError('wait_timeout', `${lock} was taken over by ${describeOwner(now)} while this process held it; nothing was written`, {
    reason: 'lock_lost',
    lock,
    nonce: mine.nonce,
  });
}

export function isLockLost(e: unknown): boolean {
  return e instanceof SeaError && e.details['reason'] === 'lock_lost';
}

/**
 * The fence: throws `lock_lost` unless `lock` still carries this process's
 * nonce. A no-op when this process did not take the lock through
 * `withFileLock` (single-process tools and tests that write directly).
 */
export function assertLockOwned(lock: string): void {
  const path = resolve(lock);
  const mine = held.get(path);
  if (mine === undefined) return;
  const now = readLockOwner(path);
  if (now?.nonce !== mine.nonce) throw lockLost(path, mine, now);
}

/** Why the lock is stale, or null while its holder may still be working. */
function staleness(st: fs.Stats, owner: LockOwner | null, watchedMs: number, now: number, o: Required<LockOptions>): string | null {
  const age = now - st.mtimeMs;
  const future = age < -FUTURE_TOLERANCE_MS;
  if (owner !== null && owner.host === hostname()) {
    if (!pidAlive(owner.pid)) return 'owner_gone';
    return (future ? watchedMs : age) > o.hungMs ? 'owner_hung' : null;
  }
  if (future) return watchedMs > o.futureGraceMs ? 'future_mtime' : null;
  return age > o.staleMs ? 'stale' : null;
}

/** Remove the stale lock we judged, and only that one. False when nothing was moved (gone already, or busy). */
function takeOver(lock: string, owner: LockOwner | null, st: fs.Stats): boolean {
  const aside = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return false;
  }
  let same: boolean;
  if (owner !== null) same = readLockOwner(aside)?.nonce === owner.nonce;
  else {
    try {
      const m = fs.statSync(aside);
      same = readLockOwner(aside) === null && m.ino === st.ino && m.mtimeMs === st.mtimeMs;
    } catch {
      same = true;
    }
  }
  if (!same) {
    // A holder replaced the stale lock between our look and the rename: put its lock back (link fails if yet another exists).
    try {
      fs.linkSync(aside, lock);
    } catch {
      // its holder's fence check (assertLockOwned) refuses its write
    }
  } else lockCounters.takeovers++;
  try {
    fs.unlinkSync(aside);
  } catch {
    // best effort
  }
  return true;
}

function acquire(lock: string, o: Required<LockOptions>): LockOwner {
  const deadline = Date.now() + o.waitMs;
  let seen = { key: '', since: Date.now() };
  for (;;) {
    const me: LockOwner = { pid: process.pid, host: hostname(), nonce: randomBytes(12).toString('hex'), at: new Date().toISOString() };
    let fd: number | null = null;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (e) {
      const c = errCode(e) ?? '';
      // EEXIST: held. EPERM / EACCES / EBUSY: Windows, the previous holder's lock file is still delete-pending.
      if (c !== 'EEXIST' && !TRANSIENT.has(c)) throw e;
    }
    if (fd !== null) {
      try {
        fs.writeSync(fd, JSON.stringify(me) + '\n');
      } catch (e) {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lock);
        } catch {
          // best effort
        }
        throw e;
      }
      fs.closeSync(fd);
      return me;
    }
    let owner: LockOwner | null = null;
    try {
      const st = fs.statSync(lock);
      owner = readLockOwner(lock);
      const key = `${st.ino}:${st.mtimeMs}:${st.size}:${owner?.nonce ?? ''}`;
      if (key !== seen.key) seen = { key, since: Date.now() };
      const now = Date.now();
      if (staleness(st, owner, now - seen.since, now, o) !== null && takeOver(lock, owner, st) && now <= deadline) continue;
    } catch {
      // gone already: retry the create
    }
    if (Date.now() > deadline) {
      throw new SeaError('wait_timeout', `${lock} is held by ${describeOwner(owner)}; remove it if no sea-lite command is running`, {
        lock,
        ...(owner !== null ? { owner_pid: owner.pid, owner_host: owner.host } : {}),
      });
    }
    lockCounters.waits++;
    sleepSync(5 + Math.floor(Math.random() * 20));
  }
}

/** Run `f` holding the exclusive lock file `lock` (created, with its directory, when missing). */
export function withFileLock<T>(lock: string, f: () => T, opts: LockOptions = {}): T {
  const o: Required<LockOptions> = { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS, hungMs: LOCK_HUNG_MS, futureGraceMs: FUTURE_GRACE_MS, ...opts };
  const path = resolve(lock);
  fs.mkdirSync(dirname(path), { recursive: true });
  const me = acquire(path, o);
  held.set(path, me);
  try {
    return f();
  } finally {
    held.delete(path);
    // Only our own lock: after a takeover the file is the new holder's.
    if (readLockOwner(path)?.nonce === me.nonce) {
      try {
        fs.unlinkSync(path);
      } catch {
        // gone already
      }
    }
  }
}

/** `withFileLock`, redoing `rmw` (from its read) when the lock was taken over before its write landed. */
export function updateLocked<T>(lock: string, rmw: () => T, opts: LockOptions = {}): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return withFileLock(lock, rmw, opts);
    } catch (e) {
      if (!isLockLost(e) || attempt >= LOST_RETRIES) throw e;
      lockCounters.retries++;
    }
  }
}

/**
 * Publish `text` at `file` (mode 0600): temp file + rename, fenced by `lock`
 * (checked right before each rename attempt), the rename retried on transient
 * Windows sharing violations.
 */
export function writeFileFenced(file: string, text: string, lock: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      assertLockOwned(lock);
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (isLockLost(e) || !TRANSIENT.has(errCode(e) ?? '') || Date.now() > deadline) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // best effort
        }
        throw e;
      }
      sleepSync(Math.min(5 * 2 ** attempt, 100));
    }
  }
}
