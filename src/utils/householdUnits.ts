/**
 * The Kitchen Codex — Deterministic Household Unit Vocabulary (Phase 1 owner).
 *
 * PURE, dependency-free, offline. This module is the ONE canonical owner for the
 * Phase 1 household unit classifications: the closed count-noun vocabulary
 * (clove, slice, piece, stick, head, stalk, sprig, bunch, leaf, fillet, breast,
 * thigh, rib, strip, link, scoop, item) and the closed container vocabulary
 * (can, package, jar, box, bag, bottle).
 *
 * It classifies NOUNS ONLY. It never assigns grams, never converts a count or
 * container to mass, and never claims a unit has a weight: mass authority stays
 * with the authenticated USDA count/source-portion machinery.
 *
 * Two closed sub-classifications matter to food-phrase cleaning:
 *
 *   - MEASURE count nouns are pure portion/measure nouns. When they follow the
 *     food (`2 celery stalks`, `4 bacon slices`) they are removed from the food
 *     phrase because the remaining phrase is still the complete food head.
 *
 *   - IDENTITY count nouns can be part of a food name (`chicken breast`,
 *     `salmon fillet`, `spare ribs`, `bay leaf`, `head cheese`, `fish stick`,
 *     `sausage link`). They are still recognized as amount metadata, but they
 *     are deliberately RETAINED in the food phrase so parsing can never erase a
 *     true food head. This is a bounded, documented classification — not a
 *     global word-removal rule.
 */

export type HouseholdUnitKind = 'count' | 'container';

export interface HouseholdUnit {
  /** Canonical singular noun (e.g. `clove`, `can`, `package`). */
  readonly noun: string;
  readonly kind: HouseholdUnitKind;
}

/**
 * Closed alias map: every accepted surface token (singular and plural) mapped to
 * its canonical noun and classification. This is the single source of truth.
 */
const HOUSEHOLD_UNIT_ALIASES: Readonly<Record<string, HouseholdUnit>> = Object.freeze({
  // Count nouns
  clove: Object.freeze({ noun: 'clove', kind: 'count' as const }),
  cloves: Object.freeze({ noun: 'clove', kind: 'count' as const }),
  slice: Object.freeze({ noun: 'slice', kind: 'count' as const }),
  slices: Object.freeze({ noun: 'slice', kind: 'count' as const }),
  piece: Object.freeze({ noun: 'piece', kind: 'count' as const }),
  pieces: Object.freeze({ noun: 'piece', kind: 'count' as const }),
  stick: Object.freeze({ noun: 'stick', kind: 'count' as const }),
  sticks: Object.freeze({ noun: 'stick', kind: 'count' as const }),
  head: Object.freeze({ noun: 'head', kind: 'count' as const }),
  heads: Object.freeze({ noun: 'head', kind: 'count' as const }),
  stalk: Object.freeze({ noun: 'stalk', kind: 'count' as const }),
  stalks: Object.freeze({ noun: 'stalk', kind: 'count' as const }),
  sprig: Object.freeze({ noun: 'sprig', kind: 'count' as const }),
  sprigs: Object.freeze({ noun: 'sprig', kind: 'count' as const }),
  bunch: Object.freeze({ noun: 'bunch', kind: 'count' as const }),
  bunches: Object.freeze({ noun: 'bunch', kind: 'count' as const }),
  leaf: Object.freeze({ noun: 'leaf', kind: 'count' as const }),
  leaves: Object.freeze({ noun: 'leaf', kind: 'count' as const }),
  fillet: Object.freeze({ noun: 'fillet', kind: 'count' as const }),
  fillets: Object.freeze({ noun: 'fillet', kind: 'count' as const }),
  breast: Object.freeze({ noun: 'breast', kind: 'count' as const }),
  breasts: Object.freeze({ noun: 'breast', kind: 'count' as const }),
  thigh: Object.freeze({ noun: 'thigh', kind: 'count' as const }),
  thighs: Object.freeze({ noun: 'thigh', kind: 'count' as const }),
  rib: Object.freeze({ noun: 'rib', kind: 'count' as const }),
  ribs: Object.freeze({ noun: 'rib', kind: 'count' as const }),
  strip: Object.freeze({ noun: 'strip', kind: 'count' as const }),
  strips: Object.freeze({ noun: 'strip', kind: 'count' as const }),
  link: Object.freeze({ noun: 'link', kind: 'count' as const }),
  links: Object.freeze({ noun: 'link', kind: 'count' as const }),
  scoop: Object.freeze({ noun: 'scoop', kind: 'count' as const }),
  scoops: Object.freeze({ noun: 'scoop', kind: 'count' as const }),
  item: Object.freeze({ noun: 'item', kind: 'count' as const }),
  items: Object.freeze({ noun: 'item', kind: 'count' as const }),
  // Containers
  can: Object.freeze({ noun: 'can', kind: 'container' as const }),
  cans: Object.freeze({ noun: 'can', kind: 'container' as const }),
  tin: Object.freeze({ noun: 'can', kind: 'container' as const }),
  tins: Object.freeze({ noun: 'can', kind: 'container' as const }),
  package: Object.freeze({ noun: 'package', kind: 'container' as const }),
  packages: Object.freeze({ noun: 'package', kind: 'container' as const }),
  pkg: Object.freeze({ noun: 'package', kind: 'container' as const }),
  jar: Object.freeze({ noun: 'jar', kind: 'container' as const }),
  jars: Object.freeze({ noun: 'jar', kind: 'container' as const }),
  box: Object.freeze({ noun: 'box', kind: 'container' as const }),
  boxes: Object.freeze({ noun: 'box', kind: 'container' as const }),
  bag: Object.freeze({ noun: 'bag', kind: 'container' as const }),
  bags: Object.freeze({ noun: 'bag', kind: 'container' as const }),
  bottle: Object.freeze({ noun: 'bottle', kind: 'container' as const }),
  bottles: Object.freeze({ noun: 'bottle', kind: 'container' as const }),
});

