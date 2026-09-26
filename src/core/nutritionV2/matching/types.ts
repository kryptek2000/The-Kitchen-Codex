/**
 * The Kitchen Codex — Advanced Nutrition Phase 2: closed review-layer contract.
 *
 * PURE, platform-neutral, offline. Phase 2 answers ONLY:
 *   "Which pinned USDA food records are plausible candidates for this
 *    ingredient, and does a human need to choose?"
 * It NEVER answers "what are this recipe's nutrition totals?" and it never
 * calculates, persists, applies, or authorizes anything.
 *
 * This module defines the closed vocabulary shared by the Phase 2 parsing,
 * normalization, catalog, ranking, and review/confirmation modules. It is NOT
 * re-exported from any public production barrel.
 */

import type {
  CanonicalPackageNetMass,
  CanonicalQuantityKind,
  CanonicalUnitKind,
  MeasurementKind,
  NormalizedUnit,
} from '../../../utils/measurements';
import type { UsdaDataType } from '../usda/types';

// ---------------------------------------------------------------------------
// Versions (pinned; part of confirmation binding)
// ---------------------------------------------------------------------------

export const MATCHING_NORMALIZATION_VERSION = 'usda_match_normalize_v2';
export const MATCHING_RANKING_VERSION = 'usda_match_rank_v11';
export const MATCHING_CATALOG_VERSION = 'usda_review_catalog_v2';
export const MATCHING_CONFIRMATION_VERSION = 'usda_match_confirm_v2';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Maximum working length of one ingredient line/query text. Matches the existing
 * deterministic-nutrition working bound (`toIngredientParts` slices at 300) so an
 * oversized authoritative query is REJECTED, never silently truncated into a
 * different valid ingredient.
 */
export const MAX_INGREDIENT_TEXT_LENGTH = 300;
/** Maximum bounded caller-supplied line reference length. */
export const MAX_INGREDIENT_LINE_REF_LENGTH = 200;
/** Maximum note/preparation text length retained as non-authoritative evidence. */
export const MAX_INGREDIENT_NOTE_LENGTH = 200;
/** Maximum token count for a normalized query. */
export const MAX_QUERY_TOKENS = 32;
/** Maximum length of a single normalized token. */
export const MAX_TOKEN_LENGTH = 48;

/**
 * Maximum accepted catalog record count. Derived from the combined accepted
 * population of the three pinned Phase 1 releases (Foundation 353 + SR Legacy
 * 7,775 + FNDDS 5,431 = 13,559), with documented headroom.
 */
export const MAX_CATALOG_RECORDS = 20_000;
/** Default number of ranked candidates returned for review. */
export const DEFAULT_RESULT_LIMIT = 10;
/** Hard maximum number of ranked candidates returned for review. */
export const MAX_RESULT_LIMIT = 25;

/**
 * Manual (full-catalog) USDA search bounds. Manual search is a discovery tool
 * over the entire eligible pinned catalog, so it is bounded separately from the
 * automatic review candidate limit.
 */
export const MANUAL_SEARCH_DEFAULT_LIMIT = 20;
export const MANUAL_SEARCH_MAX_LIMIT = 100;

/** Exact lowercase hexadecimal SHA-256 format (shared with Phase 1). */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Closed failure taxonomy
// ---------------------------------------------------------------------------

export type Phase2FailureCode =
  // parsing
  | 'invalid_input'
  | 'unsafe_input'
  | 'oversized_input'
  | 'unknown_field'
  | 'invalid_amount'
  | 'invalid_unit'
  | 'invalid_name'
  | 'invalid_line_ref'
  | 'empty_query'
  | 'invalid_query'
  // catalog
  | 'invalid_manifest'
  | 'invalid_record'
  | 'duplicate_fdc_id'
  | 'release_mismatch'
  | 'count_mismatch'
  | 'content_digest_mismatch'
  | 'too_many_records'
  | 'empty_catalog'
  // confirmation
  | 'invalid_catalog'
  | 'invalid_review'
  | 'unsafe_review'
  | 'invalid_selection'
  | 'unsafe_selection'
  | 'not_reviewable'
  | 'candidate_not_in_review_set'
  | 'malformed_digest'
  | 'stale_review'
  | 'binding_mismatch'
  // shared
  | 'validation_error';

