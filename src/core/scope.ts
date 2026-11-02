/**
 * Path-scoped claims. A claim may carry a scope: the repo-relative paths the
 * holder is going to touch. Two live scopes held by different actors must
 * not overlap, so an agent that locks `src/handlers` cannot be surprised by
 * another agent editing `src/handlers/claims.ts` under a different ticket.
 *
 * Entries are either a **prefix** (no glob characters): the path itself and,
 * when it looks like a directory, everything beneath it — `src`,
 * `src/handlers`, `README.md`; or a **glob**
 * (picomatch syntax): exactly the files it matches — `src/**` + `/*.ts`,
 * `docs/*.md`. `*` does not cross `/`; `**` does. `.` (or an empty entry)
 * is the whole repository.
 *
 * Overlap is decided segment by segment (see `entriesOverlap`): literal
 * segments must be equal, a pattern segment must match the literal it is
 * compared with, `**` is tried against every suffix, and a prefix entry
 * that runs out while the other entry continues overlaps (the other path is
 * inside its subtree) whereas a glob that runs out does not (globs match
 * whole paths). Two pattern segments are compared on their literal head and
 * tail (`*.ts` vs `*.md` cannot share a file; `*.ts` vs `*.test.ts` can).
 * The rule errs toward reporting an overlap only where two patterns are
 * genuinely ambiguous.
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, sep } from 'node:path';

import picomatch from 'picomatch';

import { SeaError } from './errors.js';

export const MAX_SCOPE_PATHS = 64;
export const MAX_SCOPE_PATH_CHARS = 512;

/** Whole-repository scope. */
export const WHOLE_REPO = '.';

export interface Scope {
  paths: string[];
}

// `(` and `)` are deliberately not glob characters here: Next.js route groups such as `app/(auth)` are literal paths.
const GLOB_CHARS = /[*?[\]{}]/;

export function isGlobEntry(entry: string): boolean {
  return GLOB_CHARS.test(entry);
}

/**
 * Normalize one scope entry; throws invalid_input on anything that cannot be a repo-relative path.
 * `..` segments are resolved lexically (`src/../src/x` is `src/x`); one that
 * would climb above the repository root, or that follows a glob segment, is
 * invalid_input. With `keepParents`, the `..` segments are validated the same
 * way but kept, for canonicalScopePath to resolve them on disk (after a
 * symlinked directory, `..` is the link target's parent, as for the OS).
 */
export function normalizeScopePath(raw: string, opts: { keepParents?: boolean } = {}): string {
  let p = raw.trim().replace(/\\/g, '/');
  if (p.includes('\0')) throw new SeaError('invalid_input', 'scope path contains a NUL byte');
  if (p.startsWith('!')) throw new SeaError('invalid_input', `scope path "${raw}": negation is not supported`, { path: raw });
  if (/^[A-Za-z]:/.test(p) || p.startsWith('/')) {
    throw new SeaError('invalid_input', `scope path "${raw}" must be repo-relative, not absolute`, { path: raw });
  }
  const dirMarked = /\/\.{0,2}$/.test(p) || p === '..';
  const kept: string[] = [];
  let depth = 0;
  let afterGlob = false;
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (afterGlob) throw new SeaError('invalid_input', `scope path "${raw}": ".." after a glob segment is ambiguous`, { path: raw });
      if (depth === 0) throw new SeaError('invalid_input', `scope path "${raw}" must not climb out of the repo ("..")`, { path: raw });
      depth--;
      if (opts.keepParents === true) kept.push(s);
      else kept.pop();
      continue;
    }
    if (isGlobEntry(s)) afterGlob = true;
    depth++;
    kept.push(s);
  }
  p = kept.join('/');
  if (p === '') return WHOLE_REPO;
  // A trailing slash is kept only where it carries information: a file-looking
  // name that is really a directory (`next.js/`). Elsewhere it is noise.
  if (dirMarked && !isGlobEntry(p) && looksLikeFile(p)) p += '/';
  if (p.length > MAX_SCOPE_PATH_CHARS) throw new SeaError('invalid_input', `scope path longer than ${MAX_SCOPE_PATH_CHARS} characters`);
  return p;
}

/**
 * Normalize, dedupe and sort a scope's paths. Sorted so the chain payload is
 * canonical. With the repository `root` known (stdio server, CLI, hooks),
 * every entry is also resolved through symlinks (see canonicalScopePath), so
 * `hlink/claims.ts` and `src/handlers/claims.ts` are the same path to every
 * claim and every check.
 */
