/**
 * The Kitchen Codex — Advanced Nutrition: AI-3 OFFER presentation and
 * SECOND-CLICK ACCEPTANCE.
 *
 * PURE, offline. This module owns the two halves of the offer-first contract:
 *
 *   1. `buildAiEstimateOffer` projects a validated reconcile entry into the
 *      DISPLAY-ONLY offer the user sees. An offer carries a bounded range and
 *      the locally derived midpoint. It grants no authority, changes no state,
 *      and never carries an FDC id, a digest or any provider internal.
 *
 *   2. `acceptAiEstimateOffer` performs EVERY re-check required at the second
 *      explicit click. If any of them fails the function returns a refusal and
 *      the caller MUST NOT touch working state. The checks are deliberately in
 *      one pure function so they are testable without React, and so a future
 *      editor cannot add a path that skips one.
 *
 * The acceptance path is the ONLY place an offer becomes a working choice.
 */

import {
  AI_ESTIMATE_DISPLAY_LABEL,
  AI_ESTIMATE_PROVENANCE_CLASS,
} from '../aiAdvancedEstimate';
import { buildAiEstimateSelection, type AiEstimateSelectionEvidence } from './aiEstimateSelection';
import { aiEstimateSnapshotBinding, deterministicMidpointGrams, type AiEstimateSnapshotInput } from './aiEstimateValidation';
import { workingChoiceFingerprint } from './aiMidFlight';
import { resolveEffectiveMassDecision } from '../calculation/effectiveMass';
import type { AiEstimateBoundedEvidence } from './aiEstimateValidation';
import type { AiEstimateChoice, Phase4State } from './types';

/** The literal label every estimate offer must display. */
export const AI_ESTIMATE_OFFER_LABEL = AI_ESTIMATE_DISPLAY_LABEL;

/**
 * A DISPLAY-ONLY estimate offer. It is not a choice, not a selection, and
 * carries nothing the calculator could consume: acceptance re-derives
 * everything from current state.
 */
export interface AiEstimateOffer {
  readonly line_ref: string;
  readonly label: typeof AI_ESTIMATE_OFFER_LABEL;
  readonly lower_grams: number;
  readonly upper_grams: number;
  /** The deterministic midpoint, re-derived here for display. */
  readonly representative_grams: number;
  readonly representative_policy: 'midpoint';
  /** Bounded advisory note from the model. Carries NO authority. */
  readonly notes?: string;
}

/** Formats the truthful one-line summary, e.g. `150–200 g · estimate uses 175 g`. */
export function formatAiEstimateOfferSummary(offer: AiEstimateOffer): string {
  return `${offer.lower_grams}\u2013${offer.upper_grams} g \u00b7 estimate uses ${offer.representative_grams} g`;
}

/**
 * Projects one validated reconcile entry into a display offer. Returns null for
 * anything that is not an offer, so a refused line can never render as one.
 */
export function buildAiEstimateOffer(
  entry: {
    readonly line_ref: string;
    readonly kind: string;
    readonly evidence?: AiEstimateBoundedEvidence;
    readonly detail?: string;
  },
  notes?: string
): AiEstimateOffer | null {
  if (entry.kind !== 'offer' || entry.evidence === undefined) return null;
  const evidence = entry.evidence;
  if (evidence.representative_policy !== 'midpoint') return null;
  if (evidence.provenance !== AI_ESTIMATE_PROVENANCE_CLASS) return null;
  const representative = deterministicMidpointGrams(evidence.lower_grams, evidence.upper_grams);
  return Object.freeze({
    line_ref: entry.line_ref,
    label: AI_ESTIMATE_OFFER_LABEL,
    lower_grams: evidence.lower_grams,
    upper_grams: evidence.upper_grams,
    representative_grams: representative,
    representative_policy: 'midpoint' as const,
    ...(notes !== undefined && notes.length > 0 && notes.length <= 300 ? { notes } : {}),
  });
}

/**
 * Derives the UI-level snapshot binding inputs for one line from the CURRENT
 * analyzed row and the CURRENT authenticated match. The card calls this once
 * when an offer is created and again at the second click; any difference in
 * the resulting binding means the offer is stale.
 *
 * The working-choice fingerprint separately covers every working-state
 * mutation, and the identity checks below cover the authenticated record, so
 * this binding is the semantic-input layer: the authored text, the chosen food
 * and the digests that bind them.
 */
export function buildAiEstimateUiSnapshot(
  lineRef: string,
  analyzed: { readonly original_text: string; readonly selected_fdc_id: number | undefined } | undefined,
  match:
    | { readonly fdc_id?: number; readonly record_digest?: string; readonly review_digest?: string }
    | undefined,
  identity: { readonly bundle_release?: string | null; readonly catalog_digest?: string | null; readonly recipe_key?: string | null } = {}
): AiEstimateSnapshotInput {
  return Object.freeze({
    lineRef,
    sourceText: analyzed?.original_text ?? '',
    amount: null,
    unit: null,
    countNoun: null,
    fdcId: match?.fdc_id ?? analyzed?.selected_fdc_id ?? 0,
    recordDigest: match?.record_digest ?? '',
    reviewDigest: match?.review_digest ?? '',
    bundleRelease: identity.bundle_release ?? null,
    catalogDigest: identity.catalog_digest ?? null,
    recipeKey: identity.recipe_key ?? null,
    sessionIdentity: null,
  });
}

