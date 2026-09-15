/**
 * SYNTHETIC USDA-SHAPED TEST FIXTURES — NOT REAL NUTRITION DATA.
 *
 * These records are hand-authored to exercise the Phase 1 trust boundary. They
 * follow the SHAPE of official USDA FoodData Central structured records but the
 * ids/amounts are illustrative and must NEVER be presented as real nutrition.
 * This file lives under `tests/` and is never imported by production code.
 */

import { adaptUsdaFood } from '../../src/core/nutritionV2/usda/adapter';
import {
  computeCanonicalContentDigest,
  deriveBundleReleaseId,
} from '../../src/core/nutritionV2/usda/manifest';
import { USDA_NUTRIENT_MAP_VERSION } from '../../src/core/nutritionV2/usda/nutrientMap';
import {
  USDA_ATTRIBUTION,
  USDA_CANONICALIZATION_VERSION,
  type CanonicalUsdaFoodRecord,
  type UsdaBundleManifest,
  type UsdaDataType,
} from '../../src/core/nutritionV2/usda/types';

export const TEST_SOURCE_SHA = 'a'.repeat(64);

export const TEST_UPSTREAM_RELEASES: Readonly<Record<UsdaDataType, string>> = Object.freeze({
  foundation: '2026-04',
  sr_legacy: '2018-04',
  fndds: '2021-2023 (2024-10)',
});

export const TEST_SOURCE_URLS: Readonly<Record<UsdaDataType, string>> = Object.freeze({
  foundation: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04.zip',
  sr_legacy: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip',
  fndds: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10.zip',
});

/** Loose USDA-shaped record type for synthetic, test-only fixtures. */
export type RawUsdaRecord = Record<string, any>;

/** Deep clone via JSON so each test gets an independent mutable fixture. */
export function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Valid shaped records
// ---------------------------------------------------------------------------

export const FOUNDATION_RAW: RawUsdaRecord = {
  fdcId: 746782,
  dataType: 'Foundation',
  description: 'Milk, whole, 3.25% milkfat, with added vitamin D',
  foodCategory: { description: 'Dairy and Egg Products' },
  foodNutrients: [
    { nutrient: { id: 1003, number: '203', name: 'Protein', unitName: 'G' }, amount: 3.15 },
    { nutrient: { id: 1004, number: '204', name: 'Total lipid (fat)', unitName: 'G' }, amount: 3.25 },
    { nutrient: { id: 1005, number: '205', name: 'Carbohydrate, by difference', unitName: 'G' }, amount: 4.8 },
    { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'KCAL' }, amount: 61 },
    { nutrient: { id: 1087, number: '301', name: 'Calcium, Ca', unitName: 'MG' }, amount: 113 },
    { nutrient: { id: 1106, number: '320', name: 'Vitamin A, RAE', unitName: 'UG' }, amount: 46 },
    { nutrient: { id: 2000, number: '269', name: 'Sugars, Total', unitName: 'G' }, amount: 5.05 },
    { nutrient: { id: 1009, number: '209', name: 'Starch', unitName: 'G' }, amount: 0 },
    { nutrient: { id: 1235, number: '539', name: 'Sugars, added', unitName: 'G' }, amount: 0 },
  ],
  foodPortions: [
    {
      id: 1234,
      measureUnit: { id: 1000, name: 'cup' },
      amount: 1,
      gramWeight: 244,
      sequenceNumber: 1,
      modifier: 'whole',
    },
  ],
};

