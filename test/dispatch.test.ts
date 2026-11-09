/**
 * sea_next dispatch (0.7.0 dogfood findings):
 *   SL-2 a hand-off (sea_release with a note) went straight back to the agent
 *        that handed it off (6/6 re-claimed by the same agent 1–10 ms later);
 *   SL-3 sea_next handed out the audit epic (parent_of 41 open children);
 *   SL-4 with the last ticket held by a crashed agent's unexpired lease,
 *        sea_next said {reason: "nothing_eligible", considered: 0}.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HANDOFF_HOLD_SECONDS } from '../src/handlers/claims.js';
import { SeaLite } from '../src/store.js';
import { Clock, fresh } from './helpers.js';

type Priority = 'urgent' | 'high' | 'medium' | 'low';
const base = { body: '', kind: 'bug' as const, priority: 'medium' as Priority, tags: [] as string[], status: 'triaged' as const, dry_run: false };
const NEXT = { include_unassigned: true };

function mk(store: SeaLite, title: string, extra: Partial<typeof base> | { kind: 'epic' } = {}): string {
  return store.create({ ...base, ...extra, title, actor_id: 'pm' }).ticket.id;
}

describe('SL-2: a hand-off goes to another agent first', () => {
  it('the handing-off agent gets other work; the hand-off goes to the other agent', () => {
    const { store } = fresh();
    const t1 = mk(store, 'T1');
    const t2 = mk(store, 'T2');
    const a = store.next({ ...NEXT, actor_id: 'agent-a' });
    expect(a.ticket!.id).toBe(t1);
    store.release({ force: false, ticket_id: t1, claim_token: a.claim_token!, note: 'stuck on the fixture; someone else take it', actor_id: 'agent-a' });
    // 0.6: agent-a got T1 straight back. Now it gets T2, and T1 waits for agent-b.
    const again = store.next({ ...NEXT, actor_id: 'agent-a' });
    expect(again.ticket!.id).toBe(t2);
    expect(store.next({ ...NEXT, actor_id: 'agent-b' }).ticket!.id).toBe(t1);
  });

  it('when only the hand-off is left and another agent is around: nothing for the hander (reason handed_off), the other agent gets it', () => {
    const { store } = fresh();
    const t1 = mk(store, 'T1');
    store.as('agent-b').create({ ...base, title: 'B is here', status: 'idea' }); // agent-b active (an idea is not eligible)
    const a1 = store.next({ ...NEXT, actor_id: 'agent-a' });
    expect(a1.ticket!.id).toBe(t1);
    store.release({ force: false, ticket_id: t1, claim_token: a1.claim_token!, note: 'handing off', actor_id: 'agent-a' });
    const r = store.next({ ...NEXT, actor_id: 'agent-a' });
    expect(r.ticket).toBeNull();
    expect(r.reason).toBe('handed_off');
    expect(r.handed_off!.map((h) => h.ticket_id)).toEqual([t1]);
    expect(Date.parse(r.handed_off![0]!.yours_again_at) - Date.parse(r.handed_off![0]!.released_at)).toBe(HANDOFF_HOLD_SECONDS * 1000);
    expect(store.next({ ...NEXT, actor_id: 'agent-b' }).ticket!.id).toBe(t1);
  });

  it('the only agent around gets its own hand-off back', () => {
    const { store } = fresh({ actor: 'solo' });
    const t1 = store.create({ ...base, title: 'T1' }).ticket.id;
    const a = store.next(NEXT);
    store.release({ force: false, ticket_id: t1, claim_token: a.claim_token!, note: 'pausing' });
    expect(store.next(NEXT).ticket!.id).toBe(t1);
  });

  it('after HANDOFF_HOLD_SECONDS the hand-off is anyone\'s again (it cannot starve)', () => {
    const { store, clock } = fresh();
    const t1 = mk(store, 'T1');
    const a = store.next({ ...NEXT, actor_id: 'agent-a' });
    store.release({ force: false, ticket_id: t1, claim_token: a.claim_token!, note: 'handing off', actor_id: 'agent-a' });
    store.as('agent-b').create({ ...base, title: 'B is here', status: 'idea' });
    expect(store.next({ ...NEXT, actor_id: 'agent-a' }).reason).toBe('handed_off');
    clock.advance(HANDOFF_HOLD_SECONDS + 1);
    store.as('agent-b').create({ ...base, title: 'B is still here', status: 'idea' });
    expect(store.next({ ...NEXT, actor_id: 'agent-a' }).ticket!.id).toBe(t1);
  });

  it('a release without a note is not a hand-off; a hand-off is per session; it survives rebuild', () => {
    const { store } = fresh();
    const t1 = mk(store, 'T1');
    store.as('agent-b').create({ ...base, title: 'B is here', status: 'idea' });
    const a = store.next({ ...NEXT, actor_id: 'agent-a' });
    store.release({ force: false, ticket_id: t1, claim_token: a.claim_token!, actor_id: 'agent-a' });
    const back = store.next({ ...NEXT, actor_id: 'agent-a' });
    expect(back.ticket!.id).toBe(t1);
    store.release({ force: false, ticket_id: t1, claim_token: back.claim_token!, note: 'now a hand-off', actor_id: 'agent-a' });
    // the same actor in another session is another agent
    const s2 = store.as('agent-a', 'agent', { session: 's2' });
    expect(store.next({ ...NEXT, actor_id: 'agent-a' }).reason).toBe('handed_off');
    store.rebuild();
    expect(store.verify().ok).toBe(true);
    expect(store.next({ ...NEXT, actor_id: 'agent-a' }).reason).toBe('handed_off');
    expect(s2.next(NEXT).ticket!.id).toBe(t1);
  });

  it('once someone else has taken and given back the ticket, the old hand-off no longer applies', () => {
    const { store } = fresh();
    const t1 = mk(store, 'T1');
    store.as('agent-b').create({ ...base, title: 'B is here', status: 'idea' });
    const a = store.next({ ...NEXT, actor_id: 'agent-a' });
    store.release({ force: false, ticket_id: t1, claim_token: a.claim_token!, note: 'handing off', actor_id: 'agent-a' });
    const b = store.next({ ...NEXT, actor_id: 'agent-b' });
    expect(b.ticket!.id).toBe(t1);
    store.release({ force: false, ticket_id: t1, claim_token: b.claim_token!, actor_id: 'agent-b' });
    expect(store.next({ ...NEXT, actor_id: 'agent-a' }).ticket!.id).toBe(t1);
  });
});

describe('SL-3: sea_next never hands out an epic', () => {
  it('kind epic is skipped even with no children; its children are handed out', () => {
    const { store } = fresh();
    const epic = mk(store, 'GitHub MCP audit', { kind: 'epic' });
    expect(store.next({ ...NEXT, actor_id: 'a' })).toMatchObject({ ticket: null, reason: 'nothing_eligible', considered: 0 });
    const f1 = mk(store, 'F1');
    const lead = store.claim({ ticket_ids: [epic], actor_id: 'pm' });
    store.link({ action: 'add', from_id: epic, to_id: f1, link_type: 'parent_of', claim_token: lead.claims[0]!.claim_token, dry_run: false, actor_id: 'pm' });
    store.release({ force: false, ticket_id: epic, claim_token: lead.claims[0]!.claim_token, actor_id: 'pm' });
    const r = store.next({ ...NEXT, actor_id: 'a' });
    expect(r.ticket!.id).toBe(f1);
    store.finish({ ticket_id: f1, claim_token: r.claim_token!, outcome: 'done', note: 'ok', dry_run: false, actor_id: 'a' });
    // all children done: still not handed out (an epic is closed by a human or the runner)
    expect(store.next({ ...NEXT, actor_id: 'a' }).ticket).toBeNull();
    expect(store.claim({ ticket_ids: [epic], actor_id: 'pm' }).claims).toHaveLength(1); // an explicit claim still works
  });

  it('a parent of an open child waits for its children (older than the child, higher priority: still skipped)', () => {
    const { store } = fresh();
    const parent = mk(store, 'parent', { priority: 'urgent' });
    const child = mk(store, 'child', { priority: 'low' });
    const c = store.claim({ ticket_ids: [parent], actor_id: 'pm' }).claims[0]!.claim_token;
    store.link({ action: 'add', from_id: parent, to_id: child, link_type: 'parent_of', claim_token: c, dry_run: false, actor_id: 'pm' });
    store.release({ force: false, ticket_id: parent, claim_token: c, actor_id: 'pm' });
    const r = store.next({ ...NEXT, actor_id: 'a' });
    expect(r.ticket!.id).toBe(child);
    store.finish({ ticket_id: child, claim_token: r.claim_token!, outcome: 'done', note: 'ok', dry_run: false, actor_id: 'a' });
    expect(store.next({ ...NEXT, actor_id: 'a' }).ticket!.id).toBe(parent);
  });

  it('a held epic does not make sea_next wait', async () => {
    const { store } = fresh();
    const epic = mk(store, 'E', { kind: 'epic' });
    store.claim({ ticket_ids: [epic], actor_id: 'crashed' });
    const t0 = Date.now();
    const r = await store.nextWait({ ...NEXT, wait_seconds: 30, actor_id: 'a' });
    expect(r.ticket).toBeNull();
    expect(r.reason).toBe('nothing_eligible');
    expect(Date.now() - t0).toBeLessThan(10_000); // returned without waiting out the 30 s
  });
});

describe('SL-4: held work is not "nothing eligible"', () => {
  it('names the holder, the claim age and the silence; stale after half the lease; free after expiry', () => {
    const { store, clock } = fresh();
    const t = mk(store, 'the last ticket');
    store.claim({ ticket_ids: [t], lease_seconds: 60, actor_id: 'agent-c' }); // agent-c then crashes
    clock.advance(10);
    const r1 = store.next({ ...NEXT, actor_id: 'agent-a' });
    expect(r1).toMatchObject({ ticket: null, reason: 'held', considered: 0 });
    expect(r1.held).toHaveLength(1);
    expect(r1.held![0]).toMatchObject({ ticket_id: t, holder: 'agent-c', holder_label: 'agent-c', claim_age_seconds: 10, silent_seconds: 10, expires_in_seconds: 50, stale: false });
    expect(r1.held![0]!.claimed_at).toBe('2026-10-31T12:00:00.000Z');
    clock.advance(25); // silent 35 s > half of 60
    const r2 = store.next({ ...NEXT, actor_id: 'agent-a' });
    expect(r2.reason).toBe('held_by_stale_claim');
    expect(r2.held![0]).toMatchObject({ holder: 'agent-c', claim_age_seconds: 35, silent_seconds: 35, expires_in_seconds: 25, stale: true });
    clock.advance(26);
    expect(store.next({ ...NEXT, actor_id: 'agent-a' }).ticket!.id).toBe(t);
  });

  it('a renewal resets the silence, not the claim age', () => {
    const { store, clock } = fresh();
    const t = mk(store, 'busy');
    const c = store.claim({ ticket_ids: [t], lease_seconds: 60, actor_id: 'agent-c' }).claims[0]!;
    clock.advance(40);
    store.refresh({ ticket_id: t, claim_token: c.claim_token, actor_id: 'agent-c' });
    clock.advance(5);
    const r = store.next({ ...NEXT, actor_id: 'agent-a' });
    expect(r.reason).toBe('held');
    expect(r.held![0]).toMatchObject({ claim_age_seconds: 45, silent_seconds: 5, stale: false });
  });

  it('an empty queue, and a queue where only the caller holds work, stay nothing_eligible', () => {
    const { store } = fresh();
    expect(store.next({ ...NEXT, actor_id: 'a' })).toMatchObject({ reason: 'nothing_eligible' });
    expect(store.next({ ...NEXT, actor_id: 'a' }).held).toBeUndefined();
    mk(store, 'mine');
    expect(store.next({ ...NEXT, actor_id: 'a' }).ticket).not.toBeNull();
    expect(store.next({ ...NEXT, actor_id: 'a' })).toMatchObject({ ticket: null, reason: 'nothing_eligible' });
  });

  it('the CLI says who holds it and for how long', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sea-sl4-')));
    try {
      const data = join(dir, 'data');
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      const s = new SeaLite({ dataDir: data, actor: 'pm', project: 'p', now: new Clock(Date.now() - 50_000).now });
      const t = s.create({ ...base, title: 'last one' }).ticket.id;
      s.claim({ ticket_ids: [t], lease_seconds: 60, actor_id: 'agent-c' });
      s.close();
      const r = spawnSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'next', '--project', 'p', '--actor', 'agent-a'], {
        encoding: 'utf8',
        cwd: repo,
        env: { PATH: process.env['PATH'] ?? '', HOME: dir, KRONICLE_LITE_DATA_DIR: data },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^nothing free: 1 eligible ticket\(s\) held by others \(a holder looks gone\)$/m);
      expect(r.stdout).toMatch(new RegExp(`^  ${t.slice(0, 8)} "last one" held by agent-c, claimed \\d+s ago, silent \\d+s \\(stale: no renewal for over half its lease\\); frees at`, 'm'));
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
