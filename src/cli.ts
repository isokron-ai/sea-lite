#!/usr/bin/env node
/**
 * sea-lite CLI
 *
 *   sea-lite serve   [--data-dir DIR] [--actor ID] [--role agent|operator] [--tracks work,design]
 *   sea-lite serve --http [--port N] [--host H] [--bearer T | --bearer-file F] [--actors-file F] [--allow-origin H,..] [--allow-host H,..]
 *   sea-lite add-token --actor ID [--role agent|operator] [--actors-file F]   mint a per-actor HTTP token (shown once)
 *   sea-lite list    [--data-dir DIR] [--status S,S] [--all] [--query Q] [--json]
 *   sea-lite show ID [--data-dir DIR] [--json]
 *   sea-lite rebuild [--data-dir DIR]        drop + replay sea tables from the chain
 *   sea-lite verify  [--data-dir DIR]        chain verify + sea rows whose chain_seq is missing
 *   sea-lite scope-check --paths a,b [--actor ID] [--json]   exit 1 if another actor's live scope overlaps
 *   sea-lite stats   [--since 24h|7d|ISO] [--for ACTOR] [--json]   per-actor claim accounting from the chain
 */

import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { defaultDataDir } from 'kronicle-lite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SeaError } from './core/errors.js';
import type { TicketCompact, Ticket } from './core/types.js';
import { ALL_STATES, type TicketStatus } from './model/enums.js';
import {
  ACTORS_FILE_NAME,
  addActorToken,
  DEFAULT_HTTP_PORT,
  loadOrCreateBearer,
  readActorsFile,
  readBearerFile,
  serveHttp,
  type ActorToken,
} from './http.js';
import type { ActorStats, StatsResult } from './handlers/stats.js';
import { createServer } from './server.js';
import { parseRole, parseTracks, SeaLite } from './store.js';

export { VERSION } from './version.js';
import { VERSION } from './version.js';

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const [cmd = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags };
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: string | true | undefined, flag: string): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new SeaError('invalid_input', `--${flag} must be a non-negative integer, got "${v}"`);
  return n;
}

/** Comma-separated flag values. */
function list(v: string | true | undefined): string[] {
  return typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter((x) => x.length > 0) : [];
}

function dataDirOf(flags: Args['flags']): string {
  return str(flags['data-dir']) ?? defaultDataDir();
}

const HELP = `sea-lite ${VERSION} — a work queue for parallel coding agents that can't collide

Usage:
  sea-lite serve   [--data-dir DIR] [--actor ID] [--role agent|operator] [--tracks work,design]
  sea-lite serve --http [--port N] [--host H] [--bearer T | --bearer-file F] [--actors-file F]
                   [--allow-origin H,..] [--allow-host H,..]
                                        Streamable HTTP (2026-07-28 only) on 127.0.0.1:${DEFAULT_HTTP_PORT}/mcp; shared
                                        bearer from DIR/http-bearer.token (created 0600) acts as --actor;
                                        per-actor tokens from DIR/http-actors.json (or --actors-file)
  sea-lite add-token --actor ID [--role agent|operator] [--actors-file F]
                                        mint a per-actor HTTP token, store its sha256 (file 0600), print it once
  sea-lite list    [--data-dir DIR] [--status S,S] [--all] [--query Q] [--json]
  sea-lite show ID [--data-dir DIR] [--json]
  sea-lite rebuild [--data-dir DIR]     drop the sea tables and replay them from the chain
  sea-lite verify  [--data-dir DIR]     recompute every chain hash; list sea rows pointing at missing events
  sea-lite scope-check [--paths a,b | PATH...] [--actor ID] [--json]
                                        exit 0 if no other actor's live claim scope overlaps, 1 if one does
                                        (for a PreToolUse edit hook; see hooks/README.md)
  sea-lite stats   [--since 24h|7d|ISO] [--for ACTOR] [--json]
                                        per actor: claims taken/released/expired/force-released, lease time,
                                        transitions — derived from the chain (read-only)

Data dir defaults to $KRONICLE_LITE_DATA_DIR or ~/.kronicle-lite (shared with kronicle-lite).
Env: SEA_LITE_ACTOR, SEA_LITE_ROLE, SEA_LITE_TRACKS.
`;

function openStore(flags: Args['flags']): SeaLite {
  const dataDir = str(flags['data-dir']) ?? defaultDataDir();
  const actor = str(flags['actor']);
  const role = str(flags['role']);
  const tracks = str(flags['tracks']);
  return new SeaLite({
    dataDir,
    ...(actor !== undefined ? { actor } : {}),
    ...(role !== undefined ? { role: parseRole(role) } : {}),
    ...(tracks !== undefined ? { tracks: parseTracks(tracks) } : {}),
  });
}

