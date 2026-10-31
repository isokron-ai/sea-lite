import { describe, expect, it } from 'vitest';

import { EVENT } from '../src/core/events.js';
import { claimedTicket, codeOf, fresh } from './helpers.js';

function eventTypes(store: ReturnType<typeof fresh>['store']): string[] {
  return [...store.chain.iterate()].map((e) => e.event_type);
}

describe('sea_claim', () => {
  it('claims one ticket, returns a token once, and the row holds only the hash', () => {
    const { store } = fresh();
    const { id, token } = claimedTicket(store);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const row = store.db.prepare(`SELECT claim_token_hash, claim_actor FROM sea_tickets WHERE id = ?`).get(id) as {
      claim_token_hash: string;
      claim_actor: string;
    };
    expect(row.claim_token_hash).not.toBe(token);
    expect(row.claim_actor).toBe('alice');
    const got = store.get({ id });
    expect(got.ticket.claim).toEqual({ holder: 'alice', expires_at: expect.any(String), write_count: 0 });
    expect(JSON.stringify(got)).not.toContain(token);
    expect(JSON.stringify(got)).not.toContain(row.claim_token_hash);
    const claimed = [...store.chain.iterate()].find((e) => e.event_type === EVENT.ticket_claimed)!;
    expect(claimed.payload['claim_token_hash']).toBe(row.claim_token_hash);
    expect(JSON.stringify(claimed.payload)).not.toContain(token);
  });

  it('refuses a ticket held by someone else and names the holder', () => {
    const { store } = fresh();
    const { id } = claimedTicket(store);
    try {
      store.claim({ ticket_ids: [id], actor_id: 'bob' });
      expect.unreachable();
    } catch (e) {
      const err = e as { code: string; details: Record<string, unknown> };
      expect(err.code).toBe('already_claimed');
      expect(err.details['held_by']).toBe('alice');
      expect(err.details['claim_expires_at']).toBeDefined();
    }
  });

  it('re-claiming your own ticket rotates the token; the old one stops fencing', () => {
    const { store } = fresh();
    const { id, token } = claimedTicket(store);
    const again = store.claim({ ticket_ids: [id] });
    expect(again.claims[0]!.rotated).toBe(true);
    expect(again.claims[0]!.claim_token).not.toBe(token);
    expect(codeOf(() => store.update({ ticket_id: id, claim_token: token, title: 'x', dry_run: false }))).toBe('fence_invalid');
    expect(store.update({ ticket_id: id, claim_token: again.claims[0]!.claim_token, title: 'x', dry_run: false }).changed).toEqual(['title']);
  });

  it('claims a set in lexicographic id order, all-or-nothing', () => {
    const { store } = fresh();
    const ids = ['c', 'a', 'b'].map((t) => store.create({ title: `ticket ${t}`, body: '', kind: 'chore', priority: 'medium', tags: [], status: 'idea', dry_run: false }).ticket.id);
    const r = store.claim({ ticket_ids: ids });
    expect(r.claims.map((c) => c.ticket_id)).toEqual([...ids].sort());
    const claimedEvents = [...store.chain.iterate()].filter((e) => e.event_type === EVENT.ticket_claimed);
    expect(claimedEvents.map((e) => e.payload['ticket_id'])).toEqual([...ids].sort());
    expect(claimedEvents[0]!.payload['set']).toEqual([...ids].sort());

    // bob wants two of them, one is alice's: nothing is claimed and nothing is chained.
    const free = store.create({ title: 'free', body: '', kind: 'chore', priority: 'medium', tags: [], status: 'idea', dry_run: false }).ticket.id;
    const headBefore = store.chain.head().seq;
    expect(codeOf(() => store.claim({ ticket_ids: [free, ids[0]!], actor_id: 'bob' }))).toBe('already_claimed');
    expect(store.chain.head().seq).toBe(headBefore);
    expect(store.get({ id: free }).ticket.claim).toBeNull();
  });

  it('de-duplicates repeated ids and resolves prefixes', () => {
    const { store } = fresh();
    const { id } = claimedTicket(store);
    const r = store.claim({ ticket_ids: [id, id.slice(0, 8), id] });
    expect(r.claims).toHaveLength(1);
  });

  it('enforces the lease bound at the schema and the handler', () => {
    const { store } = fresh();
    const { id } = claimedTicket(store);
    expect(codeOf(() => store.claim({ ticket_ids: [id], lease_seconds: 601 }))).toBe('invalid_input');
  });
});

