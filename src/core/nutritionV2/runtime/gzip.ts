/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: bounded, browser-native
 * gzip decoding.
 *
 * PURE, platform-neutral, OFFLINE. It imports NOTHING: no Node `zlib`/`Buffer`/
 * `fs`, no React, application, browser, filesystem, child-process, ZIP, Python,
 * server, provider, vault, or persistence module. Decompression uses the
 * web-standard `DecompressionStream('gzip')` when the runtime provides it.
 *
 * SAFETY
 * ------
 * `decodeBoundedGzip` enforces an INDEPENDENT incremental uncompressed-byte
 * ceiling (never trusting a declared length), rejects a malformed gzip header,
 * rejects trailing bytes after the member (the decoder errors), and throws a
 * fixed `GzipDecodeError` with a closed reason. It never echoes input bytes,
 * sizes, or exception text.
 *
 * A concatenated gzip member is NOT rejected by the decoder itself; the caller
 * rejects it by verifying the exact locked uncompressed length and SHA-256.
 */

export type GzipDecodeReason = 'unsupported' | 'malformed' | 'bound_exceeded';

/** Fixed, bounded gzip decode failure. Never carries input or exception text. */
export class GzipDecodeError extends Error {
  readonly reason: GzipDecodeReason;
  constructor(reason: GzipDecodeReason) {
    super(reason);
    this.name = 'GzipDecodeError';
    this.reason = reason;
  }
}

/** True when the runtime exposes the required safe gzip decompression capability. */
export function hasGzipDecodeCapability(): boolean {
  return typeof (globalThis as { DecompressionStream?: unknown }).DecompressionStream === 'function';
}

/**
 * Decompresses one complete gzip member with an incremental output ceiling.
 * Throws a `GzipDecodeError` (fixed reason) on failure; returns the exact bytes
 * on success. Never returns more than `maxBytes` bytes.
 */
export async function decodeBoundedGzip(
  compressed: Uint8Array,
  maxBytes: number
): Promise<Uint8Array> {
  if (!(compressed instanceof Uint8Array)) throw new GzipDecodeError('malformed');
  // Minimum member: 10-byte header + empty deflate stream + 8-byte trailer.
  if (compressed.length < 18) throw new GzipDecodeError('malformed');
  // Fixed gzip magic + deflate method + reserved FLG bits clear.
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b || compressed[2] !== 0x08) {
    throw new GzipDecodeError('malformed');
  }
  if ((compressed[3] & 0xe0) !== 0) throw new GzipDecodeError('malformed');

  if (!hasGzipDecodeCapability()) throw new GzipDecodeError('unsupported');

  let stream: DecompressionStream;
  try {
    stream = new DecompressionStream('gzip');
  } catch {
    throw new GzipDecodeError('unsupported');
  }

  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  // Write concurrently with reading so backpressure cannot deadlock a large
  // single-chunk input.
  const writePromise = (async () => {
    try {
      await writer.write(compressed as unknown as BufferSource);
      await writer.close();
    } catch {
      // The read side surfaces the same failure; nothing to do here.
    }
  })();

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new GzipDecodeError('malformed');
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // best-effort cancellation
        }
        throw new GzipDecodeError('bound_exceeded');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GzipDecodeError) throw error;
    throw new GzipDecodeError('malformed');
  } finally {
    await writePromise.catch(() => undefined);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Strict UTF-8 decode. Returns a fixed failure (never the decoder message) for
 * invalid or truncated UTF-8. Uses the web-standard `TextDecoder`.
 */
export function decodeUtf8Strict(bytes: Uint8Array): { ok: true; text: string } | { ok: false } {
  if (typeof TextDecoder !== 'function') return { ok: false };
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return { ok: true, text: decoder.decode(bytes) };
  } catch {
    return { ok: false };
  }
}
