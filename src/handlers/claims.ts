/**
 * Claims: acquire (one or a set, all-or-nothing), refresh (row only, not
 * chained), release (holder, or operator force), next (pick + claim), and
 * the scope check. A claim may carry a scope — the paths the holder will
 * touch — and no two actors may hold overlapping live scopes (core/scope.ts).
 */

import type { ChainHead } from 'kronicle-lite';

import { SeaError } from '../core/errors.js';
import { EVENT } from '../core/events.js';
import { clampLease, expiryFrom, hasLiveClaim, MAX_LEASE_SECONDS, validateFence } from '../core/fence.js';
import { addNote, mustGetRow, resolveId, sweepAllExpired, sweepExpired, tx, type Ctx } from '../core/repo.js';
import { findOverlaps, normalizeScope, parseScopeJson, type OverlapPair, type Scope } from '../core/scope.js';
import { rowToTicket, type NoteRow, type Ticket, type TicketRow } from '../core/types.js';
import { NEXT_ELIGIBLE_STATES, PRIORITY_RANK, sqlIn, TERMINAL_STATES } from '../model/enums.js';
import type { ClaimInput, NextInput, RefreshInput, ReleaseInput, ScopeCheckInput } from '../model/schemas.js';
import { placeClaim } from './tickets.js';

export interface ClaimResult {
  claims: { ticket_id: string; claim_token: string; expires_at: string; rotated: boolean }[];
  lease_seconds: number;
  /** The normalized scope every claim in the set carries, or null. */
  scope: Scope | null;
  head: ChainHead;
}

/** One live claim by another actor whose scope overlaps the request. */
export interface ScopeConflict {
  ticket_id: string;
  holder: string;
  claim_expires_at: string;
  /** The holder's scope entries that overlap. */
  held: string[];
  overlapping: OverlapPair[];
}

/**
 * Every live, scoped claim held by someone other than `ctx.actor` (and not
 * on `excludeIds`) that overlaps `paths`. Callers sweep expired leases first
 * so a lapsed scope never blocks anyone.
 */
export function findScopeConflicts(ctx: Ctx, paths: readonly string[], excludeIds: ReadonlySet<string> = new Set()): ScopeConflict[] {
  const rows = ctx.db
    .prepare(
      `SELECT id, claim_actor, claim_expires_at, claim_scope FROM sea_tickets
        WHERE claim_scope IS NOT NULL AND claim_token_hash IS NOT NULL AND claim_expires_at > ? AND claim_actor <> ?
        ORDER BY claim_expires_at, id`,
    )
    .all(ctx.now.toISOString(), ctx.actor) as { id: string; claim_actor: string; claim_expires_at: string; claim_scope: string }[];
  const conflicts: ScopeConflict[] = [];
  for (const r of rows) {
    if (excludeIds.has(r.id)) continue;
    const held = parseScopeJson(r.claim_scope);
    if (!held) continue;
    const overlapping = findOverlaps(paths, held.paths);
    if (overlapping.length === 0) continue;
    conflicts.push({
      ticket_id: r.id,
      holder: r.claim_actor,
      claim_expires_at: r.claim_expires_at,
      held: [...new Set(overlapping.map((o) => o.held))],
      overlapping,
    });
  }
  return conflicts;
}

/** Throw scope_conflict naming every holder, ticket, overlapping path and expiry. */
export function assertScopeFree(ctx: Ctx, scope: Scope, excludeIds: ReadonlySet<string> = new Set()): void {
  const conflicts = findScopeConflicts(ctx, scope.paths, excludeIds);
  if (conflicts.length === 0) return;
  const first = conflicts[0]!;
  const more = conflicts.length > 1 ? ` (+${conflicts.length - 1} more)` : '';
  throw new SeaError(
    'scope_conflict',
    `scope overlaps a live claim: "${first.holder}" holds ${first.held.join(', ')} on ticket ${first.ticket_id} until ${first.claim_expires_at}${more}`,
    { requested: scope.paths, conflicts },
  );
}

