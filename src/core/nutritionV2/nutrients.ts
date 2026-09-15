/**
 * The Kitchen Codex — Advanced Nutrition v1: closed nutrient registry.
 *
 * PURE, platform-neutral. A schema-v1 authoritative nutrient MUST be one of the
 * IDs below; unknown authoritative nutrient IDs are rejected in schema v1 and
 * may only travel in the bounded non-authoritative `extensions` namespace until
 * a future schema revision supports them.
 *
 * CANONICAL UNIT per nutrient is fixed here (single source of truth). Stored
 * amounts must use that exact unit; mismatched units are rejected.
 *
 * DAILY VALUES
 * ------------
 * The `dailyValue` numbers below are the FDA Daily Values for adults and
 * children 4 years of age and older, as published by the U.S. Food and Drug
 * Administration. They are NOT medical advice and are used only to derive a
 * bounded %DV label.
 *
 *   Source: U.S. Food and Drug Administration, "Daily Value on the Nutrition
 *           and Supplement Facts Labels"
 *   URL:    https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels
 *   Regulation: 21 CFR 101.9(c)(8)
 *   Page content current as of: 2024-03-05
 *   Accessed: 2026-09-14
 *   Standard id: fda_adult_4plus_2020 (the 2016/2020 label-update values)
 *
 * Nutrients with no established Daily Value (calories, trans fat, total sugars)
 * intentionally omit `dailyValue`; `%DV` is unavailable for them.
 */

import type { CanonicalUnit } from './units';

export type NutrientId =
  | 'calories'
  | 'protein'
  | 'carbohydrates'
  | 'fat'
  | 'saturated_fat'
  | 'trans_fat'
  | 'fiber'
  | 'total_sugars'
  | 'added_sugars'
  | 'cholesterol'
  | 'sodium'
  | 'potassium'
  | 'calcium'
  | 'iron'
  | 'magnesium'
  | 'phosphorus'
  | 'zinc'
  | 'copper'
  | 'manganese'
  | 'selenium'
  | 'vitamin_a'
  | 'vitamin_c'
  | 'vitamin_d'
  | 'vitamin_e'
  | 'vitamin_k'
  | 'thiamin'
  | 'riboflavin'
  | 'niacin'
  | 'pantothenic_acid'
  | 'vitamin_b6'
  | 'biotin'
  | 'folate'
  | 'vitamin_b12'
  | 'choline';

export interface NutrientDefinition {
  readonly id: NutrientId;
  /** The ONLY canonical unit accepted for this nutrient's stored amount. */
  readonly unit: CanonicalUnit;
  /** Human-readable label (display only). */
  readonly label: string;
  /**
   * FDA Daily Value for adults/children >= 4, expressed in the canonical unit,
   * or undefined when no Daily Value is established.
   */
  readonly dailyValue?: number;
  /** Notes the nutrient-specific equivalent basis (RAE/NE/DFE) where relevant. */
  readonly dailyValueNote?: string;
}

const REGISTRY: ReadonlyArray<NutrientDefinition> = [
  { id: 'calories', unit: 'kcal', label: 'Calories' },
  { id: 'protein', unit: 'g', label: 'Protein', dailyValue: 50 },
  { id: 'carbohydrates', unit: 'g', label: 'Total carbohydrate', dailyValue: 275 },
  { id: 'fat', unit: 'g', label: 'Total fat', dailyValue: 78 },
  { id: 'saturated_fat', unit: 'g', label: 'Saturated fat', dailyValue: 20 },
  { id: 'trans_fat', unit: 'g', label: 'Trans fat' },
  { id: 'fiber', unit: 'g', label: 'Dietary fiber', dailyValue: 28 },
  { id: 'total_sugars', unit: 'g', label: 'Total sugars' },
  { id: 'added_sugars', unit: 'g', label: 'Added sugars', dailyValue: 50 },
  { id: 'cholesterol', unit: 'mg', label: 'Cholesterol', dailyValue: 300 },
  { id: 'sodium', unit: 'mg', label: 'Sodium', dailyValue: 2300 },
  { id: 'potassium', unit: 'mg', label: 'Potassium', dailyValue: 4700 },
  { id: 'calcium', unit: 'mg', label: 'Calcium', dailyValue: 1300 },
  { id: 'iron', unit: 'mg', label: 'Iron', dailyValue: 18 },
  { id: 'magnesium', unit: 'mg', label: 'Magnesium', dailyValue: 420 },
  { id: 'phosphorus', unit: 'mg', label: 'Phosphorus', dailyValue: 1250 },
  { id: 'zinc', unit: 'mg', label: 'Zinc', dailyValue: 11 },
  { id: 'copper', unit: 'mg', label: 'Copper', dailyValue: 0.9 },
  { id: 'manganese', unit: 'mg', label: 'Manganese', dailyValue: 2.3 },
  { id: 'selenium', unit: 'ug', label: 'Selenium', dailyValue: 55 },
  { id: 'vitamin_a', unit: 'ug_rae', label: 'Vitamin A', dailyValue: 900, dailyValueNote: 'mcg RAE' },
  { id: 'vitamin_c', unit: 'mg', label: 'Vitamin C', dailyValue: 90 },
  { id: 'vitamin_d', unit: 'ug', label: 'Vitamin D', dailyValue: 20 },
  { id: 'vitamin_e', unit: 'mg', label: 'Vitamin E', dailyValue: 15, dailyValueNote: 'mg alpha-tocopherol' },
  { id: 'vitamin_k', unit: 'ug', label: 'Vitamin K', dailyValue: 120 },
  { id: 'thiamin', unit: 'mg', label: 'Thiamin', dailyValue: 1.2 },
  { id: 'riboflavin', unit: 'mg', label: 'Riboflavin', dailyValue: 1.3 },
  { id: 'niacin', unit: 'mg_ne', label: 'Niacin', dailyValue: 16, dailyValueNote: 'mg NE' },
  { id: 'pantothenic_acid', unit: 'mg', label: 'Pantothenic acid', dailyValue: 5 },
  { id: 'vitamin_b6', unit: 'mg', label: 'Vitamin B6', dailyValue: 1.7 },
  { id: 'biotin', unit: 'ug', label: 'Biotin', dailyValue: 30 },
  { id: 'folate', unit: 'ug_dfe', label: 'Folate', dailyValue: 400, dailyValueNote: 'mcg DFE' },
  { id: 'vitamin_b12', unit: 'ug', label: 'Vitamin B12', dailyValue: 2.4 },
  { id: 'choline', unit: 'mg', label: 'Choline', dailyValue: 550 },
];

/** Frozen closed registry keyed by nutrient id. */
export const NUTRIENT_REGISTRY: Readonly<Record<NutrientId, NutrientDefinition>> = Object.freeze(
  REGISTRY.reduce((acc, def) => {
    acc[def.id] = Object.freeze(def);
    return acc;
  }, {} as Record<NutrientId, NutrientDefinition>)
);

/** Stable order for deterministic iteration/serialization. */
export const NUTRIENT_IDS: ReadonlyArray<NutrientId> = Object.freeze(REGISTRY.map((def) => def.id));

export function isNutrientId(value: unknown): value is NutrientId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(NUTRIENT_REGISTRY, value);
}

export function getNutrientDefinition(id: NutrientId): NutrientDefinition {
  return NUTRIENT_REGISTRY[id];
}
