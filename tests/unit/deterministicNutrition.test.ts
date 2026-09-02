import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  estimateDeterministicNutrition,
  normalizeRawIngredientLine,
  type DeterministicNutritionResult,
  type IngredientNutritionContribution,
} from '../../server/deterministicNutrition';
import {
  estimateRecipeNutrition,
  estimateAlgorithmicNutrition,
} from '../../server/nutritionEstimator';
import { getGemini } from '../../server/geminiClient';

vi.mock('../../server/geminiClient.js', () => ({ getGemini: vi.fn() }));
const mockGetGemini = getGemini as unknown as ReturnType<typeof vi.fn>;

function contributionOf(result: DeterministicNutritionResult, index: number): IngredientNutritionContribution {
  return result.contributions[index];
}

describe('deterministicNutrition: direct mass', () => {
  it('resolves 8 oz chicken breast via direct mass and produces a plausible estimate', () => {
    const result = estimateDeterministicNutrition(['8 oz Chicken Breast']);
    const c = contributionOf(result, 0);

    expect(c.matchedFoodId).toBe('chicken_breast');
    expect(c.matchedFoodName).toBe('Chicken Breast');
    expect(c.measurementKind).toBe('mass');
    expect(c.massResolutionReason).toBe('direct_mass');
    expect(c.massConfidence).toBe('high');
    expect(c.resolvedGrams).toBeGreaterThan(200);
    expect(c.resolvedGrams).toBeLessThan(260);
    expect(c.resolved).toBe(true);
    expect(c.unresolvedReason).toBeUndefined();

    // per-100g chicken breast: 120 kcal -> plausible ~272 kcal for ~227 g.
    expect(c.per100g?.calories).toBe(120);
    expect(c.contribution?.calories).toBeCloseTo(272.16, 1);
    expect(result.coverage.resolvedCount).toBe(1);
    expect(result.coverage.measurableCount).toBe(1);
  });

  it('grams equal the deterministic Step 2 conversion (8 oz = 8 * 28.35 g)', () => {
    const result = estimateDeterministicNutrition(['8 oz Chicken Breast']);
    expect(contributionOf(result, 0).resolvedGrams).toBeCloseTo(8 * 28.349523125, 6);
  });
});

describe('deterministicNutrition: volume + density', () => {
  it('resolves 1 cup all-purpose flour to grams via flour density', () => {
    const result = estimateDeterministicNutrition(['1 cup All-Purpose Flour']);
    const c = contributionOf(result, 0);

    expect(c.matchedFoodId).toBe('all_purpose_flour');
    expect(c.measurementKind).toBe('volume');
    expect(c.normalizedUnit).toBe('cup');
    expect(c.massResolutionReason).toBe('density');
    expect(c.massConfidence).toBe('low'); // flour density is packing-sensitive
    expect(c.resolvedGrams).toBeGreaterThan(100);
    expect(c.resolvedGrams).toBeLessThan(150);
    expect(c.resolved).toBe(true);

    // per-100g all-purpose flour: 364 kcal -> plausible ~456 kcal for ~125 g.
    expect(c.per100g?.calories).toBe(364);
    expect(c.contribution?.calories).toBeCloseTo(456.4, 0);
  });
});

describe('deterministicNutrition: different food densities', () => {
  it('same normalized volume but different resolved masses and nutrition', () => {
    const flour = contributionOf(estimateDeterministicNutrition(['1 cup All-Purpose Flour']), 0);
    const sugar = contributionOf(estimateDeterministicNutrition(['1 cup granulated sugar']), 0);

    expect(flour.normalizedUnit).toBe('cup');
    expect(sugar.normalizedUnit).toBe('cup');
    // Both resolve to a plausible ~1-cup mass, but the two densities differ.
    expect(flour.resolvedGrams).toBeGreaterThan(100);
    expect(sugar.resolvedGrams).toBeGreaterThan(190);
    expect(flour.resolvedGrams).not.toBe(sugar.resolvedGrams);
    expect(flour.resolvedGrams!).toBeLessThan(sugar.resolvedGrams!); // flour lighter than sugar
    expect(flour.contribution?.calories).not.toBe(sugar.contribution?.calories);
  });

  it('sugar resolves to ~200 g/cup and a distinct total', () => {
    const sugar = contributionOf(estimateDeterministicNutrition(['1 cup granulated sugar']), 0);
    expect(sugar.resolvedGrams).toBeCloseTo(199.92, 1);
    expect(sugar.contribution?.calories).toBeCloseTo(773.7, 0);
  });
});

