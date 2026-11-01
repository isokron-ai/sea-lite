/**
 * `sea-lite doctor` (read-only health checks) and the pinned catalog fingerprint.
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CATALOG_FINGERPRINT, CATALOG_VERSION, liveCatalogFingerprint } from '../src/catalog.js';
import { runDoctor, type DoctorReport } from '../src/doctor.js';
import { addActorToken, loadOrCreateBearer } from '../src/http.js';
import { SeaLite } from '../src/store.js';
import { VERSION } from '../src/version.js';

const POSIX = process.platform !== 'win32';
const CWD = process.cwd();
const CLI = join(CWD, 'dist', 'cli.js');

function check(r: DoctorReport, id: string) {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}: ${r.checks.map((x) => x.id).join(', ')}`);
  return c;
}

function seed(dir: string, now?: () => Date): string {
  const store = new SeaLite({ dataDir: dir, actor: 'alice', ...(now ? { now } : {}) });
  const id = store.create({ title: 'doc', body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged', dry_run: false }).ticket.id;
  store.close();
  return id;
}

describe('catalog pin', () => {
  it('CATALOG_FINGERPRINT equals the checked-in snapshot and the live catalog; versions agree', async () => {
    const snap = JSON.parse(readFileSync(join(CWD, '.mcp-catalog', 'sea-lite.json'), 'utf8')) as { sha256: string; server: { version: string } };
    expect(snap.sha256).toBe(CATALOG_FINGERPRINT);
    expect((await liveCatalogFingerprint()).fingerprint).toBe(CATALOG_FINGERPRINT);
    expect(CATALOG_VERSION).toBe(VERSION);
    expect(snap.server.version).toBe(VERSION);
  });
});

describe('sea-lite doctor', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sea-doctor-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('a healthy store passes every check', async () => {
    seed(dir);
    if (POSIX) chmodSync(dir, 0o700);
    const r = await runDoctor({ dataDir: dir, cwd: CWD });
    expect(r.ok).toBe(true);
    for (const id of ['node', 'data-dir', 'db', 'schema', 'chain', 'claims', 'catalog']) expect(check(r, id).status).toBe('ok');
    expect(check(r, 'http-tokens').status).toBe('skip');
    expect(check(r, 'permissions').status).toBe(POSIX ? 'ok' : 'skip');
  });

  it('a missing data dir fails and is not created', async () => {
    const missing = join(dir, 'nope');
    const r = await runDoctor({ dataDir: missing, cwd: CWD });
    expect(r.ok).toBe(false);
    expect(check(r, 'data-dir').status).toBe('fail');
    expect(existsSync(missing)).toBe(false);
  });

  it('an old Node fails', async () => {
    seed(dir);
    const r = await runDoctor({ dataDir: dir, cwd: CWD, nodeVersion: '18.20.0' });
    expect(check(r, 'node').status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('HTTP token files: 0600 ok, group-readable fails, malformed actors file fails, plaintext tokens warn', async () => {
    seed(dir);
    loadOrCreateBearer(dir);
    addActorToken(join(dir, 'http-actors.json'), 'alice');
    let r = await runDoctor({ dataDir: dir, cwd: CWD });
    expect(check(r, 'http-tokens')).toMatchObject({ status: 'ok' });
    expect(check(r, 'http-tokens').detail).toMatch(/1 actor token/);
    if (POSIX) {
      chmodSync(join(dir, 'http-bearer.token'), 0o644);
      r = await runDoctor({ dataDir: dir, cwd: CWD });
      expect(check(r, 'http-tokens').status).toBe('fail');
      expect(check(r, 'http-tokens').detail).toMatch(/readable by others/);
      chmodSync(join(dir, 'http-bearer.token'), 0o600);
    }
    const alt = join(dir, 'alt-actors.json');
    writeFileSync(alt, JSON.stringify({ actors: [{ actor: 'p', token: 'p'.repeat(20) }] }), { mode: 0o600 });
    r = await runDoctor({ dataDir: dir, cwd: CWD, actorsFile: alt });
    expect(check(r, 'http-tokens').status).toBe('warn');
    writeFileSync(alt, '{"actors":[{"actor":"p"}]}', { mode: 0o600 });
    r = await runDoctor({ dataDir: dir, cwd: CWD, actorsFile: alt });
    expect(check(r, 'http-tokens').status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('a sea row pointing at a missing chain event fails the chain check', async () => {
    const id = seed(dir);
    const db = new Database(join(dir, 'kronicle-lite.db'));
    db.prepare(`UPDATE sea_tickets SET last_seq = 999999 WHERE id = ?`).run(id);
    db.close();
    const r = await runDoctor({ dataDir: dir, cwd: CWD });
    expect(check(r, 'chain')).toMatchObject({ status: 'fail' });
    expect(check(r, 'chain').detail).toMatch(/rebuild/);
  });

  it('a store from a newer sea-lite fails the schema check', async () => {
    seed(dir);
    const db = new Database(join(dir, 'kronicle-lite.db'));
    db.prepare(`UPDATE meta SET value = '99' WHERE key = 'sea_schema_version'`).run();
    db.close();
    const r = await runDoctor({ dataDir: dir, cwd: CWD });
    expect(check(r, 'schema').status).toBe('fail');
  });

  it('a lease that lapsed long ago warns, and doctor does not sweep it', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    const store = new SeaLite({ dataDir: dir, actor: 'alice', now: () => twoHoursAgo });
    const id = store.create({ title: 'old', body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged', dry_run: false }).ticket.id;
    store.claim({ ticket_ids: [id], lease_seconds: 10 });
    const head = store.chain.head().seq;
    store.close();
    const r = await runDoctor({ dataDir: dir, cwd: CWD });
    expect(check(r, 'claims')).toMatchObject({ status: 'warn', data: { lapsed_unswept: 1, live: 0 } });
    expect(r.ok).toBe(true); // a warning is not a failure
    const after = new SeaLite({ dataDir: dir, now: () => twoHoursAgo });
    expect(after.chain.head().seq).toBe(head);
    expect(after.get({ id }).ticket.claim?.holder).toBe('alice');
    after.close();
  });

  it('`sea-lite doctor` exits 0 when healthy and 1 on a failure; --json is the report', () => {
    seed(dir);
    const ok = JSON.parse(execFileSync(process.execPath, [CLI, 'doctor', '--data-dir', dir, '--json', '--cwd', CWD], { encoding: 'utf8' })) as DoctorReport;
    expect(ok.ok).toBe(true);
    const text = execFileSync(process.execPath, [CLI, 'doctor', '--data-dir', dir, '--cwd', CWD], { encoding: 'utf8' });
    expect(text).toMatch(/healthy: \d+ ok/);
    let code = 0;
    try {
      execFileSync(process.execPath, [CLI, 'doctor', '--data-dir', join(dir, 'missing')], { encoding: 'utf8' });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(1);
  });
});
