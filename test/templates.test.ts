/**
 * sea_apply templates: `templates: [{for_each, ref, ticket, links}]` expands
 * server-side, deterministically, into plain tickets and links before
 * validation; caps, cycle checks, dry_run and idempotency all see the
 * expanded batch. Also the compact default result and `verbose: true`.
 */

import { describe, expect, it } from 'vitest';

import type { SeaError } from '../src/core/errors.js';
import { ApplyInput } from '../src/model/schemas.js';
import { expandBatch } from '../src/model/templates.js';
import type { SeaLite } from '../src/store.js';
import { claimedTicket, codeOf, fresh } from './helpers.js';
import { assertStrictOutput, connectInMemory, parse, type ToolResult } from './mcp-helpers.js';

const plan = (x: unknown) => ApplyInput.parse(x);

function problemsOf(fn: () => unknown): { code: string; message: string }[] {
  try {
    fn();
  } catch (e) {
    const d = (e as SeaError).details as { problems?: { code: string; message: string }[] } | undefined;
    return d?.problems ?? [];
  }
  throw new Error('expected a rejection');
}

/** The S14 shape: an epic plus a 20-step chain, every step a child of the epic. */
const chain20 = {
  tickets: [{ ref: 'epic', title: 'Checkout v2 rollout', kind: 'epic' }],
  templates: [
    {
      for_each: Array.from({ length: 20 }, (_, k) => String(k + 1).padStart(2, '0')),
      ref: 't{value}',
      ticket: { title: 'Checkout v2 step {value}: ship part {i} of the new flow', body: 'Acceptance: part {i} merged.' },
      links: [
        { from_ref: 'epic', to_ref: '{ref}', link_type: 'parent_of' },
        { from_ref: '{ref}', to_ref: '{prev}', link_type: 'depends_on' },
      ],
    },
  ],
};

function linksOf(store: SeaLite, id: string) {
  return store.get({ id }).links.filter((l) => l.direction === 'out').map((l) => `${l.link_type}>${l.to_id}`);
}

