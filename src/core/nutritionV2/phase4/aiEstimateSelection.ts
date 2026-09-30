/**
 * The Kitchen Codex — Advanced Nutrition: AI-3 estimate SELECTION builder.
 *
 * PURE. This is the ONE constructor for the Phase 3 `ai_estimate_selection`
 * passed to the calculator. It follows exactly the same evidence-derived
 * contract as `userMass`/`portion`/`countPortion`: the authenticated identity
 * and the ingredient identity digest are taken from a bounded DRY-RUN
 * calculation, never from the model and never from a caller assertion.
 *
 * The estimate contributes a MASS RANGE only. The grams the calculator uses are
 * re-derived there; nothing here can express a nutrient, an identity or a
 * portion.
 */

import { CALCULATION_VERSION } from '../calculation/types';
import type { AiEstimateSelection } from '../calculation/types';
import { validateAiEstimateForWorkingState } from './aiEstimateValidation';
import { deterministicMidpointGrams } from './aiEstimateValidation';
import type { AiEstimateChoice } from './types';

export interface AiEstimateSelectionEvidence {
  readonly line_ref: string;
  readonly fdc_id: number;
  readonly record_digest: string;
  readonly ingredient_identity_digest: string;
  readonly bundle_release: string;
}

export type AiEstimateSelectionBuild =
  | { readonly ok: true; readonly selection: AiEstimateSelection }
  | { readonly ok: false; readonly reason: 'stale_binding' | 'invalid_estimate' };

/**
 * Builds the calculator selection for an ACCEPTED estimate. The dry-run
 * evidence is the authority for the identity binding; the choice is the
 * authority for the range.
 */
export function buildAiEstimateSelection(
  lineRef: string,
  evidence: AiEstimateSelectionEvidence | undefined,
  choice: AiEstimateChoice | undefined
): AiEstimateSelectionBuild {
  if (evidence === undefined || choice === undefined) return { ok: false, reason: 'invalid_estimate' };
  // The evidence must be the dry run for THIS line.
  if (evidence.line_ref !== lineRef) return { ok: false, reason: 'stale_binding' };
  if (choice.fdc_id !== evidence.fdc_id) return { ok: false, reason: 'stale_binding' };
  if (choice.record_digest !== evidence.record_digest) return { ok: false, reason: 'stale_binding' };
  if (choice.representative_policy !== 'midpoint') return { ok: false, reason: 'invalid_estimate' };
  if (choice.provenance !== 'ai_estimate') return { ok: false, reason: 'invalid_estimate' };
  if (choice.representative_grams !== deterministicMidpointGrams(choice.lower_grams, choice.upper_grams)) {
    return { ok: false, reason: 'invalid_estimate' };
  }
  return {
    ok: true,
    selection: Object.freeze({
      calculation_version: CALCULATION_VERSION,
      line_ref: lineRef,
      ingredient_identity_digest: evidence.ingredient_identity_digest,
      bundle_release: evidence.bundle_release,
      fdc_id: evidence.fdc_id,
      record_digest: evidence.record_digest,
      lower_grams: choice.lower_grams,
      upper_grams: choice.upper_grams,
      representative_policy: 'midpoint' as const,
      provenance: 'ai_estimate' as const,
      snapshot_binding: choice.snapshot_binding,
    }),
  };
}

export { validateAiEstimateForWorkingState };
