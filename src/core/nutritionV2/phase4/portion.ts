/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: portion-choice construction.
 *
 * PURE, offline, display/review only. A source-portion selection must bind the
 * CURRENT ingredient identity digest, record digest, candidate-set digest, and
 * selected canonical portion. Phase 3 exposes the identity digest only through a
 * calculation result, so this helper performs a bounded dry run through the
 * genuine session to obtain it — it never duplicates Phase 3 digest logic and it
 * never persists a portion decision.
 */

import { CALCULATION_VERSION } from '../calculation/types';
import {
  phase4Failure,
  type AdvancedNutritionSession,
  type Phase4Failure,
  type PortionChoice,
} from './types';

export interface PortionChoiceParams {
  readonly lineRef: string;
  readonly ingredient: unknown;
  readonly review?: unknown;
  readonly selection?: unknown;
  readonly fdcId: number;
  readonly portionIndex: number;
}

export type PortionChoiceResult =
  | { ok: true; choice: PortionChoice }
  | { ok: false; failure: Phase4Failure };

/**
 * Builds a fully-bound portion choice for one matched ingredient. Fails closed
 * when the identity cannot be resolved, the portion is absent, or the canonical
 * source amount is legitimately missing (never invents an amount or a density).
 */
export function buildPortionChoice(
  session: AdvancedNutritionSession,
  params: PortionChoiceParams
): PortionChoiceResult {
  const dry = session.calculate({
    servings: 1,
    nutrient_scope: ['calories'],
    ingredients: [
      {
        line_ref: params.lineRef,
        ingredient: params.ingredient,
        ...(params.review !== undefined ? { review: params.review } : {}),
        ...(params.selection !== undefined ? { selection: params.selection } : {}),
      },
    ],
  });
  if (!dry.ok) return { ok: false, failure: phase4Failure('invalid_selection') };

  const evidence = dry.preview.ingredients.find((entry) => entry.line_ref === params.lineRef);
  if (!evidence || evidence.fdc_id === undefined || evidence.record_digest === undefined) {
    return { ok: false, failure: phase4Failure('invalid_selection') };
  }
  if (evidence.fdc_id !== params.fdcId) {
    return { ok: false, failure: phase4Failure('stale_binding') };
  }

  const portions = session.reviewPortions(params.fdcId);
  if (!portions.ok) return { ok: false, failure: phase4Failure('invalid_selection') };
  const candidate = portions.review.candidates.find((entry) => entry.index === params.portionIndex);
  if (!candidate) return { ok: false, failure: phase4Failure('invalid_selection') };
  if (candidate.amount === undefined || !(candidate.amount > 0)) {
    return { ok: false, failure: phase4Failure('not_available') };
  }

  const selection = {
    calculation_version: CALCULATION_VERSION,
    line_ref: params.lineRef,
    ingredient_identity_digest: evidence.ingredient_identity_digest,
    bundle_release: dry.preview.bundle_release,
    fdc_id: evidence.fdc_id,
    record_digest: evidence.record_digest,
    candidates_digest: portions.review.candidates_digest,
    portion_index: candidate.index,
    portion_amount: candidate.amount,
    measure: candidate.measure,
    gram_weight: candidate.gram_weight,
    ...(candidate.modifier !== undefined ? { modifier: candidate.modifier } : {}),
  };

  return {
    ok: true,
    choice: Object.freeze({
      fdc_id: evidence.fdc_id,
      portion_index: candidate.index,
      selection,
      review: portions.review,
    }),
  };
}
