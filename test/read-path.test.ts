/**
 * 0.7.1 hook latency: the read paths a hook calls on every edit (scope-check,
 * board's list) answer from a snapshot without the write lock, treat expired
 * leases as free instead of sweeping them, and the CLI loads the MCP SDK,
 * HTTP and doctor code only for the commands that use them.
 */

import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { EVENT } from '../src/core/events.js';
import { KL_ENTRY, KL_SLIM_ENTRY, loadKronicle } from '../src/core/kl.js';
import { SeaLite } from '../src/store.js';
import { cleanEnv, Clock, fresh } from './helpers.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

const dirs: string[] = [];
function tmp(prefix = 'sea-lite-read-path-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A file-backed store with one live scoped claim held by alice on src/. */
function seeded(): { data: string; ticket: string } {
  const data = join(tmp(), 'data');
  const s = new SeaLite({ dataDir: data, actor: 'alice' });
  const t = s.create({ title: 'held', body: 'b', kind: 'feature', priority: 'medium', tags: [], status: 'triaged', dry_run: false });
  s.claim({ ticket_ids: [t.ticket.id], scope: { paths: ['src'] }, lease_seconds: 3600 });
  s.close();
  return { data, ticket: t.ticket.id };
}

/** Another connection holding the write lock (BEGIN IMMEDIATE plus a pending write) around `fn`. */
function whileLocked<T>(data: string, fn: () => T): T {
  const holder = new Database(join(data, 'kronicle-lite.db'));
  holder.exec('BEGIN IMMEDIATE');
  holder.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('test-holder', '1')`).run();
  try {
    return fn();
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
}

const timed = <T>(fn: () => T): { ms: number; r: T } => {
  const t0 = performance.now();
  const r = fn();
  return { ms: performance.now() - t0, r };
};

describe('read paths take no write lock', () => {
  // A write would wait sea-lite's busy timeout (seconds) and then fail with wait_timeout; a WAL read does not wait.
  it('open + scope-check answer while another connection holds the write lock', () => {
    const { data } = seeded();
    const { ms, r } = whileLocked(data, () =>
      timed(() => {
        const s = new SeaLite({ dataDir: data, actor: 'bob' });
        try {
          return { free: s.scopeCheck({ paths: ['lib/a.ts'] }), busy: s.scopeCheck({ paths: ['src/a.ts'] }) };
        } finally {
          s.close();
        }
      }),
    );
    expect(r.free).toMatchObject({ ok: true, swept_expired: 0 });
    expect(r.busy.ok).toBe(false);
    expect(r.busy.conflicts[0]).toMatchObject({ holder: 'alice', held: ['src'] });
    expect(ms).toBeLessThan(300);
  });

  it("open + board's list + status counts answer while another connection holds the write lock", () => {
    const { data, ticket } = seeded();
    const { ms, r } = whileLocked(data, () =>
      timed(() => {
        const s = new SeaLite({ dataDir: data, actor: 'bob' });
        try {
          return { list: s.list({ include_terminal: false, limit: 200, view: 'compact', claimed: 'any' }), counts: s.statusCounts() };
        } finally {
          s.close();
        }
      }),
    );
    expect(r.list.tickets.map((t) => t.id)).toEqual([ticket]);
    expect(r.list.tickets[0]!.claim).toMatchObject({ holder: 'alice' });
    expect(r.counts.open).toBe(1);
    expect(ms).toBeLessThan(300);
  });

  it('CLI scope-check returns at once while another process holds the write lock for 6 s', async () => {
    const { data } = seeded();
    // Relative paths against this repository (as the scope-check CLI test does); alice's claim has no project, so it applies.
    const run = (path: string) => spawnSync(process.execPath, [CLI, 'scope-check', '--json', '--actor', 'bob', '--data-dir', data, path], { encoding: 'utf8', env: cleanEnv() });
    expect(run('lib/warm.ts').status).toBe(0); // first start (module cache) off the clock
    const base = timed(() => run('src/a.ts')).ms; // this machine's spawn cost with no lock held
    const HOLD_MS = 6000;
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const D=require('better-sqlite3');const db=new D(process.argv[1]);db.exec('BEGIN IMMEDIATE');` +
          `db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('test-holder', '1')").run();` +
          `process.stdout.write('locked\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${HOLD_MS});db.exec('ROLLBACK');db.close();`,
        join(data, 'kronicle-lite.db'),
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const exited = new Promise((ok) => holder.on('exit', ok));
    try {
      await new Promise<void>((ok, fail) => {
        holder.stdout.on('data', (b: Buffer) => b.toString().includes('locked') && ok());
        holder.on('exit', (c) => fail(new Error(`holder exited ${c} before locking`)));
      });
      const locked = timed(() => run('src/a.ts'));
      expect(locked.r.stderr).toBe('');
      expect(locked.r.status).toBe(1); // the conflict was read from the store under the lock
      expect(JSON.parse(locked.r.stdout)).toMatchObject({ ok: false, conflicts: [{ holder: 'alice', held: ['src'] }], swept_expired: 0 });
      // The lock adds nothing beyond noise: far below the 6 s hold (and cc-anchor's 4 s scope timeout).
      expect(locked.ms).toBeLessThan(base + 1000);
      expect(locked.ms).toBeLessThan(HOLD_MS / 2);
    } finally {
      holder.kill();
      await exited;
    }
  }, 30_000);
});

