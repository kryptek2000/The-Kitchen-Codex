import { estimateAlgorithmicNutrition, estimateRecipeNutrition } from "../server/nutritionEstimator";
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from "../src/utils/markdownParser";
import { scaleIngredientText } from "../src/utils/markdownParser";
import { ObsidianRecipe, RecipeNutrition } from "../src/types";

async function runServingAudit() {
  console.log("=== NUTRITION & MACROS ACCURACY AUDIT ACROSS SERVINGS ===");

  const testRecipes = [
    {
      title: "Classic Spaghetti Carbonara",
      ingredients: [
        "400g spaghetti pasta",
        "200g guanciale",
        "4 large egg yolks",
        "100g Pecorino Romano cheese",
        "2 tsp black pepper",
        "1 tsp salt"
      ]
    },
    {
      title: "Grilled Lemon Herb Chicken Breast",
      ingredients: [
        "2 lb chicken breast",
        "2 tbsp olive oil",
        "2 cloves garlic, minced",
        "1 tbsp lemon juice",
        "1 tsp sea salt",
        "1/2 tsp black pepper"
      ]
    },
    {
      title: "Hearty Morning Rolled Oatmeal with Berries",
      ingredients: [
        "2 cups rolled oats",
        "4 cups water",
        "2 tbsp honey",
        "1 cup fresh blueberries",
        "1/4 cup chopped walnuts",
        "1/2 tsp ground cinnamon"
      ]
    }
  ];

  const servingSizes = [1, 2, 4, 6, 8, 12];

  for (const recipe of testRecipes) {
    console.log(`\n--- Auditing: ${recipe.title} ---`);
    const results: Record<number, any> = {};
    for (const s of servingSizes) {
      const est = estimateAlgorithmicNutrition(recipe.title, s, recipe.ingredients);
      results[s] = est;
      const macroKcal = (est.protein * 4) + (est.carbohydrates * 4) + (est.fat * 9);
      const macroRatio = est.calories > 0 ? (macroKcal / est.calories).toFixed(2) : "N/A";

      console.log(
        `Servings: ${s.toString().padStart(2)} | Calories: ${est.calories.toString().padStart(4)} kcal | Protein: ${est.protein.toString().padStart(5)}g | Carbs: ${est.carbohydrates.toString().padStart(5)}g | Fat: ${est.fat.toString().padStart(5)}g | Fiber: ${est.fiber.toString().padStart(4)}g | Sodium: ${est.sodium.toString().padStart(5)}mg | Macro-Calc: ${Math.round(macroKcal)} kcal (ratio: ${macroRatio})`
      );
    }

    const batch1 = results[1].calories * 1;
    const batch4 = results[4].calories * 4;
    const batch8 = results[8].calories * 8;
    const maxDev = Math.max(Math.abs(batch1 - batch4), Math.abs(batch8 - batch4));
    console.log(`-> Batch Total: ~${batch1} kcal | Max Rounding Deviation: ${maxDev} kcal`);
  }

  console.log("\n3. Ingredient Quantity Scaling Check (scaleIngredientText):");
  const baseServings = 4;
  for (const targetServings of [1, 2, 4, 8]) {
    console.log(`  Target Servings: ${targetServings} (Factor: ${targetServings / baseServings}x)`);
    for (const ing of testRecipes[0].ingredients) {
      const scaled = scaleIngredientText(ing, baseServings, targetServings);
      console.log(`    Original: "${ing}" -> Scaled: "${scaled}"`);
    }
  }

  console.log("\n4. Frontmatter Serialization & Round-Trip with Servings & Macros:");
  const mockRecipe: ObsidianRecipe = {
    id: "carbonara",
    title: "Classic Spaghetti Carbonara",
    filePath: "Recipes/Carbonara.md",
    fileName: "Carbonara.md",
    category: "Pasta",
    cuisine: "Italian",
    difficulty: "Medium",
    rating: 5,
    servings: 4,
    calories: 785,
    nutrition: {
      calories: 785,
      protein: 26.5,
      carbohydrates: 75.0,
      fat: 42.0,
      fiber: 3.0,
      sodium: 980
    },
    prepTime: "10 mins",
    cookTime: "15 mins",
    tags: ["pasta", "italian"],
    ingredients: testRecipes[0].ingredients.map(i => ({ original: i, name: i })),
    instructions: [{ stepNumber: 1, text: "Boil pasta and mix with sauce." }],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    rawMarkdown: ""
  };

  const serialized = serializeRecipeToObsidianMarkdown(mockRecipe);
  const parsedBack = parseObsidianRecipeMarkdown(serialized, "Carbonara.md", "Recipes/Carbonara.md");

  console.log(`- Serialized has calories: ${parsedBack.calories === 785 ? "PASS" : "FAIL"}`);
  console.log(`- Serialized has protein: ${parsedBack.nutrition?.protein === 26.5 ? "PASS" : "FAIL"} (${parsedBack.nutrition?.protein}g)`);
  console.log(`- Serialized has carbs: ${parsedBack.nutrition?.carbohydrates === 75 ? "PASS" : "FAIL"} (${parsedBack.nutrition?.carbohydrates}g)`);
  console.log(`- Serialized has fat: ${parsedBack.nutrition?.fat === 42 ? "PASS" : "FAIL"} (${parsedBack.nutrition?.fat}g)`);
  console.log(`- Serialized has fiber: ${parsedBack.nutrition?.fiber === 3 ? "PASS" : "FAIL"} (${parsedBack.nutrition?.fiber}g)`);
  console.log(`- Serialized has sodium: ${parsedBack.nutrition?.sodium === 980 ? "PASS" : "FAIL"} (${parsedBack.nutrition?.sodium}mg)`);
}

runServingAudit().catch(console.error);
