/**
 * The Kitchen Codex — Advanced Nutrition Phase 3: derived-only Daily Values.
 *
 * PURE. `%DV` is ALWAYS derived at read time from the pinned
 * `fda_adult_4plus_2020` standard and is NEVER stored in the advisory preview
 * totals or any persisted schema. Missing nutrients are unavailable (never 0%);
 * an explicit calculated zero yields 0% when the nutrient has an established DV;
 * nutrients without a DV keep the existing unavailable reason.
 */

import {
  dailyValuePercent,
  DV_STANDARD_ID,
  type DailyValueUnavailableReason,
} from '../dailyValues';
import { NUTRIENT_REGISTRY, type NutrientId } from '../nutrients';

export type DerivedDailyValue =
  | { readonly available: true; readonly percent: number; readonly standard: string }
  | { readonly available: false; readonly reason: 'missing' | DailyValueUnavailableReason };

/**
 * Derives `%DV` for a nutrient amount. `amount === undefined` means the nutrient
 * is missing (unavailable, never 0%). A present amount (including explicit zero)
 * is evaluated against the pinned standard.
 */
export function deriveDailyValue(nutrient: NutrientId, amount: number | undefined): DerivedDailyValue {
  if (amount === undefined) return { available: false, reason: 'missing' };
  const definition = NUTRIENT_REGISTRY[nutrient];
  return dailyValuePercent(nutrient, amount, definition.unit, DV_STANDARD_ID);
}

export { DV_STANDARD_ID };
