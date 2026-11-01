/**
 * Path-scoped claims: the overlap rule (prefix / glob / none), the
 * scope_conflict error shape, expiry and release freeing a scope, rebuild
 * restoring it from the chain, the sea_scope_check hot path, the additive
 * column migration, the CLI subcommand and the MCP round-trip.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EVENT } from '../src/core/events.js';
import { entriesOverlap, findOverlaps, isGlobEntry, looksLikeFile, normalizeScope, normalizeScopePath } from '../src/core/scope.js';
import { SEA_SCHEMA_META_KEY, SEA_SCHEMA_VERSION } from '../src/db/schema.js';
import { ensureSeaSchema, SeaLite } from '../src/store.js';
import { claimedTicket, codeOf, fresh } from './helpers.js';
import { connectInMemory, parse, type ToolResult } from './mcp-helpers.js';

function triaged(store: SeaLite, title: string, actor = 'alice'): string {
  return store.create({ title, body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged', dry_run: false, actor_id: actor }).ticket.id;
}

describe('scope normalization', () => {
  it('normalizes separators, dots, duplicates and sorts', () => {
    expect(normalizeScopePath('./src//handlers/')).toBe('src/handlers');
    expect(normalizeScopePath('src\\handlers\\claims.ts')).toBe('src/handlers/claims.ts');
    expect(normalizeScopePath('src/./a/./b')).toBe('src/a/b');
    expect(normalizeScopePath('')).toBe('.');
    expect(normalizeScopePath('.')).toBe('.');
    expect(normalizeScopePath('./')).toBe('.');
    expect(normalizeScope(['src/b', 'src/a', 'src/b/', './src/a'])).toEqual(['src/a', 'src/b']);
    expect(normalizeScope(['src', '.', 'docs'])).toEqual(['.']); // whole repo swallows the rest
  });

  it('keeps a trailing slash only where it says a file-looking name is a directory', () => {
    expect(normalizeScopePath('src/')).toBe('src');
    expect(normalizeScopePath('next.js/')).toBe('next.js/');
    expect(normalizeScopePath('src/**/')).toBe('src/**');
    expect(looksLikeFile('src/handlers/claims.ts')).toBe(true);
    expect(looksLikeFile('.env.local')).toBe(true);
    expect(looksLikeFile('README.md')).toBe(true);
    expect(looksLikeFile('.github')).toBe(false);
    expect(looksLikeFile('src/handlers')).toBe(false);
    expect(looksLikeFile('next.js/')).toBe(false);
  });

  it('rejects absolute paths, parent traversal, negation and empty sets', () => {
    expect(codeOf(() => normalizeScopePath('/etc/passwd'))).toBe('invalid_input');
    expect(codeOf(() => normalizeScopePath('C:\\repo\\src'))).toBe('invalid_input');
    expect(codeOf(() => normalizeScopePath('src/../../x'))).toBe('invalid_input');
    expect(codeOf(() => normalizeScopePath('!src/**'))).toBe('invalid_input');
    expect(codeOf(() => normalizeScope([]))).toBe('invalid_input');
    expect(codeOf(() => normalizeScope(Array.from({ length: 65 }, (_, i) => `p${i}`)))).toBe('invalid_input');
  });

  it('classifies globs by metacharacters, leaving route groups like app/(auth) literal', () => {
    expect(isGlobEntry('src/**/*.ts')).toBe(true);
    expect(isGlobEntry('docs/*.md')).toBe(true);
    expect(isGlobEntry('src/[ab].ts')).toBe(true);
    expect(isGlobEntry('src/{a,b}.ts')).toBe(true);
    expect(isGlobEntry('src/handlers')).toBe(false);
    expect(isGlobEntry('app/(auth)/page.tsx')).toBe(false);
  });
});

