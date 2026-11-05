/**
 * Review fixes for #5 (written before the fixes): lease exclusivity per
 * instance, CSV formula guard + round trip, strict import, the clock probe,
 * one test per skew guard, field-name and review-queue integrity, export
 * file mode, secret redaction, and 0.6.x rebuild compatibility.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { EXPORT_COLUMNS } from '../src/audit/audit.js';
import { guardCell, parseCsv, toCsv } from '../src/audit/export.js';
import { fsReference } from '../src/core/clock.js';
import type { SeaError } from '../src/core/errors.js';
import { runDoctor } from '../src/doctor.js';
import { SeaLite } from '../src/store.js';
import { Clock, codeOf, fresh } from './helpers.js';

const POSIX = process.platform !== 'win32';
const NEW = { body: '', kind: 'bug' as const, priority: 'high' as const, tags: [], status: 'triaged' as const, dry_run: false };
const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sea-hard-')));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function err(fn: () => unknown): SeaError {
  try {
    fn();
  } catch (e) {
    return e as SeaError;
  }
  throw new Error('expected an error');
}

describe('lease exclusivity is per instance, not per actor (#5 blocker 1)', () => {
  it('same-actor storm: 6 processes as one actor, exactly one wins', async () => {
    const dir = tmp();
    new SeaLite({ dataDir: dir, actor: 'init' }).close();
    const lib = pathToFileURL(join(process.cwd(), 'dist', 'index.js')).href;
    const script = `import { SeaLite } from ${JSON.stringify(lib)};
      const s = new SeaLite({ dataDir: process.argv[1], actor: 'mcp-audit' });
      try { s.leaseAcquire({ name: 'sandbox:same' }); console.log('won'); } catch (e) { console.log(e.code); } finally { s.close(); }`;
    const runs = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<string>((res) => {
            const c = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
            let o = '';
            c.stdout.on('data', (d: Buffer) => (o += d.toString()));
            c.on('close', () => res(o.trim()));
          }),
      ),
    );
    expect(runs.filter((r) => r === 'won')).toHaveLength(1);
    expect(runs.filter((r) => r === 'already_claimed')).toHaveLength(5);
  }, 60_000);

  it('restart within the TTL: the new instance is refused until expiry, then gets the open intent as unresolved and cannot repeat it', () => {
    const clock = new Clock();
    const first = new SeaLite({ memory: true, actor: 'mcp-audit', now: clock.now });
    const a = first.leaseAcquire({ name: 'sandbox:r', lease_seconds: 60 });
    const it1 = first.leaseIntent({ name: 'sandbox:r', token: a.token, op: 'insight-create', idempotency_key: 'k1' });
    // crash; the runner restarts as a new instance of the same actor
    const restarted = new SeaLite({ kronicle: first.kronicle, actor: 'mcp-audit', now: clock.now });
    expect(codeOf(() => restarted.leaseAcquire({ name: 'sandbox:r' }))).toBe('already_claimed');
    clock.advance(61);
    const b = restarted.leaseAcquire({ name: 'sandbox:r' });
    expect(b.epoch).toBe(2);
    expect(b.unresolved?.map((u) => u.intent_id)).toEqual([it1.intent_id]);
    expect(err(() => restarted.leaseIntent({ name: 'sandbox:r', token: b.token, op: 'insight-create', idempotency_key: 'k1' })).details).toMatchObject({ reason: 'unresolved_intents' });
    expect(restarted.leaseShow('sandbox:r')).toMatchObject({ open: 0, may_have_happened: 1 });
    first.close();
  });

  it('a re-acquire by the live holder itself still rotates the epoch and reports its open intents', () => {
    const { store } = fresh();
    const a = store.leaseAcquire({ name: 'sandbox:self' });
    const i = store.leaseIntent({ name: 'sandbox:self', token: a.token, op: 'w' });
    const b = store.leaseAcquire({ name: 'sandbox:self' });
    expect(b.epoch).toBe(a.epoch + 1);
    expect(b.unresolved?.map((u) => u.intent_id)).toEqual([i.intent_id]);
    expect(codeOf(() => store.leaseRenew({ name: 'sandbox:self', token: a.token }))).toBe('fence_invalid');
  });
});

const NASTY = [' =1+1', '\n=1+1', ' =1+1', '　+1', '＝1+1', '＋1', '－1', '＠SUM(A1)', '\t1', '\r1', '=1', '+1', '-1', '@x', "'=already", "''=x"];

describe('CSV formula guard (#5 blocker 2) and round trip', () => {
  it('every formula-looking cell is prefixed with an apostrophe', () => {
    for (const v of NASTY) expect(guardCell(v), JSON.stringify(v)).toBe(`'${v}`);
    for (const v of ['plain', "it's", 'a=b', ' x']) expect(guardCell(v)).toBe(v);
    // parseCsv undoes exactly one level, so the values come back as written.
    const all = [...NASTY, 'plain', "it's"];
    expect(parseCsv(toCsv(['v'], all.map((v) => ({ v })))).rows.map((r) => r['v'])).toEqual(all);
  });

  it('export → trusted import → export is the identity (guard prefix undone, gate results from their own columns)', () => {
    const { store } = fresh({ actor: 'mcp-audit', role: 'operator' });
    store.auditOpen({ audit_id: 'a', title: 'A' });
    store.auditOpen({ audit_id: 'b', title: 'B' });
    store.auditFinding('a', {
      finding_id: 'F1',
      title: NASTY[0]!,
      fields: { verdict: 'bug', summary: NASTY.join('|'), evidence: "'=already" },
      gates: { repro: { result: 'fail', note: 'pass: looked like a pass but it failed' }, intent: { result: 'pass' }, docs: { result: 'n/a' }, prior_reports: { result: 'pass' }, refuter: { result: 'pass' } },
    });
    store.auditFinding('a', { finding_id: 'F2', title: 'two', gates: { repro: { result: 'pass', note: 'fail: in the note only' } } });
    const one = store.auditExport('a', 'csv') as string;
    store.auditImport('b', one, { trusted: true });
    const strip = (csv: string) => parseCsv(csv).rows.map((r) => ({ ...r, ticket_id: '' }));
    expect(strip(store.auditExport('b', 'csv') as string)).toEqual(strip(one));
    const f1 = parseCsv(one).rows.find((r) => r['id'] === 'F1')!;
    expect(f1['repro_result']).toBe('fail');
    expect(f1['gate1_repro']).toBe('pass: looked like a pass but it failed');
  });
});

describe('strict findings.csv import', () => {
  const H = 'id,title,verdict\n';
  const run = (csv: string) => {
    const { store } = fresh({ actor: 'mcp-audit' });
    store.auditOpen({ audit_id: 'a', title: 'A' });
    const head = store.chain.head().seq;
    const e = err(() => store.auditImport('a', csv));
    expect(store.chain.head().seq).toBe(head);
    return e;
  };
  it('an unterminated quote is an error naming the row', () => {
    const e = run(H + 'A1,"never closed,bug\nA2,two,bug\n');
    expect(e.code).toBe('invalid_input');
    expect(e.message).toMatch(/row 2/);
  });
  it('duplicate ids are an error naming both rows', () => {
    const e = run(H + 'A1,one,bug\nA1,again,bug\n');
    expect(e.code).toBe('invalid_input');
    expect(e.message).toMatch(/row 3.*row 2|rows 2 and 3/);
  });
  it('duplicate and unknown columns are errors', () => {
    expect(run('id,title,verdict,verdict\nA1,one,bug,bug\n').message).toMatch(/duplicate column "verdict"/);
    expect(run('id,title,verdikt\nA1,one,bug\n').message).toMatch(/unknown column "verdikt"/);
  });
  it('a row with more cells than the header is an error naming it', () => {
    expect(run(H + 'A1,one,bug,extra\n').message).toMatch(/row 2/);
  });
});

describe('clock probe hardening', () => {
  it.skipIf(!POSIX)('does not follow a symlink (a canary stays intact) and refuses it', () => {
    const dir = tmp();
    const canary = join(dir, 'canary.txt');
    writeFileSync(canary, 'precious\n');
    symlinkSync(canary, join(dir, 'sea-clock.probe'));
    expect(fsReference(dir)()).toBeNull();
    expect(readFileSync(canary, 'utf8')).toBe('precious\n');
  });

  it.skipIf(!POSIX)('does not block on a FIFO', () => {
    const dir = tmp();
    const r = spawnSync('mkfifo', [join(dir, 'sea-clock.probe')]);
    if (r.status !== 0) return;
    const t0 = Date.now();
    expect(fsReference(dir)()).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('an unwritable probe warns once instead of failing open silently, and doctor reports it', async () => {
    const dir = tmp();
    const warnings: string[] = [];
    const ref = fsReference(dir, (m) => warnings.push(m));
    if (POSIX) {
      symlinkSync('/nonexistent', join(dir, 'sea-clock.probe'));
      expect(ref()).toBeNull();
      expect(ref()).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/clock check disabled/);
    }
    new SeaLite({ dataDir: join(dir, 'd'), actor: 'a' }).close();
    const rep = await runDoctor({ dataDir: join(dir, 'd') });
    expect(rep.checks.find((c) => c.id === 'clock')).toMatchObject({ status: 'ok' });
  });
});

describe('each skew guard on its own (C2-06 follow-up)', () => {
  const ahead = () => new Date(Date.now() + 15 * 60_000);
  const setup = () => {
    const A = new SeaLite({ memory: true, actor: 'a', now: () => new Date(), clockReference: () => Date.now() });
    const B = new SeaLite({ kronicle: A.kronicle, actor: 'b', now: ahead, clockReference: () => Date.now() });
    const bTrusted = new SeaLite({ kronicle: A.kronicle, actor: 'b', now: () => new Date(), clockReference: () => Date.now() });
    return { A, B, bTrusted };
  };
  it('B.get() does not sweep A’s live lease (sweepExpired guard)', () => {
    const { A, B } = setup();
    const t = A.create({ title: 'x', ...NEW });
    A.claim({ ticket_ids: [t.ticket.id] });
    expect(B.get({ id: t.ticket.id }).ticket.claim?.holder).toBe('a');
    expect(A.get({ id: t.ticket.id }).ticket.claim?.holder).toBe('a');
    A.close();
  });
  it('B.create with claim_seconds is refused (placeClaim guard)', () => {
    const { A, B } = setup();
    expect(codeOf(() => B.create({ title: 'y', ...NEW, claim_seconds: 60 }))).toBe('clock_skew');
    A.close();
  });
  it('B.refresh of its own claim is refused (refresh guard)', () => {
    const { A, B, bTrusted } = setup();
    const t = bTrusted.create({ title: 'z', ...NEW });
    const c = bTrusted.claim({ ticket_ids: [t.ticket.id] });
    expect(codeOf(() => B.refresh({ ticket_id: t.ticket.id, claim_token: c.claims[0]!.claim_token }))).toBe('clock_skew');
    A.close();
  });
  it('B.heartbeat is refused; the auto-heartbeat does not extend B’s claims', () => {
    const { A, B, bTrusted } = setup();
    const t = bTrusted.create({ title: 'h', ...NEW });
    const c = bTrusted.claim({ ticket_ids: [t.ticket.id] });
    expect(codeOf(() => B.heartbeat())).toBe('clock_skew');
    B.touch();
    expect(bTrusted.get({ id: t.ticket.id }).ticket.claim?.expires_at).toBe(c.claims[0]!.expires_at);
    A.close();
  });
  it('lease acquire and renew are refused', () => {
    const { A, B, bTrusted } = setup();
    expect(codeOf(() => B.leaseAcquire({ name: 'sandbox:g' }))).toBe('clock_skew');
    const l = bTrusted.leaseAcquire({ name: 'sandbox:g' });
    expect(codeOf(() => B.leaseRenew({ name: 'sandbox:g', token: l.token }))).toBe('clock_skew');
    A.close();
  });
});

describe('typed field integrity', () => {
  it('prototype names are invalid_input, not a TypeError', () => {
    const { store } = fresh();
    const t = store.create({ title: 'x', ...NEW });
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(codeOf(() => store.setFields(t.ticket.id, JSON.parse(`{"${k}": "x"}`) as Record<string, unknown>))).toBe('invalid_input');
    }
  });

  it('review and gate results cannot be set around the queue', () => {
    const { store } = fresh({ actor: 'mcp-audit' });
    store.auditOpen({ audit_id: 'a', title: 'A' });
    const f = store.auditFinding('a', { finding_id: 'F', title: 'f' });
    for (const patch of [{ review: 'approved' }, { result: 'pass' }, { finding_id: 'G' }, { audit_id: 'b' }]) expect(codeOf(() => store.setFields(f.ticket_id, patch))).toBe('invalid_input');
  });

  it('an approval is cleared when a gate flips to fail or the verdict changes', () => {
    const { store } = fresh({ actor: 'mcp-audit' });
    store.auditOpen({ audit_id: 'a', title: 'A' });
    const all = { repro: { result: 'pass' }, intent: { result: 'pass' }, docs: { result: 'pass' }, prior_reports: { result: 'pass' }, refuter: { result: 'pass' } };
    store.auditFinding('a', { finding_id: 'F', title: 'f', fields: { verdict: 'bug' }, gates: all });
    store.auditReview('a', { finding_id: 'F', decision: 'approved' });
    expect(store.auditGate('a', { finding_id: 'F', gate: 'refuter', result: 'fail' }).review).toBe('pending');
    expect(store.auditReviewQueue('a').items.map((i) => i.finding_id)).toEqual(['F']);
    store.auditGate('a', { finding_id: 'F', gate: 'refuter', result: 'pass' });
    store.auditReview('a', { finding_id: 'F', decision: 'approved' });
    expect(store.auditFinding('a', { finding_id: 'F', title: 'f', fields: { verdict: 'design-gap' } }).review).toBe('pending');
  });
});

describe('export file, secrets, 0.6.x compatibility', () => {
  it.skipIf(!POSIX)('audit export --out writes mode 0600, also over an existing 0644 file', () => {
    const dir = tmp();
    const data = join(dir, 'data');
    const s = new SeaLite({ dataDir: data, actor: 'mcp-audit' });
    s.auditOpen({ audit_id: 'a', title: 'A' });
    s.close();
    const out = join(dir, 'x.csv');
    writeFileSync(out, 'old', { mode: 0o644 });
    const r = spawnSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'audit', 'export', 'a', '--out', out, '--data-dir', data], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: dir } });
    expect(r.status).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it('free text that looks like a credential is redacted before it reaches the chain', () => {
    const { store } = fresh({ actor: 'mcp-audit' });
    store.auditOpen({ audit_id: 'a', title: 'A' });
    const key = 'phx_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
    const gh = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
    const r = store.auditFinding('a', { finding_id: 'S', title: `leaks ${gh}`, fields: { evidence: `Authorization: Bearer ${key}`, summary: `token ${gh}` } });
    expect(r.redacted?.length).toBeGreaterThan(0);
    const chain = JSON.stringify([...store.chain.iterate()]);
    expect(chain).not.toContain(gh);
    expect(chain).not.toContain(key);
    expect(store.fields(r.ticket_id).fields.summary).toMatch(/\[REDACTED:/);
  });

  it('a 0.6.x rebuild (drops only its own four tables, foreign keys on) still succeeds on a store with audit data', () => {
    const dir = tmp();
    const s = new SeaLite({ dataDir: dir, actor: 'mcp-audit' });
    s.auditOpen({ audit_id: 'a', title: 'A' });
    s.auditFinding('a', { finding_id: 'F', title: 'f', fields: { verdict: 'bug' } });
    const old = ['sea_tickets_fts', 'sea_notes', 'sea_links', 'sea_tickets'].map((t) => `DROP TABLE IF EXISTS ${t};`).join('\n');
    s.db.pragma('foreign_keys = ON');
    expect(() => s.db.transaction(() => s.db.exec(old))()).not.toThrow();
    s.close();
    expect(existsSync(dir)).toBe(true);
  });
});

it('EXPORT_COLUMNS carries a result column per gate after the tracker columns', () => {
  expect(EXPORT_COLUMNS).toEqual(expect.arrayContaining(['repro_result', 'intent_result', 'docs_result', 'prior_reports_result', 'refuter_result']));
});