export function normalizeScope(paths: readonly string[], root: string | null = null): string[] {
  if (paths.length === 0) throw new SeaError('invalid_input', 'scope.paths must not be empty');
  if (paths.length > MAX_SCOPE_PATHS) throw new SeaError('invalid_input', `scope.paths may hold at most ${MAX_SCOPE_PATHS} entries`, { max: MAX_SCOPE_PATHS });
  const out = new Set<string>();
  for (const raw of paths) {
    out.add(root !== null ? canonicalScopePath(root, normalizeScopePath(raw, { keepParents: true }), raw) : normalizeScopePath(raw));
  }
  if (out.has(WHOLE_REPO)) return [WHOLE_REPO];
  return [...out].sort();
}

const realRoots = new Map<string, string>();
function realRoot(root: string): string {
  let r = realRoots.get(root);
  if (r === undefined) {
    try {
      r = realpathSync.native(root);
    } catch {
      r = root;
    }
    realRoots.set(root, r);
  }
  return r;
}

/** Symbolic links followed by hand (dangling ones) before a path is given up as a loop; Linux's own limit. */
const MAX_LINK_HOPS = 40;

/**
 * realpath of the longest existing prefix of `segs` under `base`, with the
 * rest appended as written; undefined when that prefix is a link realpath
 * cannot follow (dangling, or a loop). `segs` hold no `..`.
 */
function realOfLongestExisting(base: string, segs: readonly string[]): string | undefined {
  for (let i = segs.length; i > 0; i--) {
    const candidate = join(base, ...segs.slice(0, i));
    try {
      lstatSync(candidate);
    } catch {
      continue; // does not exist: try a shorter prefix
    }
    try {
      return join(realpathSync.native(candidate), ...segs.slice(i));
    } catch {
      return undefined;
    }
  }
  return join(base, ...segs);
}

/**
 * Resolve `segs` from the physical directory `start` the way the OS would
 * open the path, one segment at a time: `..` is the parent of where the walk
 * is (so after a symlinked directory it is the target's parent), an existing
 * link is followed through realpath, and a dangling link is followed
 * lexically: its target, taken relative to the link's directory, is walked in
 * turn (a write through the link creates that file). A missing segment and
 * everything after it is kept as written. Null on a link loop (more than
 * MAX_LINK_HOPS links followed by hand).
 */
function physicalWalk(start: string, segs: readonly string[]): string | null {
  let hops = 0;
  const walkFrom = (from: string, parts: readonly string[]): string | null => {
    let cur = from;
    for (const seg of parts) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        cur = dirname(cur);
        continue;
      }
      const next = join(cur, seg);
      let isLink: boolean;
      try {
        isLink = lstatSync(next).isSymbolicLink();
      } catch {
        cur = next; // missing: nothing below it can be a link
        continue;
      }
      if (!isLink) {
        cur = next;
        continue;
      }
      try {
        cur = realpathSync.native(next);
        continue;
      } catch {
        // dangling, or a loop: follow it by hand
      }
      if (++hops > MAX_LINK_HOPS) return null;
      let target: string;
      try {
        target = readlinkSync(next).replace(/^\\\\\?\\/, '');
      } catch {
        return null;
      }
      const troot = isAbsolute(target) ? parsePath(target).root : '';
      const r = walkFrom(troot !== '' ? troot : cur, target.slice(troot.length).split(/[\\/]+/));
      if (r === null) return null;
      cur = r;
    }
    return cur;
  };
  return walkFrom(start, segs);
}

/** The platform's canonical spelling of an absolute path's existing part (case and 8.3 names on Windows), rest as given. */
function canonicalAbs(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail.reverse());
    } catch {
      // missing: try the parent
    }
    const up = dirname(cur);
    if (up === cur) return p;
    tail.push(basename(cur));
    cur = up;
  }
}

/**
 * A normalized repo-relative entry, resolved through symlinks the way the OS
 * opens it: an existing link is replaced by its realpath, a dangling link by
 * its target resolved lexically (writing through it would create that file),
 * and `..` (kept by normalizeScopePath's `keepParents`) is the parent of the
 * physical directory reached so far. The result is repo-relative again; the
 * part from the first glob segment on is kept as written. A link that
 * resolves outside the repository is invalid_input (`reason:
 * "outside_repo"`): it would name files no scope in this project can lock. A
 * link loop is kept as written (`..` resolved lexically): nothing can be
 * written through it. Uses the platform's realpath (`realpathSync.native`,
 * canonical case on Windows) and returns `/`-separated paths on every OS.
 */
