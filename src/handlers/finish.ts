/**
 * sea_finish: end your work on one or more held tickets in one call, with a
 * required outcome and note.
 *
 *   done      → resolved (terminal), claim released
 *   blocked   → blocked (not terminal: it can be resumed), claim released
 *   abandoned → dropped (terminal), claim released
 *
 * Each ticket is fenced by its own claim token; every ticket is checked
 * first and if any fails nothing is written. The note is chained as a
 * `sea_ticket.note_added` whose payload also carries `finish: {outcome,
 * commit, from, to}`, and the status_set payload carries `outcome` and
 * `commit`, so history shows why a ticket ended where it did. The note's
 * body leads with the outcome and commit (`done @ 3f2a9c1: …`) so
 * `sea_get` / `sea-lite show` show it too. With an idempotency_key, item k's
 * finish note is keyed `<key>#k` and a repeat replays.
 */

import { SeaError } from '../core/errors.js';
import { EVENT, idemKey } from '../core/events.js';
import { validateFence } from '../core/fence.js';
import { addNote, mustGetRow, resolveId, sweepExpired, tx, type Ctx } from '../core/repo.js';
import type { TicketStatus } from '../model/enums.js';
import { validateTransition } from '../model/lifecycle.js';
import { OUTCOME_STATUS, type FinishInput, type FinishOutcome } from '../model/schemas.js';
import { release } from './claims.js';
import { fencedItems, transition, type TransitionManyItem } from './tickets.js';

export interface FinishResult {
  outcome: FinishOutcome;
  finished: TransitionManyItem[];
  commit: string | null;
  replayed: boolean;
  dry_run: boolean;
}

interface FinishRecord {
  outcome: FinishOutcome;
  commit: string | null;
  from: TicketStatus;
  to: TicketStatus;
}

export function finishNoteBody(outcome: FinishOutcome, note: string, commit: string | null): string {
  return `${outcome}${commit !== null ? ` @ ${commit}` : ''}: ${note}`;
}

export function finish(ctx: Ctx, input: FinishInput): FinishResult {
  const items = fencedItems(input);
  const to: TicketStatus = OUTCOME_STATUS[input.outcome];
  const commit = input.commit?.toLowerCase() ?? null;
  const note = input.note.trim();
  const key = (k: number) => idemKey(input.idempotency_key !== undefined ? `${input.idempotency_key}#${k}` : undefined);
  const titleOf = (id: string) => (ctx.db.prepare(`SELECT title FROM sea_tickets WHERE id = ?`).get(id) as { title: string } | undefined)?.title ?? null;

  return tx(ctx.db, () => {
    // Replay: every item's finish note already chained under its key.
    if (input.idempotency_key !== undefined) {
      const prior = items.map((_, k) => ctx.chain.findByIdempotencyKey(key(k)!));
      if (prior.every((p) => p !== null && p !== undefined)) {
        const finished = prior.map((p) => {
          if (p!.event_type !== EVENT.ticket_note_added || p!.payload['finish'] === undefined) {
            throw new SeaError('invalid_input', `idempotency_key was used for a different operation (${p!.event_type})`);
          }
          const f = p!.payload['finish'] as FinishRecord;
          const id = String(p!.payload['ticket_id']);
          return { ticket_id: id, title: titleOf(id), from: f.from, to: f.to, claim_released: true };
        });
        return { outcome: input.outcome, finished, commit, replayed: true, dry_run: false };
      }
    }

    // Check every ticket before writing anything.
    const problems: { ticket_id: string; error: string; message: string; details?: Record<string, unknown> }[] = [];
    const plan: { id: string; token: string; from: TicketStatus; move: boolean }[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      try {
        const id = resolveId(ctx.db, it.ticket_id);
        if (seen.has(id)) throw new SeaError('invalid_input', `ticket ${id} appears more than once`, { ticket_id: id });
        seen.add(id);
        const row = sweepExpired(ctx, mustGetRow(ctx.db, id));
        validateFence(row, it.claim_token, ctx.actor, ctx.now);
        if (it.expected_version !== undefined && row.row_version !== it.expected_version) {
          throw new SeaError('version_conflict', `ticket ${id} is at row_version ${row.row_version}, expected ${it.expected_version}`, {
            ticket_id: id,
            expected_version: it.expected_version,
            current_version: row.row_version,
          });
        }
        // Already blocked + outcome blocked: no status change, just the note and the release.
        const move = row.status !== to;
        if (move) {
          const v = validateTransition(row.status, to, ctx.lifecycle);
          if (!v.allowed) {
            throw new SeaError('illegal_transition', `${row.status} → ${to} (outcome ${input.outcome}): ${v.message}`, {
              ticket_id: id,
              from: row.status,
              to,
              reason: v.reason,
              legal_next: v.legal_next ?? [],
            });
          }
        }
        plan.push({ id, token: it.claim_token, from: row.status, move });
      } catch (e) {
        if (!(e instanceof SeaError)) throw e;
        if (items.length === 1) throw e;
        const j = e.toJSON() as { error: string; message: string; details?: Record<string, unknown> };
        problems.push({ ticket_id: it.ticket_id, error: j.error, message: j.message, ...(j.details !== undefined ? { details: j.details } : {}) });
      }
    }
    if (problems.length > 0) {
      throw new SeaError('batch_invalid', `${problems.length} of ${items.length} ticket(s) cannot finish as ${input.outcome}; nothing changed`, { problems });
    }
    const view = (p: (typeof plan)[number]): TransitionManyItem => ({ ticket_id: p.id, title: titleOf(p.id), from: p.from, to, claim_released: true });
    if (input.dry_run) return { outcome: input.outcome, finished: plan.map(view), commit, replayed: false, dry_run: true };

    const record = (p: (typeof plan)[number]): FinishRecord => ({ outcome: input.outcome, commit, from: p.from, to });
    plan.forEach((p, k) => {
      // A terminal status releases the claim itself; blocked is not terminal, so release explicitly after the note.
      if (p.move) transition(ctx, { ticket_id: p.id, claim_token: p.token, to, confirm: true, dry_run: false, reason: `finish: ${input.outcome}` }, { outcome: input.outcome, commit });
      addNote(ctx, p.id, finishNoteBody(input.outcome, note, commit), { finish: record(p) }, key(k));
      if (to === 'blocked') release(ctx, { ticket_id: p.id, claim_token: p.token, force: false, reason: `finish: ${input.outcome}` });
    });
    return { outcome: input.outcome, finished: plan.map(view), commit, replayed: false, dry_run: false };
  });
}
