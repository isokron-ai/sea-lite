/**
 * The human side of an audit on the CLI: import a findings.csv, the review
 * queue, a decision, CSV / XLSX export, and lease show / force release.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SeaLite } from '../src/store.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');
let base: string;
let data: string;

function sl(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--data-dir', data], { encoding: 'utf8', cwd: base, env: { PATH: process.env['PATH'] ?? '', HOME: base, ...extra } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sea-cli-audit-')));
  data = join(base, 'data');
});
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe('sea-lite audit / lease', () => {
  it('import → queue → review → export csv and xlsx', () => {
    const s = new SeaLite({ dataDir: data, actor: 'mcp-audit' });
    s.auditOpen({ audit_id: 'ph2', title: 'PostHog 2' });
    s.close();
    const csv = join(base, 'findings.csv');
    writeFileSync(
      csv,
      'id,title,verdict,repro_result,intent_result,docs_result,prior_reports_result,refuter_result\n' +
        'X1,"dispatcher drops ""limit""",bug,pass,pass,n/a,pass,pass\n' +
        'X2,second,design-gap,,,,,\n',
    );
    expect(sl(['audit', 'import', 'ph2', csv, '--trusted', '--json'])).toMatchObject({ code: 2, err: expect.stringMatching(/^forbidden/) });
    expect(sl(['audit', 'import', 'ph2', csv, '--trusted', '--role', 'operator', '--json'])).toMatchObject({ code: 0 });
    expect(JSON.parse(sl(['audit', 'import', 'ph2', csv, '--trusted', '--role', 'operator', '--json']).out)).toEqual({ created: 0, updated: 0, unchanged: 2, queued: 0 });
    const q = JSON.parse(sl(['audit', 'queue', 'ph2', '--json']).out) as { items: { finding_id: string }[] };
    expect(q.items.map((i) => i.finding_id)).toEqual(['X1']);
    expect(sl(['audit', 'review', 'ph2', 'X1', 'approved', '--plan', 'PR wave 1'])).toMatchObject({ code: 0, out: expect.stringMatching(/^X1: approved/) });
    expect(sl(['audit', 'queue', 'ph2']).out).toBe('review queue empty\n');
    const out = sl(['audit', 'export', 'ph2']).out;
    expect(out.split('\r\n')[1]).toMatch(/^X1,,"dispatcher drops ""limit""",bug,/);
    expect(out).toContain('PR wave 1');
    expect(sl(['audit', 'export', 'ph2', '--format', 'xlsx'])).toMatchObject({ code: 2, err: expect.stringMatching(/--out/) });
    const x = join(base, 't.xlsx');
    expect(sl(['audit', 'export', 'ph2', '--format', 'xlsx', '--out', x]).code).toBe(0);
    expect(readFileSync(x).subarray(0, 2).toString()).toBe('PK');
  });

  it('lease show, and force release only as operator', () => {
    const s = new SeaLite({ dataDir: data, actor: 'w1' });
    s.leaseAcquire({ name: 'sandbox:ph2' });
    s.close();
    expect(JSON.parse(sl(['lease', 'show', 'sandbox:ph2', '--json']).out)).toMatchObject({ holder: 'w1', live: true, epoch: 1 });
    expect(sl(['lease', 'release', 'sandbox:ph2', '--force']).code).toBe(2);
    expect(sl(['lease', 'release', 'sandbox:ph2', '--force', '--role', 'operator']).code).toBe(0);
    expect(JSON.parse(sl(['lease', 'show', 'sandbox:ph2', '--json']).out)).toMatchObject({ live: false });
  });
});
