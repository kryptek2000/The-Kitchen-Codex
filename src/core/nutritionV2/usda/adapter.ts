/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: pinned USDA download-record
 * adapter.
 *
 * PURE, platform-neutral. Accepts ONE untrusted official USDA FoodData Central
 * download record plus a validated release context and returns either one
 * canonical trusted record or a closed, bounded, input-redacted failure.
 *
 * SUPPORTED INPUT (exact)
 * -----------------------
 * The adapter consumes the ACTUAL pinned downloadable JSON record shapes
 * directly — no caller reshaping:
 *   - `Foundation`       -> `foundation`  (Foundation Foods, April 2026)
 *   - `SR Legacy`        -> `sr_legacy`   (SR Legacy, April 2018)
 *   - `Survey (FNDDS)`   -> `fndds`       (FNDDS 2021-2023, October 2024)
 * Unknown, case-altered, ambiguous, branded, experimental, or caller-supplied
 * internal labels are rejected. Only the pinned downloads are supported; there
 * is no live-API support and no automatic discovery of future releases.
 *
 * TRUST SEQUENCE
 * --------------
 *   untrusted value -> bounded raw materialization (raw transport bounds) ->
 *   exact data-type dispatch -> closed transport-shape validation -> read only
 *   authoritative fields -> exact stable nutrient-ID mapping -> canonical-unit
 *   validation/conversion -> canonical trusted record -> (caller) immutable
 *   store -> (caller) cache.
 *
 * The raw transport object is NEVER exposed or revisited after adaptation.
 */

import { isPlainObject } from '../schema';
import { isValidNutrientAmount } from '../units';
import type { NutrientId } from '../nutrients';
import {
  applyUsdaNutrientConversion,
  getUsdaNutrientMapping,
  normalizeUsdaUnitName,
  USDA_NUTRIENT_MAP_VERSION,
  type UsdaNutrientMapping,
} from './nutrientMap';
import { DEFAULT_RAW_RECORD_BOUNDS, materializeRawRecord } from './raw';
import {
  canonicalizeText,
  containsUnsafeText,
  isValidFdcId,
  withCanonicalRecordDigest,
  type CanonicalUsdaFoodRecordContent,
} from './record';
import {
  USDA_DOWNLOAD_LABELS,
  USDA_FOOD_CATEGORY_KEYS,
  USDA_MEASURE_UNIT_KEYS,
  USDA_NUTRIENT_DESCRIPTOR_KEYS,
  USDA_TRANSPORT_SCHEMAS,
  USDA_WWEIA_CATEGORY_KEYS,
  hasOnlyAllowedKeys,
} from './transport';
import {
  BUNDLE_RELEASE_PATTERN,
  MAX_PORTION_AMOUNT,
  MAX_PORTION_GRAM_WEIGHT,
  MAX_USDA_CATEGORY_LENGTH,
  MAX_USDA_DESCRIPTION_LENGTH,
  MAX_USDA_MEASURE_LENGTH,
  MAX_USDA_MODIFIER_LENGTH,
  MAX_USDA_RAW_NUTRIENTS,
  MAX_USDA_RAW_PORTIONS,
  USDA_ADAPT_FAILURE_MESSAGE,
  USDA_FOOD_BASIS,
  USDA_SOURCE_ID,
  type CanonicalNutrientRecord,
  type CanonicalPortionRecord,
  type UsdaAdaptFailureCode,
  type UsdaAdaptResult,
  type UsdaDataType,
  type UsdaReleaseContext,
} from './types';

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function fail(code: UsdaAdaptFailureCode): UsdaAdaptResult {
  return { ok: false, failure: { code, message: USDA_ADAPT_FAILURE_MESSAGE[code] } };
}

function mapRawFailure(reason: string): UsdaAdaptFailureCode {
  switch (reason) {
    case 'oversized':
      return 'record_too_large';
    case 'too_many_keys':
    case 'string_too_long':
    case 'invalid_array_length':
    case 'unusual_array':
      return 'oversized';
    case 'dangerous_key':
    case 'accessor_or_hidden_property':
    case 'array_accessor_or_hole':
    case 'reflection_failed':
      return 'unsafe';
    default:
      return 'malformed';
  }
}

