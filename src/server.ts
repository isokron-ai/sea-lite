/**
 * MCP surface (protocol 2026-07-28, @modelcontextprotocol/server v2): fifteen
 * tools (`full` profile) or the eight an agent needs day to day (`core`), and
 * one resource template, over a SeaLite store. Every handler is synchronous;
 * the SDK wraps the result. Each tool publishes a lean `outputSchema`
 * (model/publish.ts; the strict zod schema still validates every result) and
 * returns the same JSON as `structuredContent` and as a compact text block
 * (the spec's backward-compatible form). Errors come back as isError results
 * with a closed `error` code so an agent can branch.
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
import { shortSession } from './core/identity.js';
import { isTerminalStatus } from './model/enums.js';
import { compactApply, fencedItems } from './handlers/tickets.js';
import {
  ApplyOutput,
  ClaimOutput,
  CreateOutput,
  FinishOutput,
  GetOutput,
  HistoryOutput,
  LinkOutput,
  ListOutput,
  NextOutput,
  RefreshOutput,
  ReleaseOutput,
  ScopeCheckOutput,
  StatsOutput,
  TransitionOutput,
  UpdateOutput,
} from './model/outputs.js';
import {
  ApplyInput,
  ClaimInput,
  CreateInput,
  FinishInput,
  GetInput,
  HistoryInput,
  LinkInput,
  ListInput,
  NextInput,
  RefreshInput,
  ReleaseInput,
  ScopeCheckInput,
  StatsInput,
  TransitionToolInput,
  UpdateInput,
  type TransitionInput,
} from './model/schemas.js';
import { published } from './model/publish.js';
import type { SeaLite, WaitHooks } from './store.js';
import { VERSION } from './version.js';

export type Profile = 'core' | 'full';
export const PROFILES: readonly Profile[] = ['core', 'full'];

/**
 * Input fields `serve --core` does not advertise (still accepted): rarely
 * needed day to day, and every one costs context in every session.
 */
const CORE_OMIT_ALWAYS = ['actor_id', 'idempotency_key', 'expected_version', 'tickets.expected_version'];

/** The day-to-day set `serve --core` publishes. */
export const CORE_TOOLS = [
  'sea_next',
  'sea_claim',
  'sea_get',
  'sea_scope_check',
  'sea_apply',
  'sea_transition',
  'sea_finish',
  'sea_release',
  'sea_refresh',
] as const;

export interface ServerOptions {
  version?: string;
  /**
   * The store's actor is an authenticated identity (an HTTP actor token), not
   * a default: a per-call `actor_id` naming anyone else is refused with
   * `forbidden`. Off for stdio and the shared HTTP bearer, where actor_id is
   * a self-asserted label.
   */
  bindActor?: boolean;
  /** `full` (default): every tool. `core`: CORE_TOOLS with shorter descriptions. */
  profile?: Profile;
  /** How often a waiting claim sends a progress notification (default 5000 ms). */
  waitProgressMs?: number;
}

/** Catalog results change only with a release; a client may cache them for an hour, shared. */
const CATALOG_CACHE = { ttlMs: 3_600_000, cacheScope: 'public' as const };

/** Limit from the MCP guidance on `instructions`; pinned by a test. */
export const MAX_INSTRUCTIONS_CHARS = 512;

/** The `inputRequests` key under which sea_transition asks for terminal-state confirmation. */
export const CONFIRM_KEY = 'confirm_terminal';
const ConfirmSchema = z.object({ confirm: z.boolean().describe('true to enter the terminal state; false to leave the ticket as it is.') });

/** Compact JSON text: the text block is what a model reads, so no indentation. */
function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
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

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