describe('template expansion (pure)', () => {
  it('substitutes {i}, {value}, {ref} and {prev}, skips {prev} links on the first item, and keeps order', () => {
    const x = expandBatch(plan(chain20));
    expect(x.tickets).toHaveLength(21);
    expect(x.tickets[0]!.ref).toBe('epic');
    expect(x.tickets[1]).toMatchObject({ ref: 't01', title: 'Checkout v2 step 01: ship part 1 of the new flow', body: 'Acceptance: part 1 merged.' });
    expect(x.tickets[20]).toMatchObject({ ref: 't20', title: 'Checkout v2 step 20: ship part 20 of the new flow' });
    expect(x.links).toHaveLength(39); // 20 parent_of + 19 depends_on (none for the first item)
    expect(x.links.slice(0, 3)).toEqual([
      { from_ref: 'epic', to_ref: 't01', link_type: 'parent_of' },
      { from_ref: 'epic', to_ref: 't02', link_type: 'parent_of' },
      { from_ref: 't02', to_ref: 't01', link_type: 'depends_on' },
    ]);
  });

  it('is deterministic: the same input expands to the same plan', () => {
    expect(JSON.stringify(expandBatch(plan(chain20)))).toBe(JSON.stringify(expandBatch(plan(chain20))));
  });

  it('a count for_each iterates 1..n; {value} equals {i}; tags, assignee and unknown braces', () => {
    const x = expandBatch(
      plan({ templates: [{ for_each: 3, ref: 'm{i}', ticket: { title: 'Migrate endpoint {value} {other}', tags: ['wave-{i}'], assignee: 'bot-{value}' } }] }),
    );
    expect(x.tickets.map((t) => [t.ref, t.title, t.tags[0], t.assignee])).toEqual([
      ['m1', 'Migrate endpoint 1 {other}', 'wave-1', 'bot-1'],
      ['m2', 'Migrate endpoint 2 {other}', 'wave-2', 'bot-2'],
      ['m3', 'Migrate endpoint 3 {other}', 'wave-3', 'bot-3'],
    ]);
    expect(x.links).toEqual([]);
  });

  it('string values: "Migrate endpoint {value}"', () => {
    const x = expandBatch(plan({ templates: [{ for_each: ['/users', '/orders'], ref: 'e{i}', ticket: { title: 'Migrate endpoint {value}' } }] }));
    expect(x.tickets.map((t) => t.title)).toEqual(['Migrate endpoint /users', 'Migrate endpoint /orders']);
  });

  it('several templates chain independently; {prev} is per template', () => {
    const x = expandBatch(
      plan({
        templates: [
          { for_each: 2, ref: 'a{i}', ticket: { title: 'A{i}' }, links: [{ from_ref: '{ref}', to_ref: '{prev}', link_type: 'depends_on' }] },
          { for_each: 2, ref: 'b{i}', ticket: { title: 'B{i}' }, links: [{ from_ref: '{ref}', to_ref: '{prev}', link_type: 'depends_on' }] },
        ],
      }),
    );
    expect(x.links.map((l) => `${l.from_ref}>${l.to_ref}`)).toEqual(['a2>a1', 'b2>b1']);
  });

  it('a ref pattern without {i}/{value}, or using {ref}/{prev}, is bad_template', () => {
    expect(problemsOf(() => expandBatch(plan({ templates: [{ for_each: 2, ref: 'same', ticket: { title: 'x' } }] })))[0]!.code).toBe('bad_template');
    expect(problemsOf(() => expandBatch(plan({ templates: [{ for_each: 2, ref: 'r{prev}{i}', ticket: { title: 'x' } }] })))[0]!.code).toBe('bad_template');
  });

  it('caps apply after expansion: > 50 tickets or > 100 links is rejected with nothing written', () => {
    const { store } = fresh();
    const tooMany = plan({ tickets: [{ ref: 'x', title: 'x' }], templates: [{ for_each: 50, ref: 't{i}', ticket: { title: 't{i}' } }] });
    expect(problemsOf(() => store.apply(tooMany)).map((p) => p.code)).toEqual(['too_many_tickets']);
    const tooManyLinks = plan({
      tickets: [{ ref: 'hub', title: 'hub' }, { ref: 'hub2', title: 'hub2' }, { ref: 'hub3', title: 'hub3' }],
      templates: [
        {
          for_each: 40,
          ref: 't{i}',
          ticket: { title: 't{i}' },
          links: [
            { from_ref: 'hub', to_ref: '{ref}', link_type: 'relates_to' },
            { from_ref: 'hub2', to_ref: '{ref}', link_type: 'relates_to' },
            { from_ref: 'hub3', to_ref: '{ref}', link_type: 'relates_to' },
          ],
        },
      ],
    });
    expect(problemsOf(() => store.apply(tooManyLinks)).map((p) => p.code)).toEqual(['too_many_links']);
    expect(store.chain.head().seq).toBe(0);
  });

  it('substituted strings still meet the field rules (invalid_expansion)', () => {
    const long = 'x'.repeat(490);
    const p = problemsOf(() => expandBatch(plan({ templates: [{ for_each: ['v'.repeat(20)], ref: 'r{i}', ticket: { title: `${long}{value}` } }] })));
    expect(p[0]!.code).toBe('invalid_expansion');
    expect(p[0]).toMatchObject({ where: 'templates[0] item 1 (r1) title', template: 0, item: 1, ref: 'r1' });
    expect(p[0]!.message).toMatch(/^templates\[0\] item 1 \(r1\) title: /);
  });

  it('an empty batch (no tickets, no templates) is rejected', () => {
    const { store } = fresh();
    expect(problemsOf(() => store.apply(plan({})))[0]!.code).toBe('empty_batch');
  });
});

