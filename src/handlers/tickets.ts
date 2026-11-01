/**
 * Ticket authoring and reading: create, apply (batch), update, transition,
 * get, list. Every write is one BEGIN IMMEDIATE transaction holding the row
 * change(s) and the chain append(s) together.
 */

import type { ChainHead } from 'kronicle-lite';

import { SeaError } from '../core/errors.js';
import { EVENT, idemKey } from '../core/events.js';
import { clampLease, expiryFrom, hashToken, newClaimToken, validateFence } from '../core/fence.js';
import type { Scope } from '../core/scope.js';
import {
  activeLinksFor,
  addNote,
  checkVersion,
  mustGetRow,
  notesFor,
  ownsClaim,
  projectFilter,
  resolveId,
  sweepAllExpired,
  sweepExpired,
  tx,
  uuid,
  type Ctx,
} from '../core/repo.js';
import {
  parseTags,
  rowToLink,
  rowToTicket,
  toCompact,
  type LinkView,
  type NoteRow,
  type Ticket,
  type TicketCompact,
  type TicketRow,
} from '../core/types.js';
import { detectCycle, type DirectedEdge } from '../model/cycle-check.js';
import { DAG_LINK_TYPES, isTerminalStatus, PRIORITY_RANK, TERMINAL_STATES, sqlIn, type TicketStatus } from '../model/enums.js';
import { legalNextStates, validateTransition } from '../model/lifecycle.js';
import type { ApplyInput, CreateInput, GetInput, ListInput, TransitionInput, UpdateInput } from '../model/schemas.js';
import { findPossibleDuplicates, type PossibleDuplicate } from './dedup.js';

// ───────────────────────────── create ─────────────────────────────

export interface CreateResult {
  ticket: Ticket;
  claim_token: string | null;
  claim_expires_at: string | null;
  possible_duplicates: PossibleDuplicate[];
  head: ChainHead;
  replayed: boolean;
  dry_run: boolean;
}

interface CreatedPayload {
  ticket_id: string;
  kind: Ticket['kind'];
  title: string;
  body: string;
  status: TicketStatus;
  priority: Ticket['priority'];
  tags: string[];
  assignee: string | null;
  created_by: string;
  created_at: string;
  /** 0.4.0: present only when the creator works in a project. */
  project?: string;
  batch_id?: string;
  ref?: string;
}

function ticketFromCreatedPayload(p: CreatedPayload, seq: number): Ticket {
  return {
    id: p.ticket_id,
    kind: p.kind,
    title: p.title,
    body: p.body,
    status: p.status,
    priority: p.priority,
    tags: p.tags,
    assignee: p.assignee,
    duplicate_of: null,
    created_by: p.created_by,
    created_at: p.created_at,
    updated_at: p.created_at,
    row_version: 1,
    claim: null,
    project: p.project ?? null,
    created_seq: seq,
    last_seq: seq,
  };
}

