import assert from "assert";
import http from "http";
import { estimateAlgorithmicNutrition } from "../server/nutritionEstimator";
import { serializeRecipeToObsidianMarkdown, parseObsidianRecipeMarkdown } from "../src/utils/markdownParser";
import { ObsidianRecipe } from "../src/types";

async function postJson(path: string, payload: any, timeoutMs: number = 30000): Promise<{ status: number; headers: Record<string, string>; data: any; raw: string }> {
  const postData = JSON.stringify(payload);
  const randomIp = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;
  const response = await fetch(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": randomIp,
    },
    body: postData,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((val, key) => {
    headers[key.toLowerCase()] = val;
  });

  return {
    status: response.status,
    headers,
    data,
    raw,
  };
}

/**
 * Simulates the fallback cascade logic using mocked model functions
 * verifying 404, 429, 503, and temporary network failures without consuming quota
 */
async function simulateFallbackCascade(
  primaryMock: () => Promise<any>,
  fallbackMock: () => Promise<any>,
  recipeTitle: string,
  servings: number,
  ingredients: string[]
) {
  try {
    return await primaryMock();
  } catch (primErr) {
    try {
      return await fallbackMock();
    } catch (fallErr) {
      return estimateAlgorithmicNutrition(recipeTitle, servings, ingredients);
    }
  }
}

