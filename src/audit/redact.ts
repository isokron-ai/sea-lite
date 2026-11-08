/**
 * Credential redaction before anything reaches the append-only chain (#6, #8).
 *
 * #6 added key shapes without a trailing word boundary and looked inside
 * URL-encoded and base64 runs. #8 (review of #7) found four problems:
 *
 * - False positives. `sk-` and `xox?-` had no entropy check, so ordinary ids
 *   (`sandbox:sk-prod-cluster-east-0001`, `xoxb-prod-runner-pool-1`) were
 *   refused. Those two families now need a body that looks random (see
 *   `randomLooking`); the long vendor prefixes (`ghp_`, `phx_`, …) keep a
 *   length check only.
 * - Quadratic time (about 130 ms per 8 KB cell, inside the write
 *   transaction). Every pattern here is either led by a literal or bounded,
 *   decoded text is scanned under a budget, and the callers redact before
 *   they open the transaction.
 * - Misses: a letter or digit glued in front of a key (prefixes are now
 *   matched anywhere), base64 of `x`+key, base64 in URL paths (each `/`
 *   segment and every 4-byte alignment is tried), MIME-wrapped base64
 *   (consecutive base64 lines are joined), hex, and nested encodings (decoded
 *   text is scanned again, up to MAX_DEPTH levels).
 *
 * kronicle-lite's write-time detectors (`WRITE_DETECTORS`) are mirrored here
 * with bounded quantifiers, because some of theirs backtrack quadratically on
 * long lines; a parity test checks that everything they flag is redacted.
 */

interface Span {
  start: number;
  end: number;
  id: string;
}

/** Nesting of encodings looked through (base64 of base64 of hex …); printable text nested deeper is treated as a secret. */
const MAX_DEPTH = 4;
/** Decoded bytes are scanned as text only when at least this share is printable. */
const PRINTABLE_MIN = 0.9;
/** How much of a key body is examined: enough to judge it, small enough to keep the scan linear. */
const BODY_WINDOW = 160;

// ── vendor keys: a literal prefix, matched anywhere (no boundary), then a body ──

const ALNUM = 0;
const ALNUM_US = 1;
const ALNUM_DASH = 2;
const ALNUM_US_DASH = 3;
const UPPER_DIGIT = 4;

function inClass(c: number, cls: number): boolean {
  const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  switch (cls) {
    case ALNUM:
      return alnum;
    case ALNUM_US:
      return alnum || c === 95;
    case ALNUM_DASH:
      return alnum || c === 45;
    case ALNUM_US_DASH:
      return alnum || c === 95 || c === 45;
    default:
      return (c >= 48 && c <= 57) || (c >= 65 && c <= 90);
  }
}

interface Vendor {
  id: string;
  cls: number;
  /** The documented shape of the body that follows the prefix; `glued`: the prefix is not at a token boundary. */
  accept: (body: string, glued: boolean) => boolean;
  /** Exact body length (the body is cut there; the next char must not continue it). */
  exact?: number;
}

/**
 * #8 stack review: well-known formats are matched by their documented shape
 * and length only (an entropy gate let ~1 in 6 000 real Anthropic keys
 * through), and a prefix counts only at a token boundary (start, or after a
 * non-alphanumeric character), so `task-…`, `disk-…`, `laughs_…`, `snpm_…`
 * are ordinary ids. A prefix glued to a letter or digit (`tokenghp_…`) still
 * counts when the body has the full length of its format: exactly 36 for
 * GitHub's `gh?_`, 80+ for fine-grained / project / Anthropic keys, exactly
 * 48 alphanumerics for a legacy `sk-` key. Only a bare `sk-` with none of
 * those shapes goes through the randomness check.
 */
const PREFIX = /gh[pousr]_|github_pat_|glpat-|phx_|xox[abprse]-|sk-ant-|sk-(?:proj|svcacct|admin)-|sk-|[sr]k_(?:live|test)_|AIza|npm_|hvs\.|dp\.(?:pt|st|ct|sa|scim|audit)\.|AKIA|ASIA/g;

