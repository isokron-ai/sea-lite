/**
 * Over the protocol: an SDK Client against createServer() through the
 * in-memory linked transport, and separately against the built CLI over
 * real stdio.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from '../src/server.js';
import { SeaLite } from '../src/store.js';

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

function parse<T = Record<string, unknown>>(r: unknown): T {
  const res = r as ToolResult;
  const t = res.content[0];
  if (!t || t.type !== 'text' || !t.text) throw new Error('no text content');
  return JSON.parse(t.text) as T;
}

const TOOLS = [
  'sea_apply',
  'sea_claim',
  'sea_create',
  'sea_get',
  'sea_history',
  'sea_link',
  'sea_list',
  'sea_next',
  'sea_refresh',
  'sea_release',
  'sea_transition',
  'sea_update',
];

describe('MCP server (in-process transport)', () => {
  let store: SeaLite;
  let client: Client;

  beforeAll(async () => {
    store = new SeaLite({ memory: true, actor: 'agent-1' });
    const server = createServer(store);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientT);
  });

  afterAll(async () => {
    await client.close();
    store.close();
  });

  it('lists the twelve tools with schemas and instructive descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    const next = tools.find((t) => t.name === 'sea_next')!;
    expect(next.description).toMatch(/predecessors/);
    const props = (next.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('lease_seconds');
    const create = tools.find((t) => t.name === 'sea_create')!;
    expect((create.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties['kind']!.enum).toContain('bug');
    const get = tools.find((t) => t.name === 'sea_get')!;
    expect(get.annotations?.readOnlyHint).toBe(true);
  });

  it('sets destructiveHint explicitly on every write tool (spec default is true)', async () => {
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.destructiveHint]));
    for (const t of ['sea_create', 'sea_apply', 'sea_claim', 'sea_refresh', 'sea_next']) expect(hints[t], t).toBe(false);
    for (const t of ['sea_update', 'sea_transition', 'sea_link', 'sea_release']) expect(hints[t], t).toBe(true);
    for (const t of ['sea_get', 'sea_list', 'sea_history']) expect(hints[t], t).toBeUndefined();
  });

  it('runs the queue loop: create → next → update → transition → history, with fenced errors as isError', async () => {
    const created = parse<{ ticket: { id: string }; possible_duplicates: unknown[] }>(
      await client.callTool({ name: 'sea_create', arguments: { title: 'Wire the thing', kind: 'feature', priority: 'high', status: 'triaged' } }),
    );
    expect(created.possible_duplicates).toEqual([]);

    const next = parse<{ ticket: { id: string; claim: { holder: string } }; claim_token: string }>(
      await client.callTool({ name: 'sea_next', arguments: {} }),
    );
    expect(next.ticket.id).toBe(created.ticket.id);
    expect(next.ticket.claim.holder).toBe('agent-1');

    // Another actor, same server, cannot write.
    const denied = (await client.callTool({
      name: 'sea_update',
      arguments: { ticket_id: next.ticket.id, claim_token: next.claim_token, title: 'stolen', actor_id: 'agent-2' },
    })) as ToolResult;
    expect(denied.isError).toBe(true);
    expect(parse<{ error: string; details: { held_by: string } }>(denied)).toMatchObject({ error: 'fence_foreign_holder', details: { held_by: 'agent-1' } });

    const upd = parse<{ changed: string[]; row_version: number }>(
      await client.callTool({ name: 'sea_update', arguments: { ticket_id: next.ticket.id, claim_token: next.claim_token, body: 'plan', note: 'on it' } }),
    );
    expect(upd.changed).toEqual(['body']);

    const bad = (await client.callTool({
      name: 'sea_transition',
      arguments: { ticket_id: next.ticket.id, claim_token: next.claim_token, to: 'idea' },
    })) as ToolResult;
    expect(bad.isError).toBe(true);
    expect(parse<{ error: string; details: { legal_next: string[] } }>(bad).details.legal_next).toContain('in_progress');

    const done = parse<{ to: string; claim_released: boolean }>(
      await client.callTool({ name: 'sea_transition', arguments: { ticket_id: next.ticket.id, claim_token: next.claim_token, to: 'resolved' } }),
    );
    expect(done).toMatchObject({ to: 'resolved', claim_released: true });

    const hist = parse<{ events: { event_type: string }[]; chain: { verified: boolean } }>(
      await client.callTool({ name: 'sea_history', arguments: { ticket_id: next.ticket.id.slice(0, 8) } }),
    );
    expect(hist.events.map((e) => e.event_type)).toEqual([
      'sea_ticket.created',
      'sea_ticket.claimed',
      'sea_ticket.updated',
      'sea_ticket.note_added',
      'sea_ticket.status_set',
    ]);
    expect(hist.chain.verified).toBe(true);

    const list = parse<{ count: number }>(await client.callTool({ name: 'sea_list', arguments: {} }));
    expect(list.count).toBe(0); // terminal hidden by default
    const empty = parse<{ ticket: null; reason: string }>(await client.callTool({ name: 'sea_next', arguments: {} }));
    expect(empty).toMatchObject({ ticket: null, reason: 'nothing_eligible' });
  });

  it('validates input at the boundary (zod) and reports it as an error result', async () => {
    const r = (await client.callTool({ name: 'sea_create', arguments: { title: '', kind: 'nope' } })) as ToolResult;
    expect(r.isError).toBe(true);
  });

  it('serves sea://tickets/{id} as a resource', async () => {
    const created = parse<{ ticket: { id: string } }>(await client.callTool({ name: 'sea_create', arguments: { title: 'As a resource' } }));
    const res = await client.readResource({ uri: `sea://tickets/${created.ticket.id}` });
    const body = JSON.parse((res.contents[0] as { text: string }).text) as { ticket: { title: string } };
    expect(body.ticket.title).toBe('As a resource');
  });
});

describe('MCP server (stdio, built CLI)', () => {
  const CLI = join(process.cwd(), 'dist', 'cli.js');
  let dir: string;
  let client: Client;

  beforeAll(async () => {
    if (!existsSync(CLI)) throw new Error('dist/cli.js missing; run npm run build first (npm test does this via pretest)');
    dir = mkdtempSync(join(tmpdir(), 'sea-lite-stdio-'));
    client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'serve', '--data-dir', dir, '--actor', 'stdio-agent', '--role', 'operator'],
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('speaks MCP over stdio against a file-backed store and shares it with kronicle-lite', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    const created = parse<{ ticket: { id: string } }>(await client.callTool({ name: 'sea_create', arguments: { title: 'over stdio', status: 'triaged', claim_seconds: 60 } }));
    const forced = parse<{ forced: boolean; previous_holder: string }>(
      await client.callTool({ name: 'sea_release', arguments: { ticket_id: created.ticket.id, force: true, reason: 'test' } }),
    );
    expect(forced).toEqual(expect.objectContaining({ forced: true, previous_holder: 'stdio-agent' }));
    // The same file is a kronicle-lite store: its chain holds our events.
    const { KronicleLite } = await import('kronicle-lite');
    const kl = new KronicleLite({ dataDir: dir });
    const types = [...kl.chain.iterate()].map((e) => e.event_type);
    expect(types).toEqual(['sea_ticket.created', 'sea_ticket.claimed', 'sea_ticket.claim_force_released']);
    expect(kl.chain.verify().ok).toBe(true);
    kl.close();
  });
});
