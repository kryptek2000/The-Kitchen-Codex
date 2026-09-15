/**
 * The Kitchen Codex — Advanced Nutrition v1: canonical units & numeric bounds.
 *
 * PURE, platform-neutral. No DOM, no Node builtins, no network, no vault.
 *
 * CANONICAL UNITS (closed registry)
 * --------------------------------
 * Every stored nutrient amount is expressed in ONE of the canonical units
 * below. Form-qualified units (`ug_rae`, `mg_ne`, `ug_dfe`) are intentionally
 * NOT convertible to plain mass units: retinol activity equivalents, niacin
 * equivalents, and dietary folate equivalents are nutrient-specific expressions
 * and must never be silently collapsed into grams/milligrams/micrograms.
 *
 * ASCII-safe identifiers are stored (`ug`); the UI may later render `µg`.
 */

export type CanonicalUnit = 'kcal' | 'g' | 'mg' | 'ug' | 'ug_rae' | 'mg_ne' | 'ug_dfe';

/** Base unit for a dimension (mass base = g; energy base = kcal). */
export interface UnitDefinition {
  readonly unit: CanonicalUnit;
  readonly dimension: 'mass' | 'energy' | 'mass_rae' | 'mass_ne' | 'mass_dfe';
  /** Multiplier to the dimension base unit. Non-convertible forms use 1. */
  readonly toBase: number;
  /** True only for plain metric mass units (`g`/`mg`/`ug`). */
  readonly convertible: boolean;
}

export const CANONICAL_UNITS: Readonly<Record<CanonicalUnit, UnitDefinition>> = Object.freeze({
  kcal: { unit: 'kcal', dimension: 'energy', toBase: 1, convertible: false },
  g: { unit: 'g', dimension: 'mass', toBase: 1, convertible: true },
  mg: { unit: 'mg', dimension: 'mass', toBase: 0.001, convertible: true },
  ug: { unit: 'ug', dimension: 'mass', toBase: 0.000001, convertible: true },
  ug_rae: { unit: 'ug_rae', dimension: 'mass_rae', toBase: 1, convertible: false },
  mg_ne: { unit: 'mg_ne', dimension: 'mass_ne', toBase: 1, convertible: false },
  ug_dfe: { unit: 'ug_dfe', dimension: 'mass_dfe', toBase: 1, convertible: false },
});

/** Upper bound for any single stored nutrient amount (bounded, no clipping). */
export const MAX_NUTRIENT_AMOUNT = 1_000_000_000;
/** Maximum decimal places allowed on a stored nutrient amount. */
export const MAX_DECIMAL_PLACES = 6;
/** Exact energy equivalence used ONLY by `convertEnergy` (1 kcal = 4.184 kJ). */
export const KJ_PER_KCAL = 4.184;

export function isCanonicalUnit(value: unknown): value is CanonicalUnit {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CANONICAL_UNITS, value);
}

/**
 * Negative zero (`-0`) is rejected explicitly in every authoritative numeric
 * position. It is never silently normalized to positive zero.
 */
export function isNegativeZero(value: unknown): boolean {
  return typeof value === 'number' && Object.is(value, -0);
}

/** Decimal places of a finite number (0 for integers). Infinity for non-finite. */
export function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return Infinity;
  const text = String(value);
  const exponentMatch = /^[+-]?\d+(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (exponentMatch) {
    const fractionDigits = exponentMatch[1]?.length ?? 0;
    const exponent = Number.parseInt(exponentMatch[2], 10);
    const places = fractionDigits - exponent;
    return places > 0 ? places : 0;
  }
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * A defensible stored nutrient amount: a finite, non-negative number within the
 * absolute bound and within the decimal-precision bound. Rejects NaN, Infinity,
 * negatives, unsafe/oversized values, and over-precise values (no clipping).
 */
export function isValidNutrientAmount(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (isNegativeZero(value)) return false;
  if (value < 0 || value > MAX_NUTRIENT_AMOUNT) return false;
  if (!Number.isSafeInteger(Math.round(value)) && value > Number.MAX_SAFE_INTEGER) return false;
  if (decimalPlaces(value) > MAX_DECIMAL_PLACES) return false;
  return true;
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Deterministic conversion between PLAIN metric mass units only
 * (`g` <-> `mg` <-> `ug`). Same-unit identity is allowed for every canonical
 * unit. Form-qualified units (`ug_rae`, `mg_ne`, `ug_dfe`) and cross-dimension
 * requests are rejected — never an implicit or invented conversion.
 */
export function convertUnit(amount: number, from: CanonicalUnit, to: CanonicalUnit): number {
  if (!isCanonicalUnit(from) || !isCanonicalUnit(to)) {
    throw new Error('convertUnit: unknown canonical unit.');
  }
  if (!Number.isFinite(amount) || amount < 0 || isNegativeZero(amount)) {
    throw new Error('convertUnit: amount must be a finite non-negative number.');
  }
  if (from === to) return amount;
  const source = CANONICAL_UNITS[from];
  const target = CANONICAL_UNITS[to];
  if (!source.convertible || !target.convertible || source.dimension !== target.dimension) {
    throw new Error(`convertUnit: ${from} -> ${to} is not a supported metric mass conversion.`);
  }
  return roundTo((amount * source.toBase) / target.toBase, 9);
}

/**
 * Explicit, tested energy conversion between `kcal` and `kj` using the exact
 * thermochemical equivalence 1 kcal = 4.184 kJ. No other energy unit is
 * supported, and this is never applied implicitly.
 */
export function convertEnergy(amount: number, from: 'kcal' | 'kj', to: 'kcal' | 'kj'): number {
  if (!Number.isFinite(amount) || amount < 0 || isNegativeZero(amount)) {
    throw new Error('convertEnergy: amount must be a finite non-negative number.');
  }
  if (from !== 'kcal' && from !== 'kj') throw new Error('convertEnergy: unknown source unit.');
  if (to !== 'kcal' && to !== 'kj') throw new Error('convertEnergy: unknown target unit.');
  if (from === to) return amount;
  return from === 'kcal' ? roundTo(amount * KJ_PER_KCAL, 9) : roundTo(amount / KJ_PER_KCAL, 9);
}
