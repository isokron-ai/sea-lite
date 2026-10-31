/**
 * Non-blocking duplicate detection on create: exact case-insensitive title
 * match plus FTS5 (bm25) over titles. Never prevents a write; the author
 * decides.
 */

import type { Db } from 'kronicle-lite';

import type { TicketStatus } from '../model/enums.js';

export interface PossibleDuplicate {
  ticket_id: string;
  title: string;
  status: TicketStatus;
  /** Higher is more similar. Exact title matches are reported as 1. */
  score: number;
  exact_title_match: boolean;
}

/** Turn free text into an FTS5 expression over the title column: quoted words OR-ed. */
export function titleMatchExpression(title: string): string | null {
  const words = title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
  if (words.length === 0) return null;
  const unique = [...new Set(words)].slice(0, 12);
  return `title : (${unique.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR ')})`;
}

export function findPossibleDuplicates(db: Db, title: string, excludeIds: readonly string[] = [], limit = 5): PossibleDuplicate[] {
  const out = new Map<string, PossibleDuplicate>();
  const exact = db
    .prepare(`SELECT id, title, status FROM sea_tickets WHERE lower(title) = lower(?) ORDER BY created_at LIMIT ?`)
    .all(title, limit) as { id: string; title: string; status: TicketStatus }[];
  for (const r of exact) {
    if (excludeIds.includes(r.id)) continue;
    out.set(r.id, { ticket_id: r.id, title: r.title, status: r.status, score: 1, exact_title_match: true });
  }
  const expr = titleMatchExpression(title);
  if (expr) {
    let rows: { ticket_id: string; title: string; status: TicketStatus; rank: number }[] = [];
    try {
      rows = db
        .prepare(
          `SELECT f.ticket_id, t.title, t.status, bm25(sea_tickets_fts) AS rank
             FROM sea_tickets_fts f JOIN sea_tickets t ON t.id = f.ticket_id
            WHERE sea_tickets_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(expr, limit * 2) as typeof rows;
    } catch {
      rows = []; // an unparseable expression is not an error for the caller
    }
    for (const r of rows) {
      if (excludeIds.includes(r.ticket_id) || out.has(r.ticket_id)) continue;
      // bm25 is negative and more negative is better; fold into (0, 1).
      const score = Math.min(0.99, Math.max(0.01, -r.rank / 10));
      out.set(r.ticket_id, { ticket_id: r.ticket_id, title: r.title, status: r.status, score, exact_title_match: false });
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