describe('deterministicNutrition: count', () => {
  it('resolves 2 eggs to approximately 100 g via curated count weight', () => {
    const c = contributionOf(estimateDeterministicNutrition(['2 eggs']), 0);

    expect(c.matchedFoodId).toBe('egg');
    expect(c.measurementKind).toBe('count');
    expect(c.massResolutionReason).toBe('count_weight');
    expect(c.massConfidence).toBe('medium');
    expect(c.resolvedGrams).toBe(100);
    expect(c.resolved).toBe(true);

    // per-100g egg: 143 kcal -> 143 kcal for 100 g.
    expect(c.contribution?.calories).toBeCloseTo(143, 0);
  });
});

describe('deterministicNutrition: garlic count (low confidence propagation)', () => {
  it('uses the low-confidence 3 g/clove count weight and ~9 g for 3 cloves', () => {
    const c = contributionOf(estimateDeterministicNutrition(['3 garlic cloves']), 0);

    expect(c.matchedFoodId).toBe('garlic');
    expect(c.measurementKind).toBe('count');
    expect(c.massResolutionReason).toBe('count_weight');
    expect(c.massConfidence).toBe('low');
    expect(c.resolvedGrams).toBeCloseTo(9, 5);
    expect(c.resolved).toBe(true);
  });

  it('does not yield a high whole-recipe confidence for a garlic recipe', () => {
    const result = estimateDeterministicNutrition(['3 garlic cloves']);
    expect(result.eligible).toBe(true);
    expect(result.confidence).toBe('low');
  });
});

describe('deterministicNutrition: heavy cream (absurdity guard)', () => {
  it('resolves 240 ml heavy cream to a plausible mass and nutrition (no explosion)', () => {
    const c = contributionOf(estimateDeterministicNutrition(['240 ml heavy cream']), 0);

    expect(c.matchedFoodId).toBe('heavy_cream');
    expect(c.massResolutionReason).toBe('density');
    expect(c.resolvedGrams).toBeGreaterThan(220);
    expect(c.resolvedGrams).toBeLessThan(260);

    // per-100g heavy cream: 340 kcal @ ~237 g -> ~808 kcal, NOT a multi-thousand explosion.
    expect(c.contribution?.calories).toBeGreaterThan(700);
    expect(c.contribution?.calories).toBeLessThan(900);
  });
});

describe('deterministicNutrition: unknown food', () => {
  it('1 cup mystery sauce remains unresolved with no fabricated nutrition', () => {
    const result = estimateDeterministicNutrition(['1 cup mystery sauce']);
    const c = contributionOf(result, 0);

    expect(c.matchedFoodId).toBeUndefined();
    expect(c.resolved).toBe(false);
    expect(c.resolvedGrams).toBeUndefined();
    expect(c.contribution).toBeUndefined();
    expect(c.unresolvedReason).toBe('no_curated_food_match');
    expect(result.totals.calories).toBe(0);
  });
});

describe('deterministicNutrition: qualitative ingredients', () => {
  it('salt to taste does not fabricate an amount or nutrition', () => {
    const result = estimateDeterministicNutrition(['salt to taste']);
    const c = contributionOf(result, 0);

    expect(c.resolved).toBe(false);
    expect(c.qualitative).toBe(true);
    expect(c.amount).toBeNull();
    expect(c.resolvedGrams).toBeUndefined();
    expect(c.contribution).toBeUndefined();
    expect(c.unresolvedReason).toBeUndefined();
    expect(result.totals.calories).toBe(0);
    expect(result.coverage.qualitativeCount).toBe(1);
    expect(result.coverage.materialUnresolvedCount).toBe(0);
  });
});

