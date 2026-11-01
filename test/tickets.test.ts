import { describe, expect, it } from 'vitest';

import { EVENT } from '../src/core/events.js';
import type { ApplyInput } from '../src/model/schemas.js';
import { claimedTicket, codeOf, fresh } from './helpers.js';

const base = { body: '', kind: 'chore' as const, priority: 'medium' as const, tags: [] as string[], status: 'idea' as const, dry_run: false };

describe('sea_create', () => {
  it('creates with defaults, chains sea_ticket.created with the row snapshot, and can claim in the same call', () => {
    const { store } = fresh();
    const r = store.create({ ...base, title: 'Hello', claim_seconds: 120 });
    expect(r.ticket.status).toBe('idea');
    expect(r.ticket.row_version).toBe(1);
    expect(r.claim_token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.ticket.claim?.holder).toBe('alice');
    expect(r.replayed).toBe(false);
    const ev = store.chain.get(1)!;
    expect(ev.event_type).toBe(EVENT.ticket_created);
    expect(ev.payload).toMatchObject({ ticket_id: r.ticket.id, title: 'Hello', status: 'idea', created_by: 'alice' });
    expect(store.chain.get(2)!.event_type).toBe(EVENT.ticket_claimed);
  });

  it('reports possible duplicates (exact + FTS) without blocking', () => {
    const { store } = fresh();
    const a = store.create({ ...base, title: 'Rotate the signing keys' });
    const b = store.create({ ...base, title: 'Unrelated thing' });
    const r = store.create({ ...base, title: 'rotate THE signing keys' });
    expect(r.ticket.id).not.toBe(a.ticket.id);
    expect(r.possible_duplicates.map((d) => d.ticket_id)).toContain(a.ticket.id);
    expect(r.possible_duplicates.find((d) => d.ticket_id === a.ticket.id)!.exact_title_match).toBe(true);
    expect(r.possible_duplicates.map((d) => d.ticket_id)).not.toContain(b.ticket.id);
    const fuzzy = store.create({ ...base, title: 'signing key rotation' });
    expect(fuzzy.possible_duplicates.map((d) => d.ticket_id)).toContain(a.ticket.id);
    expect(fuzzy.possible_duplicates[0]!.exact_title_match).toBe(false);
    expect(fuzzy.possible_duplicates[0]!.score).toBeGreaterThan(0);
    expect(fuzzy.possible_duplicates.length).toBeLessThanOrEqual(5);
  });

  it('dry_run writes nothing but still reports duplicates', () => {
    const { store } = fresh();
    store.create({ ...base, title: 'Same title' });
    const r = store.create({ ...base, title: 'Same title', dry_run: true });
    expect(r.dry_run).toBe(true);
    expect(r.possible_duplicates).toHaveLength(1);
    expect(store.chain.head().seq).toBe(1);
  });

  it('idempotency_key replays the original result without a second write', () => {
    const { store } = fresh();
    const a = store.create({ ...base, title: 'Once', idempotency_key: 'k1' });
    // A different request under the same key is refused (0.4.0 replayed it), and writes nothing.
    expect(codeOf(() => store.create({ ...base, title: 'Once but different', idempotency_key: 'k1' }))).toBe('invalid_input');
    const b = store.create({ ...base, title: 'Once', idempotency_key: 'k1' });
    expect(b.replayed).toBe(true);
    expect(b.ticket.id).toBe(a.ticket.id);
    expect(b.ticket.title).toBe('Once');
    expect(store.chain.head().seq).toBe(1);
    // Namespaced under sea: on the shared column.
    expect(store.chain.get(1)!.idempotency_key).toBe('sea:k1');
    // Reusing the key for another operation is an error, not a silent replay.
    const t = claimedTicket(store);
    expect(codeOf(() => store.update({ ticket_id: t.id, claim_token: t.token, title: 'z', idempotency_key: 'k1', dry_run: false }))).toBe('invalid_input');
  });
});