export const SR_LEGACY_RAW: RawUsdaRecord = {
  fdcId: 171077,
  dataType: 'SR Legacy',
  description: 'Beef, ground, 85% lean meat / 15% fat, raw',
  foodCategory: 'Beef Products',
  foodNutrients: [
    { nutrient: { id: 1003, number: '203', name: 'Protein', unitName: 'G' }, amount: 18.59 },
    { nutrient: { id: 1004, number: '204', name: 'Total lipid (fat)', unitName: 'G' }, amount: 15 },
    { nutrient: { id: 1005, number: '205', name: 'Carbohydrate, by difference', unitName: 'G' }, amount: 0 },
    { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'KCAL' }, amount: 215 },
    { nutrient: { id: 1258, number: '606', name: 'Fatty acids, total saturated', unitName: 'G' }, amount: 5.686 },
    { nutrient: { id: 1253, number: '601', name: 'Cholesterol', unitName: 'MG' }, amount: 71 },
    { nutrient: { id: 1093, number: '307', name: 'Sodium, Na', unitName: 'MG' }, amount: 66 },
    { nutrient: { id: 1089, number: '303', name: 'Iron, Fe', unitName: 'MG' }, amount: 1.94 },
  ],
};

export const FNDDS_RAW: RawUsdaRecord = {
  fdcId: 2710777,
  dataType: 'Survey (FNDDS)',
  description: 'Rice, white, cooked, fat added',
  foodNutrients: [
    { nutrient: { id: 1003, number: '203', name: 'Protein', unitName: 'G' }, amount: 2.7 },
    { nutrient: { id: 1005, number: '205', name: 'Carbohydrate, by difference', unitName: 'G' }, amount: 28.1 },
    { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'KCAL' }, amount: 166 },
    { nutrient: { id: 1079, number: '291', name: 'Fiber, total dietary', unitName: 'G' }, amount: 0.9 },
    { nutrient: { id: 1093, number: '307', name: 'Sodium, Na', unitName: 'MG' }, amount: 300 },
    { nutrient: { id: 1190, number: '435', name: 'Folate, DFE', unitName: 'UG' }, amount: 3 },
    { nutrient: { id: 1169, number: '409', name: 'Niacin equivalent N406 +N407', unitName: 'MG' }, amount: 1.5 },
  ],
  // FNDDS portions legitimately omit `amount`; the synthetic fixture mirrors that.
  foodPortions: [{ id: 999, measureUnit: { id: 1000, name: 'cup' }, gramWeight: 158 }],
};

// ---------------------------------------------------------------------------
// Adversarial / edge-case shaped records
// ---------------------------------------------------------------------------

export function explicitZeroRaw() {
  return {
    fdcId: 900001,
    dataType: 'Foundation',
    description: 'Synthetic zero-sugar food',
    foodNutrients: [
      { nutrient: { id: 1003, unitName: 'G' }, amount: 0 },
      { nutrient: { id: 1008, unitName: 'KCAL' }, amount: 0 },
    ],
  };
}

export function missingNutrientRaw() {
  return {
    fdcId: 900002,
    dataType: 'Foundation',
    description: 'Synthetic food with a missing nutrient',
    foodNutrients: [{ nutrient: { id: 1008, unitName: 'KCAL' }, amount: 100 }],
  };
}

export function duplicateMappedRaw() {
  return {
    fdcId: 900003,
    dataType: 'Foundation',
    description: 'Synthetic duplicate protein component',
    foodNutrients: [
      { nutrient: { id: 1003, unitName: 'G' }, amount: 1 },
      { nutrient: { id: 1003, unitName: 'G' }, amount: 2 },
    ],
  };
}

export function conflictingEnergyRaw() {
  return {
    fdcId: 900004,
    dataType: 'Foundation',
    description: 'Synthetic conflicting energy components',
    foodNutrients: [
      { nutrient: { id: 1008, unitName: 'KCAL' }, amount: 100 },
      { nutrient: { id: 1008, unitName: 'KCAL' }, amount: 250 },
    ],
  };
}

export function kjOnlyEnergyRaw() {
  return {
    fdcId: 900005,
    dataType: 'Foundation',
    description: 'Synthetic kJ-only energy',
    foodNutrients: [
      { nutrient: { id: 1003, unitName: 'G' }, amount: 1 },
      { nutrient: { id: 1062, unitName: 'KJ' }, amount: 418.4 },
    ],
  };
}

