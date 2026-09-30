/**
 * The Kitchen Codex — Advanced Nutrition: AI-3 preview-estimate detection.
 *
 * PURE. This is the ONE owner of the question "does the current working
 * preview depend on an AI mass estimate?" It exists so BOTH Apply layers can
 * ask the identical question:
 *
 *   Layer A (UX)   AdvancedNutritionCard apply eligibility shows the user WHY
 *                  Apply is unavailable and how to fix it.
 *   Layer B (safety) the application Apply coordinator refuses BEFORE it
 *                  authorizes or reaches the persistence writer.
 *
 * The predicate is deliberately based on the WORKING STATE store rather than on
 * a calculated preview: a preview is derived, the store is the user's own
 * accepted choice, and the store is available to both layers without widening
 * Phase 5 or teaching persistence about estimates.
 *
 * It never consults, imports or reveals anything from Phase 5.
 */

import type { Phase4State } from './types';

/** The user-facing explanation shown whenever Apply is blocked by an estimate. */
export const AI_ESTIMATE_APPLY_BLOCK_MESSAGE =
  'AI estimates are preview-only. Replace estimates with a confirmed amount before Apply.';

/** The closed failure code the application writer guard returns. */
export const AI_ESTIMATE_APPLY_BLOCK_CODE = 'ai_estimate_preview_only';

export interface ActiveAiEstimate {
  readonly lineRef: string;
  readonly lower_grams: number;
  readonly upper_grams: number;
  readonly representative_grams: number;
}

/**
 * True when at least one line in the current working state carries an accepted
 * AI mass estimate. The estimate store is optional, so a pre-AI-3 state reads
 * as "no estimate" without any caller change.
 */
export function hasActiveAiEstimateForPreview(state: Phase4State | null | undefined): boolean {
  if (state === null || state === undefined) return false;
  const store = state.aiEstimates as Readonly<Record<string, unknown>> | undefined;
  if (store === undefined || store === null) return false;
  for (const key of Object.keys(store)) {
    if (store[key] !== undefined && store[key] !== null) return true;
  }
  return false;
}

/**
 * The specific lines blocked by an estimate, with their bounded range, for
 * truthful display. Deterministic: lines are returned in sorted line_ref order.
 */
export function activeAiEstimatesForPreview(
  state: Phase4State | null | undefined
): ReadonlyArray<ActiveAiEstimate> {
  if (state === null || state === undefined) return [];
  const store = state.aiEstimates as
    | Readonly<Record<string, { lower_grams?: number; upper_grams?: number; representative_grams?: number }>>
    | undefined;
  if (store === undefined || store === null) return [];
  const out: ActiveAiEstimate[] = [];
  for (const lineRef of Object.keys(store).sort()) {
    const choice = store[lineRef];
    if (choice === undefined || choice === null) continue;
    out.push({
      lineRef,
      lower_grams: Number(choice.lower_grams),
      upper_grams: Number(choice.upper_grams),
      representative_grams: Number(choice.representative_grams),
    });
  }
  return out;
}