describe('overlap matrix', () => {
  const cases: [string, string, boolean, string][] = [
    // prefix vs prefix
    ['src', 'src', true, 'identical'],
    ['src', 'src/handlers', true, 'parent and child'],
    ['src/handlers/claims.ts', 'src', true, 'file under a dir (symmetric)'],
    ['src', 'src2', false, 'sibling with shared string prefix is not a path prefix'],
    ['src/handlers', 'src/handlers2', false, 'segment boundaries matter'],
    ['src/a', 'src/b', false, 'siblings'],
    ['README.md', 'README.md', true, 'same file'],
    ['README.md', 'README', false, 'different files'],
    // whole repo
    ['.', 'anything/at/all', true, 'whole repo overlaps everything'],
    ['**', 'src/x.ts', true, 'globstar alone is the whole repo'],
    ['.', '.', true, 'two whole-repo claims'],
    // prefix vs glob
    ['src', 'src/**/*.ts', true, 'glob inside the prefix subtree'],
    ['src/handlers', 'src/**/*.ts', true, 'glob reaches beneath a deeper prefix'],
    ['src/handlers/claims.ts', 'src/**/*.ts', true, 'file matched by glob'],
    ['src/handlers/claims.ts', 'src/**/*.md', false, 'file not matched by glob'],
    ['src/handlers', 'src/*.ts', false, '* does not cross a slash'],
    ['src/a.ts', 'src/*.ts', true, 'direct child matched'],
    ['src/handlers', 'src/*', true, 'src/* names the entry src/handlers itself (cannot tell a dir from a file)'],
    ['src/handlers/claims.ts', 'src/handlers/claims.ts/x', false, 'nothing lies beneath a file'],
    ['src/handlers/claims.ts', 'src/handlers/**/*.ts', true, 'file under a globstar'],
    ['next.js', 'next.js/**/*.ts', false, 'a dotted name reads as a file unless marked'],
    ['next.js/', 'next.js/**/*.ts', true, 'trailing slash marks a directory'],
    ['.github', '.github/workflows/ci.yml', true, 'dot-leading names are directories'],
    ['.github', '**/*.yml', true, 'globstar can reach beneath'],
    ['src/handlers', 'src/**', true, 'src/** is the subtree'],
    ['lib', 'src/**', false, 'disjoint roots'],
    ['docs/guide.md', 'docs/*.md', true, 'glob matches'],
    ['docs/guide.md', 'docs/?uide.md', true, '? matches one char'],
    ['docs/guide.md', 'docs/[gh]uide.md', true, 'class matches'],
    ['docs/guide.md', 'docs/{guide,intro}.md', true, 'brace matches'],
    ['docs/other.md', 'docs/{guide,intro}.md', false, 'brace miss'],
    ['src/.env', 'src/*', true, 'dotfiles are covered (dot: true)'],
    // glob vs glob
    ['src/**/*.ts', 'src/**/*.ts', true, 'identical globs'],
    ['src/**/*.ts', 'src/**/*.md', false, 'disjoint extensions'],
    ['src/**/*.ts', 'src/**/*.test.ts', true, '*.ts can match a *.test.ts file'],
    ['src/*.ts', 'src/**/*.ts', true, 'shallow glob within deep glob'],
    ['src/*.ts', 'lib/**/*.ts', false, 'different roots'],
    ['src/*', 'src/a/*', false, 'different depths, no globstar'],
    ['**/*.ts', 'src/handlers/x.ts', true, 'leading globstar'],
    ['**/*.ts', 'docs/*.md', false, 'leading globstar, disjoint extension'],
    ['src/foo*', 'src/bar*', false, 'disjoint literal heads'],
    ['src/foo*', 'src/foobar*', true, 'compatible literal heads'],
  ];
  for (const [a, b, expected, why] of cases) {
    it(`${a} vs ${b} → ${expected} (${why})`, () => {
      expect(entriesOverlap(a, b)).toBe(expected);
      expect(entriesOverlap(b, a)).toBe(expected); // symmetric
    });
  }

  it('findOverlaps lists every overlapping pair', () => {
    expect(findOverlaps(['src/handlers', 'docs/x.md'], ['src/**/*.ts', 'lib', 'docs/*.md'])).toEqual([
      { requested: 'src/handlers', held: 'src/**/*.ts' },
      { requested: 'docs/x.md', held: 'docs/*.md' },
    ]);
    expect(findOverlaps(['lib'], ['src'])).toEqual([]);
  });
});