export function claim(ctx: Ctx, input: ClaimInput): ClaimResult {
  const lease = clampLease(input.lease_seconds);
  const scope: Scope | null = input.scope ? { paths: normalizeScope(input.scope.paths) } : null;
  return tx(ctx.db, () => {
    // Resolve, de-duplicate, and lock in one order so two processes claiming
    // overlapping sets cannot deadlock on each other's partial progress.
    const ids = [...new Set(input.ticket_ids.map((x) => resolveId(ctx.db, x)))].sort();
    const rows: TicketRow[] = [];
    for (const id of ids) {
      const row = sweepExpired(ctx, mustGetRow(ctx.db, id));
      if (hasLiveClaim(row, ctx.now) && row.claim_actor !== ctx.actor) {
        throw new SeaError('already_claimed', `ticket ${id} is claimed by "${row.claim_actor}" until ${row.claim_expires_at}`, {
          ticket_id: id,
          held_by: row.claim_actor,
          claim_expires_at: row.claim_expires_at,
          requested: ids,
        });
      }
      rows.push(row);
    }
    if (scope) {
      sweepAllExpired(ctx);
      assertScopeFree(ctx, scope, new Set(ids));
    }
    const claims: ClaimResult['claims'] = [];
    for (const row of rows) {
      const rotated = row.claim_token_hash !== null && row.claim_actor === ctx.actor;
      const c = placeClaim(ctx, row, lease, ids.length > 1 ? { set: ids } : {}, scope);
      claims.push({ ticket_id: row.id, claim_token: c.token, expires_at: c.expires_at, rotated });
    }
    return { claims, lease_seconds: lease, scope, head: ctx.chain.head() };
  });
}

export interface ScopeCheckResult {
  ok: boolean;
  /** The request, normalized. */
  paths: string[];
  conflicts: ScopeConflict[];
  swept_expired: number;
  head: ChainHead;
}

/**
 * The hot path for an edit hook: would these paths collide with someone
 * else's live scope? No claim is taken or needed; the caller's own scopes
 * are never conflicts. One short transaction (expired leases are swept so
 * the answer is honest).
 */
export function scopeCheck(ctx: Ctx, input: ScopeCheckInput): ScopeCheckResult {
  const paths = normalizeScope(input.paths);
  return tx(ctx.db, () => {
    const swept = sweepAllExpired(ctx);
    const conflicts = findScopeConflicts(ctx, paths);
    return { ok: conflicts.length === 0, paths, conflicts, swept_expired: swept, head: ctx.chain.head() };
  });
}

export interface RefreshResult {
  ticket_id: string;
  expires_at: string;
  extended: boolean;
  head: ChainHead;
}

/** Heartbeat. Never shortens; capped at now + MAX_LEASE_SECONDS. Row only — not chained. */
export function refresh(ctx: Ctx, input: RefreshInput): RefreshResult {
  if (input.extend_by_seconds > MAX_LEASE_SECONDS) {
    throw new SeaError('invalid_input', `extend_by_seconds must be ≤ ${MAX_LEASE_SECONDS}`);
  }
  return tx(ctx.db, () => {
    const id = resolveId(ctx.db, input.ticket_id);
    const row = mustGetRow(ctx.db, id);
    validateFence(row, input.claim_token, ctx.actor, ctx.now);
    const proposed = Date.parse(expiryFrom(ctx.now, input.extend_by_seconds));
    const current = Date.parse(row.claim_expires_at!);
    if (proposed <= current) return { ticket_id: id, expires_at: row.claim_expires_at!, extended: false, head: ctx.chain.head() };
    const expires_at = new Date(proposed).toISOString();
    ctx.db.prepare(`UPDATE sea_tickets SET claim_expires_at = ? WHERE id = ?`).run(expires_at, id);
    return { ticket_id: id, expires_at, extended: true, head: ctx.chain.head() };
  });
}

export interface ReleaseResult {
  ticket: Ticket;
  forced: boolean;
  previous_holder: string | null;
  note: NoteRow | null;
  head: ChainHead;
}

export function release(ctx: Ctx, input: ReleaseInput): ReleaseResult {
  return tx(ctx.db, () => {
    const id = resolveId(ctx.db, input.ticket_id);
    const row = sweepExpired(ctx, mustGetRow(ctx.db, id));
    if (input.force) {
      if (ctx.role !== 'operator') {
        throw new SeaError('forbidden', 'force release requires the server to run with --role operator', { role: ctx.role });
      }
      if (row.claim_token_hash === null) {
        throw new SeaError('invalid_input', `ticket ${id} is not claimed`, { ticket_id: id });
      }
      const r = ctx.chain.append({
        event_type: EVENT.ticket_claim_force_released,
        actor_id: ctx.actor,
    occurred_at: ctx.now.toISOString(),
        payload: {
          ticket_id: id,
          claim_token_hash: row.claim_token_hash,
          previous_holder: row.claim_actor,
          scope: parseScopeJson(row.claim_scope),
          released_by: ctx.actor,
          reason: input.reason ?? null,
          write_count: row.claim_write_count,
        },
      });
      clearClaim(ctx, id, r.event.seq);
      const note = input.note !== undefined ? addNote(ctx, id, input.note) : null;
      return { ticket: rowToTicket(mustGetRow(ctx.db, id)), forced: true, previous_holder: row.claim_actor, note, head: ctx.chain.head() };
    }
    if (input.claim_token === undefined) {
      throw new SeaError('invalid_input', 'claim_token is required unless force is set', { ticket_id: id });
    }
    validateFence(row, input.claim_token, ctx.actor, ctx.now);
    const r = ctx.chain.append({
      event_type: EVENT.ticket_claim_released,
      actor_id: ctx.actor,
    occurred_at: ctx.now.toISOString(),
      payload: {
        ticket_id: id,
        claim_token_hash: row.claim_token_hash,
        claim_actor: row.claim_actor,
        scope: parseScopeJson(row.claim_scope),
        reason: input.reason ?? null,
        write_count: row.claim_write_count,
      },
    });
    clearClaim(ctx, id, r.event.seq);
    const note = input.note !== undefined ? addNote(ctx, id, input.note) : null;
    return { ticket: rowToTicket(mustGetRow(ctx.db, id)), forced: false, previous_holder: row.claim_actor, note, head: ctx.chain.head() };
  });
}

