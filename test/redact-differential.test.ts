/**
 * #8 third review: zero true-positive regressions against main. Every key
 * main's redactor caught must still be caught: 50 000 generated bare `sk-`
 * bodies per class, plus the keys the issue and earlier reviews used.
 */

import { describe, expect, it } from 'vitest';

import { looksLikeSecret } from '../src/audit/redact.js';
import { looksLikeSecret as mainLooksLikeSecret } from './fixtures/redact-main.js';

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
const LC = 'abcdefghijklmnopqrstuvwxyz';
const UC = LC.toUpperCase();
const D = '0123456789';
const r = prng(808);

const CLASSES: [string, () => string][] = [
  ['20 lowercase+digit', () => r(LC + D, 20)],
  ['32 lowercase+digit', () => r(LC + D, 32)],
  ['64 lowercase+digit', () => r(LC + D, 64)],
  ['40 uppercase+digit', () => r(UC + D, 40)],
  ['40 lowercase letters', () => r(LC, 40)],
  ['20 mixed case+digit', () => r(LC + UC + D, 20)],
  ['24 mixed case+digit', () => r(LC + UC + D, 24)],
  ['48 mixed case+digit (legacy)', () => r(LC + UC + D, 48)],
];

describe('#8 differential: every bare sk- key main redacted is still redacted (50 000 per class)', () => {
  for (const [name, gen] of CLASSES) {
    it(name, () => {
      const missed: string[] = [];
      let caughtByMain = 0;
      for (let i = 0; i < 50_000; i++) {
        const key = 'sk-' + gen();
        if (!mainLooksLikeSecret(key)) continue;
        caughtByMain++;
        if (!looksLikeSecret(key)) missed.push(key);
      }
      expect(caughtByMain).toBeGreaterThan(0);
      expect(missed.slice(0, 5), `${missed.length} of ${caughtByMain} missed`).toEqual([]);
    }, 120_000);
  }
  for (const [name, gen] of [
    ['sk-proj- + 40 lowercase letters', () => 'sk-' + 'proj-' + r(LC, 40)],
    ['sk-proj- + 24 lowercase+digit', () => 'sk-' + 'proj-' + r(LC + D, 24)],
    ['sk-ant- + 32 uppercase+digit', () => 'sk-' + 'ant-' + r(UC + D, 32)],
    ['sk-svcacct- + 20 mixed', () => 'sk-' + 'svcacct-' + r(LC + UC + D, 20)],
  ] as const) {
    it(`${name}: what main caught is still caught`, () => {
      const missed: string[] = [];
      let caught = 0;
      for (let i = 0; i < 50_000; i++) {
        const key = gen();
        if (!mainLooksLikeSecret(key)) continue;
        caught++;
        if (!looksLikeSecret(key)) missed.push(key);
      }
      expect(caught).toBeGreaterThan(0);
      expect(missed.slice(0, 5), `${missed.length} of ${caught} missed`).toEqual([]);
    }, 120_000);
  }
  it('the keys the issue and the reviews used', () => {
    const r2 = prng(9);
    const A = LC + UC + D;
    const keys = [
      'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
      'phx_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0',
      'sk-' + r2(A, 48),
      'sk-' + 'proj-' + r2(A + '-_', 120),
      'sk-' + 'proj-Xq7Lm2Pw4Rt6Yv8Nb1KcT3BlbkFJ3Hd5Jf7Gs9Qa2Ze4Ux6Wo8',
      'sk-' + 'ant-api03-' + r2(A + '-_', 93) + 'AA',
      'xo' + 'xb-' + r2(D, 12) + '-' + r2(D, 13) + '-' + r2(A, 24),
      'sk-' + r2(LC + D, 20),
      'sk-' + r2(LC, 40),
    ];
    for (const k of keys) {
      expect(mainLooksLikeSecret(k), `main: ${k.slice(0, 12)}`).toBe(true);
      expect(looksLikeSecret(k), k.slice(0, 12)).toBe(true);
    }
  });
});
