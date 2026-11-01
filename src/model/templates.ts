/**
 * Template expansion for sea_apply: `templates: [{for_each, ref, ticket,
 * links}]` becomes plain tickets and links before anything is validated or
 * written. Pure and deterministic: the same input always expands to the same
 * plan, in order (explicit tickets, then each template's items; explicit
 * links, then each item's links).
 *
 * Placeholders, replaced in every string of the template's ticket and links
 * (and in `ref`, except {ref} itself):
 *   {i}     1-based index of the item
 *   {value} the for_each value (a count n iterates 1..n)
 *   {ref}   this item's expanded ref
 *   {prev}  the previous item's expanded ref; a link naming it is skipped for
 *           the first item (that is how a chain is written once)
 * Anything else in braces is left as written.
 */

import { z } from 'zod';

import { SeaError } from '../core/errors.js';
import {
  BatchLink,
  BatchTicket,
  MAX_BATCH_LINKS,
  MAX_BATCH_TICKETS,
  plainOrigins,
  type ApplyInput,
  type BatchOrigin,
  type BatchTemplate,
  type ExpandedBatch,
} from './schemas.js';

const PLACEHOLDER = /\{(i|value|ref|prev)\}/g;

interface Vars {
  i: string;
  value: string;
  ref?: string;
  prev?: string;
}

function fill(s: string, v: Vars): string {
  return s.replace(PLACEHOLDER, (m, name: keyof Vars) => v[name] ?? m);
}

function fillAll<T>(x: T, v: Vars): T {
  if (typeof x === 'string') return fill(x, v) as T;
  if (Array.isArray(x)) return x.map((e) => fillAll(e, v)) as T;
  if (x !== null && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, e]) => [k, fillAll(e, v)])) as T;
  return x;
}

const mentionsPrev = (l: Record<string, unknown>): boolean => Object.values(l).some((v) => typeof v === 'string' && v.includes('{prev}'));

function values(t: BatchTemplate): (string | number)[] {
  return typeof t.for_each === 'number' ? Array.from({ length: t.for_each }, (_, k) => k + 1) : t.for_each;
}

type Problem = { code: string; message: string; at?: string } & Partial<BatchOrigin>;

function reject(problems: Problem[]): never {
  throw new SeaError('batch_invalid', `batch rejected: ${problems.length} problem(s); nothing was written`, { problems });
}

/** Expand `templates` (if any) into the plain batch the handler validates and writes. */
export function expandBatch(input: Pick<ApplyInput, 'tickets' | 'links' | 'templates'>): ExpandedBatch {
  const templates = input.templates ?? [];
  if (templates.length === 0) {
    if (input.tickets.length === 0) reject([{ code: 'empty_batch', message: 'a batch needs at least one ticket (in tickets or templates)' }]);
    return { tickets: input.tickets, links: input.links, origins: plainOrigins(input) };
  }
  const problems: Problem[] = [];
  const tickets: BatchTicket[] = [...input.tickets];
  const links: BatchLink[] = [...input.links];
  const origins = plainOrigins(input);
  const perTemplate: { template: number; tickets: number; links: number }[] = [];
  templates.forEach((t, ti) => {
    const counted = { template: ti, tickets: 0, links: 0 };
    perTemplate.push(counted);
    if (t.ref.includes('{ref}') || t.ref.includes('{prev}')) {
      problems.push({ code: 'bad_template', message: `templates[${ti}].ref may use {i} and {value}, not {ref} or {prev}`, at: t.ref, where: `templates[${ti}].ref`, template: ti });
      return;
    }
    if (!t.ref.includes('{i}') && !t.ref.includes('{value}')) {
      problems.push({ code: 'bad_template', message: `templates[${ti}].ref "${t.ref}" must contain {i} or {value} so each item gets its own ref`, at: t.ref, where: `templates[${ti}].ref`, template: ti });
      return;
    }
    let prev: string | undefined;
    values(t).forEach((value, k) => {
      const base: Vars = { i: String(k + 1), value: String(value) };
      const ref = fill(t.ref, base);
      const v: Vars = { ...base, ref, ...(prev !== undefined ? { prev } : {}) };
      const item = `templates[${ti}] item ${k + 1} (${ref})`;
      tickets.push({ ...fillAll(t.ticket, v), ref });
      origins.tickets.push({ where: item, template: ti, item: k + 1, ref });
      counted.tickets++;
      t.links.forEach((l, li) => {
        if (prev === undefined && mentionsPrev(l)) return;
        links.push(fillAll(l, v));
        origins.links.push({ where: `${item} links[${li}]`, template: ti, item: k + 1, ref, link: li });
        counted.links++;
      });
      prev = ref;
    });
  });
  if (problems.length > 0) reject(problems);
  if (tickets.length === 0) reject([{ code: 'empty_batch', message: 'a batch needs at least one ticket (in tickets or templates)' }]);
  const counts = (what: 'tickets' | 'links') =>
    [`${what} ${what === 'tickets' ? input.tickets.length : input.links.length}`, ...perTemplate.map((c) => `templates[${c.template}] ${c[what]}`)].join(', ');
  if (tickets.length > MAX_BATCH_TICKETS) {
    problems.push({ code: 'too_many_tickets', message: `the batch expands to ${tickets.length} tickets (${counts('tickets')}); at most ${MAX_BATCH_TICKETS}` });
  }
  if (links.length > MAX_BATCH_LINKS) {
    problems.push({ code: 'too_many_links', message: `the batch expands to ${links.length} links (${counts('links')}); at most ${MAX_BATCH_LINKS}` });
  }
  if (problems.length > 0) reject(problems);
  // Substituted strings must still satisfy the plain-batch field rules (title length, ref length, …).
  const parsed = z.object({ tickets: z.array(BatchTicket), links: z.array(BatchLink) }).safeParse({ tickets, links });
  if (!parsed.success) {
    reject(
      parsed.error.issues.map((i) => {
        const [list, idx, ...field] = i.path as (string | number)[];
        const o = (list === 'tickets' ? origins.tickets : origins.links)[idx as number];
        const where = `${o?.where ?? `${String(list)}[${String(idx)}]`}${field.length > 0 ? ` ${field.join('.')}` : ''}`;
        return { code: 'invalid_expansion', message: `${where}: ${i.message}`, at: i.path.join('.'), ...o, where };
      }),
    );
  }
  return { ...parsed.data, origins };
}
