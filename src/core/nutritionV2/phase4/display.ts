/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: display derivations.
 *
 * PURE, offline, display-only. The authoritative baseline is ALWAYS the
 * immutable Phase 3 entire-recipe total. Per-serving and selected-serving values
 * are DERIVED through the shared Phase 3 serving helpers, so repeated toggling
 * cannot drift and the totals are never mutated.
 *
 * `%DV` is derived for the CURRENTLY DISPLAYED amount and is never stored.
 * Missing nutrients remain missing (never `0%`); an explicit calculated zero
 * remains zero.
 */

import { NUTRIENT_IDS, NUTRIENT_REGISTRY, type NutrientId } from '../nutrients';
import { deriveDailyValue, type DerivedDailyValue } from '../calculation/dailyValues';
import { derivePerServing, deriveRequestedServing } from '../calculation/servings';
import type { CanonicalUnit } from '../units';
import type { AdvisoryNutritionPreview } from '../calculation/types';
import type {
  BasisMode,
  CoverageSummary,
  DisplayNutrient,
  IngredientEvidenceView,
  NutrientGroup,
} from './types';

/**
 * Explicit UI grouping for all 34 registered nutrients. Every registered
 * nutrient appears exactly once (proven by tests).
 */
export const NUTRIENT_GROUPS: ReadonlyArray<NutrientGroup> = Object.freeze([
  Object.freeze({
    id: 'energy_macros',
    label: 'Energy and macronutrients',
    nutrients: Object.freeze<NutrientId[]>(['calories', 'protein', 'carbohydrates', 'fat']),
  }),
  Object.freeze({
    id: 'fats',
    label: 'Fats and cholesterol',
    nutrients: Object.freeze<NutrientId[]>(['saturated_fat', 'trans_fat', 'cholesterol']),
  }),
  Object.freeze({
    id: 'carbohydrates',
    label: 'Carbohydrates and sugars',
    nutrients: Object.freeze<NutrientId[]>(['fiber', 'total_sugars', 'added_sugars']),
  }),
  Object.freeze({
    id: 'minerals',
    label: 'Minerals',
    nutrients: Object.freeze<NutrientId[]>([
      'sodium',
      'potassium',
      'calcium',
      'iron',
      'magnesium',
      'phosphorus',
      'zinc',
      'copper',
      'manganese',
      'selenium',
    ]),
  }),
  Object.freeze({
    id: 'vitamins',
    label: 'Vitamins and related nutrients',
    nutrients: Object.freeze<NutrientId[]>([
      'vitamin_a',
      'vitamin_c',
      'vitamin_d',
      'vitamin_e',
      'vitamin_k',
      'thiamin',
      'riboflavin',
      'niacin',
      'pantothenic_acid',
      'vitamin_b6',
      'biotin',
      'folate',
      'vitamin_b12',
      'choline',
    ]),
  }),
]);

/** Flattened registry order across the groups (for tests / iteration). */
export function allGroupedNutrients(): ReadonlyArray<NutrientId> {
  const out: NutrientId[] = [];
  for (const group of NUTRIENT_GROUPS) for (const nutrient of group.nutrients) out.push(nutrient);
  return Object.freeze(out);
}

/** ASCII-safe stored unit -> display label (`ug` -> `µg`). */
export function formatUnitLabel(unit: CanonicalUnit): string {
  switch (unit) {
    case 'ug':
      return 'µg';
    case 'ug_rae':
      return 'µg RAE';
    case 'mg_ne':
      return 'mg NE';
    case 'ug_dfe':
      return 'µg DFE';
    default:
      return unit;
  }
}

function scaleTotal(
  total: number,
  basis: BasisMode,
  baseServings: number,
  selectedServings: number
): number {
  if (basis === 'entire_recipe') return total;
  if (basis === 'per_serving') return derivePerServing(total, baseServings);
  return deriveRequestedServing(total, baseServings, selectedServings);
}

export function basisLabel(basis: BasisMode, selectedServings: number): string {
  switch (basis) {
    case 'entire_recipe':
      return 'Entire recipe';
    case 'per_serving':
      return 'Per serving';
    case 'selected_servings':
      return `${selectedServings} serving${selectedServings === 1 ? '' : 's'}`;
  }
}

/**
 * Derives one display row per registered nutrient (all 34, always in registry
 * order). Missing nutrients stay missing; explicit zeros stay zero.
 */
