/**
 * The Kitchen Codex — Household-Portion Registry Contract (registry-track Phase 4):
 * canonical bounded field normalization.
 *
 * PURE, platform-neutral, offline. Every function here is a total,
 * deterministic, locale-independent normalizer over an already-inert value
 * (see `registry.ts` for the inert-materialization boundary). No throwing, no
 * coercion, no network, no clock, no randomness.
 *
 * REUSE AND LAYER DIRECTION
 * -------------------------
 * - Count-unit vocabulary is reused from the Phase 1 single owner
 *   (`src/utils/householdUnits.ts`); the registry accepts ONLY `kind:
 *   'count'` nouns in canonical singular form. Containers (`can`, `package`,
 *   `jar`, `box`, `bag`, `bottle`, …) are rejected, never silently converted
 *   to mass units; mass/volume units and arbitrary strings are rejected.
 * - Positive-finite grams validation reuses `isValidNutrientAmount`
 *   (`src/core/nutritionV2/units.ts`) for finiteness/negativity/`-0`/precision,
 *   plus a stricter registry-specific maximum and positivity.
 * - Byte lengths reuse `utf8ByteLength` (`src/core/nutritionV2/schema.ts`).
 * - The size vocabulary is OWNED LOCALLY (canonical outputs only). The
 *   count-portion size map lives in the calculation layer
 *   (`src/core/nutritionV2/calculation/countPortion.ts`), which this contract
 *   must not import; duplicating the full alias table there would fork
 *   behavior, so the registry accepts ONLY already-canonical sizes.
 * - The state vocabulary is OWNED LOCALLY for the same reason: the
 *   ingredient-state roles live in matching authority
 *   (`src/core/nutritionV2/matching/query.ts`), which this contract must not
 *   import. The 8 states are aligned with the existing ingredient-state
 *   semantics (`raw`, `cooked`, `canned`, `drained`, `undrained`, `fresh`,
 *   `dried`, `frozen`).
 */

import {
  HOUSEHOLD_DATE_PATTERN,
  HOUSEHOLD_RELEASE_PATTERN,
  HOUSEHOLD_SHA256_HEX_PATTERN,
  MAX_HOUSEHOLD_ALIASES,
  MAX_HOUSEHOLD_CITATION_BYTES,
  MAX_HOUSEHOLD_EXCLUDED_STATES,
  MAX_HOUSEHOLD_FDC_IDS,
  MAX_HOUSEHOLD_FOOD_KEY_BYTES,
  MAX_HOUSEHOLD_FOOD_KEY_TOKENS,
  MAX_HOUSEHOLD_GRAMS_PER_UNIT,
  MAX_HOUSEHOLD_RELEASE_LENGTH,
  MAX_HOUSEHOLD_URL_BYTES,
  type HouseholdPortionAuthorityClass,
  type HouseholdPortionBounds,
  type HouseholdPortionQuantityBehavior,
  type HouseholdPortionSource,
  type HouseholdPortionSourceKind,
} from './types';
import { isValidNutrientAmount } from '../units';
import { utf8ByteLength } from '../schema';
import { canonicalHouseholdUnit } from '../../../utils/householdUnits';

// ---------------------------------------------------------------------------
// Closed local vocabularies (aligned, not imported — see header)
// ---------------------------------------------------------------------------

/**
 * Closed size classes: the canonical outputs of the count-portion size
 * vocabulary. `null` means "not size-specific" and never means permission to
 * match a conflicting size. Only already-canonical forms are accepted
 * (`miniature`/`xlarge`/`extra large` aliases are rejected: use `mini`/`xl`).
 */
export const HOUSEHOLD_SIZE_CLASSES: ReadonlyArray<string> = Object.freeze([
  'small',
  'medium',
  'large',
  'jumbo',
  'mini',
  'petite',
  'xl',
  'xxl',
]);

/**
 * Closed registry states, aligned with existing ingredient-state semantics.
 * `null` means "no state requirement" and never means an explicitly
 * conflicting state is acceptable; applicability is a later-phase decision.
 */
export const HOUSEHOLD_STATES: ReadonlyArray<string> = Object.freeze([
  'raw',
  'cooked',
  'canned',
  'drained',
  'undrained',
  'fresh',
  'dried',
  'frozen',
]);

export const HOUSEHOLD_AUTHORITY_CLASSES: ReadonlyArray<HouseholdPortionAuthorityClass> = Object.freeze([
  'usda_derived',
  'vetted_standard',
  'bounded_estimate',
]);

export const HOUSEHOLD_SOURCE_KINDS: ReadonlyArray<HouseholdPortionSourceKind> = Object.freeze([
  'usda_fdc',
  'government_standard',
  'standards_body',
]);

