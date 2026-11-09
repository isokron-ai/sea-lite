/**
 * The kronicle-lite values sea-lite uses at runtime, from its slim entry when
 * the installed kronicle-lite has one.
 *
 * `kronicle-lite/core` (kronicle-lite > 0.9.0) is the store, the chain and the
 * crypto helpers without the MCP SDK and server code that the main entry loads
 * (about 50 ms of module loading on every CLI call, which the cc-anchor edit
 * hook pays per edit). With an older kronicle-lite (0.9.0 has no such subpath)
 * the main entry is used. Both export the same objects, so a KronicleLite a
 * caller opened from either entry composes with this one.
 *
 * Types come straight from 'kronicle-lite' (type-only imports are erased).
 */

import type * as KL from 'kronicle-lite';

export const KL_SLIM_ENTRY = 'kronicle-lite/core';

/** "This kronicle-lite has no ./core subpath": Node's codes, or the same condition from vite's resolver (vitest), which has no code. */
function noSlimEntry(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || code === 'ERR_MODULE_NOT_FOUND') return true;
  return code === undefined && e instanceof Error && e.message.includes('"./core"') && e.message.includes('"kronicle-lite"');
}

/**
 * Import the slim entry, or the main entry when the installed kronicle-lite
 * has no slim entry. Any other import failure (a broken native module, a
 * syntax error) is thrown, not hidden behind the fallback.
 */
export async function loadKronicle(importer: (specifier: string) => Promise<unknown> = (s) => import(s)): Promise<{ mod: typeof KL; entry: string }> {
  try {
    return { mod: (await importer(KL_SLIM_ENTRY)) as typeof KL, entry: KL_SLIM_ENTRY };
  } catch (e) {
    if (!noSlimEntry(e)) throw e;
    return { mod: (await importer('kronicle-lite')) as typeof KL, entry: 'kronicle-lite' };
  }
}

// loadKronicle imports through a variable: the subpath may not exist in the installed version, so the bundler must not resolve it.
const { mod: kl, entry } = await loadKronicle();

/** Which kronicle-lite entry was loaded ('kronicle-lite/core' or 'kronicle-lite'), for doctor and tests. */
export const KL_ENTRY: string = entry;

export const KronicleLite: typeof KL.KronicleLite = kl.KronicleLite;
export type KronicleLite = KL.KronicleLite;
export const Chain: typeof KL.Chain = kl.Chain;
export type Chain = KL.Chain;
export const ChainConflictError: typeof KL.ChainConflictError = kl.ChainConflictError;
export type ChainConflictError = KL.ChainConflictError;
export const canonicalize: typeof KL.canonicalize = kl.canonicalize;
export const sha256Hex: typeof KL.sha256Hex = kl.sha256Hex;
export const defaultDataDir: typeof KL.defaultDataDir = kl.defaultDataDir;
