/**
 * C2-06 (0.6.2): a process whose clock runs ahead saw every live lease as
 * lapsed and took it over. Lease decisions are now refused while this
 * process's clock disagrees with the store's reference clock (the data dir's
 * file-system mtime by default) by more than the tolerance.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { clockGuard, fsReference, parseMaxSkew } from '../src/core/clock.js';
import { SeaLite } from '../src/store.js';
import { codeOf } from './helpers.js';

const NEW = { body: '', kind: 'bug' as const, priority: 'high' as const, tags: [], status: 'triaged' as const, dry_run: false };
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sea-skew-'));
  dirs.push(d);
  return d;
};

describe('clock skew guard (C2-06)', () => {
  it('the stress repro: B 15 min ahead cannot take over A’s live lease, renew, or sweep it', () => {
    const real = () => new Date();
    const ahead = () => new Date(Date.now() + 15 * 60_000);
    const A = new SeaLite({ memory: true, actor: 'a', now: real, clockReference: () => Date.now() });
    const B = new SeaLite({ kronicle: A.kronicle, actor: 'b', now: ahead, clockReference: () => Date.now() });
    const t = A.create({ title: 'x', ...NEW });
    A.claim({ ticket_ids: [t.ticket.id] });
    A.create({ title: 'free', ...NEW });
    expect(codeOf(() => B.claim({ ticket_ids: [t.ticket.id] }))).toBe('clock_skew');
    expect(codeOf(() => B.next({ include_unassigned: true }))).toBe('clock_skew');
    expect(codeOf(() => B.heartbeat())).toBe('clock_skew');
    // Reads still work, and do not sweep A's lease as expired.
    B.list({ include_terminal: true, limit: 10, view: 'compact', claimed: 'any' });
    expect(A.get({ id: t.ticket.id }).ticket.claim?.holder).toBe('a');
    A.close();
  });

  it('behind is refused too (its leases would lapse early for everyone else); SEA_LITE_MAX_CLOCK_SKEW_SECONDS=0 disables', () => {
    const behind = () => new Date(Date.now() - 5 * 60_000);
    const s = new SeaLite({ memory: true, actor: 'a', now: behind, clockReference: () => Date.now() });
    const t = s.create({ title: 'x', ...NEW });
    expect(codeOf(() => s.claim({ ticket_ids: [t.ticket.id] }))).toBe('clock_skew');
    s.close();
    process.env['SEA_LITE_MAX_CLOCK_SKEW_SECONDS'] = '0';
    try {
      const off = new SeaLite({ memory: true, actor: 'a', now: behind, clockReference: () => Date.now() });
      const u = off.create({ title: 'y', ...NEW });
      expect(off.claim({ ticket_ids: [u.ticket.id] }).claims).toHaveLength(1);
      off.close();
    } finally {
      delete process.env['SEA_LITE_MAX_CLOCK_SKEW_SECONDS'];
    }
  });

  it('within tolerance and with an unknown reference, nothing changes', () => {
    const g = clockGuard(() => new Date(Date.now() + 10_000), () => Date.now(), 30);
    expect(g.untrusted()).toBeNull();
    expect(clockGuard(() => new Date(0), () => null, 30).untrusted()).toBeNull();
    expect(clockGuard(() => new Date(Date.now() + 60_000), () => Date.now(), 30).untrusted()).toMatchObject({ max_ms: 30_000 });
    expect(parseMaxSkew(undefined)).toBe(30);
    expect(() => parseMaxSkew('-1')).toThrow(/non-negative/);
  });

  it('an on-disk store uses the file-system clock by default: same host, no skew, claims work', () => {
    const dir = tmp();
    const ref = fsReference(dir)();
    expect(typeof ref).toBe("number");
    expect(Math.abs(Date.now() - (ref as number))).toBeLessThan(5_000);
    const s = new SeaLite({ dataDir: dir, actor: 'a' });
    const t = s.create({ title: 'x', ...NEW });
    expect(s.claim({ ticket_ids: [t.ticket.id] }).claims).toHaveLength(1);
    s.close();
  });
});
