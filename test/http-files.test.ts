/**
 * 0.6.1 HTTP token files:
 * - P2-07: concurrent first starts on a fresh data dir agree on one bearer
 *   (exclusive create; a reader never sees a half-written file).
 * - P2-13: a token file group or others can read is refused unless
 *   --allow-insecure-token-file (then a warning).
 * - P2-12: the actors file is re-read when it changes (add-token after start
 *   works without a restart); add-token creates a missing data dir; the
 *   force-release refusal names the token's role.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { addActorToken, BEARER_FILE_NAME, loadOrCreateBearer, serveHttp } from '../src/http.js';
import { SeaLite } from '../src/store.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const INDEX = join(process.cwd(), 'dist', 'index.js');
const POSIX = process.platform !== 'win32';
const MODERN = '2026-07-28';
const META = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} };

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function call(url: string, bearer: string, name: string, args: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MODERN,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: META } }),
  });
  return { status: res.status, text: await res.text() };
}

/** The tool's own JSON (content[0].text) from a JSON-RPC response body. */
interface ToolJson {
  error?: string;
  message?: string;
  ticket: { id: string; created_by: string };
}
function tool(text: string): { isError: boolean; value: ToolJson } {
  const r = (JSON.parse(text) as { result: { isError?: boolean; content: { text: string }[] } }).result;
  return { isError: r.isError === true, value: JSON.parse(r.content[0]!.text) as ToolJson };
}