describe('deterministicNutrition: material unknown blocks completeness', () => {
  it('1 cup unknown sauce makes the result not eligible (partial)', () => {
    const result = estimateDeterministicNutrition(['1 cup unknown sauce']);
    expect(result.eligible).toBe(false);
    expect(result.coverage.status).toBe('partial');
    expect(result.coverage.materialUnresolvedCount).toBe(1);
    expect(result.coverage.measurableCount).toBe(1);
    expect(result.coverage.resolvedCount).toBe(0);
  });

  it('a quantified heavy cream with no amount is material, not qualitative', () => {
    // "Heavy Cream" with no measurable amount is materially different from "salt to taste".
    const result = estimateDeterministicNutrition(['Heavy Cream']);
    const c = contributionOf(result, 0);
    expect(c.qualitative).toBe(false);
    expect(c.matchedFoodId).toBe('heavy_cream');
    expect(c.resolved).toBe(false);
    expect(result.eligible).toBe(false);
  });
});

describe('deterministicNutrition: quantified material ingredients are never exempted as qualitative', () => {
  // BLOCKING-FIX regression: an ingredient with a measurable quantity MUST NOT be
  // demoted to qualitative merely because a cue phrase ("to taste", "as needed",
  // "as desired", "as required") appears in its text. If it cannot resolve, it stays
  // material-unresolved and blocks eligibility (never presents incomplete as complete).
  const mustBlock: Array<[string[], string]> = [
    [['2 eggs', '1 cup butter, as needed'], 'butter'],
    [['2 eggs', '1 cup sugar, as desired'], 'sugar'],
    [['2 eggs', '1 tbsp olive oil, to taste'], 'olive oil'],
    [['2 eggs', '240 ml heavy cream, as required'], 'heavy cream'],
  ];

  it.each(mustBlock)('%j -> NOT eligible', (recipe, leaked) => {
    const result = estimateDeterministicNutrition(recipe);
    expect(result.eligible).toBe(false);
    expect(result.coverage.status).toBe('partial');
    // The quantified ingredient is NOT treated as qualitative/negligible.
    const target = result.contributions.find((c) => c.ingredient.includes(leaked as string));
    expect(target?.qualitative).toBe(false);
    expect(target?.resolved).toBe(false);
    expect(result.coverage.qualitativeCount).toBe(0);
    expect(result.coverage.materialUnresolvedCount).toBe(1);
    // The partial total is NOT labelled complete.
    expect(result.coverage.allMeasurableResolved).toBe(false);
  });

  it('a quantified ingredient with a cue phrase that also carries a real quantity is material', () => {
    const result = estimateDeterministicNutrition(['1 cup butter, as needed']);
    const c = contributionOf(result, 0);
    expect(c.amount).toBe(1);
    expect(c.qualitative).toBe(false);
    expect(c.unresolvedReason).toBe('no_curated_food_match');
    expect(result.coverage.materialUnresolvedCount).toBe(1);
    expect(result.eligible).toBe(false);
  });

  it('amount-free qualitative ingredients remain exempt (conservative rule unchanged)', () => {
    for (const recipe of [['salt to taste'], ['pepper as needed'], ['water as required']]) {
      const result = estimateDeterministicNutrition(recipe);
      expect(contributionOf(result, 0).qualitative).toBe(true);
      expect(result.coverage.qualitativeCount).toBe(1);
      expect(result.coverage.materialUnresolvedCount).toBe(0);
    }
    // When a resolvable ingredient accompanies them, they still do not block coverage.
    const mixed = estimateDeterministicNutrition([
      '1 cup All-Purpose Flour',
      'salt to taste',
      'pepper as needed',
      'water as required',
    ]);
    expect(mixed.eligible).toBe(true);
    expect(mixed.coverage.qualitativeCount).toBe(3);
    expect(mixed.coverage.materialUnresolvedCount).toBe(0);
  });
});

