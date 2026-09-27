/**
 * The Kitchen Codex — Advanced Nutrition AI-2A: deterministic plan source.
 *
 * PURE, platform-neutral, provider-free. Turns an ALREADY-PRODUCED deterministic
 * `IngredientReviewResult` into one request-scoped, locally owned plan line
 * source:
 *
 *   deterministic review candidates
 *     -> AiAdvancedLocalCandidate[]            (local; record_digest preserved)
 *     -> buildAiAdvancedCandidateSet()         (frozen AI-0 contract)
 *     -> opaque provider view (c1..cN) + LOCAL ref -> candidate maps
 *
 * AUTHORITY BOUNDARY
 * ------------------
 *   - This module never calls a provider, never performs manual search, never
 *     invents a candidate finder, never widens the review result limit, and
 *     never builds candidates from arbitrary FDC ids: the candidate set is a
 *     projection of the EXACT candidates the deterministic matcher produced.
 *   - `review_digest`, `bundle_release`, `catalog_digest`, FDC ids and record
 *     digests stay LOCAL. Only the frozen AI-0 opaque views (`candidate_ref`,
 *     `display_description`, `semantic_tags`) are provider-facing.
 *   - Fail closed, never widen: an unusable review, a missing review digest, or
 *     more candidates than the frozen AI candidate cap produces a failure — the
 *     candidate list is NEVER truncated and candidates are NEVER dropped.
 *   - The caller decides WHERE the review came from. AI-2A is deliberately
 *     agnostic about whether the review originated from authored ingredient text
 *     or from a sanitized AI-1 semantic query; that live integration choice is
 *     deferred to AI-2C.
 */

import {
  MAX_AI_ADVANCED_CANDIDATES,
  buildAiAdvancedCandidateSet,
  type AiAdvancedCandidateSet,
  type AiAdvancedLocalCandidate,
} from './aiAdvancedCandidates';
import { MAX_AI_ADVANCED_LINE_REF_LENGTH } from './aiAdvanced';
import { AI_RESOLUTION_ISSUE_KINDS, type AiResolutionIssueKind } from './aiResolution';

export const AI_ADVANCED_PLAN_SOURCE_VERSION = 'nutrition_ai_advanced_plan_source_v1';

/** Maximum length of an optional interpretation fingerprint (local binding only). */
export const MAX_AI_ADVANCED_FINGERPRINT_LENGTH = 200;

export type AiAdvancedPlanSourceFailureCode =
  | 'invalid_line_ref'
  | 'unusable_review'
  | 'no_candidates'
  | 'too_many_candidates'
  | 'invalid_candidate'
  | 'duplicate_candidate'
  | 'missing_review_digest'
  | 'invalid_issue_kind'
  | 'invalid_fingerprint';

/**
 * One request-scoped plan line source. The provider-facing projection is
 * `candidate_set.views`; everything else on this object is LOCAL AUTHORITY and
 * must never be serialized towards a provider.
 */
export interface AiAdvancedPlanLineSource {
  readonly source_version: typeof AI_ADVANCED_PLAN_SOURCE_VERSION;
  readonly line_ref: string;
  /**
   * The exact deterministic review identity this candidate set was projected
   * from. A later review whose digest differs can never be satisfied by this
   * source's candidate set.
   */
  readonly review_digest: string;
  /** Trusted application issue kind, when the caller supplied one. */
  readonly issue_kind?: AiResolutionIssueKind;
  /** Optional AI-1 interpretation fingerprint this source was derived from. */
  readonly interpretation_fingerprint?: string;
  /** LOCAL candidate ref -> authenticated candidate maps (AI-0 contract). */
  readonly candidate_set: AiAdvancedCandidateSet;
  /** The opaque refs issued for this line, in deterministic `c1..cN` order. */
  readonly candidate_refs: ReadonlyArray<string>;
  /** Deterministic review outcome this projection came from. */
  readonly review_outcome: 'matched_exact' | 'review_required';
  /** Local release identity of the review's authenticated catalog. */
  readonly bundle_release: string;
  readonly catalog_digest: string;
  /** The exact effective candidate limit the review used (never widened). */
  readonly result_limit: number;
}

