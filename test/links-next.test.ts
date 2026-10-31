import { describe, expect, it } from 'vitest';

import { EVENT } from '../src/core/events.js';
import { claimedTicket, codeOf, fresh } from './helpers.js';

const base = { body: '', kind: 'chore' as const, priority: 'medium' as const, tags: [] as string[], status: 'triaged' as const, dry_run: false };

describe('sea_link', () => {
  it('adds a link fenced on the from ticket, bumps its row_version, and refuses duplicates', () => {
    const { store } = fresh();
    const a = claimedTicket(store, 'alice', 'A');
    const b = store.create({ ...base, title: 'B' }).ticket.id;
    expect(codeOf(() => store.link({ action: 'add', from_id: a.id, to_id: b, link_type: 'blocks', claim_token: 'a'.repeat(64), dry_run: false }))).toBe('fence_invalid');
    // Fence is on from: holding B is not enough to link from A.
    const bClaim = store.claim({ ticket_ids: [b], actor_id: 'bob' }).claims[0]!.claim_token;
    expect(codeOf(() => store.link({ action: 'add', from_id: a.id, to_id: b, link_type: 'blocks', claim_token: bClaim, actor_id: 'bob', dry_run: false }))).toBe('fence_invalid');

    const r = store.link({ action: 'add', from_id: a.id, to_id: b.slice(0, 10), link_type: 'blocks', claim_token: a.token, dry_run: false });
    expect(r.link!.link_type).toBe('blocks');
    expect(r.from_row_version).toBe(2);
    expect(store.get({ id: a.id }).ticket.row_version).toBe(2);
    expect(store.get({ id: b }).ticket.row_version).toBe(1);
    expect(codeOf(() => store.link({ action: 'add', from_id: a.id, to_id: b, link_type: 'blocks', claim_token: a.token, dry_run: false }))).toBe('link_exists');
    expect(codeOf(() => store.link({ action: 'add', from_id: a.id, to_id: a.id, link_type: 'relates_to', claim_token: a.token, dry_run: false }))).toBe('self_loop');
    expect(codeOf(() => store.link({ action: 'add', from_id: a.id, to_id: b, link_type: 'blocks', claim_token: a.token, expected_version: 1, dry_run: false }))).toBe('version_conflict');
  });

  it('keeps DAG-class links acyclic across existing edges and lets lifecycle edges loop', () => {
    const { store } = fresh();
    const a = claimedTicket(store, 'alice', 'A');
    const b = claimedTicket(store, 'alice', 'B');
    const c = claimedTicket(store, 'alice', 'C');
    store.link({ action: 'add', from_id: a.id, to_id: b.id, link_type: 'depends_on', claim_token: a.token, dry_run: false });
    store.link({ action: 'add', from_id: b.id, to_id: c.id, link_type: 'parent_of', claim_token: b.token, dry_run: false });
    try {
      store.link({ action: 'add', from_id: c.id, to_id: a.id, link_type: 'blocks', claim_token: c.token, dry_run: false });
      expect.unreachable();
    } catch (e) {
      const err = e as { code: string; details: { path: string[] } };
      expect(err.code).toBe('cycle');
      expect(err.details.path).toEqual([c.id, a.id, b.id, c.id]);
    }
    // Same endpoints, a non-DAG type: fine.
    expect(store.link({ action: 'add', from_id: c.id, to_id: a.id, link_type: 'conflicts_with', claim_token: c.token, dry_run: false }).link).not.toBeNull();
    expect(store.link({ action: 'add', from_id: a.id, to_id: c.id, link_type: 'conflicts_with', claim_token: a.token, dry_run: false }).link).not.toBeNull();
    // Removing the middle edge opens the way.
    store.link({ action: 'remove', from_id: b.id, to_id: c.id, link_type: 'parent_of', claim_token: b.token, dry_run: false });
    expect(store.link({ action: 'add', from_id: c.id, to_id: a.id, link_type: 'blocks', claim_token: c.token, dry_run: false }).link).not.toBeNull();
  });

  it('remove tombstones (history keeps it), is fenced, and replays by key', () => {
    const { store } = fresh();
    const a = claimedTicket(store, 'alice', 'A');
    const b = store.create({ ...base, title: 'B' }).ticket.id;
    const added = store.link({ action: 'add', from_id: a.id, to_id: b, link_type: 'relates_to', claim_token: a.token, idempotency_key: 'l1', dry_run: false });
    const replay = store.link({ action: 'add', from_id: a.id, to_id: b, link_type: 'relates_to', claim_token: a.token, idempotency_key: 'l1', dry_run: false });
    expect(replay.replayed).toBe(true);
    expect(replay.link_id).toBe(added.link_id);
    expect(codeOf(() => store.link({ action: 'remove', from_id: a.id, to_id: b, link_type: 'blocks', claim_token: a.token, dry_run: false }))).toBe('not_found');
    const rm = store.link({ action: 'remove', from_id: a.id, to_id: b, link_type: 'relates_to', claim_token: a.token, reason: 'wrong', dry_run: false });
    expect(rm.link_id).toBe(added.link_id);
    expect(store.get({ id: a.id }).links).toEqual([]);
    const row = store.db.prepare(`SELECT state, tombstoned_by FROM sea_links WHERE link_id = ?`).get(added.link_id) as { state: string; tombstoned_by: string };
    expect(row).toEqual({ state: 'tombstoned', tombstoned_by: 'alice' });
    const ev = [...store.chain.iterate()].find((e) => e.event_type === EVENT.link_tombstoned)!;
    expect(ev.payload).toMatchObject({ link_id: added.link_id, target_id: added.link_id, reason: 'wrong' });
    // Re-adding after a tombstone is allowed (the unique index is partial on active rows).
    expect(store.link({ action: 'add', from_id: a.id, to_id: b, link_type: 'relates_to', claim_token: a.token, dry_run: false }).link).not.toBeNull();
  });
});

