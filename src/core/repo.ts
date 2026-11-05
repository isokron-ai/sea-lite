/**
 * Row-level primitives shared by the handlers. Everything here assumes it is
 * called inside the caller's transaction and never awaits.
 */

import { randomUUID } from 'node:crypto';

import type { Chain, Db } from 'kronicle-lite';

import type { LifecycleConfig } from '../model/lifecycle.js';
import type { Role } from '../model/enums.js';
import type { ClockGuard } from './clock.js';
import { EVENT } from './events.js';
import { SeaError, notFound } from './errors.js';
import { isExpired } from './fence.js';
import { sameOwner } from './identity.js';
import { parseScopeJson } from './scope.js';
import type { LinkRow, NoteRow, TicketRow } from './types.js';
import { notifyChange } from './wait.js';

export interface Ctx {
  readonly db: Db;
  readonly chain: Chain;
  /** Actor for this call (per-call override already applied). */
  readonly actor: string;
  /**
   * The caller's session (core/identity.ts), or null when unknown (library
   * use, HTTP, a human at a terminal). A claim is the caller's own only when
   * actor and session both match.
   */
  readonly session: string | null;
  /**
   * A hook speaks for a whole agent session (main agent and subagents alike):
   * when set, every claim held under `session` counts as the caller's own,
   * whatever its actor label. Only the CLI's scope-check / precommit set it.
   */
  readonly sessionWide?: boolean;
  /** Project key (core/project.ts), or null for every project (pre-0.4 behaviour). */
  readonly project: string | null;
  /** Repository root: scope paths are resolved through symlinks against it (core/scope.ts). Null: lexical only. */
  readonly root?: string | null;
  readonly role: Role;
  readonly lifecycle: LifecycleConfig;
  readonly now: Date;
  /** C2-06: lease decisions are refused while this process's clock is skewed (core/clock.ts). */
  readonly clock?: ClockGuard;
  /** Byte budget of one sea_list / sea_history page (P2-03); default DEFAULT_MAX_RESPONSE_BYTES. */
  readonly maxResponseBytes?: number;
}

/** 256 KiB: see store.ts DEFAULT_MAX_RESPONSE_BYTES (kept here so handlers need not import the store). */
export const RESPONSE_BUDGET_DEFAULT = 256 * 1024;

/** UTF-8 size of a value's JSON: what it adds to a response (each item is bounded by the input schemas). */
export function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

/** Is the claim on this row held by the caller? (See Ctx.session / Ctx.sessionWide.) */
export function ownsClaim(ctx: Pick<Ctx, 'actor' | 'session' | 'sessionWide'>, holderActor: string | null, holderSession: string | null): boolean {
  if (ctx.sessionWide === true && ctx.session !== null) return holderSession === ctx.session;
  return sameOwner(holderActor, holderSession, { actor: ctx.actor, session: ctx.session });
}

/**
 * SQL filter for "tickets of the current project": its own plus legacy
 * tickets that carry no project. `project` overrides ctx.project; `*` (or a
 * null ctx.project) means every project.
 */
export function projectFilter(ctx: Pick<Ctx, 'project'>, alias = 't', override?: string): { sql: string | null; params: unknown[] } {
  const p = override !== undefined ? (override === '*' ? null : override) : ctx.project;
  if (p === null) return { sql: null, params: [] };
  return { sql: `(${alias}.project = ? OR ${alias}.project IS NULL)`, params: [p] };
}

export function uuid(): string {
  return randomUUID();
}

/** Resolve a full id or a unique prefix (≥ 8 chars) to a row id. */
export function resolveId(db: Db, idOrPrefix: string): string {
  const exact = db.prepare(`SELECT id FROM sea_tickets WHERE id = ?`).get(idOrPrefix) as { id: string } | undefined;
  if (exact) return exact.id;
  if (idOrPrefix.length < 8) throw new SeaError('invalid_input', `id prefix must be at least 8 characters: "${idOrPrefix}"`);
  const rows = db
    .prepare(`SELECT id FROM sea_tickets WHERE id >= ? AND id < ? ORDER BY id LIMIT 3`)
    .all(idOrPrefix, idOrPrefix + '￿') as { id: string }[];
  if (rows.length === 0) throw notFound(idOrPrefix);
  if (rows.length > 1) {
    throw new SeaError('ambiguous_id', `prefix "${idOrPrefix}" matches more than one ticket`, {
      prefix: idOrPrefix,
      matches: rows.map((r) => r.id),
    });
  }
  return rows[0]!.id;
}

export function getRow(db: Db, id: string): TicketRow | null {
  return (db.prepare(`SELECT * FROM sea_tickets WHERE id = ?`).get(id) as TicketRow | undefined) ?? null;
}

export function mustGetRow(db: Db, id: string): TicketRow {
  const row = getRow(db, id);
  if (!row) throw notFound(id);
  return row;
}

/**
 * Lazy expiry: if the row carries a lapsed lease, clear it and chain
 * `sea_ticket.claim_expired` once. Returns the (possibly refreshed) row.
 */
