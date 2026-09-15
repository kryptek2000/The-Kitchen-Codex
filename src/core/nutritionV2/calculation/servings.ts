/**
 * The Kitchen Codex — Advanced Nutrition Phase 3: strict serving math.
 *
 * PURE. The authoritative baseline is ALWAYS the entire-recipe total
 * (`basis: 'total'`); per-serving and requested-serving values are DERIVED,
 * never persisted, and always derived from the same immutable total baseline so
 * toggling views cannot drift.
 *
 * Strict validation (NO legacy coercion): a serving count must be a number,
 * finite, positive, not `-0`, `<= 1000`, and within the bounded decimal
 * precision. Strings such as `"4"` are rejected, never coerced.
 */

import { decimalPlaces } from '../units';
import { perServingAmount, requestedServingAmount } from '../../../utils/servingMath';
import {
  MAX_CALCULATION_SERVINGS,
  MAX_CALCULATION_SERVING_DECIMAL_PLACES,
} from './types';

/** Strict serving-count validation for authoritative Phase 3 inputs. */
export function isValidStrictServingCount(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (Object.is(value, -0)) return false;
  if (value <= 0 || value > MAX_CALCULATION_SERVINGS) return false;
  if (decimalPlaces(value) > MAX_CALCULATION_SERVING_DECIMAL_PLACES) return false;
  return true;
}

/** Derived per-serving amount (total / baseServings). No rounding. */
export function derivePerServing(total: number, baseServings: number): number {
  return perServingAmount(total, baseServings);
}

/**
 * Derived requested-serving amount (total × requested / base). No rounding.
 * Derived from the same per-serving step as `derivePerServing`.
 */
export function deriveRequestedServing(
  total: number,
  baseServings: number,
  requestedServings: number
): number {
  return requestedServingAmount(total, baseServings, requestedServings);
}
