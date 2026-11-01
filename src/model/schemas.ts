/**
 * zod input schemas for the tools. The MCP layer publishes a lean JSON Schema
 * derived from them (model/publish.ts) and validates with them; handlers take
 * the inferred types, so the same schema is the boundary for both.
 */

import { z } from 'zod';

import { DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS } from '../core/fence.js';
import { MAX_SCOPE_PATH_CHARS, MAX_SCOPE_PATHS, MAX_WORKTREE_CHARS } from '../core/scope.js';
import { ALL_STATES, LINK_TYPES, PRIORITIES, TICKET_KINDS } from './enums.js';
import { LEAN_AS } from './publish.js';

export const TicketId = z
  .string()
  .min(8)
  .max(36)
  .describe('Id or unique ≥8-char prefix.');

export const ClaimToken = z.string().length(64).regex(/^[0-9a-f]+$/).describe('From sea_claim / sea_next.');

export const ActorId = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe('Acting actor (default: the server --actor). Subagents sharing one server pass their own.');

export const IdempotencyKey = z
  .string()
  .min(1)
  .max(180)
  .optional()
  .describe('Replay-safe: a repeat with the same key returns the first result, writes nothing.');

export const ExpectedVersion = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe('Fail with version_conflict unless row_version equals this.');

export const DryRun = z.boolean().default(false).describe('Validate only; write nothing.');

export const Kind = z.enum(TICKET_KINDS);
export const Priority = z.enum(PRIORITIES);
export const Status = z.enum(ALL_STATES);
export const LinkTypeSchema = z.enum(LINK_TYPES);
export const Tags = z.array(z.string().min(1).max(64)).max(32);

export const LeaseSeconds = z
  .number()
  .int()
  .min(1)
  .max(MAX_LEASE_SECONDS)
  .optional()
  .describe(
    `Lease seconds (default ${DEFAULT_LEASE_SECONDS}, max ${MAX_LEASE_SECONDS}); renewed while you keep calling sea-lite tools.`,
  );

export const WaitSeconds = z
  .number()
  .int()
  .min(0)
  .max(300)
  .optional()
  .describe('If held by someone else, wait up to this many seconds (≤ 300) for it to free up.');

export const ScopeSchema = z
  .object({
    paths: z
      .array(z.string().min(1).max(MAX_SCOPE_PATH_CHARS))
      .min(1)
      .max(MAX_SCOPE_PATHS)
      .optional()
      .describe('Repo-relative files or dirs (a dir covers everything beneath), globs, or `.` for the whole repo.'),
    worktree: z
      .string()
      .min(1)
      .max(MAX_WORKTREE_CHARS)
      .optional()
      .describe('Absolute path of your git worktree; `sea-lite release-worktree` frees the claim when it is removed.'),
  })
  .describe('What you will edit; scope_conflict if someone else holds an overlapping scope.');

export const NewTicketFields = {
  title: z.string().min(1).max(500),
  body: z.string().max(100_000).default(''),
  kind: Kind.default('other'),
  priority: Priority.default('medium'),
  tags: Tags.default([]),
  assignee: z.string().min(1).max(200).optional(),
};

export const CreateShape = {
  ...NewTicketFields,
  status: z
    .enum(['idea', 'triaged'])
    .default('idea')
    .describe('Initial status. `triaged` skips the inbox so sea_next can hand the ticket out immediately.'),
  claim_seconds: LeaseSeconds.describe('Also claim the new ticket for this many seconds and return the token.'),
  idempotency_key: IdempotencyKey,
  dry_run: DryRun,
  actor_id: ActorId,
};
export const CreateInput = z.object(CreateShape);
export type CreateInput = z.infer<typeof CreateInput>;

/** Caps on a batch after template expansion. */
export const MAX_BATCH_TICKETS = 50;
export const MAX_BATCH_LINKS = 100;
export const MAX_TEMPLATES = 10;

const Ref = z.string().min(1).max(64);
export const BatchTicketFields = {
  ...NewTicketFields,
  status: z.enum(['idea', 'triaged']).default('idea'),
};
export const BatchTicket = z.object({
  ref: Ref.describe('Batch-local handle that links use.'),
  ...BatchTicketFields,
});
export type BatchTicket = z.infer<typeof BatchTicket>;
const LinkEnds = {
  from_ref: Ref.optional(),
  from_id: TicketId.optional(),
  to_ref: Ref.optional(),
  to_id: TicketId.optional(),
  link_type: LinkTypeSchema,
};
export const BatchLink = z
  .object(LinkEnds)
  .describe('One end each side: *_ref = a ticket in this batch, *_id = an existing ticket (a from_id needs its token in `claims`).');
