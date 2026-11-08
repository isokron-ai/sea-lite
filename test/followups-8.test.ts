/**
 * #8 (0.7.0 follow-ups from the #7 review): a planted probe is moved aside
 * instead of blocking leases, EEXIST while healing is a retry, and the
 * mutants the review left alive (ELOOP / ENXIO / EEXIST mapping, the
 * post-open fstat check) are killed.
 */

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import * as redactMod from '../src/audit/redact.js';
import { assertClockTrusted, clockGuard, fsReference, type ProbeFs } from '../src/core/clock.js';
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

// ── #8.3–#8.5 redaction: false positives, linear time, misses ──

/** Deterministic pseudo-random strings so fixtures are key-shaped without being anyone's key. */
function prng(seed: number): (alphabet: string, n: number) => string {
  let x = seed >>> 0;
  return (alphabet, n) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
      s += alphabet[x % alphabet.length];
    }
    return s;
  };
}
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rnd = prng(8);
const GHP8 = 'ghp_' + rnd(ALNUM, 36);
const SK = 'sk-' + rnd(ALNUM, 48);
const SK_PROJ = 'sk-' + 'proj-' + rnd(ALNUM + '-_', 120);
const SK_ANT = 'sk-' + 'ant-api03-' + rnd(ALNUM + '-_', 93) + 'AA';
const XOXB = 'xo' + 'xb-' + rnd('0123456789', 12) + '-' + rnd('0123456789', 13) + '-' + rnd(ALNUM, 24);
const XOXP = 'xo' + 'xp-' + rnd('0123456789', 12) + '-' + rnd('0123456789', 12) + '-' + rnd('0123456789', 13) + '-' + rnd('0123456789abcdef', 32);
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

