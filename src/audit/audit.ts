/**
 * Audit orchestration (0.7.0), driven by code (the mcp-audit runner), never by
 * agents: no MCP tools. An audit is an epic ticket in project
 * `audit:<audit_id>`, so its tickets stay out of every code project's queue
 * and views. A finding ticket is created only after refutation, with five gate
 * sub-tickets (repro, intent, docs, prior_reports, refuter) linked
 * `parent_of`; gate results and finding metadata are typed fields
 * (audit/fields.ts). Once every gate has a result the finding enters the
 * human review queue (`review: pending`); a human approves, rejects or holds
 * it. Results are ids, versions and changed field names, never whole
 * entities.
 */

import { SeaError } from '../core/errors.js';
import { EVENT } from '../core/events.js';
import { tx, type Ctx } from '../core/repo.js';
import { insertLink, insertTicket } from '../handlers/tickets.js';
import { GATES, readFields, setFields, type FieldMap, type FieldName, type Gate } from './fields.js';

export const AUDIT_PROJECT_PREFIX = 'audit:';
const AUDIT_ID = /^[A-Za-z0-9._-]{1,100}$/;

export function auditProject(audit_id: string): string {
  if (!AUDIT_ID.test(audit_id)) throw new SeaError('invalid_input', 'audit_id: 1-100 of letters, digits and ._-', { audit_id });
  return AUDIT_PROJECT_PREFIX + audit_id;
}

function inAudit(ctx: Ctx, audit_id: string): Ctx {
  return { ...ctx, project: auditProject(audit_id) };
}