function isPositiveFinite(value: unknown, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    !Object.is(value, -0) &&
    value > 0 &&
    value <= max
  );
}

/**
 * Presence-sensitive portion amount policy. A present source amount must satisfy
 * the canonical numeric contract (`isValidNutrientAmount`: finite, non-negative,
 * not `-0`, within the absolute bound, at most 6 decimal places, safe) AND be
 * strictly positive and within the portion bound. Zero, `-0`, negatives,
 * non-finite values, numeric strings, and over-precise/unsafe/excessive values
 * all fail. A present invalid amount is never omitted or replaced.
 */
function isValidPortionAmount(value: unknown, max: number): value is number {
  return isValidNutrientAmount(value) && value > 0 && value <= max;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0;
}

/** Validates the caller-supplied release context (already canonical data). */
function validateContext(context: unknown): context is UsdaReleaseContext {
  if (!isPlainObject(context)) return false;
  const bundle = context.bundle_release;
  if (typeof bundle !== 'string' || !BUNDLE_RELEASE_PATTERN.test(bundle)) return false;
  const upstream = context.upstream_release;
  if (typeof upstream !== 'string' || upstream.length < 1 || upstream.length > 64) return false;
  const dataType = context.data_type;
  if (dataType !== 'foundation' && dataType !== 'sr_legacy' && dataType !== 'fndds') return false;
  if (context.nutrient_map_version !== USDA_NUTRIENT_MAP_VERSION) return false;
  return true;
}

interface MappedCandidate {
  readonly mapping: UsdaNutrientMapping;
  readonly amount: number;
  readonly sourceUnit: string;
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; code: UsdaAdaptFailureCode };

/** Extracts the failure code from a failed `ReadResult` (call only when `!ok`). */
function failureCode<T>(result: ReadResult<T>): UsdaAdaptFailureCode {
  return (result as { ok: false; code: UsdaAdaptFailureCode }).code;
}

function readDescription(source: Record<string, unknown>): ReadResult<string> {
  const raw = source.description;
  if (typeof raw !== 'string') return { ok: false, code: 'malformed' };
  if (raw.length > MAX_USDA_DESCRIPTION_LENGTH) return { ok: false, code: 'oversized' };
  const description = canonicalizeText(raw);
  if (description.length < 1) return { ok: false, code: 'malformed' };
  if (containsUnsafeText(description)) return { ok: false, code: 'unsafe' };
  return { ok: true, value: description };
}

function canonicalizeCategory(text: string): ReadResult<string> {
  if (text.length > MAX_USDA_CATEGORY_LENGTH) return { ok: false, code: 'oversized' };
  const canonical = canonicalizeText(text);
  if (canonical.length > 0 && containsUnsafeText(canonical)) return { ok: false, code: 'unsafe' };
  return { ok: true, value: canonical };
}

function readCategory(
  source: Record<string, unknown>,
  dataType: UsdaDataType
): ReadResult<string | undefined> {
  if (dataType === 'fndds') {
    if (!hasOwn(source, 'wweiaFoodCategory')) return { ok: true, value: undefined };
    const raw = source.wweiaFoodCategory;
    if (raw === null || raw === undefined) return { ok: true, value: undefined };
    if (!isPlainObject(raw) || !hasOnlyAllowedKeys(raw, USDA_WWEIA_CATEGORY_KEYS)) {
      return { ok: false, code: 'malformed' };
    }
    if (typeof raw.wweiaFoodCategoryDescription !== 'string') return { ok: true, value: undefined };
    return canonicalizeCategory(raw.wweiaFoodCategoryDescription);
  }

  if (!hasOwn(source, 'foodCategory')) return { ok: true, value: undefined };
  const raw = source.foodCategory;
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  if (typeof raw === 'string') return canonicalizeCategory(raw);
  if (!isPlainObject(raw) || !hasOnlyAllowedKeys(raw, USDA_FOOD_CATEGORY_KEYS)) {
    return { ok: false, code: 'malformed' };
  }
  if (typeof raw.description !== 'string') return { ok: true, value: undefined };
  return canonicalizeCategory(raw.description);
}

