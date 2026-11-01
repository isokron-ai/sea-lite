/**
 * SeaLite — opens (or adopts) a kronicle-lite store, adds the sea tables to
 * the same SQLite file, and exposes the thirteen operations as synchronous
 * methods. The MCP server and the CLI both talk to this.
 */

import { KronicleLite, type Chain, type Db, type KronicleLiteOptions } from 'kronicle-lite';

import { SeaError } from './core/errors.js';
import type { Ctx } from './core/repo.js';
import { SEA_MIGRATIONS, SEA_POST_MIGRATION_SQL, SEA_SCHEMA_META_KEY, SEA_SCHEMA_SQL, SEA_SCHEMA_VERSION } from './db/schema.js';
import * as claims from './handlers/claims.js';
import * as finishH from './handlers/finish.js';
import * as hist from './handlers/history.js';
import * as links from './handlers/links.js';
import * as statsH from './handlers/stats.js';
import * as tickets from './handlers/tickets.js';
import { waitForClaim, type Blocker, type WaitInfo } from './core/wait.js';
import { ROLES, TRACKS, type Role, type Track } from './model/enums.js';
import { DEFAULT_LIFECYCLE, type LifecycleConfig } from './model/lifecycle.js';
import type * as S from './model/schemas.js';
import { rebuild, verifySea, type RebuildResult, type SeaVerifyResult } from './rebuild.js';

export interface SeaLiteOptions {
  /** Directory of the shared kronicle-lite store (default ~/.kronicle-lite). */
  dataDir?: string;
  /** In-memory store with an ephemeral identity (tests). */
  memory?: boolean;
  /** Reuse an already-open kronicle-lite instance instead of opening one. */
  kronicle?: KronicleLite;
  /** Default actor for calls that do not pass actor_id. */
  actor?: string;
  /**
   * The session this store acts for (core/identity.ts). Null/omitted for
   * library use: claims then carry no session and ownership is by actor, as
   * before 0.4.0. `sea-lite serve` always sets one.
   */
  session?: string | null;
  /**
   * Project key (core/project.ts) stamped on new tickets and used to filter
   * list / next / scope checks. Null/omitted: every project (pre-0.4).
   */
  project?: string | null;
  /**
   * Repository root on this machine. When set, scope paths (claims, sea_next,
   * scope checks) are resolved through symlinks against it, so a link into a
   * claimed directory names the claimed files. `sea-lite serve` (stdio) and
   * the CLI set it; HTTP and library use leave it null (paths stay lexical).
   */
  root?: string | null;
  /** Self-asserted role; `operator` unlocks force release. */
  role?: Role;
  /** Enabled lifecycle tracks. Default ['work']. */
  tracks?: readonly Track[];
  /** Clock override (tests). */
  now?: () => Date;
}

export const DEFAULT_ACTOR = 'local-agent';

/** Minimum gap between two activity-driven lease renewals for one actor. */
export const TOUCH_INTERVAL_MS = 30_000;

export function parseTracks(raw: string | undefined): readonly Track[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LIFECYCLE.tracks;
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const p of parts) {
    if (!(TRACKS as readonly string[]).includes(p)) throw new SeaError('invalid_input', `unknown track "${p}" (valid: ${TRACKS.join(', ')})`);
  }
  const tracks = [...new Set(parts)] as Track[];
  if (!tracks.includes('work')) tracks.unshift('work');
  return tracks;
}

export function parseRole(raw: string | undefined): Role {
  if (raw === undefined || raw === '') return 'agent';
  if (!(ROLES as readonly string[]).includes(raw)) throw new SeaError('invalid_input', `unknown role "${raw}" (valid: ${ROLES.join(', ')})`);
  return raw as Role;
}

/** Cancellation and progress for a waiting claim (the MCP request's signal and progress token). */
export interface WaitHooks {
  signal?: AbortSignal | undefined;
  onProgress?: ((p: { elapsed_seconds: number; wait_seconds: number; blocked_by: Blocker }) => void) | undefined;
  progressEveryMs?: number;
}

export class SeaLite {
  readonly kronicle: KronicleLite;
  readonly db: Db;
  readonly chain: Chain;
  readonly actor: string;
  readonly session: string | null;
  readonly project: string | null;
  /** Repository root for symlink-resolving scope paths, or null (see SeaLiteOptions.root). */
  readonly root: string | null;
  readonly role: Role;
  readonly lifecycle: LifecycleConfig;
  /** Set on a hook's view (CLI scope-check / precommit): every claim of `session` is its own. */
  readonly sessionWide: boolean;
  private readonly ownsKronicle: boolean;
  private readonly clock: () => Date;