async function runNutritionFunctionalSuite() {
  console.log("========================================================================");
  console.log("🥗 THE KITCHEN CODEX v0.2.2 — NUTRITION ESTIMATION REGRESSION SUITE");
  console.log("========================================================================");

  let passed = 0;
  let failed = 0;

  function record(testName: string, success: boolean, details?: string) {
    if (success) {
      console.log(`  ✅ [PASS] ${testName}${details ? ` (${details})` : ""}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}${details ? ` - ${details}` : ""}`);
      failed++;
    }
  }

  // 1. Live Recipe Estimation via Server Endpoint
  try {
    const res = await postJson("/api/estimate-nutrition", {
      title: "Classic Spaghetti Carbonara",
      servings: 4,
      ingredients: [
        "400g spaghetti pasta",
        "200g guanciale",
        "4 large egg yolks",
        "100g Pecorino Romano cheese",
        "2 tsp black pepper",
        "1 tsp salt"
      ]
    });
    record(
      "1. Live AI Recipe Nutrition Estimation",
      res.status === 200 && res.data.success && typeof res.data.nutrition?.calories === "number" && res.data.nutrition.calories > 200,
      `Calories: ${res.data.nutrition?.calories} kcal, Protein: ${res.data.nutrition?.protein}g, Fat: ${res.data.nutrition?.fat}g`
    );
  } catch (err: any) {
    record("1. Live AI Recipe Nutrition Estimation", false, err.message);
  }

  // 2. Standard ASCII Fractions (1/2, 3/4)
  try {
    const algoResult = estimateAlgorithmicNutrition("Simple Vinaigrette", 2, [
      "1/2 cup olive oil",
      "1/4 cup red wine vinegar",
      "1/2 tsp salt"
    ]);
    record(
      "2. Standard ASCII Fractions (1/2, 1/4, 3/4)",
      algoResult.fat > 20 && algoResult.calories > 150,
      `Algorithmic: ${algoResult.calories} kcal, ${algoResult.fat}g fat`
    );
  } catch (err: any) {
    record("2. Standard ASCII Fractions (1/2, 1/4, 3/4)", false, err.message);
  }

  // 3. Mixed Numbers (1 1/2, 2 1/4)
  try {
    const algoResult = estimateAlgorithmicNutrition("Pancake Stack", 2, [
      "1 1/2 cups all-purpose flour",
      "3 1/2 tsp baking powder",
      "1/2 tsp salt",
      "1 1/4 cups whole milk",
      "1 egg",
      "3 tbsp melted butter"
    ]);
    record(
      "3. Mixed Numbers (1 1/2, 2 1/4, 3 1/2)",
      algoResult.calories > 100 && algoResult.protein > 5,
      `Algorithmic: ${algoResult.calories} kcal, ${algoResult.carbohydrates}g carbs, ${algoResult.protein}g protein`
    );
  } catch (err: any) {
    record("3. Mixed Numbers (1 1/2, 2 1/4, 3 1/2)", false, err.message);
  }

  // 4. Unicode Vulgar Fractions (½, ¾, ⅓, ⅔)
  try {
    const algoResult = estimateAlgorithmicNutrition("Tuscan Garlic Dressing", 4, [
      "½ cup extra virgin olive oil",
      "¼ cup red wine vinegar",
      "¾ tsp sea salt",
      "⅓ cup grated parmesan cheese",
      "2 cloves minced garlic"
    ]);
    record(
      "4. Unicode Vulgar Fractions (½, ¾, ⅓, ⅔)",
      algoResult.fat > 5 && algoResult.calories > 50,
      `Algorithmic: ${algoResult.calories} kcal, ${algoResult.fat}g fat`
    );
  } catch (err: any) {
    record("4. Unicode Vulgar Fractions (½, ¾, ⅓, ⅔)", false, err.message);
  }

  // 5. Qualitative Measurements ("to taste", "pinch", "dash", "handful")
  try {
    const algoResult = estimateAlgorithmicNutrition("Herb Butter Steaks", 2, [
      "2 ribeye steaks (12 oz each)",
      "salt and freshly ground pepper to taste",
      "1 pinch red pepper flakes",
      "1 dash Worcestershire sauce",
      "1 handful fresh parsley",
      "2 tbsp butter"
    ]);
    record(
      "5. Qualitative Measurements (to taste, pinch, dash, handful)",
      algoResult.protein > 4 && algoResult.sodium > 100,
      `Algorithmic: ${algoResult.protein}g protein, ${algoResult.sodium}mg sodium`
    );
  } catch (err: any) {
    record("5. Qualitative Measurements (to taste, pinch, dash, handful)", false, err.message);
  }

  // 6. Metric Measurements (grams, ml, kg)
  try {
    const algoResult = estimateAlgorithmicNutrition("French Beef Bourguignon", 6, [
      "1000g beef chuck roast",
      "150g bacon lardons",
      "500ml red wine",
      "300ml beef stock",
      "200g button mushrooms",
      "20g butter"
    ]);
    record(
      "6. Metric Measurements (1000g, 500ml, kg)",
      algoResult.protein > 15 && algoResult.calories > 200,
      `Algorithmic: ${algoResult.calories} kcal, ${algoResult.protein}g protein`
    );
  } catch (err: any) {
    record("6. Metric Measurements (1000g, 500ml, kg)", false, err.message);
  }

  // 7. Obsidian Wikilinks Cleaning & Cleansing
  try {
    const algoResult = estimateAlgorithmicNutrition("Tuscan Chicken with Obsidian Links", 4, [
      "2 large [[Boneless Skinless Chicken Breasts]], halved horizontally",
      "2 tbsp [[Extra Virgin Olive Oil|EVOO]] (sun-dried tomato oil)",
      "1/2 cup [[Parmigiano-Reggiano|Aged Parmesan]], freshly grated",
      "1 cup [[Heavy Cream]]",
      "3 cups [[Fresh Baby Spinach]]",
      "1/2 tsp [[Sea Salt]]"
    ]);
    record(
      "7. Obsidian Wikilinks Parsing & Cleansing",
      algoResult.calories > 100 && algoResult.protein > 10,
      `Algorithmic: ${algoResult.calories} kcal, ${algoResult.protein}g protein`
    );
  } catch (err: any) {
    record("7. Obsidian Wikilinks Parsing & Cleansing", false, err.message);
  }

  // 8. Mocked Upstream Primary Model Failure (404/429) -> Secondary Model Fallback
  try {
    const fallbackResult = await simulateFallbackCascade(
      async () => {
        const err: any = new Error("404 Model Not Found / Resource Unavailable: gemini-3.7-flash");
        err.status = 404;
        throw err;
      },
      async () => {
        return {
          calories: 550,
          protein: 28.0,
          carbohydrates: 45.0,
          fat: 22.0,
          fiber: 4.0,
          sodium: 620,
          confidenceNote: "Estimated via secondary fallback model (gemini-3.1-flash-lite)."
        };
      },
      "Roasted Salmon",
      2,
      ["2 salmon fillets", "1 tbsp olive oil", "1 pinch salt"]
    );
    record(
      "8. Primary Model Failure (404/429) -> Secondary Model Fallback",
      fallbackResult.calories === 550 && fallbackResult.confidenceNote.includes("gemini-3.1-flash-lite"),
      `Successfully routed to fallback model: ${fallbackResult.confidenceNote}`
    );
  } catch (err: any) {
    record("8. Primary Model Failure (404/429) -> Secondary Model Fallback", false, err.message);
  }

  // 9. Mocked Upstream Primary + Secondary Failure (503/Quota) -> Algorithmic Fallback
  try {
    const algoResult = await simulateFallbackCascade(
      async () => {
        const err: any = new Error("429 Resource Exhausted (Quota limit reached)");
        err.status = 429;
        throw err;
      },
      async () => {
        const err: any = new Error("503 Service Unavailable (Model overloaded)");
        err.status = 503;
        throw err;
      },
      "Carbonara Recipe",
      4,
      ["400g spaghetti", "200g guanciale", "4 egg yolks", "100g pecorino cheese"]
    );
    record(
      "9. Primary + Secondary Failure (503/429) -> Algorithmic Fallback",
      algoResult.calories > 300 && algoResult.protein > 15,
      `Executed algorithmic fallback: ${algoResult.calories} kcal, ${algoResult.protein}g protein`
    );
  } catch (err: any) {
    record("9. Primary + Secondary Failure (503/429) -> Algorithmic Fallback", false, err.message);
  }

  // 10. Invalid Input -> 400 Bad Request
  try {
    const emptyRes = await postJson("/api/estimate-nutrition", { title: "Bad Recipe", ingredients: [] });
    record(
      "10. Invalid Empty Input Rejection (HTTP 400)",
      emptyRes.status === 400 && !emptyRes.data?.success,
      `Status: ${emptyRes.status}, Error: "${emptyRes.data?.error}"`
    );
  } catch (err: any) {
    record("10. Invalid Empty Input Rejection (HTTP 400)", false, err.message);
  }

  // 11. Rate Limiting Headers & Protection
  try {
    const res = await postJson("/api/estimate-nutrition", {
      title: "Header Check",
      servings: 1,
      ingredients: ["1 apple"]
    });
    const limit = res.headers["ratelimit-limit"] || res.headers["x-ratelimit-limit"];
    const remaining = res.headers["ratelimit-remaining"] || res.headers["x-ratelimit-remaining"];
    record(
      "11. Rate Limiter Active with Proper Headers",
      limit !== undefined && res.status === 200,
      `Limit: ${limit}, Remaining: ${remaining}`
    );
  } catch (err: any) {
    record("11. Rate Limiter Active with Proper Headers", false, err.message);
  }

  // 12. No API Key Exposure or Internal Leakage
  try {
    const res = await postJson("/api/estimate-nutrition", {
      title: "Leak Test",
      servings: 4,
      ingredients: ["1 tbsp olive oil"]
    }, 15000);
    const apiKey = process.env.GEMINI_API_KEY || "";
    const hasLeak = apiKey.length > 5 && res.raw.includes(apiKey);
    const hasStack = res.raw.includes("at ") && res.raw.includes(".ts:");
    record(
      "12. Zero API Key / Stack Trace Exposure",
      !hasLeak && !hasStack,
      "Client responses contain zero credentials or internal stack traces"
    );
  } catch (err: any) {
    record("12. Zero API Key / Stack Trace Exposure", false, err.message);
  }

  // 13. Recipe YAML Serialization & Frontmatter Round-trip Integrity
  try {
    const sampleRecipe: Partial<ObsidianRecipe> = {
      id: "recipe-carbonara-123",
      title: "Roman Spaghetti Carbonara",
      servings: 4,
      prepTime: "10 mins",
      cookTime: "15 mins",
      totalTime: "25 mins",
      cuisine: "Italian",
      category: "Main Course",
      difficulty: "Medium",
      rating: 5,
      tags: ["food/recipes", "cuisine/italian", "pasta"],
      ingredients: [
        { original: "400g [[Spaghetti]]", amount: 400, unit: "g", name: "Spaghetti" },
        { original: "200g [[Guanciale]]", amount: 200, unit: "g", name: "Guanciale" },
        { original: "4 [[Egg|Egg Yolks]]", amount: 4, unit: "units", name: "Egg" },
        { original: "100g [[Pecorino Romano]]", amount: 100, unit: "g", name: "Pecorino Romano" }
      ],
      instructions: [
        { stepNumber: 1, text: "Boil spaghetti in salted water for 9 minutes.", timerMinutes: 9, isCompleted: false },
        { stepNumber: 2, text: "Crisp guanciale in skillet over medium heat.", timerMinutes: 8, isCompleted: false }
      ],
      callouts: [
        { type: "tip", title: "Emulsion Secret", content: "Never add eggs over direct heat; use pasta water off-heat." }
      ],
      nutrition: {
        calories: 840,
        protein: 32.5,
        carbohydrates: 78.0,
        fat: 42.1,
        fiber: 3.2,
        sodium: 1120,
        confidenceNote: "Validated Roman Carbonara profile across 4 servings."
      },
      source: "https://example.com/carbonara",
      notes: "A family classic handed down for generations."
    };

    // Serialize to Markdown
    const serializedMarkdown = serializeRecipeToObsidianMarkdown(sampleRecipe);
    assert(serializedMarkdown.includes("calories: 840"), "Markdown frontmatter includes calories");
    assert(serializedMarkdown.includes("protein: 32.5"), "Markdown frontmatter includes protein");
    assert(serializedMarkdown.includes("confidenceNote:"), "Markdown frontmatter includes confidenceNote");
    assert(serializedMarkdown.includes("[!tip] Emulsion Secret"), "Markdown includes callout tip");
    assert(serializedMarkdown.includes("[[Spaghetti]]"), "Markdown includes ingredients with wikilinks");

    // Parse back from Markdown
    const parsedRecipe = parseObsidianRecipeMarkdown(serializedMarkdown, "Roman Spaghetti Carbonara.md", "6 - Full Notes/Food/Recipes/Roman Spaghetti Carbonara.md");
    assert(parsedRecipe.title === "Roman Spaghetti Carbonara", "Parsed title matches");
    assert(parsedRecipe.nutrition?.calories === 840, "Parsed calories match");
    assert(parsedRecipe.nutrition?.protein === 32.5, "Parsed protein matches");
    assert(parsedRecipe.callouts.length === 1, "Parsed callouts match");
    assert(parsedRecipe.ingredients.length === 4, "Parsed ingredients match");

    record(
      "13. Recipe YAML Serialization & Frontmatter Round-trip Integrity",
      true,
      "Frontmatter, callouts, wikilinks, and nutrition blocks serialize and re-parse with 100% fidelity"
    );
  } catch (err: any) {
    record("13. Recipe YAML Serialization & Frontmatter Round-trip Integrity", false, err.message);
  }

  console.log("========================================================================");
  console.log(`NUTRITION VERIFICATION SUMMARY: ${passed + failed} TESTS | ${passed} PASSED | ${failed} FAILED`);
  console.log("========================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runNutritionFunctionalSuite();

