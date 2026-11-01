/**
 * MCP surface (protocol 2026-07-28, @modelcontextprotocol/server v2): thirteen
 * tools and one resource template over a SeaLite store. Every handler is
 * synchronous; the SDK wraps the result. Each tool publishes an
 * `outputSchema` and returns the same JSON as `structuredContent` and as a
 * text block (the spec's backward-compatible form). Errors come back as
 * isError results with a closed `error` code so an agent can branch.
 *
 * `createServer` builds one McpServer; it is a factory for `serveStdio`,
 * which pins one instance per connection and serves both the 2026-07-28
 * per-request-metadata era and the 2025 `initialize` handshake.
 */

import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  McpServer,
  ResourceTemplate,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { ChainConflictError } from 'kronicle-lite';
import { z } from 'zod';

import { SeaError } from './core/errors.js';
import { ALL_STATES, isTerminalStatus, LINK_TYPES, PRIORITIES, TICKET_KINDS } from './model/enums.js';
import {
  ApplyOutput,
  ClaimOutput,
  CreateOutput,
  GetOutput,
  HistoryOutput,
  LinkOutput,
  ListOutput,
  NextOutput,
  RefreshOutput,
  ReleaseOutput,
  ScopeCheckOutput,
  TransitionOutput,
  UpdateOutput,
} from './model/outputs.js';
import {
  ApplyInput,
  ClaimInput,
  CreateInput,
  GetInput,
  HistoryInput,
  LinkInput,
  ListInput,
  NextInput,
  RefreshInput,
  ReleaseInput,
  ScopeCheckInput,
  TransitionInput,
  UpdateInput,
} from './model/schemas.js';
import type { SeaLite } from './store.js';
import { VERSION } from './version.js';

export interface ServerOptions {
  version?: string;
  /**
   * The store's actor is an authenticated identity (an HTTP actor token), not
   * a default: a per-call `actor_id` naming anyone else is refused with
   * `forbidden`. Off for stdio and the shared HTTP bearer, where actor_id is
   * a self-asserted label.
   */
  bindActor?: boolean;
}

/** Catalog results change only with a release; a client may cache them for an hour, shared. */
const CATALOG_CACHE = { ttlMs: 3_600_000, cacheScope: 'public' as const };

/** Limit from the MCP guidance on `instructions`; pinned by a test. */
export const MAX_INSTRUCTIONS_CHARS = 512;

/** The `inputRequests` key under which sea_transition asks for terminal-state confirmation. */
export const CONFIRM_KEY = 'confirm_terminal';
const ConfirmSchema = z.object({ confirm: z.boolean().describe('true to enter the terminal state; false to leave the ticket as it is.') });

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

