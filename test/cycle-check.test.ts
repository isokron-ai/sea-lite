import { describe, expect, it } from 'vitest';

import { detectCycle } from '../src/model/cycle-check.js';

const e = (from: string, to: string, linkType = 'depends_on') => ({ from, to, linkType });

describe('detectCycle', () => {
  it('passes an acyclic batch', () => {
    expect(detectCycle([], [e('a', 'b'), e('b', 'c'), e('a', 'c')])).toBeNull();
  });

  it('catches a self-loop', () => {
    const f = detectCycle([], [e('a', 'a')]);
    expect(f?.path).toEqual(['a', 'a']);
  });

  it('catches a cycle closed against existing edges and reports the path', () => {
    const f = detectCycle([e('a', 'b'), e('b', 'c')], [e('c', 'a', 'blocks')]);
    expect(f).not.toBeNull();
    expect(f!.path[0]).toBe('c');
    expect(f!.path[f!.path.length - 1]).toBe('c');
    expect(f!.path).toEqual(['c', 'a', 'b', 'c']);
    expect(f!.via.linkType).toBe('blocks');
  });

  it('catches a jointly-cyclic batch whose edges are individually fine', () => {
    const f = detectCycle([], [e('x', 'y'), e('y', 'z'), e('z', 'x')]);
    expect(f).not.toBeNull();
  });

  it('ignores non-DAG link types', () => {
    expect(detectCycle([e('a', 'b', 'conflicts_with')], [e('b', 'a', 'conflicts_with')])).toBeNull();
    expect(detectCycle([e('a', 'b', 'relates_to')], [e('b', 'a', 'relates_to')])).toBeNull();
  });

  it('is deterministic about which cycle it reports', () => {
    const batch = [e('b', 'a'), e('a', 'b'), e('d', 'c'), e('c', 'd')];
    const f1 = detectCycle([], batch);
    const f2 = detectCycle([], [...batch].reverse());
    expect(f1).toEqual(f2);
    expect(f1!.via).toEqual(e('a', 'b'));
  });

  it('mixes DAG types in one graph (parent_of into depends_on)', () => {
    const f = detectCycle([e('epic', 'child', 'parent_of')], [e('child', 'epic', 'depends_on')]);
    expect(f?.path).toEqual(['child', 'epic', 'child']);
  });
});
