import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  estimateAlgorithmicNutrition,
  estimateRecipeNutrition,
} from "../../server/nutritionEstimator.js";
import {
  nutritionForServings,
  roundNutritionForDisplay,
  normalizeServings,
  resolveNutritionBase,
  resolveRecipeBaseServings,
} from "../../src/utils/nutrition";
import {
  serializeRecipeToObsidianMarkdown,
  parseObsidianRecipeMarkdown,
} from "../../src/utils/markdownParser";
import { ObsidianRecipe } from "../../src/types";

// The single canonical example from the audit: TOTAL 5540 kcal over 4 original
// servings => 1=1385, 2=2770, 4=5540, 8=11080.
const TOTAL = {
  calories: 5540,
  protein: 280,
  carbohydrates: 340,
  fat: 420,
  fiber: 40,
  sodium: 4000,
  servings: 4,
};
const BASE = 4;

const NUTRIENT_KEYS = [
  "calories",
  "protein",
  "carbohydrates",
  "fat",
  "fiber",
  "sodium",
] as const;

describe("nutritionForServings - deterministic serving scaling", () => {
  it("A) scales exactly 2x when requested servings double (all nutrients)", () => {
    const one = nutritionForServings(TOTAL, BASE, 1);
    const two = nutritionForServings(TOTAL, BASE, 2);

    expect(two.calories).toBe(one.calories * 2);
    expect(two.protein).toBe(one.protein * 2);
    expect(two.carbohydrates).toBe(one.carbohydrates * 2);
    expect(two.fat).toBe(one.fat * 2);
    expect(two.fiber).toBe(one.fiber * 2);
    expect(two.sodium).toBe(one.sodium * 2);

    // Canonical example values.
    expect(one.calories).toBe(1385);
    expect(two.calories).toBe(2770);
  });

  it("B) keeps proportionality across 1 -> 2 -> 4 -> 8 servings", () => {
    const expectedRatio: Record<number, number> = { 1: 1 / 4, 2: 2 / 4, 4: 1, 8: 2 };
    for (const requested of Object.keys(expectedRatio).map(Number)) {
      const scaled = nutritionForServings(TOTAL, BASE, requested);
      for (const key of NUTRIENT_KEYS) {
        expect(scaled[key]).toBe(TOTAL[key] * expectedRatio[requested]);
      }
    }
    expect(nutritionForServings(TOTAL, BASE, 4).calories).toBe(5540);
    expect(nutritionForServings(TOTAL, BASE, 8).calories).toBe(11080);
  });

  it("C) applies the SAME scaling factor to every nutrient field", () => {
    const one = nutritionForServings(TOTAL, BASE, 1);
    const three = nutritionForServings(TOTAL, BASE, 3); // non-power-of-2 factor
    for (const key of NUTRIENT_KEYS) {
      const ratio = three[key] / one[key];
      expect(ratio).toBeCloseTo(3, 10);
    }
  });

  it("E) derives per-serving as total / baseServings regardless of selected servings", () => {
    // recipe.servings = 4 => per-serving is total / 4 (1385 kcal), regardless of
    // the currently selected requested count.
    const perServing = nutritionForServings(TOTAL, BASE, 1);
    expect(perServing.calories).toBe(TOTAL.calories / 4);
    expect(perServing.protein).toBe(TOTAL.protein / 4);
    expect(resolveRecipeBaseServings(4)).toBe(4);
    expect(resolveRecipeBaseServings(undefined)).toBe(4);
    // Selecting 1, 2, 4, or 8 never changes the per-serving baseline used.
    expect(nutritionForServings(TOTAL, BASE, 1).calories).toBe(1385);
    expect(nutritionForServings(TOTAL, BASE, 2).calories).toBe(2770);
    expect(nutritionForServings(TOTAL, BASE, 4).calories).toBe(5540);
    expect(nutritionForServings(TOTAL, BASE, 8).calories).toBe(11080);
  });

  it("F) normalizes invalid servings safely and never yields NaN/negative", () => {
    expect(normalizeServings(0, 4)).toBe(4);
    expect(normalizeServings(NaN, 4)).toBe(4);
    expect(normalizeServings(-3, 4)).toBe(4);
    expect(normalizeServings(undefined, 4)).toBe(4);
    expect(normalizeServings(null as any, 4)).toBe(4);
    expect(normalizeServings("abc", 4)).toBe(4);
    expect(normalizeServings("4", 4)).toBe(4);

    // Invalid base + invalid requested should fall back to a safe, finite scale.
    const res = nutritionForServings(TOTAL, 0, NaN);
    expect(Number.isFinite(res.calories)).toBe(true);
    expect(res.calories).toBeGreaterThanOrEqual(0);
    expect(res.servings).toBe(4); // denominator is never scaled

    // A negative nutrition input is clamped to >= 0.
    const neg = nutritionForServings({ calories: -5, protein: 10, servings: 4 }, 4, 2);
    expect(neg.calories).toBeGreaterThanOrEqual(0);
    expect(neg.protein).toBe(5);
  });

  it("H) does NOT double-scale: persistedTotal / base × requested, never / requested", () => {
    const total = { calories: 100, protein: 10, carbohydrates: 20, fat: 5, fiber: 2, sodium: 1000, servings: 4 };
    // Correct: total × requested / base.
    expect(nutritionForServings(total, 4, 1).calories).toBe(25);
    expect(nutritionForServings(total, 4, 3).calories).toBe(75);
    // Incorrect interpretation total / requested yields 100 or ~33.3 — must not occur.
    expect(nutritionForServings(total, 4, 1).calories).not.toBe(100);
    expect(nutritionForServings(total, 4, 3).calories).not.toBeCloseTo(100 / 3, 0);
  });

  it("J) is a pure, deterministic derivation (no hidden re-estimation)", () => {
    const a = nutritionForServings(TOTAL, BASE, 1);
    const b = nutritionForServings(TOTAL, BASE, 1);
    expect(a).toEqual(b); // repeated identical calls -> identical result
    expect(TOTAL.calories).toBe(5540); // source baseline is never mutated
    // Different requested servings are purely proportional; the baseline dictating
    // the result is a fixed stored value, never a fresh estimator invocation.
    expect(nutritionForServings(TOTAL, BASE, 4).calories).toBe(5540);
    expect(nutritionForServings(TOTAL, BASE, 2).calories).toBe(2770);
  });
});

