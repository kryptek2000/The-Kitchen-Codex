/**
 * The Kitchen Codex — Advanced Nutrition v1: canonical schema types & bounds.
 *
 * PURE, platform-neutral. This is the v0.10.0 Phase 0 contract for the
 * namespaced `codex_nutrition` frontmatter block. It stores ENTIRE-RECIPE
 * TOTALS only (`basis: 'total'`); per-serving values are always derived at
 * display time from the totals and the serving denominator.
 *
 * HARD RULES
 * ----------
 *  - `basis` MUST be `'total'` in schema v1; `'per_serving'` is rejected.
 *  - `%DV` is NEVER persisted (derived from the pinned standard at runtime).
 *  - `nutrient_scope` is the CLOSED, nonempty set of registered nutrients the
 *    calculation attempted to establish. `complete` requires every scoped
 *    nutrient to be present with exact complete coverage; an empty nutrient map
 *    can never claim complete.
 *  - A missing nutrient is ABSENT, never zero. An explicitly source-reported
 *    zero is a present entry with `amount: 0` and complete coverage.
 *  - Coverage counts are validated UNCONDITIONALLY: finite safe integers,
 *    non-negative covered, strictly positive measurable, covered <= measurable,
 *    and coverage exactly equal to `covered / measurable` (no epsilon).
 *  - Negative zero (`-0`) is rejected in every authoritative numeric position;
 *    it is never silently normalized to positive zero.
 *  - `extensions` is a bounded, NON-authoritative namespace; it never
 *    influences calculation, authorization, or trusted display.
 *  - An unknown future `schema` is preserved ONLY as bounded opaque safe data.
 *  - Validation of untrusted programmatic values NEVER invokes getters/setters,
 *    `toJSON`, `valueOf`, `in`, spread, `Object.assign`, `.map`, or coercion;
 *    it uses a single descriptor-based materialization pass and fails closed.
 */

import { NUTRIENT_IDS, type NutrientId } from './nutrients';
import type { CanonicalUnit } from './units';

export const CODEX_NUTRITION_SCHEMA_V1 = 1;
export const CODEX_NUTRITION_BASIS_TOTAL = 'total';
export const CODEX_NUTRITION_FRONTMATTER_KEY = 'codex_nutrition';

/** Mixed authoritative sources; each contribution stays traceable. */
export type NutritionSourceId = 'usda_fdc' | 'open_food_facts' | 'curated_reference' | 'user_manual';

export const NUTRITION_SOURCE_IDS: ReadonlyArray<NutritionSourceId> = Object.freeze([
  'usda_fdc',
  'open_food_facts',
  'curated_reference',
  'user_manual',
]);

/**
 * Sources that are backed by an external dataset/reference release and MUST
 * declare a bounded `source_releases` entry. `user_manual` is NOT dataset-backed
 * and MUST NOT declare (or impersonate) a dataset release.
 */
export const DATASET_BACKED_SOURCE_IDS: ReadonlyArray<NutritionSourceId> = Object.freeze([
  'usda_fdc',
  'open_food_facts',
  'curated_reference',
]);

/**
 * Fixed, server-owned release marker for `user_manual` evidence. It is not a
 * dataset release and cannot impersonate a USDA/OFF release.
 */
export const USER_MANUAL_RELEASE_ID = 'user_manual';

export type NutritionBlockStatus = 'complete' | 'partial' | 'stale' | 'unresolved';

/** Per-nutrient coverage; distinguishes complete / partial / source-zero. */
export interface NutrientCoverage {
  /** `complete` requires full measurable coverage; otherwise `partial`. */
  status: 'complete' | 'partial';
  /** Canonical representation: the IEEE-754 result of `covered / measurable`. */
  coverage: number;
  covered_ingredient_count: number;
  measurable_ingredient_count: number;
}

/** A stored nutrient amount plus its nutrient-specific coverage. */
export interface NutrientResult extends NutrientCoverage {
  amount: number;
  unit: CanonicalUnit;
}

export type IngredientMatchStatus = 'confirmed' | 'suggested' | 'ambiguous';

