/**
 * #6 (0.7.0 blockers from the #5 re-review), items 1–4 and 6: nothing
 * credential-shaped reaches the append-only chain (lease op / evidence_ref,
 * audit title, boundary and encoded forms), `audit export --out` never
 * follows a symlink, and an agent-written findings.csv can only *claim* gate
 * results.
 */

import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseCsv, toCsv } from '../src/audit/export.js';
import { redactText } from '../src/audit/fields.js';
import { SeaLite } from '../src/store.js';
import { codeOf, fresh } from './helpers.js';

const POSIX = process.platform !== 'win32';
const GHP = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
const PHX = 'phx_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const chainText = (s: SeaLite) => JSON.stringify([...s.chain.iterate()]);

describe('#6.1 no raw credential in the chain', () => {
  it('lease op is redacted; a credential-shaped evidence_ref or lease name is refused', () => {
    const { store } = fresh({ actor: 'mcp-audit' });
    const l = store.leaseAcquire({ name: 'sandbox:x' });
    const i = store.leaseIntent({ name: 'sandbox:x', token: l.token, op: `POST /api?token=${GHP}` });
    expect(codeOf(() => store.leaseResolve({ name: 'sandbox:x', token: l.token, intent_id: i.intent_id, outcome: 'happened', evidence_ref: GHP }))).toBe('invalid_input');
    expect(codeOf(() => store.leaseAcquire({ name: GHP }))).toBe('invalid_input');
    store.leaseResolve({ name: 'sandbox:x', token: l.token, intent_id: i.intent_id, outcome: 'happened', evidence_ref: 'kl:12' });
    expect(chainText(store)).not.toContain(GHP);
  });

  it('the audit title is redacted; identity tokens that look like keys are refused', () => {
    const { store } = fresh({ actor: 'mcp-audit' });
    store.auditOpen({ audit_id: 'a', title: `audit of ${GHP}` });
    expect(codeOf(() => store.auditOpen({ audit_id: 'b', title: 't', catalog_fingerprint: GHP }))).toBe('invalid_input');
    expect(codeOf(() => store.auditFinding('a', { finding_id: GHP, title: 't' }))).toBe('invalid_input');
    expect(codeOf(() => store.auditFinding('a', { finding_id: 'F', title: 't', fields: { evidence_ref: PHX } }))).toBe('invalid_input');
    expect(chainText(store)).not.toContain(GHP);
    expect(chainText(store)).not.toContain(PHX);
  });
});

describe('#6.3 / #6.4 redaction boundaries and encodings', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const cases: [string, string][] = [
    ['bare phx_ key', PHX],
    ['underscore-wrapped ghp', `_${GHP}_`],
    ['key_ prefix', `key_${PHX}`],
    ['_x suffix', `${PHX}_x`],
    ['base64', b64(`Authorization: token ${GHP}`)],
    ['base64 of a bare key', b64(PHX)],
    ['base64url', Buffer.from(GHP).toString('base64url')],
    ['URL-encoded', encodeURIComponent(GHP).replace('_', '%5F')],
    ['URL-encoded in a query', `https://x.test/cb?t=${PHX.replace('_', '%5f')}&a=1`],
  ];
  for (const [what, text] of cases) {
    it(what, () => {
      const r = redactText(`see ${text} here`, 'evidence');
      expect(r.redacted).toBe(true);
      expect(r.text).not.toContain(text);
      for (const raw of [GHP, PHX]) expect(r.text).not.toContain(raw.slice(4, 24));
    });
  }
  it('leaves ordinary text, hashes, ids and base64 of ordinary text alone', () => {
    for (const t of [
      'the phx team ships ghp packages',
      'sha256:' + 'ab'.repeat(32),
      '4f9a1c2e-6b1d-4c1e-9a7b-2f3d4e5f6a7b',
      Buffer.from('a perfectly ordinary sentence, nothing secret here').toString('base64'),
      'https://example.com/path%20with%20spaces?q=a%2Bb',
      'phx_short',
    ]) expect(redactText(t, 'x'), t).toEqual({ text: t, redacted: false });
  });
});