describe('sea_apply with templates (store)', () => {
  it('writes the exact chain, atomically, and sea_next walks it in order', () => {
    const { store } = fresh();
    const r = store.apply(plan(chain20));
    expect(r.tickets).toHaveLength(21);
    expect(r.links).toHaveLength(39);
    const id = Object.fromEntries(r.tickets.map((t) => [t.ref, t.ticket_id]));
    expect(linksOf(store, id['t05']!)).toEqual([`depends_on>${id['t04']}`]);
    expect(linksOf(store, id['epic']!)).toHaveLength(20);
    expect(store.list({ include_terminal: true, limit: 200, view: 'compact', claimed: 'any' }).count).toBe(21);
  });

  it('a template that closes a cycle is rejected as a whole; dry_run catches it and shows nothing written', () => {
    const { store } = fresh();
    const cyclic = plan({
      ...chain20,
      links: [{ from_ref: 't01', to_ref: 't20', link_type: 'depends_on' }],
    });
    expect(codeOf(() => store.apply({ ...cyclic, dry_run: true }))).toBe('cycle');
    expect(codeOf(() => store.apply(cyclic))).toBe('cycle');
    expect(store.chain.head().seq).toBe(0);
  });

  it('dry_run returns the expanded plan without writing', () => {
    const { store } = fresh();
    const r = store.apply({ ...plan(chain20), dry_run: true });
    expect(r.dry_run).toBe(true);
    expect(r.tickets.map((t) => t.ref)).toEqual(['epic', ...Array.from({ length: 20 }, (_, k) => `t${String(k + 1).padStart(2, '0')}`)]);
    expect(r.links).toHaveLength(39);
    expect(store.chain.head().seq).toBe(0);
  });

  it('idempotency_key replays a templated batch instead of duplicating it', () => {
    const { store } = fresh();
    const a = store.apply({ ...plan(chain20), idempotency_key: 'plan-1' });
    const b = store.apply({ ...plan(chain20), idempotency_key: 'plan-1' });
    expect(b.replayed).toBe(true);
    expect(b.tickets.map((t) => t.ticket_id)).toEqual(a.tickets.map((t) => t.ticket_id));
    expect(store.list({ include_terminal: true, limit: 200, view: 'compact', claimed: 'any' }).count).toBe(21);
  });

  it('template links may point at an existing ticket (to_id) and, fenced, out of one (from_id + claims)', () => {
    const { store } = fresh();
    const held = claimedTicket(store);
    const r = store.apply(
      plan({
        claims: [{ ticket_id: held.id, claim_token: held.token }],
        templates: [
          {
            for_each: 2,
            ref: 'c{i}',
            ticket: { title: 'child {i}' },
            links: [
              { from_ref: '{ref}', to_id: held.id, link_type: 'depends_on' },
              { from_id: held.id, to_ref: '{ref}', link_type: 'relates_to' },
            ],
          },
        ],
      }),
    );
    expect(r.links).toHaveLength(4);
    expect(linksOf(store, held.id)).toHaveLength(2);
  });
});