/** Per-ingredient traceable evidence. */
export interface IngredientEvidence {
  /** Bounded original ingredient line (or stable reference). */
  line_ref: string;
  /** Optional stable digest of the original line. */
  line_digest?: string;
  source: NutritionSourceId;
  source_food_id: string;
  source_release: string;
  match_status: IngredientMatchStatus;
  resolved: boolean;
  user_confirmed: boolean;
  amount?: { value: number; unit: CanonicalUnit };
  conversion_basis?: 'direct_mass' | 'source_portion';
}

export type UnresolvedReason = 'no_match' | 'ambiguous' | 'no_mass' | 'no_nutrition' | 'qualitative';

export interface UnresolvedIngredientRef {
  line_ref: string;
  reason: UnresolvedReason;
  /**
   * Optional USER-CONFIRMED reviewed FOOD IDENTITY for a line whose MASS is still
   * unresolved (e.g. the user selected `Broccoli, raw` but no authenticated
   * portion reproduces the recipe amount and no manual weight was entered yet).
   *
   * Food identity and mass resolution are independent: this evidence restores the
   * selected USDA food on reopen WITHOUT contributing any nutrient total. It is
   * written ONLY when the user explicitly reviewed the line (never for an
   * automatic candidate), and a restored value is re-authenticated against the
   * active pinned catalog. Both fields are present together or absent together;
   * legacy blocks simply omit them.
   */
  source_food_id?: string;
  source_release?: string;
}

export interface ManualOverrideMetadata {
  overridden_at: string;
  note?: string;
}

/** Recognized schema-v1 block (entire-recipe totals). */
export interface CodexNutritionV1 {
  schema: 1;
  basis: 'total';
  servings: number;
  serving_size?: string;
  status: NutritionBlockStatus;
  computed_at: string;
  ingredient_digest: string;
  dv_standard: string;
  sources: NutritionSourceId[];
  source_releases: Partial<Record<NutritionSourceId, string>>;
  /**
   * The exact registered nutrients the calculation attempted to establish.
   * Closed, unique, nonempty, and bounded by the registry size. `complete`
   * requires a present, exactly-fully-covered result for every scoped nutrient.
   */
  nutrient_scope: NutrientId[];
  nutrients: Partial<Record<NutrientId, NutrientResult>>;
  ingredients: IngredientEvidence[];
  unresolved: UnresolvedIngredientRef[];
  manual_override?: ManualOverrideMetadata;
  extensions?: Record<string, unknown>;
}

/** Bounded opaque safe data for an unknown FUTURE schema value. */
export interface OpaqueCodexNutrition {
  kind: 'opaque';
  schema: number;
  data: Record<string, unknown>;
}

/** The parsed advanced-nutrition view attached to an ObsidianRecipe. */
export type AdvancedNutritionBlock = CodexNutritionV1 | OpaqueCodexNutrition;

export const MAX_SERVINGS = 1000;
export const MAX_SOURCES = NUTRITION_SOURCE_IDS.length;
export const MAX_NUTRIENT_SCOPE = NUTRIENT_IDS.length;
export const MAX_INGREDIENT_EVIDENCE = 200;
export const MAX_UNRESOLVED = 200;
export const MAX_LINE_REF_LENGTH = 500;
export const MAX_DIGEST_LENGTH = 128;
export const MAX_SOURCE_ID_LENGTH = 128;
export const MAX_SOURCE_RELEASE_LENGTH = 64;
export const MAX_SERVING_SIZE_LENGTH = 120;
export const MAX_TIMESTAMP_LENGTH = 40;
export const MAX_MANUAL_NOTE_LENGTH = 500;
export const MAX_EXTENSION_DEPTH = 4;
export const MAX_EXTENSION_KEYS = 50;
export const MAX_EXTENSION_ARRAY = 100;
export const MAX_EXTENSION_STRING = 2000;
/** Upper bound on a raw (pre-schema) structure depth, guards stack exhaustion. */
export const MAX_STRUCTURE_DEPTH = 16;
/** Upper bound on a raw (pre-schema) array length, bounds reflective walks. */
export const MAX_INERT_ARRAY = 1000;
/** Upper bound on a raw (pre-schema) object key count, bounds reflective walks. */
export const MAX_INERT_KEYS = 256;
/**
 * The advanced block limit is expressed in UTF-8 SERIALIZED BYTES (not UTF-16
 * code units). A sanitized, inert representation is measured incrementally; the
 * limit is enforced during materialization.
 */
