#!/usr/bin/env node
/**
 * The `sea-lite` executable (dist/cli.js): turns on Node's module compile
 * cache, then runs the CLI (src/cli.ts). Hooks spawn one process per call,
 * so a warm cache saves part of every start. Node >= 22.1 only; elsewhere,
 * or with NODE_DISABLE_COMPILE_CACHE set, this is a no-op. The cache lives
 * where Node puts it ($NODE_COMPILE_CACHE, else the OS temp dir) and is keyed
 * by file content, so a rebuilt or upgraded sea-lite never reads stale code.
 */

import nodeModule from 'node:module';

try {
  (nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache?.();
} catch {
  // best effort: a cache that cannot be opened only costs the speed-up
}

await import('./cli.js');
