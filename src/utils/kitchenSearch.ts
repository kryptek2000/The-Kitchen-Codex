/**
 * The Kitchen Codex — Ask My Kitchen Deterministic Retrieval Foundation
 * (v0.4.0 Step 1)
 *
 * A LOCAL, pure, deterministic ground-truth retrieval layer. It turns a
 * structured `KitchenQuery` into a ranked, evidence-bearing set of recipes that
 * are ALREADY loaded from the Obsidian vault. It is the authoritative boundary
 * for "which recipes may be discussed": a future AI layer (Step 2) may explain
 * these results, but it may never search the vault blindly or invent recipes.
 *
 * PRODUCT RULES HONORED:
 *   - PURE & LOCAL: no `fetch()`, no Gemini, no server request, no Markdown
 *     write, no recipe save, no cache/network operation. It only reads the
 *     in-memory recipe objects it is handed.
 *   - ZERO FABRICATION: missing fields stay missing. An unknown total time never
 *     qualifies a `maxTotalMinutes` query; an unknown cuisine never matches a
 *     cuisine requirement; a recipe with no rating never clears a `minRating`
 *     bar; a missing difficulty never matches a difficulty requirement.
 *   - EXACT INGREDIENT IDENTITY: ingredient matching reuses the established
 *     conservative identity logic from `recipeRelationships.ts`. No substring
 *     matching, no fuzzy/semantic matching, no stemming. `black beans` ≠
 *     `kidney beans`, `cream` ≠ `cream cheese`, `rice` ≠ `rice vinegar`.
 *     Wikilinks reduce to their TARGET so distinct explicit vault targets never
 *     collapse through a shared alias (`[[Chicken Breast|chicken]]` ≠
 *     `[[Chicken Thigh|chicken]]`).
 *   - IMMUTABILITY: input recipes and the query object are never mutated.
 *   - SIMILARITY REUSE: `similarToRecipeId` reuses the single deterministic
 *     culinary-similarity authority (`buildRecipeRelationshipIndex` +
 *     `findSimilarRecipes`). No new similarity math, no embeddings, no AI. The
 *     target recipe is always excluded from its own similar-results.
 *
 * MULTI-VALUED vs SINGLE-VALUED FILTER SEMANTICS (deterministic, documented):
 *   - Multi-valued dimensions (includeIngredients, tags) require ALL provided
 *     values to match a recipe.
 *   - Single-valued dimensions (cuisines, courses, difficulties) match ANY of
 *     the provided values against the recipe's one value.
 *   - Singular one-off filters (max time / min rating / favoritesOnly) are
 *     simple thresholds.
 *
 * NOTE ON `course`: the application keeps the meal-course concept in the
 * `category` field (the Markdown parser reads `category`/`course` frontmatter
 * into it, defaulting to "Main Course"). `KitchenQuery.courses` therefore
 * matches against that field.
 */

import type { IngredientLike } from './recipeRelationships';
import {
  buildRecipeRelationshipIndex,
  findSimilarRecipes,
  normalizeIngredientIdentity,
  normalizeIngredientText,
  recipeIdentity,
  type RecipeRelationshipIndex,
  type SimilarRecipeResult,
} from './recipeRelationships';
import { parseDurationToMinutes } from '../schema/recipeValidator';

/**
 * A minimal, flexible recipe shape accepted by the retrieval engine. It is a
 * superset of the relationship layer's `RecipeLike` and is deliberately
 * compatible with the application's `ObsidianRecipe`.
 */
export interface SearchableRecipe {
  id?: string;
  filePath?: string;
  fileName?: string;
  title?: string;
  tags?: string[];
  category?: string;
  cuisine?: string;
  course?: string;
  prepTime?: string | number;
  cookTime?: string | number;
  totalTime?: string | number;
  difficulty?: string;
  rating?: number;
  servings?: number;
  isFavorite?: boolean;
  ingredients: IngredientLike[];
}

