/**
 * B3 (0.4.0): unrelated repositories that share one store must not see each
 * other's queue. Tickets carry a project key; list / next / the scope check
 * look at the current project (plus legacy tickets without a key). An
 * explicit cross-project listing still works.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EVENT } from '../src/core/events.js';
import { findRepo, normalizeRemote, originUrl, projectKeyFor, resolveProject } from '../src/core/project.js';
import { SeaLite } from '../src/store.js';
import { Clock } from './helpers.js';

const NEW = { body: '', kind: 'bug' as const, priority: 'high' as const, tags: [], status: 'triaged' as const, dry_run: false };

describe('per-project queues (B3)', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  it('a ticket from repo A is not listed, dispatched or scope-checked in repo B', () => {
    dir = mkdtempSync(join(tmpdir(), 'sea-proj-'));
    const clock = new Clock();
    const A = new SeaLite({ dataDir: dir, actor: 'agent-a', session: 'a', project: 'github.com/o/repo-a', now: clock.now });
    const B = new SeaLite({ dataDir: dir, actor: 'agent-b', session: 'b', project: 'github.com/o/repo-b', now: clock.now });
    try {
      const ta = A.create({ title: 'Fix session expiry bug in auth', ...NEW });
      expect(ta.ticket.project).toBe('github.com/o/repo-a');
      A.claim({ ticket_ids: [ta.ticket.id], scope: { paths: ['src/auth'] } });
      A.create({ title: 'Another repo-A ticket', ...NEW });

      expect(B.list({ include_terminal: false, claimed: 'any', limit: 50, view: 'compact' }).count).toBe(0);
      expect(B.next({ include_unassigned: true }).ticket).toBeNull();
      expect(B.scopeCheck({ paths: ['src/auth/x.ts'] }).ok).toBe(true);
      // Repo B's own claim on the same relative path does not collide with repo A's.
      const tb = B.create({ title: 'B work', ...NEW });
      expect(B.claim({ ticket_ids: [tb.ticket.id], scope: { paths: ['src/auth'] } }).claims).toHaveLength(1);

      // Explicit cross-project listing.
      const all = B.list({ include_terminal: false, claimed: 'any', limit: 50, view: 'compact', project: '*' });
      expect(all.count).toBe(3);
      const onlyA = B.list({ include_terminal: false, claimed: 'any', limit: 50, view: 'compact', project: 'github.com/o/repo-a' });
      expect(onlyA.count).toBe(2);
      // Within repo A the scope still conflicts.
      const A2 = new SeaLite({ dataDir: dir, actor: 'agent-c', session: 'c', project: 'github.com/o/repo-a', now: clock.now });
      expect(A2.scopeCheck({ paths: ['src/auth/x.ts'] }).ok).toBe(false);
      A2.close();
    } finally {
      A.close();
      B.close();
    }
  });

  it('legacy tickets without a project stay visible everywhere; a project-less store sees everything (old behaviour)', () => {
    dir = mkdtempSync(join(tmpdir(), 'sea-proj-'));
    const clock = new Clock();
    const old = new SeaLite({ dataDir: dir, actor: 'old', now: clock.now });
    const A = new SeaLite({ dataDir: dir, actor: 'a', session: 'a', project: 'pa', now: clock.now });
    try {
      const legacy = old.create({ title: 'legacy', ...NEW });
      expect(legacy.ticket.project).toBeNull();
      const created = [...old.chain.iterate()].find((e) => e.event_type === EVENT.ticket_created)!;
      expect(Object.keys(created.payload)).not.toContain('project');
      A.create({ title: 'mine', ...NEW });
      expect(A.list({ include_terminal: false, claimed: 'any', limit: 50, view: 'compact' }).count).toBe(2);
      expect(old.list({ include_terminal: false, claimed: 'any', limit: 50, view: 'compact' }).count).toBe(2);
    } finally {
      old.close();
      A.close();
    }
  });

  it('rebuild restores the project from the chain', () => {
    dir = mkdtempSync(join(tmpdir(), 'sea-proj-'));
    const A = new SeaLite({ dataDir: dir, actor: 'a', project: 'pa' });
    try {
      const t = A.create({ title: 'x', ...NEW });
      A.rebuild();
      expect(A.get({ id: t.ticket.id }).ticket.project).toBe('pa');
    } finally {
      A.close();
    }
  });
});

describe('project keys', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('normalizes remotes', () => {
    expect(normalizeRemote('git@github.com:rafe-walker/sea-lite.git')).toBe('github.com/rafe-walker/sea-lite');
    expect(normalizeRemote('https://user:pw@GitHub.com:443/rafe-walker/sea-lite/')).toBe('github.com/rafe-walker/sea-lite');
    expect(normalizeRemote('ssh://git@github.com/rafe-walker/sea-lite.git')).toBe('github.com/rafe-walker/sea-lite');
    expect(normalizeRemote('/srv/git/r.git')).toBe('/srv/git/r');
    expect(originUrl('[core]\n\tbare = false\n[remote "upstream"]\n\turl = x\n[remote "origin"]\n\turl = git@h:o/r.git\n')).toBe('git@h:o/r.git');
  });

  it('origin remote wins; worktrees resolve to the main repo; no remote → main tree path; no git → the directory', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sea-key-')));
    const main = join(dir, 'main');
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    mkdirSync(join(main, 'src', 'deep'), { recursive: true });
    writeFileSync(join(main, '.git', 'config'), '[core]\n\tbare = false\n');
    const wt = join(dir, 'wt');
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');

    expect(findRepo(join(main, 'src', 'deep', 'new-file.ts'))?.root).toBe(main);
    expect(findRepo(join(wt, 'src'))?.root).toBe(wt);
    expect(projectKeyFor(join(main, 'src'))).toBe(main);
    expect(projectKeyFor(join(wt, 'src', 'missing.ts'))).toBe(main);

    writeFileSync(join(main, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:o/r.git\n');
    expect(projectKeyFor(wt)).toBe('github.com/o/r');
    expect(projectKeyFor(main)).toBe('github.com/o/r');

    const plain = join(dir, 'plain');
    mkdirSync(plain);
    expect(projectKeyFor(plain)).toBe(plain);

    expect(resolveProject(undefined, { CLAUDE_PROJECT_DIR: wt }, '/')).toBe('github.com/o/r');
    expect(resolveProject('*', {}, wt)).toBeNull();
    expect(resolveProject(undefined, { SEA_LITE_PROJECT: 'explicit' }, wt)).toBe('explicit');
  });
});
