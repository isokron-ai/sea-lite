/**
 * sea-lite tables, added to kronicle-lite's SQLite file. Every table is a
 * projection of chain events (`sea_ticket.*`, `sea_link.*`); `sea-lite
 * rebuild` drops and replays them. The meta key `sea_schema_version` is ours;
 * kronicle-lite's `schema_version` is untouched.
 *
 * v2 (0.2.0): `sea_tickets.claim_scope` — JSON array of the paths a live claim
 * locks (see core/scope.ts). Added with ALTER TABLE on older stores.
 *
 * v3 (0.3.0): `sea_tickets.claim_worktree` — the absolute worktree path a
 * live claim is bound to (`scope.worktree`), so `release-worktree` can free
 * it when the worktree is removed. Added with ALTER TABLE on older stores.
 *
 * v4 (0.4.0): `sea_tickets.project` — the project key the ticket was created
 * in (core/project.ts; NULL for tickets created before 0.4.0, which stay
 * visible in every project); `claim_session` — the holder's session
 * (core/identity.ts; a claim is the caller's own only when actor AND session
 * match); `claim_lease_seconds` — the lease length the claim was taken with,
 * which heartbeats renew by. All three are additive and come back on rebuild
 * from optional payload fields.
 */

import { ALL_STATES, LINK_STATES, LINK_TYPES, PRIORITIES, sqlIn, TICKET_KINDS } from '../model/enums.js';

export const SEA_SCHEMA_VERSION = 4;
export const SEA_SCHEMA_META_KEY = 'sea_schema_version';

export const SEA_TABLES = ['sea_lease_intents', 'sea_leases', 'sea_field_heads', 'sea_fields', 'sea_tickets_fts', 'sea_notes', 'sea_links', 'sea_tickets'] as const;

/**
 * 0.7.0 (audit orchestration): typed ticket fields and named exclusive
 * leases. New tables only, created on open; the schema version stays 4 so an
 * older sea-lite keeps opening the store (it ignores these tables and the
 * `sea_ticket.fields_set` / `sea_lease.*` events). Opening skips DDL only
 * when this table exists.
 */
export const SEA_NEWEST_TABLE = 'sea_lease_intents';

export const SEA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sea_tickets (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN (${sqlIn(TICKET_KINDS)})),
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL CHECK (status IN (${sqlIn(ALL_STATES)})),
  priority          TEXT NOT NULL CHECK (priority IN (${sqlIn(PRIORITIES)})),
  tags              TEXT NOT NULL DEFAULT '[]',
  assignee          TEXT,
  duplicate_of      TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  row_version       INTEGER NOT NULL DEFAULT 1,
  claim_token_hash  TEXT,
  claim_actor       TEXT,
  claim_expires_at  TEXT,
  claim_write_count INTEGER NOT NULL DEFAULT 0,
  claim_scope       TEXT,
  claim_worktree    TEXT,
  claim_session     TEXT,
  claim_lease_seconds INTEGER,
  project           TEXT,
  created_seq       INTEGER NOT NULL,
  last_seq          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sea_tickets_queue_idx ON sea_tickets (status, priority, created_at);
CREATE INDEX IF NOT EXISTS sea_tickets_claim_idx ON sea_tickets (claim_expires_at) WHERE claim_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sea_tickets_assignee_idx ON sea_tickets (assignee);

