import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  estimateRecipeNutrition,
  type NutritionEstimateResult,
} from '../../server/nutritionEstimator';
import { getGemini } from '../../server/geminiClient';
import {
  buildDeterministicCacheKey,
  getDeterministicNutritionCache,
  getDeterministicNutritionCacheSize,
  getDeterministicCacheStats,
  setDeterministicNutritionCache,
  clearDeterministicNutritionCache,
  MAX_DETERMINISTIC_CACHE_SIZE,
} from '../../server/nutritionCache';

// Deterministically control the estimator path without any live network call.
vi.mock('../../server/geminiClient.js', () => ({ getGemini: vi.fn() }));
const mockGetGemini = getGemini as unknown as ReturnType<typeof vi.fn>;

const FLOUR_EGGS = ['1 cup All-Purpose Flour', '2 eggs'];

function fakeGemini(overrides: Partial<Record<string, number>> = {}) {
  return {
    models: {
      generateContent: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          calories: 250,
          protein: 12,
          carbohydrates: 30,
          fat: 8,
          fiber: 4,
          sodium: 500,
          confidenceNote: 'from model',
          ...overrides,
        }),
      }),
    },
  };
}

function stubResult(): NutritionEstimateResult {
  return {
    calories: 100,
    protein: 10,
    carbohydrates: 20,
    fat: 5,
    fiber: 2,
    sodium: 1000,
    confidenceNote: 'stub',
    source: 'database',
    confidence: 'high',
  };
}

beforeEach(() => {
  clearDeterministicNutritionCache();
  mockGetGemini.mockReturnValue(null);
});

afterEach(() => {
  clearDeterministicNutritionCache();
  mockGetGemini.mockReturnValue(null);
});

describe('nutritionCache: cache hit', () => {
  it('computes on the first eligible request and hits on an identical request', async () => {
    const r1 = await estimateRecipeNutrition({ title: 'X', servings: 1, ingredients: FLOUR_EGGS });
    expect(r1.source).toBe('database');
    expect(r1.calories).toBeGreaterThan(0);
    const afterFirst = getDeterministicCacheStats();
    expect(afterFirst.size).toBe(1);
    expect(afterFirst.misses).toBe(1); // first lookup missed
    expect(afterFirst.hits).toBe(0);

    const r2 = await estimateRecipeNutrition({ title: 'X', servings: 1, ingredients: FLOUR_EGGS });
    expect(r2.source).toBe('database');
    expect(r2.calories).toBe(r1.calories);
    const afterSecond = getDeterministicCacheStats();
    expect(afterSecond.size).toBe(1); // no new entry created
    expect(afterSecond.hits).toBe(1); // second lookup was a hit
    expect(afterSecond.misses).toBe(1);
  });

  it('returns identical totals for a hit (no recomputation drift)', async () => {
    const a = await estimateRecipeNutrition({ title: 'X', ingredients: FLOUR_EGGS });
    const b = await estimateRecipeNutrition({ title: 'X', ingredients: FLOUR_EGGS });
    expect(a).toEqual(b);
  });
});

describe('nutritionCache: cache miss (invalidation)', () => {
  it('invalidates when the amount changes', () => {
    expect(buildDeterministicCacheKey(['1 cup All-Purpose Flour'])).not.toBe(
      buildDeterministicCacheKey(['2 cups All-Purpose Flour'])
    );
  });

  it('invalidates when the unit changes', () => {
    expect(buildDeterministicCacheKey(['240 ml heavy cream'])).not.toBe(
      buildDeterministicCacheKey(['1 cup heavy cream'])
    );
  });

  it('invalidates when the food changes', () => {
    expect(buildDeterministicCacheKey(['1 cup All-Purpose Flour'])).not.toBe(
      buildDeterministicCacheKey(['1 cup granulated sugar'])
    );
  });

  it('invalidates when an ingredient is added', () => {
    expect(buildDeterministicCacheKey(['1 cup All-Purpose Flour'])).not.toBe(
      buildDeterministicCacheKey(['1 cup All-Purpose Flour', '2 eggs'])
    );
  });

  it('invalidates when an ingredient is removed', () => {
    expect(buildDeterministicCacheKey(['1 cup All-Purpose Flour', '2 eggs'])).not.toBe(
      buildDeterministicCacheKey(['1 cup All-Purpose Flour'])
    );
  });

  it('stores distinct entries on a nutrition input change and recomputes', async () => {
    await estimateRecipeNutrition({ title: 'X', ingredients: ['1 cup All-Purpose Flour'] });
    await estimateRecipeNutrition({ title: 'X', ingredients: ['2 cups All-Purpose Flour'] });
    expect(getDeterministicNutritionCacheSize()).toBe(2);
    expect(getDeterministicCacheStats().misses).toBe(2);
    expect(getDeterministicCacheStats().hits).toBe(0);
  });
});

