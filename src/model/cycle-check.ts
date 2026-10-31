/**
 * DAG cycle check at the batch barrier. Given the existing precedence edges
 * and a batch of new ones, report the first cycle the batch would close,
 * evaluated over union(existing, batch) so a batch whose edges are
 * individually fine but jointly cyclic is still caught.
 *
 * Only DAG-class link types participate (DAG_LINK_TYPES); lifecycle edges such
 * as conflicts_with or supersedes do not express an order and may loop.
 * Pure: no I/O. The caller loads the existing edges and runs this inside the
 * write transaction before any row lands.
 */

import { DAG_LINK_TYPES } from './enums.js';

export interface DirectedEdge {
  readonly from: string;
  readonly to: string;
  readonly linkType: string;
}

export interface CycleFinding {
  /** Node path with first === last, e.g. ['a', 'b', 'c', 'a']. */
  readonly path: readonly string[];
  /** The batch edge whose insertion closes the cycle. */
  readonly via: DirectedEdge;
}

export interface DetectCycleOptions {
  readonly dagLinkTypes?: ReadonlySet<string>;
}

const edgeKey = (e: DirectedEdge): string => `${e.from} ${e.to} ${e.linkType}`;

/** Deterministic ordering so the reported cycle is stable across runs. */
const byFromToType = (a: DirectedEdge, b: DirectedEdge): number =>
  a.from < b.from ? -1 : a.from > b.from ? 1
  : a.to < b.to ? -1 : a.to > b.to ? 1
  : a.linkType < b.linkType ? -1 : a.linkType > b.linkType ? 1 : 0;

export function detectCycle(
  existing: readonly DirectedEdge[],
  batch: readonly DirectedEdge[],
  opts: DetectCycleOptions = {},
): CycleFinding | null {
  const dag = opts.dagLinkTypes ?? DAG_LINK_TYPES;
  const isDag = (e: DirectedEdge) => dag.has(e.linkType);

  const adj = new Map<string, string[]>();
  const seen = new Set<string>();
  const add = (e: DirectedEdge): void => {
    if (!isDag(e)) return;
    const k = edgeKey(e);
    if (seen.has(k)) return;
    seen.add(k);
    const list = adj.get(e.from);
    if (list) list.push(e.to);
    else adj.set(e.from, [e.to]);
  };
  for (const e of existing) add(e);
  for (const e of batch) add(e);
  for (const list of adj.values()) list.sort();

  // A new edge u→v closes a cycle iff v already reaches u in the union graph.
  const candidates = batch.filter(isDag).slice().sort(byFromToType);
  for (const e of candidates) {
    if (e.from === e.to) return { path: [e.from, e.from], via: e };
    const back = bfsPath(adj, e.to, e.from);
    if (back) return { path: [e.from, ...back], via: e };
  }
  return null;
}

/** Shortest path start..target over `adj` (BFS), or null. */
function bfsPath(adj: ReadonlyMap<string, readonly string[]>, start: string, target: string): string[] | null {
  if (start === target) return [start];
  const prev = new Map<string, string>();
  const visited = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    const next = adj.get(node);
    if (!next) continue;
    for (const n of next) {
      if (visited.has(n)) continue;
      prev.set(n, node);
      if (n === target) {
        const path: string[] = [target];
        let cur = node;
        while (cur !== start) {
          path.push(cur);
          cur = prev.get(cur) as string;
        }
        path.push(start);
        path.reverse();
        return path;
      }
      visited.add(n);
      queue.push(n);
    }
  }
  return null;
}
