/**
 * Where the store lives. Precedence: `--data-dir` (or the library's
 * `dataDir`) > `$SEA_LITE_DATA_DIR` > kronicle-lite's default
 * (`$KRONICLE_LITE_DATA_DIR`, else `~/.kronicle-lite`), so sea-lite and
 * kronicle-lite share one store unless told otherwise.
 *
 * 0.7.0 review: every other setting had a SEA_LITE_* variable and
 * SEA_LITE_DATA_DIR was silently ignored, so a script that exported it wrote
 * to the shared default store.
 */

import { defaultDataDir } from 'kronicle-lite';

export const DATA_DIR_ENV = 'SEA_LITE_DATA_DIR';

/** `$SEA_LITE_DATA_DIR` when set and not blank. */
export function envDataDir(): string | undefined {
  const v = process.env[DATA_DIR_ENV];
  return v !== undefined && v.trim() !== '' ? v : undefined;
}

export function resolveDataDir(explicit?: string): string {
  return explicit ?? envDataDir() ?? defaultDataDir();
}
