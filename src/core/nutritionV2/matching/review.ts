/**
 * The Kitchen Codex — Advanced Nutrition Phase 2: authority boundary module.
 *
 * PURE, offline. This ONE lexical module owns the catalog authority registry and
 * both public operations that need it:
 *   - `createReviewCatalog` (registers the genuine catalog instance);
 *   - `confirmIngredientReview` (resolves authority for the exact catalog).
 * It also exposes the pure `reviewIngredient` snapshot classifier and the
 * deterministic `computeReviewDigest` snapshot helper.
 *
 * LEXICAL PRIVACY (audit repair)
 * ------------------------------
 * The authority registry is a module-local `WeakMap` with module-local
 * registration/retrieval functions. Neither the map nor those functions is
 * exported, so no other module — including via a direct file-path import — can
 * register an arbitrary object as a genuine catalog or retrieve authority state.
 * Registration happens only inside `createReviewCatalog`; retrieval happens only
 * inside `confirmIngredientReview`. There is no exported registry, symbol, token,
 * brand, key, handle, or dependency-injection hook for authority.
 *
 * AUTOMATIC-MATCH RULE (the ONLY automatic identity outcome):
 *   `matched_exact` requires ALL of:
 *     - the normalized ingredient phrase exactly equals the normalized USDA
 *       description;
 *     - EXACTLY ONE catalog record has that exact normalized description;
 *     - the result is bound to the validated bundle and every invariant passes.
 *   Token-set equality, token overlap, word reordering, and containment ALWAYS
 *   require review. A numeric score or first-ranked result NEVER authorizes an
 *   automatic selection.
 *
 * CONFIRMATION AUTHORITY
 * ----------------------
 * Confirmation requires a GENUINE live catalog instance (created by
 * `createReviewCatalog`) and independently RECONSTRUCTS the authoritative review
 * from that catalog. A caller-supplied review is never trusted on its own: its
 * snapshot digest is recomputed and it must be canonically identical to the
 * current-catalog reconstruction. SHA-256 proves deterministic snapshot
 * integrity only — it is NOT authentication; authority comes from
 * current-catalog reconstruction.
 */

import { isPlainObject, toInertValue } from '../schema';
import { canonicalStringify, sha256Hex } from '../usda/digest';
import { computeCanonicalContentDigest, validateManifest } from '../usda/manifest';
import { validateCanonicalRecord } from '../usda/record';
import {
  BUNDLE_RELEASE_PATTERN,
  MAX_USDA_DESCRIPTION_LENGTH,
  USDA_DATA_TYPES,
  type CanonicalUsdaFoodRecord,
  type UsdaDataType,
} from '../usda/types';
import { normalizeQuery, normalizeQueryChecked } from './normalize';
import { parseIngredient } from './parse';
import { QUERY_PROJECTION_VERSION } from './query';
import { searchManualCatalog, createManualSearchIndex, type ManualSearchIndex } from './manualSearch';
import {
  ELIGIBILITY_POLICY_VERSION,
  computeEligibilityPolicyDigest,
  evaluateEligibility,
} from './eligibility';
import { clampResultLimit, rankCandidates } from './rank';
import {
  MATCHING_CATALOG_VERSION,
  MATCHING_CONFIRMATION_VERSION,
  MATCHING_NORMALIZATION_VERSION,
  MATCHING_RANKING_VERSION,
  MAX_CATALOG_RECORDS,
  MAX_INGREDIENT_TEXT_LENGTH,
  MAX_QUERY_TOKENS,
  MAX_RESULT_LIMIT,
  MAX_TOKEN_LENGTH,
  SHA256_HEX_PATTERN,
  phase2Failure,
  type ConfirmationResult,
  type IngredientReviewResult,
  type MatchClass,
  type NormalizedQuery,
  type ParsedIngredientReview,
  type Phase2Failure,
  type Phase2FailureCode,
  type RankableEntry,
  type RankedCandidate,
  type RankingEvidence,
  type ReviewCatalog,
  type ReviewCatalogMetadata,
  type ReviewCatalogResult,
} from './types';

// ---------------------------------------------------------------------------
// Private catalog authority — lexically scoped; NEVER exported
// ---------------------------------------------------------------------------

/**
 * Frozen authority state for one genuine catalog instance. Module-local type,
 * never exported.
 */
interface CatalogAuthority {
  readonly metadata: ReviewCatalogMetadata;
  readonly entries: ReadonlyArray<RankableEntry>;
}

