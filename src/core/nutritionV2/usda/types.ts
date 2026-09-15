/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: trusted USDA record contract.
 *
 * PURE, platform-neutral. Phase 1 defines a CLOSED, immutable canonical food
 * record adapted from the USDA FoodData Central downloadable data types
 * (Foundation Foods, SR Legacy, FNDDS). It does NOT calculate, match, display,
 * persist, or authorize anything.
 *
 * SOURCE AUTHORITY
 * ----------------
 * USDA FoodData Central (FDC) is the sole Phase 1 source authority:
 *   - Foundation Foods (April 2026)
 *   - SR Legacy (final April 2018 release)
 *   - FNDDS 2021-2023 (October 2024)
 * Data are public domain / CC0 1.0 with requested (not required) attribution.
 * Downloads are available as JSON and CSV. The live FDC API requires a data.gov
 * key and is intentionally NOT used in Phase 1 (no key, no live API, no route).
 *
 * BASIS
 * -----
 * Every canonical record is `basis: 'per_100_g'`. This is a SOURCE-FOOD basis,
 * deliberately distinct from the Phase 0 recipe block basis `basis: 'total'`.
 * A per-100-g source record must never be serialized as a recipe-total block.
 */

import type { NutrientId } from '../nutrients';
import type { CanonicalUnit } from '../units';

/** The only Phase 1 source id (matches the Phase 0 evidence source). */
export const USDA_SOURCE_ID = 'usda_fdc' as const;

/** Supported USDA data types for Phase 1. Branded Foods is deliberately excluded. */
export type UsdaDataType = 'foundation' | 'sr_legacy' | 'fndds';

export const USDA_DATA_TYPES: ReadonlyArray<UsdaDataType> = Object.freeze([
  'foundation',
  'sr_legacy',
  'fndds',
]);

/**
 * Exact `dataType` labels in the official FDC structured records. FNDDS records
 * use the label `Survey (FNDDS)`.
 */
export const USDA_DATA_TYPE_BY_FDC_LABEL: Readonly<Record<string, UsdaDataType>> = Object.freeze({
  Foundation: 'foundation',
  'SR Legacy': 'sr_legacy',
  'Survey (FNDDS)': 'fndds',
});

/** The only canonical source-food basis supported in Phase 1. */
export const USDA_FOOD_BASIS = 'per_100_g' as const;
export type UsdaFoodBasis = typeof USDA_FOOD_BASIS;

/** Canonicalization rule version; part of bundle identity. */
export const USDA_CANONICALIZATION_VERSION = 'usda_canonical_v1';
/** Manifest schema version. */
export const USDA_MANIFEST_SCHEMA = 1;

/** Required USDA attribution (requested by the source, not legally required). */
export const USDA_ATTRIBUTION =
  'U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, 2019. fdc.nal.usda.gov.';

/** Official USDA source host. Only this host may appear in a manifest URL. */
export const USDA_SOURCE_HOST = 'fdc.nal.usda.gov';

// ---------------------------------------------------------------------------
// Bounds (all inclusive maxima)
// ---------------------------------------------------------------------------

/**
 * Raw transport-record bounds. Deliberately SEPARATE from (and larger than) the
 * canonical trusted-record bound and the cache-entry bound. Derived from a
 * measured census of the three pinned official archives:
 *   max serialized UTF-8 record: Foundation 87,874 B; SR Legacy 55,622 B; FNDDS 17,587 B
 *   max nutrient entries: 159; max portions: 16; max depth: 5; max string: 978 chars
 * Bounds below include documented headroom and stay resource-bounded.
 */
export const MAX_USDA_RAW_RECORD_BYTES = 256 * 1024;
export const MAX_USDA_RAW_DEPTH = 8;
export const MAX_USDA_RAW_KEYS = 64;
export const MAX_USDA_RAW_ARRAY = 512;
export const MAX_USDA_RAW_STRING = 4096;
export const MAX_USDA_RAW_NUTRIENTS = 256;
export const MAX_USDA_RAW_PORTIONS = 64;

/**
 * Canonical trusted-record bound. The canonical record is a small, closed
 * projection of the raw transport record; it remains at 64 KiB.
 */
export const MAX_USDA_RECORD_BYTES = 64 * 1024;
/** Maximum nutrient entries examined in one source record. */
export const MAX_USDA_NUTRIENTS = 128;
/** Maximum source-provided portion records. */
export const MAX_USDA_PORTIONS = 32;
export const MAX_USDA_DESCRIPTION_LENGTH = 500;
export const MAX_USDA_CATEGORY_LENGTH = 200;
export const MAX_USDA_MEASURE_LENGTH = 120;
export const MAX_USDA_MODIFIER_LENGTH = 120;
export const MAX_USDA_RELEASE_ID_LENGTH = 64;
export const MAX_USDA_URL_LENGTH = 300;
export const MAX_USDA_ATTRIBUTION_LENGTH = 500;
export const MAX_USDA_GENERATOR_LENGTH = 80;
export const MAX_USDA_WARNINGS = 16;
export const MAX_USDA_WARNING_CODE_LENGTH = 80;
export const MAX_USDA_BUNDLE_RECORDS = 1_000_000;
export const MAX_PORTION_GRAM_WEIGHT = 1_000_000;
export const MAX_PORTION_AMOUNT = 1_000_000;
export const MAX_MANIFEST_BYTES = 32 * 1024;
export const MAX_MANIFEST_COMPONENTS = 3;

