/**
 * The Kitchen Codex — Advanced Nutrition Phase 5C: SAVED ADVANCED REPORT.
 *
 * PURE, platform-neutral, read-only. This module projects an already-validated
 * canonical schema-v1/v2 `codex_nutrition` block into the detailed saved report
 * WITHOUT any Phase 2/3/4 session, catalog authentication, USDA bundle
 * reconstruction, candidate generation, or re-calculation.
 *
 * The saved report is a VIEW over the persisted entire-recipe totals:
 *   - `entire_recipe`    -> the stored totals, unchanged;
 *   - `per_serving`      -> stored totals / the STORED serving denominator;
 *   - `selected_servings`-> per-serving × selected serving count.
 *
 * Toggling the display basis never mutates the stored totals. Missing nutrients
 * stay missing (never `0`). `%DV` is derived for the displayed amount and never
 * stored. Nutrient-specific coverage is shown exactly as persisted (a nutrient
 * may be `partial` even when all ingredient lines resolved, because USDA may not
 * enumerate that field).
 */

import { NUTRIENT_IDS, NUTRIENT_REGISTRY, type NutrientId } from '../nutrients';
import { deriveDailyValue } from '../calculation/dailyValues';
import { derivePerServing, deriveRequestedServing } from '../calculation/servings';
import { formatUnitLabel, NUTRIENT_GROUPS } from '../phase4/display';
import type { BasisMode, DisplayNutrient, NutrientGroup } from '../phase4/types';
import type { CodexNutritionV1, CodexNutritionV2 } from '../schema';

export const SAVED_REPORT_VERSION = 'usda_phase5c_saved_report_v1';

export interface SavedReportMeta {
  readonly version: string;
  readonly status: string;
  readonly complete: boolean;
  readonly resolved_count: number;
  readonly unresolved_count: number;
  readonly ingredient_count: number;
  readonly servings: number;
  readonly dv_standard: string;
  readonly computed_at: string;
  readonly ingredient_digest: string;
  readonly usda_release: string | undefined;
  readonly nutrient_scope_count: number;
}

function scaleStored(
  amount: number,
  basis: BasisMode,
  baseServings: number,
  selectedServings: number
): number {
  if (basis === 'entire_recipe') return amount;
  if (basis === 'per_serving') return derivePerServing(amount, baseServings);
  return deriveRequestedServing(amount, baseServings, selectedServings);
}

/**
 * Projects every registered nutrient for the requested display basis. A stored
 * nutrient that is PRESENT is displayed (with its persisted coverage); an absent
 * nutrient stays `missing`. Never tops up from legacy/simple nutrition.
 */
export function deriveSavedReportNutrients(
  block: CodexNutritionV1 | CodexNutritionV2,
  basis: BasisMode,
  selectedServings: number
): ReadonlyArray<DisplayNutrient> {
  const baseServings = block.servings;
  const out: DisplayNutrient[] = [];
  for (const nutrient of NUTRIENT_IDS) {
    const def = NUTRIENT_REGISTRY[nutrient];
    const stored = block.nutrients[nutrient];
    if (!stored || typeof stored.amount !== 'number' || !Number.isFinite(stored.amount)) {
      const dv = deriveDailyValue(nutrient, undefined);
      out.push(
        Object.freeze({
          nutrient,
          label: def.label,
          unit: def.unit,
          unit_label: formatUnitLabel(def.unit),
          amount: undefined,
          explicit_zero: false,
          coverage: 'missing' as const,
          covered_ingredient_count: 0,
          measurable_ingredient_count: 0,
          percent_daily_value: dv,
        })
      );
      continue;
    }
    const amount = scaleStored(stored.amount, basis, baseServings, selectedServings);
    const dv = deriveDailyValue(nutrient, amount);
    out.push(
      Object.freeze({
        nutrient,
        label: def.label,
        unit: def.unit,
        unit_label: formatUnitLabel(def.unit),
        amount,
        explicit_zero: amount === 0,
        coverage: stored.status === 'complete' ? ('complete' as const) : ('partial' as const),
        covered_ingredient_count: stored.covered_ingredient_count,
        measurable_ingredient_count: stored.measurable_ingredient_count,
        percent_daily_value: dv,
      })
    );
  }
  return Object.freeze(out);
}

/** Bounded, display-safe saved-report metadata. Never throws on a valid block. */
export function savedReportMeta(block: CodexNutritionV1 | CodexNutritionV2): SavedReportMeta {
  const resolved = block.ingredients.length;
  const unresolved = block.unresolved.length;
  return Object.freeze({
    version: SAVED_REPORT_VERSION,
    status: block.status,
    complete: block.status === 'complete' && unresolved === 0,
    resolved_count: resolved,
    unresolved_count: unresolved,
    ingredient_count: resolved + unresolved,
    servings: block.servings,
    dv_standard: block.dv_standard,
    computed_at: block.computed_at,
    ingredient_digest: block.ingredient_digest,
    usda_release: block.source_releases.usda_fdc,
    nutrient_scope_count: block.nutrient_scope.length,
  });
}

/** The explicit nutrient groups for the saved report (same grouping as Phase 4). */
export function savedReportGroups(): ReadonlyArray<NutrientGroup> {
  return NUTRIENT_GROUPS;
}

/**
 * Derives the compact recipe-facing PER-SERVING values from a COMPLETE saved
 * Advanced block. Returns undefined unless the block is complete. The returned
 * block declares `servings: 1`, so it represents ONE serving and any downstream
 * serving scaling is mathematically correct. The canonical stored block remains
 * ENTIRE-RECIPE totals; this is a display derivation only and shares the exact
 * `derivePerServing` math used everywhere else (no new rounding scheme).
 */
export function deriveAdvancedCompactPerServing(
  block: CodexNutritionV1 | CodexNutritionV2
): { calories?: number; protein?: number; carbohydrates?: number; fat?: number; fiber?: number; sodium?: number; servings: number } | undefined {
  if (block.status !== 'complete' || block.unresolved.length > 0) return undefined;
  const base = block.servings;
  const out: {
    calories?: number;
    protein?: number;
    carbohydrates?: number;
    fat?: number;
    fiber?: number;
    sodium?: number;
    servings: number;
  } = { servings: 1 };
  const perServing = (id: NutrientId): number | undefined => {
    const stored = block.nutrients[id];
    if (!stored || typeof stored.amount !== 'number' || !Number.isFinite(stored.amount)) return undefined;
    const value = derivePerServing(stored.amount, base);
    return Number.isFinite(value) ? value : undefined;
  };
  const calories = perServing('calories');
  const protein = perServing('protein');
  const carbohydrates = perServing('carbohydrates');
  const fat = perServing('fat');
  const fiber = perServing('fiber');
  const sodium = perServing('sodium');
  if (calories !== undefined) out.calories = calories;
  if (protein !== undefined) out.protein = protein;
  if (carbohydrates !== undefined) out.carbohydrates = carbohydrates;
  if (fat !== undefined) out.fat = fat;
  if (fiber !== undefined) out.fiber = fiber;
  if (sodium !== undefined) out.sodium = sodium;
  return out;
}
