/**
 * The CLI a human (or a git hook) uses without an LLM: create / claim / next /
 * release / board / heartbeat / whoami, the hook contract of `scope-check`
 * (absolute in-repo paths, --json, --session, exit 0/1/2), the git
 * pre-commit guard, and the README tour, run line by line from a fresh store.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SeaLite } from '../src/store.js';
import { keyPath } from './helpers.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

let base: string;
let data: string;
let repo: string;

function env(extra: Record<string, string> = {}): Record<string, string> {
  // A clean environment: no Claude Code session leaking in from whoever runs the tests.
  return { PATH: process.env['PATH'] ?? '', HOME: base, KRONICLE_LITE_DATA_DIR: data, ...extra };
}

function sl(args: string[], extra: Record<string, string> = {}, cwd = repo) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, env: env(extra) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function git(args: string[], cwd = repo) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', cwd });
  return { code: r.status, out: r.stdout + r.stderr };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sea-cli-')));
  data = join(base, 'data');
  repo = join(base, 'repo');
  mkdirSync(join(repo, 'src', 'auth'), { recursive: true });
  git(['init', '-q', repo], base);
});
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe('human CLI (G2)', () => {
  it('create → claim --paths → board → conflicting claim refused → release (no token juggling) → board', () => {
    const c = sl(['create', 'Add rate limiting to login', '--triaged', '--json']);
    expect(c.code).toBe(0);
    const id = (JSON.parse(c.out) as { ticket: { id: string } }).ticket.id;
    const c2 = sl(['create', 'Fix session expiry', '--triaged']);
    expect(c2.code).toBe(0);
    expect(c2.out).toMatch(/^created [0-9a-f]{8} {2}Fix session expiry/m);

    const claim = sl(['claim', id.slice(0, 8), '--paths', 'src/auth', '--actor', 'alice']);
    expect(claim.code).toBe(0);
    expect(claim.out).toMatch(/claimed [0-9a-f]{8} .*src\/auth/);

    const board = sl(['board']);
    expect(board.code).toBe(0);
    expect(board.out).toMatch(/Add rate limiting to login/);
    expect(board.out).toMatch(/alice/);
    expect(board.out).toMatch(/src\/auth/);
    expect(board.out).toMatch(/\d+m\d{2}s left|\d+s left/);

    const bob = sl(['next', '--paths', 'src/auth/session.ts', '--actor', 'bob']);
    expect(bob.code).toBe(1);
    expect(bob.out + bob.err).toMatch(/scope_conflict|conflict/);
    expect(bob.out + bob.err).toMatch(/alice/);

    // The claim token was kept for this identity (0600); release needs no token.
    const tokens = join(data, 'cli-claims.json');
    expect(existsSync(tokens)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(tokens).mode & 0o077).toBe(0);
    const rel = sl(['release', id.slice(0, 8), '--actor', 'alice', '--note', 'handing off']);
    expect(rel.code).toBe(0);
    expect(rel.out).toMatch(/released [0-9a-f]{8}/);
    expect(sl(['board', '--json']).out).not.toMatch(/"holder": "alice"/);
    // Someone else cannot release a claim it does not hold.
    sl(['claim', id.slice(0, 8), '--actor', 'alice']);
    expect(sl(['release', id.slice(0, 8), '--actor', 'bob']).code).toBe(2);
  });

  it('board --json and --all-projects; whoami shows the resolved identity', () => {
    sl(['create', 'here', '--triaged']);
    const other = join(base, 'other');
    mkdirSync(other);
    git(['init', '-q', other], base);
    sl(['create', 'there', '--triaged'], {}, other);
    const here = JSON.parse(sl(['board', '--json']).out) as { project: string; tickets: { title: string }[] };
    expect(here.project).toBe(keyPath(repo));
    expect(here.tickets.map((t) => t.title)).toEqual(['here']);
    const all = JSON.parse(sl(['board', '--json', '--all-projects']).out) as { tickets: { title: string }[] };
    expect(all.tickets.map((t) => t.title).sort()).toEqual(['here', 'there']);
    const who = JSON.parse(sl(['whoami', '--json'], { SEA_LITE_ACTOR: 'alice' }).out) as Record<string, unknown>;
    expect(who).toMatchObject({ actor: 'alice', session: null, project: keyPath(repo) });
  });
});

describe('scope-check hook contract (B2)', () => {
  function seed() {
    const id = (JSON.parse(sl(['create', 'held', '--triaged', '--json']).out) as { ticket: { id: string } }).ticket.id;
    expect(sl(['claim', id, '--paths', 'src/auth', '--actor', 'agent-a', '--session', 'sess-a']).code).toBe(0);
    return id;
  }

  it('accepts an absolute in-repo path, normalizes it, and reports the stable JSON contract', () => {
    const id = seed();
    const r = sl(['scope-check', '--json', '--actor', 'agent-b', '--session', 'sess-b', join(repo, 'src/auth/login.ts')]);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(j).toMatchObject({
      schema: 'sea-lite.scope-check/1',
      ok: false,
      paths: ['src/auth/login.ts'],
      project: keyPath(repo),
      identity: { actor: 'agent-b', session: 'sess-b' },
      conflicts: [{ ticket_id: id, title: 'held', holder: 'agent-a', holder_session: 'sess-a', holder_label: 'agent-a#sessa', held: ['src/auth'] }],
    });
    const c = (j['conflicts'] as Record<string, unknown>[])[0]!;
    expect(typeof c['claim_expires_at']).toBe('string');
    expect(typeof c['expires_in_seconds']).toBe('number');
    // Same identity: its own claim is not a conflict.
    expect(sl(['scope-check', '--json', '--actor', 'agent-a', '--session', 'sess-a', join(repo, 'src/auth/login.ts')]).code).toBe(0);
    // A hook knows only the session: every claim of that session is its own.
    expect(sl(['scope-check', '--session', 'sess-a', join(repo, 'src/auth/x.ts')]).code).toBe(0);
    expect(sl(['scope-check', '--session', 'sess-b', join(repo, 'src/auth/x.ts')]).code).toBe(1);
  });

  it('exit 2 (not 1) on bad input; a path outside the repo is invalid_input with reason outside_repo', () => {
    seed();
    const outside = sl(['scope-check', '--json', '--session', 'x', join(base, 'elsewhere.ts')]);
    expect(outside.code).toBe(2);
    expect(JSON.parse(outside.out)).toMatchObject({ ok: false, error: 'invalid_input', details: { reason: 'outside_repo' } });
    expect(sl(['scope-check', '--session', 'x']).code).toBe(2);
    expect(sl(['scope-check', '--session', 'x', '../up.ts']).code).toBe(2);
  });

  it('a file in an unrelated repository never conflicts with this repository’s claims', () => {
    seed();
    const other = join(base, 'other');
    mkdirSync(join(other, 'src', 'auth'), { recursive: true });
    git(['init', '-q', other], base);
    expect(sl(['scope-check', '--session', 'x', join(other, 'src/auth/login.ts')], {}, base).code).toBe(0);
  });
});

describe('hook modes: scope-check --hook (PreToolUse) and heartbeat --hook (PostToolUse)', () => {
  function hook(args: string[], payload: unknown, extra: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: repo, env: env(extra), input: JSON.stringify(payload) });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  it('blocks (exit 2, reason on stderr) another session’s edit, allows the holder’s, a file outside any repo, and a tool call without a file', () => {
    const id = (JSON.parse(sl(['create', 'held', '--triaged', '--json']).out) as { ticket: { id: string } }).ticket.id;
    sl(['claim', id, '--paths', 'src/auth', '--actor', 'claude', '--session', 'sess-a']);
    const edit = (sid: string, file: string) => ({ session_id: sid, cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } });
    const deny = hook(['scope-check', '--hook'], edit('sess-b', join(repo, 'src/auth/login.ts')));
    expect(deny.code).toBe(2);
    expect(deny.err).toMatch(/claude#sessa/);
    expect(deny.err).toMatch(/"held"/);
    expect(hook(['scope-check', '--hook'], edit('sess-a', join(repo, 'src/auth/login.ts'))).code).toBe(0);
    expect(hook(['scope-check', '--hook'], edit('sess-b', join(base, 'notes.txt'))).code).toBe(0);
    expect(hook(['scope-check', '--hook'], { session_id: 'sess-b', tool_name: 'Edit', tool_input: {} }).code).toBe(0);
    expect(hook(['scope-check', '--hook'], edit('sess-b', 'src/auth/relative.ts')).code).toBe(2);
  });

  it('heartbeat --hook renews the session’s claims, is rate-limited, and always exits 0', () => {
    const id = (JSON.parse(sl(['create', 'held', '--triaged', '--json']).out) as { ticket: { id: string } }).ticket.id;
    sl(['claim', id, '--paths', 'src/auth', '--lease', '120', '--actor', 'claude', '--session', 'sess-a']);
    const before = (JSON.parse(sl(['board', '--json']).out) as { tickets: { claim: { expires_at: string } }[] }).tickets[0]!.claim.expires_at;
    const post = { session_id: 'sess-a', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {} };
    spawnSync('sleep', ['1.1']);
    expect(hook(['heartbeat', '--hook'], post).code).toBe(0);
    const after = (JSON.parse(sl(['board', '--json']).out) as { tickets: { claim: { expires_at: string } }[] }).tickets[0]!.claim.expires_at;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    spawnSync('sleep', ['1.1']);
    expect(hook(['heartbeat', '--hook'], post).code).toBe(0); // within --min-interval: no write
    const again = (JSON.parse(sl(['board', '--json']).out) as { tickets: { claim: { expires_at: string } }[] }).tickets[0]!.claim.expires_at;
    expect(again).toBe(after);
    writeFileSync(join(base, 'a-file'), '');
    expect(hook(['heartbeat', '--hook'], 'not json', { KRONICLE_LITE_DATA_DIR: join(base, 'a-file', 'data') }).code).toBe(0);
  });
});

describe('git pre-commit guard (G1)', () => {
  it('refuses a commit that stages a file inside another live claim, allows unrelated files and own claims; --install wires it', () => {
    const id = (JSON.parse(sl(['create', 'held', '--triaged', '--json']).out) as { ticket: { id: string } }).ticket.id;
    sl(['claim', id, '--paths', 'src/auth', '--actor', 'agent-a', '--session', 'sess-a']);
    writeFileSync(join(repo, 'src/auth/login.ts'), 'x\n');
    writeFileSync(join(repo, 'README.md'), 'r\n');

    git(['add', 'README.md']);
    expect(sl(['precommit'], { SEA_LITE_ACTOR: 'human' }).code).toBe(0);
    git(['add', 'src/auth/login.ts']);
    const refused = sl(['precommit'], { SEA_LITE_ACTOR: 'human' });
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/src\/auth\/login\.ts/);
    expect(refused.err).toMatch(/agent-a#sessa/);
    // The holder itself may commit.
    expect(sl(['precommit', '--session', 'sess-a']).code).toBe(0);

    const inst = sl(['precommit', '--install']);
    expect(inst.code).toBe(0);
    const hookFile = join(repo, '.git', 'hooks', 'pre-commit');
    expect(readFileSync(hookFile, 'utf8')).toMatch(/sea-lite precommit/);
    if (process.platform !== 'win32') {
      // Point the installed hook at this build and prove git runs it.
      writeFileSync(hookFile, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" precommit\n`);
      chmodSync(hookFile, 0o755);
      const commit = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: repo, encoding: 'utf8', env: env({ SEA_LITE_ACTOR: 'human' }) });
      expect(commit.status).not.toBe(0);
      expect(commit.stderr).toMatch(/src\/auth\/login\.ts/);
    }
    // A second --install does not clobber a foreign hook.
    writeFileSync(hookFile, '#!/bin/sh\necho mine\n');
    expect(sl(['precommit', '--install']).code).toBe(2);
  });
});

describe('README tour (G8): every command works from a fresh install', () => {
  it('runs the tour block line by line with the documented exit codes', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const m = /<!-- tour:start -->\s*```sh\n([\s\S]*?)```\s*<!-- tour:end -->/.exec(readme);
    expect(m, 'README has a tour block').not.toBeNull();
    const lines = m![1]!.split('\n').filter((l) => l.trim().startsWith('sea-lite '));
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const line of lines) {
      const [cmd, comment = ''] = line.split(/\s+#\s*/);
      const expected = /exit (\d)/.exec(comment)?.[1] ?? '0';
      const args = (cmd!.trim().match(/"[^"]*"|\S+/g) ?? []).slice(1).map((a) => a.replace(/^"|"$/g, ''));
      const r = sl(args);
      expect({ line, code: r.code, out: r.out + r.err }).toMatchObject({ line, code: Number(expected) });
    }
  });
});

