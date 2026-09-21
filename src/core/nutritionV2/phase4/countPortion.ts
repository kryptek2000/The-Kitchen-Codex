/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5E: count-portion choice.
 *
 * PURE, offline, display/review only. Builds a fully-bound authenticated
 * count-portion selection for one matched ingredient. It performs a bounded dry
 * run through the genuine session to obtain the ingredient identity digest, then
 * binds the canonical count-portion identity and a deterministic selection
 * digest. The calculator independently re-verifies the selection against the
 * authenticated record; a caller-supplied gram value is never trusted. Nothing is
 * persisted.
 */

import { CALCULATION_VERSION } from '../calculation/types';
import {
  COUNT_PORTION_VERSION,
  computeCountPortionSelectionDigest,
} from '../calculation/countPortion';
import {
  phase4Failure,
  type AdvancedNutritionSession,
  type CountPortionChoice,
  type Phase4Failure,
} from './types';

export interface CountPortionChoiceParams {
  readonly lineRef: string;
  readonly ingredient: unknown;
  readonly review?: unknown;
  readonly selection?: unknown;
  /** True when the bound match was an automatic analyzer selection. */
  readonly automaticSelection?: boolean;
  readonly fdcId: number;
  readonly portionIndex: number;
  /**
   * Bounded advisory count-identity hint (closed vocabulary) that FILLS a
   * missing unit/size of the recipe's own parsed count requirement. It is
   * carried into the identity-binding dry run so the candidate-set digest
   * matches the calculator's re-derivation. Never an amount or gram value.
   */
  readonly countRequirementHint?: { readonly unit: string | null; readonly size: string | null };
}

export type CountPortionChoiceResult =
  | { ok: true; choice: CountPortionChoice }
  | { ok: false; failure: Phase4Failure };

/**
 * Builds a fully-bound count-portion choice. Fails closed when the identity
 * cannot be resolved, the food mismatches, or the count portion is absent.
 */
export function buildCountPortionChoice(
  session: AdvancedNutritionSession,
  params: CountPortionChoiceParams
): CountPortionChoiceResult {
  const dry = session.calculate({
    servings: 1,
    nutrient_scope: ['calories'],
    ingredients: [
      {
        line_ref: params.lineRef,
        ingredient: params.ingredient,
        ...(params.review !== undefined ? { review: params.review } : {}),
        ...(params.selection !== undefined ? { selection: params.selection } : {}),
        ...(params.automaticSelection === true ? { automatic_selection: true } : {}),
        ...(params.countRequirementHint !== undefined
          ? { count_requirement_hint: params.countRequirementHint }
          : {}),
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

  const review = session.reviewCountPortions(
    params.ingredient,
    params.fdcId,
    params.countRequirementHint
  );
  if (!review.ok) return { ok: false, failure: phase4Failure('invalid_selection') };
  const candidate = review.review.candidates.find((entry) => entry.index === params.portionIndex);
  if (!candidate) return { ok: false, failure: phase4Failure('invalid_selection') };

  const base = {
    count_portion_version: COUNT_PORTION_VERSION,
    calculation_version: CALCULATION_VERSION,
    line_ref: params.lineRef,
    ingredient_identity_digest: evidence.ingredient_identity_digest,
    bundle_release: dry.preview.bundle_release,
    catalog_digest: dry.preview.catalog_digest,
    fdc_id: evidence.fdc_id,
    record_digest: evidence.record_digest,
    candidates_digest: review.review.candidates_digest,
    portion_index: candidate.index,
    portion_amount: candidate.amount,
    gram_weight: candidate.gram_weight,
    measure: candidate.measure,
    count_unit: candidate.unit,
    count_size: candidate.size,
  } as const;
  const selection = { ...base, selection_digest: computeCountPortionSelectionDigest(base) };

  return {
    ok: true,
    choice: Object.freeze({
      fdc_id: evidence.fdc_id,
      portion_index: candidate.index,
      selection,
      review: review.review,
    }),
  };
}