function readNutrients(
  source: Record<string, unknown>,
  dataType: UsdaDataType
): ReadResult<MappedCandidate[]> {
  const rawNutrients = source.foodNutrients;
  // An official record may legitimately carry an EMPTY nutrient list (e.g. the
  // FNDDS "Milk, human" profile). That is not malformed; it has no supported
  // nutrients. A missing list is malformed.
  if (!Array.isArray(rawNutrients)) return { ok: false, code: 'malformed' };
  if (rawNutrients.length > MAX_USDA_RAW_NUTRIENTS) return { ok: false, code: 'oversized' };

  const schema = USDA_TRANSPORT_SCHEMAS[dataType];
  const candidates: MappedCandidate[] = [];
  for (const entry of rawNutrients) {
    if (!isPlainObject(entry) || !hasOnlyAllowedKeys(entry, schema.nutrientEntry)) {
      return { ok: false, code: 'malformed' };
    }
    const descriptor = entry.nutrient;
    if (!isPlainObject(descriptor) || !hasOnlyAllowedKeys(descriptor, USDA_NUTRIENT_DESCRIPTOR_KEYS)) {
      return { ok: false, code: 'malformed' };
    }
    const nutrientId = descriptor.id;
    if (typeof nutrientId !== 'number' || !Number.isSafeInteger(nutrientId)) {
      return { ok: false, code: 'malformed' };
    }
    if (typeof descriptor.unitName !== 'string') return { ok: false, code: 'malformed' };

    // A missing (absent or explicit-null) amount stays missing; it is never zero.
    const amount = entry.amount;
    if (amount === null || amount === undefined) continue;
    if (typeof amount !== 'number' || !isValidNutrientAmount(amount)) {
      return { ok: false, code: 'invalid_nutrient' };
    }

    const mapping = getUsdaNutrientMapping(nutrientId);
    if (!mapping) continue; // unsupported nutrient: ignored, never retained.

    const normalizedUnit = normalizeUsdaUnitName(descriptor.unitName);
    if (normalizedUnit !== mapping.source_unit) return { ok: false, code: 'unit_mismatch' };
    candidates.push({ mapping, amount, sourceUnit: normalizedUnit });
  }
  return { ok: true, value: candidates };
}

function resolveNutrients(
  candidates: MappedCandidate[]
): ReadResult<Partial<Record<NutrientId, CanonicalNutrientRecord>>> {
  const byNutrient = new Map<NutrientId, MappedCandidate[]>();
  for (const candidate of candidates) {
    const list = byNutrient.get(candidate.mapping.nutrient_id);
    if (list) list.push(candidate);
    else byNutrient.set(candidate.mapping.nutrient_id, [candidate]);
  }

  const nutrients: Partial<Record<NutrientId, CanonicalNutrientRecord>> = {};
  for (const [nutrientId, list] of byNutrient) {
    let resolved = list;
    if (list.length > 1 && nutrientId === 'calories') {
      const direct = list.filter((candidate) => candidate.mapping.energy_fallback !== true);
      if (direct.length > 0) resolved = direct;
    }
    if (resolved.length > 1) return { ok: false, code: 'duplicate_nutrient' };
    const candidate = resolved[0];
    const convertedAmount = applyUsdaNutrientConversion(candidate.mapping, candidate.amount);
    if (!isValidNutrientAmount(convertedAmount)) return { ok: false, code: 'invalid_nutrient' };
    nutrients[nutrientId] = {
      nutrient_id: nutrientId,
      unit: candidate.mapping.canonical_unit,
      amount_per_100g: convertedAmount,
      usda_nutrient_id: candidate.mapping.usda_nutrient_id,
      source_unit: candidate.sourceUnit,
      converted:
        candidate.mapping.conversion === 'mass_metric' ||
        candidate.mapping.conversion === 'energy_kj_to_kcal',
    };
  }
  if (Object.keys(nutrients).length === 0) return { ok: false, code: 'no_supported_nutrients' };
  return { ok: true, value: nutrients };
}