describe('sea_apply errors name exactly what failed', () => {
  type P = { code: string; message: string; where?: string; template?: number; item?: number; ref?: string; link?: number };
  const problems = (fn: () => unknown) => problemsOf(fn) as P[];

  it('plain batch: duplicate refs by ticket index and ref, bad links by link index', () => {
    const { store } = fresh();
    const p = problems(() =>
      store.apply(
        plan({
          tickets: [{ ref: 'a', title: 'A' }, { ref: 'b', title: 'B' }, { ref: 'a', title: 'A again' }],
          links: [
            { from_ref: 'a', to_ref: 'b', link_type: 'depends_on' },
            { from_ref: 'a', to_ref: 'zz', link_type: 'depends_on' },
            { from_ref: 'b', to_ref: 'b', link_type: 'relates_to' },
            { from_ref: 'a', to_ref: 'b', link_type: 'depends_on' },
            { to_ref: 'a', link_type: 'blocks' },
          ],
        }),
      ),
    );
    expect(p.map((x) => [x.code, x.where])).toEqual([
      ['duplicate_ref', 'tickets[2] (a)'],
      ['foreign_ref', 'links[1]'],
      ['self_loop', 'links[2]'],
      ['duplicate_link', 'links[3]'],
      ['bad_endpoint', 'links[4]'],
    ]);
    expect(p[0]!.message).toBe('tickets[2] (a): ref "a" is already used by tickets[0] (a)');
    expect(p[1]).toMatchObject({ link: 1, at: 'zz' });
    expect(p[3]!.message).toMatch(/already given by links\[0\]/);
  });

  it('templates: the template index, the expanded item (1-based) and its ref, and the template link index', () => {
    const { store } = fresh();
    const p = problems(() =>
      store.apply(
        plan({
          tickets: [{ ref: 'epic', title: 'E' }],
          templates: [
            { for_each: 2, ref: 'a{i}', ticket: { title: 'a{i}' } },
            {
              for_each: ['x', 'y', 'z'],
              ref: 's{value}',
              ticket: { title: 's{value}' },
              links: [
                { from_ref: 'epic', to_ref: '{ref}', link_type: 'parent_of' },
                { from_ref: '{ref}', to_ref: 'missing-{i}', link_type: 'depends_on' },
              ],
            },
          ],
        }),
      ),
    );
    expect(p.map((x) => x.where)).toEqual(['templates[1] item 1 (sx) links[1]', 'templates[1] item 2 (sy) links[1]', 'templates[1] item 3 (sz) links[1]']);
    expect(p[1]).toMatchObject({ code: 'foreign_ref', template: 1, item: 2, ref: 'sy', link: 1, at: 'missing-2' });
    // A template ref colliding with a plain ticket's ref names both.
    const dup = problems(() => store.apply(plan({ tickets: [{ ref: 't2', title: 'x' }], templates: [{ for_each: 3, ref: 't{i}', ticket: { title: 't{i}' } }] })));
    expect(dup).toHaveLength(1);
    expect(dup[0]!.message).toBe('templates[0] item 2 (t2): ref "t2" is already used by tickets[0] (t2)');
  });

  it('caps name how many each part expanded to', () => {
    const { store } = fresh();
    const p = problems(() => store.apply(plan({ tickets: [{ ref: 'x', title: 'x' }], templates: [{ for_each: 30, ref: 'a{i}', ticket: { title: 'a' } }, { for_each: 30, ref: 'b{i}', ticket: { title: 'b' } }] })));
    expect(p[0]!.message).toBe('the batch expands to 61 tickets (tickets 1, templates[0] 30, templates[1] 30); at most 50');
  });

  it('cycles: the path by refs and the link that closes it, by where it was written', () => {
    const { store } = fresh();
    let err: SeaError | undefined;
    try {
      store.apply(plan({ ...chain20, links: [{ from_ref: 't01', to_ref: 't20', link_type: 'depends_on' }] }));
    } catch (e) {
      err = e as SeaError;
    }
    expect(err?.code).toBe('cycle');
    const d = err!.details as { path: string[]; closed_by: P };
    expect(d.path[0]).toMatch(/^t\d\d$/);
    expect(d.path).toContain('t01');
    expect(d.path).toContain('t20');
    expect(d.path.every((x) => /^t\d\d$/.test(x))).toBe(true);
    expect(d.closed_by.where).toMatch(/^links\[0\]$|^templates\[0\] item \d+ \(t\d\d\) links\[1\]$/);
    expect(err!.message).toMatch(/closed by /);
  });

  it('existing-ticket endpoints: unknown ids and missing fences name the link or claim', () => {
    const { store } = fresh();
    const held = claimedTicket(store);
    const p = problems(() =>
      store.apply(
        plan({
          templates: [{ for_each: 2, ref: 'c{i}', ticket: { title: 'c{i}' }, links: [{ from_ref: '{ref}', to_id: 'deadbeefdead', link_type: 'depends_on' }] }],
          claims: [{ ticket_id: 'feedfacefeed', claim_token: held.token }],
        }),
      ),
    );
    expect(p.map((x) => [x.code, x.where])).toEqual([
      ['unknown_ticket', 'templates[0] item 1 (c1) links[0]'],
      ['unknown_ticket', 'templates[0] item 2 (c2) links[0]'],
      ['unknown_ticket', 'claims[0]'],
    ]);
    const f = problems(() => store.apply(plan({ templates: [{ for_each: 1, ref: 'c{i}', ticket: { title: 'c' }, links: [{ from_id: held.id, to_ref: '{ref}', link_type: 'relates_to' }] }] })));
    expect(f[0]).toMatchObject({ code: 'fence_missing', where: 'templates[0] item 1 (c1) links[0]' });
  });
});