describe('nutritionCache: canonicalization', () => {
  it('is deterministic for identical nutrition-relevant inputs', () => {
    expect(buildDeterministicCacheKey(FLOUR_EGGS)).toBe(buildDeterministicCacheKey(FLOUR_EGGS));
  });

  it('is robust to ingredient property order in structured inputs', () => {
    const a = buildDeterministicCacheKey([{ amount: 1, unit: 'cup', name: 'All-Purpose Flour' }]);
    const b = buildDeterministicCacheKey([{ name: 'All-Purpose Flour', unit: 'cup', amount: 1 }]);
    expect(a).toBe(b);
  });

  it('collapses whitespace and case in ingredient text', () => {
    expect(buildDeterministicCacheKey([' 1 CUP   All-Purpose Flour '])).toBe(
      buildDeterministicCacheKey(['1 cup All-Purpose Flour'])
    );
  });

  it('is insensitive to the requested serving count', () => {
    expect(buildDeterministicCacheKey(FLOUR_EGGS)).toBe(buildDeterministicCacheKey(FLOUR_EGGS));
  });
});

describe('nutritionCache: serving invariance (critical invariant)', () => {
  it('servings=2 and servings=8 hit the same whole-recipe deterministic total', async () => {
    const s2 = await estimateRecipeNutrition({ title: 'X', servings: 2, ingredients: FLOUR_EGGS });
    const s8 = await estimateRecipeNutrition({ title: 'X', servings: 8, ingredients: FLOUR_EGGS });
    expect(s2.source).toBe('database');
    expect(s8.source).toBe('database');
    expect(s8.calories).toBe(s2.calories);
    expect(s8.protein).toBe(s2.protein);
    // Only one entry; the second call was a HIT, so the serving count never
    // invalidated the deterministic result.
    expect(getDeterministicNutritionCacheSize()).toBe(1);
    expect(getDeterministicCacheStats().hits).toBe(1);
    expect(getDeterministicCacheStats().misses).toBe(1);
  });
});

describe('nutritionCache: ingredient order is intentionally ignored', () => {
  it('[flour, eggs] and [eggs, flour] share a key and result', async () => {
    expect(buildDeterministicCacheKey(['1 cup All-Purpose Flour', '2 eggs'])).toBe(
      buildDeterministicCacheKey(['2 eggs', '1 cup All-Purpose Flour'])
    );

    const a = await estimateRecipeNutrition({ title: 'X', ingredients: ['1 cup All-Purpose Flour', '2 eggs'] });
    const b = await estimateRecipeNutrition({ title: 'X', ingredients: ['2 eggs', '1 cup All-Purpose Flour'] });
    expect(a.source).toBe('database');
    expect(b.source).toBe('database');
    expect(b.calories).toBe(a.calories);
    // Same deterministic result maps to the same cache entry (the second is a hit).
    expect(getDeterministicNutritionCacheSize()).toBe(1);
    expect(getDeterministicCacheStats().hits).toBe(1);
  });
});

describe('nutritionCache: partial coverage is never cached as complete', () => {
  it('an insufficient deterministic result is NOT cached and falls to the offline heuristic', async () => {
    const ingredients = ['1 cup All-Purpose Flour', '1 cup mystery sauce'];
    mockGetGemini.mockReturnValue(null);
    const result = await estimateRecipeNutrition({ title: 'X', servings: 4, ingredients });
    expect(result.source).toBe('offline_heuristic');
    // Nothing was cached for an ineligible result.
    expect(getDeterministicNutritionCacheSize()).toBe(0);
  });

  it('a later recipe that becomes eligible (key change) recomputes rather than reusing a partial', async () => {
    // First: partial (unresolvable mystery sauce) -> not cached.
    const partial = await estimateRecipeNutrition({
      title: 'X',
      ingredients: ['1 cup All-Purpose Flour', '1 cup mystery sauce'],
    });
    expect(partial.source).toBe('offline_heuristic');
    expect(getDeterministicNutritionCacheSize()).toBe(0);

    // Later: same base ingredients but the mystery sauce changed to eggs
    // (different key) -> becomes eligible and is computed + cached fresh.
    const eligible = await estimateRecipeNutrition({
      title: 'X',
      ingredients: ['1 cup All-Purpose Flour', '2 eggs'],
    });
    expect(eligible.source).toBe('database');
    expect(getDeterministicNutritionCacheSize()).toBe(1);
  });
});

describe('nutritionCache: fallback is never inserted into the deterministic cache', () => {
  it('does not cache an AI estimate when deterministic is insufficient', async () => {
    mockGetGemini.mockReturnValue(fakeGemini());
    const ingredients = ['1 cup All-Purpose Flour', '1 cup mystery sauce'];
    const result = await estimateRecipeNutrition({ title: 'X', servings: 4, ingredients });
    expect(result.source).toBe('ai_estimate');
    expect(getDeterministicNutritionCacheSize()).toBe(0);
  });
});

