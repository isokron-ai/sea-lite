/**
 * An idempotency_key is bound to its request (core/idem.ts): the same request
 * replays, a different one under a reused key is invalid_input naming the
 * key — never a replay of the first result. Covers every keyed tool, the
 * template case, prefix ids, legacy events without a hash, and two server
 * processes racing the same key.
 */

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { SeaError } from '../src/core/errors.js';
import { EVENT } from '../src/core/events.js';
import { ApplyInput } from '../src/model/schemas.js';
import type { SeaLite } from '../src/store.js';
import { claimedTicket, fresh } from './helpers.js';
import { parse, type ToolResult } from './mcp-helpers.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const plan = (x: unknown) => ApplyInput.parse(x);
const batch = (prefix: string, n: number) => plan({ tickets: Array.from({ length: n }, (_, k) => ({ ref: `${prefix}${k + 1}`, title: `${prefix}${k + 1}` })) });
const count = (s: SeaLite) => s.list({ include_terminal: true, limit: 200, view: 'compact', claimed: 'any' }).count;

function mismatch(fn: () => unknown): SeaError {
  try {
    fn();
  } catch (e) {
    const err = e as SeaError;
    expect(err.code).toBe('invalid_input');
    expect((err.details as { reason?: string }).reason).toBe('request_mismatch');
    return err;
  }
  throw new Error('expected invalid_input (request_mismatch)');
}

describe('sea_apply: a reused key with a different batch is refused, not replayed', () => {
  it('the stress repro: k1..k10 under "plan", then z1..z3 under "plan" → invalid_input naming the key; nothing of z created', () => {
    const { store } = fresh();
    const first = store.apply({ ...batch('k', 10), idempotency_key: 'plan' });
    expect(first.tickets).toHaveLength(10);
    const head = store.chain.head().seq;
    const e = mismatch(() => store.apply({ ...batch('z', 3), idempotency_key: 'plan' }));
    expect(e.message).toMatch(/^idempotency_key "plan" reused with a different request/);
    expect(e.details).toMatchObject({ idempotency_key: 'plan', first_seq: expect.any(Number) });
    expect(store.chain.head().seq).toBe(head);
    expect(count(store)).toBe(10);
    // The same batch still replays.
    const again = store.apply({ ...batch('k', 10), idempotency_key: 'plan' });
    expect(again.replayed).toBe(true);
    expect(again.tickets.map((t) => t.ticket_id)).toEqual(first.tickets.map((t) => t.ticket_id));
  });

  it('templates: the same templates hash the same (replay); the expanded plan written out is the same request; other values are not', () => {
    const { store } = fresh();
    const tpl = { templates: [{ for_each: 3, ref: 's{i}', ticket: { title: 'step {i}' }, links: [{ from_ref: '{ref}', to_ref: '{prev}', link_type: 'depends_on' }] }] };
    const a = store.apply({ ...plan(tpl), idempotency_key: 't' });
    expect(store.apply({ ...plan(tpl), idempotency_key: 't' }).replayed).toBe(true);
    const written = plan({
      tickets: [1, 2, 3].map((i) => ({ ref: `s${i}`, title: `step ${i}` })),
      links: [
        { from_ref: 's2', to_ref: 's1', link_type: 'depends_on' },
        { from_ref: 's3', to_ref: 's2', link_type: 'depends_on' },
      ],
    });
    expect(store.apply({ ...written, idempotency_key: 't' }).tickets.map((t) => t.ticket_id)).toEqual(a.tickets.map((t) => t.ticket_id));
    mismatch(() => store.apply({ ...plan({ templates: [{ ...tpl.templates[0]!, for_each: 4 }] }), idempotency_key: 't' }));
    mismatch(() => store.apply({ ...plan({ templates: [{ ...tpl.templates[0]!, ticket: { title: 'Step {i}' } }] }), idempotency_key: 't' }));
    expect(count(store)).toBe(3);
  });

  it('verbose / dry_run / the caller do not change the request (another process or session retrying it replays)', () => {
    const { store } = fresh();
    store.apply({ ...batch('a', 2), idempotency_key: 'v' });
    expect(store.apply({ ...batch('a', 2), idempotency_key: 'v', verbose: true }).replayed).toBe(true);
    expect(store.apply({ ...batch('a', 2), idempotency_key: 'v', dry_run: true }).replayed).toBe(true);
    expect(store.apply({ ...batch('a', 2), idempotency_key: 'v', actor_id: 'other-agent' }).replayed).toBe(true);
    mismatch(() => store.apply({ ...batch('a', 3), idempotency_key: 'v', actor_id: 'other-agent' }));
  });

  it('a key from before request hashes (no request_hash on the event) still replays', () => {
    const { store } = fresh();
    store.chain.append({
      event_type: EVENT.batch_applied,
      actor_id: 'alice',
      occurred_at: new Date().toISOString(),
      payload: { batch_id: 'legacy', tickets: [], links: [], ticket_count: 0, link_count: 0 },
      idempotency_key: 'sea:old',
    });
    const r = store.apply({ ...batch('n', 1), idempotency_key: 'old' });
    expect(r).toMatchObject({ replayed: true, batch_id: 'legacy' });
  });
});

