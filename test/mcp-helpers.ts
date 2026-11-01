/**
 * Protocol-level test harness: a v2 Client against `createServer()` through
 * the in-memory linked transport, served by `serveStdio` (the same dual-era
 * entry the CLI uses) so tests see exactly what a stdio client sees.
 */

import { Client, type ClientCapabilities, type ClientOptions, type ElicitResult } from '@modelcontextprotocol/client';
import { fromJsonSchema, InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import * as O from '../src/model/outputs.js';
import { createServer, type ServerOptions } from '../src/server.js';
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
  'sea_finish',
  'sea_get',
  'sea_history',
  'sea_link',
  'sea_list',
  'sea_next',
  'sea_refresh',
  'sea_release',
  'sea_scope_check',
  'sea_stats',
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
  /** createServer options (e.g. `profile: 'core'`). */
  server?: ServerOptions;
}

export async function connectInMemory(store: SeaLite, opts: ConnectOptions = {}): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createServer(store, opts.server), { transport: serverT });
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

/**
 * The strict result contract. tools/list publishes lean output schemas
 * (model/publish.ts); the full zod schemas, rendered as JSON Schema with
 * `additionalProperties: false`, are what every result must satisfy. Checked
 * with the SDK's own JSON Schema validator.
 */
export const STRICT_OUTPUTS: Record<string, z.ZodType> = {
  sea_create: O.CreateOutput,
  sea_apply: O.ApplyOutput,
  sea_update: O.UpdateOutput,
  sea_transition: O.TransitionOutput,
  sea_finish: O.FinishOutput,
  sea_link: O.LinkOutput,
  sea_claim: O.ClaimOutput,
  sea_refresh: O.RefreshOutput,
  sea_release: O.ReleaseOutput,
  sea_next: O.NextOutput,
  sea_get: O.GetOutput,
  sea_list: O.ListOutput,
  sea_history: O.HistoryOutput,
  sea_scope_check: O.ScopeCheckOutput,
  sea_stats: O.StatsOutput,
};

export async function assertStrictOutput(tool: string, res: unknown): Promise<void> {
  const r = res as ToolResult;
  if (r.isError) throw new Error(`${tool} returned an error: ${r.content.map((c) => c.text).join('')}`);
  const v = fromJsonSchema(z.toJSONSchema(STRICT_OUTPUTS[tool]!, { io: 'output' }) as unknown as Parameters<typeof fromJsonSchema>[0]);
  const out = await v['~standard'].validate(r.structuredContent);
  if (out.issues) throw new Error(`${tool}: structuredContent breaks the strict output contract: ${out.issues.map((i) => i.message).join('; ')}`);
}
