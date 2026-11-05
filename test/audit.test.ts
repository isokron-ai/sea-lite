/**
 * Audit orchestration (0.7.0): named exclusive leases with a write-intent
 * journal, typed fields, finding + gate sub-tickets, the human review queue,
 * CSV / XLSX export and findings.csv import. Library API only (the mcp-audit
 * runner drives it; agents never see these tickets).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { EXPORT_COLUMNS } from '../src/audit/audit.js';
import { parseCsv, toCsv } from '../src/audit/export.js';
import { SeaLite } from '../src/store.js';
import { Clock, codeOf, fresh } from './helpers.js';

/** The tracker columns of scratchpad/posthog/build/mk3.py, in order. */
const MK3 = ['id', 'source_pass', 'title', 'verdict', 'refuter2_verdict', 'refuter2_severity', 'refuter2_submit_ready', 'confidence', 'merged_into', 'submit_plan', 'component', 'root_cause', 'affected_count', 'summary', 'evidence', 'measured_impact', 'proposed_fix', 'fix_difficulty', 'gate1_repro', 'gate2_intent', 'gate3_docs', 'gate4_prior_links', 'gate5_refutation', 'our PR/issue #', 'submitted date', 'status'];

function pair(clock: Clock) {
  const w1 = new SeaLite({ memory: true, actor: 'worker-1', session: 's1', now: clock.now });
  const w2 = new SeaLite({ kronicle: w1.kronicle, actor: 'worker-2', session: 's2', now: clock.now });
  return { w1, w2 };
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

describe('acceptance test 1: crash mid-write', () => {
  it('the remote write landed, its response was lost, the worker died and the lease lapsed: the next worker sees it may have happened and does not repeat it', () => {
    const clock = new Clock();
    const { w1, w2 } = pair(clock);
    const a = w1.leaseAcquire({ name: 'sandbox:posthog', lease_seconds: 60 });
    expect(a).toMatchObject({ epoch: 1 });
    expect(a.unresolved).toBeUndefined();
    const it1 = w1.leaseIntent({ name: 'sandbox:posthog', token: a.token, op: 'insight-create', target: 'project 711774', idempotency_key: 'run7:L3' });
    // … the remote write succeeds, the response is lost, worker-1 dies (no close, no release).
    expect(codeOf(() => w2.leaseAcquire({ name: 'sandbox:posthog' }))).toBe('already_claimed');
    clock.advance(61);

    const b = w2.leaseAcquire({ name: 'sandbox:posthog', lease_seconds: 60 });
    expect(b.epoch).toBe(2);
    expect(b.took_over).toMatchObject({ holder: 'worker-1', epoch: 1 });
    expect(b.unresolved).toEqual([
      expect.objectContaining({ intent_id: it1.intent_id, op: 'insight-create', target: 'project 711774', idempotency_key: 'run7:L3', epoch: 1, state: 'may_have_happened' }),
    ]);
    // It cannot start another write until it has verified that one.
    const blocked = (() => {
      try {
        w2.leaseIntent({ name: 'sandbox:posthog', token: b.token, op: 'insight-create', idempotency_key: 'run7:L3' });
      } catch (e) {
        return e as { code: string; details: { reason: string; intent_ids: string[] } };
      }
      return null;
    })();
    expect(blocked).toMatchObject({ code: 'invalid_input', details: { reason: 'unresolved_intents', intent_ids: [it1.intent_id] } });
    // The zombie cannot write or close anything any more.
    expect(codeOf(() => w1.leaseResolve({ name: 'sandbox:posthog', token: a.token, intent_id: it1.intent_id, outcome: 'not_happened' }))).toBe('fence_invalid');
    expect(codeOf(() => w1.leaseIntent({ name: 'sandbox:posthog', token: a.token, op: 'x' }))).toBe('fence_invalid');

    // Worker-2 reads back (independent surface), finds the insight, records that it happened.
    expect(w2.leaseResolve({ name: 'sandbox:posthog', token: b.token, intent_id: it1.intent_id, outcome: 'happened', evidence_ref: 'kl:1234' })).toEqual({
      intent_id: it1.intent_id,
      state: 'happened',
    });
    expect(w2.leaseShow('sandbox:posthog')).toMatchObject({ epoch: 2, holder: 'worker-2', live: true, open: 0, may_have_happened: 0 });
    // Next work proceeds; a clean close + release leaves nothing for a third worker.
    const it2 = w2.leaseIntent({ name: 'sandbox:posthog', token: b.token, op: 'dashboard-create' });
    w2.leaseResolve({ name: 'sandbox:posthog', token: b.token, intent_id: it2.intent_id, outcome: 'not_happened' });
    expect(w2.leaseRelease({ name: 'sandbox:posthog', token: b.token })).toEqual({ epoch: 2, may_have_happened: 0 });
    expect(w1.leaseAcquire({ name: 'sandbox:posthog' }).unresolved).toBeUndefined();
    w1.close();
  });

  it('the journal survives a rebuild: may_have_happened intents are still reported', () => {
    const clock = new Clock();
    const { w1, w2 } = pair(clock);
    const a = w1.leaseAcquire({ name: 'sandbox:x', lease_seconds: 10 });
    w1.leaseIntent({ name: 'sandbox:x', token: a.token, op: 'delete' });
    clock.advance(11);
    w2.rebuild();
    expect(w2.leaseAcquire({ name: 'sandbox:x' }).unresolved).toHaveLength(1);
    w1.close();
  });
});

describe('named exclusive lease', () => {
  it('one holder; re-acquire by the holder rotates the token and the epoch; release refuses open intents unless abandon', () => {
    const clock = new Clock();
    const { w1, w2 } = pair(clock);
    const a = w1.leaseAcquire({ name: 'sandbox:1' });
    expect(Object.keys(a).sort()).toEqual(['epoch', 'expires_at', 'name', 'token']);
    const a2 = w1.leaseAcquire({ name: 'sandbox:1' });
    expect(a2.epoch).toBe(2);
    expect(codeOf(() => w1.leaseRenew({ name: 'sandbox:1', token: a.token }))).toBe('fence_invalid');
    clock.advance(10);
    expect(Date.parse(w1.leaseRenew({ name: 'sandbox:1', token: a2.token }).expires_at)).toBeGreaterThan(Date.parse(a2.expires_at));
    expect(codeOf(() => w2.leaseRenew({ name: 'sandbox:1', token: a2.token }))).toBe('fence_foreign_holder');
    w1.leaseIntent({ name: 'sandbox:1', token: a2.token, op: 'write' });
    expect(codeOf(() => w1.leaseRelease({ name: 'sandbox:1', token: a2.token }))).toBe('invalid_input');
    expect(w1.leaseRelease({ name: 'sandbox:1', token: a2.token, abandon: true })).toEqual({ epoch: 2, may_have_happened: 1 });
    const b = w2.leaseAcquire({ name: 'sandbox:1' });
    expect(b.took_over).toBeUndefined();
    expect(b.unresolved).toHaveLength(1);
    w1.close();
  });

  it('four processes race to acquire one lease: exactly one wins, three get already_claimed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sea-lease-race-'));
    try {
      new SeaLite({ dataDir: dir, actor: 'init' }).close();
      const lib = pathToFileURL(join(process.cwd(), 'dist', 'index.js')).href;
      const script = `import { SeaLite } from ${JSON.stringify(lib)};
        const s = new SeaLite({ dataDir: process.argv[1], actor: process.argv[2] });
        try { s.leaseAcquire({ name: 'sandbox:race' }); console.log('won'); } catch (e) { console.log(e.code); } finally { s.close(); }`;
      const runs = await Promise.all(
        Array.from({ length: 4 }, (_, k) =>
          new Promise<string>((res) => {
            const c = spawn(process.execPath, ['--input-type=module', '-e', script, dir, `w${k}`], { stdio: ['ignore', 'pipe', 'inherit'] });
            let o = '';
            c.stdout.on('data', (d: Buffer) => (o += d.toString()));
            c.on('close', () => res(o.trim()));
          }),
        ),
      );
      expect(runs.filter((r) => r === 'won')).toHaveLength(1);
      expect(runs.filter((r) => r === 'already_claimed')).toHaveLength(3);
      const s = new SeaLite({ dataDir: dir, actor: 'check' });
      expect(s.leaseShow('sandbox:race')).toMatchObject({ epoch: 1, live: true });
      expect(s.verify().ok).toBe(true);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 60_000);

  it('force release needs the operator role', () => {
    const clock = new Clock();
    const { w1 } = pair(clock);
    const op = new SeaLite({ kronicle: w1.kronicle, actor: 'human', role: 'operator', now: clock.now });
    w1.leaseAcquire({ name: 'sandbox:2' });
    expect(codeOf(() => w1.leaseRelease({ name: 'sandbox:2', force: true }))).toBe('forbidden');
    expect(op.leaseRelease({ name: 'sandbox:2', force: true }).epoch).toBe(1);
    expect(op.leaseShow('sandbox:2').live).toBe(false);
    expect(codeOf(() => w1.leaseAcquire({ name: 'bad name' }))).toBe('invalid_input');
    w1.close();
  });
});

