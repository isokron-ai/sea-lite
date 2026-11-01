/**
 * B1 (0.4.0): two Claude Code sessions that run sea-lite under the SAME actor
 * label must still collide-protect each other. A claim records the holder's
 * session; ownership is actor AND session. Same session re-claiming stays
 * idempotent; legacy (session-less) callers keep the old actor-only rule.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { EVENT } from '../src/core/events.js';
import { holderLabel, listInstances, pidAlive, registerInstance, resolveIdentity, sameOwner, shortSession } from '../src/core/identity.js';
import { SeaLite } from '../src/store.js';
import { Clock, codeOf } from './helpers.js';
import { parse } from './mcp-helpers.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

/** Remove a temp dir; Windows may hold a just-closed SQLite file for a moment, hence the retries. */
function removeDir(d: string): void {
  rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function two(dir: string, clock: Clock, a = 'sess-A', b = 'sess-B') {
  const A = new SeaLite({ dataDir: dir, actor: 'claude', session: a, project: 'proj', now: clock.now });
  const B = new SeaLite({ dataDir: dir, actor: 'claude', session: b, project: 'proj', now: clock.now });
  return { A, B };
}

describe('per-session identity (B1)', () => {
  let dir: string | undefined;
  afterEach(() => {
    // Every SeaLite a test opens is closed in its own finally (an open handle is EBUSY on Windows).
    if (dir) removeDir(dir);
    dir = undefined;
  });

  it('same actor, different sessions: scopes conflict, tickets are already_claimed, scope_check says no', () => {
    dir = mkdtempSync(join(tmpdir(), 'sea-id-'));
    const clock = new Clock();
    const { A, B } = two(dir, clock);
    try {
      const t1 = A.create({ title: 'Add rate limiting', body: '', kind: 'feature', priority: 'high', tags: [], status: 'triaged', dry_run: false });
      const t2 = A.create({ title: 'Fix session expiry', body: '', kind: 'bug', priority: 'high', tags: [], status: 'triaged', dry_run: false });
      const a = A.next({ include_unassigned: true, scope: { paths: ['src/auth'] } });
      expect(a.ticket?.id).toBe(t1.ticket.id);
      expect(a.ticket?.claim).toMatchObject({ holder: 'claude', session: 'sess-A' });

      // The audit repro: session 2 with the same `--actor claude` used to get T2 and src/auth with no conflict.
      expect(codeOf(() => B.next({ include_unassigned: true, scope: { paths: ['src/auth'] } }))).toBe('scope_conflict');
      const check = B.scopeCheck({ paths: ['src/auth/login.ts'] });
      expect(check.ok).toBe(false);
      expect(check.conflicts[0]).toMatchObject({ ticket_id: t1.ticket.id, holder: 'claude', holder_session: 'sess-A', title: 'Add rate limiting' });
      expect(check.conflicts[0]!.holder_label).toBe('claude#sessA');
      expect(codeOf(() => B.claim({ ticket_ids: [t1.ticket.id] }))).toBe('already_claimed');

      // Disjoint work is fine.
      const b = B.next({ include_unassigned: true, scope: { paths: ['src/billing'] } });
      expect(b.ticket?.id).toBe(t2.ticket.id);
      // And session A now sees B's scope as foreign.
      expect(A.scopeCheck({ paths: ['src/billing/x.ts'] }).ok).toBe(false);
      expect(A.scopeCheck({ paths: ['src/auth/x.ts'] }).ok).toBe(true);
    } finally {
      A.close();
      B.close();
    }
  });

  it('the same session re-claiming is idempotent (rotation, its own scope never conflicts), even from another process', () => {
    dir = mkdtempSync(join(tmpdir(), 'sea-id-'));
    const clock = new Clock();
    const { A, B } = two(dir, clock);
    const A2 = new SeaLite({ dataDir: dir, actor: 'claude', session: 'sess-A', project: 'proj', now: clock.now });
    try {
      const t = A.create({ title: 'x', body: '', kind: 'bug', priority: 'high', tags: [], status: 'triaged', dry_run: false });
      A.claim({ ticket_ids: [t.ticket.id], scope: { paths: ['src/auth'] } });
      const again = A2.claim({ ticket_ids: [t.ticket.id], scope: { paths: ['src/auth'] } });
      expect(again.claims[0]!.rotated).toBe(true);
      expect(A2.scopeCheck({ paths: ['src/auth/login.ts'] }).ok).toBe(true);
      expect(A2.list({ claimed: 'mine', include_terminal: false, limit: 50, view: 'compact' }).count).toBe(1);
    } finally {
      A.close();
      B.close();
      A2.close();
    }
  });

  it('claimed: "mine" means this session, not just this label', () => {
    dir = mkdtempSync(join(tmpdir(), 'sea-id-'));
    const clock = new Clock();
    const { A, B } = two(dir, clock);
    try {
      const t = A.create({ title: 'x', body: '', kind: 'bug', priority: 'high', tags: [], status: 'triaged', dry_run: false, claim_seconds: 60 });
      expect(t.ticket.claim?.session).toBe('sess-A');
      expect(A.list({ claimed: 'mine', include_terminal: false, limit: 50, view: 'compact' }).count).toBe(1);
      expect(B.list({ claimed: 'mine', include_terminal: false, limit: 50, view: 'compact' }).count).toBe(0);
    } finally {
      A.close();
      B.close();
    }
  });

  it('chain compatibility: the session is an additive payload field, absent for session-less callers; rebuild restores it', () => {
    dir = mkdtempSync(join(tmpdir(), 'sea-id-'));
    const clock = new Clock();
    const legacy = new SeaLite({ dataDir: dir, actor: 'old', now: clock.now });
    const { A, B } = two(dir, clock);
    try {
      const l = legacy.create({ title: 'legacy', body: '', kind: 'bug', priority: 'high', tags: [], status: 'triaged', dry_run: false });
      legacy.claim({ ticket_ids: [l.ticket.id], scope: { paths: ['lib'] } });
      const t = A.create({ title: 'new', body: '', kind: 'bug', priority: 'high', tags: [], status: 'triaged', dry_run: false });
      A.claim({ ticket_ids: [t.ticket.id], scope: { paths: ['src'] } });
      const claimed = [...A.chain.iterate()].filter((e) => e.event_type === EVENT.ticket_claimed);
      expect(Object.keys(claimed[0]!.payload)).not.toContain('claim_session');
      expect(claimed[1]!.payload['claim_session']).toBe('sess-A');
      expect(A.chain.verify().ok).toBe(true);
      const before = A.get({ id: t.ticket.id }).ticket.claim;
      A.rebuild();
      expect(A.get({ id: t.ticket.id }).ticket.claim).toEqual(before);
      expect(legacy.get({ id: l.ticket.id }).ticket.claim?.session).toBeNull();
      // A session-less caller with the legacy label still owns its legacy claim.
      expect(legacy.scopeCheck({ paths: ['lib/x.ts'] }).ok).toBe(true);
    } finally {
      legacy.close();
      A.close();
      B.close();
    }
  });

  it('helpers: holder labels and ownership', () => {
    expect(holderLabel('claude', '725eab64-3792-554d')).toBe('claude#725eab64');
    expect(holderLabel('claude', null)).toBe('claude');
    expect(shortSession('inst-0a1b2c3d')).toBe('0a1b2c3d');
    expect(sameOwner('claude', 's1', { actor: 'claude', session: 's1' })).toBe(true);
    expect(sameOwner('claude', 's1', { actor: 'claude', session: 's2' })).toBe(false);
    expect(sameOwner('claude', null, { actor: 'claude', session: null })).toBe(true);
    expect(sameOwner('claude', null, { actor: 'claude', session: 's1' })).toBe(false);
  });
});

describe('session registry: hooks find their server', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sea-reg-'));
  });
  afterAll(() => removeDir(dir));

  describe('a server spawned by a stand-in Claude Code process', () => {
    let parent: ChildProcess | undefined;
    let serverPid = 0;

    /**
     * Stop the stand-in and its server and wait until both are gone. On POSIX
     * the stand-in's SIGTERM handler kills its child; on Windows kill() ends the
     * stand-in outright (no handler runs) and the child would outlive it, so the
     * server is also killed by pid.
     */
    async function stop(): Promise<void> {
      const p = parent;
      if (p && p.exitCode === null && p.signalCode === null) {
        const exited = new Promise((r) => p.once('exit', r));
        p.kill('SIGTERM');
        await exited;
      }
      if (serverPid > 0 && pidAlive(serverPid)) {
        try {
          process.kill(serverPid);
        } catch {
          // exited in between
        }
      }
      for (let i = 0; i < 50 && serverPid > 0 && pidAlive(serverPid); i++) await new Promise((r) => setTimeout(r, 100));
    }

    beforeAll(async () => {
      const fake = join(dir, 'fake-claude.mjs');
      // import() takes a URL: a bare Windows path (`D:\a\…`) reads as scheme `d:` and is refused.
      const index = pathToFileURL(join(process.cwd(), 'dist', 'index.js')).href;
      writeFileSync(
        fake,
        `import { spawn } from 'node:child_process';
         const child = spawn(process.execPath, ['-e', ${JSON.stringify(
           `import(${JSON.stringify(index)}).then(m => { m.registerInstance(${JSON.stringify(dir)}, { actor: 'claude', session: 'spawned-sid', claude_session: 'spawned-sid', project: null }); console.log('ready ' + process.pid); setInterval(() => {}, 1000); })`,
         )}], { stdio: ['ignore', 'inherit', 'inherit'] });
         process.on('SIGTERM', () => { child.kill(); process.exit(0); });
         setInterval(() => {}, 1000);`,
      );
      const p = spawn(process.execPath, [fake], { stdio: ['ignore', 'pipe', 'inherit'] });
      parent = p;
      serverPid = await new Promise<number>((res, rej) => {
        let out = '';
        const timer = setTimeout(() => rej(new Error('server did not register')), 10_000);
        p.stdout!.on('data', (d: Buffer) => {
          out += d.toString();
          const m = /ready (\d+)/.exec(out);
          if (m) {
            clearTimeout(timer);
            res(Number(m[1]));
          }
        });
        p.once('exit', (code) => {
          clearTimeout(timer);
          rej(new Error(`the stand-in exited (${String(code)}) before its server registered`));
        });
      });
    }, 15_000);
    afterAll(stop, 15_000);

    it('lists the live server', () => {
      expect(listInstances(dir).map((e) => e.session)).toEqual(['spawned-sid']);
      expect(listInstances(dir)[0]!.pid).toBe(serverPid);
    });

    it('resolves by session key; an unknown key falls back to itself; no key means no session', () => {
      const byKey = resolveIdentity({ dataDir: dir, session: 'spawned-sid', env: {} });
      expect(byKey).toMatchObject({ actor: 'claude', session: 'spawned-sid', source: 'registry:key' });
      const elsewhere = resolveIdentity({ dataDir: dir, session: 'other-sid', env: { CLAUDE_PID: '999999' }, defaultActor: 'me' });
      expect(elsewhere).toMatchObject({ actor: 'me', session: 'other-sid', source: 'flag', instance: null });
      const nothing = resolveIdentity({ dataDir: dir, env: { SEA_LITE_ACTOR: 'alice' } });
      expect(nothing).toMatchObject({ actor: 'alice', session: null });
    });

    // Windows has no process-tree lookup (core/identity.ts parentOf returns null there by design),
    // so the CLAUDE_PID join after /clear is POSIX-only; the session-key lookup above covers Windows.
    it.skipIf(process.platform === 'win32')('after /clear, CLAUDE_PID ancestry joins the hook to its server (POSIX only: no process-tree lookup on Windows)', () => {
      const afterClear = resolveIdentity({ dataDir: dir, session: 'new-sid-after-clear', env: { CLAUDE_PID: String(parent!.pid) } });
      expect(afterClear).toMatchObject({ actor: 'claude', session: 'spawned-sid', source: 'registry:claude_pid' });
    });

    it('prunes the entry once the server is gone', async () => {
      await stop();
      expect(pidAlive(serverPid)).toBe(false);
      // The server is gone: its entry is pruned on the next read.
      for (let i = 0; i < 50 && listInstances(dir).length > 0; i++) await new Promise((r) => setTimeout(r, 100));
      expect(listInstances(dir)).toEqual([]);
      expect(readdirSync(join(dir, 'sessions')).filter((n) => n.endsWith('.json'))).toEqual([]);
    }, 15_000);
  });

  it('registerInstance writes 0600 and unregister removes it', () => {
    const r = registerInstance(dir, { actor: 'x', session: 'reg-test', claude_session: null, project: 'p' });
    expect(r.file).not.toBeNull();
    expect(existsSync(r.file!)).toBe(true);
    expect(listInstances(dir).some((e) => e.session === 'reg-test' && e.pid === process.pid)).toBe(true);
    r.unregister();
    expect(existsSync(r.file!)).toBe(false);
  });
});

