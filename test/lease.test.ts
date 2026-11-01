/**
 * B5 (0.4.0): a lease must not silently lapse under an agent that is still
 * working. Longer default (900 s, max 3600 s); every sea-lite tool call by
 * the holder renews its live claims (rate-limited, row-only like
 * sea_refresh); `heartbeat` does the same for a hook; lapsed claims are never
 * resurrected; expiry is surfaced.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS } from '../src/core/fence.js';
import { EVENT } from '../src/core/events.js';
import { SeaLite } from '../src/store.js';
import { Clock, codeOf } from './helpers.js';
import { connectInMemory, parse } from './mcp-helpers.js';

const NEW = { body: '', kind: 'bug' as const, priority: 'high' as const, tags: [], status: 'triaged' as const, dry_run: false };

function shared(clock: Clock) {
  const kron = new SeaLite({ memory: true, actor: 'setup', now: clock.now });
  const A = new SeaLite({ kronicle: kron.kronicle, actor: 'claude', session: 'A', now: clock.now });
  const B = new SeaLite({ kronicle: kron.kronicle, actor: 'claude', session: 'B', now: clock.now });
  return { kron, A, B };
}

describe('leases (B5)', () => {
  it('defaults to 900 s, accepts up to 3600 s, and records the lease length on the claim', () => {
    expect(DEFAULT_LEASE_SECONDS).toBe(900);
    expect(MAX_LEASE_SECONDS).toBe(3600);
    const clock = new Clock();
    const { kron, A } = shared(clock);
    const t = A.create({ title: 'x', ...NEW });
    const c = A.claim({ ticket_ids: [t.ticket.id] });
    expect(c.lease_seconds).toBe(900);
    expect(Date.parse(c.claims[0]!.expires_at) - clock.now().getTime()).toBe(900_000);
    expect(A.claim({ ticket_ids: [t.ticket.id], lease_seconds: 3600 }).lease_seconds).toBe(3600);
    expect(codeOf(() => A.claim({ ticket_ids: [t.ticket.id], lease_seconds: 3601 }))).toBe('invalid_input');
    expect(A.get({ id: t.ticket.id }).ticket.claim?.lease_seconds).toBe(3600);
    kron.close();
  });

  it('heartbeat renews only the caller’s own live claims, by each claim’s lease, never resurrecting a lapsed one, and is not chained', () => {
    const clock = new Clock();
    const { kron, A, B } = shared(clock);
    const ta = A.create({ title: 'a', ...NEW });
    const tb = B.create({ title: 'b', ...NEW });
    const tc = A.create({ title: 'c', ...NEW });
    A.claim({ ticket_ids: [ta.ticket.id], lease_seconds: 600 });
    B.claim({ ticket_ids: [tb.ticket.id], lease_seconds: 600 });
    A.claim({ ticket_ids: [tc.ticket.id], lease_seconds: 60 });
    const seqBefore = A.chain.head().seq;
    clock.advance(300);
    const hb = A.heartbeat();
    expect(hb.renewed.map((r) => r.ticket_id)).toEqual([ta.ticket.id]);
    expect(A.get({ id: ta.ticket.id }).ticket.claim?.expires_at).toBe(new Date(clock.now().getTime() + 600_000).toISOString());
    // B's lease is untouched by A's heartbeat.
    expect(Date.parse(A.get({ id: tb.ticket.id }).ticket.claim!.expires_at)).toBe(clock.now().getTime() + 300_000);
    // Renewal is row-only: the one new chain event is the lapsed claim's expiry.
    expect([...A.chain.iterate()].filter((e) => e.seq > seqBefore).map((e) => e.event_type)).toEqual([EVENT.ticket_claim_expired]);
    // The 60 s claim lapsed at t+60: it is reported and swept, not resurrected.
    expect(hb.lapsed.map((r) => r.ticket_id)).toEqual([tc.ticket.id]);
    expect(A.get({ id: tc.ticket.id }).ticket.claim).toBeNull();
    kron.close();
  });

  it('any sea-lite tool call by the holder renews its claims (rate-limited); a quiet holder’s lease still lapses', async () => {
    const clock = new Clock();
    const { kron, A, B } = shared(clock);
    const ta = A.create({ title: 'a', ...NEW });
    const tb = B.create({ title: 'b', ...NEW });
    A.claim({ ticket_ids: [ta.ticket.id], lease_seconds: 120 });
    B.claim({ ticket_ids: [tb.ticket.id], lease_seconds: 120 });
    const { client, close } = await connectInMemory(A);
    try {
      clock.advance(100);
      await client.callTool({ name: 'sea_list', arguments: {} });
      expect(A.get({ id: ta.ticket.id }).ticket.claim?.expires_at).toBe(new Date(clock.now().getTime() + 120_000).toISOString());
      // Within the rate limit nothing is written again.
      const after = A.get({ id: ta.ticket.id }).ticket.claim!.expires_at;
      clock.advance(5);
      await client.callTool({ name: 'sea_list', arguments: {} });
      expect(A.get({ id: ta.ticket.id }).ticket.claim!.expires_at).toBe(after);
      clock.advance(60);
      // B made no calls: its lease lapsed at t+120.
      const list = parse<{ tickets: { id: string; claim: unknown }[] }>(await client.callTool({ name: 'sea_list', arguments: {} }));
      expect(list.tickets.find((t) => t.id === tb.ticket.id)?.claim).toBeNull();
      expect(list.tickets.find((t) => t.id === ta.ticket.id)?.claim).not.toBeNull();
    } finally {
      await close();
      kron.close();
    }
  });

  it('sea_refresh without extend_by_seconds extends by the claim’s own lease', () => {
    const clock = new Clock();
    const { kron, A } = shared(clock);
    const t = A.create({ title: 'a', ...NEW });
    const c = A.claim({ ticket_ids: [t.ticket.id], lease_seconds: 1800 });
    clock.advance(1000);
    const r = A.refresh({ ticket_id: t.ticket.id, claim_token: c.claims[0]!.claim_token });
    expect(r.expires_at).toBe(new Date(clock.now().getTime() + 1_800_000).toISOString());
    kron.close();
  });
});