/**
 * The structured, deterministic internal query representation. All fields are
 * optional. Every constraint only ever comes from actual indexed recipe data;
 * nothing is inferred.
 *
 * `text` is reserved for Step 2 (natural-language → `KitchenQuery`). The Step 1
 * engine ignores it; it must not be used as a free-text search.
 */
export interface KitchenQuery {
  text?: string;
  /** Recipe must contain ALL of these exact ingredient identities. */
  includeIngredients?: string[];
  /** Recipe must contain NONE of these exact ingredient identities. */
  excludeIngredients?: string[];
  /** Recipe must carry ALL of these tags. */
  tags?: string[];
  /** Recipe's single cuisine must be one of these (ANY). */
  cuisines?: string[];
  /** Recipe's single course (category) must be one of these (ANY). */
  courses?: string[];
  /** Recipe's single difficulty must be one of these (ANY). */
  difficulties?: string[];
  maxPrepMinutes?: number;
  maxCookMinutes?: number;
  maxTotalMinutes?: number;
  minRating?: number;
  favoritesOnly?: boolean;
  /** Restrict to recipes similar to this identity (self excluded). */
  similarToRecipeId?: string;
  /** Cap the number of returned results (after sorting). */
  limit?: number;
}

/**
 * A structured, evidence-bearing retrieval result. `matchedIngredients` and
 * `matchedFields` are factual, and `reasons` are deterministic human-readable
 * strings derived only from the query constraints that were satisfied — never
 * hallucinated prose.
 */
export interface KitchenSearchResult {
  recipe: SearchableRecipe;
  recipeIdentity: string;
  matchedIngredients: string[];
  matchedFields: string[];
  score: number;
  reasons: string[];
  similarity?: SimilarRecipeResult;
}

/**
 * Optional runtime options for a single retrieval call.
 *
 * CALLER CONTRACT FOR `index`: when supplied, it is reused for the
 * `similarToRecipeId` path to avoid rebuilding the culinary similarity index per
 * call. It MUST have been built from the SAME recipe collection passed to
 * `searchKitchenRecipes` (i.e. `buildRecipeRelationshipIndex(recipes)` over the
 * identical array). This is purely a performance reuse contract: no identity
 * comparison or validation is performed, because the caller is the authority.
 * Building it from a different recipe set would yield similarity results that
 * do not correspond to the recipe array being searched.
 */
export interface KitchenSearchOptions {
  /** A prebuilt relationship index built from the SAME recipes array. */
  index?: RecipeRelationshipIndex;
}

/**
 * Deterministic, documented ranking weights.
 *
 * IMPORTANT: `includeIngredients` uses hard ALL semantics, so every eligible
 * recipe already contains ALL requested include ingredients. The ingredient
 * score term is therefore a CONSTANT across eligible results — it is hard-gate
 * bookkeeping, not a within-eligible ranking signal. Within the eligible set,
 * ranking is driven by exact field matches, then similarity (when requested),
 * with rating used only as a tiny secondary/tie-break signal.
 */
export const SCORE_WEIGHTS = {
  ingredient: 10,
  field: 4,
  similarity: 8,
  rating: 1,
} as const;

function recipeString(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  return str || undefined;
}

