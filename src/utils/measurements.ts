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
import {
  canonicalHouseholdUnit,
  householdUnitAliases,
  householdUnitFoodCollision,
  isStrippableCountNoun,
} from './householdUnits';

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
  | 'fl_oz'
  | 'cup'
  | 'pint'
  | 'quart'
  | 'gallon'
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
export const ML_PER_FL_OZ = 29.5735295625;
export const ML_PER_CUP = 236.5882365;
/**
 * US customary larger volume units, derived RELATIONALLY from the single
 * canonical fluid-ounce constant (1 cup = 8 fl oz, 1 pint = 16 fl oz,
 * 1 quart = 32 fl oz, 1 gallon = 128 fl oz). There is no second, contradictory
 * conversion table.
 */
export const ML_PER_PINT = 16 * ML_PER_FL_OZ;
export const ML_PER_QUART = 32 * ML_PER_FL_OZ;
export const ML_PER_GALLON = 128 * ML_PER_FL_OZ;

/**
 * Alias / plural map: surface unit token -> canonical NormalizedUnit.
 *
 * Reuses the existing `KNOWN_UNITS` canonical spellings where they exist, and
 * additionally recognizes British spellings, `fluid ounce(s)`, and the count
 * nouns enumerated in v0.3.0 Step 2.
 */
const BASE_UNIT_ALIASES: Record<string, NormalizedUnit> = {
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
  pint: 'pint',
  pints: 'pint',
  pt: 'pint',
  quart: 'quart',
  quarts: 'quart',
  qt: 'quart',
  gallon: 'gallon',
  gallons: 'gallon',
  gal: 'gallon',
  fl_oz: 'fl_oz',
  'fl oz': 'fl_oz',
  floz: 'fl_oz',
  'fluid ounce': 'fl_oz',
  'fluid ounces': 'fl_oz',
  // FOOD count noun (never consumed as a leading measure: `2 eggs` keeps
  // `eggs` as the food name).
  egg: 'count',
  eggs: 'count',
  // Recognized culinary measures that are NOT deterministically mass/volume/count.
  // Treated as unmeasurable (unknown) rather than guessed.
  pinch: 'unknown',
  pinches: 'unknown',
  dash: 'unknown',
  dashes: 'unknown',
  handful: 'unknown',
  handfuls: 'unknown',
  portion: 'unknown',
  portions: 'unknown',
};

/**
 * The canonical Phase 1 household vocabulary (`src/utils/householdUnits.ts`) is
 * resolved as `count` for the legacy `NormalizedUnit` contract. There is ONE
 * vocabulary owner; this map only projects it onto the pre-existing
 * mass/volume/count/unknown unit ids (containers are count-like for legacy
 * conversion purposes and are separately classified by the canonical parse).
 */
const HOUSEHOLD_UNIT_ALIASES: Record<string, NormalizedUnit> = (() => {
  const out: Record<string, NormalizedUnit> = {};
  for (const token of householdUnitAliases()) out[token] = 'count';
  return out;
})();

const RESOLVED_UNIT_ALIASES: Record<string, NormalizedUnit> = {
  ...BASE_UNIT_ALIASES,
  ...HOUSEHOLD_UNIT_ALIASES,
};

const MASS_UNITS: ReadonlySet<NormalizedUnit> = new Set(['g', 'kg', 'oz', 'lb']);
const VOLUME_UNITS: ReadonlySet<NormalizedUnit> = new Set([
  'ml',
  'l',
  'tsp',
  'tbsp',
  'fl_oz',
  'cup',
  'pint',
  'quart',
  'gallon',
]);

/**
 * Recognized count nouns (word-boundary matched so "eggplant", "canned",
 * "bagel", "breadstick", "bottle gourd" do not match a shorter noun inside a
 * longer word). Derived from the ONE household vocabulary owner plus the food
 * count noun `egg`. Only used to infer `count` when no explicit unit is present
 * but the name is a countable food — never to assign mass.
 */
const COUNT_NOUN_REGEX = new RegExp(
  `\\b(?:egg|eggs|${householdUnitAliases().join('|')})\\b`,
  'i'
);

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
    case 'pint':
      return amount * ML_PER_PINT;
    case 'quart':
      return amount * ML_PER_QUART;
    case 'gallon':
      return amount * ML_PER_GALLON;
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
  const canonical = RESOLVED_UNIT_ALIASES[cleaned];
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

