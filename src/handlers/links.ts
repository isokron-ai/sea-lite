/**
 * Typed links between tickets. Add is fenced on the `from` ticket, checked
 * against the closed vocabulary, the active-unique index and (for
 * precedence types) a reachability query over existing active edges so no
 * DAG-class cycle can be committed. Remove is a tombstone, never a delete.
 */

import type { ChainHead } from 'kronicle-lite';

import { SeaError } from '../core/errors.js';
import { EVENT, idemKey } from '../core/events.js';
import { idForHash, priorFor, requestHash } from '../core/idem.js';
import { validateFence } from '../core/fence.js';
import { assertWritable, checkVersion, mustGetRow, resolveId, sweepExpired, tx, type Ctx } from '../core/repo.js';
import { rowToLink, type LinkRow, type LinkView } from '../core/types.js';
import { detectCycle, type DirectedEdge } from '../model/cycle-check.js';
import { DAG_LINK_TYPES, sqlIn } from '../model/enums.js';
import type { LinkInput } from '../model/schemas.js';
import { insertLink } from './tickets.js';

export interface LinkResult {
  action: 'add' | 'remove';
  link: LinkView | null;
  link_id: string;
  from_row_version: number;
  head: ChainHead;
  replayed: boolean;
  dry_run: boolean;
}

const DAG_TYPES_SQL = sqlIn([...DAG_LINK_TYPES]);

/** Can `start` reach `target` over active DAG-class edges? Recursive CTE, bounded by node count. */
export function reaches(db: Ctx['db'], start: string, target: string): boolean {
  const r = db
    .prepare(
      `WITH RECURSIVE reach(id, depth) AS (
         SELECT ?, 0
         UNION
         SELECT l.to_id, r.depth + 1 FROM sea_links l JOIN reach r ON l.from_id = r.id
          WHERE l.state = 'active' AND l.link_type IN (${DAG_TYPES_SQL}) AND r.depth < 10000
       )
       SELECT 1 AS hit FROM reach WHERE id = ? LIMIT 1`,
    )
    .get(start, target) as { hit: number } | undefined;
  return r !== undefined;
}

function dagEdges(db: Ctx['db']): DirectedEdge[] {
  return (
    db.prepare(`SELECT from_id, to_id, link_type FROM sea_links WHERE state = 'active' AND link_type IN (${DAG_TYPES_SQL})`).all() as {
      from_id: string;
      to_id: string;
      link_type: string;
    }[]
  ).map((e) => ({ from: e.from_id, to: e.to_id, linkType: e.link_type }));
}

function bumpFrom(ctx: Ctx, from_id: string, seq: number): number {
  ctx.db
    .prepare(
      `UPDATE sea_tickets SET row_version = row_version + 1, updated_at = ?, claim_write_count = claim_write_count + 1, last_seq = ?
        WHERE id = ?`,
    )
    .run(ctx.now.toISOString(), seq, from_id);
  return mustGetRow(ctx.db, from_id).row_version;
}

