/**
 * C2-02 (0.6.1): CLI claim tokens live in one <data dir>/cli-claims.json that
 * 0.6.0 updated with an unlocked read-modify-write: 40 concurrent CLI claims
 * lost up to 34 tokens, so those releases failed and the paths stayed locked
 * until the leases lapsed. Updates now take an exclusive lock file.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
