/**
 * SYNTHETIC PHASE 3 CALCULATION FIXTURES — NOT REAL NUTRITION DATA.
 *
 * Hand-authored canonical USDA-shaped records used only to exercise the Phase 3
 * advisory calculation layer. This file lives under `tests/` and is never
 * imported by production code.
 */

import {
  withCanonicalRecordDigest,
  type CanonicalUsdaFoodRecordContent,
} from '../../src/core/nutritionV2/usda/record';
import { computeCanonicalContentDigest } from '../../src/core/nutritionV2/usda/manifest';
import { USDA_NUTRIENT_MAP } from '../../src/core/nutritionV2/usda/nutrientMap';
import { USDA_NUTRIENT_MAP_VERSION } from '../../src/core/nutritionV2/usda/nutrientMap';
import type { NutrientId } from '../../src/core/nutritionV2/nutrients';
import type {
  CanonicalNutrientRecord,
  CanonicalPortionRecord,
  CanonicalUsdaFoodRecord,
  UsdaBundleManifest,
  UsdaDataType,
} from '../../src/core/nutritionV2/usda/types';
import { makeManifestBase, TEST_UPSTREAM_RELEASES } from './usdaFixtures';

const MAPPING_BY_NUTRIENT = new Map<NutrientId, (typeof USDA_NUTRIENT_MAP)[number]>();
for (const mapping of USDA_NUTRIENT_MAP) {
  if (!MAPPING_BY_NUTRIENT.has(mapping.nutrient_id)) MAPPING_BY_NUTRIENT.set(mapping.nutrient_id, mapping);
}

export interface CalcRecordSpec {
  fdcId: number;
  dataType: UsdaDataType;
  description: string;
  /** Per-100-g amounts keyed by Phase 0 nutrient id. */
  nutrients: Partial<Record<NutrientId, number>>;
  portions?: ReadonlyArray<CanonicalPortionRecord>;
}

function nutrientRecords(
  nutrients: Partial<Record<NutrientId, number>>
): Partial<Record<NutrientId, CanonicalNutrientRecord>> {
  const out: Partial<Record<NutrientId, CanonicalNutrientRecord>> = {};
  for (const [id, amount] of Object.entries(nutrients) as [NutrientId, number][]) {
    const mapping = MAPPING_BY_NUTRIENT.get(id);
    if (!mapping) throw new Error(`no mapping for ${id}`);
    out[id] = {
      nutrient_id: id,
      unit: mapping.canonical_unit,
      amount_per_100g: amount,
      usda_nutrient_id: mapping.usda_nutrient_id,
      source_unit: mapping.source_unit,
      converted: false,
    };
  }
  return out;
}

export function makeCalcRecord(spec: CalcRecordSpec, bundleRelease: string): CanonicalUsdaFoodRecord {
  const content: CanonicalUsdaFoodRecordContent = {
    source: 'usda_fdc',
    bundle_release: bundleRelease,
    upstream_release: TEST_UPSTREAM_RELEASES[spec.dataType],
    fdc_id: spec.fdcId,
    data_type: spec.dataType,
    description: spec.description,
    nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
    basis: 'per_100_g',
    nutrients: nutrientRecords(spec.nutrients),
    portions: spec.portions ? [...spec.portions] : [],
  };
  return withCanonicalRecordDigest(content);
}

export function buildCalculationBundle(specs: ReadonlyArray<CalcRecordSpec>): {
  manifest: UsdaBundleManifest;
  records: CanonicalUsdaFoodRecord[];
  bundleRelease: string;
} {
  const dataTypes = Array.from(new Set(specs.map((spec) => spec.dataType)));
  const bundleRelease = makeManifestBase(dataTypes, 1, '0'.repeat(64)).bundle_release;
  const records = specs.map((spec) => makeCalcRecord(spec, bundleRelease));
  const manifest = makeManifestBase(dataTypes, records.length, computeCanonicalContentDigest(records));
  return { manifest, records, bundleRelease };
}

/** Two foods with a portion, for mass/portion tests. */
export const CALC_FOODS: ReadonlyArray<CalcRecordSpec> = [
  {
    fdcId: 3001,
    dataType: 'foundation',
    description: 'Flour, wheat, white',
    nutrients: { calories: 364, protein: 10.3, carbohydrates: 76.3, fat: 1, fiber: 2.7 },
    portions: [
      { usda_portion_id: 1, amount: 1, measure: 'cup', gram_weight: 125, sequence: 1 },
      { usda_portion_id: 2, amount: 1, measure: 'tablespoon', gram_weight: 7.8, sequence: 2 },
    ],
  },
  {
    fdcId: 3002,
    dataType: 'sr_legacy',
    description: 'Butter, salted',
    nutrients: { calories: 717, protein: 0.85, carbohydrates: 0.06, fat: 81.1, sodium: 643 },
    portions: [{ usda_portion_id: 3, amount: 1, measure: 'tablespoon', gram_weight: 14.2, sequence: 1 }],
  },
  {
    fdcId: 3003,
    dataType: 'fndds',
    description: 'Salt, table',
    nutrients: { sodium: 38758, calcium: 24 },
    // FNDDS-style portion with a legitimately absent `amount`.
    portions: [{ usda_portion_id: 4, measure: 'teaspoon', gram_weight: 6, sequence: 1 }],
  },
];

/**
 * SYNTHETIC Phase 4.5C fixtures exercising the three canonical portion shapes
 * (Foundation numeric amount, SR Legacy `undetermined` + modifier, FNDDS
 * embedded measure), plus count and unusable shapes. NOT real nutrition data.
 */
export const CUSTOMARY_FOODS: ReadonlyArray<CalcRecordSpec> = [
  {
    fdcId: 169697,
    dataType: 'sr_legacy',
    description: 'Cornmeal, whole-grain, yellow',
    nutrients: { calories: 362, protein: 8.12, carbohydrates: 76.89, fat: 3.59 },
    portions: [
      { usda_portion_id: 85369, amount: 1, measure: 'undetermined', modifier: 'cup', gram_weight: 122, sequence: 1 },
    ],
  },
  {
    fdcId: 168867,
    dataType: 'sr_legacy',
    description: 'Cornmeal, degermed, enriched, yellow',
    nutrients: { calories: 370, protein: 7.11, carbohydrates: 79.45, fat: 1.75 },
    portions: [
      { usda_portion_id: 83917, amount: 1, measure: 'undetermined', modifier: 'cup', gram_weight: 157, sequence: 1 },
    ],
  },
  {
    fdcId: 4001,
    dataType: 'fndds',
    description: 'Cornmeal, cooked, FNDDS',
    nutrients: { calories: 100 },
    // FNDDS embeds the explicit amount in `measure`; `modifier` is a numeric code.
    portions: [{ usda_portion_id: 5, measure: '1 cup', modifier: '10205', gram_weight: 240, sequence: 1 }],
  },
  {
    fdcId: 4002,
    dataType: 'foundation',
    description: 'Egg, whole, raw, fresh',
    nutrients: { calories: 143, protein: 12.6, fat: 9.5 },
    portions: [{ usda_portion_id: 6, amount: 1, measure: 'piece', gram_weight: 50, sequence: 1 }],
  },
  {
    fdcId: 4003,
    dataType: 'fndds',
    description: 'Mystery, quantity not specified',
    nutrients: { calories: 50 },
    portions: [
      { usda_portion_id: 7, measure: 'Quantity not specified', modifier: '90000', gram_weight: 100, sequence: 1 },
    ],
  },
];