function clearClaim(ctx: Ctx, id: string, seq: number): void {
  ctx.db
    .prepare(
      `UPDATE sea_tickets SET claim_token_hash = NULL, claim_actor = NULL, claim_expires_at = NULL, claim_write_count = 0,
         claim_scope = NULL, last_seq = ? WHERE id = ?`,
    )
    .run(seq, id);
}

export interface NextResult {
  ticket: Ticket | null;
  claim_token: string | null;
  expires_at: string | null;
  /** Why nothing came back, when ticket is null. */
  reason: 'nothing_eligible' | null;
  considered: number;
  head: ChainHead;
}

/**
 * The queue's dispatch: the highest-priority unclaimed triaged/in_progress
 * ticket assigned to me (or unassigned) whose predecessors are all terminal,
 * claimed in the same transaction. Predecessors: tickets that `block` this
 * one, and tickets this one `depends_on`.
 */
export function next(ctx: Ctx, input: NextInput): NextResult {
  const lease = clampLease(input.lease_seconds);
  const scope: Scope | null = input.scope ? { paths: normalizeScope(input.scope.paths) } : null;
  return tx(ctx.db, () => {
    sweepAllExpired(ctx);
    // The scope is what the caller will touch regardless of which ticket comes
    // back, so a conflict refuses the dispatch rather than skipping tickets.
    if (scope) assertScopeFree(ctx, scope);
    const where: string[] = [
      `t.status IN (${sqlIn(NEXT_ELIGIBLE_STATES)})`,
      `t.claim_token_hash IS NULL`,
      `t.priority <> 'parked'`,
      input.include_unassigned ? `(t.assignee = ? OR t.assignee IS NULL)` : `t.assignee = ?`,
      `NOT EXISTS (SELECT 1 FROM sea_links l JOIN sea_tickets p ON p.id = l.from_id
         WHERE l.state = 'active' AND l.link_type = 'blocks' AND l.to_id = t.id AND p.status NOT IN (${sqlIn(TERMINAL_STATES)}))`,
      `NOT EXISTS (SELECT 1 FROM sea_links l JOIN sea_tickets p ON p.id = l.to_id
         WHERE l.state = 'active' AND l.link_type = 'depends_on' AND l.from_id = t.id AND p.status NOT IN (${sqlIn(TERMINAL_STATES)}))`,
    ];
    const params: unknown[] = [ctx.actor];
    if (input.kind && input.kind.length > 0) {
      where.push(`t.kind IN (${input.kind.map(() => '?').join(', ')})`);
      params.push(...input.kind);
    }
    if (input.tag !== undefined) {
      where.push(`EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ?)`);
      params.push(input.tag);
    }
    const order = `CASE t.priority ${Object.entries(PRIORITY_RANK)
      .map(([p, r]) => `WHEN '${p}' THEN ${r}`)
      .join(' ')} END, CASE t.status WHEN 'in_progress' THEN 0 ELSE 1 END, t.created_seq ASC`;
    const considered = (
      ctx.db.prepare(`SELECT COUNT(*) AS n FROM sea_tickets t WHERE ${where.join(' AND ')}`).get(...params) as { n: number }
    ).n;
    const row = ctx.db.prepare(`SELECT t.* FROM sea_tickets t WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 1`).get(...params) as
      | TicketRow
      | undefined;
    if (!row) return { ticket: null, claim_token: null, expires_at: null, reason: 'nothing_eligible', considered, head: ctx.chain.head() };
    const c = placeClaim(ctx, row, lease, { via: 'sea_next' }, scope);
    return {
      ticket: rowToTicket(mustGetRow(ctx.db, row.id)),
      claim_token: c.token,
      expires_at: c.expires_at,
      reason: null,
      considered,
      head: ctx.chain.head(),
    };
  });
}
