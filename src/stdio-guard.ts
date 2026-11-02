/**
 * P2-05 / F11 (0.6.1): one stdin line over the SDK's 10 MiB ReadBuffer made
 * the stdio server log "ReadBuffer exceeded", close the transport and exit 0,
 * with no JSON-RPC error; the client waited to its timeout. A schema-valid
 * call can get there (a body of control characters is 6× larger once
 * JSON-escaped).
 *
 * This Transform sits between stdin and the SDK's StdioServerTransport and
 * hands it complete lines only. A line longer than `maxLineBytes` is
 * discarded as it streams (never buffered whole) and answered with a JSON-RPC
 * error carrying the request's id when it can be read from the line's first
 * bytes; the connection stays up for the next message.
 */

import { Transform, type TransformCallback } from 'node:stream';

/** The SDK's own stdio limit (STDIO_DEFAULT_MAX_BUFFER_SIZE). */
export const MAX_STDIO_LINE_BYTES = 10 * 1024 * 1024;
/** How much of an oversized line is kept to find its id. */
const HEAD_BYTES = 4096;
const NL = 0x0a;

/** The JSON-RPC id from the start of a (truncated) request line, or undefined. */
export function idFromHead(head: string): string | number | null | undefined {
  // Requests are serialized with "id" near the start; a nested "id" key would come after "params", so stop there.
  const before = head.split(/"params"\s*:/)[0]!;
  const m = /"id"\s*:\s*(-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.){0,256}"|null)\s*[,}]/.exec(before);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]!) as string | number | null;
  } catch {
    return undefined;
  }
}

export class StdioLineGuard extends Transform {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private dropping = false;
  private head = '';
  private dropped = 0;

  constructor(
    private readonly respond: (line: string) => void,
    private readonly log: (msg: string) => void,
    private readonly maxLineBytes = MAX_STDIO_LINE_BYTES,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    let start = 0;
    const out: Buffer[] = [];
    while (start < chunk.length) {
      const nl = chunk.indexOf(NL, start);
      const end = nl === -1 ? chunk.length : nl;
      this.absorb(chunk.subarray(start, end));
      if (nl === -1) break;
      if (this.dropping) this.answerOversized();
      else {
        out.push(...this.pending, Buffer.from([NL]));
      }
      this.pending = [];
      this.pendingBytes = 0;
      start = nl + 1;
    }
    if (out.length > 0) this.push(Buffer.concat(out));
    done();
  }

  private absorb(seg: Buffer): void {
    if (seg.length === 0) return;
    if (this.dropping) {
      this.dropped += seg.length;
      return;
    }
    this.pending.push(seg);
    this.pendingBytes += seg.length;
    if (this.pendingBytes > this.maxLineBytes) {
      this.head = Buffer.concat(this.pending).subarray(0, HEAD_BYTES).toString('utf8');
      this.dropped = this.pendingBytes;
      this.pending = [];
      this.pendingBytes = 0;
      this.dropping = true;
    }
  }

  private answerOversized(): void {
    const id = idFromHead(this.head);
    const message = `message of ${this.dropped} bytes exceeds the ${this.maxLineBytes}-byte stdio limit; it was discarded and the connection is still open`;
    this.log(`sea-lite: ${message}${id === undefined ? ' (no request id found; nothing to answer)' : ''}`);
    if (id !== undefined && id !== null) {
      this.respond(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32600, message, data: { bytes: this.dropped, limit: this.maxLineBytes } } }) + '\n');
    }
    this.dropping = false;
    this.head = '';
    this.dropped = 0;
  }

  override _flush(done: TransformCallback): void {
    if (this.dropping) this.answerOversized();
    else if (this.pendingBytes > 0) this.push(Buffer.concat(this.pending)); // a last line without "\n": the SDK decides
    done();
  }
}