/**
 * Count nouns that are FOODS, not measures. `egg`/`eggs` are deliberately never
 * consumed as a leading unit: `2 eggs` must keep `eggs` as the food name.
 */
const FOOD_COUNT_NOUNS: ReadonlySet<string> = new Set(['egg', 'eggs']);

/** Result of recognizing an exact leading unit token in a bounded text. */
export interface LeadingUnitMatch {
  /** The exact original unit token(s) as supplied (e.g. `slices`, `fl oz`). */
  readonly rawUnit: string;
  /** The canonical unit id. */
  readonly canonical: NormalizedUnit;
  /** The remaining text after the unit, with a leading `of` removed. */
  readonly rest: string;
  /**
   * True when the source separated the unit from the food with an explicit
   * `of` (`1 bottle of hot sauce`). An explicit separator is unambiguous
   * container/count grammar and is never a compound-food collision.
   */
  readonly hadOf: boolean;
}

/**
 * Recognizes an EXACT leading unit token — one complete token or one exact
 * recognized multi-token unit (`fl oz`, `fluid ounce(s)`) — and returns it with
 * the remaining text. A unit is never matched as a PREFIX of a longer word:
 * `slice` does not match `slices` (the whole `slices` token matches instead),
 * `g` does not match `garlic`, `l` does not match `lettuce`, `c` does not match
 * `cheese`, and `can` does not match `candy`.
 *
 * This is the ONE shared leading-unit recognizer used by both the deterministic
 * raw-line segmenter and the Phase 2 matching parser. It is pure and offline.
 */
export function matchLeadingUnit(text: string): LeadingUnitMatch | undefined {
  const trimmed = String(text).replace(/^\s+/, '');
  if (!trimmed) return undefined;
  const tokens = trimmed.split(/\s+/);

  // Exact multi-token fluid-ounce unit (`fl oz`, `fl. oz.`, `fluid ounce(s)`).
  if (tokens.length >= 2) {
    const firstClean = tokens[0].toLowerCase().replace(/[.,;:]+$/, '');
    if (firstClean === 'fl' || firstClean === 'fluid') {
      const combined = `${tokens[0]} ${tokens[1]}`;
      if (normalizeUnit(combined) === 'fl_oz') {
        const consumed = tokens[0].length + 1 + tokens[1].length;
        const afterUnit = trimmed.slice(consumed).replace(/^[,\s]+/, '');
        const hadOf = /^of\s+/i.test(afterUnit);
        const rest = afterUnit.replace(/^of\s+/i, '').trim();
        return { rawUnit: combined, canonical: 'fl_oz', rest, hadOf };
      }
    }
  }

  const rawUnit = tokens[0];
  const cleaned = rawUnit.toLowerCase().replace(/[.,;:]+$/, '');
  if (!cleaned || FOOD_COUNT_NOUNS.has(cleaned)) return undefined;
  const canonical = normalizeUnit(cleaned);
  if (!canonical) return undefined;
  const afterUnit = trimmed.slice(rawUnit.length).replace(/^[,\s]+/, '');
  const hadOf = /^of\s+/i.test(afterUnit);
  const rest = afterUnit.replace(/^of\s+/i, '').trim();
  // Return the unit token with trailing sentence punctuation stripped (an
  // explicit, tested rule: `cups,` -> `cups`).
  return { rawUnit: rawUnit.replace(/[.,;:]+$/, ''), canonical, rest, hadOf };
}

export interface RawIngredientPartsOptions {
  /**
   * When true, recognized count / culinary measures (`slice`, `clove`, `can`,
   * `pinch`, `dash`, `bunch`, ...) are consumed from the food name as well. When
   * false (the deterministic-engine default), only mass/volume units are
   * consumed and count nouns remain in the name.
   */
  readonly includeCount?: boolean;
}

// ---------------------------------------------------------------------------
// Phase 1 canonical ingredient parse
// ---------------------------------------------------------------------------

/**
 * Explicit canonical-parse contract version. Bumping this is required whenever
 * the canonical parse classification of an existing input changes meaning.
 */
export const CANONICAL_INGREDIENT_PARSE_VERSION = 'canonical_ingredient_parse_v1';

/**
 * Maximum accepted quantity RANGE endpoint. Exact-quantity parsing is unchanged
 * (existing bounds untouched); only the newly added range grammar rejects
 * excessive endpoints. A range with an excessive endpoint is unresolved, never
 * silently clamped.
 */
export const MAX_CANONICAL_RANGE_QUANTITY = 1_000_000;

