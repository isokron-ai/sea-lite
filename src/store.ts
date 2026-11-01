/**
 * SeaLite — opens (or adopts) a kronicle-lite store, adds the sea tables to
 * the same SQLite file, and exposes the thirteen operations as synchronous
 * methods. The MCP server and the CLI both talk to this.
 */

import { KronicleLite, type Chain, type Db, type KronicleLiteOptions } from 'kronicle-lite';

import { SeaError } from './core/errors.js';
import type { Ctx } from './core/repo.js';
import { SEA_MIGRATIONS, SEA_SCHEMA_META_KEY, SEA_SCHEMA_SQL, SEA_SCHEMA_VERSION } from './db/schema.js';
import * as claims from './handlers/claims.js';
import * as hist from './handlers/history.js';
import * as links from './handlers/links.js';
import * as statsH from './handlers/stats.js';
import * as tickets from './handlers/tickets.js';
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
  /** Self-asserted role; `operator` unlocks force release. */
  role?: Role;
  /** Enabled lifecycle tracks. Default ['work']. */
  tracks?: readonly Track[];
  /** Clock override (tests). */
  now?: () => Date;
}

export const DEFAULT_ACTOR = 'local-agent';

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

export class SeaLite {
  readonly kronicle: KronicleLite;
  readonly db: Db;
  readonly chain: Chain;
  readonly actor: string;
  readonly role: Role;
  readonly lifecycle: LifecycleConfig;
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
  as(actor: string, role: Role = this.role): SeaLite {
    const view = Object.create(SeaLite.prototype) as SeaLite;
    Object.assign(view, {
      kronicle: this.kronicle,
      db: this.db,
      chain: this.chain,
      actor,
      role,
      lifecycle: this.lifecycle,
      ownsKronicle: false,
      clock: this.clock,
    });
    return view;
  }

  ctx(actor_id?: string): Ctx {
    return {
      db: this.db,
      chain: this.chain,
      actor: actor_id ?? this.actor,
      role: this.role,
      lifecycle: this.lifecycle,
      now: this.clock(),
    };
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
  claim(input: S.ClaimInput): claims.ClaimResult {
    return claims.claim(this.ctx(input.actor_id), input);
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
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(SEA_SCHEMA_META_KEY, String(SEA_SCHEMA_VERSION));
  }).immediate();
}