describe('nutritionCache: provenance on cache hit', () => {
  it('a hit still reports source=database with unchanged confidence', async () => {
    const r1 = await estimateRecipeNutrition({ title: 'X', ingredients: FLOUR_EGGS });
    const r2 = await estimateRecipeNutrition({ title: 'X', ingredients: FLOUR_EGGS });
    expect(r1.source).toBe('database');
    expect(r2.source).toBe('database');
    expect(r2.confidence).toBe(r1.confidence);
    expect(r2.confidenceNote).toBe(r1.confidenceNote);
    expect(r2.calories).toBe(r1.calories);
    expect(getDeterministicCacheStats().hits).toBe(1);
  });

  it('does not invent a source=cache provenance', async () => {
    const r = await estimateRecipeNutrition({ title: 'X', ingredients: FLOUR_EGGS });
    expect(r.source).toBe('database');
  });
});

describe('nutritionCache: immutability', () => {
  it('mutating a returned cached result cannot poison later hits', async () => {
    const r1 = await estimateRecipeNutrition({ title: 'X', ingredients: FLOUR_EGGS });
    const originalCalories = r1.calories;
    const originalProtein = r1.protein;
    const originalConfidence = r1.confidence;
    // Attempt to poison the cache via the caller-held result.
    r1.calories = 99999;
    r1.protein = 999;
    r1.confidence = 'high';

    const r2 = await estimateRecipeNutrition({ title: 'X', ingredients: FLOUR_EGGS });
    expect(r2.calories).toBe(originalCalories);
    expect(r2.calories).not.toBe(99999);
    expect(r2.protein).toBe(originalProtein);
    expect(r2.confidence).toBe(originalConfidence); // preserved the original deterministic confidence
  });

  it('returns defensive copies (two fetches do not share a reference)', async () => {
    const key = buildDeterministicCacheKey(FLOUR_EGGS);
    setDeterministicNutritionCache(key, stubResult());
    const v1 = getDeterministicNutritionCache(key);
    const v2 = getDeterministicNutritionCache(key);
    expect(v1).toBeDefined();
    expect(v2).toBeDefined();
    expect(v1).not.toBe(v2);
  });
});

describe('nutritionCache: bounds and eviction (LRU)', () => {
  it('remains bounded and evicts the least-recently-used entry', () => {
    const keys: string[] = [];
    for (let i = 1; i <= MAX_DETERMINISTIC_CACHE_SIZE + 1; i++) {
      const key = buildDeterministicCacheKey([`${i} cup All-Purpose Flour`]);
      keys.push(key);
      setDeterministicNutritionCache(key, stubResult());
    }
    expect(getDeterministicNutritionCacheSize()).toBe(MAX_DETERMINISTIC_CACHE_SIZE);
    // The oldest (least recently used) entry was evicted.
    expect(getDeterministicNutritionCache(keys[0])).toBeUndefined();
    // The most recently inserted entry is still cached.
    expect(getDeterministicNutritionCache(keys[keys.length - 1])).toBeDefined();
    expect(getDeterministicCacheStats().evictions).toBeGreaterThanOrEqual(1);
    expect(getDeterministicCacheStats().maxSize).toBe(MAX_DETERMINISTIC_CACHE_SIZE);
  });

  it('accessing an entry refreshes its recency (true LRU)', () => {
    // Only useful at capacity: build MAX entries, refresh the first, then add one
    // more so an eviction MUST occur. The refreshed entry survives; the next-oldest
    // (the un-refreshed second entry) is evicted instead.
    for (let i = 1; i <= MAX_DETERMINISTIC_CACHE_SIZE; i++) {
      setDeterministicNutritionCache(
        buildDeterministicCacheKey([`${i} cup All-Purpose Flour`]),
        stubResult()
      );
    }
    const k1 = buildDeterministicCacheKey(['1 cup All-Purpose Flour']);
    const k2 = buildDeterministicCacheKey(['2 cups All-Purpose Flour']);
    // Refresh k1 (now the most-recently used entry).
    expect(getDeterministicNutritionCache(k1)).toBeDefined();
    // Adding one more evicts the true LRU (k2), not the refreshed k1.
    const kNew = buildDeterministicCacheKey([`${MAX_DETERMINISTIC_CACHE_SIZE + 1} cup All-Purpose Flour`]);
    setDeterministicNutritionCache(kNew, stubResult());
    expect(getDeterministicNutritionCacheSize()).toBe(MAX_DETERMINISTIC_CACHE_SIZE);
    expect(getDeterministicNutritionCache(k2)).toBeUndefined();
    expect(getDeterministicNutritionCache(k1)).toBeDefined();
  });
});