describe('deterministicNutrition: coverage eligibility', () => {
  it('partial coverage (flour + eggs + mystery sauce) is NOT eligible', () => {
    const result = estimateDeterministicNutrition([
      '1 cup All-Purpose Flour',
      '2 eggs',
      '1 cup mystery sauce',
    ]);

    expect(result.coverage.totalIngredients).toBe(3);
    expect(result.coverage.resolvedCount).toBe(2);
    expect(result.coverage.materialUnresolvedCount).toBe(1);
    expect(result.coverage.qualitativeCount).toBe(0);
    expect(result.coverage.measurableCount).toBe(3);
    expect(result.coverage.allMeasurableResolved).toBe(false);
    expect(result.coverage.sufficient).toBe(false);
    expect(result.eligible).toBe(false);

    // The flour+egg total is returned for diagnostics but must NOT be labelled complete.
    expect(result.totals.calories).toBeGreaterThan(0);
  });

  it('full coverage (only curated/resolvable ingredients) is eligible', () => {
    const result = estimateDeterministicNutrition([
      '1 cup All-Purpose Flour',
      '2 eggs',
      '8 oz Chicken Breast',
      '240 ml heavy cream',
    ]);

    expect(result.coverage.resolvedCount).toBe(4);
    expect(result.coverage.materialUnresolvedCount).toBe(0);
    expect(result.coverage.qualitativeCount).toBe(0);
    expect(result.coverage.measurableCount).toBe(4);
    expect(result.coverage.allMeasurableResolved).toBe(true);
    expect(result.coverage.sufficient).toBe(true);
    expect(result.eligible).toBe(true);

    // Sum of independent contributions == whole-recipe totals.
    const sum = result.contributions.reduce(
      (acc, c) => acc + (c.contribution?.calories ?? 0),
      0
    );
    expect(sum).toBeCloseTo(result.totals.calories, 6);
  });

  it('qualitative ingredients do not destroy coverage', () => {
    const result = estimateDeterministicNutrition([
      '1 cup All-Purpose Flour',
      'salt to taste',
      'pepper as needed',
    ]);
    expect(result.coverage.resolvedCount).toBe(1);
    expect(result.coverage.qualitativeCount).toBe(2);
    expect(result.coverage.materialUnresolvedCount).toBe(0);
    expect(result.coverage.allMeasurableResolved).toBe(true);
    expect(result.coverage.sufficient).toBe(true);
    expect(result.eligible).toBe(true);
    expect(result.coverage.measurableCount).toBe(1);
  });
});

describe('deterministicNutrition: wikilinks', () => {
  it('resolves wikilink ingredients where matching semantics support them', () => {
    const result = estimateDeterministicNutrition([
      '8 oz [[Chicken Breast]]',
      '240 ml [[Heavy Cream]]',
      '1 cup [[All-Purpose Flour]]',
    ]);
    const ids = result.contributions.map((c) => c.matchedFoodId);
    expect(ids).toContain('chicken_breast');
    expect(ids).toContain('heavy_cream');
    expect(ids).toContain('all_purpose_flour');
    expect(result.contributions.every((c) => c.resolved)).toBe(true);
    expect(result.eligible).toBe(true);
  });

  it('never mutates the original ingredient string', () => {
    const raw1 = '8 oz [[Chicken Breast]]';
    const raw2 = '240 ml [[Heavy Cream]]';
    const result = estimateDeterministicNutrition([raw1, raw2]);
    expect(result.contributions[0].ingredient).toBe(raw1);
    expect(result.contributions[1].ingredient).toBe(raw2);
    expect(raw1).toBe('8 oz [[Chicken Breast]]');
    expect(raw2).toBe('240 ml [[Heavy Cream]]');
  });
});

