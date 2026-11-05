/**
 * Claim fencing. A claim is a lease on a ticket held by one actor. The holder
 * receives a random 32-byte token once, at claim time; the row and the chain
 * hold only sha256(token). Every fenced write presents the token; the row
 * compares hashes.
 *
 * validateFence checks in a fixed order so the error an agent sees is the
 * most specific one: wrong token → right token but a different holder (a
 * leaked token) → claim row without an expiry (corrupt) → expired lease.
 *
 * Leases are bounded (MAX_LEASE_SECONDS). Refresh extends by at most the same
 * bound and never shortens. Expiry is lazy: there is no sweeper; whichever
 * read or write first notices an expired lease treats the ticket as free and
 * records `sea_ticket.claim_expired` once.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { SeaError } from './errors.js';

/**
 * 0.4.0: 900 s by default (was 300), up to an hour (was 600). Leases are
 * renewed while the holder is active (any sea-lite tool call, `sea-lite
 * heartbeat` from a hook), so the default is how long a crashed or abandoned
 * holder keeps its lock, not how long a task may take.
 */
export const MAX_LEASE_SECONDS = 3600;
export const DEFAULT_LEASE_SECONDS = 900;

export interface ClaimFields {
  readonly id: string;
  readonly claim_token_hash: string | null;
  readonly claim_actor: string | null;
  readonly claim_expires_at: string | null;
}

export function newClaimToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function hashEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Constant-time: does `token` hash to `hash`? */
export function tokenMatches(hash: string | null, token: string): boolean {
  return hash !== null && hashEquals(hash, hashToken(token));
}

export function isExpired(expires_at: string | null, now: Date): boolean {
  return expires_at === null || Date.parse(expires_at) <= now.getTime();
}

/** True when the row carries a live claim as of `now`. */
export function hasLiveClaim(row: ClaimFields, now: Date): boolean {
  return row.claim_token_hash !== null && !isExpired(row.claim_expires_at, now);
}

/** Throws a SeaError unless `token` is the live fence held by `actor` on this row. */
export function validateFence(row: ClaimFields, token: string, actor: string, now: Date): void {
  // The token is the fence; the actor check catches a leaked token. Sessions
  // are not compared here: whoever holds the token is the holder's process.
  if (row.claim_token_hash === null || !hashEquals(row.claim_token_hash, hashToken(token))) {
    throw new SeaError('fence_invalid', `claim token does not fence ticket ${row.id}`, {
      ticket_id: row.id,
      held_by: row.claim_actor,
      claim_expires_at: row.claim_expires_at,
    });
  }
  if (row.claim_actor !== null && row.claim_actor !== actor) {
    throw new SeaError('fence_foreign_holder', `ticket ${row.id} is claimed by "${row.claim_actor}", not "${actor}"`, {
      ticket_id: row.id,
      held_by: row.claim_actor,
      claim_expires_at: row.claim_expires_at,
    });
  }
  if (row.claim_expires_at === null) {
    throw new SeaError('fence_invalid', `claim on ticket ${row.id} has no expiry`, { ticket_id: row.id });
  }
  if (isExpired(row.claim_expires_at, now)) {
    throw new SeaError('fence_expired', `claim on ticket ${row.id} expired at ${row.claim_expires_at}`, {
      ticket_id: row.id,
      claim_expires_at: row.claim_expires_at,
    });
  }
}

export function clampLease(seconds: number | undefined): number {
  const s = seconds ?? DEFAULT_LEASE_SECONDS;
  if (!Number.isInteger(s) || s < 1) throw new SeaError('invalid_input', 'lease_seconds must be a positive integer');
  if (s > MAX_LEASE_SECONDS) {
    throw new SeaError('invalid_input', `lease_seconds must be ≤ ${MAX_LEASE_SECONDS}`, { max: MAX_LEASE_SECONDS });
  }
  return s;
}

export function expiryFrom(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}
