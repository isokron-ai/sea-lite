/**
 * Tracker export (CSV, XLSX) and findings.csv import parsing, with no new
 * dependency: CSV is RFC 4180; XLSX is a minimal SpreadsheetML package
 * (inline strings, one sheet, header style, frozen header, autofilter and the
 * status dropdown) zipped with node:zlib's raw deflate. Why not a library:
 * sea-lite keeps runtime dependencies minimal (CONTRIBUTING), and the common
 * xlsx writers are 0.5–1 MB with transitive deps for a feature this narrow.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { SeaError } from '../core/errors.js';
import { TRACKER_STATUSES } from './fields.js';

// ───────────────────────────── CSV ─────────────────────────────

/**
 * why: findings quote vendor-controlled text; a cell whose first non-space
 * character is = + - @ (or their fullwidth forms), or that starts with a tab
 * or CR, can run as a formula when the CSV is opened in a spreadsheet (some
 * importers trim leading spaces first). Such cells get a leading apostrophe
 * (OWASP CSV injection). A cell that already starts with an apostrophe in
 * front of one gets another, so `unguardCell` undoes exactly one level and
 * export → import round-trips.
 */
const FORMULA_START = /^[=+\-@\uff1d\uff0b\uff0d\uff20]/;
function needsGuard(v: string): boolean {
  if (/^[\t\r]/.test(v)) return true;
  if (FORMULA_START.test(v.replace(/^[\s\u180e\u200b]+/u, ''))) return true;
  return v.startsWith("'") && needsGuard(v.slice(1));
}

export function guardCell(v: string): string {
  return needsGuard(v) ? `'${v}` : v;
}

/** Inverse of guardCell. */
export function unguardCell(v: string): string {
  return v.startsWith("'") && needsGuard(v.slice(1)) ? v.slice(1) : v;
}

function csvCell(v: string): string {
  const s = guardCell(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: readonly string[], rows: readonly Record<string, string>[]): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c] ?? '')).join(','));
  return lines.join('\r\n') + '\r\n';
}

/**
 * Strict RFC 4180 parse (quoted fields, "" escapes, CRLF or LF, optional
 * BOM) into header-keyed rows. Errors name the 1-based line of the record:
 * an unterminated quote, text after a closing quote, a record with more or
 * fewer cells than the header, a duplicate or empty header name.
 */
export function parseCsv(text: string): { header: string[]; rows: Record<string, string>[]; lines: number[] } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: { cells: string[]; line: number }[] = [];
  let rec: string[] = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  let recLine = 1;
  let quoteLine = 1;
  const bad = (msg: string, at: number) => new SeaError('invalid_input', `CSV row ${at}: ${msg}`, { row: at });
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        afterQuote = true;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && cell === '' && !afterQuote) {
      quoted = true;
      quoteLine = recLine;
    } else if (ch === ',') {
      rec.push(cell);
      cell = '';
      afterQuote = false;
    } else if (ch === '\n' || ch === '\r') {
      rec.push(cell);
      cell = '';
      afterQuote = false;
      records.push({ cells: rec, line: recLine });
      rec = [];
      if (ch === '\r' && src[i + 1] === '\n') i++;
      line++;
      recLine = line;
    } else if (afterQuote) {
      throw bad('text after a closing quote', recLine);
    } else cell += ch;
    i++;
  }
  if (quoted) throw bad('unterminated quoted field', quoteLine);
  if (cell !== '' || rec.length > 0) {
    rec.push(cell);
    records.push({ cells: rec, line: recLine });
  }
  const nonEmpty = records.filter((r) => !(r.cells.length === 1 && r.cells[0] === ''));
  const head = nonEmpty.shift();
  const header = (head?.cells ?? []).map((h) => h.trim());
  const seen = new Set<string>();
  for (const h of header) {
    if (h === '') throw bad('empty column name in the header', head?.line ?? 1);
    if (seen.has(h)) throw bad(`duplicate column "${h}"`, head?.line ?? 1);
    seen.add(h);
  }
  for (const r of nonEmpty) if (r.cells.length !== header.length) throw bad(`${r.cells.length} cells, header has ${header.length}`, r.line);
  return {
    header,
    rows: nonEmpty.map((r) => Object.fromEntries(header.map((h, k) => [h, unguardCell(r.cells[k] ?? '')]))),
    lines: nonEmpty.map((r) => r.line),
  };
}