describe('two real `sea-lite serve --actor claude` processes (the audit repro, end to end)', () => {
  let dir: string;
  let repo: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sea-e2e-'));
    repo = mkdtempSync(join(tmpdir(), 'sea-e2e-repo-'));
    spawnSync('git', ['init', '-q', repo]);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(repo, { recursive: true, force: true });
  });

  async function session(sid: string): Promise<{ client: Client; close: () => Promise<void> }> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PROJECT_DIR: repo };
    delete env['SEA_LITE_SESSION'];
    delete env['SEA_LITE_ACTOR'];
    delete env['SEA_LITE_PROJECT'];
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'serve', '--data-dir', dir, '--actor', 'claude'], env, stderr: 'ignore' });
    const client = new Client({ name: `t-${sid}`, version: '0' });
    await client.connect(transport);
    return { client, close: () => client.close() };
  }

  it('session 2 is refused src/auth; the hook CLI denies session 2 and allows session 1', async () => {
    const s1 = await session('11111111-aaaa');
    const s2 = await session('22222222-bbbb');
    try {
      await s1.client.callTool({ name: 'sea_create', arguments: { title: 'T1', status: 'triaged' } });
      await s1.client.callTool({ name: 'sea_create', arguments: { title: 'T2', status: 'triaged' } });
      const n1 = parse<{ ticket: { title: string; claim: { holder: string; session: string } } }>(
        await s1.client.callTool({ name: 'sea_next', arguments: { scope: { paths: ['src/auth'] } } }),
      );
      expect(n1.ticket.claim).toMatchObject({ holder: 'claude', session: '11111111-aaaa' });
      const n2 = await s2.client.callTool({ name: 'sea_next', arguments: { scope: { paths: ['src/auth'] } } });
      expect(n2.isError).toBe(true);
      expect(parse<{ error: string }>(n2).error).toBe('scope_conflict');
      const c2 = parse<{ ok: boolean }>(await s2.client.callTool({ name: 'sea_scope_check', arguments: { paths: ['src/auth/login.ts'] } }));
      expect(c2.ok).toBe(false);

      const hook = (sid: string) =>
        spawnSync(process.execPath, [CLI, 'scope-check', '--json', '--data-dir', dir, '--session', sid, join(repo, 'src/auth/login.ts')], {
          encoding: 'utf8',
          cwd: repo,
          env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
        });
      const deny = hook('22222222-bbbb');
      expect(deny.status).toBe(1);
      expect(JSON.parse(deny.stdout)).toMatchObject({ ok: false, identity: { actor: 'claude', session: '22222222-bbbb' }, conflicts: [{ holder: 'claude', holder_session: '11111111-aaaa' }] });
      const allow = hook('11111111-aaaa');
      expect(allow.status).toBe(0);
      expect(JSON.parse(allow.stdout)).toMatchObject({ ok: true, paths: ['src/auth/login.ts'] });
    } finally {
      await s1.close();
      await s2.close();
    }
  }, 30_000);
});
