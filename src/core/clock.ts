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

import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { constants, readdirSync, renameSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { basename, join } from 'node:path';

import { SeaError } from './errors.js';

export const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 30;
/** Re-measure at most this often (process monotonic time). */
const PROBE_EVERY_MS = 60_000;
export const PROBE_FILE = 'sea-clock.probe';
/** A plant that cannot be unlinked (a directory) is renamed to `<probe>.tampered-<ms>-<hex>` and kept as evidence. */
export const PROBE_ASIDE_PREFIX = `${PROBE_FILE}.tampered-`;
/** Moved-aside plants kept as evidence; older ones are removed and counted in PROBE_REMOVED_FILE (#8 review: 121 in 3 s). */
export const PROBE_ASIDE_KEEP = 8;
export const PROBE_REMOVED_FILE = `${PROBE_FILE}.removed-count`;
const ASIDE_NAME = /^\d{1,16}-[0-9a-f]{8}$/;

/** Our own moved-aside names in `dir`, oldest first. */
export function probeAsides(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith(PROBE_ASIDE_PREFIX) && ASIDE_NAME.test(n.slice(PROBE_ASIDE_PREFIX.length)))
      .sort((a, b) => Number(a.slice(PROBE_ASIDE_PREFIX.length).split('-')[0]) - Number(b.slice(PROBE_ASIDE_PREFIX.length).split('-')[0]) || (a < b ? -1 : 1));
  } catch {
    return [];
  }
}

/** How many moved-aside plants were removed so far (an agent-writable counter: informational only). */
export function probeRemovedCount(dir: string): number {
  let fd: number | null = null;
  try {
    fd = nodeFs.openSync(join(dir, PROBE_REMOVED_FILE), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!nodeFs.fstatSync(fd).isFile()) return 0;
    const buf = Buffer.alloc(16);
    const n = Number(buf.subarray(0, nodeFs.readSync(fd, buf, 0, 16, 0)).toString('latin1').trim());
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  } finally {
    if (fd !== null) nodeFs.closeSync(fd);
  }
}

/** Keep the newest PROBE_ASIDE_KEEP asides; remove older ones (never following links) and add them to the counter. */
function pruneAsides(dir: string): void {
  const all = probeAsides(dir);
  const old = all.slice(0, Math.max(0, all.length - PROBE_ASIDE_KEEP));
  if (old.length === 0) return;
  let removed = 0;
  for (const a of old) {
    try {
      rmSync(join(dir, a), { recursive: true, force: true });
      removed++;
    } catch {
      /* keep it; counted next time */
    }
  }
  const tmp = join(dir, `${PROBE_REMOVED_FILE}.${process.pid}.${randomBytes(4).toString('hex')}`);
  try {
    writeFileSync(tmp, String(probeRemovedCount(dir) + removed), { flag: 'wx', mode: 0o600 });
    renameSync(tmp, join(dir, PROBE_REMOVED_FILE));
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing */
    }
  }
}
/** Heal-and-reopen rounds before falling back to a one-shot probe (concurrent healers, a racing planter). */
const ATTEMPTS = 10;
/** Open errors that mean "something other than our file is at the path right now": retried, and tampering if it persists. */
const CONTESTED = new Set(['ELOOP', 'ENXIO', 'EEXIST', 'EISDIR']);

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

/** The file-system calls the probe makes (injectable so tests can reach the error paths). */
export interface ProbeFs {
  lstat(path: string): Stats;
  open(path: string, flags: number, mode: number): number;
  fstat(fd: number): Stats;
  unlink(path: string): void;
  rename(from: string, to: string): void;
  ftruncate(fd: number, len: number): void;
  write(fd: number, data: string): void;
  close(fd: number): void;
}

const NODE_FS: ProbeFs = {
  lstat: (p) => nodeFs.lstatSync(p),
  open: (p, f, m) => nodeFs.openSync(p, f, m),
  fstat: (fd) => nodeFs.fstatSync(fd),
  unlink: (p) => nodeFs.unlinkSync(p),
  rename: (a, b) => nodeFs.renameSync(a, b),
  ftruncate: (fd, n) => nodeFs.ftruncateSync(fd, n),
  write: (fd, s) => void nodeFs.writeSync(fd, s),
  close: (fd) => nodeFs.closeSync(fd),
};

