/**
 * The Kitchen Codex — Advanced Nutrition: AI-3 centrally-owned numeric bounds.
 *
 * PURE and platform-neutral. It lives at the CORE root (not under `calculation/`
 * and not under `phase4/`) because BOTH the Phase 3 calculator and the Phase 4
 * eligibility/reconciliation layers must enforce the SAME estimate bounds, and
 * the Phase 1-3 / Phase 4 layering rule forbids either importing the other.
 *
 * ONE owner, ONE value: nothing else in the codebase may declare an estimate
 * range ratio.
 */

/**
 * The maximum ratio `upper_grams / lower_grams` a bounded AI mass estimate may
 * span. A wider model range is an admission of ignorance rather than an
 * estimate, so AI-3 REFUSES the line. It never clamps and never silently
 * narrows the range.
 */
export const MAX_AI_ESTIMATE_RANGE_RATIO = 4;
