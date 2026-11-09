/**
 * CLI argument parsing, strict (0.7.0; ported from mcp-catalog-snap 0.2.0's
 * cli-flags). An option a command does not take is an error, not a no-op:
 * `sea-lite next --pathz src/auth` used to claim a ticket with NO path lock
 * and exit 0, silently dropping the collision guard the product exists for.
 *
 * Also refused: a value option with no value (`next --paths --json`), a
 * repeated single-value option, a boolean option given a non-boolean value
 * (`--json=yes`), more positionals than the command takes (`next src/auth`,
 * the `--paths` forgotten), and a single-dash token (`-p`) where an option
 * was meant. `--` still ends the options.
 */

import { SeaError } from './core/errors.js';

export interface Args {
  cmd: string;
  /** The audit / lease subcommand, when the command has one. */
  sub?: string;
  positional: string[];
  flags: Record<string, string | true>;
}

/** Flags that never take a value, so `--triaged "title"` does not swallow the title. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'json',
  'all',
  'all-projects',
  'triaged',
  'hook',
  'http',
  'force',
  'install',
  'help',
  'mine',
  'core',
  'trusted',
  'allow-insecure-token-file',
]);

/** Every command takes these (the help's "Common flags"). */
const COMMON = ['data-dir', 'actor', 'session', 'project', 'help'];
/** Commands that open the store also take the self-asserted role and tracks. */
const STORE = [...COMMON, 'role', 'tracks'];
const CLAIM = [...STORE, 'all-projects', 'paths', 'lease', 'wait', 'worktree', 'json'];

/** Which options each command (or `audit` / `lease` subcommand) takes. */
export const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  create: [...STORE, 'all-projects', 'triaged', 'status', 'body', 'kind', 'priority', 'assignee', 'tags', 'json'],
  claim: CLAIM,
  next: [...CLAIM, 'kind', 'tag'],
  release: [...STORE, 'all-projects', 'all', 'mine', 'force', 'note', 'reason', 'json'],
  board: [...STORE, 'all-projects', 'all', 'json'],
  heartbeat: [...STORE, 'json', 'hook', 'min-interval'],
  whoami: [...COMMON, 'all-projects', 'json'],
  list: [...STORE, 'all-projects', 'status', 'all', 'query', 'json'],
  show: [...STORE, 'json'],
  rebuild: [...STORE, 'json'],
  verify: [...STORE, 'json'],
  'scope-check': [...STORE, 'all-projects', 'paths', 'json', 'hook'],
  precommit: [...STORE, 'install'],
  'release-worktree': [...STORE, 'hook', 'reason', 'json'],
  doctor: [...COMMON, 'cwd', 'actors-file', 'json'],
  stats: [...STORE, 'since', 'for', 'json'],
  'add-token': [...COMMON, 'role', 'actors-file'],
  serve: [
    ...STORE,
    'core',
    'profile',
    'http',
    'port',
    'host',
    'bearer',
    'bearer-file',
    'actors-file',
    'allow-origin',
    'allow-host',
    'legacy',
    'allow-insecure-token-file',
  ],
  'audit open': [...STORE, 'title', 'gates', 'json'],
  'audit queue': [...STORE, 'json'],
  'audit review': [...STORE, 'plan', 'note', 'json'],
  'audit export': [...STORE, 'format', 'out'],
  'audit import': [...STORE, 'trusted', 'json'],
  'lease show': [...STORE, 'json'],
  'lease release': [...STORE, 'force', 'json'],
};

/** Most positional arguments each command takes (after the subcommand, if any); Infinity = a list. */
const MAX_POSITIONALS: Readonly<Record<string, number>> = {
  create: Infinity, // the title, words joined
  claim: Infinity,
  release: Infinity,
  'scope-check': Infinity,
  show: 1,
  'release-worktree': 1,
  'audit open': 1,
  'audit queue': 1,
  'audit review': 3,
  'audit export': 1,
  'audit import': 2,
  'lease show': 1,
  'lease release': 1,
};

export const COMMANDS: readonly string[] = [...new Set(Object.keys(COMMAND_OPTIONS).map((k) => k.split(' ')[0]!)), 'help', 'version'];
const SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  audit: Object.keys(COMMAND_OPTIONS).filter((k) => k.startsWith('audit ')).map((k) => k.slice(6)),
  lease: Object.keys(COMMAND_OPTIONS).filter((k) => k.startsWith('lease ')).map((k) => k.slice(6)),
};

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** The known name within edit distance 2 (case-insensitive), else null. */
export function closest(name: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const k of known) {
    const d = distance(name.toLowerCase(), k);
    if (d < bestD) [best, bestD] = [k, d];
  }
  return best;
}

function bad(message: string, details: Record<string, unknown> = {}): SeaError {
  return new SeaError('invalid_input', message, details);
}

