/**
 * Per-actor accounting, derived from the chain (claims, releases, expiries,
 * transitions) plus the projection (live claims and their current expiry).
 * Read-only: no sweep, no write, no new event types.
 *
 * Lease-seconds is the time each claim was held, from its `claimed` event to
 * whatever ended it — release, force release, a terminal transition, a
 * re-claim (token rotation), or the lapsed expiry recorded on
 * `claim_expired` (which includes unchained refreshes). A claim still live
 * counts up to now. Everything is clipped to the window.
 *
 * Not counted: `scope_conflict` refusals. They are not chained (a refusal
 * writes nothing), so there is nothing to derive them from.
 */

import type { ChainHead } from 'kronicle-lite';

import { SeaError } from '../core/errors.js';
import { EVENT } from '../core/events.js';
import type { Ctx } from '../core/repo.js';
import type { StatsInput } from '../model/schemas.js';

export interface ActorStats {
  actor: string;
  /** Claims taken (sea_claim, sea_next, create with claim_seconds), excluding token rotations. */
  claims_taken: number;
  /** Re-claims of a ticket the actor already held (token rotation). */
  claims_rotated: number;
  /** Claims taken with a scope (paths and/or worktree). */
  scoped_claims: number;
  /** Claims the holder gave back (sea_release, release-worktree). */
  released: number;
  /** Claims released by the holder's own terminal transition. */
  released_on_transition: number;
  /** The actor's leases that lapsed. */
  expired: number;
  /** The actor's claims an operator force-released. */
  force_released: number;
  /** Force releases this actor performed as operator. */
  force_releases_issued: number;
  /** Seconds the actor held claims, clipped to the window. */
  lease_seconds: number;
  /** Claims held right now (unexpired). */
  live_claims: number;
  /** Status changes made. */
  transitions: number;
  tickets_created: number;
}