describe('#8.3 redaction false positives: ordinary ids pass, real-looking keys are still caught', () => {
  const ordinary = [
    'sandbox:sk-prod-cluster-east-0001',
    'sk-create-sandbox-attempt-0001',
    'xoxb-prod-runner-pool-1',
    'F-sk-learn-regression-0001',
    'refs/heads/sk-proj-redaction-false-positives',
    'task-create-sandbox-attempt-0001',
    'sk-proj-supercalifragilisticexpialidocious',
    'xoxp-staging-deploy-notifications-0042',
    'risk-assessment-2026-q4-final',
  ];
  for (const id of ordinary) {
    it(`"${id}" is neither refused as an identity nor redacted from free text`, () => {
      const { redactText, looksLikeSecret } = redactMod;
      expect(looksLikeSecret(id)).toBe(false);
      expect(redactText(`see ${id} here`, 'x')).toEqual({ text: `see ${id} here`, redacted: false });
    });
  }
  it('they work as lease names, finding ids and titles end to end', () => {
    const s = new SeaLite({ memory: true, actor: 'a' });
    expect(s.leaseAcquire({ name: 'sandbox:sk-prod-cluster-east-0001' }).epoch).toBe(1);
    s.auditOpen({ audit_id: 'au', title: 't' });
    const r = s.auditFinding('au', { finding_id: 'F-sk-learn-regression-0001', title: 'on refs/heads/sk-proj-redaction-false-positives (xoxb-prod-runner-pool-1)' });
    expect(r.redacted).toBeUndefined();
    s.close();
  });
  for (const [what, key] of [
    ['sk- legacy', SK],
    ['sk-proj-', SK_PROJ],
    ['sk-ant-', SK_ANT],
    ['xoxb-', XOXB],
    ['xoxp- (hex secret)', XOXP],
  ] as const) {
    it(`a real-looking ${what} key is still redacted and refused`, () => {
      const { redactText, looksLikeSecret } = redactMod;
      expect(looksLikeSecret(key)).toBe(true);
      const r = redactText(`k=${key};`, 'x');
      expect(r.redacted).toBe(true);
      expect(r.text).not.toContain(key.slice(8, 30));
    });
  }
  it('every credential kronicle-lite detects is still redacted (parity with its write-time detectors)', async () => {
    const { scanForSecrets } = await import('kronicle-lite');
    const { redactText } = redactMod;
    const r2 = prng(3);
    const corpus = [
      `-----BEGIN RSA PRIVATE KEY-----\n${r2(ALNUM, 64)}\n${r2(ALNUM, 64)}\n-----END RSA PRIVATE KEY-----`,
      'AKIA' + r2('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16),
      `aws_secret_access_key = ${r2(ALNUM + '/+', 40)}`,
      GHP8,
      'github_pat_' + r2(ALNUM + '_', 82),
      'glpat-' + r2(ALNUM, 20),
      SK_ANT,
      SK_PROJ,
      XOXB,
      'sk_' + 'live_' + r2(ALNUM, 24),
      'AIza' + r2(ALNUM + '-_', 35),
      'npm_' + r2(ALNUM, 36),
      'hvs.' + r2(ALNUM, 90),
      'dp.pt.' + r2(ALNUM, 43),
      `eyJ${r2(ALNUM, 20)}.eyJ${r2(ALNUM, 30)}.${r2(ALNUM, 43)}`,
      `postgres://app:${r2(ALNUM, 16)}@db.internal:5432/prod`,
      `Authorization: Bearer ${r2(ALNUM, 40)}`,
      `export API_TOKEN=${r2(ALNUM, 32)}`,
      `password: "${r2(ALNUM, 20)}"`,
    ];
    for (const t of corpus) {
      expect(scanForSecrets(t).length, `kronicle should flag: ${t.slice(0, 20)}`).toBeGreaterThan(0);
      expect(redactText(t, 'x').redacted, t.slice(0, 30)).toBe(true);
    }
  });
});

describe('#8.5 redaction misses', () => {
  const wrap = (s: string, w: number) => s.match(new RegExp(`.{1,${w}}`, 'g'))!.join('\r\n');
  const hex = (s: string) => Buffer.from(s).toString('hex');
  const cases: [string, string][] = [
    ['a letter glued to the key', `token${GHP8}`],
    ['a digit glued to the key', `1${GHP8}`],
    ['a word glued to an sk- key', `apikey${SK}`],
    ['base64 of x+key', b64(`x${GHP8}`)],
    ['base64 of x+key (sk-proj)', b64(`x${SK_PROJ}`)],
    ['base64 in a URL path', `https://h.test/v1/${b64(GHP8)}/info`],
    ['base64url in a URL path', `https://h.test/cb/${Buffer.from(`id:${SK}`).toString('base64url')}?a=1`],
    ['base64 glued after a path segment', `/files/x${b64(`secret ${GHP8} end`)}`],
    ['MIME-wrapped base64 (76 columns)', wrap(b64(`Authorization: token ${GHP8} and some more text to wrap a few lines over`), 76)],
    ['MIME-wrapped base64 (key split across lines)', wrap(b64(`k=${XOXB}`), 16)],
    ['hex', hex(GHP8)],
    ['uppercase hex', hex(`key ${SK}`).toUpperCase()],
    ['hex at an odd offset (a hex digit glued in front)', `a${hex(GHP8)}`],
    ['base64 with a letter glued in front', `Q${b64(`secret ${GHP8} end`)}`],
    ['double base64', b64(b64(GHP8))],
    ['triple base64', b64(b64(b64(`k=${SK_ANT}`)))],
    ['base64 of hex', b64(hex(GHP8))],
    ['URL-encoded base64', encodeURIComponent(b64(`t ${GHP8}`))],
  ];
  for (const [what, text] of cases) {
    it(what, () => {
      const { redactText, looksLikeSecret } = redactMod;
      const r = redactText(`see ${text} here`, 'evidence');
      expect(r.redacted).toBe(true);
      expect(r.text).not.toContain(text.split('\r\n')[0]!.slice(0, 40));
      expect(r.text.startsWith('see ')).toBe(true);
      expect(r.text.endsWith(' here')).toBe(true);
      expect(looksLikeSecret(text)).toBe(true);
    });
  }
  it('leaves hashes, uuids, hex digests and base64 / hex of ordinary text alone', () => {
    const { redactText } = redactMod;
    for (const t of [
      'sha256:' + 'ab'.repeat(32),
      'commit ' + rnd('0123456789abcdef', 40),
      'sha512-' + b64(Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 97 + 13) & 255))),
      hex('a perfectly ordinary sentence, nothing secret here'),
      b64(b64('a perfectly ordinary sentence, nothing secret here')),
      wrap(b64('a perfectly ordinary sentence, nothing secret here at all, wrapped over lines'), 20),
      'https://example.com/v1/' + b64('ordinary/path/segment') + '/x',
    ]) expect(redactText(t, 'x'), t).toEqual({ text: t, redacted: false });
  });
});