export type BatchLink = z.infer<typeof BatchLink>;

export const BatchTemplate = z
  .object({
    for_each: z
      .union([z.array(z.union([z.string().max(200), z.number()])).min(1).max(MAX_BATCH_TICKETS), z.number().int().min(1).max(MAX_BATCH_TICKETS)])
      .describe('Values to repeat over, or a count n (= values 1..n).'),
    ref: Ref.describe('Ref per item; must use {i} or {value}, e.g. "t{i}".'),
    ticket: z.object(BatchTicketFields).meta({ [LEAN_AS]: 'Fields of a `tickets` entry without ref (title required).' }),
    links: z
      .array(z.object(LinkEnds))
      .max(MAX_BATCH_LINKS)
      .default([])
      .describe('Per item, entries like `links`.')
      .meta({ [LEAN_AS]: '' }),
  })
  .describe('One ticket (+ links) per for_each value. In every string: {i} = 1-based index, {value}, {ref} = this item\'s expanded ref, {prev} = the expanded ref of item i-1 of this template (a link naming {prev} is skipped for item 1).');
export type BatchTemplate = z.infer<typeof BatchTemplate>;

export const ApplyShape = {
  tickets: z.array(BatchTicket).max(MAX_BATCH_TICKETS).default([]),
  links: z.array(BatchLink).max(MAX_BATCH_LINKS).default([]),
  templates: z.array(BatchTemplate).max(MAX_TEMPLATES).optional(),
  claims: z
    .array(z.object({ ticket_id: TicketId, claim_token: ClaimToken }))
    .max(MAX_BATCH_TICKETS)
    .optional()
    .describe('Tokens for existing tickets used as from_id.'),
  verbose: z.boolean().optional().describe('true: return every ticket and link id in full instead of {created, links, idempotent_replay}.'),
  idempotency_key: IdempotencyKey,
  dry_run: DryRun.describe('Validate only; the result shows the expanded plan.'),
  actor_id: ActorId,
};
export const ApplyInput = z.object(ApplyShape);
export type ApplyInput = z.infer<typeof ApplyInput>;
/** A batch after template expansion: what the handler validates and writes. */
export type ExpandedBatch = { tickets: BatchTicket[]; links: BatchLink[]; origins?: BatchOrigins };

/**
 * Where an expanded ticket or link came from, so an error can name it:
 * `tickets[2]`, `links[4]`, `templates[0] item 3 (t03)`, or
 * `templates[0] item 3 (t03) links[1]`.
 */
export interface BatchOrigin {
  where: string;
  template?: number;
  /** 1-based item of the template ({i}). */
  item?: number;
  /** The expanded ref of the ticket (or, for a template link, of its item). */
  ref?: string;
  /** Index in the list the link was written in (`links`, or the template's `links`). */
  link?: number;
}
export interface BatchOrigins {
  tickets: BatchOrigin[];
  links: BatchOrigin[];
}

/** Origins for a batch written without templates. */
export function plainOrigins(b: { tickets: { ref: string }[]; links: unknown[] }): BatchOrigins {
  return {
    tickets: b.tickets.map((t, k) => ({ where: `tickets[${k}] (${t.ref})`, ref: t.ref })),
    links: b.links.map((_, k) => ({ where: `links[${k}]`, link: k })),
  };
}

export const GetShape = {
  id: TicketId,
  actor_id: ActorId,
};
export const GetInput = z.object(GetShape);
export type GetInput = z.infer<typeof GetInput>;