describe('board counts (SL-5, SL-7)', () => {
  it('`board --all` on a closed queue says 0 open, N closed, and the outcome by status', () => {
    const s = new SeaLite({ dataDir: data, actor: 'alice', project: 'p1' });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(s.create({ title: `finding ${i}`, body: '', kind: 'bug', priority: 'medium', tags: [], status: 'triaged', dry_run: false }).ticket.id);
    const outcomes = ['done', 'done', 'done', 'abandoned'] as const;
    ids.forEach((id, i) => {
      const token = s.claim({ ticket_ids: [id] }).claims[0]!.claim_token;
      s.finish({ ticket_id: id, claim_token: token, outcome: outcomes[i]!, note: 'n', dry_run: false });
    });
    s.close();

    const plain = sl(['board', '--project', 'p1']);
    expect(plain.code).toBe(0);
    expect(plain.out).toMatch(/; 0 open ticket\(s\);/);
    const all = sl(['board', '--project', 'p1', '--all']);
    expect(all.code).toBe(0);
    expect(all.out).toMatch(/; 0 open, 4 closed ticket\(s\);/);
    expect(all.out).not.toMatch(/4 open/);
    expect(all.out).toMatch(/^by status: dropped 1, resolved 3$/m);
    const j = JSON.parse(sl(['board', '--project', 'p1', '--all', '--json']).out) as { counts: { open: number; closed: number; by_status: Record<string, number> }; tickets: unknown[] };
    expect(j.counts).toEqual({ open: 0, closed: 4, by_status: { dropped: 1, resolved: 3 } });
    expect(j.tickets).toHaveLength(4);

    // a mixed queue: open counts only open tickets, with or without --all
    expect(sl(['create', 'still open', '--triaged', '--project', 'p1']).code).toBe(0);
    expect(sl(['board', '--project', 'p1']).out).toMatch(/; 1 open ticket\(s\);/);
    expect(sl(['board', '--project', 'p1', '--all']).out).toMatch(/; 1 open, 4 closed ticket\(s\);/);
  });
});