function audit() {
  const { store, clock } = fresh({ actor: 'mcp-audit' });
  store.auditOpen({ audit_id: 'posthog-2', title: 'PostHog MCP audit 2', catalog_fingerprint: 'sha256:abc' });
  return { store, clock };
}

const GATES_ALL = { repro: { result: 'pass', note: 'live repro' }, intent: { result: 'pass' }, docs: { result: 'n/a' }, prior_reports: { result: 'pass', note: '#129174' }, refuter: { result: 'pass', evidence_ref: 'kl:77' } };

describe('audit findings, gates and the review queue', () => {
  it('a finding is one ticket + five gate sub-tickets in the audit project, invisible to agents in other projects', () => {
    const { store } = audit();
    const r = store.auditFinding('posthog-2', { finding_id: 'L3', title: '500 persists the insight', fields: { verdict: 'bug', severity: 'high', confidence: 'high', source_pass: 'schema lint' } });
    expect(r).toMatchObject({ created: true, changed: ['verdict', 'severity', 'confidence', 'source_pass'] });
    expect(bytes(r)).toBeLessThan(200);
    const all = store.list({ include_terminal: true, limit: 50, view: 'compact', claimed: 'any', project: 'audit:posthog-2' });
    expect(all.count).toBe(7); // epic + finding + 5 gates
    const agent = new SeaLite({ kronicle: store.kronicle, actor: 'claude', project: '/repo/app' });
    expect(agent.list({ include_terminal: true, limit: 50, view: 'compact', claimed: 'any' }).count).toBe(0);
    expect(agent.next({ include_unassigned: true }).ticket).toBeNull();
    // Idempotent by finding id: the same input writes nothing.
    const head = store.chain.head().seq;
    expect(store.auditFinding('posthog-2', { finding_id: 'L3', title: '500 persists the insight', fields: { verdict: 'bug' } })).toMatchObject({ created: false, changed: [] });
    expect(store.chain.head().seq).toBe(head);
  });

  it('typed fields: unknown names and bad values are refused; identity fields are managed', () => {
    const { store } = audit();
    expect(codeOf(() => store.auditFinding('posthog-2', { finding_id: 'X1', title: 't', fields: { verdcit: 'bug' } }))).toBe('invalid_input');
    expect(codeOf(() => store.auditFinding('posthog-2', { finding_id: 'X1', title: 't', fields: { verdict: 'nope' } }))).toBe('invalid_input');
    expect(codeOf(() => store.auditFinding('posthog-2', { finding_id: 'X1', title: 't', fields: { submitted_date: '6 Nov' } }))).toBe('invalid_input');
    expect(codeOf(() => store.auditFinding('posthog-2', { finding_id: 'X1', title: 't', fields: { review: 'approved' } }))).toBe('invalid_input');
    expect(codeOf(() => store.auditFinding('nope', { finding_id: 'X1', title: 't' }))).toBe('not_found');
    const r = store.auditFinding('posthog-2', { finding_id: 'X1', title: 't', fields: { affected_count: 3, pr_or_issue: 'PostHog/posthog#129900', submitted_date: '2026-11-06', tracker_status: 'Draft PR open' } });
    expect(store.fields(r.ticket_id).fields).toMatchObject({ affected_count: 3, tracker_status: 'Draft PR open', finding_id: 'X1', audit_id: 'posthog-2' });
    expect(codeOf(() => store.setFields(r.ticket_id, { severity: 'low' }, 1))).toBe('version_conflict');
    expect(store.setFields(r.ticket_id, { severity: 'low', pr_or_issue: null }, r.version)).toEqual({ ticket_id: r.ticket_id, version: r.version + 1, changed: ['severity', 'pr_or_issue'] });
  });

  it('every gate resolved → review pending; a human approves; not before', () => {
    const { store } = audit();
    store.auditFinding('posthog-2', { finding_id: 'G1', title: 'filters overwritten', fields: { verdict: 'bug', severity: 'medium' } });
    expect(codeOf(() => store.auditReview('posthog-2', { finding_id: 'G1', decision: 'approved' }))).toBe('illegal_transition');
    for (const g of ['repro', 'intent', 'docs', 'prior_reports'] as const) expect(store.auditGate('posthog-2', { finding_id: 'G1', gate: g, ...GATES_ALL[g] }).review).toBeUndefined();
    expect(store.auditReviewQueue('posthog-2').items).toEqual([]);
    const last = store.auditGate('posthog-2', { finding_id: 'G1', gate: 'refuter', result: 'pass', evidence_ref: 'kl:77' });
    expect(last.review).toBe('pending');
    const q = store.auditReviewQueue('posthog-2');
    expect(q.items).toEqual([{ finding_id: 'G1', title: 'filters overwritten', verdict: 'bug', severity: 'medium' }]);
    expect(bytes(q)).toBeLessThan(150);
    const d = store.auditReview('posthog-2', { finding_id: 'G1', decision: 'approved', submit_plan: 'PR wave 1' });
    expect(d.changed).toEqual(['review', 'submit_plan']);
    expect(store.auditReviewQueue('posthog-2').items).toEqual([]);
  });

  it('the lease clock guard covers named leases too', () => {
    const s = new SeaLite({ memory: true, actor: 'a', now: () => new Date(Date.now() + 3_600_000), clockReference: () => Date.now() });
    expect(codeOf(() => s.leaseAcquire({ name: 'sandbox:z' }))).toBe('clock_skew');
    s.close();
  });
});