/** Tokenize argv. Pure: no knowledge of which command takes what (see validateArgs). */
export function parseArgs(argv: string[]): Args & { repeated: string[]; valueless: string[] } {
  const [cmd = 'help', ...rest] = argv;
  const positional: string[] = [];
  // null prototype: option names are user input (`--__proto__` must stay a key, and be reported as unknown)
  const flags = Object.create(null) as Record<string, string | true>;
  const repeated: string[] = [];
  const valueless: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    // `--` ends the options: everything after it is a positional (a path may start with `-`).
    if (a === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      let key = a.slice(2);
      let value: string | true = true;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (!BOOLEAN_FLAGS.has(key)) {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i++;
        } else valueless.push(key);
      }
      if (Object.hasOwn(flags, key) && !repeated.includes(key)) repeated.push(key);
      flags[key] = value;
    } else if (a === '-h') {
      flags['help'] = true;
    } else if (/^-[A-Za-z]/.test(a)) {
      throw bad(`unknown option ${a} for ${cmd}: sea-lite options start with -- (put \`--\` before a value that starts with -); see sea-lite help`, { option: a });
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags, repeated, valueless };
}

/**
 * Parse and check argv against what the command takes. Throws invalid_input
 * naming the closest known option ("did you mean --paths?"). Unknown
 * commands and help/version are left to the caller.
 */
export function strictArgs(argv: string[]): Args {
  const p = parseArgs(argv);
  const { cmd } = p;
  let key = cmd;
  let positional = p.positional;
  let sub: string | undefined;
  const subs = SUBCOMMANDS[cmd];
  if (subs !== undefined) {
    sub = positional[0];
    if (sub === undefined || !subs.includes(sub)) {
      const hint = sub !== undefined ? closest(sub, subs) : null;
      throw bad(`${sub === undefined ? `${cmd} needs a subcommand` : `unknown ${cmd} subcommand "${sub}"`}${hint ? ` (did you mean ${cmd} ${hint}?)` : ''}: ${subs.join(' | ')}`, {
        subcommand: sub ?? null,
      });
    }
    key = `${cmd} ${sub}`;
    positional = positional.slice(1);
  }
  const allowed = Object.hasOwn(COMMAND_OPTIONS, key) ? COMMAND_OPTIONS[key]! : null;
  if (allowed === null) return { cmd, positional, flags: p.flags };
  for (const name of Object.keys(p.flags)) {
    if (allowed.includes(name)) continue;
    const hint = closest(name, allowed);
    throw bad(`unknown option --${name} for ${key}${hint ? ` (did you mean --${hint}?)` : ''}; see sea-lite help`, { option: name, command: key, ...(hint ? { did_you_mean: hint } : {}) });
  }
  for (const name of p.repeated) throw bad(`--${name} given more than once`, { option: name });
  for (const name of p.valueless) throw bad(`--${name} needs a value`, { option: name });
  for (const name of Object.keys(p.flags)) {
    const v = p.flags[name]!;
    if (BOOLEAN_FLAGS.has(name)) {
      if (v === true) continue;
      if (v === 'true' || v === '1') p.flags[name] = true;
      else if (v === 'false' || v === '0') delete p.flags[name];
      else throw bad(`--${name} expects true or false (or no value), got ${JSON.stringify(v)}`, { option: name });
    } else if (v === '') throw bad(`--${name} needs a value`, { option: name });
  }
  const max = MAX_POSITIONALS[key] ?? 0;
  if (positional.length > max) {
    const extra = positional[max]!;
    const looksLikePath = cmd === 'next' && /[/\\.]/.test(extra);
    throw bad(`unexpected argument ${JSON.stringify(extra)} for ${key}${looksLikePath ? ' (paths to lock go in --paths a,b)' : ''}; see sea-lite help`, { argument: extra });
  }
  return { cmd, ...(sub !== undefined ? { sub } : {}), positional, flags: p.flags };
}

/** An unknown command, with the closest known one. */
export function unknownCommand(cmd: string): string {
  const hint = closest(cmd, COMMANDS);
  return `unknown command: ${cmd}${hint ? ` (did you mean ${hint}?)` : ''}`;
}

/** Plain decimal, non-negative, safe integer ("", "0x10", "1e3", "1.5", "-1" are refused). */
export function strictInt(v: string | true | undefined, flag: string): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n)) throw bad(`--${flag} must be a non-negative integer, got ${JSON.stringify(v)}`, { option: flag });
  return n;
}

/** A zod error as one readable line: `field: message; field: message` instead of the raw issue array. */
export function formatZodError(err: { issues?: { path?: PropertyKey[]; message?: string }[] }): string {
  const issues = err.issues ?? [];
  if (issues.length === 0) return 'invalid input';
  return issues
    .slice(0, 5)
    .map((i) => {
      const path = (i.path ?? []).map(String).join('.');
      return `${path === '' ? '' : `${path}: `}${i.message ?? 'invalid'}`;
    })
    .join('; ')
    .concat(issues.length > 5 ? `; (+${issues.length - 5} more)` : '');
}
