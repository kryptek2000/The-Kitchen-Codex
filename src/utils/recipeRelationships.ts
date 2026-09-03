/**
 * The Kitchen Codex — Recipe Relationship / Ingredient Index Foundation
 * (v0.3.0 Step 6)
 *
 * A PURE, deterministic, dependency-light derived-data layer that turns the
 * application's already-loaded `ObsidianRecipe` objects into a reusable
 * ingredient index and a simple (Jaccard) recipe-similarity foundation.
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
}

/** Options for `findSimilarRecipes`. */
export interface FindSimilarOptions {
  /** Maximum number of results to return (after sorting). */
  limit?: number;
}

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

  for (const recipe of recipes) {
    const recipeId = recipeIdentity(recipe);
    if (!recipeId) continue;
    const ingredients = recipe?.ingredients;
    if (!Array.isArray(ingredients)) continue;

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

  return { ingredientIndex, recipeProfiles };
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
 * Finds recipes similar to a given recipe, ranked by Jaccard score descending.
 * Always excludes the recipe itself, omits zero-overlap results (no
 * "recommendations" from no shared ingredients), and breaks ties
 * deterministically by recipe identity ascending. `limit` caps the results.
 */
export function findSimilarRecipes(
  index: RecipeRelationshipIndex,
  recipeId: string,
  options?: FindSimilarOptions
): SimilarRecipeResult[] {
  const target = index.recipeProfiles.get(recipeId);
  if (!target) return [];

  const results: SimilarRecipeResult[] = [];
  for (const otherId of index.recipeProfiles.keys()) {
    if (otherId === recipeId) continue;
    const sim = scoreRecipeSimilarity(index, recipeId, otherId);
    if (sim.sharedCount === 0) continue;
    results.push({
      recipeId: otherId,
      score: sim.score,
      sharedIngredientKeys: sim.sharedIngredientKeys,
      sharedCount: sim.sharedCount,
      unionCount: sim.unionCount,
    });
  }

  results.sort(
    (x, y) => y.score - x.score || x.recipeId.localeCompare(y.recipeId)
  );

  if (options?.limit != null && options.limit >= 0) {
    return results.slice(0, options.limit);
  }
  return results;
}