  constructor(opts: SeaLiteOptions = {}) {
    if (opts.kronicle) {
      this.kronicle = opts.kronicle;
      this.ownsKronicle = false;
    } else {
      const klOpts: KronicleLiteOptions = opts.memory ? { memory: true } : opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {};
      this.kronicle = new KronicleLite(klOpts);
      this.ownsKronicle = true;
    }
    this.db = this.kronicle.db;
    this.chain = this.kronicle.chain;
    this.actor = opts.actor ?? process.env['SEA_LITE_ACTOR'] ?? DEFAULT_ACTOR;
    this.session = opts.session ?? null;
    this.project = opts.project ?? null;
    this.root = opts.root ?? null;
    this.sessionWide = false;
    this.role = opts.role ?? parseRole(process.env['SEA_LITE_ROLE']);
    this.lifecycle = { tracks: opts.tracks ?? parseTracks(process.env['SEA_LITE_TRACKS']) };
    this.clock = opts.now ?? (() => new Date());
    ensureSeaSchema(this.db);
  }

  close(): void {
    if (this.ownsKronicle) this.kronicle.close();
  }

  /**
   * A view over this open store with another default actor (and role). Shares
   * the connection, the clock and the lifecycle; `close()` on the view is a
   * no-op. The HTTP transport builds one per request from the bearer token.
   */
  as(actor: string, role: Role = this.role, more: { session?: string | null; project?: string | null; sessionWide?: boolean } = {}): SeaLite {
    const view = Object.create(SeaLite.prototype) as SeaLite;
    Object.assign(view, {
      kronicle: this.kronicle,
      db: this.db,
      chain: this.chain,
      actor,
      session: more.session !== undefined ? more.session : this.session,
      project: more.project !== undefined ? more.project : this.project,
      root: this.root,
      sessionWide: more.sessionWide ?? this.sessionWide,
      role,
      lifecycle: this.lifecycle,
      ownsKronicle: false,
      clock: this.clock,
      lastTouch: this.lastTouch,
    });
    return view;
  }

  ctx(actor_id?: string): Ctx {
    return {
      db: this.db,
      chain: this.chain,
      actor: actor_id ?? this.actor,
      session: this.session,
      sessionWide: this.sessionWide,
      project: this.project,
      root: this.root,
      role: this.role,
      lifecycle: this.lifecycle,
      now: this.clock(),
    };
  }

  /** Renew the caller's own live claims by their lease; report the ones that had lapsed. Row only, like sea_refresh. */
  heartbeat(input: { actor_id?: string } = {}): claims.HeartbeatResult {
    return claims.heartbeat(this.ctx(input.actor_id));
  }

  private lastTouch = new Map<string, number>();
  /**
   * Auto-renewal on activity: the MCP layer calls this on every tool call.
   * At most one heartbeat per actor every TOUCH_INTERVAL_MS (store clock);
   * never throws.
   */
  touch(actor_id?: string): void {
    const key = `${actor_id ?? this.actor}\u0000${this.session ?? ''}`;
    const now = this.clock().getTime();
    const last = this.lastTouch.get(key);
    if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
    this.lastTouch.set(key, now);
    try {
      claims.heartbeat(this.ctx(actor_id), { quiet: true });
    } catch {
      // a busy database must not fail the caller's actual request
    }
  }

