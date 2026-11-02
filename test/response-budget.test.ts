/**
 * P2-03 (0.6.1): sea_list and sea_history have a response byte budget. 200
 * tickets with schema-max bodies made a 38 MiB line that blocked the event
 * loop for 34–95 s and killed the TS stdio client (10 MiB ReadBuffer). A page
 * now stops before the item that would exceed the budget (default 256 KiB,
 * SEA_LITE_MAX_RESPONSE_BYTES) and says how to continue.
 */

import { describe, expect, it } from 'vitest';

import { ApplyInput, CreateInput, HistoryInput, ListInput } from '../src/model/schemas.js';
import { DEFAULT_MAX_RESPONSE_BYTES, parseResponseBudget } from '../src/store.js';
import { assertStrictOutput, connectInMemory } from './mcp-helpers.js';
import { codeOf, fresh } from './helpers.js';

const BODY = 'b'.repeat(100_000); // the schema maximum

function seed(n: number, opts: Parameters<typeof fresh>[0] = {}) {
  const { store } = fresh(opts);
  for (let i = 0; i < n; i += 20) {
    store.apply(ApplyInput.parse({ tickets: Array.from({ length: Math.min(20, n - i) }, (_, k) => ({ ref: `r${k}`, title: `t${i + k}`, body: BODY, status: 'triaged' })) }));
  }
  return store;
}

describe('response budget (P2-03)', () => {
  it('sea_list view=full pages by bytes: every page under the budget, the cursor walks all 200 tickets', () => {
    const store = seed(200);
    try {
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const r = store.list(ListInput.parse({ view: 'full', limit: 200, ...(cursor !== undefined ? { cursor } : {}) }));
        pages++;
        expect(Buffer.byteLength(JSON.stringify(r.tickets))).toBeLessThanOrEqual(DEFAULT_MAX_RESPONSE_BYTES);
        expect(r.count).toBeGreaterThan(0);
        for (const t of r.tickets) seen.add(t.id);
        if (r.next_cursor === null) {
          expect(r.budget_truncated).toBeUndefined();
          break;
        }
        expect(r.budget_truncated).toBe(true);
        cursor = r.next_cursor;
      }
      expect(seen.size).toBe(200);
      expect(pages).toBeGreaterThan(50); // ~2 schema-max tickets per 256 KiB page
    } finally {
      store.close();
    }
  });

  it('sea_history pages by bytes; a single event over the budget is returned with its payload elided', () => {
    const store = seed(40, { maxResponseBytes: 64 * 1024 });
    try {
      // Two sea.batch_applied events of 20 × 100 kB each: every one alone is over a 64 KiB budget.
      const r1 = store.history(HistoryInput.parse({ limit: 500, verify: false }));
      expect(r1.count).toBe(1);
      expect(r1.truncated).toBe(true);
      expect(r1.events[0]!.payload).toMatchObject({ elided: true });
      expect(Buffer.byteLength(JSON.stringify(r1))).toBeLessThan(64 * 1024);
      const r2 = store.history(HistoryInput.parse({ limit: 500, verify: false, since_seq: r1.last_seq! }));
      expect(r2.events[0]!.seq).toBeGreaterThan(r1.events[0]!.seq);
      // Small events fill a page up to the budget.
      const { store: s2 } = fresh({ maxResponseBytes: 4096 });
      try {
        for (let i = 0; i < 100; i++) s2.create(CreateInput.parse({ title: `small ${i}`, status: 'triaged' }));
        const h = s2.history(HistoryInput.parse({ limit: 500, verify: false }));
        expect(h.count).toBeGreaterThan(1);
        expect(h.count).toBeLessThan(100);
        expect(h).toMatchObject({ truncated: true, budget_truncated: true });
        expect(Buffer.byteLength(JSON.stringify(h.events))).toBeLessThanOrEqual(4096);
      } finally {
        s2.close();
      }
    } finally {
      store.close();
    }
  });

  it('over MCP the 200-ticket full list is one bounded, strict result', async () => {
    const store = seed(200);
    const { client, close } = await connectInMemory(store);
    try {
      const r = await client.callTool({ name: 'sea_list', arguments: { view: 'full', limit: 200 } });
      await assertStrictOutput('sea_list', r);
      expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(3 * DEFAULT_MAX_RESPONSE_BYTES); // structuredContent + text copy
      expect((r.structuredContent as { budget_truncated?: boolean }).budget_truncated).toBe(true);
    } finally {
      await close();
      store.close();
    }
  });

  it('SEA_LITE_MAX_RESPONSE_BYTES is validated', () => {
    expect(parseResponseBudget(undefined)).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    expect(parseResponseBudget('65536')).toBe(65536);
    expect(codeOf(() => parseResponseBudget('12'))).toBe('invalid_input');
    expect(codeOf(() => parseResponseBudget('99999999'))).toBe('invalid_input');
    expect(codeOf(() => parseResponseBudget('lots'))).toBe('invalid_input');
  });
});