// ───────────────────────────── XLSX ─────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive (deflate, no zip64: fine below 4 GiB). Fixed 1980-01-01 timestamps, so output is deterministic. */
export function zip(files: readonly { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const body = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

function xml(s: string): string {
  // why: XML 1.0 forbids most C0 controls even escaped; drop them.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Column widths of the PostHog tracker (mk3.py); others 14, gate columns 30. */
const WIDTHS: Record<string, number> = {
  id: 6,
  source_pass: 12,
  title: 36,
  verdict: 12,
  confidence: 9,
  merged_into: 9,
  submit_plan: 22,
  component: 14,
  root_cause: 30,
  affected_count: 10,
  summary: 50,
  evidence: 40,
  measured_impact: 28,
  proposed_fix: 40,
  fix_difficulty: 10,
};
/** Cells a human fills in (yellow in the tracker). */
const INPUT_COLUMNS = new Set(['our PR/issue #', 'submitted date', 'status']);
/** Excel's limit per cell. */
const MAX_CELL = 32_767;

export function toXlsx(columns: readonly string[], rows: readonly Record<string, string>[], sheet = 'Findings'): Buffer {
  const last = colName(columns.length - 1);
  const n = rows.length + 1;
  const cell = (ref: string, v: string, style: number) =>
    v === '' && style === 0 ? '' : `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xml(v.slice(0, MAX_CELL))}</t></is></c>`;
  const header = `<row r="1">${columns.map((c, i) => cell(`${colName(i)}1`, c, 1)).join('')}</row>`;
  const body = rows
    .map((r, k) => `<row r="${k + 2}">${columns.map((c, i) => cell(`${colName(i)}${k + 2}`, r[c] ?? '', INPUT_COLUMNS.has(c) ? 3 : 2)).join('')}</row>`)
    .join('');
  const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${WIDTHS[c] ?? (c.startsWith('gate') ? 30 : 14)}" customWidth="1"/>`).join('');
  const st = columns.indexOf('status');
  const validation =
    st >= 0 && rows.length > 0
      ? `<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="${colName(st)}2:${colName(st)}${n}"><formula1>"${xml(TRACKER_STATUSES.join(','))}"</formula1></dataValidation></dataValidations>`
      : '';
  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane xSplit="3" ySplit="1" topLeftCell="D2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${cols}</cols><sheetData>${header}${body}</sheetData><autoFilter ref="A1:${last}${n}"/>${validation}</worksheet>`;
  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="3"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><sz val="9"/><name val="Arial"/></font></fonts>` +
    `<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill></fills>` +
    `<borders count="2"><border/><border><bottom style="thin"><color rgb="FFC9CED6"/></bottom></border></borders>` +
    `<cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf/>` +
    `<xf fontId="1" fillId="2" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>` +
    `<xf fontId="2" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>` +
    `<xf fontId="2" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheet.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xml(sheet.slice(0, 31))}'!$A$1:$${last}$${n}</definedName></definedNames></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
    { name: 'xl/styles.xml', data: styles },
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf8') })));
}

/** Fresh temp names tried before giving up (a name that exists is someone else's file). */
const TEMP_ATTEMPTS = 8;

/**
 * Write `data` to `file` with mode 0600, never through anything planted there
 * (#6, #8). A tracker carries unreported vulnerabilities, so it goes to a
 * fresh temp file next to `file`, created with O_EXCL | O_NOFOLLOW (an
 * existing file or link at the temp name is never opened: another name is
 * tried), then renamed over `file`, which replaces a planted symlink or hard
 * link instead of writing through it. `file` being a directory is
 * `invalid_input`, and any failure after the temp file exists removes it.
 */
export function writePrivateFile(
  file: string,
  data: string | Buffer,
  opts: { tmpName?: () => string; write?: (fd: number, buf: Buffer, offset: number, length: number) => number } = {},
): void {
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(file);
  } catch {
    /* absent: fine */
  }
  if (st?.isDirectory()) throw new SeaError('invalid_input', `--out ${file} is a directory; give a file path`, { path: file });
  removeStaleTemps(file);
  const tmpName = opts.tmpName ?? (() => join(dirname(resolve(file)), `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`));
  let tmp = '';
  let fd: number | null = null;
  for (let i = 0; fd === null; i++) {
    tmp = tmpName();
    try {
      fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i + 1 >= TEMP_ATTEMPTS) throw e;
    }
  }
  try {
    try {
      // #8 review: one writeSync can write less than asked (a full disk wrote 64 KB of 200 KB and the
      // truncated file replaced the export). Every byte is written, flushed and counted before the rename.
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      const write = opts.write ?? ((f: number, b: Buffer, o: number, l: number) => writeSync(f, b, o, l));
      for (let off = 0; off < buf.length; ) {
        const n = write(fd, buf, off, buf.length - off);
        if (!(n > 0)) throw new Error(`writing ${tmp}: no progress at byte ${off} of ${buf.length}`);
        off += n;
      }
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
      const size = fstatSync(fd).size;
      if (size !== buf.length) throw new Error(`writing ${tmp}: ${size} of ${buf.length} bytes reached the file`);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    const code = (e as NodeJS.ErrnoException).code;
    // why: a directory that appeared after the check (EPERM is Windows' answer).
    if (code === 'EISDIR' || code === 'EPERM') {
      throw new SeaError('invalid_input', `--out ${file}: could not replace it (${code}); is it a directory?`, { path: file, code });
    }
    throw e;
  }
}

/**
 * #8 review: an export killed mid-write (SIGKILL) leaves `.<name>.<pid>.<hex>.tmp`
 * holding part of the tracker. The next export to the same path removes such
 * files whose pid is no longer running (regular files only; nothing else).
 */
function removeStaleTemps(file: string): void {
  const dir = dirname(resolve(file));
  const prefix = `.${basename(file)}.`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const m = /^(\d{1,10})\.[0-9a-f]{12}\.tmp$/.exec(n.slice(prefix.length));
    if (!m || Number(m[1]) === process.pid || pidAlive(Number(m[1]))) continue;
    try {
      if (lstatSync(join(dir, n)).isFile()) unlinkSync(join(dir, n));
    } catch {
      /* gone already, or not ours to remove */
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // why: alive, owned by someone else
  }
}
