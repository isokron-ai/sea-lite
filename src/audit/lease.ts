/**
 * Named exclusive leases with a write-intent journal (0.7.0).
 *
 * A lease (`sandbox:<id>`) has at most one live holder. Acquire returns a
 * one-time token (only its sha256 is stored) and an `epoch` that increases on
 * every acquire. The holder is the actor plus the SeaLite instance (a random
 * id per instance), so two processes of one actor are two holders. Renew is row-only, like sea_refresh. A lapsed lease
 * is taken over by the next acquire; there is no sweeper.
 *
 * The journal makes a crash mid-write detectable. Before a side effect the
 * holder opens an intent (op, target, idempotency_key); afterwards it closes
 * it as `happened` or `not_happened`. When a lease is taken over, or released
 * with `abandon`, every intent still open becomes `may_have_happened`, and
 * the new holder gets the list in its acquire result. It must verify each one
 * (read back through an independent surface) and close it before it may open
 * a new intent, so it neither repeats a write that landed nor assumes one
 * that did not. A stale holder's token no longer fences after a takeover.
 */

import { SeaError } from '../core/errors.js';
import { EVENT } from '../core/events.js';
import { assertClockTrusted } from '../core/clock.js';
import { clampLease, expiryFrom, hashToken, newClaimToken, tokenMatches } from '../core/fence.js';
import { tx, uuid, type Ctx } from '../core/repo.js';
import { looksLikeSecret, redactText } from './redact.js';
import type { Db } from 'kronicle-lite';

export interface LeaseRow {
  name: string;
  epoch: number;
  holder: string | null;
  holder_session: string | null;
  token_hash: string | null;
  expires_at: string | null;
  lease_seconds: number | null;
  last_seq: number;
}

export type IntentState = 'open' | 'happened' | 'not_happened' | 'may_have_happened';

export interface Unresolved {
  intent_id: string;
  op: string;
  target: string | null;
  idempotency_key: string | null;
  epoch: number;
  opened_by: string;
  opened_at: string;
  state: IntentState;
}

const NAME = /^[A-Za-z0-9._:@/-]{1,200}$/;

function checkName(name: string): void {
  if (!NAME.test(name)) throw new SeaError('invalid_input', 'lease name: 1-200 of letters, digits and ._:@/-', { name });
  if (looksLikeSecret(name)) throw new SeaError('invalid_input', 'lease name looks like a credential; refusing to chain it');
}

/** Identity-like strings (keys, refs) are refused when they look like a credential; free text is redacted. */
function refuseSecret(value: string, what: string): string {
  if (looksLikeSecret(value)) throw new SeaError('invalid_input', `${what} looks like a credential; refusing to chain it`, { field: what });
  return value;
}

function getLease(db: Db, name: string): LeaseRow | null {
  return (db.prepare(`SELECT * FROM sea_leases WHERE name = ?`).get(name) as LeaseRow | undefined) ?? null;
}

function live(row: LeaseRow | null, now: Date): row is LeaseRow & { holder: string; expires_at: string } {
  return row !== null && row.token_hash !== null && row.expires_at !== null && Date.parse(row.expires_at) > now.getTime();
}

function unresolved(db: Db, name: string, states: readonly IntentState[] = ['may_have_happened']): Unresolved[] {
  return db
    .prepare(
      `SELECT intent_id, op, target, idempotency_key, epoch, opened_by, opened_at, state FROM sea_lease_intents
        WHERE lease_name = ? AND state IN (${states.map(() => '?').join(', ')}) ORDER BY opened_seq`,
    )
    .all(name, ...states) as Unresolved[];
}

/** Fence check for every holder operation: the token, the holder, the clock, the expiry. */
function fenced(ctx: Ctx, name: string, token: string): LeaseRow & { holder: string; expires_at: string } {
  const row = getLease(ctx.db, name);
  if (!row || !tokenMatches(row.token_hash, token)) {
    throw new SeaError('fence_invalid', `token does not hold lease ${name}`, { name, holder: row?.holder ?? null, epoch: row?.epoch ?? 0 });
  }
  if (row.holder !== ctx.actor) throw new SeaError('fence_foreign_holder', `lease ${name} is held by "${row.holder}", not "${ctx.actor}"`, { name, holder: row.holder });
  if (!live(row, ctx.now)) throw new SeaError('fence_expired', `lease ${name} expired at ${row.expires_at}`, { name, expires_at: row.expires_at });
  return row;
}

