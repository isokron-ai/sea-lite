/**
 * Idempotency keys bound to their request.
 *
 * Every keyed write stores `request_hash` — sha256 of the canonical JSON
 * (RFC 8785) of {op, request} — in the payload of the event that
 * carries the key. A later call with the same key replays only if its own
 * hash matches; a different request under a reused key is `invalid_input`
 * ("idempotency_key reused with a different request"), never a replay of
 * the first result. The request excludes what does not change the intent:
 * the key itself, dry_run, verbose / confirm, claim tokens (fences, which
 * rotate) and the caller's identity (a key names the request, so the same
 * request retried from another process or session replays); ticket ids are
 * resolved to full ids, and a templated sea_apply is
 * hashed after expansion, so the same templates always hash the same.
 *
 * Events written before request hashes existed (sea-lite < 0.6.0) carry
 * none. C2-07 (0.6.2): a key bound to one of those is refused
 * (`invalid_input`, reason `unverifiable_key`) instead of replayed — it
 * cannot be checked, and replaying it silently returned the old result for a
 * different request after an upgrade.
 */

import { canonicalize, sha256Hex, type ChainEvent } from 'kronicle-lite';

import { SeaError } from './errors.js';
import type { Ctx } from './repo.js';
import { resolveId } from './repo.js';

export function requestHash(op: string, request: unknown): string {
  const clean = JSON.parse(JSON.stringify(request ?? null)) as unknown;
  return sha256Hex(canonicalize({ op, request: clean } as never));
}

/** A ticket id as the request means it: the full id when it resolves, else as written. */
export function idForHash(ctx: Ctx, raw: string): string {
  try {
    return resolveId(ctx.db, raw);
  } catch {
    return raw;
  }
}

/**
 * The prior event for `key` (namespaced), or null. Throws when the key was
 * used for another operation or with a different request.
 */
export function priorFor(ctx: Ctx, rawKey: string | undefined, key: string | undefined, types: readonly string[], hash: string): ChainEvent | null {
  if (key === undefined) return null;
  const prior = ctx.chain.findByIdempotencyKey(key);
  if (!prior) return null;
  if (!types.includes(prior.event_type)) {
    throw new SeaError('invalid_input', `idempotency_key was used for a different operation (${prior.event_type})`, {
      idempotency_key: rawKey ?? key,
      reason: 'other_operation',
    });
  }
  assertSameRequest(prior, rawKey ?? key, hash);
  return prior;
}

export function assertSameRequest(prior: ChainEvent, rawKey: string, hash: string): void {
  const h = prior.payload['request_hash'];
  if (typeof h !== 'string') {
    throw new SeaError(
      'invalid_input',
      `idempotency_key "${rawKey}" is bound to seq ${prior.seq}, written before request hashes (sea-lite < 0.6.0), so this request cannot be checked against it; nothing was written. ` +
        `If this retries that request, it already took effect (sea_history from seq ${prior.seq}); otherwise use a new key`,
      { idempotency_key: rawKey, reason: 'unverifiable_key', first_seq: prior.seq },
    );
  }
  if (h !== hash) {
    throw new SeaError('invalid_input', `idempotency_key "${rawKey}" reused with a different request; nothing was written (the key is bound to seq ${prior.seq})`, {
      idempotency_key: rawKey,
      reason: 'request_mismatch',
      first_seq: prior.seq,
    });
  }
}
