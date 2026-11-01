/**
 * sea-lite public API. Most users want the CLI (`sea-lite serve`); this
 * module is for embedding the queue or building another transport.
 */

export { SeaLite, ensureSeaSchema, parseRole, parseTracks, DEFAULT_ACTOR, TOUCH_INTERVAL_MS, type SeaLiteOptions } from './store.js';
export {
  holderLabel,
  shortSession,
  sameOwner,
  sessionKeyFromEnv,
  newInstanceSession,
  registerInstance,
  listInstances,
  resolveIdentity as resolveCliIdentity,
  ancestors,
  pidAlive,
  SESSIONS_DIR,
  type Owner,
  type InstanceEntry,
  type ResolvedIdentity,
  type IdentitySource,
} from './core/identity.js';
export { projectKeyFor, resolveProject, findRepo, normalizeRemote, originUrl, ALL_PROJECTS, type RepoInfo } from './core/project.js';
export { createServer, errorResult, type ServerOptions } from './server.js';
export {
  serveHttp,
  createHttpListener,
  loadOrCreateBearer,
  readBearerFile,
  parseActorsFile,
  readActorsFile,
  addActorToken,
  tokenSha256,
  resolveIdentity,
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTP_PATH,
  BEARER_FILE_NAME,
  ACTORS_FILE_NAME,
  type HttpServeOptions,
  type HttpServeHandle,
  type HttpIdentity,
  type ActorToken,
} from './http.js';
export { rebuild, verifySea, applySeaEvent, type RebuildResult, type SeaVerifyResult } from './rebuild.js';
export { SEA_SCHEMA_SQL, SEA_DROP_SQL, SEA_SCHEMA_VERSION, SEA_SCHEMA_META_KEY, SEA_TABLES, SEA_MIGRATIONS } from './db/schema.js';
export * from './model/enums.js';
export * from './model/lifecycle.js';
export * from './model/cycle-check.js';
export * as schemas from './model/schemas.js';
export { SeaError, ERROR_CODES, type ErrorCode } from './core/errors.js';
export {
  validateFence,
  hashToken,
  newClaimToken,
  hasLiveClaim,
  isExpired,
  clampLease,
  MAX_LEASE_SECONDS,
  DEFAULT_LEASE_SECONDS,
  type ClaimFields,
} from './core/fence.js';
export { EVENT, SEA_EVENT_TYPES, SEA_EVENT_PREFIXES, IDEMPOTENCY_PREFIX, isSeaEventType, type SeaEventType } from './core/events.js';
export type { Ticket, TicketCompact, TicketRow, LinkRow, LinkView, NoteRow, ClaimView } from './core/types.js';
export { ownsClaim, projectFilter, type Ctx } from './core/repo.js';
export type { CreateResult, ApplyResult, UpdateResult, TransitionResult, GetResult, ListResult, LinkWithPeer } from './handlers/tickets.js';
export type { ClaimResult, RefreshResult, ReleaseResult, NextResult, ScopeCheckResult, ScopeConflict, ReleaseWorktreeResult, HeartbeatResult } from './handlers/claims.js';
export { findScopeConflicts, assertScopeFree } from './handlers/claims.js';
export {
  normalizeScope,
  normalizeScopePath,
  normalizeWorktreePath,
  sameWorktree,
  resolveClaimScope,
  MAX_WORKTREE_CHARS,
  entriesOverlap,
  findOverlaps,
  isGlobEntry,
  parseScopeJson,
  MAX_SCOPE_PATHS,
  MAX_SCOPE_PATH_CHARS,
  WHOLE_REPO,
  type Scope,
  type OverlapPair,
} from './core/scope.js';
export type { LinkResult } from './handlers/links.js';
export type { HistoryResult, HistoryEntry } from './handlers/history.js';
export { runDoctor, renderDoctor, type DoctorReport, type DoctorCheck, type DoctorOptions, type CheckStatus } from './doctor.js';
export { CATALOG_FINGERPRINT, CATALOG_VERSION, liveCatalogFingerprint } from './catalog.js';
export { parseSince, type StatsResult, type ActorStats } from './handlers/stats.js';
export { findPossibleDuplicates, titleMatchExpression, type PossibleDuplicate } from './handlers/dedup.js';
