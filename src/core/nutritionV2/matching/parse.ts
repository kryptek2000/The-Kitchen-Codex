/**
 * The Kitchen Codex — Advanced Nutrition Phase 2: defensive ingredient parsing.
 *
 * PURE, offline. Accepts a bounded raw ingredient string OR the repository's
 * structured ingredient shape (as `unknown`), materializes it through the
 * existing safe inert-value boundary, and derives a bounded review view WITHOUT
 * mutating the source.
 *
 * It reuses the canonical measurement primitives (`normalizeIngredientMeasurement`,
 * `parseAmount`, `normalizeUnit`) and the deterministic line segmenter
 * (`parseRawIngredientMeasurementParts`) — no competing fraction parser or unit system.
 *
 * HONESTY RULES
 *  - a missing amount stays null (never defaulted to 1);
 *  - volume yields milliliters only (never grams);
 *  - count yields a count classification only (never grams);
 *  - unknown / "pinch" / "dash" / "to taste" stay unmeasurable (never grams);
 *  - an oversized line is REJECTED, never silently truncated to a different
 *    valid ingredient;
 *  - the source object and any wikilinks are preserved untouched.
 */

import { isPlainObject, toInertValue } from '../schema';
import {
  CANONICAL_INGREDIENT_PARSE_VERSION,
  getMeasurementKind,
  normalizeIngredientMeasurement,
  normalizeUnit,
  parseAmount,
  parseCanonicalIngredientParts,
  type CanonicalQuantity,
  type CanonicalQuantityKind,
  type CanonicalUnitKind,
  type MeasurementKind,
  type NormalizedUnit,
} from '../../../utils/measurements';
import { canonicalHouseholdUnit } from '../../../utils/householdUnits';
import {
  MAX_INGREDIENT_LINE_REF_LENGTH,
  MAX_INGREDIENT_NOTE_LENGTH,
  MAX_INGREDIENT_TEXT_LENGTH,
  phase2Failure,
  type IngredientParseResult,
  type ParsedIngredientReview,
  type RangeRepresentative,
} from './types';

const STRUCTURED_KEYS = new Set([
  'original',
  'amount',
  'unit',
  'name',
  'wikilink',
  'wikilinkTarget',
  'wikilinkAlias',
  'note',
  'isChecked',
  'line_ref',
  'index',
]);

function failure(code: Parameters<typeof phase2Failure>[0]): IngredientParseResult {
  return { ok: false, failure: phase2Failure(code) };
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? undefined : value;
}

/** Bounded leading approximation adverbs allowed before a secondary mass. */
const APPROXIMATION_PREFIX = /^(?:about|approximately|approx\.?|around|roughly|circa|~)\s+/i;

/** Any parenthesized group; nested groups are not part of the canonical input. */
const PARENTHETICAL_GROUP = /\(([^()]*)\)/g;

/**
 * NUTRIENT / NUTRITION-ANNOTATION syntax. A parenthetical that names a nutrient,
 * a per-serving qualifier, a %DV, or an energy value is NEVER ingredient mass;
 * it is metadata about what the food contains. This is a fail-closed exclusion
 * tested BEFORE any mass interpretation, so `1 cup flour (20 g protein)` can
 * never gain 20 g of direct mass.
 */
const NUTRIENT_ANNOTATION_PATTERN =
  /\b(?:protein|fats?|carb|carbs|carbohydrates?|fib(?:er|re)|sugars?|sodium|cholesterol|calor(?:ies|ie|y)|kcal|kilocalor(?:ies|ie|y))\b|%\s*dv\b|per\s+serving\b/i;

/**
 * Closed trailing phrases that make a quantity-only parenthetical a credible
 * TOTAL ingredient-mass clause: `(75-100 g in total)`, `(400 g net)`,
 * `(about 500 g, drained)`. Anything else after the quantity (`... protein`,
 * `... fat`, `... per serving`, `... of cake`) is NOT accepted as ingredient
 * mass. This is a positive grammar, not a food-name rule.
 */
const SECONDARY_MASS_TRAILING_ALLOWLIST: ReadonlySet<string> = new Set([
  'total',
  'in total',
  'altogether',
  'combined',
  'net',
  'net weight',
  'drained',
  'drained weight',
  'drained only',
]);

/**
 * Representative grams for the recipe's OWN explicit mass quantity, including a
 * bounded range. Policy (documented, deterministic): a direct MASS range uses
 * the arithmetic MIDPOINT of the author's own endpoints, because the nutrition
 * calculation needs one scalar and the author's range is the complete evidence.
 * No endpoint is silently chosen, no range outside a mass unit converts, and a
 * volume/count range stays unresolved (a midpoint count/volume would fake
 * precision the recipe never stated).
 */
