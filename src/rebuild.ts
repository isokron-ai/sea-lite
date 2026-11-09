/**
 * Projection rebuild: drop the sea tables and replay every sea event from
 * the chain. This file is the authority on what each event type means to
 * the row model; the handlers must stay consistent with it (the
 * rebuild-equals-live test pins that).
 *
 * Refresh heartbeats are not chained, so a rebuilt lease expiry is the one
 * last chained — never later than the live one. Token hashes are replayed,
 * so a holder's token keeps fencing after a rebuild. Claim scopes are on
 * the `sea_ticket.claimed` payload and come back with the claim.
 */

import type { Chain, ChainEvent, Db } from 'kronicle-lite';

import { applyFieldsSet } from './audit/fields.js';
import { applyLeaseEvent } from './audit/lease.js';
import { EVENT } from './core/events.js';
import { SEA_DROP_SQL, SEA_POST_MIGRATION_SQL, SEA_SCHEMA_META_KEY, SEA_SCHEMA_SQL, SEA_SCHEMA_VERSION } from './db/schema.js';

export interface RebuildResult {
  events_seen: number;
  events_applied: number;
  tickets: number;
  links: number;
  notes: number;
  head: { seq: number; hash: string };
}

type P = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const n = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d);
const b = (v: unknown): boolean => v === true;

