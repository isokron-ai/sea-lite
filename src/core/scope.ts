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

/** Normalize one scope entry; throws invalid_input on anything that cannot be a repo-relative path. */
export function normalizeScopePath(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/');
  if (p.includes('\0')) throw new SeaError('invalid_input', 'scope path contains a NUL byte');
  if (p.startsWith('!')) throw new SeaError('invalid_input', `scope path "${raw}": negation is not supported`, { path: raw });
  if (/^[A-Za-z]:/.test(p) || p.startsWith('/')) {
    throw new SeaError('invalid_input', `scope path "${raw}" must be repo-relative, not absolute`, { path: raw });
  }
  p = p.replace(/\/{2,}/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  const dirMarked = p.endsWith('/');
  while (p.endsWith('/')) p = p.slice(0, -1);
  if (p === '' || p === '.') return WHOLE_REPO;
  const segments = p.split('/');
  if (segments.some((s) => s === '..')) throw new SeaError('invalid_input', `scope path "${raw}" must not climb out of the repo ("..")`, { path: raw });
  if (segments.some((s) => s === '.' || s === '')) {
    p = segments.filter((s) => s !== '.' && s !== '').join('/');
    if (p === '') return WHOLE_REPO;
  }
  // A trailing slash is kept only where it carries information: a file-looking
  // name that is really a directory (`next.js/`). Elsewhere it is noise.
  if (dirMarked && !isGlobEntry(p) && looksLikeFile(p)) p += '/';
  if (p.length > MAX_SCOPE_PATH_CHARS) throw new SeaError('invalid_input', `scope path longer than ${MAX_SCOPE_PATH_CHARS} characters`);
  return p;
}

/** Normalize, dedupe and sort a scope's paths. Sorted so the chain payload is canonical. */
export function normalizeScope(paths: readonly string[]): string[] {
  if (paths.length === 0) throw new SeaError('invalid_input', 'scope.paths must not be empty');
  if (paths.length > MAX_SCOPE_PATHS) throw new SeaError('invalid_input', `scope.paths may hold at most ${MAX_SCOPE_PATHS} entries`, { max: MAX_SCOPE_PATHS });
  const out = new Set<string>();
  for (const raw of paths) out.add(normalizeScopePath(raw));
  if (out.has(WHOLE_REPO)) return [WHOLE_REPO];
  return [...out].sort();
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
