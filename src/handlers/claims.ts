/**
 * Claims: acquire (one or a set, all-or-nothing), refresh (row only, not
 * chained), release (holder, or operator force), next (pick + claim), and
 * the scope check. A claim may carry a scope — the paths the holder will
 * touch — and no two actors may hold overlapping live scopes (core/scope.ts).
 */

import type { ChainHead } from 'kronicle-lite';

import { SeaError } from '../core/errors.js';
import { EVENT } from '../core/events.js';
import { assertClockTrusted } from '../core/clock.js';
import { clampLease, DEFAULT_LEASE_SECONDS, expiryFrom, hasLiveClaim, MAX_LEASE_SECONDS, validateFence } from '../core/fence.js';
import { holderLabel } from '../core/identity.js';
import type { Blocker, WaitInfo } from '../core/wait.js';
import { addNote, assertWritable, mustGetRow, ownsClaim, projectFilter, resolveId, sweepAllExpired, sweepExpired, tx, type Ctx } from '../core/repo.js';
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
      const row = sweepExpired(ctx, assertWritable(ctx, mustGetRow(ctx.db, id)));
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
  assertClockTrusted(ctx.clock, 'refresh a lease');
  return tx(ctx.db, () => {
    const id = resolveId(ctx.db, input.ticket_id);
    const row = assertWritable(ctx, mustGetRow(ctx.db, id));
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
    const row = sweepExpired(ctx, assertWritable(ctx, mustGetRow(ctx.db, id)));
    if (input.force) {
      if (ctx.role !== 'operator') {
        // P2-12: an HTTP actor's role comes from its token, not from the server's --role.
        throw new SeaError(
          'forbidden',
          `force release needs the operator role; "${ctx.actor}" acts as ${ctx.role} (stdio/CLI: --role operator or SEA_LITE_ROLE=operator; ` +
            'HTTP: a token from the actors file with "role": "operator", e.g. sea-lite add-token --actor ID --role operator)',
          { role: ctx.role },
        );
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
    // SL-2: a release with a note is a hand-off; sea_next keeps it from the holder that handed it off (see next()).
    const handoff = input.note !== undefined;
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
        // Present only on hand-offs, so other release payloads are unchanged.
        ...(handoff ? { handoff: true, ...(row.claim_session !== null ? { claim_session: row.claim_session } : {}) } : {}),
      },
    });
    clearClaim(ctx, id, r.event.seq);
    if (handoff) recordHandoff(ctx.db, id, row.claim_actor ?? ctx.actor, row.claim_session, ctx.now.toISOString(), r.event.seq);
    const note = input.note !== undefined ? addNote(ctx, id, input.note) : null;
    return { ticket: rowToTicket(mustGetRow(ctx.db, id)), forced: false, previous_holder: row.claim_actor, note, head: ctx.chain.head() };
  });
}

/** Projection of a hand-off (also used by rebuild). */
export function recordHandoff(db: Ctx['db'], ticket_id: string, actor: string, session: string | null, at: string, seq: number): void {
  db.prepare(`INSERT OR REPLACE INTO sea_handoffs (ticket_id, actor, session, released_at, released_seq) VALUES (?, ?, ?, ?, ?)`).run(ticket_id, actor, session, at, seq);
}

function clearClaim(ctx: Ctx, id: string, seq: number): void {
  ctx.db
    .prepare(
      `UPDATE sea_tickets SET claim_token_hash = NULL, claim_actor = NULL, claim_expires_at = NULL, claim_write_count = 0,
         claim_scope = NULL, claim_worktree = NULL, claim_session = NULL, claim_lease_seconds = NULL, last_seq = ? WHERE id = ?`,
    )
    .run(seq, id);
}

/** An eligible ticket sea_next could not hand out because someone else holds it (SL-4). */
export interface HeldTicket {
  ticket_id: string;
  title: string;
  holder: string;
  holder_session: string | null;
  holder_label: string;
  /** When the current claim was taken, and how long ago (the claim age). Null when the chain has no claim event for it. */
  claimed_at: string | null;
  claim_age_seconds: number | null;
  /** Seconds since the holder last renewed the lease (any tool call renews it). */
  silent_seconds: number;
  expires_at: string;
  expires_in_seconds: number;
  /** Silent for more than half its lease: the holder has probably crashed; the claim frees itself at expires_at. */
  stale: boolean;
}

