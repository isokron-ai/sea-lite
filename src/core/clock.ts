/**
 * C2-06 (0.6.2): leases compare wall-clock instants written by different
 * processes, so they assume one shared clock. A process whose clock runs
 * 15 min ahead saw every live lease as lapsed and took it over; one running
 * behind wrote leases that lapsed early for everyone else.
 *
 * The guard measures this process's clock against a reference every process
 * sharing the store also sees: the modification time the file system stamps
 * on a probe file in the data dir (the kernel's clock on a local disk, the
 * server's on a network share or a VM bind mount). When the two differ by
 * more than the tolerance, lease decisions are refused: claim / next /
 * refresh fail with `clock_skew`, the auto-heartbeat skips, and the lazy
 * expiry sweep leaves other holders' leases alone. Reads and fenced writes
 * are unaffected (a fence is a token compare; its expiry check can only err
 * towards refusing the holder, never towards admitting someone else).
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, writeSync, type Stats } from 'node:fs';
import { join } from 'node:path';

import { SeaError } from './errors.js';

export const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 30;
/** Re-measure at most this often (process monotonic time). */
const PROBE_EVERY_MS = 60_000;
const PROBE_FILE = 'sea-clock.probe';

export interface ClockGuard {
  /** Measured skew in ms (this process minus the reference) when over the tolerance, else null. */
  untrusted(): { skew_ms: number; max_ms: number } | null;
}

/** SEA_LITE_MAX_CLOCK_SKEW_SECONDS: tolerance in seconds; 0 disables the guard. */
export function parseMaxSkew(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CLOCK_SKEW_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`SEA_LITE_MAX_CLOCK_SKEW_SECONDS must be a non-negative number of seconds (got "${raw}")`);
  return n;
}

/** The probe never follows a link or opens a FIFO / device (both were possible through a planted file). */
const PROBE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function defaultWarn(message: string): void {
  process.emitWarning(message, { code: 'SEA_LITE_CLOCK_PROBE' });
}

/**
 * The file system's notion of "now" in ms, from a probe write in `dir`; null
 * when it cannot be measured (the guard then allows lease decisions). The
 * first failure is reported once through `warn` (default: a process warning
 * on stderr) so a disabled check is never silent; `sea-lite doctor` reports
 * it too.
 */
export function fsReference(dir: string, warn: (message: string) => void = defaultWarn): () => number | null {
  const file = join(dir, PROBE_FILE);
  let warned = false;
  const fail = (why: string): null => {
    if (!warned) {
      warned = true;
      warn(`sea-lite: clock check disabled for ${dir}: ${why}; leases then trust this process's clock`);
    }
    return null;
  };
  return () => {
    let fd: number | null = null;
    try {
      // why: lstat first for platforms without O_NOFOLLOW (Windows); the flags close the race on POSIX.
      const pre = lstatOrNull(file);
      if (pre && !pre.isFile()) return fail(`${file} is not a regular file`);
      fd = openSync(file, PROBE_FLAGS, 0o600);
      if (!fstatSync(fd).isFile()) return fail(`${file} is not a regular file`);
      writeSync(fd, `${process.pid}\n`);
      return fstatSync(fd).mtimeMs;
    } catch (e) {
      return fail(`${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  };
}

function lstatOrNull(file: string): Stats | null {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

export function clockGuard(clock: () => Date, reference: () => number | null, maxSkewSeconds: number): ClockGuard {
  const max_ms = maxSkewSeconds * 1000;
  let measuredAt = -Infinity;
  let skew: number | null = null;
  return {
    untrusted() {
      if (max_ms <= 0) return null;
      const t = performance.now();
      if (t - measuredAt >= PROBE_EVERY_MS) {
        const ref = reference();
        skew = ref === null ? null : clock().getTime() - ref;
        measuredAt = t;
      }
      return skew !== null && Math.abs(skew) > max_ms ? { skew_ms: Math.round(skew), max_ms } : null;
    },
  };
}

/** Throws `clock_skew` when the caller's clock is not trusted for lease decisions. */
export function assertClockTrusted(guard: ClockGuard | undefined, what: string): void {
  const u = guard?.untrusted() ?? null;
  if (u === null) return;
  const dir = u.skew_ms > 0 ? 'ahead of' : 'behind';
  throw new SeaError(
    'clock_skew',
    `refusing to ${what}: this process's clock is ${Math.abs(Math.round(u.skew_ms / 1000))}s ${dir} the data dir's file-system clock ` +
      `(tolerance ${u.max_ms / 1000}s); leases compare wall-clock times across processes. Fix the clock (NTP), or set SEA_LITE_MAX_CLOCK_SKEW_SECONDS=0 to disable the check`,
    { skew_ms: u.skew_ms, max_skew_ms: u.max_ms },
  );
}