describe('sea_apply', () => {
  const batch: ApplyInput = {
    tickets: [
      { ref: 'epic', title: 'Epic', ...base, kind: 'epic' },
      { ref: 'a', title: 'Task A', ...base, status: 'triaged' },
      { ref: 'b', title: 'Task B', ...base, status: 'triaged' },
    ],
    links: [
      { from_ref: 'epic', to_ref: 'a', link_type: 'parent_of' },
      { from_ref: 'epic', to_ref: 'b', link_type: 'parent_of' },
      { from_ref: 'b', to_ref: 'a', link_type: 'depends_on' },
    ],
    dry_run: false,
  };

  it('writes tickets, links and a batch summary atomically, and replays by key', () => {
    const { store } = fresh();
    const r = store.apply({ ...batch, idempotency_key: 'batch-1' });
    expect(r.tickets).toHaveLength(3);
    expect(r.links).toHaveLength(3);
    const types = [...store.chain.iterate()].map((e) => e.event_type);
    expect(types.filter((t) => t === EVENT.ticket_created)).toHaveLength(3);
    expect(types.filter((t) => t === EVENT.link_created)).toHaveLength(3);
    expect(types[types.length - 1]).toBe(EVENT.batch_applied);
    const a = r.tickets.find((t) => t.ref === 'a')!;
    const got = store.get({ id: a.ticket_id });
    expect(got.links.map((l) => `${l.direction}:${l.link_type}`).sort()).toEqual(['in:depends_on', 'in:parent_of']);

    const again = store.apply({ ...batch, idempotency_key: 'batch-1' });
    expect(again.replayed).toBe(true);
    expect(again.batch_id).toBe(r.batch_id);
    expect(again.tickets).toEqual(r.tickets);
    expect(store.chain.head().seq).toBe(7);
  });

  it('dry_run validates without writing', () => {
    const { store } = fresh();
    const r = store.apply({ ...batch, dry_run: true });
    expect(r.dry_run).toBe(true);
    expect(r.tickets.every((t) => t.ticket_id === '(dry_run)')).toBe(true);
    expect(store.chain.head().seq).toBe(0);
  });

  it('rejects duplicate refs, foreign refs, self-loops and duplicate links together, writing nothing', () => {
    const { store } = fresh();
    try {
      store.apply({
        tickets: [
          { ref: 'x', title: 'X', ...base },
          { ref: 'x', title: 'X again', ...base },
        ],
        links: [
          { from_ref: 'x', to_ref: 'ghost', link_type: 'blocks' },
          { from_ref: 'x', to_ref: 'x', link_type: 'relates_to' },
          { from_ref: 'x', to_ref: 'x', link_type: 'relates_to' },
        ],
        dry_run: false,
      });
      expect.unreachable();
    } catch (e) {
      const err = e as { code: string; details: { problems: { code: string }[] } };
      expect(err.code).toBe('batch_invalid');
      const codes = [...new Set(err.details.problems.map((p) => p.code))].sort();
      expect(codes).toEqual(['duplicate_link', 'duplicate_ref', 'foreign_ref', 'self_loop'].sort());
      expect(err.details.problems).toHaveLength(5); // both self-loop links are reported
    }
    expect(store.chain.head().seq).toBe(0);
  });

  it('rejects a jointly cyclic batch with the path', () => {
    const { store } = fresh();
    try {
      store.apply({
        tickets: [
          { ref: 'a', title: 'A', ...base },
          { ref: 'b', title: 'B', ...base },
          { ref: 'c', title: 'C', ...base },
        ],
        links: [
          { from_ref: 'a', to_ref: 'b', link_type: 'depends_on' },
          { from_ref: 'b', to_ref: 'c', link_type: 'blocks' },
          { from_ref: 'c', to_ref: 'a', link_type: 'parent_of' },
        ],
        dry_run: false,
      });
      expect.unreachable();
    } catch (e) {
      const err = e as { code: string; details: { path: string[] } };
      expect(err.code).toBe('cycle');
      expect(err.details.path[0]).toBe(err.details.path[err.details.path.length - 1]);
    }
    expect(store.chain.head().seq).toBe(0);
  });

  it('refuses more than 50 tickets at the schema boundary', async () => {
    const { ApplyInput: Schema } = await import('../src/model/schemas.js');
    const many = Array.from({ length: 51 }, (_, i) => ({ ref: `r${i}`, title: `T${i}` }));
    expect(Schema.safeParse({ tickets: many }).success).toBe(false);
    expect(Schema.safeParse({ tickets: many.slice(0, 50) }).success).toBe(true);
  });
});

