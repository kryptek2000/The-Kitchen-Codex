/**
 * The Kitchen Codex — Household-Portion Registry Contract (registry-track Phase 4):
 * public closed types, schema version, bounds, and failure taxonomy.
 *
 * PURE, platform-neutral, offline. This module defines the contract ONLY: no
 * normalization, no digests, no loading, no lookup. See `normalize.ts`
 * (canonical bounded field normalization), `digest.ts` (canonical digest
 * construction), and `registry.ts` (materialization, validation, release-lock
 * verification, immutable lookup).
 *
 * CONTRACT-ONLY STATUS
 * ---------------------
 * This phase ships ZERO real household-portion records and has ZERO effect on
 * matching, calculation, live rows, AI, Apply, persistence, or user-visible
 * behavior. Nothing outside `src/core/nutritionV2/household/` (and its tests)
 * may import this directory in Phase 4.
 *
 * AUTHORITY BOUNDARY
 * ------------------
 * The registry will eventually provide ONLY a mass conversion for an already
 * authenticated USDA food identity plus a compatible household unit. It never
 * provides or decides: food identity, FDC selection, nutrients, recipe totals,
 * AI confidence, automatic-match authority, user confirmation, or Apply
 * authorization. A valid registry record is not automatically authorized for
 * calculation.
 *
 * > Cryptographic integrity proves which reviewed record was loaded; it does
 * > not prove the real-world truth of the cited grams or authorize its use for
 * > a recipe.
 */

/** Closed registry-schema identifier (distinct from every other version). */
export const HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION = 'household_portion_registry_v1' as const;

/** Provenance class of one household-portion record. */
export type HouseholdPortionAuthorityClass = 'usda_derived' | 'vetted_standard' | 'bounded_estimate';

/** Closed source kinds. Web-recipe and manufacturer-package kinds are excluded. */
export type HouseholdPortionSourceKind = 'usda_fdc' | 'government_standard' | 'standards_body';

/** The only accepted quantity behavior. Future behaviors require a schema change. */
export type HouseholdPortionQuantityBehavior = 'linear';

// ---------------------------------------------------------------------------
// Bounds (all inclusive maxima; conservative and registry-specific)
// ---------------------------------------------------------------------------

/** Maximum authenticated records in one registry release. */
export const MAX_HOUSEHOLD_REGISTRY_RECORDS = 1_000;
/** Maximum total materialized registry bytes (sum of per-record JSON bytes). */
export const MAX_HOUSEHOLD_REGISTRY_BYTES = 512 * 1024;
/** Maximum UTF-8 bytes of one canonical food key / alias / citation-adjacent label. */
export const MAX_HOUSEHOLD_FOOD_KEY_BYTES = 200;
/** Maximum whitespace-separated tokens in one food key or alias. */
export const MAX_HOUSEHOLD_FOOD_KEY_TOKENS = 12;
/** Maximum aliases per record (after canonicalization and dedupe). */
export const MAX_HOUSEHOLD_ALIASES = 16;
/** Maximum declared USDA FDC ids per record. */
export const MAX_HOUSEHOLD_FDC_IDS = 16;
/** Maximum excluded states per record (the state vocabulary has 8 members). */
export const MAX_HOUSEHOLD_EXCLUDED_STATES = 8;
/**
 * Conservative registry-specific maximum grams for one household unit. This is
 * FAR below the existing calculation bound (`MAX_PORTION_GRAM_WEIGHT` =
 * 1,000,000) and does not raise any existing bound.
 */
export const MAX_HOUSEHOLD_GRAMS_PER_UNIT = 10_000;
/** Maximum UTF-8 bytes of one source citation. */
export const MAX_HOUSEHOLD_CITATION_BYTES = 500;
/** Maximum UTF-8 bytes of one source URL (aligned with the USDA manifest bound). */
export const MAX_HOUSEHOLD_URL_BYTES = 300;
/** Maximum characters of one registry release identifier. */
export const MAX_HOUSEHOLD_RELEASE_LENGTH = 64;

/**
 * Bounded registry-release identifier: 1..64 chars, ASCII, no leading
 * separator (aligned with the Phase 1 bundle-release rule, but a DISTINCT
 * namespace: a bundle release is never a valid substitute here and vice
 * versa — the schema version binds which namespace applies).
 */
export const HOUSEHOLD_RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Exact lowercase hexadecimal SHA-256 format (shared shape with Phase 1). */
export const HOUSEHOLD_SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Strict canonical calendar date `YYYY-MM-DD` (real dates validated separately). */
export const HOUSEHOLD_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------------------
// Closed failure taxonomy (fixed, bounded, input-redacted messages)
// ---------------------------------------------------------------------------