function byField(ctx: Ctx, audit_id: string, name: FieldName, value: string, extra?: { name: FieldName; value: string }): string | null {
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

function epicOf(ctx: Ctx, audit_id: string): string {
  const id = ctx.db
    .prepare(
      `SELECT a.ticket_id AS id FROM sea_fields a JOIN sea_tickets t ON t.id = a.ticket_id
        WHERE a.name = 'audit_id' AND a.value = ? AND t.kind = 'epic' ORDER BY a.set_seq LIMIT 1`,
    )
    .get(audit_id) as { id: string } | undefined;
  if (!id) throw new SeaError('not_found', `audit ${audit_id} not found (open it first)`, { audit_id });
  return id.id;
}

export interface OpenAuditResult {
  ticket_id: string;
  created: boolean;
}

/** Idempotent by audit_id. */
export function openAudit(ctx0: Ctx, input: { audit_id: string; title: string; catalog_fingerprint?: string }): OpenAuditResult {
  const ctx = inAudit(ctx0, input.audit_id);
  return tx(ctx.db, () => {
    const existing = ctx.db
      .prepare(`SELECT a.ticket_id AS id FROM sea_fields a JOIN sea_tickets t ON t.id = a.ticket_id WHERE a.name = 'audit_id' AND a.value = ? AND t.kind = 'epic'`)
      .get(input.audit_id) as { id: string } | undefined;
    if (existing) {
      if (input.catalog_fingerprint !== undefined) setFields(ctx, existing.id, { catalog_fingerprint: input.catalog_fingerprint });
      return { ticket_id: existing.id, created: false };
    }
    const { row } = insertTicket(ctx, { title: input.title, body: '', kind: 'epic', priority: 'medium', tags: ['audit'], assignee: ctx.actor, status: 'triaged' });
    setFields(ctx, row.id, { audit_id: input.audit_id, ...(input.catalog_fingerprint !== undefined ? { catalog_fingerprint: input.catalog_fingerprint } : {}) });
    return { ticket_id: row.id, created: true };
  });
}

export type GateInput = { result: string; note?: string; evidence_ref?: string };

export interface FindingInput {
  finding_id: string;
  title: string;
  /** Finding fields (verdict, severity, …); identity fields are set for you. */
  fields?: Record<string, unknown>;
  gates?: Partial<Record<Gate, GateInput>>;
}

export interface UpsertFindingResult {
  ticket_id: string;
  created: boolean;
  version: number;
  changed: string[];
  /** Set when this write moved the finding into the review queue. */
  review?: 'pending';
}

const IDENTITY: readonly string[] = ['audit_id', 'finding_id', 'gate_of', 'gate', 'review'];

function reviewIfReady(ctx: Ctx, audit_id: string, finding_ticket: string, finding_id: string): boolean {
  const f = readFields(ctx.db, finding_ticket);
  if (f.review !== undefined) return false;
  for (const g of GATES) {
    const id = byField(ctx, audit_id, 'gate_of', finding_id, { name: 'gate', value: g });
    const r = id ? readFields(ctx.db, id).result : undefined;
    if (r === undefined || r === 'pending') return false;
  }
  setFields(ctx, finding_ticket, { review: 'pending' });
  return true;
}

function setTitle(ctx: Ctx, id: string, title: string): boolean {
  const row = ctx.db.prepare(`SELECT title, row_version FROM sea_tickets WHERE id = ?`).get(id) as { title: string; row_version: number };
  if (row.title === title) return false;
  const row_version = row.row_version + 1;
  const updated_at = ctx.now.toISOString();
  const r = ctx.chain.append({
    event_type: EVENT.ticket_updated,
    actor_id: ctx.actor,
    occurred_at: updated_at,
    payload: { ticket_id: id, changes: { title }, row_version, updated_at },
  });
  ctx.db
    .prepare(`UPDATE sea_tickets SET title = ?, row_version = ?, updated_at = ?, last_seq = ?, claim_write_count = claim_write_count + 1 WHERE id = ?`)
    .run(title, row_version, updated_at, r.event.seq, id);
  return true;
}

/**
 * Create a refuted finding with its five gate sub-tickets, or update it:
 * idempotent by (audit, finding_id). Writes only what changed; a repeat of
 * the same input writes nothing.
 */
export function upsertFinding(ctx0: Ctx, audit_id: string, input: FindingInput): UpsertFindingResult {
  const ctx = inAudit(ctx0, audit_id);
  if (input.title.length === 0 || input.title.length > 500) throw new SeaError('invalid_input', 'title: 1-500 characters');
  for (const k of Object.keys(input.fields ?? {})) {
    if (IDENTITY.includes(k)) throw new SeaError('invalid_input', `field "${k}" is managed by sea-lite`, { field: k });
  }
  return tx(ctx.db, () => {
    const epic = epicOf(ctx, audit_id);
    let id = byField(ctx, audit_id, 'finding_id', input.finding_id);
    const created = id === null;
    const changed: string[] = [];
    if (id === null) {
      id = insertTicket(ctx, { title: input.title, body: '', kind: 'investigation', priority: 'medium', tags: ['audit', 'finding'], assignee: ctx.actor, status: 'triaged' }).row.id;
      insertLink(ctx, epic, id, 'parent_of');
      setFields(ctx, id, { audit_id, finding_id: input.finding_id, tracker_status: 'Not started' });
      for (const g of GATES) {
        const gid = insertTicket(ctx, { title: `${g}: ${input.finding_id}`, body: '', kind: 'chore', priority: 'medium', tags: ['audit', 'gate'], assignee: ctx.actor, status: 'triaged' }).row.id;
        insertLink(ctx, id, gid, 'parent_of');
        setFields(ctx, gid, { audit_id, gate_of: input.finding_id, gate: g, result: 'pending' });
      }
    } else if (setTitle(ctx, id, input.title)) changed.push('title');
    const r = setFields(ctx, id, input.fields ?? {});
    changed.push(...r.changed);
    for (const [g, v] of Object.entries(input.gates ?? {}) as [Gate, GateInput][]) {
      const gr = gateWrite(ctx, audit_id, input.finding_id, g, v);
      if (gr.length > 0) changed.push(`gate.${g}`);
    }
    const queued = reviewIfReady(ctx, audit_id, id, input.finding_id);
    const version = readVersion(ctx, id);
    return { ticket_id: id, created, version, changed, ...(queued ? { review: 'pending' as const } : {}) };
  });
}

function readVersion(ctx: Ctx, id: string): number {
  return (ctx.db.prepare(`SELECT version FROM sea_field_heads WHERE ticket_id = ?`).get(id) as { version: number } | undefined)?.version ?? 0;
}

function gateWrite(ctx: Ctx, audit_id: string, finding_id: string, gate: Gate, v: GateInput): string[] {
  if (!(GATES as readonly string[]).includes(gate)) throw new SeaError('invalid_input', `gate must be one of ${GATES.join(', ')}`, { gate });
  const gid = byField(ctx, audit_id, 'gate_of', finding_id, { name: 'gate', value: gate });
  if (!gid) throw new SeaError('not_found', `finding ${finding_id} not found in audit ${audit_id}`, { finding_id });
  return setFields(ctx, gid, { result: v.result, note: v.note ?? null, evidence_ref: v.evidence_ref ?? null }).changed;
}

/** Record one gate's result. Returns the gate ticket and what changed. */
export function recordGate(ctx0: Ctx, audit_id: string, input: { finding_id: string; gate: Gate } & GateInput): { ticket_id: string; changed: string[]; review?: 'pending' } {
  const ctx = inAudit(ctx0, audit_id);
  return tx(ctx.db, () => {
    const changed = gateWrite(ctx, audit_id, input.finding_id, input.gate, input);
    const fid = byField(ctx, audit_id, 'finding_id', input.finding_id)!;
    const queued = reviewIfReady(ctx, audit_id, fid, input.finding_id);
    const gid = byField(ctx, audit_id, 'gate_of', input.finding_id, { name: 'gate', value: input.gate })!;
    return { ticket_id: gid, changed, ...(queued ? { review: 'pending' as const } : {}) };
  });
}

export interface ReviewItem {
  finding_id: string;
  title: string;
  verdict?: string;
  severity?: string;
  confidence?: string;
  submit_plan?: string;
}

/** Findings awaiting a human decision, oldest first. Compact by design. */
export function reviewQueue(ctx: Ctx, audit_id: string): { items: ReviewItem[] } {
  auditProject(audit_id);
  const rows = ctx.db
    .prepare(
      `SELECT t.id, t.title FROM sea_fields r
         JOIN sea_fields a ON a.ticket_id = r.ticket_id AND a.name = 'audit_id' AND a.value = ?
         JOIN sea_tickets t ON t.id = r.ticket_id
        WHERE r.name = 'review' AND r.value = 'pending' ORDER BY r.set_seq`,
    )
    .all(audit_id) as { id: string; title: string }[];
  return {
    items: rows.map((r) => {
      const f = readFields(ctx.db, r.id);
      const pick = (k: FieldName) => (f[k] !== undefined ? { [k]: String(f[k]) } : {});
      return { finding_id: String(f.finding_id), title: r.title, ...pick('verdict'), ...pick('severity'), ...pick('confidence'), ...pick('submit_plan') } as ReviewItem;
    }),
  };
}

/** A human's decision on a queued finding. */
export function review(
  ctx0: Ctx,
  audit_id: string,
  input: { finding_id: string; decision: 'approved' | 'rejected' | 'hold'; submit_plan?: string; note?: string; expect_version?: number },
): { ticket_id: string; version: number; changed: string[] } {
  const ctx = inAudit(ctx0, audit_id);
  if (!['approved', 'rejected', 'hold'].includes(input.decision)) throw new SeaError('invalid_input', 'decision: approved | rejected | hold');
  return tx(ctx.db, () => {
    const id = byField(ctx, audit_id, 'finding_id', input.finding_id);
    if (!id) throw new SeaError('not_found', `finding ${input.finding_id} not found in audit ${audit_id}`, { finding_id: input.finding_id });
    const cur = readFields(ctx.db, id).review;
    if (cur === undefined) throw new SeaError('illegal_transition', `finding ${input.finding_id} is not in the review queue (gates still pending)`, { finding_id: input.finding_id });
    const r = setFields(
      ctx,
      id,
      { review: input.decision, ...(input.submit_plan !== undefined ? { submit_plan: input.submit_plan } : {}), ...(input.note !== undefined ? { review_note: input.note } : {}) },
      input.expect_version,
    );
    return { ticket_id: id, version: r.version, changed: r.changed };
  });
}

/** Export columns, in the order of the PostHog tracker (mk3.py), then sea-lite's own. */
export const EXPORT_COLUMNS = [
  'id',
  'source_pass',
  'title',
  'verdict',
  'refuter2_verdict',
  'refuter2_severity',
  'refuter2_submit_ready',
  'confidence',
  'merged_into',
  'submit_plan',
  'component',
  'root_cause',
  'affected_count',
  'summary',
  'evidence',
  'measured_impact',
  'proposed_fix',
  'fix_difficulty',
  'gate1_repro',
  'gate2_intent',
  'gate3_docs',
  'gate4_prior_links',
  'gate5_refutation',
  'our PR/issue #',
  'submitted date',
  'status',
  'review',
  'catalog_fingerprint',
  'evidence_ref',
  'ticket_id',
] as const;
export type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], string>;

