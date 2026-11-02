/**
 * Project keys (0.4.0). One store (`~/.kronicle-lite` by default) can serve
 * many repositories, so every ticket created from 0.4.0 on carries the key of
 * the project it was created in, and the queue, the board and the scope
 * check look only at the current project's tickets (plus legacy tickets that
 * have no key, which stay visible everywhere so an upgrade hides nothing).
 *
 * The key is derived without spawning git:
 *   1. the `origin` remote URL of the repository, normalized
 *      (`git@github.com:o/r.git`, `https://user@github.com/o/r` →
 *      `github.com/o/r`), so every clone and worktree of one repository, on
 *      any machine, is one project — paths in scopes are repo-relative, so
 *      that is the unit inside which two claims can collide;
 *   2. otherwise the absolute path of the main working tree (worktrees of the
 *      same repository resolve through `commondir` to the same path);
 *   3. otherwise (not a git repository) the absolute directory itself.
 *
 * Path keys (2 and 3) are always spelled with `/` separators, on Windows too
 * (`C:/Users/me/repo`, never `C:\Users\me\repo`): a key is compared as a
 * string, so one repository must have exactly one spelling.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface RepoInfo {
  /** Top of the working tree that contains the start directory (a worktree's own root for a linked worktree). */
  root: string;
  /** The repository's common git dir (`.git` of the main working tree for linked worktrees). */
  commonDir: string | null;
}

/**
 * realpath of `p`; a path that does not exist (yet) is the realpath of its
 * nearest existing ancestor plus the missing tail, so `<link>/new` and
 * `<real>/new` get one key, as they do in kronicle-lite 0.8.0's project keys
 * (0.6.0 kept the missing path as spelled).
 */
function real(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const up = dirname(abs);
    return up === abs ? abs : join(real(up), basename(abs));
  }
}

/**
 * The working-tree root containing `start` (a file or a directory, which may
 * not exist yet: the nearest existing ancestor is used), or null when no
 * `.git` is found above it.
 */
export function findRepo(start: string): RepoInfo | null {
  let dir = resolve(start);
  // Walk up to the nearest existing directory first (a Write may name a file that does not exist yet).
  for (;;) {
    try {
      if (statSync(dir).isDirectory()) break;
    } catch {
      // missing: keep climbing
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  dir = real(dir);
  for (;;) {
    const dotgit = join(dir, '.git');
    if (existsSync(dotgit)) {
      let gitDir: string | null = null;
      try {
        if (statSync(dotgit).isDirectory()) gitDir = dotgit;
        else {
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotgit, 'utf8'));
          if (m) gitDir = resolve(dir, m[1]!);
        }
      } catch {
        gitDir = null;
      }
      let commonDir = gitDir;
      if (gitDir !== null) {
        try {
          const cd = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
          if (cd) commonDir = resolve(gitDir, cd);
        } catch {
          // not a linked worktree
        }
      }
      return { root: dir, commonDir: commonDir !== null ? real(commonDir) : null };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** `origin` URL from a git config file's text, or null. */
export function originUrl(configText: string): string | null {
  let inOrigin = false;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[\s*remote\s+"origin"\s*\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.+)$/.exec(line);
    if (m) return m[1]!.replace(/^"|"$/g, '').trim();
  }
  return null;
}

/**
 * Normalize a remote URL to `host/path`: scheme, credentials, port and a
 * trailing `.git` / slash are dropped and the host is lower-cased.
 * `git@github.com:o/r.git`, `ssh://git@github.com/o/r`, `https://u:p@github.com/o/r/` → `github.com/o/r`.
 * A local-path remote (`/srv/git/r.git`, `file:///srv/git/r`) keeps its path.
 */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = /^([^@/:]+@)?([^/:]+):(?!\/)(.+)$/.exec(u);
  if (scp && !/^[A-Za-z]:[\\/]/.test(u)) {
    u = `${scp[2]!.toLowerCase()}/${scp[3]!}`;
  } else {
    const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/]*)(\/.*)?$/.exec(u);
    if (m) {
      const host = m[1]!.replace(/:\d+$/, '').toLowerCase();
      u = host === '' ? (m[2] ?? '') : `${host}${m[2] ?? ''}`;
    }
  }
  u = u.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return u;
}

/** The project key for a directory (or a file inside one). See the module comment. */
export function projectKeyFor(start: string): string {
  const repo = findRepo(start);
  if (repo === null) return real(isAbsolute(start) ? start : resolve(start)).replace(/\\/g, '/');
  if (repo.commonDir !== null) {
    try {
      const url = originUrl(readFileSync(join(repo.commonDir, 'config'), 'utf8'));
      if (url) return normalizeRemote(url);
    } catch {
      // no readable config: fall through to the path
    }
    // The main working tree owns `<root>/.git`; a bare-ish common dir names itself.
    const main = basename(repo.commonDir) === '.git' ? dirname(repo.commonDir) : repo.commonDir;
    return main.replace(/\\/g, '/');
  }
  return repo.root.replace(/\\/g, '/');
}

/** `*` (or `all`) means every project: the pre-0.4 behaviour. */
export const ALL_PROJECTS = '*';

/**
 * The project a process works in: an explicit value (flag or SEA_LITE_PROJECT;
 * `*` = every project), else the key of CLAUDE_PROJECT_DIR (set by Claude Code
 * for stdio MCP servers and hooks), else of the working directory.
 * Returns null for "every project".
 */
export function resolveProject(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  const v = explicit ?? env['SEA_LITE_PROJECT'];
  if (v !== undefined && v.trim() !== '') {
    const t = v.trim();
    return t === ALL_PROJECTS || t === 'all' ? null : t;
  }
  const dir = env['CLAUDE_PROJECT_DIR'] && env['CLAUDE_PROJECT_DIR'] !== '' ? env['CLAUDE_PROJECT_DIR'] : cwd;
  return projectKeyFor(dir);
}
