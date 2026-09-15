/**
 * The Kitchen Codex — pure serving-math formulas (calculation-free).
 *
 * ONE source of the entire-recipe -> per-serving -> requested-serving formulas,
 * so they cannot drift between the legacy serving utility and the Advanced
 * Nutrition Phase 3 calculation engine:
 *
 *   perServing        = total / baseServings
 *   requestedServing  = perServing × requestedServings
 *
 * These functions perform NO coercion, NO clamping, and NO rounding. Callers own
 * input validation and their own rounding boundary. The legacy
 * `src/utils/nutrition.ts` coerces its inputs first (preserving its historical
 * behavior) and then uses `servingFactor`; Phase 3 validates strictly and uses
 * the strict primitives directly.
 */

/** requested / base. Caller must supply finite positive values. */
export function servingFactor(baseServings: number, requestedServings: number): number {
  return requestedServings / baseServings;
}

/** total / baseServings. */
export function perServingAmount(total: number, baseServings: number): number {
  return total / baseServings;
}

/** (total / baseServings) × requestedServings, derived from the same per-serving step. */
export function requestedServingAmount(
  total: number,
  baseServings: number,
  requestedServings: number
): number {
  return perServingAmount(total, baseServings) * requestedServings;
}