function fmtRow(t: Ticket | TicketCompact): string {
  const claim = t.claim ? ` [${t.claim.holder} until ${t.claim.expires_at.slice(11, 19)}Z]` : '';
  return `${t.id.slice(0, 8)}  ${t.status.padEnd(14)} ${t.priority.padEnd(7)} ${t.kind.padEnd(13)} ${t.title}${claim}`;
}

async function main(argv: string[]): Promise<number> {
  const { cmd, positional, flags } = parseArgs(argv);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === 'version') {
    process.stdout.write(VERSION + '\n');
    return 0;
  }

  switch (cmd) {
    case 'serve': {
      const store = openStore(flags);
      if (flags['http']) return serveHttpCmd(store, flags);
      process.stderr.write(
        `sea-lite ${VERSION} serving on stdio; data dir ${store.kronicle.dataDir}; actor ${store.actor}; role ${store.role}; tracks ${store.lifecycle.tracks.join(',')}\n`,
      );
      // serveStdio owns the era decision for the connection: a 2026-07-28
      // client (per-request _meta) and a 2025 client (initialize handshake)
      // are both served from the same factory. The store is shared; each
      // pinned instance is a fresh McpServer over it.
      const transport = new StdioServerTransport();
      const handle = serveStdio(() => createServer(store, { version: VERSION }), {
        transport,
        onerror: (err) => process.stderr.write(`sea-lite: ${err.message}\n`),
      });
      await new Promise<void>((resolve) => {
        process.stdin.once('end', () => resolve());
        process.stdin.once('close', () => resolve());
      });
      await handle.close();
      store.close();
      return 0;
    }
    case 'list': {
      const store = openStore(flags);
      const statusFlag = str(flags['status']);
      const status = statusFlag
        ? statusFlag.split(',').map((s) => {
            if (!(ALL_STATES as readonly string[]).includes(s)) throw new SeaError('invalid_input', `unknown status "${s}"`);
            return s as TicketStatus;
          })
        : undefined;
      const r = store.list({
        ...(status !== undefined ? { status } : {}),
        include_terminal: flags['all'] === true,
        claimed: 'any',
        limit: 200,
        view: 'compact',
        ...(str(flags['query']) !== undefined ? { query: str(flags['query'])! } : {}),
      });
      if (flags['json'] === true) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      else {
        for (const t of r.tickets) process.stdout.write(fmtRow(t) + '\n');
        process.stdout.write(`${r.count} ticket(s); head seq ${r.head.seq}\n`);
      }
      store.close();
      return 0;
    }
    case 'show': {
      const id = positional[0];
      if (!id) throw new SeaError('invalid_input', 'show requires a ticket id or prefix');
      const store = openStore(flags);
      const r = store.get({ id });
      if (flags['json'] === true) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      else {
        const t = r.ticket;
        process.stdout.write(`${t.id}\n${t.title}\n`);
        process.stdout.write(`status ${t.status}  priority ${t.priority}  kind ${t.kind}  v${t.row_version}  tags ${t.tags.join(',') || '-'}\n`);
        process.stdout.write(`assignee ${t.assignee ?? '-'}  claim ${t.claim ? `${t.claim.holder} until ${t.claim.expires_at}` : 'none'}\n`);
        process.stdout.write(`created ${t.created_at} by ${t.created_by}; updated ${t.updated_at}; seq ${t.created_seq}..${t.last_seq}\n`);
        if (t.body) process.stdout.write(`\n${t.body}\n`);
        if (r.links.length) {
          process.stdout.write(`\nlinks:\n`);
          for (const l of r.links) {
            process.stdout.write(`  ${l.direction === 'out' ? '→' : '←'} ${l.link_type} ${l.peer.id.slice(0, 8)} ${l.peer.title} (${l.peer.status})\n`);
          }
        }
        if (r.notes.length) {
          process.stdout.write(`\nnotes:\n`);
          for (const n of r.notes) process.stdout.write(`  [${n.created_at}] ${n.author}: ${n.body}\n`);
        }
        process.stdout.write(`\nlegal next: ${r.legal_next.join(', ') || '(terminal)'}\n`);
      }
      store.close();
      return 0;
    }
    case 'rebuild': {
      const store = openStore(flags);
      const r = store.rebuild();
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      store.close();
      return 0;
    }
    case 'verify': {
      const store = openStore(flags);
      const r = store.verify();
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      store.close();
      return r.ok ? 0 : 1;
    }
    case 'scope-check': {
      const fromFlag = str(flags['paths']);
      const paths = [...(fromFlag ? fromFlag.split(',') : []), ...positional].map((p) => p.trim()).filter((p) => p.length > 0);
      if (paths.length === 0) throw new SeaError('invalid_input', 'scope-check needs --paths a,b or positional paths');
      const store = openStore(flags);
      const r = store.scopeCheck({ paths });
      if (flags['json'] === true) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      else if (r.ok) process.stdout.write(`ok: ${r.paths.join(', ')} overlap no live scope of another actor (actor ${store.actor})\n`);
      else {
        for (const c of r.conflicts) {
          process.stdout.write(
            `conflict: "${c.holder}" holds ${c.held.join(', ')} on ticket ${c.ticket_id.slice(0, 8)} until ${c.claim_expires_at}` +
              ` (${c.overlapping.map((o) => `${o.requested} ↔ ${o.held}`).join('; ')})\n`,
          );
        }
      }
      store.close();
      return r.ok ? 0 : 1;
    }
    case 'stats': {
      const store = openStore(flags);
      const since = str(flags['since']);
      const forActor = str(flags['for']);
      const r = store.stats({ ...(since !== undefined ? { since } : {}), ...(forActor !== undefined ? { actor: forActor } : {}) });
      if (flags['json'] === true) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      else process.stdout.write(formatStats(r));
      store.close();
      return 0;
    }
    case 'add-token': {
      const actor = str(flags['actor']);
      if (actor === undefined) throw new SeaError('invalid_input', 'add-token needs --actor ID');
      const role = str(flags['role']);
      const file = str(flags['actors-file']) ?? join(dataDirOf(flags), ACTORS_FILE_NAME);
      const r = addActorToken(file, actor, role !== undefined ? parseRole(role) : undefined);
      process.stderr.write(`token for "${actor}" added to ${r.file}${r.created ? ' (created, mode 0600)' : ''}; only its sha256 is stored, so copy it now:\n`);
      process.stdout.write(r.token + '\n');
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
}

function formatStats(r: StatsResult): string {
  const cols = ['actor', 'taken', 'rotated', 'released', 'on_term', 'expired', 'forced', 'held', 'live', 'transitions', 'created'] as const;
  const row = (a: Omit<ActorStats, 'actor'> & { actor: string }): string[] => [
    a.actor,
    String(a.claims_taken),
    String(a.claims_rotated),
    String(a.released),
    String(a.released_on_transition),
    String(a.expired),
    String(a.force_released),
    fmtDuration(a.lease_seconds),
    String(a.live_claims),
    String(a.transitions),
    String(a.tickets_created),
  ];
  const rows = [[...cols], ...r.actors.map(row), row({ actor: 'total', ...r.totals })];
  const widths = cols.map((_, i) => Math.max(...rows.map((x) => x[i]!.length)));
  const lines = rows.map((x) => x.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  '));
  return (
    `window ${r.since ?? 'all time'} → ${r.until}; ${r.events_scanned} event(s); head seq ${r.head.seq}\n` +
    lines.join('\n') +
    '\n(scope_conflict refusals are not chained and are not counted)\n'
  );
}

async function serveHttpCmd(store: SeaLite, flags: Args['flags']): Promise<number> {
  const dataDir = store.kronicle.dataDir ?? dataDirOf(flags);
  let bearer: string;
  let bearerNote: string;
  if (str(flags['bearer']) !== undefined) {
    bearer = str(flags['bearer'])!;
    bearerNote = 'bearer from --bearer';
  } else if (str(flags['bearer-file']) !== undefined) {
    bearer = readBearerFile(str(flags['bearer-file'])!);
    bearerNote = `bearer from ${str(flags['bearer-file'])}`;
  } else {
    const b = loadOrCreateBearer(dataDir);
    bearer = b.token;
    bearerNote = `bearer from ${b.file}${b.created ? ' (created, mode 0600)' : ''}`;
  }
  const explicitActors = str(flags['actors-file']);
  const actorsFile = explicitActors ?? join(dataDir, ACTORS_FILE_NAME);
  let actors: ActorToken[] = [];
  if (explicitActors !== undefined || existsSync(actorsFile)) {
    actors = readActorsFile(actorsFile);
    bearerNote += `; ${actors.length} actor token(s) from ${actorsFile}`;
  }
  const allowedOrigins = list(flags['allow-origin']);
  const allowedHosts = list(flags['allow-host']);
  const port = num(flags['port'], 'port');
  const handle = await serveHttp({
    store,
    bearer,
    actors,
    version: VERSION,
    ...(str(flags['host']) !== undefined ? { host: str(flags['host'])! } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    onerror: (err) => process.stderr.write(`http: ${err.message}\n`),
  });
  process.stderr.write(
    `sea-lite ${VERSION} serving Streamable HTTP (2026-07-28) at ${handle.url}; ${bearerNote}; data dir ${dataDir}; ` +
      `default actor ${store.actor}; role ${store.role}\n`,
  );
  await new Promise<void>((resolve) => {
    const stop = () => {
      handle.close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  store.close();
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof SeaError) process.stderr.write(`${err.code}: ${err.message}\n`);
    else process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
