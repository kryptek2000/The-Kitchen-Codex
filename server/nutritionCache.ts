/**
 * The Kitchen Codex — Deterministic Nutrition Cache (v0.3.0 Step 5)
 *
 * A small, bounded, in-memory LRU cache for WHOLE-RECIPE deterministic
 * (source = 'database') nutrition results.
 *
 * NON-AUTHORITATIVE: a cache entry is a performance optimization, NOT a source
 * of nutrition truth. Every cached value was originally produced by the
 * deterministic engine (`estimateDeterministicNutrition`) and carries its exact
 * provenance (source = 'database') and its exact application-assigned
 * confidence. The cache NEVER invents, revises, or fabricates nutrition; it only
 * memoizes an ELIGIBLE, SUFFICIENT deterministic result on the precise
 * nutrition-relevant inputs that produced it.
 *
 * DESIGN DECISIONS (documented):
 *
 *  - SCOPE: in-memory only. It resets on server restart, which is acceptable
 *    for Step 5 (a runtime optimization).
 *  - AUTHORITY: caches ONLY eligible/sufficient deterministic results
 *    (source = 'database'). It never caches ai_estimate / offline_heuristic /
 *    user_defined / source_metadata. It never caches a partial (ineligible)
 *    deterministic result as if it were complete. The estimator only calls the
 *    cache setter on the eligible branch, so a Gemini/offline fallback is never
 *    inserted no matter how it reaches the fallback path.
 *  - KEY: derived ONLY from nutrition-relevant inputs (see
 *    buildDeterministicCacheKey). It is independent of any requested serving
 *    display count, title, UI state, favorites, or notes. Serving arithmetic is
 *    deliberately left to the existing nutritionForServings contract.
 *  - ORDER: ingredient order is intentionally IGNORED. Deterministic nutrition
 *    is a commutative sum of independent per-ingredient contributions, and no
 *    per-ingredient parse/matching depends on the position of an ingredient, so
 *    [flour, eggs] and [eggs, flour] share a key and a result. The canonical
 *    ingredient list is sorted before it is hashed.
 *  - BOUNDS / EVICTION: a bounded Map-based basic LRU
 *    (MAX_DETERMINISTIC_CACHE_SIZE entries, default 128). Map preserves
 *    insertion order, and entries are re-inserted on access so the oldest /
 *    least-recently-used entry is evicted first. No external dependency.
 *  - IMMUTABILITY: each cached result is stored as an Object.freeze'd snapshot.
 *    The result shape is flat (primitive number/string fields only), so a
 *    shallow freeze is a complete freeze with no expensive deep clone. The
 *    getter returns a defensive shallow copy, so a caller mutating the returned
 *    object cannot poison later cache hits.
 *  - VERSIONING: the key embeds (a) an explicit algorithm version constant that
 *    a developer must bump when the deterministic algorithm changes, and
 *    (b) a data fingerprint derived by hashing the curated FOOD_REFERENCES, so a
 *    food-panel edit automatically invalidates every derived key. The in-memory
 *    cache normally resets with the process anyway; these are a defense-in-depth
 *    guard for long-running / hot-reloaded processes.
 */

import { createHash } from 'node:crypto';
import { FOOD_REFERENCES } from '../src/data/foodReference';
import { normalizeUnit, parseAmount } from '../src/utils/measurements';
import {
  toIngredientParts,
  type DeterministicIngredient,
} from './deterministicNutrition';
import type { NutritionEstimateResult } from './nutritionEstimator';

/** Maximum number of cached deterministic whole-recipe results. Modest, bounded. */
export const MAX_DETERMINISTIC_CACHE_SIZE = 128;

/**
 * Explicit deterministic-algorithm version. Bump ONLY when changing the
 * deterministic estimation ALGORITHM in `server/deterministicNutrition.ts` so
 * that stale keys from the previous algorithm never collide.
 */
export const DETERMINISTIC_ALGORITHM_VERSION = 'v1';

/**
 * Fingerprint of the curated food reference data. Derived by hashing the exact
 * serialized FOOD_REFERENCES so that any edit to `src/data/foodReference.ts`
 * (new foods, changed per-100g values, densities, count weights) automatically
 * changes every derived cache key and invalidates stale entries in a
 * long-running process.
 */
export const FOOD_REFERENCE_FINGERPRINT: string = createHash('sha256')
  .update(JSON.stringify(FOOD_REFERENCES))
  .digest('hex');

