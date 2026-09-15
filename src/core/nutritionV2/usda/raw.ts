/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: bounded raw-record
 * materialization.
 *
 * PURE, platform-neutral. Official USDA download records are larger and deeper
 * than the canonical trusted record (the largest observed pinned Foundation
 * record is ~86 KiB), so the raw transport bound is deliberately SEPARATE from
 * the canonical record bound and the cache-entry bound.
 *
 * This walker produces a brand-new inert plain structure using guarded
 * reflection ONLY. It never invokes accessors, proxy `get`/`has` traps,
 * `toJSON`, `valueOf`, iterators, or coercion. It rejects, without invoking
 * attacker code: accessors/getters/setters, symbol keys, non-enumerable own
 * properties (array `length` excepted), non-plain prototypes (Date/Map/Set/
 * typed arrays/class instances), functions, bigint, symbol, undefined, sparse
 * arrays, cycles, dangerous keys, and `ownKeys`/`getOwnPropertyDescriptor`/
 * `getPrototypeOf` reflection failures.
 *
 * Byte accounting is exact and incremental, so an oversized record is rejected
 * without building a large duplicate representation. Records are never silently
 * truncated. Non-finite numbers are preserved so field validators can emit a
 * specific `invalid_nutrient` rather than a generic structural error.
 */

import { utf8ByteLength } from '../schema';
import {
  MAX_USDA_RAW_ARRAY,
  MAX_USDA_RAW_DEPTH,
  MAX_USDA_RAW_KEYS,
  MAX_USDA_RAW_RECORD_BYTES,
  MAX_USDA_RAW_STRING,
} from './types';

/** Explicit raw-record bounds (independent of the canonical/cache bounds). */
export interface RawRecordBounds {
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxArray: number;
  readonly maxString: number;
  readonly maxBytes: number;
}

export const DEFAULT_RAW_RECORD_BOUNDS: RawRecordBounds = Object.freeze({
  maxDepth: MAX_USDA_RAW_DEPTH,
  maxKeys: MAX_USDA_RAW_KEYS,
  maxArray: MAX_USDA_RAW_ARRAY,
  maxString: MAX_USDA_RAW_STRING,
  maxBytes: MAX_USDA_RAW_RECORD_BYTES,
});

export type RawMaterialization =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/** Incremental UTF-8 byte length of `JSON.stringify(text)` without building it. */
function jsonStringByteLength(text: string, remaining: number): number {
  let bytes = 2;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
    if (bytes > remaining) return -1;
  }
  return bytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

type BuildResult = { ok: true; value: unknown } | { ok: false; reason: string };

function build(
  current: unknown,
  depth: number,
  stack: Set<object>,
  bounds: RawRecordBounds,
  add: (count: number) => boolean
): BuildResult {
  if (depth > bounds.maxDepth) return { ok: false, reason: 'too_deep' };
  if (current === null) {
    if (!add(4)) return { ok: false, reason: 'oversized' };
    return { ok: true, value: null };
  }
  const type = typeof current;
  if (type === 'boolean') {
    if (!add(current ? 4 : 5)) return { ok: false, reason: 'oversized' };
    return { ok: true, value: current };
  }
  if (type === 'number') {
    const numeric = current as number;
    const text = Number.isFinite(numeric) ? String(numeric) : 'null';
    if (!add(text.length)) return { ok: false, reason: 'oversized' };
    return { ok: true, value: numeric };
  }
  if (type === 'string') {
    const text = current as string;
    if (text.length > bounds.maxString) return { ok: false, reason: 'string_too_long' };
    const length = jsonStringByteLength(text, bounds.maxBytes);
    if (length < 0 || !add(length)) return { ok: false, reason: 'oversized' };
    return { ok: true, value: text };
  }
  if (type !== 'object') return { ok: false, reason: 'unsupported_type' };

  const object = current as object;
  if (stack.has(object)) return { ok: false, reason: 'cycle' };
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      if (Object.getPrototypeOf(object) !== Array.prototype) return { ok: false, reason: 'non_plain_array' };
      if (Object.getOwnPropertySymbols(object).length > 0) return { ok: false, reason: 'symbol_key' };
      const lengthDescriptor = Object.getOwnPropertyDescriptor(object, 'length');
      const length =
        lengthDescriptor && 'value' in lengthDescriptor ? (lengthDescriptor.value as number) : -1;
      if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > bounds.maxArray) {
        return { ok: false, reason: 'invalid_array_length' };
      }
      if (Object.getOwnPropertyNames(object).length !== length + 1) return { ok: false, reason: 'unusual_array' };
      if (!add(2)) return { ok: false, reason: 'oversized' };
      const output: unknown[] = [];
      for (let i = 0; i < length; i += 1) {
        if (i > 0 && !add(1)) return { ok: false, reason: 'oversized' };
        const descriptor = Object.getOwnPropertyDescriptor(object, String(i));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          return { ok: false, reason: 'array_accessor_or_hole' };
        }
        const child = build(descriptor.value, depth + 1, stack, bounds, add);
        if (!child.ok) return child;
        output.push(child.value);
      }
      return { ok: true, value: output };
    }

    if (!isPlainObject(object)) return { ok: false, reason: 'non_plain_prototype' };
    if (Object.getOwnPropertySymbols(object).length > 0) return { ok: false, reason: 'symbol_key' };
    const names = Object.getOwnPropertyNames(object);
    if (names.length > bounds.maxKeys) return { ok: false, reason: 'too_many_keys' };
    if (!add(2)) return { ok: false, reason: 'oversized' };
    const output: Record<string, unknown> = {};
    let first = true;
    for (const name of names) {
      if (DANGEROUS_KEYS.has(name)) return { ok: false, reason: 'dangerous_key' };
      if (name.length > bounds.maxString) return { ok: false, reason: 'string_too_long' };
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        return { ok: false, reason: 'accessor_or_hidden_property' };
      }
      if (!first && !add(1)) return { ok: false, reason: 'oversized' };
      first = false;
      const keyLength = jsonStringByteLength(name, bounds.maxBytes);
      if (keyLength < 0 || !add(keyLength)) return { ok: false, reason: 'oversized' };
      if (!add(1)) return { ok: false, reason: 'oversized' };
      const child = build(descriptor.value, depth + 1, stack, bounds, add);
      if (!child.ok) return child;
      output[name] = child.value;
    }
    return { ok: true, value: output };
  } finally {
    stack.delete(object);
  }
}

/**
 * Materializes one untrusted raw record into an inert plain structure within the
 * given raw bounds. Never throws; reflection/proxy failures return a fixed
 * reason. The original object is never revisited after this pass.
 */
export function materializeRawRecord(
  value: unknown,
  bounds: RawRecordBounds = DEFAULT_RAW_RECORD_BOUNDS
): RawMaterialization {
  let bytes = 0;
  const add = (count: number): boolean => {
    bytes += count;
    return bytes <= bounds.maxBytes;
  };
  try {
    const result = build(value, 0, new Set(), bounds, add);
    if (result.ok) return { ok: true, value: result.value };
    return { ok: false, reason: (result as { ok: false; reason: string }).reason };
  } catch {
    return { ok: false, reason: 'reflection_failed' };
  }
}

/** UTF-8 byte length helper re-exported for census/tests. */
export { utf8ByteLength };