describe('sea_apply over MCP: compact default, verbose echo', () => {
  it('returns {created: {ref: id}, links, idempotent_replay} by default, compact JSON text, and replays', async () => {
    const { store } = fresh();
    const { client, close } = await connectInMemory(store);
    try {
      const res = await client.callTool({ name: 'sea_apply', arguments: { ...chain20, idempotency_key: 'k' } });
      await assertStrictOutput('sea_apply', res);
      const text = (res as ToolResult).content[0]!.text!;
      expect(text).not.toMatch(/\n/);
      const r = parse<{ created: Record<string, string>; links: number; idempotent_replay: boolean }>(res);
      expect(Object.keys(r).sort()).toEqual(['created', 'idempotent_replay', 'links']);
      expect(Object.keys(r.created)).toHaveLength(21);
      expect(r.links).toBe(39);
      expect(r.idempotent_replay).toBe(false);
      // ~1 KB for a 21-ticket plan (it was 13.4 KB pretty-printed in 0.4.0).
      expect(Buffer.byteLength(text)).toBeLessThan(1200);
      const again = parse<{ created: Record<string, string>; idempotent_replay: boolean }>(
        await client.callTool({ name: 'sea_apply', arguments: { ...chain20, idempotency_key: 'k' } }),
      );
      expect(again.idempotent_replay).toBe(true);
      expect(again.created).toEqual(r.created);
    } finally {
      await close();
      store.close();
    }
  });

  it('verbose: true returns the full 0.4.0 echo; dry_run shows the expanded plan compactly', async () => {
    const { store } = fresh();
    const { client, close } = await connectInMemory(store);
    try {
      const v = parse<{ batch_id: string; tickets: { ref: string; ticket_id: string; title: string }[]; links: { link_id: string }[]; head: unknown }>(
        await client.callTool({ name: 'sea_apply', arguments: { ...chain20, verbose: true } }),
      );
      expect(v.batch_id).toHaveLength(36);
      expect(v.tickets).toHaveLength(21);
      expect(v.links).toHaveLength(39);
      expect(v.head).toBeDefined();
      const dry = await client.callTool({ name: 'sea_apply', arguments: { templates: chain20.templates, tickets: chain20.tickets, dry_run: true } });
      await assertStrictOutput('sea_apply', dry);
      const d = parse<{ dry_run: boolean; created: object; plan: { tickets: { ref: string }[]; links: string[] } }>(dry);
      expect(d.dry_run).toBe(true);
      expect(d.created).toEqual({});
      expect(d.plan.tickets).toHaveLength(21);
      expect(d.plan.links[0]).toBe('epic parent_of t01');
      expect(d.plan.links).toContain('t02 depends_on t01');
    } finally {
      await close();
      store.close();
    }
  });

  it('errors keep their shape: batch_invalid lists every problem, cycle names the path', async () => {
    const { store } = fresh();
    const { client, close } = await connectInMemory(store);
    try {
      const bad = (await client.callTool({ name: 'sea_apply', arguments: { templates: [{ for_each: 2, ref: 'x', ticket: { title: 'x' } }] } })) as ToolResult;
      expect(bad.isError).toBe(true);
      expect(parse<{ error: string; details: { problems: { code: string }[] } }>(bad)).toMatchObject({ error: 'batch_invalid', details: { problems: [{ code: 'bad_template' }] } });
      const cyc = (await client.callTool({
        name: 'sea_apply',
        arguments: { ...chain20, links: [{ from_ref: 't01', to_ref: 't20', link_type: 'depends_on' }] },
      })) as ToolResult;
      expect(parse<{ error: string; details: { path: string[] } }>(cyc)).toMatchObject({ error: 'cycle' });
    } finally {
      await close();
      store.close();
    }
  });
});
