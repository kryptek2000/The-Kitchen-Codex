/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5E: authenticated count-portion
 * resolution.
 *
 * PURE, offline, versioned. This module is the ONE authority for turning an
 * authenticated USDA source portion into a usable COUNT portion identity and for
 * deciding whether that identity is compatible with a parsed recipe count.
 *
 * WHAT IT IS
 * ----------
 * Some USDA foods carry source portions whose identity is a countable culinary
 * unit (`1 slice = 28 g`) or a bounded size descriptor (`1 medium = 123 g`).
 * Phase 4.5E uses ONLY those authenticated portions to derive mass:
 *
 *   totalGrams = ingredientCount / portionAmount × portionGramWeight
 *
 * WHAT IT IS NOT
 * --------------
 * It never invents an average weight, never performs a density/count-weight
 * guess, never uses a web/AI conversion, never accepts a restaurant/fast-food
 * food, and never trusts a caller-supplied gram value. A portion from one food is
 * never reusable with another food.
 *
 * IDENTITY EXTRACTION (closed)
 * ----------------------------
 * A portion identity is the closed pair `{ unit, size }`:
 *   - `unit` is a canonical count unit (slice, piece, item, serving, clove, can,
 *     package, stick, head, egg, container, bun, roll, pickle) taken from the
 *     portion's measure/modifier; a `bun`/`roll` and an `item`/`pickle` are the
 *     only bounded equivalences.
 *   - `size` is a bounded size qualifier (small, medium, large, jumbo, mini, xl)
 *     when the portion identity is a size.
 * An ambiguous description (`any size`, `NFS`, `not specified`, `quantity`,
 * `guideline`, `variable`) is never a count identity.
 *
 * COMPATIBILITY (closed)
 * ----------------------
 *   - an explicit input size is a CONSTRAINT: the portion size must equal it;
 *   - an unspecified input size never silently falls back to a size-specific
 *     portion;
 *   - an explicit count unit must match (with the bounded equivalences above);
 *   - a bare count with no unit/size never matches a slice/piece portion.
 */

import { isPlainObject, toInertValue } from '../schema';
import { canonicalStringify, sha256Hex } from '../usda/digest';
import type { CanonicalPortionRecord, CanonicalUsdaFoodRecord } from '../usda/types';
import { parseAmount } from '../../../utils/measurements';
import {
  canonicalHouseholdUnit,
  householdCountNouns,
  householdUnitAliases,
} from '../../../utils/householdUnits';
import { CALCULATION_VERSION, type Phase3Failure } from './types';

/** Explicit count-portion contract version (part of selection bindings). */
export const COUNT_PORTION_VERSION = 'usda_count_portion_v2';

/** Bounded ingredient count requirement derived from the parsed ingredient. */
export interface CountRequirement {
  readonly amount: number;
  readonly unit: string | null;
  readonly size: string | null;
}

/**
 * Bounded advisory count-identity hint. It may fill a MISSING unit/size of the
 * recipe's own parsed count requirement (e.g. `3 garlic cloves` -> unit
 * `clove`), but it can never supply the amount, a gram weight, an FDC id, or
 * override an explicit recipe identity. Values are the CLOSED canonical count
 * vocabulary only.
 */
export interface CountRequirementHint {
  readonly unit: string | null;
  readonly size: string | null;
}

/**
 * Strictly sanitizes an untrusted count-requirement hint. Absent/null is simply
 * no hint; a present malformed value (non-plain object, unknown keys, or a token
 * outside the closed count vocabulary) fails closed.
 */
export function sanitizeCountRequirementHint(
  raw: unknown
): { ok: true; hint?: CountRequirementHint } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true };
  if (!isPlainObject(raw)) return { ok: false };
  for (const key of Object.keys(raw)) {
    if (key !== 'unit' && key !== 'size') return { ok: false };
  }
  const unit = raw.unit === undefined || raw.unit === null ? null : canonicalCountUnit(String(raw.unit));
  if (raw.unit !== undefined && raw.unit !== null && unit === null) return { ok: false };
  const size = raw.size === undefined || raw.size === null ? null : canonicalSize(String(raw.size));
  if (raw.size !== undefined && raw.size !== null && size === null) return { ok: false };
  return { ok: true, hint: Object.freeze({ unit, size }) };
}

