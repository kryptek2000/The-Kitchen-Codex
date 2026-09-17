/**
 * SYNTHETIC PHASE 2 MATCHING FIXTURES — NOT REAL NUTRITION DATA.
 *
 * Hand-authored canonical USDA-shaped records used only to exercise the Phase 2
 * review layer. The descriptions deliberately include adversarial qualifier
 * pairs (salted/unsalted, raw/cooked, sweetened/unsweetened, enriched/
 * unenriched, drained/undrained) that must NOT collapse into automatic matches.
 * This file lives under `tests/` and is never imported by production code.
 */

import {
  withCanonicalRecordDigest,
  type CanonicalUsdaFoodRecordContent,
} from '../../src/core/nutritionV2/usda/record';
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
import {
  TEST_SOURCE_SHA,
  TEST_SOURCE_URLS,
  TEST_UPSTREAM_RELEASES,
  makeManifestBase,
} from './usdaFixtures';

export interface MatchingRecordSpec {
  fdcId: number;
  dataType: UsdaDataType;
  description: string;
  /** Optional canonical food category (Phase 4.5D eligibility). */
  foodCategory?: string;
  upstreamRelease?: string;
  nutrientMapVersion?: string;
  /** Varies the canonical record digest without changing identity/description. */
  proteinAmount?: number;
}

/** Adversarial qualifier pairs that must stay distinct through normalization. */
export const MATCHING_QUALIFIER_PAIRS: ReadonlyArray<[string, string]> = [
  ['Butter, salted', 'Butter, unsalted'],
  ['Beef, ground, raw', 'Beef, ground, cooked'],
  ['Milk, whole', 'Milk, skim'],
  ['Milk, sweetened', 'Milk, unsweetened'],
  ['Flour, enriched', 'Flour, unenriched'],
  ['Tomatoes, canned, drained', 'Tomatoes, canned, undrained'],
];

export const DEFAULT_MATCHING_SPECS: ReadonlyArray<MatchingRecordSpec> = [
  { fdcId: 1001, dataType: 'foundation', description: 'Butter, salted' },
  { fdcId: 1002, dataType: 'foundation', description: 'Butter, unsalted' },
  { fdcId: 1003, dataType: 'foundation', description: 'Milk, whole' },
  { fdcId: 1004, dataType: 'foundation', description: 'Milk, skim' },
  { fdcId: 1005, dataType: 'foundation', description: 'Milk, sweetened' },
  { fdcId: 1006, dataType: 'foundation', description: 'Milk, unsweetened' },
  { fdcId: 1007, dataType: 'sr_legacy', description: 'Flour, enriched' },
  { fdcId: 1008, dataType: 'sr_legacy', description: 'Flour, unenriched' },
  { fdcId: 1009, dataType: 'sr_legacy', description: 'Beef, ground, raw' },
  { fdcId: 1010, dataType: 'sr_legacy', description: 'Beef, ground, cooked' },
  { fdcId: 1011, dataType: 'fndds', description: 'Tomatoes, canned, drained' },
  { fdcId: 1012, dataType: 'fndds', description: 'Tomatoes, canned, undrained' },
  // Duplicate exact description (different FDC ids) -> must never auto-select.
  { fdcId: 2001, dataType: 'fndds', description: 'Sugar, granulated' },
  { fdcId: 2002, dataType: 'fndds', description: 'Sugar, granulated' },
];

/** Builds one canonical record for the given release context. */
export function makeCanonicalRecord(
  spec: MatchingRecordSpec,
  bundleRelease: string
): CanonicalUsdaFoodRecord {
  const content: CanonicalUsdaFoodRecordContent = {
    source: 'usda_fdc',
    bundle_release: bundleRelease,
    upstream_release: spec.upstreamRelease ?? TEST_UPSTREAM_RELEASES[spec.dataType],
    fdc_id: spec.fdcId,
    data_type: spec.dataType,
    description: spec.description,
    ...(spec.foodCategory !== undefined ? { food_category: spec.foodCategory } : {}),
    nutrient_map_version: spec.nutrientMapVersion ?? USDA_NUTRIENT_MAP_VERSION,
    basis: 'per_100_g',
    nutrients: {
      protein: {
        nutrient_id: 'protein',
        unit: 'g',
        amount_per_100g: spec.proteinAmount ?? 1,
        usda_nutrient_id: 1003,
        source_unit: 'G',
        converted: false,
      },
    },
    portions: [],
  };
  return withCanonicalRecordDigest(content);
}

/** Builds a valid manifest + canonical records for the given specs. */
export function buildMatchingBundle(specs: ReadonlyArray<MatchingRecordSpec>): {
  manifest: UsdaBundleManifest;
  records: CanonicalUsdaFoodRecord[];
  bundleRelease: string;
} {
  const dataTypes = Array.from(new Set(specs.map((spec) => spec.dataType)));
  const bundleRelease = makeManifestBase(dataTypes, 1, '0'.repeat(64)).bundle_release;
  const records = specs.map((spec) => makeCanonicalRecord(spec, bundleRelease));
  const manifest = makeManifestBase(
    dataTypes,
    records.length,
    computeCanonicalContentDigest(records)
  );
  return { manifest, records, bundleRelease };
}

/**
 * Builds a genuine bundle with a DIFFERENT bundle identity (custom generator
 * name) while keeping the same records. Used to prove stale-catalog detection.
 */
export function buildMatchingBundleWithGenerator(
  specs: ReadonlyArray<MatchingRecordSpec>,
  generatorName: string
): { manifest: UsdaBundleManifest; records: CanonicalUsdaFoodRecord[]; bundleRelease: string } {
  const dataTypes = Array.from(new Set(specs.map((spec) => spec.dataType)));
  const components = dataTypes.map((dataType) => ({
    data_type: dataType,
    upstream_release: TEST_UPSTREAM_RELEASES[dataType],
    source_url: TEST_SOURCE_URLS[dataType],
    source_sha256: TEST_SOURCE_SHA,
  }));
  const base: UsdaBundleManifest = {
    manifest_schema: 1,
    bundle_release: 'pending',
    generator: { name: generatorName, schema_version: '1' },
    created_at: '2026-09-15T00:00:00.000Z',
    data_types: [...dataTypes],
    components,
    canonical_record_count: specs.length,
    rejected_record_count: 0,
    canonical_content_digest: '0'.repeat(64),
    nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
    canonicalization_version: USDA_CANONICALIZATION_VERSION,
    attribution: USDA_ATTRIBUTION,
  };
  const bundleRelease = deriveBundleReleaseId(base);
  const records = specs.map((spec) => makeCanonicalRecord(spec, bundleRelease));
  const manifest: UsdaBundleManifest = {
    ...base,
    bundle_release: bundleRelease,
    canonical_content_digest: computeCanonicalContentDigest(records),
  };
  return { manifest, records, bundleRelease };
}

/** A manifest template with explicit count/digest (for mismatch tests). */
export function makeMatchingManifest(
  dataTypes: ReadonlyArray<UsdaDataType>,
  canonicalRecordCount: number,
  canonicalContentDigest: string
): UsdaBundleManifest {
  return makeManifestBase(dataTypes, canonicalRecordCount, canonicalContentDigest);
}
