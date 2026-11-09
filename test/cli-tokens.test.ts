/**
 * C2-02 (0.6.1): CLI claim tokens live in one <data dir>/cli-claims.json that
 * 0.6.0 updated with an unlocked read-modify-write: 40 concurrent CLI claims
 * lost up to 34 tokens, so those releases failed and the paths stayed locked
 * until the leases lapsed. Updates now take an exclusive lock file.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = join(process.cwd(), 'dist', 'cli.js');
let base: string;
let data: string;
let repo: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'sea-clitok-'));
  data = join(base, 'data');
  repo = join(base, 'repo');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
});
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const env = (i: number) => ({ PATH: process.env['PATH'] ?? '', HOME: base, SEA_LITE_ACTOR: `a${i}`, SEA_LITE_SESSION: `s${i}` });
const sl = (i: number, args: string[]) => spawnSync(process.execPath, [CLI, ...args, '--data-dir', data], { encoding: 'utf8', cwd: repo, env: env(i) });
const slAsync = (i: number, args: string[]) =>
  new Promise<{ code: number | null; err: string }>((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, '--data-dir', data], { cwd: repo, env: env(i), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('exit', (code) => resolve({ code, err }));
  });
/** Every process exited 0; else name the failures and their stderr (CI on Windows showed only "expected false to be true"). */
const allOk = (rs: { code: number | null; err: string }[]) =>
  expect(rs.map((r, i) => ({ i, ...r })).filter((r) => r.code !== 0)).toEqual([]);
const tokens = () => (JSON.parse(readFileSync(join(data, 'cli-claims.json'), 'utf8')) as { claims: Record<string, unknown> }).claims;

describe('cli-claims.json under concurrency (C2-02)', () => {
  it('sixteen concurrent CLI claims keep sixteen tokens; every holder can release', async () => {
    const N = 16;
    const ids = Array.from({ length: N }, (_, i) => (JSON.parse(sl(i, ['create', `t${i}`, '--triaged', '--json']).stdout) as { ticket: { id: string } }).ticket.id);
    const codes = await Promise.all(ids.map((id, i) => slAsync(i, ['claim', id, '--paths', `src/f${i}.ts`, '--lease', '600'])));
    allOk(codes);
    expect(Object.keys(tokens()).sort()).toEqual([...ids].sort());
    // Concurrent releases forget only their own tokens.
    const rel = await Promise.all(ids.map((id, i) => slAsync(i, ['release', id])));
    allOk(rel);
    expect(tokens()).toEqual({});
    expect(readFileSync(join(data, 'cli-claims.json'), 'utf8')).not.toMatch(/token/);
  }, 180_000);

  it('a stale lock left by a crashed process is taken over', () => {
    const id = (JSON.parse(sl(0, ['create', 't', '--triaged', '--json']).stdout) as { ticket: { id: string } }).ticket.id;
    const lock = join(data, 'cli-claims.json.lock');
    writeFileSync(lock, 'crashed\n');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const r = sl(0, ['claim', id, '--paths', 'src/x.ts']);
    expect(r.status, r.stderr).toBe(0);
    expect(Object.keys(tokens())).toEqual([id]);
  }, 60_000);
});

