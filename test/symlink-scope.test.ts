/**
 * Scope paths through symlinks (stress finding F07): a relative path through
 * a link (`hlink/claims.ts`, `flink`) names the files it points at, for
 * claims, scope checks, sea_next scopes and the pre-commit guard, so two live
 * claims can never cover the same files under two spellings. Links that
 * escape the repository are refused. Also F15: `scope-check -- PATH`.
 */

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalScopePath, normalizeScope } from '../src/core/scope.js';
import { SeaLite } from '../src/store.js';
import { codeOf } from './helpers.js';
import { parse } from './mcp-helpers.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

let base: string;
let repo: string;
let data: string;
/** Symlinks need privileges on some Windows setups; those tests are skipped there, not failed. */
let canLink = true;

function link(target: string, at: string, type: 'dir' | 'file' = 'dir'): void {
  symlinkSync(target, join(repo, at), process.platform === 'win32' ? (type === 'dir' ? 'junction' : 'file') : undefined);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sea-link-')));
  repo = join(base, 'repo');
  data = join(base, 'data');
  mkdirSync(join(repo, 'src', 'handlers'), { recursive: true });
  mkdirSync(join(base, 'outside'), { recursive: true });
  writeFileSync(join(repo, 'src', 'handlers', 'claims.ts'), 'x\n');
  spawnSync('git', ['init', '-q', repo]);
  try {
    // Relative targets, as `ln -s src/handlers hlink` makes them (a junction needs an absolute one).
    link(process.platform === 'win32' ? join(repo, 'src', 'handlers') : 'src/handlers', 'hlink');
    link(process.platform === 'win32' ? join(repo, 'src', 'handlers', 'claims.ts') : 'src/handlers/claims.ts', 'flink', 'file');
    link(process.platform === 'win32' ? repo : '.', 'rootlink');
    link(join(base, 'outside'), 'escape');
    link(process.platform === 'win32' ? join(repo, 'nowhere') : 'nowhere', 'dangling', 'file');
    canLink = true;
  } catch {
    canLink = false;
  }
});
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe('canonicalScopePath', () => {
  it('resolves the longest existing prefix through links and keeps the rest', (ctx) => {
    if (!canLink) ctx.skip();
    expect(canonicalScopePath(repo, 'hlink')).toBe('src/handlers');
    expect(canonicalScopePath(repo, 'hlink/claims.ts')).toBe('src/handlers/claims.ts');
    expect(canonicalScopePath(repo, 'flink')).toBe('src/handlers/claims.ts');
    expect(canonicalScopePath(repo, 'hlink/not-yet/new.ts')).toBe('src/handlers/not-yet/new.ts');
    expect(canonicalScopePath(repo, 'hlink/**/*.ts')).toBe('src/handlers/**/*.ts');
    expect(canonicalScopePath(repo, 'rootlink/src')).toBe('src');
    expect(canonicalScopePath(repo, 'rootlink')).toBe('.');
    expect(canonicalScopePath(repo, '.')).toBe('.');
    // Real paths and paths that do not exist are unchanged.
    expect(canonicalScopePath(repo, 'src/handlers/claims.ts')).toBe('src/handlers/claims.ts');
    expect(canonicalScopePath(repo, 'docs/new.md')).toBe('docs/new.md');
    // A dangling link points nowhere: kept as written.
    expect(canonicalScopePath(repo, 'dangling')).toBe('dangling');
  });

  it('a link escaping the repository is invalid_input (outside_repo)', (ctx) => {
    if (!canLink) ctx.skip();
    expect(codeOf(() => canonicalScopePath(repo, 'escape/secret.txt'))).toBe('invalid_input');
    expect(() => normalizeScope(['escape'], repo)).toThrow(expect.objectContaining({ code: 'invalid_input', details: expect.objectContaining({ reason: 'outside_repo' }) }));
  });

  it('normalizeScope dedupes a path and its link spelling; without a root it stays lexical', (ctx) => {
    if (!canLink) ctx.skip();
    expect(normalizeScope(['hlink/claims.ts', 'src/handlers/claims.ts', 'flink'], repo)).toEqual(['src/handlers/claims.ts']);
    expect(normalizeScope(['hlink'], null)).toEqual(['hlink']);
  });
});

