/**
 * `wait_seconds` on sea_claim / sea_next: wait for a held ticket or scope to
 * free up instead of failing; report what freed it, or time out naming the
 * holder and expiry. In-process (the notifier), over MCP (progress,
 * cancellation, strict output), and across two server processes (SQLite
 * data_version polling).
 */

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { SeaError } from '../src/core/errors.js';
import { waitCounters } from '../src/core/wait.js';
import { SeaLite } from '../src/store.js';
import { claimedTicket, codeOf } from './helpers.js';
import { assertStrictOutput, connectInMemory, parse, type ToolResult } from './mcp-helpers.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function store(actor = 'alice') {
  const s = new SeaLite({ memory: true, actor, session: `s-${actor}` });
  closers.push(() => s.close());
  return s;
}
const create = (s: SeaLite, title: string) => s.create({ title, body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged', dry_run: false }).ticket.id;
const later = (ms: number, fn: () => unknown) => new Promise<void>((res) => setTimeout(() => (fn(), res()), ms));

async function rejected(p: Promise<unknown>): Promise<SeaError> {
  try {
    await p;
  } catch (e) {
    return e as SeaError;
  }
  throw new Error('expected a rejection');
}

/**
 * Calibrated timing (0.7.0 review of #20). #20 relaxed the absolute bounds
 * until a 300 ms sleep injected in claim() and a 1.5 s delay in the refusal
 * path both passed. These bounds are meaningful and still load-proof:
 *
 * - best of n: a scheduler stall must hit every run to fail a test, while an
 *   injected delay is in every run;
 * - relative: the bound is a multiple of a baseline measured in the same
 *   test, on an operation off the claim path (create + get), so a loaded
 *   machine raises the bound with the cost; a floor covers timer noise;
 * - behavioural where possible: "refused at once" also asserts that the wait
 *   loop never slept (waitCounters), whatever the clock says.
 */
async function bestMs(n: number, f: () => unknown): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await f();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}
const baselineMs = (s: SeaLite) =>
  bestMs(5, () => {
    s.get({ id: create(s, 'baseline') });
  });
/** ~1–3 ms per claim on an idle laptop, under 10 ms with half the cores busy; an injected 300 ms (or 1.5 s) is far above. */
const FLOOR_MS = 100;
const FACTOR = 20;
const boundOf = (base: number) => Math.max(FLOOR_MS, FACTOR * base);

describe('claimWait / nextWait (in-process)', () => {
  it('waits for an overlapping scope to be released, then claims; reports who held it and that it was released', async () => {
    const a = store();
    const b = a.as('bob', 'agent', { session: 's-bob' });
    const t1 = create(a, 'auth work');
    const t2 = create(a, 'session work');
    const held = a.claim({ ticket_ids: [t1], scope: { paths: ['src/auth'] } });
    const t0 = Date.now();
    let releasedAt = 0;
    const [r] = await Promise.all([
      b.claimWait({ ticket_ids: [t2], scope: { paths: ['src/auth/session.ts'] }, wait_seconds: 10 }),
      later(300, () => {
        releasedAt = Date.now();
        a.release({ ticket_id: t1, claim_token: held.claims[0]!.claim_token, force: false });
      }),
    ]);
    expect(r.claims[0]!.ticket_id).toBe(t2);
    expect(r.waited).toMatchObject({ freed: 'released', blocked_by: { kind: 'scope_conflict', ticket_id: t1, holder: 'alice', holder_label: expect.stringMatching(/^alice#/), title: 'auth work' } });
    // Woken by the in-process notifier, not by a poll tick: nothing changed
    // while it waited, so it retried exactly once, on the release (polling
    // would show more attempts). The latency bound is only a sanity check:
    // wall-clock bounds tight enough to tell a notifier from a 250 ms poll
    // fail on a loaded machine.
    expect(r.waited!.attempts).toBe(2);
    expect(Date.now() - releasedAt).toBeLessThan(5_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
  });

  it('a held ticket: freed when the holder finishes it (already_claimed → finished)', async () => {
    const a = store();
    const b = a.as('bob', 'agent', { session: 's-bob' });
    const t = claimedTicket(a, 'alice', 'shared');
    const [r] = await Promise.all([
      b.claimWait({ ticket_ids: [t.id], wait_seconds: 10 }).catch((e: SeaError) => e),
      later(150, () => a.finish({ ticket_id: t.id, claim_token: t.token, outcome: 'blocked', note: 'handing over', dry_run: false })),
    ]);
    expect(r).toMatchObject({ waited: { freed: 'released', blocked_by: { kind: 'already_claimed', ticket_id: t.id } } });
  });

  it('a lapsing lease frees it at the expiry with no write at all (lease_expired)', async () => {
    const a = store();
    const b = a.as('bob', 'agent', { session: 's-bob' });
    const t1 = create(a, 'one');
    const t2 = create(a, 'two');
    a.claim({ ticket_ids: [t1], scope: { paths: ['lib'] }, lease_seconds: 1 });
    const t0 = Date.now();
    const r = await b.claimWait({ ticket_ids: [t2], scope: { paths: ['lib'] }, wait_seconds: 5 });
    expect(r.waited!.freed).toBe('lease_expired');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900); // not before the lease lapses
    expect(Date.now() - t0).toBeLessThan(4_500); // and not the whole 5 s wait
  });

  it('times out naming the holder and expiry; nothing is claimed; no wait means the old immediate refusal', async () => {
    const a = store();
    const b = a.as('bob', 'agent', { session: 's-bob' });
    const t1 = create(a, 'one');
    const t2 = create(a, 'two');
    const held = a.claim({ ticket_ids: [t1], scope: { paths: ['src'] } });
    const e = await rejected(b.claimWait({ ticket_ids: [t2], scope: { paths: ['src/x'] }, wait_seconds: 1 }));
    expect(e.code).toBe('wait_timeout');
    expect(e.message).toMatch(/still blocked after 1(\.\d)?s: "alice#[^"]+" holds an overlapping scope on ticket/);
    expect(e.details).toMatchObject({
      blocked_by: { holder: 'alice', ticket_id: t1, expires_at: held.claims[0]!.expires_at },
      attempts: 1,
      cause: { error: 'scope_conflict' },
    });
    expect(a.get({ id: t2 }).ticket.claim).toBeNull();
    expect(codeOf(() => b.claim({ ticket_ids: [t2], scope: { paths: ['src/x'] } }))).toBe('scope_conflict');
    const now = Date.now();
    expect((await rejected(b.claimWait({ ticket_ids: [t2], scope: { paths: ['src/x'] } }))).code).toBe('scope_conflict');
    expect(Date.now() - now).toBeLessThan(2_000); // sanity only; the calibrated "refused at once" test below is the real bound
  });

  it('refusals that waiting cannot fix fail at once (unknown ticket, bad input)', async () => {
    const b = store('bob');
    const t0 = Date.now();
    expect((await rejected(b.claimWait({ ticket_ids: ['deadbeefdead'], wait_seconds: 10 }))).code).toBe('not_found');
    expect(Date.now() - t0).toBeLessThan(5_000); // not the 10 s wait
  });

  it('cancellation stops the wait (wait_cancelled)', async () => {
    const a = store();
    const b = a.as('bob', 'agent', { session: 's-bob' });
    const t = claimedTicket(a);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const e = await rejected(b.claimWait({ ticket_ids: [t.id], wait_seconds: 30 }, { signal: ac.signal }));
    expect(e.code).toBe('wait_cancelled');
    expect(Date.now() - t0).toBeLessThan(15_000); // not the 30 s wait
  });

  it('progress callbacks fire while waiting', async () => {
    const a = store();
    const b = a.as('bob', 'agent', { session: 's-bob' });
    const t = claimedTicket(a);
    const seen: number[] = [];
    await rejected(b.claimWait({ ticket_ids: [t.id], wait_seconds: 1 }, { progressEveryMs: 100, onProgress: (p) => seen.push(p.elapsed_seconds) }));
    // ~10 nominal; a loaded event loop delays timers, so ask only for repeats, in order.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect([...seen].sort((x, y) => x - y)).toEqual(seen);
  });

  it('sea_next waits for busy work (a claimed eligible ticket, or a claimed predecessor) but not on an empty queue', async () => {
    const a = store();
    const b = a.as('bob', 'agent', { session: 's-bob' });
    // Empty queue: immediate nothing_eligible.
    const t0 = Date.now();
    const empty = await b.nextWait({ include_unassigned: true, wait_seconds: 10 });
    expect(empty.ticket).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000); // not the 10 s wait
    // first ← second (depends_on); alice holds first.
    const r = a.apply({
      tickets: [
        { ref: 'f', title: 'first', body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged' },
        { ref: 's', title: 'second', body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged' },
      ],
      links: [{ from_ref: 's', to_ref: 'f', link_type: 'depends_on' }],
      dry_run: false,
    });
    const first = a.next({ include_unassigned: true });
    expect(first.ticket!.title).toBe('first');
    const [n] = await Promise.all([
      b.nextWait({ include_unassigned: true, wait_seconds: 10 }),
      later(200, () => a.finish({ ticket_id: first.ticket!.id, claim_token: first.claim_token!, outcome: 'done', note: 'ok', dry_run: false })),
    ]);
    expect(n.ticket!.id).toBe(r.tickets[1]!.ticket_id);
    expect(n.waited).toMatchObject({ freed: 'finished', blocked_by: { kind: 'busy_queue', ticket_id: first.ticket!.id, holder: 'alice' } });
  });

  it('sea_next waits on a held scope, and times out with the holder', async () => {
    const a = store();
    const b = a.as('bob', 'agent', { session: 's-bob' });
    create(a, 'x');
    create(a, 'y');
    a.next({ include_unassigned: true, scope: { paths: ['CHANGELOG.md'] } });
    const e = await rejected(b.nextWait({ include_unassigned: true, scope: { paths: ['CHANGELOG.md'] }, wait_seconds: 1 }));
    expect(e.code).toBe('wait_timeout');
    expect(e.details).toMatchObject({ blocked_by: { kind: 'scope_conflict', holder: 'alice' } });
  });
});

describe('claim cost and immediate refusals (calibrated, 0.7.0 review)', () => {
  it('an uncontended claim (sync and through claimWait) costs about what a create does', async () => {
    const s = store();
    const ids = Array.from({ length: 11 }, (_, i) => create(s, `c${i}`));
    s.claim({ ticket_ids: [ids[10]!] }); // warm up (statements, JIT)
    const base = await baselineMs(s);
    let i = 0;
    const sync = await bestMs(5, () => s.claim({ ticket_ids: [ids[i++]!] }));
    const viaWait = await bestMs(5, () => s.claimWait({ ticket_ids: [ids[i++]!], wait_seconds: 5 }));
    expect(sync, `claim ${sync.toFixed(1)} ms, baseline ${base.toFixed(1)} ms`).toBeLessThan(boundOf(base));
    expect(viaWait, `claimWait ${viaWait.toFixed(1)} ms, baseline ${base.toFixed(1)} ms`).toBeLessThan(boundOf(base));
  });

  it('a refusal without wait_seconds is immediate: the wait loop never sleeps, and it costs about what a create does', async () => {
    const a = store();
    const b = a.as('bob', 'agent', { session: 's-bob' });
    const t1 = create(a, 'one');
    const t2 = create(a, 'two');
    a.claim({ ticket_ids: [t1], scope: { paths: ['src'] } });
    expect(codeOf(() => b.claim({ ticket_ids: [t2], scope: { paths: ['src/x'] } }))).toBe('scope_conflict'); // warm up
    const base = await baselineMs(a);
    const sleeps = waitCounters.sleeps;
    const sync = await bestMs(5, () => expect(codeOf(() => b.claim({ ticket_ids: [t2], scope: { paths: ['src/x'] } }))).toBe('scope_conflict'));
    const scoped = await bestMs(5, async () => expect((await rejected(b.claimWait({ ticket_ids: [t2], scope: { paths: ['src/x'] } }))).code).toBe('scope_conflict'));
    const held = await bestMs(5, async () => expect((await rejected(b.claimWait({ ticket_ids: [t1] }))).code).toBe('already_claimed'));
    expect(waitCounters.sleeps, 'no wait loop iteration').toBe(sleeps);
    for (const [what, ms] of [
      ['claim', sync],
      ['claimWait scope_conflict', scoped],
      ['claimWait already_claimed', held],
    ] as const) {
      expect(ms, `${what} ${ms.toFixed(1)} ms, baseline ${base.toFixed(1)} ms`).toBeLessThan(boundOf(base));
    }
  });

  it('refusals waiting cannot fix (unknown ticket, empty queue) skip the wait even with wait_seconds', async () => {
    const b = store('bob');
    create(b, 'warm');
    const base = await baselineMs(b);
    const fresh = store('carol'); // an empty queue
    const sleeps = waitCounters.sleeps;
    const unknown = await bestMs(5, async () => expect((await rejected(b.claimWait({ ticket_ids: ['deadbeefdead'], wait_seconds: 10 }))).code).toBe('not_found'));
    const empty = await bestMs(5, async () => expect((await fresh.nextWait({ include_unassigned: true, wait_seconds: 10 })).ticket).toBeNull());
    expect(waitCounters.sleeps, 'no wait loop iteration').toBe(sleeps);
    expect(unknown, `not_found ${unknown.toFixed(1)} ms, baseline ${base.toFixed(1)} ms`).toBeLessThan(boundOf(base));
    expect(empty, `empty queue ${empty.toFixed(1)} ms, baseline ${base.toFixed(1)} ms`).toBeLessThan(boundOf(base));
  });
});

describe('over MCP', () => {
  it('sea_claim with wait_seconds: strict output with `waited`, progress notifications, timeout as an error result', async () => {
    const a = store();
    const t1 = create(a, 'one');
    const t2 = create(a, 'two');
    const held = a.claim({ ticket_ids: [t1], scope: { paths: ['src'] } });
    const bob = a.as('bob', 'agent', { session: 's-bob' });
    const { client, close } = await connectInMemory(bob, { server: { waitProgressMs: 200 } });
    closers.push(close);
    await client.listTools();
    const progress: string[] = [];
    const call = client.callTool(
      { name: 'sea_claim', arguments: { ticket_ids: [t2], scope: { paths: ['src/a.ts'] }, wait_seconds: 10 } },
      { onprogress: (p) => progress.push(p.message ?? '') },
    );
    await later(700, () => a.release({ ticket_id: t1, claim_token: held.claims[0]!.claim_token, force: false }));
    const res = await call;
    await assertStrictOutput('sea_claim', res);
    expect(parse<{ waited: { freed: string } }>(res).waited.freed).toBe('released');
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[0]).toMatch(/waiting: "alice#/);

    const again = a.claim({ ticket_ids: [t1], scope: { paths: ['src/b.ts'] } });
    expect(again.claims).toHaveLength(1);
    const to = (await client.callTool({ name: 'sea_next', arguments: { scope: { paths: ['src/b.ts'] }, wait_seconds: 1 } })) as ToolResult;
    expect(to.isError).toBe(true);
    expect(parse<{ error: string; details: { blocked_by: { holder: string } } }>(to)).toMatchObject({ error: 'wait_timeout', details: { blocked_by: { holder: 'alice' } } });
  });
});

describe('two server processes on one store (SQLite data_version)', () => {
  it('B waits on A across processes and wakes within a poll tick of the release; a lapse frees it too', async () => {
    if (!existsSync(CLI)) throw new Error('dist/cli.js missing; run npm run build first');
    const dir = mkdtempSync(join(tmpdir(), 'sea-wait-2p-'));
    closers.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const spawn = async (actor: string) => {
      const c = new Client({ name: actor, version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await c.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'serve', '--data-dir', dir, '--actor', actor, '--session', `p-${actor}`, '--project', 'two-proc'] }));
      closers.push(() => c.close());
      return c;
    };
    const A = await spawn('alice');
    const B = await spawn('bob');
    const mk = async (title: string) => parse<{ ticket: { id: string } }>(await A.callTool({ name: 'sea_create', arguments: { title, status: 'triaged' } })).ticket.id;
    const t1 = await mk('one');
    const t2 = await mk('two');
    const t3 = await mk('three');
    const held = parse<{ claims: { claim_token: string }[] }>(await A.callTool({ name: 'sea_claim', arguments: { ticket_ids: [t1], scope: { paths: ['CHANGELOG.md'] } } }));

    await B.listTools(); // the client caches output schemas first; keep that out of the timed window
    const waiting = B.callTool({ name: 'sea_claim', arguments: { ticket_ids: [t2], scope: { paths: ['CHANGELOG.md'] }, wait_seconds: 20 } });
    await later(800, () => undefined);
    const releasedAt = Date.now();
    await A.callTool({ name: 'sea_finish', arguments: { ticket_id: t1, claim_token: held.claims[0]!.claim_token, outcome: 'done', note: 'done' } });
    const res = await waiting;
    const latency = Date.now() - releasedAt;
    await assertStrictOutput('sea_claim', res);
    const w = parse<{ waited: { seconds: number; freed: string; blocked_by: { holder: string } } }>(res).waited;
    expect(w).toMatchObject({ freed: 'finished', blocked_by: { holder: 'alice' } });
    expect(w.seconds).toBeGreaterThanOrEqual(0.5);
    expect(latency).toBeLessThan(10_000); // ~250 ms poll backoff + the finish round trip when idle; far from the 20 s wait

    // A lapse: alice's 1 s lease on t3's scope, bob waits for it.
    await A.callTool({ name: 'sea_claim', arguments: { ticket_ids: [t3], scope: { paths: ['docs'] }, lease_seconds: 1 } });
    const t4 = await mk('four');
    const lapse = parse<{ waited: { freed: string } }>(await B.callTool({ name: 'sea_claim', arguments: { ticket_ids: [t4], scope: { paths: ['docs/x.md'] }, wait_seconds: 5 } }));
    expect(lapse.waited.freed).toBe('lease_expired');
  });
});
