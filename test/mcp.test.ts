/**
 * Over the protocol (2026-07-28, SDK v2): a Client against createServer()
 * through the in-memory linked transport, and separately against the built
 * CLI over real stdio. The last block connects a 2025-era (SDK v1) client to
 * the same CLI to pin backward compatibility with handshake clients.
 */

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_INSTRUCTIONS_CHARS } from '../src/server.js';
import { SeaLite } from '../src/store.js';
import { connectInMemory, parse, TOOLS, type ToolResult } from './mcp-helpers.js';

describe('MCP server (in-process transport, 2026-07-28 era)', () => {
  let store: SeaLite;
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    store = new SeaLite({ memory: true, actor: 'agent-1' });
    ({ client, close } = await connectInMemory(store));
  });

  afterAll(async () => {
    await close();
    store.close();
  });

  it('negotiates the 2026-07-28 era and answers server/discover with identity, capabilities, instructions and a cache hint', async () => {
    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const d = await client.discover();
    expect(d.supportedVersions).toContain('2026-07-28');
    expect(d.capabilities).toHaveProperty('tools');
    expect(d.capabilities).toHaveProperty('resources');
    expect(d._meta?.['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'sea-lite' });
    expect(d.instructions).toMatch(/sea_next/);
    expect(d.instructions!.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    expect(d.ttlMs).toBeGreaterThan(0);
    expect(d.cacheScope).toBe('public');
  });

  it('lists the thirteen tools deterministically with input + output schemas, descriptions and a cache hint', async () => {
    const first = await client.listTools();
    expect(first.tools.map((t) => t.name).sort()).toEqual(TOOLS);
    expect(first.ttlMs).toBeGreaterThan(0);
    expect(first.cacheScope).toBe('public');
    const second = await client.listTools();
    expect(second.tools.map((t) => t.name)).toEqual(first.tools.map((t) => t.name));
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    for (const t of first.tools) {
      expect(t.outputSchema, t.name).toBeDefined();
      expect((t.outputSchema as { type: string }).type).toBe('object');
      expect(t.description, t.name).toBeTruthy();
    }
    const next = first.tools.find((t) => t.name === 'sea_next')!;
    expect(next.description).toMatch(/predecessors/);
    const props = (next.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('lease_seconds');
    const create = first.tools.find((t) => t.name === 'sea_create')!;
    expect((create.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties['kind']!.enum).toContain('bug');
    const get = first.tools.find((t) => t.name === 'sea_get')!;
    expect(get.annotations?.readOnlyHint).toBe(true);
  });

  it('sets destructiveHint explicitly on every write tool (spec default is true)', async () => {
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.destructiveHint]));
    for (const t of ['sea_create', 'sea_apply', 'sea_claim', 'sea_refresh', 'sea_next']) expect(hints[t], t).toBe(false);
    for (const t of ['sea_update', 'sea_transition', 'sea_link', 'sea_release']) expect(hints[t], t).toBe(true);
    for (const t of ['sea_get', 'sea_list', 'sea_history']) expect(hints[t], t).toBeUndefined();
  });

  it('runs the queue loop: create → next → update → transition → history, with fenced errors as isError and structuredContent on success', async () => {
    const createdRes = (await client.callTool({
      name: 'sea_create',
      arguments: { title: 'Wire the thing', kind: 'feature', priority: 'high', status: 'triaged' },
    })) as ToolResult;
    const created = parse<{ ticket: { id: string }; possible_duplicates: unknown[] }>(createdRes);
    expect(created.possible_duplicates).toEqual([]);
    expect(createdRes.structuredContent).toEqual(created); // text block and structured content carry the same JSON

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
    expect(denied.structuredContent).toBeUndefined();
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
      await client.callTool({ name: 'sea_transition', arguments: { ticket_id: next.ticket.id, claim_token: next.claim_token, to: 'resolved', confirm: true } }),
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

  it('every tool returns structuredContent that validates against its published outputSchema (server and client both check)', async () => {
    // The v2 client validates structuredContent against the cached tools/list outputSchema and throws on a mismatch;
    // the server refuses to send a non-conforming result. Exercising every success path pins the schemas.
    const a = parse<{ ticket: { id: string } }>(await client.callTool({ name: 'sea_create', arguments: { title: 'schema A', status: 'triaged' } }));
    const b = parse<{ tickets: { ticket_id: string }[] }>(
      await client.callTool({
        name: 'sea_apply',
        arguments: { tickets: [{ ref: 'x', title: 'schema B' }, { ref: 'y', title: 'schema C' }], links: [{ from_ref: 'x', to_ref: 'y', link_type: 'parent_of' }] },
      }),
    );
    const claim = parse<{ claims: { claim_token: string }[] }>(await client.callTool({ name: 'sea_claim', arguments: { ticket_ids: [a.ticket.id] } }));
    const token = claim.claims[0]!.claim_token;
    await client.callTool({ name: 'sea_refresh', arguments: { ticket_id: a.ticket.id, claim_token: token, extend_by_seconds: 600 } });
    await client.callTool({ name: 'sea_link', arguments: { action: 'add', from_id: a.ticket.id, to_id: b.tickets[0]!.ticket_id, link_type: 'relates_to', claim_token: token } });
    await client.callTool({ name: 'sea_link', arguments: { action: 'remove', from_id: a.ticket.id, to_id: b.tickets[0]!.ticket_id, link_type: 'relates_to', claim_token: token } });
    await client.callTool({ name: 'sea_update', arguments: { ticket_id: a.ticket.id, claim_token: token, note: 'n', dry_run: true } });
    await client.callTool({ name: 'sea_transition', arguments: { ticket_id: a.ticket.id, claim_token: token, to: 'in_progress', dry_run: true } });
    const got = parse<{ ticket: { claim: { holder: string } }; legal_next: string[] }>(await client.callTool({ name: 'sea_get', arguments: { id: a.ticket.id } }));
    expect(got.ticket.claim.holder).toBe('agent-1');
    const full = parse<{ tickets: { body?: string }[] }>(await client.callTool({ name: 'sea_list', arguments: { view: 'full', include_terminal: true } }));
    expect(full.tickets.length).toBeGreaterThanOrEqual(3);
    expect(full.tickets[0]).toHaveProperty('body');
    const rel = parse<{ ticket: { claim: null } }>(await client.callTool({ name: 'sea_release', arguments: { ticket_id: a.ticket.id, claim_token: token, note: 'bye' } }));
    expect(rel.ticket.claim).toBeNull();
    const feed = parse<{ mode: string; truncated: boolean }>(await client.callTool({ name: 'sea_history', arguments: { since_seq: 0, limit: 2, verify: false } }));
    expect(feed).toMatchObject({ mode: 'feed', truncated: true });
  });

  it('validates input at the boundary (zod) and reports it as an error result', async () => {
    const r = (await client.callTool({ name: 'sea_create', arguments: { title: '', kind: 'nope' } })) as ToolResult;
    expect(r.isError).toBe(true);
  });

  it('serves sea://tickets/{id} as a resource (private, uncached)', async () => {
    const created = parse<{ ticket: { id: string } }>(await client.callTool({ name: 'sea_create', arguments: { title: 'As a resource' } }));
    const res = await client.readResource({ uri: `sea://tickets/${created.ticket.id}` });
    const body = JSON.parse((res.contents[0] as { text: string }).text) as { ticket: { title: string } };
    expect(body.ticket.title).toBe('As a resource');
    expect((res as { cacheScope?: string }).cacheScope).toBe('private');
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toEqual(['sea://tickets/{id}']);
  });
});

describe('MCP server (in-process transport, 2025 initialize handshake)', () => {
  it('serves a legacy-era v2 client from the same factory: tools, structuredContent, resource', async () => {
    const store = new SeaLite({ memory: true, actor: 'legacy-agent' });
    const { client, close } = await connectInMemory(store, { era: 'legacy' });
    try {
      expect(client.getProtocolEra()).toBe('legacy');
      expect(client.getInstructions()).toMatch(/sea_next/);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
      const res = (await client.callTool({ name: 'sea_create', arguments: { title: 'legacy', status: 'triaged' } })) as ToolResult;
      expect(res.isError).toBeFalsy();
      expect((res.structuredContent as { ticket: { title: string } }).ticket.title).toBe('legacy');
      const id = (res.structuredContent as { ticket: { id: string } }).ticket.id;
      const r = await client.readResource({ uri: `sea://tickets/${id}` });
      expect(JSON.parse((r.contents[0] as { text: string }).text).ticket.id).toBe(id);
    } finally {
      await close();
      store.close();
    }
  });
});

describe('MCP server (stdio, built CLI)', () => {
  const CLI = join(process.cwd(), 'dist', 'cli.js');
  let dir: string;
  let client: Client;

  beforeAll(async () => {
    if (!existsSync(CLI)) throw new Error('dist/cli.js missing; run npm run build first (npm test does this via pretest)');
    dir = mkdtempSync(join(tmpdir(), 'sea-lite-stdio-'));
    client = new Client({ name: 'stdio-test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
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

  it('speaks MCP 2026-07-28 over stdio against a file-backed store and shares it with kronicle-lite', async () => {
    expect(client.getProtocolEra()).toBe('modern');
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

describe('MCP server (stdio, 2025-era SDK v1 client — handshake backward compatibility)', () => {
  const CLI = join(process.cwd(), 'dist', 'cli.js');
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sea-lite-v1-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a v1 SDK client (initialize handshake, protocol 2025-06-18) lists tools, calls them and reads the resource', async () => {
    const { Client: V1Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport: V1Stdio } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const v1 = new V1Client({ name: 'v1-client', version: '1.0.0' });
    await v1.connect(new V1Stdio({ command: process.execPath, args: [CLI, 'serve', '--data-dir', dir, '--actor', 'v1-agent'] }));
    try {
      expect(v1.getServerVersion()).toMatchObject({ name: 'sea-lite' });
      expect(v1.getInstructions()).toMatch(/sea_next/);
      const { tools } = await v1.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
      expect(tools.find((t) => t.name === 'sea_get')!.outputSchema).toBeDefined();
      const created = (await v1.callTool({ name: 'sea_create', arguments: { title: 'from v1', status: 'triaged' } })) as ToolResult;
      expect(created.isError).toBeFalsy();
      const id = (created.structuredContent as { ticket: { id: string } }).ticket.id;
      const next = (await v1.callTool({ name: 'sea_next', arguments: {} })) as ToolResult;
      const token = (next.structuredContent as { claim_token: string }).claim_token;
      // No elicitation capability on this client: the terminal move needs confirm: true, and says so.
      const asked = (await v1.callTool({ name: 'sea_transition', arguments: { ticket_id: id, claim_token: token, to: 'resolved' } })) as ToolResult;
      expect(asked.isError).toBe(true);
      expect(parse<{ error: string }>(asked).error).toBe('confirmation_required');
      const done = (await v1.callTool({ name: 'sea_transition', arguments: { ticket_id: id, claim_token: token, to: 'resolved', confirm: true } })) as ToolResult;
      expect((done.structuredContent as { to: string }).to).toBe('resolved');
      const res = await v1.readResource({ uri: `sea://tickets/${id}` });
      expect(JSON.parse((res.contents[0] as { text: string }).text).ticket.status).toBe('resolved');
    } finally {
      await v1.close();
    }
  });
});