function representativeMassGrams(
  quantity: CanonicalQuantity,
  rawUnit: string | null | undefined
): number | undefined {
  if (quantity.kind !== 'exact' && quantity.kind !== 'range') return undefined;
  const amount =
    quantity.kind === 'exact'
      ? quantity.amount
      : quantity.lower !== null && quantity.upper !== null
        ? (quantity.lower + quantity.upper) / 2
        : null;
  if (amount === null || !Number.isFinite(amount) || amount <= 0 || Object.is(amount, -0)) {
    return undefined;
  }
  const measurement = normalizeIngredientMeasurement({ amount, unit: rawUnit ?? undefined, name: '' });
  if (
    measurement.kind !== 'mass' ||
    typeof measurement.grams !== 'number' ||
    !Number.isFinite(measurement.grams) ||
    measurement.grams <= 0 ||
    Object.is(measurement.grams, -0)
  ) {
    return undefined;
  }
  return measurement.grams;
}

interface SecondaryMass {
  readonly grams: number;
  /** Exact source text so the clause can be stripped from the food query. */
  readonly text: string;
  /**
   * Present ONLY when the credible secondary mass was itself written as a
   * bounded RANGE; it carries the same deterministic midpoint representative
   * policy as a direct mass range.
   */
  readonly range: RangeRepresentative | undefined;
}

/**
 * Bounded, deterministic representative marker for a written MASS RANGE.
 * `undefined` for an exact author-written scalar, so a midpoint-derived mass is
 * always distinguishable downstream from an exact scalar. Display/evidence only;
 * it never changes the calculation authority (the endpoints remain the source).
 */
function rangeRepresentativeOf(
  rangeQuantity: { readonly lower: number; readonly upper: number } | undefined,
  rangeGrams: number | undefined,
  rawUnit: string | null | undefined
): RangeRepresentative | undefined {
  if (rangeQuantity === undefined || rangeGrams === undefined) return undefined;
  const unit = typeof rawUnit === 'string' ? rawUnit.trim() : '';
  if (unit.length === 0) return undefined;
  return Object.freeze({
    amount_source: 'written_mass_range' as const,
    policy: 'midpoint' as const,
    lower: rangeQuantity.lower,
    upper: rangeQuantity.upper,
    unit,
    representative_grams: rangeGrams,
  });
}

/**
 * The range marker for the source that ACTUALLY supplied the resolved grams: a
 * direct written mass range first, otherwise a credible secondary parenthetical
 * mass range. An exact measurement or an exact secondary scalar yields
 * `undefined`, so a range midpoint is never confused with an authored scalar.
 */
function resolvedRangeRepresentative(
  rangeQuantity: { readonly lower: number; readonly upper: number } | undefined,
  rangeGrams: number | undefined,
  rawUnit: string | null | undefined,
  secondaryMass: SecondaryMass | undefined,
  secondaryGrams: number | undefined
): RangeRepresentative | undefined {
  if (rangeGrams !== undefined) return rangeRepresentativeOf(rangeQuantity, rangeGrams, rawUnit);
  if (secondaryGrams !== undefined) return secondaryMass?.range;
  return undefined;
}

/**
 * Explicit SECONDARY mass declared in a parenthetical clause, e.g.
 * `3 to 4 slices provolone (about 75 to 100 grams in total)` or
 * `2 slices bacon (about 20 g)`. It uses the SAME bounded midpoint policy as a
 * direct mass range.
 *
 * POSITIVE GRAMMAR: after an optional approximation adverb, the clause must be
 * an explicit MASS quantity followed only by nothing or a closed "total mass"
 * trailing phrase. FAIL-CLOSED EXCLUSIONS: any nutrient/per-serving/%DV/energy
 * annotation is rejected before interpretation. Container lines (`1 (15 oz)
 * can ...`) are excluded: the canonical parser represents their package net
 * mass separately and never converts it.
 */
