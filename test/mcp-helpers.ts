/**
 * Protocol-level test harness: a v2 Client against `createServer()` through
 * the in-memory linked transport, served by `serveStdio` (the same dual-era
 * entry the CLI uses) so tests see exactly what a stdio client sees.
 */

import { Client, type ClientCapabilities, type ClientOptions, type ElicitResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createServer } from '../src/server.js';
import type { SeaLite } from '../src/store.js';

export interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export function parse<T = Record<string, unknown>>(r: unknown): T {
  const res = r as ToolResult;
  const t = res.content[0];
  if (!t || t.type !== 'text' || !t.text) throw new Error('no text content');
  return JSON.parse(t.text) as T;
}

export const TOOLS = [
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
  'sea_scope_check',
  'sea_transition',
  'sea_update',
];

export interface ConnectOptions {
  /** `modern` negotiates 2026-07-28 via server/discover; `legacy` runs the 2025 initialize handshake. */
  era?: 'modern' | 'legacy';
  capabilities?: ClientCapabilities;
  /** Answer every embedded elicitation with this. Declares the elicitation capability. */
  elicit?: (params: { message: string }) => ElicitResult;
  /** Disable multi-round-trip auto-fulfilment so input_required surfaces to the caller. */
  autoFulfill?: boolean;
  name?: string;
}

export async function connectInMemory(store: SeaLite, opts: ConnectOptions = {}): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createServer(store), { transport: serverT });
  const capabilities: ClientCapabilities = { ...(opts.capabilities ?? {}), ...(opts.elicit ? { elicitation: { form: {} } } : {}) };
  const clientOpts: ClientOptions = {
    capabilities,
    ...(opts.era !== 'legacy' ? { versionNegotiation: { mode: 'auto' } } : {}),
    ...(opts.autoFulfill === false ? { inputRequired: { autoFulfill: false } } : {}),
  };
  const client = new Client({ name: opts.name ?? 'test-client', version: '0.0.0' }, clientOpts);
  if (opts.elicit) {
    const answer = opts.elicit;
    client.setRequestHandler('elicitation/create', (req) => answer({ message: (req.params as { message: string }).message }));
  }
  await client.connect(clientT);
  return {
    client,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}
