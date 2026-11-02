/**
 * Streamable HTTP serving (spec 2026-07-28 only), mirroring kronicle-lite's
 * `serve --http`.
 *
 * One endpoint, POST only, stateless: no session id is minted or honored, GET
 * and DELETE answer 405, per-request `_meta` carries the protocol version and
 * client capabilities. 2025-era clients (`initialize` handshake: Cursor and
 * other clients that do not speak 2026-07-28 yet) are served by the SDK's
 * stateless legacy fallback by default (0.4.0); `legacy: 'reject'` restores
 * the modern-only endpoint that answers them with
 * `UnsupportedProtocolVersionError` (-32022).
 *
 * Identity, per request: the shared bearer (`<data dir>/http-bearer.token`)
 * acts as the server's `--actor` with `actor_id` a self-asserted label, as on
 * stdio. A token from the actors file (`<data dir>/http-actors.json` or
 * `--actors-file`) acts as its own actor, and a per-call `actor_id` naming
 * anyone else is refused. Single trust domain: see docs/THREAT-MODEL.md
 * "HTTP transport".
 */

import { createMcpHandler, type McpRequestContext } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { SeaError } from './core/errors.js';
import { CorruptFileError, ensureDir, readOrCreateOnce } from './core/once-file.js';
import { ROLES, type Role } from './model/enums.js';
import { createServer, type Profile } from './server.js';
import type { SeaLite } from './store.js';
import { VERSION } from './version.js';

/** kronicle-lite's `serve --http` defaults to 7417; sea-lite takes the next port so both can run on one box. */
export const DEFAULT_HTTP_PORT = 7418;
export const DEFAULT_HTTP_PATH = '/mcp';
/** Same file name as kronicle-lite: one data dir, one trust domain, one shared secret. */
export const BEARER_FILE_NAME = 'http-bearer.token';
export const ACTORS_FILE_NAME = 'http-actors.json';
export const MIN_TOKEN_CHARS = 16;

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

// ───────────────────────────── tokens ─────────────────────────────

export interface TokenFileOptions {
  /** Use a token file that group or others can read (P2-13); a warning is returned instead of an error. */
  allowInsecure?: boolean;
}

/**
 * P2-13 (0.6.1): a token file other users can read is refused (it was used
 * silently), unless `allowInsecure`, which turns it into a warning. POSIX
 * only: Windows has no mode bits to check.
 */
export function checkTokenFileMode(file: string, opts: TokenFileOptions = {}): string | null {
  if (process.platform === 'win32') return null;
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) === 0) return null;
  const text = `${file} is readable by group or others (mode 0${mode.toString(8)}); run chmod 600 on it`;
  if (opts.allowInsecure !== true) throw new SeaError('invalid_input', `${text}, or pass --allow-insecure-token-file`, { reason: 'insecure_token_file', file, mode: `0${mode.toString(8)}` });
  return `warning: ${text} (used because of --allow-insecure-token-file)`;
}

/**
 * Read the bearer token from `<dataDir>/http-bearer.token`, creating a random
 * 256-bit one with mode 0600 when absent. 0.6.1 (P2-07): creation is atomic
 * and exclusive (core/once-file.ts), so servers starting together on a fresh
 * data dir all agree on one token instead of one crashing with EEXIST or
 * "empty"; the data dir is created when missing.
 */
export function loadOrCreateBearer(dataDir: string, opts: TokenFileOptions = {}): { token: string; created: boolean; file: string; warning: string | null } {
  ensureDir(dataDir);
  const file = join(dataDir, BEARER_FILE_NAME);
  let r: { value: string; created: boolean };
  try {
    r = readOrCreateOnce(file, () => newToken() + '\n', (text) => (text.trim().length > 0 ? text.trim() : null));
  } catch (err) {
    if (err instanceof CorruptFileError) throw new SeaError('invalid_input', `${file} is empty; delete it to regenerate or pass --bearer`, { file });
    throw err;
  }
  const warning = r.created ? null : checkTokenFileMode(file, opts);
  return { token: r.value, created: r.created, file, warning };
}

export function readBearerFile(file: string): string {
  const token = readFileSync(file, 'utf8').trim();
  if (token.length === 0) throw new Error(`${file} is empty`);
  return token;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenSha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const ActorEntry = z
  .object({
    actor: z.string().min(1).max(200),
    token: z.string().min(MIN_TOKEN_CHARS).optional(),
    token_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'token_sha256 must be 64 lowercase hex characters').optional(),
    role: z.enum(ROLES).optional(),
  })
  .strict()
  .refine((e) => (e.token === undefined) !== (e.token_sha256 === undefined), { message: 'each entry needs exactly one of token, token_sha256' });

const ActorsFile = z.object({ actors: z.array(ActorEntry) }).strict();
export type ActorsFile = z.infer<typeof ActorsFile>;

/** One authenticated identity: the token is kept only as its sha256. */
export interface ActorToken {
  actor: string;
  role: Role;
  token_sha256: string;
}