/** Fixed, bounded, input-redacted messages. Never echo source values. */
export const PHASE2_FAILURE_MESSAGE: Readonly<Record<Phase2FailureCode, string>> = Object.freeze({
  invalid_input: 'phase2_invalid_input',
  unsafe_input: 'phase2_unsafe_input',
  oversized_input: 'phase2_oversized_input',
  unknown_field: 'phase2_unknown_field',
  invalid_amount: 'phase2_invalid_amount',
  invalid_unit: 'phase2_invalid_unit',
  invalid_name: 'phase2_invalid_name',
  invalid_line_ref: 'phase2_invalid_line_ref',
  empty_query: 'phase2_empty_query',
  invalid_query: 'phase2_invalid_query',
  invalid_manifest: 'phase2_invalid_manifest',
  invalid_record: 'phase2_invalid_record',
  duplicate_fdc_id: 'phase2_duplicate_fdc_id',
  release_mismatch: 'phase2_release_mismatch',
  count_mismatch: 'phase2_count_mismatch',
  content_digest_mismatch: 'phase2_content_digest_mismatch',
  too_many_records: 'phase2_too_many_records',
  empty_catalog: 'phase2_empty_catalog',
  invalid_catalog: 'phase2_invalid_catalog',
  invalid_review: 'phase2_invalid_review',
  unsafe_review: 'phase2_unsafe_review',
  invalid_selection: 'phase2_invalid_selection',
  unsafe_selection: 'phase2_unsafe_selection',
  not_reviewable: 'phase2_not_reviewable',
  candidate_not_in_review_set: 'phase2_candidate_not_in_review_set',
  malformed_digest: 'phase2_malformed_digest',
  stale_review: 'phase2_stale_review',
  binding_mismatch: 'phase2_binding_mismatch',
  validation_error: 'phase2_validation_error',
});

export interface Phase2Failure {
  readonly code: Phase2FailureCode;
  readonly message: string;
}