/** C0/C1 controls, DEL, and invisible format characters: always rejected. */
const CONTROL_OR_FORMAT_PATTERN =
  // Explicit escapes only: C0/C1 controls, DEL, and invisible format characters.
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\u205F-\u2064\uFEFF\u00AD]/;

/** Object-key forms that must never become lookup labels. */
const UNSAFE_KEY_FORMS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

export type NormalizeResult<T> = { ok: true; value: T } | { ok: false };

// ---------------------------------------------------------------------------
// Canonical text (food_key and aliases)
// ---------------------------------------------------------------------------

/**
 * Canonical text form: NFC-normalized, non-locale lowercased, trimmed,
 * whitespace-collapsed, bounded in UTF-8 bytes and tokens, with no control/
 * format characters and no unsafe object-key forms. Returns null on any
 * violation. This is an audit/search label only; it grants no food identity.
 */
export function normalizeCanonicalText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const canonical = raw.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');
  if (canonical.length === 0) return null;
  if (utf8ByteLength(canonical) > MAX_HOUSEHOLD_FOOD_KEY_BYTES) return null;
  const tokens = canonical.split(' ');
  if (tokens.length === 0 || tokens.length > MAX_HOUSEHOLD_FOOD_KEY_TOKENS) return null;
  if (CONTROL_OR_FORMAT_PATTERN.test(canonical)) return null;
  if (UNSAFE_KEY_FORMS.has(canonical)) return null;
  return canonical;
}

/** Alias list: bounded, canonically normalized, deduplicated, sorted. */
export function normalizeAliasList(raw: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_HOUSEHOLD_ALIASES) return null;
  const canonical: string[] = [];
  for (const entry of raw) {
    const text = normalizeCanonicalText(entry);
    if (text === null) return null;
    canonical.push(text);
  }
  const unique = Array.from(new Set(canonical));
  unique.sort();
  return Object.freeze(unique);
}

// ---------------------------------------------------------------------------
// Identity constraints (declared, not proven — no USDA lookup in this phase)
// ---------------------------------------------------------------------------

/** FDC ids: required non-empty bounded array of positive safe integers. */
export function normalizeFdcIds(raw: unknown): ReadonlyArray<number> | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0 || raw.length > MAX_HOUSEHOLD_FDC_IDS) return null;
  const ids: number[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'number') return null;
    if (!Number.isSafeInteger(entry) || entry <= 0) return null;
    ids.push(entry);
  }
  const unique = Array.from(new Set(ids));
  unique.sort((a, b) => a - b);
  return Object.freeze(unique);
}

// ---------------------------------------------------------------------------
// Household unit (reuses the Phase 1 single owner; count nouns only)
// ---------------------------------------------------------------------------

/**
 * Canonical household unit: must resolve through the Phase 1 vocabulary to a
 * `count` noun; the authenticated form is the canonical singular (`cloves` ->
 * `clove`). Containers, mass/volume units, and arbitrary strings return null.
 */
export function normalizeHouseholdUnit(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const unit = canonicalHouseholdUnit(raw);
  if (!unit || unit.kind !== 'count') return null;
  return unit.noun;
}

// ---------------------------------------------------------------------------
// Size class (tri-state: canonical, null, or invalid)
// ---------------------------------------------------------------------------

export function normalizeSizeClass(raw: unknown): NormalizeResult<string | null> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  const cleaned = raw.normalize('NFC').toLowerCase().trim();
  if ((HOUSEHOLD_SIZE_CLASSES as ReadonlyArray<string>).includes(cleaned)) {
    return { ok: true, value: cleaned };
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Registry state (tri-state) and excluded states
// ---------------------------------------------------------------------------

export function normalizeRegistryState(raw: unknown): NormalizeResult<string | null> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  const cleaned = raw.normalize('NFC').toLowerCase().trim();
  if ((HOUSEHOLD_STATES as ReadonlyArray<string>).includes(cleaned)) {
    return { ok: true, value: cleaned };
  }
  return { ok: false };
}

/**
 * Excluded states: closed values only, bounded, deduplicated, sorted, and
 * never containing the record's own `requires_state`.
 */
export function normalizeExcludedStates(raw: unknown, requiresState: string | null): ReadonlyArray<string> | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_HOUSEHOLD_EXCLUDED_STATES) return null;
  const states: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return null;
    const cleaned = entry.normalize('NFC').toLowerCase().trim();
    if (!(HOUSEHOLD_STATES as ReadonlyArray<string>).includes(cleaned)) return null;
    states.push(cleaned);
  }
  const unique = Array.from(new Set(states));
  unique.sort();
  if (requiresState !== null && unique.includes(requiresState)) return null;
  return Object.freeze(unique);
}

// ---------------------------------------------------------------------------
// Grams (reuses the shared positive-finite implementation + registry maximum)
// ---------------------------------------------------------------------------