export const ListShape = {
  status: z.array(Status).optional().describe('Only these statuses. Default: every non-terminal status.'),
  include_terminal: z.boolean().default(false).describe('When no status filter is given, also return terminal tickets.'),
  kind: z.array(Kind).optional(),
  priority: z.array(Priority).optional(),
  assignee: z.string().optional().describe('Exact assignee; "me" means the calling actor; "none" means unassigned.'),
  tag: z.string().optional().describe('Only tickets carrying this tag.'),
  claimed: z.enum(['any', 'yes', 'no', 'mine']).default('any'),
  query: z.string().max(500).optional().describe('Full-text search over title and body (FTS5; words are OR-ed).'),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional().describe('Opaque cursor from a previous page.'),
  view: z.enum(['compact', 'full']).default('compact'),
  project: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe('Default: this server\'s project (plus legacy tickets without one). Another project key, or "*" for every project.'),
  actor_id: ActorId,
};
export const ListInput = z.object(ListShape);
export type ListInput = z.infer<typeof ListInput>;

export const ClaimShape = {
  ticket_ids: z.array(TicketId).min(1).max(50),
  lease_seconds: LeaseSeconds,
  scope: ScopeSchema.optional(),
  wait_seconds: WaitSeconds,
  actor_id: ActorId,
};
export const ClaimInput = z.object(ClaimShape);
export type ClaimInput = z.infer<typeof ClaimInput>;

export const RefreshShape = {
  ticket_id: TicketId,
  claim_token: ClaimToken,
  extend_by_seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_LEASE_SECONDS)
    .optional()
    .describe(`Expiry = now + this (default: the claim's lease); never shortens.`),
  actor_id: ActorId,
};
export const RefreshInput = z.object(RefreshShape);
export type RefreshInput = z.infer<typeof RefreshInput>;

export const ReleaseShape = {
  ticket_id: TicketId,
  claim_token: ClaimToken.optional().describe('Required unless force is set.'),
  force: z.boolean().default(false).describe('Operator only (--role operator): release regardless of holder.'),
  reason: z.string().max(2000).optional().describe('Why (force releases should say).'),
  note: z.string().max(10_000).optional().describe('Hand-off note appended to the ticket on release.'),
  actor_id: ActorId,
};
export const ReleaseInput = z.object(ReleaseShape);
export type ReleaseInput = z.infer<typeof ReleaseInput>;

export const UpdateShape = {
  ticket_id: TicketId,
  claim_token: ClaimToken,
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(100_000).optional(),
  kind: Kind.optional(),
  priority: Priority.optional(),
  add_tags: Tags.optional(),
  remove_tags: Tags.optional(),
  assignee: z.string().max(200).nullable().optional().describe('Set the assignee; null clears it.'),
  note: z.string().max(10_000).optional().describe('Append a note (progress, findings, hand-off).'),
  expected_version: ExpectedVersion,
  idempotency_key: IdempotencyKey,
  dry_run: DryRun,
  actor_id: ActorId,
};
export const UpdateInput = z.object(UpdateShape);
export type UpdateInput = z.infer<typeof UpdateInput>;

const Note = z.string().max(10_000);

export const TransitionShape = {
  ticket_id: TicketId,
  claim_token: ClaimToken,
  to: Status,
  reason: z.string().max(2000).optional(),
  duplicate_of: TicketId.optional().describe('Required when to = duplicate; also creates a `duplicates` link.'),
  note: Note.optional().describe('Also append this note (hand-off) in the same write.'),
  confirm: z
    .boolean()
    .optional()
    .describe('true: enter a terminal state now (else the client is asked, or gets confirmation_required).'),
  expected_version: ExpectedVersion,
  idempotency_key: IdempotencyKey,
  dry_run: DryRun,
  actor_id: ActorId,
};
/** One ticket (the store API). The MCP tool takes TransitionToolInput, which also has the bulk form. */
export const TransitionInput = z.object(TransitionShape);
export type TransitionInput = z.infer<typeof TransitionInput>;

export const FencedItem = z.object({ ticket_id: TicketId, claim_token: ClaimToken, expected_version: ExpectedVersion });
export type FencedItem = z.infer<typeof FencedItem>;
const BulkTickets = z
  .array(FencedItem)
  .min(1)
  .max(MAX_BATCH_TICKETS)
  .describe('Several tickets (each with its own token) instead of ticket_id + claim_token; all or none.');

export const TransitionToolShape = {
  ...TransitionShape,
  ticket_id: TicketId.optional(),
  claim_token: ClaimToken.optional(),
  tickets: BulkTickets.optional(),
};
export const TransitionToolInput = z.object(TransitionToolShape);
export type TransitionToolInput = z.infer<typeof TransitionToolInput>;