const atLeast = (n: number) => (b: string, glued: boolean) => !glued && b.length >= n;
/** Slack: numeric segments, then the secret (`xoxb-<team>-<bot>-<24>`, `xoxp-…-…-…-<32 hex>`, `xoxa-2-…`). */
const SLACK_SHAPE = /^(?:\d+-){1,4}[A-Za-z0-9]{16,}/;
/** Base64 of "OpenAI": inside every OpenAI key body, whatever its length. */
const OPENAI_MARKER = 'T3BlbkFJ';

/**
 * Class switches (lower / upper / digit) inside separator-delimited runs,
 * not counting a Capitalized word's first switch. Random keys switch
 * constantly; slugs of words, all-digit and single-case runs hardly at all
 * (`fix-issue123-redaction` 1, `New-York-2024-Q3-Report` 1).
 */
export function switches(body: string): number {
  let t = 0;
  let prev = 0;
  let pos = 0;
  for (let i = 0; i < body.length && i < BODY_WINDOW; i++) {
    const c = body.charCodeAt(i);
    const k = c >= 48 && c <= 57 ? 1 : c >= 65 && c <= 90 ? 2 : c >= 97 && c <= 122 ? 4 : 0;
    if (k === 0) {
      prev = pos = 0;
      continue;
    }
    if (prev !== 0 && prev !== k && !(pos === 1 && prev === 2 && k === 4)) t++;
    prev = k;
    pos++;
  }
  return t;
}
/** #8 re-review: what a glued key or a long subtype body must also show — not a slug, not all letters, not all digits. */
const keyish = (b: string) => switches(b) >= 3 && /[0-9]/.test(b) && /[A-Za-z]/.test(b);

/** Share of vowels among the letters (words run ~35-45%, random letters ~19%); 1 when there are fewer than 8 letters. */
export function vowelShare(body: string): number {
  let letters = 0;
  let vowels = 0;
  for (let i = 0; i < body.length && i < BODY_WINDOW; i++) {
    const c = body.charCodeAt(i) | 0x20;
    if (c < 97 || c > 122) continue;
    letters++;
    if (c === 97 || c === 101 || c === 105 || c === 111 || c === 117) vowels++;
  }
  return letters < 8 ? 1 : vowels / letters;
}

/**
 * `sk-ant-` / `sk-proj-` / `sk-svcacct-` / `sk-admin-`: a random-looking body
 * — 20+ characters unglued with 3+ class switches (or 2 and few vowels, so a
 * lowercase-heavy random key is not mistaken for a slug), 80+ glued and
 * keyish. #8 re-review: this accepts every body the bare `sk-` rule would
 * (the OpenAI marker alone has 4 switches; a randomLooking body has 5+), so a
 * subtype's non-match never hides a key the fallback would have caught;
 * the property test pins it.
 */
const subtype = (b: string, glued: boolean) =>
  glued ? b.length >= 80 && keyish(b) : b.length >= 20 && (switches(b) >= 3 || (switches(b) === 2 && vowelShare(b) < 0.3));

