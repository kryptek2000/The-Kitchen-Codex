/**
 * The Kitchen Codex — Recipe Relationship / Ingredient Index Foundation
 * (v0.3.0 Step 6)
 *
 * A PURE, deterministic, dependency-light derived-data layer that turns the
 * application's already-loaded `ObsidianRecipe` objects into a reusable
 * ingredient index and a deterministic CULINARY recipe-similarity foundation
 * (dish family first; a lower-level Jaccard overlap remains only a bonus
 * signal, never the ranking authority).
 *
 * PRODUCT RULES HONORED:
 *   - This is DERIVED DATA ONLY. It never writes anything back to a recipe, its
 *     Markdown, its frontmatter, or the vault. No wikilinks are created or
 *     modified. Original ingredient strings are never mutated.
 *   - Obsidian Markdown remains the canonical source of truth; this module only
 *     reads the in-memory loaded recipes.
 *   - No AI. No external database/service/dependency. No filesystem scanning
 *     (it operates on the recipe objects the application already holds).
 *   - ZERO FABRICATION: an unknown ingredient identity stays unknown. Ingredients
 *     whose text does not normalize to a meaningful key are skipped rather than
 *     guessed.
 *   - SAFETY > RELATIONSHIP COUNT: identity is exact-match and conservative. We
 *     deliberately do NOT do substring matching, fuzzy/semantic similarity,
 *     stemming, or aggressive adjective stripping, so distinct foods cannot
 *     bleed into each other:
 *
 *         egg != eggplant          butter != peanut butter
 *         cream != cream cheese    garlic != garlic powder
 *         onion != onion powder    chicken breast != chicken thigh
 *         all-purpose flour != almond flour
 *
 * INGREDIENT IDENTITY:
 *   Identity is re-derived from the ingredient's reliable `original` text via the
 *   canonical parser `normalizeIngredient` (whole-word unit matching). The legacy
 *   line tokenizer in `parseIngredientLine` greedily swallows a leading letter as
 *   a unit for count-adjacent names (e.g. "3 large eggs" -> name "arge eggs",
 *   "1 garlic clove" -> "arlic clove"), which would corrupt relationship keys if
 *   `ParsedIngredient.name` were used directly. `original` is preserved correctly,
 *   so the safe canonical parser is used instead. This layer is intentionally
 *   independent of the curated `foodReference` data: arbitrary ingredients such
 *   as `paprika`, `carrots`, `soy sauce`, `lemons`, `potatoes` are all indexable.
 *
 *   Identity steps (conservative):
 *     1. strip a wikilink to its TARGET ([[Target|Alias]] -> Target, so distinct
 *        explicit vault targets can never collapse through a shared alias);
 *     2. drop a trailing qualitative clause ("to taste", "as needed", "optional");
 *     3. drop a trailing preparation clause ONLY when it begins with a closed,
 *        unambiguous preparation cue (e.g. "onion, diced" -> "onion"); a comma
 *        describing a variety/type ("beans, black") is PRESERVED so distinct
 *        foods never collapse;
 *     4. normalize case + whitespace + trailing punctuation.
 *
 *   Descriptor/size/adjective variants are deliberately NOT collapsed
 *   ("large eggs" stays distinct from "eggs", "heavy cream" from "cream") because
 *   adjectives can change identity and the layer favours safety over recall.
 *
 * NOTE ON PREPARATION:
 *   Only a small, closed set of preparation modifiers is treated as preparation
 *   after a comma. Variety/type descriptors (black/kidney beans, brown/wild rice,
 *   cream/blue cheese, Dijon mustard, canned/sun-dried tomatoes, olive/sesame oil)
 *   are preserved, at the cost of not collapsing "canned tomatoes" with fresh
 *   tomatoes. Safety over recall.
 *
 * DUPLICATE SEMANTICS:
 *   - Within a recipe, a repeated ingredient is a SINGLE presence for similarity,
 *     so duplicates never inflate a recipe's unique ingredient set (Jaccard
 *     stays honest).
 *   - Global frequency exposes BOTH `recipeCount` (distinct recipes containing
 *     the ingredient) and `occurrenceCount` (total raw occurrences across all
 *     recipes, including intra-recipe duplicates).
 */

import type { ParsedIngredient } from '../types';
import { normalizeIngredient } from '../schema/recipeValidator';

/** A minimal, flexible ingredient shape accepted by the index builder. */
export interface IngredientLike {
  original?: string;
  name?: string;
  amount?: number | null;
  unit?: string;
  wikilink?: string;
  wikilinkTarget?: string;
  wikilinkAlias?: string;
  note?: string;
}

/** A minimal, flexible recipe shape accepted by the index builder. */
export interface RecipeLike {
  id?: string;
  filePath?: string;
  fileName?: string;
  title?: string;
  category?: string;
  course?: string;
  cuisine?: string;
  tags?: string[];
  difficulty?: string;
  ingredients: IngredientLike[];
}

/** A single derived ingredient concept in the index. */
export interface IngredientIndexEntry {
  /** Conservative canonical identity key. */
  key: string;
  /** A representative human-readable label (first occurrence, not lowercased). */
  displayName: string;
  /** Distinct recipe identities containing this ingredient (deduped, sorted on read). */
  recipeIds: string[];
  /** Number of distinct recipes containing this ingredient. */
  recipeCount: number;
  /** Total raw occurrences across all recipes (including intra-recipe duplicates). */
  occurrenceCount: number;
}

