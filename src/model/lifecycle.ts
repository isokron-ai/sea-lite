/**
 * Ticket lifecycle state machine. Pure data and functions; the mutator that
 * applies a transition lives in handlers/tickets.ts.
 *
 *   Work track (forward only, one step at a time):
 *     idea → triaged → in_progress → resolved
 *
 *   Design track (only when `tracks` includes `design`):
 *     idea → in_design → ready → in_progress
 *
 *   Holding states (non-terminal; enterable from any active state, exit only
 *   to a resumption point: idea / triaged / in_progress, plus in_design when
 *   the design track is on):
 *     parked | blocked | needs_decision
 *
 *   Terminal (no exit): resolved | wont_fix | duplicate | dropped | merged
 *
 * Any active (non-terminal) state may enter any holding or terminal state.
 * Same-state transitions are rejected as no-ops. Tombstoning is an event in
 * the chain, never a status.
 */

import {
  ALL_STATES,
  DESIGN_TRACK_STATES,
  HOLDING_SET,
  HOLDING_STATES,
  TERMINAL_SET,
  TERMINAL_STATES,
  WORK_TRACK_STATES,
  type TicketStatus,
  type Track,
} from './enums.js';

export interface LifecycleConfig {
  readonly tracks: readonly Track[];
}

export const DEFAULT_LIFECYCLE: LifecycleConfig = Object.freeze({ tracks: ['work'] as const });

const WORK_SUCCESSOR: ReadonlyMap<string, TicketStatus> = new Map<string, TicketStatus>([
  ['idea', 'triaged'],
  ['triaged', 'in_progress'],
  ['in_progress', 'resolved'],
]);

const DESIGN_SUCCESSOR: ReadonlyMap<string, TicketStatus> = new Map<string, TicketStatus>([
  ['idea', 'in_design'],
  ['in_design', 'ready'],
  ['ready', 'in_progress'],
]);

function designEnabled(cfg: LifecycleConfig): boolean {
  return cfg.tracks.includes('design');
}

function isDesignState(s: string): boolean {
  return (DESIGN_TRACK_STATES as readonly string[]).includes(s);
}

export function isKnownState(s: string): s is TicketStatus {
  return (ALL_STATES as readonly string[]).includes(s);
}

/** States a ticket may be in under this config (design states only when enabled). */
export function enabledStates(cfg: LifecycleConfig = DEFAULT_LIFECYCLE): readonly TicketStatus[] {
  return designEnabled(cfg) ? ALL_STATES : ALL_STATES.filter((s) => !isDesignState(s));
}

function holdingExitTargets(cfg: LifecycleConfig): readonly TicketStatus[] {
  return designEnabled(cfg) ? ['idea', 'triaged', 'in_progress', 'in_design'] : ['idea', 'triaged', 'in_progress'];
}

export type TransitionRejection =
  | 'unknown_state'
  | 'track_disabled'
  | 'no_op_transition'
  | 'terminal_state_no_exit'
  | 'illegal_holding_exit'
  | 'illegal_track_jump'
  | 'no_legal_path';

export interface TransitionValidation {
  readonly allowed: boolean;
  readonly reason?: TransitionRejection;
  readonly message?: string;
  /** Always populated on rejection so the caller can offer a correction. */
  readonly legal_next?: readonly TicketStatus[];
}

export function validateTransition(
  from: string,
  to: string,
  cfg: LifecycleConfig = DEFAULT_LIFECYCLE,
): TransitionValidation {
  if (!isKnownState(from)) {
    return { allowed: false, reason: 'unknown_state', message: `unknown 'from' state '${from}'`, legal_next: [] };
  }
  const legal_next = legalNextStates(from, cfg);
  if (!isKnownState(to)) {
    return { allowed: false, reason: 'unknown_state', message: `unknown 'to' state '${to}'`, legal_next };
  }
  if (!designEnabled(cfg) && (isDesignState(from) || isDesignState(to))) {
    return {
      allowed: false,
      reason: 'track_disabled',
      message: `'${isDesignState(to) ? to : from}' belongs to the design track, which is not enabled (tracks: ${cfg.tracks.join(', ')})`,
      legal_next,
    };
  }
  if (from === to) {
    return { allowed: false, reason: 'no_op_transition', message: `already '${from}'`, legal_next };
  }
  if (TERMINAL_SET.has(from)) {
    return { allowed: false, reason: 'terminal_state_no_exit', message: `'${from}' is terminal; no transitions out`, legal_next };
  }
  // `from` is active (non-terminal) from here on.
  if (HOLDING_SET.has(to) || TERMINAL_SET.has(to)) return { allowed: true, legal_next };

  if (HOLDING_SET.has(from)) {
    if (holdingExitTargets(cfg).includes(to)) return { allowed: true, legal_next };
    return {
      allowed: false,
      reason: 'illegal_holding_exit',
      message: `'${from}' may only resume to ${holdingExitTargets(cfg).join(' / ')}, not '${to}'`,
      legal_next,
    };
  }

  if (WORK_SUCCESSOR.get(from) === to) return { allowed: true, legal_next };
  if (designEnabled(cfg) && DESIGN_SUCCESSOR.get(from) === to) return { allowed: true, legal_next };

  if (isKnownState(to)) {
    return {
      allowed: false,
      reason: 'illegal_track_jump',
      message: `'${from}' → '${to}' is not a one-step move on any enabled track`,
      legal_next,
    };
  }
  return { allowed: false, reason: 'no_legal_path', message: `no legal path '${from}' → '${to}'`, legal_next };
}

/** Legal next states from `from`, in a stable order: track successors, holding, terminal. */
export function legalNextStates(from: string, cfg: LifecycleConfig = DEFAULT_LIFECYCLE): readonly TicketStatus[] {
  if (!isKnownState(from) || TERMINAL_SET.has(from)) return [];
  if (!designEnabled(cfg) && isDesignState(from)) return [];
  const next: TicketStatus[] = [];
  const push = (s: TicketStatus | undefined) => {
    if (s !== undefined && s !== from && !next.includes(s)) next.push(s);
  };
  if (HOLDING_SET.has(from)) {
    for (const t of holdingExitTargets(cfg)) push(t);
  } else {
    push(WORK_SUCCESSOR.get(from));
    if (designEnabled(cfg)) push(DESIGN_SUCCESSOR.get(from));
  }
  for (const h of HOLDING_STATES) push(h);
  for (const t of TERMINAL_STATES) push(t);
  return next;
}

/** Every legal (from, to) pair under the config; tests use it to pin the machine. */
export function enumerateLegalTransitions(cfg: LifecycleConfig = DEFAULT_LIFECYCLE): ReadonlyArray<{
  from: TicketStatus;
  to: TicketStatus;
}> {
  const out: { from: TicketStatus; to: TicketStatus }[] = [];
  for (const from of enabledStates(cfg)) for (const to of legalNextStates(from, cfg)) out.push({ from, to });
  return out;
}

export { WORK_TRACK_STATES, DESIGN_TRACK_STATES };
