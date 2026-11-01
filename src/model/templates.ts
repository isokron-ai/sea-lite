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
  type ApplyInput,
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

type Problem = { code: string; message: string; at?: string };

function reject(problems: Problem[]): never {
  throw new SeaError('batch_invalid', `batch rejected: ${problems.length} problem(s); nothing was written`, { problems });
}

/** Expand `templates` (if any) into the plain batch the handler validates and writes. */
export function expandBatch(input: Pick<ApplyInput, 'tickets' | 'links' | 'templates'>): ExpandedBatch {
  const templates = input.templates ?? [];
  if (templates.length === 0) {
    if (input.tickets.length === 0) reject([{ code: 'empty_batch', message: 'a batch needs at least one ticket (in tickets or templates)' }]);
    return { tickets: input.tickets, links: input.links };
  }
  const problems: Problem[] = [];
  const tickets: BatchTicket[] = [...input.tickets];
  const links: BatchLink[] = [...input.links];
  templates.forEach((t, ti) => {
    if (t.ref.includes('{ref}') || t.ref.includes('{prev}')) {
      problems.push({ code: 'bad_template', message: `templates[${ti}].ref may use {i} and {value}, not {ref} or {prev}`, at: t.ref });
      return;
    }
    if (!t.ref.includes('{i}') && !t.ref.includes('{value}')) {
      problems.push({ code: 'bad_template', message: `templates[${ti}].ref "${t.ref}" must contain {i} or {value} so each item gets its own ref`, at: t.ref });
      return;
    }
    let prev: string | undefined;
    values(t).forEach((value, k) => {
      const base: Vars = { i: String(k + 1), value: String(value) };
      const ref = fill(t.ref, base);
      const v: Vars = { ...base, ref, ...(prev !== undefined ? { prev } : {}) };
      tickets.push({ ...fillAll(t.ticket, v), ref });
      for (const l of t.links) {
        if (prev === undefined && mentionsPrev(l)) continue;
        links.push(fillAll(l, v));
      }
      prev = ref;
    });
  });
  if (problems.length > 0) reject(problems);
  if (tickets.length === 0) reject([{ code: 'empty_batch', message: 'a batch needs at least one ticket (in tickets or templates)' }]);
  if (tickets.length > MAX_BATCH_TICKETS) {
    problems.push({ code: 'too_many_tickets', message: `templates expand to ${tickets.length} tickets; a batch holds at most ${MAX_BATCH_TICKETS}` });
  }
  if (links.length > MAX_BATCH_LINKS) {
    problems.push({ code: 'too_many_links', message: `templates expand to ${links.length} links; a batch holds at most ${MAX_BATCH_LINKS}` });
  }
  if (problems.length > 0) reject(problems);
  // Substituted strings must still satisfy the plain-batch field rules (title length, ref length, …).
  const parsed = z.object({ tickets: z.array(BatchTicket), links: z.array(BatchLink) }).safeParse({ tickets, links });
  if (!parsed.success) {
    reject(parsed.error.issues.map((i) => ({ code: 'invalid_expansion', message: `${i.path.join('.')}: ${i.message}`, at: i.path.join('.') })));
  }
  return parsed.data;
}
