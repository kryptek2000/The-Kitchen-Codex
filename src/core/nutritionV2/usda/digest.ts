/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: pure deterministic digests
 * and STRICT canonical serialization.
 *
 * PURE, platform-neutral, SYNCHRONOUS. No DOM, no Node builtins, no network,
 * no `globalThis.crypto` (which is async and not guaranteed across surfaces).
 *
 * STRICT CANONICAL SERIALIZATION (audit repair)
 * ---------------------------------------------
 * Canonical identity (bundle identity, canonical record digest, content digest)
 * must never alias distinct authoritative inputs. The previous serializer
 * silently converted unsupported values to `null` (so `{a: undefined}` aliased
 * `{a: null}`) and serialized `-0` as `0`. `canonicalStringify` now FAILS CLOSED
 * on any unsupported value and never substitutes `null`.
 *
 * It rejects, without invoking attacker code: `undefined`, `-0`, `NaN`,
 * `Infinity`, bigint, symbol, function, accessors, symbol keys, sparse arrays,
 * non-enumerable/hidden properties, non-plain prototypes (Date/Map/Set/typed
 * arrays/class instances), cycles, dangerous keys (`__proto__`/`prototype`/
 * `constructor`), and hostile proxies/reflection failures.
 *
 * `null` serializes only when it was explicitly present. Object keys are sorted
 * with a locale-independent (UTF-16 code-unit) rule; arrays preserve order.
 * Strings preserve exact code-unit content and are escaped exactly as
 * `JSON.stringify` escapes them (including lone surrogates); no implicit Unicode
 * normalization is applied. `1` and `1.0` are the same JS number and are not
 * distinguished. Numeric strings are never stringified as numbers.
 */

/** Fixed, bounded, input-redacted canonical-serialization failure. */
export class CanonicalSerializationError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`canonical_serialization_failed:${reason}`);
    this.name = 'CanonicalSerializationError';
    this.reason = reason;
  }
}

/** Keys that could enable prototype pollution; always rejected. */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

function serialize(value: unknown, stack: Set<object>): string {
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    const numeric = value as number;
    if (!Number.isFinite(numeric)) throw new CanonicalSerializationError('non_finite_number');
    if (Object.is(numeric, -0)) throw new CanonicalSerializationError('negative_zero');
    return String(numeric);
  }
  if (type === 'string') return JSON.stringify(value);
  if (type !== 'object') throw new CanonicalSerializationError('unsupported_type');

  const object = value as object;
  if (stack.has(object)) throw new CanonicalSerializationError('cycle');
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      if (Object.getPrototypeOf(object) !== Array.prototype) {
        throw new CanonicalSerializationError('non_plain_array');
      }
      if (Object.getOwnPropertySymbols(object).length > 0) {
        throw new CanonicalSerializationError('symbol_key');
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(object, 'length');
      const length =
        lengthDescriptor && 'value' in lengthDescriptor ? (lengthDescriptor.value as number) : -1;
      if (!Number.isInteger(length) || length < 0) {
        throw new CanonicalSerializationError('invalid_array_length');
      }
      if (Object.getOwnPropertyNames(object).length !== length + 1) {
        throw new CanonicalSerializationError('unusual_array');
      }
      const parts: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new CanonicalSerializationError('array_hole_or_accessor');
        }
        parts.push(serialize(descriptor.value, stack));
      }
      return `[${parts.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalSerializationError('non_plain_prototype');
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw new CanonicalSerializationError('symbol_key');
    }
    const names = Object.getOwnPropertyNames(object);
    const keys: string[] = [];
    for (const name of names) {
      if (DANGEROUS_KEYS.has(name)) throw new CanonicalSerializationError('dangerous_key');
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new CanonicalSerializationError('accessor_or_hidden_property');
      }
      keys.push(name);
    }
    keys.sort();
    const parts: string[] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key) as PropertyDescriptor;
      parts.push(`${JSON.stringify(key)}:${serialize(descriptor.value, stack)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    stack.delete(object);
  }
}

/**
 * Strict, deterministic, fail-closed canonical JSON serialization. Throws a
 * `CanonicalSerializationError` (fixed bounded reason) on any unsupported value.
 * Never invokes getters, `toJSON`, `valueOf`, iterators, or coercion.
 */
export function canonicalStringify(value: unknown): string {
  return serialize(value, new Set());
}

/** Non-throwing wrapper: returns a fixed bounded reason instead of throwing. */
export type CanonicalStringifyResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

export function tryCanonicalStringify(value: unknown): CanonicalStringifyResult {
  try {
    return { ok: true, value: canonicalStringify(value) };
  } catch (error) {
    if (error instanceof CanonicalSerializationError) return { ok: false, reason: error.reason };
    return { ok: false, reason: 'serialization_error' };
  }
}

// ---------------------------------------------------------------------------
// SHA-256 (unchanged, verified against standard vectors)
// ---------------------------------------------------------------------------

/** Round constants (first 32 bits of the fractional parts of the cube roots of the first 64 primes). */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * Encodes a string to UTF-8 bytes with a pure fallback. Lone surrogates are
 * encoded as U+FFFD, matching `TextEncoder`.
 */
export function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        const point = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        bytes.push(
          0xf0 | (point >> 18),
          0x80 | ((point >> 12) & 0x3f),
          0x80 | ((point >> 6) & 0x3f),
          0x80 | (point & 0x3f)
        );
        i += 1;
      } else {
        bytes.push(0xef, 0xbf, 0xbd);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes.push(0xef, 0xbf, 0xbd);
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return Uint8Array.from(bytes);
}

/** Lowercase hexadecimal SHA-256 of a byte buffer. Never throws. */
export function sha256HexFromBytes(input: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const length = input.length;
  const bitLength = length * 8;
  const remainder = (length + 9) % 64;
  const zeroPad = remainder === 0 ? 0 : 64 - remainder;
  const total = length + 9 + zeroPad;
  const buffer = new Uint8Array(total);
  buffer.set(input, 0);
  buffer[length] = 0x80;

  const hi = Math.floor(bitLength / 0x100000000);
  const lo = bitLength >>> 0;
  buffer[total - 8] = (hi >>> 24) & 0xff;
  buffer[total - 7] = (hi >>> 16) & 0xff;
  buffer[total - 6] = (hi >>> 8) & 0xff;
  buffer[total - 5] = hi & 0xff;
  buffer[total - 4] = (lo >>> 24) & 0xff;
  buffer[total - 3] = (lo >>> 16) & 0xff;
  buffer[total - 2] = (lo >>> 8) & 0xff;
  buffer[total - 1] = lo & 0xff;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] =
        ((buffer[j] << 24) | (buffer[j + 1] << 16) | (buffer[j + 2] << 8) | buffer[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += h[i].toString(16).padStart(8, '0');
  }
  return out;
}

/** Lowercase hexadecimal SHA-256 of a string's UTF-8 bytes. Never throws. */
export function sha256Hex(text: string): string {
  return sha256HexFromBytes(utf8Encode(text));
}

/** Re-export for callers that need the dangerous-key set. */
export { DANGEROUS_KEYS as CANONICAL_DANGEROUS_KEYS };