describe('every other keyed write', () => {
  it('sea_create', () => {
    const { store } = fresh();
    const base = { body: '', kind: 'chore' as const, priority: 'medium' as const, tags: [], status: 'idea' as const, dry_run: false };
    const a = store.create({ ...base, title: 'one', idempotency_key: 'c' });
    expect(store.create({ ...base, title: 'one', idempotency_key: 'c' })).toMatchObject({ replayed: true, ticket: { id: a.ticket.id } });
    mismatch(() => store.create({ ...base, title: 'two', idempotency_key: 'c' }));
    mismatch(() => store.create({ ...base, title: 'one', priority: 'high', idempotency_key: 'c' }));
    expect(count(store)).toBe(1);
  });

  it('sea_update, sea_transition (prefix id = full id), sea_link', () => {
    const { store } = fresh();
    const t = claimedTicket(store);
    const other = claimedTicket(store, 'alice', 'other');
    store.update({ ticket_id: t.id, claim_token: t.token, title: 'renamed', idempotency_key: 'u', dry_run: false });
    expect(store.update({ ticket_id: t.id, claim_token: t.token, title: 'renamed', idempotency_key: 'u', dry_run: false }).replayed).toBe(true);
    mismatch(() => store.update({ ticket_id: t.id, claim_token: t.token, title: 'other name', idempotency_key: 'u', dry_run: false }));

    store.transition({ ticket_id: t.id, claim_token: t.token, to: 'in_progress', idempotency_key: 's', dry_run: false });
    expect(store.transition({ ticket_id: t.id.slice(0, 8), claim_token: t.token, to: 'in_progress', idempotency_key: 's', dry_run: false }).replayed).toBe(true);
    mismatch(() => store.transition({ ticket_id: t.id, claim_token: t.token, to: 'parked', idempotency_key: 's', dry_run: false }));
    mismatch(() => store.transition({ ticket_id: other.id, claim_token: other.token, to: 'in_progress', idempotency_key: 's', dry_run: false }));

    store.link({ action: 'add', from_id: t.id, to_id: other.id, link_type: 'relates_to', claim_token: t.token, idempotency_key: 'l', dry_run: false });
    expect(store.link({ action: 'add', from_id: t.id, to_id: other.id, link_type: 'relates_to', claim_token: t.token, idempotency_key: 'l', dry_run: false }).replayed).toBe(true);
    mismatch(() => store.link({ action: 'add', from_id: t.id, to_id: other.id, link_type: 'blocks', claim_token: t.token, idempotency_key: 'l', dry_run: false }));
  });

  it('bulk sea_transition and sea_finish bind every item to the whole request', () => {
    const { store } = fresh();
    const ts = [claimedTicket(store, 'alice', 'a'), claimedTicket(store, 'alice', 'b'), claimedTicket(store, 'alice', 'c')];
    const items = (xs: typeof ts) => xs.map((t) => ({ ticket_id: t.id, claim_token: t.token }));
    store.transitionMany({ tickets: items(ts.slice(0, 2)), to: 'in_progress', idempotency_key: 'm', dry_run: false });
    expect(store.transitionMany({ tickets: items(ts.slice(0, 2)), to: 'in_progress', idempotency_key: 'm', dry_run: false }).replayed).toBe(true);
    // Same first items plus one more: refused, the third ticket is not moved.
    mismatch(() => store.transitionMany({ tickets: items(ts), to: 'in_progress', idempotency_key: 'm', dry_run: false }));
    expect(store.get({ id: ts[2]!.id }).ticket.status).toBe('triaged');

    store.finish({ tickets: items(ts.slice(0, 2)), outcome: 'done', note: 'shipped', idempotency_key: 'f', dry_run: false });
    expect(store.finish({ tickets: items(ts.slice(0, 2)), outcome: 'done', note: 'shipped', idempotency_key: 'f', dry_run: false }).replayed).toBe(true);
    mismatch(() => store.finish({ tickets: items(ts.slice(0, 2)), outcome: 'done', note: 'different note', idempotency_key: 'f', dry_run: false }));
    mismatch(() => store.finish({ tickets: items(ts), outcome: 'done', note: 'shipped', idempotency_key: 'f', dry_run: false }));
    expect(store.get({ id: ts[2]!.id }).ticket.status).toBe('triaged');
  });
});

