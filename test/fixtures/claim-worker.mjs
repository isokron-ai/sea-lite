// Spawned by test/concurrent.test.ts. Opens the shared store in its own
// process and either claims one ticket or drains the queue with sea_next.
// Prints one JSON line.
import { SeaLite } from '../../dist/index.js';

const [, , dataDir, actor, mode, ticketId] = process.argv;
const store = new SeaLite({ dataDir, actor });
const out = { actor, won: [], errors: [] };
try {
  if (mode === 'claim') {
    try {
      store.claim({ ticket_ids: [ticketId] });
      out.won.push(ticketId);
    } catch (e) {
      out.errors.push(e.code ?? String(e));
    }
  } else if (mode === 'drain') {
    for (;;) {
      const r = store.next({ include_unassigned: true, lease_seconds: 60 });
      if (!r.ticket) break;
      out.won.push(r.ticket.id);
    }
  }
} finally {
  store.close();
}
process.stdout.write(JSON.stringify(out) + '\n');