/** Insert one ticket row + its created event. Caller holds the transaction. */
function insertTicket(
  ctx: Ctx,
  fields: {
    title: string;
    body: string;
    kind: Ticket['kind'];
    priority: Ticket['priority'];
    tags: string[];
    assignee: string | undefined;
    status: TicketStatus;
  },
  extra: { batch_id?: string; ref?: string } = {},
  idempotency_key?: string,
): { row: TicketRow; seq: number } {
  const id = uuid();
  const created_at = ctx.now.toISOString();
  const tags = [...new Set(fields.tags)];
  const payload: CreatedPayload = {
    ticket_id: id,
    kind: fields.kind,
    title: fields.title,
    body: fields.body,
    status: fields.status,
    priority: fields.priority,
    tags,
    assignee: fields.assignee ?? null,
    created_by: ctx.actor,
    created_at,
    ...(ctx.project !== null ? { project: ctx.project } : {}),
    ...extra,
  };
  const r = ctx.chain.append({
    event_type: EVENT.ticket_created,
    actor_id: ctx.actor,
    occurred_at: ctx.now.toISOString(),
    payload: payload as unknown as Record<string, unknown>,
    ...(idempotency_key !== undefined ? { idempotency_key } : {}),
  });
  ctx.db
    .prepare(
      `INSERT INTO sea_tickets (id, kind, title, body, status, priority, tags, assignee, duplicate_of, created_by,
         created_at, updated_at, row_version, project, created_seq, last_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      id,
      fields.kind,
      fields.title,
      fields.body,
      fields.status,
      fields.priority,
      JSON.stringify(tags),
      fields.assignee ?? null,
      ctx.actor,
      created_at,
      created_at,
      ctx.project,
      r.event.seq,
      r.event.seq,
    );
  return { row: mustGetRow(ctx.db, id), seq: r.event.seq };
}

/** Set a fresh claim on a row and chain it. Returns the one-time token. */
export function placeClaim(
  ctx: Ctx,
  row: TicketRow,
  lease_seconds: number,
  extra: Record<string, unknown> = {},
  scope: Scope | null = null,
  worktree: string | null = null,
): { token: string; expires_at: string; seq: number } {
  const token = newClaimToken();
  const token_hash = hashToken(token);
  const expires_at = expiryFrom(ctx.now, lease_seconds);
  const rotated = row.claim_token_hash !== null && ownsClaim({ actor: ctx.actor, session: ctx.session }, row.claim_actor, row.claim_session);
  const r = ctx.chain.append({
    event_type: EVENT.ticket_claimed,
    actor_id: ctx.actor,
    occurred_at: ctx.now.toISOString(),
    payload: {
      ticket_id: row.id,
      claim_token_hash: token_hash,
      claim_actor: ctx.actor,
      expires_at,
      lease_seconds,
      rotated,
      scope,
      // Present only on worktree-bound claims, so unbound payloads are unchanged.
      ...(worktree !== null ? { worktree } : {}),
      // 0.4.0: present only when the holder has a session, so session-less payloads are unchanged.
      ...(ctx.session !== null ? { claim_session: ctx.session } : {}),
      ...extra,
    },
  });
  ctx.db
    .prepare(
      `UPDATE sea_tickets SET claim_token_hash = ?, claim_actor = ?, claim_expires_at = ?, claim_write_count = 0, claim_scope = ?,
         claim_worktree = ?, claim_session = ?, claim_lease_seconds = ?, last_seq = ? WHERE id = ?`,
    )
    .run(token_hash, ctx.actor, expires_at, scope ? JSON.stringify(scope.paths) : null, worktree, ctx.session, lease_seconds, r.event.seq, row.id);
  return { token, expires_at, seq: r.event.seq };
}

export function create(ctx: Ctx, input: CreateInput): CreateResult {
  const key = idemKey(input.idempotency_key);
  return tx(ctx.db, () => {
    if (key !== undefined) {
      const prior = ctx.chain.findByIdempotencyKey(key);
      if (prior) {
        if (prior.event_type !== EVENT.ticket_created) {
          throw new SeaError('invalid_input', `idempotency_key was used for a different operation (${prior.event_type})`);
        }
        return {
          ticket: ticketFromCreatedPayload(prior.payload as unknown as CreatedPayload, prior.seq),
          claim_token: null,
          claim_expires_at: null,
          possible_duplicates: [],
          head: ctx.chain.head(),
          replayed: true,
          dry_run: false,
        };
      }
    }
    const possible_duplicates = findPossibleDuplicates(ctx.db, input.title);
    const lease = input.claim_seconds !== undefined ? clampLease(input.claim_seconds) : null;
    if (input.dry_run) {
      const preview: Ticket = {
        id: '(dry_run)',
        kind: input.kind,
        title: input.title,
        body: input.body,
        status: input.status,
        priority: input.priority,
        tags: [...new Set(input.tags)],
        assignee: input.assignee ?? null,
        duplicate_of: null,
        created_by: ctx.actor,
        created_at: ctx.now.toISOString(),
        updated_at: ctx.now.toISOString(),
        row_version: 1,
        claim: null,
        project: ctx.project,
        created_seq: 0,
        last_seq: 0,
      };
      return {
        ticket: preview,
        claim_token: null,
        claim_expires_at: null,
        possible_duplicates,
        head: ctx.chain.head(),
        replayed: false,
        dry_run: true,
      };
    }
    const { row } = insertTicket(
      ctx,
      {
        title: input.title,
        body: input.body,
        kind: input.kind,
        priority: input.priority,
        tags: input.tags,
        assignee: input.assignee,
        status: input.status,
      },
      {},
      key,
    );
    let claim_token: string | null = null;
    let claim_expires_at: string | null = null;
    if (lease !== null) {
      const c = placeClaim(ctx, row, lease, { on_create: true });
      claim_token = c.token;
      claim_expires_at = c.expires_at;
    }
    return {
      ticket: rowToTicket(mustGetRow(ctx.db, row.id)),
      claim_token,
      claim_expires_at,
      possible_duplicates,
      head: ctx.chain.head(),
      replayed: false,
      dry_run: false,
    };
  });
}

// ───────────────────────────── apply (batch) ─────────────────────────────

export interface ApplyLink {
  link_id: string;
  /** Batch ref of the from ticket, or null when from is an existing ticket. */
  from_ref: string | null;
  to_ref: string | null;
  from_id: string;
  to_id: string;
  link_type: string;
}

export interface ApplyResult {
  batch_id: string | null;
  tickets: { ref: string; ticket_id: string; title: string }[];
  links: ApplyLink[];
  head: ChainHead;
  replayed: boolean;
  dry_run: boolean;
}

interface BatchPayload {
  batch_id: string;
  tickets: { ref: string; ticket_id: string; title: string }[];
  links: ApplyLink[];
}

type Problem = { code: string; message: string; at?: string | undefined };

/** Graph key for a batch endpoint: refs and existing ids live in separate namespaces. */
const refNode = (ref: string) => `ref:${ref}`;
const endpoint = (ref: string | undefined, id: string | undefined): string => (ref !== undefined ? refNode(ref) : `id:${id}`);

/**
 * The pure, batch-local barrier: refs, endpoint shape, self-loops, duplicate
 * links, and cycles among the batch's own edges. Existing-ticket endpoints
 * (`from_id` / `to_id`) are checked against the store in `apply`.
 */
export function validateBatch(input: Pick<ApplyInput, 'tickets' | 'links'>): void {
  const refs = new Set<string>();
  const problems: Problem[] = [];
  for (const t of input.tickets) {
    if (refs.has(t.ref)) problems.push({ code: 'duplicate_ref', message: `ref "${t.ref}" appears more than once`, at: t.ref });
    refs.add(t.ref);
  }
  const seenLinks = new Set<string>();
  for (const l of input.links) {
    for (const [side, ref, id] of [
      ['from', l.from_ref, l.from_id],
      ['to', l.to_ref, l.to_id],
    ] as const) {
      if ((ref === undefined) === (id === undefined)) {
        problems.push({ code: 'bad_endpoint', message: `link ${side}: give exactly one of ${side}_ref (a ticket in this batch) or ${side}_id (an existing ticket)` });
      } else if (ref !== undefined && !refs.has(ref)) {
        problems.push({
          code: 'foreign_ref',
          message: `link ${side}_ref "${ref}" is not a ticket in this batch (for an existing ticket use ${side}_id)`,
          at: ref,
        });
      }
    }
    const from = endpoint(l.from_ref, l.from_id);
    const to = endpoint(l.to_ref, l.to_id);
    if (from === to) problems.push({ code: 'self_loop', message: `link ${l.link_type} from "${l.from_ref ?? l.from_id}" to itself`, at: l.from_ref ?? l.from_id });
    const k = `${from}|${to}|${l.link_type}`;
    if (seenLinks.has(k)) problems.push({ code: 'duplicate_link', message: `link ${k.replace(/\|/g, ' ')} appears more than once` });
    seenLinks.add(k);
  }
  if (problems.length > 0) {
    throw new SeaError('batch_invalid', `batch rejected: ${problems.length} problem(s); nothing was written`, { problems });
  }
  const edges: DirectedEdge[] = input.links.map((l) => ({ from: endpoint(l.from_ref, l.from_id), to: endpoint(l.to_ref, l.to_id), linkType: l.link_type }));
  const cycle = detectCycle([], edges);
  if (cycle) throw cycleError(cycle.path, cycle.via);
}

function cycleError(path: readonly string[], via: DirectedEdge): SeaError {
  const show = (n: string) => n.replace(/^(ref|id):/, '');
  return new SeaError('cycle', `batch would create a cycle: ${path.map(show).join(' → ')} via ${via.linkType}`, {
    path: path.map(show),
    via: { from: show(via.from), to: show(via.to), linkType: via.linkType },
  });
}

/**
 * Resolve and check the existing-ticket endpoints inside the write
 * transaction: every id resolves; every existing `from` is fenced by a claim
 * token in `claims`; no link duplicates an active one; and the union of
 * existing DAG edges and the batch's edges stays acyclic. Returns id → full id.
 */
function validateExisting(ctx: Ctx, input: ApplyInput): Map<string, string> {
  const resolved = new Map<string, string>();
  const problems: Problem[] = [];
  const resolveOne = (raw: string): string | null => {
    if (resolved.has(raw)) return resolved.get(raw)!;
    try {
      const id = resolveId(ctx.db, raw);
      resolved.set(raw, id);
      return id;
    } catch (e) {
      problems.push({ code: 'unknown_ticket', message: e instanceof Error ? e.message : String(e), at: raw });
      return null;
    }
  };
  const fromIds = new Set<string>();
  for (const l of input.links) {
    if (l.from_id !== undefined) {
      const id = resolveOne(l.from_id);
      if (id !== null) fromIds.add(id);
    }
    if (l.to_id !== undefined) resolveOne(l.to_id);
  }
  const tokens = new Map<string, string>();
  for (const c of input.claims ?? []) {
    const id = resolveOne(c.ticket_id);
    if (id !== null) tokens.set(id, c.claim_token);
  }
  if (problems.length > 0) throw new SeaError('batch_invalid', `batch rejected: ${problems.length} problem(s); nothing was written`, { problems });

  for (const id of [...fromIds].sort()) {
    const token = tokens.get(id);
    if (token === undefined) {
      problems.push({ code: 'fence_missing', message: `links from existing ticket ${id} need its claim_token in claims`, at: id });
      continue;
    }
    // Fence failures (foreign holder, expired, wrong token) keep their own error codes.
    validateFence(sweepExpired(ctx, mustGetRow(ctx.db, id)), token, ctx.actor, ctx.now);
  }
  for (const l of input.links) {
    if (l.from_id === undefined || l.to_id === undefined) continue;
    const from = resolved.get(l.from_id)!;
    const to = resolved.get(l.to_id)!;
    if (from === to) problems.push({ code: 'self_loop', message: `link ${l.link_type} from ${from} to itself`, at: from });
    const dup = ctx.db
      .prepare(`SELECT link_id FROM sea_links WHERE state = 'active' AND from_id = ? AND to_id = ? AND link_type = ?`)
      .get(from, to, l.link_type) as { link_id: string } | undefined;
    if (dup) problems.push({ code: 'link_exists', message: `active ${l.link_type} link ${from} → ${to} already exists (${dup.link_id})`, at: dup.link_id });
  }
  if (problems.length > 0) throw new SeaError('batch_invalid', `batch rejected: ${problems.length} problem(s); nothing was written`, { problems });

  // Cycle check over union(existing DAG edges, batch edges). Existing tickets are keyed by full id.
  const node = (ref: string | undefined, id: string | undefined) => (ref !== undefined ? refNode(ref) : `id:${resolved.get(id!)!}`);
  const existing = existingDagEdges(ctx).map((e) => ({ from: `id:${e.from}`, to: `id:${e.to}`, linkType: e.linkType }));
  const batch = input.links.map((l) => ({ from: node(l.from_ref, l.from_id), to: node(l.to_ref, l.to_id), linkType: l.link_type }));
  const cycle = detectCycle(existing, batch);
  if (cycle) throw cycleError(cycle.path, cycle.via);
  return resolved;
}

function existingDagEdges(ctx: Ctx): DirectedEdge[] {
  return (
    ctx.db
      .prepare(`SELECT from_id, to_id, link_type FROM sea_links WHERE state = 'active' AND link_type IN (${sqlIn([...DAG_LINK_TYPES])})`)
      .all() as { from_id: string; to_id: string; link_type: string }[]
  ).map((e) => ({ from: e.from_id, to: e.to_id, linkType: e.link_type }));
}

export function apply(ctx: Ctx, input: ApplyInput): ApplyResult {
  const key = idemKey(input.idempotency_key);
  return tx(ctx.db, () => {
    if (key !== undefined) {
      const prior = ctx.chain.findByIdempotencyKey(key);
      if (prior) {
        if (prior.event_type !== EVENT.batch_applied) {
          throw new SeaError('invalid_input', `idempotency_key was used for a different operation (${prior.event_type})`);
        }
        const p = prior.payload as unknown as BatchPayload;
        return { batch_id: p.batch_id, tickets: p.tickets, links: p.links, head: ctx.chain.head(), replayed: true, dry_run: false };
      }
    }
    validateBatch(input);
    const touchesExisting = input.links.some((l) => l.from_id !== undefined || l.to_id !== undefined);
    const resolved = touchesExisting ? validateExisting(ctx, input) : new Map<string, string>();
    if (input.dry_run) {
      return {
        batch_id: null,
        tickets: input.tickets.map((t) => ({ ref: t.ref, ticket_id: '(dry_run)', title: t.title })),
        links: input.links.map((l) => ({
          link_id: '(dry_run)',
          from_ref: l.from_ref ?? null,
          to_ref: l.to_ref ?? null,
          from_id: l.from_id !== undefined ? resolved.get(l.from_id)! : '(dry_run)',
          to_id: l.to_id !== undefined ? resolved.get(l.to_id)! : '(dry_run)',
          link_type: l.link_type,
        })),
        head: ctx.chain.head(),
        replayed: false,
        dry_run: true,
      };
    }
    const batch_id = uuid();
    const byRef = new Map<string, string>();
    const tickets: BatchPayload['tickets'] = [];
    for (const t of input.tickets) {
      const { row } = insertTicket(
        ctx,
        { title: t.title, body: t.body, kind: t.kind, priority: t.priority, tags: t.tags, assignee: t.assignee, status: t.status },
        { batch_id, ref: t.ref },
      );
      byRef.set(t.ref, row.id);
      tickets.push({ ref: t.ref, ticket_id: row.id, title: row.title });
    }
    const links: ApplyLink[] = [];
    for (const l of input.links) {
      const from_id = l.from_ref !== undefined ? byRef.get(l.from_ref)! : resolved.get(l.from_id!)!;
      const to_id = l.to_ref !== undefined ? byRef.get(l.to_ref)! : resolved.get(l.to_id!)!;
      let link_id: string;
      if (l.from_ref !== undefined) {
        link_id = insertLink(ctx, from_id, to_id, l.link_type, { batch_id });
      } else {
        // A link out of an existing ticket edits that ticket, as sea_link does: bump its row_version (on the payload, for rebuild).
        const from = mustGetRow(ctx.db, from_id);
        link_id = insertLink(ctx, from_id, to_id, l.link_type, { batch_id, from_row_version: from.row_version + 1 });
        const seq = (ctx.db.prepare(`SELECT chain_seq FROM sea_links WHERE link_id = ?`).get(link_id) as { chain_seq: number }).chain_seq;
        ctx.db
          .prepare(
            `UPDATE sea_tickets SET row_version = row_version + 1, updated_at = ?, claim_write_count = claim_write_count + 1, last_seq = ?
              WHERE id = ?`,
          )
          .run(ctx.now.toISOString(), seq, from_id);
      }
      links.push({ link_id, from_ref: l.from_ref ?? null, to_ref: l.to_ref ?? null, from_id, to_id, link_type: l.link_type });
    }
    const payload: BatchPayload = { batch_id, tickets, links };
    ctx.chain.append({
      event_type: EVENT.batch_applied,
      actor_id: ctx.actor,
      occurred_at: ctx.now.toISOString(),
      payload: { ...payload, ticket_count: tickets.length, link_count: links.length } as unknown as Record<string, unknown>,
      ...(key !== undefined ? { idempotency_key: key } : {}),
    });
    return { batch_id, tickets, links, head: ctx.chain.head(), replayed: false, dry_run: false };
  });
}

/** Insert an active link row + event. Caller has validated everything. */
export function insertLink(
  ctx: Ctx,
  from_id: string,
  to_id: string,
  link_type: string,
  extra: Record<string, unknown> = {},
  idempotency_key?: string,
): string {
  const link_id = uuid();
  const created_at = ctx.now.toISOString();
  const r = ctx.chain.append({
    event_type: EVENT.link_created,
    actor_id: ctx.actor,
    occurred_at: ctx.now.toISOString(),
    payload: { link_id, from_id, to_id, link_type, created_at, ...extra },
    ...(idempotency_key !== undefined ? { idempotency_key } : {}),
  });
  ctx.db
    .prepare(
      `INSERT INTO sea_links (link_id, from_id, to_id, link_type, state, created_by, created_at, chain_seq)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .run(link_id, from_id, to_id, link_type, ctx.actor, created_at, r.event.seq);
  return link_id;
}

// ───────────────────────────── update ─────────────────────────────

export interface UpdateResult {
  ticket: Ticket | null;
  ticket_id: string;
  changed: string[];
  row_version: number;
  note: NoteRow | null;
  head: ChainHead;
  replayed: boolean;
  dry_run: boolean;
}

export function update(ctx: Ctx, input: UpdateInput): UpdateResult {
  const key = idemKey(input.idempotency_key);
  return tx(ctx.db, () => {
    if (key !== undefined) {
      const prior = ctx.chain.findByIdempotencyKey(key);
      if (prior) {
        if (prior.event_type !== EVENT.ticket_updated) {
          throw new SeaError('invalid_input', `idempotency_key was used for a different operation (${prior.event_type})`);
        }
        const p = prior.payload as { ticket_id: string; changes: Record<string, unknown>; row_version: number };
        return {
          ticket: null,
          ticket_id: p.ticket_id,
          changed: Object.keys(p.changes),
          row_version: p.row_version,
          note: null,
          head: ctx.chain.head(),
          replayed: true,
          dry_run: false,
        };
      }
    }
    const id = resolveId(ctx.db, input.ticket_id);
    const row = sweepExpired(ctx, mustGetRow(ctx.db, id));
    validateFence(row, input.claim_token, ctx.actor, ctx.now);
    checkVersion(row, input.expected_version);

    const changes: Record<string, unknown> = {};
    if (input.title !== undefined && input.title !== row.title) changes['title'] = input.title;
    if (input.body !== undefined && input.body !== row.body) changes['body'] = input.body;
    if (input.kind !== undefined && input.kind !== row.kind) changes['kind'] = input.kind;
    if (input.priority !== undefined && input.priority !== row.priority) changes['priority'] = input.priority;
    if (input.assignee !== undefined && input.assignee !== row.assignee) changes['assignee'] = input.assignee;
    let tags = parseTags(row.tags);
    if (input.add_tags || input.remove_tags) {
      const next = new Set(tags);
      for (const t of input.add_tags ?? []) next.add(t);
      for (const t of input.remove_tags ?? []) next.delete(t);
      const arr = [...next];
      if (JSON.stringify(arr) !== JSON.stringify(tags)) {
        changes['tags'] = arr;
        tags = arr;
      }
    }
    const changed = Object.keys(changes);
    if (changed.length === 0 && input.note === undefined) {
      throw new SeaError('invalid_input', 'nothing to change: no field differs and no note was given');
    }
    if (input.dry_run) {
      return {
        ticket: rowToTicket(row),
        ticket_id: id,
        changed,
        row_version: row.row_version,
        note: null,
        head: ctx.chain.head(),
        replayed: false,
        dry_run: true,
      };
    }
    let row_version = row.row_version;
    if (changed.length > 0) {
      row_version = row.row_version + 1;
      const updated_at = ctx.now.toISOString();
      const r = ctx.chain.append({
        event_type: EVENT.ticket_updated,
        actor_id: ctx.actor,
    occurred_at: ctx.now.toISOString(),
        payload: { ticket_id: id, changes, tags, row_version, updated_at },
        ...(key !== undefined ? { idempotency_key: key } : {}),
      });
      ctx.db
        .prepare(
          `UPDATE sea_tickets SET title = ?, body = ?, kind = ?, priority = ?, tags = ?, assignee = ?, row_version = ?,
             updated_at = ?, claim_write_count = claim_write_count + 1, last_seq = ? WHERE id = ?`,
        )
        .run(
          (changes['title'] as string | undefined) ?? row.title,
          (changes['body'] as string | undefined) ?? row.body,
          (changes['kind'] as string | undefined) ?? row.kind,
          (changes['priority'] as string | undefined) ?? row.priority,
          JSON.stringify(tags),
          'assignee' in changes ? (changes['assignee'] as string | null) : row.assignee,
          row_version,
          updated_at,
          r.event.seq,
          id,
        );
    }
    const note = input.note !== undefined ? addNote(ctx, id, input.note) : null;
    return {
      ticket: rowToTicket(mustGetRow(ctx.db, id)),
      ticket_id: id,
      changed,
      row_version,
      note,
      head: ctx.chain.head(),
      replayed: false,
      dry_run: false,
    };
  });
}

// ───────────────────────────── transition ─────────────────────────────

export interface TransitionResult {
  ticket: Ticket | null;
  ticket_id: string;
  from: TicketStatus;
  to: TicketStatus;
  claim_released: boolean;
  duplicates_link_id: string | null;
  legal_next: readonly TicketStatus[];
  head: ChainHead;
  replayed: boolean;
  dry_run: boolean;
}

export function transition(ctx: Ctx, input: TransitionInput): TransitionResult {
  const key = idemKey(input.idempotency_key);
  return tx(ctx.db, () => {
    if (key !== undefined) {
      const prior = ctx.chain.findByIdempotencyKey(key);
      if (prior) {
        if (prior.event_type !== EVENT.ticket_status_set) {
          throw new SeaError('invalid_input', `idempotency_key was used for a different operation (${prior.event_type})`);
        }
        const p = prior.payload as {
          ticket_id: string;
          from: TicketStatus;
          to: TicketStatus;
          claim_auto_released: boolean;
          duplicates_link_id: string | null;
        };
        return {
          ticket: null,
          ticket_id: p.ticket_id,
          from: p.from,
          to: p.to,
          claim_released: p.claim_auto_released,
          duplicates_link_id: p.duplicates_link_id ?? null,
          legal_next: legalNextStates(p.to, ctx.lifecycle),
          head: ctx.chain.head(),
          replayed: true,
          dry_run: false,
        };
      }
    }
    const id = resolveId(ctx.db, input.ticket_id);
    const row = sweepExpired(ctx, mustGetRow(ctx.db, id));
    validateFence(row, input.claim_token, ctx.actor, ctx.now);
    checkVersion(row, input.expected_version);

    const v = validateTransition(row.status, input.to, ctx.lifecycle);
    if (!v.allowed) {
      throw new SeaError('illegal_transition', `${row.status} → ${input.to}: ${v.message}`, {
        ticket_id: id,
        from: row.status,
        to: input.to,
        reason: v.reason,
        legal_next: v.legal_next ?? [],
      });
    }
    let duplicate_of: string | null = null;
    if (input.to === 'duplicate') {
      if (input.duplicate_of === undefined) {
        throw new SeaError('invalid_input', 'to = duplicate requires duplicate_of', { ticket_id: id });
      }
      duplicate_of = resolveId(ctx.db, input.duplicate_of);
      if (duplicate_of === id) throw new SeaError('self_loop', 'a ticket cannot duplicate itself', { ticket_id: id });
    }
    const willRelease = isTerminalStatus(input.to) && row.claim_token_hash !== null;
    if (input.dry_run) {
      return {
        ticket: rowToTicket(row),
        ticket_id: id,
        from: row.status,
        to: input.to,
        claim_released: willRelease,
        duplicates_link_id: null,
        legal_next: legalNextStates(input.to, ctx.lifecycle),
        head: ctx.chain.head(),
        replayed: false,
        dry_run: true,
      };
    }
    let duplicates_link_id: string | null = null;
    if (duplicate_of !== null) {
      const existing = ctx.db
        .prepare(`SELECT link_id FROM sea_links WHERE state = 'active' AND from_id = ? AND to_id = ? AND link_type = 'duplicates'`)
        .get(id, duplicate_of) as { link_id: string } | undefined;
      duplicates_link_id = existing ? existing.link_id : insertLink(ctx, id, duplicate_of, 'duplicates', { via: 'transition' });
    }
    const row_version = row.row_version + 1;
    const updated_at = ctx.now.toISOString();
    const r = ctx.chain.append({
      event_type: EVENT.ticket_status_set,
      actor_id: ctx.actor,
    occurred_at: ctx.now.toISOString(),
      payload: {
        ticket_id: id,
        from: row.status,
        to: input.to,
        reason: input.reason ?? null,
        duplicate_of,
        duplicates_link_id,
        row_version,
        updated_at,
        claim_auto_released: willRelease,
        claim_token_hash: willRelease ? row.claim_token_hash : null,
      },
      ...(key !== undefined ? { idempotency_key: key } : {}),
    });
    ctx.db
      .prepare(
        `UPDATE sea_tickets SET status = ?, duplicate_of = COALESCE(?, duplicate_of), row_version = ?, updated_at = ?,
           claim_write_count = claim_write_count + 1, last_seq = ? WHERE id = ?`,
      )
      .run(input.to, duplicate_of, row_version, updated_at, r.event.seq, id);
    if (willRelease) {
      ctx.db
        .prepare(
          `UPDATE sea_tickets SET claim_token_hash = NULL, claim_actor = NULL, claim_expires_at = NULL, claim_write_count = 0, claim_scope = NULL, claim_worktree = NULL,
             claim_session = NULL, claim_lease_seconds = NULL
             WHERE id = ?`,
        )
        .run(id);
    }
    return {
      ticket: rowToTicket(mustGetRow(ctx.db, id)),
      ticket_id: id,
      from: row.status,
      to: input.to,
      claim_released: willRelease,
      duplicates_link_id,
      legal_next: legalNextStates(input.to, ctx.lifecycle),
      head: ctx.chain.head(),
      replayed: false,
      dry_run: false,
    };
  });
}

// ───────────────────────────── get ─────────────────────────────

export interface LinkWithPeer extends LinkView {
  direction: 'out' | 'in';
  peer: { id: string; title: string; status: TicketStatus };
}

export interface GetResult {
  ticket: Ticket;
  legal_next: readonly TicketStatus[];
  links: LinkWithPeer[];
  notes: NoteRow[];
  head: ChainHead;
}

export function get(ctx: Ctx, input: GetInput): GetResult {
  return tx(ctx.db, () => {
    const id = resolveId(ctx.db, input.id);
    const row = sweepExpired(ctx, mustGetRow(ctx.db, id));
    const links: LinkWithPeer[] = activeLinksFor(ctx.db, id).map((l) => {
      const peerId = l.from_id === id ? l.to_id : l.from_id;
      const peer = mustGetRow(ctx.db, peerId);
      return { ...rowToLink(l), direction: l.from_id === id ? 'out' : 'in', peer: { id: peer.id, title: peer.title, status: peer.status } };
    });
    return {
      ticket: rowToTicket(row),
      legal_next: legalNextStates(row.status, ctx.lifecycle),
      links,
      notes: notesFor(ctx.db, id),
      head: ctx.chain.head(),
    };
  });
}

// ───────────────────────────── list ─────────────────────────────

export interface ListResult {
  tickets: (Ticket | TicketCompact)[];
  count: number;
  next_cursor: string | null;
  swept_expired: number;
  head: ChainHead;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(c: string | undefined): number {
  if (c === undefined) return 0;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { o?: unknown };
    return typeof v.o === 'number' && Number.isInteger(v.o) && v.o >= 0 ? v.o : 0;
  } catch {
    throw new SeaError('invalid_input', 'cursor is not one this server issued');
  }
}

export function list(ctx: Ctx, input: ListInput): ListResult {
  return tx(ctx.db, () => {
    const swept = sweepAllExpired(ctx);
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.status && input.status.length > 0) {
      where.push(`t.status IN (${input.status.map(() => '?').join(', ')})`);
      params.push(...input.status);
    } else if (!input.include_terminal) {
      where.push(`t.status NOT IN (${sqlIn(TERMINAL_STATES)})`);
    }
    if (input.kind && input.kind.length > 0) {
      where.push(`t.kind IN (${input.kind.map(() => '?').join(', ')})`);
      params.push(...input.kind);
    }
    if (input.priority && input.priority.length > 0) {
      where.push(`t.priority IN (${input.priority.map(() => '?').join(', ')})`);
      params.push(...input.priority);
    }
    if (input.assignee !== undefined) {
      if (input.assignee === 'none') where.push(`t.assignee IS NULL`);
      else {
        where.push(`t.assignee = ?`);
        params.push(input.assignee === 'me' ? ctx.actor : input.assignee);
      }
    }
    if (input.tag !== undefined) {
      where.push(`EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ?)`);
      params.push(input.tag);
    }
    if (input.claimed === 'yes') where.push(`t.claim_token_hash IS NOT NULL`);
    else if (input.claimed === 'no') where.push(`t.claim_token_hash IS NULL`);
    else if (input.claimed === 'mine') {
      where.push(`t.claim_actor = ?`, `t.claim_session IS ?`);
      params.push(ctx.actor, ctx.session);
    }
    const pf = projectFilter(ctx, 't', input.project);
    if (pf.sql) {
      where.push(pf.sql);
      params.push(...pf.params);
    }
    let fromSql = `sea_tickets t`;
    let orderSql = `CASE t.priority ${Object.entries(PRIORITY_RANK)
      .map(([p, r]) => `WHEN '${p}' THEN ${r}`)
      .join(' ')} END, t.updated_at DESC, t.id`;
    if (input.query !== undefined && input.query.trim().length > 0) {
      const expr = input.query
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 0)
        .map((w) => `"${w.replace(/"/g, '""')}"`)
        .join(' OR ');
      if (expr.length > 0) {
        fromSql = `sea_tickets_fts f JOIN sea_tickets t ON t.id = f.ticket_id`;
        where.push(`sea_tickets_fts MATCH ?`);
        params.push(expr);
        orderSql = `bm25(sea_tickets_fts), t.updated_at DESC`;
      }
    }
    const offset = decodeCursor(input.cursor);
    const sql = `SELECT t.* FROM ${fromSql}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderSql} LIMIT ? OFFSET ?`;
    const rows = ctx.db.prepare(sql).all(...params, input.limit + 1, offset) as TicketRow[];
    const page = rows.slice(0, input.limit);
    const tickets = page.map((r) => (input.view === 'full' ? rowToTicket(r) : toCompact(rowToTicket(r))));
    return {
      tickets,
      count: tickets.length,
      next_cursor: rows.length > input.limit ? encodeCursor(offset + input.limit) : null,
      swept_expired: swept,
      head: ctx.chain.head(),
    };
  });
}