/** The closed count identity of one authenticated USDA portion. */
export interface CountPortionIdentity {
  readonly unit: string | null;
  readonly size: string | null;
}

export interface CountPortionCandidate {
  readonly index: number;
  readonly usda_portion_id?: number;
  readonly measure: string;
  readonly modifier?: string;
  /** Positive finite portion amount (from the raw field or explicit measure). */
  readonly amount: number;
  /** Positive finite authoritative gram weight. */
  readonly gram_weight: number;
  readonly unit: string | null;
  readonly size: string | null;
  /** Safe bounded human label (e.g. `1 slice = 28 g`). */
  readonly display_label: string;
}

export interface CountPortionReview {
  readonly count_portion_version: string;
  readonly calculation_version: string;
  readonly bundle_release: string;
  /** Catalog identity (binds eligibility + normalization + ranking + membership). */
  readonly catalog_digest: string;
  readonly fdc_id: number;
  readonly record_digest: string;
  /** True when the ingredient has a usable count identity (unit or size). */
  readonly applicable: boolean;
  readonly requirement: CountRequirement;
  readonly candidates: ReadonlyArray<CountPortionCandidate>;
  readonly candidates_digest: string;
}

export type CountPortionReviewResult =
  | { ok: true; review: CountPortionReview }
  | { ok: false; failure: Phase3Failure };

export interface CountPortionSelection {
  readonly count_portion_version: string;
  readonly calculation_version: string;
  readonly line_ref: string;
  readonly ingredient_identity_digest: string;
  readonly bundle_release: string;
  /** Catalog identity (binds eligibility + normalization + ranking + membership). */
  readonly catalog_digest: string;
  readonly fdc_id: number;
  readonly record_digest: string;
  readonly candidates_digest: string;
  readonly portion_index: number;
  readonly portion_amount: number;
  readonly gram_weight: number;
  readonly measure: string;
  readonly count_unit: string | null;
  readonly count_size: string | null;
  readonly selection_digest: string;
}

// ---------------------------------------------------------------------------
// Closed count-unit / size vocabulary
// ---------------------------------------------------------------------------

/**
 * Canonical count-unit spellings. `normalizeCountToken` collapses regular plurals
 * and the closed synonym set; no other noun is ever a count unit.
 *
 * The Phase 1 household count nouns (clove, slice, piece, stick, head, stalk,
 * sprig, bunch, leaf, fillet, breast, thigh, rib, strip, link, scoop, item) are
 * derived from the ONE vocabulary owner (`src/utils/householdUnits.ts`) plus the
 * pre-existing calculation-layer extras (serving, egg, container, bun/roll,
 * pickle). Containers (can/package are pre-existing here; jar/box/bag/bottle are
 * deliberately NOT count units) never gain a count conversion from Phase 1.
 */
const BASE_COUNT_UNIT_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  serving: 'serving',
  servings: 'serving',
  egg: 'egg',
  eggs: 'egg',
  container: 'container',
  containers: 'container',
  bun: 'bun',
  buns: 'bun',
  roll: 'roll',
  rolls: 'roll',
  pickle: 'pickle',
  pickles: 'pickle',
  can: 'can',
  cans: 'can',
  package: 'package',
  packages: 'package',
  pkg: 'package',
});

const COUNT_UNIT_TOKENS: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = { ...BASE_COUNT_UNIT_TOKENS };
  for (const token of householdUnitAliases()) {
    const unit = canonicalHouseholdUnit(token);
    if (unit?.kind === 'count') out[token] = unit.noun;
  }
  for (const noun of householdCountNouns()) out[noun] ??= noun;
  return Object.freeze(out);
})();

