// Verbatim copy of src/audit/redact.ts at origin/main (d3eb8f1): the differential baseline for #8 (no true-positive regressions). Do not edit.
/**
 * Credential redaction before anything reaches the append-only chain (#6).
 *
 * kronicle-lite's write-time detectors anchor on word boundaries, so a key
 * glued to `_` (`_ghp_…_`, `key_phx_…`, `phx_…_x`) slipped through, and so
 * did any key that was base64- or URL-encoded. This layer adds key shapes
 * matched without a trailing word boundary, and decodes URL-encoded and
 * base64 / base64url runs to look inside them. A run whose decoded form holds
 * a credential is replaced whole.
 */

import { redactSecrets, scanForSecrets } from 'kronicle-lite';

/** Vendor key shapes; a key may be preceded by `_` or followed by anything (no `\b`). */
const KEY_SHAPES: readonly { id: string; re: RegExp }[] = [
  { id: 'github_token', re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/g },
  { id: 'github_pat', re: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{30,}/g },
  { id: 'posthog_personal_key', re: /(?<![A-Za-z0-9])phx_[A-Za-z0-9]{20,}/g },
  { id: 'aws_access_key', re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g },
  { id: 'slack_token', re: /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: 'stripe_key', re: /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { id: 'llm_api_key', re: /(?<![A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'google_api_key', re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g },
];

const URL_RUN = /[A-Za-z0-9._~%+-]*%[0-9A-Fa-f]{2}[A-Za-z0-9._~%+-]*/g;
const B64_RUN = /[A-Za-z0-9+/_-]{20,}={0,2}/g;

function hasKeyShape(s: string): boolean {
  return KEY_SHAPES.some((k) => new RegExp(k.re.source).test(s)) || scanForSecrets(s).length > 0;
}

function plain(text: string, field: string): string {
  let out = redactSecrets(text, field).text;
  for (const k of KEY_SHAPES) out = out.replace(k.re, `[REDACTED:${k.id}]`);
  return out;
}

function urlDecode(run: string): string {
  return run.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Decoded bytes as text when they are mostly printable, else null. */
function b64Decode(run: string): string | null {
  const buf = Buffer.from(run.replace(/=+$/, ''), 'base64');
  if (buf.length < 12) return null;
  let printable = 0;
  for (const b of buf) if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09) printable++;
  return printable / buf.length >= 0.9 ? buf.toString('latin1') : null;
}

/**
 * Replace every credential-shaped part of `text` with `[REDACTED:<detector>]`.
 * `redacted` says whether anything was replaced.
 */
export function redactText(text: string, field: string): { text: string; redacted: boolean } {
  let out = plain(text, field);
  out = out.replace(URL_RUN, (run) => (hasKeyShape(urlDecode(run)) ? '[REDACTED:url_encoded_secret]' : run));
  out = out.replace(B64_RUN, (run) => {
    const d = b64Decode(run);
    return d !== null && (hasKeyShape(d) || hasKeyShape(urlDecode(d))) ? '[REDACTED:base64_secret]' : run;
  });
  return { text: out, redacted: out !== text };
}

/** True when `value` holds anything redactText would replace: identity tokens are refused, not rewritten. */
export function looksLikeSecret(value: string): boolean {
  return redactText(value, 'value').redacted;
}