function extractParentheticalMass(originalText: string): SecondaryMass | undefined {
  if (!originalText.includes('(')) return undefined;
  for (const match of originalText.matchAll(PARENTHETICAL_GROUP)) {
    const rawInner = (match[1] ?? '').trim();
    if (rawInner.length === 0) continue;
    // Fail closed on nutrition annotations before any mass interpretation.
    if (NUTRIENT_ANNOTATION_PATTERN.test(rawInner)) continue;
    const inner = rawInner.replace(APPROXIMATION_PREFIX, '');
    if (inner.length === 0) continue;
    const parts = parseCanonicalIngredientParts(inner, { includeCount: false });
    if (parts.unitKind !== 'mass') continue;
    // A quantity-only clause has no residual food text AT ALL; the canonical
    // parser falls back `foodText` to the original text in that case, so an
    // equality test (not an empty-string test) identifies "no trailing words".
    const rawTrailing = parts.foodText === parts.originalText ? '' : parts.foodText;
    const trailing = rawTrailing
      .trim()
      .toLowerCase()
      .replace(/[.,;:!?]+$/g, '')
      .replace(/\s+/g, ' ');
    if (trailing.length > 0 && !SECONDARY_MASS_TRAILING_ALLOWLIST.has(trailing)) continue;
    const grams = representativeMassGrams(parts.quantity, parts.rawUnit);
    if (grams === undefined) continue;
    const rangeQuantity =
      parts.quantity.kind === 'range' &&
      parts.quantity.lower !== null &&
      parts.quantity.upper !== null
        ? { lower: parts.quantity.lower, upper: parts.quantity.upper }
        : undefined;
    return {
      grams,
      text: match[0],
      range: rangeRepresentativeOf(rangeQuantity, grams, parts.rawUnit),
    };
  }
  return undefined;
}