describe('expired leases on the read paths: free, not swept, swept by the next write', () => {
  it('scope-check does not report an expired claim as a conflict and chains nothing', () => {
    const { store, clock } = fresh();
    const a = store.create({ title: 'A', body: 'b', kind: 'bug', priority: 'high', tags: [], status: 'triaged', dry_run: false }).ticket.id;
    store.claim({ ticket_ids: [a], scope: { paths: ['src'] }, lease_seconds: 10, actor_id: 'alice' });
    expect(store.scopeCheck({ paths: ['src/a.ts'], actor_id: 'bob' }).ok).toBe(false);
    clock.advance(11);
    const before = store.chain.head().seq;
    expect(store.scopeCheck({ paths: ['src/a.ts'], actor_id: 'bob' })).toMatchObject({ ok: true, conflicts: [], swept_expired: 0 });
    expect(store.chain.head().seq).toBe(before);
    // The next write sweeps it (once), and bob can take the scope.
    store.claim({ ticket_ids: [a], scope: { paths: ['src'] }, actor_id: 'bob' });
    const types = [...store.chain.iterate()].map((e) => e.event_type);
    expect(types.filter((t) => t === EVENT.ticket_claim_expired)).toHaveLength(1);
  });

  it('list shows an expired claim as no claim and honours it in the claimed filter, without writing', () => {
    const clock = new Clock();
    const store = new SeaLite({ memory: true, actor: 'alice', now: clock.now });
    const mk = (title: string, lease: number) => {
      const id = store.create({ title, body: 'b', kind: 'bug', priority: 'high', tags: [], status: 'triaged', dry_run: false }).ticket.id;
      store.claim({ ticket_ids: [id], lease_seconds: lease });
      return id;
    };
    const lapsed = mk('lapsed', 10);
    const live = mk('live', 3600);
    const free = store.create({ title: 'free', body: 'b', kind: 'bug', priority: 'high', tags: [], status: 'triaged', dry_run: false }).ticket.id;
    clock.advance(11);
    const before = store.chain.head().seq;
    const ids = (claimed: 'any' | 'yes' | 'no' | 'mine') =>
      store
        .list({ include_terminal: false, claimed, limit: 50, view: 'compact' })
        .tickets.map((t) => t.id)
        .sort();
    const all = store.list({ include_terminal: false, claimed: 'any', limit: 50, view: 'full' });
    expect(all.swept_expired).toBe(0);
    expect(all.tickets.find((t) => t.id === lapsed)!.claim).toBeNull();
    expect(all.tickets.find((t) => t.id === live)!.claim).toMatchObject({ holder: 'alice' });
    expect(ids('yes')).toEqual([live]);
    expect(ids('mine')).toEqual([live]);
    expect(ids('no')).toEqual([lapsed, free].sort());
    expect(ids('any')).toEqual([lapsed, live, free].sort());
    expect(store.chain.head().seq).toBe(before);
    store.close();
  });
});