const FIELD_COLUMN: Partial<Record<(typeof EXPORT_COLUMNS)[number], FieldName>> = {
  source_pass: 'source_pass',
  verdict: 'verdict',
  refuter2_verdict: 'refuter_verdict',
  refuter2_severity: 'severity',
  refuter2_submit_ready: 'submit_ready',
  confidence: 'confidence',
  merged_into: 'merged_into',
  submit_plan: 'submit_plan',
  component: 'component',
  root_cause: 'root_cause',
  affected_count: 'affected_count',
  summary: 'summary',
  evidence: 'evidence',
  measured_impact: 'measured_impact',
  proposed_fix: 'proposed_fix',
  fix_difficulty: 'fix_difficulty',
  'our PR/issue #': 'pr_or_issue',
  'submitted date': 'submitted_date',
  status: 'tracker_status',
  review: 'review',
  catalog_fingerprint: 'catalog_fingerprint',
  evidence_ref: 'evidence_ref',
};
const GATE_COLUMN: Record<Gate, (typeof EXPORT_COLUMNS)[number]> = {
  repro: 'gate1_repro',
  intent: 'gate2_intent',
  docs: 'gate3_docs',
  prior_reports: 'gate4_prior_links',
  refuter: 'gate5_refutation',
};

function gateCell(f: FieldMap): string {
  const r = f.result === undefined || f.result === 'pending' ? '' : String(f.result);
  const note = f.note !== undefined ? String(f.note) : '';
  return r && note ? `${r}: ${note}` : r || note;
}

