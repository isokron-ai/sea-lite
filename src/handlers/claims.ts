/**
 * Claims: acquire (one or a set, all-or-nothing), refresh (row only, not
 * chained), release (holder, or operator force), next (pick + claim), and
 * the scope check. A claim may carry a scope — the paths the holder will
 * touch — and no two actors may hold overlapping live scopes (core/scope.ts).
 */

import type { ChainHead } from 'kronicle-lite';

import { SeaError } from '../core/errors.js';
import { EVENT } from '../core/events.js';
import { clampLease, DEFAULT_LEASE_SECONDS, expiryFrom, hasLiveClaim, MAX_LEASE_SECONDS, validateFence } from '../core/fence.js';
import { holderLabel } from '../core/identity.js';
import { addNote, mustGetRow, ownsClaim, projectFilter, resolveId, sweepAllExpired, sweepExpired, tx, type Ctx } from '../core/repo.js';
import {
  findOverlaps,
  normalizeScope,
  normalizeWorktreePath,
  parseScopeJson,
  resolveClaimScope,
  sameWorktree,
  type OverlapPair,
  type Scope,
} from '../core/scope.js';
import { rowToTicket, type NoteRow, type Ticket, type TicketRow } from '../core/types.js';
import { NEXT_ELIGIBLE_STATES, PRIORITY_RANK, sqlIn, TERMINAL_STATES } from '../model/enums.js';
import type { ClaimInput, NextInput, RefreshInput, ReleaseInput, ScopeCheckInput } from '../model/schemas.js';
import { placeClaim } from './tickets.js';

export interface ClaimResult {
  claims: { ticket_id: string; claim_token: string; expires_at: string; rotated: boolean }[];
  lease_seconds: number;
  /** The normalized scope every claim in the set carries, or null. */
  scope: Scope | null;
  /** The worktree every claim in the set is bound to, or null. */
  worktree: string | null;
  head: ChainHead;
}

/** One live claim by someone else (another actor, or the same actor in another session) whose scope overlaps the request. */
export interface ScopeConflict {
  ticket_id: string;
  /** The ticket's title, so a hook's deny message says what the holder is working on. */
  title: string;
  /** The holder's actor label. */
  holder: string;
  /** The holder's session (0.4.0), or null for a legacy claim. */
  holder_session: string | null;
  /** `actor#session8` (or the bare actor): what to show a human. */
  holder_label: string;
  claim_expires_at: string;
  /** Seconds until the lease lapses (as of the check). */
  expires_in_seconds: number;
  /** The holder's scope entries that overlap. */
  held: string[];
  overlapping: OverlapPair[];
}

/**
 * Every live, scoped claim in the current project held by someone other than
 * the caller (another actor, or the same actor in another session; see
 * ownsClaim) and not on `excludeIds`, that overlaps `paths`. Callers sweep
 * expired leases first so a lapsed scope never blocks anyone.
 */