// ───────────────────────────── projection (live + rebuild) ─────────────────────────────

type P = Record<string, unknown>;

export function applyLeaseEvent(db: Db, type: string, p: P, seq: number): boolean {
  const name = p['name'] as string;
  switch (type) {
    case EVENT.lease_acquired: {
      const mhh = (p['may_have_happened'] as string[] | undefined) ?? [];
      const mark = db.prepare(`UPDATE sea_lease_intents SET state = 'may_have_happened' WHERE intent_id = ? AND state = 'open'`);
      for (const id of mhh) mark.run(id);
      db.prepare(
        `INSERT INTO sea_leases (name, epoch, holder, holder_session, token_hash, expires_at, lease_seconds, last_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET epoch = excluded.epoch, holder = excluded.holder, holder_session = excluded.holder_session,
           token_hash = excluded.token_hash, expires_at = excluded.expires_at, lease_seconds = excluded.lease_seconds, last_seq = excluded.last_seq`,
      ).run(name, p['epoch'], p['holder'], p['session'] ?? null, p['token_hash'], p['expires_at'], p['lease_seconds'], seq);
      return true;
    }
    case EVENT.lease_released: {
      const mhh = (p['may_have_happened'] as string[] | undefined) ?? [];
      const mark = db.prepare(`UPDATE sea_lease_intents SET state = 'may_have_happened' WHERE intent_id = ? AND state = 'open'`);
      for (const id of mhh) mark.run(id);
      db.prepare(`UPDATE sea_leases SET holder = NULL, holder_session = NULL, token_hash = NULL, expires_at = NULL, lease_seconds = NULL, last_seq = ? WHERE name = ?`).run(seq, name);
      return true;
    }
    case EVENT.lease_intent_opened:
      db.prepare(
        `INSERT OR REPLACE INTO sea_lease_intents (intent_id, lease_name, epoch, op, target, idempotency_key, state, opened_by, opened_at, opened_seq)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      ).run(p['intent_id'], name, p['epoch'], p['op'], p['target'] ?? null, p['idempotency_key'] ?? null, p['opened_by'], p['opened_at'], seq);
      return true;
    case EVENT.lease_intent_closed:
      db.prepare(`UPDATE sea_lease_intents SET state = ?, closed_seq = ?, evidence_ref = ? WHERE intent_id = ?`).run(p['outcome'], seq, p['evidence_ref'] ?? null, p['intent_id']);
      return true;
    default:
      return false;
  }
}

function append(ctx: Ctx, type: string, payload: P): number {
  const r = ctx.chain.append({ event_type: type, actor_id: ctx.actor, occurred_at: ctx.now.toISOString(), payload });
  applyLeaseEvent(ctx.db, type, payload, r.event.seq);
  return r.event.seq;
}

// ───────────────────────────── operations ─────────────────────────────

export interface AcquireResult {
  name: string;
  epoch: number;
  token: string;
  expires_at: string;
  /** The holder whose lapsed lease this acquire took over, else omitted. */
  took_over?: { holder: string; epoch: number; expired_at: string };
  /** Intents that may have happened: verify and close each before opening another. Omitted when none. */
  unresolved?: Unresolved[];
}

export function acquire(ctx: Ctx, input: { name: string; lease_seconds?: number }): AcquireResult {
  checkName(input.name);
  const lease = clampLease(input.lease_seconds);
  assertClockTrusted(ctx.clock, `acquire lease ${input.name}`);
  // why: with sessions null in library use, actor alone made every process of one actor the holder (#5 review).
  const instance = ctx.instance;
  if (instance === undefined) throw new SeaError('invalid_input', 'a named lease needs a per-instance id (use SeaLite, not a bare Ctx)');
  return tx(ctx.db, () => {
    const row = getLease(ctx.db, input.name);
    const isLive = live(row, ctx.now);
    if (isLive && !(row.holder === ctx.actor && row.holder_session === instance)) {
      throw new SeaError('already_claimed', `lease ${input.name} is held by "${row.holder}" until ${row.expires_at}`, {
        name: input.name,
        holder: row.holder,
        expires_at: row.expires_at,
        epoch: row.epoch,
      });
    }
    // Every acquire is a new epoch with a new token, the live holder's own re-acquire included:
    // whatever was open under the old token may have happened.
    const epoch = (row?.epoch ?? 0) + 1;
    const open = row ? unresolved(ctx.db, input.name, ['open']).map((u) => u.intent_id) : [];
    const took_over = row && row.token_hash !== null && !isLive ? { holder: row.holder ?? '', epoch: row.epoch, expired_at: row.expires_at ?? '' } : undefined;
    const token = newClaimToken();
    const expires_at = expiryFrom(ctx.now, lease);
    append(ctx, EVENT.lease_acquired, {
      name: input.name,
      epoch,
      holder: ctx.actor,
      session: instance,
      token_hash: hashToken(token),
      expires_at,
      lease_seconds: lease,
      ...(took_over ? { took_over } : {}),
      ...(open.length > 0 ? { may_have_happened: open } : {}),
    });
    const u = unresolved(ctx.db, input.name);
    return { name: input.name, epoch, token, expires_at, ...(took_over ? { took_over } : {}), ...(u.length > 0 ? { unresolved: u } : {}) };
  });
}

export function renew(ctx: Ctx, input: { name: string; token: string; extend_by_seconds?: number }): { expires_at: string } {
  assertClockTrusted(ctx.clock, `renew lease ${input.name}`);
  return tx(ctx.db, () => {
    const row = fenced(ctx, input.name, input.token);
    const by = clampLease(input.extend_by_seconds ?? row.lease_seconds ?? undefined);
    const proposed = expiryFrom(ctx.now, by);
    if (Date.parse(proposed) <= Date.parse(row.expires_at)) return { expires_at: row.expires_at };
    ctx.db.prepare(`UPDATE sea_leases SET expires_at = ? WHERE name = ?`).run(proposed, input.name);
    return { expires_at: proposed };
  });
}

/**
 * Release by the holder. Open intents block a release unless `abandon`
 * (audit_abort), which marks them may_have_happened for the next holder.
 * `force` (operator role) releases whoever holds it, abandoning its intents.
 */
export function release(ctx: Ctx, input: { name: string; token?: string; abandon?: boolean; force?: boolean }): { epoch: number; may_have_happened: number } {
  return tx(ctx.db, () => {
    let row: LeaseRow;
    if (input.force) {
      if (ctx.role !== 'operator') throw new SeaError('forbidden', 'force release of a lease needs the operator role');
      const r = getLease(ctx.db, input.name);
      if (!r || r.token_hash === null) throw new SeaError('not_found', `lease ${input.name} is not held`, { name: input.name });
      row = r;
    } else {
      if (input.token === undefined) throw new SeaError('invalid_input', 'release needs the token (or force as operator)');
      row = fenced(ctx, input.name, input.token);
    }
    const open = unresolved(ctx.db, input.name, ['open']).map((u) => u.intent_id);
    if (open.length > 0 && !input.abandon && !input.force) {
      throw new SeaError('invalid_input', `lease ${input.name} has ${open.length} open intent(s); close them, or release with abandon`, {
        name: input.name,
        reason: 'open_intents',
        intent_ids: open,
      });
    }
    append(ctx, EVENT.lease_released, {
      name: input.name,
      epoch: row.epoch,
      holder: row.holder,
      released_by: ctx.actor,
      ...(input.force ? { forced: true } : {}),
      ...(open.length > 0 ? { may_have_happened: open } : {}),
    });
    return { epoch: row.epoch, may_have_happened: open.length };
  });
}

/** Record a side effect about to happen. Refused while earlier intents are unresolved. */
export function openIntent(ctx: Ctx, input: { name: string; token: string; op: string; target?: string; idempotency_key?: string }): { intent_id: string } {
  if (input.op.length === 0 || input.op.length > 200) throw new SeaError('invalid_input', 'op: 1-200 characters');
  // #8: redaction runs before the write transaction, never inside it.
  const text = {
    op: redactText(input.op, 'op').text,
    ...(input.target !== undefined ? { target: redactText(input.target.slice(0, 500), 'target').text } : {}),
    ...(input.idempotency_key !== undefined ? { idempotency_key: refuseSecret(input.idempotency_key.slice(0, 200), 'idempotency_key') } : {}),
  };
  return tx(ctx.db, () => {
    const row = fenced(ctx, input.name, input.token);
    const u = unresolved(ctx.db, input.name);
    if (u.length > 0) {
      throw new SeaError('invalid_input', `lease ${input.name} has ${u.length} intent(s) that may have happened; verify and close them first`, {
        name: input.name,
        reason: 'unresolved_intents',
        intent_ids: u.map((x) => x.intent_id),
      });
    }
    const intent_id = uuid();
    append(ctx, EVENT.lease_intent_opened, {
      intent_id,
      name: input.name,
      epoch: row.epoch,
      ...text,
      opened_by: ctx.actor,
      opened_at: ctx.now.toISOString(),
    });
    return { intent_id };
  });
}

/** Close an own open intent, or resolve a may_have_happened one after verifying it. */
export function closeIntent(
  ctx: Ctx,
  input: { name: string; token: string; intent_id: string; outcome: 'happened' | 'not_happened'; evidence_ref?: string },
): { intent_id: string; state: IntentState } {
  if (input.outcome !== 'happened' && input.outcome !== 'not_happened') throw new SeaError('invalid_input', 'outcome: happened | not_happened');
  const evidence = input.evidence_ref !== undefined ? { evidence_ref: refuseSecret(input.evidence_ref.slice(0, 128), 'evidence_ref') } : {};
  return tx(ctx.db, () => {
    const row = fenced(ctx, input.name, input.token);
    const it = ctx.db.prepare(`SELECT state, epoch FROM sea_lease_intents WHERE intent_id = ? AND lease_name = ?`).get(input.intent_id, input.name) as
      | { state: IntentState; epoch: number }
      | undefined;
    if (!it) throw new SeaError('not_found', `intent ${input.intent_id} not found on lease ${input.name}`, { intent_id: input.intent_id });
    if (it.state === 'happened' || it.state === 'not_happened') {
      throw new SeaError('illegal_transition', `intent ${input.intent_id} is already closed (${it.state})`, { intent_id: input.intent_id, state: it.state });
    }
    if (it.state === 'open' && it.epoch !== row.epoch) {
      throw new SeaError('fence_invalid', `intent ${input.intent_id} belongs to epoch ${it.epoch}, not ${row.epoch}`, { intent_id: input.intent_id });
    }
    append(ctx, EVENT.lease_intent_closed, {
      intent_id: input.intent_id,
      name: input.name,
      outcome: input.outcome,
      was: it.state,
      closed_by: ctx.actor,
      ...evidence,
    });
    return { intent_id: input.intent_id, state: input.outcome };
  });
}

export interface LeaseStatus {
  name: string;
  epoch: number;
  holder: string | null;
  expires_at: string | null;
  live: boolean;
  open: number;
  may_have_happened: number;
}

export function show(ctx: Ctx, name: string): LeaseStatus {
  checkName(name);
  const row = getLease(ctx.db, name);
  const n = (st: IntentState) => (ctx.db.prepare(`SELECT COUNT(*) AS n FROM sea_lease_intents WHERE lease_name = ? AND state = ?`).get(name, st) as { n: number }).n;
  return {
    name,
    epoch: row?.epoch ?? 0,
    holder: row?.holder ?? null,
    expires_at: row?.expires_at ?? null,
    live: live(row, ctx.now),
    open: n('open'),
    may_have_happened: n('may_have_happened'),
  };
}