export function wrongUnitRaw() {
  return {
    fdcId: 900006,
    dataType: 'Foundation',
    description: 'Synthetic wrong-unit protein',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'MG' }, amount: 5 }],
  };
}

export function iuVitaminDRaw() {
  return {
    fdcId: 900007,
    dataType: 'Foundation',
    description: 'Synthetic IU vitamin D',
    foodNutrients: [
      { nutrient: { id: 1110, unitName: 'IU' }, amount: 100 },
      { nutrient: { id: 1008, unitName: 'KCAL' }, amount: 50 },
    ],
  };
}

export function folateTotalRaw() {
  return {
    fdcId: 900008,
    dataType: 'Foundation',
    description: 'Synthetic total folate (must not map to DFE)',
    foodNutrients: [
      { nutrient: { id: 1177, unitName: 'UG' }, amount: 20 },
      { nutrient: { id: 1008, unitName: 'KCAL' }, amount: 50 },
    ],
  };
}

export function invalidFdcIdRaw() {
  return {
    fdcId: 0,
    dataType: 'Foundation',
    description: 'Synthetic invalid fdc id',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: 1 }],
  };
}

export function invalidDataTypeRaw() {
  return {
    fdcId: 900009,
    dataType: 'Branded',
    description: 'Synthetic unsupported data type',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: 1 }],
  };
}

export function unsafeDescriptionRaw() {
  return {
    fdcId: 900010,
    dataType: 'Foundation',
    description: '<script>alert(1)</script>',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: 1 }],
  };
}

export function oversizedRaw() {
  return {
    fdcId: 900011,
    dataType: 'Foundation',
    description: 'x'.repeat(70 * 1024),
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: 1 }],
  };
}

/** A record whose total raw serialized size exceeds the raw transport bound. */
export function rawOversizedRaw() {
  return {
    fdcId: 900022,
    dataType: 'Foundation',
    description: 'Synthetic raw-oversized record',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: 1 }],
    inputFoods: Array.from({ length: 512 }, (_, index) => ({
      id: index + 1,
      foodDescription: 'x'.repeat(1000),
    })),
  };
}

/** A record nested deeper than the raw depth bound. */
export function deepRaw() {
  let nested: unknown = { value: 1 };
  for (let i = 0; i < 20; i += 1) nested = { nested };
  return {
    fdcId: 900023,
    dataType: 'Foundation',
    description: 'Synthetic deep record',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: 1 }],
    foodAttributes: [nested],
  };
}

export function negativeAmountRaw() {
  return {
    fdcId: 900012,
    dataType: 'Foundation',
    description: 'Synthetic negative amount',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: -1 }],
  };
}

export function negativeZeroAmountRaw() {
  return {
    fdcId: 900013,
    dataType: 'Foundation',
    description: 'Synthetic negative zero amount',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: -0 }],
  };
}

export function nonFiniteAmountRaw() {
  return {
    fdcId: 900014,
    dataType: 'Foundation',
    description: 'Synthetic non-finite amount',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: Number.POSITIVE_INFINITY }],
  };
}

export function overPreciseAmountRaw() {
  return {
    fdcId: 900015,
    dataType: 'Foundation',
    description: 'Synthetic over-precise amount',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: 1.1234567 }],
  };
}

export function excessiveAmountRaw() {
  return {
    fdcId: 900016,
    dataType: 'Foundation',
    description: 'Synthetic excessive amount',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: 2_000_000_000 }],
  };
}

export function validPortionRaw() {
  return {
    fdcId: 900017,
    dataType: 'Foundation',
    description: 'Synthetic food with a valid portion',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: 10 }],
    foodPortions: [
      {
        id: 42,
        measureUnit: { id: 1000, name: 'cup' },
        amount: 1,
        gramWeight: 240,
        sequenceNumber: 1,
        modifier: 'sliced',
      },
    ],
  };
}

