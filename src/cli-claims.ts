/**
 * Tokens of claims taken from the CLI, so `release` needs no token juggling.
 * `<data dir>/cli-claims.json`, mode 0600, keyed by ticket id. Holding a
 * token is holding the claim: the file is as sensitive as the data dir.
 *
 * C2-02 (0.6.1): every read-modify-write runs under an exclusive lock file
 * (`open(O_CREAT|O_EXCL)`, retried); the write is temp file + rename.
 *
 * Windows (0.7.0, CI on #17): `release` read the file *outside* the lock
 * while other processes renamed over it under the lock. On Windows a rename
 * over a file another process has open fails (EPERM / EACCES / EBUSY), and
 * opening a file mid-replace can fail the same way; the read swallowed any
 * error as "no tokens", so a concurrent release exited 2 ("no CLI claim
 * token"). Now: every read takes the lock (`snapshotCliClaims`), a read error
 * other than "no file yet" is an error, not an empty map, and the rename and
 * the lock create retry those transient Windows codes (an antivirus or
 * indexer can hold the file too).
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';

import { SeaError } from './core/errors.js';

export interface CliClaim {
  token: string;
  actor: string;
  session: string | null;
  expires_at: string;
}

export const CLI_CLAIMS_FILE = 'cli-claims.json';
/** A lock older than this is a crashed holder's: taken over. Every holder is one short read-modify-write. */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 30_000;
/** How long a rename keeps retrying a transient sharing violation. */
const RENAME_RETRY_MS = 5_000;

/** Codes Windows returns while another process has the file open or it is delete-pending. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function code(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

/** The current tokens. Caller holds the lock. No file yet: none. A corrupt file: none (it is rewritten whole). Anything else throws. */
export function readCliClaims(dataDir: string): Record<string, CliClaim> {
  let text: string;
  try {
    text = fs.readFileSync(join(dataDir, CLI_CLAIMS_FILE), 'utf8');
  } catch (e) {
    if (code(e) === 'ENOENT') return {};
    throw e;
  }
  try {
    return (JSON.parse(text) as { claims?: Record<string, CliClaim> }).claims ?? {};
  } catch {
    return {};
  }
}

/** Temp file + rename; the rename retries transient sharing violations. Caller holds the lock. */
export function writeCliClaims(dataDir: string, claims: Record<string, CliClaim>): void {
  const file = join(dataDir, CLI_CLAIMS_FILE);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, claims }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (!TRANSIENT.has(code(e) ?? '') || Date.now() > deadline) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // best effort
        }
        throw e;
      }
      sleep(Math.min(5 * 2 ** attempt, 100));
    }
  }
}

/** Run `f` holding the exclusive lock. */
export function withCliClaimsLock<T>(dataDir: string, f: () => T): T {
  fs.mkdirSync(dataDir, { recursive: true });
  const lock = join(dataDir, `${CLI_CLAIMS_FILE}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (e) {
      const c = code(e) ?? '';
      // EEXIST: held. EPERM / EACCES / EBUSY: Windows, the previous holder's lock file is still delete-pending.
      if (c !== 'EEXIST' && !TRANSIENT.has(c)) throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
      } catch {
        // gone already: retry at once
      }
      if (Date.now() > deadline) throw new SeaError('wait_timeout', `${lock} is held by another sea-lite process; remove it if no sea-lite command is running`, { lock });
      sleep(5 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return f();
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lock);
    } catch {
      // taken over as stale: nothing to remove
    }
  }
}

/** Read-modify-write under the lock, so concurrent CLI claims and releases never drop each other's tokens. */
export function updateCliClaims(dataDir: string, change: (claims: Record<string, CliClaim>) => void): void {
  withCliClaimsLock(dataDir, () => {
    const claims = readCliClaims(dataDir);
    change(claims);
    writeCliClaims(dataDir, claims);
  });
}

/** A consistent read: under the lock, never while another process is replacing the file. */
export function snapshotCliClaims(dataDir: string): Record<string, CliClaim> {
  return withCliClaimsLock(dataDir, () => readCliClaims(dataDir));
}
