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
 *
 * Owner-verified lock (0.7.0 review): the lock names its owner, a live
 * owner is never taken over by age, and every write is fenced by the lock
 * (core/file-lock.ts), so a holder paused past the stale age cannot write
 * its stale copy over a newer holder's tokens.
 */

import * as fs from 'node:fs';
import { join } from 'node:path';

import { updateLocked, withFileLock, writeFileFenced, type LockOptions } from './core/file-lock.js';

export interface CliClaim {
  token: string;
  actor: string;
  session: string | null;
  expires_at: string;
}

export const CLI_CLAIMS_FILE = 'cli-claims.json';

export function cliClaimsLock(dataDir: string): string {
  return join(dataDir, `${CLI_CLAIMS_FILE}.lock`);
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

/**
 * Temp file + rename; the rename retries transient sharing violations and is
 * fenced: when this process holds the lock (withCliClaimsLock) but another
 * process has taken it over, nothing is written (`lock_lost`).
 */
export function writeCliClaims(dataDir: string, claims: Record<string, CliClaim>): void {
  writeFileFenced(join(dataDir, CLI_CLAIMS_FILE), JSON.stringify({ v: 1, claims }, null, 2) + '\n', cliClaimsLock(dataDir));
}

/** Run `f` holding the exclusive lock. */
export function withCliClaimsLock<T>(dataDir: string, f: () => T, opts: LockOptions = {}): T {
  fs.mkdirSync(dataDir, { recursive: true });
  return withFileLock(cliClaimsLock(dataDir), f, opts);
}

/**
 * Read-modify-write under the lock, so concurrent CLI claims and releases
 * never drop each other's tokens. `change` may run more than once (on a
 * fresh read each time) if the lock is taken over before the write lands.
 */
export function updateCliClaims(dataDir: string, change: (claims: Record<string, CliClaim>) => void, opts: LockOptions = {}): void {
  fs.mkdirSync(dataDir, { recursive: true });
  updateLocked(
    cliClaimsLock(dataDir),
    () => {
      const claims = readCliClaims(dataDir);
      change(claims);
      writeCliClaims(dataDir, claims);
    },
    opts,
  );
}

/** A consistent read: under the lock, never while another process is replacing the file. */
export function snapshotCliClaims(dataDir: string): Record<string, CliClaim> {
  return withCliClaimsLock(dataDir, () => readCliClaims(dataDir));
}