/** Bounded, symmetric equivalences only where real culinary identity holds. */
const COUNT_UNIT_EQUIVALENCES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  Object.freeze(['bun', 'roll'] as const),
  Object.freeze(['item', 'pickle'] as const),
]);

const SIZE_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  small: 'small',
  medium: 'medium',
  large: 'large',
  jumbo: 'jumbo',
  mini: 'mini',
  miniature: 'mini',
  petite: 'petite',
  xl: 'xl',
  xlarge: 'xl',
  'extra large': 'xl',
  xxl: 'xxl',
});

/** Descriptions that are never an unambiguous count identity. */
const AMBIGUITY_MARKERS: ReadonlyArray<RegExp> = Object.freeze([
  /\bany size\b/,
  /\bnfs\b/,
  /\bnot specified\b/,
  /\bunspecified\b/,
  /\bquantity\b/,
  /\bguideline\b/,
  /\bvariable\b/,
  /\bunknown\b/,
]);

const MASS_OR_VOLUME_TOKENS: ReadonlySet<string> = new Set([
  'g',
  'gram',
  'grams',
  'kg',
  'oz',
  'ounce',
  'ounces',
  'lb',
  'lbs',
  'pound',
  'pounds',
  'ml',
  'l',
  'liter',
  'liters',
  'tsp',
  'teaspoon',
  'teaspoons',
  'tbsp',
  'tablespoon',
  'tablespoons',
  'cup',
  'cups',
  'fl',
  'fluid',
  'pint',
  'quart',
  'gallon',
]);

function normalizeToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Canonicalizes a raw count-unit token, or null when it is not a count unit. */
export function canonicalCountUnit(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = normalizeToken(String(raw));
  if (!cleaned) return null;
  if (cleaned.includes(' ')) {
    // Multi-word units are not count units in this vocabulary.
    return null;
  }
  return COUNT_UNIT_TOKENS[cleaned] ?? null;
}

/** Canonicalizes a raw size token, or null when it is not a size qualifier. */
export function canonicalSize(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = normalizeToken(String(raw));
  if (!cleaned) return null;
  return SIZE_TOKENS[cleaned] ?? null;
}

/** True when two canonical count units are equal under the bounded equivalences. */
export function countUnitsEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  for (const [x, y] of COUNT_UNIT_EQUIVALENCES) {
    if ((a === x && b === y) || (a === y && b === x)) return true;
  }
  return false;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && !Object.is(value, -0);
}

// ---------------------------------------------------------------------------
// Portion identity extraction
// ---------------------------------------------------------------------------

interface ExtractedCountIdentity {
  readonly amount: number;
  readonly unit: string | null;
  readonly size: string | null;
}

function stripLeadingAmount(text: string): { amount: number | null; rest: string } {
  const match = text.match(
    /^\s*(\d+\s+\d+\/\d+|\d+\s*-\s*\d+\/\d+|\d+\/\d+|\d+\s*[½⅓⅔¼¾⅛⅜⅝⅞]|[½⅓⅔¼¾⅛⅜⅝⅞]|\d+(?:\.\d+)?)\s*([\s\S]*)$/
  );
  if (!match) return { amount: null, rest: text };
  return { amount: parseAmount(match[1]), rest: match[2].trim() };
}

/**
 * Extracts the closed count identity of ONE canonical portion, or null when the
 * portion is not a usable, unambiguous count portion. Never throws.
 */
