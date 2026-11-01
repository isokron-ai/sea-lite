/**
 * sea_apply links to existing tickets: `from_id` (fenced by a claim token in
 * `claims`) and `to_id` (not fenced), cycle-checked over the union with
 * existing edges, all-or-nothing.
 */

import { describe, expect, it } from 'vitest';

import type { ApplyInput } from '../src/model/schemas.js';
import type { SeaLite } from '../src/store.js';
import { claimedTicket, fresh } from './helpers.js';

const base = { body: '', kind: 'chore' as const, priority: 'medium' as const, tags: [] as string[], status: 'triaged' as const };

function problems(fn: () => unknown): { code: string; problems: string[] } {
  try {
    fn();
  } catch (e) {
    const err = e as { code: string; details?: { problems?: { code: string }[] } };
    return { code: err.code, problems: (err.details?.problems ?? []).map((p) => p.code).sort() };
  }
  throw new Error('expected an error');
}

function apply(store: SeaLite, input: Partial<ApplyInput> & Pick<ApplyInput, 'tickets'>) {
  return store.apply({ links: [], dry_run: false, ...input });
}

describe('sea_apply with existing tickets', () => {
  it('a new ticket may depend on an existing one (to_id, no fence) and sea_next honours it', () => {
    const { store } = fresh();
    const existing = store.create({ title: 'foundation', ...base, dry_run: false }).ticket.id;
    const r = apply(store, {
      tickets: [{ ref: 'n', title: 'built on it', ...base }],
      links: [{ from_ref: 'n', to_id: existing.slice(0, 8), link_type: 'depends_on' }],
    });
    expect(r.links).toEqual([{ link_id: expect.any(String), from_ref: 'n', to_ref: null, from_id: r.tickets[0]!.ticket_id, to_id: existing, link_type: 'depends_on' }]);
    // the dependent waits: next hands out the foundation first
    expect(store.next({ include_unassigned: true }).ticket?.id).toBe(existing);
    store.close();
  });

  it('a link out of an existing ticket needs that ticket\'s claim token and bumps its row_version', () => {
    const { store } = fresh();
    const epic = claimedTicket(store, 'alice', 'existing epic');
    const v0 = store.get({ id: epic.id }).ticket.row_version;
    const tickets = [
      { ref: 'a', title: 'child a', ...base },
      { ref: 'b', title: 'child b', ...base },
    ];
    const links = [
      { from_id: epic.id, to_ref: 'a', link_type: 'parent_of' as const },
      { from_id: epic.id, to_ref: 'b', link_type: 'parent_of' as const },
    ];
    expect(problems(() => apply(store, { tickets, links }))).toEqual({ code: 'batch_invalid', problems: ['fence_missing'] });
    expect(store.chain.head().seq).toBe(2); // created + claimed: nothing written

    const r = apply(store, { tickets, links, claims: [{ ticket_id: epic.id, claim_token: epic.token }] });
    expect(r.links.map((l) => [l.from_ref, l.from_id])).toEqual([
      [null, epic.id],
      [null, epic.id],
    ]);
    const got = store.get({ id: epic.id });
    expect(got.ticket.row_version).toBe(v0 + 2);
    expect(got.links.filter((l) => l.direction === 'out').map((l) => l.peer.title).sort()).toEqual(['child a', 'child b']);

    // rebuild reproduces the bump from the payload
    const before = store.get({ id: epic.id }).ticket;
    store.rebuild();
    expect(store.get({ id: epic.id }).ticket).toEqual(before);
    store.close();
  });

  it('another actor\'s token, or a token for a ticket held by someone else, is refused by the fence', () => {
    const { store } = fresh();
    const held = claimedTicket(store, 'bob', 'bob holds this');
    const code = (() => {
      try {
        apply(store, {
          tickets: [{ ref: 'x', title: 'x', ...base }],
          links: [{ from_id: held.id, to_ref: 'x', link_type: 'parent_of' }],
          claims: [{ ticket_id: held.id, claim_token: held.token }],
        });
      } catch (e) {
        return (e as { code: string }).code;
      }
      return 'no_error';
    })();
    expect(code).toBe('fence_foreign_holder');
    store.close();
  });

  it('unknown ids, both-or-neither endpoints and duplicate existing links are batch_invalid', () => {
    const { store } = fresh();
    const a = claimedTicket(store, 'alice', 'a');
    const b = store.create({ title: 'b', ...base, dry_run: false }).ticket.id;
    store.link({ action: 'add', from_id: a.id, to_id: b, link_type: 'relates_to', claim_token: a.token, dry_run: false });
    expect(
      problems(() =>
        apply(store, {
          tickets: [{ ref: 'x', title: 'x', ...base }],
          links: [{ from_ref: 'x', to_id: '00000000-0000-0000-0000-000000000000', link_type: 'relates_to' }],
        }),
      ),
    ).toEqual({ code: 'batch_invalid', problems: ['unknown_ticket'] });
    expect(
      problems(() =>
        apply(store, {
          tickets: [{ ref: 'x', title: 'x', ...base }],
          links: [
            { from_ref: 'x', from_id: a.id, to_ref: 'x', link_type: 'relates_to' },
            { to_ref: 'x', link_type: 'relates_to' },
          ],
        }),
      ).problems,
    ).toContain('bad_endpoint');
    expect(
      problems(() =>
        apply(store, {
          tickets: [{ ref: 'x', title: 'x', ...base }],
          links: [{ from_id: a.id, to_id: b, link_type: 'relates_to' }],
          claims: [{ ticket_id: a.id, claim_token: a.token }],
        }),
      ),
    ).toEqual({ code: 'batch_invalid', problems: ['link_exists'] });
    store.close();
  });

  it('a cycle that closes only through existing links is caught, with the path', () => {
    const { store } = fresh();
    const a = claimedTicket(store, 'alice', 'A');
    const b = claimedTicket(store, 'alice', 'B');
    store.link({ action: 'add', from_id: a.id, to_id: b.id, link_type: 'depends_on', claim_token: a.token, dry_run: false });
    const head = store.chain.head().seq;
    // B depends_on N, N depends_on A, A depends_on B (existing) → cycle
    type CycleErr = { code: string; details: { path: string[] } };
    let err = null as CycleErr | null;
    try {
      apply(store, {
        tickets: [{ ref: 'n', title: 'N', ...base }],
        links: [
          { from_id: b.id, to_ref: 'n', link_type: 'depends_on' },
          { from_ref: 'n', to_id: a.id, link_type: 'depends_on' },
        ],
        claims: [{ ticket_id: b.id, claim_token: b.token }],
      });
    } catch (e) {
      err = e as CycleErr;
    }
    expect(err?.code).toBe('cycle');
    expect(err?.details.path).toEqual(expect.arrayContaining([a.id, b.id, 'n']));
    expect(store.chain.head().seq).toBe(head);
    store.close();
  });

  it('dry_run validates against the store and reports resolved ids without writing', () => {
    const { store } = fresh();
    const a = claimedTicket(store, 'alice', 'A');
    const head = store.chain.head().seq;
    const r = apply(store, {
      tickets: [{ ref: 'n', title: 'N', ...base }],
      links: [{ from_id: a.id.slice(0, 8), to_ref: 'n', link_type: 'parent_of' }],
      claims: [{ ticket_id: a.id, claim_token: a.token }],
      dry_run: true,
    });
    expect(r.dry_run).toBe(true);
    expect(r.links[0]).toMatchObject({ from_ref: null, from_id: a.id, to_ref: 'n', to_id: '(dry_run)' });
    expect(store.chain.head().seq).toBe(head);
    store.close();
  });
});