export const MAX_SERIALIZED_BYTES = 64 * 1024;

/** Bounded, input-redacted diagnostics. */
export const MAX_VALIDATION_ERRORS = 64;
export const MAX_VALIDATION_ERROR_LENGTH = 120;
export const MAX_VALIDATION_DIAGNOSTIC_BYTES = 4096;

/** Keys that could enable prototype pollution; always rejected. */
export const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Deterministic ASCII release-identity normalization for the reserved-token
 * policy: lowercase, then drop every character that is not `[a-z0-9]`. This is
 * locale-independent (`toLowerCase`, not `toLocaleLowerCase`).
 */
export function normalizeReleaseIdentity(release: string): string {
  return release.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * True when a release ID, after separator/punctuation-insensitive normalization,
 * contains the reserved `usda` or `fdc` identity tokens. `curated_reference`
 * releases must not claim USDA/FDC identity under any obfuscation.
 */
export function containsReservedUsdaIdentity(release: string): boolean {
  const normalized = normalizeReleaseIdentity(release);
  return normalized.includes('usda') || normalized.includes('fdc');
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

export function hasDangerousKey(value: Record<string, unknown>): boolean {
  try {
    return Object.keys(value).some((key) => DANGEROUS_KEYS.has(key));
  } catch {
    return true;
  }
}

let cachedTextEncoder: TextEncoder | null | undefined;

function getTextEncoder(): TextEncoder | null {
  if (cachedTextEncoder !== undefined) return cachedTextEncoder;
  try {
    cachedTextEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  } catch {
    cachedTextEncoder = null;
  }
  return cachedTextEncoder;
}

/**
 * UTF-8 byte length of a string. Uses the cross-platform `TextEncoder` when
 * available (browser, Node, Obsidian/Electron) with a pure fallback.
 */
export function utf8ByteLength(text: string): number {
  const encoder = getTextEncoder();
  if (encoder) return encoder.encode(text).length;
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Incremental UTF-8 byte length of `JSON.stringify(text)` WITHOUT constructing
 * the escaped string. Accounts for quotes, `"`/`\` escaping, the short control
 * escapes, `\u00XX` escapes, 1/2/3-byte UTF-8 sequences, valid surrogate pairs
 * (4 bytes), and lone surrogates (escaped as `\uXXXX`, exactly as
 * `JSON.stringify` does). Returns `-1` once `remaining` is exceeded.
 */
function jsonStringByteLength(text: string, remaining: number): number {
  let bytes = 2; // opening + closing quote
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

/** Structural bounds profile for the one-pass materializer. */
interface MaterializeBounds {
  maxDepth: number;
  maxKeys: number;
  maxArray: number;
  maxString: number;
  allowNonFinite: boolean;
}

/** Generous bounds used to materialize a raw recognized/future block. */
const GENERIC_BOUNDS: MaterializeBounds = {
  maxDepth: MAX_STRUCTURE_DEPTH,
  maxKeys: MAX_INERT_KEYS,
  maxArray: MAX_INERT_ARRAY,
  maxString: Number.MAX_SAFE_INTEGER,
  allowNonFinite: true,
};

/** Tight bounds for the non-authoritative `extensions` / opaque namespaces. */
const EXTENSION_BOUNDS: MaterializeBounds = {
  maxDepth: MAX_EXTENSION_DEPTH,
  maxKeys: MAX_EXTENSION_KEYS,
  maxArray: MAX_EXTENSION_ARRAY,
  maxString: MAX_EXTENSION_STRING,
  allowNonFinite: false,
};

type MaterializeResult = { ok: true; value: unknown; bytes: number } | { ok: false; reason: string };

type BuildResult = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * The single descriptor-based materialization path. Walks an untrusted value
 * using guarded reflection ONLY, produces a brand-new inert plain structure,
 * and accounts the exact JSON UTF-8 byte length as it goes. It never revisits
 * the original object after this pass.
 *
 * Rejected (without invoking attacker code): accessors/getters/setters, symbol
 * keys, non-enumerable own properties (array `length` excepted), non-plain
 * prototypes (Date/Map/Set/typed arrays/class instances), functions, bigint,
 * symbol, undefined, sparse/unusual arrays, cycles, dangerous keys, and
 * `ownKeys`/`getOwnPropertyDescriptor`/`getPrototypeOf`/`has` proxy failures.
 * Non-finite numbers are rejected unless `allowNonFinite` is set (so recognized
 * field validators can emit a specific error instead of a generic one).
 */
function materialize(value: unknown, bounds: MaterializeBounds, limit: number): MaterializeResult {
  let bytes = 0;
  const add = (count: number): boolean => {
    bytes += count;
    return bytes <= limit;
  };

  const build = (current: unknown, depth: number, stack: Set<object>): BuildResult => {
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
      if (!Number.isFinite(current)) {
        if (!bounds.allowNonFinite) return { ok: false, reason: 'non_finite_number' };
        if (!add(4)) return { ok: false, reason: 'oversized' };
        return { ok: true, value: current };
      }
      if (!add(String(current).length)) return { ok: false, reason: 'oversized' };
      return { ok: true, value: current };
    }
    if (type === 'string') {
      const text = current as string;
      if (text.length > bounds.maxString) return { ok: false, reason: 'string_too_long' };
      const length = jsonStringByteLength(text, limit - bytes);
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
          const child = build(descriptor.value, depth + 1, stack);
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
        const keyLength = jsonStringByteLength(name, limit - bytes);
        if (keyLength < 0 || !add(keyLength)) return { ok: false, reason: 'oversized' };
        if (!add(1)) return { ok: false, reason: 'oversized' }; // colon
        const child = build(descriptor.value, depth + 1, stack);
        if (!child.ok) return child;
        output[name] = child.value;
      }
      return { ok: true, value: output };
    } finally {
      stack.delete(object);
    }
  };

  try {
    const result = build(value, 0, new Set());
    if (result.ok) return { ok: true, value: result.value, bytes };
    return { ok: false, reason: (result as { ok: false; reason: string }).reason };
  } catch {
    return { ok: false, reason: 'reflection_failed' };
  }
}

/**
 * Materializes an untrusted value into an inert plain structure with generous
 * structural bounds. Non-finite numbers are preserved so recognized field
 * validators can report a specific error. Never throws; reflective/proxy
 * failures return a fixed reason.
 */
export type InertMaterialization = { ok: true; value: unknown } | { ok: false; reason: string };

export function toInertValue(value: unknown): InertMaterialization {
  const result = materialize(value, GENERIC_BOUNDS, MAX_SERIALIZED_BYTES);
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, reason: (result as { ok: false; reason: string }).reason };
}

/**
 * True only when `value` is a bounded, JSON/YAML-safe plain value within the
 * non-authoritative extension bounds (depth 4, 50 keys, 100 array entries,
 * 2000-char strings, 64 KiB serialized, finite numbers). Descriptor-based and
 * one-pass; never invokes accessors or `toJSON`; never throws.
 */
export function isPlainSafeValue(value: unknown): boolean {
  try {
    return materialize(value, EXTENSION_BOUNDS, MAX_SERIALIZED_BYTES).ok;
  } catch {
    return false;
  }
}

/**
 * Returns the inert clone produced by the single safe materialization pass.
 * Throws a fixed, bounded error for unsafe/oversized input. Used for the
 * non-authoritative `extensions` namespace and for opaque future-schema data.
 * The original object is never revisited after the walk.
 */
export function cloneSafeValue(value: unknown): unknown {
  const result = materialize(value, EXTENSION_BOUNDS, MAX_SERIALIZED_BYTES);
  if (!result.ok) throw new Error('Unsafe or oversized value in advanced-nutrition data.');
  return result.value;
}

/**
 * Safe wrapper: materializes `value` defensively (single pass) and returns the
 * exact UTF-8 byte length of its JSON serialization, or `Infinity` for unsafe
 * structures / values over `limit`. It never calls `JSON.stringify` on an entire
 * string and never invokes `toJSON`, getters, or coercion on the input.
 */
export function serializedBlockBytes(value: unknown, limit: number = MAX_SERIALIZED_BYTES): number {
  try {
    const result = materialize(value, GENERIC_BOUNDS, limit);
    return result.ok ? result.bytes : Infinity;
  } catch {
    return Infinity;
  }
}