export function extractCountIdentity(
  portion: CanonicalPortionRecord
): ExtractedCountIdentity | null {
  if (!isPositiveFinite(portion.gram_weight)) return null;

  const rawMeasure = typeof portion.measure === 'string' ? portion.measure.trim() : '';
  const rawModifier = typeof portion.modifier === 'string' ? portion.modifier.trim() : '';
  const undetermined = rawMeasure.toLowerCase() === 'undetermined' || rawMeasure.length === 0;
  const identityText = undetermined ? rawModifier : rawMeasure;
  if (identityText.length === 0) return null;

  const lowered = normalizeToken(identityText);
  for (const marker of AMBIGUITY_MARKERS) {
    if (marker.test(lowered)) return null;
  }

  // Determine the authoritative portion amount: the raw field when present,
  // otherwise an explicit leading amount embedded in the measure text.
  let amount: number | null = isPositiveFinite(portion.amount) ? portion.amount : null;
  let remainder = identityText;
  if (amount === null && !undetermined) {
    const leading = stripLeadingAmount(identityText);
    if (isPositiveFinite(leading.amount)) {
      amount = leading.amount;
      remainder = leading.rest;
    }
  } else if (!undetermined) {
    // Strip an explicit leading amount so it never becomes an identity token.
    const leading = stripLeadingAmount(identityText);
    if (leading.amount !== null) remainder = leading.rest;
  }
  if (amount === null) return null;

  // Parenthetical descriptors are package/portion metadata, never the count
  // identity: `1 slice (15 per 8 oz package)` is ONE SLICE, and the embedded
  // package mass must not discard an otherwise valid count portion. Strip every
  // parenthetical group BEFORE the mass/volume token guard so a package-size
  // note can never remove a legitimate count identity.
  const remainderWithoutParentheticals = remainder.replace(/\([^()]*\)/g, ' ').trim();
  const tokens = normalizeToken(remainderWithoutParentheticals).split(' ').filter(Boolean);
  if (tokens.length === 0) return null;
  // A mass/volume unit is never a count identity.
  if (tokens.some((token) => MASS_OR_VOLUME_TOKENS.has(token))) return null;

  let unit: string | null = null;
  let size: string | null = null;
  for (const token of tokens) {
    const candidateUnit = COUNT_UNIT_TOKENS[token];
    if (candidateUnit) unit = candidateUnit;
    const candidateSize = SIZE_TOKENS[token];
    if (candidateSize) size = candidateSize;
  }

  if (unit === null && size === null) return null;
  return { amount, unit, size };
}

// ---------------------------------------------------------------------------
// Requirement derivation
// ---------------------------------------------------------------------------

/** Canonical count unit inferred from a food's head noun, or null. */
function inferUnitFromIdentityTokens(tokens: ReadonlyArray<string>): string | null {
  if (tokens.length === 0) return null;
  const head = tokens[tokens.length - 1];
  return canonicalCountUnit(head);
}

/**
 * Derives the closed count requirement from a parsed ingredient's amount, raw
 * unit, and the query's bounded size qualifiers. Returns null when the ingredient
 * is not a usable count (no amount, or neither a count unit nor a size).
 *
 * The optional `hint` (bounded, closed vocabulary) may only FILL a missing
 * unit/size; it never supplies or overrides the amount, and the recipe's own
 * explicit identity always wins.
 */
export function deriveCountRequirement(
  amount: number | null,
  rawUnit: string | null | undefined,
  identityTokens: ReadonlyArray<string>,
  sizeQualifiers: ReadonlyArray<string>,
  hint?: CountRequirementHint
): CountRequirement | null {
  if (amount === null || !isPositiveFinite(amount)) return null;
  const explicitUnit = canonicalCountUnit(rawUnit ?? null);
  const unit = explicitUnit ?? inferUnitFromIdentityTokens(identityTokens) ?? hint?.unit ?? null;
  const explicitSize = sizeQualifiers.length > 0 ? canonicalSize(sizeQualifiers[0]) : null;
  const size = explicitSize ?? hint?.size ?? null;
  return Object.freeze({ amount, unit, size });
}

/** True when a requirement carries a usable count identity (unit or size). */
export function isCountRequirementApplicable(requirement: CountRequirement): boolean {
  return requirement.unit !== null || requirement.size !== null;
}