describe('sea_update', () => {
  it('is fenced, bumps row_version, records only the fields that changed, and appends notes', () => {
    const { store } = fresh();
    const { id, token } = claimedTicket(store);
    expect(codeOf(() => store.update({ ticket_id: id, claim_token: 'f'.repeat(64), title: 'nope', dry_run: false }))).toBe('fence_invalid');
    const r = store.update({ ticket_id: id, claim_token: token, title: 'Fix the thing', priority: 'urgent', add_tags: ['hot', 't'], remove_tags: ['nothere'], note: 'looking', dry_run: false });
    expect(r.changed.sort()).toEqual(['priority', 'tags']); // title unchanged → not recorded
    expect(r.row_version).toBe(2);
    expect(r.ticket!.tags).toEqual(['t', 'hot']);
    expect(r.ticket!.claim!.write_count).toBe(1);
    expect(r.note!.body).toBe('looking');
    expect(codeOf(() => store.update({ ticket_id: id, claim_token: token, title: 'Fix the thing', dry_run: false }))).toBe('invalid_input');
    const noteOnly = store.update({ ticket_id: id, claim_token: token, note: 'just a note', dry_run: false });
    expect(noteOnly.changed).toEqual([]);
    expect(noteOnly.row_version).toBe(2);
  });

  it('enforces expected_version (OCC) and carries the current state in the error', () => {
    const { store } = fresh();
    const { id, token } = claimedTicket(store);
    store.update({ ticket_id: id, claim_token: token, body: 'v2', dry_run: false });
    try {
      store.update({ ticket_id: id, claim_token: token, body: 'v3', expected_version: 1, dry_run: false });
      expect.unreachable();
    } catch (e) {
      const err = e as { code: string; details: Record<string, unknown> };
      expect(err.code).toBe('version_conflict');
      expect(err.details['current_version']).toBe(2);
      expect(err.details['expected_version']).toBe(1);
    }
    expect(store.update({ ticket_id: id, claim_token: token, body: 'v3', expected_version: 2, dry_run: false }).row_version).toBe(3);
  });

  it('idempotent replay returns the original change set and does not re-apply', () => {
    const { store } = fresh();
    const { id, token } = claimedTicket(store);
    const a = store.update({ ticket_id: id, claim_token: token, body: 'first', idempotency_key: 'u1', dry_run: false });
    expect(codeOf(() => store.update({ ticket_id: id, claim_token: token, body: 'second', idempotency_key: 'u1', dry_run: false }))).toBe('invalid_input');
    const b = store.update({ ticket_id: id, claim_token: token, body: 'first', idempotency_key: 'u1', dry_run: false });
    expect(b.replayed).toBe(true);
    expect(b.changed).toEqual(['body']);
    expect(b.row_version).toBe(a.row_version);
    expect(store.get({ id }).ticket.body).toBe('first');
  });

  it('dry_run reports changes without writing', () => {
    const { store } = fresh();
    const { id, token } = claimedTicket(store);
    const head = store.chain.head().seq;
    const r = store.update({ ticket_id: id, claim_token: token, title: 'new', dry_run: true });
    expect(r.dry_run).toBe(true);
    expect(r.changed).toEqual(['title']);
    expect(store.chain.head().seq).toBe(head);
    expect(store.get({ id }).ticket.title).toBe('Fix the thing');
  });
});