function instructionsFor(profile: Profile, actor: string, session: string | null, role: string): string {
  // L2-06 (0.6.1): the session is shown apart from the actor, and said to be sea-lite's only: agents that saw
  // "actor#session" here passed it as their kronicle-lite actor_id, splitting pending items and lineage by session.
  const who =
    session !== null
      ? `You are "${actor}" (role ${role}; session ${session}: sea-lite only, not in a kronicle-lite actor_id).`
      : `You are "${actor}" (role ${role}).`;
  const text =
    profile === 'core'
      ? 'Fenced work queue for parallel agents. Loop: sea_next (scope.paths: files to edit) → work → sea_finish (outcome, ' +
        'note). Writes need the claim_token (sea_next/sea_claim); leases renew on any call. sea_scope_check before ' +
        'editing unclaimed paths. Plan with sea_apply. Not in core: sea_create, sea_update, sea_link, sea_list, ' +
        `sea_history, sea_stats (serve without --core, SEA_LITE_PROFILE=full). ${who}`
      : 'Fenced work queue for parallel agents. Loop: sea_next (scope: the paths you will edit) → work → sea_update notes → ' +
        'sea_finish (outcome, note). Writes need the claim_token from sea_claim/sea_next. Leases renew on any call; ' +
        'sea_release when you stop. Scopes of other holders (other actors, or this actor in another session) never ' +
        `overlap; sea_scope_check before editing unclaimed paths. ${who}`;
  if (text.length > MAX_INSTRUCTIONS_CHARS) {
    throw new Error(`sea-lite: server instructions are ${text.length} chars; the limit is ${MAX_INSTRUCTIONS_CHARS}`);
  }
  return text;
}

