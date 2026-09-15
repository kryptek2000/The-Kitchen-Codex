/**
 * The Kitchen Codex — Advanced Nutrition Phase 3: deterministic numeric policy.
 *
 * PURE. Rules:
 *   - full precision during contribution arithmetic;
 *   - reject NaN/Infinity/negatives/`-0`; no clipping; no fallback to zero;
 *   - detect overflow at every multiplication/division/summation;
 *   - round EXACTLY ONCE at the canonical total boundary;
 *   - at most six decimal places for canonical totals;
 *   - deterministic stable summation (caller supplies a canonical order).
 */

import { MAX_DECIMAL_PLACES, MAX_NUTRIENT_AMOUNT } from '../units';

/** Canonical totals are rounded once to this many decimal places. */
export const CANONICAL_TOTAL_DECIMAL_PLACES = MAX_DECIMAL_PLACES;

/** True for a finite, non-negative, non-`-0` number. */
export function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && value >= 0;
}

/** True for a finite, non-negative, non-`-0` number within the Phase 0 absolute bound. */
export function isWithinCanonicalBound(value: unknown): value is number {
  return isFiniteNonNegative(value) && value <= MAX_NUTRIENT_AMOUNT;
}

/**
 * Rounds a canonical total to six decimal places by evaluating the current
 * IEEE-754 binary number with `Math.round(value * 1_000_000) / 1_000_000`.
 *
 * ECMAScript `Math.round` selects the nearest integer and resolves an exact
 * represented half-integer toward positive infinity; because Phase 3 rejects
 * negatives, an exact represented non-negative half-integer rounds upward. This
 * is BINARY FLOATING-POINT arithmetic, not decimal arithmetic: a source value
 * that appears to be a conceptual decimal half may be represented slightly below
 * or above that tie, so no independent decimal half-away-from-zero guarantee is
 * claimed. The caller must have already established the value is finite and
 * non-negative. No clipping is performed.
 */
export function roundCanonicalTotal(value: number): number {
  const factor = 10 ** CANONICAL_TOTAL_DECIMAL_PLACES;
  return Math.round(value * factor) / factor;
}

/**
 * Stable, deterministic summation in the supplied order. Returns `undefined`
 * on a non-finite intermediate (overflow) instead of clamping to zero.
 */
export function stableSum(values: ReadonlyArray<number>): number | undefined {
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) return undefined;
    total += value;
    if (!Number.isFinite(total)) return undefined;
  }
  return total;
}

/**
 * Multiplies `amountPer100g × grams / 100` with overflow detection. Returns
 * `undefined` for any non-finite input/intermediate. No clipping.
 */
export function contributionFor(amountPer100g: number, grams: number): number | undefined {
  if (!Number.isFinite(amountPer100g) || !Number.isFinite(grams)) return undefined;
  const product = amountPer100g * grams;
  if (!Number.isFinite(product)) return undefined;
  const contribution = product / 100;
  if (!Number.isFinite(contribution)) return undefined;
  return contribution;
}
