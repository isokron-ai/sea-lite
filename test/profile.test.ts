/**
 * Tool profiles and the lean catalog: `serve --core` publishes the
 * day-to-day tools with short descriptions; the full profile keeps every
 * tool. Both publish lean JSON Schemas (no `$schema`, nested result objects
 * as field lists) while the server still validates with the full zod
 * schemas. Size budgets are pinned here: full ≤ 35 KB, core ≤ 12 KB.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { serveHttp } from '../src/http.js';
import { leanInputSchema, leanOutputSchema, omitProperties } from '../src/model/publish.js';
import { CORE_TOOLS, createServer, MAX_INSTRUCTIONS_CHARS } from '../src/server.js';
import { SeaLite } from '../src/store.js';
import { claimedTicket } from './helpers.js';
import { assertStrictOutput, connectInMemory, parse, TOOLS } from './mcp-helpers.js';

const FULL_BUDGET = 35_000;
const CORE_BUDGET = 12_000;
const CLI = join(process.cwd(), 'dist', 'cli.js');

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function listed(profile?: 'core' | 'full') {
  const store = new SeaLite({ memory: true, actor: 'agent-1' });
  const { client, close } = await connectInMemory(store, profile !== undefined ? { server: { profile } } : {});
  closers.push(() => store.close(), close);
  const { tools } = await client.listTools();
  const d = await client.discover();
  return { store, client, tools, bytes: Buffer.byteLength(JSON.stringify({ tools })), instructions: d.instructions ?? '' };
}

describe('profiles', () => {
  it('full (default) lists every tool within its budget; core lists CORE_TOOLS within its budget', async () => {
    const full = await listed();
    expect(full.tools.map((t) => t.name).sort()).toEqual(TOOLS);
    expect(full.bytes).toBeLessThanOrEqual(FULL_BUDGET);
    const core = await listed('core');
    expect(core.tools.map((t) => t.name).sort()).toEqual([...CORE_TOOLS].sort());
    expect(core.bytes).toBeLessThanOrEqual(CORE_BUDGET);
    for (const t of core.tools) {
      const f = full.tools.find((x) => x.name === t.name)!;
      expect(t.description!.length, t.name).toBeLessThanOrEqual(f.description!.length);
      expect(t.annotations, t.name).toEqual(f.annotations);
    }
    expect(core.instructions).toMatch(/sea_finish/);
    expect(core.instructions.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    // Core says what it leaves out and how to get it.
    const omitted = TOOLS.filter((t) => !(CORE_TOOLS as readonly string[]).includes(t));
    expect(omitted.sort()).toEqual(['sea_create', 'sea_history', 'sea_link', 'sea_list', 'sea_stats', 'sea_update']);
    for (const t of omitted) expect(core.instructions, t).toContain(t);
    expect(core.instructions).toMatch(/serve without --core/);
    expect(core.instructions).toMatch(/SEA_LITE_PROFILE=full/);
    expect(full.instructions).not.toMatch(/SEA_LITE_PROFILE/);
    expect(full.instructions).toMatch(/sea_finish/);
  });

  it('instructions stay within budget for the longest actor and a session in both profiles', () => {
    const store = new SeaLite({ memory: true, actor: 'x'.repeat(200), session: 'f'.repeat(64) });
    closers.push(() => store.close());
    for (const profile of ['core', 'full'] as const) expect(() => createServer(store, { profile })).not.toThrow();
  });

  it('documents {prev} as the expanded ref of the previous item of the same template', async () => {
    const { tools } = await listed('core');
    const apply = tools.find((t) => t.name === 'sea_apply')!;
    expect(JSON.stringify(apply.inputSchema)).toContain('{prev} = the expanded ref of item i-1 of this template');
  });

  it('publishes lean schemas: no $schema, no string length noise, nested result objects as field lists', async () => {
    const { tools } = await listed();
    const text = JSON.stringify(tools);
    expect(text).not.toMatch(/\$schema/);
    expect(text).not.toMatch(/"maxLength"/);
    expect(text).not.toMatch(/9007199254740991/);
    const get = tools.find((t) => t.name === 'sea_get')!;
    const ticket = (get.outputSchema as { properties: Record<string, { type: string; description: string }> }).properties['ticket']!;
    expect(ticket.type).toBe('object');
    expect(ticket.description).toMatch(/^\{id,kind,title,body,status/);
    // Enums stay on the input side.
    const create = tools.find((t) => t.name === 'sea_create')!;
    expect((create.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties['kind']!.enum).toContain('epic');
  });

  it('core hides rarely-needed inputs but still accepts them', async () => {
    const { tools, client, store } = await listed('core');
    const props = (name: string) => Object.keys((tools.find((t) => t.name === name)!.inputSchema as { properties: object }).properties);
    for (const name of CORE_TOOLS) {
      expect(props(name), name).not.toContain('actor_id');
      expect(props(name), name).not.toContain('idempotency_key');
    }
    expect(props('sea_next')).not.toContain('kind');
    expect(props('sea_apply')).toContain('templates');
    expect(props('sea_transition')).toContain('tickets');
    store.create({ title: 'for bob', body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged', dry_run: false });
    const r = await client.callTool({ name: 'sea_next', arguments: { actor_id: 'bob', kind: ['chore'] } });
    await assertStrictOutput('sea_next', r);
    expect(parse<{ ticket: { claim: { holder: string } } }>(r).ticket.claim.holder).toBe('bob');
  });

  it('core runs the whole loop: sea_apply (template) → sea_next → sea_transition → sea_finish', async () => {
    const { client, store } = await listed('core');
    const plan = await client.callTool({
      name: 'sea_apply',
      arguments: {
        templates: [
          {
            for_each: ['a', 'b'],
            ref: 's{i}',
            ticket: { title: 'step {value}', status: 'triaged' },
            links: [{ from_ref: '{ref}', to_ref: '{prev}', link_type: 'depends_on' }],
          },
        ],
      },
    });
    await assertStrictOutput('sea_apply', plan);
    const created = parse<{ created: Record<string, string> }>(plan).created;
    for (const want of ['s1', 's2']) {
      const n = parse<{ ticket: { id: string }; claim_token: string }>(await client.callTool({ name: 'sea_next', arguments: { scope: { paths: ['src'] } } }));
      expect(n.ticket.id).toBe(created[want]);
      await client.callTool({ name: 'sea_transition', arguments: { ticket_id: n.ticket.id, claim_token: n.claim_token, to: 'in_progress' } });
      const f = await client.callTool({ name: 'sea_finish', arguments: { ticket_id: n.ticket.id, claim_token: n.claim_token, outcome: 'done', note: `${want} done` } });
      await assertStrictOutput('sea_finish', f);
    }
    expect(store.get({ id: created['s2']! }).ticket.status).toBe('resolved');
    const empty = parse<{ ticket: null }>(await client.callTool({ name: 'sea_next', arguments: {} }));
    expect(empty.ticket).toBeNull();
  });
});

describe('publish helpers', () => {
  it('leanInputSchema keeps types, enums, defaults, bounds and descriptions', () => {
    const lean = leanInputSchema({
      $schema: 'x',
      type: 'object',
      properties: { a: { type: 'string', minLength: 1, maxLength: 9, pattern: '^a', description: 'd', enum: ['p'] }, n: { type: 'integer', minimum: 1, maximum: 3600 } },
      required: ['a'],
    });
    expect(lean).toEqual({ type: 'object', properties: { a: { type: 'string', description: 'd', enum: ['p'] }, n: { type: 'integer', minimum: 1, maximum: 3600 } }, required: ['a'] });
  });

  it('omitProperties drops dotted paths through objects, nullable objects and arrays', () => {
    const j = {
      type: 'object',
      properties: {
        a: { type: 'string' },
        s: { anyOf: [{ type: 'object', properties: { p: {}, w: {} }, required: ['w'] }, { type: 'null' }] },
        t: { type: 'array', items: { type: 'object', properties: { x: {}, y: {} } } },
      },
      required: ['a'],
    };
    const o = omitProperties(j, ['a', 's.w', 't.y', 'missing.z']) as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(o.properties)).toEqual(['s', 't']);
    expect(o.required).toBeUndefined();
    expect(JSON.stringify(o)).not.toMatch(/"w"|"y"/);
    expect(Object.keys(j.properties)).toContain('a'); // input untouched
  });

  it('leanOutputSchema merges a root union into one object; minimal keeps only names and types', () => {
    const u = {
      anyOf: [
        { type: 'object', properties: { created: { type: 'object' }, links: { type: 'number' } }, required: ['created', 'links'] },
        { type: 'object', properties: { links: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } }, head: { type: 'object' } }, required: ['links'] },
      ],
    };
    const lean = leanOutputSchema(u) as { properties: Record<string, { type: unknown }>; required: string[]; description: string };
    expect(lean.required).toEqual(['links']);
    expect(lean.properties['links']!.type).toEqual(['number', 'array']);
    expect(lean.description).toMatch(/One of: \{created,links\} \| \{links,head\?\}/);
    const min = leanOutputSchema(u, true) as { properties: Record<string, object>; description?: string };
    expect(min.description).toBeUndefined();
    expect(min.properties['head']).toEqual({ type: 'object' });
  });
});

describe('serve --core over stdio and HTTP', () => {
  it('a 2026-07-28 client and a 2025-era (SDK v1) client both see the core tools from `serve --core`', async () => {
    if (!existsSync(CLI)) throw new Error('dist/cli.js missing; run npm run build first');
    const dir = mkdtempSync(join(tmpdir(), 'sea-lite-core-'));
    closers.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const modern = new Client({ name: 'core-modern', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await modern.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'serve', '--core', '--data-dir', dir, '--actor', 'm'] }));
    closers.push(() => modern.close());
    expect((await modern.listTools()).tools.map((t) => t.name).sort()).toEqual([...CORE_TOOLS].sort());

    const { Client: V1Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport: V1Stdio } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const v1 = new V1Client({ name: 'core-v1', version: '1.0.0' });
    await v1.connect(new V1Stdio({ command: process.execPath, args: [CLI, 'serve', '--profile', 'core', '--data-dir', dir, '--actor', 'v1'] }));
    closers.push(() => v1.close());
    const { tools } = await v1.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CORE_TOOLS].sort());
    const r = await v1.callTool({ name: 'sea_apply', arguments: { templates: [{ for_each: 2, ref: 'x{i}', ticket: { title: 'v1 {i}' } }] } });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    expect(Object.keys((r.structuredContent as { created: object }).created)).toEqual(['x1', 'x2']);
  });

  it('an unknown --profile is refused', () => {
    let code = 0;
    let err = '';
    try {
      execFileSync(process.execPath, [CLI, 'serve', '--profile', 'tiny'], { stdio: 'pipe', input: '' });
    } catch (e) {
      code = (e as { status: number }).status;
      err = String((e as { stderr: Buffer }).stderr);
    }
    expect(code).not.toBe(0);
    expect(err).toMatch(/--profile must be core or full/);
  });

  it('serve --http with profile core serves the core tools', async () => {
    const store = new SeaLite({ memory: true, actor: 'h' });
    const http = await serveHttp({ store, bearer: 'b'.repeat(32), port: 0, profile: 'core' });
    closers.push(() => store.close(), () => http.close());
    const client = new Client({ name: 'core-http', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${'b'.repeat(32)}` } } }));
    closers.push(() => client.close());
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...CORE_TOOLS].sort());
    const t = claimedTicket(store, 'h');
    const f = await client.callTool({ name: 'sea_finish', arguments: { ticket_id: t.id, claim_token: t.token, outcome: 'abandoned', note: 'not needed' } });
    await assertStrictOutput('sea_finish', f);
  });
});
