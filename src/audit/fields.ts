/**
 * Typed ticket fields (0.7.0). A closed registry: every name has a type and
 * an unknown name is `invalid_input`, so a typo cannot create a column. Each
 * write is one `sea_ticket.fields_set` event carrying only what changed
 * (`set` / `unset`) and the ticket's new fields version; a write that changes
 * nothing writes nothing. The ticket row is not touched (its row_version is
 * the ticket's own), so older builds' rebuild stays exact.
 */

import { z } from 'zod';

import { EVENT } from '../core/events.js';
import { SeaError } from '../core/errors.js';
import { mustGetRow, type Ctx } from '../core/repo.js';
import { redactSecrets, type Db } from 'kronicle-lite';

const text = (max: number) => z.string().max(max);
const token = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:@/#+-]+$/, 'letters, digits and ._:@/#+- only');

export const VERDICTS = ['bug', 'design-gap', 'feature-proposal', 'intended', 'not-reproduced', 'our-own-error', 'duplicate'] as const;
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const CONFIDENCES = ['high', 'medium', 'low'] as const;
/** The tracker's status dropdown (mk3.py), kept verbatim so exports match it. */
export const TRACKER_STATUSES = ['Not started', 'In progress', 'Draft PR open', 'PR open', 'Issue filed', 'Comment posted', 'Reported privately', 'Merged', 'Closed', 'Skipped'] as const;
export const GATES = ['repro', 'intent', 'docs', 'prior_reports', 'refuter'] as const;
export type Gate = (typeof GATES)[number];
export const GATE_RESULTS = ['pending', 'pass', 'fail', 'n/a'] as const;
export const REVIEW_STATES = ['pending', 'approved', 'rejected', 'hold'] as const;

export const FIELD_TYPES = {
  // identity
  audit_id: token,
  finding_id: token,
  gate_of: token,
  gate: z.enum(GATES),
  // finding
  source_pass: text(200),
  verdict: z.enum(VERDICTS),
  severity: z.enum(SEVERITIES),
  confidence: z.enum(CONFIDENCES),
  refuter_verdict: text(200),
  submit_ready: text(200),
  merged_into: text(200),
  submit_plan: text(500),
  component: text(200),
  root_cause: text(4000),
  affected_count: z.number().int().min(0),
  summary: text(8000),
  evidence: text(8000),
  measured_impact: text(4000),
  proposed_fix: text(8000),
  fix_difficulty: text(200),
  pr_or_issue: text(500),
  submitted_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  tracker_status: z.enum(TRACKER_STATUSES),
  catalog_fingerprint: token,
  /** kronicle event id (or seq) of the evidence. */
  evidence_ref: token,
  review: z.enum(REVIEW_STATES),
  review_note: text(4000),
  // gate tickets
  result: z.enum(GATE_RESULTS),
  note: text(8000),
} as const;
export type FieldName = keyof typeof FIELD_TYPES;
export type FieldValue = string | number;
export type FieldMap = Partial<Record<FieldName, FieldValue>>;
export const FIELD_NAMES = Object.keys(FIELD_TYPES) as FieldName[];

/** Set only by the audit layer (identity, gate results, the review decision), never by a caller's patch. */
export const MANAGED_FIELDS: readonly FieldName[] = ['audit_id', 'finding_id', 'gate_of', 'gate', 'result', 'review'];

/** Validate a patch: known names, typed values; null unsets. */
export function parseFields(patch: Record<string, unknown>, managed = false): Record<FieldName, FieldValue | null> {
  const out = {} as Record<FieldName, FieldValue | null>;
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.hasOwn(FIELD_TYPES, k)) throw new SeaError('invalid_input', `unknown field "${k}"`, { field: k, known: FIELD_NAMES });
    const name = k as FieldName;
    if (!managed && MANAGED_FIELDS.includes(name)) throw new SeaError('invalid_input', `field "${k}" is managed by sea-lite`, { field: k });
    if (v === null || v === undefined) {
      out[name] = null;
      continue;
    }
    const r = (FIELD_TYPES[name] as z.ZodType).safeParse(v);
    if (!r.success) throw new SeaError('invalid_input', `field "${k}": ${r.error.issues[0]?.message ?? 'invalid'}`, { field: k });
    out[name] = r.data as FieldValue;
  }
  return out;
}

function decode(name: string, raw: string): FieldValue {
  return name === 'affected_count' ? Number(raw) : raw;
}