export function link(ctx: Ctx, input: LinkInput): LinkResult {
  const key = idemKey(input.idempotency_key);
  return tx(ctx.db, () => {
    const hash = requestHash('sea_link', {
      action: input.action,
      from_id: idForHash(ctx, input.from_id),
      to_id: idForHash(ctx, input.to_id),
      link_type: input.link_type,
      reason: input.reason,
      expected_version: input.expected_version,
    });
    {
      const prior = priorFor(ctx, input.idempotency_key, key, [input.action === 'add' ? EVENT.link_created : EVENT.link_tombstoned], hash);
      if (prior) {
        const p = prior.payload as { link_id: string; from_row_version?: number };
        const row = ctx.db.prepare(`SELECT * FROM sea_links WHERE link_id = ?`).get(p.link_id) as LinkRow | undefined;
        return {
          action: input.action,
          link: row ? rowToLink(row) : null,
          link_id: p.link_id,
          from_row_version: p.from_row_version ?? 0,
          head: ctx.chain.head(),
          replayed: true,
          dry_run: false,
        };
      }
    }
    const from_id = resolveId(ctx.db, input.from_id);
    const to_id = resolveId(ctx.db, input.to_id);
    if (from_id === to_id) throw new SeaError('self_loop', `a ticket cannot ${input.link_type} itself`, { ticket_id: from_id });
    const from = sweepExpired(ctx, assertWritable(ctx, mustGetRow(ctx.db, from_id)));
    assertWritable(ctx, mustGetRow(ctx.db, to_id));
    validateFence(from, input.claim_token, ctx.actor, ctx.now);
    checkVersion(from, input.expected_version);

    const existing = ctx.db
      .prepare(`SELECT * FROM sea_links WHERE state = 'active' AND from_id = ? AND to_id = ? AND link_type = ?`)
      .get(from_id, to_id, input.link_type) as LinkRow | undefined;

    if (input.action === 'add') {
      if (existing) {
        throw new SeaError('link_exists', `active ${input.link_type} link already exists`, { link_id: existing.link_id });
      }
      if (DAG_LINK_TYPES.has(input.link_type) && reaches(ctx.db, to_id, from_id)) {
        const finding = detectCycle(dagEdges(ctx.db), [{ from: from_id, to: to_id, linkType: input.link_type }]);
        throw new SeaError('cycle', `adding ${input.link_type} would close a cycle${finding ? `: ${finding.path.join(' → ')}` : ''}`, {
          path: finding?.path ?? [from_id, to_id, from_id],
          via: { from: from_id, to: to_id, linkType: input.link_type },
        });
      }
      if (input.dry_run) {
        return { action: 'add', link: null, link_id: '(dry_run)', from_row_version: from.row_version, head: ctx.chain.head(), replayed: false, dry_run: true };
      }
      const link_id = insertLink(
        ctx,
        from_id,
        to_id,
        input.link_type,
        { from_row_version: from.row_version + 1, reason: input.reason ?? null, ...(key !== undefined ? { request_hash: hash } : {}) },
        key,
      );
      const row = ctx.db.prepare(`SELECT * FROM sea_links WHERE link_id = ?`).get(link_id) as LinkRow;
      const from_row_version = bumpFrom(ctx, from_id, row.chain_seq);
      return { action: 'add', link: rowToLink(row), link_id, from_row_version, head: ctx.chain.head(), replayed: false, dry_run: false };
    }

    // remove
    if (!existing) {
      throw new SeaError('not_found', `no active ${input.link_type} link from ${from_id} to ${to_id}`, { from_id, to_id, link_type: input.link_type });
    }
    if (input.dry_run) {
      return { action: 'remove', link: rowToLink(existing), link_id: existing.link_id, from_row_version: from.row_version, head: ctx.chain.head(), replayed: false, dry_run: true };
    }
    const tombstoned_at = ctx.now.toISOString();
    const r = ctx.chain.append({
      event_type: EVENT.link_tombstoned,
      actor_id: ctx.actor,
    occurred_at: ctx.now.toISOString(),
      payload: {
        link_id: existing.link_id,
        // `target_id` is the generic subject key kronicle-lite's retraction classifier reads.
        target_id: existing.link_id,
        from_id,
        to_id,
        link_type: input.link_type,
        reason: input.reason ?? null,
        tombstoned_at,
        from_row_version: from.row_version + 1,
        ...(key !== undefined ? { request_hash: hash } : {}),
      },
      ...(key !== undefined ? { idempotency_key: key } : {}),
    });
    ctx.db
      .prepare(`UPDATE sea_links SET state = 'tombstoned', tombstoned_at = ?, tombstoned_by = ?, tombstone_seq = ? WHERE link_id = ?`)
      .run(tombstoned_at, ctx.actor, r.event.seq, existing.link_id);
    const from_row_version = bumpFrom(ctx, from_id, r.event.seq);
    return { action: 'remove', link: null, link_id: existing.link_id, from_row_version, head: ctx.chain.head(), replayed: false, dry_run: false };
  });
}
