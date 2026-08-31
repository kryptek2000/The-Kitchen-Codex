/**
 * The Kitchen Codex — Deterministic Nutrition Serving-Scaling Utility
 *
 * Contract:
 * A recipe's ingredients represent ONE FIXED RECIPE BATCH corresponding to the
 * recipe's ORIGINAL serving count. The backend AI/offline estimator produces
 * TOTAL nutrition for that entire batch. All serving arithmetic is performed
 * here, deterministically, in application code:
 *
 *   perServing       = totalNutrition / baseServings
 *   requestedNutrition = perServing × requestedServings
 *
 * Changing the serving selector MUST NOT re-invoke the estimator; it is pure
 * local arithmetic on the stable stored recipe-total baseline.
 *
 * Note on legacy data: old nutrition blocks stored values as PER-SERVING and
 * carried no serving denominator. Those blocks are detected by the absence of
 * a numeric `servings` field and are treated as a value for a batch of 1
 * serving (base = 1), so `perServing × requested` holds exactly. New blocks
 * store TOTAL nutrition plus an explicit `servings` denominator.
 */

import { RecipeNutrition } from '../types';

/**
 * Numeric metadata on a nutrition object that must never be scaled by the
 * serving factor. `servings` is the denominator itself; future non-scalable
 * numeric metadata should be added here so it cannot be accidentally scaled.
 */
const NON_SCALING_NUMERIC_KEYS = new Set<string>(['servings']);

/**
 * Coerces any value into a positive, finite serving count >= 1.
 * 0, NaN, negative, undefined, null and non-numeric values safely fall back,
 * so downstream math can never produce NaN or negative nutrition.
 */
export function normalizeServings(value: unknown, fallback: number = 1): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (Number.isFinite(n) && n > 0) return n;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
}

/**
 * Returns the effective base serving count for scaling a given nutrition block.
 *
 * - When the block carries an explicit numeric `servings` denominator, the
 *   stored values are TOTAL recipe nutrition for that many servings → return it.
 * - Otherwise the block is a legacy PER-SERVING value → treat it as a batch of
 *   1 serving so `value × requestedServings` yields the requested total.
 */
export function resolveNutritionBase(nutrition: RecipeNutrition | null | undefined): number {
  if (nutrition && typeof (nutrition as RecipeNutrition).servings === 'number') {
    return normalizeServings((nutrition as RecipeNutrition).servings, 1);
  }
  return 1;
}

/**
 * Scales TOTAL recipe nutrition for `baseServings` to the nutrition for
 * `requestedServings`.
 *
 * `nutrition` MUST represent TOTAL nutrition for the whole recipe batch
 * corresponding to `baseServings`. The exact same factor
 * `requestedServings / baseServings` is applied to every numeric nutrient field
 * (calories, protein, carbohydrates, fat, fiber, sodium and any future numeric
 * field), so no nutrient can drift out of proportion. Non-numeric fields
 * (confidenceNote, etc.) are preserved. The `servings` denominator is preserved.
 *
 * No rounding is performed here; rounding happens once at the display/storage
 * boundary via `roundNutritionForDisplay`.
 */
export function nutritionForServings(
  nutrition: RecipeNutrition | null | undefined,
  baseServings: number,
  requestedServings: number
): RecipeNutrition {
  const base = normalizeServings(baseServings, 1);
  const requested = normalizeServings(requestedServings, base);
  const factor = requested / base;

  const result: Record<string, unknown> = {};
  const source = nutrition ?? {};
  for (const key of Object.keys(source)) {
    const value = (source as Record<string, unknown>)[key];
    if (NON_SCALING_NUMERIC_KEYS.has(key)) {
      result[key] = value;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const scaled = value * factor;
      result[key] = Number.isFinite(scaled) ? Math.max(0, scaled) : 0;
    } else {
      result[key] = value;
    }
  }
  return result as RecipeNutrition;
}

/**
 * Rounds a nutrition value for display/storage, matching the field precision
 * conventions: calories & sodium are whole integers, macro grams are 1 decimal.
 * Applied only at the final display boundary so intermediate arithmetic stays
 * exact and proportional.
 */
export function roundNutritionForDisplay(nutrition: RecipeNutrition | null | undefined): RecipeNutrition {
  const out: RecipeNutrition = { ...(nutrition ?? {}) };

  if (typeof out.calories === 'number') out.calories = Math.round(out.calories);
  if (typeof out.sodium === 'number') out.sodium = Math.round(out.sodium);

  for (const key of ['protein', 'carbohydrates', 'fat', 'fiber'] as const) {
    if (typeof out[key] === 'number') {
      out[key] = Math.round((out[key] as number) * 10) / 10;
    }
  }

  return out;
}

/**
 * Convenience: resolve the recipe's original serving count for a given recipe,
 * defaulting safely to 4 (the application's historical default) when the recipe
 * has no valid serving count. This is the base denominator used when a freshly
 * estimated TOTAL is attached to a recipe.
 */
export function resolveRecipeBaseServings(recipeServings: unknown): number {
  return normalizeServings(recipeServings, 4);
}