export function deriveDisplayNutrients(
  preview: AdvisoryNutritionPreview,
  basis: BasisMode,
  baseServings: number,
  selectedServings: number
): ReadonlyArray<DisplayNutrient> {
  const out: DisplayNutrient[] = [];
  for (const nutrient of NUTRIENT_IDS) {
    const def = NUTRIENT_REGISTRY[nutrient];
    const total = preview.totals[nutrient];
    if (!total) {
      const dv: DerivedDailyValue = deriveDailyValue(nutrient, undefined);
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
    const amount = scaleTotal(total.amount, basis, baseServings, selectedServings);
    const dv = deriveDailyValue(nutrient, amount);
    out.push(
      Object.freeze({
        nutrient,
        label: def.label,
        unit: def.unit,
        unit_label: formatUnitLabel(def.unit),
        amount,
        explicit_zero: amount === 0,
        coverage: total.status === 'complete' ? ('complete' as const) : ('partial' as const),
        covered_ingredient_count: total.covered_ingredient_count,
        measurable_ingredient_count: total.measurable_ingredient_count,
        percent_daily_value: dv,
      })
    );
  }
  return Object.freeze(out);
}

export function coverageSummary(preview: AdvisoryNutritionPreview): CoverageSummary {
  return Object.freeze({
    status: preview.status,
    unresolved_count: preview.unresolved.length,
    total_ingredients: preview.ingredients.length,
  });
}

export function ingredientEvidenceViews(
  preview: AdvisoryNutritionPreview
): ReadonlyArray<IngredientEvidenceView> {
  return Object.freeze(
    preview.ingredients.map((entry) =>
      Object.freeze({
        line_ref: entry.line_ref,
        original_text: entry.original_text,
        outcome: entry.outcome,
        match_status: entry.match_status,
        user_confirmed: entry.user_confirmed,
        fdc_id: entry.fdc_id,
        mass_source: entry.mass_source,
        resolved_grams: entry.resolved_grams,
        portion_index: entry.portion_index,
        count_ingredient_amount: entry.count_ingredient_amount,
        count_portion_amount: entry.count_portion_amount,
        count_gram_weight: entry.count_gram_weight,
        count_unit: entry.count_unit,
        count_size: entry.count_size,
        count_deterministic: entry.count_deterministic,
        user_mass_quantity: entry.user_mass_quantity,
        user_mass_unit: entry.user_mass_unit,
        household_unit: entry.household_unit,
        household_size_class: entry.household_size_class ?? undefined,
        household_requires_state: entry.household_requires_state ?? undefined,
        household_authority_class: entry.household_authority_class,
        contributing_nutrients: entry.contributing_nutrients,
      })
    )
  );
}

/**
 * Bounded, user-facing mass-source evidence label. It never mislabels a
 * user-entered weight as USDA portion evidence.
 */
export function massSourceLabel(entry: IngredientEvidenceView): string {
  switch (entry.mass_source) {
    case 'direct_mass':
      return 'direct mass';
    case 'source_portion':
      return entry.fdc_id !== undefined ? `USDA source portion · FDC ${entry.fdc_id}` : 'USDA source portion';
    case 'count_portion':
      return entry.fdc_id !== undefined
        ? `USDA count portion · FDC ${entry.fdc_id}`
        : 'USDA count portion';
    case 'user_mass':
      return entry.user_mass_quantity !== undefined && entry.user_mass_unit !== undefined
        ? `user-entered total weight · ${entry.user_mass_quantity} ${entry.user_mass_unit}`
        : 'user-entered total weight';
    case 'household_portion':
      return householdPortionEvidenceLabel(entry);
    default:
      return 'no mass';
  }
}

/** Bounded household-portion dimension text, e.g. `1 clove · item · medium`. */
function householdDimensionText(entry: IngredientEvidenceView): string {
  const parts: string[] = [];
  if (entry.household_unit !== undefined) parts.push(entry.household_unit);
  if (entry.household_size_class !== undefined && entry.household_size_class.length > 0) {
    parts.push(entry.household_size_class);
  }
  if (entry.household_requires_state !== undefined && entry.household_requires_state.length > 0) {
    parts.push(entry.household_requires_state);
  }
  return parts.join(' · ');
}

/**
 * Truthful household-portion evidence label. An `usda_derived` record is a
 * vetted exact conversion; a `bounded_estimate` record is visibly an ESTIMATE.
 * It is never labeled USDA portion, user-entered, or AI-provided.
 */
export function householdPortionEvidenceLabel(entry: IngredientEvidenceView): string {
  const dimensions = householdDimensionText(entry);
  const suffix = dimensions.length > 0 ? ` · ${dimensions}` : '';
  if (entry.household_authority_class === 'bounded_estimate') {
    return `Kitchen Codex household estimate${suffix}`;
  }
  return `Kitchen Codex household portion${suffix}`;
}

/**
 * Bounded derivation math for an authenticated count-portion result, e.g.
 * `8 slices × 28 g per slice = 224 g`. Returns undefined for any other source.
 */
export function countDerivationLabel(entry: IngredientEvidenceView): string | undefined {
  if (entry.mass_source !== 'count_portion') return undefined;
  if (
    entry.count_ingredient_amount === undefined ||
    entry.count_portion_amount === undefined ||
    entry.count_gram_weight === undefined ||
    entry.resolved_grams === undefined
  ) {
    return undefined;
  }
  const unit = entry.count_unit ?? entry.count_size ?? 'portion';
  const ingredientLabel = `${entry.count_ingredient_amount} ${unit}${
    entry.count_ingredient_amount === 1 ? '' : 's'
  }`;
  return `${ingredientLabel} × ${entry.count_gram_weight} g per ${unit} = ${entry.resolved_grams} g`;
}

/** Formats a derived amount for display; `—` for missing, never `0`. */
export function formatAmount(amount: number | undefined): string {
  if (amount === undefined) return '—';
  if (amount === 0) return '0';
  if (Number.isInteger(amount)) return String(amount);
  return String(Math.round(amount * 1000) / 1000);
}

export function formatDailyValue(dv: { readonly available: boolean; readonly percent?: number }): string {
  if (!dv.available) return '—';
  return `${dv.percent ?? 0}%`;
}
