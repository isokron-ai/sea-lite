import { SeaLite, type SeaLiteOptions } from '../src/store.js';

export class Clock {
  constructor(private ms = Date.parse('2026-10-31T12:00:00.000Z')) {}
  now = (): Date => new Date(this.ms);
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

export function fresh(opts: Partial<SeaLiteOptions> = {}): { store: SeaLite; clock: Clock } {
  const clock = new Clock();
  const store = new SeaLite({ memory: true, actor: 'alice', now: clock.now, ...opts });
  return { store, clock };
}

/** A claimed, triaged ticket ready for fenced writes. */
export function claimedTicket(store: SeaLite, actor = 'alice', title = 'Fix the thing') {
  const c = store.create({ title, body: 'body', kind: 'bug', priority: 'high', tags: ['t'], status: 'triaged', dry_run: false, actor_id: actor });
  const cl = store.claim({ ticket_ids: [c.ticket.id], actor_id: actor });
  return { id: c.ticket.id, token: cl.claims[0]!.claim_token, ticket: c.ticket };
}

export function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? 'no_code';
  }
  return 'no_error';
}

/**
 * The environment for a spawned CLI or server without the identity of
 * whoever runs the tests (a Claude Code session exports
 * CLAUDE_CODE_SESSION_ID / CLAUDE_PID / CLAUDE_PROJECT_DIR to its Bash tool).
 */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(CLAUDE_CODE_SESSION_ID|CLAUDE_PID|CLAUDE_PROJECT_DIR|SEA_LITE_.*)$/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}
