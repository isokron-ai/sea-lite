/**
 * The CLI token file's lock (0.7.0 review). C2-02's lock was taken over by
 * file age alone: a holder paused past 30 s lost it, then wrote its stale
 * copy over the newer holder's tokens; a lock dated in the future was waited
 * on until the 30 s timeout. Now the lock names its owner (a live owner is
 * not taken over, a dead one at once), every write is fenced by the lock,
 * and a future mtime is stale-suspect (core/file-lock.ts).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCliClaims, updateCliClaims, withCliClaimsLock, writeCliClaims } from '../src/cli-claims.js';

let dir: string;
let lock: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sea-filelock-'));
  lock = join(dir, 'cli-claims.json.lock');
});
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const claim = (token: string) => ({ token, actor: 'a', session: 's', expires_at: '2099-01-01T00:00:00.000Z' });
const ownerLock = (pid: number, nonce: string) => JSON.stringify({ pid, host: hostname(), nonce, at: new Date().toISOString() }) + '\n';
const backdate = (file: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  utimesSync(file, t, t);
};
/** A pid that was alive a moment ago and is not any more. */
const deadPid = () => spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();
/** A live process that is not this one: a stand-in for a paused holder. */
const liveProcess = () => {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  children.push(c);
  return c;
};

describe('owner-verified takeover', () => {
  it('a live holder keeps its lock however old the file is (a paused holder is not taken over)', () => {
    const holder = liveProcess();
    writeFileSync(lock, ownerLock(holder.pid!, 'paused-holder'));
    backdate(lock, 120_000);
    const t0 = Date.now();
    let ran = false;
    expect(() =>
      withCliClaimsLock(
        dir,
        () => {
          ran = true;
        },
        { waitMs: 500 },
      ),
    ).toThrow(/held by pid \d+/);
    expect(ran).toBe(false);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(readFileSync(lock, 'utf8')).toContain('paused-holder');
  });

  it("a dead owner's lock is taken over at once, however young", () => {
    writeFileSync(lock, ownerLock(Number(deadPid()), 'crashed'));
    const t0 = Date.now();
    expect(withCliClaimsLock(dir, () => 'ran')).toBe('ran');
    expect(Date.now() - t0).toBeLessThan(5_000); // not the 30 s stale age
    expect(existsSync(lock)).toBe(false);
  });

  it('a lock dated in the future is stale-suspect: taken over after a short grace, not waited on until the timeout', () => {
    writeFileSync(lock, '');
    const future = new Date(Date.now() + 5 * 60_000);
    utimesSync(lock, future, future);
    const t0 = Date.now();
    updateCliClaims(dir, (c) => {
      c['t1'] = claim('tok1');
    });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(readCliClaims(dir)).toEqual({ t1: claim('tok1') });
  }, 60_000);
});

describe('fenced writes', () => {
  it('a holder whose lock was taken over writes nothing and leaves the new holder its lock', () => {
    writeCliClaims(dir, { newer: claim('newer') });
    expect(() =>
      withCliClaimsLock(dir, () => {
        const stale = readCliClaims(dir);
        // While "paused", another process took the lock over and wrote.
        writeFileSync(lock, ownerLock(process.pid, 'new-holder'));
        writeFileSync(join(dir, 'cli-claims.json'), JSON.stringify({ v: 1, claims: { ...readCliClaims(dir), theirs: claim('theirs') } }));
        stale['mine'] = claim('mine');
        writeCliClaims(dir, stale);
      }),
    ).toThrow(/taken over/);
    // the newer holder's tokens survive; its lock is not removed by the old holder's release
    expect(readCliClaims(dir)).toEqual({ newer: claim('newer'), theirs: claim('theirs') });
    expect(readFileSync(lock, 'utf8')).toContain('new-holder');
  });

  it('updateCliClaims redoes the read-modify-write from a fresh read when its lock was taken over', () => {
    let calls = 0;
    const gone = Number(deadPid());
    updateCliClaims(dir, (c) => {
      calls++;
      if (calls === 1) {
        // Another process takes the lock over (then crashes) and writes its token in between.
        writeFileSync(join(dir, 'cli-claims.json'), JSON.stringify({ v: 1, claims: { other: claim('other') } }));
        writeFileSync(lock, ownerLock(gone, 'crashed-taker'));
      }
      c['mine'] = claim('mine');
    });
    expect(calls).toBe(2);
    expect(readCliClaims(dir)).toEqual({ other: claim('other'), mine: claim('mine') });
    expect(existsSync(lock)).toBe(false);
  });
});
