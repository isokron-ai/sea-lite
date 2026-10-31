/**
 * The sea tables are a projection of the chain. Dropping them and replaying
 * must reproduce the live rows exactly (claims included — token hashes are
 * on the chain, so a holder's token still fences after a rebuild).
 */

import { describe, expect, it } from 'vitest';

import { SEA_SCHEMA_META_KEY } from '../src/db/schema.js';
import { claimedTicket, fresh } from './helpers.js';

function snapshot(db: ReturnType<typeof fresh>['store']['db']) {
  return {
    tickets: db.prepare(`SELECT * FROM sea_tickets ORDER BY id`).all(),
    links: db.prepare(`SELECT * FROM sea_links ORDER BY link_id`).all(),
    notes: db.prepare(`SELECT * FROM sea_notes ORDER BY note_id`).all(),
    fts: db.prepare(`SELECT ticket_id, title, body FROM sea_tickets_fts ORDER BY ticket_id`).all(),
  };
}

describe('rebuild from chain', () => {
  it('reproduces the live projection after a busy history', () => {
    const { store, clock } = fresh({ role: 'operator' });
    const base = { body: 'b', kind: 'chore' as const, priority: 'medium' as const, tags: ['x'] as string[], status: 'triaged' as const, dry_run: false };

    // Authoring of every flavour.
    const a = claimedTicket(store, 'alice', 'A');
    store.update({ ticket_id: a.id, claim_token: a.token, title: 'A2', body: 'longer body', add_tags: ['y'], assignee: 'alice', note: 'n1', dry_run: false });
    store.transition({ ticket_id: a.id, claim_token: a.token, to: 'in_progress', dry_run: false });
    const b = store.create({ ...base, title: 'B', claim_seconds: 100 });
    const batch = store.apply({
      tickets: [
        { ref: 'e', title: 'E', ...base, kind: 'epic', status: 'idea' },
        { ref: 'c', title: 'C', ...base },
      ],
      links: [{ from_ref: 'e', to_ref: 'c', link_type: 'parent_of' }],
      dry_run: false,
    });
    store.link({ action: 'add', from_id: a.id, to_id: b.ticket.id, link_type: 'depends_on', claim_token: a.token, dry_run: false });
    store.link({ action: 'add', from_id: a.id, to_id: batch.tickets[1]!.ticket_id, link_type: 'relates_to', claim_token: a.token, dry_run: false });
    store.link({ action: 'remove', from_id: a.id, to_id: batch.tickets[1]!.ticket_id, link_type: 'relates_to', claim_token: a.token, dry_run: false });
    store.release({ ticket_id: b.ticket.id, claim_token: b.claim_token!, force: false, note: 'bye' });
    store.release({ ticket_id: a.id, force: true, reason: 'ops' });
    const dup = claimedTicket(store, 'bob', 'A2');
    store.transition({ ticket_id: dup.id, claim_token: dup.token, to: 'duplicate', duplicate_of: a.id, actor_id: 'bob', dry_run: false });
    const n = store.next({ include_unassigned: true });
    expect(n.ticket).not.toBeNull();
    const expiring = claimedTicket(store, 'carol', 'will expire');
    clock.advance(301);
    store.get({ id: expiring.id }); // lazy expiry chained
    // A live claim whose token must keep fencing across the rebuild.
    const live = claimedTicket(store, 'dave', 'live claim');

    const before = snapshot(store.db);
    const headBefore = store.chain.head();
    const r = store.rebuild();
    expect(r.head).toEqual(headBefore);
    expect(r.events_seen).toBe(r.events_applied);
    expect(r.tickets).toBe((before.tickets as unknown[]).length);
    expect(snapshot(store.db)).toEqual(before);
    expect(store.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(SEA_SCHEMA_META_KEY)).toEqual({ value: '1' });
    expect(store.verify().ok).toBe(true);

    // The chain is untouched and the old token still works.
    expect(store.chain.head()).toEqual(headBefore);
    expect(store.update({ ticket_id: live.id, claim_token: live.token, title: 'still mine', actor_id: 'dave', dry_run: false }).changed).toEqual(['title']);
    // FTS was rebuilt by the triggers.
    expect(store.list({ query: 'longer', include_terminal: true, claimed: 'any', limit: 10, view: 'compact' }).count).toBe(1);
  });

  it('verify reports rows whose chain_seq no longer resolves', () => {
    const { store } = fresh();
    const t = claimedTicket(store);
    store.db.prepare(`UPDATE sea_tickets SET last_seq = 999 WHERE id = ?`).run(t.id);
    const v = store.verify();
    expect(v.chain.ok).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.rows_missing_chain_seq).toEqual([{ table: 'sea_tickets', id: t.id, seq: 999 }]);
    store.rebuild();
    expect(store.verify().ok).toBe(true);
  });

  it('a rebuilt lease is the one last chained (refresh is not an event)', () => {
    const { store, clock } = fresh();
    const t = claimedTicket(store);
    const chained = store.get({ id: t.id }).ticket.claim!.expires_at;
    clock.advance(100);
    const refreshed = store.refresh({ ticket_id: t.id, claim_token: t.token, extend_by_seconds: 600 }).expires_at;
    expect(refreshed).not.toBe(chained);
    store.rebuild();
    expect(store.get({ id: t.id }).ticket.claim!.expires_at).toBe(chained);
  });
});