describe('the CLI loads only what a command needs', () => {
  /** A loader hook that fails any @modelcontextprotocol import made by sea-lite's own code (not by its dependencies). */
  function noMcpHook(): string {
    const d = tmp('sea-lite-hook-');
    const hooks = join(d, 'hooks.mjs');
    writeFileSync(
      hooks,
      `export async function resolve(specifier, context, next) {
        if (specifier.startsWith('@modelcontextprotocol/') && context.parentURL && !context.parentURL.includes('/node_modules/')) {
          throw new Error('sea-lite loaded ' + specifier + ' from ' + context.parentURL);
        }
        return next(specifier, context);
      }\n`,
    );
    const register = join(d, 'register.mjs');
    writeFileSync(register, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
    return pathToFileURL(register).href;
  }

  it('scope-check, board and heartbeat never import the MCP SDK; serve does', () => {
    const data = join(tmp(), 'data');
    const hook = noMcpHook();
    const run = (args: string[]) => spawnSync(process.execPath, ['--import', hook, CLI, ...args, '--data-dir', data], { encoding: 'utf8', env: { ...process.env, SEA_LITE_ACTOR: 'bob' } });
    for (const args of [['scope-check', '--json', 'src/a.ts'], ['board', '--json'], ['heartbeat', '--session', 's1'], ['--version']]) {
      const r = run(args);
      expect(r.stderr, args.join(' ')).toBe('');
      expect(r.status, args.join(' ')).toBe(0);
    }
    // Control: the hook does catch sea-lite's MCP imports (serve needs them).
    const serve = spawnSync(process.execPath, ['--import', hook, CLI, 'serve', '--data-dir', data], { encoding: 'utf8', input: '', timeout: 20_000 });
    expect(serve.status).not.toBe(0);
    expect(serve.stderr).toContain('sea-lite loaded @modelcontextprotocol/');
  }, 60_000);
});

describe('kronicle-lite entry: the slim one when installed, else the main one', () => {
  const fake = { KronicleLite: class {} };
  const notExported = Object.assign(new Error('no ./core'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });

  it('uses kronicle-lite/core when it resolves', async () => {
    const seen: string[] = [];
    const r = await loadKronicle(async (s) => (seen.push(s), fake));
    expect(r.entry).toBe(KL_SLIM_ENTRY);
    expect(seen).toEqual([KL_SLIM_ENTRY]);
  });

  it('falls back to the main entry when the installed kronicle-lite has no slim entry', async () => {
    const seen: string[] = [];
    const r = await loadKronicle(async (s) => {
      seen.push(s);
      if (s === KL_SLIM_ENTRY) throw notExported;
      return fake;
    });
    expect(r).toMatchObject({ entry: 'kronicle-lite', mod: fake });
    expect(seen).toEqual([KL_SLIM_ENTRY, 'kronicle-lite']);
  });

  it('does not hide a real failure of the slim entry behind the fallback', async () => {
    const broken = Object.assign(new Error('bad native module'), { code: 'ERR_DLOPEN_FAILED' });
    await expect(loadKronicle(async () => Promise.reject(broken))).rejects.toBe(broken);
  });

  it('loaded entry is the one the installed kronicle-lite offers, and composes with the main entry', async () => {
    let hasSlim = true;
    try {
      await import(KL_SLIM_ENTRY);
    } catch {
      hasSlim = false;
    }
    expect(KL_ENTRY).toBe(hasSlim ? KL_SLIM_ENTRY : 'kronicle-lite');
    const main = await import('kronicle-lite');
    const kl = new main.KronicleLite({ memory: true });
    const s = new SeaLite({ kronicle: kl, actor: 'alice' });
    expect(s.list({ include_terminal: false, claimed: 'any', limit: 5, view: 'compact' }).count).toBe(0);
    kl.close();
  });
});