function defaultWarn(message: string): void {
  process.emitWarning(message, { code: 'SEA_LITE_CLOCK_PROBE' });
}

type Attempt = { done: Reference } | { retry: string };
const RETRY = '\0retry';

/**
 * The file system's notion of "now" in ms, from a probe write in `dir`.
 *
 * #6: anything other than our own regular, singly linked file at the probe
 * path is a plant. A symlink, FIFO or hard link is unlinked (which never
 * touches what it points at); #8: a directory is renamed aside to
 * `sea-clock.probe.tampered-<ms>-<hex>` (kept as evidence, reported by
 * `sea-lite doctor`) instead of blocking every lease decision. Every repair
 * goes to `warn`. The probe is then recreated exclusively. A plant that
 * cannot be moved is measured around with a one-shot probe under an
 * unpredictable name, so planting at the fixed path never switches the guard
 * on or off.
 *
 * #8: other processes heal the same plant at the same time, so ENOENT from
 * unlink / rename and EEXIST / ELOOP / ENXIO / EISDIR from open (another
 * healer, or a planter, got there between our lstat and our call) are
 * retried. Only a path still contested after every attempt, and for the
 * one-shot probe too, is tampering (fail closed). A probe made unwritable
 * (EACCES / EPERM) is replaced like any other plant. When no probe can be
 * written at all the reading is null: the guard then refuses lease decisions
 * (#8 review: it used to trust this process's clock, so `chmod 0444` on the
 * probe switched it off), and `warn` says so once; SEA_LITE_MAX_CLOCK_SKEW_SECONDS=0
 * is the operator's way to accept an unmeasured clock.
 */
