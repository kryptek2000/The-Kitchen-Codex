/**
 * The Kitchen Codex — Deterministic Unit & Measurement Normalization
 *
 * A dependency-free, pure, client/server-reusable measurement layer.
 *
 * It correctly distinguishes the three semantically distinct measurement
 * classes and performs ONLY mathematically valid conversions:
 *
 *   - mass   : g <-> kg <-> oz <-> lb   (deterministic, no ingredient needed)
 *   - volume : ml <-> l <-> tsp <-> tbsp <-> cup <-> fl oz (deterministic, no
 *              ingredient needed; valid for anything measureable by volume)
 *   - count  : countable nouns (egg, clove, slice, piece, can, package, stick).
 *              NEVER converted to grams here — that is density/count-weight
 *              metadata and belongs to the future food-reference layer.
 *   - unknown: unmeasured / "to taste" / as-needed / unrecognized units.
 *
 * This module does NOT invent ingredient-specific densities. `1 cup flour` and
 * `1 cup sugar` both resolve to the SAME deterministically-known milliliters;
 * both grams remain `undefined` because mass requires food identity.
 */

import { parseFraction } from '../schema/recipeValidator';

/** Measurement classification. */
export type MeasurementKind = 'mass' | 'volume' | 'count' | 'unknown';

/**
 * Canonical normalized unit identifier. Mass/volume spellings align with the
 * existing `KNOWN_UNITS` canonical conventions; count-nouns collapse to
 * `count`, everything else to `unknown`.
 */
export type NormalizedUnit =
  | 'g'
  | 'kg'
  | 'oz'
  | 'lb'
  | 'ml'
  | 'l'
  | 'tsp'
  | 'tbsp'
  | 'cup'
  | 'fl_oz'
  | 'count'
  | 'unknown';

/** Confidence in the resolved (deterministic) portion of a measurement. */
export type MeasurementConfidence = 'high' | 'medium' | 'low' | 'unknown';

/** Result of normalizing a measurement. `grams`/`milliliters` are undefined when not resolvable. */
export interface NormalizedMeasurement {
  /** The numeric quantity, or null when no quantity was expressed. */
  amount: number | null;
  /** The original unit token as supplied (trimmed), or undefined. */
  rawUnit: string | undefined;
  /** The canonical unit id, or 'unknown'. */
  normalizedUnit: NormalizedUnit;
  /** Classification. */
  kind: MeasurementKind;
  /** Deterministic grams when kind === 'mass'; else undefined. */
  grams: number | undefined;
  /** Deterministic milliliters when kind === 'volume'; else undefined. */
  milliliters: number | undefined;
  /** Confidence in the resolved classification. */
  confidence: MeasurementConfidence;
}

/** Deterministic mass constants (grams) — exact, not rounded. */
export const GRAMS_PER_KG = 1000;
export const GRAMS_PER_OZ = 28.349523125;
export const GRAMS_PER_LB = 453.59237;

/** Deterministic volume constants (milliliters) — exact, not rounded. */
export const ML_PER_L = 1000;
export const ML_PER_TSP = 4.92892159375;
export const ML_PER_TBSP = 14.78676478125;
export const ML_PER_CUP = 236.5882365;
export const ML_PER_FL_OZ = 29.5735295625;

/**
 * Alias / plural map: surface unit token -> canonical NormalizedUnit.
 *
 * Reuses the existing `KNOWN_UNITS` canonical spellings where they exist, and
 * additionally recognizes British spellings, `fluid ounce(s)`, and the count
 * nouns enumerated in v0.3.0 Step 2.
 */
const UNIT_ALIASES: Record<string, NormalizedUnit> = {
  // Mass
  g: 'g',
  gram: 'g',
  grams: 'g',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  // Volume
  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  l: 'l',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  litres: 'l',
  tsp: 'tsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  t: 'tsp',
  tbsp: 'tbsp',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  tbs: 'tbsp',
  cup: 'cup',
  cups: 'cup',
  c: 'cup',
  fl_oz: 'fl_oz',
  'fl oz': 'fl_oz',
  floz: 'fl_oz',
  'fluid ounce': 'fl_oz',
  'fluid ounces': 'fl_oz',
  // Count-like (collapsed to 'count'; never converted to grams here)
  egg: 'count',
  eggs: 'count',
  clove: 'count',
  cloves: 'count',
  slice: 'count',
  slices: 'count',
  piece: 'count',
  pieces: 'count',
  can: 'count',
  cans: 'count',
  package: 'count',
  packages: 'count',
  pkg: 'count',
  stick: 'count',
  sticks: 'count',
  // Recognized culinary measures that are NOT deterministically mass/volume/count.
  // Treated as unmeasurable (unknown) rather than guessed.
  pinch: 'unknown',
  pinches: 'unknown',
  dash: 'unknown',
  dashes: 'unknown',
  bunch: 'unknown',
  bunches: 'unknown',
  stalk: 'unknown',
  stalks: 'unknown',
  sprig: 'unknown',
  sprigs: 'unknown',
  handful: 'unknown',
  handfuls: 'unknown',
  portion: 'unknown',
  portions: 'unknown',
};