describe('sea_refresh', () => {
  it('extends to now + extend_by, never shortens, and is not chained', () => {
    const { store, clock } = fresh();
    const { id, token } = claimedTicket(store);
    const head = store.chain.head().seq;
    const first = store.get({ id }).ticket.claim!.expires_at;
    // Asking for less than remaining does nothing.
    const r0 = store.refresh({ ticket_id: id, claim_token: token, extend_by_seconds: 10 });
    expect(r0.extended).toBe(false);
    expect(r0.expires_at).toBe(first);
    clock.advance(200);
    const r1 = store.refresh({ ticket_id: id, claim_token: token, extend_by_seconds: 600 });
    expect(r1.extended).toBe(true);
    expect(Date.parse(r1.expires_at) - clock.now().getTime()).toBe(600_000);
    expect(store.chain.head().seq).toBe(head);
    expect(eventTypes(store).filter((t) => t.includes('refresh'))).toEqual([]);
  });

  it('is holder-only and fails once the lease has lapsed', () => {
    const { store, clock } = fresh();
    const { id, token } = claimedTicket(store);
    expect(codeOf(() => store.refresh({ ticket_id: id, claim_token: token, extend_by_seconds: 60, actor_id: 'bob' }))).toBe('fence_foreign_holder');
    clock.advance(301);
    expect(codeOf(() => store.refresh({ ticket_id: id, claim_token: token, extend_by_seconds: 60 }))).toBe('fence_expired');
  });
});

describe('sea_release', () => {
  it('holder releases with a hand-off note; the ticket is free again', () => {
    const { store } = fresh();
    const { id, token } = claimedTicket(store);
    const r = store.release({ ticket_id: id, claim_token: token, force: false, note: 'half done; see branch x' });
    expect(r.forced).toBe(false);
    expect(r.previous_holder).toBe('alice');
    expect(r.ticket.claim).toBeNull();
    expect(r.note?.body).toBe('half done; see branch x');
    expect(store.get({ id }).notes.map((n) => n.body)).toEqual(['half done; see branch x']);
    expect(eventTypes(store)).toContain(EVENT.ticket_claim_released);
    expect(store.claim({ ticket_ids: [id], actor_id: 'bob' }).claims).toHaveLength(1);
  });

  it('a non-holder cannot release, with or without a stolen token', () => {
    const { store } = fresh();
    const { id, token } = claimedTicket(store);
    expect(codeOf(() => store.release({ ticket_id: id, claim_token: token, force: false, actor_id: 'bob' }))).toBe('fence_foreign_holder');
    expect(codeOf(() => store.release({ ticket_id: id, force: false, actor_id: 'bob' }))).toBe('invalid_input');
  });

  it('force release needs the operator role and is recorded as such', () => {
    const agent = fresh();
    const t = claimedTicket(agent.store);
    expect(codeOf(() => agent.store.release({ ticket_id: t.id, force: true, reason: 'stuck' }))).toBe('forbidden');

    const op = fresh({ role: 'operator', actor: 'ops' });
    const t2 = claimedTicket(op.store, 'worker');
    const r = op.store.release({ ticket_id: t2.id, force: true, reason: 'worker hung' });
    expect(r.forced).toBe(true);
    expect(r.previous_holder).toBe('worker');
    const ev = [...op.store.chain.iterate()].find((e) => e.event_type === EVENT.ticket_claim_force_released)!;
    expect(ev.payload).toMatchObject({ previous_holder: 'worker', released_by: 'ops', reason: 'worker hung' });
    expect(codeOf(() => op.store.release({ ticket_id: t2.id, force: true }))).toBe('invalid_input'); // not claimed any more
  });
});

describe('lazy expiry', () => {
  it('an expired lease is treated as free on the next read and chained exactly once', () => {
    const { store, clock } = fresh();
    const { id, token } = claimedTicket(store);
    clock.advance(301);
    const g1 = store.get({ id });
    expect(g1.ticket.claim).toBeNull();
    const g2 = store.get({ id });
    expect(g2.ticket.claim).toBeNull();
    expect(eventTypes(store).filter((t) => t === EVENT.ticket_claim_expired)).toHaveLength(1);
    // The old token no longer fences; a new claimant wins.
    expect(codeOf(() => store.update({ ticket_id: id, claim_token: token, title: 'late', dry_run: false }))).toBe('fence_invalid');
    expect(store.claim({ ticket_ids: [id], actor_id: 'bob' }).claims[0]!.ticket_id).toBe(id);
  });

  it('sea_list sweeps every expired lease it sees', () => {
    const { store, clock } = fresh();
    claimedTicket(store, 'alice', 'one');
    claimedTicket(store, 'alice', 'two');
    clock.advance(301);
    const l = store.list({ include_terminal: false, claimed: 'any', limit: 50, view: 'compact' });
    expect(l.swept_expired).toBe(2);
    expect(l.tickets.every((t) => t.claim === null)).toBe(true);
  });
});