/**
 * The authority registry is a module-local `WeakMap`. It is NOT exported and
 * neither registration nor retrieval is exported, so no other module can bless
 * an arbitrary object as a genuine catalog or obtain private authority state.
 * It cannot be forged structurally and does not retain catalogs after garbage
 * collection.
 */
const CATALOG_AUTHORITY = new WeakMap<object, CatalogAuthority>();

function registerCatalogAuthority(catalog: ReviewCatalog, authority: CatalogAuthority): void {
  CATALOG_AUTHORITY.set(catalog as object, authority);
}

function resolveCatalogAuthority(catalog: unknown): CatalogAuthority | undefined {
  if (typeof catalog !== 'object' || catalog === null) return undefined;
  try {
    return CATALOG_AUTHORITY.get(catalog as object);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Catalog construction (all-or-nothing)
// ---------------------------------------------------------------------------

function catalogFailure(code: Phase2FailureCode): ReviewCatalogResult {
  return { ok: false, failure: phase2Failure(code) };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Builds a trusted review catalog from a validated manifest and canonical
 * records. Returns a closed failure classification when anything is invalid.
 * Registers the genuine returned instance with its private authority state.
 */
export function createReviewCatalog(
  manifestRaw: unknown,
  recordsRaw: unknown
): ReviewCatalogResult {
  const manifestValidation = validateManifest(manifestRaw);
  if (!manifestValidation.ok) return catalogFailure('invalid_manifest');
  const manifest = manifestValidation.manifest;

  if (!Array.isArray(recordsRaw)) return catalogFailure('invalid_record');
  if (recordsRaw.length === 0) return catalogFailure('empty_catalog');
  if (recordsRaw.length > MAX_CATALOG_RECORDS) return catalogFailure('too_many_records');

  const records: CanonicalUsdaFoodRecord[] = [];
  for (const raw of recordsRaw) {
    const validation = validateCanonicalRecord(raw);
    if (!validation.ok) return catalogFailure('invalid_record');
    records.push(validation.record);
  }

  const componentByType = new Map<UsdaDataType, string>();
  for (const component of manifest.components) {
    componentByType.set(component.data_type, component.upstream_release);
  }

  const seenIds = new Set<number>();
  for (const record of records) {
    if (record.bundle_release !== manifest.bundle_release) return catalogFailure('release_mismatch');
    if (record.nutrient_map_version !== manifest.nutrient_map_version) {
      return catalogFailure('release_mismatch');
    }
    const expectedUpstream = componentByType.get(record.data_type);
    if (expectedUpstream === undefined || expectedUpstream !== record.upstream_release) {
      return catalogFailure('release_mismatch');
    }
    if (seenIds.has(record.fdc_id)) return catalogFailure('duplicate_fdc_id');
    seenIds.add(record.fdc_id);
  }

  // AUTHENTICATION-BEFORE-FILTERING: the COMPLETE source must pass the count and
  // content-digest checks before any eligibility filtering is applied. The
  // eligibility filter can never make a damaged/incomplete/forged artifact look
  // valid.
  if (records.length !== manifest.canonical_record_count) return catalogFailure('count_mismatch');
  if (computeCanonicalContentDigest(records) !== manifest.canonical_content_digest) {
    return catalogFailure('content_digest_mismatch');
  }

  // Build the ELIGIBLE home-recipe index. Excluded records are counted but never
  // indexed, so they can never appear in search results or be confirmed.
  const entries: RankableEntry[] = [];
  let excludedRecordCount = 0;
  for (const record of records) {
    if (!evaluateEligibility(record).eligible) {
      excludedRecordCount += 1;
      continue;
    }
    const normalized = normalizeQuery(record.description);
    entries.push({
      fdc_id: record.fdc_id,
      data_type: record.data_type,
      description: record.description,
      normalized_description: normalized.text,
      normalized_tokens: normalized.tokens,
      record_digest: record.record_digest,
    });
  }
  if (entries.length === 0) return catalogFailure('empty_catalog');

  // Deterministic iteration order (input order independence).
  entries.sort((a, b) => a.fdc_id - b.fdc_id);

  const upstreamReleases: Partial<Record<UsdaDataType, string>> = {};
  for (const component of manifest.components) {
    upstreamReleases[component.data_type] = component.upstream_release;
  }

  const eligibilityDigest = computeEligibilityPolicyDigest();
  const catalogDigest = sha256Hex(
    canonicalStringify({
      catalog_version: MATCHING_CATALOG_VERSION,
      normalization_version: MATCHING_NORMALIZATION_VERSION,
      ranking_version: MATCHING_RANKING_VERSION,
      query_projection_version: QUERY_PROJECTION_VERSION,
      eligibility_version: ELIGIBILITY_POLICY_VERSION,
      eligibility_digest: eligibilityDigest,
      bundle_release: manifest.bundle_release,
      nutrient_map_version: manifest.nutrient_map_version,
      canonicalization_version: manifest.canonicalization_version,
      source_record_count: records.length,
      eligible_record_count: entries.length,
      excluded_record_count: excludedRecordCount,
      records: entries.map((entry) => ({
        fdc_id: entry.fdc_id,
        record_digest: entry.record_digest,
        normalized_description: entry.normalized_description,
      })),
    })
  );

  const metadata: ReviewCatalogMetadata = deepFreeze({
    catalog_version: MATCHING_CATALOG_VERSION,
    normalization_version: MATCHING_NORMALIZATION_VERSION,
    ranking_version: MATCHING_RANKING_VERSION,
    query_projection_version: QUERY_PROJECTION_VERSION,
    eligibility_version: ELIGIBILITY_POLICY_VERSION,
    eligibility_digest: eligibilityDigest,
    bundle_release: manifest.bundle_release,
    source_record_count: records.length,
    eligible_record_count: entries.length,
    excluded_record_count: excludedRecordCount,
    record_count: entries.length,
    data_types: [...manifest.data_types],
    upstream_releases: upstreamReleases,
    nutrient_map_version: manifest.nutrient_map_version,
    canonicalization_version: manifest.canonicalization_version,
    catalog_digest: catalogDigest,
  });

  const frozenEntries = deepFreeze(entries);

  // Per-catalog manual-search index, built lazily on the first manual search and
  // reused thereafter. It carries no authority and is scoped to this catalog
  // closure (never exported, never global).
  let manualSearchIndex: ManualSearchIndex | undefined;
  const manualIndex = (): ManualSearchIndex => {
    if (manualSearchIndex === undefined) {
      manualSearchIndex = createManualSearchIndex(frozenEntries);
    }
    return manualSearchIndex;
  };

  const catalog: ReviewCatalog = Object.freeze({
    metadata(): ReviewCatalogMetadata {
      return metadata;
    },
    size(): number {
      return frozenEntries.length;
    },
    search(normalized: NormalizedQuery, limit: number) {
      if (
        !normalized ||
        typeof normalized.text !== 'string' ||
        !Array.isArray(normalized.tokens) ||
        normalized.text.length === 0
      ) {
        return Object.freeze([]);
      }
      return rankCandidates(normalized, frozenEntries, limit);
    },
    exactPhraseCount(normalized: NormalizedQuery): number {
      if (!normalized || typeof normalized.text !== 'string' || normalized.text.length === 0) {
        return 0;
      }
      let count = 0;
      for (const entry of frozenEntries) {
        if (entry.normalized_description === normalized.text) count += 1;
      }
      return count;
    },
    manualSearch(normalized: NormalizedQuery, limit: number) {
      if (
        !normalized ||
        typeof normalized.text !== 'string' ||
        !Array.isArray(normalized.tokens) ||
        normalized.text.length === 0
      ) {
        return Object.freeze({ hits: Object.freeze([]), total: 0 });
      }
      return searchManualCatalog(normalized, frozenEntries, manualIndex(), limit);
    },
  });

  // Establish the private, runtime-verifiable catalog authority capability.
  registerCatalogAuthority(catalog, Object.freeze({ metadata, entries: frozenEntries }));

  return { ok: true, catalog };
}

// ---------------------------------------------------------------------------
// Review snapshot
// ---------------------------------------------------------------------------

export interface ReviewOptions {
  readonly limit?: unknown;
}

function invalidReview(
  catalog: ReviewCatalog,
  failure: Phase2Failure,
  limit: number,
  parsed?: ParsedIngredientReview
): IngredientReviewResult {
  const metadata = catalog.metadata();
  return deepFreeze({
    outcome: 'invalid' as const,
    line_ref: parsed?.line_ref,
    original_text: parsed?.original_text,
    query: parsed?.query,
    ...(parsed?.count_noun !== undefined ? { count_noun: parsed.count_noun } : {}),
    ...(parsed?.container !== undefined ? { container: parsed.container } : {}),
    normalized_query: undefined,
    query_tokens: Object.freeze([] as string[]),
    bundle_release: metadata.bundle_release,
    catalog_digest: metadata.catalog_digest,
    normalization_version: MATCHING_NORMALIZATION_VERSION,
    ranking_version: MATCHING_RANKING_VERSION,
    result_limit: limit,
    candidates: Object.freeze([] as RankedCandidate[]),
    review_digest: undefined,
    failure,
  });
}

export interface ReviewDigestInput {
  readonly line_ref: string;
  readonly original_text: string;
  readonly query: string;
  readonly normalized_query: string;
  readonly query_tokens: ReadonlyArray<string>;
  readonly bundle_release: string;
  readonly catalog_digest: string;
  readonly normalization_version: string;
  readonly ranking_version: string;
  readonly result_limit: number;
  readonly candidates: ReadonlyArray<RankedCandidate>;
}

function candidateDigestShape(candidate: RankedCandidate) {
  return {
    fdc_id: candidate.fdc_id,
    data_type: candidate.data_type,
    description: candidate.description,
    normalized_description: candidate.normalized_description,
    record_digest: candidate.record_digest,
    match_class: candidate.match_class,
    evidence: {
      exact_phrase: candidate.evidence.exact_phrase,
      exact_token_multiset: candidate.evidence.exact_token_multiset,
      matched_query_token_count: candidate.evidence.matched_query_token_count,
      missing_query_token_count: candidate.evidence.missing_query_token_count,
      extra_candidate_token_count: candidate.evidence.extra_candidate_token_count,
      order_agreement: candidate.evidence.order_agreement,
    },
  };
}

export function computeReviewDigest(input: ReviewDigestInput): string {
  return sha256Hex(
    canonicalStringify({
      normalization_version: input.normalization_version,
      ranking_version: input.ranking_version,
      bundle_release: input.bundle_release,
      catalog_digest: input.catalog_digest,
      line_ref: input.line_ref,
      original_text: input.original_text,
      query: input.query,
      normalized_query: input.normalized_query,
      query_tokens: [...input.query_tokens],
      result_limit: input.result_limit,
      candidates: input.candidates.map(candidateDigestShape),
    })
  );
}

/**
 * Reviews one ingredient (raw string or structured object) against a review
 * catalog. Never throws; returns an immutable, explainable result. The result
 * is a SNAPSHOT only — it is not authority, and it is not confirmation.
 */
export function reviewIngredient(
  catalog: ReviewCatalog,
  raw: unknown,
  options: ReviewOptions = {}
): IngredientReviewResult {
  const limit = clampResultLimit(options.limit);
  const metadata = catalog.metadata();
  const parsedResult = parseIngredient(raw);
  if (!parsedResult.ok) {
    return invalidReview(
      catalog,
      (parsedResult as { ok: false; failure: Phase2Failure }).failure,
      limit
    );
  }
  const parsed = parsedResult.parsed;

  const normalizedResult = normalizeQueryChecked(parsed.query);
  if (!normalizedResult.ok) {
    const code = (normalizedResult as { ok: false; code: 'empty_query' | 'invalid_query' }).code;
    return invalidReview(catalog, phase2Failure(code), limit, parsed);
  }
  const normalized = normalizedResult.query;

  const candidates = catalog.search(normalized, limit);
  const exactCount = catalog.exactPhraseCount(normalized);

  const reviewDigest = computeReviewDigest({
    line_ref: parsed.line_ref,
    original_text: parsed.original_text,
    query: parsed.query,
    normalized_query: normalized.text,
    query_tokens: normalized.tokens,
    bundle_release: metadata.bundle_release,
    catalog_digest: metadata.catalog_digest,
    normalization_version: MATCHING_NORMALIZATION_VERSION,
    ranking_version: MATCHING_RANKING_VERSION,
    result_limit: limit,
    candidates,
  });

  const common = {
    line_ref: parsed.line_ref,
    original_text: parsed.original_text,
    query: parsed.query,
    ...(parsed.count_noun !== undefined ? { count_noun: parsed.count_noun } : {}),
    ...(parsed.container !== undefined ? { container: parsed.container } : {}),
    normalized_query: normalized.text,
    query_tokens: Object.freeze([...normalized.tokens]),
    bundle_release: metadata.bundle_release,
    catalog_digest: metadata.catalog_digest,
    normalization_version: MATCHING_NORMALIZATION_VERSION,
    ranking_version: MATCHING_RANKING_VERSION,
    result_limit: limit,
    candidates,
    review_digest: reviewDigest,
  };

  if (exactCount === 1) {
    const exact = candidates.find((candidate) => candidate.match_class === 'exact_phrase');
    if (exact) {
      return deepFreeze({
        ...common,
        outcome: 'matched_exact' as const,
        selected_fdc_id: exact.fdc_id,
      });
    }
  }

  if (exactCount > 1 || candidates.length > 0) {
    return deepFreeze({ ...common, outcome: 'review_required' as const });
  }

  return deepFreeze({ ...common, outcome: 'unmatched' as const });
}

// ---------------------------------------------------------------------------
// Confirmation / rejection (trusted current-catalog authority)
// ---------------------------------------------------------------------------

const SELECTION_KEYS = new Set([
  'kind',
  'fdc_id',
  'review_digest',
  'bundle_release',
  'normalized_query',
  'line_ref',
]);
const REVIEW_KEYS = new Set([
  'outcome',
  'line_ref',
  'original_text',
  'query',
  'normalized_query',
  'query_tokens',
  'bundle_release',
  'catalog_digest',
  'normalization_version',
  'ranking_version',
  'result_limit',
  'candidates',
  'review_digest',
  'selected_fdc_id',
  'failure',
  // Phase 2 bounded Phase 1 amount metadata (accepted for round-trip
  // compatibility; never part of the review digest and never identity).
  'count_noun',
  'container',
]);
const CANDIDATE_KEYS = new Set([
  'fdc_id',
  'data_type',
  'description',
  'normalized_description',
  'record_digest',
  'match_class',
  'evidence',
]);
const EVIDENCE_KEYS = new Set([
  'exact_phrase',
  'exact_token_multiset',
  'matched_query_token_count',
  'missing_query_token_count',
  'extra_candidate_token_count',
  'order_agreement',
]);
const MATCH_CLASSES: ReadonlySet<string> = new Set([
  'exact_phrase',
  'exact_token_multiset',
  'all_query_tokens_present',
  'partial_token_overlap',
  'no_match',
]);

function invalidConfirmation(code: Phase2FailureCode): ConfirmationResult {
  return Object.freeze({ outcome: 'invalid' as const, failure: phase2Failure(code) });
}

type Materialized = { ok: true; value: unknown } | { ok: false; unsafe: boolean };

function materialize(raw: unknown): Materialized {
  const result = toInertValue(raw);
  if (result.ok) return { ok: true, value: result.value };
  const reason = (result as { ok: false; reason: string }).reason;
  const unsafe =
    reason === 'dangerous_key' ||
    reason === 'accessor_or_hidden_property' ||
    reason === 'array_accessor_or_hole' ||
    reason === 'reflection_failed' ||
    reason === 'cycle' ||
    reason === 'symbol_key';
  return { ok: false, unsafe };
}

function isSafePositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0;
}

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0);
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

interface SanitizedReview {
  readonly outcome: 'review_required';
  readonly line_ref: string;
  readonly original_text: string;
  readonly query: string;
  readonly normalized_query: string;
  readonly query_tokens: ReadonlyArray<string>;
  readonly bundle_release: string;
  readonly catalog_digest: string;
  readonly normalization_version: string;
  readonly ranking_version: string;
  readonly result_limit: number;
  readonly candidates: ReadonlyArray<RankedCandidate>;
  readonly review_digest: string;
}

type SanitizedReviewResult =
  | { ok: true; review: SanitizedReview }
  | { ok: false; code: Phase2FailureCode };

function sanitizeEvidence(raw: unknown): RankingEvidence | undefined {
  if (!isPlainObject(raw)) return undefined;
  for (const key of Object.keys(raw)) if (!EVIDENCE_KEYS.has(key)) return undefined;
  const {
    exact_phrase,
    exact_token_multiset,
    matched_query_token_count,
    missing_query_token_count,
    extra_candidate_token_count,
    order_agreement,
  } = raw;
  if (typeof exact_phrase !== 'boolean' || typeof exact_token_multiset !== 'boolean') return undefined;
  if (typeof order_agreement !== 'boolean') return undefined;
  if (
    !isNonNegativeInt(matched_query_token_count) ||
    !isNonNegativeInt(missing_query_token_count) ||
    !isNonNegativeInt(extra_candidate_token_count)
  ) {
    return undefined;
  }
  return {
    exact_phrase,
    exact_token_multiset,
    matched_query_token_count,
    missing_query_token_count,
    extra_candidate_token_count,
    order_agreement,
  };
}

function sanitizeCandidate(raw: unknown): RankedCandidate | undefined {
  if (!isPlainObject(raw)) return undefined;
  for (const key of Object.keys(raw)) if (!CANDIDATE_KEYS.has(key)) return undefined;
  const { fdc_id, data_type, description, normalized_description, record_digest, match_class } = raw;
  if (!isSafePositiveInt(fdc_id)) return undefined;
  if (typeof data_type !== 'string' || !(USDA_DATA_TYPES as ReadonlyArray<string>).includes(data_type)) {
    return undefined;
  }
  if (!isBoundedString(description, MAX_USDA_DESCRIPTION_LENGTH)) return undefined;
  if (!isBoundedString(normalized_description, MAX_USDA_DESCRIPTION_LENGTH)) return undefined;
  if (!isHex64(record_digest)) return undefined;
  if (typeof match_class !== 'string' || !MATCH_CLASSES.has(match_class) || match_class === 'no_match') {
    return undefined;
  }
  const evidence = sanitizeEvidence(raw.evidence);
  if (!evidence) return undefined;
  return {
    fdc_id,
    data_type: data_type as UsdaDataType,
    description,
    normalized_description,
    record_digest,
    match_class: match_class as MatchClass,
    evidence,
  };
}

function sanitizeReview(raw: unknown): SanitizedReviewResult {
  const materialized = materialize(raw);
  if (!materialized.ok) {
    return {
      ok: false,
      code: (materialized as { ok: false; unsafe: boolean }).unsafe
        ? 'unsafe_review'
        : 'invalid_review',
    };
  }
  if (!isPlainObject(materialized.value)) return { ok: false, code: 'invalid_review' };
  const value = materialized.value;

  for (const key of Object.keys(value)) {
    if (!REVIEW_KEYS.has(key)) return { ok: false, code: 'unknown_field' };
  }
  if (value.outcome !== 'review_required') return { ok: false, code: 'not_reviewable' };
  if ('selected_fdc_id' in value || 'failure' in value) return { ok: false, code: 'not_reviewable' };

  if (!isBoundedString(value.line_ref, MAX_INGREDIENT_TEXT_LENGTH)) {
    return { ok: false, code: 'invalid_review' };
  }
  if (!isBoundedString(value.original_text, MAX_INGREDIENT_TEXT_LENGTH)) {
    return { ok: false, code: 'invalid_review' };
  }
  if (!isBoundedString(value.query, MAX_INGREDIENT_TEXT_LENGTH)) {
    return { ok: false, code: 'invalid_review' };
  }
  if (
    value.count_noun !== undefined &&
    !isBoundedString(value.count_noun, MAX_INGREDIENT_TEXT_LENGTH)
  ) {
    return { ok: false, code: 'invalid_review' };
  }
  if (
    value.container !== undefined &&
    !isBoundedString(value.container, MAX_INGREDIENT_TEXT_LENGTH)
  ) {
    return { ok: false, code: 'invalid_review' };
  }
  if (!isBoundedString(value.normalized_query, MAX_INGREDIENT_TEXT_LENGTH)) {
    return { ok: false, code: 'invalid_review' };
  }
  if (!Array.isArray(value.query_tokens) || value.query_tokens.length > MAX_QUERY_TOKENS) {
    return { ok: false, code: 'invalid_review' };
  }
  for (const token of value.query_tokens) {
    if (typeof token !== 'string' || token.length < 1 || token.length > MAX_TOKEN_LENGTH) {
      return { ok: false, code: 'invalid_review' };
    }
  }
  if (typeof value.bundle_release !== 'string' || !BUNDLE_RELEASE_PATTERN.test(value.bundle_release)) {
    return { ok: false, code: 'invalid_review' };
  }
  if (!isHex64(value.catalog_digest)) return { ok: false, code: 'invalid_review' };
  if (typeof value.normalization_version !== 'string' || typeof value.ranking_version !== 'string') {
    return { ok: false, code: 'invalid_review' };
  }
  if (
    !isNonNegativeInt(value.result_limit) ||
    (value.result_limit as number) < 1 ||
    (value.result_limit as number) > MAX_RESULT_LIMIT
  ) {
    return { ok: false, code: 'invalid_review' };
  }
  if (!isHex64(value.review_digest)) return { ok: false, code: 'invalid_review' };
  if (!Array.isArray(value.candidates) || value.candidates.length > MAX_RESULT_LIMIT) {
    return { ok: false, code: 'invalid_review' };
  }
  const candidates: RankedCandidate[] = [];
  for (const entry of value.candidates) {
    const candidate = sanitizeCandidate(entry);
    if (!candidate) return { ok: false, code: 'invalid_review' };
    candidates.push(candidate);
  }

  return {
    ok: true,
    review: {
      outcome: 'review_required',
      line_ref: value.line_ref,
      original_text: value.original_text,
      query: value.query,
      normalized_query: value.normalized_query,
      query_tokens: value.query_tokens as string[],
      bundle_release: value.bundle_release,
      catalog_digest: value.catalog_digest,
      normalization_version: value.normalization_version,
      ranking_version: value.ranking_version,
      result_limit: value.result_limit as number,
      candidates,
      review_digest: value.review_digest,
    },
  };
}

function sameTokens(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function sameEvidence(a: RankingEvidence, b: RankingEvidence): boolean {
  return (
    a.exact_phrase === b.exact_phrase &&
    a.exact_token_multiset === b.exact_token_multiset &&
    a.matched_query_token_count === b.matched_query_token_count &&
    a.missing_query_token_count === b.missing_query_token_count &&
    a.extra_candidate_token_count === b.extra_candidate_token_count &&
    a.order_agreement === b.order_agreement
  );
}

function sameCandidates(a: ReadonlyArray<RankedCandidate>, b: ReadonlyArray<RankedCandidate>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.fdc_id !== y.fdc_id ||
      x.data_type !== y.data_type ||
      x.description !== y.description ||
      x.normalized_description !== y.normalized_description ||
      x.record_digest !== y.record_digest ||
      x.match_class !== y.match_class ||
      !sameEvidence(x.evidence, y.evidence)
    ) {
      return false;
    }
  }
  return true;
}