/** The trusted metadata used for CULINARY (dish-family) similarity only. */
export interface RecipeMetadata {
  title: string;
  category?: string;
  course?: string;
  cuisine?: string;
  tags: string[];
  difficulty?: string;
}

/** Per-recipe derived ingredient summary. */
export interface RecipeIngredientProfile {
  recipeId: string;
  /** Unique canonical ingredient keys (deduped). */
  ingredientKeys: string[];
  /** Number of unique ingredient keys. */
  uniqueCount: number;
  /** Total raw ingredient occurrences (including intra-recipe duplicates). */
  occurrenceCount: number;
}

/** The derived relationship index. */
export interface RecipeRelationshipIndex {
  ingredientIndex: Map<string, IngredientIndexEntry>;
  recipeProfiles: Map<string, RecipeIngredientProfile>;
  /** Trusted recipe metadata keyed by stable identity (for culinary similarity). */
  recipeMeta: Map<string, RecipeMetadata>;
}

/** A Jaccard similarity result between two recipes. */
export interface SimilarityResult {
  score: number;
  sharedIngredientKeys: string[];
  sharedCount: number;
  unionCount: number;
}

/** A similarity result paired with a recipe identity. */
export interface SimilarRecipeResult extends SimilarityResult {
  recipeId: string;
  /** Culinary relevance score (0..1) — NOT raw ingredient Jaccard. */
  score: number;
  /** The candidate's recognized dish family, if any. */
  family?: string;
  /** Human-readable justification for the recommendation. */
  reason: string;
  /** Count of shared NON-generic ingredient keys (bonus signal). */
  sharedNonGenericCount: number;
}

/** Options for `findSimilarRecipes`. */
export interface FindSimilarOptions {
  /**
   * Maximum number of results. Defaults to `DEFAULT_SIMILARITY_LIMIT`; clamps to
   * `MAX_SIMILARITY_LIMIT`. `limit >= 0` (0 => []). No throwing on bad input.
   */
  limit?: number;
}

export const DEFAULT_SIMILARITY_LIMIT = 6;
export const MAX_SIMILARITY_LIMIT = 8;

/** Matches a trailing qualitative clause we strip from an ingredient name. */
const QUALITATIVE_SUFFIX =
  /\s+(?:to taste|as needed|as required|as desired|as you like|to your liking|use as needed|enough|optional)\s*$/i;

/**
 * A narrowly-defined, closed set of unambiguous PREPARATION modifiers. A
 * post-comma clause is dropped from the identity ONLY when it begins with one of
 * these; otherwise the comma is treated as a variety/type descriptor that MUST be
 * preserved. Variety descriptors like "black", "kidney", "brown", "wild", "cream",
 * "blue", "Dijon", "olive", "canned", "sun-dried", "roasted red" are deliberately
 * NOT here, so distinct foods never collapse ("beans, black" != "beans, kidney").
 */
const PREP_CUES: readonly string[] = [
  'finely diced',
  'finely chopped',
  'coarsely chopped',
  'coarsely diced',
  'roughly chopped',
  'roughly diced',
  'thinly sliced',
  'diced',
  'chopped',
  'sliced',
  'minced',
  'crushed',
  'grated',
  'shredded',
  'peeled',
  'seeded',
  'drained',
  'rinsed',
  'halved',
  'quartered',
  'julienned',
  'cooked and chopped',
];

/** True when a post-comma clause is an unambiguous preparation modifier. */
function isPrepCue(clause: string): boolean {
  const p = String(clause ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!p) return false;
  return PREP_CUES.some((cue) => p === cue || p.startsWith(`${cue} `));
}

/**
 * Strips a wikilink to its TARGET text for identity purposes
 * ([[Target]] -> Target, [[Target|Alias]] -> Target). Alias/display text is used
 * only for display, never for identity, so distinct explicit vault targets
 * ([[Chicken Breast|chicken]] vs [[Chicken Thigh|chicken]]) remain distinct.
 */
function stripWikilinkTarget(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1');
}

/**
 * Canonical conservative text normalization: case-insensitive, whitespace
 * collapsed, trailing punctuation stripped. Purely local (no dependency on the
 * curated food reference).
 */
