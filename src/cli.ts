#!/usr/bin/env node
/**
 * sea-lite CLI
 *
 *   sea-lite serve   [--data-dir DIR] [--actor ID] [--role agent|operator] [--tracks work,design]
 *   sea-lite list    [--data-dir DIR] [--status S,S] [--all] [--query Q] [--json]
 *   sea-lite show ID [--data-dir DIR] [--json]
 *   sea-lite rebuild [--data-dir DIR]        drop + replay sea tables from the chain
 *   sea-lite verify  [--data-dir DIR]        chain verify + sea rows whose chain_seq is missing
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultDataDir } from 'kronicle-lite';

import { SeaError } from './core/errors.js';
import type { TicketCompact, Ticket } from './core/types.js';
import { ALL_STATES, type TicketStatus } from './model/enums.js';
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

const HELP = `sea-lite ${VERSION} — a work queue for parallel coding agents that can't collide

Usage:
  sea-lite serve   [--data-dir DIR] [--actor ID] [--role agent|operator] [--tracks work,design]
  sea-lite list    [--data-dir DIR] [--status S,S] [--all] [--query Q] [--json]
  sea-lite show ID [--data-dir DIR] [--json]
  sea-lite rebuild [--data-dir DIR]     drop the sea tables and replay them from the chain
  sea-lite verify  [--data-dir DIR]     recompute every chain hash; list sea rows pointing at missing events

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
      const server = createServer(store, { version: VERSION });
      const transport = new StdioServerTransport();
      process.stderr.write(
        `sea-lite ${VERSION} serving on stdio; data dir ${store.kronicle.dataDir}; actor ${store.actor}; role ${store.role}; tracks ${store.lifecycle.tracks.join(',')}\n`,
      );
      await server.connect(transport);
      await new Promise<void>((resolve) => {
        transport.onclose = () => resolve();
      });
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
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
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
