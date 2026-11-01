/**
 * What tools/list publishes, versus what the server enforces.
 *
 * Every tool is validated by its full zod schema (input on the way in, output
 * before a result leaves). What a client is *shown* is a lean JSON Schema
 * derived from the same zod schema, because tools/list is paid for in every
 * session's context:
 *
 * - input: the zod JSON Schema minus `$schema` and string length/pattern
 *   constraints (the server still enforces them and names the field when one
 *   fails). Types, enums, defaults, required lists, array/number bounds and
 *   every description stay.
 * - output: the top level in full (field names, types, required); a nested
 *   object is published as `{type: object}` whose description lists its
 *   fields (`{id,title,claim?,…}`), enums as their base type. A root union
 *   (two result shapes) is merged into one object.
 *
 * The strict zod schemas stay the contract: tests validate every result
 * against them.
 */

import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { z } from 'zod';

type Json = Record<string, unknown>;

const STRING_NOISE = ['minLength', 'maxLength', 'pattern', 'format'] as const;

/**
 * zod `.meta({ [LEAN_AS]: 'description' })` on a schema that repeats a shape
 * published elsewhere in the same tool: it is published as just its type and
 * that description ("Same fields as …"). Validation is unchanged.
 */
export const LEAN_AS = 'x-sea-lean';

function leanInputNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(leanInputNode);
  if (node === null || typeof node !== 'object') return node;
  const n = node as Json;
  if (typeof n[LEAN_AS] === 'string') {
    const out: Json = { type: n['type'] ?? 'object' };
    if (n['default'] !== undefined) out['default'] = n['default'];
    return withDescription(out, n['description'] as string | undefined, n[LEAN_AS] as string);
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === '$schema') continue;
    if ((STRING_NOISE as readonly string[]).includes(k)) continue;
    // z.number().int() bounds: the safe-integer range says nothing.
    if ((k === 'maximum' || k === 'minimum') && typeof v === 'number' && Math.abs(v) === Number.MAX_SAFE_INTEGER) continue;
    if (k === 'properties' && v !== null && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, leanInputNode(pv)]));
      continue;
    }
    out[k] = leanInputNode(v);
  }
  return out;
}

export function leanInputSchema(json: Json): Json {
  return leanInputNode(json) as Json;
}

function typesOf(node: Json): string[] {
  const t = node['type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.map(String);
  if (Array.isArray(node['enum'])) return [...new Set((node['enum'] as unknown[]).map((v) => (v === null ? 'null' : typeof v)))];
  return [];
}

/** `{a,b?,c}` — an object's field names, `?` for the optional ones. */
function fieldList(node: Json): string {
  const props = Object.keys((node['properties'] as Json | undefined) ?? {});
  const req = new Set((node['required'] as string[] | undefined) ?? []);
  return `{${props.map((p) => (req.has(p) ? p : `${p}?`)).join(',')}}`;
}

function withDescription(base: Json, ...parts: (string | undefined)[]): Json {
  const d = parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
  return d.length > 0 ? { ...base, description: d } : base;
}

/** A nested (non-root) output node, briefly. */
function brief(node: Json): Json {
  const desc = typeof node['description'] === 'string' ? (node['description'] as string) : undefined;
  const variants = (node['anyOf'] ?? node['oneOf']) as Json[] | undefined;
  if (Array.isArray(variants)) {
    const nonNull = variants.filter((v) => !(v['type'] === 'null'));
    const nullable = nonNull.length < variants.length;
    if (nonNull.length === 1) {
      const { description: inner, ...b } = brief(nonNull[0]!);
      const t = typesOf(b);
      return withDescription({ ...b, type: nullable ? [...t, 'null'] : t.length === 1 ? t[0] : t }, desc, inner as string | undefined);
    }
    const bs = nonNull.map(brief);
    const types = [...new Set(bs.flatMap(typesOf))];
    if (nullable) types.push('null');
    const shapes = bs.map((b) => b['description']).filter((d): d is string => typeof d === 'string');
    return withDescription({ type: types.length === 1 ? types[0] : types }, desc, shapes.join(' | '));
  }
  const types = typesOf(node);
  if (types.includes('object')) {
    const fields = node['properties'] !== undefined ? fieldList(node) : undefined;
    return withDescription({ type: types.length === 1 ? types[0] : types }, desc, fields);
  }
  if (types.includes('array')) {
    const items = node['items'] as Json | undefined;
    const out: Json = { type: types.length === 1 ? types[0] : types };
    if (items !== undefined) out['items'] = brief(items);
    return withDescription(out, desc);
  }
  // A scalar: its base type (enums are listed on the input side).
  return withDescription({ type: types.length === 1 ? types[0] : types }, desc);
}

/** Just the base type: what `serve --core` publishes for a result field. */
function bare(node: Json): Json {
  const b = brief(node);
  return { type: b['type'] };
}

function leanObjectRoot(node: Json, minimal = false): Json {
  const props = (node['properties'] as Json | undefined) ?? {};
  const out: Json = { type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, minimal ? bare(v as Json) : brief(v as Json)])) };
  if (Array.isArray(node['required']) && (node['required'] as unknown[]).length > 0) out['required'] = node['required'];
  return typeof node['description'] === 'string' && !minimal ? { ...out, description: node['description'] } : out;
}