describe('two server processes racing one key', () => {
  it('different payloads: exactly one batch is written, the other call is refused; same payloads: one write, one replay', async () => {
    if (!existsSync(CLI)) throw new Error('dist/cli.js missing; run npm run build first');
    const dir = mkdtempSync(join(tmpdir(), 'sea-idem-2p-'));
    closers.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const spawn = async (actor: string) => {
      const c = new Client({ name: actor, version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await c.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'serve', '--data-dir', dir, '--actor', actor, '--session', `p-${actor}`, '--project', 'idem'] }));
      closers.push(() => c.close());
      await c.listTools();
      return c;
    };
    const [A, B] = await Promise.all([spawn('a'), spawn('b')]);
    const tickets = (p: string, n: number) => Array.from({ length: n }, (_, k) => ({ ref: `${p}${k + 1}`, title: `${p}${k + 1}` }));
    for (let round = 0; round < 5; round++) {
      const key = `race-${round}`;
      const [ra, rb] = (await Promise.all([
        A.callTool({ name: 'sea_apply', arguments: { tickets: tickets(`k${round}-`, 10), idempotency_key: key } }),
        B.callTool({ name: 'sea_apply', arguments: { tickets: tickets(`z${round}-`, 3), idempotency_key: key } }),
      ])) as ToolResult[];
      const ok = [ra!, rb!].filter((r) => !r.isError);
      const bad = [ra!, rb!].filter((r) => r.isError);
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      expect(parse<{ error: string; message: string }>(bad[0]).message).toMatch(new RegExp(`idempotency_key "${key}" reused with a different request`));
      expect(parse<{ idempotent_replay: boolean }>(ok[0]).idempotent_replay).toBe(false);
    }
    // Same payload from both at once: one write, one replay with the same ids.
    const same = { tickets: tickets('s-', 4), idempotency_key: 'race-same' };
    const [sa, sb] = (await Promise.all([A.callTool({ name: 'sea_apply', arguments: same }), B.callTool({ name: 'sea_apply', arguments: same })])) as ToolResult[];
    const pa = parse<{ created: Record<string, string>; idempotent_replay: boolean }>(sa);
    const pb = parse<{ created: Record<string, string>; idempotent_replay: boolean }>(sb);
    expect(pa.created).toEqual(pb.created);
    expect([pa.idempotent_replay, pb.idempotent_replay].sort()).toEqual([false, true]);
    // Each round wrote exactly one batch (10 or 3), plus the 4 of the same-payload race.
    const list = parse<{ tickets: { title: string }[] }>(await A.callTool({ name: 'sea_list', arguments: { include_terminal: true, limit: 200 } }));
    for (let round = 0; round < 5; round++) {
      const k = list.tickets.filter((t) => t.title.startsWith(`k${round}-`)).length;
      const z = list.tickets.filter((t) => t.title.startsWith(`z${round}-`)).length;
      expect([k, z].sort()).toEqual(k > 0 ? [0, 10] : [0, 3]);
    }
    expect(list.tickets.filter((t) => t.title.startsWith('s-'))).toHaveLength(4);
  });
});