/**
 * Grams per unit: positive, finite, non-`-0`, within the conservative
 * registry-specific maximum (which does not raise any existing calculation
 * bound), and within the shared decimal-precision policy. No zero, negative,
 * NaN, Infinity, string coercion, or exponent-string abuse. The authored
 * finite number is preserved exactly (no rounding) for canonical digest form.
 */
export function normalizeGrams(raw: unknown): number | null {
  if (typeof raw !== 'number') return null;
  if (!isValidNutrientAmount(raw)) return null;
  if (raw <= 0 || raw > MAX_HOUSEHOLD_GRAMS_PER_UNIT) return null;
  return raw;
}

/** Estimate bounds: required iff class is `bounded_estimate`; strict `min < max`. */
export function normalizeBounds(raw: unknown): NormalizeResult<HouseholdPortionBounds | null> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false };
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('min_grams') || !keys.includes('max_grams')) {
    return { ok: false };
  }
  const min = normalizeGrams(value.min_grams);
  const max = normalizeGrams(value.max_grams);
  if (min === null || max === null) return { ok: false };
  if (!(min < max)) return { ok: false };
  return { ok: true, value: Object.freeze({ min_grams: min, max_grams: max }) };
}

// ---------------------------------------------------------------------------
// Scalars, source, dates, release, supersedes
// ---------------------------------------------------------------------------

export function normalizeQuantityBehavior(raw: unknown): HouseholdPortionQuantityBehavior | null {
  return raw === 'linear' ? 'linear' : null;
}

export function normalizeBoolean(raw: unknown): boolean | null {
  return typeof raw === 'boolean' ? raw : null;
}

export function normalizeAuthorityClass(raw: unknown): HouseholdPortionAuthorityClass | null {
  if (typeof raw !== 'string') return null;
  if ((HOUSEHOLD_AUTHORITY_CLASSES as ReadonlyArray<string>).includes(raw)) {
    return raw as HouseholdPortionAuthorityClass;
  }
  return null;
}

/** Citation: NFC, trimmed, whitespace-collapsed, non-empty, bounded. */
export function normalizeCitation(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const canonical = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (canonical.length === 0) return null;
  if (utf8ByteLength(canonical) > MAX_HOUSEHOLD_CITATION_BYTES) return null;
  if (CONTROL_OR_FORMAT_PATTERN.test(canonical)) return null;
  return canonical;
}

/**
 * Optional URL: null, or a bounded `https:` URL with no credentials and no
 * whitespace. Parsed only — never fetched, never redirected, never validated
 * over the network.
 */
export function normalizeUrl(raw: unknown): NormalizeResult<string | null> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  if (raw.length === 0 || utf8ByteLength(raw) > MAX_HOUSEHOLD_URL_BYTES) return { ok: false };
  if (!raw.startsWith('https://')) return { ok: false };
  if (/\s/.test(raw)) return { ok: false };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== 'https:') return { ok: false };
  if (parsed.username.length > 0 || parsed.password.length > 0) return { ok: false };
  if (parsed.host.length === 0) return { ok: false };
  return { ok: true, value: raw };
}

/** Canonical calendar date `YYYY-MM-DD` with real month/day/leap validation. */
export function normalizeDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = HOUSEHOLD_DATE_PATTERN.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > daysInMonth) return null;
  return raw;
}

/**
 * Source: closed exact keys, closed kind, bounded citation, optional https
 * URL, optional canonical access date.
 */
export function normalizeSource(raw: unknown): NormalizeResult<HouseholdPortionSource> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false };
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 4) return { ok: false };
  for (const key of ['kind', 'citation', 'url', 'accessed']) {
    if (!keys.includes(key)) return { ok: false };
  }
  if (typeof value.kind !== 'string' || !(HOUSEHOLD_SOURCE_KINDS as ReadonlyArray<string>).includes(value.kind)) {
    return { ok: false };
  }
  const citation = normalizeCitation(value.citation);
  if (citation === null) return { ok: false };
  const url = normalizeUrl(value.url);
  if (!url.ok) return { ok: false };
  let accessed: string | null = null;
  if (value.accessed !== null) {
    accessed = normalizeDate(value.accessed);
    if (accessed === null) return { ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({
      kind: value.kind as HouseholdPortionSourceKind,
      citation,
      url: url.value,
      accessed,
    }),
  };
}

/** Registry release: non-empty, bounded, canonical identifier. */
export function normalizeRelease(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_HOUSEHOLD_RELEASE_LENGTH) return null;
  if (!HOUSEHOLD_RELEASE_PATTERN.test(raw)) return null;
  return raw;
}

/** Supersedes: null, or a lowercase SHA-256 digest (chain checks in registry). */
export function normalizeSupersedes(raw: unknown): NormalizeResult<string | null> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  if (!HOUSEHOLD_SHA256_HEX_PATTERN.test(raw)) return { ok: false };
  return { ok: true, value: raw };
}