export function readFields(db: Db, ticket_id: string): FieldMap {
  const rows = db.prepare(`SELECT name, value FROM sea_fields WHERE ticket_id = ?`).all(ticket_id) as { name: string; value: string }[];
  const out: FieldMap = {};
  for (const r of rows) out[r.name as FieldName] = decode(r.name, r.value);
  return out;
}

export function fieldsVersion(db: Db, ticket_id: string): number {
  return (db.prepare(`SELECT version FROM sea_field_heads WHERE ticket_id = ?`).get(ticket_id) as { version: number } | undefined)?.version ?? 0;
}

export interface SetFieldsResult {
  ticket_id: string;
  /** Fields version after the write (unchanged when nothing changed). */
  version: number;
  /** Names whose value changed (set or unset). Empty: nothing written. */
  changed: FieldName[];
  /** Names whose text had a credential-shaped part replaced by `[REDACTED:<detector>]` before it was chained. */
  redacted?: FieldName[];
}

/** PostHog personal API keys, which kronicle-lite's write-time detectors do not know. */
const EXTRA_SECRETS = /\bphx_[A-Za-z0-9]{20,}\b/g;

/**
 * why: the chain is append-only, so a credential pasted into evidence would
 * stay in every export and backup. kronicle-lite's write-time redaction, plus
 * the vendor key shapes audits handle.
 */
export function redactText(text: string, field: string): { text: string; redacted: boolean } {
  const r = redactSecrets(text, field);
  const out = r.text.replace(EXTRA_SECRETS, '[REDACTED:posthog_personal_key]');
  return { text: out, redacted: r.findings.length > 0 || out !== r.text };
}

/** Caller holds the transaction. `expect_version` guards against a concurrent writer; `managed` is for the audit layer only. */
export function setFields(ctx: Ctx, ticket_id: string, patch: Record<string, unknown>, expect_version?: number, opts: { managed?: boolean } = {}): SetFieldsResult {
  mustGetRow(ctx.db, ticket_id);
  const parsed = parseFields(patch, opts.managed === true);
  const redacted: FieldName[] = [];
  for (const [k, v] of Object.entries(parsed) as [FieldName, FieldValue | null][]) {
    if (typeof v !== 'string') continue;
    const r = redactText(v, k);
    if (r.redacted) {
      parsed[k] = r.text;
      redacted.push(k);
    }
  }
  const current = readFields(ctx.db, ticket_id);
  const version = fieldsVersion(ctx.db, ticket_id);
  if (expect_version !== undefined && expect_version !== version) {
    throw new SeaError('version_conflict', `fields of ${ticket_id} are at version ${version}, not ${expect_version}`, { ticket_id, version });
  }
  const set: FieldMap = {};
  const unset: FieldName[] = [];
  for (const [k, v] of Object.entries(parsed) as [FieldName, FieldValue | null][]) {
    if (v === null) {
      if (current[k] !== undefined) unset.push(k);
    } else if (current[k] !== v) set[k] = v;
  }
  const changed = [...(Object.keys(set) as FieldName[]), ...unset];
  const red = redacted.length > 0 ? { redacted } : {};
  if (changed.length === 0) return { ticket_id, version, changed, ...red };
  const next = version + 1;
  const r = ctx.chain.append({
    event_type: EVENT.ticket_fields_set,
    actor_id: ctx.actor,
    occurred_at: ctx.now.toISOString(),
    payload: { ticket_id, set, unset, version: next },
  });
  applyFieldsSet(ctx.db, { ticket_id, set, unset, version: next }, r.event.seq);
  return { ticket_id, version: next, changed, ...red };
}

/** The projection of one `sea_ticket.fields_set` (live and rebuild). */
export function applyFieldsSet(db: Db, p: { ticket_id: string; set: Record<string, unknown>; unset: readonly string[]; version: number }, seq: number): void {
  const up = db.prepare(`INSERT INTO sea_fields (ticket_id, name, value, set_seq) VALUES (?, ?, ?, ?) ON CONFLICT (ticket_id, name) DO UPDATE SET value = excluded.value, set_seq = excluded.set_seq`);
  for (const [k, v] of Object.entries(p.set)) up.run(p.ticket_id, k, String(v), seq);
  const del = db.prepare(`DELETE FROM sea_fields WHERE ticket_id = ? AND name = ?`);
  for (const k of p.unset) del.run(p.ticket_id, k);
  db.prepare(`INSERT INTO sea_field_heads (ticket_id, version, last_seq) VALUES (?, ?, ?) ON CONFLICT (ticket_id) DO UPDATE SET version = excluded.version, last_seq = excluded.last_seq`).run(
    p.ticket_id,
    p.version,
    seq,
  );
}
