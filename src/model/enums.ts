/**
 * Closed vocabularies. Every CHECK constraint in db/schema.ts and every zod
 * enum in model/schemas.ts is generated from these arrays, so adding a value
 * here is the whole change.
 */

/** What kind of work item a ticket frames. */
export const TICKET_KINDS = [
  'feature',
  'research',
  'investigation',
  'refactor',
  'curiosity',
  'question',
  'other',
  'bug',
  'chore',
  'incident',
  'security',
  'epic',
  'spike',
  'log',
  'docs',
  'decision',
] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'parked'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Lower sorts first in the queue. */
export const PRIORITY_RANK: Readonly<Record<Priority, number>> = Object.freeze({
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  parked: 4,
});

/** Work track: the default execution path. `idea` is the entry for every track. */
export const WORK_TRACK_STATES = ['idea', 'triaged', 'in_progress'] as const;

/** Optional design track (`tracks: [work, design]`): idea → in_design → ready → in_progress. */
export const DESIGN_TRACK_STATES = ['in_design', 'ready'] as const;

/** Holding states: enterable from any active state, exit only to a resumption point. */
export const HOLDING_STATES = ['parked', 'blocked', 'needs_decision'] as const;
export type HoldingState = (typeof HOLDING_STATES)[number];

/** No exit once entered. */
export const TERMINAL_STATES = ['resolved', 'wont_fix', 'duplicate', 'dropped', 'merged'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

export const ALL_STATES = [
  ...WORK_TRACK_STATES,
  ...DESIGN_TRACK_STATES,
  ...HOLDING_STATES,
  ...TERMINAL_STATES,
] as const;
export type TicketStatus = (typeof ALL_STATES)[number];

export const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_STATES);
export const HOLDING_SET: ReadonlySet<string> = new Set(HOLDING_STATES);

export function isTerminalStatus(s: string): s is TerminalState {
  return TERMINAL_SET.has(s);
}

/** Statuses sea_next will hand out. */
export const NEXT_ELIGIBLE_STATES = ['triaged', 'in_progress'] as const;

/** Idea-topology link types plus `duplicates`. Direction reads left to right: `from <type> to`. */
export const LINK_TYPES = [
  'parent_of',
  'relates_to',
  'inspired_by',
  'responds_to',
  'conflicts_with',
  'supersedes',
  'blocks',
  'depends_on',
  'condenses_into',
  'branches_from',
  'references',
  'duplicates',
] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/**
 * Link types that express precedence or containment and must stay acyclic.
 * Lifecycle edges (conflicts_with, supersedes, duplicates) may legitimately
 * form cycles and are not checked.
 */
export const DAG_LINK_TYPES: ReadonlySet<string> = new Set(['parent_of', 'depends_on', 'blocks', 'implements']);

/** `from` blocks `to`, or `from` depends_on `to`: these decide what sea_next may hand out. */
export const PREDECESSOR_LINK_TYPES = ['blocks', 'depends_on'] as const;

export const TRACKS = ['work', 'design'] as const;
export type Track = (typeof TRACKS)[number];

export const ROLES = ['agent', 'operator'] as const;
export type Role = (typeof ROLES)[number];

export const LINK_STATES = ['active', 'tombstoned'] as const;

export function sqlIn(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}
