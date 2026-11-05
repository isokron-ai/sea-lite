/**
 * Chain event vocabulary. Payload shapes are documented in docs/MODEL.md;
 * `rebuild.ts` is the authority on what each one does to the projection.
 *
 * Not chained: claim refresh (a heartbeat; it only touches the row). A rebuilt
 * projection therefore shows the lease as last chained, which is never longer
 * than the live one.
 */

export const EVENT = {
  ticket_created: 'sea_ticket.created',
  ticket_updated: 'sea_ticket.updated',
  ticket_status_set: 'sea_ticket.status_set',
  ticket_claimed: 'sea_ticket.claimed',
  ticket_claim_released: 'sea_ticket.claim_released',
  ticket_claim_force_released: 'sea_ticket.claim_force_released',
  ticket_claim_expired: 'sea_ticket.claim_expired',
  ticket_note_added: 'sea_ticket.note_added',
  link_created: 'sea_link.created',
  link_tombstoned: 'sea_link.tombstoned',
  batch_applied: 'sea.batch_applied',
  ticket_fields_set: 'sea_ticket.fields_set',
  lease_acquired: 'sea_lease.acquired',
  lease_released: 'sea_lease.released',
  lease_intent_opened: 'sea_lease.intent_opened',
  lease_intent_closed: 'sea_lease.intent_closed',
} as const;

export type SeaEventType = (typeof EVENT)[keyof typeof EVENT];

export const SEA_EVENT_TYPES: readonly SeaEventType[] = Object.freeze(Object.values(EVENT));

/** Every sea-lite event type starts with one of these. */
export const SEA_EVENT_PREFIXES = ['sea_ticket.', 'sea_link.', 'sea_lease.', 'sea.'] as const;

export function isSeaEventType(t: string): t is SeaEventType {
  return (SEA_EVENT_TYPES as readonly string[]).includes(t);
}

/** Idempotency keys share kronicle-lite's UNIQUE column; the prefix keeps namespaces apart. */
export const IDEMPOTENCY_PREFIX = 'sea:';

export function idemKey(key: string | undefined): string | undefined {
  return key === undefined ? undefined : IDEMPOTENCY_PREFIX + key;
}