/** Quantity classification: exact, bounded range, absent, or invalid. */
export type CanonicalQuantityKind = 'exact' | 'range' | 'absent' | 'invalid';

/** Canonical unit classification. */
export type CanonicalUnitKind = 'mass' | 'volume' | 'count' | 'container' | 'unknown';

export interface CanonicalQuantity {
  readonly kind: CanonicalQuantityKind;
  /** Exact quantity only; null for range/absent/invalid. */
  readonly amount: number | null;
  /** Range endpoints only; null otherwise. */
  readonly lower: number | null;
  readonly upper: number | null;
}

/**
 * Explicit package net mass (e.g. `1 (15 oz) can tomato sauce`). It is extracted
 * and represented truthfully; it is NEVER converted into mass authority by the
 * parse layer, and it is never multiplied by the container count here.
 */
export interface CanonicalPackageNetMass {
  readonly amount: number;
  readonly unit: NormalizedUnit;
  /** `per_container` / `total` when grammar is deterministic; null otherwise. */
  readonly scope: 'per_container' | 'total' | null;
}

export interface CanonicalIngredientParts {
  readonly version: string;
  readonly quantity: CanonicalQuantity;
  /** The raw unit token as supplied (`sprigs`, `(15 oz)`-free, ...), or null. */
  readonly rawUnit: string | null;
  /** Canonical unit id (mass/volume), canonical count/container noun, or null. */
  readonly unit: string | null;
  readonly unitKind: CanonicalUnitKind;
  /** Canonical count noun (leading or after the food), or null. */
  readonly countNoun: string | null;
  /** Canonical container noun, or null. */
  readonly container: string | null;
  readonly packageNetMass: CanonicalPackageNetMass | null;
  /** Food phrase remaining after amount extraction (preparation words kept). */
  readonly foodText: string;
  readonly originalText: string;
}

/** Existing-equivalent exact quantity matcher (one canonical fraction contract). */
const EXACT_AMOUNT_PATTERN =
  /^\s*(\d+\s+\d+\/\d+|\d+\s*-\s*\d+\/\d+|\d+\/\d+|\d+\s*[½⅓⅔¼¾⅛⅜⅝⅞]|[½⅓⅔¼¾⅛⅜⅝⅞]|\d+(?:\.\d+)?)/;

const RANGE_ENDPOINT_SOURCE = String.raw`\d+\s+\d+\/\d+|\d+\/\d+|\d+\s*[½⅓⅔¼¾⅛⅜⅝⅞]|[½⅓⅔¼¾⅛⅜⅝⅞]|\d+(?:\.\d+)?`;

/**
 * Bounded culinary range grammar: `1-2`, `1–2`, `1—2`, `1 to 2`, `1/4-1/2`,
 * `1 1/2-2`. The upper endpoint must end at a real boundary (whitespace, `)`,
 * `,`, `;`, or end of text) so `1-2-3`, `2-3mm`, and date-like strings are never
 * chained into a range.
 */
const RANGE_PATTERN = new RegExp(
  `^\\s*(${RANGE_ENDPOINT_SOURCE})\\s*(?:-|–|—|\\bto\\b)\\s*(${RANGE_ENDPOINT_SOURCE})(?=\\s|[),;]|$)`
);

/**
 * The pre-existing closed mixed-fraction contract (`1-1/2` === `1 1/2`), reused
 * so a hyphenated mixed number is never mistaken for a reversed range.
 */
const MIXED_FRACTION_PATTERN = /^\d+[-\s]\d+\/\d+$/;

/** Leading calendar dates are never quantities (`2024-01-02 ...`). */
const DATE_PREFIX_PATTERN = /^\s*\d{4}-\d{1,2}-\d{1,2}(?=\s|$)/;

/**
 * A dash run immediately after a quantity is an unresolved range, not food text
 * (covers `1-2-3`, `1--2`, `1 - - 2`, and a range with a missing endpoint such
 * as `1- tbsp oil`). A valid range is always recognized BEFORE this check.
 */
const DANGLING_DASH_PATTERN = /^\s*[-–—]+/;

/** A `to` separator with no upper endpoint (`1 to cups oil`) is unresolved. */
const DANGLING_TO_PATTERN = /^\s*to(?=\s|$)/i;

/**
 * A recognized unit token joined to a second quantity (`1 cup-2 tbsp`,
 * `1 tbsp - 2 tsp`) is a mixed-unit range and is unresolved: the first unit must
 * never be extracted as if the text were a single quantity.
 */