describe("roundNutritionForDisplay", () => {
  it("rounds calories/sodium to integers and macros to 1 decimal", () => {
    const rounded = roundNutritionForDisplay({
      calories: 1385.4,
      protein: 14.575,
      carbohydrates: 20.21,
      fat: 33.334,
      fiber: 2.26,
      sodium: 1000.6,
      servings: 4,
      confidenceNote: "note",
    });
    expect(rounded.calories).toBe(1385);
    expect(rounded.sodium).toBe(1001);
    expect(rounded.protein).toBe(14.6);
    expect(rounded.carbohydrates).toBe(20.2);
    expect(rounded.fat).toBe(33.3);
    expect(rounded.fiber).toBe(2.3);
    expect(rounded.servings).toBe(4);
  });

  it("does not round non-numeric / undefined fields", () => {
    const rounded = roundNutritionForDisplay({ confidenceNote: "x" });
    expect(rounded.confidenceNote).toBe("x");
  });
});

describe("estimateAlgorithmicNutrition - stable recipe TOTAL", () => {
  const ingredients = [
    "400g spaghetti pasta",
    "200g guanciale",
    "4 large egg yolks",
    "100g Pecorino Romano cheese",
    "2 tsp black pepper",
    "1 tsp salt",
  ];

  it("D) returns the SAME TOTAL regardless of requested servings (invariance)", () => {
    const s1 = estimateAlgorithmicNutrition("Carbonara", 1, ingredients);
    const s2 = estimateAlgorithmicNutrition("Carbonara", 2, ingredients);
    const s4 = estimateAlgorithmicNutrition("Carbonara", 4, ingredients);
    const s8 = estimateAlgorithmicNutrition("Carbonara", 8, ingredients);

    expect(s1).toEqual(s2);
    expect(s2).toEqual(s4);
    expect(s4).toEqual(s8);
  });

  it("G) regresses old per-serving halving (no more 1156 -> 578 -> 289 -> 145)", () => {
    const chicken = [
      "2 large Boneless Skinless Chicken Breasts",
      "2 tbsp Extra Virgin Olive Oil",
      "1/2 cup Parmigiano-Reggiano, freshly grated",
      "1 cup Heavy Cream",
      "3 cups Fresh Baby Spinach",
      "1/2 tsp Sea Salt",
    ];

    const one = estimateAlgorithmicNutrition("Tuscan Chicken", 1, chicken);
    const two = estimateAlgorithmicNutrition("Tuscan Chicken", 2, chicken);
    const four = estimateAlgorithmicNutrition("Tuscan Chicken", 4, chicken);
    const eight = estimateAlgorithmicNutrition("Tuscan Chicken", 8, chicken);

    expect(two.calories).toBe(one.calories);
    expect(four.calories).toBe(one.calories);
    expect(eight.calories).toBe(one.calories);
    expect(one.calories).not.toBe(one.calories / 2); // never halves

    // All fields stable across servings.
    expect(two.protein).toBe(one.protein);
    expect(two.fat).toBe(one.fat);
  });

  it("produces a finite, non-negative base baseline without servings scaling", () => {
    // A recipe whose ingredients are all unrecognized falls to the safe
    // per-ingredient baseline; it must be stable independent of servings.
    const obscure = ["1 exotic unknown magic item", "2 another mystery component"];
    const one = estimateAlgorithmicNutrition("Mystery", 1, obscure);
    const eight = estimateAlgorithmicNutrition("Mystery", 8, obscure);
    expect(one.calories).toBe(eight.calories);
    expect(Number.isFinite(one.calories)).toBe(true);
    expect(one.calories).toBeGreaterThanOrEqual(0);
  });
});