function vendorOf(prefix: string): Vendor {
  if (prefix === 'github_pat_') return { id: 'github_pat', cls: ALNUM_US, accept: (b, glued) => (glued ? b.length >= 80 && keyish(b) : b.length >= 30) };
  if (prefix.startsWith('gh')) return { id: 'github_token', cls: ALNUM, accept: (b, glued) => (glued ? b.length === 36 && keyish(b) : b.length >= 30) };
  if (prefix === 'glpat-') return { id: 'gitlab_token', cls: ALNUM_US_DASH, accept: atLeast(20) };
  if (prefix === 'phx_') return { id: 'posthog_personal_key', cls: ALNUM, accept: atLeast(20) };
  if (prefix.startsWith('xox')) return { id: 'slack_token', cls: ALNUM_DASH, accept: (b, glued) => !glued && SLACK_SHAPE.test(b) };
  if (prefix === 'sk-ant-') return { id: 'anthropic_key', cls: ALNUM_US_DASH, accept: subtype };
  if (prefix !== 'sk-' && prefix.startsWith('sk-')) return { id: 'llm_api_key', cls: ALNUM_US_DASH, accept: subtype };
  if (prefix === 'sk-') return { id: 'llm_api_key', cls: ALNUM_US_DASH, accept: BARE_SK };
  if (prefix.endsWith('_live_') || prefix.endsWith('_test_')) return { id: 'stripe_key', cls: ALNUM, accept: atLeast(16) };
  if (prefix === 'AIza') return { id: 'google_api_key', cls: ALNUM_US_DASH, exact: 35, accept: atLeast(35) };
  if (prefix === 'npm_') return { id: 'npm_token', cls: ALNUM, accept: atLeast(36) };
  if (prefix === 'hvs.') return { id: 'vault_token', cls: ALNUM_US_DASH, accept: atLeast(24) };
  if (prefix.startsWith('dp.')) return { id: 'doppler_token', cls: ALNUM, accept: atLeast(32) };
  return { id: 'aws_access_key', cls: UPPER_DIGIT, exact: 16, accept: (b, glued) => !glued && b.length === 16 && !b.includes('EXAMPLE') };
}

/** A bare `sk-`: the OpenAI marker, a legacy 48-alphanumeric body, or (unglued) a random-looking one. */
function BARE_SK(b: string, glued: boolean): boolean {
  return b.includes(OPENAI_MARKER) || (/^[A-Za-z0-9]{48}$/.test(b) && (!glued || keyish(b))) || (!glued && b.length >= 20 && randomLooking(b));
}

/**
 * A key body, not a name: some run of letters and digits between separators
 * is at least 16 long and either switches between lower / upper / digit at
 * least 5 times and on at least a quarter of its characters (random base62
 * switches on ~60%, `createsandboxattempt0001` once, `Build2024Release` 4
 * times), or is 32+ hex digits.
 */
export function randomLooking(body: string): boolean {
  const w = body.slice(0, BODY_WINDOW);
  let len = 0;
  let transitions = 0;
  let prev = 0;
  let hex = true;
  let seen = 0;
  const good = () => len >= 16 && ((transitions >= 5 && transitions >= (len - 1) * 0.25) || (len >= 32 && hex && seen === 5));
  for (let i = 0; i <= w.length; i++) {
    const c = i < w.length ? w.charCodeAt(i) : 0;
    const k = c >= 48 && c <= 57 ? 1 : c >= 65 && c <= 90 ? 2 : c >= 97 && c <= 122 ? 4 : 0;
    if (k === 0) {
      if (good()) return true;
      len = transitions = prev = seen = 0;
      hex = true;
      continue;
    }
    len++;
    seen |= k;
    if (k === 2 || (k === 4 && c > 102)) hex = false; // why: lowercase hex only, the form hex secrets take
    if (prev !== 0 && prev !== k) transitions++;
    prev = k;
  }
  return false;
}

function vendorSpans(text: string, out: Span[]): void {
  const re = new RegExp(PREFIX.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = vendorOf(m[0]);
    const from = m.index + m[0].length;
    const before = m.index > 0 ? text.charCodeAt(m.index - 1) : 0;
    const glued = inClass(before, ALNUM);
    let j = from;
    const cap = v.exact ?? BODY_WINDOW;
    while (j < text.length && j - from < cap && inClass(text.charCodeAt(j), v.cls)) j++;
    let ok = !(j < text.length && j - from === cap && v.exact !== undefined && inClass(text.charCodeAt(j), v.cls));
    // why: a body longer than the window is judged by its first BODY_WINDOW chars; its length is at least that.
    if (ok) ok = v.accept(text.slice(from, j), glued);
    if (!ok) continue; // why: resume right after the prefix; at most BODY_WINDOW chars were read for it
    if (v.exact === undefined) while (j < text.length && inClass(text.charCodeAt(j), v.cls)) j++;
    out.push({ start: m.index, end: j, id: v.id });
    re.lastIndex = j;
  }
}

// ── context detectors (kronicle-lite's WRITE_DETECTORS, bounded) ──

