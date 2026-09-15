/**
 * The Kitchen Codex — calculation-free ingredient-text semantics.
 *
 * PURE, dependency-free. This module owns the ONE shared qualitative-cue
 * classifier used by both the legacy deterministic engine and the Advanced
 * Nutrition Phase 3 calculation engine, so there is a single implementation and
 * no drifting regex.
 *
 * IMPORTANT: a qualitative cue is NEVER sufficient on its own. A quantified /
 * material ingredient ("1 cup butter, as needed", "2 g salt to taste") must
 * never be demoted to qualitative just because a cue phrase appears. Callers
 * gate on the presence of an explicit measurable quantity.
 */

/** Recognized qualitative / as-needed cues (case-insensitive, word-bounded). */
export const QUALITATIVE_INGREDIENT_PATTERN =
  /\b(?:to taste|as needed|as required|as desired|to your liking|as you like|use as needed|enough)\b/i;

/**
 * True when the free-form ingredient text carries an explicit qualitative cue.
 * This is a pure text test; it does NOT decide qualitative-vs-material status
 * (the caller must also require the absence of an explicit measurable quantity).
 */
export function isQualitativeIngredientText(text: string): boolean {
  return QUALITATIVE_INGREDIENT_PATTERN.test(String(text));
}
