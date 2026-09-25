/**
 * The Kitchen Codex — Advanced Nutrition Phase 6: household-portion choice.
 *
 * PURE, offline, display/review only. Builds a fully-bound verified household
 * selection for one matched ingredient. It performs a bounded dry run through
 * the genuine session to obtain the ingredient identity digest, resolves the
 * household conversion from the authenticated Phase 5 registry, and binds a
 * deterministic selection digest. A caller-supplied gram value is never trusted:
 * the calculator independently re-derives and re-verifies the selection. Nothing
 * is persisted until the user explicitly Applies.
 */

import {
  buildHouseholdPortionSelection,
  resolveHouseholdPortion,
  sanitizeHouseholdRequirementHint,
  type HouseholdRequirementHint,
} from '../calculation/householdPortion';
import { CALCULATION_VERSION } from '../calculation/types';
import { hasDirectRecipeMass, hasDirectRecipeVolume } from './rows';
import {
  phase4Failure,
  type AdvancedNutritionSession,
  type HouseholdPortionChoice,
  type Phase4Failure,
} from './types';

export interface HouseholdPortionChoiceParams {
  readonly lineRef: string;
  readonly ingredient: unknown;
  readonly review?: unknown;
  readonly selection?: unknown;
  /** True when the bound match was an automatic analyzer selection. */
  readonly automaticSelection?: boolean;
  readonly fdcId: number;
  /**
   * Optional bounded interpretation-only hint (untrusted). It is sanitized here
   * against the closed vocabularies and may only fill a source-missing
   * unit/size/state; a malformed hint fails closed (no choice).
   */
  readonly householdRequirementHint?: unknown;
}

export type HouseholdPortionChoiceResult =
  | { ok: true; choice: HouseholdPortionChoice }
  | { ok: false; failure: Phase4Failure };

/**
 * Builds a fully-bound verified household-portion choice. Fails closed when the
 * line declares its own direct mass, the identity cannot be resolved, the food
 * mismatches, the household record is absent, or the calculator rejects the
 * freshly built selection.
 */
export function buildHouseholdPortionChoice(
  session: AdvancedNutritionSession,
  params: HouseholdPortionChoiceParams
): HouseholdPortionChoiceResult {
  // The ONE shared direct-mass/direct-volume creation gate: a line that already
  // declares its own recipe mass has complete mass authority, and a line that
  // declares a direct volume is resolved through its own canonical USDA
  // source-portion path. Neither is ever a household count, so no household
  // choice is created for them (the effective-mass decision fails any
  // conflicting state closed instead of silently ignoring the choice).
  if (hasDirectRecipeMass(params.ingredient) || hasDirectRecipeVolume(params.ingredient)) {
    return { ok: false, failure: phase4Failure('invalid_selection') };
  }
  // The optional bounded hint is validated ONCE here (defense in depth): a
  // malformed/forged hint yields NO choice rather than a partially trusted one.
  const hintResult = sanitizeHouseholdRequirementHint(params.householdRequirementHint);
  if (!hintResult.ok) return { ok: false, failure: phase4Failure('invalid_selection') };
  const householdRequirementHint: HouseholdRequirementHint | undefined = hintResult.hint;
  // Identity-binding dry run (no household selection): yields the canonical
  // ingredient identity digest + the authenticated USDA record binding.
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

  const resolution = resolveHouseholdPortion({
    ingredient: params.ingredient,
    fdcId: evidence.fdc_id,
    usdaRecordDigest: evidence.record_digest,
    bundleRelease: dry.preview.bundle_release,
    ...(householdRequirementHint !== undefined ? { hint: householdRequirementHint } : {}),
  });
  if (!resolution) return { ok: false, failure: phase4Failure('invalid_selection') };

  const selection = buildHouseholdPortionSelection({
    calculationVersion: CALCULATION_VERSION,
    lineRef: params.lineRef,
    ingredientIdentityDigest: evidence.ingredient_identity_digest,
    bundleRelease: dry.preview.bundle_release,
    resolution,
  });
  if (!selection) return { ok: false, failure: phase4Failure('invalid_selection') };

  // FULL-BINDING VERIFICATION: the choice is accepted only when the genuine
  // calculator independently accepts the very selection being stored. This
  // guarantees the working state can never hold a household choice the
  // calculator would reject.
  const verified = session.calculate({
    servings: 1,
    nutrient_scope: ['calories'],
    ingredients: [
      {
        line_ref: params.lineRef,
        ingredient: params.ingredient,
        ...(params.review !== undefined ? { review: params.review } : {}),
        ...(params.selection !== undefined ? { selection: params.selection } : {}),
        ...(params.automaticSelection === true ? { automatic_selection: true } : {}),
        household_portion_selection: selection,
        ...(householdRequirementHint !== undefined
          ? { household_requirement_hint: householdRequirementHint }
          : {}),
      },
    ],
  });
  if (!verified.ok) return { ok: false, failure: phase4Failure('invalid_selection') };
  const verifiedEvidence = verified.preview.ingredients.find(
    (entry) => entry.line_ref === params.lineRef
  );
  if (
    !verifiedEvidence ||
    verifiedEvidence.mass_source !== 'household_portion' ||
    verifiedEvidence.resolved_grams !== resolution.resolved_grams
  ) {
    return { ok: false, failure: phase4Failure('invalid_selection') };
  }

  return {
    ok: true,
    choice: Object.freeze({
      fdc_id: evidence.fdc_id,
      record_key: resolution.household_record_key,
      authority_class: resolution.authority_class,
      resolved_grams: resolution.resolved_grams,
      selection,
      automatic: params.automaticSelection === true,
      ...(householdRequirementHint !== undefined
        ? { householdRequirementHint }
        : {}),
    }),
  };
}