export type HouseholdFailureCode =
  | 'invalid_input'
  | 'invalid_schema_version'
  | 'invalid_record'
  | 'invalid_unit'
  | 'invalid_size'
  | 'invalid_state'
  | 'invalid_grams'
  | 'invalid_authority'
  | 'invalid_source'
  | 'invalid_date'
  | 'invalid_digest'
  | 'record_digest_mismatch'
  | 'registry_digest_mismatch'
  | 'record_count_mismatch'
  | 'duplicate_record'
  | 'ambiguous_lookup'
  | 'alias_collision'
  | 'supersedes_conflict'
  | 'registry_too_large'
  | 'not_found';

export const HOUSEHOLD_FAILURE_MESSAGE: Readonly<Record<HouseholdFailureCode, string>> = Object.freeze({
  invalid_input: 'household_invalid_input',
  invalid_schema_version: 'household_invalid_schema_version',
  invalid_record: 'household_invalid_record',
  invalid_unit: 'household_invalid_unit',
  invalid_size: 'household_invalid_size',
  invalid_state: 'household_invalid_state',
  invalid_grams: 'household_invalid_grams',
  invalid_authority: 'household_invalid_authority',
  invalid_source: 'household_invalid_source',
  invalid_date: 'household_invalid_date',
  invalid_digest: 'household_invalid_digest',
  record_digest_mismatch: 'household_record_digest_mismatch',
  registry_digest_mismatch: 'household_registry_digest_mismatch',
  record_count_mismatch: 'household_record_count_mismatch',
  duplicate_record: 'household_duplicate_record',
  ambiguous_lookup: 'household_ambiguous_lookup',
  alias_collision: 'household_alias_collision',
  supersedes_conflict: 'household_supersedes_conflict',
  registry_too_large: 'household_registry_too_large',
  not_found: 'household_not_found',
});

export interface HouseholdFailure {
  readonly code: HouseholdFailureCode;
  readonly message: string;
}

export function householdFailure(code: HouseholdFailureCode): HouseholdFailure {
  return { code, message: HOUSEHOLD_FAILURE_MESSAGE[code] };
}

// ---------------------------------------------------------------------------
// Record contract
// ---------------------------------------------------------------------------

/** Bounded source provenance of one household-portion record. */
export interface HouseholdPortionSource {
  readonly kind: HouseholdPortionSourceKind;
  readonly citation: string;
  readonly url: string | null;
  readonly accessed: string | null;
}

/** Bounded estimate window; required if and only if class is `bounded_estimate`. */
export interface HouseholdPortionBounds {
  readonly min_grams: number;
  readonly max_grams: number;
}

/**
 * Bounded semantic record INPUT (untrusted). The authenticated loaded record
 * (`AuthenticatedHouseholdPortionRecord`) adds a locally computed
 * `record_digest`; no provider, fixture, or raw object may supply an
 * authoritative digest.
 */
export interface HouseholdPortionRecordInput {
  readonly schema_version: typeof HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION;
  readonly food_key: string;
  readonly aliases: ReadonlyArray<string>;
  readonly usda_fdc_ids: ReadonlyArray<number>;
  readonly household_unit: string;
  readonly size_class: string | null;
  readonly grams_per_unit: number;
  readonly quantity_behavior: HouseholdPortionQuantityBehavior;
  readonly requires_state: string | null;
  readonly excluded_states: ReadonlyArray<string>;
  readonly exclude_generic_identity: boolean;
  readonly authority_class: HouseholdPortionAuthorityClass;
  readonly bounds: HouseholdPortionBounds | null;
  readonly source: HouseholdPortionSource;
  readonly reviewed_at: string;
  readonly supersedes: string | null;
}

/**
 * Authenticated loaded record: the canonical semantic record PLUS the locally
 * recomputed `record_digest`. The digest proves WHICH reviewed record was
 * loaded; it does not prove the real-world truth of the cited grams and does
 * not authorize use for a recipe.
 */
export interface AuthenticatedHouseholdPortionRecord extends HouseholdPortionRecordInput {
  readonly record_digest: string;
}

/** Release/manifest lock: independently recomputed and verified at load. */
export interface HouseholdPortionRegistryLock {
  readonly schema_version: typeof HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION;
  readonly registry_release: string;
  readonly record_count: number;
  readonly registry_digest: string;
}

/** Exact lookup dimensions: FDC id + canonical unit + size/state dimensions. */
export interface HouseholdLookupKey {
  readonly fdc_id: number;
  readonly household_unit: string;
  readonly size_class: string | null;
  readonly requires_state: string | null;
}