/** Removes an exact secondary-mass parenthetical from the food query. */
function stripSecondaryMassFromQuery(query: string, secondary: SecondaryMass | undefined): string {
  if (secondary === undefined || query.length === 0) return query;
  return query.split(secondary.text).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Removes nutrient-annotation parentheticals from the food query. Such a clause
 * is metadata, never identity: `1 cup flour (20 g protein)` must query `flour`,
 * not `flour (20 g protein)`. Only clauses matching the closed nutrient syntax
 * are removed; every other parenthetical is left untouched.
 */
function stripNutrientAnnotationsFromQuery(query: string): string {
  if (query.length === 0 || !query.includes('(')) return query;
  const cleaned = query
    .replace(PARENTHETICAL_GROUP, (whole, inner: string) =>
      NUTRIENT_ANNOTATION_PATTERN.test(String(inner)) ? ' ' : whole
    )
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : query;
}

interface StructuredUnitClassification {
  readonly kind: CanonicalUnitKind;
  readonly countNoun: string | undefined;
  readonly container: string | undefined;
}

/**
 * Classifies an explicit structured `unit` field through the ONE canonical
 * vocabulary: mass/volume ids, household count nouns, and containers. Never
 * assigns mass.
 */
function classifyStructuredUnit(unit: string | undefined): StructuredUnitClassification {
  if (unit === undefined) return { kind: 'unknown', countNoun: undefined, container: undefined };
  const normalized = normalizeUnit(unit);
  const kind = normalized ? getMeasurementKind(normalized) : 'unknown';
  if (kind === 'mass' || kind === 'volume') {
    return { kind, countNoun: undefined, container: undefined };
  }
  const household = canonicalHouseholdUnit(unit);
  if (household?.kind === 'count') {
    return { kind: 'count', countNoun: household.noun, container: undefined };
  }
  if (household?.kind === 'container') {
    return { kind: 'container', countNoun: undefined, container: household.noun };
  }
  return { kind: 'unknown', countNoun: undefined, container: undefined };
}

/**
 * Parses one ingredient (raw string or structured object) into a bounded review
 * view. Never throws; every failure is a closed, bounded classification.
 */
export function parseIngredient(raw: unknown): IngredientParseResult {
  try {
    if (typeof raw === 'string') return parseRawLine(raw);

    const materialized = toInertValue(raw);
    if (!materialized.ok) {
      const reason = (materialized as { ok: false; reason: string }).reason;
      if (
        reason === 'dangerous_key' ||
        reason === 'accessor_or_hidden_property' ||
        reason === 'array_accessor_or_hole' ||
        reason === 'reflection_failed' ||
        reason === 'cycle' ||
        reason === 'symbol_key'
      ) {
        return failure('unsafe_input');
      }
      if (reason === 'oversized') return failure('oversized_input');
      return failure('invalid_input');
    }
    if (!isPlainObject(materialized.value)) return failure('invalid_input');
    const source = materialized.value;

    for (const key of Object.keys(source)) {
      if (!STRUCTURED_KEYS.has(key)) return failure('unknown_field');
    }

    // Original text (bounded). Required as the base display/reference text.
    const original = boundedText(source.original, MAX_INGREDIENT_TEXT_LENGTH);
    if (source.original !== undefined && original === undefined) return failure('oversized_input');

    // Amount: absent/null stays null; present must parse to a finite number.
    let amount: number | null = null;
    if (source.amount !== undefined && source.amount !== null) {
      if (typeof source.amount !== 'number' && typeof source.amount !== 'string') {
        return failure('invalid_amount');
      }
      amount = parseAmount(source.amount as number | string);
      if (amount === null) return failure('invalid_amount');
    }

    // Unit (bounded).
    const unit = boundedText(source.unit, MAX_INGREDIENT_TEXT_LENGTH);
    if (source.unit !== undefined && source.unit !== null && unit === undefined) {
      return failure('oversized_input');
    }

    // Name (bounded).
    const name = boundedText(source.name, MAX_INGREDIENT_TEXT_LENGTH);
    if (source.name !== undefined && source.name !== null && name === undefined) {
      return failure('oversized_input');
    }

    // Non-authoritative note (bounded, optional).
    let note: string | undefined;
    if (source.note !== undefined && source.note !== null) {
      const boundedNote = boundedText(source.note, MAX_INGREDIENT_NOTE_LENGTH);
      if (boundedNote === undefined) return failure('oversized_input');
      const trimmedNote = boundedNote.trim();
      if (trimmedNote.length > 0) note = trimmedNote;
    }

    // Stable line reference (caller-supplied line_ref or index; else original).
    let lineRef: string;
    if (source.line_ref !== undefined && source.line_ref !== null) {
      const boundedRef = boundedText(source.line_ref, MAX_INGREDIENT_LINE_REF_LENGTH);
      if (boundedRef === undefined || boundedRef.trim().length === 0) return failure('invalid_line_ref');
      lineRef = boundedRef.trim();
    } else if (source.index !== undefined && source.index !== null) {
      if (
        typeof source.index !== 'number' ||
        !Number.isSafeInteger(source.index) ||
        Object.is(source.index, -0) ||
        source.index < 0
      ) {
        return failure('invalid_line_ref');
      }
      lineRef = `line:${source.index}`;
    } else {
      lineRef = original ?? name ?? '';
    }

    // The canonical Phase 1 parse of the source text is the authority for the
    // quantity-kind, unit classification, count noun, container, and package
    // net mass. A true range never collapses to an amount.
    const canonicalSourceText =
      (original ?? '').trim() ||
      `${amount ?? ''} ${unit ?? ''} ${name ?? ''}`.replace(/\s+/g, ' ').trim();
    const canonical = parseCanonicalIngredientParts(canonicalSourceText, { includeCount: true });

    // Explicit MASS RANGE from the recipe itself resolves via the documented
    // midpoint policy; a parenthetical explicit mass is the same authority class.
    const rangeGrams =
      canonical.quantity.kind === 'range'
        ? representativeMassGrams(canonical.quantity, canonical.rawUnit)
        : undefined;
    const secondaryMass =
      canonical.container === null ? extractParentheticalMass(canonicalSourceText) : undefined;

    // Derive the food-name query. Never invent a food name.
    let query = (name ?? '').trim();
    if (!query) {
      const base = (original ?? '').trim();
      if (base) query = parseCanonicalIngredientParts(base, { includeCount: true }).foodText.trim();
      if (!query) query = base;
    }
    query = stripNutrientAnnotationsFromQuery(stripSecondaryMassFromQuery(query, secondaryMass));
    if (query.length === 0) return failure('empty_query');
    if (query.length > MAX_INGREDIENT_TEXT_LENGTH) return failure('oversized_input');

    const originalText = (original ?? name ?? query).trim();

    // A stored range never keeps a single endpoint amount, even when the
    // structured `amount` field was authored against the older parse.
    const rangeQuantity =
      canonical.quantity.kind === 'range' &&
      canonical.quantity.lower !== null &&
      canonical.quantity.upper !== null
        ? { lower: canonical.quantity.lower, upper: canonical.quantity.upper }
        : undefined;
    const effectiveAmount = rangeQuantity !== undefined ? null : amount;

    const measurement = normalizeIngredientMeasurement({ amount: effectiveAmount, unit, name: query });
    const secondaryGrams =
      measurement.grams === undefined && rangeGrams === undefined ? secondaryMass?.grams : undefined;
    const measurementKind: MeasurementKind =
      secondaryGrams !== undefined ? 'mass' : (measurement.kind as MeasurementKind);
    const grams = measurement.grams ?? rangeGrams ?? secondaryGrams;
    const structuredUnit = classifyStructuredUnit(unit ?? undefined);
    const quantityKind: CanonicalQuantityKind = rangeQuantity
      ? 'range'
      : effectiveAmount !== null
        ? 'exact'
        : canonical.quantity.kind === 'invalid'
          ? 'invalid'
          : canonical.quantity.kind;
    return {
      ok: true,
      parsed: {
        line_ref: lineRef.length > 0 ? lineRef : originalText,
        original_text: originalText,
        amount: measurement.amount,
        raw_unit: measurement.rawUnit,
        normalized_unit: measurement.normalizedUnit as NormalizedUnit,
        measurement_kind: measurementKind,
        grams,
        milliliters: measurement.milliliters,
        count: measurement.kind === 'count',
        query,
        note,
        parse_version: CANONICAL_INGREDIENT_PARSE_VERSION,
        quantity_kind: quantityKind,
        quantity_range: rangeQuantity,
        range_representative: resolvedRangeRepresentative(
          rangeQuantity,
          rangeGrams,
          canonical.rawUnit,
          secondaryMass,
          secondaryGrams
        ),
        unit_kind: canonical.unitKind !== 'unknown' ? canonical.unitKind : structuredUnit.kind,
        count_noun: canonical.countNoun ?? structuredUnit.countNoun,
        container: canonical.container ?? structuredUnit.container,
        package_net_mass: canonical.packageNetMass ?? undefined,
      },
    };
  } catch {
    return failure('validation_error');
  }
}

function parseRawLine(raw: string): IngredientParseResult {
  if (raw.length > MAX_INGREDIENT_TEXT_LENGTH) return failure('oversized_input');
  const trimmed = raw.trim();
  if (trimmed.length === 0) return failure('empty_query');
  const canonical = parseCanonicalIngredientParts(trimmed, { includeCount: true });
  const rangeGrams =
    canonical.quantity.kind === 'range'
      ? representativeMassGrams(canonical.quantity, canonical.rawUnit)
      : undefined;
  const secondaryMass =
    canonical.container === null ? extractParentheticalMass(trimmed) : undefined;
  const query = stripNutrientAnnotationsFromQuery(
    stripSecondaryMassFromQuery(canonical.foodText.trim(), secondaryMass)
  );
  if (query.length === 0) return failure('empty_query');
  if (query.length > MAX_INGREDIENT_TEXT_LENGTH) return failure('oversized_input');

  const measurement = normalizeIngredientMeasurement({
    amount: canonical.quantity.kind === 'exact' ? canonical.quantity.amount : null,
    unit: canonical.rawUnit,
    name: query,
  });
  const secondaryGrams =
    measurement.grams === undefined && rangeGrams === undefined ? secondaryMass?.grams : undefined;
  const measurementKind: MeasurementKind =
    secondaryGrams !== undefined ? 'mass' : (measurement.kind as MeasurementKind);
  const grams = measurement.grams ?? rangeGrams ?? secondaryGrams;
  const rangeQuantity =
    canonical.quantity.kind === 'range' &&
    canonical.quantity.lower !== null &&
    canonical.quantity.upper !== null
      ? { lower: canonical.quantity.lower, upper: canonical.quantity.upper }
      : undefined;
  const quantityKind: CanonicalQuantityKind =
    canonical.quantity.kind === 'range'
      ? 'range'
      : canonical.quantity.kind === 'exact' && canonical.quantity.amount !== null
        ? 'exact'
        : canonical.quantity.kind;
  return {
    ok: true,
    parsed: {
      line_ref: trimmed,
      original_text: trimmed,
      amount: measurement.amount,
      raw_unit: measurement.rawUnit,
      normalized_unit: measurement.normalizedUnit as NormalizedUnit,
      measurement_kind: measurementKind,
      grams,
      milliliters: measurement.milliliters,
      count: measurement.kind === 'count',
      query,
      note: undefined,
      parse_version: CANONICAL_INGREDIENT_PARSE_VERSION,
      quantity_kind: quantityKind,
      quantity_range: rangeQuantity,
      range_representative: resolvedRangeRepresentative(
        rangeQuantity,
        rangeGrams,
        canonical.rawUnit,
        secondaryMass,
        secondaryGrams
      ),
      unit_kind: canonical.unitKind,
      count_noun: canonical.countNoun ?? undefined,
      container: canonical.container ?? undefined,
      package_net_mass: canonical.packageNetMass ?? undefined,
    },
  };
}
