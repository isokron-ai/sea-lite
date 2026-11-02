/**
 * P2-05 / F11 (0.6.1): a stdin line over 10 MiB used to make `serve` exit 0
 * with no JSON-RPC error. It is now discarded as it streams and answered with
 * an error carrying the request id; the server stays up.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { idFromHead, StdioLineGuard } from '../src/stdio-guard.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

describe('StdioLineGuard', () => {
  it('finds the id at the start of a request line, not one nested in params', () => {
    expect(idFromHead('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"x":1}}')).toBe(7);
    expect(idFromHead('{"jsonrpc":"2.0","id":"f11","method":"tools/call","params":{"arguments":{"query":"aaaa')).toBe('f11');
    expect(idFromHead('{"jsonrpc":"2.0","method":"tools/call","params":{"id":"inner","q":"aaa')).toBeUndefined();
    expect(idFromHead('{"method":"x","params":{"a":"b"},"id":3}')).toBeUndefined(); // id after params: not in the kept head
  });

  it('passes normal lines through whole, drops an oversized one across chunks and answers it', async () => {
    const answers: string[] = [];
    const logs: string[] = [];
    const g = new StdioLineGuard((l) => answers.push(l), (m) => logs.push(m), 1000);
    const out: Buffer[] = [];
    g.on('data', (d: Buffer) => out.push(d));
    g.write('{"id":1}\n{"jsonrpc":"2.0","id":"big","method":"m","params":{"q":"');
    for (let i = 0; i < 5; i++) g.write('x'.repeat(400));
    g.write('"}}\n{"id":2}\n');
    g.end();
    await new Promise((r) => g.on('end', r));
    expect(Buffer.concat(out).toString()).toBe('{"id":1}\n{"id":2}\n');
    expect(answers).toHaveLength(1);
    expect(JSON.parse(answers[0]!)).toMatchObject({ jsonrpc: '2.0', id: 'big', error: { code: -32600 } });
    expect(logs[0]).toMatch(/exceeds the 1000-byte stdio limit/);
  });
});

describe('serve (stdio) with an 11 MiB request', () => {
  it('answers it with a JSON-RPC error and keeps serving', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sea-f11-'));
    const p = spawn(process.execPath, [CLI, 'serve', '--data-dir', join(dir, 'data'), '--actor', 'f11'], {
      env: { PATH: process.env['PATH'] ?? '', HOME: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    const msgs: { id?: unknown; error?: { code: number; message: string }; result?: unknown }[] = [];
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) msgs.push(JSON.parse(line) as (typeof msgs)[number]);
      }
    });
    let exited: number | null | undefined;
    p.on('exit', (code) => (exited = code));
    const waitFor = async (id: string) => {
      for (let t = 0; t < 600; t++) {
        const m = msgs.find((x) => x.id === id);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no reply to ${id}`);
    };
    try {
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'f11', method: 'tools/call', params: { name: 'sea_list', arguments: { query: 'a'.repeat(11 * 1024 * 1024) }, _meta: META } }) + '\n');
      const err = await waitFor('f11');
      expect(err.error?.code).toBe(-32600);
      expect(err.error?.message).toMatch(/exceeds the 10485760-byte stdio limit/);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'after', method: 'tools/list', params: { _meta: META } }) + '\n');
      const ok = await waitFor('after');
      expect(ok.result).toBeDefined();
      expect(exited).toBeUndefined();
    } finally {
      p.kill();
      await new Promise((r) => (exited !== undefined ? r(null) : p.once('exit', r)));
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 120_000);
});