/** Every finding of an audit as export rows, ordered by finding id. */
export function findingRows(ctx: Ctx, audit_id: string): ExportRow[] {
  auditProject(audit_id);
  const rows = ctx.db
    .prepare(
      `SELECT t.id, t.title, f.value AS finding_id FROM sea_fields f
         JOIN sea_fields a ON a.ticket_id = f.ticket_id AND a.name = 'audit_id' AND a.value = ?
         JOIN sea_tickets t ON t.id = f.ticket_id
        WHERE f.name = 'finding_id' ORDER BY f.value`,
    )
    .all(audit_id) as { id: string; title: string; finding_id: string }[];
  return rows.map((r) => {
    const f = readFields(ctx.db, r.id);
    const out = Object.fromEntries(EXPORT_COLUMNS.map((c) => [c, ''])) as ExportRow;
    out.id = r.finding_id;
    out.title = r.title;
    out.ticket_id = r.id;
    for (const [col, name] of Object.entries(FIELD_COLUMN) as [(typeof EXPORT_COLUMNS)[number], FieldName][]) {
      if (f[name] !== undefined) out[col] = String(f[name]);
    }
    for (const g of GATES) {
      const gid = byField(ctx, audit_id, 'gate_of', r.finding_id, { name: 'gate', value: g });
      if (gid) out[GATE_COLUMN[g]] = gateCell(readFields(ctx.db, gid));
    }
    return out;
  });
}

/** Inverse of FIELD_COLUMN for import: a findings.csv column → field name. */
export const IMPORT_COLUMNS: Readonly<Record<string, FieldName>> = Object.freeze(
  Object.fromEntries(Object.entries(FIELD_COLUMN).filter(([, f]) => !IDENTITY.includes(f)).map(([c, f]) => [c, f])) as Record<string, FieldName>,
);
export const IMPORT_GATE_COLUMNS: Readonly<Record<string, Gate>> = Object.freeze(Object.fromEntries(Object.entries(GATE_COLUMN).map(([g, c]) => [c, g as Gate])));
