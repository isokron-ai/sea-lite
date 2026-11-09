/**
 * Waiting for a claim instead of failing at once (`wait_seconds` on
 * sea_claim / sea_next, `--wait` on the CLI).
 *
 * A waiter retries its claim only when something could have changed:
 *
 * - another process committed to the store: SQLite's `PRAGMA data_version`
 *   moves (a single counter read; no table scan), polled with a short
 *   backoff from 20 ms up to 250 ms;
 * - this process committed (another MCP connection or HTTP actor on the same
 *   open store): every write transaction pokes an in-process notifier keyed
 *   by the connection (core/repo.ts `tx`), which wakes waiters at once;
 * - the blocking lease reached its expiry (a lapse writes nothing until
 *   someone reads the row, so the waiter wakes at that instant and retries).
 *
 * Nothing is held while waiting: no transaction, no lock. When the wait
 * ends without the claim, the result names the holder and expiry that still
 * block it (`wait_timeout`).
 */

import type { Db } from 'kronicle-lite';

import { SeaError } from './errors.js';

export const MAX_WAIT_SECONDS = 300;
const MIN_BACKOFF_MS = 20;
const MAX_BACKOFF_MS = 250;

/** What stands in the way: one holder, its ticket and its expiry. */
export interface Blocker {
  /** already_claimed: the ticket is held; scope_conflict: an overlapping scope is held; busy_queue: sea_next found nothing free while others hold work. */
  kind: 'already_claimed' | 'scope_conflict' | 'busy_queue';
  ticket_id: string;
  title: string | null;
  holder: string;
  holder_session: string | null;
  holder_label: string;
  expires_at: string;
}

export interface WaitInfo {
  /** Seconds spent waiting before the claim went through. */
  seconds: number;
  attempts: number;
  blocked_by: Blocker;
  /** What freed it: the holder released, finished/moved the ticket, its lease lapsed, or the conflict otherwise went away. */
  freed: 'released' | 'finished' | 'lease_expired' | 'changed';
}

/**
 * How often this process slept in a wait loop. Tests assert on it ("refused
 * at once" = no sleep at all) instead of on wall clock alone, which a loaded
 * machine stretches.
 */
export const waitCounters = { sleeps: 0 };

type Wake = () => void;
const listeners = new WeakMap<Db, Set<Wake>>();

/** Called after every committed write transaction on `db` (core/repo.ts tx). */
export function notifyChange(db: Db): void {
  const set = listeners.get(db);
  if (set === undefined || set.size === 0) return;
  for (const w of [...set]) w();
}

function onChange(db: Db, w: Wake): () => void {
  let set = listeners.get(db);
  if (set === undefined) {
    set = new Set();
    listeners.set(db, set);
  }
  set.add(w);
  return () => set.delete(w);
}

function dataVersion(db: Db): number {
  return Number(db.pragma('data_version', { simple: true }));
}

export type Attempt<T> = { ok: true; value: T } | { ok: false; blocker: Blocker; error: SeaError };

export interface WaitOptions {
  waitSeconds: number;
  signal?: AbortSignal | undefined;
  /** Called about every `progressEveryMs` while waiting. */
  onProgress?: ((p: { elapsed_seconds: number; wait_seconds: number; blocked_by: Blocker }) => void) | undefined;
  progressEveryMs?: number;
  /** After success: how the first blocker was freed. */
  freedBy: (b: Blocker) => WaitInfo['freed'];
}

/**
 * Run `attempt` now; while it reports a blocker, wait for a change (or the
 * blocker's expiry) and run it again, until it succeeds or `waitSeconds`
 * pass. Returns the value and, if it had to wait, how long and what freed it.
 */
export async function waitForClaim<T>(db: Db, attempt: () => Attempt<T>, opts: WaitOptions): Promise<{ value: T; waited: WaitInfo | null }> {
  const started = Date.now();
  let r = attempt();
  if (r.ok) return { value: r.value, waited: null };
  if (opts.waitSeconds <= 0) throw r.error;
  const first = r.blocker;
  const deadline = started + Math.min(opts.waitSeconds, MAX_WAIT_SECONDS) * 1000;
  const progressEvery = opts.progressEveryMs ?? 5000;
  let nextProgress = started + progressEvery;
  let attempts = 1;
  let version = dataVersion(db);
  let backoff = MIN_BACKOFF_MS;

  for (;;) {
    if (opts.signal?.aborted) {
      throw new SeaError('wait_cancelled', `wait cancelled after ${secs(Date.now() - started)}s; ${describe(r.blocker)}`, {
        waited_seconds: secs(Date.now() - started),
        blocked_by: r.blocker,
      });
    }
    const now = Date.now();
    if (now >= deadline) {
      throw new SeaError('wait_timeout', `still blocked after ${secs(now - started)}s: ${describe(r.blocker)}`, {
        waited_seconds: secs(now - started),
        attempts,
        blocked_by: r.blocker,
        cause: r.error.toJSON(),
      });
    }
    const expiry = Date.parse(r.blocker.expires_at);
    const wakeAt = Math.min(now + backoff, deadline, Number.isFinite(expiry) && expiry > now ? expiry + 5 : now + backoff);
    const poked = await sleep(db, wakeAt - now, opts.signal);
    const v = dataVersion(db);
    const changed = poked || v !== version || Date.now() >= expiry;
    version = v;
    if (Date.now() >= nextProgress) {
      nextProgress += progressEvery;
      opts.onProgress?.({ elapsed_seconds: secs(Date.now() - started), wait_seconds: opts.waitSeconds, blocked_by: r.blocker });
    }
    if (!changed) {
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      continue;
    }
    backoff = MIN_BACKOFF_MS;
    attempts++;
    r = attempt();
    if (r.ok) return { value: r.value, waited: { seconds: secs(Date.now() - started), attempts, blocked_by: first, freed: opts.freedBy(first) } };
  }
}

function sleep(db: Db, ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  waitCounters.sleeps++;
  return new Promise((resolve) => {
    let done = false;
    const finish = (poked: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      signal?.removeEventListener('abort', abort);
      resolve(poked);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), Math.max(0, ms));
    const off = onChange(db, () => finish(true));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

const secs = (ms: number) => Math.round(ms / 100) / 10;

function describe(b: Blocker): string {
  const what = b.kind === 'scope_conflict' ? 'an overlapping scope' : b.kind === 'busy_queue' ? 'eligible work' : 'the ticket';
  return `"${b.holder_label}" holds ${what} on ticket ${b.ticket_id}${b.title !== null ? ` ("${b.title}")` : ''} until ${b.expires_at}`;
}