describe('#8 surviving mutant: the 0.9 printable-ratio threshold on decoded base64', () => {
  // A key inside decoded bytes that are exactly 90% printable is looked at; 89% is treated as binary.
  const blob = (printable: number) => {
    const key = Buffer.from(` ${GHP8} `); // 42 printable bytes
    const pad = Buffer.alloc(printable - key.length, 0x2e); // '.'
    const noise = Buffer.alloc(100 - printable, 0x01);
    return b64(Buffer.concat([key, pad, noise]));
  };
  it('90% printable: decoded and redacted', () => {
    expect(redactMod.redactText(`x ${blob(90)} y`, 'x').redacted).toBe(true);
  });
  it('89% printable: treated as binary, left alone', () => {
    expect(redactMod.redactText(`x ${blob(89)} y`, 'x').redacted).toBe(false);
  });
});

describe('#8.4 redaction is linear in the size of a cell', () => {
  const r3 = prng(5);
  const shapes: Record<string, (n: number) => string> = {
    'one 64K-char word': (n) => 'a'.repeat(n),
    'random alnum': (n) => r3(ALNUM, n),
    'dashed id': (n) => 'ab-'.repeat(n / 3),
    'percent runs': (n) => 'a%4'.repeat(n / 3),
    'sk- repeated': (n) => 'sk-'.repeat(n / 3),
    'xoxb- repeated': (n) => 'xoxb-'.repeat(n / 5),
    'TOKEN line': (n) => 'TOKEN'.repeat(n / 5),
    'TOKEN lines with x=': (n) => ('TOKEN'.repeat(20) + ' x=\n').repeat(n / 104),
    'PEM headers': (n) => '-----BEGIN PRIVATE KEY-----\n'.repeat(n / 28),
    'scheme runs': (n) => 'a://x:'.repeat(n / 6),
    'eyJ runs': (n) => 'eyJ'.repeat(n / 3),
    'base64 of text': (n) => b64('x'.repeat((n * 3) / 4)),
    'nested base64': (n) => b64(b64(b64('x '.repeat(n / 5)))),
    'hex': (n) => r3('0123456789abcdef', n),
    'MIME lines': (n) => (r3(ALNUM, 76) + '\r\n').repeat(n / 78),
    'Bearer runs': (n) => 'Bearer '.repeat(n / 7),
    'many keys': (n) => (GHP8 + ' ').repeat(n / 41),
  };
  const time = (f: () => void) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      f();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  for (const [what, make] of Object.entries(shapes)) {
    it(what, () => {
      const small = make(8_192);
      const big = make(65_536);
      const ts = time(() => redactMod.redactText(small, 'x'));
      const tb = time(() => redactMod.redactText(big, 'x'));
      // 8× the input: linear is ~8× the time, quadratic ~64×. Allow noise, and a floor for tiny timings. (8 KB → 64 KB keeps the suite's CPU load low.)
      expect(tb, `${ts.toFixed(2)} ms → ${tb.toFixed(2)} ms`).toBeLessThan(Math.max(ts, 2) * 24);
      expect(tb).toBeLessThan(2_000);
    });
  }
  it('an 8 KB cell takes well under the 130 ms the review measured', () => {
    const cell = r3(ALNUM + '-_', 8192); // one 8 KB word: the old URL-run regex was quadratic in it
    expect(time(() => redactMod.redactText(cell, 'x'))).toBeLessThan(25);
  });
});

describe('#8.3 the randomness rule for bare sk- bodies, edge by edge', () => {
  const secret = (s: string) => redactMod.looksLikeSecret(s);
  it('a 16-char segment that switches class only 4 times is a name (sk-Build2024Release-v12)', () => {
    expect(secret('sk-Build2024Release-v12')).toBe(false);
  });
  it('5 switches spread over a long segment (< 25%) is a name', () => {
    expect(secret('sk-productionrelease2026candidatebuild7fixes9')).toBe(false);
  });
  it('random-looking segments shorter than 16 are not a key', () => {
    expect(secret('sk-aB3dE5gH7jK9mN1-pQrS')).toBe(false);
  });
  it('a 16-char random segment is a key', () => {
    expect(secret('sk-aB3dE5gH7jK9mN1p-qRs')).toBe(true);
  });
  it('a bare sk- with 32+ lowercase hex digits is a key even with few class switches', () => {
    expect(secret('sk-' + '0123456789abcdef'.repeat(2))).toBe(true);
    expect(secret('sk-' + '0123456789ABCDEF'.repeat(2))).toBe(false); // uppercase: not the hex form, and 3 switches
  });
});

