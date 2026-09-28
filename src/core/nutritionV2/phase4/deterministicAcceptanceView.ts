/**
 * The Kitchen Codex — Advanced Nutrition Phase 4 (AI-2C): deterministic
 * acceptance view.
 *
 * PURE, offline, read-only. This is the ONE Phase-4 boundary port that AI-2A
 * explicitly reserves for AI-2C (see the port contract in
 * `aiAdvancedPlanApply.ts`): it reports what the EXISTING deterministic
 * confidence contract already decided for one review, so the frozen AI-2A
 * classifier can name the authority AI is allowed to spend.
 *
 * WHAT IT MAY DO
 * --------------
 *   - reuse the existing Phase 2 predicates verbatim:
 *       `selectAutomaticMatch`            (the STRICT automatic branch)
 *       `bestEffortDefaultCandidates`     (the full eligible family)
 *     and report their decisions.
 *
 * WHAT IT MAY NEVER DO
 * --------------------
 *   - invent a threshold, a ranking, a score or a new candidate order;
 *   - grant authority: a missing/empty report can only COST a label, never
 *     create one (`automatic` requires `strict_automatic_fdc_id` to equal the
 *     candidate the plan resolved locally);
 *   - mutate anything: no state, no storage, no network, no persistence;
 *   - import Phase 2 anywhere except this approved Phase-4 boundary file.
 *
 * FIELD SEMANTICS (deliberate, so the report can never overstate the truth)
 * -----------------------------------------------------------------------
 *   `strict_automatic_fdc_id`    the STRICT automatic choice, when one exists.
 *   `best_effort_default_fdc_id` the best-effort same-family DEFAULT. Taken from
 *                                the eligible family (`bestEffortDefaultCandidates`)
 *                                rather than from `selectBestEffortMatch`, because
 *                                `selectBestEffortMatch` echoes the STRICT choice
 *                                when one exists, which would break the invariant
 *                                that this field is always a member of the family
 *                                below. It is informational telemetry only: the
 *                                family, never this field, drives the label.
 *   `best_effort_eligible_fdc_ids` the FULL eligible family — every candidate the
 *                                existing `isDeterministicBestEffortSelection`
 *                                accepts (membership, not default equality).
 *
 * This module is reachable only from the Phase-4 review boundary; the documented
 * matching-isolation rule (`tests/security/usdaMatchingIsolation.test.ts`) allows
 * `matching/*` for `src/core/nutritionV2/phase4/` and nowhere else.
 */

import type { AiAdvancedDeterministicAcceptance } from '../aiAdvancedPlanApply';
import {
  bestEffortDefaultCandidates,
  selectAutomaticMatch,
} from '../matching/confidence';

/** Longest bounded description of a review this port is willing to inspect. */
const MAX_CANDIDATES = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Structural usability guard. A value that does not look like a Phase 2 review
 * is NOT inspected: the port reports nothing, which can only remove authority.
 */
function asUsableReview(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value['outcome'] !== 'matched_exact' && value['outcome'] !== 'review_required') return undefined;
  if (!Array.isArray(value['candidates'])) return undefined;
  if ((value['candidates'] as ReadonlyArray<unknown>).length > MAX_CANDIDATES) return undefined;
  if (typeof value['normalized_query'] !== 'string') return undefined;
  return value;
}

/**
 * Reports the EXISTING deterministic decisions for one review. Returns
 * `undefined` when the review is unusable, which the AI-2A classifier treats as
 * "no port, no automatic".
 */
export function deterministicAcceptanceView(
  review: unknown
): AiAdvancedDeterministicAcceptance | undefined {
  try {
    const usable = asUsableReview(review);
    if (usable === undefined) return undefined;

    const strict = selectAutomaticMatch(usable as never);
    const family = bestEffortDefaultCandidates(usable as never);
    const familyIds: number[] = [];
    for (const candidate of family) {
      const fdcId = (candidate as { fdc_id?: unknown }).fdc_id;
      if (typeof fdcId === 'number' && Number.isSafeInteger(fdcId) && !familyIds.includes(fdcId)) {
        familyIds.push(fdcId);
      }
    }

    const view: {
      strict_automatic_fdc_id?: number;
      best_effort_default_fdc_id?: number;
      best_effort_eligible_fdc_ids?: readonly number[];
    } = {};

    const strictId = (strict as { fdc_id?: unknown } | undefined)?.fdc_id;
    if (typeof strictId === 'number' && Number.isSafeInteger(strictId)) {
      view.strict_automatic_fdc_id = strictId;
    }
    // INVARIANT: the default is always a member of the family (or omitted).
    if (familyIds.length > 0) {
      view.best_effort_default_fdc_id = familyIds[0];
      view.best_effort_eligible_fdc_ids = Object.freeze(familyIds);
    }

    return Object.freeze(view);
  } catch {
    // Never throw at a trust boundary: an unusable review yields no authority.
    return undefined;
  }
}
