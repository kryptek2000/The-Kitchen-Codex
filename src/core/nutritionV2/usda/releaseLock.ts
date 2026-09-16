/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: source-controlled release trust lock.
 *
 * PURPOSE
 * -------
 * The generated USDA bundle is internally self-consistent but self-describing: its
 * own digests prove accidental-corruption integrity, not authenticity. This module
 * is an immutable, source-controlled, externally audited trust anchor that lives
 * OUTSIDE the generated artifact directory. The verifier compares every
 * authoritative identity against this lock, so a fully recomputed/self-consistent
 * forgery still fails.
 *
 * CONSTRAINTS (audited)
 * ---------------------
 * - Data only: no functions, no behavior, no getters.
 * - Imports NOTHING: no Node, filesystem, child-process, ZIP, Python, React,
 *   application, or platform module.
 * - Never generated into or read from the artifact directory.
 * - Never supplied by a caller, environment variable, query, or CLI flag.
 * - Not updated automatically by the generator. A future USDA release or
 *   generator-version change REQUIRES a deliberate manual edit of this file,
 *   followed by a full re-audit and test run.
 *
 * SHA-256 CAVEAT
 * --------------
 * A digest proves identity/integrity against a pinned expected value. Authenticity
 * here comes from the separately verified official acquisition process (pinned
 * source archive filenames, official HTTPS URLs, releases, and SHA-256 values)
 * combined with this manually reviewed lock.
 */

export const USDA_BUNDLE_RELEASE_LOCK_SCHEMA = 1 as const;

export interface UsdaBundleReleaseLockSource {
  readonly data_type: string;
  readonly upstream_release: string;
  readonly archive_filename: string;
  readonly source_url: string;
  readonly sha256: string;
}

export interface UsdaBundleReleaseLockShard {
  readonly data_type: string;
  readonly filename: string;
  readonly record_count: number;
  readonly compressed_bytes: number;
  readonly compressed_sha256: string;
  readonly uncompressed_bytes: number;
  readonly uncompressed_sha256: string;
}

export interface UsdaBundleReleaseLockWarning {
  readonly code: string;
  readonly count: number;
}

