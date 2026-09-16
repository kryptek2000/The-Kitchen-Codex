/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: bounded streaming JSON array reader.
 *
 * BUILD-TIME / OFFLINE ONLY. Reads the exact pinned USDA top-level JSON envelope
 * and yields one complete root-array entry at a time as its exact JSON substring.
 * The whole archive is never parsed into one in-memory object; each entry is
 * parsed individually by the caller and released immediately after adaptation.
 *
 * It rejects, without source evaluation: an unexpected/multiple root key, an
 * invalid root structure, trailing non-whitespace, truncated JSON, malformed
 * syntax, and any entry whose UTF-8 byte length exceeds the configured bound.
 * The scanner correctly handles braces/brackets inside strings, escaped quotes
 * and backslashes, Unicode escapes, nested objects/arrays, and whitespace.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { utf8ByteLength } from '../../src/core/nutritionV2/schema';

const READ_CHUNK_BYTES = 1 << 20;

export type StreamJsonErrorCode =
  | 'unexpected_eof'
  | 'invalid_root_key'
  | 'unexpected_root_key'
  | 'multiple_root_keys'
  | 'invalid_root_structure'
  | 'invalid_object'
  | 'invalid_array'
  | 'invalid_string'
  | 'entry_too_large'
  | 'trailing_garbage'
  | 'empty_root'
  | 'read_failed';

export class StreamJsonError extends Error {
  readonly code: StreamJsonErrorCode;
  constructor(code: StreamJsonErrorCode) {
    super(`usda_stream_json_failed:${code}`);
    this.name = 'StreamJsonError';
    this.code = code;
  }
}

function fail(code: StreamJsonErrorCode): never {
  throw new StreamJsonError(code);
}

class CharStream {
  private readonly fd: number;
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private pos = 0;
  private eof = false;
  private closed = false;

  constructor(filePath: string) {
    this.fd = openSync(filePath, 'r');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } catch {
      /* fixed, bounded */
    }
  }

  private fill(): void {
    while (!this.eof && this.pos >= this.buffer.length) {
      this.buffer = '';
      this.pos = 0;
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let n: number;
      try {
        n = readSync(this.fd, chunk, 0, READ_CHUNK_BYTES, null);
      } catch {
        fail('read_failed');
      }
      if (n <= 0) {
        this.eof = true;
        this.buffer = this.decoder.end();
        break;
      }
      this.buffer = this.decoder.write(chunk.subarray(0, n));
    }
  }

  peek(): string | null {
    if (this.pos >= this.buffer.length) this.fill();
    return this.pos < this.buffer.length ? this.buffer[this.pos] : null;
  }

  next(): string | null {
    const ch = this.peek();
    if (ch !== null) this.pos += 1;
    return ch;
  }
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function skipWhitespace(stream: CharStream): void {
  while (true) {
    const ch = stream.peek();
    if (ch === null || !isWhitespace(ch)) return;
    stream.next();
  }
}

function expect(stream: CharStream, expected: string, code: StreamJsonErrorCode): void {
  const ch = stream.next();
  if (ch !== expected) fail(code);
}

function readStringLiteral(stream: CharStream): string {
  const parts: string[] = [];
  const opening = stream.next();
  if (opening !== '"') fail('invalid_string');
  parts.push('"');
  let escape = false;
  while (true) {
    const ch = stream.next();
    if (ch === null) fail('unexpected_eof');
    parts.push(ch);
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') break;
  }
  try {
    const parsed = JSON.parse(parts.join(''));
    if (typeof parsed !== 'string') fail('invalid_string');
    return parsed;
  } catch {
    fail('invalid_string');
  }
}

function readValueRaw(stream: CharStream, maxEntryBytes: number): string {
  const parts: string[] = [];
  let units = 0;
  const push = (ch: string): void => {
    parts.push(ch);
    units += 1;
    if (units > maxEntryBytes) fail('entry_too_large');
  };

  const first = stream.peek();
  if (first === null) fail('unexpected_eof');

  if (first === '{' || first === '[') {
    let depth = 0;
    let inString = false;
    let escape = false;
    while (true) {
      const ch = stream.next();
      if (ch === null) fail('unexpected_eof');
      push(ch);
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
  } else if (first === '"') {
    // Consume the opening quote, then scan to the matching closing quote.
    push(stream.next() as string);
    let escape = false;
    while (true) {
      const ch = stream.next();
      if (ch === null) fail('unexpected_eof');
      push(ch);
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') escape = true;
      else if (ch === '"') break;
    }
  } else {
    while (true) {
      const ch = stream.peek();
      if (ch === null) break;
      if (ch === ',' || ch === ']' || ch === '}' || isWhitespace(ch)) break;
      push(stream.next() as string);
    }
  }

  const raw = parts.join('');
  if (utf8ByteLength(raw) > maxEntryBytes) fail('entry_too_large');
  return raw;
}

/**
 * Yields the exact JSON substring of every entry in the single expected root
 * array. The caller parses one entry at a time. Throws a fixed `StreamJsonError`
 * on any structural failure.
 */
export function* streamRootArray(
  filePath: string,
  rootKey: string,
  maxEntryBytes: number
): Generator<string> {
  const stream = new CharStream(filePath);
  try {
    skipWhitespace(stream);
    expect(stream, '{', 'invalid_root_structure');
    skipWhitespace(stream);
    const first = stream.peek();
    if (first === '}') fail('empty_root');
    if (first !== '"') fail('invalid_root_key');
    const key = readStringLiteral(stream);
    if (key !== rootKey) fail('unexpected_root_key');
    skipWhitespace(stream);
    expect(stream, ':', 'invalid_root_structure');
    skipWhitespace(stream);
    expect(stream, '[', 'invalid_root_structure');

    skipWhitespace(stream);
    if (stream.peek() === ']') {
      stream.next();
    } else {
      while (true) {
        yield readValueRaw(stream, maxEntryBytes);
        skipWhitespace(stream);
        const sep = stream.peek();
        if (sep === ',') {
          stream.next();
          skipWhitespace(stream);
          continue;
        }
        if (sep === ']') {
          stream.next();
          break;
        }
        fail('invalid_array');
      }
    }

    skipWhitespace(stream);
    const afterArray = stream.peek();
    if (afterArray === ',') fail('multiple_root_keys');
    if (afterArray !== '}') fail('invalid_object');
    stream.next();
    skipWhitespace(stream);
    if (stream.peek() !== null) fail('trailing_garbage');
  } finally {
    stream.close();
  }
}