describe('#8.5 nesting depth and the scan budget fail closed', () => {
  const nest = (s: string, n: number) => Array.from({ length: n }).reduce<string>((t) => b64(t), s);
  const text = 'a perfectly ordinary sentence, nothing secret here';
  it('four levels of base64 are looked through: a key is found, ordinary text is left alone', () => {
    expect(redactMod.redactText(nest(`k=${GHP8}`, 4), 'x').redacted).toBe(true);
    expect(redactMod.redactText(nest(text, 4), 'x').redacted).toBe(false);
  });
  it('text nested five levels deep is not looked into: it is redacted', () => {
    expect(redactMod.redactText(nest(text, 5), 'x')).toMatchObject({ redacted: true });
  });
  it('input whose decoding exceeds the budget is replaced whole', () => {
    expect(redactMod.redactWithBudget(nest(text, 3), 10)).toEqual({ text: '[REDACTED:undecidable]', redacted: true });
    expect(redactMod.redactWithBudget(nest(text, 3), 10_000)).toEqual({ text: nest(text, 3), redacted: false });
  });
});

describe('#8 context detectors keep kronicle-lite\'s exclusions (placeholders, accept rules, exact lengths)', () => {
  const r4 = prng(11);
  const cases: [string, string][] = [
    ['AWS key id with 20 chars is not the 16-char form', 'AKIA' + r4('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 20)],
    ['AWS documentation example key', 'AKIA' + 'IOSFODNN7EXAMPLE'],
    ['PEM armour without a key body', '-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----'],
    ['placeholder password value', 'password = "your_password_123"'],
    ['Bearer value without a digit', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyzabcd'],
    ['env value read from the environment', 'export API_TOKEN=os.getenv(X1)'],
  ];
  for (const [what, t] of cases) {
    it(`${what}: neither kronicle-lite nor sea-lite flags it`, async () => {
      const { scanForSecrets } = await import('kronicle-lite');
      expect(scanForSecrets(t)).toEqual([]);
      expect(redactMod.redactText(t, 'x')).toEqual({ text: t, redacted: false });
    });
  }
  it('a PEM key body without its footer is still redacted', () => {
    const t = `-----BEGIN PRIVATE KEY-----\n${r4(ALNUM, 64)}\n${r4(ALNUM, 64)}\n\nafter`;
    const r = redactMod.redactText(t, 'x');
    expect(r.text).toBe('[REDACTED:private_key]\n\nafter');
  });
});

// ── #8.6 export --out, and the O_EXCL mutant ──

describe('#8.6 audit export --out pointing at an existing directory', () => {
  it('is a clean error, and no temp file holding the tracker is left behind', () => {
    const dir = tmp();
    const data = join(dir, 'data');
    const s = new SeaLite({ dataDir: data, actor: 'mcp-audit' });
    s.auditOpen({ audit_id: 'a', title: 'A' });
    s.auditFinding('a', { finding_id: 'F1', title: 'tracker-canary-title' });
    s.close();
    const out = join(dir, 'out');
    mkdirSync(out);
    const r = nodeSpawnSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'audit', 'export', 'a', '--out', out, '--data-dir', data], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: dir },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/is a directory/);
    expect(r.stderr).not.toMatch(/\n\s+at /); // no stack trace
    expect(readdirSync(dir).sort()).toEqual(['data', 'out']);
    expect(readdirSync(out)).toEqual([]);
  });

  it('a failure after the temp file is written (rename refused) removes the temp file', async () => {
    const { writePrivateFile } = await import('../src/audit/export.js');
    const dir = tmp();
    const target = join(dir, 'race');
    // the target turns into a non-empty directory between the check and the rename
    const names = [join(dir, '.t1.tmp')];
    let err: unknown;
    try {
      writePrivateFile(target, 'tracker', {
        tmpName: () => {
          mkdirSync(target);
          writeFileSync(join(target, 'x'), 'x');
          return names.shift()!;
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'invalid_input' });
    expect(readdirSync(dir)).toEqual(['race']);
  });

  it('a directory at the path is refused before any temp file is created', async () => {
    const { writePrivateFile } = await import('../src/audit/export.js');
    const dir = tmp();
    let made = 0;
    expect(() => writePrivateFile(dir, 'tracker', { tmpName: () => (made++, join(dir, '.x.tmp')) })).toThrow(/is a directory; give a file path/);
    expect(made).toBe(0);
  });
});

describe('#8 surviving mutant: O_EXCL on the export temp file', () => {
  it.skipIf(!POSIX)('a file planted at the temp name is never written through; a fresh name is used', async () => {
    const { writePrivateFile } = await import('../src/audit/export.js');
    const { openSync, readSync, closeSync } = nodeFs;
    const dir = tmp();
    const planted = join(dir, '.planted.tmp');
    writeFileSync(planted, '', { mode: 0o666 });
    const spy = openSync(planted, 'r'); // the planter keeps a read handle
    const names = [planted, join(dir, '.fresh.tmp')];
    writePrivateFile(join(dir, 'tracker.csv'), 'id,title\nF1,secret finding\n', { tmpName: () => names.shift()! });
    const buf = Buffer.alloc(64);
    expect(readSync(spy, buf, 0, 64, 0)).toBe(0); // nothing reached the planter
    closeSync(spy);
    expect(readFileSync(planted, 'utf8')).toBe('');
    expect(readFileSync(join(dir, 'tracker.csv'), 'utf8')).toMatch(/secret finding/);
    expect(lstatSync(join(dir, 'tracker.csv')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(['.planted.tmp', 'tracker.csv']);
  });
  it.skipIf(!POSIX)('a symlink planted at the temp name is not followed', async () => {
    const { writePrivateFile } = await import('../src/audit/export.js');
    const dir = tmp();
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'precious\n');
    const planted = join(dir, '.link.tmp');
    symlinkSync(victim, planted);
    const names = [planted, join(dir, '.fresh.tmp')];
    writePrivateFile(join(dir, 'tracker.csv'), 'id\n', { tmpName: () => names.shift()! });
    expect(readFileSync(victim, 'utf8')).toBe('precious\n');
  });
});

// ── #8 review of the stack: an unwritable probe, and the moved-aside pile ──

describe('#8 follow-up: a probe made unwritable (chmod 0444, same uid) is replaced; unmeasurable fails closed', () => {
  it('EACCES on the probe is healed: the probe is replaced and the 15-minute skew is still caught', () => {
    const dir = tmp();
    writeFileSync(join(dir, PROBE), '1\n', { mode: 0o444 });
    const real = fakeFs({});
    // root ignores file modes, so the EACCES the planter caused is injected for the probe path
    let denied = 0;
    const fs = fakeFs({
      open(p, f, m) {
        if (p.endsWith(PROBE) && nodeFs.existsSync(p) && (nodeFs.statSync(p).mode & 0o200) === 0) {
          denied++;
          throw errno('EACCES');
        }
        return real.open(p, f, m);
      },
    });
    const warnings: string[] = [];
    const ref = fsReference(dir, (m) => warnings.push(m), fs);
    expect(typeof ref()).toBe('number');
    expect(denied).toBe(1);
    expect(warnings.join('\n')).toMatch(/not writable \(EACCES\); replaced/);
    if (POSIX) expect(nodeFs.statSync(join(dir, PROBE)).mode & 0o777).toBe(0o600);
    const guard = clockGuard(() => new Date(Date.now() + 15 * 60_000), ref, 30);
    expect(guard.untrusted()).toMatchObject({ max_ms: 30_000 });
  });

  it('a probe that cannot be measured at all refuses lease decisions (not "trust this clock"); the knob set to 0 is the operator\'s ack', () => {
    const down = () => null;
    expect(() => assertClockTrusted(clockGuard(() => new Date(), down, 30), 'place a claim')).toThrow(expect.objectContaining({ code: 'clock_skew', details: { reason: 'probe_unavailable' } }));
    expect(() => assertClockTrusted(clockGuard(() => new Date(), down, 0), 'place a claim')).not.toThrow();
  });

  it('a skewed store whose probe is denied end to end: claims are refused', () => {
    const dir = tmp();
    const s = new SeaLite({ dataDir: dir, actor: 'a', now: () => new Date(Date.now() + 15 * 60_000), clockReference: () => null });
    const t = s.create({ title: 'x', ...NEW });
    let code = '';
    try {
      s.claim({ ticket_ids: [t.ticket.id] });
    } catch (e) {
      code = (e as { code: string }).code;
    }
    expect(code).toBe('clock_skew');
    s.close();
  });

  it('doctor fails the clock check when it cannot measure', async () => {
    const dir = tmp();
    new SeaLite({ dataDir: dir, actor: 'a' }).close();
    const { checkClockWith } = await import('../src/doctor.js');
    const c = checkClockWith(dir, new Date(), () => null);
    expect(c.status).toBe('fail');
    // #8 re-review: say exactly how to recover
    expect(c.detail).toContain(`chmod u+w ${dir} ${join(dir, PROBE)}`);
    expect(c.detail).toMatch(/or, knowingly, set SEA_LITE_MAX_CLOCK_SKEW_SECONDS=0/);
  });
});

describe('#8 follow-up: moved-aside plants are capped', () => {
  it('keeps the newest 8, removes the rest and counts them; doctor reports both', async () => {
    const dir = tmp();
    const ref = fsReference(dir, () => undefined);
    for (let i = 0; i < 20; i++) {
      rmSync(join(dir, PROBE), { force: true });
      mkdirSync(join(dir, PROBE));
      writeFileSync(join(dir, PROBE, `n${i}`), String(i));
      expect(typeof ref()).toBe('number');
    }
    const kept = asides(dir).sort();
    expect(kept).toHaveLength(8);
    expect(kept.map((a) => readdirSync(join(dir, a))[0]).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `n${12 + i}`).sort());
    const { runDoctor: doctor } = await import('../src/doctor.js');
    const clock = (await doctor({ dataDir: dir })).checks.find((c) => c.id === 'clock');
    expect(clock?.detail).toMatch(/12 older plants were removed/);
    expect(clock?.data).toMatchObject({ removed_earlier: 12 });
  });
});

// ── #8 review of the stack: export writes all bytes or nothing, and stale temp files ──

describe('#8 follow-up: writePrivateFile never replaces an export with a partial one', () => {
  const setup = () => {
    const dir = tmp();
    const out = join(dir, 'tracker.csv');
    writeFileSync(out, 'old export\n', { mode: 0o600 });
    return { dir, out, data: Buffer.alloc(204_800, 0x61) };
  };
  it('short writes are continued until every byte is written', async () => {
    const { writePrivateFile } = await import('../src/audit/export.js');
    const { out, data } = setup();
    writePrivateFile(out, data, { write: (fd, b, off, len) => nodeFs.writeSync(fd, b, off, Math.min(len, 1000)) });
    expect(nodeFs.statSync(out).size).toBe(data.length);
  });
  it('ENOSPC part-way: an error, the old export intact, no temp file left', async () => {
    const { writePrivateFile } = await import('../src/audit/export.js');
    const { dir, out, data } = setup();
    let written = 0;
    const write = (fd: number, b: Buffer, off: number, len: number) => {
      if (written >= 65_536) throw errno('ENOSPC');
      const n = nodeFs.writeSync(fd, b, off, Math.min(len, 65_536 - written));
      written += n;
      return n;
    };
    expect(() => writePrivateFile(out, data, { write })).toThrow(/ENOSPC/);
    expect(readFileSync(out, 'utf8')).toBe('old export\n');
    expect(readdirSync(dir)).toEqual(['tracker.csv']);
  });
  it('a write that makes no progress is an error, not a loop', async () => {
    const { writePrivateFile } = await import('../src/audit/export.js');
    const { out, data } = setup();
    expect(() => writePrivateFile(out, data, { write: () => 0 })).toThrow(/no progress/);
    expect(readFileSync(out, 'utf8')).toBe('old export\n');
  });
  it('a write that claims more than reached the file is caught by the size check before the rename', async () => {
    const { writePrivateFile } = await import('../src/audit/export.js');
    const { dir, out, data } = setup();
    const lying = (fd: number, b: Buffer, off: number, len: number) => (nodeFs.writeSync(fd, b, off, Math.ceil(len / 2)), len);
    expect(() => writePrivateFile(out, data, { write: lying })).toThrow(/102400 of 204800 bytes/);
    expect(readFileSync(out, 'utf8')).toBe('old export\n');
    expect(readdirSync(dir)).toEqual(['tracker.csv']);
  });
});

describe('#8 follow-up: temp files left by a killed export are removed by the next one', () => {
  it.skipIf(!POSIX)("a dead pid's temp file is removed; a live pid's and other names are kept", async () => {
    const { writePrivateFile } = await import('../src/audit/export.js');
    const dir = tmp();
    const dead = nodeSpawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    const stale = `.tracker.csv.${dead}.0123456789ab.tmp`;
    const live = `.tracker.csv.${process.pid}.0123456789ab.tmp`;
    const other = `.notes.csv.${dead}.0123456789ab.tmp`;
    for (const n of [stale, live, other]) writeFileSync(join(dir, n), 'tracker rows', { mode: 0o600 });
    writePrivateFile(join(dir, 'tracker.csv'), 'id\n');
    expect(readdirSync(dir).sort()).toEqual([live, other, 'tracker.csv'].sort());
  });
});