export interface UsdaBundleReleaseLockFileRef {
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface UsdaBundleReleaseLock {
  readonly lock_schema: typeof USDA_BUNDLE_RELEASE_LOCK_SCHEMA;
  readonly bundle_release: string;
  readonly generator: { readonly name: string; readonly schema_version: string };
  readonly created_at: string;
  readonly nutrient_map_version: string;
  readonly canonicalization_version: string;
  readonly sources: ReadonlyArray<UsdaBundleReleaseLockSource>;
  readonly artifact_filenames: ReadonlyArray<string>;
  readonly canonical_record_count: number;
  readonly rejected_record_count: number;
  readonly null_placeholder_count: number;
  readonly canonical_content_digest: string;
  readonly manifest: UsdaBundleReleaseLockFileRef;
  readonly artifact: UsdaBundleReleaseLockFileRef;
  readonly shards: ReadonlyArray<UsdaBundleReleaseLockShard>;
  readonly total_compressed_bytes: number;
  readonly total_uncompressed_bytes: number;
  readonly warnings: ReadonlyArray<UsdaBundleReleaseLockWarning>;
  readonly attribution: string;
}

export const USDA_BUNDLE_RELEASE_LOCK: UsdaBundleReleaseLock = Object.freeze({
  lock_schema: USDA_BUNDLE_RELEASE_LOCK_SCHEMA,
  bundle_release: 'usda_fdc_87c5408a3e98838944a87be74824761e',
  generator: Object.freeze({ name: 'the-kitchen-codex-usda-bundle', schema_version: '1' }),
  created_at: '2026-09-15T00:00:00.000Z',
  nutrient_map_version: 'usda_fdc_nutrient_map_v2',
  canonicalization_version: 'usda_canonical_v1',
  sources: Object.freeze([
    Object.freeze({
      data_type: 'foundation',
      upstream_release: '2026-04',
      archive_filename: 'FoodData_Central_foundation_food_json_2026-04-30.zip',
      source_url:
        'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip',
      sha256: '186e988ec542e913f51ef62b86a47758e8cdd0d1dc3889e7b055581f3c09c77a',
    }),
    Object.freeze({
      data_type: 'sr_legacy',
      upstream_release: '2018-04',
      archive_filename: 'FoodData_Central_sr_legacy_food_json_2018-04.zip',
      source_url:
        'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip',
      sha256: '0fe8ae486a2c8eb42cb96413f058deb51863a46c8fb8eeb4b1fb45006dd338ef',
    }),
    Object.freeze({
      data_type: 'fndds',
      upstream_release: '2021-2023 (2024-10)',
      archive_filename: 'FoodData_Central_survey_food_json_2024-10-31.zip',
      source_url:
        'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip',
      sha256: 'dfb06ae7ddc397ccd570b91c14b75438ab2ba39f64f22d321f61d4a52a77f3eb',
    }),
  ]),
  artifact_filenames: Object.freeze([
    'artifact.json',
    'manifest.json',
    'records.foundation.json.gz',
    'records.sr_legacy.json.gz',
    'records.fndds.json.gz',
  ]),
  canonical_record_count: 13559,
  rejected_record_count: 29,
  null_placeholder_count: 32,
  canonical_content_digest: 'dd9740bcf0efb577f0afd5b87ddb70a652384e4d7833947e83b30da8b39f67e4',
  manifest: Object.freeze({
    filename: 'manifest.json',
    bytes: 1573,
    sha256: '3b4ee9888bda49ff705e9e38971621beac7a091fe0b53e1187e68d050e70e2ba',
  }),
  artifact: Object.freeze({
    filename: 'artifact.json',
    bytes: 1604,
    sha256: '1e525d9423572ab202d80ed78ff05b7ec34899744f62b24664f8d32c4d0efd3b',
  }),
  shards: Object.freeze([
    Object.freeze({
      data_type: 'foundation',
      filename: 'records.foundation.json.gz',
      record_count: 353,
      compressed_bytes: 53877,
      compressed_sha256: '50bb6999d12b7c68f167509bc2d88d35ad9c2df9d6a03a9a7f89379323399709',
      uncompressed_bytes: 958025,
      uncompressed_sha256: '5082031987b75d388880b8d416b4c3cacd3ee4f7c227a2717d1cedfdc6b043e6',
    }),
    Object.freeze({
      data_type: 'sr_legacy',
      filename: 'records.sr_legacy.json.gz',
      record_count: 7775,
      compressed_bytes: 1456503,
      compressed_sha256: '2fa6be1ebefa1ffd2b70554e082237f15e14ce2c51302fdf00cde97ae6e3a876',
      uncompressed_bytes: 33695908,
      uncompressed_sha256: 'e916f71396f4f55db04365e4b622fdfa3ec8006d499ed67789434e4e5d213f35',
    }),
    Object.freeze({
      data_type: 'fndds',
      filename: 'records.fndds.json.gz',
      record_count: 5431,
      compressed_bytes: 981412,
      compressed_sha256: '1a25a5d8c4e18fbca8e91d80a0b051860bad72aedb27486e8940699ad8158b2b',
      uncompressed_bytes: 25024331,
      uncompressed_sha256: '426e6e2642bcccfe64c2f86e831ef9c272b3def9829e25a17f179b283a055fc7',
    }),
  ]),
  total_compressed_bytes: 2491792,
  total_uncompressed_bytes: 59678264,
  warnings: Object.freeze([
    Object.freeze({ code: 'foundation_null_placeholder', count: 32 }),
    Object.freeze({ code: 'rejected_invalid_nutrient', count: 10 }),
    Object.freeze({ code: 'rejected_invalid_portion', count: 18 }),
    Object.freeze({ code: 'rejected_no_supported_nutrients', count: 1 }),
  ]),
  attribution:
    'U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, 2019. fdc.nal.usda.gov.',
});
