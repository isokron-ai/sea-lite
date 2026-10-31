/**
 * History: the chain events behind one ticket, or a since-seq feed of every
 * sea event, with the chain's verification status alongside so a reader
 * knows whether the record it is looking at still hashes.
 */

import type { ChainEvent, ChainHead, VerifyChainResult } from 'kronicle-lite';

import { SEA_EVENT_PREFIXES } from '../core/events.js';
import { resolveId, type Ctx } from '../core/repo.js';
import type { HistoryInput } from '../model/schemas.js';

export interface HistoryEntry {
  seq: number;
  hash: string;
  event_type: string;
  actor_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface HistoryResult {
  mode: 'ticket' | 'feed';
  ticket_id: string | null;
  since_seq: number | null;
  events: HistoryEntry[];
  count: number;
  /** Highest seq returned; pass as since_seq to continue the feed. */
  last_seq: number | null;
  truncated: boolean;
  head: ChainHead;
  chain: {
    verified: boolean | null;
    events_checked: number | null;
    first_mismatch: VerifyChainResult['first_mismatch'] | null;
  };
}

const PREFIX_SQL = SEA_EVENT_PREFIXES.map(() => `event_type LIKE ? ESCAPE '\\'`).join(' OR ');
const PREFIX_PARAMS = SEA_EVENT_PREFIXES.map((p) => p.replace(/_/g, '\\_') + '%');

function toEntry(ev: ChainEvent): HistoryEntry {
  return {
    seq: ev.seq,
    hash: ev.this_hash,
    event_type: ev.event_type,
    actor_id: ev.actor_id,
    occurred_at: ev.occurred_at,
    payload: ev.payload,
  };
}

export function history(ctx: Ctx, input: HistoryInput): HistoryResult {
  let seqs: number[];
  let ticket_id: string | null = null;
  let mode: HistoryResult['mode'];
  if (input.ticket_id !== undefined) {
    mode = 'ticket';
    ticket_id = resolveId(ctx.db, input.ticket_id);
    seqs = (
      ctx.db
        .prepare(
          `SELECT seq FROM events
            WHERE (${PREFIX_SQL})
              AND seq > ?
              AND (json_extract(payload_canonical, '$.ticket_id') = ?
                   OR json_extract(payload_canonical, '$.from_id') = ?
                   OR json_extract(payload_canonical, '$.to_id') = ?
                   OR json_extract(payload_canonical, '$.duplicate_of') = ?)
            ORDER BY seq LIMIT ?`,
        )
        .all(...PREFIX_PARAMS, input.since_seq ?? 0, ticket_id, ticket_id, ticket_id, ticket_id, input.limit + 1) as { seq: number }[]
    ).map((r) => r.seq);
  } else {
    mode = 'feed';
    seqs = (
      ctx.db
        .prepare(`SELECT seq FROM events WHERE (${PREFIX_SQL}) AND seq > ? ORDER BY seq LIMIT ?`)
        .all(...PREFIX_PARAMS, input.since_seq ?? 0, input.limit + 1) as { seq: number }[]
    ).map((r) => r.seq);
  }
  const truncated = seqs.length > input.limit;
  const page = seqs.slice(0, input.limit);
  const events: HistoryEntry[] = [];
  for (const s of page) {
    const ev = ctx.chain.get(s);
    if (ev) events.push(toEntry(ev));
  }
  const head = ctx.chain.head();
  let chain: HistoryResult['chain'] = { verified: null, events_checked: null, first_mismatch: null };
  if (input.verify) {
    const v = ctx.chain.verify();
    chain = { verified: v.ok, events_checked: v.events_checked, first_mismatch: v.first_mismatch };
  }
  return {
    mode,
    ticket_id,
    since_seq: input.since_seq ?? null,
    events,
    count: events.length,
    last_seq: events.length > 0 ? events[events.length - 1]!.seq : null,
    truncated,
    head,
    chain,
  };
}