function countIdentityCompatible(
  requirement: CountRequirement,
  identity: CountPortionIdentity
): boolean {
  if (requirement.size !== null) {
    // An explicit size is satisfied by a size-specific portion OR by the generic
    // (size-unspecified) portion of the same count unit when the pinned USDA
    // record exposes no size-specific portion (e.g. `2 large eggs` ->
    // `1 egg = 50 g`). The reverse is NOT allowed: an unspecified size never
    // silently binds a size-specific portion.
    if (identity.size !== null && identity.size !== requirement.size) return false;
  } else if (identity.size !== null) {
    return false;
  }
  if (requirement.unit !== null) {
    if (identity.unit === null) return false;
    if (!countUnitsEquivalent(requirement.unit, identity.unit)) return false;
  } else if (identity.unit !== null) {
    return false;
  }
  return true;
}

function portionDisplayLabel(
  amount: number,
  unit: string | null,
  size: string | null,
  gramWeight: number
): string {
  const identity = unit ?? size ?? 'portion';
  const label = `${amount} ${identity} = ${gramWeight} g`;
  return label.length > 80 ? label.slice(0, 80) : label;
}

/**
 * Bounded, deterministic list of authenticated count portions compatible with
 * the requirement. Order is the canonical source order (index ascending).
 */
export function countPortionCandidates(
  record: CanonicalUsdaFoodRecord,
  requirement: CountRequirement
): ReadonlyArray<CountPortionCandidate> {
  const out: CountPortionCandidate[] = [];
  record.portions.forEach((portion, index) => {
    const identity = extractCountIdentity(portion);
    if (!identity) return;
    if (!countIdentityCompatible(requirement, identity)) return;
    out.push(
      Object.freeze({
        index,
        ...(portion.usda_portion_id !== undefined ? { usda_portion_id: portion.usda_portion_id } : {}),
        measure: portion.measure,
        ...(portion.modifier !== undefined ? { modifier: portion.modifier } : {}),
        amount: identity.amount,
        gram_weight: portion.gram_weight,
        unit: identity.unit,
        size: identity.size,
        display_label: portionDisplayLabel(
          identity.amount,
          identity.unit,
          identity.size,
          portion.gram_weight
        ),
      })
    );
  });
  return Object.freeze(out);
}

/** Deterministic digest binding a record + requirement + compatible candidate set. */
export function computeCountPortionCandidatesDigest(
  record: CanonicalUsdaFoodRecord,
  requirement: CountRequirement,
  candidates: ReadonlyArray<CountPortionCandidate>
): string {
  return sha256Hex(
    canonicalStringify({
      count_portion_version: COUNT_PORTION_VERSION,
      fdc_id: record.fdc_id,
      record_digest: record.record_digest,
      requirement,
      candidates,
    })
  );
}

/** Pure count-portion review for one matched food and one count requirement. */
export function buildCountPortionReview(
  record: CanonicalUsdaFoodRecord,
  requirement: CountRequirement,
  bundleRelease: string,
  catalogDigest: string
): CountPortionReview {
  const candidates = countPortionCandidates(record, requirement);
  return Object.freeze({
    count_portion_version: COUNT_PORTION_VERSION,
    calculation_version: CALCULATION_VERSION,
    bundle_release: bundleRelease,
    catalog_digest: catalogDigest,
    fdc_id: record.fdc_id,
    record_digest: record.record_digest,
    applicable: isCountRequirementApplicable(requirement),
    requirement,
    candidates,
    candidates_digest: computeCountPortionCandidatesDigest(record, requirement, candidates),
  });
}

// ---------------------------------------------------------------------------
// Deterministic selection
// ---------------------------------------------------------------------------

export interface DeterministicCountPortion {
  readonly candidate: CountPortionCandidate;
  readonly deterministic: true;
}

/**
 * Returns the unique compatible count portion when every compatible candidate
 * resolves to the SAME authoritative `(amount, gram_weight)` (provably
 * equivalent duplicates), choosing the lowest index deterministically. Returns
 * null when there are no candidates or when materially different weights make the
 * choice ambiguous (the caller must ask the user).
 */
