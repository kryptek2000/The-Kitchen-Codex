/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: pinned generator constants.
 *
 * BUILD-TIME / OFFLINE ONLY. This module is imported only by the offline bundle
 * generator and verifier and by their tests. It is never imported by any
 * production React/UI, server, browser, or plugin runtime module.
 *
 * SHA-256 CAVEAT: a digest proves identity/integrity against a pinned expected
 * value. It does NOT, by itself, prove USDA authorship. Trust comes from the
 * separately verified official acquisition process plus these pinned identities.
 */

import type { UsdaDataType } from '../../src/core/nutritionV2/usda/types';
import { USDA_NUTRIENT_MAP_VERSION } from '../../src/core/nutritionV2/usda/nutrientMap';
import {
  USDA_ATTRIBUTION,
  USDA_CANONICALIZATION_VERSION,
} from '../../src/core/nutritionV2/usda/types';

export const GENERATOR_NAME = 'the-kitchen-codex-usda-bundle';
export const GENERATOR_SCHEMA_VERSION = '1';
/** Pinned reproducible bundle-build timestamp (NOT a USDA publication time). */
export const PINNED_CREATED_AT = '2026-09-15T00:00:00.000Z';

export const ARTIFACT_SCHEMA_VERSION = 1;
export const ARTIFACT_MANIFEST_FILENAME = 'manifest.json';
export const ARTIFACT_DESCRIPTOR_FILENAME = 'artifact.json';
export const GZIP_COMPRESSION_LEVEL = 9;

export const USDA_BUNDLE_ATTRIBUTION = USDA_ATTRIBUTION;
export const USDA_BUNDLE_NUTRIENT_MAP_VERSION = USDA_NUTRIENT_MAP_VERSION;
export const USDA_BUNDLE_CANONICALIZATION_VERSION = USDA_CANONICALIZATION_VERSION;

// ---------------------------------------------------------------------------
// Hard size limits (conservative release budget)
// ---------------------------------------------------------------------------

export const LIMIT_MANIFEST_BYTES = 64 * 1024;
export const LIMIT_ARTIFACT_BYTES = 64 * 1024;
export const LIMIT_COMPRESSED_SHARD_BYTES = 16 * 1024 * 1024;
export const LIMIT_TOTAL_COMPRESSED_BYTES = 32 * 1024 * 1024;
export const LIMIT_UNCOMPRESSED_SHARD_BYTES = 128 * 1024 * 1024;
export const LIMIT_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const LIMIT_TOTAL_RECORDS = 20_000;
/** Bounded streaming entry ceiling (raw JSON substring UTF-8 bytes). */
export const LIMIT_STREAM_ENTRY_BYTES = 256 * 1024;
/** Maximum gzip compression ratio allowed by the verifier. */
export const LIMIT_DECOMPRESSION_RATIO = 200;

// ---------------------------------------------------------------------------
// Secure ZIP policy bounds
// ---------------------------------------------------------------------------

export const ZIP_MAX_MEMBERS = 16;
export const ZIP_MAX_MEMBER_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const ZIP_MAX_MEMBER_COMPRESSED_BYTES = 64 * 1024 * 1024;
export const ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const ZIP_MAX_COMPRESSION_RATIO = 400;

// ---------------------------------------------------------------------------
// Pinned official source archives
// ---------------------------------------------------------------------------

export interface ArchiveSpec {
  readonly data_type: UsdaDataType;
  /** Official transport label the adapter dispatches on (`source.dataType`). */
  readonly transport_label: string;
  readonly upstream_release: string;
  readonly archive_filename: string;
  readonly source_url: string;
  readonly sha256: string;
  /** Expected top-level root collection key. */
  readonly root_key: string;
  /** Expected single JSON member name inside the archive. */
  readonly member_name: string;
  readonly expected_total_entries: number;
  readonly expected_null_placeholders: number;
  readonly expected_accepted: number;
}