export function createServer(store: SeaLite, opts: ServerOptions = {}): McpServer {
  const profile: Profile = opts.profile ?? 'full';
  const actor = store.actor.length > 24 ? store.actor.slice(0, 23) + '…' : store.actor;
  // Statuses are not repeated here: sea_transition's input enum and every
  // illegal_transition error carry them. Budget: MAX_INSTRUCTIONS_CHARS.
  const instructions = instructionsFor(profile, actor, store.session !== null ? shortSession(store.session) : null, store.role);

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

  /**
   * B5: every tool call is activity by its actor, so it renews that actor's
   * live claims (rate-limited inside store.touch; never fails the call).
   */
  const touch = (args: { actor_id?: string | undefined }): void => store.touch(opts.bindActor === true ? undefined : args.actor_id);
  const run = (args: { actor_id?: string | undefined }, fn: () => unknown): CallToolResult => {
    touch(args);
    return wrap(fn);
  };

  /**
   * A claim that may wait (`wait_seconds`): async, cancelled with the request,
   * and reporting progress every 5 s when the client sent a progressToken
   * (a client that resets its request timeout on progress then never times
   * out a long wait).
   */
  const runWait = async (args: { actor_id?: string | undefined }, ctx: ServerContext, fn: (hooks: WaitHooks) => Promise<unknown>): Promise<CallToolResult> => {
    touch(args);
    const token = ctx.mcpReq._meta?.progressToken;
    const hooks: WaitHooks = {
      signal: ctx.mcpReq.signal,
      progressEveryMs: opts.waitProgressMs ?? 5000,
      onProgress:
        token === undefined
          ? undefined
          : (p) => {
              ctx.mcpReq
                .notify({
                  method: 'notifications/progress',
                  params: {
                    progressToken: token,
                    progress: p.elapsed_seconds,
                    total: p.wait_seconds,
                    message: `waiting: "${p.blocked_by.holder_label}" holds ticket ${p.blocked_by.ticket_id} until ${p.blocked_by.expires_at}`,
                  },
                })
                .catch(() => undefined);
            },
    };
    try {
      return json(await fn(hooks));
    } catch (err) {
      return errorResult(err);
    }
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

  /**
   * Register one tool for this profile: the full description, or the short
   * `core` one under `serve --core` (a tool without one is full-only). The
   * zod schemas validate; clients are shown their lean JSON Schema.
   */
  const tool = <I extends z.ZodType, O extends z.ZodType>(
    name: string,
    def: {
      title: string;
      description: string;
      core?: string;
      /** Further input fields `--core` does not advertise. */
      coreOmit?: string[];
      input: I;
      output: O;
      annotations: Record<string, boolean>;
    },
    handler: (args: z.output<I>, ctx: ServerContext) => CallToolResult | InputRequiredResult | Promise<CallToolResult>,
  ): void => {
    if (profile === 'core' && !(CORE_TOOLS as readonly string[]).includes(name)) return;
    const core = profile === 'core';
    const description = core && def.core !== undefined ? def.core : def.description;
    const omit = core ? [...CORE_OMIT_ALWAYS, ...(def.coreOmit ?? [])] : [];
    server.registerTool(
      name,
      { title: def.title, description, inputSchema: published(def.input, { omit }), outputSchema: published(def.output, { minimal: core }), annotations: def.annotations },
      handler,
    );
  };

  // ───────────────────────────── authoring ─────────────────────────────

  tool(
    'sea_create',
    {
      title: 'Create a ticket',
      description:
        'Create one ticket (status idea, or triaged = dispatchable now). Returns it plus `possible_duplicates` (similar ' +
        'titles; the create still happens, you decide). `claim_seconds` also claims it and returns a claim_token.',
      input: CreateInput,
      output: CreateOutput,
      annotations: WRITE,
    },
    (args) => run(args, () => store.create(bind(args))),
  );

  tool(
    'sea_apply',
    {
      title: 'Create tickets and links in one batch',
      description:
        'Create up to 50 tickets and 100 links in one all-or-nothing write. Each ticket has a batch-local `ref`; links join ' +
        'refs and/or existing ids. `templates` repeat one ticket per `for_each` value, e.g. a 20-step chain: ' +
        '{for_each: 20, ref: "s{i}", ticket: {title: "Step {i}"}, links: [{from_ref: "{ref}", to_ref: "{prev}", link_type: "depends_on"}]}. ' +
        'Rejected as a whole, every problem listed, on bad or duplicate refs, unknown ids, self-loops, duplicate links or a ' +
        'cycle. Returns {created: {ref: id}, links, idempotent_replay}; verbose: true echoes every id.',
      core:
        'Create ≤50 tickets + ≤100 links, all or nothing. Tickets have a batch-local `ref`; links join refs or existing ids. ' +
        '`templates` repeat a ticket per value, e.g. {for_each: 20, ref: "s{i}", ticket: {title: "Step {i}"}, links: [{from_ref: "{ref}", ' +
        'to_ref: "{prev}", link_type: "depends_on"}]}. An invalid plan writes nothing. Returns {created: {ref: id}, links}.',
      coreOmit: ['claims', 'verbose'],
      input: ApplyInput,
      output: ApplyOutput,
      annotations: WRITE,
    },
    (args) =>
      run(args, () => {
        const r = store.apply(bind(args));
        return args.verbose ? r : compactApply(r);
      }),
  );

  tool(
    'sea_update',
    {
      title: 'Edit a claimed ticket',
      description:
        'Edit a ticket you hold (claim_token): title/body/kind/priority/assignee, tags, and/or append a note. Notes are the ' +
        'hand-off channel. expected_version (row_version from sea_get / sea_list) rejects a write on a ticket changed since.',
      input: UpdateInput,
      output: UpdateOutput,
      annotations: DESTRUCTIVE,
    },
    (args) => run(args, () => store.update(bind(args))),
  );

  tool(
    'sea_transition',
    {
      title: "Change a ticket's status",
      description:
        'Set status (claim_token). Work track idea → triaged → in_progress → resolved; any active ticket may enter parked | ' +
        'blocked | needs_decision (resume to idea / triaged / in_progress) or a terminal state resolved | wont_fix | duplicate ' +
        '| dropped | merged (no exit; releases the claim; needs confirm: true or the client\'s confirmation). to=duplicate needs ' +
        'duplicate_of (records a `duplicates` link). `note` appends a note in the same write; `tickets` moves several at once, ' +
        'all or nothing. Rejections carry legal_next.',
      core:
        'Set status (claim_token): idea → triaged → in_progress → resolved, or parked | blocked | needs_decision. Terminal ' +
        'states (no exit; release the claim) need confirm: true. `note` adds a note; `tickets` moves several. Errors carry legal_next.',
      coreOmit: ['dry_run', 'duplicate_of', 'reason'],
      input: TransitionToolInput,
      output: TransitionOutput,
      annotations: DESTRUCTIVE,
    },
    (args, ctx) => {
      try {
        bind(args);
      } catch (err) {
        return errorResult(err);
      }
      touch(args);
      return transitionWithConfirmation(store, server, args, ctx);
    },
  );

  tool(
    'sea_finish',
    {
      title: 'Finish tickets',
      description:
        'End your work on a ticket in one write: `outcome` done (→ resolved) | blocked (→ blocked, resumable) | abandoned ' +
        '(→ dropped), a required `note` (what shipped / why), optional `commit` sha; your claim is released and all of it is ' +
        'chained. `tickets` finishes several (each with its own claim_token; all or none). No confirmation prompt.',
      core: 'End work in one write: outcome, note, optional commit; claim released. `tickets`: several.',
      coreOmit: ['dry_run', 'reason'],
      input: FinishInput,
      output: FinishOutput,
      annotations: DESTRUCTIVE,
    },
    (args) => run(args, () => store.finish(bind(args))),
  );

  tool(
    'sea_link',
    {
      title: 'Add or remove a typed link',
      description:
        'Add or remove a directed link `from <link_type> to`, fenced on from (claim_token). parent_of / depends_on / blocks ' +
        'stay acyclic (a cycle is rejected with its path); remove tombstones it. sea_next hands a ticket out only when every ' +
        'ticket it depends_on and every ticket that blocks it is terminal.',
      input: LinkInput,
      output: LinkOutput,
      annotations: DESTRUCTIVE,
    },
    (args) => run(args, () => store.link(bind(args))),
  );

  // ───────────────────────────── claims ─────────────────────────────

  tool(
    'sea_claim',
    {
      title: 'Claim tickets',
      description:
        'Lease tickets, all or nothing. Returns one claim_token per ticket (shown once; every write needs it). Leases ' +
        '(default 900 s, max 3600) renew while you call sea-lite tools. already_claimed names the holder and expiry; ' +
        're-claiming your own rotates the token. `scope.paths` locks the files you will edit (scope_conflict names the ' +
        'holder, ticket, overlap and expiry). `wait_seconds` waits for a held ticket or scope to free up instead (≤ 300 s; ' +
        'wait_timeout names who still holds it).',
      core: 'Lease named tickets, all or nothing; a claim_token each (shown once). `scope.paths` locks files you will edit.',
      coreOmit: ['scope.worktree', 'lease_seconds'],
      input: ClaimInput,
      output: ClaimOutput,
      annotations: WRITE,
    },
    (args, ctx) => (args.wait_seconds ? runWait(args, ctx, (h) => store.claimWait(bind(args), h)) : run(args, () => store.claim(bind(args)))),
  );

  tool(
    'sea_refresh',
    {
      title: 'Extend a claim lease',
      description: 'Extend your lease to now + extend_by_seconds (default: its lease; max 3600; never shortens). Any sea-lite call renews your claims anyway.',
      core: 'Extend your lease (any sea-lite call also renews it).',
      coreOmit: ['extend_by_seconds'],
      input: RefreshInput,
      output: RefreshOutput,
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args) => run(args, () => store.refresh(bind(args))),
  );

  tool(
    'sea_release',
    {
      title: 'Release a claim',
      description:
        'Give a ticket back to the queue (claim_token; leave a `note` saying where you stopped). Operator role: force: true ' +
        'releases any holder, recorded with your reason.',
      core: 'Give a ticket back unfinished (claim_token); `note` says where you stopped.',
      coreOmit: ['force', 'reason'],
      input: ReleaseInput,
      output: ReleaseOutput,
      annotations: DESTRUCTIVE,
    },
    (args) => run(args, () => store.release(bind(args))),
  );

  tool(
    'sea_next',
    {
      title: 'Claim the next ticket',
      description:
        'Atomically pick and claim the next ticket: unclaimed, triaged or in_progress, assigned to you or nobody, not priority ' +
        'parked, all predecessors (blocks / depends_on) terminal; highest priority, in_progress before triaged, then oldest. ' +
        'Returns ticket + claim_token, or ticket: null (nothing_eligible). This project only. `scope.paths` locks the files you will edit. ' +
        '`wait_seconds` (≤ 300) waits while the scope is held, or while nothing is free but others hold work that may free up.',
      core:
        'Claim the next eligible ticket (priority, then age; predecessors done): ticket + claim_token, or ticket: null. ' +
        '`scope.paths` locks files you will edit.',
      coreOmit: ['kind', 'tag', 'include_unassigned', 'scope.worktree', 'lease_seconds'],
      input: NextInput,
      output: NextOutput,
      annotations: WRITE,
    },
    (args, ctx) => (args.wait_seconds ? runWait(args, ctx, (h) => store.nextWait(bind(args), h)) : run(args, () => store.next(bind(args)))),
  );

  // ───────────────────────────── reads ─────────────────────────────

  tool(
    'sea_get',
    {
      title: 'Read one ticket',
      description:
        "One ticket by id or ≥8-char prefix: fields, row_version, claim holder and expiry (never the token), links with the peer's " +
        'title/status, recent notes, legal_next.',
      core: 'One ticket by id or ≥8-char prefix: fields, claim, links, notes, legal_next.',
      input: GetInput,
      output: GetOutput,
      annotations: READ,
    },
    (args) => run(args, () => store.get(bind(args))),
  );

  tool(
    'sea_list',
    {
      title: 'List and search tickets',
      description:
        'Filter by status (default: non-terminal), kind, priority, assignee ("me" / "none"), tag, claim state and/or full-text ' +
        '`query`. This project unless `project` says otherwise. Cursor-paginated; view compact (default) omits bodies.',
      input: ListInput,
      output: ListOutput,
      annotations: READ,
    },
    (args) => run(args, () => store.list(bind(args))),
  );

  tool(
    'sea_history',
    {
      title: 'Chain history for a ticket, or a feed',
      description:
        'With ticket_id: its chain events (and links touching it), oldest first. Without: every sea event after since_seq — ' +
        'poll it to watch the queue. `verify` (default true) rechecks every hash.',
      input: HistoryInput,
      output: HistoryOutput,
      annotations: READ,
    },
    (args) => run(args, () => store.history(bind(args))),
  );

  tool(
    'sea_scope_check',
    {
      title: 'Check paths against claim scopes',
      description:
        'Would editing these paths collide with a live scope someone else holds (another actor, or you in another session)? ' +
        'Returns {ok, conflicts} naming holder, ticket, overlap and expiry. Needs no claim; your own scopes never conflict.',
      core: 'Would editing these paths collide with someone else\'s live scope? {ok, conflicts}.',
      input: ScopeCheckInput,
      output: ScopeCheckOutput,
      annotations: READ,
    },
    (args) => run(args, () => store.scopeCheck(bind(args))),
  );

  tool(
    'sea_stats',
    {
      title: 'Per-actor claim accounting',
      description:
        'Per actor, from the chain: claims taken / rotated / released / expired / force-released, lease-seconds held, ' +
        'transitions, tickets created, live claims. `since`: 24h, 7d or ISO time. scope_conflict refusals are not counted.',
      input: StatsInput,
      output: StatsOutput,
      annotations: { ...READ, destructiveHint: false },
    },
    (args) => run(args, () => store.stats(bind(args))),
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
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result) }] };
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
 * The bulk form (`tickets`) asks once for the whole set.
 */
