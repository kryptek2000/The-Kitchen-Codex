/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: stable USDA nutrient-ID map.
 *
 * PURE, platform-neutral. This is the ONE centralized, closed mapping from
 * verified USDA FoodData Central nutrient/component ids to Phase 0 `NutrientId`s.
 * It never maps by display name.
 *
 * VERIFICATION (pinned releases)
 * ------------------------------
 * The mapping was verified against the actual pinned official downloads:
 *   - Foundation Foods, April 2026  (fdc-datasets/...foundation...2026-04-30.zip)
 *   - SR Legacy, April 2018         (fdc-datasets/...sr_legacy...2018-04.zip)
 *   - FNDDS 2021-2023, October 2024 (fdc-datasets/...survey...2024-10-31.zip)
 * For every mapped id, the nutrient name and the single observed `unitName` were
 * confirmed across all three archives. The archives use lowercase unit labels
 * (`g`, `mg`, `µg`/U+00B5, `kcal`, `kJ`); `normalizeUsdaUnitName` canonicalizes
 * the micro sign and case before comparison. A mapped id arriving with any other
 * source unit is rejected (`unit_mismatch`); it is never converted.
 *
 * DELIBERATELY UNMAPPED (examples)
 * --------------------------------
 *   - 1104 Vitamin A, IU / 1110 Vitamin D, IU: IU is never converted.
 *   - 1177 Folate, total (µg): NOT mapped to `folate` (canonical `ug_dfe`).
 *     Only 1190 `Folate, DFE` is mapped; mass folate is never treated as DFE.
 *   - 1167 Niacin (mg): NOT mapped to `niacin` (canonical `mg_ne`). The pinned
 *     downloads expose NO niacin-equivalent component (1169 is absent), so
 *     `niacin` remains absent rather than converting plain mass niacin to NE.
 *   - 1235 Sugars, added: ABSENT from all three pinned releases, so
 *     `added_sugars` remains absent (no inference from total sugars).
 *   - 1105 Retinol / 1107 Carotene, beta / 1156 Vitamin A, RE: never merged
 *     into `vitamin_a` (canonical `ug_rae`). Only 1106 `Vitamin A, RAE`.
 *
 * ENERGY POLICY
 * -------------
 * Only 1008 (`Energy`, kcal) is the approved direct kilocalorie component. 1062
 * (`Energy`, kJ) is a documented FALLBACK used only when no 1008 is present,
 * converted with the existing exact 4.184 helper (`convertEnergy`). Energy
 * components are never summed, the first value is never chosen arbitrarily, a
 * duplicate direct component is rejected as a conflict, and the fallback never
 * creates a second calories entry.
 */

import { convertEnergy, convertUnit, MAX_DECIMAL_PLACES, type CanonicalUnit } from '../units';
import type { NutrientId } from '../nutrients';

/** Mapping version; part of bundle identity and every canonical record. */
export const USDA_NUTRIENT_MAP_VERSION = 'usda_fdc_nutrient_map_v2';

export type UsdaSourceUnit = 'G' | 'MG' | 'UG' | 'KCAL' | 'KJ';

export type UsdaConversion =
  | 'identity'
  | 'mass_metric'
  | 'energy_kj_to_kcal'
  | 'form_rae'
  | 'form_dfe'
  | 'form_ne';

export interface UsdaNutrientMapping {
  readonly usda_nutrient_id: number;
  readonly nutrient_id: NutrientId;
  readonly canonical_unit: CanonicalUnit;
  readonly source_unit: UsdaSourceUnit;
  readonly conversion: UsdaConversion;
  /** True for the kJ energy fallback (used only when no direct kcal exists). */
  readonly energy_fallback?: boolean;
  readonly version: string;
}

const V = USDA_NUTRIENT_MAP_VERSION;

