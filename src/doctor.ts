/**
 * `sea-lite doctor`: is this install and this data dir healthy?
 *
 * Read-only by design: it opens the database with `readonly: true`, never
 * creates the data dir, a token or a table, never sweeps a lease. Exit 0 when
 * no check fails, 1 otherwise; `--json` prints the report.
 */

import Database from 'better-sqlite3';
import { Chain, type Signer } from 'kronicle-lite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CATALOG_FINGERPRINT, CATALOG_VERSION, liveCatalogFingerprint } from './catalog.js';
import { SEA_SCHEMA_META_KEY, SEA_SCHEMA_VERSION } from './db/schema.js';
import { ACTORS_FILE_NAME, BEARER_FILE_NAME, MIN_TOKEN_CHARS, parseActorsFile } from './http.js';
import { verifySea } from './rebuild.js';
import { fsReference, parseMaxSkew } from './core/clock.js';
import { VERSION } from './version.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  detail: string;
  data?: Record<string, unknown>;
}

export interface DoctorReport {
  version: string;
  node: string;
  platform: string;
  data_dir: string;
  ok: boolean;
  summary: Record<CheckStatus, number>;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  dataDir: string;
  /** Project directory holding .mcp-catalog/sea-lite.json (default cwd). */
  cwd?: string;
  /** Actors file to check instead of `<dataDir>/http-actors.json`. */
  actorsFile?: string;
  /** Injectable for tests. */
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  now?: Date;
}

export const DB_FILE_NAME = 'kronicle-lite.db';
const MIN_NODE_MAJOR = 20;
/** A lapsed lease nobody has noticed for this long means nothing is reading the queue. */
const STALE_EXPIRY_MS = 3_600_000;

const noSigner: Signer = {
  key_id: 'doctor-readonly',
  public_key_pem: '',
  sign() {
    throw new Error('doctor is read-only');
  },
};

function mode(p: string): number | null {
  try {
    return statSync(p).mode & 0o777;
  } catch {
    return null;
  }
}