describe('bearer file: atomic first start (P2-07)', () => {
  it('eight processes creating the bearer at once on a fresh data dir all get the same token', async () => {
    const base = tmp('sea-race-');
    const data = join(base, 'data'); // does not exist yet: created on the way
    const script = `import(${JSON.stringify('file://' + INDEX.replace(/\\/g, '/'))}).then((m) => { const b = m.loadOrCreateBearer(process.argv[1]); process.stdout.write(JSON.stringify({ t: b.token, c: b.created })); })`;
    const runs = await Promise.all(
      Array.from({ length: 8 }, () =>
        new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
          const p = spawn(process.execPath, ['-e', script, data], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          let err = '';
          p.stdout.on('data', (d: Buffer) => (out += d.toString()));
          p.stderr.on('data', (d: Buffer) => (err += d.toString()));
          p.on('exit', (code) => resolve({ code, out, err }));
        }),
      ),
    );
    for (const r of runs) expect(r.code, r.err).toBe(0);
    const got = runs.map((r) => JSON.parse(r.out) as { t: string; c: boolean });
    expect(new Set(got.map((g) => g.t)).size).toBe(1);
    expect(got.filter((g) => g.c).length).toBe(1);
    expect(readFileSync(join(data, BEARER_FILE_NAME), 'utf8').trim()).toBe(got[0]!.t);
  });

  it('a file caught empty (another writer between create and write) is re-read until it has a token', () => {
    const dir = tmp('sea-empty-');
    const file = join(dir, BEARER_FILE_NAME);
    writeFileSync(file, '', { mode: 0o600 });
    // Another process fills it 300 ms later; loadOrCreateBearer waits for it instead of failing "empty".
    const later = spawn(process.execPath, ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(file)}, 'x'.repeat(43) + '\\n'), 300)`], { stdio: 'ignore' });
    try {
      expect(loadOrCreateBearer(dir).token).toBe('x'.repeat(43));
    } finally {
      later.kill();
    }
  });

  it('a file that stays empty is still an error, after the wait', () => {
    const dir = tmp('sea-empty2-');
    writeFileSync(join(dir, BEARER_FILE_NAME), '\n', { mode: 0o600 });
    expect(() => loadOrCreateBearer(dir)).toThrow(/is empty; delete it to regenerate/);
  });
});

describe.runIf(POSIX)('token file modes (P2-13)', () => {
  it('a pre-existing 0644 bearer file is refused; --allow-insecure-token-file turns it into a warning', () => {
    const dir = tmp('sea-mode-');
    const a = loadOrCreateBearer(dir);
    expect(a.warning).toBeNull();
    chmodSync(a.file, 0o644);
    expect(() => loadOrCreateBearer(dir)).toThrow(/readable by group or others \(mode 0644\).*--allow-insecure-token-file/);
    const b = loadOrCreateBearer(dir, { allowInsecure: true });
    expect(b.token).toBe(a.token);
    expect(b.warning).toMatch(/^warning: .*mode 0644/);
    chmodSync(a.file, 0o600);
    expect(loadOrCreateBearer(dir).warning).toBeNull();
  });

  it('serve --http refuses a 0644 bearer file (exit 2, clear stderr) and --bearer-file too', () => {
    const dir = tmp('sea-mode-cli-');
    const { file } = loadOrCreateBearer(dir);
    chmodSync(file, 0o644);
    for (const extra of [[], ['--bearer-file', file]]) {
      const r = spawnSync(process.execPath, [CLI, 'serve', '--http', '--port', '0', '--data-dir', dir, ...extra], { encoding: 'utf8', timeout: 60_000 });
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/readable by group or others .*--allow-insecure-token-file/);
      expect(r.stderr).not.toMatch(/\n\s+at /); // no stack trace
    }
  });

  it('serve --http --allow-insecure-token-file starts with a warning', async () => {
    const dir = tmp('sea-mode-ok-');
    const { file } = loadOrCreateBearer(dir);
    chmodSync(file, 0o644);
    const child = spawn(process.execPath, [CLI, 'serve', '--http', '--port', '0', '--data-dir', dir, '--allow-insecure-token-file'], { stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      const err = await new Promise<string>((resolve, rejectRun) => {
        let e = '';
        child.stderr!.on('data', (d: Buffer) => {
          e += d.toString();
          if (/serving Streamable HTTP/.test(e)) resolve(e);
        });
        child.once('exit', (code) => rejectRun(new Error(`exited ${code}: ${e}`)));
      });
      expect(err).toMatch(/warning: .*mode 0644/);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
});

describe('actors file follows changes (P2-12)', () => {
  it('a token added after start works without a restart; a removed one stops; a broken file keeps the previous table', async () => {
    const dir = tmp('sea-reload-');
    const file = join(dir, 'http-actors.json');
    const store = new SeaLite({ memory: true, actor: 'owner' });
    const errors: string[] = [];
    const bearer = loadOrCreateBearer(dir).token;
    const http = await serveHttp({ store, bearer, actorsFile: file, port: 0, onerror: (e) => errors.push(e.message) });
    try {
      // README order: serve first, add-token after.
      const alice = addActorToken(file, 'alice').token;
      const r1 = await call(http.url, alice, 'sea_create', { title: 'after start' });
      expect(r1.status).toBe(200);
      expect(tool(r1.text).value.ticket.created_by).toBe('alice');

      const good = readFileSync(file, 'utf8');
      writeFileSync(file, '{ not json');
      expect((await call(http.url, alice, 'sea_create', { title: 'still ok' })).status).toBe(200);
      expect(errors.join('\n')).toMatch(/actors file not reloaded, keeping the previous tokens/);

      writeFileSync(file, good.replace(/"actor": "alice"/, '"actor": "alice2"'));
      expect(tool((await call(http.url, alice, 'sea_create', { title: 'renamed' })).text).value.ticket.created_by).toBe('alice2');
      rmSync(file);
      expect((await call(http.url, alice, 'sea_create', { title: 'gone' })).status).toBe(401);
      expect((await call(http.url, bearer, 'sea_create', { title: 'owner still works' })).status).toBe(200);
    } finally {
      await http.close();
      store.close();
    }
  });

  it('add-token on a fresh machine (no data dir) creates it; no stack trace', () => {
    const base = tmp('sea-addtok-');
    const data = join(base, 'nested', 'data');
    const r = spawnSync(process.execPath, [CLI, 'add-token', '--actor', 'alice', '--data-dir', data], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThanOrEqual(32);
    expect(existsSync(join(data, 'http-actors.json'))).toBe(true);
  });

  it('an agent-role token asking for force release is told about token roles, not only --role', async () => {
    const dir = tmp('sea-force-');
    const file = join(dir, 'http-actors.json');
    const store = new SeaLite({ memory: true, actor: 'owner', role: 'operator' });
    const alice = addActorToken(file, 'alice').token;
    const http = await serveHttp({ store, bearer: loadOrCreateBearer(dir).token, actorsFile: file, port: 0 });
    try {
      const created = await call(http.url, alice, 'sea_create', { title: 'held', status: 'triaged', claim_seconds: 60 });
      const id = tool(created.text).value.ticket.id;
      const denied = tool((await call(http.url, alice, 'sea_release', { ticket_id: id, force: true })).text);
      expect(denied.isError).toBe(true);
      expect(denied.value.error).toBe('forbidden');
      expect(denied.value.message).toMatch(/"alice" acts as agent/);
      expect(denied.value.message).toMatch(/actors file with "role": "operator"/);
    } finally {
      await http.close();
      store.close();
    }
  });
});
