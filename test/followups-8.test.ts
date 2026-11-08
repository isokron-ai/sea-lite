/**
 * #8 (0.7.0 follow-ups from the #7 review): a planted probe is moved aside
 * instead of blocking leases, EEXIST while healing is a retry, and the
 * mutants the review left alive (ELOOP / ENXIO / EEXIST mapping, the
 * post-open fstat check) are killed.
 */

import * as nodeFs from 'node:fs';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