export function errorResult(err: unknown): CallToolResult {
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

function wrap<T>(fn: () => T): CallToolResult {
  try {
    return json(fn());
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * The capabilities the calling client declared: per request on the
 * 2026-07-28 era (the `_meta` envelope), from the `initialize` handshake on a
 * 2025-era connection.
 */
function clientCapabilities(ctx: ServerContext, server: McpServer): ClientCapabilities | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const fromEnvelope = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  if (fromEnvelope !== undefined && fromEnvelope !== null && typeof fromEnvelope === 'object') return fromEnvelope as ClientCapabilities;
  return server.server.getClientCapabilities();
}

/** A server MUST NOT embed an elicitation the client did not declare support for. Bare `elicitation: {}` means form. */
export function supportsFormElicitation(caps: ClientCapabilities | undefined): boolean {
  const e = caps?.elicitation as { form?: unknown; url?: unknown } | undefined;
  if (e === undefined || e === null) return false;
  return e.form !== undefined || (e.form === undefined && e.url === undefined);
}

export function createServer(store: SeaLite, opts: ServerOptions = {}): McpServer {
  const actor = store.actor.length > 40 ? store.actor.slice(0, 37) + '…' : store.actor;
  // Statuses are not repeated here: sea_transition's description and every
  // illegal_transition error carry legal_next. Budget: MAX_INSTRUCTIONS_CHARS.
  const instructions =
    'Fenced work queue for parallel agents. Loop: sea_next (scope: the paths you will edit) → work → sea_update notes → ' +
    'sea_transition resolved (confirm: true, or answer the prompt). Writes need the claim_token from sea_claim/sea_next; ' +
    'only the holder writes while its lease is live (sea_refresh extends, sea_release returns the ticket). Scopes of ' +
    `different actors never overlap; run sea_scope_check before editing a path you did not claim. Actor "${actor}" (role ${store.role}).`;
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
    throw new Error(`sea-lite: server instructions are ${instructions.length} chars; the limit is ${MAX_INSTRUCTIONS_CHARS}`);
  }

  /** Enforce `bindActor`: a bound connection may only act as its own actor. */
  const bind = <T extends { actor_id?: string | undefined }>(args: T): T => {
    if (opts.bindActor === true && args.actor_id !== undefined && args.actor_id !== store.actor) {
      throw new SeaError('forbidden', `this connection is authenticated as "${store.actor}"; actor_id "${args.actor_id}" is not allowed`, {
        actor: store.actor,
        actor_id: args.actor_id,
      });
    }
    return args;
  };

  const server = new McpServer(
    { name: 'sea-lite', version: opts.version ?? VERSION },
    {
      instructions,
      cacheHints: {
        'server/discover': CATALOG_CACHE,
        'tools/list': CATALOG_CACHE,
        'resources/templates/list': CATALOG_CACHE,
        'resources/list': CATALOG_CACHE,
        // A ticket read is per-actor state (claims, notes); never share it.
        'resources/read': { ttlMs: 0, cacheScope: 'private' },
      },
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
      inputSchema: CreateInput,
      outputSchema: CreateOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.create(bind(args))),
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
      inputSchema: ApplyInput,
      outputSchema: ApplyOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.apply(bind(args))),
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
      inputSchema: UpdateInput,
      outputSchema: UpdateOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.update(bind(args))),
  );

  server.registerTool(
    'sea_transition',
    {
      title: 'Move a ticket to another status',
      description:
        `Set status. Fenced (claim_token). Legal moves: work track idea → triaged → in_progress → resolved; any active ticket may ` +
        `enter parked | blocked | needs_decision (resume only to idea / triaged / in_progress) or a terminal state ` +
        `resolved | wont_fix | duplicate | dropped | merged (no exit). to=duplicate requires duplicate_of and records a ` +
        `\`duplicates\` link. Entering a terminal state releases your claim and asks for confirmation unless confirm: true ` +
        `is passed. On rejection the error carries legal_next. ` +
        `Known statuses: ${ALL_STATES.join(' | ')}.`,
      inputSchema: TransitionInput,
      outputSchema: TransitionOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args, ctx) => {
      try {
        bind(args);
      } catch (err) {
        return errorResult(err);
      }
      return transitionWithConfirmation(store, server, args, ctx);
    },
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
      inputSchema: LinkInput,
      outputSchema: LinkOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.link(bind(args))),
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
        'ticket is held by someone else. Claiming a ticket you already hold rotates its token. Pass `scope.paths` (the files ' +
        'or directories you will edit; a worktree is a scope) to lock them for the lease: refused with scope_conflict, naming ' +
        'the holder, ticket, overlapping paths and expiry, if they overlap another actor\'s live scope.',
      inputSchema: ClaimInput,
      outputSchema: ClaimOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.claim(bind(args))),
  );

  server.registerTool(
    'sea_refresh',
    {
      title: 'Extend a claim lease',
      description:
        'Heartbeat: set the lease expiry to now + extend_by_seconds (≤ 600) if that is later than the current expiry; never ' +
        "shortens. Holder-only. Not recorded on the chain, so heartbeats do not flood anyone's orient delta.",
      inputSchema: RefreshInput,
      outputSchema: RefreshOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => wrap(() => store.refresh(bind(args))),
  );

  server.registerTool(
    'sea_release',
    {
      title: 'Release a claim',
      description:
        'Give a ticket back to the queue. Holder: pass claim_token (and ideally a `note` saying where you left off). ' +
        'Operator (server started with --role operator): `force: true` releases any holder and is recorded as ' +
        'sea_ticket.claim_force_released with your reason.',
      inputSchema: ReleaseInput,
      outputSchema: ReleaseOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.release(bind(args))),
  );

  server.registerTool(
    'sea_next',
    {
      title: 'Pick and claim the next ticket',
      description:
        'Dispatch: atomically pick and claim the highest-priority unclaimed triaged or in_progress ticket that is assigned ' +
        'to you or unassigned, is not priority parked, and whose predecessors (tickets that `blocks` it, tickets it ' +
        '`depends_on`) are all terminal. in_progress beats triaged at equal priority; then oldest (chain order) first. Returns ticket + ' +
        'claim_token, or ticket: null with reason nothing_eligible. Call it in a loop. `scope.paths` locks the paths you will ' +
        'edit for the lease (scope_conflict if they overlap another actor\'s live scope).',
      inputSchema: NextInput,
      outputSchema: NextOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => wrap(() => store.next(bind(args))),
  );

  // ───────────────────────────── reads ─────────────────────────────

  server.registerTool(
    'sea_get',
    {
      title: 'Read one ticket',
      description:
        'Full ticket by id or a unique ≥8-char prefix: fields, row_version (for expected_version), claim holder and expiry ' +
        "(never the token), active links with the peer ticket's title/status, recent notes, and legal_next statuses.",
      inputSchema: GetInput,
      outputSchema: GetOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => wrap(() => store.get(bind(args))),
  );

  server.registerTool(
    'sea_list',
    {
      title: 'List and search tickets',
      description:
        'Filter by status (default: every non-terminal), kind, priority, assignee ("me" / "none"), tag, claim state ' +
        '(any / yes / no / mine), and/or full-text `query` over title and body. Paginated with an opaque cursor. ' +
        '`view: compact` (default) omits bodies. Ordered by priority then recency, or by relevance when querying.',
      inputSchema: ListInput,
      outputSchema: ListOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => wrap(() => store.list(bind(args))),
  );

  server.registerTool(
    'sea_history',
    {
      title: 'Chain history for a ticket, or a feed',
      description:
        'With ticket_id: every chain event about that ticket (its own events and links touching it), oldest first. ' +
        'Without: a feed of every sea event with seq > since_seq — poll it to watch the queue. `verify` (default true) ' +
        'recomputes every hash on the chain and reports whether the record is intact.',
      inputSchema: HistoryInput,
      outputSchema: HistoryOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => wrap(() => store.history(bind(args))),
  );

  server.registerTool(
    'sea_scope_check',
    {
      title: 'Check paths against live claim scopes',
      description:
        'Would editing these paths collide with a scope another actor holds right now? Returns { ok, conflicts } naming each ' +
        'holder, ticket, the overlapping entries and the expiry. No claim is taken or needed and your own scopes never ' +
        'conflict. Meant for an edit hook (PreToolUse on Edit/Write) and for checking before you touch a file outside your claim.',
      inputSchema: ScopeCheckInput,
      outputSchema: ScopeCheckOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => wrap(() => store.scopeCheck(bind(args))),
  );

  // ───────────────────────────── resource ─────────────────────────────

  server.registerResource(
    'ticket',
    new ResourceTemplate('sea://tickets/{id}', { list: undefined }),
    {
      title: 'Ticket',
      description: 'A sea-lite ticket as JSON (same shape as sea_get).',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 0, cacheScope: 'private' },
    },
    (uri, variables) => {
      const id = String(variables['id'] ?? '');
      const result = store.get({ id });
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result, null, 2) }] };
    },
  );

  return server;
}