const PLACEHOLDER =
  /^(?:<[^>]*>|\$\{\{[^}]*\}\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{\{[^}]*\}\}|%[A-Za-z_]+%|\*+|x+|X+|\.{3,}|…|password|passwd|pass|pwd|secret|changeme|example|placeholder|redacted|your[-_a-z]*|my[-_a-z]*|<redacted>|\[REDACTED[^\]]*\])$/i;
function isPlaceholder(v: string): boolean {
  const t = v.replace(/^['"]|['"]$/g, '');
  return PLACEHOLDER.test(t) || /example|placeholder|your[-_]|changeme|REDACTED/i.test(t);
}
function looksLikeCredential(raw: string): boolean {
  const v = raw.trim().replace(/^['"]|['"]$/g, '');
  return /[0-9]/.test(v) && /[A-Za-z]/.test(v) && !/[().]|environ|getenv|^\$|^%|secrets?\./i.test(v);
}

interface Context {
  id: string;
  re: RegExp;
  /** Capture group holding the value: a placeholder there is not a secret. */
  value?: number;
  accept?: (m: RegExpExecArray) => boolean;
}

const CONTEXT: readonly Context[] = [
  { id: 'aws_secret_key', re: /aws_secret_access_key[ \t]{0,8}[:=][ \t]{0,8}['"]?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi, value: 1 },
  { id: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/g },
  {
    id: 'connection_string',
    re: /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`<>]{1,256}:([^\s@/'"`]{1,256})@[^\s'"`]{1,512}/gi,
    value: 1,
  },
  { id: 'bearer_token', re: /\b(?:Bearer|Basic)[ \t]{1,8}([A-Za-z0-9_\-.~+/]{20,2048}=*)/g, value: 1, accept: (m) => /[0-9]/.test(m[1]!) },
  {
    id: 'env_secret',
    re: /^[ \t]{0,32}(?:export[ \t]{1,8})?[A-Z0-9_]{0,48}(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]{0,24}[ \t]{0,8}[:=][ \t]{0,8}(['"]?[^\s'"#]{8,1024}['"]?)/gm,
    value: 1,
    accept: (m) => looksLikeCredential(m[1]!),
  },
  {
    id: 'config_secret',
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret)["']?[ \t]{0,8}[:=][ \t]{0,8}(['"]?[^\s'"#,;]{8,1024}['"]?)/gi,
    value: 1,
    accept: (m) => looksLikeCredential(m[1]!),
  },
];

const PEM_BEGIN = /-----BEGIN (?:[A-Z]{1,20} ){0,4}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END (?:[A-Z]{1,20} ){0,4}PRIVATE KEY(?: BLOCK)?-----/g;

/** A private key block: header to footer, or (no footer) through the base64 lines after the header. */
function pemSpans(text: string, out: Span[]): void {
  const begin = new RegExp(PEM_BEGIN.source, 'g');
  const endRe = new RegExp(PEM_END.source, 'g');
  let nextEnd: { at: number; to: number } | null | undefined; // undefined: not searched past `searchedTo` yet
  let searchedTo = -1;
  let m: RegExpExecArray | null;
  while ((m = begin.exec(text)) !== null) {
    const from = m.index + m[0].length;
    if (nextEnd === undefined || (nextEnd !== null && nextEnd.at < from) || (nextEnd === null && searchedTo < from)) {
      // why: each footer search starts where the last one stopped, so many headers cost one pass.
      endRe.lastIndex = Math.max(from, searchedTo);
      const e = endRe.exec(text);
      nextEnd = e ? { at: e.index, to: e.index + e[0].length } : null;
      searchedTo = e ? e.index : text.length;
    }
    let to: number;
    if (nextEnd) to = nextEnd.to;
    else {
      to = from;
      for (;;) {
        const nl = text.indexOf('\n', to + 1);
        const line = text.slice(to + 1, nl === -1 ? text.length : nl);
        if (!/^[A-Za-z0-9+/=:\- \r\t]*$/.test(line) || (line.trim() === '' && to > from)) break;
        to = nl === -1 ? text.length : nl;
        if (nl === -1) break;
      }
    }
    if (/[A-Za-z0-9+/=]{40,}/.test(text.slice(from, to))) out.push({ start: m.index, end: to, id: 'private_key' });
    // why: a later header before the same footer sees a suffix of this block, so it cannot do better; skip it.
    begin.lastIndex = Math.max(begin.lastIndex, to);
  }
}

function contextSpans(text: string, out: Span[]): void {
  pemSpans(text, out);
  for (const d of CONTEXT) {
    const re = new RegExp(d.re.source, d.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (d.value !== undefined && isPlaceholder(m[d.value] ?? '')) continue;
      if (d.accept && !d.accept(m)) continue;
      out.push({ start: m.index, end: m.index + m[0].length, id: d.id });
    }
  }
}

// ── encodings ──

interface Scan {
  /** Characters of decoded text still allowed to be scanned (keeps nesting linear); below 0: give up, fail closed. */
  budget: number;
}

class OverBudget extends Error {}

function printable(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  let p = 0;
  for (const b of buf) if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09) p++;
  return p / buf.length >= PRINTABLE_MIN;
}

/** True when `decoded` (from an encoded run) holds a credential, or is text nested deeper than MAX_DEPTH (fail closed). */
function decodedHits(decoded: Buffer, s: Scan, depth: number): boolean {
  if (!printable(decoded)) return false;
  if (depth + 1 > MAX_DEPTH) return true;
  s.budget -= decoded.length;
  if (s.budget < 0) throw new OverBudget();
  return scan(decoded.toString('latin1'), s, depth + 1).length > 0;
}

/** base64 / base64url at every 4-char alignment (a glued prefix shifts it). */
function base64Hits(run: string, s: Scan, depth: number): boolean {
  for (let off = 0; off < 4 && run.length - off >= 16; off++) {
    if (decodedHits(Buffer.from(run.slice(off).replace(/=+$/, ''), 'base64'), s, depth)) return true;
  }
  return false;
}

function hexHits(run: string, s: Scan, depth: number): boolean {
  for (let off = 0; off < 2 && run.length - off >= 32; off++) {
    const h = run.slice(off, off + ((run.length - off) & ~1));
    if (decodedHits(Buffer.from(h, 'hex'), s, depth)) return true;
  }
  return false;
}

function urlDecode(run: string): string {
  return run.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

const RUN = /[^\s"'`<>]+/g;
const B64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const HEX_RUN = /[0-9A-Fa-f]{32,}/g;
const MIME_LINE = /^[ \t]*[A-Za-z0-9+/]{4,}={0,2}[ \t]*\r?$/;

/** `direct` is sorted and disjoint (merged); runs arrive in order, so one pointer walks it. */
function encodedSpans(text: string, s: Scan, depth: number, direct: readonly Span[], out: Span[]): void {
  const runs = new RegExp(RUN.source, 'g');
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = runs.exec(text)) !== null) {
    const run = m[0];
    const at = m.index;
    while (k < direct.length && direct[k]!.end <= at) k++;
    if (run.length < 16 || (k < direct.length && direct[k]!.start <= at && direct[k]!.end >= at + run.length)) continue;
    if (/%[0-9A-Fa-f]{2}/.test(run)) {
      const d = urlDecode(run);
      s.budget -= d.length;
      if (s.budget < 0) throw new OverBudget();
      if (depth + 1 > MAX_DEPTH || scan(d, s, depth + 1).length > 0) {
        out.push({ start: at, end: at + run.length, id: 'url_encoded_secret' });
        continue;
      }
    }
    const b64 = new RegExp(B64_RUN.source, 'g');
    let c: RegExpExecArray | null;
    let hit = false;
    while (!hit && (c = b64.exec(run)) !== null) {
      // why: base64 in a URL path: the whole run, and each `/` segment on its own.
      const parts = c[0].includes('/') ? [c[0], ...c[0].split('/').filter((p) => p.length >= 16)] : [c[0]];
      hit = parts.some((p) => base64Hits(p, s, depth));
    }
    if (hit) {
      out.push({ start: at, end: at + run.length, id: 'base64_secret' });
      continue;
    }
    const hex = new RegExp(HEX_RUN.source, 'g');
    while (!hit && (c = hex.exec(run)) !== null) hit = hexHits(c[0], s, depth);
    if (hit) out.push({ start: at, end: at + run.length, id: 'hex_secret' });
  }
  mimeSpans(text, s, depth, out);
}

function isB64Char(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47;
}

/**
 * MIME / PEM-style wrapped base64: consecutive base64-only lines, joined and
 * decoded as one, together with the base64 tail of the line before (`data:
 * AAAA…`) and the base64 head of the line after (`…== here`).
 */
function mimeSpans(text: string, s: Scan, depth: number, out: Span[]): void {
  const lines: { start: number; end: number }[] = [];
  for (let at = 0; ; ) {
    const nl = text.indexOf('\n', at);
    lines.push({ start: at, end: nl === -1 ? text.length : nl });
    if (nl === -1) break;
    at = nl + 1;
  }
  const line = (i: number) => text.slice(lines[i]!.start, lines[i]!.end);
  let i = 0;
  while (i < lines.length) {
    if (!MIME_LINE.test(line(i))) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < lines.length && MIME_LINE.test(line(j + 1))) j++;
    const parts: string[] = [];
    let start = lines[i]!.start;
    let end = lines[j]!.end;
    if (i > 0) {
      const prev = lines[i - 1]!;
      let e = prev.end;
      if (e > prev.start && text.charCodeAt(e - 1) === 13) e--;
      let t = e;
      while (t > prev.start && isB64Char(text.charCodeAt(t - 1))) t--;
      if (t < e) {
        parts.push(text.slice(t, e));
        start = t;
      }
    }
    for (let k = i; k <= j; k++) parts.push(line(k).trim());
    if (j + 1 < lines.length) {
      const h = /^[ \t]*([A-Za-z0-9+/]+={0,2})/.exec(line(j + 1));
      if (h) {
        parts.push(h[1]!);
        end = lines[j + 1]!.start + h[0].length;
      }
    }
    if (parts.length >= 2 && base64Hits(parts.join(''), s, depth)) out.push({ start, end, id: 'base64_secret' });
    i = j + 1;
  }
}

// ── driver ──

function scan(text: string, s: Scan, depth: number): Span[] {
  const direct: Span[] = [];
  vendorSpans(text, direct);
  contextSpans(text, direct);
  const merged = merge(direct);
  const enc: Span[] = [];
  encodedSpans(text, s, depth, merged, enc);
  return enc.length === 0 ? merged : merge([...merged, ...enc]);
}

/** Overlapping spans merged, in order. */
function merge(spans: Span[]): Span[] {
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const x of spans) {
    const last = out[out.length - 1];
    if (last && x.start < last.end) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

/**
 * Replace every credential-shaped part of `text` with `[REDACTED:<detector>]`.
 * `redacted` says whether anything was replaced. Linear in `text.length`;
 * input whose nested encodings would exceed the scan budget is replaced whole
 * (`[REDACTED:undecidable]`): fail closed.
 */
export function redactText(text: string, field: string): { text: string; redacted: boolean } {
  void field;
  return redactWithBudget(text, 8 * text.length + 4096);
}

/** redactText with an explicit budget of decoded characters (exported for the fail-closed test). */
export function redactWithBudget(text: string, budget: number): { text: string; redacted: boolean } {
  let spans: Span[];
  try {
    spans = merge(scan(text, { budget }, 0));
  } catch (e) {
    if (e instanceof OverBudget) return { text: '[REDACTED:undecidable]', redacted: true };
    throw e;
  }
  if (spans.length === 0) return { text, redacted: false };
  let out = '';
  let pos = 0;
  for (const x of spans) {
    out += text.slice(pos, x.start) + `[REDACTED:${x.id}]`;
    pos = x.end;
  }
  return { text: out + text.slice(pos), redacted: true };
}

/** True when `value` holds anything redactText would replace: identity tokens are refused, not rewritten. */
export function looksLikeSecret(value: string): boolean {
  return redactText(value, 'value').redacted;
}
