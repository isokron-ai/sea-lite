/**
 * Multi round-trip confirmation on sea_transition into a terminal state
 * (MCP 2026-07-28 `input_required`): asked once, answered by the client,
 * retried with inputResponses; declined → nothing changes; no elicitation
 * capability → confirmation_required; confirm: true → straight through.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { CONFIRM_KEY, supportsFormElicitation } from '../src/server.js';
import { SeaLite } from '../src/store.js';
import { connectInMemory, parse, type ToolResult } from './mcp-helpers.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function claimed(store: SeaLite) {
  const c = store.create({ title: 'Ship it', body: '', kind: 'feature', priority: 'high', tags: [], status: 'triaged', dry_run: false });
  const cl = store.claim({ ticket_ids: [c.ticket.id] });
  return { id: c.ticket.id, token: cl.claims[0]!.claim_token };
}

describe('sea_transition terminal-state confirmation (MRTR)', () => {
  it('asks a form elicitation, and completes when the client accepts with confirm: true', async () => {
    const store = new SeaLite({ memory: true, actor: 'agent-1' });
    const asked: string[] = [];
    const { client, close } = await connectInMemory(store, {
      elicit: ({ message }) => {
        asked.push(message);
        return { action: 'accept', content: { confirm: true } };
      },
    });
    closers.push(close, async () => store.close());
    const { id, token } = await claimed(store);
    const r = parse<{ to: string; claim_released: boolean }>(await client.callTool({ name: 'sea_transition', arguments: { ticket_id: id, claim_token: token, to: 'resolved' } }));
    expect(r).toMatchObject({ to: 'resolved', claim_released: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/Ship it/);
    expect(asked[0]).toMatch(/resolved/);
    expect(store.get({ id }).ticket.status).toBe('resolved');
  });

  it('a declined elicitation changes nothing and returns confirmation_declined', async () => {
    const store = new SeaLite({ memory: true, actor: 'agent-1' });
    const { client, close } = await connectInMemory(store, { elicit: () => ({ action: 'decline' }) });
    closers.push(close, async () => store.close());
    const { id, token } = await claimed(store);
    const r = (await client.callTool({ name: 'sea_transition', arguments: { ticket_id: id, claim_token: token, to: 'dropped' } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(parse<{ error: string; details: { action: string } }>(r)).toMatchObject({ error: 'confirmation_declined', details: { action: 'decline' } });
    expect(store.get({ id }).ticket.status).toBe('triaged');
    expect(store.get({ id }).ticket.claim?.holder).toBe('agent-1');
  });

  it('an accepted answer of confirm: false is a decline too', async () => {
    const store = new SeaLite({ memory: true, actor: 'agent-1' });
    const { client, close } = await connectInMemory(store, { elicit: () => ({ action: 'accept', content: { confirm: false } }) });
    closers.push(close, async () => store.close());
    const { id, token } = await claimed(store);
    const r = (await client.callTool({ name: 'sea_transition', arguments: { ticket_id: id, claim_token: token, to: 'wont_fix' } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(parse<{ error: string }>(r).error).toBe('confirmation_declined');
    expect(store.get({ id }).ticket.status).toBe('triaged');
  });

  it('a client without the elicitation capability gets confirmation_required (never a protocol error) and can pass confirm: true', async () => {
    const store = new SeaLite({ memory: true, actor: 'agent-1' });
    const { client, close } = await connectInMemory(store);
    closers.push(close, async () => store.close());
    const { id, token } = await claimed(store);
    const r = (await client.callTool({ name: 'sea_transition', arguments: { ticket_id: id, claim_token: token, to: 'resolved' } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(parse<{ error: string; details: { to: string } }>(r)).toMatchObject({ error: 'confirmation_required', details: { to: 'resolved' } });
    const ok = parse<{ to: string }>(await client.callTool({ name: 'sea_transition', arguments: { ticket_id: id, claim_token: token, to: 'resolved', confirm: true } }));
    expect(ok.to).toBe('resolved');
  });

  it('does not ask when the move would be rejected anyway: the fence/legality error comes first', async () => {
    const store = new SeaLite({ memory: true, actor: 'agent-1' });
    let asks = 0;
    const { client, close } = await connectInMemory(store, {
      elicit: () => {
        asks++;
        return { action: 'accept', content: { confirm: true } };
      },
    });
    closers.push(close, async () => store.close());
    const { id } = await claimed(store);
    const r = (await client.callTool({ name: 'sea_transition', arguments: { ticket_id: id, claim_token: 'f'.repeat(64), to: 'resolved' } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(parse<{ error: string }>(r).error).toBe('fence_invalid');
    expect(asks).toBe(0);
  });

  it('non-terminal moves and dry runs never ask', async () => {
    const store = new SeaLite({ memory: true, actor: 'agent-1' });
    let asks = 0;
    const { client, close } = await connectInMemory(store, {
      elicit: () => {
        asks++;
        return { action: 'accept', content: { confirm: true } };
      },
    });
    closers.push(close, async () => store.close());
    const { id, token } = await claimed(store);
    const a = parse<{ to: string }>(await client.callTool({ name: 'sea_transition', arguments: { ticket_id: id, claim_token: token, to: 'in_progress' } }));
    expect(a.to).toBe('in_progress');
    const d = parse<{ dry_run: boolean; claim_released: boolean }>(
      await client.callTool({ name: 'sea_transition', arguments: { ticket_id: id, claim_token: token, to: 'resolved', dry_run: true } }),
    );
    expect(d).toMatchObject({ dry_run: true, claim_released: true });
    expect(asks).toBe(0);
    expect(store.get({ id }).ticket.status).toBe('in_progress');
  });

  it('manual mode: the raw input_required result carries the elicitation under the documented key', async () => {
    const store = new SeaLite({ memory: true, actor: 'agent-1' });
    const { client, close } = await connectInMemory(store, { capabilities: { elicitation: { form: {} } }, autoFulfill: false });
    closers.push(close, async () => store.close());
    const { id, token } = await claimed(store);
    const raw = (await client.request(
      { method: 'tools/call', params: { name: 'sea_transition', arguments: { ticket_id: id, claim_token: token, to: 'resolved' } } },
      { allowInputRequired: true },
    )) as unknown as { resultType: string; inputRequests: Record<string, { method: string; params: { mode: string; requestedSchema: { required: string[] } } }> };
    expect(raw.resultType).toBe('input_required');
    const req = raw.inputRequests[CONFIRM_KEY]!;
    expect(req.method).toBe('elicitation/create');
    expect(req.params.mode).toBe('form');
    expect(req.params.requestedSchema.required).toEqual(['confirm']);
    // Retry with the answer, as a client that gathers input itself would.
    const done = (await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'sea_transition',
          arguments: { ticket_id: id, claim_token: token, to: 'resolved' },
          inputResponses: { [CONFIRM_KEY]: { action: 'accept', content: { confirm: true } } },
        },
      },
      { allowInputRequired: true },
    )) as ToolResult;
    expect(parse<{ to: string }>(done).to).toBe('resolved');
  });

  it('a 2025-era client with elicitation is served through the SDK legacy shim (real elicitation/create request)', async () => {
    const store = new SeaLite({ memory: true, actor: 'agent-1' });
    let asks = 0;
    const { client, close } = await connectInMemory(store, {
      era: 'legacy',
      elicit: () => {
        asks++;
        return { action: 'accept', content: { confirm: true } };
      },
    });
    closers.push(close, async () => store.close());
    expect(client.getProtocolEra()).toBe('legacy');
    const { id, token } = await claimed(store);
    const r = parse<{ to: string }>(await client.callTool({ name: 'sea_transition', arguments: { ticket_id: id, claim_token: token, to: 'resolved' } }));
    expect(r.to).toBe('resolved');
    expect(asks).toBe(1);
  });

  it('supportsFormElicitation reads the capability the way the spec does', () => {
    expect(supportsFormElicitation(undefined)).toBe(false);
    expect(supportsFormElicitation({})).toBe(false);
    expect(supportsFormElicitation({ elicitation: {} })).toBe(true);
    expect(supportsFormElicitation({ elicitation: { form: {} } })).toBe(true);
    expect(supportsFormElicitation({ elicitation: { url: {} } })).toBe(false);
    expect(supportsFormElicitation({ elicitation: { form: {}, url: {} } })).toBe(true);
  });
});