/** Several tickets to one status, all or nothing (store API behind bulk sea_transition and sea_finish). */
export const TransitionManyInput = z.object({
  tickets: z.array(FencedItem).min(1).max(MAX_BATCH_TICKETS),
  to: Status,
  reason: z.string().max(2000).optional(),
  duplicate_of: TicketId.optional(),
  note: Note.optional(),
  idempotency_key: IdempotencyKey,
  dry_run: DryRun,
  actor_id: ActorId,
});
export type TransitionManyInput = z.infer<typeof TransitionManyInput>;

/** sea_finish outcomes and the status each one sets. Every outcome releases the claim. */
export const FINISH_OUTCOMES = ['done', 'blocked', 'abandoned'] as const;
export type FinishOutcome = (typeof FINISH_OUTCOMES)[number];
export const OUTCOME_STATUS = { done: 'resolved', blocked: 'blocked', abandoned: 'dropped' } as const;
export const MAX_FINISH_NOTE_CHARS = 1000;

export const FinishShape = {
  ticket_id: TicketId.optional(),
  claim_token: ClaimToken.optional(),
  tickets: BulkTickets.optional(),
  outcome: z.enum(FINISH_OUTCOMES).describe('done → resolved; blocked → blocked (resumable); abandoned → dropped.'),
  note: z
    .string()
    .trim()
    .min(1)
    .max(MAX_FINISH_NOTE_CHARS)
    .describe('What shipped, or why not.'),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/i)
    .optional()
    .describe('Commit sha.'),
  idempotency_key: IdempotencyKey,
  dry_run: DryRun,
  actor_id: ActorId,
};
export const FinishInput = z.object(FinishShape);
export type FinishInput = z.infer<typeof FinishInput>;

export const LinkShape = {
  action: z.enum(['add', 'remove']),
  from_id: TicketId,
  to_id: TicketId,
  link_type: LinkTypeSchema,
  claim_token: ClaimToken.describe('Fence on the `from` ticket.'),
  reason: z.string().max(2000).optional(),
  expected_version: ExpectedVersion.describe('row_version of the `from` ticket.'),
  idempotency_key: IdempotencyKey,
  dry_run: DryRun,
  actor_id: ActorId,
};
export const LinkInput = z.object(LinkShape);
export type LinkInput = z.infer<typeof LinkInput>;

export const NextShape = {
  lease_seconds: LeaseSeconds,
  kind: z.array(Kind).optional().describe('Only these kinds.'),
  tag: z.string().optional().describe('Only tickets carrying this tag.'),
  include_unassigned: z.boolean().default(true).describe('Consider unassigned tickets as well as ones assigned to me.'),
  scope: ScopeSchema.optional(),
  wait_seconds: WaitSeconds,
  actor_id: ActorId,
};
export const NextInput = z.object(NextShape);
export type NextInput = z.infer<typeof NextInput>;

export const HistoryShape = {
  ticket_id: TicketId.optional().describe('Events for one ticket (its own events and links touching it).'),
  since_seq: z.number().int().nonnegative().optional().describe('Feed mode: every sea event with seq greater than this.'),
  limit: z.number().int().min(1).max(500).default(100),
  verify: z.boolean().default(true).describe('Also recompute every hash in the chain and report the result.'),
  actor_id: ActorId,
};
export const HistoryInput = z.object(HistoryShape);
export type HistoryInput = z.infer<typeof HistoryInput>;

export const ScopeCheckShape = {
  paths: z
    .array(z.string().min(1).max(MAX_SCOPE_PATH_CHARS))
    .min(1)
    .max(MAX_SCOPE_PATHS)
    .describe('Files or globs you are about to edit (repo-relative).'),
  actor_id: ActorId,
};
export const ScopeCheckInput = z.object(ScopeCheckShape);
export type ScopeCheckInput = z.infer<typeof ScopeCheckInput>;

export const StatsShape = {
  since: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Window start: a duration back from now (`24h`, `7d`, `2w`) or an ISO-8601 timestamp. Default: the whole chain.'),
  actor: z.string().min(1).max(200).optional().describe('Only this actor.'),
  actor_id: ActorId,
};
export const StatsInput = z.object(StatsShape);
export type StatsInput = z.infer<typeof StatsInput>;