function canonicalizeName(text: string): string {
  return String(text)
    .replace(/[.,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Turns a cleaned ingredient name into a conservative canonical identity key.
 * Wikilinks reduce to their target and a trailing qualitative/optional clause is
 * dropped. Returns '' when the result is not meaningful.
 *
 * NOTE: the comma is NOT stripped here. Comma handling is deliberately decided in
 * `resolveIngredientIdentityText` using ONLY the closed preparation cue set, so
 * variety descriptors ("beans, black") are preserved while true preparation
 * ("onion, diced") is dropped.
 */
function finalizeName(name: string): string {
  let n = String(name ?? '').trim();
  if (!n) return '';
  n = stripWikilinkTarget(n);
  // Drop a trailing qualitative clause so "salt to taste" -> "salt".
  if (QUALITATIVE_SUFFIX.test(n)) n = n.replace(QUALITATIVE_SUFFIX, '');
  n = n.replace(/\s*\(optional\)\s*$/i, '');
  return canonicalizeName(n);
}

/**
 * Resolves a conservative identity from raw ingredient text: the canonical parser
 * removes amount/unit; a post-comma clause is dropped only when it is a
 * recognized preparation cue (otherwise it is a variety descriptor and is kept);
 * wikilinks reduce to their target and qualifiers are normalized. Returns '' when
 * not meaningful.
 */
function resolveIngredientIdentityText(text: string): string {
  const parsed = normalizeIngredient(String(text ?? '').trim());
  const head = (parsed.name || String(text ?? '')).trim();
  const prep = (parsed.preparation || '').trim();
  const base = prep ? (isPrepCue(prep) ? head : `${head}, ${prep}`) : head;
  return finalizeName(base);
}

/**
 * Returns the reliable text an ingredient's identity should be derived from.
 * `original` is preserved accurately by the loader; `name` may carry legacy
 * tokenizer corruption, so `original` is preferred.
 */
function sourceText(ingredient: IngredientLike): string {
  const original = ingredient?.original ? String(ingredient.original).trim() : '';
  const name = ingredient?.name ? String(ingredient.name).trim() : '';
  return original || name;
}

/**
 * Computes the conservative canonical ingredient-identity key for a single
 * structured ingredient. Amount and unit are removed via the canonical parser,
 * wikilinks are reduced to their safe display text, qualitative/preparation
 * clauses are dropped, and case/whitespace are normalized. Returns '' when the
 * ingredient has no usable identity.
 */
export function normalizeIngredientIdentity(ingredient: IngredientLike): string {
  const text = sourceText(ingredient);
  if (!text) return '';
  return resolveIngredientIdentityText(text);
}

/**
 * Computes the conservative canonical ingredient-identity key from a plain
 * display string (used by query functions). Accepts "2 eggs", "Eggs",
 * "1 cup flour", "[[Egg|eggs]]", "onion, diced", etc.
 */
export function normalizeIngredientText(text: string): string {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  return resolveIngredientIdentityText(raw);
}

/** A readable representative label for an ingredient (not lowercased). */
function ingredientDisplayName(ingredient: IngredientLike, fallbackKey: string): string {
  const preferred =
    ingredient?.wikilinkAlias ||
    ingredient?.wikilinkTarget ||
    ingredient?.name ||
    ingredient?.original ||
    fallbackKey;
  return String(preferred).replace(/^[-*+]\s*/, '').trim();
}

/**
 * Resolves the stable recipe identity. Prefers the application's `id`, then the
 * vault `filePath`, then `fileName`. Title is deliberately never used alone
 * because duplicate recipe titles are possible.
 */
export function recipeIdentity(recipe: RecipeLike): string {
  return String(recipe?.id || recipe?.filePath || recipe?.fileName || '').trim();
}

/** Returns a trimmed metadata string, or undefined when empty. */
function recipeStringMeta(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  return str || undefined;
}

// ---------------------------------------------------------------------------
// CULINARY SIMILARITY (deterministic, local, read-only) — a dish-family-first
// authority for "Similar Recipes" and Ask My Kitchen's `similarToRecipeId`.
// Ingredient Jaccard overlap remains only a low-level BONUS signal, never the
// ranking authority. No AI, no embeddings, no network, no vault writes.
//
// Invariants: a recipe sharing a generic pantry ingredient must never outrank a
// recipe that is clearly the same culinary type; and a KNOWN culinary-family
// mismatch (both families known + unrelated) can never be overridden by shared
// cuisine/course or shared ingredients.
// ---------------------------------------------------------------------------

/**
 * Common pantry/baseline ingredients that should NOT drive similarity on their
 * own. This is a deliberately small, explicit closed set — not a fuzzy
 * blacklist — and it only governs SIMILARITY noise. Ingredient identity and
 * parser behavior are unchanged.
 */
export const SIMILARITY_GENERIC_INGREDIENT_KEYS: ReadonlySet<string> = new Set([
  'salt',
  'kosher salt',
  'sea salt',
  'black pepper',
  'white pepper',
  'pepper',
  'ground pepper',
  'garlic',
  'garlic powder',
  'garlic cloves',
  'onion',
  'onion powder',
  'butter',
  'oil',
  'olive oil',
  'vegetable oil',
  'canola oil',
  'avocado oil',
  'water',
  'flour',
  'all-purpose flour',
  'bread flour',
  'sugar',
  'granulated sugar',
  'powdered sugar',
]);

function isGenericIngredientKey(key: string): boolean {
  return SIMILARITY_GENERIC_INGREDIENT_KEYS.has(key);
}

/**
 * A small explicit set of GENERIC similarity tags. These may add a little score
 * to an already-credible pair, but they must NEVER establish similarity on
 * their own — two unrelated recipes sharing only "easy"/"quick"/"dinner" are
 * not culinary cousins. Meaningful culinary tags (e.g. "Mexican", "vegetarian",
 * "gluten-free") still contribute freely.
 */
export const SIMILARITY_GENERIC_TAG_KEYS: ReadonlySet<string> = new Set([
  'easy',
  'quick',
  'fast',
  'simple',
  'dinner',
  'family',
  'weeknight',
  'comfort food',
  'comfort-food',
  'everyday',
]);

/**
 * A small, explicit, conservative dish-family ontology. Families are inferred
 * ONLY from trusted metadata (title, tags, and a course fallback) — never from
 * AI, never from ingredient guessing. Unknown recipes have no family.
 *
 * KNOWN EDGE CASES (pinned by tests; these are the current behavior, and a
 * broader classifier taxonomy is deliberately deferred as future refinement):
 *
 *   - "Taco Soup" -> soup   (the soup rule precedes the taco rule; desired)
 *   - "Pizza Sauce" -> pizza (a sauce whose title contains "pizza")
 *   - "Caesar Dressing" -> salad (a dressing whose title contains "caesar")
 *   - "Dessert Pizza" -> pizza
 *   - "Chicken Pot Pie" -> pie
 *
 * The similarity gate keeps these from producing recommendations among truly
 * different dish types, so the edge mislabels do not leak undesired pairings.
 */
const DISH_FAMILY_RULES: ReadonlyArray<readonly [string, readonly RegExp[]]> = [
  ['salad', [/\bsalad(?:s)?\b/i, /\bcaesar\b/i]],
  ['soup', [/\bsoup(?:s)?\b/i, /\bchowder\b/i, /\bminestrone\b/i]],
  ['stew', [/\bstew(?:s)?\b/i, /\bgumbo\b/i]],
  ['chili', [/\bchili\b/i]],
  ['sandwich', [/\bsandwich(?:es)?\b/i, /\bgrinder(?:s)?\b/i, /\bhoagie(?:s)?\b/i]],
  ['burger', [/\bburger(?:s)?\b/i, /\bslider(?:s)?\b/i]],
  ['pizza', [/\bpizza(?:s)?\b/i, /\bcalzone(?:s)?\b/i, /\bstromboli\b/i]],
  ['pasta', [/\bpasta\b/i, /\bspaghetti\b/i, /\bpenne\b/i, /\bfettuccine\b/i, /\blasagna\b/i, /\balfredo\b/i, /\bcarbonara\b/i, /\bmac and cheese\b/i, /\bgnocchi\b/i]],
  ['taco', [/\btaco(?:s)?\b/i]],
  ['burrito', [/\bburrito(?:s)?\b/i]],
  ['enchilada', [/\benchilada(?:s)?\b/i]],
  ['quesadilla', [/\bquesadilla(?:s)?\b/i]],
  ['fajita', [/\bfajita(?:s)?\b/i]],
  ['casserole', [/\bcasserole(?:s)?\b/i]],
  ['bread', [/\bbread(?:s)?\b/i, /\bbaguette\b/i, /\bbiscuit(?:s)?\b/i, /\broll(?:s)?\b/i, /\bfocaccia\b/i]],
  ['cake', [/\bcake(?:s)?\b/i]],
  ['cookie', [/\bcookie(?:s)?\b/i, /\bbiscotti\b/i]],
  ['pie', [/\bpie(?:s)?\b/i, /\btart(?:s)?\b/i, /\bquiche\b/i]],
  ['breakfast', [/\bbreakfast\b/i, /\bpancake(?:s)?\b/i, /\bwaffle(?:s)?\b/i, /\bomelet(?:te)?s?\b/i, /\bfrench toast\b/i]],
  ['dessert', [/\bdessert(?:s)?\b/i]],
  ['drink', [/\bdrink(?:s)?\b/i, /\bjuice\b/i, /\blemonade\b/i, /\bsmoothie\b/i, /\bmilkshake\b/i, /\bmargarita\b/i, /\bagua fresca\b/i]],
  ['sauce', [/\bsauce(?:s)?\b/i, /\bsalsa\b/i]],
  ['dip', [/\bdip(?:s)?\b/i, /\bguacamole\b/i, /\bhummus\b/i]],
  ['side', [/\bside(?:s)?\b/i]],
  ['seafood', [/\b(?:shrimp|salmon|cod|tuna|halibut|fish|scallop(?:s)?|mussel(?:s)?|clam(?:s)?)\b/i]],
  ['chicken', [/\bchicken\b/i]],
  ['beef', [/\bbeef\b/i, /\bsteak\b/i, /\bbrisket\b/i]],
  ['pork', [/\bpork\b/i, /\bham\b/i, /\bbacon\b/i, /\bchorizo\b/i]],
];

/** A course fallback (used only when the title/tags classify nothing). */
const COURSE_FAMILY: ReadonlyArray<readonly [string, string]> = [
  ['dessert', 'dessert'],
  ['breakfast', 'breakfast'],
  ['salad', 'salad'],
  ['soup', 'soup'],
  ['appetizer', 'dip'],
  ['snack', 'side'],
  ['beverage', 'drink'],
  ['drink', 'drink'],
];

/** Families considered closely related (may recommend one another). */
export const RELATED_DISH_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['taco', 'burrito', 'enchilada', 'quesadilla', 'fajita'], // Mexican / Tex-Mex
  ['bread', 'pizza'], // baked dough
  ['soup', 'stew', 'chili'], // hot comfort bowls
  ['burger', 'sandwich'], // hand-held
  ['cake', 'cookie', 'pie', 'dessert'], // sweets
];

const FAMILY_LABEL: Record<string, string> = {
  salad: 'Salad',
  soup: 'Soup',
  stew: 'Stew',
  chili: 'Chili',
  sandwich: 'Sandwich',
  burger: 'Burger',
  pizza: 'Pizza',
  pasta: 'Pasta',
  taco: 'Taco',
  burrito: 'Burrito',
  enchilada: 'Enchilada',
  quesadilla: 'Quesadilla',
  fajita: 'Fajita',
  casserole: 'Casserole',
  bread: 'Bread',
  cake: 'Cake',
  cookie: 'Cookie',
  pie: 'Pie',
  breakfast: 'Breakfast',
  dessert: 'Dessert',
  drink: 'Drink',
  sauce: 'Sauce',
  dip: 'Dip',
  side: 'Side',
  seafood: 'Seafood',
  chicken: 'Chicken',
  beef: 'Beef',
  pork: 'Pork',
};

function familyLabel(family: string): string {
  return FAMILY_LABEL[family] ?? family;
}

/** True when two families are explicitly related (same group). */
export function areRelatedFamilies(a: string, b: string): boolean {
  if (!a || !b) return false;
  return RELATED_DISH_GROUPS.some((group) => group.includes(a) && group.includes(b));
}

/**
 * Infers a conservative dish family from a recipe's trusted metadata. Returns
 * undefined when nothing is recognized — such recipes rely on the culinary
 * fallback. Deterministic and purely local.
 */
export function classifyDishFamily(meta: RecipeMetadata | undefined): string | undefined {
  if (!meta) return undefined;
  const title = String(meta.title ?? '');
  const tagText = (meta.tags ?? []).join(' ');
  const text = `${title} ${tagText}`;
  if (text.trim()) {
    for (const [family, patterns] of DISH_FAMILY_RULES) {
      if (patterns.some((pattern) => pattern.test(text))) return family;
    }
  }
  // Course fallback: use a recognized course only when it names a distinct type.
  const course = String(meta.category ?? meta.course ?? '').trim().toLowerCase();
  if (course) {
    for (const [key, family] of COURSE_FAMILY) {
      if (course === key) return family;
    }
  }
  return undefined;
}

/**
 * Builds a derived ingredient/relationship index over the loaded recipes.
 *
 * Complexity is linear in the total number of ingredient occurrences: each
 * recipe is visited once and each ingredient normalizes once. No recipe pairs
 * are precomputed; similarity is computed on demand.
 *
 * This is read-only derived data: input recipes are never mutated.
 */
export function buildRecipeRelationshipIndex(
  recipes: RecipeLike[]
): RecipeRelationshipIndex {
  const ingredientIndex = new Map<string, IngredientIndexEntry>();
  const recipeProfiles = new Map<string, RecipeIngredientProfile>();
  const recipeMeta = new Map<string, RecipeMetadata>();

  for (const recipe of recipes) {
    const recipeId = recipeIdentity(recipe);
    if (!recipeId) continue;
    const ingredients = recipe?.ingredients;
    if (!Array.isArray(ingredients)) continue;

    recipeMeta.set(recipeId, {
      title: String(recipe?.title ?? '').trim(),
      category: recipeStringMeta(recipe?.category),
      course: recipeStringMeta(recipe?.course),
      cuisine: recipeStringMeta(recipe?.cuisine),
      tags: Array.isArray(recipe?.tags) ? recipe.tags.map(String).map((t) => t.trim()).filter(Boolean) : [],
      difficulty: recipeStringMeta(recipe?.difficulty),
    });

    const keys = new Set<string>();
    let occurrenceCount = 0;

    for (const ingredient of ingredients) {
      const key = normalizeIngredientIdentity(ingredient);
      if (!key) continue;
      occurrenceCount += 1;
      keys.add(key);

      let entry = ingredientIndex.get(key);
      if (!entry) {
        entry = {
          key,
          displayName: ingredientDisplayName(ingredient, key),
          recipeIds: [],
          recipeCount: 0,
          occurrenceCount: 0,
        };
        ingredientIndex.set(key, entry);
      }
      if (!entry.recipeIds.includes(recipeId)) {
        entry.recipeIds.push(recipeId);
        entry.recipeCount = entry.recipeIds.length;
      }
      entry.occurrenceCount += 1;
    }

    recipeProfiles.set(recipeId, {
      recipeId,
      ingredientKeys: Array.from(keys),
      uniqueCount: keys.size,
      occurrenceCount,
    });
  }

  return { ingredientIndex, recipeProfiles, recipeMeta };
}

/**
 * Returns the distinct recipe identities that use an ingredient (given as a
 * display string, normalized internally). Empty when no recipe uses it.
 */
export function getRecipesUsingIngredient(
  index: RecipeRelationshipIndex,
  ingredient: string
): string[] {
  const key = normalizeIngredientText(ingredient);
  if (!key) return [];
  const entry = index.ingredientIndex.get(key);
  return entry ? Array.from(entry.recipeIds).sort() : [];
}

/**
 * Returns frequency metadata for an ingredient (recipeCount + occurrenceCount),
 * normalized from a display string. Undefined when the ingredient is unknown.
 */
export function getIngredientFrequency(
  index: RecipeRelationshipIndex,
  ingredient: string
): { key: string; recipeCount: number; occurrenceCount: number } | undefined {
  const key = normalizeIngredientText(ingredient);
  if (!key) return undefined;
  const entry = index.ingredientIndex.get(key);
  if (!entry) return undefined;
  return {
    key: entry.key,
    recipeCount: entry.recipeCount,
    occurrenceCount: entry.occurrenceCount,
  };
}

/**
 * Returns the derived profile for a recipe, or undefined. Returns a copy so a
 * caller cannot mutate the index through it.
 */
export function getRecipeIngredientProfile(
  index: RecipeRelationshipIndex,
  recipeId: string
): RecipeIngredientProfile | undefined {
  const profile = index.recipeProfiles.get(recipeId);
  if (!profile) return undefined;
  return { ...profile, ingredientKeys: [...profile.ingredientKeys] };
}

/** Returns the trusted metadata for a recipe, or undefined. Returns a copy. */
export function getRecipeMetadata(
  index: RecipeRelationshipIndex,
  recipeId: string
): RecipeMetadata | undefined {
  const meta = index.recipeMeta.get(recipeId);
  if (!meta) return undefined;
  return { ...meta, tags: [...meta.tags] };
}

/**
 * Returns the shared (unique) ingredient keys between two recipes (the
 * intersection of their unique ingredient sets), sorted for determinism.
 */
export function getSharedIngredients(
  index: RecipeRelationshipIndex,
  recipeAId: string,
  recipeBId: string
): string[] {
  const a = index.recipeProfiles.get(recipeAId);
  const b = index.recipeProfiles.get(recipeBId);
  if (!a || !b) return [];
  const bSet = new Set(b.ingredientKeys);
  return a.ingredientKeys.filter((key) => bSet.has(key)).sort();
}

/**
 * Computes a deterministic Jaccard similarity over the two recipes' UNIQUE
 * ingredient keys: sharedCount / unionCount. No weighting, no embeddings, no
 * semantic similarity — a transparent foundation only. Returns 0 for an empty
 * union so division by zero is impossible.
 */
export function scoreRecipeSimilarity(
  index: RecipeRelationshipIndex,
  recipeAId: string,
  recipeBId: string
): SimilarityResult {
  const a = index.recipeProfiles.get(recipeAId);
  const b = index.recipeProfiles.get(recipeBId);
  if (!a || !b) {
    return { score: 0, sharedIngredientKeys: [], sharedCount: 0, unionCount: 0 };
  }
  const sharedIngredientKeys = getSharedIngredients(index, recipeAId, recipeBId);
  const sharedCount = sharedIngredientKeys.length;
  const union = new Set<string>(a.ingredientKeys);
  for (const key of b.ingredientKeys) union.add(key);
  const unionCount = union.size;
  const score = unionCount === 0 ? 0 : sharedCount / unionCount;
  return { score, sharedIngredientKeys, sharedCount, unionCount };
}

/**
 * Finds recipes CULINARILY similar to a given recipe, ranked by a deterministic
 * tiered model (this is the SINGLE similarity authority for the Similar Recipes
 * UI and Ask My Kitchen's `similarToRecipeId`):
 *
 *   1. same dish family (VERY HIGH)
 *   2. related dish family (HIGH)
 *   3. strong metadata-supported plausible match (same cuisine + same course)
 *   4. moderate metadata match (same cuisine OR same course)
 *   5. meaningful shared culinary tags
 *   6. ingredient overlap (BONUS ONLY, generic pantry items ignored)
 *
 * Candidate gating is authoritative: when the source has a recognized family, a
 * candidate must share that/related family. If BOTH source and candidate have
 * known dish families that are neither equal nor explicitly related, the pair is
 * excluded — cuisine/course compatibility and shared ingredients never override
 * a known culinary-family mismatch. Ingredient redundancy is never allowed to
 * make two unrelated dishes look similar.
 *
 * When the source has NO recognized family (or the candidate has none), the
 * rules stay lenient: meaningful ingredient overlap may qualify only as a
 * weaker fallback, never outranking a genuine culinary relationship.
 *
 * Always excludes the source itself, omits weak matches, breaks ties by recipe
 * identity ascending, clamps score to [0, 1], and caps results (default 6,
 * max 8).
 */
export function findSimilarRecipes(
  index: RecipeRelationshipIndex,
  recipeId: string,
  options?: FindSimilarOptions
): SimilarRecipeResult[] {
  const targetProfile = index.recipeProfiles.get(recipeId);
  if (!targetProfile) return [];

  const targetMeta = index.recipeMeta.get(recipeId);
  const targetFamily = classifyDishFamily(targetMeta);
  const targetCuisine = normalizedMetadata(targetMeta?.cuisine);
  const targetCourse = normalizedMetadata(targetMeta?.category ?? targetMeta?.course);
  const targetTags = normalizedTagSet(targetMeta?.tags);
  const targetNonGeneric = Array.from(targetProfile.ingredientKeys).filter((k) => !isGenericIngredientKey(k));
  const targetNonGenericSet = new Set(targetNonGeneric);

  const results: SimilarRecipeResult[] = [];

  for (const otherId of index.recipeProfiles.keys()) {
    if (otherId === recipeId) continue;
    const otherProfile = index.recipeProfiles.get(otherId);
    if (!otherProfile) continue;

    const otherMeta = index.recipeMeta.get(otherId);
    const otherFamily = classifyDishFamily(otherMeta);
    const otherCuisine = normalizedMetadata(otherMeta?.cuisine);
    const otherCourse = normalizedMetadata(otherMeta?.category ?? otherMeta?.course);
    const otherTags = normalizedTagSet(otherMeta?.tags);
    const otherNonGenericSet = new Set(otherProfile.ingredientKeys.filter((k) => !isGenericIngredientKey(k)));

    const sharedIngredientKeys = getSharedIngredients(index, recipeId, otherId);
    const sharedCount = sharedIngredientKeys.length;
    const unionSet = new Set(targetProfile.ingredientKeys);
    for (const key of otherProfile.ingredientKeys) unionSet.add(key);
    const unionCount = unionSet.size;
    const jaccard = unionCount === 0 ? 0 : sharedCount / unionCount;

    const sharedNonGenericCount = targetNonGeneric.filter((k) => otherNonGenericSet.has(k)).length;

    const sameFamily = Boolean(targetFamily && otherFamily && targetFamily === otherFamily);
    const relatedFamily = Boolean(
      targetFamily && otherFamily && targetFamily !== otherFamily && areRelatedFamilies(targetFamily, otherFamily)
    );
    const sameCuisine = Boolean(targetCuisine && otherCuisine && targetCuisine === otherCuisine);
    const sameCourse = Boolean(targetCourse && otherCourse && targetCourse === otherCourse);
    const compatibleCuisineCourse = sameCuisine && sameCourse;
    const sharedTagsCount = countSharedTags(targetTags, otherTags);
    const sharedMeaningfulTagsCount = countSharedMeaningfulTags(targetTags, otherTags);

    // 1) Gate out obviously unrelated candidates. This includes the HARD family
    // mismatch gate below: when BOTH source and candidate have known dish
    // families and those families are neither equal nor explicitly related,
    // neither cuisine+course nor shared ingredients may qualify the pair.
    if (!passesCulinaryGate(targetFamily, otherFamily, targetCuisine, otherCuisine, targetCourse, otherCourse)) {
      continue;
    }

    // 2) Require a genuinely strong match. Generic tags (easy, quick, dinner...)
    // must never qualify an unrelated pair, so only MEANINGFUL tags count here.
    if (
      !sameFamily &&
      !relatedFamily &&
      !compatibleCuisineCourse &&
      sharedMeaningfulTagsCount < 2 &&
      sharedNonGenericCount < MIN_MEANINGFUL_SHARED_NON_GENERIC
    ) {
      continue;
    }

    // 3) Deterministic tiered score (culinary first, ingredients a bonus).
    // order: same family > related family > strong metadata match > moderate
    // metadata match > meaningful tags > ingredient-only fallback. The
    // ingredient-only fallback is capped well below any culinary relationship so
    // it can NEVER outrank a same/related family or a supported cuisine/course.
    const tagBonus = Math.min(0.06, sharedMeaningfulTagsCount * 0.03 + sharedTagsCount * 0.01);
    const ingredientBonus = Math.min(0.10, jaccard * 0.2);
    let score: number;
    if (sameFamily) {
      score =
        0.5 +
        (sameCuisine ? 0.1 : 0) +
        (sameCourse ? 0.05 : 0) +
        tagBonus +
        ingredientBonus;
    } else if (relatedFamily) {
      score =
        0.35 +
        (sameCuisine ? 0.08 : 0) +
        (sameCourse ? 0.04 : 0) +
        tagBonus +
        ingredientBonus;
    } else if (compatibleCuisineCourse) {
      score = 0.22 + tagBonus + ingredientBonus;
    } else if (sameCuisine || sameCourse) {
      score = 0.16 + tagBonus + ingredientBonus;
    } else if (sharedMeaningfulTagsCount >= 1) {
      score = 0.14 + tagBonus + Math.min(0.08, jaccard * 0.15);
    } else {
      // Sparse/unknown-family metadata: ingredient overlap is the only signal,
      // and it is kept modest so it never outranks a culinary relationship.
      score = Math.min(0.12, 0.12 * jaccard);
    }
    score = Math.max(0, Math.min(1, score));

    const reason = buildSimilarityReason({
      sameFamily,
      relatedFamily,
      sameCuisine,
      sameCourse,
      sharedTagsCount,
      sharedNonGenericCount,
      family: otherFamily,
      targetFamily,
      cuisineValue: otherMeta?.cuisine,
      courseValue: otherMeta?.category ?? otherMeta?.course,
      shareNonGenericLabels: sharedIngredientKeys.filter((k) => !isGenericIngredientKey(k)),
    });

    results.push({
      recipeId: otherId,
      score,
      sharedIngredientKeys,
      sharedCount,
      unionCount,
      family: otherFamily,
      reason,
      sharedNonGenericCount,
    });
  }

  results.sort((x, y) => y.score - x.score || x.recipeId.localeCompare(y.recipeId));

  const requested = options?.limit;
  const limit = requested == null || Number.isNaN(requested)
    ? DEFAULT_SIMILARITY_LIMIT
    : Math.max(0, Math.min(MAX_SIMILARITY_LIMIT, requested));
  return limit === 0 ? [] : results.slice(0, limit);
}

const MIN_MEANINGFUL_SHARED_NON_GENERIC = 2;

function normalizedMetadata(value: string | undefined): string | undefined {
  const v = String(value ?? '').trim().toLowerCase();
  return v || undefined;
}

function normalizedTagSet(tags: string[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const tag of tags ?? []) {
    const t = String(tag ?? '').replace(/^#+/, '').trim().toLowerCase();
    if (t) set.add(t);
  }
  return set;
}

function countSharedTags(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const tag of a) if (b.has(tag)) count += 1;
  return count;
}

/** True when a normalized tag is a generic similarity-noise tag. */
function isGenericTag(tag: string): boolean {
  return SIMILARITY_GENERIC_TAG_KEYS.has(tag);
}

/**
 * Counts shared tags that are NOT generic similarity-noise. Two weak/generic
 * tags (easy, quick, dinner, ...) must not qualify an unrelated pair, so only
 * meaningful culinary tags count as qualifying tag evidence.
 */
function countSharedMeaningfulTags(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const tag of a) {
    if (b.has(tag) && !isGenericTag(tag)) count += 1;
  }
  return count;
}

/**
 * Gate: when the source has a recognized STRONG family, a candidate must share
 * that/related family. The HARD family-mismatch gate is authoritative: when BOTH
 * the source and the candidate have known dish families that are neither equal
 * nor explicitly related, cuisine/course compatibility and shared ingredients
 * are NOT enough to qualify the pair (a salad never becomes a "similar" pasta
 * merely because both are Main Course and American).
 *
 * When the source has no recognized family, or the candidate has no recognized
 * family, we stay lenient and let the strong-match rule + deterministic score
 * decide — this is where ingredient overlap may still serve sparse/unknown-family
 * metadata.
 */
function passesCulinaryGate(
  targetFamily: string | undefined,
  otherFamily: string | undefined,
  targetCuisine: string | undefined,
  otherCuisine: string | undefined,
  targetCourse: string | undefined,
  otherCourse: string | undefined
): boolean {
  if (!targetFamily) return true;
  if (otherFamily) {
    if (otherFamily === targetFamily) return true;
    if (areRelatedFamilies(targetFamily, otherFamily)) return true;
    // Both families known and unrelated -> hard mismatch gate.
    return false;
  }
  // Candidate has no recognized family: fall back to lenient metadata checks.
  if (targetCuisine && otherCuisine && targetCuisine === otherCuisine && targetCourse && otherCourse && targetCourse === otherCourse) {
    return true;
  }
  const confirmedConflict =
    (targetCuisine && otherCuisine && targetCuisine !== otherCuisine) ||
    (targetCourse && otherCourse && targetCourse !== otherCourse);
  return !confirmedConflict;
}

interface ReasonParts {
  sameFamily: boolean;
  relatedFamily: boolean;
  sameCuisine: boolean;
  sameCourse: boolean;
  sharedTagsCount: number;
  sharedNonGenericCount: number;
  family?: string;
  targetFamily?: string;
  cuisineValue?: string;
  courseValue?: string;
  shareNonGenericLabels: string[];
}

function capitalizeLabel(value: string | undefined): string | undefined {
  const v = String(value ?? '').trim();
  if (!v) return undefined;
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function buildSimilarityReason(parts: ReasonParts): string {
  const familyLabelValue = parts.family ? familyLabel(parts.family) : '';
  const targetFamilyLabelValue = parts.targetFamily ? familyLabel(parts.targetFamily) : '';

  if (parts.sameFamily) return `Same type · ${familyLabelValue}`;

  if (parts.relatedFamily) {
    if (parts.sameCuisine) {
      return `${capitalizeLabel(parts.cuisineValue) ?? ''} · Related ${targetFamilyLabelValue} dish`.replace(/^\s*·\s*/, '');
    }
    return `Related ${targetFamilyLabelValue}-style dish`;
  }

  if (parts.sameCuisine) {
    if (parts.shareNonGenericLabels.length > 0) {
      return `Same cuisine · ${parts.shareNonGenericLabels.length} shared ingredient${parts.shareNonGenericLabels.length === 1 ? '' : 's'}`;
    }
    return `Same cuisine · ${capitalizeLabel(parts.cuisineValue) ?? ''}`;
  }

  if (parts.sameCourse) {
    return `Same course · ${capitalizeLabel(parts.courseValue) ?? ''}`;
  }

  if (parts.sharedTagsCount > 0) return `Shares tags · ${parts.sharedTagsCount} tag${parts.sharedTagsCount === 1 ? '' : 's'}`;

  if (parts.shareNonGenericLabels.length > 0) {
    return `Shares ${parts.shareNonGenericLabels.length} key ingredient${parts.shareNonGenericLabels.length === 1 ? '' : 's'}`;
  }

  return 'Culinary match';
}