interface Reconstruction {
  readonly candidates: ReadonlyArray<RankedCandidate>;
  readonly outcome: 'matched_exact' | 'review_required' | 'unmatched';
}

function reconstructReview(
  authority: CatalogAuthority,
  normalizedQueryText: string,
  resultLimit: number
): Reconstruction | undefined {
  const normalized = normalizeQuery(normalizedQueryText);
  if (normalized.text.length === 0 || normalized.text !== normalizedQueryText) return undefined;
  const candidates = rankCandidates(normalized, authority.entries, resultLimit);
  let exactCount = 0;
  for (const entry of authority.entries) {
    if (entry.normalized_description === normalizedQueryText) exactCount += 1;
  }
  let outcome: Reconstruction['outcome'];
  if (exactCount === 1 && candidates[0]?.match_class === 'exact_phrase') outcome = 'matched_exact';
  else if (exactCount > 1 || candidates.length > 0) outcome = 'review_required';
  else outcome = 'unmatched';
  return { candidates, outcome };
}

interface SanitizedSelection {
  readonly kind: 'candidate' | 'none';
  readonly fdc_id: number | undefined;
  readonly review_digest: string;
  readonly bundle_release: string | undefined;
  readonly normalized_query: string | undefined;
  readonly line_ref: string | undefined;
}

