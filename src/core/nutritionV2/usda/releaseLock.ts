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
  bundle_release: 'usda_fdc_1f3e3068a7ae0702f360d1caae40a628',
  generator: Object.freeze({ name: 'the-kitchen-codex-usda-bundle', schema_version: '1' }),
  created_at: '2026-09-15T00:00:00.000Z',
  nutrient_map_version: 'usda_fdc_nutrient_map_v3',
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
  canonical_content_digest: 'de639e0cc2a2b0455577e0ad055e8691c73ef7dc395bfb57e76a224e050fa739',
  manifest: Object.freeze({
    filename: 'manifest.json',
    bytes: 1573,
    sha256: '5a8596432d5f050ce5a3482ef06340d876a9ff7244c88fd64b4cdb2802e2fd8f',
  }),
  artifact: Object.freeze({
    filename: 'artifact.json',
    bytes: 1604,
    sha256: '0049be77aeed9328772a9b3561df054a80f10002a4c2b6153f2b0f1a6b6116f4',
  }),
  shards: Object.freeze([
    Object.freeze({
      data_type: 'foundation',
      filename: 'records.foundation.json.gz',
      record_count: 353,
      compressed_bytes: 54188,
      compressed_sha256: 'cab340a836c230581b6fc891b7543cc161ab637254c45d0411d2470a394dd274',
      uncompressed_bytes: 984248,
      uncompressed_sha256: 'cfdf4af6472f0c3501361df525a2c485c607c6baf23778b3380ab38cbecc7b8a',
    }),
    Object.freeze({
      data_type: 'sr_legacy',
      filename: 'records.sr_legacy.json.gz',
      record_count: 7775,
      compressed_bytes: 1445111,
      compressed_sha256: '4f73b99807b71bf08e30677d7f1c185916f721e488168ee75e896d1086b7c3fd',
      uncompressed_bytes: 33695908,
      uncompressed_sha256: '1aedba90770903fb60944f2d9be5d92ff078bbfd464ce427c2c1e21a1ef6388a',
    }),
    Object.freeze({
      data_type: 'fndds',
      filename: 'records.fndds.json.gz',
      record_count: 5431,
      compressed_bytes: 972897,
      compressed_sha256: '4e6f7e2a7c5a438638344fd8fa23508d61a9183608e46c7bdbf05cd55f2c461b',
      uncompressed_bytes: 25024331,
      uncompressed_sha256: '47002c269078cd69106bd805a5486312243c9b46cad855fe5d7a67d81b7a1bdc',
    }),
  ]),
  total_compressed_bytes: 2472196,
  total_uncompressed_bytes: 59704487,
  warnings: Object.freeze([
    Object.freeze({ code: 'foundation_null_placeholder', count: 32 }),
    Object.freeze({ code: 'rejected_invalid_nutrient', count: 10 }),
    Object.freeze({ code: 'rejected_invalid_portion', count: 18 }),
    Object.freeze({ code: 'rejected_no_supported_nutrients', count: 1 }),
  ]),
  attribution:
    'U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, 2019. fdc.nal.usda.gov.',
});
