/**
 * Claims: acquire (one or a set, all-or-nothing), refresh (row only, not
 * chained), release (holder, or operator force), and next (pick + claim).
 */

import type { ChainHead } from 'kronicle-lite';

import { SeaError } from '../core/errors.js';
import { EVENT } from '../core/events.js';
import { clampLease, expiryFrom, hasLiveClaim, MAX_LEASE_SECONDS, validateFence } from '../core/fence.js';
import { addNote, mustGetRow, resolveId, sweepAllExpired, sweepExpired, tx, type Ctx } from '../core/repo.js';
import { rowToTicket, type NoteRow, type Ticket, type TicketRow } from '../core/types.js';
import { NEXT_ELIGIBLE_STATES, PRIORITY_RANK, sqlIn, TERMINAL_STATES } from '../model/enums.js';
import type { ClaimInput, NextInput, RefreshInput, ReleaseInput } from '../model/schemas.js';
import { placeClaim } from './tickets.js';

export interface ClaimResult {
  claims: { ticket_id: string; claim_token: string; expires_at: string; rotated: boolean }[];
  lease_seconds: number;
  head: ChainHead;
}

export function claim(ctx: Ctx, input: ClaimInput): ClaimResult {
  const lease = clampLease(input.lease_seconds);
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
    const claims: ClaimResult['claims'] = [];
    for (const row of rows) {
      const rotated = row.claim_token_hash !== null && row.claim_actor === ctx.actor;
      const c = placeClaim(ctx, row, lease, ids.length > 1 ? { set: ids } : {});
      claims.push({ ticket_id: row.id, claim_token: c.token, expires_at: c.expires_at, rotated });
    }
    return { claims, lease_seconds: lease, head: ctx.chain.head() };
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
         last_seq = ? WHERE id = ?`,
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
  return tx(ctx.db, () => {
    sweepAllExpired(ctx);
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
    const c = placeClaim(ctx, row, lease, { via: 'sea_next' });
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