export function applySeaEvent(db: Db, ev: ChainEvent): boolean {
  const p = ev.payload as P;
  switch (ev.event_type) {
    case EVENT.ticket_created: {
      db.prepare(
        `INSERT OR REPLACE INTO sea_tickets (id, kind, title, body, status, priority, tags, assignee, duplicate_of, created_by,
           created_at, updated_at, row_version, project, created_seq, last_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(
        s(p['ticket_id']),
        s(p['kind']),
        s(p['title']),
        s(p['body']) ?? '',
        s(p['status']) ?? 'idea',
        s(p['priority']) ?? 'medium',
        JSON.stringify(Array.isArray(p['tags']) ? p['tags'] : []),
        s(p['assignee']),
        s(p['created_by']) ?? ev.actor_id,
        s(p['created_at']) ?? ev.occurred_at,
        s(p['created_at']) ?? ev.occurred_at,
        s(p['project']),
        ev.seq,
        ev.seq,
      );
      return true;
    }
    case EVENT.ticket_updated: {
      const changes = (p['changes'] ?? {}) as P;
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const col of ['title', 'body', 'kind', 'priority'] as const) {
        if (col in changes) {
          sets.push(`${col} = ?`);
          params.push(changes[col]);
        }
      }
      if ('assignee' in changes) {
        sets.push(`assignee = ?`);
        params.push(s(changes['assignee']));
      }
      if (Array.isArray(p['tags'])) {
        sets.push(`tags = ?`);
        params.push(JSON.stringify(p['tags']));
      }
      sets.push(`row_version = ?`, `updated_at = ?`, `last_seq = ?`, `claim_write_count = claim_write_count + 1`);
      params.push(n(p['row_version'], 1), s(p['updated_at']) ?? ev.occurred_at, ev.seq, s(p['ticket_id']));
      db.prepare(`UPDATE sea_tickets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      return true;
    }
    case EVENT.ticket_status_set: {
      db.prepare(
        `UPDATE sea_tickets SET status = ?, duplicate_of = COALESCE(?, duplicate_of), row_version = ?, updated_at = ?,
           claim_write_count = claim_write_count + 1, last_seq = ? WHERE id = ?`,
      ).run(s(p['to']), s(p['duplicate_of']), n(p['row_version'], 1), s(p['updated_at']) ?? ev.occurred_at, ev.seq, s(p['ticket_id']));
      if (b(p['claim_auto_released'])) clearClaim(db, s(p['ticket_id'])!, null);
      return true;
    }
    case EVENT.ticket_claimed: {
      const scope = p['scope'] as { paths?: unknown } | null | undefined;
      const scopeJson = scope && typeof scope === 'object' && Array.isArray(scope.paths) ? JSON.stringify(scope.paths) : null;
      db.prepare(
        `UPDATE sea_tickets SET claim_token_hash = ?, claim_actor = ?, claim_expires_at = ?, claim_write_count = 0, claim_scope = ?,
          claim_worktree = ?, claim_session = ?, claim_lease_seconds = ?, last_seq = ? WHERE id = ?`,
      ).run(
        s(p['claim_token_hash']),
        s(p['claim_actor']) ?? ev.actor_id,
        s(p['expires_at']),
        scopeJson,
        s(p['worktree']),
        s(p['claim_session']),
        typeof p['lease_seconds'] === 'number' ? p['lease_seconds'] : null,
        ev.seq,
        s(p['ticket_id']),
      );
      return true;
    }
    case EVENT.ticket_claim_released:
    case EVENT.ticket_claim_force_released:
    case EVENT.ticket_claim_expired: {
      clearClaim(db, s(p['ticket_id'])!, ev.seq);
      if (ev.event_type === EVENT.ticket_claim_released && p['handoff'] === true) {
        db.prepare(`INSERT OR REPLACE INTO sea_handoffs (ticket_id, actor, session, released_at, released_seq) VALUES (?, ?, ?, ?, ?)`).run(
          s(p['ticket_id']),
          s(p['claim_actor']) ?? ev.actor_id,
          s(p['claim_session']),
          ev.occurred_at,
          ev.seq,
        );
      }
      return true;
    }
    case EVENT.ticket_note_added: {
      db.prepare(
        `INSERT OR REPLACE INTO sea_notes (note_id, ticket_id, author, body, created_at, chain_seq) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(s(p['note_id']), s(p['ticket_id']), ev.actor_id, s(p['body']) ?? '', s(p['created_at']) ?? ev.occurred_at, ev.seq);
      db.prepare(`UPDATE sea_tickets SET last_seq = ? WHERE id = ?`).run(ev.seq, s(p['ticket_id']));
      return true;
    }
    case EVENT.link_created: {
      db.prepare(
        `INSERT OR REPLACE INTO sea_links (link_id, from_id, to_id, link_type, state, created_by, created_at, chain_seq)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      ).run(s(p['link_id']), s(p['from_id']), s(p['to_id']), s(p['link_type']), ev.actor_id, s(p['created_at']) ?? ev.occurred_at, ev.seq);
      // A link added through sea_link bumps the from ticket; a batch link does not.
      if (typeof p['from_row_version'] === 'number') {
        db.prepare(
          `UPDATE sea_tickets SET row_version = ?, updated_at = ?, claim_write_count = claim_write_count + 1, last_seq = ? WHERE id = ?`,
        ).run(p['from_row_version'], ev.occurred_at, ev.seq, s(p['from_id']));
      }
      return true;
    }
    case EVENT.link_tombstoned: {
      db.prepare(`UPDATE sea_links SET state = 'tombstoned', tombstoned_at = ?, tombstoned_by = ?, tombstone_seq = ? WHERE link_id = ?`).run(
        s(p['tombstoned_at']) ?? ev.occurred_at,
        ev.actor_id,
        ev.seq,
        s(p['link_id']),
      );
      if (typeof p['from_row_version'] === 'number') {
        db.prepare(
          `UPDATE sea_tickets SET row_version = ?, updated_at = ?, claim_write_count = claim_write_count + 1, last_seq = ? WHERE id = ?`,
        ).run(p['from_row_version'], ev.occurred_at, ev.seq, s(p['from_id']));
      }
      return true;
    }
    case EVENT.batch_applied:
      return true; // summary only; the member events carried the rows
    case EVENT.ticket_fields_set:
      applyFieldsSet(db, { ticket_id: s(p['ticket_id'])!, set: (p['set'] ?? {}) as P, unset: (p['unset'] ?? []) as string[], version: n(p['version'], 1) }, ev.seq);
      return true;
    case EVENT.lease_acquired:
    case EVENT.lease_released:
    case EVENT.lease_intent_opened:
    case EVENT.lease_intent_closed:
      return applyLeaseEvent(db, ev.event_type, p, ev.seq);
    default:
      return false;
  }
}

function clearClaim(db: Db, id: string, seq: number | null): void {
  if (seq === null) {
    db.prepare(
      `UPDATE sea_tickets SET claim_token_hash = NULL, claim_actor = NULL, claim_expires_at = NULL, claim_write_count = 0, claim_scope = NULL, claim_worktree = NULL, claim_session = NULL, claim_lease_seconds = NULL WHERE id = ?`,
    ).run(id);
  } else {
    db.prepare(
      `UPDATE sea_tickets SET claim_token_hash = NULL, claim_actor = NULL, claim_expires_at = NULL, claim_write_count = 0, claim_scope = NULL, claim_worktree = NULL,
         claim_session = NULL, claim_lease_seconds = NULL, last_seq = ? WHERE id = ?`,
    ).run(seq, id);
  }
}

/** Drop and replay. One transaction; the file is never left half-built. */
export function rebuild(db: Db, chain: Chain): RebuildResult {
  const run = db.transaction((): RebuildResult => {
    db.exec(SEA_DROP_SQL);
    db.exec(SEA_SCHEMA_SQL);
    db.exec(SEA_POST_MIGRATION_SQL);
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(SEA_SCHEMA_META_KEY, String(SEA_SCHEMA_VERSION));
    let seen = 0;
    let applied = 0;
    for (const ev of chain.iterate()) {
      if (!ev.event_type.startsWith('sea')) continue;
      seen++;
      if (applySeaEvent(db, ev)) applied++;
    }
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return {
      events_seen: seen,
      events_applied: applied,
      tickets: count('sea_tickets'),
      links: count('sea_links'),
      notes: count('sea_notes'),
      head: chain.head(),
    };
  });
  return run.immediate();
}

export interface SeaVerifyResult {
  chain: ReturnType<Chain['verify']>;
  rows_missing_chain_seq: { table: string; id: string; seq: number }[];
  ok: boolean;
}

/** Chain verification plus: every chain_seq a sea row points at must exist. */
export function verifySea(db: Db, chain: Chain): SeaVerifyResult {
  const chainResult = chain.verify();
  const missing: SeaVerifyResult['rows_missing_chain_seq'] = [];
  const check = (table: string, idCol: string, seqCol: string) => {
    // A table a newer build adds (sea_handoffs, 0.7.0) may not exist yet in a store this process has not opened for writing.
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) === undefined) return;
    const rows = db
      .prepare(`SELECT t.${idCol} AS id, t.${seqCol} AS seq FROM ${table} t LEFT JOIN events e ON e.seq = t.${seqCol} WHERE t.${seqCol} IS NOT NULL AND e.seq IS NULL`)
      .all() as { id: string; seq: number }[];
    for (const r of rows) missing.push({ table, id: r.id, seq: r.seq });
  };
  check('sea_tickets', 'id', 'created_seq');
  check('sea_tickets', 'id', 'last_seq');
  check('sea_links', 'link_id', 'chain_seq');
  check('sea_links', 'link_id', 'tombstone_seq');
  check('sea_notes', 'note_id', 'chain_seq');
  check('sea_fields', 'ticket_id', 'set_seq');
  check('sea_field_heads', 'ticket_id', 'last_seq');
  check('sea_leases', 'name', 'last_seq');
  check('sea_lease_intents', 'intent_id', 'opened_seq');
  check('sea_lease_intents', 'intent_id', 'closed_seq');
  check('sea_handoffs', 'ticket_id', 'released_seq');
  return { chain: chainResult, rows_missing_chain_seq: missing, ok: chainResult.ok && missing.length === 0 };
}