export type AiEstimateAcceptRefusal =
  | 'line_missing'
  | 'identity_unresolved'
  | 'identity_changed'
  | 'stronger_source_present'
  | 'fingerprint_changed'
  | 'snapshot_changed'
  | 'offer_mismatch'
  | 'unbuildable_selection';

export type AiEstimateAcceptResult =
  | { readonly ok: true; readonly choice: AiEstimateChoice }
  | { readonly ok: false; readonly reason: AiEstimateAcceptRefusal };

export interface AiEstimateAcceptContext {
  /** The state as it is NOW, re-read at the moment of the second click. */
  readonly currentState: Phase4State;
  /** The working-choice fingerprint captured when the OFFER was created. */
  readonly offerFingerprint: string;
  /** The authenticated dry-run evidence for this line. */
  readonly evidence: AiEstimateSelectionEvidence | undefined;
  /** The local snapshot inputs re-read at the moment of the second click. */
  readonly snapshot: AiEstimateSnapshotInput;
  /** The snapshot binding captured when the OFFER was created. */
  readonly offerSnapshotBinding: string;
}

/**
 * The SECOND-CLICK gate. Every check below must hold, or the working state is
 * left untouched:
 *
 *   - the line still exists (a removed line is never recreated);
 *   - the food identity is still authenticated and unchanged;
 *   - the offer still describes this line's offered range;
 *   - no stronger mass source has appeared (user mass, USDA portion, count
 *     portion, household portion) -- if one has, the estimate LOSES;
 *   - the working-choice fingerprint is unchanged since the offer;
 *   - the snapshot binding is unchanged (text, parsed quantity, identity,
 *     record/review, bundle/catalog, recipe/session);
 *   - the Phase-3 selection can be built from current authenticated evidence.
 */
export function acceptAiEstimateOffer(
  offer: AiEstimateOffer,
  context: AiEstimateAcceptContext
): AiEstimateAcceptResult {
  const state = context.currentState;
  const lineRef = offer.line_ref;

  // 1. The line must still exist.
  if (!state.rows.some((row) => row.line_ref === lineRef)) {
    return { ok: false, reason: 'line_missing' };
  }

  // 2. The identity must still be authenticated.
  const match = state.matches[lineRef];
  if (match === undefined || typeof match.fdc_id !== 'number' || match.fdc_id <= 0) {
    return { ok: false, reason: 'identity_unresolved' };
  }

  // 3. The offer must still be the offer for this line's offered range.
  if (offer.representative_policy !== 'midpoint') return { ok: false, reason: 'offer_mismatch' };
  if (offer.representative_grams !== deterministicMidpointGrams(offer.lower_grams, offer.upper_grams)) {
    return { ok: false, reason: 'offer_mismatch' };
  }
  if (context.evidence === undefined) return { ok: false, reason: 'unbuildable_selection' };

  // 4. A stronger or user-explicit mass source WINS: the estimate loses.
  const authority = resolveEffectiveMassDecision({
    directMassGrams: undefined,
    hasUserMass: state.userMasses[lineRef] !== undefined,
    hasSourcePortion: state.portions[lineRef] !== undefined,
    hasCountPortion: state.countPortions[lineRef] !== undefined,
    hasHouseholdPortion: state.householdPortions?.[lineRef] !== undefined,
    hasAiEstimate: state.aiEstimates?.[lineRef] !== undefined,
  });
  if (authority.kind !== 'none' && authority.kind !== 'ai_estimate') {
    return { ok: false, reason: 'stronger_source_present' };
  }

  // 5. The working choice must be unchanged since the offer was created.
  if (workingChoiceFingerprint(state, lineRef) !== context.offerFingerprint) {
    return { ok: false, reason: 'fingerprint_changed' };
  }

  // 6. The identity binding the offer was derived from must be current.
  //    `MatchChoice` carries the chosen food (`fdc_id`) and the review digest;
  //    the record digest is bound by the Phase-3 selection sanitizer against the
  //    authenticated record, so it is deliberately not compared here.
  if (context.evidence.fdc_id !== match.fdc_id) {
    return { ok: false, reason: 'identity_changed' };
  }

  // 7. The snapshot binding must be unchanged since the offer was created.
  if (aiEstimateSnapshotBinding(context.snapshot) !== context.offerSnapshotBinding) {
    return { ok: false, reason: 'snapshot_changed' };
  }

  // 8. Build the Phase-3 selection from CURRENT authenticated evidence.
  const built = buildAiEstimateSelection(lineRef, context.evidence, {
    fdc_id: context.evidence.fdc_id,
    record_digest: context.evidence.record_digest,
    review_digest: match.review_digest,
    lower_grams: offer.lower_grams,
    upper_grams: offer.upper_grams,
    representative_grams: offer.representative_grams,
    representative_policy: 'midpoint',
    provenance: AI_ESTIMATE_PROVENANCE_CLASS,
    snapshot_binding: aiEstimateSnapshotBinding(context.snapshot),
  } as AiEstimateChoice);
  if (built.ok !== true) return { ok: false, reason: 'unbuildable_selection' };

  return {
    ok: true,
    choice: Object.freeze({
      fdc_id: context.evidence.fdc_id,
      record_digest: context.evidence.record_digest,
      review_digest: match.review_digest,
      lower_grams: offer.lower_grams,
      upper_grams: offer.upper_grams,
      representative_grams: offer.representative_grams,
      representative_policy: 'midpoint' as const,
      provenance: AI_ESTIMATE_PROVENANCE_CLASS,
      snapshot_binding: aiEstimateSnapshotBinding(context.snapshot),
      selection: built.selection,
    }),
  };
}