/**
 * Parse an actors file:
 * `{ "actors": [ { "actor": "alice", "token_sha256": "<hex>", "role": "agent" }, ... ] }`.
 * `token` (plaintext) is accepted in place of `token_sha256`; `sea-lite add-token` writes hashes.
 * Actor names and tokens must be unique.
 */
export function parseActorsFile(text: string, source = 'actors file'): ActorToken[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source}: not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = ActorsFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${source}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  const out: ActorToken[] = [];
  const actors = new Set<string>();
  const hashes = new Set<string>();
  for (const e of parsed.data.actors) {
    const h = e.token_sha256 ?? tokenSha256(e.token!);
    if (actors.has(e.actor)) throw new Error(`${source}: actor "${e.actor}" appears more than once`);
    if (hashes.has(h)) throw new Error(`${source}: two entries share a token`);
    actors.add(e.actor);
    hashes.add(h);
    out.push({ actor: e.actor, role: e.role ?? 'agent', token_sha256: h });
  }
  return out;
}

export function readActorsFile(file: string): ActorToken[] {
  return parseActorsFile(readFileSync(file, 'utf8'), file);
}

/**
 * Mint a token for `actor`, append its sha256 to the actors file (created
 * 0600; rewritten atomically) and return the plaintext — shown once.
 */
export function addActorToken(file: string, actor: string, role?: Role): { token: string; file: string; created: boolean } {
  ensureDir(dirname(file)); // P2-12: a fresh machine has no data dir yet
  const created = !existsSync(file);
  const doc: ActorsFile = created ? { actors: [] } : ActorsFile.parse(JSON.parse(readFileSync(file, 'utf8')));
  parseActorsFile(JSON.stringify(doc), file); // the existing file must already be valid
  if (doc.actors.some((e) => e.actor === actor)) throw new Error(`${file}: actor "${actor}" already has a token; remove the entry to rotate it`);
  const token = newToken();
  doc.actors.push({ actor, token_sha256: tokenSha256(token), ...(role !== undefined ? { role } : {}) });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return { token, file, created };
}

// ───────────────────────────── identity ─────────────────────────────

/** Who a request is, after the bearer check. */
export interface HttpIdentity {
  actor: string;
  role: Role;
  /** True for an actors-file token: per-call actor_id may not name anyone else. */
  bound: boolean;
}

function bearerOf(req: IncomingMessage): string | null {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1]! : null;
}

/**
 * Constant-time over the whole table: every candidate is compared (sha256
 * digests, so equal length), no early exit, so timing does not reveal which
 * entry matched or how long a token is.
 */
export function resolveIdentity(
  presented: string | null,
  shared: { digest: Buffer; actor: string; role: Role },
  actors: readonly { digest: Buffer; entry: ActorToken }[],
): HttpIdentity | null {
  if (presented === null) return null;
  const d = createHash('sha256').update(presented, 'utf8').digest();
  let hit: HttpIdentity | null = null;
  if (timingSafeEqual(d, shared.digest)) hit = { actor: shared.actor, role: shared.role, bound: false };
  for (const a of actors) {
    if (timingSafeEqual(d, a.digest) && hit === null) hit = { actor: a.entry.actor, role: a.entry.role, bound: true };
  }
  return hit;
}

// ───────────────────────────── server ─────────────────────────────

export interface HttpServeOptions {
  store: SeaLite;
  /** Shared bearer every unmapped request must present. Required; `loadOrCreateBearer` makes one. */
  bearer: string;
  /** Per-actor tokens (from the actors file). */
  actors?: readonly ActorToken[];
  /**
   * 0.6.1 (P2-12): the actors file to follow. Re-read when its mtime, size or
   * inode changes (one stat per request), so `add-token` after start works
   * without a restart; a missing file means no actor tokens; a file that does
   * not parse keeps the previous table (reported through onerror). Replaces
   * `actors` once the file is first read.
   */
  actorsFile?: string;
  host?: string;
  port?: number;
  path?: string;
  /** Extra Origin hostnames to accept besides loopback. */
  allowedOrigins?: string[];
  /** Extra Host header hostnames to accept besides loopback and the bound host. */
  allowedHosts?: string[];
  version?: string;
  /**
   * 2025-era clients: `stateless` (default) serves each legacy request through
   * the SDK's stateless fallback from the same factory, so both eras see the
   * same tools and the same per-request identity; `reject` answers them -32022.
   */
  legacy?: 'stateless' | 'reject';
  /** Tool profile served (`serve --http --core`); default full. */
  profile?: Profile;
  onerror?: (err: Error) => void;
}

export interface HttpServeHandle {
  server: NodeHttpServer;
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

function reject(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message }, id: null }));
}

function identityOf(ctx: McpRequestContext, fallback: HttpIdentity): HttpIdentity {
  const extra = ctx.authInfo?.extra as { sea_identity?: HttpIdentity } | undefined;
  return extra?.sea_identity ?? fallback;
}

