/**
 * The Kitchen Codex — Advanced Nutrition Phase 0B: the ONE canonical
 * count-requirement / hint context for one working line.
 *
 * PURE, offline, display/review only. The bounded advisory count-identity hint
 * is interpretation-only working-state input: it is bound to the line's stored
 * authenticated count-portion choice and may only FILL a missing count unit/size
 * (never an amount, FDC id, gram weight, portion index, or digest). Every
 * consumer that shows or authenticates count-portion evidence — the modal's
 * candidate review, the live projection, the calculation request, and the
 * calculator's own re-derivation — must use the SAME hint for the same line and
 * working state, so the normalized requirement, candidate set, deterministic
 * order, candidate-set digest, and selected portion binding can never disagree.
 *
 * Fail-closed rules:
 *   - a malformed stored hint is ignored for display (no hint), never trusted;
 *   - binding verification of a stored count selection is owned by the
 *     calculation engine: the live projection verifies through a bounded
 *     per-line calculation dry-run, so display never claims a mass the
 *     calculator would reject as stale, forged, or cross-bound.
 */

import {
  sanitizeCountRequirementHint,
  type CountPortionReviewResult,
  type CountRequirementHint,
} from '../calculation/countPortion';
import type { AdvancedNutritionSession, Phase4State } from './types';

/**
 * The canonical bounded count-identity hint for one working line: the sanitized
 * hint bound to its stored count-portion choice, or undefined when the line has
 * no stored choice or the stored hint is not a valid closed-vocabulary hint.
 */
export function canonicalCountRequirementHint(
  state: Phase4State,
  lineRef: string
): CountRequirementHint | undefined {
  const choice = state.countPortions[lineRef];
  if (!choice || choice.countRequirementHint === undefined) return undefined;
  const sanitized = sanitizeCountRequirementHint(choice.countRequirementHint);
  return sanitized.ok ? sanitized.hint : undefined;
}

/**
 * Reviews the authenticated count portions for one line under its canonical
 * hint. This is the ONE candidate-review call for the working state; the modal,
 * the live projection, and the calculation request all flow through the same
 * hint. Binding verification of a stored selection is owned by the calculation
 * engine itself (the live projection verifies through a bounded per-line
 * calculation dry-run, so display and calculation can never disagree).
 */
export function reviewCanonicalLineCountPortions(
  session: AdvancedNutritionSession,
  state: Phase4State,
  lineRef: string,
  ingredient: unknown,
  fdcId: number
): CountPortionReviewResult {
  return session.reviewCountPortions(ingredient, fdcId, canonicalCountRequirementHint(state, lineRef));
}
