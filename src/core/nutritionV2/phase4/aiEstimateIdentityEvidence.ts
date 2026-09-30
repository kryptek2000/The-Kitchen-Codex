/**
 * AI-3 FIVE-FIELD IDENTITY EVIDENCE — the Phase-4/session owner.
 *
 * Produces the complete `AiEstimateSelectionEvidence` for one CURRENT line, using
 * only in-session authority, and the ALREADY-EXTRACTED canonical digest
 * primitive. It adds no hashing, no confirmation, and no authority of its own.
 *
 * WHERE EACH FIELD COMES FROM (all current, all local):
 *
 *   line_ref                    Phase4Row.line_ref
 *   fdc_id                      the CURRENT authenticated selection
 *   record_digest               the CURRENT PINNED BUNDLE RECORD for that fdc id
 *   bundle_release              session.metadata().bundle_release
 *   ingredient_identity_digest  computeIngredientIdentityDigest(<facts>)
 *
 * `AiEstimateSelectionEvidence` remains the five-field contract. This module
 * never narrows it, never substitutes a field, and never invents one.
 *
 * CONFIRMATION AUTHORITY. The canonical identity payload carries a
 * `confirmation_digest` ONLY on the branches where the match carries explicit
 * confirmation authority; the calculator omits it for a bare `unique_exact`
 * match. The value it carries there is exactly `currentReview.review_digest` --
 * `confirmIngredientReview` proves the recomputed confirmation digest equals the
 * stored review digest or fails closed, so no re-confirmation is needed here.
 * The branch is reproduced from the CURRENT review outcome, never assumed.
 *
 * FAIL CLOSED. Any missing or unprovable field returns `null`. There is no
 * placeholder, no partial evidence and no fallback.
 */
import { parseIngredient } from '../matching/parse';
import { normalizeQuery } from '../matching/normalize';
import { isQualitativeIngredientText } from '../../../utils/ingredientSemantics';
import { computeIngredientIdentityDigest } from '../calculation/identityEvidence';
import type { AdvancedNutritionSession, Phase4State } from './types';

/** The complete five-field AI-3 selection authority. Never narrowed. */
export interface AiEstimateIdentityEvidence {
  readonly line_ref: string;
  readonly fdc_id: number;
  readonly record_digest: string;
  readonly ingredient_identity_digest: string;
  readonly bundle_release: string;
}

/** The canonical `MatchStatus` the CALCULATOR would assign for this line. */
type CalculatorMatchStatus = 'unique_exact' | 'user_confirmed' | 'auto_confirmed' | 'none';

export interface AiEstimateIdentityEvidenceInput {
  readonly session: AdvancedNutritionSession;
  readonly state: Phase4State;
  readonly lineRef: string;
}

export function deriveAiEstimateIdentityEvidence(
  input: AiEstimateIdentityEvidenceInput,
): AiEstimateIdentityEvidence | null {
  const row = input.state.rows.find((r) => r.line_ref === input.lineRef);
  const match = input.state.matches[input.lineRef] as
    | { fdc_id?: number; review_digest: string; kind?: string; automatic?: boolean }
    | undefined;
  if (row === undefined || match === undefined) return null;

  // 1. IDENTITY MUST BE AUTHENTICATED. No fdc id, no evidence.
  const fdcId = match.fdc_id ?? row.selected_fdc_id;
  if (typeof fdcId !== 'number' || !Number.isFinite(fdcId)) return null;

  // 2. REPRODUCE THE CALCULATOR'S MATCH-STATUS BRANCH from the CURRENT review
  //    outcome. `matched_exact` is a bare deterministic match and carries NO
  //    confirmation authority; `review_required` is a match that required
  //    confirmation and therefore DOES. Anything else has no identity.
  const confirmed = row.outcome === 'review_required';
  if (row.outcome !== 'matched_exact' && !confirmed) return null;
  const matchStatus: CalculatorMatchStatus = confirmed
    ? match.kind === 'manual' && match.automatic !== true
      ? 'user_confirmed'
      : 'auto_confirmed'
    : 'unique_exact';

  // 3. THE PINNED BUNDLE RECORD supplies the record digest. Phase-4 match state
  //    does NOT own it, and the session deliberately exposes no raw record map,
  //    so it is read through the session's OWN bounded authority:
  //    `reviewPortions(fdcId)` is built by `buildPortionReview(record, ...)`,
  //    whose `record_digest` IS `record.record_digest` and whose `fdc_id` /
  //    `bundle_release` are the same pinned values. Nothing is re-derived.
  const portions = input.session.reviewPortions(fdcId);
  if (!portions.ok) return null;
  const review = portions.review;
  if (review.fdc_id !== fdcId) return null;
  const recordDigest = review.record_digest;
  const bundleRelease = input.session.metadata().bundle_release;
  if (typeof recordDigest !== 'string' || recordDigest.length === 0) return null;
  if (review.bundle_release !== bundleRelease) return null;

  // 4. THE IDENTITY FACTS, exactly as the calculator composes them.
  const parsed = parseIngredient(row.original_text);
  if (!parsed.ok) return null;
  const p = parsed.parsed;
  const hasMeasurable = typeof p.amount === 'number' && Number.isFinite(p.amount);
  const qualitative = !hasMeasurable && isQualitativeIngredientText(`${p.query} ${p.original_text}`);

  // 5. CONFIRMATION AUTHORITY, included ONLY where the calculator includes it.
  //    On a confirmed match the value is the current review digest -- proven
  //    equal to the confirmation digest by `confirmIngredientReview`. On a bare
  //    `unique_exact` match the calculator omits the field, so we omit it too.
  const confirmationDigest = confirmed ? match.review_digest : undefined;
  if (confirmed && typeof confirmationDigest !== 'string') return null;

  const digest = computeIngredientIdentityDigest({
    lineRef: input.lineRef,
    originalText: row.original_text,
    amount: p.amount,
    rawUnit: p.raw_unit,
    normalizedUnit: p.normalized_unit,
    measurementKind: p.measurement_kind,
    query: row.query,
    normalizedQuery: normalizeQuery(row.query).text,
    note: row.note,
    qualitative,
    matchStatus,
    fdcId,
    // A bare `unique_exact` match has no confirmation authority AND no record
    // digest in the calculator either; both are omitted, not invented.
    recordDigest: confirmed ? recordDigest : undefined,
    confirmationDigest,
  });

  return Object.freeze({
    line_ref: input.lineRef,
    fdc_id: fdcId,
    record_digest: recordDigest,
    ingredient_identity_digest: digest,
    bundle_release: bundleRelease,
  });
}