export type AiAdvancedPlanSourceResult =
  | { readonly ok: true; readonly source: AiAdvancedPlanLineSource }
  | { readonly ok: false; readonly code: AiAdvancedPlanSourceFailureCode };

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isIssueKind(value: unknown): value is AiResolutionIssueKind {
  return (
    typeof value === 'string' && (AI_RESOLUTION_ISSUE_KINDS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Maps the EXACT deterministic review candidates into local candidates.
 * `fdc_id`, `description` and (when present) `data_type` + `record_digest` are
 * preserved; nothing else is copied and nothing is invented.
 */
function localCandidatesFromReview(
  rawCandidates: ReadonlyArray<unknown>
): ReadonlyArray<AiAdvancedLocalCandidate> | 'invalid' {
  const out: AiAdvancedLocalCandidate[] = [];
  for (const entry of rawCandidates) {
    const record = asRecord(entry);
    if (record === undefined) return 'invalid';
    const fdcId = record['fdc_id'];
    const description = record['description'];
    if (typeof fdcId !== 'number' || !Number.isSafeInteger(fdcId) || fdcId <= 0) return 'invalid';
    if (typeof description !== 'string' || description.trim().length === 0) return 'invalid';
    const dataType = boundedText(record['data_type'], 40);
    const recordDigest = boundedText(record['record_digest'], 200);
    out.push(
      Object.freeze({
        fdc_id: fdcId,
        description: description.trim(),
        ...(dataType !== undefined ? { data_type: dataType } : {}),
        ...(recordDigest !== undefined ? { record_digest: recordDigest } : {}),
      })
    );
  }
  return Object.freeze(out);
}

/**
 * Builds one request-scoped plan line source from an already-produced
 * deterministic review. Never throws. Fails closed on anything it cannot prove.
 *
 * NOTE: this module preserves `record_digest` locally but deliberately does NOT
 * re-derive the review digest authority: the caller passes the review the
 * deterministic matcher produced, and `review_digest` is taken from it verbatim.
 */
export function buildAiAdvancedPlanLineSource(input: {
  readonly lineRef: unknown;
  readonly review: unknown;
  readonly issueKind?: unknown;
  readonly interpretationFingerprint?: unknown;
}): AiAdvancedPlanSourceResult {
  const lineRef = boundedText(input.lineRef, MAX_AI_ADVANCED_LINE_REF_LENGTH);
  if (lineRef === undefined) return { ok: false, code: 'invalid_line_ref' };

  const review = asRecord(input.review);
  if (review === undefined) return { ok: false, code: 'unusable_review' };
  const outcome = review['outcome'];
  if (outcome !== 'matched_exact' && outcome !== 'review_required') {
    // `unmatched` and `invalid` reviews carry no authoritative candidate set:
    // AI may never invent one for them.
    return { ok: false, code: 'unusable_review' };
  }

  const reviewDigest = boundedText(review['review_digest'], MAX_AI_ADVANCED_FINGERPRINT_LENGTH);
  if (reviewDigest === undefined) return { ok: false, code: 'missing_review_digest' };

  const rawCandidates = review['candidates'];
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    return { ok: false, code: 'no_candidates' };
  }
  if (rawCandidates.length > MAX_AI_ADVANCED_CANDIDATES) {
    // FAIL CLOSED, NEVER TRUNCATE: dropping candidates could silently remove the
    // only food the AI was allowed to select.
    return { ok: false, code: 'too_many_candidates' };
  }

  const candidates = localCandidatesFromReview(rawCandidates);
  if (candidates === 'invalid') return { ok: false, code: 'invalid_candidate' };

  let issueKind: AiResolutionIssueKind | undefined;
  if (input.issueKind !== undefined && input.issueKind !== null) {
    if (!isIssueKind(input.issueKind)) return { ok: false, code: 'invalid_issue_kind' };
    issueKind = input.issueKind;
  }

  let fingerprint: string | undefined;
  if (input.interpretationFingerprint !== undefined && input.interpretationFingerprint !== null) {
    fingerprint = boundedText(input.interpretationFingerprint, MAX_AI_ADVANCED_FINGERPRINT_LENGTH);
    if (fingerprint === undefined) return { ok: false, code: 'invalid_fingerprint' };
  }

  const built = buildAiAdvancedCandidateSet({ lineRef, candidates });
  if (built.ok !== true) {
    // The frozen AI-0 builder owns the duplicate/invalid/no-candidate rules; the
    // codes are structurally the same vocabulary, so they map through verbatim.
    return { ok: false, code: built.code };
  }

  const refs = built.set.views.map((view) => view.candidate_ref);
  const source: AiAdvancedPlanLineSource = Object.freeze({
    source_version: AI_ADVANCED_PLAN_SOURCE_VERSION,
    line_ref: lineRef,
    review_digest: reviewDigest,
    ...(issueKind !== undefined ? { issue_kind: issueKind } : {}),
    ...(fingerprint !== undefined ? { interpretation_fingerprint: fingerprint } : {}),
    candidate_set: built.set,
    candidate_refs: Object.freeze(refs),
    review_outcome: outcome,
    bundle_release: typeof review['bundle_release'] === 'string' ? review['bundle_release'] : '',
    catalog_digest: typeof review['catalog_digest'] === 'string' ? review['catalog_digest'] : '',
    result_limit: typeof review['result_limit'] === 'number' ? review['result_limit'] : 0,
  });
  return { ok: true, source };
}