export function findScopeConflicts(ctx: Ctx, paths: readonly string[], excludeIds: ReadonlySet<string> = new Set()): ScopeConflict[] {
  const pf = projectFilter(ctx);
  const rows = ctx.db
    .prepare(
      `SELECT t.id, t.title, t.claim_actor, t.claim_session, t.claim_expires_at, t.claim_scope FROM sea_tickets t
        WHERE t.claim_scope IS NOT NULL AND t.claim_token_hash IS NOT NULL AND t.claim_expires_at > ?${pf.sql ? ` AND ${pf.sql}` : ''}
        ORDER BY t.claim_expires_at, t.id`,
    )
    .all(ctx.now.toISOString(), ...pf.params) as {
    id: string;
    title: string;
    claim_actor: string;
    claim_session: string | null;
    claim_expires_at: string;
    claim_scope: string;
  }[];
  const conflicts: ScopeConflict[] = [];
  for (const r of rows) {
    if (excludeIds.has(r.id)) continue;
    if (ownsClaim(ctx, r.claim_actor, r.claim_session)) continue;
    const held = parseScopeJson(r.claim_scope);
    if (!held) continue;
    const overlapping = findOverlaps(paths, held.paths);
    if (overlapping.length === 0) continue;
    conflicts.push({
      ticket_id: r.id,
      title: r.title,
      holder: r.claim_actor,
      holder_session: r.claim_session ?? null,
      holder_label: holderLabel(r.claim_actor, r.claim_session),
      claim_expires_at: r.claim_expires_at,
      expires_in_seconds: Math.max(0, Math.round((Date.parse(r.claim_expires_at) - ctx.now.getTime()) / 1000)),
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
    `scope overlaps a live claim: "${first.holder_label}" holds ${first.held.join(', ')} on ticket ${first.ticket_id} ("${first.title}") until ${first.claim_expires_at}${more}`,
    { requested: scope.paths, conflicts },
  );
}

export function claim(ctx: Ctx, input: ClaimInput): ClaimResult {
  const lease = clampLease(input.lease_seconds);
  const { scope, worktree } = resolveClaimScope(input.scope, ctx.root);
  return tx(ctx.db, () => {
    // Resolve, de-duplicate, and lock in one order so two processes claiming
    // overlapping sets cannot deadlock on each other's partial progress.
    const ids = [...new Set(input.ticket_ids.map((x) => resolveId(ctx.db, x)))].sort();
    const rows: TicketRow[] = [];
    for (const id of ids) {
      const row = sweepExpired(ctx, mustGetRow(ctx.db, id));
      if (hasLiveClaim(row, ctx.now) && !ownsClaim({ actor: ctx.actor, session: ctx.session }, row.claim_actor, row.claim_session)) {
        const label = holderLabel(row.claim_actor ?? '?', row.claim_session);
        throw new SeaError('already_claimed', `ticket ${id} is claimed by "${label}" until ${row.claim_expires_at}`, {
          ticket_id: id,
          held_by: row.claim_actor,
          held_by_session: row.claim_session,
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
      const rotated = row.claim_token_hash !== null && ownsClaim({ actor: ctx.actor, session: ctx.session }, row.claim_actor, row.claim_session);
      const c = placeClaim(ctx, row, lease, ids.length > 1 ? { set: ids } : {}, scope, worktree);
      claims.push({ ticket_id: row.id, claim_token: c.token, expires_at: c.expires_at, rotated });
    }
    return { claims, lease_seconds: lease, scope, worktree, head: ctx.chain.head() };
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
  const paths = normalizeScope(input.paths, ctx.root);
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

/** Heartbeat. Never shortens; capped at now + MAX_LEASE_SECONDS. Row only — not chained. Default: the claim's own lease. */
export function refresh(ctx: Ctx, input: RefreshInput): RefreshResult {
  if (input.extend_by_seconds !== undefined && input.extend_by_seconds > MAX_LEASE_SECONDS) {
    throw new SeaError('invalid_input', `extend_by_seconds must be ≤ ${MAX_LEASE_SECONDS}`);
  }
  return tx(ctx.db, () => {
    const id = resolveId(ctx.db, input.ticket_id);
    const row = mustGetRow(ctx.db, id);
    validateFence(row, input.claim_token, ctx.actor, ctx.now);
    const by = input.extend_by_seconds ?? row.claim_lease_seconds ?? DEFAULT_LEASE_SECONDS;
    const proposed = Date.parse(expiryFrom(ctx.now, by));
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
         claim_scope = NULL, claim_worktree = NULL, claim_session = NULL, claim_lease_seconds = NULL, last_seq = ? WHERE id = ?`,
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
  const { scope, worktree } = resolveClaimScope(input.scope, ctx.root);
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
    const pf = projectFilter(ctx);
    if (pf.sql) {
      where.push(pf.sql);
      params.push(...pf.params);
    }
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
    const c = placeClaim(ctx, row, lease, { via: 'sea_next' }, scope, worktree);
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

export interface ReleaseWorktreeResult {
  /** The worktree, normalized. */
  worktree: string;
  released: { ticket_id: string; holder: string; scope: Scope | null }[];
  /** Bound claims whose lease had already lapsed: recorded as expired, not released. */
  expired: { ticket_id: string; holder: string }[];
  head: ChainHead;
}

/**
 * Release every live claim bound to a worktree (for a WorktreeRemove hook):
 * the worktree is gone, so whoever held the claims cannot continue there.
 * No claim token is needed — the binding the holder declared is the
 * authority — and each release is chained as `sea_ticket.claim_released`
 * with `via: release_worktree`, the caller as actor_id and the holder as
 * claim_actor. `worktree` may list several spellings of one directory (as
 * given, realpath); a claim matching any of them is released.
 */
export function releaseWorktree(ctx: Ctx, input: { worktree: string | readonly string[]; reason?: string }): ReleaseWorktreeResult {
  const candidates = (typeof input.worktree === 'string' ? [input.worktree] : [...input.worktree]).map(normalizeWorktreePath);
  if (candidates.length === 0) throw new SeaError('invalid_input', 'release-worktree needs a path');
  return tx(ctx.db, () => {
    const rows = ctx.db
      .prepare(`SELECT * FROM sea_tickets WHERE claim_worktree IS NOT NULL AND claim_token_hash IS NOT NULL ORDER BY id`)
      .all() as TicketRow[];
    const released: ReleaseWorktreeResult['released'] = [];
    const expired: ReleaseWorktreeResult['expired'] = [];
    for (const r of rows) {
      if (!candidates.some((c) => sameWorktree(c, r.claim_worktree!))) continue;
      const row = sweepExpired(ctx, r);
      if (row.claim_token_hash === null) {
        expired.push({ ticket_id: r.id, holder: r.claim_actor ?? '' });
        continue;
      }
      const scope = parseScopeJson(row.claim_scope);
      const ev = ctx.chain.append({
        event_type: EVENT.ticket_claim_released,
        actor_id: ctx.actor,
        occurred_at: ctx.now.toISOString(),
        payload: {
          ticket_id: row.id,
          claim_token_hash: row.claim_token_hash,
          claim_actor: row.claim_actor,
          scope,
          reason: input.reason ?? 'worktree removed',
          write_count: row.claim_write_count,
          worktree: row.claim_worktree,
          via: 'release_worktree',
        },
      });
      clearClaim(ctx, row.id, ev.event.seq);
      released.push({ ticket_id: row.id, holder: row.claim_actor ?? '', scope });
    }
    return { worktree: candidates[0]!, released, expired, head: ctx.chain.head() };
  });
}

export interface HeartbeatResult {
  /** The caller's live claims, renewed to now + their lease (never shortened). */
  renewed: { ticket_id: string; title: string; expires_at: string; lease_seconds: number; scope: Scope | null }[];
  /** The caller's claims whose lease had already lapsed: recorded as expired, not renewed. */
  lapsed: { ticket_id: string; title: string; expired_at: string }[];
  head: ChainHead;
}

/**
 * Renew every live claim the caller holds (ownsClaim) to now + its own lease
 * (claim_lease_seconds, else the default), never shortening one. Claims of
 * the caller whose lease already lapsed are swept (chained as expired, once)
 * and reported, never resurrected: a lapsed lease may already have been
 * taken over by someone else. Renewal is row-only, like sea_refresh, so it
 * does not flood the chain. `quiet` skips the result assembly (the MCP
 * layer's per-call touch).
 */
export function heartbeat(ctx: Ctx, opts: { quiet?: boolean } = {}): HeartbeatResult {
  return tx(ctx.db, () => {
    const rows = ctx.db
      .prepare(`SELECT * FROM sea_tickets WHERE claim_token_hash IS NOT NULL AND claim_actor IS NOT NULL ORDER BY id`)
      .all() as TicketRow[];
    const renewed: HeartbeatResult['renewed'] = [];
    const lapsed: HeartbeatResult['lapsed'] = [];
    const nowMs = ctx.now.getTime();
    const upd = ctx.db.prepare(`UPDATE sea_tickets SET claim_expires_at = ? WHERE id = ?`);
    for (const row of rows) {
      if (!ownsClaim(ctx, row.claim_actor, row.claim_session)) continue;
      if (!hasLiveClaim(row, ctx.now)) {
        sweepExpired(ctx, row);
        lapsed.push({ ticket_id: row.id, title: row.title, expired_at: row.claim_expires_at ?? '' });
        continue;
      }
      const lease = Math.min(row.claim_lease_seconds ?? DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS);
      const proposed = nowMs + lease * 1000;
      let expires_at = row.claim_expires_at!;
      if (proposed > Date.parse(expires_at)) {
        expires_at = new Date(proposed).toISOString();
        upd.run(expires_at, row.id);
      }
      if (!opts.quiet) renewed.push({ ticket_id: row.id, title: row.title, expires_at, lease_seconds: lease, scope: parseScopeJson(row.claim_scope) });
    }
    return { renewed, lapsed, head: ctx.chain.head() };
  });
}