export function phase2Failure(code: Phase2FailureCode): Phase2Failure {
  return { code, message: PHASE2_FAILURE_MESSAGE[code] };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** A normalized matching query: one canonical phrase plus bounded tokens. */
export interface NormalizedQuery {
  /** NFC-normalized, non-locale-lowercased, whitespace-collapsed phrase. */
  readonly text: string;
  /** Bounded tokens derived from `text` (order preserved). */
  readonly tokens: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Parsed ingredient review
// ---------------------------------------------------------------------------

/**
 * Defensive, derived review view of one ingredient. It preserves the original
 * text and never mutates the source. `grams`/`milliliters` are populated ONLY
 * for direct mass / volume units; count and unknown never carry mass.
 */
/**
 * Deterministic representative metadata for a recipe-authored MASS RANGE. The
 * endpoints are the author's authority; `representative_grams` is the bounded
 * MIDPOINT scalar used by the calculation. This is recipe-authored deterministic
 * range handling, NOT an AI estimate, and it is never persisted as if it were an
 * exact author-written scalar.
 */
export interface RangeRepresentative {
  readonly amount_source: 'written_mass_range';
  readonly policy: 'midpoint';
  readonly lower: number;
  readonly upper: number;
  /** Canonical mass unit the endpoints were written in (`g`, `kg`, `oz`, `lb`). */
  readonly unit: string;
  readonly representative_grams: number;
}

export interface ParsedIngredientReview {
  /** Bounded stable reference (caller-supplied, else the original text). */
  readonly line_ref: string;
  /** Verbatim (bounded) original ingredient text. */
  readonly original_text: string;
  /** Parsed numeric quantity, or null when no quantity was expressed. */
  readonly amount: number | null;
  /** Original unit token as supplied, or undefined. */
  readonly raw_unit: string | undefined;
  readonly normalized_unit: NormalizedUnit;
  readonly measurement_kind: MeasurementKind;
  /** Deterministic grams when kind === 'mass'; else undefined. */
  readonly grams: number | undefined;
  /** Deterministic milliliters when kind === 'volume'; else undefined. */
  readonly milliliters: number | undefined;
  /** True when the measurement classifies as a countable noun. */
  readonly count: boolean;
  /** Bounded food-name query text used for matching. */
  readonly query: string;
  /** Non-authoritative preparation/note text when already present. */
  readonly note: string | undefined;
  /** Canonical Phase 1 parse contract version (`CANONICAL_INGREDIENT_PARSE_VERSION`). */
  readonly parse_version: string;
  /**
   * Canonical quantity classification. `amount` is populated ONLY for an exact
   * quantity: a true range never collapses to one endpoint.
   */
  readonly quantity_kind: CanonicalQuantityKind;
  /** Range endpoints when `quantity_kind === 'range'`; undefined otherwise. */
  readonly quantity_range: { readonly lower: number; readonly upper: number } | undefined;
  /**
   * Present ONLY when `grams` was derived from a written MASS RANGE (the
   * documented midpoint policy). An exact author-written scalar mass leaves this
   * undefined, so the two remain distinguishable downstream.
   */
  readonly range_representative: RangeRepresentative | undefined;
  /** Canonical unit classification: mass, volume, count, container, unknown. */
  readonly unit_kind: CanonicalUnitKind;
  /** Canonical count noun (leading or after the food), when recognized. */
  readonly count_noun: string | undefined;
  /** Canonical container noun, when recognized. */
  readonly container: string | undefined;
  /** Explicit package net mass, when the source declares one. Never mass authority. */
  readonly package_net_mass: CanonicalPackageNetMass | undefined;
}

export type IngredientParseResult =
  | { ok: true; parsed: ParsedIngredientReview }
  | { ok: false; failure: Phase2Failure };

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Closed match classes, most specific first. A higher class is never inferred
 * from a lower one; only `exact_phrase` can ever be an automatic identity match.
 */
export type MatchClass =
  | 'exact_phrase'
  | 'exact_token_multiset'
  | 'all_query_tokens_present'
  | 'partial_token_overlap'
  | 'no_match';

/** Bounded, explainable ranking evidence for one candidate. */
export interface RankingEvidence {
  readonly exact_phrase: boolean;
  readonly exact_token_multiset: boolean;
  readonly matched_query_token_count: number;
  readonly missing_query_token_count: number;
  readonly extra_candidate_token_count: number;
  readonly order_agreement: boolean;
}

/** One ranked review candidate (identity + review metadata only, no nutrients). */
export interface RankedCandidate {
  readonly fdc_id: number;
  readonly data_type: UsdaDataType;
  readonly description: string;
  readonly normalized_description: string;
  readonly record_digest: string;
  readonly match_class: MatchClass;
  readonly evidence: RankingEvidence;
}

/** Bounded rankable entry derived from a validated canonical Phase 1 record. */
export interface RankableEntry {
  readonly fdc_id: number;
  readonly data_type: UsdaDataType;
  readonly description: string;
  readonly normalized_description: string;
  readonly normalized_tokens: ReadonlyArray<string>;
  readonly record_digest: string;
}

/**
 * One FULL-CATALOG manual-search hit. This is DISCOVERY data only: it carries no
 * automatic authority and may include records the automatic analyzer would never
 * auto-select. The user decides what to select; the calculation engine
 * independently re-authenticates any selection made from it.
 */
export interface ManualSearchHit {
  readonly fdc_id: number;
  readonly data_type: UsdaDataType;
  readonly description: string;
  readonly normalized_description: string;
  readonly record_digest: string;
  /** Number of query tokens matched (equals `query_token_count` for a hit). */
  readonly matched_token_count: number;
  readonly query_token_count: number;
  readonly exact_description: boolean;
  readonly exact_fdc_id: boolean;
}

export interface ManualSearchOutcome {
  /** Bounded ranked hits (at most the requested limit). */
  readonly hits: ReadonlyArray<ManualSearchHit>;
  /** Total number of full-catalog records that matched the query (before the limit). */
  readonly total: number;
}

// ---------------------------------------------------------------------------
// Review outcome
// ---------------------------------------------------------------------------

export type ReviewOutcome = 'matched_exact' | 'review_required' | 'unmatched' | 'invalid';

interface ReviewCommon {
  readonly line_ref: string | undefined;
  readonly original_text: string | undefined;
  readonly query: string | undefined;
  readonly normalized_query: string | undefined;
  readonly query_tokens: ReadonlyArray<string>;
  readonly bundle_release: string;
  readonly catalog_digest: string;
  readonly normalization_version: string;
  readonly ranking_version: string;
  /**
   * The exact effective candidate limit used to produce `candidates`. It shapes
   * the authoritative candidate set and is part of the review digest, so a
   * caller cannot change a limit to hide or change the authoritative set.
   */
  readonly result_limit: number;
  /**
   * Phase 1 canonical count noun (amount metadata; `clove`, `slice`, ...).
   * Bounded and additive: it never participates in the review digest and is
   * consumed only as negative/count evidence by the projection context.
   */
  readonly count_noun?: string | undefined;
  /**
   * Phase 1 canonical container noun (amount metadata; `can`, `jar`, ...).
   * Bounded and additive; a `can` supplies the projection's `canned` state.
   */
  readonly container?: string | undefined;
  readonly candidates: ReadonlyArray<RankedCandidate>;
  readonly review_digest: string | undefined;
}

export interface InvalidReview extends ReviewCommon {
  readonly outcome: 'invalid';
  readonly failure: Phase2Failure;
}

export interface UnmatchedReview extends ReviewCommon {
  readonly outcome: 'unmatched';
}

export interface ReviewRequiredResult extends ReviewCommon {
  readonly outcome: 'review_required';
}

export interface MatchedExactResult extends ReviewCommon {
  readonly outcome: 'matched_exact';
  readonly selected_fdc_id: number;
}

export type IngredientReviewResult =
  | InvalidReview
  | UnmatchedReview
  | ReviewRequiredResult
  | MatchedExactResult;

// ---------------------------------------------------------------------------
// Confirmation / rejection
// ---------------------------------------------------------------------------

export interface ConfirmedReview {
  readonly outcome: 'confirmed';
  readonly confirmation_version: string;
  readonly fdc_id: number;
  readonly line_ref: string;
  readonly normalized_query: string;
  readonly bundle_release: string;
  readonly catalog_digest: string;
  readonly ranking_version: string;
  readonly normalization_version: string;
  readonly result_limit: number;
  readonly review_digest: string;
}

export interface RejectedReview {
  readonly outcome: 'rejected';
  readonly confirmation_version: string;
  readonly line_ref: string;
  readonly normalized_query: string;
  readonly bundle_release: string;
  readonly catalog_digest: string;
  readonly ranking_version: string;
  readonly normalization_version: string;
  readonly result_limit: number;
  readonly review_digest: string;
}

export interface InvalidConfirmation {
  readonly outcome: 'invalid';
  readonly failure: Phase2Failure;
}

export type ConfirmationResult = ConfirmedReview | RejectedReview | InvalidConfirmation;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface ReviewCatalogMetadata {
  readonly catalog_version: string;
  readonly normalization_version: string;
  readonly ranking_version: string;
  readonly query_projection_version: string;
  readonly eligibility_version: string;
  /** Deterministic digest of the closed eligibility policy. */
  readonly eligibility_digest: string;
  readonly bundle_release: string;
  /** Number of authenticated source records (13,559 for the pinned bundle). */
  readonly source_record_count: number;
  /** Number of records ELIGIBLE for home-recipe matching. */
  readonly eligible_record_count: number;
  /** Number of authenticated records excluded by the eligibility policy. */
  readonly excluded_record_count: number;
  /** Eligible indexed record count (equal to `eligible_record_count`). */
  readonly record_count: number;
  readonly data_types: ReadonlyArray<UsdaDataType>;
  readonly upstream_releases: Readonly<Partial<Record<UsdaDataType, string>>>;
  readonly nutrient_map_version: string;
  readonly canonicalization_version: string;
  /** Deterministic digest over the catalog identity + eligible descriptions. */
  readonly catalog_digest: string;
}

export interface ReviewCatalog {
  /** Bounded, frozen catalog metadata. */
  metadata(): ReviewCatalogMetadata;
  /** Number of indexed records. */
  size(): number;
  /** Deterministic bounded ranked candidates for one normalized query. */
  search(normalized: NormalizedQuery, limit: number): ReadonlyArray<RankedCandidate>;
  /**
   * Deterministic FULL-CATALOG manual search for one normalized query. Unlike
   * `search`, this does NOT apply the automatic anchor/family/eligibility
   * authority — it ranks every eligible record for DISCOVERY so a user can find
   * a food even when automatic matching failed. Results are bounded by `limit`.
   */
  manualSearch(normalized: NormalizedQuery, limit: number): ManualSearchOutcome;
  /**
   * Number of catalog records whose normalized description EXACTLY equals the
   * normalized query phrase. Bounded, deterministic metadata used to decide the
   * automatic-match rule without trusting the (capped) candidate list.
   */
  exactPhraseCount(normalized: NormalizedQuery): number;
}

export type ReviewCatalogResult =
  | { ok: true; catalog: ReviewCatalog }
  | { ok: false; failure: Phase2Failure };