describe('#6.2 export --out never follows a symlink', () => {
  it.skipIf(!POSIX)('a symlink at the out path is replaced, its target untouched', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sea-out-')));
    dirs.push(dir);
    const data = join(dir, 'data');
    const s = new SeaLite({ dataDir: data, actor: 'mcp-audit' });
    s.auditOpen({ audit_id: 'a', title: 'A' });
    s.close();
    const canary = join(dir, 'canary');
    writeFileSync(canary, 'precious\n', { mode: 0o644 });
    const out = join(dir, 'x.csv');
    symlinkSync(canary, out);
    const r = spawnSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'audit', 'export', 'a', '--out', out, '--data-dir', data], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: dir } });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(canary, 'utf8')).toBe('precious\n');
    expect(lstatSync(canary).mode & 0o777).toBe(0o644);
    const st = lstatSync(out);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.mode & 0o777).toBe(0o600);
    expect(readFileSync(out, 'utf8')).toMatch(/^id,/);
  });
});

describe('#6.6 an imported gate result is a claim unless the import is trusted', () => {
  const ALL = { repro_result: 'pass', intent_result: 'pass', docs_result: 'pass', prior_reports_result: 'pass', refuter_result: 'pass' };
  const csv = toCsv(['id', 'title', 'verdict', ...Object.keys(ALL)], [{ id: 'S1', title: 'self-approved', verdict: 'bug', ...ALL }]);

  it('an agent import records claimed results; nothing enters the review queue', () => {
    const { store } = fresh({ actor: 'mcp-audit' });
    store.auditOpen({ audit_id: 'a', title: 'A' });
    expect(store.auditImport('a', csv)).toMatchObject({ created: 1, queued: 0 });
    expect(store.auditReviewQueue('a').items).toEqual([]);
    const row = parseCsv(store.auditExport('a', 'csv') as string).rows[0]!;
    expect(row['repro_result']).toBe('claimed:pass');
    expect(row['review']).toBe('');
    // The runner verifies and records the real result; the claim does not count for anything.
    for (const g of ['repro', 'intent', 'docs', 'prior_reports'] as const) store.auditGate('a', { finding_id: 'S1', gate: g, result: 'pass' });
    expect(store.auditReviewQueue('a').items).toEqual([]);
    expect(store.auditGate('a', { finding_id: 'S1', gate: 'refuter', result: 'pass' }).review).toBe('pending');
  });

  it('a trusted import (operator only) records results', () => {
    const { store } = fresh({ actor: 'mcp-audit' });
    store.auditOpen({ audit_id: 'a', title: 'A' });
    expect(codeOf(() => store.auditImport('a', csv, { trusted: true }))).toBe('forbidden');
    const op = new SeaLite({ kronicle: store.kronicle, actor: 'operator-1', role: 'operator' });
    expect(op.auditImport('a', csv, { trusted: true })).toMatchObject({ created: 1, queued: 1 });
  });

  it('a claimed:… cell is always a claim, even in a trusted import', () => {
    const { store } = fresh({ actor: 'mcp-audit', role: 'operator' });
    store.auditOpen({ audit_id: 'a', title: 'A' });
    const c = toCsv(['id', 'title', 'repro_result'], [{ id: 'C', title: 'c', repro_result: 'claimed:fail' }]);
    store.auditImport('a', c, { trusted: true });
    expect(parseCsv(store.auditExport('a', 'csv') as string).rows[0]!['repro_result']).toBe('claimed:fail');
    expect(codeOf(() => store.auditImport('a', toCsv(['id', 'title', 'repro_result'], [{ id: 'D', title: 'd', repro_result: 'claimed:maybe' }])))).toBe('invalid_input');
  });
});

