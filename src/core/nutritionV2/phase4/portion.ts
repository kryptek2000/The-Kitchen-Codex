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
import { candidatePortionCompatibility, PORTION_SEMANTICS_VERSION } from '../calculation/portionSemantics';
import { normalizeQuery } from '../matching/normalize';
import { projectQueryText } from '../matching/query';
import { hasDirectRecipeMass } from './rows';
import {
  phase4Failure,
  type AdvancedNutritionSession,
  type Phase4Failure,
  type PortionChoice,
} from './types';

/**
 * Deterministic automatic volume-portion resolution. Returns the lowest-index
 * compatible authenticated source portion ONLY when every compatible portion
 * resolves to the SAME authoritative mass for the ingredient's measurement.
 * Differing authoritative gram weights are ambiguous and are NOT auto-chosen.
 * Never averages, never guesses a density, never invents a conversion.
 *
 * Shared by the one-click deterministic analyzer and the AI-assisted identity
 * path: when AI supplies a deterministic-accepted food for a volume line, the
 * SAME authenticated portion rule may finish the mass instead of forcing a
 * second per-ingredient choice. It binds no nutrition value itself.
 */
export function selectDeterministicVolumePortionIndex(
  session: AdvancedNutritionSession,
  fdcId: number,
  milliliters: number | undefined,
  requestedUnit: string | undefined,
  queryText: string
): number | undefined {
  if (typeof milliliters !== 'number' || !Number.isFinite(milliliters) || milliliters <= 0) {
    return undefined;
  }
  const review = session.reviewPortions(fdcId);
  if (!review.ok) return undefined;
  const compatible = review.review.candidates.filter(
    (candidate) => candidatePortionCompatibility(candidate, 'volume') === 'compatible'
  );
  if (compatible.length === 0) return undefined;

  const resolvedGrams = (candidate: (typeof compatible)[number]): number | undefined => {
    if (
      candidate.volume_ml === null ||
      !Number.isFinite(candidate.volume_ml) ||
      candidate.volume_ml <= 0 ||
      !(candidate.gram_weight > 0)
    ) {
      return undefined;
    }
    const grams = (milliliters / candidate.volume_ml) * candidate.gram_weight;
    if (!Number.isFinite(grams) || grams <= 0 || Object.is(grams, -0)) return undefined;
    return grams;
  };

  const allEquivalent = (candidates: ReadonlyArray<(typeof compatible)[number]>): boolean => {
    const values: number[] = [];
    for (const candidate of candidates) {
      const grams = resolvedGrams(candidate);
      if (grams === undefined) return false;
      values.push(grams);
    }
    const first = values[0];
    return values.every((value) => Math.abs(value - first) <= 1e-9 * Math.max(1, Math.abs(first)));
  };

  // 1. Prefer the exact requested unit identity.
  if (requestedUnit) {
    const exactUnit = compatible.filter((candidate) => candidate.unit === requestedUnit);
    if (exactUnit.length === 1) return exactUnit[0].index;
    if (exactUnit.length > 1) {
      // 1a. Narrow by a requested preparation/qualifier descriptor
      //     (e.g. `tsp, ground` for `ground black pepper`).
      const projection = projectQueryText(normalizeQuery(queryText).text);
      const descriptorTokens = new Set([
        ...projection.preparation_qualifiers,
        ...projection.qualifier_tokens,
      ]);
      const descriptorMatches = exactUnit.filter(
        (candidate) => candidate.descriptor !== null && descriptorTokens.has(candidate.descriptor)
      );
      if (descriptorMatches.length === 1) return descriptorMatches[0].index;
      // Bounded default for measured spices: when the query did not request a
      // preparation and exactly one exact-unit portion is the `ground` form, the
      // ground form is the ordinary measured seasoning (e.g. `1/2 tsp black
      // pepper` -> `1 tsp, ground`). This is deterministic, not arbitrary.
      if (descriptorMatches.length === 0) {
        const groundMatches = exactUnit.filter((candidate) => candidate.descriptor === 'ground');
        if (groundMatches.length === 1) return groundMatches[0].index;
      }
      const pool = descriptorMatches.length > 0 ? descriptorMatches : exactUnit;
      if (allEquivalent(pool)) return pool[0].index;
      return undefined;
    }
  }

  // 2. Otherwise, only a provably equivalent compatible set is auto-chosen.
  if (allEquivalent(compatible)) return compatible[0].index;
  return undefined;
}

export interface PortionChoiceParams {
  readonly lineRef: string;
  readonly ingredient: unknown;
  readonly review?: unknown;
  readonly selection?: unknown;
  /**
   * True when the bound match was an automatic analyzer selection. It must be
   * carried into the identity-binding dry run so the portion's identity digest
   * matches the `auto_confirmed` calculation.
   */
  readonly automaticSelection?: boolean;
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
  // The ONE shared direct-mass creation gate: a line that already declares its
  // own recipe mass has complete mass authority, so no source-portion choice
  // is ever created for it (the effective-mass decision fails any conflicting
  // state closed instead of silently ignoring the choice).
  if (hasDirectRecipeMass(params.ingredient)) {
    return { ok: false, failure: phase4Failure('invalid_selection') };
  }
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
  if (
    candidate.kind === 'unusable' ||
    candidate.effective_amount === null ||
    !(candidate.effective_amount > 0) ||
    !(candidate.gram_weight > 0)
  ) {
    return { ok: false, failure: phase4Failure('not_available') };
  }

  const selection = {
    calculation_version: CALCULATION_VERSION,
    portion_semantics_version: PORTION_SEMANTICS_VERSION,
    line_ref: params.lineRef,
    ingredient_identity_digest: evidence.ingredient_identity_digest,
    bundle_release: dry.preview.bundle_release,
    fdc_id: evidence.fdc_id,
    record_digest: evidence.record_digest,
    candidates_digest: portions.review.candidates_digest,
    portion_index: candidate.index,
    portion_amount: candidate.effective_amount,
    measure: candidate.measure,
    gram_weight: candidate.gram_weight,
    ...(candidate.modifier !== undefined ? { modifier: candidate.modifier } : {}),
    semantics_kind: candidate.kind,
    semantics_unit: candidate.unit,
    semantics_volume_ml: candidate.volume_ml,
    semantics_amount: candidate.effective_amount,
    semantics_gram_weight: candidate.gram_weight,
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
