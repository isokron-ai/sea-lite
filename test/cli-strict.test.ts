/**
 * Strict CLI input (0.7.0, SL-1). Before the fix, `sea-lite next --pathz
 * src/auth` (a typo) claimed a ticket with NO path lock and exited 0: an
 * unknown option was ignored, silently dropping the collision guard. Also
 * fixed here: `next --paths --json` and `next src/auth` (no lock either),
 * `next --help` (claimed a ticket), repeated options (last one won),
 * `--json=yes` (meant false), `--lease 0x10` (meant 16), and raw zod issue
 * arrays as error messages (SL-6).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COMMAND_OPTIONS, closest, formatZodError, parseArgs, strictArgs } from '../src/cli-args.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

let base: string;
let data: string;
let repo: string;

function sl(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: repo,
    env: { PATH: process.env['PATH'] ?? '', HOME: base, KRONICLE_LITE_DATA_DIR: data },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function claimed(): { id: string; claim: unknown }[] {
  const r = sl(['list', '--json']);
  expect(r.code).toBe(0);
  return (JSON.parse(r.out) as { tickets: { id: string; claim: unknown }[] }).tickets;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sea-strict-')));
  data = join(base, 'data');
  repo = join(base, 'repo');
  mkdirSync(join(repo, 'src', 'auth'), { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
});
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe('SL-1: a misspelt option never silently drops the path lock', () => {
  it('next --pathz src/auth is refused (exit 2, did you mean --paths?) and claims nothing', () => {
    expect(sl(['create', 'a ticket', '--triaged']).code).toBe(0);
    const r = sl(['next', '--pathz', 'src/auth', '--actor', 'alice']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown option --pathz for next \(did you mean --paths\?\)/);
    expect(r.out).toBe('');
    expect(claimed().every((t) => t.claim === null)).toBe(true);
    // the correct spelling locks
    const ok = sl(['next', '--paths', 'src/auth', '--actor', 'alice']);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/locks src\/auth/);
  });

  it('the other ways a lock went missing are refused too, and claim nothing', () => {
    expect(sl(['create', 'a ticket', '--triaged']).code).toBe(0);
    const cases: [string[], RegExp][] = [
      [['next', '--paths'], /--paths needs a value/],
      [['next', '--paths', '--json'], /--paths needs a value/],
      [['next', '--paths='], /--paths needs a value/],
      [['next', 'src/auth'], /unexpected argument "src\/auth" for next \(paths to lock go in --paths a,b\)/],
      [['next', '-p', 'src/auth'], /unknown option -p for next: sea-lite options start with --/],
      [['next', '--paths', 'src/a', '--paths', 'src/b'], /--paths given more than once/],
      [['next', '--json=yes'], /--json expects true or false/],
      [['next', '--lease', '0x10'], /--lease must be a non-negative integer, got "0x10"/],
      [['next', '--wait', '1e3'], /--wait must be a non-negative integer/],
      [['next', '--PATHS', 'src/auth'], /unknown option --PATHS for next \(did you mean --paths\?\)/],
      [['claim', 'deadbeef', '--path', 'src/auth'], /unknown option --path for claim \(did you mean --paths\?\)/],
      [['scope-check', '--pahts', 'src/auth'], /unknown option --pahts for scope-check \(did you mean --paths\?\)/],
    ];
    for (const [args, msg] of cases) {
      const r = sl(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toMatch(msg);
    }
    expect(claimed().every((t) => t.claim === null)).toBe(true);
  });

  it('`next --help` prints the help and claims nothing', () => {
    expect(sl(['create', 'a ticket', '--triaged']).code).toBe(0);
    for (const h of ['--help', '-h']) {
      const r = sl(['next', h]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^sea-lite \S+ — /);
    }
    expect(claimed().every((t) => t.claim === null)).toBe(true);
  });

  it('every command refuses an option it does not take', () => {
    for (const key of Object.keys(COMMAND_OPTIONS)) {
      const argv = [...key.split(' '), ...(key.includes(' ') ? ['A1'] : []), '--bogus-option', 'x'];
      expect(() => strictArgs(argv), key).toThrow(new RegExp(`unknown option --bogus-option for ${key}`));
    }
    // and a few real typos, end to end
    expect(sl(['release', '--al']).err).toMatch(/unknown option --al for release \(did you mean --all\?\)/);
    expect(sl(['board', '--all-project']).err).toMatch(/did you mean --all-projects\?/);
    expect(sl(['audit', 'import', 'A1', 'f.csv', '--trustd']).err).toMatch(/unknown option --trustd for audit import \(did you mean --trusted\?\)/);
    expect(sl(['serve', '--htttp']).err).toMatch(/unknown option --htttp for serve \(did you mean --http\?\)/);
  });

  it('unknown commands and subcommands name the closest one', () => {
    const r = sl(['nxt']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command: nxt \(did you mean next\?\)/);
    const a = sl(['audit', 'reveiw', 'A1', 'F1', 'approved']);
    expect(a.code).toBe(2);
    expect(a.err).toMatch(/unknown audit subcommand "reveiw" \(did you mean audit review\?\)/);
  });

  it('`--trusted` is a flag: it no longer swallows the file name after it', () => {
    const p = strictArgs(['audit', 'import', 'A1', '--trusted', 'f.csv']);
    expect(p.flags['trusted']).toBe(true);
    expect(p.positional).toEqual(['A1', 'f.csv']);
  });

  it('boolean options take true/false/1/0 after =', () => {
    expect(strictArgs(['board', '--json=1']).flags['json']).toBe(true);
    expect(strictArgs(['board', '--json=false']).flags['json']).toBeUndefined();
  });

  it('`--` still ends the options (a path may start with -)', () => {
    expect(strictArgs(['scope-check', '--', '-weird/file']).positional).toEqual(['-weird/file']);
    expect(parseArgs(['create', 'title', '--', '--not-a-flag']).positional).toEqual(['title', '--not-a-flag']);
  });

  it('accepts every option the README, the help text and the hooks pass', () => {
    const lines = [
      'create TITLE --triaged --body B --kind bug --priority high --tags a,b --assignee x --status idea --json',
      'next --paths src/auth --actor alice',
      'next --paths a,b --lease 60 --wait 5 --kind bug,docs --tag t --worktree w --json',
      'claim 1234abcd 5678abcd --paths a,b --lease 60 --wait 5 --json',
      'release --all --actor alice',
      'release 1234abcd --note N --reason R --force --role operator --json',
      'board --all-projects --all --json',
      'heartbeat --json --hook --min-interval 30',
      'whoami --json --session S --data-dir D --project P',
      'list --status triaged,idea --all --all-projects --query q --json',
      'show 1234abcd --json',
      'stats --since 24h --for alice --json',
      'verify --json',
      'rebuild',
      'doctor --json --cwd D --actors-file F',
      'scope-check --paths a,b --json',
      'scope-check src/auth/login.ts --actor bob',
      'scope-check --hook',
      'precommit --install',
      'release-worktree --hook',
      'release-worktree /tmp/wt --reason R --json',
      'serve --core --actor claude',
      'serve --actor ID --session S --project * --role agent --tracks work,design --profile full',
      'serve --http --port 7418 --host 127.0.0.1 --bearer T --actors-file F --allow-origin a,b --allow-host h --project K --legacy stateless --allow-insecure-token-file',
      'serve --http --bearer-file F',
      'add-token --actor alice --role operator --actors-file F',
      'audit queue A1 --json',
      'audit review A1 F1 approved --plan P --note N --role operator',
      'audit export A1 --format xlsx --out f.xlsx',
      'audit import A1 f.csv --trusted --role operator',
      'lease show sandbox:x --json',
      'lease release sandbox:x --force --role operator',
    ];
    for (const l of lines) expect(() => strictArgs(l.split(' ')), l).not.toThrow();
  });

  it('did-you-mean only suggests a close name', () => {
    expect(closest('pathz', ['paths', 'lease'])).toBe('paths');
    expect(closest('zzzzzz', ['paths', 'lease'])).toBeNull();
  });
});

describe('SL-6: zod errors read as one line, not a raw issue array', () => {
  it('next --lease 0 and claim 55c3', () => {
    const lease = sl(['next', '--lease', '0']);
    expect(lease.code).toBe(2);
    expect(lease.err).toMatch(/^invalid_input: lease_seconds: /);
    expect(lease.err).not.toMatch(/"code"|^\s*\[/m);
    const claim = sl(['claim', '55c3']);
    expect(claim.code).toBe(2);
    expect(claim.err).toMatch(/^invalid_input: ticket_ids\.0: /);
    expect(claim.err).not.toMatch(/"code"/);
  });

  it('formatZodError caps the list', () => {
    const issues = Array.from({ length: 7 }, (_, i) => ({ path: ['f', i], message: 'bad' }));
    expect(formatZodError({ issues })).toBe('f.0: bad; f.1: bad; f.2: bad; f.3: bad; f.4: bad; (+2 more)');
  });
});