  create(input: S.CreateInput): tickets.CreateResult {
    return tickets.create(this.ctx(input.actor_id), input);
  }
  apply(input: S.ApplyInput): tickets.ApplyResult {
    return tickets.apply(this.ctx(input.actor_id), input);
  }
  get(input: S.GetInput): tickets.GetResult {
    return tickets.get(this.ctx(input.actor_id), input);
  }
  list(input: S.ListInput): tickets.ListResult {
    return tickets.list(this.ctx(input.actor_id), input);
  }
  update(input: S.UpdateInput): tickets.UpdateResult {
    return tickets.update(this.ctx(input.actor_id), input);
  }
  transition(input: S.TransitionInput): tickets.TransitionResult {
    return tickets.transition(this.ctx(input.actor_id), input);
  }
  /** Several tickets to one status, each fenced by its own token; all or nothing. */
  transitionMany(input: S.TransitionManyInput): tickets.TransitionManyResult {
    return tickets.transitionMany(this.ctx(input.actor_id), input);
  }
  /** End work on held tickets: outcome done | blocked | abandoned, a note, optional commit; claims released. */
  finish(input: S.FinishInput): finishH.FinishResult {
    return finishH.finish(this.ctx(input.actor_id), input);
  }
  claim(input: S.ClaimInput): claims.ClaimResult {
    return claims.claim(this.ctx(input.actor_id), input);
  }
  /**
   * sea_claim with `wait_seconds`: while the ticket or the scope is held by
   * someone else, wait (core/wait.ts) instead of failing; `wait_timeout`
   * names the holder and expiry if it never frees up.
   */
  async claimWait(input: S.ClaimInput, opts: WaitHooks = {}): Promise<claims.ClaimResult & { waited?: WaitInfo }> {
    const r = await waitForClaim(
      this.db,
      () => {
        const ctx = this.ctx(input.actor_id);
        try {
          return { ok: true, value: claims.claim(ctx, input) };
        } catch (e) {
          const b = claims.blockerOf(ctx, e);
          if (b === null) throw e;
          return { ok: false, blocker: b, error: e as SeaError };
        }
      },
      { ...opts, waitSeconds: input.wait_seconds ?? 0, freedBy: (b) => claims.freedBy(this.ctx(input.actor_id), b) },
    );
    return r.waited !== null ? { ...r.value, waited: r.waited } : r.value;
  }
  refresh(input: S.RefreshInput): claims.RefreshResult {
    return claims.refresh(this.ctx(input.actor_id), input);
  }
  release(input: S.ReleaseInput): claims.ReleaseResult {
    return claims.release(this.ctx(input.actor_id), input);
  }
  next(input: S.NextInput): claims.NextResult {
    return claims.next(this.ctx(input.actor_id), input);
  }
  /**
   * sea_next with `wait_seconds`: waits while the scope overlaps someone
   * else's, or while nothing is free but someone else holds work that could
   * free up (an eligible ticket, or a predecessor of one). An empty queue
   * returns at once.
   */
  async nextWait(input: S.NextInput, opts: WaitHooks = {}): Promise<claims.NextResult & { waited?: WaitInfo }> {
    const r = await waitForClaim(
      this.db,
      () => {
        const ctx = this.ctx(input.actor_id);
        try {
          const v = claims.next(ctx, input);
          if (v.ticket === null) {
            const b = claims.busyQueueBlocker(ctx);
            if (b !== null) {
              return { ok: false, blocker: b, error: new SeaError('nothing_eligible', 'nothing eligible yet: other holders have work in progress', { busy: b }) };
            }
          }
          return { ok: true, value: v };
        } catch (e) {
          const b = claims.blockerOf(ctx, e);
          if (b === null) throw e;
          return { ok: false, blocker: b, error: e as SeaError };
        }
      },
      { ...opts, waitSeconds: input.wait_seconds ?? 0, freedBy: (b) => claims.freedBy(this.ctx(input.actor_id), b) },
    ).catch((e: unknown) => {
      // Without a wait, a busy queue is the ordinary "nothing eligible" answer, not an error.
      if (e instanceof SeaError && e.code === 'nothing_eligible') return { value: claims.next(this.ctx(input.actor_id), input), waited: null };
      throw e;
    });
    return r.waited !== null ? { ...r.value, waited: r.waited } : r.value;
  }
  link(input: S.LinkInput): links.LinkResult {
    return links.link(this.ctx(input.actor_id), input);
  }
  history(input: S.HistoryInput): hist.HistoryResult {
    return hist.history(this.ctx(input.actor_id), input);
  }
  scopeCheck(input: S.ScopeCheckInput): claims.ScopeCheckResult {
    return claims.scopeCheck(this.ctx(input.actor_id), input);
  }
  /** Release every live claim bound to a worktree (CLI `release-worktree`, for a WorktreeRemove hook). */
  releaseWorktree(input: { worktree: string | readonly string[]; reason?: string; actor_id?: string }): claims.ReleaseWorktreeResult {
    return claims.releaseWorktree(this.ctx(input.actor_id), input);
  }
  stats(input: S.StatsInput): statsH.StatsResult {
    return statsH.stats(this.ctx(input.actor_id), input);
  }

  rebuild(): RebuildResult {
    return rebuild(this.db, this.chain);
  }
  verify(): SeaVerifyResult {
    return verifySea(this.db, this.chain);
  }
}

export function ensureSeaSchema(db: Db): void {
  db.pragma('busy_timeout = 5000');
  db.exec(SEA_SCHEMA_SQL);
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(SEA_SCHEMA_META_KEY) as { value: string } | undefined;
  if (row && Number(row.value) > SEA_SCHEMA_VERSION) {
    throw new Error(`sea-lite: store has sea_schema_version ${row.value}, newer than this build (${SEA_SCHEMA_VERSION}); upgrade sea-lite`);
  }
  // Additive column migrations for stores created by an older build. CREATE
  // TABLE IF NOT EXISTS above is a no-op on them, so add what is missing.
  db.transaction(() => {
    for (const m of SEA_MIGRATIONS) {
      const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === m.column)) db.exec(m.sql);
    }
    db.exec(SEA_POST_MIGRATION_SQL);
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(SEA_SCHEMA_META_KEY, String(SEA_SCHEMA_VERSION));
  }).immediate();
}