describe('scoped claims', () => {
  it('stores the scope on the claim, in the chain payload, and surfaces it in get/list', () => {
    const { store } = fresh();
    const id = triaged(store, 'A');
    const r = store.claim({ ticket_ids: [id], scope: { paths: ['src/handlers/', './docs'] } });
    expect(r.scope).toEqual({ paths: ['docs', 'src/handlers'] });
    expect(store.get({ id }).ticket.claim).toEqual({ holder: 'alice', expires_at: expect.any(String), write_count: 0, scope: { paths: ['docs', 'src/handlers'] } });
    const listed = store.list({ include_terminal: false, claimed: 'mine', limit: 10, view: 'compact' });
    expect(listed.tickets[0]!.claim?.scope).toEqual({ paths: ['docs', 'src/handlers'] });
    const ev = [...store.chain.iterate()].find((e) => e.event_type === EVENT.ticket_claimed)!;
    expect(ev.payload['scope']).toEqual({ paths: ['docs', 'src/handlers'] });
    // An unscoped claim carries scope: null.
    const id2 = triaged(store, 'B');
    store.claim({ ticket_ids: [id2] });
    expect(store.get({ id: id2 }).ticket.claim?.scope).toBeNull();
  });

  it("refuses a scope that overlaps another actor's live scope with scope_conflict naming holder, ticket, paths and expiry", () => {
    const { store } = fresh();
    const a = triaged(store, 'A');
    const b = triaged(store, 'B');
    const held = store.claim({ ticket_ids: [a], scope: { paths: ['src/handlers', 'docs/*.md'] }, actor_id: 'alice' });
    try {
      store.claim({ ticket_ids: [b], scope: { paths: ['src/handlers/claims.ts', 'README.md', 'docs/guide.md'] }, actor_id: 'bob' });
      expect.unreachable();
    } catch (e) {
      const err = e as { code: string; message: string; details: { requested: string[]; conflicts: Record<string, unknown>[] } };
      expect(err.code).toBe('scope_conflict');
      expect(err.message).toMatch(/"alice" holds/);
      expect(err.details.requested).toEqual(['README.md', 'docs/guide.md', 'src/handlers/claims.ts']);
      expect(err.details.conflicts).toEqual([
        {
          ticket_id: a,
          holder: 'alice',
          claim_expires_at: held.claims[0]!.expires_at,
          held: ['docs/*.md', 'src/handlers'],
          overlapping: [
            { requested: 'docs/guide.md', held: 'docs/*.md' },
            { requested: 'src/handlers/claims.ts', held: 'src/handlers' },
          ],
        },
      ]);
    }
    // Nothing was claimed for bob.
    expect(store.get({ id: b }).ticket.claim).toBeNull();
    // A disjoint scope goes through.
    expect(store.claim({ ticket_ids: [b], scope: { paths: ['lib'] }, actor_id: 'bob' }).scope).toEqual({ paths: ['lib'] });
  });

  it('the same actor may hold overlapping scopes across tickets, and re-claiming rotates the scope', () => {
    const { store } = fresh();
    const a = triaged(store, 'A');
    const b = triaged(store, 'B');
    store.claim({ ticket_ids: [a], scope: { paths: ['src'] } });
    expect(store.claim({ ticket_ids: [b], scope: { paths: ['src/x.ts'] } }).scope).toEqual({ paths: ['src/x.ts'] });
    const again = store.claim({ ticket_ids: [a], scope: { paths: ['lib'] } });
    expect(again.claims[0]!.rotated).toBe(true);
    expect(store.get({ id: a }).ticket.claim?.scope).toEqual({ paths: ['lib'] });
    // and re-claiming without a scope clears it
    store.claim({ ticket_ids: [a] });
    expect(store.get({ id: a }).ticket.claim?.scope).toBeNull();
  });

  it('a whole-repo scope blocks every other actor and is blocked by any live scope', () => {
    const { store } = fresh();
    const a = triaged(store, 'A');
    const b = triaged(store, 'B');
    store.claim({ ticket_ids: [a], scope: { paths: ['docs/x.md'] }, actor_id: 'alice' });
    expect(codeOf(() => store.claim({ ticket_ids: [b], scope: { paths: ['.'] }, actor_id: 'bob' }))).toBe('scope_conflict');
    store.release({ ticket_id: a, claim_token: store.claim({ ticket_ids: [a], actor_id: 'alice' }).claims[0]!.claim_token, force: false, actor_id: 'alice' });
    store.claim({ ticket_ids: [b], scope: { paths: ['.'] }, actor_id: 'bob' });
    expect(codeOf(() => store.claim({ ticket_ids: [a], scope: { paths: ['README.md'] }, actor_id: 'alice' }))).toBe('scope_conflict');
  });

  it('a set claim applies one scope to every ticket in the set, all-or-nothing', () => {
    const { store } = fresh();
    const a = triaged(store, 'A');
    const b = triaged(store, 'B');
    const c = triaged(store, 'C');
    store.claim({ ticket_ids: [c], scope: { paths: ['src/c'] }, actor_id: 'carol' });
    expect(codeOf(() => store.claim({ ticket_ids: [a, b], scope: { paths: ['src'] }, actor_id: 'alice' }))).toBe('scope_conflict');
    expect(store.get({ id: a }).ticket.claim).toBeNull();
    expect(store.get({ id: b }).ticket.claim).toBeNull();
    store.claim({ ticket_ids: [a, b], scope: { paths: ['src/a', 'src/b'] }, actor_id: 'alice' });
    expect(store.get({ id: a }).ticket.claim?.scope).toEqual({ paths: ['src/a', 'src/b'] });
    expect(store.get({ id: b }).ticket.claim?.scope).toEqual({ paths: ['src/a', 'src/b'] });
  });

  it('sea_next takes a scope: dispatch is refused on conflict (not skipped), and the claim carries it', () => {
    const { store } = fresh();
    const a = triaged(store, 'A');
    const b = triaged(store, 'B');
    store.claim({ ticket_ids: [a], scope: { paths: ['src/**/*.ts'] }, actor_id: 'alice' });
    expect(codeOf(() => store.next({ include_unassigned: true, scope: { paths: ['src/handlers/x.ts'] }, actor_id: 'bob' }))).toBe('scope_conflict');
    expect(store.get({ id: b }).ticket.claim).toBeNull();
    const got = store.next({ include_unassigned: true, scope: { paths: ['docs'] }, actor_id: 'bob' });
    expect(got.ticket?.id).toBe(b);
    expect(got.ticket?.claim?.scope).toEqual({ paths: ['docs'] });
    const ev = [...store.chain.iterate()].filter((e) => e.event_type === EVENT.ticket_claimed).at(-1)!;
    expect(ev.payload).toMatchObject({ via: 'sea_next', scope: { paths: ['docs'] } });
  });

  it('expiry frees the scope: a lapsed lease no longer blocks and the expiry event records the scope it freed', () => {
    const { store, clock } = fresh();
    const a = triaged(store, 'A');
    const b = triaged(store, 'B');
    store.claim({ ticket_ids: [a], scope: { paths: ['src'] }, lease_seconds: 60, actor_id: 'alice' });
    clock.advance(30);
    expect(codeOf(() => store.claim({ ticket_ids: [b], scope: { paths: ['src/x.ts'] }, actor_id: 'bob' }))).toBe('scope_conflict');
    clock.advance(31);
    const r = store.claim({ ticket_ids: [b], scope: { paths: ['src/x.ts'] }, actor_id: 'bob' });
    expect(r.scope).toEqual({ paths: ['src/x.ts'] });
    expect(store.get({ id: a }).ticket.claim).toBeNull();
    const expired = [...store.chain.iterate()].find((e) => e.event_type === EVENT.ticket_claim_expired)!;
    expect(expired.payload).toMatchObject({ ticket_id: a, scope: { paths: ['src'] } });
  });

  it('release, force release and a terminal transition clear the scope', () => {
    const { store } = fresh({ role: 'operator' });
    const a = triaged(store, 'A');
    const b = triaged(store, 'B');
    const c = triaged(store, 'C');
    const ta = store.claim({ ticket_ids: [a], scope: { paths: ['a'] } }).claims[0]!.claim_token;
    store.claim({ ticket_ids: [b], scope: { paths: ['b'] } });
    const tc = store.claim({ ticket_ids: [c], scope: { paths: ['c'] } }).claims[0]!.claim_token;
    store.release({ ticket_id: a, claim_token: ta, force: false });
    store.release({ ticket_id: b, force: true, reason: 'op' });
    store.transition({ ticket_id: c, claim_token: tc, to: 'resolved', dry_run: false });
    for (const id of [a, b, c]) expect(store.get({ id }).ticket.claim).toBeNull();
    const released = [...store.chain.iterate()].find((e) => e.event_type === EVENT.ticket_claim_released)!;
    expect(released.payload['scope']).toEqual({ paths: ['a'] });
    const forced = [...store.chain.iterate()].find((e) => e.event_type === EVENT.ticket_claim_force_released)!;
    expect(forced.payload['scope']).toEqual({ paths: ['b'] });
    expect(store.claim({ ticket_ids: [a], scope: { paths: ['a', 'b', 'c'] }, actor_id: 'zed' }).scope).toEqual({ paths: ['a', 'b', 'c'] });
  });

  it('rebuild from the chain restores live scopes and the conflicts they imply', () => {
    const { store } = fresh();
    const a = triaged(store, 'A');
    const b = triaged(store, 'B');
    const c = triaged(store, 'C');
    store.claim({ ticket_ids: [a], scope: { paths: ['src/**/*.ts', 'docs'] }, actor_id: 'alice' });
    const tb = store.claim({ ticket_ids: [b], scope: { paths: ['lib'] }, actor_id: 'bob' }).claims[0]!.claim_token;
    store.release({ ticket_id: b, claim_token: tb, force: false, actor_id: 'bob' });
    store.claim({ ticket_ids: [c], actor_id: 'carol' });
    const before = store.db.prepare(`SELECT id, claim_actor, claim_scope FROM sea_tickets ORDER BY id`).all();
    store.rebuild();
    const after = store.db.prepare(`SELECT id, claim_actor, claim_scope FROM sea_tickets ORDER BY id`).all();
    expect(after).toEqual(before);
    expect(store.get({ id: a }).ticket.claim?.scope).toEqual({ paths: ['docs', 'src/**/*.ts'] });
    expect(store.get({ id: b }).ticket.claim).toBeNull();
    expect(store.get({ id: c }).ticket.claim?.scope).toBeNull();
    expect(codeOf(() => store.claim({ ticket_ids: [b], scope: { paths: ['src/x.ts'] }, actor_id: 'bob' }))).toBe('scope_conflict');
    expect(store.scopeCheck({ paths: ['lib/y.ts'], actor_id: 'bob' }).ok).toBe(true);
  });

  it('the scope is part of the chained claim and survives the rebuild-equals-live invariant with a busy history', () => {
    const { store, clock } = fresh();
    const t = claimedTicket(store);
    store.claim({ ticket_ids: [t.id], scope: { paths: ['x'] } });
    clock.advance(1);
    const live = store.db.prepare(`SELECT * FROM sea_tickets`).all();
    store.rebuild();
    expect(store.db.prepare(`SELECT * FROM sea_tickets`).all()).toEqual(live);
  });
});

