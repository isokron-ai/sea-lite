/**
 * zod input schemas for the twelve tools. The MCP layer passes the `.shape`
 * to registerTool; handlers take the inferred types, so the same schema is
 * the boundary for both.
 */

import { z } from 'zod';

import { MAX_LEASE_SECONDS } from '../core/fence.js';
import { ALL_STATES, LINK_TYPES, PRIORITIES, TICKET_KINDS } from './enums.js';

export const TicketId = z
  .string()
  .min(8)
  .max(36)
  .describe('Ticket id (uuid) or a unique prefix of at least 8 characters.');

export const ClaimToken = z.string().length(64).regex(/^[0-9a-f]+$/).describe('The claim token returned by sea_claim or sea_next.');

export const ActorId = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe('Who is calling. Defaults to the server --actor. Claims are held per actor; subagents sharing one server should each pass their own.');

export const IdempotencyKey = z
  .string()
  .min(1)
  .max(180)
  .optional()
  .describe('Replay-safe key. A second call with the same key returns the first result without writing again.');

export const ExpectedVersion = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe('Optimistic concurrency: fail with version_conflict unless the ticket row_version equals this.');

export const DryRun = z.boolean().default(false).describe('Validate and report what would happen; write nothing.');

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
  .describe(`Lease length in seconds (default 300, max ${MAX_LEASE_SECONDS}). Refresh before it lapses; expiry frees the ticket.`);

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

export const BatchTicket = z.object({
  ref: z.string().min(1).max(64).describe('Batch-local handle other entries use to point at this ticket.'),
  ...NewTicketFields,
  status: z.enum(['idea', 'triaged']).default('idea'),
});
export const BatchLink = z.object({
  from_ref: z.string().min(1).max(64),
  to_ref: z.string().min(1).max(64),
  link_type: LinkTypeSchema,
});

export const ApplyShape = {
  tickets: z.array(BatchTicket).min(1).max(50),
  links: z.array(BatchLink).max(100).default([]),
  idempotency_key: IdempotencyKey,
  dry_run: DryRun,
  actor_id: ActorId,
};
export const ApplyInput = z.object(ApplyShape);
export type ApplyInput = z.infer<typeof ApplyInput>;

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
  actor_id: ActorId,
};
export const ListInput = z.object(ListShape);
export type ListInput = z.infer<typeof ListInput>;

export const ClaimShape = {
  ticket_ids: z.array(TicketId).min(1).max(50).describe('One or more tickets. All are claimed or none is.'),
  lease_seconds: LeaseSeconds,
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
    .default(300)
    .describe(`New expiry = now + this (max ${MAX_LEASE_SECONDS}); never shortens an existing lease.`),
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

export const TransitionShape = {
  ticket_id: TicketId,
  claim_token: ClaimToken,
  to: Status,
  reason: z.string().max(2000).optional(),
  duplicate_of: TicketId.optional().describe('Required when to = duplicate; also creates a `duplicates` link.'),
  expected_version: ExpectedVersion,
  idempotency_key: IdempotencyKey,
  dry_run: DryRun,
  actor_id: ActorId,
};
export const TransitionInput = z.object(TransitionShape);
export type TransitionInput = z.infer<typeof TransitionInput>;

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