function readPortion(
  raw: unknown,
  schemaPortion: ReadonlySet<string>
): ReadResult<CanonicalPortionRecord> {
  if (!isPlainObject(raw)) return { ok: false, code: 'invalid_portion' };
  // An unknown portion field is a transport-shape violation, not bad content.
  if (!hasOnlyAllowedKeys(raw, schemaPortion)) return { ok: false, code: 'malformed' };
  if (hasOwn(raw, 'id') && !isValidFdcId(raw.id)) return { ok: false, code: 'invalid_portion' };
  if (!isPositiveFinite(raw.gramWeight, MAX_PORTION_GRAM_WEIGHT)) {
    return { ok: false, code: 'invalid_portion' };
  }

  // Presence-sensitive source amount. An absent property (or an explicit `null`)
  // is ABSENT. A present value must be a finite positive bounded number; a
  // present invalid value (0, -0, negative, non-finite, numeric string,
  // over-precise/unsafe/excessive) rejects the whole record — it is never
  // omitted, normalized, or replaced, and never falls back to `value`.
  // `value` (the official Foundation/SR Legacy alternate) is used only when
  // `amount` is genuinely absent; when BOTH are present they must both be valid
  // and equal, otherwise the contradictory pair fails closed. A missing amount
  // is never invented as 1.
  const amountPresent = hasOwn(raw, 'amount') && raw.amount !== null && raw.amount !== undefined;
  const valuePresent = hasOwn(raw, 'value') && raw.value !== null && raw.value !== undefined;
  let amount: number | undefined;
  if (amountPresent && valuePresent) {
    if (
      !isValidPortionAmount(raw.amount, MAX_PORTION_AMOUNT) ||
      !isValidPortionAmount(raw.value, MAX_PORTION_AMOUNT) ||
      raw.amount !== raw.value
    ) {
      return { ok: false, code: 'invalid_portion' };
    }
    amount = raw.amount as number;
  } else if (amountPresent) {
    if (!isValidPortionAmount(raw.amount, MAX_PORTION_AMOUNT)) return { ok: false, code: 'invalid_portion' };
    amount = raw.amount as number;
  } else if (valuePresent) {
    if (!isValidPortionAmount(raw.value, MAX_PORTION_AMOUNT)) return { ok: false, code: 'invalid_portion' };
    amount = raw.value as number;
  }

  let measureUnitName: string | undefined;
  if (hasOwn(raw, 'measureUnit')) {
    const measureUnit = raw.measureUnit;
    if (measureUnit !== null && measureUnit !== undefined) {
      if (!isPlainObject(measureUnit) || !hasOnlyAllowedKeys(measureUnit, USDA_MEASURE_UNIT_KEYS)) {
        return { ok: false, code: 'invalid_portion' };
      }
      if (typeof measureUnit.name === 'string') measureUnitName = measureUnit.name;
    }
  }
  const portionDescription = typeof raw.portionDescription === 'string' ? raw.portionDescription : undefined;

  let measureText = measureUnitName;
  if (measureText === undefined || measureText.trim().length === 0 || /^undetermined$/i.test(measureText.trim())) {
    if (portionDescription !== undefined && portionDescription.trim().length > 0) measureText = portionDescription;
  }
  if (typeof measureText !== 'string') return { ok: false, code: 'invalid_portion' };
  if (measureText.length > MAX_USDA_MEASURE_LENGTH) return { ok: false, code: 'invalid_portion' };
  const measure = canonicalizeText(measureText);
  if (measure.length < 1 || containsUnsafeText(measure)) return { ok: false, code: 'invalid_portion' };

  let modifier: string | undefined;
  if (hasOwn(raw, 'modifier')) {
    const rawModifier = raw.modifier;
    if (rawModifier !== null && rawModifier !== undefined) {
      if (typeof rawModifier !== 'string' || rawModifier.length > MAX_USDA_MODIFIER_LENGTH) {
        return { ok: false, code: 'invalid_portion' };
      }
      const canonicalModifier = canonicalizeText(rawModifier);
      if (containsUnsafeText(canonicalModifier)) return { ok: false, code: 'invalid_portion' };
      if (canonicalModifier.length > 0) modifier = canonicalModifier;
    }
  }

  let sequence: number | undefined;
  if (hasOwn(raw, 'sequenceNumber')) {
    if (!isSafeNonNegativeInteger(raw.sequenceNumber)) return { ok: false, code: 'invalid_portion' };
    sequence = raw.sequenceNumber as number;
  }

  return {
    ok: true,
    value: {
      ...(hasOwn(raw, 'id') ? { usda_portion_id: raw.id as number } : {}),
      ...(amount !== undefined ? { amount } : {}),
      measure,
      gram_weight: raw.gramWeight as number,
      ...(modifier !== undefined ? { modifier } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
    },
  };
}

function readPortions(
  source: Record<string, unknown>,
  dataType: UsdaDataType
): ReadResult<CanonicalPortionRecord[]> {
  if (!hasOwn(source, 'foodPortions')) return { ok: true, value: [] };
  const rawPortions = source.foodPortions;
  if (rawPortions === null || rawPortions === undefined) return { ok: true, value: [] };
  if (!Array.isArray(rawPortions)) return { ok: false, code: 'invalid_portion' };
  if (rawPortions.length > MAX_USDA_RAW_PORTIONS) return { ok: false, code: 'oversized' };

  const schemaPortion = USDA_TRANSPORT_SCHEMAS[dataType].portion;
  const portions: CanonicalPortionRecord[] = [];
  const seenIds = new Set<number>();
  for (const entry of rawPortions) {
    const result = readPortion(entry, schemaPortion);
    if (!result.ok) return { ok: false, code: failureCode(result) };
    const portion = result.value;
    if (portion.usda_portion_id !== undefined) {
      if (seenIds.has(portion.usda_portion_id)) return { ok: false, code: 'invalid_portion' };
      seenIds.add(portion.usda_portion_id);
    }
    portions.push(portion);
  }
  return { ok: true, value: portions };
}

/**
 * Adapts one untrusted official USDA download record. Never throws and never
 * propagates a raw exception: every failure returns a fixed, bounded
 * classification.
 */
export function adaptUsdaFood(raw: unknown, context: unknown): UsdaAdaptResult {
  try {
    if (!validateContext(context)) return fail('validation_error');

    const materialized = materializeRawRecord(raw, DEFAULT_RAW_RECORD_BOUNDS);
    if (!materialized.ok) {
      return fail(mapRawFailure((materialized as { ok: false; reason: string }).reason));
    }
    if (!isPlainObject(materialized.value)) return fail('malformed');
    const source = materialized.value;

    const label = source.dataType;
    if (typeof label !== 'string') return fail('malformed');
    const dataType = USDA_DOWNLOAD_LABELS[label];
    if (!dataType) return fail('unsupported_data_type');
    if (dataType !== context.data_type) return fail('release_mismatch');

    const schema = USDA_TRANSPORT_SCHEMAS[dataType];
    if (!hasOnlyAllowedKeys(source, schema.top)) return fail('malformed');

    if (!isValidFdcId(source.fdcId)) return fail('invalid_fdc_id');

    const description = readDescription(source);
    if (!description.ok) return fail(failureCode(description));

    const category = readCategory(source, dataType);
    if (!category.ok) return fail(failureCode(category));

    const candidates = readNutrients(source, dataType);
    if (!candidates.ok) return fail(failureCode(candidates));

    const nutrients = resolveNutrients(candidates.value);
    if (!nutrients.ok) return fail(failureCode(nutrients));

    const portions = readPortions(source, dataType);
    if (!portions.ok) return fail(failureCode(portions));

    const content: CanonicalUsdaFoodRecordContent = {
      source: USDA_SOURCE_ID,
      bundle_release: context.bundle_release,
      upstream_release: context.upstream_release,
      fdc_id: source.fdcId as number,
      data_type: dataType,
      description: description.value,
      ...(category.value !== undefined && category.value.length > 0
        ? { food_category: category.value }
        : {}),
      nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
      basis: USDA_FOOD_BASIS,
      nutrients: nutrients.value,
      portions: portions.value,
    };

    return { ok: true, record: withCanonicalRecordDigest(content) };
  } catch {
    return fail('validation_error');
  }
}
