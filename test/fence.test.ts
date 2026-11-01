import { describe, expect, it } from 'vitest';

import { clampLease, hashToken, hasLiveClaim, isExpired, MAX_LEASE_SECONDS, newClaimToken, validateFence } from '../src/core/fence.js';
import { codeOf } from './helpers.js';

const now = new Date('2026-10-31T12:00:00Z');
const later = new Date('2026-10-31T12:05:00Z').toISOString();
const earlier = new Date('2026-10-31T11:55:00Z').toISOString();

describe('claim tokens', () => {
  it('are 32 random bytes as hex and hash to sha256', () => {
    const t = newClaimToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(newClaimToken()).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toBe(t);
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('validateFence order', () => {
  const token = newClaimToken();
  const row = { id: 'tk', claim_token_hash: hashToken(token), claim_actor: 'alice', claim_expires_at: later };

  it('accepts the holder with a live lease', () => {
    expect(() => validateFence(row, token, 'alice', now)).not.toThrow();
  });

  it('token mismatch wins over everything else', () => {
    expect(codeOf(() => validateFence({ ...row, claim_actor: 'bob', claim_expires_at: earlier }, newClaimToken(), 'alice', now))).toBe('fence_invalid');
    expect(codeOf(() => validateFence({ ...row, claim_token_hash: null }, token, 'alice', now))).toBe('fence_invalid');
  });

  it('then a different holder (a leaked token), even if the lease is expired', () => {
    expect(codeOf(() => validateFence({ ...row, claim_expires_at: earlier }, token, 'mallory', now))).toBe('fence_foreign_holder');
  });

  it('then a missing expiry', () => {
    expect(codeOf(() => validateFence({ ...row, claim_expires_at: null }, token, 'alice', now))).toBe('fence_invalid');
  });

  it('then an expired lease', () => {
    expect(codeOf(() => validateFence({ ...row, claim_expires_at: earlier }, token, 'alice', now))).toBe('fence_expired');
    expect(codeOf(() => validateFence({ ...row, claim_expires_at: now.toISOString() }, token, 'alice', now))).toBe('fence_expired');
  });

  it('never reveals the hash in error details', () => {
    try {
      validateFence(row, newClaimToken(), 'alice', now);
    } catch (e) {
      const text = JSON.stringify((e as { toJSON(): unknown }).toJSON());
      expect(text).not.toContain(row.claim_token_hash);
      expect(text).toContain('alice');
    }
  });
});

describe('expiry and lease bounds', () => {
  it('isExpired treats null and past as expired', () => {
    expect(isExpired(null, now)).toBe(true);
    expect(isExpired(earlier, now)).toBe(true);
    expect(isExpired(later, now)).toBe(false);
  });

  it('hasLiveClaim needs both a hash and a future expiry', () => {
    expect(hasLiveClaim({ id: 'x', claim_token_hash: null, claim_actor: null, claim_expires_at: later }, now)).toBe(false);
    expect(hasLiveClaim({ id: 'x', claim_token_hash: 'h', claim_actor: 'a', claim_expires_at: earlier }, now)).toBe(false);
    expect(hasLiveClaim({ id: 'x', claim_token_hash: 'h', claim_actor: 'a', claim_expires_at: later }, now)).toBe(true);
  });

  it('clampLease defaults, rejects 0, negatives, floats and > 3600', () => {
    expect(clampLease(undefined)).toBe(900);
    expect(clampLease(MAX_LEASE_SECONDS)).toBe(3600);
    expect(codeOf(() => clampLease(0))).toBe('invalid_input');
    expect(codeOf(() => clampLease(-5))).toBe('invalid_input');
    expect(codeOf(() => clampLease(1.5))).toBe('invalid_input');
    expect(codeOf(() => clampLease(3601))).toBe('invalid_input');
  });
});