function normalizeTagValue(tag: unknown): string {
  return String(tag ?? '').replace(/^#+/, '').trim().toLowerCase();
}

function normalizeValue(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function recipeRating(recipe: SearchableRecipe): number {
  const val = typeof recipe.rating === 'number' ? recipe.rating : Number(recipe.rating);
  if (typeof val !== 'number' || isNaN(val)) return 0;
  return Math.max(0, Math.min(5, val));
}

/** Returns the recipe's single course concept (prefers category, then course). */
function recipeCourse(recipe: SearchableRecipe): string {
  return recipeString(recipe.category) || recipeString(recipe.course) || '';
}

function recipeCuisine(recipe: SearchableRecipe): string {
  return recipeString(recipe.cuisine) || '';
}

function recipeDifficulty(recipe: SearchableRecipe): string {
  return recipeString(recipe.difficulty) || '';
}

/**
 * The recipe's unique, conservative ingredient-identity keys (deduped).
 * Reuses the exact identity logic from the relationship layer.
 */
function recipeIngredientKeys(recipe: SearchableRecipe): Set<string> {
  const keys = new Set<string>();
  for (const ingredient of recipe?.ingredients ?? []) {
    const key = normalizeIngredientIdentity(ingredient);
    if (key) keys.add(key);
  }
  return keys;
}

/** Normalizes query ingredient terms to exact identity keys (deduped, ordered). */
function ingredientQueryKeys(terms: string[] | undefined): string[] {
  if (!terms) return [];
  const keys = new Set<string>();
  for (const term of terms) {
    const key = normalizeIngredientText(String(term ?? '').trim());
    if (key) keys.add(key);
  }
  return Array.from(keys);
}

function normalizeTags(terms: string[] | undefined): string[] {
  if (!terms) return [];
  const tags = new Set<string>();
  for (const term of terms) {
    const tag = normalizeTagValue(term);
    if (tag) tags.add(tag);
  }
  return Array.from(tags);
}

function normalizeValues(terms: string[] | undefined): string[] {
  if (!terms) return [];
  const values = new Set<string>();
  for (const term of terms) {
    const value = normalizeValue(term);
    if (value) values.add(value);
  }
  return Array.from(values);
}

function withinMax(actual: number | null, max: number | undefined): boolean {
  if (max === undefined || max === null) return true;
  // Missing data must never be treated as zero for query qualification.
  if (actual === null) return false;
  return actual <= max;
}

/**
 * Resolves a recipe's prep time to integer minutes, or null when unknown.
 * Reuses the canonical duration parser; never invents a value.
 */
export function resolvePrepMinutes(recipe: SearchableRecipe): number | null {
  return parseDurationToMinutes(recipeString(recipe.prepTime));
}

/**
 * Resolves a recipe's cook time to integer minutes, or null when unknown.
 */
export function resolveCookMinutes(recipe: SearchableRecipe): number | null {
  return parseDurationToMinutes(recipeString(recipe.cookTime));
}

/**
 * Resolves a recipe's total time to integer minutes, or null when unknown.
 *
 * An explicit total is authoritative. Otherwise total = prep + cook ONLY when
 * BOTH are valid finite numbers. When either is missing the total is unknown
 * (`null`) and is never guessed, so a `maxTotalMinutes` query cannot wrongly
 * qualify a recipe with ambiguous timing.
 */
export function resolveTotalMinutes(recipe: SearchableRecipe): number | null {
  const explicit = parseDurationToMinutes(recipeString(recipe.totalTime));
  if (explicit !== null) return explicit;
  const prep = resolvePrepMinutes(recipe);
  const cook = resolveCookMinutes(recipe);
  if (prep !== null && cook !== null) return prep + cook;
  return null;
}

/** A single computed evidence/reason string from a satisfied constraint. */
export interface EvidenceReason {
  label: string;
  reason: string;
}

/**
 * The deterministic retrieval engine. Returns recipes matching the query's hard
 * filters, ranked by the documented weights, with factual evidence. Never
 * mutates recipes or the query. Same input always produces the same order.
 */
export function searchKitchenRecipes(
  recipes: SearchableRecipe[],
  query: KitchenQuery = {},
  options: KitchenSearchOptions = {}
): KitchenSearchResult[] {
  const includeKeys = ingredientQueryKeys(query.includeIngredients);
  const excludeKeys = ingredientQueryKeys(query.excludeIngredients);
  const queryTags = normalizeTags(query.tags);
  const queryTagSet = new Set(queryTags);
  const cuisines = normalizeValues(query.cuisines);
  const cuisineSet = new Set(cuisines);
  const courses = normalizeValues(query.courses);
  const courseSet = new Set(courses);
  const difficulties = normalizeValues(query.difficulties);
  const difficultySet = new Set(difficulties);
  const maxPrep = query.maxPrepMinutes;
  const maxCook = query.maxCookMinutes;
  const maxTotal = query.maxTotalMinutes;
  const minRating = query.minRating;
  const favoritesOnly = Boolean(query.favoritesOnly);

  // Similarity data: reuse the single culinary-similarity authority.
  let similarityById: Map<string, SimilarRecipeResult> | null = null;
  if (query.similarToRecipeId) {
    const similarityTarget = query.similarToRecipeId;
    const index = options.index ?? buildRecipeRelationshipIndex(recipes);
    const similar = findSimilarRecipes(index, similarityTarget);
    similarityById = new Map(similar.map((s) => [s.recipeId, s]));
    // The target recipe is always excluded from its own similar-results list.
    similarityById.delete(similarityTarget);
  }

  const results: KitchenSearchResult[] = [];

  for (const recipe of recipes ?? []) {
    const identity = recipeIdentity(recipe);
    if (!identity) continue;

    const ingredientKeys = recipeIngredientKeys(recipe);

    // --- Hard ingredient filters (exact identity, ALL / NONE semantics) ---
    let includeOk = true;
    for (const key of includeKeys) {
      if (!ingredientKeys.has(key)) {
        includeOk = false;
        break;
      }
    }
    if (!includeOk) continue;

    let excludeOk = true;
    for (const key of excludeKeys) {
      if (ingredientKeys.has(key)) {
        excludeOk = false;
        break;
      }
    }
    if (!excludeOk) continue;

    // --- Tag filters (ALL semantics) ---
    const recipeTagSet = new Set((recipe.tags ?? []).map(normalizeTagValue));
    let tagsOk = true;
    for (const tag of queryTags) {
      if (!recipeTagSet.has(tag)) {
        tagsOk = false;
        break;
      }
    }
    if (!tagsOk) continue;

    // --- Single-valued dimension filters (ANY semantics) ---
    if (cuisineSet.size > 0 && !cuisineSet.has(normalizeValue(recipeCuisine(recipe)))) {
      continue;
    }
    if (courseSet.size > 0 && !courseSet.has(normalizeValue(recipeCourse(recipe)))) {
      continue;
    }
    if (difficultySet.size > 0 && !difficultySet.has(normalizeValue(recipeDifficulty(recipe)))) {
      continue;
    }

    // --- Time / rating / favorite filters (thresholds) ---
    if (!withinMax(resolvePrepMinutes(recipe), maxPrep)) continue;
    if (!withinMax(resolveCookMinutes(recipe), maxCook)) continue;
    if (!withinMax(resolveTotalMinutes(recipe), maxTotal)) continue;

    const rating = recipeRating(recipe);
    if (minRating !== undefined && minRating !== null && rating < minRating) continue;
    if (favoritesOnly && recipe.isFavorite !== true) continue;

    // --- Similarity filter ---
    let similarity: SimilarRecipeResult | undefined;
    if (similarityById) {
      similarity = similarityById.get(identity);
      if (!similarity) continue;
    }

    // --- Evidence (factual, deterministic) ---
    const matchedIngredients: string[] = [];
    const fieldLabels: string[] = [];
    const reasons: string[] = [];

    for (const key of includeKeys) {
      if (ingredientKeys.has(key)) {
        matchedIngredients.push(key);
        reasons.push(`contains "${key}"`);
      }
    }

    for (const tag of queryTags) {
      if (recipeTagSet.has(tag)) {
        fieldLabels.push(`tag:${tag}`);
        reasons.push(`tag: ${tag}`);
      }
    }

    if (cuisineSet.size > 0 && cuisineSet.has(normalizeValue(recipeCuisine(recipe)))) {
      const value = recipeCuisine(recipe);
      fieldLabels.push(`cuisine:${normalizeValue(value)}`);
      reasons.push(`cuisine: ${value}`);
    }

    if (courseSet.size > 0 && courseSet.has(normalizeValue(recipeCourse(recipe)))) {
      const value = recipeCourse(recipe);
      fieldLabels.push(`course:${normalizeValue(value)}`);
      reasons.push(`course: ${value}`);
    }

    if (difficultySet.size > 0 && difficultySet.has(normalizeValue(recipeDifficulty(recipe)))) {
      const value = recipeDifficulty(recipe);
      fieldLabels.push(`difficulty:${normalizeValue(value)}`);
      reasons.push(`difficulty: ${value}`);
    }

    if (maxPrep !== undefined && maxPrep !== null) {
      const actual = resolvePrepMinutes(recipe);
      if (actual !== null && actual <= maxPrep) {
        fieldLabels.push(`prep<=${maxPrep}`);
        reasons.push(`prep time <= ${maxPrep} minutes`);
      }
    }
    if (maxCook !== undefined && maxCook !== null) {
      const actual = resolveCookMinutes(recipe);
      if (actual !== null && actual <= maxCook) {
        fieldLabels.push(`cook<=${maxCook}`);
        reasons.push(`cook time <= ${maxCook} minutes`);
      }
    }
    if (maxTotal !== undefined && maxTotal !== null) {
      const actual = resolveTotalMinutes(recipe);
      if (actual !== null && actual <= maxTotal) {
        fieldLabels.push(`total<=${maxTotal}`);
        reasons.push(`total time <= ${maxTotal} minutes`);
      }
    }

    if (minRating !== undefined && minRating !== null && rating >= minRating) {
      fieldLabels.push(`rating>=${minRating}`);
      reasons.push(`rating >= ${minRating}`);
    }

    if (favoritesOnly) {
      fieldLabels.push('favorite');
      reasons.push('is favorite');
    }

    if (similarity) {
      // Use the culinary justification (e.g. "Same type · Taco") rather than a
      // raw Jaccard number; the numeric relevance stays on `similarity.score`.
      reasons.push(similarity.reason);
    }

    // --- Score (deterministic, documented weights) ---
    // `matchedIngredients.length` is a constant here (hard ALL gate already
    // ensured every eligible recipe contains all include keys), so it is
    // bookkeeping rather than within-eligible ranking strength.
    const ingredientContribution = matchedIngredients.length * SCORE_WEIGHTS.ingredient;
    const fieldContribution = fieldLabels.length * SCORE_WEIGHTS.field;
    const similarityContribution = similarity ? similarity.score * SCORE_WEIGHTS.similarity : 0;
    const ratingContribution = (rating / 5) * SCORE_WEIGHTS.rating;
    const score =
      ingredientContribution + fieldContribution + similarityContribution + ratingContribution;

    results.push({
      recipe,
      recipeIdentity: identity,
      matchedIngredients,
      matchedFields: fieldLabels,
      score,
      reasons,
      similarity,
    });
  }

  // Deterministic ordering: score descending, then recipe identity ascending.
  results.sort(
    (a, b) => b.score - a.score || a.recipeIdentity.localeCompare(b.recipeIdentity)
  );

  // --- Limit semantics (documented, behavior-preserving) ---
  //   limit >= 0   (including 0)  -> cap results to `limit` (0 => [])
  //   limit < 0                    -> interpreted as "no limit" (return all)
  //   limit NaN                    -> interpreted as "no limit" (return all)
  //   limit undefined / null       -> "no limit" (return all)
  // There is deliberately NO throwing behavior: an invalid numeric value
  // resolves to "no limit" rather than raising an error.
  const limit = query.limit;
  const hasValidLimit = typeof limit === 'number' && !Number.isNaN(limit) && limit >= 0;
  return hasValidLimit ? results.slice(0, limit) : results;
}
