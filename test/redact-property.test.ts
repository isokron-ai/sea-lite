/**
 * #8 stack review: real key formats are redacted by their documented shape
 * alone — 100 000 generated keys of each format, none may survive — and the
 * prefixes only count at a token boundary (ordinary ids that merely contain
 * `sk-`, `ghs_` or `npm_` pass). Kept in its own small file: it is the
 * heaviest redaction test.
 */

import { describe, expect, it } from 'vitest';

import { looksLikeSecret, redactText } from '../src/audit/redact.js';
import { SeaLite } from '../src/store.js';

function prng(seed: number): (alphabet: string, n: number) => string {
  let x = seed >>> 0;
  return (alphabet, n) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
      x = (x ^ (x >>> 13)) >>> 0;
      s += alphabet[x % alphabet.length];
    }
    return s;
  };
}
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64URL = A + '-_';
const D = '0123456789';
const HEX = '0123456789abcdef';
const slow = prng(2026);
/** Fast draws: a slice of a pre-generated random pool per alphabet at a random offset. */
const pools = new Map<string, string>();
const r = (alphabet: string, n: number): string => {
  let pool = pools.get(alphabet);
  if (pool === undefined) pools.set(alphabet, (pool = slow(alphabet, 1 << 18)));
  const at = Number.parseInt(slow(HEX, 5), 16) % (pool.length - n);
  return pool.slice(at, at + n);
};
const span = (lo: number, hi: number) => lo + (slow(D, 2).charCodeAt(1) % (hi - lo + 1));

const FORMATS: Record<string, () => string> = {
  'anthropic sk-ant-api03': () => 'sk-' + 'ant-api03-' + r(B64URL, 93) + 'AA',
  'openai sk-proj-': () => 'sk-' + 'proj-' + r(B64URL, 156),
  'openai sk-svcacct-': () => 'sk-' + 'svcacct-' + r(B64URL, 156),
  'openai legacy sk-': () => 'sk-' + r(A, 20) + 'T3BlbkFJ' + r(A, 20),
  'github ghp_': () => 'gh' + 'p_' + r(A, 36),
  'github gho_': () => 'gh' + 'o_' + r(A, 36),
  'github ghs_': () => 'gh' + 's_' + r(A, 36),
  'github fine-grained': () => 'github' + '_pat_' + r(A, 22) + '_' + r(A, 59),
  'slack xoxb': () => 'xo' + 'xb-' + r(D, span(10, 13)) + '-' + r(D, span(10, 13)) + '-' + r(A, 24),
  'slack xoxp': () => 'xo' + 'xp-' + r(D, span(10, 13)) + '-' + r(D, span(10, 13)) + '-' + r(D, 13) + '-' + r(HEX, 32),
  'slack xoxa-2': () => 'xo' + 'xa-2-' + r(D, 12) + '-' + r(D, 13) + '-' + r(HEX, 64),
  'slack xoxr': () => 'xo' + 'xr-' + r(D, 12) + '-' + r(D, 13) + '-' + r(A, 24),
  'aws AKIA': () => 'AKIA' + r('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16),
};

describe('#8 review: every generated key of a real format is redacted (shape only, no entropy gate)', () => {
  for (const [name, gen] of Object.entries(FORMATS)) {
    it(`${name}: 100 000 keys`, () => {
      const seps = [' ', '\n', ' token=', ', "', '\t'];
      for (let chunk = 0; chunk < 100; chunk++) {
        const keys = Array.from({ length: 1000 }, gen);
        const text = keys.map((k, i) => seps[i % seps.length] + k).join('') + ' ';
        const out = redactText(text, 'x').text;
        const left = out.replace(/\[REDACTED:[a-z_0-9]+\]/g, '');
        // only the separators may remain
        expect(left.replace(/ token=|, "|[\s]/g, ''), `${name}, chunk ${chunk}`).toBe('');
      }
    }, 60_000);
  }
});

describe('#8 review: prefixes count only at a token boundary', () => {
  const r2 = prng(7);
  const ulid = () => r2('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 26);
  const ids = [
    `task-${ulid()}`,
    `task-${r2(HEX, 32)}`,
    `disk-${r2(A, 32)}`,
    `risk-${ulid()}`,
    `helpdesk-${r2(A, 40)}`,
    `laughs_${r2(A, 30)}`,
    `snpm_${r2(A, 36)}`,
    `XAKIA${r2('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)}`,
    'sandbox:sk-prod-cluster-east-0001',
    'sk-create-sandbox-attempt-0001',
    'xoxb-prod-runner-pool-1',
    'F-sk-learn-regression-0001',
    'refs/heads/sk-proj-redaction-false-positives',
    'sk-proj-supercalifragilisticexpialidocious',
  ];
  for (const id of ids) {
    it(`${id.slice(0, 24)}… is an ordinary id: finding id, lease name, idempotency key`, () => {
      expect(looksLikeSecret(id)).toBe(false);
      expect(redactText(`see ${id} here`, 'x').redacted).toBe(false);
      const s = new SeaLite({ memory: true, actor: 'a' });
      const name = id.replace(/[^A-Za-z0-9._:@/-]/g, '.');
      const l = s.leaseAcquire({ name });
      s.leaseIntent({ name, token: l.token, op: 'op', idempotency_key: id });
      s.auditOpen({ audit_id: 'au', title: 't' });
      s.auditFinding('au', { finding_id: id.replace(/[^A-Za-z0-9._:@/#+-]/g, '.'), title: 't' });
      s.close();
    });
  }
  it('the glued forms the issue listed are still caught (GitHub and long OpenAI / Anthropic shapes)', () => {
    const ghp = 'gh' + 'p_' + r2(A, 36);
    for (const t of [`token${ghp}`, `1${ghp}`, `apikey${'sk-' + r2(A, 48)}`, `x${'sk-' + 'proj-' + r2(B64URL, 120)}`, `x${'sk-' + 'ant-api03-' + r2(B64URL, 93)}AA`]) {
      expect(looksLikeSecret(t), t.slice(0, 20)).toBe(true);
    }
  });
});