describe('deterministicNutrition: negative and zero amounts', () => {
  it('never produces negative nutrition from a negative amount', () => {
    const result = estimateDeterministicNutrition([
      { amount: -1, unit: 'cup', name: 'All-Purpose Flour' },
    ]);
    const c = contributionOf(result, 0);
    expect(c.resolved).toBe(false);
    expect(c.resolvedGrams).toBeUndefined();
    expect(result.totals.calories).toBe(0);
    expect(result.totals.calories).toBeGreaterThanOrEqual(0);
    expect(result.eligible).toBe(false);
  });

  it('a negative amount alongside a resolvable ingredient does not subtract', () => {
    const result = estimateDeterministicNutrition([
      { amount: -1, unit: 'cup', name: 'All-Purpose Flour' },
      '2 eggs',
    ]);
    const egg = result.contributions[1];
    expect(egg.resolved).toBe(true);
    expect(result.totals.calories).toBe(egg.contribution!.calories); // only eggs counted
  });

  it('a zero amount resolves to zero contribution without being unresolved', () => {
    const result = estimateDeterministicNutrition([
      { amount: 0, unit: 'cup', name: 'All-Purpose Flour' },
    ]);
    const c = contributionOf(result, 0);
    expect(c.resolved).toBe(true);
    expect(c.resolvedGrams).toBe(0);
    expect(c.contribution?.calories).toBe(0);
    expect(c.unresolvedReason).toBeUndefined();
  });

  it('zero grams yields zero contribution (non-negative totals)', () => {
    const result = estimateDeterministicNutrition([
      { amount: 0, unit: 'g', name: 'Chicken Breast' },
    ]);
    const c = contributionOf(result, 0);
    expect(c.resolved).toBe(true);
    expect(c.resolvedGrams).toBe(0);
    expect(c.contribution?.calories).toBe(0);
    expect(result.totals.calories).toBe(0);
  });
});

describe('deterministicNutrition: serving contract (whole recipe, no serving denominator)', () => {
  it('produces whole-recipe totals with no dependence on requested servings', () => {
    const ingredients = ['1 cup All-Purpose Flour', '2 eggs', '240 ml heavy cream'];
    // The pure engine has no servings input at all: totals are whole-recipe only.
    const a = estimateDeterministicNutrition(ingredients);
    const b = estimateDeterministicNutrition(ingredients);
    expect(a.totals).toEqual(b.totals);
    expect(a.totals.calories).toBeGreaterThan(0);
    // Contracts: whole-recipe, first-pass.
    expect(a.coverage.resolvedCount).toBe(3);
  });

  it('estimateRecipeNutrition is invariant to requested servings on the deterministic path', async () => {
    const ingredients = ['1 cup All-Purpose Flour', '2 eggs', '240 ml heavy cream'];
    const r1 = await estimateRecipeNutrition({ title: 'X', servings: 1, ingredients });
    const r8 = await estimateRecipeNutrition({ title: 'X', servings: 8, ingredients });
    // Deterministic path selected (source database); totals identical for any serving count.
    expect(r1.source).toBe('database');
    expect(r1.calories).toBe(r8.calories);
    expect(r1.protein).toBe(r8.protein);
  });
});

describe('deterministicNutrition: provenance & confidence', () => {
  it('an eligible deterministic result is tagged source=database', () => {
    const result = estimateDeterministicNutrition(['1 cup All-Purpose Flour', '2 eggs']);
    expect(result.eligible).toBe(true);
    expect(result.source).toBe('database');
    expect(result.confidence).toBe('low'); // flour density is low confidence => weakest evidence
  });

  it('garlic-count recipe is not high confidence', () => {
    const result = estimateDeterministicNutrition(['3 garlic cloves']);
    expect(result.confidence).not.toBe('high');
    expect(result.confidence).toBe('low');
  });

  it('confidence reflects the weakest material evidence, not arithmetic precision', () => {
    // All direct-mass + high, but density/count approximations lower the whole-recipe confidence.
    const allHigh = estimateDeterministicNutrition(['8 oz Chicken Breast', '8 oz Chicken Breast']);
    expect(allHigh.confidence).toBe('high');

    const withCount = estimateDeterministicNutrition(['8 oz Chicken Breast', '2 eggs']);
    expect(withCount.confidence).toBe('medium'); // egg count weight is medium
  });
});