type SanitizedSelectionResult =
  | { ok: true; selection: SanitizedSelection }
  | { ok: false; code: Phase2FailureCode };

function sanitizeSelection(raw: unknown): SanitizedSelectionResult {
  const materialized = materialize(raw);
  if (!materialized.ok) {
    return {
      ok: false,
      code: (materialized as { ok: false; unsafe: boolean }).unsafe
        ? 'unsafe_selection'
        : 'invalid_selection',
    };
  }
  if (!isPlainObject(materialized.value)) return { ok: false, code: 'invalid_selection' };
  const value = materialized.value;
  for (const key of Object.keys(value)) {
    if (!SELECTION_KEYS.has(key)) return { ok: false, code: 'unknown_field' };
  }
  const kind = value.kind;
  if (kind !== 'candidate' && kind !== 'none') return { ok: false, code: 'invalid_selection' };
  if (!isHex64(value.review_digest)) return { ok: false, code: 'malformed_digest' };

  let fdcId: number | undefined;
  if (kind === 'candidate') {
    if (!isSafePositiveInt(value.fdc_id)) return { ok: false, code: 'candidate_not_in_review_set' };
    fdcId = value.fdc_id;
  } else if ('fdc_id' in value) {
    return { ok: false, code: 'invalid_selection' };
  }

  if (value.bundle_release !== undefined && typeof value.bundle_release !== 'string') {
    return { ok: false, code: 'invalid_selection' };
  }
  if (value.normalized_query !== undefined && typeof value.normalized_query !== 'string') {
    return { ok: false, code: 'invalid_selection' };
  }
  if (value.line_ref !== undefined && typeof value.line_ref !== 'string') {
    return { ok: false, code: 'invalid_selection' };
  }

  return {
    ok: true,
    selection: {
      kind,
      fdc_id: fdcId,
      review_digest: value.review_digest,
      bundle_release: value.bundle_release as string | undefined,
      normalized_query: value.normalized_query as string | undefined,
      line_ref: value.line_ref as string | undefined,
    },
  };
}

