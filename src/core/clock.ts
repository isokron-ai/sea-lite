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

import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { join } from 'node:path';

import { SeaError } from './errors.js';

export const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 30;
/** Re-measure at most this often (process monotonic time). */
const PROBE_EVERY_MS = 60_000;
const PROBE_FILE = 'sea-clock.probe';

export interface ClockGuard {
  /** Measured skew in ms (this process minus the reference) when over the tolerance, else null. */
  untrusted(): Untrusted | null;
}

/** SEA_LITE_MAX_CLOCK_SKEW_SECONDS: tolerance in seconds; 0 disables the guard. */
export function parseMaxSkew(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CLOCK_SKEW_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`SEA_LITE_MAX_CLOCK_SKEW_SECONDS must be a non-negative number of seconds (got "${raw}")`);
  return n;
}

/** Opening the probe never follows a link, never blocks on a FIFO, and never truncates before the checks. */
const OPEN_FLAGS = constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

/** A reference reading: ms since the epoch, null (cannot measure: fail open, warned), or tampered (fail closed). */
export type Reference = number | null | { tampered: string };

function defaultWarn(message: string): void {
  process.emitWarning(message, { code: 'SEA_LITE_CLOCK_PROBE' });
}

/**
 * The file system's notion of "now" in ms, from a probe write in `dir`.
 *
 * #6: anything other than our own regular, singly linked file at the probe
 * path (a symlink, a FIFO, a hard link to someone else's file) is a plant:
 * it is unlinked (which never touches what it points at) and a fresh probe is
 * created exclusively. A plant that cannot be removed (a directory) is
 * reported as tampered and the guard fails closed. A data dir that cannot be
 * written at all (read-only mount) is not an attack: the reading is null, the
 * guard allows lease decisions, and `warn` says so once (default: a process
 * warning on stderr); `sea-lite doctor` reports it too.
 */
export function fsReference(dir: string, warn: (message: string) => void = defaultWarn): () => Reference {
  const file = join(dir, PROBE_FILE);
  let warned = false;
  const unavailable = (why: string): null => {
    if (!warned) {
      warned = true;
      warn(`sea-lite: clock check disabled for ${dir}: ${why}; leases then trust this process's clock`);
    }
    return null;
  };
  const write = (fd: number): number => {
    ftruncateSync(fd, 0);
    writeSync(fd, `${process.pid}\n`);
    return fstatSync(fd).mtimeMs;
  };
  return () => {
    let fd: number | null = null;
    try {
      const pre = lstatOrNull(file);
      if (pre && (!pre.isFile() || pre.nlink > 1)) {
        try {
          unlinkSync(file);
        } catch (e) {
          return { tampered: `${file} is not our probe (${kind(pre)}) and cannot be removed: ${(e as NodeJS.ErrnoException).code ?? String(e)}` };
        }
        fd = openSync(file, CREATE_FLAGS, 0o600);
      } else {
        fd = openSync(file, OPEN_FLAGS, 0o600);
      }
      const st = fstatSync(fd);
      // why: closes the lstat→open race (O_NOFOLLOW covers links; this covers a hard link made in between).
      if (!st.isFile() || st.nlink > 1) return { tampered: `${file} changed under the probe (${kind(st)})` };
      return write(fd);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ELOOP' || code === 'ENXIO' || code === 'EEXIST') return { tampered: `${file}: ${code} while opening the probe` };
      return unavailable(`${file}: ${code ?? String(e)}`);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  };
}

function kind(st: Stats): string {
  return st.isSymbolicLink() ? 'symlink' : st.isFIFO() ? 'fifo' : st.isDirectory() ? 'directory' : st.nlink > 1 ? `hard link ×${st.nlink}` : 'not a regular file';
}

function lstatOrNull(file: string): Stats | null {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

export interface Untrusted {
  /** Measured skew in ms (this process minus the reference); NaN when tampered. */
  skew_ms: number;
  max_ms: number;
  /** Set when the probe path was tampered with and could not be repaired. */
  tampered?: string;
}

export function clockGuard(clock: () => Date, reference: () => Reference, maxSkewSeconds: number): ClockGuard {
  const max_ms = maxSkewSeconds * 1000;
  let measuredAt = -Infinity;
  let last: Reference = null;
  let at = 0;
  return {
    untrusted() {
      if (max_ms <= 0) return null;
      const t = performance.now();
      if (t - measuredAt >= PROBE_EVERY_MS) {
        last = reference();
        at = clock().getTime();
        measuredAt = t;
      }
      if (last === null) return null;
      if (typeof last === 'object') return { skew_ms: NaN, max_ms, tampered: last.tampered };
      const skew = at - last;
      return Math.abs(skew) > max_ms ? { skew_ms: Math.round(skew), max_ms } : null;
    },
  };
}

/** Throws `clock_skew` when the caller's clock is not trusted for lease decisions. */
export function assertClockTrusted(guard: ClockGuard | undefined, what: string): void {
  const u = guard?.untrusted() ?? null;
  if (u === null) return;
  if (u.tampered !== undefined) {
    throw new SeaError('clock_skew', `refusing to ${what}: the clock probe was tampered with and could not be repaired (${u.tampered}); remove it`, {
      reason: 'probe_tampered',
    });
  }
  const dir = u.skew_ms > 0 ? 'ahead of' : 'behind';
  throw new SeaError(
    'clock_skew',
    `refusing to ${what}: this process's clock is ${Math.abs(Math.round(u.skew_ms / 1000))}s ${dir} the data dir's file-system clock ` +
      `(tolerance ${u.max_ms / 1000}s); leases compare wall-clock times across processes. Fix the clock (NTP), or set SEA_LITE_MAX_CLOCK_SKEW_SECONDS=0 to disable the check`,
    { skew_ms: u.skew_ms, max_skew_ms: u.max_ms },
  );
}