export function absentPortionRaw() {
  return {
    fdcId: 900018,
    dataType: 'Foundation',
    description: 'Synthetic food with no portion',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: 10 }],
  };
}

export function malformedPortionRaw() {
  return {
    fdcId: 900019,
    dataType: 'Foundation',
    description: 'Synthetic malformed portion',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: 10 }],
    foodPortions: [{ id: 1, measureUnit: { id: 1000, name: 'cup' }, amount: 1, gramWeight: -5 }],
  };
}

export function zeroGramPortionRaw() {
  return {
    fdcId: 900020,
    dataType: 'Foundation',
    description: 'Synthetic zero gram portion',
    foodNutrients: [{ nutrient: { id: 1003, unitName: 'G' }, amount: 10 }],
    foodPortions: [{ id: 1, measureUnit: { id: 1000, name: 'cup' }, amount: 1, gramWeight: 0 }],
  };
}

/** Own `__proto__` key (via JSON.parse) to exercise dangerous-key rejection. */
export function dangerousKeyRaw() {
  return JSON.parse(
    '{"fdcId":900021,"dataType":"Foundation","description":"Synthetic dangerous key","foodNutrients":[{"nutrient":{"id":1003,"unitName":"G"},"amount":1}],"__proto__":{"polluted":true}}'
  ) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Manifest + bundle helpers
// ---------------------------------------------------------------------------

export function makeManifestBase(
  dataTypes: ReadonlyArray<UsdaDataType>,
  canonicalRecordCount: number,
  canonicalContentDigest: string
): UsdaBundleManifest {
  const components = dataTypes.map((dataType) => ({
    data_type: dataType,
    upstream_release: TEST_UPSTREAM_RELEASES[dataType],
    source_url: TEST_SOURCE_URLS[dataType],
    source_sha256: TEST_SOURCE_SHA,
  }));
  const base = {
    manifest_schema: 1 as const,
    bundle_release: 'pending',
    generator: { name: 'kitchen-codex-test', schema_version: '1' },
    created_at: '2026-09-15T00:00:00.000Z',
    data_types: [...dataTypes],
    components,
    canonical_record_count: canonicalRecordCount,
    rejected_record_count: 0,
    canonical_content_digest: canonicalContentDigest,
    nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
    canonicalization_version: USDA_CANONICALIZATION_VERSION,
    attribution: USDA_ATTRIBUTION,
  };
  return { ...base, bundle_release: deriveBundleReleaseId(base as unknown as UsdaBundleManifest) };
}

export interface BundleEntry {
  dataType: UsdaDataType;
  raw: unknown;
}

/** Adapts raw fixtures and binds them into a valid manifest + record bundle. */
export function buildBundle(entries: ReadonlyArray<BundleEntry>): {
  manifest: UsdaBundleManifest;
  records: CanonicalUsdaFoodRecord[];
  bundleRelease: string;
} {
  const dataTypes = Array.from(new Set(entries.map((entry) => entry.dataType)));
  const bundleRelease = makeManifestBase(dataTypes, 1, '0'.repeat(64)).bundle_release;
  const records = entries.map((entry) => {
    const result = adaptUsdaFood(entry.raw, {
      bundle_release: bundleRelease,
      upstream_release: TEST_UPSTREAM_RELEASES[entry.dataType],
      data_type: entry.dataType,
      nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
    });
    if (!result.ok) {
      throw new Error(`fixture adapt failed: ${(result as { ok: false; failure: { code: string } }).failure.code}`);
    }
    return result.record;
  });
  const manifest = makeManifestBase(dataTypes, records.length, computeCanonicalContentDigest(records));
  return { manifest, records, bundleRelease };
}

/** A context bound to the derived release for one data type. */
export function contextFor(dataType: UsdaDataType, bundleRelease: string) {
  return {
    bundle_release: bundleRelease,
    upstream_release: TEST_UPSTREAM_RELEASES[dataType],
    data_type: dataType,
    nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
  };
}