describe('the token file lock and the claim it records (0.7.0 review)', () => {
  const idOf = (out: string) => (JSON.parse(out) as { ticket: { id: string } }).ticket.id;
  const claimOf = (id: string) => (JSON.parse(sl(0, ['show', id, '--json']).stdout) as { ticket: { claim: { holder: string } | null } }).ticket.claim;

  it('a live holder paused past the stale age keeps its lock: a concurrent claim waits, and both tokens survive', async () => {
    const id = idOf(sl(0, ['create', 't', '--triaged', '--json']).stdout);
    // A holder that takes the lock (owner record, file dated 60 s back as if paused that long), sleeps 3 s, then
    // writes what it read before the pause, unconditionally: the 0.6.1 lock took it over by age, so its write erased the claim's token.
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const fs = require('fs'), os = require('os'), path = require('path');
         const data = process.argv[1], lock = path.join(data, 'cli-claims.json.lock'), file = path.join(data, 'cli-claims.json');
         fs.mkdirSync(data, { recursive: true });
         const fd = fs.openSync(lock, 'wx');
         fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'paused-holder', at: new Date().toISOString() }));
         fs.closeSync(fd);
         const old = new Date(Date.now() - 60000);
         fs.utimesSync(lock, old, old);
         const claims = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).claims : {};
         process.stdout.write('ready\\n');
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
         claims.HOLDER = { token: 'h', actor: 'h', session: null, expires_at: '2099-01-01T00:00:00.000Z' };
         fs.writeFileSync(file + '.holder.tmp', JSON.stringify({ v: 1, claims }));
         fs.renameSync(file + '.holder.tmp', file);
         try { fs.unlinkSync(lock); } catch {}`,
        data,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const holderExit = new Promise<number | null>((resolve) => holder.on('exit', (c) => resolve(c)));
    await new Promise<void>((resolve) => holder.stdout.on('data', (d: Buffer) => d.toString().includes('ready') && resolve()));
    const r = await slAsync(0, ['claim', id]);
    expect(r.code, r.err).toBe(0);
    expect(await holderExit).toBe(0);
    expect(Object.keys(tokens()).sort()).toEqual([id, 'HOLDER'].sort());
    const rel = sl(0, ['release', id]);
    expect(rel.status, rel.stderr).toBe(0);
  }, 60_000);

  it('a claim whose token cannot be saved is rolled back: the claim and its token persist together or not at all', () => {
    const id = idOf(sl(0, ['create', 't', '--triaged', '--json']).stdout);
    mkdirSync(join(data, 'cli-claims.json')); // unwritable token file
    const r = sl(0, ['claim', id, '--paths', 'src/x.ts']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/could not save the CLI claim token .*the claim was rolled back \(released [0-9a-f]{8}\); nothing is held/);
    expect(r.stderr).not.toMatch(/\n\s+at /); // no stack trace
    expect(claimOf(id)).toBeNull();
    rmSync(join(data, 'cli-claims.json'), { recursive: true });
    // not held: anyone can take it, and the paths are free
    const other = sl(1, ['claim', id, '--paths', 'src/x.ts']);
    expect(other.status, other.stderr).toBe(0);
  }, 60_000);

  it('a lock dated in the future (clock skew) does not block claims until the timeout', () => {
    const id = idOf(sl(0, ['create', 't', '--triaged', '--json']).stdout);
    const lock = join(data, 'cli-claims.json.lock');
    writeFileSync(lock, '');
    const future = new Date(Date.now() + 5 * 60_000);
    utimesSync(lock, future, future);
    const t0 = Date.now();
    const r = sl(0, ['claim', id]);
    expect(r.status, r.stderr).toBe(0);
    expect(Date.now() - t0).toBeLessThan(25_000); // 0.6.1: 30 s, then wait_timeout with the ticket held and no token
    expect(Object.keys(tokens())).toEqual([id]);
    expect(sl(0, ['release', id]).status).toBe(0);
  }, 60_000);

  it('sixteen concurrent add-token runs store sixteen tokens', async () => {
    const N = 16;
    const rs = await Promise.all(Array.from({ length: N }, (_, i) => slAsync(i, ['add-token', '--actor', `actor${i}`])));
    allOk(rs);
    const actors = (JSON.parse(readFileSync(join(data, 'http-actors.json'), 'utf8')) as { actors: { actor: string }[] }).actors.map((a) => a.actor);
    expect(actors.sort()).toEqual(Array.from({ length: N }, (_, i) => `actor${i}`).sort());
    expect(readdirSync(data).filter((f) => f.includes('.tmp') || f.endsWith('.lock'))).toEqual([]);
  }, 180_000);
});

describe('SEA_LITE_DATA_DIR (0.7.0 review: it was ignored)', () => {
  const run = (args: string[], extra: Record<string, string>) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: repo, env: { PATH: process.env['PATH'] ?? '', HOME: base, ...extra } });
  const titles = (dir: string) =>
    (JSON.parse(run(['list', '--json', '--all-projects', '--data-dir', dir], {}).stdout) as { tickets: { title: string }[] }).tickets.map((t) => t.title);

  it('precedence: --data-dir > SEA_LITE_DATA_DIR > KRONICLE_LITE_DATA_DIR', () => {
    const viaSea = join(base, 'sea');
    const viaKl = join(base, 'kl');
    const viaFlag = join(base, 'flag');
    expect(run(['create', 'env', '--json'], { SEA_LITE_DATA_DIR: viaSea, KRONICLE_LITE_DATA_DIR: viaKl }).status).toBe(0);
    expect(run(['create', 'flag', '--json', '--data-dir', viaFlag], { SEA_LITE_DATA_DIR: viaSea, KRONICLE_LITE_DATA_DIR: viaKl }).status).toBe(0);
    expect(run(['create', 'kl', '--json'], { SEA_LITE_DATA_DIR: '', KRONICLE_LITE_DATA_DIR: viaKl }).status).toBe(0);
    expect(titles(viaSea)).toEqual(['env']);
    expect(titles(viaFlag)).toEqual(['flag']);
    expect(titles(viaKl)).toEqual(['kl']);
    expect((JSON.parse(run(['whoami', '--json'], { SEA_LITE_DATA_DIR: viaSea, KRONICLE_LITE_DATA_DIR: viaKl }).stdout) as { data_dir: string }).data_dir).toBe(viaSea);
  });

  it('the library reads it too when no dataDir is given', async () => {
    const { SeaLite } = await import('../src/store.js');
    const saved = { sea: process.env['SEA_LITE_DATA_DIR'], kl: process.env['KRONICLE_LITE_DATA_DIR'] };
    process.env['SEA_LITE_DATA_DIR'] = join(base, 'lib-sea');
    process.env['KRONICLE_LITE_DATA_DIR'] = join(base, 'lib-kl');
    try {
      const s = new SeaLite({ actor: 'x' });
      expect(s.kronicle.dataDir).toBe(join(base, 'lib-sea'));
      s.close();
    } finally {
      for (const [k, v] of [
        ['SEA_LITE_DATA_DIR', saved.sea],
        ['KRONICLE_LITE_DATA_DIR', saved.kl],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