export function selectDeterministicCountPortion(
  candidates: ReadonlyArray<CountPortionCandidate>
): DeterministicCountPortion | null {
  if (candidates.length === 0) return null;
  const first = candidates[0];
  for (const candidate of candidates) {
    if (candidate.amount !== first.amount || candidate.gram_weight !== first.gram_weight) {
      return null;
    }
  }
  return Object.freeze({ candidate: first, deterministic: true });
}

// ---------------------------------------------------------------------------
// Mass resolution
// ---------------------------------------------------------------------------

export type CountPortionMassResolution =
  | { ok: true; grams: number; deterministic: boolean; candidate: CountPortionCandidate }
  | { ok: false; reason: 'stale' | 'incompatible' | 'overflow' | 'ambiguous' };

function resolveGrams(
  requirement: CountRequirement,
  candidate: CountPortionCandidate
): number | undefined {
  const grams = (requirement.amount / candidate.amount) * candidate.gram_weight;
  if (!Number.isFinite(grams) || grams <= 0 || Object.is(grams, -0)) return undefined;
  return grams;
}

/** Computes the deterministic count-portion grams without any caller selection. */
export function resolveDeterministicCountPortionGrams(
  record: CanonicalUsdaFoodRecord,
  requirement: CountRequirement,
  maxGrams: number
): CountPortionMassResolution {
  const candidates = countPortionCandidates(record, requirement);
  const deterministic = selectDeterministicCountPortion(candidates);
  if (!deterministic) {
    return { ok: false, reason: candidates.length === 0 ? 'incompatible' : 'ambiguous' };
  }
  const grams = resolveGrams(requirement, deterministic.candidate);
  if (grams === undefined) return { ok: false, reason: 'overflow' };
  if (grams > maxGrams) return { ok: false, reason: 'overflow' };
  return { ok: true, grams, deterministic: true, candidate: deterministic.candidate };
}

/** Recomputes a caller-supplied count-portion selection against the record. */
export function resolveCountPortionMassGrams(
  record: CanonicalUsdaFoodRecord,
  selection: CountPortionSelection,
  requirement: CountRequirement,
  bundleRelease: string,
  catalogDigest: string,
  lineRef: string,
  identityDigest: string,
  calculationVersion: string,
  maxGrams: number
): CountPortionMassResolution {
  if (
    selection.count_portion_version !== COUNT_PORTION_VERSION ||
    selection.calculation_version !== calculationVersion ||
    selection.line_ref !== lineRef ||
    selection.ingredient_identity_digest !== identityDigest ||
    selection.bundle_release !== bundleRelease ||
    selection.catalog_digest !== catalogDigest ||
    selection.fdc_id !== record.fdc_id ||
    selection.record_digest !== record.record_digest
  ) {
    return { ok: false, reason: 'stale' };
  }

  const candidates = countPortionCandidates(record, requirement);
  if (
    selection.candidates_digest !==
    computeCountPortionCandidatesDigest(record, requirement, candidates)
  ) {
    return { ok: false, reason: 'stale' };
  }

  const candidate = candidates.find((entry) => entry.index === selection.portion_index);
  if (!candidate) return { ok: false, reason: 'stale' };
  if (
    selection.portion_amount !== candidate.amount ||
    selection.gram_weight !== candidate.gram_weight ||
    selection.measure !== candidate.measure ||
    selection.count_unit !== candidate.unit ||
    selection.count_size !== candidate.size
  ) {
    return { ok: false, reason: 'stale' };
  }

  const grams = resolveGrams(requirement, candidate);
  if (grams === undefined) return { ok: false, reason: 'overflow' };
  if (grams > maxGrams) return { ok: false, reason: 'overflow' };
  return { ok: true, grams, deterministic: false, candidate };
}

/** Recomputes the deterministic digest binding a count-portion selection. */
export function computeCountPortionSelectionDigest(
  selection: Omit<CountPortionSelection, 'selection_digest'>
): string {
  return sha256Hex(canonicalStringify(selection));
}

/**
 * Sanitizes an untrusted count-portion selection into the closed shape. The
 * gram value is NEVER taken from the caller; it is recomputed by the resolver.
 */
