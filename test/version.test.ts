import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CATALOG_VERSION } from '../src/catalog.js';
import { VERSION } from '../src/version.js';

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

describe('version', () => {
  it('matches package.json so the CLI and MCP banner never drift from npm', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('SL-11: every place that states the version agrees (lockfile, server.json, catalog pin, CHANGELOG, --version)', () => {
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
    expect(lock.version).toBe(VERSION);
    expect(lock.packages['']!.version).toBe(VERSION);
    const server = JSON.parse(read('server.json')) as { version: string; packages: { identifier: string; version: string }[] };
    expect(server.version).toBe(VERSION);
    expect(server.packages.find((p) => p.identifier === 'sea-lite')!.version).toBe(VERSION);
    expect(CATALOG_VERSION).toBe(VERSION);
    expect((JSON.parse(read('.mcp-catalog/sea-lite.json')) as { server: { version: string } }).server.version).toBe(VERSION);
    // The newest CHANGELOG heading is this version (released or "Unreleased"), never an [Unreleased] block for another.
    const top = /^## \[([^\]]+)\]/m.exec(read('CHANGELOG.md'))![1];
    expect(top).toBe(VERSION);
    const r = spawnSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), '--version'], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe(VERSION);
    expect(spawnSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'help'], { encoding: 'utf8' }).stdout).toMatch(new RegExp(`^sea-lite ${VERSION.replace(/\./g, '\\.')} `));
  });
});