describe('sea_transition', () => {
  it('walks the work track, rejects illegal moves with legal_next, and releases the claim on a terminal', () => {
    const { store } = fresh();
    const { id, token } = claimedTicket(store); // triaged
    try {
      store.transition({ ticket_id: id, claim_token: token, to: 'resolved', dry_run: true });
    } catch {
      expect.unreachable('triaged → resolved is legal (active → terminal)');
    }
    try {
      store.transition({ ticket_id: id, claim_token: token, to: 'idea', dry_run: false });
      expect.unreachable();
    } catch (e) {
      const err = e as { code: string; details: { legal_next: string[]; reason: string } };
      expect(err.code).toBe('illegal_transition');
      expect(err.details.reason).toBe('illegal_track_jump');
      expect(err.details.legal_next).toContain('in_progress');
    }
    const r1 = store.transition({ ticket_id: id, claim_token: token, to: 'in_progress', reason: 'starting', dry_run: false });
    expect(r1.claim_released).toBe(false);
    expect(r1.ticket!.row_version).toBe(2);
    const r2 = store.transition({ ticket_id: id, claim_token: token, to: 'resolved', dry_run: false });
    expect(r2.claim_released).toBe(true);
    expect(r2.ticket!.claim).toBeNull();
    expect(r2.legal_next).toEqual([]);
    // Terminal: even a fresh claim cannot move it.
    const again = store.claim({ ticket_ids: [id] });
    expect(codeOf(() => store.transition({ ticket_id: id, claim_token: again.claims[0]!.claim_token, to: 'idea', dry_run: false }))).toBe('illegal_transition');
  });

  it('duplicate requires duplicate_of and records a duplicates link', () => {
    const { store } = fresh();
    const original = store.create({ ...base, title: 'Original' }).ticket.id;
    const { id, token } = claimedTicket(store, 'alice', 'Original (again)');
    expect(codeOf(() => store.transition({ ticket_id: id, claim_token: token, to: 'duplicate', dry_run: false }))).toBe('invalid_input');
    expect(codeOf(() => store.transition({ ticket_id: id, claim_token: token, to: 'duplicate', duplicate_of: id, dry_run: false }))).toBe('self_loop');
    const r = store.transition({ ticket_id: id, claim_token: token, to: 'duplicate', duplicate_of: original.slice(0, 8), dry_run: false });
    expect(r.duplicates_link_id).toBeTruthy();
    expect(r.ticket!.duplicate_of).toBe(original);
    const got = store.get({ id: original });
    expect(got.links.map((l) => `${l.direction}:${l.link_type}`)).toEqual(['in:duplicates']);
  });

  it('is fenced, honours expected_version and replays by key', () => {
    const { store } = fresh();
    const { id, token } = claimedTicket(store);
    expect(codeOf(() => store.transition({ ticket_id: id, claim_token: token, to: 'in_progress', actor_id: 'bob', dry_run: false }))).toBe('fence_foreign_holder');
    expect(codeOf(() => store.transition({ ticket_id: id, claim_token: token, to: 'in_progress', expected_version: 9, dry_run: false }))).toBe('version_conflict');
    const a = store.transition({ ticket_id: id, claim_token: token, to: 'in_progress', idempotency_key: 't1', dry_run: false });
    expect(codeOf(() => store.transition({ ticket_id: id, claim_token: token, to: 'parked', idempotency_key: 't1', dry_run: false }))).toBe('invalid_input');
    const b = store.transition({ ticket_id: id, claim_token: token, to: 'in_progress', idempotency_key: 't1', dry_run: false });
    expect(b.replayed).toBe(true);
    expect(b.to).toBe('in_progress');
    expect(b.from).toBe(a.from);
    expect(store.get({ id }).ticket.status).toBe('in_progress');
  });

  it('respects the design track config', () => {
    const { store } = fresh({ tracks: ['work', 'design'] });
    const { id, token } = claimedTicket(store);
    // claimedTicket creates triaged; design starts from idea.
    const idea = store.create({ ...base, title: 'design me', claim_seconds: 60 });
    const r = store.transition({ ticket_id: idea.ticket.id, claim_token: idea.claim_token!, to: 'in_design', dry_run: false });
    expect(r.to).toBe('in_design');
    expect(codeOf(() => store.transition({ ticket_id: id, claim_token: token, to: 'ready', dry_run: false }))).toBe('illegal_transition');
  });
});