export const ARCHIVE_SPECS: ReadonlyArray<ArchiveSpec> = Object.freeze([
  Object.freeze({
    data_type: 'foundation',
    transport_label: 'Foundation',
    upstream_release: '2026-04',
    archive_filename: 'FoodData_Central_foundation_food_json_2026-04-30.zip',
    source_url:
      'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip',
    sha256: '186e988ec542e913f51ef62b86a47758e8cdd0d1dc3889e7b055581f3c09c77a',
    root_key: 'FoundationFoods',
    member_name: 'FoodData_Central_foundation_food_json_2026-04-30.json',
    expected_total_entries: 395,
    expected_null_placeholders: 32,
    expected_accepted: 353,
  }),
  Object.freeze({
    data_type: 'sr_legacy',
    transport_label: 'SR Legacy',
    upstream_release: '2018-04',
    archive_filename: 'FoodData_Central_sr_legacy_food_json_2018-04.zip',
    source_url:
      'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip',
    sha256: '0fe8ae486a2c8eb42cb96413f058deb51863a46c8fb8eeb4b1fb45006dd338ef',
    root_key: 'SRLegacyFoods',
    member_name: 'FoodData_Central_sr_legacy_food_json_2018-04.json',
    expected_total_entries: 7_793,
    expected_null_placeholders: 0,
    expected_accepted: 7_775,
  }),
  Object.freeze({
    data_type: 'fndds',
    transport_label: 'Survey (FNDDS)',
    upstream_release: '2021-2023 (2024-10)',
    archive_filename: 'FoodData_Central_survey_food_json_2024-10-31.zip',
    source_url:
      'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip',
    sha256: 'dfb06ae7ddc397ccd570b91c14b75438ab2ba39f64f22d321f61d4a52a77f3eb',
    root_key: 'SurveyFoods',
    member_name: 'surveyDownload.json',
    expected_total_entries: 5_432,
    expected_null_placeholders: 0,
    expected_accepted: 5_431,
  }),
]);

export const SHARD_FILENAMES: Readonly<Record<UsdaDataType, string>> = Object.freeze({
  foundation: 'records.foundation.json.gz',
  sr_legacy: 'records.sr_legacy.json.gz',
  fndds: 'records.fndds.json.gz',
});

// ---------------------------------------------------------------------------
// Expected census
// ---------------------------------------------------------------------------

export const EXPECTED_TOTAL_ACCEPTED = 13_559;
export const EXPECTED_REJECTED_NON_NULL = 29;
export const EXPECTED_NULL_PLACEHOLDERS = 32;

/** Explicit, deterministic warning codes preserving each failure class. */
export const WARNING_CODE_NULL_PLACEHOLDER = 'foundation_null_placeholder';
export const WARNING_CODE_INVALID_NUTRIENT = 'rejected_invalid_nutrient';
export const WARNING_CODE_INVALID_PORTION = 'rejected_invalid_portion';
export const WARNING_CODE_NO_SUPPORTED_NUTRIENTS = 'rejected_no_supported_nutrients';

export const EXPECTED_WARNINGS: ReadonlyArray<{ code: string; count: number }> = Object.freeze([
  Object.freeze({ code: WARNING_CODE_NULL_PLACEHOLDER, count: 32 }),
  Object.freeze({ code: WARNING_CODE_INVALID_NUTRIENT, count: 10 }),
  Object.freeze({ code: WARNING_CODE_INVALID_PORTION, count: 18 }),
  Object.freeze({ code: WARNING_CODE_NO_SUPPORTED_NUTRIENTS, count: 1 }),
]);

/** Exact SR Legacy FDC ids that must be rejected as `invalid_portion`. */
export const EXPECTED_SR_LEGACY_REJECTED_FDC_IDS: ReadonlyArray<number> = Object.freeze([
  168789, 168790, 168796, 169239, 169617, 169621, 171056, 171062, 171073, 171300,
  171450, 171452, 171453, 171472, 171475, 171492, 172252, 173509,
]);

/** Deterministic shard ordering (data type). */
export const SHARD_ORDER: ReadonlyArray<UsdaDataType> = Object.freeze([
  'foundation',
  'sr_legacy',
  'fndds',
]);