export function canonicalScopePath(root: string, entry: string, raw: string = entry): string {
  if (entry === WHOLE_REPO) return entry;
  const slash = entry.endsWith('/');
  const segs = (slash ? entry.slice(0, -1) : entry).split('/');
  // A trailing slash or `..` names a directory; the slash is kept where it carries information (see normalizeScopePath).
  const dirMarked = slash || segs[segs.length - 1] === '..';
  let literal = segs.findIndex((x) => isGlobEntry(x));
  if (literal === -1) literal = segs.length;
  const head = segs.slice(0, literal);
  const base = realRoot(root);
  let real = head.includes('..') ? undefined : realOfLongestExisting(base, head);
  if (real === undefined) {
    const walked = physicalWalk(base, head);
    if (walked === null) return normalizeScopePath(entry);
    real = canonicalAbs(walked);
  }
  const rel = relative(base, real);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new SeaError('invalid_input', `scope path "${raw}" resolves outside the repository through a symlink (${real})`, {
      path: raw,
      reason: 'outside_repo',
      resolved: real,
    });
  }
  const out = [...(rel === '' ? [] : rel.split(sep)), ...segs.slice(literal)].join('/');
  if (out === '') return WHOLE_REPO;
  return dirMarked && !isGlobEntry(out) && looksLikeFile(out) ? `${out}/` : out;
}

interface Parsed {
  entry: string;
  segments: string[];
  isPrefix: boolean;
  /** A prefix that can have paths beneath it (a directory, as far as the string can tell). */
  isSubtree: boolean;
}

/**
 * A prefix whose last segment carries an extension (`claims.ts`, `.env.local`,
 * `README.md`) is a file: nothing lies beneath it, so a glob that would only
 * match deeper paths does not overlap it. The string cannot say for sure
 * (`next.js/` could be a directory); claim a dotted directory as `name.d/**`
 * or `name.d/` to be explicit — a trailing slash marks a directory.
 */
const FILE_LIKE = /(^|\/)\.?[^./][^/]*\.[A-Za-z0-9]{1,8}$/;
export function looksLikeFile(entry: string): boolean {
  return FILE_LIKE.test(entry);
}

const parseCache = new Map<string, Parsed>();
function parse(entry: string): Parsed {
  let p = parseCache.get(entry);
  if (!p) {
    const isPrefix = !isGlobEntry(entry);
    const dirMarked = entry.endsWith('/');
    const segments = (dirMarked ? entry.slice(0, -1) : entry).split('/');
    p = { entry, segments, isPrefix, isSubtree: isPrefix && (dirMarked || !looksLikeFile(entry)) };
    if (parseCache.size > 4096) parseCache.clear();
    parseCache.set(entry, p);
  }
  return p;
}

const matcherCache = new Map<string, (s: string) => boolean>();
function segmentMatcher(pattern: string): (s: string) => boolean {
  let m = matcherCache.get(pattern);
  if (!m) {
    m = picomatch(pattern, { dot: true, nocase: false });
    if (matcherCache.size > 4096) matcherCache.clear();
    matcherCache.set(pattern, m);
  }
  return m;
}

function literalHead(pattern: string): string {
  const i = pattern.search(GLOB_CHARS);
  return i < 0 ? pattern : pattern.slice(0, i);
}

function literalTail(pattern: string): string {
  let i = pattern.length - 1;
  while (i >= 0 && !GLOB_CHARS.test(pattern[i]!)) i--;
  return pattern.slice(i + 1);
}

/** Can two single path segments name the same file? */
function segmentsOverlap(a: string, b: string): boolean {
  const ag = isGlobEntry(a);
  const bg = isGlobEntry(b);
  if (!ag && !bg) return a === b;
  if (ag && !bg) return segmentMatcher(a)(b);
  if (!ag && bg) return segmentMatcher(b)(a);
  // Both patterns: provably disjoint only when their literal heads or tails disagree.
  const ha = literalHead(a);
  const hb = literalHead(b);
  if (!(ha.startsWith(hb) || hb.startsWith(ha))) return false;
  const ta = literalTail(a);
  const tb = literalTail(b);
  if (!(ta.endsWith(tb) || tb.endsWith(ta))) return false;
  return true;
}