describe('#6.5 a decision is reopened by any change of substance', () => {
  const ALL = { repro: { result: 'pass' }, intent: { result: 'pass' }, docs: { result: 'pass' }, prior_reports: { result: 'pass' }, refuter: { result: 'pass' } };
  const approved = (decision: 'approved' | 'rejected' | 'hold' = 'approved') => {
    const { store } = fresh({ actor: 'mcp-audit' });
    store.auditOpen({ audit_id: 'a', title: 'A' });
    store.auditFinding('a', { finding_id: 'F', title: 'f', fields: { verdict: 'bug', severity: 'high', summary: 's' }, gates: ALL });
    store.as(store.actor, 'operator').auditReview('a', { finding_id: 'F', decision });
    return store;
  };
  const review = (s: SeaLite) => parseCsv(s.auditExport('a', 'csv') as string).rows[0]!['review'];
  const queue = (s: SeaLite) => s.auditReviewQueue('a').items.map((i) => i.finding_id);

  it('a gate back to pending takes it out of the queue until it is resolved again', () => {
    const s = approved();
    s.auditGate('a', { finding_id: 'F', gate: 'repro', result: 'pending' });
    expect(review(s)).toBe('');
    expect(queue(s)).toEqual([]);
    expect(s.auditGate('a', { finding_id: 'F', gate: 'repro', result: 'pass' }).review).toBe('pending');
    expect(queue(s)).toEqual(['F']);
  });
  it('a gate to n/a, a new severity or summary, or a new title re-queues it', () => {
    for (const change of [
      (s: SeaLite) => s.auditGate('a', { finding_id: 'F', gate: 'docs', result: 'n/a' }),
      (s: SeaLite) => s.auditFinding('a', { finding_id: 'F', title: 'f', fields: { severity: 'low' } }),
      (s: SeaLite) => s.auditFinding('a', { finding_id: 'F', title: 'f', fields: { summary: 'different' } }),
      (s: SeaLite) => s.auditFinding('a', { finding_id: 'F', title: 'f renamed' }),
    ]) {
      const s = approved();
      expect(change(s).review).toBe('pending');
      expect(review(s)).toBe('pending');
    }
  });
  it('rejected and hold decisions reopen too; tracker bookkeeping does not reopen anything', () => {
    for (const d of ['rejected', 'hold'] as const) {
      const s = approved(d);
      s.auditFinding('a', { finding_id: 'F', title: 'f', fields: { severity: 'medium' } });
      expect(review(s)).toBe('pending');
    }
    const s = approved();
    expect(s.auditFinding('a', { finding_id: 'F', title: 'f', fields: { tracker_status: 'PR open', pr_or_issue: 'o/r#1', submitted_date: '2026-11-06' } }).review).toBeUndefined();
    expect(review(s)).toBe('approved');
  });
});

describe('#6.8 short rows', () => {
  it('a row with fewer cells than the header is an error naming it', () => {
    const { store } = fresh({ actor: 'mcp-audit' });
    store.auditOpen({ audit_id: 'a', title: 'A' });
    let msg = '';
    try {
      store.auditImport('a', 'id,title,verdict\nA1,one,bug\nA2,two\n');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/row 3: 2 cells, header has 3/);
  });
});

describe('#6.7 probe-path tampering', () => {
  it.skipIf(!POSIX)('a hard link at the probe path is not truncated; the probe is replaced and still measures', async () => {
    const { linkSync, statSync } = await import('node:fs');
    const { fsReference } = await import('../src/core/clock.js');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sea-probe-')));
    dirs.push(dir);
    const canary = join(dir, 'canary');
    writeFileSync(canary, 'precious\n');
    linkSync(canary, join(dir, 'sea-clock.probe'));
    const ref = fsReference(dir, () => undefined)();
    expect(typeof ref).toBe('number');
    expect(readFileSync(canary, 'utf8')).toBe('precious\n');
    expect(statSync(canary).nlink).toBe(1);
  });

  it.skipIf(!POSIX)('a planted symlink or FIFO is replaced, not trusted as a reason to switch the guard off', async () => {
    const { fsReference } = await import('../src/core/clock.js');
    for (const plant of ['symlink', 'fifo'] as const) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sea-probe-')));
      dirs.push(dir);
      const probe = join(dir, 'sea-clock.probe');
      if (plant === 'symlink') symlinkSync('/nonexistent/x', probe);
      else if (spawnSync('mkfifo', [probe]).status !== 0) continue;
      expect(typeof fsReference(dir, () => undefined)(), plant).toBe('number');
      expect(lstatSync(probe).isFile()).toBe(true);
    }
  });

  it('a directory planted at the probe path no longer blocks lease decisions (#8: it is moved aside)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sea-probe-')));
    dirs.push(dir);
    const s = new SeaLite({ dataDir: dir, actor: 'a' });
    const t = s.create({ title: 'x', body: '', kind: 'bug', priority: 'high', tags: [], status: 'triaged', dry_run: false });
    s.close();
    spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(join(dir, 'sea-clock.probe'))}); require('fs').writeFileSync(${JSON.stringify(join(dir, 'sea-clock.probe', 'keep'))}, 'x')`]);
    const s2 = new SeaLite({ dataDir: dir, actor: 'a' });
    expect(s2.claim({ ticket_ids: [t.ticket.id] }).claims).toHaveLength(1);
    s2.close();
  });
});