describe('sea_next', () => {
  const mk = (store: ReturnType<typeof fresh>['store'], title: string, extra: Partial<Parameters<typeof store.create>[0]> = {}) =>
    store.create({ ...base, title, ...extra }).ticket.id;

  it('returns nothing_eligible on an empty queue and never hands out idea / parked-priority / claimed tickets', () => {
    const { store } = fresh();
    expect(store.next({ include_unassigned: true })).toMatchObject({ ticket: null, reason: 'nothing_eligible', considered: 0 });
    mk(store, 'just an idea', { status: 'idea' });
    mk(store, 'parked priority', { priority: 'parked' });
    const held = mk(store, 'held');
    store.claim({ ticket_ids: [held], actor_id: 'bob' });
    expect(store.next({ include_unassigned: true }).ticket).toBeNull();
  });

  it('orders by priority, then in_progress before triaged, then age, and claims atomically', () => {
    const { store } = fresh();
    const low = mk(store, 'low', { priority: 'low' });
    const urgentOld = mk(store, 'urgent old', { priority: 'urgent' });
    const urgentNew = mk(store, 'urgent new', { priority: 'urgent' });
    const started = claimedTicket(store, 'alice', 'started');
    store.transition({ ticket_id: started.id, claim_token: started.token, to: 'in_progress', dry_run: false });
    store.update({ ticket_id: started.id, claim_token: started.token, priority: 'urgent', dry_run: false });
    store.release({ ticket_id: started.id, claim_token: started.token, force: false });

    const order: string[] = [];
    for (;;) {
      const r = store.next({ include_unassigned: true, lease_seconds: 60 });
      if (!r.ticket) break;
      expect(r.claim_token).toMatch(/^[0-9a-f]{64}$/);
      expect(r.ticket.claim?.holder).toBe('alice');
      order.push(r.ticket.id);
    }
    expect(order).toEqual([started.id, urgentOld, urgentNew, low]);
    const claimedEvents = [...store.chain.iterate()].filter((e) => e.event_type === EVENT.ticket_claimed && e.payload['via'] === 'sea_next');
    expect(claimedEvents).toHaveLength(4);
  });

  it('respects assignment: mine or unassigned, never someone else\'s', () => {
    const { store } = fresh();
    mk(store, 'bobs', { assignee: 'bob', priority: 'urgent' });
    const mine = mk(store, 'mine', { assignee: 'alice' });
    const free = mk(store, 'free', { priority: 'low' });
    expect(store.next({ include_unassigned: true }).ticket!.id).toBe(mine);
    expect(store.next({ include_unassigned: true }).ticket!.id).toBe(free);
    expect(store.next({ include_unassigned: true }).ticket).toBeNull();
    const { store: s2 } = fresh();
    mk(s2, 'free', { priority: 'urgent' });
    expect(s2.next({ include_unassigned: false }).ticket).toBeNull();
  });

  it('holds back tickets whose predecessors are not terminal (blocks and depends_on), and filters by kind/tag', () => {
    const { store } = fresh();
    const dep = claimedTicket(store, 'alice', 'dependency');
    const blocker = claimedTicket(store, 'alice', 'blocker');
    const target = claimedTicket(store, 'alice', 'target');
    store.link({ action: 'add', from_id: target.id, to_id: dep.id, link_type: 'depends_on', claim_token: target.token, dry_run: false });
    store.link({ action: 'add', from_id: blocker.id, to_id: target.id, link_type: 'blocks', claim_token: blocker.token, dry_run: false });
    store.release({ ticket_id: target.id, claim_token: target.token, force: false });
    store.release({ ticket_id: dep.id, claim_token: dep.token, force: false });
    store.release({ ticket_id: blocker.id, claim_token: blocker.token, force: false });
    const otherKind = store.create({ ...base, title: 'docs', kind: 'docs', tags: ['paper'] }).ticket.id;

    // target is ineligible; dep/blocker (kind bug) and docs are the candidates.
    expect(store.next({ include_unassigned: true, kind: ['feature'] }).ticket).toBeNull();
    expect(store.next({ include_unassigned: true, tag: 'paper' }).ticket!.id).toBe(otherKind);
    const first = store.next({ include_unassigned: true, kind: ['bug'] });
    expect([dep.id, blocker.id]).toContain(first.ticket!.id);
    const second = store.next({ include_unassigned: true, kind: ['bug'] });
    expect([dep.id, blocker.id]).toContain(second.ticket!.id);
    expect(store.next({ include_unassigned: true, kind: ['bug'] }).ticket).toBeNull(); // target still held back

    // Resolve the dependency, drop the blocker: target becomes eligible.
    store.transition({ ticket_id: dep.id, claim_token: first.ticket!.id === dep.id ? first.claim_token! : second.claim_token!, to: 'resolved', dry_run: false });
    expect(store.next({ include_unassigned: true, kind: ['bug'] }).ticket).toBeNull();
    store.transition({ ticket_id: blocker.id, claim_token: first.ticket!.id === blocker.id ? first.claim_token! : second.claim_token!, to: 'dropped', dry_run: false });
    expect(store.next({ include_unassigned: true, kind: ['bug'] }).ticket!.id).toBe(target.id);
  });

  it('frees expired leases before picking', () => {
    const { store, clock } = fresh();
    const t = claimedTicket(store, 'bob', 'abandoned');
    expect(store.next({ include_unassigned: true }).ticket).toBeNull();
    clock.advance(301);
    const r = store.next({ include_unassigned: true });
    expect(r.ticket!.id).toBe(t.id);
    expect(r.ticket!.claim!.holder).toBe('alice');
    expect([...store.chain.iterate()].filter((e) => e.event_type === EVENT.ticket_claim_expired)).toHaveLength(1);
  });
});
