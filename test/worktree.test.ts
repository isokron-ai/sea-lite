/**
 * Worktree-bound claims (`scope.worktree`) and `release-worktree`.
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizeWorktreePath, sameWorktree } from '../src/core/scope.js';
import { SEA_SCHEMA_VERSION } from '../src/db/schema.js';
import { runDoctor } from '../src/doctor.js';
import { SeaLite } from '../src/store.js';
import { codeOf, fresh } from './helpers.js';
import { connectInMemory, parse } from './mcp-helpers.js';

function triaged(store: SeaLite, title: string, actor = 'alice'): string {
  return store.create({ title, body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged', dry_run: false, actor_id: actor }).ticket.id;
}

describe('normalizeWorktreePath', () => {
  it('normalizes POSIX, Windows drive and UNC spellings lexically', () => {
    expect(normalizeWorktreePath('/repo/wt-1/')).toBe('/repo/wt-1');
    expect(normalizeWorktreePath('/repo/./x/../wt-1//')).toBe('/repo/wt-1');
    expect(normalizeWorktreePath('C:\\Repo\\wt-1\\')).toBe('c:/Repo/wt-1');
    expect(normalizeWorktreePath('c:/Repo/wt-1')).toBe('c:/Repo/wt-1');
    expect(normalizeWorktreePath('\\\\host\\share\\wt')).toBe('//host/share/wt');
    expect(normalizeWorktreePath('/')).toBe('/');
    expect(codeOf(() => normalizeWorktreePath('wt-1'))).toBe('invalid_input');
    expect(codeOf(() => normalizeWorktreePath('..\\wt'))).toBe('invalid_input');
    expect(codeOf(() => normalizeWorktreePath('//host'))).toBe('invalid_input');
  });

  it('compares Windows-style paths case-insensitively, POSIX paths exactly', () => {
    expect(sameWorktree('c:/Repo/WT', 'c:/repo/wt')).toBe(true);
    expect(sameWorktree('//Host/Share/x', '//host/share/X')).toBe(true);
    expect(sameWorktree('/Repo/wt', '/repo/wt')).toBe(false);
  });
});

describe('worktree-bound claims', () => {
  it('a claim may bind a worktree with or without paths; get/list/claim report it; the payload carries it only when set', () => {
    const { store } = fresh();
    const a = triaged(store, 'a');
    const b = triaged(store, 'b');
    const r = store.claim({ ticket_ids: [a], scope: { worktree: '/work/repo-wt-a/' } });
    expect(r).toMatchObject({ scope: null, worktree: '/work/repo-wt-a' });
    expect(store.get({ id: a }).ticket.claim).toMatchObject({ scope: null, worktree: '/work/repo-wt-a' });
    const r2 = store.claim({ ticket_ids: [b], scope: { paths: ['src'], worktree: 'C:\\work\\wt-b' } });
    expect(r2).toMatchObject({ scope: { paths: ['src'] }, worktree: 'c:/work/wt-b' });
    const listed = store.list({ include_terminal: false, claimed: 'mine', limit: 50, view: 'compact' });
    expect(listed.tickets.map((t) => t.claim?.worktree).sort()).toEqual(['/work/repo-wt-a', 'c:/work/wt-b']);

    const events = store.history({ limit: 100, verify: false }).events.filter((e) => e.event_type === 'sea_ticket.claimed');
    expect(events.map((e) => e.payload['worktree'])).toEqual(['/work/repo-wt-a', 'c:/work/wt-b']);
    const c = triaged(store, 'c');
    store.claim({ ticket_ids: [c] });
    const unbound = store.history({ ticket_id: c, limit: 10, verify: false }).events.find((e) => e.event_type === 'sea_ticket.claimed')!;
    expect('worktree' in unbound.payload).toBe(false); // unbound claims keep the 0.2.0 payload byte for byte
    store.close();
  });

  it('a worktree-only scope locks no paths; an empty scope is refused', () => {
    const { store } = fresh();
    const a = triaged(store, 'a');
    const b = triaged(store, 'b', 'bob');
    store.claim({ ticket_ids: [a], scope: { worktree: '/w/a' } });
    expect(store.claim({ ticket_ids: [b], scope: { paths: ['.'] }, actor_id: 'bob' }).scope).toEqual({ paths: ['.'] });
    expect(codeOf(() => store.claim({ ticket_ids: [a], scope: {} }))).toBe('invalid_input');
    expect(codeOf(() => store.claim({ ticket_ids: [a], scope: { worktree: 'relative/wt' } }))).toBe('invalid_input');
    store.close();
  });

  it('sea_next binds the worktree too, and terminal transition / release clear it', () => {
    const { store } = fresh();
    const a = triaged(store, 'a');
    const n = store.next({ include_unassigned: true, scope: { worktree: '/w/next' } });
    expect(n.ticket?.id).toBe(a);
    expect(n.ticket?.claim?.worktree).toBe('/w/next');
    store.release({ ticket_id: a, claim_token: n.claim_token!, force: false });
    const row = store.db.prepare(`SELECT claim_worktree FROM sea_tickets WHERE id = ?`).get(a) as { claim_worktree: string | null };
    expect(row.claim_worktree).toBeNull();
    store.close();
  });

  it('release-worktree frees every live claim bound to it (any holder, any spelling) and nothing else', () => {
    const { store, clock } = fresh();
    const a = triaged(store, 'a');
    const b = triaged(store, 'b', 'bob');
    const c = triaged(store, 'c', 'carol');
    const d = triaged(store, 'd');
    store.claim({ ticket_ids: [a], scope: { paths: ['src'], worktree: 'C:\\Work\\WT' } });
    store.claim({ ticket_ids: [b], scope: { worktree: 'c:/work/wt' }, actor_id: 'bob' });
    store.claim({ ticket_ids: [c], scope: { worktree: 'c:/work/other' }, actor_id: 'carol' });
    store.claim({ ticket_ids: [d], lease_seconds: 5, scope: { worktree: 'c:/work/wt/' } });
    clock.advance(10); // d's lease lapses

    const r = store.as('hook').releaseWorktree({ worktree: 'C:/WORK/wt' });
    expect(r.worktree).toBe('c:/WORK/wt');
    expect(r.released.map((x) => [x.ticket_id, x.holder]).sort()).toEqual([[a, 'alice'], [b, 'bob']].sort());
    expect(r.expired).toEqual([{ ticket_id: d, holder: 'alice' }]);
    expect(store.get({ id: a }).ticket.claim).toBeNull();
    expect(store.get({ id: b }).ticket.claim).toBeNull();
    expect(store.get({ id: c }).ticket.claim?.holder).toBe('carol');
    // The scope went with the claim: bob may now lock src.
    expect(store.claim({ ticket_ids: [b], scope: { paths: ['src'] }, actor_id: 'bob' }).scope).toEqual({ paths: ['src'] });

    const rel = store.history({ ticket_id: a, limit: 50, verify: true });
    expect(rel.chain.verified).toBe(true);
    const ev = rel.events.find((e) => e.event_type === 'sea_ticket.claim_released')!;
    expect(ev.actor_id).toBe('hook');
    expect(ev.payload).toMatchObject({ claim_actor: 'alice', via: 'release_worktree', worktree: 'c:/Work/WT', reason: 'worktree removed' });
    const stats = Object.fromEntries(store.stats({}).actors.map((x) => [x.actor, x]));
    expect(stats['alice']).toMatchObject({ released: 1, expired: 1 });
    expect(stats['bob']).toMatchObject({ released: 1 });
    expect(store.releaseWorktree({ worktree: '/nothing/here' }).released).toEqual([]);
    store.close();
  });

  it('rebuild restores the binding from the chain', () => {
    const { store } = fresh();
    const a = triaged(store, 'a');
    store.claim({ ticket_ids: [a], scope: { paths: ['lib'], worktree: '/w/rb' } });
    const before = store.get({ id: a }).ticket;
    store.rebuild();
    expect(store.get({ id: a }).ticket).toEqual(before);
    store.close();
  });

  it('a v2 store gains claim_worktree additively on open (schema v3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sea-wt-mig-'));
    try {
      const s1 = new SeaLite({ dataDir: dir });
      const id = triaged(s1, 'old');
      s1.close();
      const db = new Database(join(dir, 'kronicle-lite.db'));
      db.exec(`ALTER TABLE sea_tickets DROP COLUMN claim_worktree`);
      db.prepare(`UPDATE meta SET value = '2' WHERE key = 'sea_schema_version'`).run();
      db.close();
      const s2 = new SeaLite({ dataDir: dir });
      const cols = (s2.db.prepare(`PRAGMA table_info(sea_tickets)`).all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain('claim_worktree');
      expect((s2.db.prepare(`SELECT value FROM meta WHERE key = 'sea_schema_version'`).get() as { value: string }).value).toBe(String(SEA_SCHEMA_VERSION));
      expect(s2.claim({ ticket_ids: [id], scope: { worktree: '/w/m' } }).worktree).toBe('/w/m');
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('over MCP: sea_claim takes scope.worktree and sea_get reports it', async () => {
    const { store } = fresh();
    const a = triaged(store, 'a');
    const { client, close } = await connectInMemory(store);
    const r = parse<{ worktree: string }>(await client.callTool({ name: 'sea_claim', arguments: { ticket_ids: [a], scope: { worktree: '/w/mcp' } } }));
    expect(r.worktree).toBe('/w/mcp');
    const g = await client.callTool({ name: 'sea_get', arguments: { id: a } });
    expect((g.structuredContent as { ticket: { claim: { worktree: string } } }).ticket.claim.worktree).toBe('/w/mcp');
    await close();
    store.close();
  });

  it('`sea-lite release-worktree` takes a path or --hook JSON on stdin; doctor flags claims on a vanished worktree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sea-wt-cli-'));
    const wt = join(dir, 'wt-1');
    const gone = join(dir, 'wt-gone');
    mkdirSync(wt);
    try {
      const store = new SeaLite({ dataDir: dir, actor: 'alice' });
      const a = triaged(store, 'a');
      const b = triaged(store, 'b');
      store.claim({ ticket_ids: [a], scope: { worktree: wt } });
      store.claim({ ticket_ids: [b], scope: { worktree: gone } });
      store.close();

      const doc = await runDoctor({ dataDir: dir, cwd: process.cwd() });
      const claims = doc.checks.find((c) => c.id === 'claims')!;
      expect(claims.status).toBe('warn');
      expect(claims.detail).toMatch(/no longer exists/);

      const CLI = join(process.cwd(), 'dist', 'cli.js');
      const out = JSON.parse(
        execFileSync(process.execPath, [CLI, 'release-worktree', wt, '--data-dir', dir, '--actor', 'hook', '--json'], { encoding: 'utf8' }),
      ) as { released: { ticket_id: string }[] };
      expect(out.released.map((x) => x.ticket_id)).toEqual([a]);
      const text = execFileSync(process.execPath, [CLI, 'release-worktree', '--hook', '--data-dir', dir], {
        encoding: 'utf8',
        input: JSON.stringify({ hook_event_name: 'WorktreeRemove', worktree_path: gone }),
      });
      expect(text).toMatch(/1 claim\(s\) released/);
      const after = new SeaLite({ dataDir: dir });
      expect(after.get({ id: b }).ticket.claim).toBeNull();
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe('Windows path spellings', () => {
  it('backslash scope paths lock and conflict exactly like forward-slash ones', () => {
    const { store } = fresh();
    const a = triaged(store, 'a');
    const b = triaged(store, 'b', 'bob');
    expect(store.claim({ ticket_ids: [a], scope: { paths: ['src\\handlers\\', 'docs\\*.md'], worktree: 'D:\\wt\\a' } })).toMatchObject({
      scope: { paths: ['docs/*.md', 'src/handlers'] },
      worktree: 'd:/wt/a',
    });
    expect(codeOf(() => store.claim({ ticket_ids: [b], scope: { paths: ['src/handlers/claims.ts'] }, actor_id: 'bob' }))).toBe('scope_conflict');
    expect(store.scopeCheck({ paths: ['docs\\README.md'], actor_id: 'bob' }).ok).toBe(false);
    expect(store.scopeCheck({ paths: ['lib\\x.ts'], actor_id: 'bob' }).ok).toBe(true);
    store.close();
  });
});