/**
 * Confirms or rejects a reviewed candidate against a GENUINE current catalog.
 *
 * The review is never trusted on its own: its snapshot digest is recomputed and
 * it must be canonically identical to the authoritative review independently
 * reconstructed from the genuine current catalog's validated state. Confirmation
 * NEVER authorizes calculation, persistence, or application.
 *
 * Honest trust boundary: this verifies against the genuine catalog instance the
 * caller supplies. It cannot know which catalog is globally "current"; a caller
 * that deliberately supplies an older genuine catalog cannot be distinguished
 * from one supplying the intended active catalog. Production composition is
 * responsible for supplying the active catalog.
 */
export function confirmIngredientReview(
  currentCatalog: unknown,
  reviewRaw: unknown,
  selectionRaw: unknown
): ConfirmationResult {
  try {
    const authority = resolveCatalogAuthority(currentCatalog);
    if (!authority) return invalidConfirmation('invalid_catalog');

    const reviewResult = sanitizeReview(reviewRaw);
    if (!reviewResult.ok) {
      return invalidConfirmation((reviewResult as { ok: false; code: Phase2FailureCode }).code);
    }
    const review = reviewResult.review;

    if (
      review.normalization_version !== MATCHING_NORMALIZATION_VERSION ||
      review.ranking_version !== MATCHING_RANKING_VERSION
    ) {
      return invalidConfirmation('stale_review');
    }
    if (
      review.bundle_release !== authority.metadata.bundle_release ||
      review.catalog_digest !== authority.metadata.catalog_digest
    ) {
      return invalidConfirmation('stale_review');
    }

    // 1. Recompute the snapshot digest from the supplied review content.
    const recomputedDigest = computeReviewDigest({
      line_ref: review.line_ref,
      original_text: review.original_text,
      query: review.query,
      normalized_query: review.normalized_query,
      query_tokens: review.query_tokens,
      bundle_release: review.bundle_release,
      catalog_digest: review.catalog_digest,
      normalization_version: review.normalization_version,
      ranking_version: review.ranking_version,
      result_limit: review.result_limit,
      candidates: review.candidates,
    });
    if (recomputedDigest !== review.review_digest) return invalidConfirmation('invalid_review');

    // 2. Independently reconstruct the authoritative review from the genuine
    //    current catalog and require exact canonical equality.
    const reconstruction = reconstructReview(authority, review.normalized_query, review.result_limit);
    if (!reconstruction) return invalidConfirmation('stale_review');
    if (reconstruction.outcome !== 'review_required') return invalidConfirmation('not_reviewable');

    const reNormalized = normalizeQuery(review.query);
    if (
      reNormalized.text !== review.normalized_query ||
      !sameTokens(reNormalized.tokens, review.query_tokens)
    ) {
      return invalidConfirmation('stale_review');
    }
    if (!sameCandidates(review.candidates, reconstruction.candidates)) {
      return invalidConfirmation('stale_review');
    }

    // 3. Validate the explicit selection.
    const selectionResult = sanitizeSelection(selectionRaw);
    if (!selectionResult.ok) {
      return invalidConfirmation((selectionResult as { ok: false; code: Phase2FailureCode }).code);
    }
    const selection = selectionResult.selection;
    if (selection.review_digest !== recomputedDigest) return invalidConfirmation('stale_review');

    if (
      selection.bundle_release !== undefined &&
      selection.bundle_release !== authority.metadata.bundle_release
    ) {
      return invalidConfirmation('binding_mismatch');
    }
    if (
      selection.normalized_query !== undefined &&
      selection.normalized_query !== review.normalized_query
    ) {
      return invalidConfirmation('binding_mismatch');
    }
    if (selection.line_ref !== undefined && selection.line_ref !== review.line_ref) {
      return invalidConfirmation('binding_mismatch');
    }

    const binding = {
      confirmation_version: MATCHING_CONFIRMATION_VERSION,
      line_ref: review.line_ref,
      normalized_query: review.normalized_query,
      bundle_release: authority.metadata.bundle_release,
      catalog_digest: authority.metadata.catalog_digest,
      ranking_version: MATCHING_RANKING_VERSION,
      normalization_version: MATCHING_NORMALIZATION_VERSION,
      result_limit: review.result_limit,
      review_digest: recomputedDigest,
    };

    if (selection.kind === 'none') {
      return Object.freeze({ outcome: 'rejected' as const, ...binding });
    }

    const fdcId = selection.fdc_id as number;
    if (!reconstruction.candidates.some((candidate) => candidate.fdc_id === fdcId)) {
      return invalidConfirmation('candidate_not_in_review_set');
    }

    return Object.freeze({ outcome: 'confirmed' as const, fdc_id: fdcId, ...binding });
  } catch {
    return invalidConfirmation('validation_error');
  }
}
