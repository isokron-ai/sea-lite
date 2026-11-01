/**
 * Two OS processes share the SQLite file. BEGIN IMMEDIATE + WAL + busy_timeout
 * must make claims exclusive: exactly one claimer wins a contested ticket, and
 * two drainers never hand out the same ticket twice.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SeaLite } from '../src/store.js';

const run = promisify(execFile);
const WORKER = join(process.cwd(), 'test', 'fixtures', 'claim-worker.mjs');

interface WorkerOut {
  actor: string;
  won: string[];
  errors: string[];
}

async function worker(dataDir: string, actor: string, mode: 'claim' | 'drain', ticketId = ''): Promise<WorkerOut> {
  const { stdout } = await run(process.execPath, [WORKER, dataDir, actor, mode, ticketId], { timeout: 30_000 });
  return JSON.parse(stdout.trim().split('\n').pop()!) as WorkerOut;
}

describe('concurrent processes', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sea-lite-conc-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('exactly one of two processes wins a contested claim', async () => {
    const store = new SeaLite({ dataDir: dir, actor: 'setup' });
    const id = store.create({ title: 'contested', body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged', dry_run: false }).ticket.id;
    store.close();
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => worker(dir, `w${i}`, 'claim', id)));
    const winners = results.filter((r) => r.won.length === 1);
    const losers = results.filter((r) => r.won.length === 0);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(3);
    for (const l of losers) expect(l.errors).toEqual(['already_claimed']);
    const check = new SeaLite({ dataDir: dir, actor: 'setup' });
    expect(check.get({ id }).ticket.claim?.holder).toBe(winners[0]!.actor);
    expect(check.verify().ok).toBe(true);
    check.close();
  });

  it('three drainers hand out every ticket exactly once', async () => {
    const store = new SeaLite({ dataDir: dir, actor: 'setup' });
    const ids = Array.from({ length: 30 }, (_, i) =>
      store.create({ title: `job ${i}`, body: '', kind: 'chore', priority: i % 3 === 0 ? 'high' : 'medium', tags: ['drain'], status: 'triaged', dry_run: false }).ticket.id,
    );
    store.close();
    const results = await Promise.all(['d1', 'd2', 'd3'].map((a) => worker(dir, a, 'drain')));
    const all = results.flatMap((r) => r.won);
    expect(all).toHaveLength(ids.length);
    expect(new Set(all).size).toBe(ids.length);
    expect(new Set(all)).toEqual(new Set(ids));
    const check = new SeaLite({ dataDir: dir, actor: 'setup' });
    expect(check.verify().ok).toBe(true);
    check.close();
  });
});