export function sanitizeCountPortionSelection(
  raw: unknown
): { ok: true; selection: CountPortionSelection } | { ok: false; unsafe: boolean } {
  const materialized = toInertValue(raw);
  if (!materialized.ok) {
    const reason = (materialized as { ok: false; reason: string }).reason;
    const unsafe =
      reason === 'dangerous_key' ||
      reason === 'accessor_or_hidden_property' ||
      reason === 'array_accessor_or_hole' ||
      reason === 'reflection_failed' ||
      reason === 'cycle' ||
      reason === 'symbol_key';
    return { ok: false, unsafe };
  }
  if (!isPlainObject(materialized.value)) return { ok: false, unsafe: false };
  const value = materialized.value;
  const keys = Object.keys(value);
  const allowed = new Set([
    'count_portion_version',
    'calculation_version',
    'line_ref',
    'ingredient_identity_digest',
    'bundle_release',
    'catalog_digest',
    'fdc_id',
    'record_digest',
    'candidates_digest',
    'portion_index',
    'portion_amount',
    'gram_weight',
    'measure',
    'count_unit',
    'count_size',
    'selection_digest',
  ]);
  for (const key of keys) {
    if (!allowed.has(key)) return { ok: false, unsafe: false };
  }
  if (
    value.count_portion_version !== COUNT_PORTION_VERSION ||
    typeof value.calculation_version !== 'string' ||
    typeof value.line_ref !== 'string' ||
    typeof value.ingredient_identity_digest !== 'string' ||
    typeof value.bundle_release !== 'string' ||
    typeof value.catalog_digest !== 'string' ||
    typeof value.fdc_id !== 'number' ||
    !Number.isSafeInteger(value.fdc_id) ||
    value.fdc_id <= 0 ||
    typeof value.record_digest !== 'string' ||
    typeof value.candidates_digest !== 'string' ||
    !Number.isSafeInteger(value.portion_index) ||
    (value.portion_index as number) < 0 ||
    !isPositiveFinite(value.portion_amount) ||
    !isPositiveFinite(value.gram_weight) ||
    typeof value.measure !== 'string' ||
    !(value.count_unit === null || typeof value.count_unit === 'string') ||
    !(value.count_size === null || typeof value.count_size === 'string') ||
    typeof value.selection_digest !== 'string'
  ) {
    return { ok: false, unsafe: false };
  }
  const selection: CountPortionSelection = {
    count_portion_version: COUNT_PORTION_VERSION,
    calculation_version: value.calculation_version as string,
    line_ref: value.line_ref as string,
    ingredient_identity_digest: value.ingredient_identity_digest as string,
    bundle_release: value.bundle_release as string,
    catalog_digest: value.catalog_digest as string,
    fdc_id: value.fdc_id as number,
    record_digest: value.record_digest as string,
    candidates_digest: value.candidates_digest as string,
    portion_index: value.portion_index as number,
    portion_amount: value.portion_amount as number,
    gram_weight: value.gram_weight as number,
    measure: value.measure as string,
    count_unit: (value.count_unit ?? null) as string | null,
    count_size: (value.count_size ?? null) as string | null,
    selection_digest: value.selection_digest as string,
  };
  const expected = computeCountPortionSelectionDigest({
    count_portion_version: selection.count_portion_version,
    calculation_version: selection.calculation_version,
    line_ref: selection.line_ref,
    ingredient_identity_digest: selection.ingredient_identity_digest,
    bundle_release: selection.bundle_release,
    catalog_digest: selection.catalog_digest,
    fdc_id: selection.fdc_id,
    record_digest: selection.record_digest,
    candidates_digest: selection.candidates_digest,
    portion_index: selection.portion_index,
    portion_amount: selection.portion_amount,
    gram_weight: selection.gram_weight,
    measure: selection.measure,
    count_unit: selection.count_unit,
    count_size: selection.count_size,
  });
  if (selection.selection_digest !== expected) return { ok: false, unsafe: false };
  return { ok: true, selection };
}