const MASS_UNITS: ReadonlySet<NormalizedUnit> = new Set(['g', 'kg', 'oz', 'lb']);
const VOLUME_UNITS: ReadonlySet<NormalizedUnit> = new Set(['ml', 'l', 'tsp', 'tbsp', 'cup', 'fl_oz']);

/**
 * Recognized count nouns (word-boundary matched so "eggplant"/"canned" do not match).
 * Only used to infer `count` when no explicit unit is present but the name is a
 * countable food — never to assign mass.
 */
const COUNT_NOUN_REGEX =
  /\b(egg|eggs|clove|cloves|slice|slices|piece|pieces|can|cans|package|packages|pkg|stick|sticks)\b/i;

/** Converts a mass unit into grams (deterministic), or undefined for non-mass. */
export function convertMassToGrams(
  amount: number,
  unit: NormalizedUnit
): number | undefined {
  switch (unit) {
    case 'g':
      return amount;
    case 'kg':
      return amount * GRAMS_PER_KG;
    case 'oz':
      return amount * GRAMS_PER_OZ;
    case 'lb':
      return amount * GRAMS_PER_LB;
    default:
      return undefined;
  }
}

/** Converts a volume unit into milliliters (deterministic), or undefined for non-volume. */
export function convertVolumeToMl(
  amount: number,
  unit: NormalizedUnit
): number | undefined {
  switch (unit) {
    case 'ml':
      return amount;
    case 'l':
      return amount * ML_PER_L;
    case 'tsp':
      return amount * ML_PER_TSP;
    case 'tbsp':
      return amount * ML_PER_TBSP;
    case 'cup':
      return amount * ML_PER_CUP;
    case 'fl_oz':
      return amount * ML_PER_FL_OZ;
    default:
      return undefined;
  }
}

/** Normalizes a raw unit token to a canonical id, or undefined when unrecognized. */
export function normalizeUnit(rawUnit: string | null | undefined): NormalizedUnit | undefined {
  if (rawUnit === null || rawUnit === undefined) return undefined;
  const cleaned = String(rawUnit)
    .trim()
    .toLowerCase()
    .replace(/[.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  const canonical = UNIT_ALIASES[cleaned];
  return canonical ?? undefined;
}

/** Classifies a normalized unit into mass / volume / count / unknown. */
export function getMeasurementKind(unit: NormalizedUnit | undefined | null): MeasurementKind {
  if (unit && MASS_UNITS.has(unit)) return 'mass';
  if (unit && VOLUME_UNITS.has(unit)) return 'volume';
  if (unit === 'count') return 'count';
  return 'unknown';
}

/**
 * Parses an amount (number or fraction/unicode string) into a finite number.
 * Reuses the canonical single fraction parser (`parseFraction`) — no new parser.
 */
export function parseAmount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return parseFraction(trimmed);
}

function hasCountNoun(text: string): boolean {
  return COUNT_NOUN_REGEX.test(text);
}

/**
 * Normalizes a measurement (amount + unit + optional ingredient name) into a
 * deterministic classification.
 *
 * - mass/volume convert deterministically (grams/ml); cross-dimension is never
 *   attempted.
 * - count nouns classify as `count` with NO gram conversion.
 * - unmeasured / unknown stays unknown; amount is never defaulted to 1.
 */
export function normalizeMeasurement(
  amount: number | string | null | undefined,
  unit: string | null | undefined,
  ingredientName?: string | undefined
): NormalizedMeasurement {
  const parsedAmount = parseAmount(amount);
  let normalizedUnit = normalizeUnit(unit);
  let kind = getMeasurementKind(normalizedUnit);

  // "2 eggs", "3 cloves" often arrive with unit === undefined. Infer count from
  // a recognized count noun in the name, but NEVER assign mass.
  if (!normalizedUnit && ingredientName && hasCountNoun(ingredientName)) {
    normalizedUnit = 'count';
    kind = 'count';
  }
  if (!normalizedUnit) {
    normalizedUnit = 'unknown';
    kind = 'unknown';
  }

  const grams =
    kind === 'mass' && parsedAmount !== null
      ? convertMassToGrams(parsedAmount, normalizedUnit)
      : undefined;
  const milliliters =
    kind === 'volume' && parsedAmount !== null
      ? convertVolumeToMl(parsedAmount, normalizedUnit)
      : undefined;

  const confidence: MeasurementConfidence = kind === 'unknown' ? 'unknown' : 'high';

  return {
    amount: parsedAmount,
    rawUnit: unit !== null && unit !== undefined && String(unit).trim() ? String(unit).trim() : undefined,
    normalizedUnit,
    kind,
    grams,
    milliliters,
    confidence,
  };
}

/** Structured ingredient input for measurement derivation (computation-only). */
export interface MeasurementIngredientInput {
  amount?: number | null;
  unit?: string | null;
  name?: string;
  raw?: string;
  original?: string;
}

/**
 * Derives a normalized measurement from existing structured ingredient data.
 *
 * This is purely derived, read-only computation. It NEVER mutates the input and
 * returns no serialized surface, so wikilinks / aliases / names / preparation /
 * checklist state and Markdown are left untouched.
 */
export function normalizeIngredientMeasurement(
  input: MeasurementIngredientInput
): NormalizedMeasurement {
  const name = input.name || input.raw || input.original || undefined;
  return normalizeMeasurement(input.amount ?? null, input.unit, name);
}
