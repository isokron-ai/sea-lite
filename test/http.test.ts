/**
 * Streamable HTTP: 2026-07-28 only, bearer, loopback, per-request identity
 * (shared bearer → --actor, unbound; actors-file token → its own actor, bound).
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addActorToken,
  DEFAULT_HTTP_PORT,
  loadOrCreateBearer,
  parseActorsFile,
  readActorsFile,
  serveHttp,
  tokenSha256,
  type HttpServeHandle,
} from '../src/http.js';
import { SeaLite } from '../src/store.js';
import { parse, TOOLS } from './mcp-helpers.js';

const MODERN = '2026-07-28';
const META = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} };
const POSIX = process.platform !== 'win32';

function rpcHeaders(bearer: string | null, method: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MODERN,
    'Mcp-Method': method,
    ...(bearer !== null ? { Authorization: `Bearer ${bearer}` } : {}),
    ...extra,
  };
}

async function call(url: string, bearer: string, name: string, args: Record<string, unknown>, id = 1): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: rpcHeaders(bearer, 'tools/call', { 'Mcp-Name': name }),
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, _meta: META } }),
  });
  return { status: res.status, body: await res.json() };
}

function toolJson<T = Record<string, unknown>>(body: unknown): { isError: boolean; value: T } {
  const r = (body as { result: { isError?: boolean; content: { text: string }[] } }).result;
  return { isError: r.isError === true, value: JSON.parse(r.content[0]!.text) as T };
}

describe('tokens and the actors file', () => {
  it('default port is 7418 (kronicle-lite is 7417)', () => {
    expect(DEFAULT_HTTP_PORT).toBe(7418);
  });

  it('bearer file is created once with mode 0600 and reused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sea-http-tok-'));
    try {
      const a = loadOrCreateBearer(dir);
      expect(a.created).toBe(true);
      expect(a.token.length).toBeGreaterThanOrEqual(32);
      if (POSIX) expect(statSync(a.file).mode & 0o777).toBe(0o600);
      expect(loadOrCreateBearer(dir)).toEqual({ token: a.token, created: false, file: a.file });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('add-token stores only the sha256, mode 0600, and refuses a second token for one actor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sea-http-act-'));
    try {
      const file = join(dir, 'http-actors.json');
      const a = addActorToken(file, 'alice');
      const b = addActorToken(file, 'bob', 'operator');
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      if (POSIX) expect(statSync(file).mode & 0o777).toBe(0o600);
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain(a.token);
      expect(text).toContain(tokenSha256(a.token));
      expect(readActorsFile(file)).toEqual([
        { actor: 'alice', role: 'agent', token_sha256: tokenSha256(a.token) },
        { actor: 'bob', role: 'operator', token_sha256: tokenSha256(b.token) },
      ]);
      expect(() => addActorToken(file, 'alice')).toThrow(/already has a token/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parseActorsFile rejects bad shapes, duplicate actors, shared tokens and short tokens', () => {
    expect(() => parseActorsFile('nope')).toThrow(/not JSON/);
    expect(() => parseActorsFile('{"actors":[{"actor":"a"}]}')).toThrow(/exactly one of token, token_sha256/);
    expect(() => parseActorsFile('{"actors":[{"actor":"a","token":"short"}]}')).toThrow(/token/);
    expect(() => parseActorsFile('{"actors":[{"actor":"a","token_sha256":"XYZ"}]}')).toThrow(/64 lowercase hex/);
    expect(() => parseActorsFile('{"actors":[],"extra":1}')).toThrow();
    const t = 'x'.repeat(20);
    expect(() => parseActorsFile(JSON.stringify({ actors: [{ actor: 'a', token: t }, { actor: 'a', token: 'y'.repeat(20) }] }))).toThrow(/more than once/);
    expect(() => parseActorsFile(JSON.stringify({ actors: [{ actor: 'a', token: t }, { actor: 'b', token_sha256: tokenSha256(t) }] }))).toThrow(
      /share a token/,
    );
    expect(parseActorsFile(JSON.stringify({ actors: [{ actor: 'a', token: t, role: 'operator' }] }))).toEqual([
      { actor: 'a', role: 'operator', token_sha256: tokenSha256(t) },
    ]);
  });

  it('serveHttp refuses an actor token equal to the shared bearer', async () => {
    const store = new SeaLite({ memory: true });
    const bearer = 'b'.repeat(32);
    await expect(serveHttp({ store, bearer, actors: [{ actor: 'x', role: 'agent', token_sha256: tokenSha256(bearer) }], port: 0 })).rejects.toThrow(
      /equals the shared bearer/,
    );
    await expect(serveHttp({ store, bearer: 'short', port: 0 })).rejects.toThrow(/at least 16/);
    store.close();
  });
});

describe('Streamable HTTP (2026-07-28 only, bearer, loopback, per-request actor)', () => {
  let store: SeaLite;
  let dir: string;
  let http: HttpServeHandle;
  let bearer: string;
  let aliceToken: string;
  let bobToken: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sea-http-'));
    store = new SeaLite({ memory: true, actor: 'http-default' });
    bearer = loadOrCreateBearer(dir).token;
    const file = join(dir, 'http-actors.json');
    aliceToken = addActorToken(file, 'alice').token;
    bobToken = addActorToken(file, 'bob', 'operator').token;
    http = await serveHttp({ store, bearer, actors: readActorsFile(file), port: 0 });
  });

  afterAll(async () => {
    await http.close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('binds loopback by default', () => {
    expect(http.host).toBe('127.0.0.1');
    expect(http.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('a v2 client pinned to 2026-07-28 completes a round trip with the shared bearer (acts as --actor)', async () => {
    const client = new Client({ name: 'http-test', version: '0.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
    expect(client.getProtocolEra()).toBe('modern');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    const c = parse<{ ticket: { created_by: string } }>(await client.callTool({ name: 'sea_create', arguments: { title: 'over http' } }));
    expect(c.ticket.created_by).toBe('http-default');
    // The shared bearer is unbound: actor_id stays a self-asserted label, as on stdio.
    const c2 = parse<{ ticket: { created_by: string } }>(await client.callTool({ name: 'sea_create', arguments: { title: 'labelled', actor_id: 'carol' } }));
    expect(c2.ticket.created_by).toBe('carol');
    await client.close();
  });

  it('an actors-file token acts as its own actor; actor_id naming someone else is forbidden', async () => {
    const created = await call(http.url, aliceToken, 'sea_create', { title: 'alice made this', status: 'triaged', claim_seconds: 60 });
    expect(created.status).toBe(200);
    const r = toolJson<{ ticket: { id: string; created_by: string; claim: { holder: string } } }>(created.body);
    expect(r.isError).toBe(false);
    expect(r.value.ticket.created_by).toBe('alice');
    expect(r.value.ticket.claim.holder).toBe('alice');

    const same = toolJson(( await call(http.url, aliceToken, 'sea_get', { id: r.value.ticket.id, actor_id: 'alice' })).body);
    expect(same.isError).toBe(false);

    const spoof = toolJson<{ error: string; details: { actor: string } }>((await call(http.url, aliceToken, 'sea_create', { title: 'x', actor_id: 'bob' })).body);
    expect(spoof.isError).toBe(true);
    expect(spoof.value.error).toBe('forbidden');
    expect(spoof.value.details.actor).toBe('alice');

    // The transition path is guarded too (it bypasses the plain wrapper for the confirmation gate).
    const tr = toolJson<{ error: string }>(
      (await call(http.url, aliceToken, 'sea_transition', { ticket_id: r.value.ticket.id, claim_token: 'a'.repeat(64), to: 'parked', actor_id: 'bob' })).body,
    );
    expect(tr.value.error).toBe('forbidden');
  });

  it('per-token role: bob (operator) may force-release; alice (agent) may not', async () => {
    const t = toolJson<{ ticket: { id: string } }>((await call(http.url, aliceToken, 'sea_create', { title: 'held', status: 'triaged', claim_seconds: 60 })).body);
    const id = t.value.ticket.id;
    const denied = toolJson<{ error: string }>((await call(http.url, aliceToken, 'sea_release', { ticket_id: id, force: true })).body);
    expect(denied.value.error).toBe('forbidden');
    const ok = toolJson<{ forced: boolean; previous_holder: string }>((await call(http.url, bobToken, 'sea_release', { ticket_id: id, force: true, reason: 'test' })).body);
    expect(ok.isError).toBe(false);
    expect(ok.value).toMatchObject({ forced: true, previous_holder: 'alice' });
    const ev = store.history({ ticket_id: id, limit: 100, verify: false }).events.find((e) => e.event_type === 'sea_ticket.claim_force_released');
    expect(ev?.actor_id).toBe('bob');
  });

  it('rejects: missing/wrong bearer → 401, bad Origin → 403, GET → 405, wrong path → 404', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: META } });
    const noAuth = await fetch(http.url, { method: 'POST', headers: rpcHeaders(null, 'server/discover'), body });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toMatch(/Bearer realm="sea-lite"/);
    const wrong = await fetch(http.url, { method: 'POST', headers: rpcHeaders('nope-nope-nope-nope', 'server/discover'), body });
    expect(wrong.status).toBe(401);
    const badOrigin = await fetch(http.url, { method: 'POST', headers: rpcHeaders(bearer, 'server/discover', { Origin: 'https://evil.example' }), body });
    expect(badOrigin.status).toBe(403);
    const get = await fetch(http.url, { headers: { Authorization: `Bearer ${bearer}` } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const notFound = await fetch(http.url.replace('/mcp', '/nope'), { method: 'POST', headers: rpcHeaders(bearer, 'server/discover'), body });
    expect(notFound.status).toBe(404);
  });

  it('a foreign Host header is rejected before the bearer is looked at (DNS rebinding)', async () => {
    const u = new URL(http.url);
    const status = await new Promise<number>((resolve, rejectReq) => {
      const req = request(
        { host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: 'attacker.example', 'Content-Type': 'application/json' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', rejectReq);
      req.end('{}');
    });
    expect(status).toBe(403);
  });

  it('a 2025-era initialize POST is refused with 400 / -32022 naming 2026-07-28, no session id', async () => {
    const res = await fetch(http.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } },
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: number; data?: { supported?: string[] } } };
    expect(json.error.code).toBe(-32022);
    expect(json.error.data?.supported).toEqual([MODERN]);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('modern raw POST from a loopback Origin gets a plain JSON result, cache hints and no session id', async () => {
    const res = await fetch(http.url, {
      method: 'POST',
      headers: rpcHeaders(bearer, 'tools/list', { Origin: 'http://localhost' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: META } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const json = (await res.json()) as { id: number; result: Record<string, unknown> };
    expect(json.id).toBe(7);
    expect(json.result).toMatchObject({ resultType: 'complete', ttlMs: 3_600_000, cacheScope: 'public' });
  });

  it('a malformed actors file never reaches serve (bad file → parse error)', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"actors":[{"actor":"x","token":"tiny"}]}');
    expect(() => readActorsFile(bad)).toThrow(/bad\.json/);
  });
});

describe('sea-lite serve --http (CLI)', () => {
  const CLI = join(__dirname, '..', 'dist', 'cli.js');

  it('creates the bearer file, prints the URL, serves a request, stops on SIGTERM', async () => {
    const { spawn } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'sea-http-cli-'));
    const child = spawn(process.execPath, [CLI, 'serve', '--http', '--port', '0', '--data-dir', dir, '--actor', 'cli-http'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      const url = await new Promise<string>((resolve, rejectUrl) => {
        let err = '';
        child.stderr!.on('data', (d: Buffer) => {
          err += d.toString();
          const m = /at (http:\/\/\S+\/mcp);/.exec(err);
          if (m) resolve(m[1]!);
        });
        child.once('exit', (code) => rejectUrl(new Error(`exited ${code}: ${err}`)));
      });
      const token = readFileSync(join(dir, 'http-bearer.token'), 'utf8').trim();
      const r = await call(url, token, 'sea_create', { title: 'via cli' });
      expect(toolJson<{ ticket: { created_by: string } }>(r.body).value.ticket.created_by).toBe('cli-http');
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
