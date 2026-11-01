/**
 * sea_stats / `sea-lite stats`: per-actor accounting derived from the chain.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseSince } from '../src/handlers/stats.js';
import { SeaLite } from '../src/store.js';
import { codeOf, fresh } from './helpers.js';
import { connectInMemory } from './mcp-helpers.js';

const T0 = Date.parse('2026-10-31T12:00:00.000Z');
const iso = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

function triaged(store: SeaLite, title: string, actor: string): string {
  return store.create({ title, body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged', dry_run: false, actor_id: actor }).ticket.id;
}

/**
 * t=0    alice claims T1 (300 s)          t=100  alice releases T1
 * t=100  bob claims T1 with a scope       t=150  bob re-claims T1 (rotation)
 * t=200  bob T1 → in_progress             t=220  bob T1 → resolved (releases the claim)
 * t=220  carol claims T2 (60 s)           t=320  dave claims T2 (carol's lease noticed expired at 280)
 * t=350  erin (operator) force-releases dave on T2
 * t=350  alice claims T3                  now = t=390
 */
function scenario() {
  const { store, clock } = fresh();
  const t1 = triaged(store, 'one', 'alice');
  const a = store.claim({ ticket_ids: [t1], lease_seconds: 300, actor_id: 'alice' }).claims[0]!.claim_token;
  clock.advance(100);
  store.release({ ticket_id: t1, claim_token: a, force: false, actor_id: 'alice' });
  store.claim({ ticket_ids: [t1], scope: { paths: ['src'] }, actor_id: 'bob' });
  clock.advance(50);
  const b = store.claim({ ticket_ids: [t1], scope: { paths: ['src'] }, actor_id: 'bob' }).claims[0]!.claim_token;
  clock.advance(50);
  store.transition({ ticket_id: t1, claim_token: b, to: 'in_progress', dry_run: false, actor_id: 'bob' });
  clock.advance(20);
  store.transition({ ticket_id: t1, claim_token: b, to: 'resolved', confirm: true, dry_run: false, actor_id: 'bob' });
  const t2 = triaged(store, 'two', 'carol');
  store.claim({ ticket_ids: [t2], lease_seconds: 60, actor_id: 'carol' });
  clock.advance(100);
  store.claim({ ticket_ids: [t2], actor_id: 'dave' });
  clock.advance(30);
  store.as('erin', 'operator').release({ ticket_id: t2, force: true, reason: 'stuck' });
  const t3 = triaged(store, 'three', 'alice');
  store.claim({ ticket_ids: [t3], actor_id: 'alice' });
  clock.advance(40);
  return { store, clock };
}

