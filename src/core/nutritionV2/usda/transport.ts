/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: pinned download transport
 * schemas.
 *
 * PURE, platform-neutral. These closed field sets describe the EXACT official
 * transport shapes present in the three pinned USDA FoodData Central downloads.
 * They were derived from a full census of every record in:
 *   - Foundation Foods, April 2026;
 *   - SR Legacy, April 2018;
 *   - FNDDS 2021-2023, October 2024.
 *
 * A future USDA release that adds a field requires a manifest/adapter review
 * rather than silent trust: an unknown field for the pinned transport schema is
 * rejected.
 *
 * Field policy
 * ------------
 *   - authoritative-read: the adapter reads the value into the canonical record
 *     (description, fdcId, dataType, foodNutrients[].nutrient.id/unitName/amount,
 *     foodPortions[], category description).
 *   - validated-but-ignored: the field is materialized and bounded by the raw
 *     walker, then discarded (foodClass, foodAttributes, inputFoods,
 *     nutrientConversionFactors, publicationDate, ndbNumber, scientificName,
 *     isHistoricalReference, foodCode, startDate, endDate, footnote,
 *     foodNutrientDerivation, dataPoints, min/max/median, entry id/type,
 *     portion minYearAcquired/abbreviation). It never enters the canonical
 *     record, extensions, cache, manifest, or provenance.
 */

import type { UsdaDataType } from './types';

/** Exact official transport labels mapped to internal closed identifiers. */
export const USDA_DOWNLOAD_LABELS: Readonly<Record<string, UsdaDataType>> = Object.freeze({
  Foundation: 'foundation',
  'SR Legacy': 'sr_legacy',
  'Survey (FNDDS)': 'fndds',
});

/** Reverse map for tests/diagnostics. */
export const USDA_DOWNLOAD_LABEL_BY_TYPE: Readonly<Record<UsdaDataType, string>> = Object.freeze({
  foundation: 'Foundation',
  sr_legacy: 'SR Legacy',
  fndds: 'Survey (FNDDS)',
});

const COMMON_TOP = [
  'dataType',
  'description',
  'fdcId',
  'foodClass',
  'foodAttributes',
  'foodNutrients',
  'foodPortions',
  'inputFoods',
  'publicationDate',
];
const LEGACY_TOP = [
  ...COMMON_TOP,
  'foodCategory',
  'isHistoricalReference',
  'ndbNumber',
  'nutrientConversionFactors',
  'scientificName',
];
const FNDDS_TOP = [...COMMON_TOP, 'endDate', 'foodCode', 'footnote', 'startDate', 'wweiaFoodCategory'];

const FOUNDATION_NUTRIENT = [
  'amount',
  'dataPoints',
  'foodNutrientDerivation',
  'footnote',
  'id',
  'max',
  'median',
  'min',
  'nutrient',
  'type',
];
const SR_LEGACY_NUTRIENT = [
  'amount',
  'dataPoints',
  'foodNutrientDerivation',
  'id',
  'max',
  'min',
  'nutrient',
  'type',
];
const FNDDS_NUTRIENT = ['amount', 'id', 'nutrient', 'type'];

export const USDA_NUTRIENT_DESCRIPTOR_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'number',
  'rank',
  'unitName',
]);

export const USDA_MEASURE_UNIT_KEYS: ReadonlySet<string> = new Set(['abbreviation', 'id', 'name']);

const FOUNDATION_PORTION = [
  'amount',
  'gramWeight',
  'id',
  'measureUnit',
  'minYearAcquired',
  'modifier',
  'portionDescription',
  'sequenceNumber',
  'value',
];
const SR_LEGACY_PORTION = [
  'amount',
  'gramWeight',
  'id',
  'measureUnit',
  'modifier',
  'portionDescription',
  'sequenceNumber',
  'value',
];
const FNDDS_PORTION = [
  'gramWeight',
  'id',
  'measureUnit',
  'modifier',
  'portionDescription',
  'sequenceNumber',
];

/** Closed category shapes. Foundation/SR Legacy use `{description}`; FNDDS uses WWEA. */
export const USDA_FOOD_CATEGORY_KEYS: ReadonlySet<string> = new Set(['description']);
export const USDA_WWEIA_CATEGORY_KEYS: ReadonlySet<string> = new Set([
  'wweiaFoodCategoryCode',
  'wweiaFoodCategoryDescription',
]);

export interface UsdaTransportSchema {
  readonly top: ReadonlySet<string>;
  readonly nutrientEntry: ReadonlySet<string>;
  readonly portion: ReadonlySet<string>;
}

export const USDA_TRANSPORT_SCHEMAS: Readonly<Record<UsdaDataType, UsdaTransportSchema>> =
  Object.freeze({
    foundation: Object.freeze({
      top: new Set(LEGACY_TOP),
      nutrientEntry: new Set(FOUNDATION_NUTRIENT),
      portion: new Set(FOUNDATION_PORTION),
    }),
    sr_legacy: Object.freeze({
      top: new Set(LEGACY_TOP),
      nutrientEntry: new Set(SR_LEGACY_NUTRIENT),
      portion: new Set(SR_LEGACY_PORTION),
    }),
    fndds: Object.freeze({
      top: new Set(FNDDS_TOP),
      nutrientEntry: new Set(FNDDS_NUTRIENT),
      portion: new Set(FNDDS_PORTION),
    }),
  });

/** True when every own key of `object` is in `allowed`. */
export function hasOnlyAllowedKeys(
  object: Record<string, unknown>,
  allowed: ReadonlySet<string>
): boolean {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}