describe('store with a repository root', () => {
  it('a claim through a link locks the real files; checks and claims through either spelling collide', (ctx) => {
    if (!canLink) ctx.skip();
    const s = new SeaLite({ memory: true, actor: 'a', session: 'sA', root: repo });
    const b = s.as('b', 'agent', { session: 'sB' });
    try {
      const t1 = s.create({ title: 'one', body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged', dry_run: false }).ticket.id;
      const t2 = s.create({ title: 'two', body: '', kind: 'chore', priority: 'medium', tags: [], status: 'triaged', dry_run: false }).ticket.id;
      const c = s.claim({ ticket_ids: [t1], scope: { paths: ['hlink'] } });
      expect(c.scope).toEqual({ paths: ['src/handlers'] });
      for (const p of ['src/handlers/claims.ts', 'flink', 'hlink/claims.ts', 'rootlink/src/handlers']) {
        const r = b.scopeCheck({ paths: [p] });
        expect(r.ok, p).toBe(false);
      }
      expect(b.scopeCheck({ paths: ['flink'] }).paths).toEqual(['src/handlers/claims.ts']);
      expect(codeOf(() => b.claim({ ticket_ids: [t2], scope: { paths: ['flink'] } }))).toBe('scope_conflict');
      expect(codeOf(() => b.next({ include_unassigned: true, scope: { paths: ['hlink/claims.ts'] } }))).toBe('scope_conflict');
      expect(codeOf(() => b.claim({ ticket_ids: [t2], scope: { paths: ['escape'] } }))).toBe('invalid_input');
    } finally {
      s.close();
    }
  });
});

describe('CLI (F07 repro, F15)', () => {
  const env = () => ({ PATH: process.env['PATH'] ?? '', HOME: base, KRONICLE_LITE_DATA_DIR: data });
  const sl = (args: string[], cwd = repo) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, env: env() });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it('relative paths through a link conflict exactly like the absolute and real ones; a claim through the link is refused', (ctx) => {
    if (!canLink) ctx.skip();
    const t = (JSON.parse(sl(['create', 'T1', '--triaged', '--json']).out) as { ticket: { id: string } }).ticket.id;
    expect(sl(['claim', t, '--paths', 'src/handlers', '--session', 'sA', '--actor', 'a']).code).toBe(0);
    for (const p of ['src/handlers/claims.ts', join(repo, 'flink'), join(repo, 'hlink', 'claims.ts'), 'flink', 'hlink/claims.ts', 'hlink']) {
      expect(sl(['scope-check', '--session', 'sB', '--actor', 'b', p]).code, p).toBe(1);
    }
    const j = JSON.parse(sl(['scope-check', '--session', 'sB', '--actor', 'b', '--json', 'hlink/claims.ts']).out) as { paths: string[] };
    expect(j.paths).toEqual(['src/handlers/claims.ts']);
    const t2 = (JSON.parse(sl(['create', 'T2', '--triaged', '--json']).out) as { ticket: { id: string } }).ticket.id;
    const c = sl(['claim', t2, '--paths', 'hlink', '--session', 'sC', '--actor', 'c']);
    expect(c.code).toBe(1);
    expect(c.err + c.out).toMatch(/scope_conflict|overlaps a live claim/);
    // A link out of the repository: refused, exit 2.
    expect(sl(['scope-check', '--session', 'sB', 'escape/x']).code).toBe(2);
  });

  it('the pre-commit guard sees a staged change through its real path', (ctx) => {
    if (!canLink) ctx.skip();
    const t = (JSON.parse(sl(['create', 'T1', '--triaged', '--json']).out) as { ticket: { id: string } }).ticket.id;
    expect(sl(['claim', t, '--paths', 'hlink', '--session', 'sA', '--actor', 'a']).code).toBe(0);
    writeFileSync(join(repo, 'hlink', 'claims.ts'), 'edited through the link\n');
    spawnSync('git', ['add', 'src/handlers/claims.ts'], { cwd: repo });
    const r = sl(['precommit', '--session', 'sB', '--actor', 'b']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/src\/handlers\/claims\.ts/);
  });

  it('F15: `scope-check -- PATH` checks the paths after `--` (and a path may start with -)', () => {
    const t = (JSON.parse(sl(['create', 'T1', '--triaged', '--json']).out) as { ticket: { id: string } }).ticket.id;
    expect(sl(['claim', t, '--paths', 'src', '--session', 'sA', '--actor', 'a']).code).toBe(0);
    const hit = sl(['scope-check', '--session', 'x', '--', 'src/a.ts']);
    expect(hit.code).toBe(1);
    expect(hit.out).toMatch(/src\/a\.ts ↔ src/);
    expect(sl(['scope-check', '--session', 'x', '--', '-weird.ts', 'docs/b.md']).code).toBe(0);
    expect(sl(['scope-check', '--session', 'x', '--json', '--', 'src/a.ts', 'docs/b.md']).out).toMatch(/"paths": \[\s*"docs\/b\.md",\s*"src\/a\.ts"/);
  });
});

describe('stdio serve resolves against its project directory', () => {
  it('sea_scope_check / sea_claim through a link over MCP', async (ctx) => {
    if (!canLink) ctx.skip();
    const start = async (actor: string) => {
      const c = new Client({ name: actor, version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await c.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [CLI, 'serve', '--data-dir', data, '--actor', actor, '--session', `s-${actor}`],
          cwd: repo,
          env: { PATH: process.env['PATH'] ?? '', HOME: base, CLAUDE_PROJECT_DIR: repo },
        }),
      );
      return c;
    };
    const [A, B] = await Promise.all([start('a'), start('b')]);
    try {
      const t1 = parse<{ ticket: { id: string } }>(await A.callTool({ name: 'sea_create', arguments: { title: 'one', status: 'triaged' } })).ticket.id;
      const c = parse<{ scope: { paths: string[] } }>(await A.callTool({ name: 'sea_claim', arguments: { ticket_ids: [t1], scope: { paths: ['hlink/'] } } }));
      expect(c.scope.paths).toEqual(['src/handlers']);
      const chk = parse<{ ok: boolean; paths: string[] }>(await B.callTool({ name: 'sea_scope_check', arguments: { paths: ['flink'] } }));
      expect(chk).toMatchObject({ ok: false, paths: ['src/handlers/claims.ts'] });
    } finally {
      await A.close();
      await B.close();
    }
  });
});