/**
 * Identity-bearing count nouns: recognized as amount metadata, but retained in
 * the food phrase because they can be the food head itself.
 */
const IDENTITY_BEARING_COUNT_NOUNS: ReadonlySet<string> = new Set([
  'stick',
  'head',
  'leaf',
  'fillet',
  'breast',
  'thigh',
  'rib',
  'strip',
  'link',
]);

/**
 * Closed unit/food COMPOUND-COLLISION policy.
 *
 * Some household unit nouns also begin a legitimate compound FOOD name. A
 * leading unit token must then never be consumed: consuming it would erase the
 * true food head (the exact failure this policy exists to prevent). Each entry
 * is a bound, documented pair of `unit noun -> compound head token(s)` where the
 * whole phrase is a food, not a container/count of the following food:
 *
 *   - `bottle gourd`  : the gourd (calabash) is a food; `bottle` is not a
 *                       container of `gourd`.
 *   - `head cheese`   : a meat-jelly food; `head` is not a count of `cheese`.
 *   - `leaf lettuce`  : a lettuce variety; `leaf` is not a count of `lettuce`.
 *
 * This is deliberately NOT a food lexicon: only unit nouns that would otherwise
 * be destructively consumed are listed, with their explicit singular and plural
 * compound heads. An explicit `of` separator (`1 bottle of hot sauce`) is
 * unambiguous container grammar and is never treated as a collision.
 */
const HOUSEHOLD_UNIT_FOOD_COLLISIONS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  bottle: Object.freeze(['gourd', 'gourds']),
  head: Object.freeze(['cheese', 'cheeses']),
  leaf: Object.freeze(['lettuce', 'lettuces']),
});

/**
 * True when consuming `unitNoun` immediately before `followingText` would
 * destroy a documented compound food name. Token-boundary based: the first
 * token of the following text must equal a documented head token after
 * case-folding and trailing punctuation stripping.
 */
export function householdUnitFoodCollision(unitNoun: string, followingText: string): boolean {
  const heads = HOUSEHOLD_UNIT_FOOD_COLLISIONS[unitNoun];
  if (!heads || heads.length === 0) return false;
  const first = String(followingText).trim().split(/\s+/)[0];
  if (!first) return false;
  const cleaned = first.toLowerCase().replace(/[.,;:!?"'()[\]{}]+$/g, '');
  return heads.includes(cleaned);
}

/** Every documented collision unit noun (for tests/documentation). */
export function householdCollisionUnitNouns(): ReadonlyArray<string> {
  return Object.freeze(Object.keys(HOUSEHOLD_UNIT_FOOD_COLLISIONS));
}

/** The documented compound head tokens for one unit noun. */
export function householdCollisionHeads(unitNoun: string): ReadonlyArray<string> {
  return HOUSEHOLD_UNIT_FOOD_COLLISIONS[unitNoun] ?? Object.freeze([]);
}

/** Canonicalizes one exact household token (case-insensitive, token-bounded). */
export function canonicalHouseholdUnit(raw: string | null | undefined): HouseholdUnit | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).trim().toLowerCase();
  if (!cleaned) return null;
  return HOUSEHOLD_UNIT_ALIASES[cleaned] ?? null;
}

/** Every accepted surface token (for vocabulary-consistency tests). */
export function householdUnitAliases(): ReadonlyArray<string> {
  return Object.freeze(Object.keys(HOUSEHOLD_UNIT_ALIASES));
}

/** Canonical count nouns (singular). */
export function householdCountNouns(): ReadonlyArray<string> {
  return Object.freeze([
    'clove',
    'slice',
    'piece',
    'stick',
    'head',
    'stalk',
    'sprig',
    'bunch',
    'leaf',
    'fillet',
    'breast',
    'thigh',
    'rib',
    'strip',
    'link',
    'scoop',
    'item',
  ]);
}

/** Canonical container nouns (singular). */
export function householdContainerNouns(): ReadonlyArray<string> {
  return Object.freeze(['can', 'package', 'jar', 'box', 'bag', 'bottle']);
}

/**
 * True when a count noun may be removed from a trailing position in the food
 * phrase (a pure measure of the preceding food). Identity-bearing nouns return
 * false: they stay in the food phrase.
 */
export function isStrippableCountNoun(noun: string): boolean {
  return !IDENTITY_BEARING_COUNT_NOUNS.has(noun);
}

/**
 * True when a count noun may be retained in the food phrase because it can be
 * part of the food identity. Exported for tests/documentation.
 */
export function isIdentityBearingCountNoun(noun: string): boolean {
  return IDENTITY_BEARING_COUNT_NOUNS.has(noun);
}