/** Build the Node request listener without binding a socket (used by tests and `serveHttp`). */
export function createHttpListener(opts: HttpServeOptions): {
  listener: (req: IncomingMessage, res: ServerResponse) => void;
  close: () => Promise<void>;
} {
  if (!opts.bearer || opts.bearer.length < MIN_TOKEN_CHARS) throw new Error(`bearer token must be at least ${MIN_TOKEN_CHARS} characters`);
  const store = opts.store;
  const shared = { digest: createHash('sha256').update(opts.bearer, 'utf8').digest(), actor: store.actor, role: store.role };
  const table = (list: readonly ActorToken[]) => {
    const t = list.map((entry) => ({ digest: Buffer.from(entry.token_sha256, 'hex'), entry }));
    if (t.some((a) => a.digest.equals(shared.digest))) throw new Error('an actor token equals the shared bearer; give each actor its own token');
    return t;
  };
  let actors = table(opts.actors ?? []);
  let actorsSig: string | null = null;
  const reloadActors = (): void => {
    const file = opts.actorsFile;
    if (file === undefined) return;
    let sig: string;
    try {
      const st = statSync(file);
      sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      sig = 'absent';
    }
    if (sig === actorsSig) return;
    try {
      actors = sig === 'absent' ? [] : table(readActorsFile(file));
      actorsSig = sig;
    } catch (err) {
      actorsSig = sig; // report a bad file once, keep the previous table
      opts.onerror?.(new Error(`actors file not reloaded, keeping the previous tokens: ${err instanceof Error ? err.message : String(err)}`));
    }
  };
  if (opts.actorsFile !== undefined) {
    // The first read must succeed (a broken file at start is an error, as before).
    try {
      const st = statSync(opts.actorsFile);
      actorsSig = `${st.ino}:${st.size}:${st.mtimeMs}`;
      actors = table(readActorsFile(opts.actorsFile));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      actorsSig = 'absent';
      actors = table(opts.actors ?? []);
    }
  }
  const path = opts.path ?? DEFAULT_HTTP_PATH;
  const host = opts.host ?? '127.0.0.1';
  const allowedHosts = [...new Set([...LOOPBACK, host.includes(':') && !host.startsWith('[') ? `[${host}]` : host, ...(opts.allowedHosts ?? [])])];
  const allowedOrigins = [...new Set([...LOOPBACK, ...(opts.allowedOrigins ?? [])])];
  const validateHost = hostHeaderValidation(allowedHosts);
  const validateOrigin = originValidation(allowedOrigins);
  const fallback: HttpIdentity = { actor: store.actor, role: store.role, bound: false };

  // One McpServer per request (stateless), over a view of the store carrying
  // the request's identity. The view shares the connection; nothing is opened.
  const handler = createMcpHandler(
    (ctx) => {
      const id = identityOf(ctx, fallback);
      // No per-request session: an HTTP identity is its token (or the shared bearer's label).
      const view = id.actor === store.actor && id.role === store.role ? store : store.as(id.actor, id.role, { session: null });
      return createServer(view, { version: opts.version ?? VERSION, bindActor: id.bound, ...(opts.profile !== undefined ? { profile: opts.profile } : {}) });
    },
    { legacy: opts.legacy ?? 'stateless', ...(opts.onerror ? { onerror: opts.onerror } : {}) },
  );
  const node = toNodeHandler(handler, opts.onerror ? { onerror: opts.onerror } : {});

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) {
      reject(res, 404, `not found; the MCP endpoint is ${path}`);
      return;
    }
    // Order: Host (rebinding) → Origin (browser cross-site) → bearer → MCP.
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;
    reloadActors();
    const identity = resolveIdentity(bearerOf(req), shared, actors);
    if (identity === null) {
      reject(res, 401, 'missing or invalid bearer token', { 'WWW-Authenticate': 'Bearer realm="sea-lite"' });
      return;
    }
    if (req.method !== 'POST') {
      // 2026-07-28: GET/DELETE session operations are not part of this revision.
      reject(res, 405, 'method not allowed; the MCP endpoint accepts POST only', { Allow: 'POST' });
      return;
    }
    // toNodeHandler forwards `req.auth` to the factory as `authInfo`. The raw token never leaves this function.
    (req as IncomingMessage & { auth?: unknown }).auth = {
      token: 'redacted',
      clientId: identity.actor,
      scopes: [identity.role],
      extra: { sea_identity: identity },
    };
    // `exactOptionalPropertyTypes` disagrees with the SDK's duck type for `method?`; the shape is the same.
    void node(req as unknown as Parameters<typeof node>[0], res);
  };

  return { listener, close: () => handler.close() };
}

export async function serveHttp(opts: HttpServeOptions): Promise<HttpServeHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? DEFAULT_HTTP_PORT;
  const path = opts.path ?? DEFAULT_HTTP_PATH;
  const { listener, close } = createHttpListener({ ...opts, host, port, path });
  const server = createHttpServer(listener);
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolve();
    });
  });
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const displayHost = host.includes(':') ? `[${host}]` : host;
  return {
    server,
    host,
    port: boundPort,
    url: `http://${displayHost}:${boundPort}${path}`,
    close: async () => {
      await close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
