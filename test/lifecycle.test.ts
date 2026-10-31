import { describe, expect, it } from 'vitest';

import { ALL_STATES, HOLDING_STATES, TERMINAL_STATES, type TicketStatus } from '../src/model/enums.js';
import {
  DEFAULT_LIFECYCLE,
  enabledStates,
  enumerateLegalTransitions,
  legalNextStates,
  validateTransition,
  type LifecycleConfig,
} from '../src/model/lifecycle.js';

const DESIGN: LifecycleConfig = { tracks: ['work', 'design'] };

/** The complete legal table for the default (work-only) config. */
const WORK_TABLE: Record<string, readonly TicketStatus[]> = {
  idea: ['triaged', ...HOLDING_STATES, ...TERMINAL_STATES],
  triaged: ['in_progress', ...HOLDING_STATES, ...TERMINAL_STATES],
  in_progress: [...HOLDING_STATES, ...TERMINAL_STATES],
  parked: ['idea', 'triaged', 'in_progress', 'blocked', 'needs_decision', ...TERMINAL_STATES],
  blocked: ['idea', 'triaged', 'in_progress', 'parked', 'needs_decision', ...TERMINAL_STATES],
  needs_decision: ['idea', 'triaged', 'in_progress', 'parked', 'blocked', ...TERMINAL_STATES],
  resolved: [],
  wont_fix: [],
  duplicate: [],
  dropped: [],
  merged: [],
};

describe('lifecycle (work track)', () => {
  it('enabled states exclude the design track by default', () => {
    expect(enabledStates()).not.toContain('in_design');
    expect(enabledStates()).not.toContain('ready');
    expect(enabledStates(DESIGN)).toEqual(ALL_STATES);
  });

  it('every (from, to) pair agrees with the table', () => {
    for (const from of enabledStates()) {
      const legal = new Set(WORK_TABLE[from]);
      expect(new Set(legalNextStates(from))).toEqual(legal);
      for (const to of ALL_STATES) {
        const v = validateTransition(from, to);
        expect(v.allowed, `${from} → ${to}`).toBe(legal.has(to));
        if (!v.allowed) {
          expect(v.reason).toBeDefined();
          expect(v.legal_next).toEqual(legalNextStates(from));
        }
      }
    }
  });

  it('names the rejection reason', () => {
    expect(validateTransition('idea', 'idea').reason).toBe('no_op_transition');
    expect(validateTransition('resolved', 'idea').reason).toBe('terminal_state_no_exit');
    expect(validateTransition('idea', 'in_progress').reason).toBe('illegal_track_jump');
    expect(validateTransition('parked', 'resolved').allowed).toBe(true);
    expect(validateTransition('idea', 'in_design').reason).toBe('track_disabled');
    expect(validateTransition('nope', 'idea').reason).toBe('unknown_state');
    expect(validateTransition('idea', 'nope').reason).toBe('unknown_state');
  });

  it('terminal states have no exits; holding states exit only to resumption points', () => {
    for (const t of TERMINAL_STATES) expect(legalNextStates(t)).toEqual([]);
    for (const h of HOLDING_STATES) {
      const next = legalNextStates(h);
      expect(next).toContain('idea');
      expect(next).toContain('triaged');
      expect(next).toContain('in_progress');
      expect(next).not.toContain('in_design');
    }
  });

  it('enumerateLegalTransitions is consistent with validateTransition', () => {
    const pairs = enumerateLegalTransitions(DEFAULT_LIFECYCLE);
    expect(pairs.length).toBeGreaterThan(40);
    for (const { from, to } of pairs) expect(validateTransition(from, to).allowed).toBe(true);
  });
});

describe('lifecycle (design track enabled)', () => {
  it('opens idea → in_design → ready → in_progress and lets holding states resume to in_design', () => {
    expect(validateTransition('idea', 'in_design', DESIGN).allowed).toBe(true);
    expect(validateTransition('in_design', 'ready', DESIGN).allowed).toBe(true);
    expect(validateTransition('ready', 'in_progress', DESIGN).allowed).toBe(true);
    expect(validateTransition('ready', 'triaged', DESIGN).allowed).toBe(false);
    expect(validateTransition('in_design', 'in_progress', DESIGN).reason).toBe('illegal_track_jump');
    expect(validateTransition('parked', 'in_design', DESIGN).allowed).toBe(true);
    expect(validateTransition('in_design', 'parked', DESIGN).allowed).toBe(true);
    expect(validateTransition('in_design', 'dropped', DESIGN).allowed).toBe(true);
    expect(legalNextStates('idea', DESIGN)).toContain('in_design');
  });

  it('a design-state ticket under a work-only config has no legal moves', () => {
    expect(legalNextStates('in_design')).toEqual([]);
    expect(validateTransition('in_design', 'ready').reason).toBe('track_disabled');
  });
});