const MIXED_UNIT_RANGE_PATTERN = /^\s*([A-Za-z][A-Za-z.]*)\s*[-–—]\s*\d/;

const MASS_UNIT_TOKEN_SOURCE = String.raw`g|kg|oz|lb|gram|grams|kilogram|kilograms|ounce|ounces|pound|pounds`;
const NET_MASS_PREFIX_PATTERN = new RegExp(
  `^\\(\\s*(${RANGE_ENDPOINT_SOURCE})\\s*(${MASS_UNIT_TOKEN_SOURCE})\\s*(total)?\\s*\\)\\s*`
);
const BARE_NET_MASS_PREFIX_PATTERN = new RegExp(
  `^(${RANGE_ENDPOINT_SOURCE})\\s*(${MASS_UNIT_TOKEN_SOURCE})\\s+`
);

function emptyQuantity(kind: CanonicalQuantityKind): CanonicalQuantity {
  return Object.freeze({ kind, amount: null, lower: null, upper: null });
}

function absentParse(originalText: string): CanonicalIngredientParts {
  return Object.freeze({
    version: CANONICAL_INGREDIENT_PARSE_VERSION,
    quantity: emptyQuantity('absent'),
    rawUnit: null,
    unit: null,
    unitKind: 'unknown' as const,
    countNoun: null,
    container: null,
    packageNetMass: null,
    foodText: originalText,
    originalText,
  });
}

function invalidParse(originalText: string): CanonicalIngredientParts {
  return Object.freeze({
    version: CANONICAL_INGREDIENT_PARSE_VERSION,
    quantity: emptyQuantity('invalid'),
    rawUnit: null,
    unit: null,
    unitKind: 'unknown' as const,
    countNoun: null,
    container: null,
    packageNetMass: null,
    foodText: originalText,
    originalText,
  });
}

/** Extracts a bounded net-mass entry from a matched mass expression. */
function netMassEntry(
  rawAmount: string,
  rawUnit: string,
  totalMarker: string | undefined
): CanonicalPackageNetMass | null {
  const amount = parseAmount(rawAmount);
  if (
    amount === null ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    Object.is(amount, -0) ||
    amount > MAX_CANONICAL_RANGE_QUANTITY
  ) {
    return null;
  }
  const unit = normalizeUnit(rawUnit);
  if (unit !== 'g' && unit !== 'kg' && unit !== 'oz' && unit !== 'lb') return null;
  return Object.freeze({
    amount,
    unit,
    scope: totalMarker !== undefined ? ('total' as const) : ('per_container' as const),
  });
}

