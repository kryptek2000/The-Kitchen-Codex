/**
 * The Kitchen Codex — Advanced Nutrition v1: Daily Value (%DV) helper.
 *
 * PURE, platform-neutral. `%DV` is DERIVED at display/runtime and is NEVER
 * persisted in the schema (storing a percentage alongside an amount allows the
 * two to disagree). This helper returns a bounded percentage only when the
 * nutrient has an applicable Daily Value under the pinned standard.
 *
 * The Daily Values live in `nutrients.ts`; see that file for the official FDA
 * source URL, regulation, page version, and access date.
 */

import { NUTRIENT_REGISTRY, isNutrientId, type NutrientId } from './nutrients';
import { isCanonicalUnit, isValidNutrientAmount, type CanonicalUnit } from './units';

/**
 * The ONLY supported Daily Value standard. Pinned explicitly so a future
 * standard change is a deliberate, versioned migration.
 */
export const DV_STANDARD_ID = 'fda_adult_4plus_2020';

export const DV_STANDARD_SOURCE = Object.freeze({
  id: DV_STANDARD_ID,
  authority: 'U.S. Food and Drug Administration (FDA)',
  document: 'Daily Value on the Nutrition and Supplement Facts Labels',
  regulation: '21 CFR 101.9(c)(8)',
  url: 'https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels',
  pageVersionCurrentAsOf: '2024-03-05',
  accessed: '2026-09-14',
  population: 'Adults and children 4 years of age and older',
});

/** Upper bound on a returned %DV (guards absurd/overflowing inputs). */
export const MAX_DV_PERCENT = 100000;

export type DailyValueUnavailableReason =
  | 'unknown_standard'
  | 'unknown_nutrient'
  | 'invalid_unit'
  | 'invalid_amount'
  | 'no_daily_value'
  | 'percent_out_of_range';

export type DailyValueResult =
  | { available: true; percent: number; standard: typeof DV_STANDARD_ID }
  | { available: false; reason: DailyValueUnavailableReason };

/**
 * Calculates the bounded %DV for a registered nutrient amount in its canonical
 * unit. Returns `available: false` (never a guessed number) when the standard
 * is unknown, the nutrient/unit is unknown or mismatched, the amount is
 * invalid, or the nutrient has no established Daily Value.
 *
 * Explicit source-reported zero yields 0% (not "unavailable").
 */
export function dailyValuePercent(
  nutrient: NutrientId,
  amount: number,
  unit: CanonicalUnit,
  standard: string
): DailyValueResult {
  if (standard !== DV_STANDARD_ID) return { available: false, reason: 'unknown_standard' };
  if (!isNutrientId(nutrient)) return { available: false, reason: 'unknown_nutrient' };
  if (!isCanonicalUnit(unit)) return { available: false, reason: 'invalid_unit' };

  const def = NUTRIENT_REGISTRY[nutrient];
  if (unit !== def.unit) return { available: false, reason: 'invalid_unit' };
  if (!isValidNutrientAmount(amount)) return { available: false, reason: 'invalid_amount' };
  if (def.dailyValue === undefined || !(def.dailyValue > 0)) {
    return { available: false, reason: 'no_daily_value' };
  }

  const percent = (amount / def.dailyValue) * 100;
  if (!Number.isFinite(percent) || percent < 0 || percent > MAX_DV_PERCENT) {
    return { available: false, reason: 'percent_out_of_range' };
  }
  // FDA Nutrition Facts labels express %DV as a whole number.
  return { available: true, percent: Math.round(percent), standard: DV_STANDARD_ID };
}
