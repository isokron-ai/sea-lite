/**
 * cli-claims.json on Windows semantics (CI on #17, windows-latest: one of 16
 * concurrent `sea-lite release` processes exited non-zero). `release` read
 * the file outside the lock while other releases renamed over it under the
 * lock; on Windows a rename over a file another process has open fails with
 * EPERM / EACCES / EBUSY, and a read mid-replace can fail too, which the
 * read turned into "no tokens". These tests inject those failures, so they
 * are deterministic on every OS.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeFs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({ rename: 0, read: 0, open: 0, code: 'EPERM' }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>();
  const fail = (what: string) => Object.assign(new Error(`${faults.code}: operation not permitted, ${what}`), { code: faults.code });
  return {
    ...real,
    renameSync: (a: string, b: string) => {
      if (faults.rename > 0) {
        faults.rename--;
        throw fail('rename');
      }
      return real.renameSync(a, b);
    },
    readFileSync: ((p: string, o?: unknown) => {
      if (faults.read > 0 && String(p).endsWith('cli-claims.json')) {
        faults.read--;
        throw fail('open');
      }
      return real.readFileSync(p as never, o as never);
    }) as typeof real.readFileSync,
    openSync: ((p: string, f?: unknown, m?: unknown) => {
      if (faults.open > 0 && String(p).endsWith('.lock')) {
        faults.open--;
        throw fail('open');
      }
      return real.openSync(p as never, f as never, m as never);
    }) as typeof real.openSync,
  };
});

const { readCliClaims, snapshotCliClaims, updateCliClaims, writeCliClaims } = await import('../src/cli-claims.js');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sea-cliclaims-'));
  Object.assign(faults, { rename: 0, read: 0, open: 0, code: 'EPERM' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const claim = (token: string) => ({ token, actor: 'a', session: 's', expires_at: '2026-11-09T00:00:00.000Z' });

describe('cli-claims.json under Windows sharing violations', () => {
  it('a rename over a file another process has open (EPERM / EACCES / EBUSY) is retried, not fatal', () => {
    for (const c of ['EPERM', 'EACCES', 'EBUSY']) {
      Object.assign(faults, { rename: 3, code: c });
      writeCliClaims(dir, { t1: claim(`tok-${c}`) });
      expect(faults.rename, c).toBe(0);
      expect(readCliClaims(dir), c).toEqual({ t1: claim(`tok-${c}`) });
    }
    // no temp files left behind
    expect(readFileSync(join(dir, 'cli-claims.json'), 'utf8')).toContain('tok-EBUSY');
  });

  it('a read that fails for any reason but "no file" is an error, never an empty token map', () => {
    writeCliClaims(dir, { t1: claim('tok') });
    faults.read = 1;
    expect(() => readCliClaims(dir)).toThrow(/EPERM/);
    expect(readCliClaims(dir)).toEqual({ t1: claim('tok') });
    expect(readCliClaims(join(dir, 'missing'))).toEqual({});
  });

  it('a lock file still delete-pending (EPERM on create) is waited for, not fatal', () => {
    faults.open = 3;
    updateCliClaims(dir, (c) => {
      c['t2'] = claim('tok2');
    });
    expect(faults.open).toBe(0);
    expect(snapshotCliClaims(dir)).toEqual({ t2: claim('tok2') });
    expect(existsSync(join(dir, 'cli-claims.json.lock'))).toBe(false);
  });
});

describe('release reads the tokens under the lock', () => {
  it('a release started while another process holds the lock sees what that process wrote', async () => {
    const data = join(dir, 'data');
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    spawnSync('git', ['init', '-q', repo]);
    const CLI = join(process.cwd(), 'dist', 'cli.js');
    const env = { PATH: process.env['PATH'] ?? '', HOME: dir, SEA_LITE_ACTOR: 'a1', SEA_LITE_SESSION: 's1' };
    const sl = (args: string[]) => spawnSync(process.execPath, [CLI, ...args, '--data-dir', data], { encoding: 'utf8', cwd: repo, env });
    const id = (JSON.parse(sl(['create', 't', '--triaged', '--json']).stdout) as { ticket: { id: string } }).ticket.id;
    expect(sl(['claim', id]).status).toBe(0);
    const file = join(data, 'cli-claims.json');
    const full = readFileSync(file, 'utf8');
    // Another CLI process is mid-update: it holds the lock and has not written our token yet.
    writeFileSync(file, JSON.stringify({ v: 1, claims: {} }));
    const lock = join(data, 'cli-claims.json.lock');
    writeFileSync(lock, 'held\n');
    const child = spawn(process.execPath, [CLI, 'release', id, '--data-dir', data], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    // The holder finishes: the token is there, then the lock goes. An unlocked read (0.6.1–0.7.0 candidates) saw {} and exited 2.
    await new Promise((r) => setTimeout(r, 3_000));
    writeFileSync(file, full);
    unlinkSync(lock);
    expect(await exited, err).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, claims: {} });
  }, 60_000);
});