describe('sea_get / sea_list', () => {
  it('resolves prefixes and rejects ambiguous or short ones', () => {
    const { store } = fresh();
    const a = store.create({ ...base, title: 'A' }).ticket.id;
    expect(store.get({ id: a.slice(0, 12) }).ticket.id).toBe(a);
    expect(codeOf(() => store.get({ id: 'zzzzzzzz' }))).toBe('not_found');
    expect(codeOf(() => store.get({ id: 'abc' }))).toBe('invalid_input');
    // Force an ambiguous prefix by inserting a second row sharing the first 8 chars.
    const fakeId = a.slice(0, 8) + '-ffff-4fff-8fff-ffffffffffff';
    store.db
      .prepare(`INSERT INTO sea_tickets (id, kind, title, body, status, priority, tags, created_by, created_at, updated_at, created_seq, last_seq)
                VALUES (?, 'chore', 'B', '', 'idea', 'medium', '[]', 'x', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 1)`)
      .run(fakeId);
    expect(codeOf(() => store.get({ id: a.slice(0, 8) }))).toBe('ambiguous_id');
  });

  it('filters, searches and pages', () => {
    const { store } = fresh();
    for (let i = 0; i < 7; i++) {
      store.create({ ...base, title: `Widget ${i}`, body: i % 2 ? 'alpha gadget' : 'beta gizmo', priority: i < 3 ? 'urgent' : 'low', tags: i < 2 ? ['x'] : [], status: 'triaged' });
    }
    const done = claimedTicket(store, 'alice', 'Finished');
    store.transition({ ticket_id: done.id, claim_token: done.token, to: 'resolved', dry_run: false });

    const all = store.list({ include_terminal: false, claimed: 'any', limit: 50, view: 'compact' });
    expect(all.count).toBe(7);
    expect(all.tickets[0]!.priority).toBe('urgent');
    expect(store.list({ include_terminal: true, claimed: 'any', limit: 50, view: 'compact' }).count).toBe(8);
    expect(store.list({ status: ['resolved'], include_terminal: false, claimed: 'any', limit: 50, view: 'compact' }).count).toBe(1);
    expect(store.list({ tag: 'x', include_terminal: false, claimed: 'any', limit: 50, view: 'compact' }).count).toBe(2);
    expect(store.list({ priority: ['low'], include_terminal: false, claimed: 'any', limit: 50, view: 'compact' }).count).toBe(4);
    const q = store.list({ query: 'alpha', include_terminal: false, claimed: 'any', limit: 50, view: 'full' });
    expect(q.count).toBe(3);
    expect((q.tickets[0] as { body: string }).body).toContain('alpha');

    const p1 = store.list({ include_terminal: false, claimed: 'any', limit: 3, view: 'compact' });
    expect(p1.count).toBe(3);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = store.list({ include_terminal: false, claimed: 'any', limit: 3, view: 'compact', cursor: p1.next_cursor! });
    const p3 = store.list({ include_terminal: false, claimed: 'any', limit: 3, view: 'compact', cursor: p2.next_cursor! });
    expect(p3.count).toBe(1);
    expect(p3.next_cursor).toBeNull();
    const ids = [...p1.tickets, ...p2.tickets, ...p3.tickets].map((t) => t.id);
    expect(new Set(ids).size).toBe(7);
    expect(codeOf(() => store.list({ include_terminal: false, claimed: 'any', limit: 3, view: 'compact', cursor: '!!!' }))).toBe('invalid_input');
  });

  it('assignee and claim filters understand me / none / mine', () => {
    const { store } = fresh();
    store.create({ ...base, title: 'mine', assignee: 'alice' });
    store.create({ ...base, title: 'bobs', assignee: 'bob' });
    store.create({ ...base, title: 'nobody' });
    const c = claimedTicket(store, 'alice', 'held');
    expect(store.list({ assignee: 'me', include_terminal: false, claimed: 'any', limit: 50, view: 'compact' }).tickets.map((t) => t.title)).toEqual(['mine']);
    expect(store.list({ assignee: 'none', include_terminal: false, claimed: 'any', limit: 50, view: 'compact' }).count).toBe(2);
    expect(store.list({ claimed: 'mine', include_terminal: false, limit: 50, view: 'compact' }).tickets[0]!.id).toBe(c.id);
    expect(store.list({ claimed: 'no', include_terminal: false, limit: 50, view: 'compact' }).count).toBe(3);
    expect(store.list({ claimed: 'yes', include_terminal: false, limit: 50, view: 'compact', actor_id: 'bob' }).count).toBe(1);
  });
});