/** One of the caller's own hand-offs that sea_next is keeping for another agent (SL-2). */
export interface HandedOffTicket {
  ticket_id: string;
  title: string;
  released_at: string;
  /** When sea_next gives it back to the caller even if other agents are around. */
  yours_again_at: string;
}

export interface NextResult {
  ticket: Ticket | null;
  claim_token: string | null;
  expires_at: string | null;
  /**
   * Why nothing came back, when ticket is null: `nothing_eligible` (no work
   * for you at all), `held` (eligible work exists but others hold it),
   * `held_by_stale_claim` (as held, and at least one holder has gone silent
   * — see `held[].stale`), `handed_off` (the only work left is what you
   * handed off; another agent is active).
   */
  reason: 'nothing_eligible' | 'held' | 'held_by_stale_claim' | 'handed_off' | null;
  considered: number;
  /** When ticket is null and eligible work is held by others: who holds it, since when, and when it frees. */
  held?: HeldTicket[];
  /** When ticket is null and your own hand-offs are being kept for another agent. */
  handed_off?: HandedOffTicket[];
  head: ChainHead;
}

/**
 * SL-2: how long a hand-off is kept from the agent that handed it off while
 * other agents are around (then it is anyone's again, so it cannot starve).
 */
export const HANDOFF_HOLD_SECONDS = DEFAULT_LEASE_SECONDS;
/** SL-2: chain activity by another actor this recent counts as "another agent is around". */
const PEER_ACTIVE_SECONDS = DEFAULT_LEASE_SECONDS;
const PEER_EVENT_SCAN = 500;

/**
 * Is any agent other than the caller around to take a hand-off? A live
 * registered server of another actor or session, a live claim of someone
 * else, or chain activity of another actor within PEER_ACTIVE_SECONDS.
 */
function otherAgentAround(ctx: Ctx): boolean {
  const me = { actor: ctx.actor, session: ctx.session };
  for (const p of ctx.peers?.() ?? []) {
    if ((p.project === null || ctx.project === null || p.project === ctx.project) && !ownsClaim(me, p.actor, p.session)) return true;
  }
  const pf = projectFilter(ctx);
  const claims = ctx.db
    .prepare(`SELECT t.claim_actor, t.claim_session FROM sea_tickets t WHERE t.claim_token_hash IS NOT NULL AND t.claim_expires_at > ?${pf.sql ? ` AND ${pf.sql}` : ''}`)
    .all(ctx.now.toISOString(), ...pf.params) as { claim_actor: string; claim_session: string | null }[];
  if (claims.some((c) => !ownsClaim(me, c.claim_actor, c.claim_session))) return true;
  const since = new Date(ctx.now.getTime() - PEER_ACTIVE_SECONDS * 1000).toISOString();
  const recent = ctx.db.prepare(`SELECT actor_id, occurred_at FROM events ORDER BY seq DESC LIMIT ?`).all(PEER_EVENT_SCAN) as { actor_id: string; occurred_at: string }[];
  return recent.some((e) => e.occurred_at >= since && e.actor_id !== ctx.actor);
}

/**
 * SQL for "this ticket is work sea_next may hand out", apart from being
 * claimed: an eligible status, not parked, assigned to the caller (or
 * nobody, with include_unassigned), every predecessor terminal, not an epic
 * (SL-3: kind epic, or the parent_of an open child — an epic is done by
 * doing its children), and the caller's project / kind / tag filters.
 */
