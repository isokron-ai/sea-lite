/**
 * #8 (0.7.0 follow-ups from the #7 review): a planted probe is moved aside
 * instead of blocking leases, EEXIST while healing is a retry, and the
 * mutants the review left alive (ELOOP / ENXIO / EEXIST mapping, the
 * post-open fstat check) are killed.
 */

import { spawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { fsReference, type ProbeFs } from '../src/core/clock.js';
import { runDoctor } from '../src/doctor.js';
import { SeaLite } from '../src/store.js';

const POSIX = process.platform !== 'win32';
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sea-f8-')));
  dirs.push(d);
  return d;
};
const PROBE = 'sea-clock.probe';
const asides = (dir: string) => readdirSync(dir).filter((n) => n.startsWith(`${PROBE}.tampered-`));
const NEW = { body: '', kind: 'bug' as const, priority: 'high' as const, tags: [], status: 'triaged' as const, dry_run: false };

/** Node's fs with some calls overridden: the probe's own error paths, which a real file system cannot be made to hit on demand. */
function fakeFs(over: Partial<ProbeFs>): ProbeFs & { writes: number } {
  const fs = nodeFs;
  const base: ProbeFs & { writes: number } = {
    writes: 0,
    lstat: (p) => fs.lstatSync(p),
    open: (p, f, m) => fs.openSync(p, f, m),
    fstat: (fd) => fs.fstatSync(fd),
    unlink: (p) => fs.unlinkSync(p),
    rename: (a, b) => fs.renameSync(a, b),
    ftruncate: (fd, n) => fs.ftruncateSync(fd, n),
    write(fd, s) {
      base.writes++;
      fs.writeSync(fd, s);
    },
    close: (fd) => fs.closeSync(fd),
  };
  return Object.assign(base, over);
}
const child = (args: string[]): Promise<string> =>
  new Promise((res) => {
    const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let o = '';
    c.stdout.on('data', (d: Buffer) => (o += d.toString()));
    c.on('close', () => res(o.trim()));
  });
const errno = (code: string) => Object.assign(new Error(code), { code });

describe('#8.1 probe DoS: a planted directory is moved aside, not a reason to refuse leases', () => {
  it('claims keep working after `mkdir <data-dir>/sea-clock.probe`; the plant is kept aside, recorded, and doctor reports it', async () => {
    const dir = tmp();
    const s = new SeaLite({ dataDir: dir, actor: 'a' });
    const t = s.create({ title: 'x', ...NEW });
    s.close();
    mkdirSync(join(dir, PROBE));
    writeFileSync(join(dir, PROBE, 'keep'), 'x');
    const s2 = new SeaLite({ dataDir: dir, actor: 'a' });
    expect(s2.claim({ ticket_ids: [t.ticket.id] }).claims).toHaveLength(1);
    s2.close();
    expect(lstatSync(join(dir, PROBE)).isFile()).toBe(true);
    const [aside] = asides(dir);
    expect(aside).toBeDefined();
    expect(readFileSync(join(dir, aside!, 'keep'), 'utf8')).toBe('x');

    rmSync(join(dir, PROBE));
    mkdirSync(join(dir, PROBE));
    const warnings: string[] = [];
    expect(typeof fsReference(dir, (m) => warnings.push(m))()).toBe('number');
    expect(warnings.join('\n')).toMatch(/was a directory; moved aside to sea-clock\.probe\.tampered-/);
    const rep = await runDoctor({ dataDir: dir });
    const clock = rep.checks.find((c) => c.id === 'clock');
    expect(clock?.status).toBe('warn');
    expect(clock?.detail).toMatch(/moved aside/);
  });

  it('a plant that cannot be moved (rename refused) is measured around with a one-shot probe, not a refusal', () => {
    const dir = tmp();
    mkdirSync(join(dir, PROBE));
    const warnings: string[] = [];
    const fs = fakeFs({
      rename: () => {
        throw errno('EACCES');
      },
    });
    expect(typeof fsReference(dir, (m) => warnings.push(m), fs)()).toBe('number');
    expect(warnings.join('\n')).toMatch(/cannot be moved \(EACCES\); measured with a one-shot probe/);
    expect(readdirSync(dir)).toEqual([PROBE]); // the one-shot probe is removed again
  });
});

