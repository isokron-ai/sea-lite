/**
 * #8.2 healing race, across processes: twelve processes heal the same planted
 * probe at once. Kept in its own small file: vitest starts large files first,
 * and these tests' 24 process start-ups starved the wall-clock check in
 * scope.test.ts when they ran in the first batch on CI runners.
 */

import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { SeaLite } from '../src/store.js';

const POSIX = process.platform !== 'win32';
const PROBE = 'sea-clock.probe';
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sea-race-')));
  dirs.push(d);
  return d;
};
const child = (args: string[]): Promise<string> =>
  new Promise((res) => {
    const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let o = '';
    c.stdout.on('data', (d: Buffer) => (o += d.toString()));
    c.on('close', () => res(o.trim()));
  });

describe('#8.2 healing race across processes: EEXIST while healing is a retry, not tampering', () => {
  it.skipIf(!POSIX)('end to end: 12 processes acquire leases at once over a planted directory; every one succeeds and measures', async () => {
    const dir = tmp();
    new SeaLite({ dataDir: dir, actor: 'init' }).close();
    mkdirSync(join(dir, PROBE));
    const lib = pathToFileURL(join(process.cwd(), 'dist', 'index.js')).href;
    // Every child opens its store first, then waits for a shared start instant so the probes collide.
    const script = `import { SeaLite } from ${JSON.stringify(lib)};
      const [dir, name, at] = process.argv.slice(1);
      const s = new SeaLite({ dataDir: dir, actor: name });
      const bad = [];
      process.on('warning', (w) => { if (/disabled|one-shot|contested/.test(w.message)) bad.push(w.message); });
      const until = (t) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, t - Date.now() - 2)); while (Date.now() < t) {} };
      until(Number(at));
      let r = 'ok';
      try { s.leaseAcquire({ name }); } catch (e) { r = e.code + ':' + (e.details?.reason ?? ''); } finally { s.close(); }
      await new Promise((res) => setTimeout(res, 20));
      console.log(bad.length ? 'unmeasured:' + bad.join('|') : r);`;
    const at = Date.now() + 1500;
    const runs = await Promise.all(Array.from({ length: 12 }, (_, k) => child(['--input-type=module', '-e', script, dir, `p${k}`, String(at)])));
    const bad = runs.filter((r) => r !== 'ok');
    expect(bad, bad.join('\n')).toEqual([]);
    expect(lstatSync(join(dir, PROBE)).isFile()).toBe(true);
  }, 60_000);

  it.skipIf(!POSIX)('12 processes × 25 rounds heal the same plant at once (race window widened): no reading is lost or called tampering', async () => {
    const dir = tmp();
    const bundle = join(dir, 'clock.mjs');
    const { buildSync } = await import('esbuild');
    buildSync({ entryPoints: [join(process.cwd(), 'src', 'core', 'clock.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
    const data = join(dir, 'data');
    mkdirSync(data);
    // Round r: process 0 plants (alternately a directory and a symlink), then all 12 measure at the same instant.
    // Each file-system call sleeps 0–2 ms so that, even on a 2-core runner, healers interleave between lstat, unlink / rename and open.
    const script = `import { fsReference } from ${JSON.stringify(pathToFileURL(bundle).href)};
      import fs from 'node:fs';
      const [dir, k, t0, rounds] = process.argv.slice(1);
      const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.random() * 2);
      const slow = (f) => (...a) => { nap(); const r = f(...a); nap(); return r; };
      const sfs = { lstat: slow(fs.lstatSync), open: slow(fs.openSync), fstat: fs.fstatSync, unlink: slow(fs.unlinkSync), rename: slow(fs.renameSync),
        ftruncate: fs.ftruncateSync, write: (fd, s) => void fs.writeSync(fd, s), close: fs.closeSync };
      const probe = dir + '/sea-clock.probe';
      // sleep, then spin only the last 2 ms: twelve spinning children starved the rest of the suite on CI
      const until = (t) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, t - Date.now() - 2)); while (Date.now() < t) {} };
      const bad = [];
      for (let r = 0; r < Number(rounds); r++) {
        const start = Number(t0) + r * 100;
        until(start);
        for (let i = 0; k === '0' && i < 50; i++) {
          try { fs.rmSync(probe, { recursive: true, force: true }); if (r % 2) fs.symlinkSync('/nonexistent/x', probe); else fs.mkdirSync(probe); break; } catch {}
        }
        until(start + 10);
        const w = [];
        const ref = fsReference(dir, (m) => w.push(m), sfs)();
        if (typeof ref !== 'number') bad.push(JSON.stringify(ref));
        for (const m of w) if (/disabled|one-shot|contested/.test(m)) bad.push(m);
      }
      console.log(JSON.stringify(bad));`;
    const t0 = Date.now() + 1500;
    const runs = await Promise.all(Array.from({ length: 12 }, (_, k) => child(['--input-type=module', '-e', script, data, String(k), String(t0), '25'])));
    const bad = runs.flatMap((r) => JSON.parse(r || '["no output"]') as string[]);
    expect(bad, bad.join('\n')).toEqual([]);
    expect(lstatSync(join(data, PROBE)).isFile()).toBe(true);
  }, 90_000);

});