/** True when the first token of `text` is a closed container noun. */
function startsWithContainer(text: string): boolean {
  const first = text.trim().split(/\s+/)[0];
  if (!first) return false;
  const cleaned = first.replace(/^[(\[]+/, '').replace(/[),;:.!?[\]]+$/, '');
  return canonicalHouseholdUnit(cleaned)?.kind === 'container';
}

interface TrailingNounExtraction {
  readonly token: string;
  readonly noun: string;
  readonly food: string;
}

/**
 * Extracts an unambiguous trailing count noun (`2 celery stalks`,
 * `4 bacon slices`, `2 garlic cloves, minced`). Identity-bearing count nouns are
 * recorded as amount metadata but retained in the food phrase. Token-boundary
 * and grammatical-position logic only — never substring replacement.
 */
function extractTrailingCountNoun(food: string): TrailingNounExtraction | null {
  const commaIndex = food.indexOf(',');
  const headPart = (commaIndex >= 0 ? food.slice(0, commaIndex) : food).trim();
  const tailPart = commaIndex >= 0 ? food.slice(commaIndex) : '';
  if (!headPart) return null;
  const tokens = headPart.split(/\s+/);
  if (tokens.length < 2) return null;
  const lastToken = tokens[tokens.length - 1];
  const household = canonicalHouseholdUnit(lastToken.replace(/[.,;:]+$/, ''));
  if (!household || household.kind !== 'count') return null;
  if (!isStrippableCountNoun(household.noun)) {
    return { token: lastToken, noun: household.noun, food };
  }
  const head = tokens.slice(0, -1).join(' ');
  if (!head) return null;
  return { token: lastToken, noun: household.noun, food: `${head}${tailPart}` };
}

/**
 * The ONE canonical Phase 1 parse: a bounded, additive representation that
 * separates amount metadata (exact quantity or range, canonical unit, count
 * noun, container, package net mass) from the remaining food phrase.
 *
 * HONESTY RULES
 *  - a missing amount stays absent (never defaulted);
 *  - a true range keeps BOTH endpoints and never yields a single amount, so it
 *    can never drive grams from one endpoint;
 *  - a container is classified but never assigned a guessed mass;
 *  - a package net mass is extracted and represented, never converted to mass;
 *  - malformed ranges (chained, reversed, mixed, excessive) are unresolved.
 */
export function parseCanonicalIngredientParts(
  line: string,
  options: RawIngredientPartsOptions = {}
): CanonicalIngredientParts {
  const includeCount = options.includeCount === true;
  const originalText = String(line).trim().slice(0, 300);
  if (!originalText) return absentParse(originalText);

  // Calendar dates and other non-quantity leading numerics are not quantities.
  if (DATE_PREFIX_PATTERN.test(originalText)) return absentParse(originalText);

  let quantity: CanonicalQuantity = emptyQuantity('absent');
  let rest = originalText;
  let malformed = false;

  const range = RANGE_PATTERN.exec(originalText);
  if (range) {
    const lower = parseAmount(range[1]);
    const upper = parseAmount(range[2]);
    const whole = range[0].trim();
    const bounded = (value: number | null): value is number =>
      value !== null &&
      Number.isFinite(value) &&
      value > 0 &&
      !Object.is(value, -0) &&
      value <= MAX_CANONICAL_RANGE_QUANTITY;
    if (bounded(lower) && bounded(upper) && lower <= upper) {
      quantity = Object.freeze({ kind: 'range' as const, amount: null, lower, upper });
      rest = originalText.slice(range[0].length).trim();
    } else if (
      bounded(lower) &&
      bounded(upper) &&
      lower > upper &&
      MIXED_FRACTION_PATTERN.test(whole)
    ) {
      // Existing closed contract: `2-1/2` is the mixed number 2 1/2.
      const mixed = parseAmount(whole);
      if (mixed !== null && Number.isFinite(mixed) && mixed > 0) {
        quantity = Object.freeze({ kind: 'exact' as const, amount: mixed, lower: null, upper: null });
        rest = originalText.slice(range[0].length).trim();
      } else {
        malformed = true;
      }
    } else {
      malformed = true;
    }
  } else {
    const exact = EXACT_AMOUNT_PATTERN.exec(originalText);
    if (exact) {
      const amount = parseAmount(exact[1]);
      const after = originalText.slice(exact[0].length).trim();
      const mixedUnit = MIXED_UNIT_RANGE_PATTERN.exec(after);
      const mixedUnitRange =
        mixedUnit !== null && normalizeUnit(mixedUnit[1].replace(/[.]+$/, '')) !== undefined;
      if (
        amount !== null &&
        Number.isFinite(amount) &&
        amount >= 0 &&
        !Object.is(amount, -0) &&
        !DANGLING_DASH_PATTERN.test(after) &&
        !DANGLING_TO_PATTERN.test(after) &&
        !mixedUnitRange
      ) {
        quantity = Object.freeze({ kind: 'exact' as const, amount, lower: null, upper: null });
        rest = after;
      } else {
        malformed = true;
      }
    }
  }

  if (malformed) return invalidParse(originalText);

  // Count/container classification is amount metadata: it requires an explicit
  // quantity. A bare phrase (`bottle gourd`, `head cheese`, `spare ribs`) is
  // never split, so a food name can never lose a real head to unit consumption.
  const hasExplicitQuantity = quantity.kind === 'exact' || quantity.kind === 'range';

  let packageNetMass: CanonicalPackageNetMass | null = null;

  // Package net mass: only meaningful together with an explicit count and a container.
  if (includeCount && hasExplicitQuantity) {
    const parenPrefix = NET_MASS_PREFIX_PATTERN.exec(rest);
    if (parenPrefix && startsWithContainer(rest.slice(parenPrefix[0].length))) {
      const entry = netMassEntry(parenPrefix[1], parenPrefix[2], parenPrefix[3]);
      if (entry) {
        packageNetMass = entry;
        rest = rest.slice(parenPrefix[0].length).trim();
      }
    } else {
      const bare = BARE_NET_MASS_PREFIX_PATTERN.exec(rest);
      if (bare && startsWithContainer(rest.slice(bare[0].length))) {
        const entry = netMassEntry(bare[1], bare[2], undefined);
        if (entry) {
          packageNetMass = entry;
          rest = rest.slice(bare[0].length).trim();
        }
      }
    }
  }

  let rawUnit: string | null = null;
  let unit: string | null = null;
  let unitKind: CanonicalUnitKind = 'unknown';
  let countNoun: string | null = null;
  let container: string | null = null;
  let food = rest;

  const leading = matchLeadingUnit(rest);
  if (leading) {
    const kind = getMeasurementKind(leading.canonical);
    const household = canonicalHouseholdUnit(leading.rawUnit);
    const consumable =
      kind === 'mass' ||
      kind === 'volume' ||
      (includeCount && hasExplicitQuantity && (kind === 'count' || kind === 'unknown'));
    // Closed compound-food collision policy: a leading household unit that
    // begins a documented compound food name (`1 bottle gourd`, `1 head
    // cheese`) is NEVER consumed without an explicit `of` separator — the unit
    // token is part of the food identity, so consuming it would erase a true
    // food head. Without `of`, the line stays fully unresolved for mass.
    const compoundCollision =
      household !== null && !leading.hadOf && householdUnitFoodCollision(household.noun, leading.rest);
    if (consumable && !compoundCollision) {
      rawUnit = leading.rawUnit;
      food = leading.rest;
      if (kind === 'mass' || kind === 'volume') {
        unit = leading.canonical;
        unitKind = kind;
      } else if (household) {
        unit = household.noun;
        unitKind = household.kind;
        if (household.kind === 'count') countNoun = household.noun;
        else container = household.noun;
      }
    }
  }

  // Parenthetical net mass AFTER a leading container: `1 can (15 ounces) beans`.
  if (includeCount && hasExplicitQuantity && container !== null && packageNetMass === null) {
    const parenSuffix = NET_MASS_PREFIX_PATTERN.exec(food);
    if (parenSuffix) {
      const entry = netMassEntry(parenSuffix[1], parenSuffix[2], parenSuffix[3]);
      if (entry) {
        packageNetMass = entry;
        food = food.slice(parenSuffix[0].length).trim();
      }
    }
  }

  // Trailing count noun (`2 celery stalks`, `2 garlic cloves, minced`). Only
  // when no leading unit was consumed; the noun is amount metadata.
  if (includeCount && hasExplicitQuantity && rawUnit === null) {
    const extracted = extractTrailingCountNoun(food);
    if (extracted) {
      rawUnit = extracted.token;
      unit = extracted.noun;
      unitKind = 'count';
      countNoun = extracted.noun;
      food = extracted.food;
    }
  }

  const cleanedFood = food.replace(/\s+/g, ' ').trim();
  const foodText = cleanedFood.length > 0 ? cleanedFood : originalText;

  return Object.freeze({
    version: CANONICAL_INGREDIENT_PARSE_VERSION,
    quantity,
    rawUnit,
    unit,
    unitKind,
    countNoun,
    container,
    packageNetMass,
    foodText,
    originalText,
  });
}

/**
 * Thin, calculation-free segmentation of a raw ingredient line into
 * `{ amount, unit, name }`.
 *
 * This is the LEGACY projection of the ONE canonical Phase 1 parse
 * (`parseCanonicalIngredientParts`): `amount` is the exact quantity only (a true
 * range is unresolved and yields null — never one endpoint), `unit` is the raw
 * unit token, and `name` is the remaining food phrase. With the default options
 * only mass/volume units are consumed; count nouns stay in the name. With
 * `{ includeCount: true }` recognized count/culinary measures, containers, and
 * trailing count nouns are consumed too, and package net masses are stripped
 * with their container.
 *
 * This helper is pure and free of any nutrition/calculation dependency (it does
 * NOT import the curated food reference or any calculation engine). The working
 * text is bounded to 300 characters; callers that must reject oversized input
 * MUST bound it BEFORE calling this helper, so it can never silently truncate an
 * authoritative query into a different valid ingredient.
 */
export function parseRawIngredientMeasurementParts(
  line: string,
  options: RawIngredientPartsOptions = {}
): {
  amount: number | null;
  unit: string | null;
  name: string;
} {
  const parsed = parseCanonicalIngredientParts(line, options);
  return {
    amount: parsed.quantity.kind === 'exact' ? parsed.quantity.amount : null,
    unit: parsed.rawUnit,
    name: parsed.foodText || parsed.originalText,
  };
}