/**
 * sea_transition with the multi-round-trip confirmation gate on terminal
 * states. A terminal state has no exit and releases the claim, so unless the
 * caller passed `confirm: true` the server answers `input_required` with an
 * embedded form elicitation; the client's retry carries the answer and the
 * write goes through. The dry run runs first so the prompt is only raised for
 * a move that would otherwise succeed. A client that did not declare form
 * elicitation cannot be asked (spec: MRTR server requirement 7) and gets
 * `confirmation_required` instead, telling it to pass `confirm: true`.
 */
function transitionWithConfirmation(
  store: SeaLite,
  server: McpServer,
  args: TransitionInput,
  ctx: ServerContext,
): CallToolResult | InputRequiredResult {
  if (!isTerminalStatus(args.to) || args.dry_run || args.confirm === true) return wrap(() => store.transition(args));

  let preview: ReturnType<SeaLite['transition']>;
  try {
    preview = store.transition({ ...args, dry_run: true });
  } catch (err) {
    return errorResult(err);
  }

  const answer = inputResponse(ctx.mcpReq.inputResponses, CONFIRM_KEY);
  if (answer.kind === 'elicit' && answer.action !== 'accept') {
    return errorResult(
      new SeaError('confirmation_declined', `transition of ${preview.ticket_id} to ${args.to} was ${answer.action === 'cancel' ? 'cancelled' : 'declined'}; nothing changed`, {
        ticket_id: preview.ticket_id,
        to: args.to,
        action: answer.action,
      }),
    );
  }
  const accepted = acceptedContent(ctx.mcpReq.inputResponses, CONFIRM_KEY, ConfirmSchema);
  if (accepted?.confirm === true) return wrap(() => store.transition({ ...args, confirm: true }));
  if (accepted !== undefined) {
    return errorResult(
      new SeaError('confirmation_declined', `transition of ${preview.ticket_id} to ${args.to} was not confirmed; nothing changed`, {
        ticket_id: preview.ticket_id,
        to: args.to,
        action: 'accept',
      }),
    );
  }
  if (!supportsFormElicitation(clientCapabilities(ctx, server))) {
    return errorResult(
      new SeaError(
        'confirmation_required',
        `${args.to} is a terminal state (no exit; releases your claim). Pass confirm: true to enter it.`,
        { ticket_id: preview.ticket_id, from: preview.from, to: args.to },
      ),
    );
  }
  const title = preview.ticket?.title ?? preview.ticket_id;
  return inputRequired({
    inputRequests: {
      [CONFIRM_KEY]: inputRequired.elicit({
        message: `Move "${title}" (${preview.ticket_id.slice(0, 8)}) from ${preview.from} to ${args.to}? Terminal states have no exit and this releases your claim.`,
        requestedSchema: ConfirmSchema,
      }),
    },
  });
}
