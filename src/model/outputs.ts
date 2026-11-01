/**
 * zod output schemas for every tool result. They are published as each
 * tool's `outputSchema` (MCP 2026-07-28) and the server validates every
 * `structuredContent` against them before it leaves, so a handler whose
 * return shape drifts from the schema fails loudly in tests, not in a
 * client. Objects are strict (`additionalProperties: false`) except where a
 * field is open by nature (event payloads, error details).
 */

import { z } from 'zod';

import { Kind, LinkTypeSchema, Priority, Status } from './schemas.js';

export const HeadOut = z.object({ seq: z.number(), hash: z.string() }).describe('Chain head after the call.');

export const ScopeOut = z
  .object({ paths: z.array(z.string()) })
  .describe('Repo-relative paths (prefixes or globs) the holder has locked for the life of the claim.');

export const ClaimViewOut = z
  .object({
    holder: z.string(),
    expires_at: z.string(),
    write_count: z.number(),
    scope: ScopeOut.nullable(),
    worktree: z.string().nullable().describe('Absolute worktree path the claim is bound to.'),
    session: z.string().nullable().describe('Holder session; one actor label in two sessions is two holders.'),
    lease_seconds: z.number().nullable().describe('Lease the claim renews by.'),
  })
  .describe('Who holds the ticket and until when. Never the token.');

export const TicketOut = z.object({
  id: z.string(),
  kind: Kind,
  title: z.string(),
  body: z.string(),
  status: Status,
  priority: Priority,
  tags: z.array(z.string()),
  assignee: z.string().nullable(),
  duplicate_of: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  row_version: z.number(),
  claim: ClaimViewOut.nullable(),
  project: z.string().nullable().describe('Project key; null = legacy, visible in every project.'),
  created_seq: z.number(),
  last_seq: z.number(),
});

export const TicketCompactOut = z.object({
  id: z.string(),
  kind: Kind,
  title: z.string(),
  status: Status,
  priority: Priority,
  tags: z.array(z.string()),
  assignee: z.string().nullable(),
  claim: ClaimViewOut.nullable(),
  project: z.string().nullable(),
  row_version: z.number(),
  updated_at: z.string(),
});

export const NoteOut = z.object({
  note_id: z.string(),
  ticket_id: z.string(),
  author: z.string(),
  body: z.string(),
  created_at: z.string(),
  chain_seq: z.number(),
});

export const LinkViewOut = z.object({
  link_id: z.string(),
  from_id: z.string(),
  to_id: z.string(),
  link_type: LinkTypeSchema,
  created_by: z.string(),
  created_at: z.string(),
  chain_seq: z.number(),
});

export const PossibleDuplicateOut = z.object({
  ticket_id: z.string(),
  title: z.string(),
  status: Status,
  score: z.number(),
  exact_title_match: z.boolean(),
});

export const CreateOutput = z.object({
  ticket: TicketOut,
  claim_token: z.string().nullable(),
  claim_expires_at: z.string().nullable(),
  possible_duplicates: z.array(PossibleDuplicateOut),
  head: HeadOut,
  replayed: z.boolean(),
  dry_run: z.boolean(),
});

/** sea_apply default: ref → ticket id, link count, replay flag (and the expanded plan on dry_run). */
export const ApplyCompactOutput = z.object({
  created: z.record(z.string(), z.string()).describe('ref → ticket id.'),
  links: z.number().describe('Links written.'),
  idempotent_replay: z.boolean(),
  dry_run: z.literal(true).optional(),
  plan: z
    .object({ tickets: z.array(z.object({ ref: z.string(), title: z.string() })), links: z.array(z.string()) })
    .optional()
    .describe('dry_run only: the expanded plan; links as "from link_type to".'),
});

/** sea_apply with verbose: true (the 0.4.0 result). */
export const ApplyVerboseOutput = z.object({
  batch_id: z.string().nullable(),
  tickets: z.array(z.object({ ref: z.string(), ticket_id: z.string(), title: z.string() })),
  links: z.array(
    z.object({
      link_id: z.string(),
      from_ref: z.string().nullable().describe('null when from is an existing ticket.'),
      to_ref: z.string().nullable().describe('null when to is an existing ticket.'),
      from_id: z.string(),
      to_id: z.string(),
      link_type: z.string(),
    }),
  ),
  head: HeadOut,
  replayed: z.boolean(),
  dry_run: z.boolean(),
});

export const ApplyOutput = z.union([ApplyCompactOutput, ApplyVerboseOutput]);

export const UpdateOutput = z.object({
  ticket: TicketOut.nullable(),
  ticket_id: z.string(),
  changed: z.array(z.string()),
  row_version: z.number(),
  note: NoteOut.nullable(),
  head: HeadOut,
  replayed: z.boolean(),
  dry_run: z.boolean(),
});

export const TransitionOneOutput = z.object({
  ticket: TicketOut.nullable(),
  ticket_id: z.string(),
  from: Status,
  to: Status,
  claim_released: z.boolean(),
  duplicates_link_id: z.string().nullable(),
  legal_next: z.array(Status),
  head: HeadOut,
  replayed: z.boolean(),
  dry_run: z.boolean(),
});

const MovedOut = z.object({ ticket_id: z.string(), title: z.string().nullable(), from: Status, to: Status, claim_released: z.boolean() });