function transitionWithConfirmation(
  store: SeaLite,
  server: McpServer,
  args: TransitionToolInput,
  ctx: ServerContext,
): CallToolResult | InputRequiredResult {
  let bulk: boolean;
  let items: ReturnType<typeof fencedItems>;
  try {
    bulk = args.tickets !== undefined;
    items = fencedItems(args);
  } catch (err) {
    return errorResult(err);
  }
  const { tickets: _tickets, ticket_id: _id, claim_token: _token, expected_version: _ev, ...shared } = args;
  const one = (confirm: boolean, dry_run: boolean): TransitionInput => ({
    ...shared,
    ticket_id: items[0]!.ticket_id,
    claim_token: items[0]!.claim_token,
    ...(items[0]!.expected_version !== undefined ? { expected_version: items[0]!.expected_version } : {}),
    confirm,
    dry_run,
  });
  const many = (dry_run: boolean) => store.transitionMany({ ...shared, tickets: items, dry_run });
  const commit = (): CallToolResult => wrap(() => (bulk ? many(args.dry_run) : store.transition(one(true, args.dry_run))));
  if (!isTerminalStatus(args.to) || args.dry_run || args.confirm === true) return commit();

  // The dry run first: a move that would be rejected anyway reports that error, not a prompt.
  let preview: { ids: string[]; from: string | null; label: string };
  try {
    if (bulk) {
      const p = many(true);
      preview = { ids: p.results.map((r) => r.ticket_id), from: null, label: `${p.count} tickets (${p.results.map((r) => `"${r.title ?? r.ticket_id}"`).join(', ')})` };
    } else {
      const p = store.transition(one(false, true));
      preview = { ids: [p.ticket_id], from: p.from, label: `"${p.ticket?.title ?? p.ticket_id}" (${p.ticket_id.slice(0, 8)}) from ${p.from}` };
    }
  } catch (err) {
    return errorResult(err);
  }
  const subject = bulk ? `${preview.ids.length} tickets` : preview.ids[0]!;
  const details = (extra: Record<string, unknown>) => (bulk ? { ticket_ids: preview.ids, to: args.to, ...extra } : { ticket_id: preview.ids[0]!, to: args.to, ...extra });

  const answer = inputResponse(ctx.mcpReq.inputResponses, CONFIRM_KEY);
  if (answer.kind === 'elicit' && answer.action !== 'accept') {
    return errorResult(
      new SeaError('confirmation_declined', `transition of ${subject} to ${args.to} was ${answer.action === 'cancel' ? 'cancelled' : 'declined'}; nothing changed`, details({ action: answer.action })),
    );
  }
  const accepted = acceptedContent(ctx.mcpReq.inputResponses, CONFIRM_KEY, ConfirmSchema);
  if (accepted?.confirm === true) return wrap(() => (bulk ? many(false) : store.transition(one(true, false))));
  if (accepted !== undefined) {
    return errorResult(new SeaError('confirmation_declined', `transition of ${subject} to ${args.to} was not confirmed; nothing changed`, details({ action: 'accept' })));
  }
  if (!supportsFormElicitation(clientCapabilities(ctx, server))) {
    return errorResult(
      new SeaError(
        'confirmation_required',
        `${args.to} is a terminal state (no exit; releases your claim). Pass confirm: true to enter it.`,
        bulk ? details({}) : { ticket_id: preview.ids[0]!, from: preview.from, to: args.to },
      ),
    );
  }
  return inputRequired({
    inputRequests: {
      [CONFIRM_KEY]: inputRequired.elicit({
        message: `Move ${preview.label} to ${args.to}? Terminal states have no exit and this releases your claim.`,
        requestedSchema: ConfirmSchema,
      }),
    },
  });
}