function walk(a: Parsed, i: number, b: Parsed, j: number): boolean {
  const aDone = i >= a.segments.length;
  const bDone = j >= b.segments.length;
  if (aDone && bDone) return true;
  if (aDone) return a.isSubtree; // b is inside a's subtree; a glob (or a file) that ran out matched a shorter path only
  if (bDone) return b.isSubtree;
  const xa = a.segments[i]!;
  const xb = b.segments[j]!;
  if (xa === '**') {
    for (let k = j; k <= b.segments.length; k++) if (walk(a, i + 1, b, k)) return true;
    return false;
  }
  if (xb === '**') {
    for (let k = i; k <= a.segments.length; k++) if (walk(a, k, b, j + 1)) return true;
    return false;
  }
  if (!segmentsOverlap(xa, xb)) return false;
  return walk(a, i + 1, b, j + 1);
}

/** True when the two normalized scope entries can name the same file. Symmetric. */
export function entriesOverlap(a: string, b: string): boolean {
  if (a === WHOLE_REPO || b === WHOLE_REPO) return true;
  return walk(parse(a), 0, parse(b), 0);
}

export interface OverlapPair {
  requested: string;
  held: string;
}

/** Every (requested, held) pair that overlaps. Empty means the scopes are disjoint. */
export function findOverlaps(requested: readonly string[], held: readonly string[]): OverlapPair[] {
  const pairs: OverlapPair[] = [];
  for (const r of requested) for (const h of held) if (entriesOverlap(r, h)) pairs.push({ requested: r, held: h });
  return pairs;
}

export const MAX_WORKTREE_CHARS = 1024;

/** Drive-letter (`c:/…`) or UNC (`//host/share/…`) path: compared case-insensitively. */
function isWindowsPath(p: string): boolean {
  return /^[a-z]:\//.test(p) || p.startsWith('//');
}

/**
 * Normalize an absolute worktree path so the same directory always yields
 * the same string, whatever the client's platform: backslashes become `/`,
 * `.` / `..` / repeated separators are resolved, a trailing separator is
 * dropped, and a drive letter is lower-cased (`C:\\repo\\wt-1\\` →
 * `c:/repo/wt-1`). Purely lexical — no filesystem access, no symlink
 * resolution (the path may be gone by the time a hook releases it).
 */
export function normalizeWorktreePath(raw: string): string {
  let p = raw.trim();
  if (p.includes('\0')) throw new SeaError('invalid_input', 'worktree path contains a NUL byte');
  if (p.length > MAX_WORKTREE_CHARS) throw new SeaError('invalid_input', `worktree path longer than ${MAX_WORKTREE_CHARS} characters`);
  p = p.replace(/\\/g, '/');
  let prefix: string;
  const drive = /^([A-Za-z]):(\/|$)/.exec(p);
  if (drive) {
    prefix = drive[1]!.toLowerCase() + ':/';
    p = p.slice(drive[0].length);
  } else if (p.startsWith('//')) {
    prefix = '//';
    p = p.slice(2);
  } else if (p.startsWith('/')) {
    prefix = '/';
    p = p.slice(1);
  } else {
    throw new SeaError('invalid_input', `worktree "${raw}" must be an absolute path`, { worktree: raw });
  }
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  if (prefix === '//' && out.length < 2) throw new SeaError('invalid_input', `worktree "${raw}": a UNC path needs //host/share`, { worktree: raw });
  return prefix + out.join('/');
}

/** Two normalized worktree paths name the same directory (case-insensitive on Windows-style paths). */
export function sameWorktree(a: string, b: string): boolean {
  return isWindowsPath(a) && isWindowsPath(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The scope argument of sea_claim / sea_next, normalized: the paths it locks
 * (or null) and the worktree it binds to (or null). At least one is required.
 */
export function resolveClaimScope(
  input: { paths?: readonly string[] | undefined; worktree?: string | undefined } | undefined,
  root: string | null = null,
): {
  scope: Scope | null;
  worktree: string | null;
} {
  if (input === undefined) return { scope: null, worktree: null };
  const hasPaths = input.paths !== undefined && input.paths.length > 0;
  if (!hasPaths && input.worktree === undefined) throw new SeaError('invalid_input', 'scope needs paths, a worktree, or both');
  return {
    scope: hasPaths ? { paths: normalizeScope(input.paths!, root) } : null,
    worktree: input.worktree !== undefined ? normalizeWorktreePath(input.worktree) : null,
  };
}

export function parseScopeJson(json: string | null): Scope | null {
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as unknown;
    if (Array.isArray(v)) return { paths: v.filter((x): x is string => typeof x === 'string') };
    if (v && typeof v === 'object' && Array.isArray((v as { paths?: unknown }).paths)) {
      return { paths: ((v as { paths: unknown[] }).paths).filter((x): x is string => typeof x === 'string') };
    }
    return null;
  } catch {
    return null;
  }
}
