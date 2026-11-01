/**
 * Bulk transitions (sea_transition `tickets`) and the one-call finish
 * (sea_finish): every ticket fenced by its own claim token, all or nothing,
 * an optional note, the claim released on a terminal status, replay-safe.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { EVENT } from '../src/core/events.js';
import type { SeaError } from '../src/core/errors.js';
import type { SeaLite } from '../src/store.js';
import { FinishInput } from '../src/model/schemas.js';
import { claimedTicket, codeOf, fresh } from './helpers.js';
import { assertStrictOutput, connectInMemory, parse, type ToolResult } from './mcp-helpers.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function three(store: SeaLite) {
  return [claimedTicket(store, 'alice', 'one'), claimedTicket(store, 'alice', 'two'), claimedTicket(store, 'alice', 'three')];
}
const items = (ts: { id: string; token: string }[]) => ts.map((t) => ({ ticket_id: t.id, claim_token: t.token }));

describe('transitionMany (store)', () => {
  it('moves every ticket, each fenced by its own token, with a note on each', () => {
    const { store } = fresh();
    const ts = three(store);
    const r = store.transitionMany({ tickets: items(ts), to: 'in_progress', note: 'starting', dry_run: false });
    expect(r.count).toBe(3);
    expect(r.results.map((x) => [x.title, x.from, x.to, x.claim_released])).toEqual([
      ['one', 'triaged', 'in_progress', false],
      ['two', 'triaged', 'in_progress', false],
      ['three', 'triaged', 'in_progress', false],
    ]);
    for (const t of ts) {
      const g = store.get({ id: t.id });
      expect(g.ticket.status).toBe('in_progress');
      expect(g.notes.map((n) => n.body)).toEqual(['starting']);
    }
  });

  it('is all or nothing: one bad token (or illegal move) rejects the set, naming every failing ticket', () => {
    const { store } = fresh();
    const ts = three(store);
    const bob = claimedTicket(store, 'bob', 'bobs');
    const bad = [...items(ts), { ticket_id: bob.id, claim_token: ts[0]!.token }];
    let err: SeaError | undefined;
    try {
      store.transitionMany({ tickets: bad, to: 'in_progress', dry_run: false });
    } catch (e) {
      err = e as SeaError;
    }
    expect(err?.code).toBe('batch_invalid');
    const problems = (err!.details as { problems: { ticket_id: string; error: string }[] }).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]!.ticket_id).toBe(bob.id);
    expect(problems[0]!.error).toMatch(/^fence_|^not_holder|claim/);
    for (const t of ts) expect(store.get({ id: t.id }).ticket.status).toBe('triaged');
  });

  it('a single ticket keeps its own error code; a ticket listed twice is refused', () => {
    const { store } = fresh();
    const [a] = three(store);
    expect(codeOf(() => store.transitionMany({ tickets: [{ ticket_id: a!.id, claim_token: 'f'.repeat(64) }], to: 'in_progress', dry_run: false }))).toMatch(/^fence_/);
    expect(codeOf(() => store.transitionMany({ tickets: [items([a!])[0]!, items([a!])[0]!], to: 'in_progress', dry_run: false }))).toBe('batch_invalid');
  });

  it('idempotency_key replays (item k uses key#k) and dry_run writes nothing', () => {
    const { store } = fresh();
    const ts = three(store);
    const head = store.chain.head().seq;
    const dry = store.transitionMany({ tickets: items(ts), to: 'parked', dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect(store.chain.head().seq).toBe(head);
    const a = store.transitionMany({ tickets: items(ts), to: 'parked', idempotency_key: 'park', dry_run: false });
    const b = store.transitionMany({ tickets: items(ts), to: 'parked', idempotency_key: 'park', dry_run: false });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(store.chain.head().seq).toBe(head + 3);
  });
});

describe('finish (store)', () => {
  it('outcome done: note + commit + resolved + claim released, recorded on the chain and on the ticket', () => {
    const { store } = fresh();
    const t = claimedTicket(store);
    const r = store.finish({ ticket_id: t.id, claim_token: t.token, outcome: 'done', note: 'shipped retry logic', commit: 'ABC1234', dry_run: false });
    expect(r).toMatchObject({ outcome: 'done', commit: 'abc1234', replayed: false, dry_run: false });
    expect(r.finished[0]).toMatchObject({ ticket_id: t.id, from: 'triaged', to: 'resolved', claim_released: true });
    const g = store.get({ id: t.id });
    expect(g.ticket.status).toBe('resolved');
    expect(g.ticket.claim).toBeNull();
    expect(g.notes.map((n) => n.body)).toEqual(['done @ abc1234: shipped retry logic']);
    const evs = store.chain.since(0);
    const status = evs.filter((e) => e.event_type === EVENT.ticket_status_set).pop()!;
    expect(status.payload).toMatchObject({ to: 'resolved', outcome: 'done', commit: 'abc1234', reason: 'finish: done' });
    const note = evs.filter((e) => e.event_type === EVENT.ticket_note_added).pop()!;
    expect(note.payload['finish']).toEqual({ outcome: 'done', commit: 'abc1234', from: 'triaged', to: 'resolved' });
    const hist = store.history({ ticket_id: t.id, limit: 100, verify: true });
    expect(hist.events.some((e) => (e.payload as { finish?: { outcome: string } }).finish?.outcome === 'done')).toBe(true);
  });

  it('outcome blocked: status blocked (not terminal), claim released, ticket can be resumed later', () => {
    const { store } = fresh();
    const t = claimedTicket(store);
    const r = store.finish({ ticket_id: t.id, claim_token: t.token, outcome: 'blocked', note: 'waiting on the auth API', dry_run: false });
    expect(r.finished[0]).toMatchObject({ from: 'triaged', to: 'blocked', claim_released: true });
    const g = store.get({ id: t.id });
    expect(g.ticket.status).toBe('blocked');
    expect(g.ticket.claim).toBeNull();
    expect(g.legal_next).toContain('in_progress');
    expect(g.notes.map((n) => n.body)).toEqual(['blocked: waiting on the auth API']);
    // Someone picks it up again and resumes it.
    const again = store.claim({ ticket_ids: [t.id], actor_id: 'bob' });
    store.transition({ ticket_id: t.id, claim_token: again.claims[0]!.claim_token, to: 'in_progress', dry_run: false, actor_id: 'bob' });
    expect(store.get({ id: t.id }).ticket.status).toBe('in_progress');
  });

  it('outcome blocked on an already-blocked ticket: no status change, note and release only', () => {
    const { store } = fresh();
    const t = claimedTicket(store);
    store.transition({ ticket_id: t.id, claim_token: t.token, to: 'blocked', dry_run: false });
    const r = store.finish({ ticket_id: t.id, claim_token: t.token, outcome: 'blocked', note: 'still waiting', dry_run: false });
    expect(r.finished[0]).toMatchObject({ from: 'blocked', to: 'blocked', claim_released: true });
    expect(store.get({ id: t.id }).ticket.claim).toBeNull();
  });

  it('outcome abandoned closes several as dropped; a closed ticket cannot be finished again', () => {
    const { store } = fresh();
    const ts = three(store);
    const r = store.finish({ tickets: items(ts), outcome: 'abandoned', note: 'superseded by the v3 plan', dry_run: false });
    expect(r.finished.map((x) => x.to)).toEqual(['dropped', 'dropped', 'dropped']);
    expect(store.list({ claimed: 'mine', limit: 50, view: 'compact', include_terminal: true }).count).toBe(0);
    expect(codeOf(() => store.finish({ ticket_id: ts[0]!.id, claim_token: ts[0]!.token, outcome: 'done', note: 'x', dry_run: false }))).toMatch(/^fence_|illegal_transition/);
  });

  it('all or nothing: one foreign token fails the set with every problem named', () => {
    const { store } = fresh();
    const ts = three(store);
    const bob = claimedTicket(store, 'bob', 'bobs');
    expect(codeOf(() => store.finish({ tickets: [...items(ts), { ticket_id: bob.id, claim_token: ts[0]!.token }], outcome: 'done', note: 'n', dry_run: false }))).toBe('batch_invalid');
    for (const t of ts) expect(store.get({ id: t.id }).ticket.status).toBe('triaged');
  });

  it('idempotency_key replays instead of writing twice; dry_run writes nothing', () => {
    const { store } = fresh();
    const ts = three(store);
    const head = store.chain.head().seq;
    const dry = store.finish({ tickets: items(ts), outcome: 'done', note: 'n', dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect(store.chain.head().seq).toBe(head);
    const a = store.finish({ tickets: items(ts), outcome: 'blocked', note: 'n', idempotency_key: 'fin', dry_run: false });
    const after = store.chain.head().seq;
    const b = store.finish({ tickets: items(ts), outcome: 'blocked', note: 'n', idempotency_key: 'fin', dry_run: false });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.finished.map((x) => x.to)).toEqual(['blocked', 'blocked', 'blocked']);
    expect(store.chain.head().seq).toBe(after);
  });

  it('needs exactly one ticket form; the note is required, non-empty and capped; commit must be a sha', () => {
    const { store } = fresh();
    const t = claimedTicket(store);
    expect(codeOf(() => store.finish({ outcome: 'done', note: 'n', dry_run: false }))).toBe('invalid_input');
    expect(codeOf(() => store.finish({ ticket_id: t.id, claim_token: t.token, tickets: items([t]), outcome: 'done', note: 'n', dry_run: false }))).toBe('invalid_input');
    const S = FinishInput;
    expect(S.safeParse({ ticket_id: t.id, claim_token: t.token, outcome: 'done' }).success).toBe(false);
    expect(S.safeParse({ ticket_id: t.id, claim_token: t.token, outcome: 'done', note: '   ' }).success).toBe(false);
    expect(S.safeParse({ ticket_id: t.id, claim_token: t.token, outcome: 'done', note: 'x'.repeat(1001) }).success).toBe(false);
    expect(S.safeParse({ ticket_id: t.id, claim_token: t.token, outcome: 'done', note: 'ok', commit: 'not-a-sha' }).success).toBe(false);
    expect(S.safeParse({ ticket_id: t.id, claim_token: t.token, outcome: 'finished', note: 'ok' }).success).toBe(false);
    expect(S.safeParse({ ticket_id: t.id, claim_token: t.token, outcome: 'done', note: 'ok', commit: 'deadbeef' }).success).toBe(true);
  });

  it('a finished chain unblocks sea_next for the dependent ticket', () => {
    const { store } = fresh();
    const r = store.apply({
      tickets: [
        { ref: 'a', title: 'first', body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged' },
        { ref: 'b', title: 'second', body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged' },
      ],
      links: [{ from_ref: 'b', to_ref: 'a', link_type: 'depends_on' }],
      dry_run: false,
    });
    const n1 = store.next({ include_unassigned: true });
    expect(n1.ticket?.title).toBe('first');
    store.finish({ ticket_id: n1.ticket!.id, claim_token: n1.claim_token!, outcome: 'done', note: 'done', dry_run: false });
    const n2 = store.next({ include_unassigned: true });
    expect(n2.ticket?.id).toBe(r.tickets[1]!.ticket_id);
  });

  it('rebuild replays a finish exactly', () => {
    const { store } = fresh();
    const t = claimedTicket(store);
    store.finish({ ticket_id: t.id, claim_token: t.token, outcome: 'blocked', note: 'waiting', commit: 'abcdef1', dry_run: false });
    const before = store.get({ id: t.id });
    store.rebuild();
    const after = store.get({ id: t.id });
    expect(after.ticket.status).toBe(before.ticket.status);
    expect(after.ticket.claim).toBeNull();
    expect(after.notes.map((n) => n.body)).toEqual(before.notes.map((n) => n.body));
  });
});

describe('over MCP', () => {
  it('sea_finish needs no confirmation round trip; sea_transition bulk to a terminal state asks once', async () => {
    const { store } = fresh();
    const asked: string[] = [];
    const { client, close } = await connectInMemory(store, {
      elicit: ({ message }) => {
        asked.push(message);
        return { action: 'accept', content: { confirm: true } };
      },
    });
    closers.push(close, async () => store.close());
    const ts = three(store);
    const fin = await client.callTool({ name: 'sea_finish', arguments: { ticket_id: ts[0]!.id, claim_token: ts[0]!.token, outcome: 'done', note: 'done', commit: 'abc1234' } });
    await assertStrictOutput('sea_finish', fin);
    expect(asked).toHaveLength(0);
    const bulk = await client.callTool({ name: 'sea_transition', arguments: { tickets: items(ts.slice(1)), to: 'dropped' } });
    await assertStrictOutput('sea_transition', bulk);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/2 tickets/);
    expect(asked[0]).toMatch(/"two"/);
    expect(parse<{ count: number; results: { to: string }[] }>(bulk)).toMatchObject({ count: 2, results: [{ to: 'dropped' }, { to: 'dropped' }] });
  });

  it('bulk without elicitation: confirmation_required listing the tickets; confirm: true goes through; single form unchanged', async () => {
    const { store } = fresh();
    const { client, close } = await connectInMemory(store);
    closers.push(close, async () => store.close());
    const ts = three(store);
    const r = (await client.callTool({ name: 'sea_transition', arguments: { tickets: items(ts), to: 'resolved' } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(parse<{ error: string; details: { ticket_ids: string[] } }>(r)).toMatchObject({ error: 'confirmation_required', details: { ticket_ids: ts.map((t) => t.id) } });
    expect(store.get({ id: ts[0]!.id }).ticket.status).toBe('triaged');
    const ok = await client.callTool({ name: 'sea_transition', arguments: { tickets: items(ts.slice(0, 2)), to: 'resolved', confirm: true, note: 'bulk close' } });
    await assertStrictOutput('sea_transition', ok);
    expect(store.get({ id: ts[1]!.id }).notes.map((n) => n.body)).toEqual(['bulk close']);
    const one = await client.callTool({ name: 'sea_transition', arguments: { ticket_id: ts[2]!.id, claim_token: ts[2]!.token, to: 'in_progress', note: 'on it' } });
    await assertStrictOutput('sea_transition', one);
    expect(parse<{ ticket: { status: string }; from: string }>(one)).toMatchObject({ ticket: { status: 'in_progress' }, from: 'triaged' });
    const both = (await client.callTool({ name: 'sea_transition', arguments: { ticket_id: ts[2]!.id, claim_token: ts[2]!.token, tickets: items([ts[2]!]), to: 'parked' } })) as ToolResult;
    expect(parse<{ error: string }>(both).error).toBe('invalid_input');
  });
});
