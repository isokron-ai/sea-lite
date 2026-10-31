/**
 * MCP surface: twelve tools and one resource template over a SeaLite store.
 * Every handler is synchronous; the SDK wraps the result. Errors come back as
 * isError results with a closed `error` code so an agent can branch.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from './version.js';
import { ChainConflictError } from 'kronicle-lite';
import { z } from 'zod';

import { SeaError } from './core/errors.js';
import { ALL_STATES, LINK_TYPES, PRIORITIES, TICKET_KINDS } from './model/enums.js';
import { enabledStates } from './model/lifecycle.js';
import {
  ApplyShape,
  ClaimShape,
  CreateShape,
  GetShape,
  HistoryShape,
  LinkShape,
  ListShape,
  NextShape,
  RefreshShape,
  ReleaseShape,
  TransitionShape,
  UpdateShape,
} from './model/schemas.js';
import type { SeaLite } from './store.js';

export interface ServerOptions {
  version?: string;
}

type ToolText = { content: { type: 'text'; text: string }[]; isError?: boolean };

function json(value: unknown): ToolText {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(err: unknown): ToolText {
  if (err instanceof SeaError) return { isError: true, content: [{ type: 'text', text: JSON.stringify(err.toJSON()) }] };
  if (err instanceof ChainConflictError) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'chain_conflict', message: err.message }) }] };
  }
  if (err instanceof z.ZodError) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_input', message: err.message, details: { issues: err.issues } }) }] };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'internal', message }) }] };
}

function wrap<T>(fn: () => T): ToolText {
  try {
    return json(fn());
  } catch (err) {
    return errorResult(err);
  }
}

export function createServer(store: SeaLite, opts: ServerOptions = {}): McpServer {
  const states = enabledStates(store.lifecycle).join(' | ');
  const server = new McpServer(
    { name: 'sea-lite', version: opts.version ?? VERSION },
    {
      instructions:
        'sea-lite is a work queue for parallel coding agents. Tickets are fenced: every mutation (update, transition, link) ' +
        'needs the claim_token you got from sea_claim or sea_next, and only the holder can write until the lease lapses. ' +
        'Loop: sea_next → work → sea_update (notes) → sea_transition resolved → (claim auto-releases), or sea_release when ' +
        'you stop early. Refresh long leases with sea_refresh. Statuses: ' +
        states +
        '. Everything is an event on the shared kronicle-lite hash chain; if kronicle-lite is also installed, its get_system_state ' +
        `shows sea events in the delta. Actor for this server: "${store.actor}" (role ${store.role}).`,
    },
  );

  // ───────────────────────────── authoring ─────────────────────────────

  server.registerTool(
    'sea_create',
    {
      title: 'Create a ticket',
      description:
        'Create one ticket (status idea, or triaged to make it dispatchable right away). Returns the ticket plus ' +
        '`possible_duplicates` — existing tickets with the same or a similar title; the create always goes through, you decide. ' +
        'Pass `claim_seconds` to claim it in the same call and get a claim_token back. `idempotency_key` makes retries safe. ' +
        `Kinds: ${TICKET_KINDS.join(' | ')}. Priorities: ${PRIORITIES.join(' | ')}.`,
      inputSchema: CreateShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.create(args)),
  );

  server.registerTool(
    'sea_apply',
    {
      title: 'Create a batch of tickets and links atomically',
      description:
        'Author 1–50 tickets and up to 100 links between them in one all-or-nothing write. Each ticket carries a batch-local ' +
        '`ref`; links point at refs. Rejected as a whole on duplicate refs, links to refs outside the batch, self-loops, ' +
        'duplicate links, or a parent_of/depends_on/blocks cycle — the error lists every problem. `dry_run` validates only. ' +
        'Use this to lay down an epic with its children and dependency edges in one shot.',
      inputSchema: ApplyShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.apply(args)),
  );

  server.registerTool(
    'sea_update',
    {
      title: 'Edit a claimed ticket',
      description:
        'Change title/body/kind/priority/assignee, add or remove tags, and/or append a note. Fenced: requires the claim_token ' +
        'of a live claim held by you. `expected_version` (from sea_get / sea_list row_version) rejects the write with ' +
        'version_conflict if someone changed the ticket since you read it. Notes are the hand-off channel: write what you ' +
        'found and what is left before you release.',
      inputSchema: UpdateShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.update(args)),
  );

  server.registerTool(
    'sea_transition',
    {
      title: 'Move a ticket to another status',
      description:
        `Set status. Fenced (claim_token). Legal moves: work track idea → triaged → in_progress → resolved; any active ticket may ` +
        `enter parked | blocked | needs_decision (resume only to idea / triaged / in_progress) or a terminal state ` +
        `resolved | wont_fix | duplicate | dropped | merged (no exit). to=duplicate requires duplicate_of and records a ` +
        `\`duplicates\` link. Entering a terminal state releases your claim. On rejection the error carries legal_next. ` +
        `Known statuses: ${ALL_STATES.join(' | ')}.`,
      inputSchema: TransitionShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.transition(args)),
  );

  server.registerTool(
    'sea_link',
    {
      title: 'Add or remove a typed link',
      description:
        `Add or remove a directed link \`from <link_type> to\`. Types: ${LINK_TYPES.join(' | ')}. Fenced on the from ticket ` +
        '(claim_token). parent_of / depends_on / blocks are kept acyclic across all existing links; a cycle is rejected with ' +
        'its path. Remove tombstones the link (history keeps it). `from blocks to` and `from depends_on to` decide what sea_next ' +
        'may hand out: a ticket is eligible only when every predecessor is terminal.',
      inputSchema: LinkShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.link(args)),
  );

  // ───────────────────────────── claims ─────────────────────────────

  server.registerTool(
    'sea_claim',
    {
      title: 'Claim one or more tickets',
      description:
        'Take a lease on one or more tickets (all-or-nothing; locked in id order so concurrent claimers cannot deadlock). ' +
        'Returns one claim_token per ticket — keep it, it is shown once and is required for every write. Leases are at most ' +
        '600 s; refresh with sea_refresh or let them lapse. Fails with already_claimed (naming the holder and expiry) if any ' +
        'ticket is held by someone else. Claiming a ticket you already hold rotates its token.',
      inputSchema: ClaimShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.claim(args)),
  );

  server.registerTool(
    'sea_refresh',
    {
      title: 'Extend a claim lease',
      description:
        'Heartbeat: set the lease expiry to now + extend_by_seconds (≤ 600) if that is later than the current expiry; never ' +
        'shortens. Holder-only. Not recorded on the chain, so heartbeats do not flood anyone\'s orient delta.',
      inputSchema: RefreshShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => wrap(() => store.refresh(args)),
  );

  server.registerTool(
    'sea_release',
    {
      title: 'Release a claim',
      description:
        'Give a ticket back to the queue. Holder: pass claim_token (and ideally a `note` saying where you left off). ' +
        'Operator (server started with --role operator): `force: true` releases any holder and is recorded as ' +
        'sea_ticket.claim_force_released with your reason.',
      inputSchema: ReleaseShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.release(args)),
  );

  server.registerTool(
    'sea_next',
    {
      title: 'Pick and claim the next ticket',
      description:
        'Dispatch: atomically pick and claim the highest-priority unclaimed triaged or in_progress ticket that is assigned ' +
        'to you or unassigned, is not priority parked, and whose predecessors (tickets that `blocks` it, tickets it ' +
        '`depends_on`) are all terminal. in_progress beats triaged at equal priority; then oldest (chain order) first. Returns ticket + ' +
        'claim_token, or ticket: null with reason nothing_eligible. Call it in a loop.',
      inputSchema: NextShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.next(args)),
  );

  // ───────────────────────────── reads ─────────────────────────────

  server.registerTool(
    'sea_get',
    {
      title: 'Read one ticket',
      description:
        'Full ticket by id or a unique ≥8-char prefix: fields, row_version (for expected_version), claim holder and expiry ' +
        '(never the token), active links with the peer ticket\'s title/status, recent notes, and legal_next statuses.',
      inputSchema: GetShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => wrap(() => store.get(args)),
  );

  server.registerTool(
    'sea_list',
    {
      title: 'List and search tickets',
      description:
        'Filter by status (default: every non-terminal), kind, priority, assignee ("me" / "none"), tag, claim state ' +
        '(any / yes / no / mine), and/or full-text `query` over title and body. Paginated with an opaque cursor. ' +
        '`view: compact` (default) omits bodies. Ordered by priority then recency, or by relevance when querying.',
      inputSchema: ListShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => wrap(() => store.list(args)),
  );

  server.registerTool(
    'sea_history',
    {
      title: 'Chain history for a ticket, or a feed',
      description:
        'With ticket_id: every chain event about that ticket (its own events and links touching it), oldest first. ' +
        'Without: a feed of every sea event with seq > since_seq — poll it to watch the queue. `verify` (default true) ' +
        'recomputes every hash on the chain and reports whether the record is intact.',
      inputSchema: HistoryShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => wrap(() => store.history(args)),
  );

  // ───────────────────────────── resource ─────────────────────────────

  server.registerResource(
    'ticket',
    new ResourceTemplate('sea://tickets/{id}', { list: undefined }),
    { title: 'Ticket', description: 'A sea-lite ticket as JSON (same shape as sea_get).', mimeType: 'application/json' },
    (uri, variables) => {
      const id = String(variables['id'] ?? '');
      const result = store.get({ id });
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result, null, 2) }] };
    },
  );

  return server;
}
