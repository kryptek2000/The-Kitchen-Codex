/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: narrow hostile-input materialization.
 *
 * PURE, offline. Phase 4 must NEVER read an untrusted recipe/ingredient property
 * before it has been materialized once into inert data. These helpers read ONLY
 * explicitly requested own enumerable DATA properties (never invoking an
 * accessor) and reuse the Phase 0 descriptor-based materializer (`toInertValue`)
 * so accessors/getters/setters, proxies/reflection failures, symbols, sparse
 * arrays, cycles, non-plain prototypes, functions, bigints, undefined-own fields,
 * dangerous keys, and oversized values fail closed with fixed, bounded,
 * input-redacted classifications.
 *
 * The recipe envelope is read NARROWLY: unrelated recipe fields (full Markdown,
 * file handles, frontmatter, platform objects) are never touched or materialized.
 */

import { DANGEROUS_KEYS, toInertValue } from '../schema';

export type FieldRead = { ok: true; present: boolean; value: unknown } | { ok: false };

/**
 * Reads one own enumerable DATA property. A missing property is reported as
 * absent; an accessor, a non-enumerable own property, or a reflection failure is
 * reported as unsafe WITHOUT invoking any getter/setter or proxy `get` trap.
 */
export function readOwnDataField(object: object, key: string): FieldRead {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    return { ok: false };
  }
  if (!descriptor) return { ok: true, present: false, value: undefined };
  if (!('value' in descriptor)) return { ok: false };
  if (descriptor.enumerable !== true) return { ok: false };
  return { ok: true, present: true, value: descriptor.value };
}

/** True when the object carries any own symbol key (or reflection fails). */
export function hasSymbolKeys(object: object): boolean {
  try {
    return Object.getOwnPropertySymbols(object).length > 0;
  } catch {
    return true;
  }
}

/** True when any own property name is a dangerous key (or reflection fails). */
export function hasDangerousOwnKey(object: object): boolean {
  try {
    return Object.getOwnPropertyNames(object).some((name) => DANGEROUS_KEYS.has(name));
  } catch {
    return true;
  }
}

/** Materializer failure reasons that indicate hostile/unsupported input. */
const UNSAFE_REASONS: ReadonlySet<string> = new Set([
  'dangerous_key',
  'accessor_or_hidden_property',
  'array_accessor_or_hole',
  'reflection_failed',
  'cycle',
  'symbol_key',
  'non_plain_prototype',
  'non_plain_array',
  'unsupported_type',
  'unusual_array',
  'invalid_array_length',
]);

export type NarrowMaterialization =
  | { ok: true; unsafe: false; value: unknown }
  | { ok: false; unsafe: boolean };

/**
 * Materializes one untrusted value once into inert bounded data using the
 * established Phase 0 materializer. Never throws and never invokes attacker
 * code. `unsafe` distinguishes hostile/unsupported input from ordinary
 * structural/oversized invalidity.
 */
export function materializeNarrow(value: unknown): NarrowMaterialization {
  const result = toInertValue(value);
  if (result.ok) return { ok: true, unsafe: false, value: result.value };
  const reason = (result as { ok: false; reason: string }).reason;
  return { ok: false, unsafe: UNSAFE_REASONS.has(reason) };
}