/** Exact lowercase hexadecimal SHA-256 format. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Bounded bundle release id: 1..64 chars, ASCII, no leading separator. */
export const BUNDLE_RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------
// Closed failure classification
// ---------------------------------------------------------------------------

export type UsdaAdaptFailureCode =
  | 'malformed'
  | 'unsafe'
  | 'oversized'
  | 'unsupported_data_type'
  | 'release_mismatch'
  | 'invalid_fdc_id'
  | 'invalid_basis'
  | 'invalid_nutrient'
  | 'unit_mismatch'
  | 'duplicate_nutrient'
  | 'invalid_portion'
  | 'record_too_large'
  | 'no_supported_nutrients'
  | 'digest_mismatch'
  | 'validation_error';

/** Fixed, bounded, input-redacted messages. Never echo source values. */
export const USDA_ADAPT_FAILURE_MESSAGE: Readonly<Record<UsdaAdaptFailureCode, string>> =
  Object.freeze({
    malformed: 'usda_record_malformed',
    unsafe: 'usda_record_unsafe',
    oversized: 'usda_record_oversized',
    unsupported_data_type: 'usda_data_type_unsupported',
    release_mismatch: 'usda_release_mismatch',
    invalid_fdc_id: 'usda_fdc_id_invalid',
    invalid_basis: 'usda_basis_invalid',
    invalid_nutrient: 'usda_nutrient_invalid',
    unit_mismatch: 'usda_nutrient_unit_mismatch',
    duplicate_nutrient: 'usda_nutrient_duplicate',
    invalid_portion: 'usda_portion_invalid',
    record_too_large: 'usda_record_too_large',
    no_supported_nutrients: 'usda_no_supported_nutrients',
    digest_mismatch: 'usda_digest_mismatch',
    validation_error: 'usda_validation_error',
  });

export interface UsdaAdaptFailure {
  readonly code: UsdaAdaptFailureCode;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Canonical trusted record
// ---------------------------------------------------------------------------

/** One canonical nutrient amount per 100 g, with exact source identity. */
export interface CanonicalNutrientRecord {
  readonly nutrient_id: NutrientId;
  readonly unit: CanonicalUnit;
  /** Exact numeric amount per 100 g in the Phase 0 canonical unit. */
  readonly amount_per_100g: number;
  /** Stable USDA nutrient/component id used for the mapping. */
  readonly usda_nutrient_id: number;
  /** Source unit label exactly as declared by USDA (e.g. `G`, `MG`, `KCAL`). */
  readonly source_unit: string;
  /** True only when an exact allowed conversion (e.g. kJ -> kcal) occurred. */
  readonly converted: boolean;
}

/**
 * Optional bounded source-provided gram-weight portion (evidence only).
 * `amount` is OPTIONAL because FNDDS portions legitimately omit it; a missing
 * source amount is never invented.
 */
export interface CanonicalPortionRecord {
  /** Stable USDA portion/measure reference when present. */
  readonly usda_portion_id?: number;
  readonly amount?: number;
  readonly measure: string;
  readonly gram_weight: number;
  readonly modifier?: string;
  readonly sequence?: number;
}

/** Closed immutable trusted USDA food record. */
export interface CanonicalUsdaFoodRecord {
  readonly source: 'usda_fdc';
  readonly bundle_release: string;
  readonly upstream_release: string;
  readonly fdc_id: number;
  readonly data_type: UsdaDataType;
  readonly description: string;
  readonly food_category?: string;
  readonly nutrient_map_version: string;
  readonly basis: 'per_100_g';
  readonly nutrients: Readonly<Partial<Record<NutrientId, CanonicalNutrientRecord>>>;
  readonly portions: ReadonlyArray<CanonicalPortionRecord>;
  /** Deterministic SHA-256 over the canonical content (excluding this field). */
  readonly record_digest: string;
}

/**
 * Validated release context supplied to the adapter. It binds one untrusted
 * source record to exactly one bundle release, component release, and data type.
 */
export interface UsdaReleaseContext {
  readonly bundle_release: string;
  readonly upstream_release: string;
  readonly data_type: UsdaDataType;
  readonly nutrient_map_version: string;
}

// ---------------------------------------------------------------------------
// Release manifest
// ---------------------------------------------------------------------------

export interface UsdaManifestComponent {
  readonly data_type: UsdaDataType;
  readonly upstream_release: string;
  readonly source_url: string;
  readonly source_sha256: string;
}

export interface UsdaManifestWarning {
  readonly code: string;
  readonly count: number;
}

export interface UsdaBundleManifest {
  readonly manifest_schema: 1;
  readonly bundle_release: string;
  readonly generator: { readonly name: string; readonly schema_version: string };
  readonly created_at: string;
  readonly data_types: ReadonlyArray<UsdaDataType>;
  readonly components: ReadonlyArray<UsdaManifestComponent>;
  readonly canonical_record_count: number;
  readonly rejected_record_count: number;
  readonly canonical_content_digest: string;
  readonly nutrient_map_version: string;
  readonly canonicalization_version: string;
  readonly warnings?: ReadonlyArray<UsdaManifestWarning>;
  readonly attribution: string;
}

export type UsdaManifestValidation =
  | { ok: true; manifest: UsdaBundleManifest; errors: [] }
  | { ok: false; errors: string[] };

export type UsdaAdaptResult =
  | { ok: true; record: CanonicalUsdaFoodRecord }
  | { ok: false; failure: UsdaAdaptFailure };
