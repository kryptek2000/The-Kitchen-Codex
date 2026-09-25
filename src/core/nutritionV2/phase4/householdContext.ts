/**
 * The Kitchen Codex — Advanced Nutrition Phase 7: the ONE canonical
 * household-requirement / hint context for one working line.
 *
 * PURE, offline, display/review only. The bounded advisory household hint
 * (closed unit/size/state vocabulary) is interpretation-only working-state
 * input: it is bound to the line's stored verified household choice and may
 * only FILL a missing unit/size/state (never a quantity, FDC id, gram weight,
 * registry record, or digest). Every consumer that shows or authenticates
 * household evidence — the live projection, the calculation request, and the
 * calculator's own re-derivation — must use the SAME hint for the same line and
 * working state, so the exact-key lookup, resolved grams, and selection digest
 * can never disagree.
 *
 * Fail-closed rules:
 *   - a malformed stored hint is ignored for display (no hint), never trusted;
 *   - binding verification of a stored household selection is owned by the
 *     calculation engine: the live projection verifies through a bounded
 *     per-line calculation dry-run, so display never claims a mass the
 *     calculator would reject as stale, forged, or cross-bound.
 */

import {
  canonicalHouseholdState,
  sanitizeHouseholdRequirementHint,
  type HouseholdRequirementHint,
} from '../calculation/householdPortion';
import type { Phase4State } from './types';

/**
 * The canonical bounded household hint for one working line: the sanitized hint
 * bound to its stored household-portion choice, or undefined when the line has
 * no stored choice or the stored hint is not a valid closed-vocabulary hint.
 */
export function canonicalHouseholdRequirementHint(
  state: Phase4State,
  lineRef: string
): HouseholdRequirementHint | undefined {
  const choice = state.householdPortions?.[lineRef];
  if (!choice || choice.householdRequirementHint === undefined) return undefined;
  const sanitized = sanitizeHouseholdRequirementHint(choice.householdRequirementHint);
  return sanitized.ok ? sanitized.hint : undefined;
}

/** Re-exported closed state canonicalizer (used by the AI hint adapter/tests). */
export { canonicalHouseholdState };