function eligibleWhere(ctx: Ctx, input: Pick<NextInput, 'include_unassigned' | 'kind' | 'tag'>): { where: string[]; params: unknown[] } {
  const where: string[] = [
    `t.status IN (${sqlIn(NEXT_ELIGIBLE_STATES)})`,
    `t.priority <> 'parked'`,
    input.include_unassigned ? `(t.assignee = ? OR t.assignee IS NULL)` : `t.assignee = ?`,
    `NOT EXISTS (SELECT 1 FROM sea_links l JOIN sea_tickets p ON p.id = l.from_id
       WHERE l.state = 'active' AND l.link_type = 'blocks' AND l.to_id = t.id AND p.status NOT IN (${sqlIn(TERMINAL_STATES)}))`,
    `NOT EXISTS (SELECT 1 FROM sea_links l JOIN sea_tickets p ON p.id = l.to_id
       WHERE l.state = 'active' AND l.link_type = 'depends_on' AND l.from_id = t.id AND p.status NOT IN (${sqlIn(TERMINAL_STATES)}))`,
    ...EPIC_EXCLUSION,
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
  return { where, params };
}

/** SL-3: sea_next never hands out an epic (kind epic, or the parent of an open child). */
const EPIC_EXCLUSION: readonly string[] = [
  `t.kind <> 'epic'`,
  `NOT EXISTS (SELECT 1 FROM sea_links l JOIN sea_tickets c ON c.id = l.to_id
     WHERE l.state = 'active' AND l.link_type = 'parent_of' AND l.from_id = t.id AND c.status NOT IN (${sqlIn(TERMINAL_STATES)}))`,
];

/** SL-2: the caller's own current hand-off of `t` (the release + note are the last events on the ticket), kept for HANDOFF_HOLD_SECONDS. */
const MY_HANDOFF = `EXISTS (SELECT 1 FROM sea_handoffs h WHERE h.ticket_id = t.id AND h.actor = ? AND h.session IS ?
  AND t.last_seq <= h.released_seq + 1 AND h.released_at > ?)`;

/** SL-4: eligible tickets held by someone else's live claim, earliest to free first. */
function heldBy(ctx: Ctx, input: NextInput): HeldTicket[] {
  const { where, params } = eligibleWhere(ctx, input);
  const now = ctx.now.getTime();
  const rows = ctx.db
    .prepare(`SELECT t.* FROM sea_tickets t WHERE ${where.join(' AND ')} AND t.claim_token_hash IS NOT NULL AND t.claim_expires_at > ? ORDER BY t.claim_expires_at, t.id LIMIT 20`)
    .all(...params, ctx.now.toISOString()) as TicketRow[];
  const claimedAt = ctx.db.prepare(
    `SELECT occurred_at FROM events WHERE event_type = ? AND json_extract(payload_canonical, '$.ticket_id') = ? AND seq <= ? ORDER BY seq DESC LIMIT 1`,
  );
  const out: HeldTicket[] = [];
  for (const r of rows) {
    if (ownsClaim(ctx, r.claim_actor, r.claim_session)) continue;
    const exp = Date.parse(r.claim_expires_at!);
    const lease = r.claim_lease_seconds ?? DEFAULT_LEASE_SECONDS;
    // A renewal sets expires_at = now + lease, so the last sign of life is expires_at - lease.
    const silent = Math.max(0, Math.round((now - (exp - lease * 1000)) / 1000));
    const at = (claimedAt.get(EVENT.ticket_claimed, r.id, r.last_seq) as { occurred_at: string } | undefined)?.occurred_at ?? null;
    out.push({
      ticket_id: r.id,
      title: r.title,
      holder: r.claim_actor!,
      holder_session: r.claim_session ?? null,
      holder_label: holderLabel(r.claim_actor!, r.claim_session),
      claimed_at: at,
      claim_age_seconds: at === null ? null : Math.max(0, Math.round((now - Date.parse(at)) / 1000)),
      silent_seconds: silent,
      expires_at: r.claim_expires_at!,
      expires_in_seconds: Math.max(0, Math.round((exp - now) / 1000)),
      stale: silent * 2 > lease,
    });
  }
  return out;
}

/**
 * The queue's dispatch: the highest-priority unclaimed triaged/in_progress
 * ticket assigned to me (or unassigned) whose predecessors are all terminal,
 * claimed in the same transaction. Predecessors: tickets that `block` this
 * one, and tickets this one `depends_on`. Never an epic (SL-3). A ticket the
 * caller handed off (released with a note) goes to another agent first: it
 * comes back to the caller only when nothing else is eligible and no other
 * agent is around, or after HANDOFF_HOLD_SECONDS (SL-2). When nothing comes
 * back, `reason` and `held` say whether eligible work is held, by whom, for
 * how long, and whether the holder looks gone (SL-4).
 */
export function next(ctx: Ctx, input: NextInput): NextResult {
  const lease = clampLease(input.lease_seconds);
  const { scope, worktree } = resolveClaimScope(input.scope, ctx.root);
  return tx(ctx.db, () => {
    sweepAllExpired(ctx);
    // The scope is what the caller will touch regardless of which ticket comes
    // back, so a conflict refuses the dispatch rather than skipping tickets.
    if (scope) assertScopeFree(ctx, scope);
    const { where, params } = eligibleWhere(ctx, input);
    where.push(`t.claim_token_hash IS NULL`);
    const order = `CASE t.priority ${Object.entries(PRIORITY_RANK)
      .map(([p, r]) => `WHEN '${p}' THEN ${r}`)
      .join(' ')} END, CASE t.status WHEN 'in_progress' THEN 0 ELSE 1 END, t.created_seq ASC`;
    const considered = (
      ctx.db.prepare(`SELECT COUNT(*) AS n FROM sea_tickets t WHERE ${where.join(' AND ')}`).get(...params) as { n: number }
    ).n;
    const holdSince = new Date(ctx.now.getTime() - HANDOFF_HOLD_SECONDS * 1000).toISOString();
    const mine = [ctx.actor, ctx.session, holdSince];
    const pick = (extra: string, extraParams: unknown[]) =>
      ctx.db.prepare(`SELECT t.* FROM sea_tickets t WHERE ${where.join(' AND ')}${extra} ORDER BY ${order} LIMIT 1`).get(...params, ...extraParams) as
        | TicketRow
        | undefined;
    // SL-2: someone else's work (or work nobody handed off) first.
    let row = pick(` AND NOT ${MY_HANDOFF}`, mine);
    let handedOff: HandedOffTicket[] = [];
    if (!row) {
      const own = pick(` AND ${MY_HANDOFF}`, mine);
      if (own) {
        if (!otherAgentAround(ctx)) row = own; // the only agent: it is yours again
        else {
          const rows = ctx.db
            .prepare(
              `SELECT t.id, t.title, h.released_at FROM sea_tickets t JOIN sea_handoffs h ON h.ticket_id = t.id WHERE ${where.join(' AND ')} AND ${MY_HANDOFF} ORDER BY h.released_at LIMIT 20`,
            )
            .all(...params, ...mine) as { id: string; title: string; released_at: string }[];
          handedOff = rows.map((r) => ({
            ticket_id: r.id,
            title: r.title,
            released_at: r.released_at,
            yours_again_at: new Date(Date.parse(r.released_at) + HANDOFF_HOLD_SECONDS * 1000).toISOString(),
          }));
        }
      }
    }
    if (!row) {
      const held = heldBy(ctx, input);
      const reason: NextResult['reason'] = held.some((h) => h.stale) ? 'held_by_stale_claim' : held.length > 0 ? 'held' : handedOff.length > 0 ? 'handed_off' : 'nothing_eligible';
      return {
        ticket: null,
        claim_token: null,
        expires_at: null,
        reason,
        considered,
        ...(held.length > 0 ? { held } : {}),
        ...(handedOff.length > 0 ? { handed_off: handedOff } : {}),
        head: ctx.chain.head(),
      };
    }
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
  assertClockTrusted(ctx.clock, 'renew leases');
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

// ───────────────────────────── waiting (wait_seconds) ─────────────────────────────

/** Turn a refusal into the blocker a waiter waits on; null if waiting cannot help. */
export function blockerOf(ctx: Ctx, err: unknown): Blocker | null {
  if (!(err instanceof SeaError)) return null;
  const titleOf = (id: string) => (ctx.db.prepare(`SELECT title FROM sea_tickets WHERE id = ?`).get(id) as { title: string } | undefined)?.title ?? null;
  if (err.code === 'already_claimed') {
    const d = err.details as { ticket_id: string; held_by: string | null; held_by_session: string | null; claim_expires_at: string };
    const holder = d.held_by ?? '?';
    return {
      kind: 'already_claimed',
      ticket_id: d.ticket_id,
      title: titleOf(d.ticket_id),
      holder,
      holder_session: d.held_by_session ?? null,
      holder_label: holderLabel(holder, d.held_by_session),
      expires_at: d.claim_expires_at,
    };
  }
  if (err.code === 'scope_conflict') {
    const c = (err.details as { conflicts: ScopeConflict[] }).conflicts[0];
    if (c === undefined) return null;
    return {
      kind: 'scope_conflict',
      ticket_id: c.ticket_id,
      title: c.title,
      holder: c.holder,
      holder_session: c.holder_session,
      holder_label: c.holder_label,
      expires_at: c.claim_expires_at,
    };
  }
  return null;
}

/**
 * sea_next found nothing eligible: is that because someone else holds work
 * that could free up (an eligible ticket under a live claim, or a live-claimed
 * predecessor of an unclaimed eligible ticket)? The earliest-expiring such
 * claim, or null when the queue is simply empty for this caller.
 */
export function busyQueueBlocker(ctx: Ctx): Blocker | null {
  const pf = projectFilter(ctx);
  const now = ctx.now.toISOString();
  const rows = ctx.db
    .prepare(
      `SELECT t.id, t.title, t.claim_actor, t.claim_session, t.claim_expires_at FROM sea_tickets t
        WHERE t.claim_token_hash IS NOT NULL AND t.claim_expires_at > ?${pf.sql ? ` AND ${pf.sql}` : ''}
          AND (
            (t.status IN (${sqlIn(NEXT_ELIGIBLE_STATES)}) AND t.priority <> 'parked' AND ${EPIC_EXCLUSION.join(' AND ')})
            OR EXISTS (SELECT 1 FROM sea_links l JOIN sea_tickets c ON c.id = l.to_id
                        WHERE l.state = 'active' AND l.link_type = 'blocks' AND l.from_id = t.id
                          AND c.status IN (${sqlIn(NEXT_ELIGIBLE_STATES)}) AND c.claim_token_hash IS NULL)
            OR EXISTS (SELECT 1 FROM sea_links l JOIN sea_tickets c ON c.id = l.from_id
                        WHERE l.state = 'active' AND l.link_type = 'depends_on' AND l.to_id = t.id
                          AND c.status IN (${sqlIn(NEXT_ELIGIBLE_STATES)}) AND c.claim_token_hash IS NULL)
          )
        ORDER BY t.claim_expires_at, t.id`,
    )
    .all(now, ...pf.params) as { id: string; title: string; claim_actor: string; claim_session: string | null; claim_expires_at: string }[];
  const r = rows.find((x) => !ownsClaim(ctx, x.claim_actor, x.claim_session));
  if (r === undefined) return null;
  return {
    kind: 'busy_queue',
    ticket_id: r.id,
    title: r.title,
    holder: r.claim_actor,
    holder_session: r.claim_session ?? null,
    holder_label: holderLabel(r.claim_actor, r.claim_session),
    expires_at: r.claim_expires_at,
  };
}

/** After a successful wait: what happened to the first blocker. */
export function freedBy(ctx: Ctx, b: Blocker): WaitInfo['freed'] {
  const row = ctx.db.prepare(`SELECT * FROM sea_tickets WHERE id = ?`).get(b.ticket_id) as TicketRow | undefined;
  if (row === undefined) return 'changed';
  if ((TERMINAL_STATES as readonly string[]).includes(row.status)) return 'finished';
  const stillHers = row.claim_token_hash !== null && row.claim_actor === b.holder && (row.claim_session ?? null) === b.holder_session;
  if (stillHers) return 'changed';
  return ctx.now.getTime() >= Date.parse(b.expires_at) ? 'lease_expired' : 'released';
}
