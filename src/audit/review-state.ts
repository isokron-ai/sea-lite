/**
 * The review state of a finding (#6, #8): what the reviewer decided on, and
 * when a write sends that decision back to `pending`. Shared by the audit
 * layer and by every other path that can change a finding or a gate ticket
 * (`sea_update`, library `setFields`), so none of them can change what was
 * approved without reopening it (#8 stack review). No import of the ticket
 * handlers, which call into this module.
 */

import type { Ctx } from '../core/repo.js';
import { FIELD_NAMES, GATES, prepareFields, readFields, setFields, type FieldName } from './fields.js';

export function byField(ctx: Ctx, audit_id: string, name: FieldName, value: string, extra?: { name: FieldName; value: string }): string | null {
  const r = ctx.db
    .prepare(
      `SELECT f.ticket_id AS id FROM sea_fields f
         JOIN sea_fields a ON a.ticket_id = f.ticket_id AND a.name = 'audit_id' AND a.value = ?
         ${extra ? `JOIN sea_fields x ON x.ticket_id = f.ticket_id AND x.name = ? AND x.value = ?` : ''}
        WHERE f.name = ? AND f.value = ? ORDER BY f.set_seq LIMIT 1`,
    )
    .get(audit_id, ...(extra ? [extra.name, extra.value] : []), name, value) as { id: string } | undefined;
  return r?.id ?? null;
}

/**
 * Tracker bookkeeping: changing these never reopens a decision. #8: the plan
 * and note a reviewer approved with (`submit_plan`, `review_note`) are part
 * of the decision, so a finding write or an import that changes them reopens
 * it; the reviewer changes them through `auditReview`.
 */
export const REVIEW_NEUTRAL: readonly string[] = ['pr_or_issue', 'submitted_date', 'tracker_status'];

function gatesResolved(ctx: Ctx, audit_id: string, finding_id: string): boolean {
  for (const g of GATES) {
    const id = byField(ctx, audit_id, 'gate_of', finding_id, { name: 'gate', value: g });
    const r = id ? readFields(ctx.db, id).result : undefined;
    if (r === undefined || r === 'pending') return false;
  }
  return true;
}

/**
 * The review state after a write (#6). Unresolved gates: out of the queue
 * (no review state), whatever was decided. All resolved: queued when new;
 * and a decision (approved / rejected / hold) goes back to `pending` when
 * the write changed substance (title, a non-bookkeeping field, a gate's
 * result, note or evidence), since it was made about the finding as it was.
 * Returns 'pending' when this write (re)queued the finding.
 */
export function reconcileReview(ctx: Ctx, audit_id: string, finding_ticket: string, finding_id: string, substance: boolean): 'pending' | undefined {
  const cur = readFields(ctx.db, finding_ticket).review;
  let next: string | undefined = cur === undefined ? undefined : String(cur);
  if (!gatesResolved(ctx, audit_id, finding_id)) next = undefined;
  else if (next === undefined || (substance && next !== 'pending')) next = 'pending';
  if (next !== cur) setFields(ctx, finding_ticket, prepareFields({ review: next ?? null }, true)); // an enum: nothing to scan
  return next === 'pending' && cur !== 'pending' ? 'pending' : undefined;
}

/** Gate fields whose change is a change of substance. */
export const GATE_SUBSTANCE: readonly string[] = ['result', 'note', 'evidence_ref'];

/** Ticket columns a reviewer sees (export / queue): changing them reopens a decision. */
const TICKET_SUBSTANCE: readonly string[] = ['title', 'body'];

/**
 * After a write outside the audit layer's own finding / gate calls: when
 * `ticket_id` is a finding or a gate ticket and `changed` (ticket columns or
 * field names) holds something the reviewer decided on, reconcile the
 * finding's review (a decision goes back to `pending`). Caller holds the
 * transaction. Reviewer-decided fields: the title and body, every finding
 * field except tracker bookkeeping (REVIEW_NEUTRAL) and `review` itself,
 * and a gate's result / note / evidence_ref.
 */
export function reopenAfterWrite(ctx: Ctx, ticket_id: string, changed: readonly string[]): void {
  const f = readFields(ctx.db, ticket_id);
  if (f.audit_id === undefined) return;
  const audit_id = String(f.audit_id);
  if (f.finding_id !== undefined) {
    const substance = changed.some(
      (c) => TICKET_SUBSTANCE.includes(c) || ((FIELD_NAMES as readonly string[]).includes(c) && c !== 'review' && !REVIEW_NEUTRAL.includes(c)),
    );
    if (substance) reconcileReview(ctx, audit_id, ticket_id, String(f.finding_id), true);
  } else if (f.gate_of !== undefined) {
    if (!changed.some((c) => GATE_SUBSTANCE.includes(c))) return;
    const fid = byField(ctx, audit_id, 'finding_id', String(f.gate_of));
    if (fid !== null) reconcileReview(ctx, audit_id, fid, String(f.gate_of), true);
  }
}