describe('sea_scope_check (hot path)', () => {
  it('reports ok with no conflicts, never takes a claim, and ignores the caller\'s own scopes', () => {
    const { store } = fresh();
    const a = triaged(store, 'A');
    store.claim({ ticket_ids: [a], scope: { paths: ['src'] }, actor_id: 'alice' });
    const mine = store.scopeCheck({ paths: ['src/handlers/claims.ts'], actor_id: 'alice' });
    expect(mine).toMatchObject({ ok: true, conflicts: [], paths: ['src/handlers/claims.ts'] });
    const other = store.scopeCheck({ paths: ['./src/handlers/claims.ts', 'README.md'], actor_id: 'bob' });
    expect(other.ok).toBe(false);
    expect(other.paths).toEqual(['README.md', 'src/handlers/claims.ts']);
    expect(other.conflicts).toEqual([
      {
        ticket_id: a,
        holder: 'alice',
        claim_expires_at: expect.any(String),
        held: ['src'],
        overlapping: [{ requested: 'src/handlers/claims.ts', held: 'src' }],
      },
    ]);
    expect(store.scopeCheck({ paths: ['lib/x.ts'], actor_id: 'bob' }).ok).toBe(true);
    // No claim rows changed and nothing was chained by the checks.
    const types = [...store.chain.iterate()].map((e) => e.event_type);
    expect(types.filter((x) => x === EVENT.ticket_claimed)).toHaveLength(1);
  });

  it('sweeps expired leases so a dead holder never blocks an edit', () => {
    const { store, clock } = fresh();
    const a = triaged(store, 'A');
    store.claim({ ticket_ids: [a], scope: { paths: ['src'] }, lease_seconds: 10, actor_id: 'alice' });
    expect(store.scopeCheck({ paths: ['src/a.ts'], actor_id: 'bob' }).ok).toBe(false);
    clock.advance(11);
    const r = store.scopeCheck({ paths: ['src/a.ts'], actor_id: 'bob' });
    expect(r).toMatchObject({ ok: true, swept_expired: 1 });
  });

  it('is fast: a thousand checks against fifty live scopes stay well under a second', () => {
    const { store } = fresh();
    for (let i = 0; i < 50; i++) {
      const id = triaged(store, `T${i}`);
      store.claim({ ticket_ids: [id], scope: { paths: [`pkg${i}/**/*.ts`, `docs/pkg${i}`] }, actor_id: `agent-${i}` });
    }
    const t0 = performance.now();
    let conflicts = 0;
    for (let i = 0; i < 1000; i++) {
      const r = store.scopeCheck({ paths: [`pkg${i % 60}/src/index.ts`], actor_id: 'me' });
      if (!r.ok) conflicts++;
    }
    const ms = performance.now() - t0;
    expect(conflicts).toBe(Math.floor(1000 / 60) * 50 + Math.min(1000 % 60, 50));
    expect(ms).toBeLessThan(1000);
  });
});

