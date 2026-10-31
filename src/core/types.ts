import type { LinkType, Priority, TicketKind, TicketStatus } from '../model/enums.js';

/** Row shape of sea_tickets. */
export interface TicketRow {
  id: string;
  kind: TicketKind;
  title: string;
  body: string;
  status: TicketStatus;
  priority: Priority;
  tags: string; // JSON array
  assignee: string | null;
  duplicate_of: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  row_version: number;
  claim_token_hash: string | null;
  claim_actor: string | null;
  claim_expires_at: string | null;
  claim_write_count: number;
  created_seq: number;
  last_seq: number;
}

export interface LinkRow {
  link_id: string;
  from_id: string;
  to_id: string;
  link_type: LinkType;
  state: 'active' | 'tombstoned';
  created_by: string;
  created_at: string;
  chain_seq: number;
  tombstoned_at: string | null;
  tombstoned_by: string | null;
  tombstone_seq: number | null;
}

export interface NoteRow {
  note_id: string;
  ticket_id: string;
  author: string;
  body: string;
  created_at: string;
  chain_seq: number;
}

/** Public claim view: who holds it and until when. Never the token or its hash. */
export interface ClaimView {
  holder: string;
  expires_at: string;
  write_count: number;
}

/** What tools return. The token hash never leaves the row/chain. */
export interface Ticket {
  id: string;
  kind: TicketKind;
  title: string;
  body: string;
  status: TicketStatus;
  priority: Priority;
  tags: string[];
  assignee: string | null;
  duplicate_of: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  row_version: number;
  claim: ClaimView | null;
  created_seq: number;
  last_seq: number;
}

export interface TicketCompact {
  id: string;
  kind: TicketKind;
  title: string;
  status: TicketStatus;
  priority: Priority;
  tags: string[];
  assignee: string | null;
  claim: ClaimView | null;
  row_version: number;
  updated_at: string;
}

export interface LinkView {
  link_id: string;
  from_id: string;
  to_id: string;
  link_type: LinkType;
  created_by: string;
  created_at: string;
  chain_seq: number;
}

export function parseTags(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function rowToTicket(r: TicketRow): Ticket {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    status: r.status,
    priority: r.priority,
    tags: parseTags(r.tags),
    assignee: r.assignee,
    duplicate_of: r.duplicate_of,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    row_version: r.row_version,
    claim:
      r.claim_token_hash !== null && r.claim_actor !== null && r.claim_expires_at !== null
        ? { holder: r.claim_actor, expires_at: r.claim_expires_at, write_count: r.claim_write_count }
        : null,
    created_seq: r.created_seq,
    last_seq: r.last_seq,
  };
}

export function toCompact(t: Ticket): TicketCompact {
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    status: t.status,
    priority: t.priority,
    tags: t.tags,
    assignee: t.assignee,
    claim: t.claim,
    row_version: t.row_version,
    updated_at: t.updated_at,
  };
}

export function rowToLink(r: LinkRow): LinkView {
  return {
    link_id: r.link_id,
    from_id: r.from_id,
    to_id: r.to_id,
    link_type: r.link_type,
    created_by: r.created_by,
    created_at: r.created_at,
    chain_seq: r.chain_seq,
  };
}