/** Case-invariant / whitespace-canonical text for cache-key derivation. */
function normalizeKeyText(value: string): string {
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Produces a single stable, order-independent canonical string for one
 * ingredient. It reuses the engine's own `toIngredientParts` so the key reflects
 * the EXACT inputs the engine consumes, then normalizes:
 *
 *   - name        : case-insensitive, whitespace-collapsed food-match text.
 *   - unit        : normalized via the canonical unit normalizer (or 'none').
 *   - amount      : parsed numeric quantity (unifies string/number inputs).
 *   - originalText: case-insensitive, whitespace-collapsed working text.
 *
 * `originalText` is intentionally included: a qualitative cue can appear in the
 * original string even when a structured `name`/`amount` are identical (e.g.
 * `{ name: 'salt', original: 'salt, to taste' }` vs `{ name: 'salt' }`), and the
 * engine's qualitative/eligibility decision reads that text. Including it keeps
 * the key faithful to the eligibility outcome, at the cost of a conservative
 * miss when two semantically-equivalent ingredient strings differ cosmetically.
 */
function canonicalizeIngredient(item: DeterministicIngredient): string {
  const parts = toIngredientParts(item);
  const name = normalizeKeyText(parts.name);
  const unit = normalizeUnit(parts.unit) ?? 'none';
  const amount = parseAmount(parts.amount);
  const original = normalizeKeyText(parts.originalText);
  return JSON.stringify([name, unit, amount, original]);
}

/**
 * Builds the deterministic cache key for a whole recipe.
 *
 * The key covers only nutrition-relevant inputs (each ingredient's derived
 * name/unit/amount/original text) plus the algorithm + food-reference versions.
 * It is NOT affected by the requested serving count, title, or any UI/notes
 * metadata. Ingredient order is ignored (the canonical ingredient strings are
 * sorted), matching the commutative nature of nutrition summation.
 */
export function buildDeterministicCacheKey(
  ingredients: DeterministicIngredient[]
): string {
  const canonical = ingredients.map(canonicalizeIngredient).sort();
  const payload = `${DETERMINISTIC_ALGORITHM_VERSION}::${FOOD_REFERENCE_FINGERPRINT}::${JSON.stringify(canonical)}`;
  return createHash('sha256').update(payload).digest('hex');
}

// Bounded LRU: a Map whose insertion order is the least-recently-used order and
// whose most-recently-used end is the tail.
const cache = new Map<string, NutritionEstimateResult>();
let hits = 0;
let misses = 0;
let evictions = 0;

/**
 * Stores a deterministic result under `cacheKey`, evicting the least-recently
 * used entry if the cache is at capacity. The stored value is an immutable
 * (Object.freeze'd) snapshot, not caller-held mutable state.
 */
export function setDeterministicNutritionCache(
  cacheKey: string,
  result: NutritionEstimateResult
): void {
  if (cache.has(cacheKey)) cache.delete(cacheKey);
  if (cache.size >= MAX_DETERMINISTIC_CACHE_SIZE) {
    const lru: string | undefined = cache.keys().next().value as string | undefined;
    if (lru !== undefined) {
      cache.delete(lru);
      evictions += 1;
    }
  }
  // The result shape is flat/primitives-only, so a shallow freeze is complete.
  cache.set(cacheKey, Object.freeze({ ...result }));
}

/**
 * Returns an immutable snapshot of a cached deterministic result, or undefined
 * on a miss. A hit moves the entry to the most-recently-used end and returns a
 * defensive shallow copy so the caller cannot mutate the cached value. Entries
 * store source = 'database' and the exact deterministic confidence.
 */
export function getDeterministicNutritionCache(
  cacheKey: string
): NutritionEstimateResult | undefined {
  if (!cache.has(cacheKey)) {
    misses += 1;
    return undefined;
  }
  hits += 1;
  const value: NutritionEstimateResult = cache.get(cacheKey) as NutritionEstimateResult;
  cache.delete(cacheKey);
  cache.set(cacheKey, value); // move to MRU end
  return { ...value };
}

/** Clears the cache and resets hit/miss/eviction diagnostics (mainly for tests). */
export function clearDeterministicNutritionCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
  evictions = 0;
}

/** Number of entries currently cached. */
export function getDeterministicNutritionCacheSize(): number {
  return cache.size;
}

/** Read-only diagnostics snapshot (hits/misses/size/maxSize/evictions). */
export function getDeterministicCacheStats(): {
  hits: number;
  misses: number;
  size: number;
  maxSize: number;
  evictions: number;
} {
  return {
    hits,
    misses,
    size: cache.size,
    maxSize: MAX_DETERMINISTIC_CACHE_SIZE,
    evictions,
  };
}
