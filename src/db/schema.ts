/**
 * sea-lite tables, added to kronicle-lite's SQLite file. Every table is a
 * projection of chain events (`sea_ticket.*`, `sea_link.*`); `sea-lite
 * rebuild` drops and replays them. The meta key `sea_schema_version` is ours;
 * kronicle-lite's `schema_version` is untouched.
 *
 * v2 (0.2.0): `sea_tickets.claim_scope` — JSON array of the paths a live claim
 * locks (see core/scope.ts). Added with ALTER TABLE on older stores.
 */

import { ALL_STATES, LINK_STATES, LINK_TYPES, PRIORITIES, sqlIn, TICKET_KINDS } from '../model/enums.js';

export const SEA_SCHEMA_VERSION = 2;
export const SEA_SCHEMA_META_KEY = 'sea_schema_version';

export const SEA_TABLES = ['sea_tickets_fts', 'sea_notes', 'sea_links', 'sea_tickets'] as const;

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
`;

/**
 * Additive migrations, keyed by the schema version they bring the store up
 * to. Each statement must be safe to run on a store that already has the
 * change (checked via PRAGMA table_info before running).
 */
export const SEA_MIGRATIONS: readonly { version: number; table: string; column: string; sql: string }[] = [
  { version: 2, table: 'sea_tickets', column: 'claim_scope', sql: `ALTER TABLE sea_tickets ADD COLUMN claim_scope TEXT` },
];

export const SEA_DROP_SQL = `
DROP TRIGGER IF EXISTS sea_tickets_fts_ai;
DROP TRIGGER IF EXISTS sea_tickets_fts_ad;
DROP TRIGGER IF EXISTS sea_tickets_fts_au;
${SEA_TABLES.map((t) => `DROP TABLE IF EXISTS ${t};`).join('\n')}
`;
