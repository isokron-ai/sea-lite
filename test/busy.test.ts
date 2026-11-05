/**
 * Round-3 lead (sl-cli-tokens.sh 40: one crash inside a SQLite txn under
 * load). 0.6.2: SQLITE_BUSY past the busy timeout is a typed, retryable
 * `wait_timeout` (nothing written), the busy timeout is no longer lowered
 * below kronicle-lite's 10 s, and opening a store whose schema is current
 * writes nothing (one fewer write transaction per CLI command).
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SeaLite } from '../src/store.js';
import { codeOf } from './helpers.js';

const NEW = { body: '', kind: 'bug' as const, priority: 'high' as const, tags: [], status: 'triaged' as const, dry_run: false };
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('busy store', () => {
  it('a write past the busy timeout is wait_timeout, not a raw SqliteError; nothing is written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sea-busy-'));
    dirs.push(dir);
    const s = new SeaLite({ dataDir: dir, actor: 'a' });
    expect(Number(s.db.pragma('busy_timeout', { simple: true }))).toBeGreaterThanOrEqual(10_000);
    s.db.pragma('busy_timeout = 50');
    const other = new Database(join(dir, 'kronicle-lite.db'));
    const head = s.chain.head().seq;
    other.prepare('BEGIN IMMEDIATE').run();
    try {
      expect(codeOf(() => s.create({ title: 'x', ...NEW }))).toBe('wait_timeout');
    } finally {
      other.prepare('COMMIT').run();
      other.close();
    }
    expect(s.chain.head().seq).toBe(head);
    expect(s.create({ title: 'x', ...NEW }).ticket.title).toBe('x');
    s.close();
  });

  it('re-opening a current store commits nothing on the sea-lite side', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sea-busy-'));
    dirs.push(dir);
    new SeaLite({ dataDir: dir, actor: 'a' }).close();
    const watcher = new Database(join(dir, 'kronicle-lite.db'));
    const before = watcher.pragma('data_version', { simple: true });
    new SeaLite({ dataDir: dir, actor: 'a' }).close();
    expect(watcher.pragma('data_version', { simple: true })).toBe(before);
    watcher.close();
  });
});