describe('#8.2 healing race: EEXIST while healing is a retry, not tampering', () => {
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

  it('an EEXIST from the exclusive create (another process healed first) is retried', () => {
    const dir = tmp();
    symlinkSync('/nonexistent/x', join(dir, PROBE));
    let excl = 0;
    const real = fakeFs({});
    const fs = fakeFs({
      open(p, f, m) {
        if (excl++ === 0 && p.endsWith(PROBE)) {
          // the other healer wins: it creates the probe between our unlink and our O_EXCL open
          writeFileSync(p, 'theirs\n');
          throw errno('EEXIST');
        }
        return real.open(p, f, m);
      },
    });
    const warnings: string[] = [];
    expect(typeof fsReference(dir, (m) => warnings.push(m), fs)()).toBe('number');
    expect(warnings.join('\n')).not.toMatch(/one-shot/);
    expect(readFileSync(join(dir, PROBE), 'utf8')).toBe(`${process.pid}\n`);
  });

  it.skipIf(!POSIX)('a directory swapped in after lstat saw a symlink (unlink: EISDIR) is retried and moved aside, not "cannot be moved"', () => {
    const dir = tmp();
    symlinkSync('/nonexistent/x', join(dir, 'link'));
    const linkStat = lstatSync(join(dir, 'link'));
    mkdirSync(join(dir, PROBE));
    let first = true;
    const fs = fakeFs({ lstat: (p) => (first && p.endsWith(PROBE) ? ((first = false), linkStat) : nodeFs.lstatSync(p)) });
    const warnings: string[] = [];
    expect(typeof fsReference(dir, (m) => warnings.push(m), fs)()).toBe('number');
    expect(warnings.join('\n')).not.toMatch(/cannot be moved|one-shot/);
    expect(asides(dir)).toHaveLength(1);
  });

  it('an ENOENT from unlink / rename (another process removed the plant first) is retried', () => {
    for (const plant of ['dir', 'symlink'] as const) {
      const dir = tmp();
      if (plant === 'dir') mkdirSync(join(dir, PROBE));
      else symlinkSync('/nonexistent/x', join(dir, PROBE));
      const real = fakeFs({});
      const gone = () => {
        rmSync(join(dir, PROBE), { recursive: true, force: true });
        throw errno('ENOENT');
      };
      const fs = fakeFs({ rename: (a, b) => (a.endsWith(PROBE) ? gone() : real.rename(a, b)), unlink: (p) => (p.endsWith(PROBE) ? gone() : real.unlink(p)) });
      const warnings: string[] = [];
      expect(typeof fsReference(dir, (m) => warnings.push(m), fs)(), plant).toBe('number');
      expect(warnings, plant).toEqual([]); // not "cannot be moved", no one-shot probe
      expect(lstatSync(join(dir, PROBE)).isFile(), plant).toBe(true);
    }
  });
});

describe('#8.2 a fresh probe renamed by a slower healer is not recorded as a plant', () => {
  it('when what got moved aside turns out to be a regular probe file, it is removed and nothing is reported', () => {
    const dir = tmp();
    writeFileSync(join(dir, PROBE), '1\n'); // the other healer's fresh probe
    const dirStat = lstatSync(dir);
    let first = true;
    const warnings: string[] = [];
    // our lstat saw the planted directory just before the other healer replaced it
    const fs = fakeFs({ lstat: (p) => (first && p.endsWith(PROBE) ? ((first = false), dirStat) : nodeFs.lstatSync(p)) });
    expect(typeof fsReference(dir, (m) => warnings.push(m), fs)()).toBe('number');
    expect(asides(dir)).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('#8 surviving mutants: the probe open error mapping and the post-open fstat check', () => {
  for (const code of ['ELOOP', 'ENXIO', 'EEXIST', 'EISDIR']) {
    it(`a persistent ${code} on open is tampering (fail closed), a transient one is retried`, () => {
      const dir = tmp();
      const always = fakeFs({
        open: () => {
          throw errno(code);
        },
      });
      const ref = fsReference(dir, () => undefined, always)();
      expect(ref).toMatchObject({ tampered: expect.stringContaining(code) });
      let n = 0;
      const real = fakeFs({});
      const once = fakeFs({
        open(p, f, m) {
          if (n++ === 0) throw errno(code);
          return real.open(p, f, m);
        },
      });
      const warnings: string[] = [];
      expect(typeof fsReference(dir, (m) => warnings.push(m), once)()).toBe('number');
      expect(warnings).toEqual([]); // retried at the probe path, not via the one-shot fallback
    });
  }

  it('any other open error is "cannot measure" (fail open, warned once), not tampering', () => {
    const dir = tmp();
    const warnings: string[] = [];
    const fs = fakeFs({
      open: () => {
        throw errno('EACCES');
      },
    });
    const ref = fsReference(dir, (m) => warnings.push(m), fs);
    expect(ref()).toBeNull();
    expect(ref()).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('a hard link appearing between lstat and open is caught by fstat: nothing is written through it', () => {
    const dir = tmp();
    const real = fakeFs({});
    const linked = (fd: number): Stats => Object.assign(Object.create(Object.getPrototypeOf(real.fstat(fd)) as object) as Stats, real.fstat(fd), { nlink: 2 });
    const always = fakeFs({ fstat: linked });
    expect(fsReference(dir, () => undefined, always)()).toMatchObject({ tampered: expect.stringMatching(/hard link/) });
    expect(always.writes).toBe(0);
    let n = 0;
    const once = fakeFs({ fstat: (fd) => (n++ === 0 ? linked(fd) : real.fstat(fd)) });
    const warnings: string[] = [];
    expect(typeof fsReference(dir, (m) => warnings.push(m), once)()).toBe('number');
    expect(warnings).toEqual([]);
    expect(once.writes).toBe(1);
  });
});