describe('sea_stats', () => {
  it('parseSince accepts durations and ISO timestamps', () => {
    const now = new Date(T0);
    expect(parseSince('90s', now)).toBe(T0 - 90_000);
    expect(parseSince('24h', now)).toBe(T0 - 86_400_000);
    expect(parseSince('2w', now)).toBe(T0 - 14 * 86_400_000);
    expect(parseSince(iso(-5), now)).toBe(T0 - 5000);
    expect(codeOf(() => parseSince('yesterday', now))).toBe('invalid_input');
  });

  it('whole chain: every counter per actor, plus totals', () => {
    const { store } = scenario();
    const r = store.stats({});
    expect(r.since).toBeNull();
    expect(r.until).toBe(iso(390));
    const by = Object.fromEntries(r.actors.map((a) => [a.actor, a]));
    expect(Object.keys(by)).toEqual(['alice', 'bob', 'carol', 'dave', 'erin']);
    expect(by['alice']).toMatchObject({ claims_taken: 2, released: 1, lease_seconds: 100 + 40, live_claims: 1, tickets_created: 2, transitions: 0 });
    expect(by['bob']).toMatchObject({
      claims_taken: 1,
      claims_rotated: 1,
      scoped_claims: 2,
      transitions: 2,
      released_on_transition: 1,
      lease_seconds: 120,
      live_claims: 0,
    });
    expect(by['carol']).toMatchObject({ claims_taken: 1, expired: 1, lease_seconds: 60, tickets_created: 1 });
    expect(by['dave']).toMatchObject({ claims_taken: 1, force_released: 1, lease_seconds: 30 });
    expect(by['erin']).toMatchObject({ force_releases_issued: 1, claims_taken: 0, lease_seconds: 0 });
    expect(r.totals).toMatchObject({ claims_taken: 5, claims_rotated: 1, expired: 1, force_released: 1, lease_seconds: 350, live_claims: 1 });
    store.close();
  });

  it('a window counts events inside it and clips lease time to it', () => {
    const { store } = scenario();
    const fromIso = store.stats({ since: iso(300) });
    const fromRel = store.stats({ since: '90s' });
    expect(fromRel.actors).toEqual(fromIso.actors);
    const by = Object.fromEntries(fromIso.actors.map((a) => [a.actor, a]));
    expect(by['bob']).toBeUndefined(); // nothing in the window: actors without activity are omitted
    expect(by['carol']).toMatchObject({ expired: 1, lease_seconds: 0 }); // noticed at 320; the lease ended at 280
    expect(by['dave']).toMatchObject({ claims_taken: 1, force_released: 1, lease_seconds: 30 });
    expect(by['alice']).toMatchObject({ claims_taken: 1, released: 0, lease_seconds: 40 });
    expect(codeOf(() => store.stats({ since: '2099-01-01T00:00:00Z' }))).toBe('invalid_input');
    store.close();
  });

  it('actor filter, and the same answer after a rebuild (derived from the chain)', () => {
    const { store } = scenario();
    const only = store.stats({ actor: 'dave' });
    expect(only.actors.map((a) => a.actor)).toEqual(['dave']);
    expect(only.totals.claims_taken).toBe(1);
    const before = store.stats({});
    store.rebuild();
    expect(store.stats({})).toEqual(before);
    store.close();
  });

  it('is read-only: it never sweeps a lapsed lease or appends an event', () => {
    const { store, clock } = fresh();
    const t = triaged(store, 'x', 'alice');
    store.claim({ ticket_ids: [t], lease_seconds: 10, actor_id: 'alice' });
    clock.advance(60);
    const head = store.chain.head().seq;
    const r = store.stats({});
    expect(store.chain.head().seq).toBe(head);
    expect(r.actors[0]).toMatchObject({ actor: 'alice', live_claims: 0, lease_seconds: 10, expired: 0 });
    store.close();
  });

  it('over MCP: read-only annotations and structuredContent that matches the outputSchema', async () => {
    const { store } = scenario();
    const { client, close } = await connectInMemory(store);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'sea_stats')!;
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const res = await client.callTool({ name: 'sea_stats', arguments: { since: '1h' } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { actors: unknown[] }).actors.length).toBe(5);
    const bad = await client.callTool({ name: 'sea_stats', arguments: { since: 'soon' } });
    expect(bad.isError).toBe(true);
    await close();
    store.close();
  });

  it('`sea-lite stats` prints a table and --json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sea-stats-'));
    try {
      const store = new SeaLite({ dataDir: dir, actor: 'alice' });
      const t = triaged(store, 'cli', 'alice');
      store.claim({ ticket_ids: [t] });
      store.close();
      const CLI = join(process.cwd(), 'dist', 'cli.js');
      const table = execFileSync(process.execPath, [CLI, 'stats', '--data-dir', dir], { encoding: 'utf8' });
      expect(table).toMatch(/^actor\s+taken/m);
      expect(table).toMatch(/^alice\s+1\s/m);
      expect(table).toMatch(/^total\s+1\s/m);
      const json = JSON.parse(execFileSync(process.execPath, [CLI, 'stats', '--data-dir', dir, '--json', '--for', 'alice', '--since', '1h'], { encoding: 'utf8' }));
      expect(json.actors).toHaveLength(1);
      expect(json.actors[0]).toMatchObject({ actor: 'alice', claims_taken: 1, live_claims: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