export function fsReference(dir: string, warn: (message: string) => void = defaultWarn, fs: ProbeFs = NODE_FS): () => Reference {
  const file = join(dir, PROBE_FILE);
  let warned = false;
  const unavailable = (why: string): null => {
    if (!warned) {
      warned = true;
      warn(`sea-lite: cannot measure the clock in ${dir}: ${why}; lease decisions are refused (SEA_LITE_MAX_CLOCK_SKEW_SECONDS=0 accepts an unmeasured clock)`);
    }
    return null;
  };
  const lstatOrNull = (p: string): Stats | null => {
    try {
      return fs.lstat(p);
    } catch {
      return null;
    }
  };
  /** Write through `fd` once fstat confirms it is a regular, singly linked file; a retry reason otherwise. */
  const measure = (fd: number): Attempt => {
    const st = fs.fstat(fd);
    // why: closes the lstat→open race (O_NOFOLLOW covers links; this covers a hard link made in between).
    if (!st.isFile() || st.nlink > 1) return { retry: `${file} changed under the probe (${kind(st)})` };
    fs.ftruncate(fd, 0);
    fs.write(fd, `${process.pid}\n`);
    return { done: fs.fstat(fd).mtimeMs };
  };
  /** Remove a plant: null when done (or another healer did it), RETRY when it changed under us, a reason when it cannot be moved. */
  const clear = (pre: Stats): string | null => {
    const code = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? String(e);
    if (pre.isDirectory()) {
      const aside = join(dir, `${PROBE_ASIDE_PREFIX}${Date.now()}-${randomBytes(4).toString('hex')}`);
      try {
        fs.rename(file, aside);
      } catch (e) {
        return code(e) === 'ENOENT' ? null : code(e);
      }
      const moved = lstatOrNull(aside);
      if (moved !== null && moved.isFile() && moved.nlink === 1) {
        // why: another healer put a fresh probe there between our lstat and rename; that is no plant.
        try {
          fs.unlink(aside);
        } catch {
          /* best effort */
        }
        return null;
      }
      warn(`sea-lite: clock probe ${file} was a directory; moved aside to ${basename(aside)}`);
      pruneAsides(dir);
      return null;
    }
    try {
      fs.unlink(file);
    } catch (e) {
      // why: EISDIR (EPERM on macOS) means a directory replaced what lstat saw; the next attempt renames it aside.
      if (code(e) === 'EISDIR' || code(e) === 'EPERM') return RETRY;
      return code(e) === 'ENOENT' ? null : code(e);
    }
    warn(`sea-lite: clock probe ${file} was a ${kind(pre)}; unlinked (what it pointed at is untouched)`);
    return null;
  };
  const attempt = (): Attempt => {
    let fd: number | null = null;
    let pre: Stats | null = null;
    try {
      pre = lstatOrNull(file);
      if (pre && (!pre.isFile() || pre.nlink > 1)) {
        const stuck = clear(pre);
        if (stuck === RETRY) return { retry: `${file} changed while it was being removed` };
        if (stuck !== null) return { done: oneShot(`${file} is a ${kind(pre)} that cannot be moved (${stuck}); measured with a one-shot probe`) };
        fd = fs.open(file, CREATE_FLAGS, 0o600);
      } else {
        fd = fs.open(file, OPEN_FLAGS, 0o600);
      }
      return measure(fd);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== undefined && CONTESTED.has(code)) return { retry: `${file}: ${code} while opening the probe` };
      if ((code === 'EACCES' || code === 'EPERM') && pre !== null) {
        // #8 review: a probe made read-only (chmod 0444, same uid) is a plant too: replace it.
        try {
          fs.unlink(file);
        } catch (u) {
          if ((u as NodeJS.ErrnoException).code !== 'ENOENT') return { done: oneShot(`${file} is not writable (${code}) and cannot be removed; measured with a one-shot probe`) };
        }
        warn(`sea-lite: clock probe ${file} was not writable (${code}); replaced`);
        return { retry: `${file}: ${code}` };
      }
      return { done: unavailable(`${file}: ${code ?? String(e)}`) };
    } finally {
      if (fd !== null) fs.close(fd);
    }
  };
  /** Measure with a probe under a fresh, unpredictable name: nothing can be planted there in advance. */
  const oneShot = (why: string): Reference => {
    warn(`sea-lite: clock probe ${why}`);
    const tmp = `${file}.${process.pid}-${randomBytes(6).toString('hex')}`;
    let fd: number | null = null;
    try {
      fd = fs.open(tmp, CREATE_FLAGS, 0o600);
      const r = measure(fd);
      return 'done' in r ? r.done : { tampered: r.retry };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== undefined && CONTESTED.has(code)) return { tampered: `${tmp}: ${code} while opening the one-shot probe` };
      return unavailable(`${tmp}: ${code ?? String(e)}`);
    } finally {
      if (fd !== null) fs.close(fd);
      try {
        fs.unlink(tmp);
      } catch {
        /* never created */
      }
    }
  };
  return () => {
    let why = '';
    for (let i = 0; i < ATTEMPTS; i++) {
      const r = attempt();
      if ('done' in r) return r.done;
      why = r.retry;
    }
    const r = oneShot(`${file} still contested after ${ATTEMPTS} attempts (${why}); measured with a one-shot probe`);
    return typeof r === 'object' && r !== null ? { tampered: `${why}; ${r.tampered}` } : r;
  };
}

function kind(st: Stats): string {
  return st.isSymbolicLink() ? 'symlink' : st.isFIFO() ? 'fifo' : st.isDirectory() ? 'directory' : st.nlink > 1 ? `hard link ×${st.nlink}` : 'not a regular file';
}

export interface Untrusted {
  /** Measured skew in ms (this process minus the reference); NaN when tampered. */
  skew_ms: number;
  max_ms: number;
  /** Set when the probe path was tampered with and could not be repaired. */
  tampered?: string;
  /** Set when the clock could not be measured at all (fail closed). */
  unavailable?: true;
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
      if (last === null) return { skew_ms: NaN, max_ms, unavailable: true };
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
  if (u.unavailable) {
    throw new SeaError(
      'clock_skew',
      `refusing to ${what}: this process's clock could not be checked against the data dir's (the clock probe cannot be written; see the SEA_LITE_CLOCK_PROBE warning). Fix the data dir, or set SEA_LITE_MAX_CLOCK_SKEW_SECONDS=0 to accept an unmeasured clock`,
      { reason: 'probe_unavailable' },
    );
  }
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
