/**
 * #8.4: redaction runs before the write transaction opens, never inside it
 * (a slow scan inside `BEGIN IMMEDIATE` holds the store's write lock).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as Redact from '../src/audit/redact.js';

const probe = vi.hoisted(() => ({ db: null as null | { inTransaction: boolean }, inside: [] as string[], calls: 0 }));

vi.mock('../src/audit/redact.js', async (importOriginal) => {
  const real = await importOriginal<typeof Redact>();
  const watch =
    <A extends unknown[], R>(name: string, f: (...a: A) => R) =>
    (...a: A): R => {
      probe.calls++;
      if (probe.db?.inTransaction) probe.inside.push(`${name}(${String(a[0]).slice(0, 30)})`);
      return f(...a);
    };
  return { ...real, redactText: watch('redactText', real.redactText), looksLikeSecret: watch('looksLikeSecret', real.looksLikeSecret) };
});

const { SeaLite } = await import('../src/store.js');

afterEach(() => {
  probe.db = null;
  probe.inside = [];
  probe.calls = 0;
});

describe('#8.4 redaction happens outside the write transaction', () => {
  it('audit open / finding / gate / review / import, setFields, lease intents', () => {
    const s = new SeaLite({ memory: true, actor: 'op', role: 'operator' });
    probe.db = s.db;
    s.auditOpen({ audit_id: 'au', title: 'audit', catalog_fingerprint: 'fp1' });
    s.auditOpen({ audit_id: 'au', title: 'audit', catalog_fingerprint: 'fp2' });
    const f = s.auditFinding('au', { finding_id: 'F1', title: 'one', fields: { summary: 'long text '.repeat(50), severity: 'high', verdict: 'bug' }, gates: { repro: { claimed: 'pass', note: 'n', evidence_ref: 'kl:1' } } });
    s.auditGate('au', { finding_id: 'F1', gate: 'repro', result: 'pass', note: 'checked' });
    s.setFields(f.ticket_id, { summary: 'changed' });
    for (const g of ['intent', 'docs', 'prior_reports', 'refuter'] as const) s.auditGate('au', { finding_id: 'F1', gate: g, result: 'pass' });
    s.auditReview('au', { finding_id: 'F1', decision: 'approved', submit_plan: 'file it', note: 'ok' });
    s.auditImport('au', 'id,title,gate1_repro\nF2,two,a note\n', { trusted: true });
    const l = s.leaseAcquire({ name: 'sandbox:x' });
    const i = s.leaseIntent({ name: 'sandbox:x', token: l.token, op: 'POST /x', target: 'thing', idempotency_key: 'k1' });
    s.leaseResolve({ name: 'sandbox:x', token: l.token, intent_id: i.intent_id, outcome: 'happened', evidence_ref: 'kl:2' });
    expect(probe.calls).toBeGreaterThan(10);
    expect(probe.inside).toEqual([]);
    s.close();
  });
});