/** The single closed mapping table (verified against the pinned archives). */
const MAPPINGS: ReadonlyArray<UsdaNutrientMapping> = [
  { usda_nutrient_id: 1003, nutrient_id: 'protein', canonical_unit: 'g', source_unit: 'G', conversion: 'identity', version: V },
  { usda_nutrient_id: 1004, nutrient_id: 'fat', canonical_unit: 'g', source_unit: 'G', conversion: 'identity', version: V },
  { usda_nutrient_id: 1005, nutrient_id: 'carbohydrates', canonical_unit: 'g', source_unit: 'G', conversion: 'identity', version: V },
  { usda_nutrient_id: 1008, nutrient_id: 'calories', canonical_unit: 'kcal', source_unit: 'KCAL', conversion: 'identity', version: V },
  { usda_nutrient_id: 1062, nutrient_id: 'calories', canonical_unit: 'kcal', source_unit: 'KJ', conversion: 'energy_kj_to_kcal', energy_fallback: true, version: V },
  { usda_nutrient_id: 1079, nutrient_id: 'fiber', canonical_unit: 'g', source_unit: 'G', conversion: 'identity', version: V },
  { usda_nutrient_id: 1087, nutrient_id: 'calcium', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1089, nutrient_id: 'iron', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1090, nutrient_id: 'magnesium', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1091, nutrient_id: 'phosphorus', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1092, nutrient_id: 'potassium', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1093, nutrient_id: 'sodium', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1095, nutrient_id: 'zinc', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1098, nutrient_id: 'copper', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1101, nutrient_id: 'manganese', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1103, nutrient_id: 'selenium', canonical_unit: 'ug', source_unit: 'UG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1106, nutrient_id: 'vitamin_a', canonical_unit: 'ug_rae', source_unit: 'UG', conversion: 'form_rae', version: V },
  { usda_nutrient_id: 1109, nutrient_id: 'vitamin_e', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1114, nutrient_id: 'vitamin_d', canonical_unit: 'ug', source_unit: 'UG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1162, nutrient_id: 'vitamin_c', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1165, nutrient_id: 'thiamin', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1166, nutrient_id: 'riboflavin', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1170, nutrient_id: 'pantothenic_acid', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1175, nutrient_id: 'vitamin_b6', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1176, nutrient_id: 'biotin', canonical_unit: 'ug', source_unit: 'UG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1178, nutrient_id: 'vitamin_b12', canonical_unit: 'ug', source_unit: 'UG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1180, nutrient_id: 'choline', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1185, nutrient_id: 'vitamin_k', canonical_unit: 'ug', source_unit: 'UG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1190, nutrient_id: 'folate', canonical_unit: 'ug_dfe', source_unit: 'UG', conversion: 'form_dfe', version: V },
  { usda_nutrient_id: 1253, nutrient_id: 'cholesterol', canonical_unit: 'mg', source_unit: 'MG', conversion: 'identity', version: V },
  { usda_nutrient_id: 1257, nutrient_id: 'trans_fat', canonical_unit: 'g', source_unit: 'G', conversion: 'identity', version: V },
  { usda_nutrient_id: 1258, nutrient_id: 'saturated_fat', canonical_unit: 'g', source_unit: 'G', conversion: 'identity', version: V },
  { usda_nutrient_id: 2000, nutrient_id: 'total_sugars', canonical_unit: 'g', source_unit: 'G', conversion: 'identity', version: V },
];

/** Frozen closed mapping table. */
export const USDA_NUTRIENT_MAP: ReadonlyArray<UsdaNutrientMapping> = Object.freeze(
  MAPPINGS.map((entry) => Object.freeze(entry))
);

const BY_ID: Readonly<Record<number, UsdaNutrientMapping>> = Object.freeze(
  MAPPINGS.reduce((acc, entry) => {
    acc[entry.usda_nutrient_id] = entry;
    return acc;
  }, {} as Record<number, UsdaNutrientMapping>)
);

/**
 * Normalizes an official USDA `unitName` label: trims, folds the micro sign
 * (U+00B5) and Greek mu (U+03BC/U+039C) to `u`, and uppercases. This is
 * locale-independent and only affects the unit comparison, never the amount.
 */
export function normalizeUsdaUnitName(unitName: string): string {
  return unitName.trim().replace(/[\u00b5\u03bc\u039c]/g, 'u').toUpperCase();
}

/** Returns the mapping for a stable USDA nutrient id, or undefined if unmapped. */
export function getUsdaNutrientMapping(usdaNutrientId: unknown): UsdaNutrientMapping | undefined {
  if (typeof usdaNutrientId !== 'number' || !Number.isSafeInteger(usdaNutrientId)) return undefined;
  return BY_ID[usdaNutrientId];
}

/** True when the given stable USDA nutrient id is mapped. */
export function isMappedUsdaNutrient(usdaNutrientId: unknown): boolean {
  return getUsdaNutrientMapping(usdaNutrientId) !== undefined;
}

/** The Phase 0 nutrient ids covered by the mapping (calories has two ids). */
export const USDA_MAPPED_NUTRIENT_IDS: ReadonlyArray<NutrientId> = Object.freeze(
  Array.from(new Set(MAPPINGS.map((entry) => entry.nutrient_id)))
);

function roundToPlaces(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Applies the mapping's exact permitted conversion. `identity` and form mappings
 * leave the numeric value untouched. `mass_metric` uses the Phase 0 metric mass
 * helper; `energy_kj_to_kcal` uses the exact 4.184 helper and rounds the result
 * to the canonical 6-decimal precision. Throws only on an unknown conversion.
 */
export function applyUsdaNutrientConversion(mapping: UsdaNutrientMapping, amount: number): number {
  switch (mapping.conversion) {
    case 'identity':
    case 'form_rae':
    case 'form_dfe':
    case 'form_ne':
      return amount;
    case 'mass_metric': {
      const sourceUnit = mapping.source_unit.toLowerCase() as CanonicalUnit;
      return convertUnit(amount, sourceUnit, mapping.canonical_unit);
    }
    case 'energy_kj_to_kcal':
      return roundToPlaces(convertEnergy(amount, 'kj', 'kcal'), MAX_DECIMAL_PLACES);
    default:
      throw new Error('applyUsdaNutrientConversion: unknown conversion.');
  }
}