/**
 * The published result schema. `minimal` (serve --core): top-level field
 * names and base types only.
 */
export function leanOutputSchema(json: Json, minimal = false): Json {
  const variants = (json['anyOf'] ?? json['oneOf']) as Json[] | undefined;
  if (!Array.isArray(variants)) return leanObjectRoot(json, minimal);
  // Several result shapes: one object with every field; required = those in every shape.
  const roots = variants.map((v) => leanObjectRoot(v, minimal));
  const properties: Json = {};
  for (const r of roots) {
    for (const [k, v] of Object.entries(r['properties'] as Json)) {
      const prev = properties[k] as Json | undefined;
      if (prev === undefined) properties[k] = v;
      else if (JSON.stringify(prev) !== JSON.stringify(v)) {
        const types = [...new Set([...typesOf(prev), ...typesOf(v as Json)])];
        properties[k] = minimal ? { type: types } : withDescription({ type: types }, prev['description'] as string | undefined, (v as Json)['description'] as string | undefined);
      }
    }
  }
  const required = Object.keys(properties).filter((k) => roots.every((r) => ((r['required'] as string[] | undefined) ?? []).includes(k)));
  const shapes = roots.map((r) => (typeof r['description'] === 'string' ? (r['description'] as string) : fieldList(r)));
  const out: Json = { type: 'object', properties };
  if (required.length > 0) out['required'] = required;
  if (minimal) return out;
  return withDescription(out, typeof json['description'] === 'string' ? (json['description'] as string) : undefined, `One of: ${shapes.join(' | ')}`);
}

/**
 * Drop input properties from the published schema (dotted paths reach into
 * nested objects). They are still accepted and validated: a profile simply
 * does not advertise them.
 */
export function omitProperties(json: Json, paths: readonly string[]): Json {
  const out = structuredClone(json);
  for (const p of paths) {
    const parts = p.split('.');
    let node: Json | undefined = out;
    for (const part of parts.slice(0, -1)) {
      let next = (node?.['properties'] as Json | undefined)?.[part] as Json | undefined;
      if (next !== undefined && Array.isArray(next['anyOf'])) next = (next['anyOf'] as Json[]).find((v) => v['type'] === 'object') ?? next;
      if (next !== undefined && next['type'] === 'array') next = next['items'] as Json | undefined;
      node = next;
    }
    const last = parts[parts.length - 1]!;
    const props = node?.['properties'] as Json | undefined;
    if (node === undefined || props === undefined || !(last in props)) continue;
    delete props[last];
    if (Array.isArray(node['required'])) {
      const req = (node['required'] as string[]).filter((r) => r !== last);
      if (req.length > 0) node['required'] = req;
      else delete node['required'];
    }
  }
  return out;
}

/**
 * Wrap a zod schema so it validates exactly as before but publishes the
 * lean JSON Schema (minus `omit`, input side). `types` is kept so handler
 * arguments stay typed.
 */
export function published<S extends z.ZodType>(schema: S, opts: { omit?: readonly string[]; minimal?: boolean } = {}): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
  const std = schema['~standard'] as unknown as StandardSchemaWithJSON<z.input<S>, z.output<S>>['~standard'];
  return {
    '~standard': {
      version: 1,
      vendor: std.vendor,
      validate: (value, options) => std.validate(value, options),
      ...(std.types !== undefined ? { types: std.types } : {}),
      jsonSchema: {
        input: (options) => omitProperties(leanInputSchema(std.jsonSchema.input(options)), opts.omit ?? []),
        output: (options) => leanOutputSchema(std.jsonSchema.output(options), opts.minimal === true),
      },
    },
  };
}