export interface StatsResult {
  since: string | null;
  until: string;
  actors: ActorStats[];
  totals: Omit<ActorStats, 'actor'>;
  events_scanned: number;
  head: ChainHead;
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `7d`, `24h`, `30m`, `90s`, `2w`, or an ISO-8601 timestamp. Returns epoch ms. */
export function parseSince(raw: string, now: Date): number {
  const s = raw.trim();
  const rel = /^(\d+)\s*([smhdw])$/i.exec(s);
  if (rel) return now.getTime() - Number(rel[1]) * UNIT_MS[rel[2]!.toLowerCase()]!;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new SeaError('invalid_input', `since must be a duration like 24h / 7d or an ISO-8601 timestamp, got "${raw}"`);
  return t;
}

const TYPES = [
  EVENT.ticket_created,
  EVENT.ticket_claimed,
  EVENT.ticket_claim_released,
  EVENT.ticket_claim_force_released,
  EVENT.ticket_claim_expired,
  EVENT.ticket_status_set,
] as const;

function zero(actor: string): ActorStats {
  return {
    actor,
    claims_taken: 0,
    claims_rotated: 0,
    scoped_claims: 0,
    released: 0,
    released_on_transition: 0,
    expired: 0,
    force_released: 0,
    force_releases_issued: 0,
    lease_seconds: 0,
    live_claims: 0,
    transitions: 0,
    tickets_created: 0,
  };
}

type P = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function stats(ctx: Ctx, input: StatsInput): StatsResult {
  const nowMs = ctx.now.getTime();
  const sinceMs = input.since !== undefined ? parseSince(input.since, ctx.now) : null;
  if (sinceMs !== null && sinceMs > nowMs) throw new SeaError('invalid_input', 'since is in the future');
  const from = sinceMs ?? Number.NEGATIVE_INFINITY;

  const byActor = new Map<string, ActorStats>();
  const get = (actor: string): ActorStats => {
    let s = byActor.get(actor);
    if (!s) byActor.set(actor, (s = zero(actor)));
    return s;
  };
  const inWindow = (iso: string): boolean => Date.parse(iso) >= from;

  /** Open claim per ticket: who and since when. */
  const open = new Map<string, { actor: string; start: number }>();
  const close = (ticket: string, endMs: number): string | null => {
    const o = open.get(ticket);
    if (!o) return null;
    open.delete(ticket);
    const lo = Math.max(o.start, from);
    const hi = Math.min(Math.max(endMs, o.start), nowMs);
    if (hi > lo) get(o.actor).lease_seconds += (hi - lo) / 1000;
    return o.actor;
  };

  // One read; better-sqlite3 runs it against a consistent snapshot.
  const rows = ctx.db
    .prepare(
      `SELECT seq, event_type, actor_id, occurred_at, payload_canonical FROM events
        WHERE event_type IN (${TYPES.map(() => '?').join(', ')}) ORDER BY seq`,
    )
    .all(...TYPES) as { seq: number; event_type: string; actor_id: string; occurred_at: string; payload_canonical: string }[];

  for (const r of rows) {
    const p = JSON.parse(r.payload_canonical) as P;
    const ticket = str(p['ticket_id']);
    if (ticket === null) continue;
    const at = Date.parse(r.occurred_at);
    const counted = inWindow(r.occurred_at);
    switch (r.event_type) {
      case EVENT.ticket_created:
        if (counted) get(r.actor_id).tickets_created++;
        break;
      case EVENT.ticket_claimed: {
        const holder = str(p['claim_actor']) ?? r.actor_id;
        close(ticket, at);
        open.set(ticket, { actor: holder, start: at });
        if (counted) {
          const s = get(holder);
          if (p['rotated'] === true) s.claims_rotated++;
          else s.claims_taken++;
          if ((p['scope'] !== null && p['scope'] !== undefined) || typeof p['worktree'] === 'string') s.scoped_claims++;
        }
        break;
      }
      case EVENT.ticket_claim_released: {
        const holder = close(ticket, at) ?? str(p['claim_actor']) ?? r.actor_id;
        if (counted) get(holder).released++;
        break;
      }
      case EVENT.ticket_claim_force_released: {
        const holder = close(ticket, at) ?? str(p['previous_holder']);
        if (counted) {
          if (holder !== null) get(holder).force_released++;
          get(r.actor_id).force_releases_issued++;
        }
        break;
      }
      case EVENT.ticket_claim_expired: {
        const expiredAt = str(p['expired_at']);
        const holder = close(ticket, expiredAt !== null ? Date.parse(expiredAt) : at) ?? str(p['claim_actor']);
        if (counted && holder !== null) get(holder).expired++;
        break;
      }
      case EVENT.ticket_status_set: {
        if (counted) get(r.actor_id).transitions++;
        if (p['claim_auto_released'] === true) {
          const holder = close(ticket, at) ?? r.actor_id;
          if (counted) get(holder).released_on_transition++;
        }
        break;
      }
    }
  }

  // Still-open claims: held until their current expiry (refreshes included) or now.
  const live = ctx.db
    .prepare(`SELECT id, claim_actor, claim_expires_at FROM sea_tickets WHERE claim_token_hash IS NOT NULL AND claim_expires_at IS NOT NULL`)
    .all() as { id: string; claim_actor: string; claim_expires_at: string }[];
  const liveExpiry = new Map(live.map((l) => [l.id, l]));
  for (const [ticket, o] of [...open]) {
    const row = liveExpiry.get(ticket);
    const end = row && row.claim_actor === o.actor ? Date.parse(row.claim_expires_at) : nowMs;
    close(ticket, end);
  }
  for (const l of live) if (Date.parse(l.claim_expires_at) > nowMs) get(l.claim_actor).live_claims++;

  let actors = [...byActor.values()].sort((a, b) => (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0));
  if (input.actor !== undefined) actors = actors.filter((a) => a.actor === input.actor);
  for (const a of actors) a.lease_seconds = Math.round(a.lease_seconds);
  const totals = zero('*');
  for (const a of actors) {
    for (const k of Object.keys(totals) as (keyof ActorStats)[]) {
      if (k !== 'actor') (totals[k] as number) += a[k] as number;
    }
  }
  const { actor: _drop, ...totalsOut } = totals;
  return {
    since: sinceMs !== null ? new Date(sinceMs).toISOString() : null,
    until: ctx.now.toISOString(),
    actors,
    totals: totalsOut,
    events_scanned: rows.length,
    head: ctx.chain.head(),
  };
}
