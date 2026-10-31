/**
 * Composition with kronicle-lite: the same store object serves both; sea
 * events show up in get_system_state deltas, claim churn rolls up, and a
 * tombstoned link is classified as a retraction.
 */

import { KronicleLite } from 'kronicle-lite';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { titleMatchExpression } from '../src/handlers/dedup.js';
import { SeaLite } from '../src/store.js';

describe('kronicle-lite composition', () => {
  it('adopts an open KronicleLite and surfaces sea events through its orient protocol', () => {
    const kl = new KronicleLite({ memory: true });
    const sea = new SeaLite({ kronicle: kl, actor: 'worker' });
    const first = kl.orient.getSystemState({ actor_id: 'observer' });
    expect(first.head.seq).toBe(0);

    const a = sea.create({ title: 'A', body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged', dry_run: false });
    const b = sea.create({ title: 'B', body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged', dry_run: false });
    const tok = sea.claim({ ticket_ids: [a.ticket.id] }).claims[0]!.claim_token;
    sea.link({ action: 'add', from_id: a.ticket.id, to_id: b.ticket.id, link_type: 'relates_to', claim_token: tok, dry_run: false });
    sea.link({ action: 'remove', from_id: a.ticket.id, to_id: b.ticket.id, link_type: 'relates_to', claim_token: tok, dry_run: false });
    sea.release({ ticket_id: a.ticket.id, claim_token: tok, force: false });
    for (let i = 0; i < 5; i++) {
      const t = sea.claim({ ticket_ids: [b.ticket.id] }).claims[0]!.claim_token;
      sea.release({ ticket_id: b.ticket.id, claim_token: t, force: false });
    }

    const state = kl.orient.getSystemState({ actor_id: 'observer', since_cursor: first.cursor, focus: 'recent_changes', budget_tokens: 64_000 });
    expect(state.recovery.method).toBe('presented');
    expect(state.delta!.by_type['sea_ticket.created']).toBe(2);
    expect(state.delta!.by_type['sea_ticket.claimed']).toBe(6);
    const rollups = state.delta!.entries.filter((e) => e.kind === 'volume_rollup').map((e) => (e as { event_type: string }).event_type);
    expect(rollups).toContain('sea_ticket.claimed');
    expect(rollups).toContain('sea_ticket.claim_released');
    const enumerated = state.delta!.entries.filter((e) => e.kind === 'event').map((e) => (e as { event_type: string }).event_type);
    expect(enumerated).toContain('sea_ticket.created');
    expect(enumerated).toContain('sea_link.created');
    expect(enumerated).toContain('sea_link.tombstoned');

    expect(state.retractions).toHaveLength(1);
    expect(state.retractions![0]).toMatchObject({ event_type: 'sea_link.tombstoned', kind: 'tombstone', severity: 'safety' });
    expect(state.retractions![0]!.reason_line).toMatch(/sea_link/);

    // Closing sea-lite does not close an adopted kronicle-lite.
    sea.close();
    expect(kl.chain.head().seq).toBeGreaterThan(0);
    kl.close();
  });

  it('survives kronicle-lite export → import → sea-lite rebuild', async () => {
    const src = new SeaLite({ memory: true, actor: 'a' });
    const t = src.create({ title: 'exported', body: 'b', kind: 'bug', priority: 'low', tags: ['e'], status: 'triaged', dry_run: false, claim_seconds: 60 });
    src.update({ ticket_id: t.ticket.id, claim_token: t.claim_token!, note: 'n', dry_run: false });
    const buf = new PassThrough();
    const chunks: Buffer[] = [];
    buf.on('data', (c: Buffer) => chunks.push(c));
    src.kronicle.exportEvents(buf);
    buf.end();
    await new Promise((r) => buf.on('end', r));

    const dstKl = new KronicleLite({ memory: true });
    const input = new PassThrough();
    input.end(Buffer.concat(chunks));
    await dstKl.importEvents(input);
    const dst = new SeaLite({ kronicle: dstKl, actor: 'a' });
    expect(dst.list({ include_terminal: true, claimed: 'any', limit: 10, view: 'compact' }).count).toBe(0); // import projects documents only
    const r = dst.rebuild();
    expect(r.tickets).toBe(1);
    const got = dst.get({ id: t.ticket.id });
    expect(got.ticket.title).toBe('exported');
    expect(got.notes.map((n) => n.body)).toEqual(['n']);
    expect(dst.verify().ok).toBe(true);
    // The holder's token still fences in the restored copy.
    expect(dst.update({ ticket_id: t.ticket.id, claim_token: t.claim_token!, title: 'restored', dry_run: false }).changed).toEqual(['title']);
    src.close();
    dstKl.close();
  });

  it('refuses a store written by a newer sea-lite', () => {
    const kl = new KronicleLite({ memory: true });
    kl.db.prepare(`INSERT INTO meta (key, value) VALUES ('sea_schema_version', '99')`).run();
    expect(() => new SeaLite({ kronicle: kl })).toThrow(/newer/);
    kl.close();
  });
});

describe('dedup match expression', () => {
  it('quotes words, drops short ones, and returns null when nothing is left', () => {
    expect(titleMatchExpression('Fix the login bug!')).toBe('title : ("fix" OR "the" OR "login" OR "bug")');
    expect(titleMatchExpression('a b "c"')).toBeNull();
    expect(titleMatchExpression('say "hello" world')).toBe('title : ("say" OR "hello" OR "world")');
  });
});
