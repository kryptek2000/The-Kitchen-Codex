/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5C: explicit total-weight fallback.
 *
 * PURE, offline, display/review only. Builds a fully-bound `user_mass` selection
 * from an explicit user-entered total weight (g / oz / lb). It performs a bounded
 * dry run through the genuine session to obtain the ingredient identity digest,
 * then binds the recomputed gram value and a deterministic selection digest. The
 * calculator independently recomputes the conversion; a caller-supplied gram
 * value is never trusted. Nothing is persisted.
 */

import { CALCULATION_VERSION } from '../calculation/types';
import { computeUserMassSelectionDigest } from '../calculation/mass';
import { convertMassToGrams, type NormalizedUnit } from '../../../utils/measurements';
import {
  phase4Failure,
  type AdvancedNutritionSession,
  type Phase4Failure,
  type UserMassChoice,
} from './types';

export interface UserMassChoiceParams {
  readonly lineRef: string;
  readonly ingredient: unknown;
  readonly review?: unknown;
  readonly selection?: unknown;
  /** True when the bound match was an automatic analyzer selection. */
  readonly automaticSelection?: boolean;
  readonly fdcId: number;
  readonly quantity: number;
  readonly unit: 'g' | 'oz' | 'lb';
}

export type UserMassChoiceResult =
  | { ok: true; choice: UserMassChoice }
  | { ok: false; failure: Phase4Failure };

const ALLOWED_UNITS: ReadonlySet<string> = new Set(['g', 'oz', 'lb']);

/**
 * Builds a fully-bound user-mass choice. Fails closed on an invalid quantity/unit,
 * an unresolved ingredient identity, or a food mismatch.
 */
export function buildUserMassChoice(
  session: AdvancedNutritionSession,
  params: UserMassChoiceParams
): UserMassChoiceResult {
  if (
    typeof params.quantity !== 'number' ||
    !Number.isFinite(params.quantity) ||
    params.quantity <= 0 ||
    Object.is(params.quantity, -0) ||
    !ALLOWED_UNITS.has(params.unit)
  ) {
    return { ok: false, failure: phase4Failure('invalid_selection') };
  }
  const grams = convertMassToGrams(params.quantity, params.unit as NormalizedUnit);
  if (grams === undefined || !Number.isFinite(grams) || grams <= 0 || Object.is(grams, -0)) {
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

  const base = {
    calculation_version: CALCULATION_VERSION,
    line_ref: params.lineRef,
    ingredient_identity_digest: evidence.ingredient_identity_digest,
    bundle_release: dry.preview.bundle_release,
    fdc_id: evidence.fdc_id,
    record_digest: evidence.record_digest,
    quantity: params.quantity,
    unit: params.unit,
    grams,
  } as const;
  const selection = { ...base, selection_digest: computeUserMassSelectionDigest(base) };

  return {
    ok: true,
    choice: Object.freeze({
      fdc_id: evidence.fdc_id,
      quantity: params.quantity,
      unit: params.unit,
      selection,
    }),
  };
}