describe('export and import', () => {
  it('CSV: the mk3 tracker columns in order, then review / fingerprint / evidence / ticket; formula-looking cells are neutralized', () => {
    const { store } = audit();
    store.auditFinding('posthog-2', { finding_id: 'V4', title: '=HYPERLINK("http://x")', fields: { verdict: 'bug', summary: 'line1\nline2, "quoted"' }, gates: GATES_ALL });
    store.auditFinding('posthog-2', { finding_id: 'A1', title: 'a', fields: { affected_count: 2 } });
    expect(EXPORT_COLUMNS.slice(0, MK3.length)).toEqual(MK3);
    const csv = store.auditExport('posthog-2', 'csv') as string;
    const { header, rows } = parseCsv(csv);
    expect(header).toEqual([...EXPORT_COLUMNS]);
    expect(rows.map((r) => r['id'])).toEqual(['A1', 'V4']);
    const v4 = rows[1]!;
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(v4['title']).toBe('=HYPERLINK("http://x")');
    expect(v4['summary']).toBe('line1\nline2, "quoted"');
    expect(v4['gate1_repro']).toBe('live repro');
    expect(v4['repro_result']).toBe('pass');
    expect(v4['docs_result']).toBe('n/a');
    expect(v4['status']).toBe('Not started');
    expect(v4['review']).toBe('pending');
    expect(rows[0]!['affected_count']).toBe('2');
  });

  it('XLSX: a valid zip whose sheet holds every cell, with the frozen header, autofilter and status dropdown', () => {
    const { store } = audit();
    store.auditFinding('posthog-2', { finding_id: 'R2', title: 'a <b> & c', fields: { verdict: 'bug' } });
    const buf = store.auditExport('posthog-2', 'xlsx') as Buffer;
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
    const files = unzip(buf);
    expect(Object.keys(files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = files['xl/worksheets/sheet1.xml']!;
    expect(sheet).toContain('<t xml:space="preserve">a &lt;b&gt; &amp; c</t>');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A1:AI2"/>');
    expect(sheet).toContain('type="list"');
    expect(sheet).toContain('our PR/issue #');
    // Deterministic bytes for the same rows.
    expect((store.auditExport('posthog-2', 'xlsx') as Buffer).equals(buf)).toBe(true);
  });

  it('import of an analysis pass findings.csv: idempotent by finding id, gate results from their own columns, all-or-nothing', () => {
    const { store } = audit();
    const cols = ['id', 'title', 'verdict', 'confidence', 'component', 'gate1_repro', 'repro_result', 'intent_result', 'docs_result', 'prior_reports_result', 'refuter_result'];
    const csv = toCsv(cols, [
      { id: 'K1', title: 'guidance contradicts schema', verdict: 'bug', confidence: 'high', component: 'guidance', gate1_repro: 'seen live', repro_result: 'pass', intent_result: 'pass', docs_result: 'n/a', prior_reports_result: 'pass', refuter_result: 'pass' },
      { id: 'K2', title: 'untyped node', verdict: 'design-gap', confidence: 'low', component: 'schema', gate1_repro: 'pass: reproduced twice', repro_result: '', intent_result: '', docs_result: '', prior_reports_result: '', refuter_result: '' },
    ]);
    expect(store.auditImport('posthog-2', csv)).toEqual({ created: 2, updated: 0, unchanged: 0, queued: 1 });
    const head = store.chain.head().seq;
    expect(store.auditImport('posthog-2', csv)).toEqual({ created: 0, updated: 0, unchanged: 2, queued: 0 });
    expect(store.chain.head().seq).toBe(head);
    const rows = parseCsv(store.auditExport('posthog-2', 'csv') as string).rows;
    expect(rows.find((r) => r['id'] === 'K1')).toMatchObject({ gate1_repro: 'seen live', repro_result: 'pass', review: 'pending' });
    expect(rows.find((r) => r['id'] === 'K2')).toMatchObject({ gate1_repro: 'pass: reproduced twice', repro_result: 'pending', review: '' });
    // A bad row rolls back the whole file.
    const bad = toCsv(['id', 'title', 'verdict'], [
      { id: 'K3', title: 'ok', verdict: 'bug' },
      { id: 'K4', title: 'bad', verdict: 'maybe' },
    ]);
    expect(codeOf(() => store.auditImport('posthog-2', bad))).toBe('invalid_input');
    expect(store.chain.head().seq).toBe(head);
  });
});

describe('projection', () => {
  it('rebuild reproduces fields, leases and intents exactly', () => {
    const clock = new Clock();
    const { w1, w2 } = pair(clock);
    w1.auditOpen({ audit_id: 'a1', title: 'A' });
    w1.auditFinding('a1', { finding_id: 'F1', title: 'f', fields: { verdict: 'bug' }, gates: GATES_ALL });
    w1.auditReview('a1', { finding_id: 'F1', decision: 'hold', note: 'wait for maintainer' });
    w1.auditFinding('a1', { finding_id: 'F1', title: 'f renamed', fields: { verdict: 'design-gap', severity: null } });
    const a = w1.leaseAcquire({ name: 'sandbox:r', lease_seconds: 5 });
    const i = w1.leaseIntent({ name: 'sandbox:r', token: a.token, op: 'w' });
    w1.leaseResolve({ name: 'sandbox:r', token: a.token, intent_id: i.intent_id, outcome: 'happened' });
    w1.leaseIntent({ name: 'sandbox:r', token: a.token, op: 'w2' });
    clock.advance(6);
    w2.leaseAcquire({ name: 'sandbox:r' });
    const snap = () =>
      ['sea_tickets', 'sea_links', 'sea_fields', 'sea_field_heads', 'sea_leases', 'sea_lease_intents'].map((t) => w1.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all());
    const before = snap();
    w1.rebuild();
    expect(snap()).toEqual(before);
    w1.close();
  });
});

function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let k = 0; k < count; k++) {
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26);
    out[name] = inflateRawSync(buf.subarray(off + 30 + lnlen, off + 30 + lnlen + csize)).toString('utf8');
    p += 46 + nlen;
  }
  return out;
}