describe('deterministicNutrition: estimator fallback preservation', () => {
  const originalKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    mockGetGemini.mockReturnValue(null);
  });

  afterEach(() => {
    mockGetGemini.mockReturnValue(null);
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  });

  it('insufficient deterministic coverage falls through to the offline heuristic (no Gemini)', async () => {
    const ingredients = ['1 cup All-Purpose Flour', '1 cup mystery sauce'];
    const result = await estimateRecipeNutrition({ title: 'X', servings: 4, ingredients });
    const algorithm = estimateAlgorithmicNutrition('X', 4, ingredients);

    expect(result.source).toBe('offline_heuristic');
    expect(result).toEqual(algorithm);
  });

  it('insufficient deterministic coverage continues into the AI cascade when Gemini is available', async () => {
    const fakeGemini = {
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
          }),
        }),
      },
    };
    mockGetGemini.mockReturnValue(fakeGemini);

    const ingredients = ['1 cup All-Purpose Flour', '1 cup mystery sauce'];
    const result = await estimateRecipeNutrition({ title: 'X', servings: 4, ingredients });
    expect(result.source).toBe('ai_estimate');
    expect(result.confidence).toBe('medium');
    expect(result.calories).toBe(250);
  });

  it('eligible deterministic coverage is selected in preference to AI (database provenance)', async () => {
    const fakeGemini = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: JSON.stringify({ calories: 999, protein: 1, carbohydrates: 1, fat: 1, fiber: 1, sodium: 1 }),
        }),
      },
    };
    mockGetGemini.mockReturnValue(fakeGemini);

    const ingredients = ['1 cup All-Purpose Flour', '2 eggs'];
    const result = await estimateRecipeNutrition({ title: 'X', servings: 4, ingredients });
    expect(result.source).toBe('database');
    expect(result.calories).not.toBe(999);
  });

  it('BLOCKING-FIX regression: a quantified material ingredient is NOT dropped as qualitative', async () => {
    // "1 cup butter, as needed" is material/quantified. It must NOT be silently
    // ignored and let the eggs-only total be returned as a complete database estimate.
    const ingredients = ['2 eggs', '1 cup butter, as needed'];

    // 1) No Gemini client -> must fall through to the offline heuristic, not `database`.
    mockGetGemini.mockReturnValue(null);
    const offline = await estimateRecipeNutrition({ title: 'X', servings: 4, ingredients });
    const algorithm = estimateAlgorithmicNutrition('X', 4, ingredients);
    expect(offline.source).toBe('offline_heuristic');
    expect(offline).toEqual(algorithm);

    // 2) Gemini available -> must continue into the AI cascade, not a partial database.
    const fakeGemini = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: JSON.stringify({ calories: 640, protein: 20, carbohydrates: 12, fat: 55, fiber: 2, sodium: 800 }),
        }),
      },
    };
    mockGetGemini.mockReturnValue(fakeGemini);
    const ai = await estimateRecipeNutrition({ title: 'X', servings: 4, ingredients });
    expect(ai.source).toBe('ai_estimate');
    expect(ai.calories).toBe(640);
  });
});

describe('normalizeRawIngredientLine (production tokenizer)', () => {
  it('keeps count nouns in the name so count weights drive resolution', () => {
    expect(normalizeRawIngredientLine('3 garlic cloves')).toEqual({
      amount: 3,
      unit: null,
      name: 'garlic cloves',
    });
    expect(normalizeRawIngredientLine('2 eggs')).toEqual({ amount: 2, unit: null, name: 'eggs' });
  });

  it('consumes only mass/volume unit tokens and leaves the food name', () => {
    expect(normalizeRawIngredientLine('8 oz Chicken Breast')).toEqual({
      amount: 8,
      unit: 'oz',
      name: 'Chicken Breast',
    });
    expect(normalizeRawIngredientLine('240 ml heavy cream')).toEqual({
      amount: 240,
      unit: 'ml',
      name: 'heavy cream',
    });
    // A leading "of" between unit and food name is handled.
    expect(normalizeRawIngredientLine('1 cup of All-Purpose Flour')).toEqual({
      amount: 1,
      unit: 'cup',
      name: 'All-Purpose Flour',
    });
  });

  it('does not fabricate an amount for unmeasured ingredients', () => {
    expect(normalizeRawIngredientLine('salt to taste')).toEqual({
      amount: null,
      unit: null,
      name: 'salt to taste',
    });
  });
});