CREATE TABLE IF NOT EXISTS sea_links (
  link_id        TEXT PRIMARY KEY,
  from_id        TEXT NOT NULL REFERENCES sea_tickets(id),
  to_id          TEXT NOT NULL REFERENCES sea_tickets(id),
  link_type      TEXT NOT NULL CHECK (link_type IN (${sqlIn(LINK_TYPES)})),
  state          TEXT NOT NULL CHECK (state IN (${sqlIn(LINK_STATES)})),
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  chain_seq      INTEGER NOT NULL,
  tombstoned_at  TEXT,
  tombstoned_by  TEXT,
  tombstone_seq  INTEGER,
  CHECK (from_id <> to_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sea_links_active_uq ON sea_links (from_id, to_id, link_type) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS sea_links_from_idx ON sea_links (from_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS sea_links_to_idx ON sea_links (to_id) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS sea_notes (
  note_id    TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES sea_tickets(id),
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  chain_seq  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sea_notes_ticket_idx ON sea_notes (ticket_id, chain_seq);

-- Standalone FTS (not external-content) so a VACUUM renumbering sea_tickets'
-- implicit rowid cannot desynchronize it.
CREATE VIRTUAL TABLE IF NOT EXISTS sea_tickets_fts USING fts5(
  ticket_id UNINDEXED,
  title,
  body,
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS sea_tickets_fts_ai AFTER INSERT ON sea_tickets BEGIN
  INSERT INTO sea_tickets_fts(ticket_id, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS sea_tickets_fts_ad AFTER DELETE ON sea_tickets BEGIN
  DELETE FROM sea_tickets_fts WHERE ticket_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS sea_tickets_fts_au AFTER UPDATE OF title, body ON sea_tickets BEGIN
  DELETE FROM sea_tickets_fts WHERE ticket_id = old.id;
  INSERT INTO sea_tickets_fts(ticket_id, title, body) VALUES (new.id, new.title, new.body);
END;

-- Typed fields (audit/fields.ts): one row per set field; value is TEXT in the
-- field's declared type. Versioned per ticket in sea_field_heads, so the
-- ticket row (and older builds' rebuild of it) is untouched.
CREATE TABLE IF NOT EXISTS sea_fields (
  ticket_id TEXT NOT NULL REFERENCES sea_tickets(id),
  name      TEXT NOT NULL,
  value     TEXT NOT NULL,
  set_seq   INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, name)
);
CREATE INDEX IF NOT EXISTS sea_fields_lookup_idx ON sea_fields (name, value);
CREATE TABLE IF NOT EXISTS sea_field_heads (
  ticket_id TEXT PRIMARY KEY REFERENCES sea_tickets(id),
  version   INTEGER NOT NULL,
  last_seq  INTEGER NOT NULL
);

-- Named exclusive leases (audit/lease.ts) and their write-intent journal.
CREATE TABLE IF NOT EXISTS sea_leases (
  name           TEXT PRIMARY KEY,
  epoch          INTEGER NOT NULL,
  holder         TEXT,
  holder_session TEXT,
  token_hash     TEXT,
  expires_at     TEXT,
  lease_seconds  INTEGER,
  last_seq       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sea_lease_intents (
  intent_id       TEXT PRIMARY KEY,
  lease_name      TEXT NOT NULL,
  epoch           INTEGER NOT NULL,
  op              TEXT NOT NULL,
  target          TEXT,
  idempotency_key TEXT,
  state           TEXT NOT NULL CHECK (state IN ('open', 'happened', 'not_happened', 'may_have_happened')),
  opened_by       TEXT NOT NULL,
  opened_at       TEXT NOT NULL,
  opened_seq      INTEGER NOT NULL,
  closed_seq      INTEGER,
  evidence_ref    TEXT
);
CREATE INDEX IF NOT EXISTS sea_lease_intents_idx ON sea_lease_intents (lease_name, state);
`;

/**
 * Additive migrations, keyed by the schema version they bring the store up
 * to. Each statement must be safe to run on a store that already has the
 * change (checked via PRAGMA table_info before running).
 */
export const SEA_MIGRATIONS: readonly { version: number; table: string; column: string; sql: string }[] = [
  { version: 2, table: 'sea_tickets', column: 'claim_scope', sql: `ALTER TABLE sea_tickets ADD COLUMN claim_scope TEXT` },
  { version: 3, table: 'sea_tickets', column: 'claim_worktree', sql: `ALTER TABLE sea_tickets ADD COLUMN claim_worktree TEXT` },
  { version: 4, table: 'sea_tickets', column: 'claim_session', sql: `ALTER TABLE sea_tickets ADD COLUMN claim_session TEXT` },
  { version: 4, table: 'sea_tickets', column: 'claim_lease_seconds', sql: `ALTER TABLE sea_tickets ADD COLUMN claim_lease_seconds INTEGER` },
  { version: 4, table: 'sea_tickets', column: 'project', sql: `ALTER TABLE sea_tickets ADD COLUMN project TEXT` },
];

/** Indexes over migrated columns: created after the migrations so an old store has the column first. */
export const SEA_POST_MIGRATION_SQL = `CREATE INDEX IF NOT EXISTS sea_tickets_project_idx ON sea_tickets (project);`;

export const SEA_DROP_SQL = `
DROP TRIGGER IF EXISTS sea_tickets_fts_ai;
DROP TRIGGER IF EXISTS sea_tickets_fts_ad;
DROP TRIGGER IF EXISTS sea_tickets_fts_au;
${SEA_TABLES.map((t) => `DROP TABLE IF EXISTS ${t};`).join('\n')}
`;