export function sweepExpired(ctx: Ctx, row: TicketRow): TicketRow {
  if (row.claim_token_hash === null || !isExpired(row.claim_expires_at, ctx.now)) return row;
  // why: a skewed clock must not decide that someone else's lease lapsed (C2-06).
  if (ctx.clock?.untrusted()) return row;
  const r = ctx.chain.append({
    event_type: EVENT.ticket_claim_expired,
    actor_id: ctx.actor,
    occurred_at: ctx.now.toISOString(),
    payload: {
      ticket_id: row.id,
      claim_token_hash: row.claim_token_hash,
      claim_actor: row.claim_actor,
      scope: parseScopeJson(row.claim_scope),
      expired_at: row.claim_expires_at,
      noticed_at: ctx.now.toISOString(),
      noticed_by: ctx.actor,
    },
  });
  ctx.db
    .prepare(
      `UPDATE sea_tickets SET claim_token_hash = NULL, claim_actor = NULL, claim_expires_at = NULL,
         claim_write_count = 0, claim_scope = NULL, claim_worktree = NULL, claim_session = NULL, claim_lease_seconds = NULL, last_seq = ? WHERE id = ?`,
    )
    .run(r.event.seq, row.id);
  return mustGetRow(ctx.db, row.id);
}

/** Sweep every expired lease in the table (used by list/next so the queue view is honest). */
export function sweepAllExpired(ctx: Ctx): number {
  if (ctx.clock?.untrusted()) return 0;
  const rows = ctx.db
    .prepare(`SELECT * FROM sea_tickets WHERE claim_expires_at IS NOT NULL AND claim_expires_at <= ?`)
    .all(ctx.now.toISOString()) as TicketRow[];
  for (const row of rows) sweepExpired(ctx, row);
  return rows.length;
}

export function activeLinksFor(db: Db, id: string): LinkRow[] {
  return db
    .prepare(`SELECT * FROM sea_links WHERE state = 'active' AND (from_id = ? OR to_id = ?) ORDER BY chain_seq`)
    .all(id, id) as LinkRow[];
}

export function notesFor(db: Db, id: string, limit = 20): NoteRow[] {
  return db
    .prepare(`SELECT * FROM sea_notes WHERE ticket_id = ? ORDER BY chain_seq DESC LIMIT ?`)
    .all(id, limit)
    .reverse() as NoteRow[];
}

/** `extra` adds fields to the chained payload; `idempotency_key` (already namespaced) keys the event. */
export function addNote(ctx: Ctx, ticket_id: string, body: string, extra: Record<string, unknown> = {}, idempotency_key?: string): NoteRow {
  const note_id = uuid();
  const created_at = ctx.now.toISOString();
  const r = ctx.chain.append({
    event_type: EVENT.ticket_note_added,
    actor_id: ctx.actor,
    occurred_at: ctx.now.toISOString(),
    payload: { ticket_id, note_id, body, created_at, ...extra },
    ...(idempotency_key !== undefined ? { idempotency_key } : {}),
  });
  ctx.db
    .prepare(`INSERT INTO sea_notes (note_id, ticket_id, author, body, created_at, chain_seq) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(note_id, ticket_id, ctx.actor, body, created_at, r.event.seq);
  ctx.db.prepare(`UPDATE sea_tickets SET last_seq = ? WHERE id = ?`).run(r.event.seq, ticket_id);
  return { note_id, ticket_id, author: ctx.actor, body, created_at, chain_seq: r.event.seq };
}

export function checkVersion(row: TicketRow, expected: number | undefined): void {
  if (expected !== undefined && row.row_version !== expected) {
    throw new SeaError('version_conflict', `ticket ${row.id} is at row_version ${row.row_version}, expected ${expected}`, {
      ticket_id: row.id,
      expected_version: expected,
      current_version: row.row_version,
      current: {
        title: row.title,
        status: row.status,
        priority: row.priority,
        assignee: row.assignee,
        updated_at: row.updated_at,
        last_seq: row.last_seq,
      },
    });
  }
}

/** Run `fn` in one BEGIN IMMEDIATE transaction. Synchronous by construction. */
export function tx<T>(db: Db, fn: () => T): T {
  let out: T;
  try {
    out = db.transaction(fn).immediate();
  } catch (e) {
    // why: SQLITE_BUSY after busy_timeout is contention, not a bug; the
    // transaction rolled back, so report it as a typed, retryable conflict.
    if (isBusy(e)) throw new SeaError('wait_timeout', 'the store is busy (another process held the write lock past the busy timeout); nothing was written, retry', { sqlite: (e as { code: string }).code });
    throw e;
  }
  // Committed (or a nested savepoint released): wake in-process waiters (core/wait.ts).
  if (!db.inTransaction) notifyChange(db);
  return out;
}

/** SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT / SQLITE_LOCKED from better-sqlite3. */
export function isBusy(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'));
}