function octal(m: number): string {
  return '0' + m.toString(8).padStart(3, '0');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function checkNode(version: string): DoctorCheck {
  const major = Number(version.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? { id: 'node', status: 'ok', detail: `Node ${version} (requires >= ${MIN_NODE_MAJOR})` }
    : { id: 'node', status: 'fail', detail: `Node ${version} is too old; sea-lite requires Node >= ${MIN_NODE_MAJOR}` };
}

function checkPermissions(dataDir: string, platform: NodeJS.Platform): DoctorCheck {
  if (platform === 'win32') {
    return { id: 'permissions', status: 'skip', detail: 'Windows: POSIX modes are not enforced (0700/0600 are no-ops); rely on the user profile ACL' };
  }
  const dm = mode(dataDir);
  if (dm === null) return { id: 'permissions', status: 'skip', detail: 'no data dir' };
  const problems: string[] = [];
  let status: CheckStatus = 'ok';
  const dirOpen = (dm & 0o077) !== 0;
  if (dirOpen) {
    problems.push(`data dir is ${octal(dm)} (expected 0700: chmod 700 ${dataDir})`);
    status = 'warn';
  }
  const files: Record<string, string> = {};
  for (const name of [DB_FILE_NAME, `${DB_FILE_NAME}-wal`]) {
    const m = mode(join(dataDir, name));
    if (m === null) continue;
    files[name] = octal(m);
    // Inside a private (0700) directory a looser file mode is unreachable; only flag it when the directory is open too.
    if ((m & 0o077) !== 0 && dirOpen) problems.push(`${name} is ${octal(m)} in a directory others can enter (expected 0600)`);
  }
  return {
    id: 'permissions',
    status,
    detail: problems.length > 0 ? problems.join('; ') : `data dir ${octal(dm)}`,
    data: { dir: octal(dm), files },
  };
}

/** The HTTP secrets: group/other access is a failure; a malformed actors file is a failure (serve --http would refuse to start). */
function checkHttpTokens(dataDir: string, actorsFile: string, platform: NodeJS.Platform): DoctorCheck {
  const bearer = join(dataDir, BEARER_FILE_NAME);
  const present = [bearer, actorsFile].filter((f) => existsSync(f));
  if (present.length === 0) return { id: 'http-tokens', status: 'skip', detail: 'no HTTP bearer or actors file (serve --http not used yet)' };
  const problems: string[] = [];
  const data: Record<string, unknown> = {};
  if (platform !== 'win32') {
    for (const f of present) {
      const m = mode(f);
      if (m === null) continue;
      data[f] = octal(m);
      if ((m & 0o077) !== 0) problems.push(`${f} is ${octal(m)}, readable by others (expected 0600: chmod 600 ${f})`);
    }
  }
  let actors = 0;
  if (existsSync(bearer)) {
    const t = readFileSync(bearer, 'utf8').trim();
    if (t.length < MIN_TOKEN_CHARS) problems.push(`${bearer} holds ${t.length === 0 ? 'nothing' : 'a token shorter than 16 characters'}; serve --http will refuse it`);
  }
  if (existsSync(actorsFile)) {
    try {
      const parsed = parseActorsFile(readFileSync(actorsFile, 'utf8'), actorsFile);
      actors = parsed.length;
      data['actors'] = parsed.map((a) => ({ actor: a.actor, role: a.role }));
      const plaintext = /"token"\s*:/.test(readFileSync(actorsFile, 'utf8'));
      if (plaintext) problems.push(`${actorsFile} stores plaintext tokens; prefer token_sha256 (sea-lite add-token writes hashes)`);
    } catch (e) {
      problems.push(errMsg(e));
    }
  }
  const fail = problems.some((p) => !p.includes('prefer token_sha256'));
  return {
    id: 'http-tokens',
    status: fail ? 'fail' : problems.length > 0 ? 'warn' : 'ok',
    detail: problems.length > 0 ? problems.join('; ') : `${present.length} file(s) 0600${existsSync(actorsFile) ? `; ${actors} actor token(s)` : ''}`,
    data,
  };
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`).get(name) !== undefined;
}

function metaValue(db: Database.Database, key: string): string | null {
  if (!tableExists(db, 'meta')) return null;
  const r = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

function checkSchema(db: Database.Database): DoctorCheck {
  const kl = metaValue(db, 'schema_version');
  const sea = metaValue(db, SEA_SCHEMA_META_KEY);
  const data = { kronicle_schema_version: kl, sea_schema_version: sea, supported: SEA_SCHEMA_VERSION };
  if (!tableExists(db, 'events')) return { id: 'schema', status: 'fail', detail: 'no events table: not a kronicle-lite store', data };
  if (sea === null || !tableExists(db, 'sea_tickets')) {
    return { id: 'schema', status: 'warn', detail: 'sea tables not created yet (any sea-lite command that opens the store adds them)', data };
  }
  const v = Number(sea);
  if (v > SEA_SCHEMA_VERSION) return { id: 'schema', status: 'fail', detail: `sea_schema_version ${v} is newer than this build (${SEA_SCHEMA_VERSION}); upgrade sea-lite`, data };
  if (v < SEA_SCHEMA_VERSION) {
    return { id: 'schema', status: 'warn', detail: `sea_schema_version ${v}; the next open migrates it to ${SEA_SCHEMA_VERSION} (additive)`, data };
  }
  return { id: 'schema', status: 'ok', detail: `sea_schema_version ${v}; kronicle schema_version ${kl ?? '?'}`, data };
}

function checkChain(db: Database.Database): DoctorCheck {
  try {
    const chain = new Chain(db as unknown as ConstructorParameters<typeof Chain>[0], noSigner);
    const hasSea = tableExists(db, 'sea_tickets') && tableExists(db, 'sea_links') && tableExists(db, 'sea_notes');
    if (!hasSea) {
      const r = chain.verify();
      return r.ok
        ? { id: 'chain', status: 'ok', detail: `${r.events_checked} event(s) verify; head seq ${r.head.seq}` }
        : { id: 'chain', status: 'fail', detail: `${r.first_mismatch?.kind} at seq ${r.first_mismatch?.seq}; run sea-lite verify` };
    }
    const v = verifySea(db as unknown as ConstructorParameters<typeof Chain>[0], chain);
    if (!v.chain.ok) {
      const m = v.chain.first_mismatch;
      return { id: 'chain', status: 'fail', detail: `${m?.kind} at seq ${m?.seq}; run sea-lite verify`, data: { head: v.chain.head, first_mismatch: m } };
    }
    if (v.rows_missing_chain_seq.length > 0) {
      return {
        id: 'chain',
        status: 'fail',
        detail: `${v.rows_missing_chain_seq.length} sea row(s) point at chain events that do not exist; run sea-lite rebuild`,
        data: { rows_missing_chain_seq: v.rows_missing_chain_seq.slice(0, 20) },
      };
    }
    return { id: 'chain', status: 'ok', detail: `${v.chain.events_checked} event(s) verify; every sea row's chain_seq exists; head seq ${v.chain.head.seq}`, data: { head: v.chain.head } };
  } catch (e) {
    return { id: 'chain', status: 'fail', detail: `chain verification failed: ${errMsg(e)}` };
  }
}

function checkClaims(db: Database.Database, now: Date): DoctorCheck {
  if (!tableExists(db, 'sea_tickets')) return { id: 'claims', status: 'skip', detail: 'no sea tables' };
  const nowIso = now.toISOString();
  const cols = (db.prepare(`PRAGMA table_info(sea_tickets)`).all() as { name: string }[]).map((c) => c.name);
  const hasWorktree = cols.includes('claim_worktree');
  const rows = db
    .prepare(
      `SELECT id, claim_actor, claim_expires_at${hasWorktree ? ', claim_worktree' : ', NULL AS claim_worktree'} FROM sea_tickets
        WHERE claim_token_hash IS NOT NULL AND claim_expires_at IS NOT NULL`,
    )
    .all() as { id: string; claim_actor: string; claim_expires_at: string; claim_worktree: string | null }[];
  const live = rows.filter((r) => r.claim_expires_at > nowIso);
  const lapsed = rows.filter((r) => r.claim_expires_at <= nowIso);
  const stale = lapsed.filter((r) => now.getTime() - Date.parse(r.claim_expires_at) > STALE_EXPIRY_MS);
  const orphaned = live.filter((r) => r.claim_worktree !== null && !existsSync(r.claim_worktree));
  const problems: string[] = [];
  if (stale.length > 0) problems.push(`${stale.length} lease(s) lapsed over an hour ago and were never swept (nothing has read the queue; sea-lite list sweeps)`);
  if (orphaned.length > 0) {
    problems.push(`${orphaned.length} live claim(s) bound to a worktree that no longer exists (sea-lite release-worktree <path>): ${[...new Set(orphaned.map((o) => o.claim_worktree))].join(', ')}`);
  }
  return {
    id: 'claims',
    status: problems.length > 0 ? 'warn' : 'ok',
    detail:
      problems.length > 0
        ? problems.join('; ')
        : `${live.length} live claim(s); ${lapsed.length} lapsed lease(s) awaiting the next read (lazy expiry)`,
    data: {
      live: live.length,
      lapsed_unswept: lapsed.length,
      stale: stale.map((r) => ({ ticket_id: r.id, holder: r.claim_actor, expired_at: r.claim_expires_at })),
      orphaned_worktree: orphaned.map((r) => ({ ticket_id: r.id, holder: r.claim_actor, worktree: r.claim_worktree })),
    },
  };
}

async function checkCatalog(cwd: string): Promise<DoctorCheck> {
  try {
    const live = await liveCatalogFingerprint();
    const fails: string[] = [];
    const warns: string[] = [];
    if (live.fingerprint !== CATALOG_FINGERPRINT) {
      fails.push(`live catalog ${live.fingerprint.slice(0, 12)}… ≠ pinned ${CATALOG_FINGERPRINT.slice(0, 12)}… (a mismatched or patched build)`);
    }
    if (CATALOG_VERSION !== VERSION) warns.push(`catalog pinned for ${CATALOG_VERSION}, package is ${VERSION}`);
    let snapshot: Record<string, unknown> | null = null;
    const snapFile = join(cwd, '.mcp-catalog', 'sea-lite.json');
    if (existsSync(snapFile)) {
      try {
        const s = JSON.parse(readFileSync(snapFile, 'utf8')) as { sha256?: string; server?: { version?: string } };
        snapshot = { file: snapFile, sha256: s.sha256 ?? null, version: s.server?.version ?? null };
        if (s.sha256 !== live.fingerprint) warns.push(`${snapFile} ${String(s.sha256).slice(0, 12)}… ≠ live (run npm run catalog:snapshot)`);
      } catch (e) {
        warns.push(`${snapFile}: ${errMsg(e)}`);
      }
    }
    const problems = [...fails, ...warns];
    return {
      id: 'catalog',
      status: fails.length > 0 ? 'fail' : warns.length > 0 ? 'warn' : 'ok',
      detail: problems.length > 0 ? problems.join('; ') : `${live.tools} tools, fingerprint ${live.fingerprint.slice(0, 12)}… matches ${VERSION}`,
      data: { live: live.fingerprint, pinned: CATALOG_FINGERPRINT, pinned_version: CATALOG_VERSION, version: VERSION, snapshot },
    };
  } catch (e) {
    return { id: 'catalog', status: 'fail', detail: `could not build the MCP catalog: ${errMsg(e)}` };
  }
}

/** C2-06: the lease clock check needs a writable probe and a clock that agrees with the file system's. */
function checkClock(dataDir: string, now: Date): DoctorCheck {
  if (!existsSync(dataDir)) return { id: 'clock', status: 'skip', detail: 'no data dir' };
  let why: string | null = null;
  const ref = fsReference(dataDir, (m) => (why = m))();
  if (ref === null) return { id: 'clock', status: 'warn', detail: why ?? 'clock probe failed; lease decisions trust each process clock' };
  let max: number;
  try {
    max = parseMaxSkew(process.env['SEA_LITE_MAX_CLOCK_SKEW_SECONDS']);
  } catch (e) {
    return { id: 'clock', status: 'fail', detail: errMsg(e) };
  }
  const skew = Math.round((now.getTime() - ref) / 1000);
  if (max === 0) return { id: 'clock', status: 'warn', detail: `clock check disabled (SEA_LITE_MAX_CLOCK_SKEW_SECONDS=0); skew ${skew}s`, data: { skew_seconds: skew } };
  return Math.abs(skew) > max
    ? { id: 'clock', status: 'fail', detail: `this clock is ${skew}s off the data dir's file-system clock (tolerance ${max}s): claims and leases will be refused`, data: { skew_seconds: skew } }
    : { id: 'clock', status: 'ok', detail: `skew ${skew}s vs the file-system clock (tolerance ${max}s)`, data: { skew_seconds: skew } };
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const platform = opts.platform ?? process.platform;
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const now = opts.now ?? new Date();
  const dataDir = opts.dataDir;
  const actorsFile = opts.actorsFile ?? join(dataDir, ACTORS_FILE_NAME);
  const checks: DoctorCheck[] = [checkNode(nodeVersion)];

  const dbPath = join(dataDir, DB_FILE_NAME);
  if (!existsSync(dataDir)) {
    checks.push({ id: 'data-dir', status: 'fail', detail: `${dataDir} does not exist (any sea-lite or kronicle-lite command creates it; doctor does not)` });
  } else if (!existsSync(dbPath)) {
    checks.push({ id: 'data-dir', status: 'fail', detail: `${dataDir} has no ${DB_FILE_NAME}` });
  } else {
    checks.push({ id: 'data-dir', status: 'ok', detail: dataDir });
  }
  checks.push(checkPermissions(dataDir, platform));
  checks.push(checkClock(dataDir, new Date())); // why: the real clock, not opts.now (a test clock is skewed by design)
  checks.push(checkHttpTokens(dataDir, actorsFile, platform));

  let db: Database.Database | null = null;
  if (existsSync(dbPath)) {
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma('busy_timeout = 5000');
      const q = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
      const msgs = q.map((r) => r.quick_check);
      checks.push(
        msgs.length === 1 && msgs[0] === 'ok'
          ? { id: 'db', status: 'ok', detail: `${dbPath} opens read-only; PRAGMA quick_check ok` }
          : { id: 'db', status: 'fail', detail: `PRAGMA quick_check: ${msgs.slice(0, 5).join('; ')}` },
      );
    } catch (e) {
      checks.push({ id: 'db', status: 'fail', detail: `cannot open ${dbPath}: ${errMsg(e)}` });
      db?.close();
      db = null;
    }
  } else {
    checks.push({ id: 'db', status: 'skip', detail: 'no database' });
  }
  if (db) {
    try {
      checks.push(checkSchema(db));
      checks.push(checkChain(db));
      checks.push(checkClaims(db, now));
    } finally {
      db.close();
    }
  }
  checks.push(await checkCatalog(opts.cwd ?? process.cwd()));

  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;
  return { version: VERSION, node: nodeVersion, platform, data_dir: dataDir, ok: summary.fail === 0, summary, checks };
}

export function renderDoctor(r: DoctorReport): string {
  const mark: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL', skip: 'skip' };
  const lines = [`sea-lite ${r.version} doctor — Node ${r.node} on ${r.platform}; data dir ${r.data_dir}`];
  for (const c of r.checks) lines.push(`  ${mark[c.status]}  ${c.id.padEnd(12)} ${c.detail}`);
  lines.push(`${r.ok ? 'healthy' : 'problems found'}: ${r.summary.ok} ok, ${r.summary.warn} warn, ${r.summary.fail} fail, ${r.summary.skip} skipped`);
  return lines.join('\n') + '\n';
}
