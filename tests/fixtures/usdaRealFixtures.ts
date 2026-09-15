/**
 * Complete official USDA FoodData Central records, deterministically extracted
 * and compact-serialized from the pinned source archives (test-only).
 *
 * Each fixture is the complete parsed record for one exact numeric FDC ID,
 * serialized with native compact `JSON.stringify(record)` (no replacer, no
 * indentation) and written as exact UTF-8 bytes with no added whitespace. The
 * fixtures are therefore byte-identical to the documented compact extraction
 * output and semantically equal to the selected archive entry; they are NOT
 * raw archive byte slices and NOT synthetic. See
 * `usdaRealRecords/PROVENANCE.json`. They are never imported by production.
 */

import { readFileSync } from 'node:fs';
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
  type UsdaManifestComponent,
} from '../../src/core/nutritionV2/usda/types';

function load(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./usdaRealRecords/${name}`, import.meta.url), 'utf8'));
}

export const REAL_FOUNDATION_RAW = load('foundation_321358.json');
export const REAL_SR_LEGACY_RAW = load('sr_legacy_167512.json');
export const REAL_FNDDS_RAW = load('fndds_2705384.json');
/** A real SR Legacy record with a present `amount: 0` portion (expected rejected). */
export const REAL_SR_LEGACY_REJECTED_RAW = load('sr_legacy_168789.json');

/** Raw bytes of a checked-in fixture file (for byte-identity/provenance tests). */
export function loadRealFixtureBytes(name: string): Buffer {
  return readFileSync(new URL(`./usdaRealRecords/${name}`, import.meta.url));
}

export interface RealFixtureProvenanceRecord {
  file: string;
  data_type: UsdaDataType;
  transport_label: string;
  upstream_release: string;
  fdc_id: number;
  description: string;
  source_url: string;
  archive_sha256: string;
  fixture_bytes: number;
  fixture_sha256: string;
  expected_outcome: 'accepted' | 'rejected';
  expected_failure?: string;
}

export interface RealFixtureProvenance {
  provenance_schema: number;
  note: string;
  license: string;
  attribution: string;
  extraction_method: { id: string; version: number; description: string; date: string };
  records: RealFixtureProvenanceRecord[];
}

export const REAL_FIXTURE_PROVENANCE = load('PROVENANCE.json') as RealFixtureProvenance;

export const REAL_UPSTREAM_RELEASES: Readonly<Record<UsdaDataType, string>> = Object.freeze({
  foundation: '2026-04',
  sr_legacy: '2018-04',
  fndds: '2021-2023 (2024-10)',
});

export const REAL_SOURCE_URLS: Readonly<Record<UsdaDataType, string>> = Object.freeze({
  foundation:
    'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip',
  sr_legacy:
    'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip',
  fndds: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip',
});

export const REAL_ARCHIVE_SHA256: Readonly<Record<UsdaDataType, string>> = Object.freeze({
  foundation: '186e988ec542e913f51ef62b86a47758e8cdd0d1dc3889e7b055581f3c09c77a',
  sr_legacy: '0fe8ae486a2c8eb42cb96413f058deb51863a46c8fb8eeb4b1fb45006dd338ef',
  fndds: 'dfb06ae7ddc397ccd570b91c14b75438ab2ba39f64f22d321f61d4a52a77f3eb',
});

function realComponents(dataTypes: ReadonlyArray<UsdaDataType>): UsdaManifestComponent[] {
  return dataTypes.map((dataType) => ({
    data_type: dataType,
    upstream_release: REAL_UPSTREAM_RELEASES[dataType],
    source_url: REAL_SOURCE_URLS[dataType],
    source_sha256: REAL_ARCHIVE_SHA256[dataType],
  }));
}

export function realContext(dataType: UsdaDataType, bundleRelease: string) {
  return {
    bundle_release: bundleRelease,
    upstream_release: REAL_UPSTREAM_RELEASES[dataType],
    data_type: dataType,
    nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
  };
}

export interface RealBundleEntry {
  dataType: UsdaDataType;
  raw: unknown;
}

/** Adapts the real fixtures and binds them into a valid manifest + record bundle. */
export function buildRealBundle(entries: ReadonlyArray<RealBundleEntry>): {
  manifest: UsdaBundleManifest;
  records: CanonicalUsdaFoodRecord[];
  bundleRelease: string;
} {
  const dataTypes = Array.from(new Set(entries.map((entry) => entry.dataType)));
  const base: UsdaBundleManifest = {
    manifest_schema: 1,
    bundle_release: 'pending',
    generator: { name: 'kitchen-codex-real-fixture', schema_version: '1' },
    created_at: '2026-09-15T00:00:00.000Z',
    data_types: [...dataTypes],
    components: realComponents(dataTypes),
    canonical_record_count: entries.length,
    rejected_record_count: 0,
    canonical_content_digest: '0'.repeat(64),
    nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
    canonicalization_version: USDA_CANONICALIZATION_VERSION,
    attribution: USDA_ATTRIBUTION,
  };
  const bundleRelease = deriveBundleReleaseId(base);
  const records = entries.map((entry) => {
    const result = adaptUsdaFood(entry.raw, realContext(entry.dataType, bundleRelease));
    if (!result.ok) {
      throw new Error(
        `real fixture adapt failed: ${(result as { ok: false; failure: { code: string } }).failure.code}`
      );
    }
    return result.record;
  });
  const manifest: UsdaBundleManifest = {
    ...base,
    bundle_release: bundleRelease,
    canonical_record_count: records.length,
    canonical_content_digest: computeCanonicalContentDigest(records),
  };
  return { manifest, records, bundleRelease };
}