describe('schema migration', () => {
  it('adds claim_scope to a v1 store additively and bumps sea_schema_version', () => {
    const { store } = fresh();
    // Simulate a store written by 0.1.x: no claim_scope column, version 1.
    store.db.exec(`ALTER TABLE sea_tickets DROP COLUMN claim_scope`);
    store.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(SEA_SCHEMA_META_KEY, '1');
    const id = triaged(store, 'pre-migration');
    expect((store.db.prepare(`PRAGMA table_info(sea_tickets)`).all() as { name: string }[]).some((c) => c.name === 'claim_scope')).toBe(false);
    ensureSeaSchema(store.db);
    expect((store.db.prepare(`PRAGMA table_info(sea_tickets)`).all() as { name: string }[]).some((c) => c.name === 'claim_scope')).toBe(true);
    expect((store.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(SEA_SCHEMA_META_KEY) as { value: string }).value).toBe(String(SEA_SCHEMA_VERSION));
    expect(store.get({ id }).ticket.claim).toBeNull();
    store.claim({ ticket_ids: [id], scope: { paths: ['src'] } });
    expect(store.get({ id }).ticket.claim?.scope).toEqual({ paths: ['src'] });
    ensureSeaSchema(store.db); // idempotent
  });
});

describe('scope over MCP and the CLI', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sea-lite-scope-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips scope through sea_claim / sea_next / sea_get / sea_scope_check with structuredContent', async () => {
    const store = new SeaLite({ memory: true, actor: 'agent-1' });
    const { client, close } = await connectInMemory(store);
    try {
      const { tools } = await client.listTools();
      const sc = tools.find((t) => t.name === 'sea_scope_check')!;
      expect(sc.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
      expect((sc.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty('paths');
      const claimProps = (tools.find((t) => t.name === 'sea_claim')!.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(claimProps).toHaveProperty('scope');

      const a = parse<{ ticket: { id: string } }>(await client.callTool({ name: 'sea_create', arguments: { title: 'A', status: 'triaged' } }));
      const b = parse<{ ticket: { id: string } }>(await client.callTool({ name: 'sea_create', arguments: { title: 'B', status: 'triaged' } }));
      const claimed = (await client.callTool({ name: 'sea_claim', arguments: { ticket_ids: [a.ticket.id], scope: { paths: ['src/handlers/'] } } })) as ToolResult;
      expect((claimed.structuredContent as { scope: unknown }).scope).toEqual({ paths: ['src/handlers'] });

      const conflict = (await client.callTool({
        name: 'sea_next',
        arguments: { scope: { paths: ['src/handlers/claims.ts'] }, actor_id: 'agent-2' },
      })) as ToolResult;
      expect(conflict.isError).toBe(true);
      const err = parse<{ error: string; details: { conflicts: { holder: string; ticket_id: string }[] } }>(conflict);
      expect(err.error).toBe('scope_conflict');
      expect(err.details.conflicts[0]).toMatchObject({ holder: 'agent-1', ticket_id: a.ticket.id });

      const next = parse<{ ticket: { id: string; claim: { scope: { paths: string[] } } } }>(
        await client.callTool({ name: 'sea_next', arguments: { scope: { paths: ['docs/*.md'] }, actor_id: 'agent-2' } }),
      );
      expect(next.ticket.id).toBe(b.ticket.id);
      expect(next.ticket.claim.scope).toEqual({ paths: ['docs/*.md'] });

      const got = parse<{ ticket: { claim: { scope: unknown } } }>(await client.callTool({ name: 'sea_get', arguments: { id: a.ticket.id } }));
      expect(got.ticket.claim.scope).toEqual({ paths: ['src/handlers'] });

      const check = (await client.callTool({ name: 'sea_scope_check', arguments: { paths: ['docs/guide.md', 'lib/x.ts'], actor_id: 'agent-3' } })) as ToolResult;
      expect(check.isError).toBeFalsy();
      expect(check.structuredContent).toMatchObject({ ok: false, paths: ['docs/guide.md', 'lib/x.ts'], conflicts: [{ holder: 'agent-2', held: ['docs/*.md'] }] });
      const clear = parse<{ ok: boolean; conflicts: unknown[] }>(await client.callTool({ name: 'sea_scope_check', arguments: { paths: ['lib/x.ts'] } }));
      expect(clear).toMatchObject({ ok: true, conflicts: [] });
    } finally {
      await close();
      store.close();
    }
  });

  it('`sea-lite scope-check` exits 0 when clear and 1 on a conflict, with --json for hooks', () => {
    const CLI = join(process.cwd(), 'dist', 'cli.js');
    const store = new SeaLite({ dataDir: dir, actor: 'alice' });
    const id = triaged(store, 'held');
    store.claim({ ticket_ids: [id], scope: { paths: ['src/handlers'] } });
    store.close();
    const run = (args: string[]) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [CLI, 'scope-check', '--data-dir', dir, ...args], { encoding: 'utf8' }) };
      } catch (e) {
        const err = e as { status: number; stdout: string; stderr: string };
        return { code: err.status, out: err.stdout + err.stderr };
      }
    };
    expect(run(['--paths', 'src/handlers/claims.ts', '--actor', 'alice'])).toMatchObject({ code: 0 });
    const hit = run(['--paths', 'src/handlers/claims.ts,README.md', '--actor', 'bob']);
    expect(hit.code).toBe(1);
    expect(hit.out).toMatch(/"alice" holds src\/handlers/);
    const json = run(['src/handlers/claims.ts', '--actor', 'bob', '--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, conflicts: [{ holder: 'alice' }] });
    expect(run(['lib/x.ts', '--actor', 'bob'])).toMatchObject({ code: 0 });
    expect(run(['--actor', 'bob']).code).toBe(1); // no paths: usage error
  });
});