describe("estimateRecipeNutrition - entry point invariance", () => {
  const originalKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    // Force the offline algorithmic path deterministically (the sentinel the
    // estimator treats as "no Gemini client configured").
    process.env.GEMINI_API_KEY = "MY_GEMINI_API_KEY";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  });

  it("returns identical TOTAL nutrition for different requested servings", async () => {
    const ingredients = [
      "400g spaghetti pasta",
      "200g guanciale",
      "4 large egg yolks",
      "100g Pecorino Romano cheese",
    ];

    const r1 = await estimateRecipeNutrition({ title: "Carbonara", servings: 1, ingredients });
    const r2 = await estimateRecipeNutrition({ title: "Carbonara", servings: 2, ingredients });
    const r8 = await estimateRecipeNutrition({ title: "Carbonara", servings: 8, ingredients });

    expect(r1.calories).toBe(r2.calories);
    expect(r2.calories).toBe(r8.calories);
    expect(r2.protein).toBe(r1.protein);
    // And it is the recipe-total baseline (not divided down).
    expect(r1.calories).toBeGreaterThan(100);
  });
});

describe("Schema / Markdown round-trip of the serving denominator", () => {
  function sampleRecipe(): ObsidianRecipe {
    return {
      id: "recipe-tuscan-1",
      fileName: "Creamy Tuscan Garlic Chicken.md",
      filePath: "3 - Recipes/Creamy Tuscan Garlic Chicken.md",
      rawMarkdown: "",
      title: "Creamy Tuscan Garlic Chicken",
      tags: ["food/recipes"],
      category: "Main Course",
      cuisine: "Italian",
      difficulty: "Medium",
      rating: 5,
      servings: 4,
      calories: 5540,
      nutrition: {
        calories: 5540,
        protein: 280,
        carbohydrates: 340,
        fat: 420,
        fiber: 40,
        sodium: 4000,
        servings: 4,
        confidenceNote: "Total for entire recipe batch.",
      },
      ingredients: [
        { original: "2 large [[Chicken Breast]]", amount: 2, unit: "large", name: "Chicken Breast" },
      ],
      instructions: [{ stepNumber: 1, text: "Sear and simmer." }],
      callouts: [],
      dataviewFields: {},
      wikilinks: [],
    };
  }

  it("I) persists the serving denominator and round-trips it", () => {
    const recipe = sampleRecipe();
    const markdown = serializeRecipeToObsidianMarkdown(recipe);
    const parsed = parseObsidianRecipeMarkdown(markdown, recipe.fileName, recipe.filePath);

    expect(parsed.nutrition?.servings).toBe(4);
    expect(parsed.nutrition?.calories).toBe(5540);
    expect(parsed.nutrition?.protein).toBe(280);
    expect(markdown).toContain("servings: 4");
  });

  it("I) preserves legacy per-serving blocks without a denominator", () => {
    const legacy = sampleRecipe();
    delete legacy.nutrition!.servings;
    legacy.nutrition!.calories = 1385;
    legacy.calories = "1385";

    const markdown = serializeRecipeToObsidianMarkdown(legacy);
    const parsed = parseObsidianRecipeMarkdown(markdown, legacy.fileName, legacy.filePath);

    // Legacy block is preserved (per-serving, no invented denominator).
    expect(parsed.nutrition?.calories).toBe(1385);
    // Legacy scaling treats it as per-serving (base = 1) => requested = value × requested.
    const twoServings = nutritionForServings(parsed.nutrition!, resolveNutritionBase(parsed.nutrition!), 2);
    expect(twoServings.calories).toBe(1385 * 2);
  });
});