export const TransitionManyOutput = z.object({
  results: z.array(MovedOut),
  count: z.number(),
  head: HeadOut,
  replayed: z.boolean(),
  dry_run: z.boolean(),
});

/** One ticket: the 0.4.0 result; bulk (`tickets`): one row per ticket. */
export const TransitionOutput = z.union([TransitionOneOutput, TransitionManyOutput]);

export const FinishOutput = z.object({
  finished: z.array(MovedOut),
  note_added: z.boolean(),
  replayed: z.boolean(),
  dry_run: z.boolean(),
});

export const LinkOutput = z.object({
  action: z.enum(['add', 'remove']),
  link: LinkViewOut.nullable(),
  link_id: z.string(),
  from_row_version: z.number(),
  head: HeadOut,
  replayed: z.boolean(),
  dry_run: z.boolean(),
});

export const ClaimOutput = z.object({
  claims: z.array(z.object({ ticket_id: z.string(), claim_token: z.string(), expires_at: z.string(), rotated: z.boolean() })),
  lease_seconds: z.number(),
  scope: ScopeOut.nullable(),
  worktree: z.string().nullable(),
  head: HeadOut,
});

export const RefreshOutput = z.object({
  ticket_id: z.string(),
  expires_at: z.string(),
  extended: z.boolean(),
  head: HeadOut,
});

export const ReleaseOutput = z.object({
  ticket: TicketOut,
  forced: z.boolean(),
  previous_holder: z.string().nullable(),
  note: NoteOut.nullable(),
  head: HeadOut,
});

export const NextOutput = z.object({
  ticket: TicketOut.nullable(),
  claim_token: z.string().nullable(),
  expires_at: z.string().nullable(),
  reason: z.enum(['nothing_eligible']).nullable(),
  considered: z.number(),
  head: HeadOut,
});

export const LinkWithPeerOut = LinkViewOut.extend({
  direction: z.enum(['out', 'in']),
  peer: z.object({ id: z.string(), title: z.string(), status: Status }),
});

export const GetOutput = z.object({
  ticket: TicketOut,
  legal_next: z.array(Status),
  links: z.array(LinkWithPeerOut),
  notes: z.array(NoteOut),
  head: HeadOut,
});

export const ListOutput = z.object({
  tickets: z.array(z.union([TicketCompactOut, TicketOut])),
  count: z.number(),
  next_cursor: z.string().nullable(),
  swept_expired: z.number(),
  head: HeadOut,
});

export const HistoryEntryOut = z.object({
  seq: z.number(),
  hash: z.string(),
  event_type: z.string(),
  actor_id: z.string(),
  occurred_at: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

export const HistoryOutput = z.object({
  mode: z.enum(['ticket', 'feed']),
  ticket_id: z.string().nullable(),
  since_seq: z.number().nullable(),
  events: z.array(HistoryEntryOut),
  count: z.number(),
  last_seq: z.number().nullable(),
  truncated: z.boolean(),
  head: HeadOut,
  chain: z.object({
    verified: z.boolean().nullable(),
    events_checked: z.number().nullable(),
    first_mismatch: z
      .object({
        seq: z.number(),
        kind: z.enum(['hash_mismatch', 'link_broken', 'seq_gap', 'head_mismatch']),
        expected: z.string(),
        actual: z.string(),
      })
      .nullable(),
  }),
});

export const ScopeConflictOut = z.object({
  ticket_id: z.string(),
  title: z.string(),
  holder: z.string(),
  holder_session: z.string().nullable(),
  holder_label: z.string().describe('actor#session, for humans.'),
  claim_expires_at: z.string(),
  expires_in_seconds: z.number(),
  held: z.array(z.string()).describe("The holder's scope entries that overlap."),
  overlapping: z.array(z.object({ requested: z.string(), held: z.string() })),
});

export const ScopeCheckOutput = z.object({
  ok: z.boolean(),
  paths: z.array(z.string()).describe('The request, normalized.'),
  conflicts: z.array(ScopeConflictOut),
  swept_expired: z.number(),
  head: HeadOut,
});

const StatsCounters = {
  claims_taken: z.number().describe('Claims taken, excluding token rotations.'),
  claims_rotated: z.number().describe('Re-claims of a ticket already held (token rotation).'),
  scoped_claims: z.number().describe('Claims taken with a scope.'),
  released: z.number().describe('Claims given back by the holder.'),
  released_on_transition: z.number().describe("Claims released by the holder's terminal transition."),
  expired: z.number().describe('Leases that lapsed.'),
  force_released: z.number().describe('Own claims an operator force-released.'),
  force_releases_issued: z.number().describe('Force releases performed as operator.'),
  lease_seconds: z.number().describe('Seconds claims were held, clipped to the window.'),
  live_claims: z.number().describe('Claims held right now.'),
  transitions: z.number().describe('Status changes made.'),
  tickets_created: z.number(),
};

export const StatsOutput = z.object({
  since: z.string().nullable().describe('Window start, or null for the whole chain.'),
  until: z.string(),
  actors: z.array(z.object({ actor: z.string(), ...StatsCounters })),
  totals: z.object(StatsCounters),
  events_scanned: z.number(),
  head: HeadOut,
});
