import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import dotenv from "dotenv";
import { MODEL_CONFIG } from "./modelConfig.js";
import { getGemini } from "./geminiClient.js";
import type { NutritionSource, NutritionConfidence } from "../src/schema/recipeSchema.js";

dotenv.config();

export interface NutritionEstimateRequest {
  title?: string;
  servings?: number;
  ingredients: Array<string | { original?: string; amount?: number | null; unit?: string; name?: string }>;
}

export interface NutritionEstimateResult {
  calories: number; // kcal for the entire recipe batch
  protein: number; // g for the entire recipe batch
  carbohydrates: number; // g for the entire recipe batch
  fat: number; // g for the entire recipe batch
  fiber: number; // g for the entire recipe batch
  sodium: number; // mg for the entire recipe batch
  confidenceNote: string;
  /** Provenance authority, assigned by application logic (never model-self-rated). */
  source: NutritionSource;
  /** Application-assigned confidence (never model-self-rated). */
  confidence: NutritionConfidence;
}

const PRIMARY_MODEL = MODEL_CONFIG.nutritionPrimary;
const FALLBACK_MODEL = MODEL_CONFIG.nutritionFallback;

/**
 * Strips Obsidian wikilinks [[Target|Alias]] -> Alias, [[Target]] -> Target
 * solely for prompt input clarity without touching raw recipe files.
 */
function cleanWikilinks(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1");
}

/**
 * Fallback algorithmic culinary nutritional estimator based on standard
 * ingredient profiles.
 *
 * Returns TOTAL nutrition for the supplied recipe batch as written. The
 * `servings` argument is accepted for signature compatibility only and is NOT
 * used as a divisor — the result is invariant to the requested serving count.
 */
export function estimateAlgorithmicNutrition(
  recipeTitle: string,
  servings: number,
  ingredientLines: string[]
): NutritionEstimateResult {
  let totalCalories = 0;
  let totalProtein = 0;
  let totalCarbs = 0;
  let totalFat = 0;
  let totalFiber = 0;
  let totalSodium = 0;

  for (const rawLine of ingredientLines) {
    const line = cleanWikilinks(rawLine);
    const lower = line.toLowerCase();
    
    // Extract numerical amount if present
    const amountMatch = lower.match(/(\d+(?:\.\d+)?|\d+\s*\/\s*\d+)/);
    let amount = 1;
    if (amountMatch) {
      const rawNum = amountMatch[1];
      if (rawNum.includes('/')) {
        const parts = rawNum.split('/');
        amount = parseFloat(parts[0]) / parseFloat(parts[1]);
      } else {
        amount = parseFloat(rawNum);
      }
    }

    if (lower.includes('pasta') || lower.includes('spaghetti') || lower.includes('rigatoni') || lower.includes('noodle') || lower.includes('rice') || lower.includes('flour') || lower.includes('oat') || lower.includes('grain') || lower.includes('quinoa') || lower.includes('couscous') || lower.includes('barley')) {
      const multiplier = lower.includes('lb') || lower.includes('pound') ? amount * 450 : lower.includes('cup') ? amount * 80 : lower.includes('g') ? amount : amount * 100;
      totalCalories += (multiplier / 100) * 360;
      totalProtein += (multiplier / 100) * 12;
      totalCarbs += (multiplier / 100) * 70;
      totalFat += (multiplier / 100) * 3;
      totalFiber += (multiplier / 100) * 6;
      totalSodium += (multiplier / 100) * 5;
    } else if (lower.includes('walnut') || lower.includes('almond') || lower.includes('pecan') || lower.includes('cashew') || lower.includes('peanut') || lower.includes('nut') || lower.includes('seed') || lower.includes('chia') || lower.includes('flax')) {
      const multiplier = lower.includes('cup') ? amount * 120 : lower.includes('tbsp') ? amount * 15 : lower.includes('g') ? amount : lower.includes('oz') ? amount * 28.3 : amount * 30;
      totalCalories += (multiplier / 100) * 600;
      totalProtein += (multiplier / 100) * 18;
      totalCarbs += (multiplier / 100) * 16;
      totalFat += (multiplier / 100) * 55;
      totalFiber += (multiplier / 100) * 8;
      totalSodium += (multiplier / 100) * 5;
    } else if (lower.includes('salmon') || lower.includes('tuna') || lower.includes('fish') || lower.includes('shrimp') || lower.includes('seafood') || lower.includes('cod')) {
      const multiplier = lower.includes('g') ? amount : lower.includes('oz') ? amount * 28.3 : lower.includes('lb') ? amount * 450 : amount * 120;
      totalCalories += (multiplier / 100) * 180;
      totalProtein += (multiplier / 100) * 25;
      totalFat += (multiplier / 100) * 8;
      totalSodium += (multiplier / 100) * 80;
    } else if (lower.includes('chicken') || lower.includes('poultry') || lower.includes('turkey')) {
      const multiplier = lower.includes('g') ? amount : lower.includes('oz') ? amount * 28.3 : lower.includes('lb') ? amount * 450 : amount * 120;
      totalCalories += (multiplier / 100) * 165;
      totalProtein += (multiplier / 100) * 31;
      totalFat += (multiplier / 100) * 3.6;
      totalSodium += (multiplier / 100) * 70;
    } else if (lower.includes('guanciale') || lower.includes('pancetta') || lower.includes('bacon') || lower.includes('pork') || lower.includes('beef') || lower.includes('steak')) {
      const multiplier = lower.includes('g') ? amount : lower.includes('oz') ? amount * 28.3 : lower.includes('lb') ? amount * 450 : amount * 50;
      totalCalories += (multiplier / 100) * 600;
      totalProtein += (multiplier / 100) * 15;
      totalFat += (multiplier / 100) * 60;
      totalSodium += (multiplier / 100) * 1200;
    } else if (lower.includes('bean') || lower.includes('chickpea') || lower.includes('lentil') || lower.includes('tofu') || lower.includes('edamame')) {
      const multiplier = lower.includes('cup') ? amount * 180 : lower.includes('can') ? amount * 240 : lower.includes('g') ? amount : amount * 100;
      totalCalories += (multiplier / 100) * 140;
      totalProtein += (multiplier / 100) * 9;
      totalCarbs += (multiplier / 100) * 22;
      totalFat += (multiplier / 100) * 2;
      totalFiber += (multiplier / 100) * 7;
      totalSodium += (multiplier / 100) * 150;
    } else if (lower.includes('egg yolk') || lower.includes('yolk')) {
      totalCalories += amount * 55;
      totalProtein += amount * 2.7;
      totalFat += amount * 4.5;
      totalSodium += amount * 8;
    } else if (lower.includes('egg')) {
      totalCalories += amount * 72;
      totalProtein += amount * 6.3;
      totalFat += amount * 4.8;
      totalSodium += amount * 71;
    } else if (lower.includes('pecorino') || lower.includes('parmesan') || lower.includes('parmigiano') || lower.includes('cheese') || lower.includes('cheddar') || lower.includes('mozzarella')) {
      const multiplier = lower.includes('cup') ? amount * 100 : lower.includes('g') ? amount : lower.includes('oz') ? amount * 28.3 : amount * 30;
      totalCalories += (multiplier / 100) * 390;
      totalProtein += (multiplier / 100) * 32;
      totalFat += (multiplier / 100) * 28;
      totalSodium += (multiplier / 100) * 1800;
    } else if (lower.includes('milk') || lower.includes('yogurt')) {
      const multiplier = lower.includes('cup') ? amount * 240 : lower.includes('tbsp') ? amount * 15 : amount * 100;
      totalCalories += (multiplier / 100) * 60;
      totalProtein += (multiplier / 100) * 4;
      totalCarbs += (multiplier / 100) * 5;
      totalFat += (multiplier / 100) * 3;
      totalSodium += (multiplier / 100) * 50;
    } else if (lower.includes('oil') || lower.includes('butter')) {
      const multiplier = lower.includes('tbsp') ? amount * 14 : lower.includes('tsp') ? amount * 5 : lower.includes('cup') ? amount * 220 : amount * 14;
      totalCalories += (multiplier / 14) * 120;
      totalFat += (multiplier / 14) * 14;
    } else if (lower.includes('cream')) {
      const multiplier = lower.includes('cup') ? amount * 240 : lower.includes('tbsp') ? amount * 15 : amount * 100;
      totalCalories += (multiplier / 100) * 340;
      totalFat += (multiplier / 100) * 36;
      totalProtein += (multiplier / 100) * 2.8;
      totalCarbs += (multiplier / 100) * 2.7;
    } else if (lower.includes('salt')) {
      totalSodium += (lower.includes('tsp') ? amount * 2300 : 300);
    } else if (lower.includes('sugar') || lower.includes('honey') || lower.includes('syrup')) {
      const multiplier = lower.includes('tbsp') ? amount * 15 : lower.includes('cup') ? amount * 200 : amount * 15;
      totalCalories += (multiplier / 15) * 60;
      totalCarbs += (multiplier / 15) * 15;
    } else if (lower.includes('berry') || lower.includes('blueberr') || lower.includes('strawberr') || lower.includes('apple') || lower.includes('banana') || lower.includes('fruit')) {
      const multiplier = lower.includes('cup') ? amount * 150 : lower.includes('g') ? amount : amount * 100;
      totalCalories += (multiplier / 100) * 60;
      totalCarbs += (multiplier / 100) * 14;
      totalFiber += (multiplier / 100) * 3;
      totalProtein += (multiplier / 100) * 1;
    } else {
      // General vegetable, spice, broth, condiment baseline
      totalCalories += 25;
      totalCarbs += 4;
      totalProtein += 1;
      totalFiber += 1;
      totalSodium += 50;
    }
  }

  // Ensure a reasonable serving-independent baseline only if no ingredients
  // yielded calories. The baseline scales with the number of ingredient lines,
  // NOT with the requested serving count, so the recipe-total nutrition stays
  // stable regardless of how many servings the user later selects.
  if (totalCalories <= 0) {
    const count = Math.max(1, ingredientLines.length);
    totalCalories = 450 * count;
    totalProtein = 18 * count;
    totalCarbs = 45 * count;
    totalFat = 15 * count;
    totalFiber = 3 * count;
    totalSodium = 600 * count;
  }

  // These are TOTAL nutrition values for the entire recipe batch as written.
  // They are intentionally independent of the requested serving count; serving
  // arithmetic is performed deterministically by the application on the frontend
  // (nutritionForServings). The `servings` argument is accepted for signature
  // compatibility only and is never used as a divisor.
  return {
    calories: Math.max(0, Math.round(totalCalories)),
    protein: Math.max(0, Math.round(totalProtein * 10) / 10),
    carbohydrates: Math.max(0, Math.round(totalCarbs * 10) / 10),
    fat: Math.max(0, Math.round(totalFat * 10) / 10),
    fiber: Math.max(0, Math.round(totalFiber * 10) / 10),
    sodium: Math.max(0, Math.round(totalSodium)),
    confidenceNote: `Nutrition values are estimates for the entire recipe based on ${ingredientLines.length} ingredients.`,
    source: 'offline_heuristic' as NutritionSource,
    confidence: 'low' as NutritionConfidence,
  };
}

async function callGeminiForNutrition(
  gemini: GoogleGenAI,
  modelName: string,
  recipeTitle: string,
  servings: number,
  cleanedIngredientLines: string[]
): Promise<NutritionEstimateResult> {
  const prompt = `You are a certified culinary nutritional analysis engine for The Kitchen Codex.
Analyze the following recipe and its ingredients to calculate the estimated TOTAL nutritional content for the ENTIRE recipe batch, exactly as written. Do NOT divide by any number of servings.

Recipe Title: ${recipeTitle}

Ingredients:
${cleanedIngredientLines.map(line => `- ${line}`).join("\n")}

Guidelines:
1. Calculate total values for the entire supplied ingredient batch (do NOT divide by servings).
2. Account for cooking methods and typical absorption (e.g. oil used in sautéing/frying).
3. If an ingredient has "to taste", "pinch", "dash", or unstated amount, estimate standard modest culinary quantities.
4. Output strictly the requested JSON structure with integers/decimals rounded to 1 decimal place (calories as whole integer).
5. Provide a brief, factual confidence note.`;

  const response = await gemini.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      temperature: 0.1,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          calories: {
            type: Type.NUMBER,
            description: "Estimated total calories for the entire recipe batch in kcal",
          },
          protein: {
            type: Type.NUMBER,
            description: "Estimated total protein for the entire recipe batch in grams",
          },
          carbohydrates: {
            type: Type.NUMBER,
            description: "Estimated total carbohydrates for the entire recipe batch in grams",
          },
          fat: {
            type: Type.NUMBER,
            description: "Estimated total fat for the entire recipe batch in grams",
          },
          fiber: {
            type: Type.NUMBER,
            description: "Estimated total dietary fiber for the entire recipe batch in grams",
          },
          sodium: {
            type: Type.NUMBER,
            description: "Estimated total sodium for the entire recipe batch in milligrams",
          },
          confidenceNote: {
            type: Type.STRING,
            description: "A short qualification message regarding the estimation",
          },
        },
        required: [
          "calories",
          "protein",
          "carbohydrates",
          "fat",
          "fiber",
          "sodium",
        ],
      },
    },
  });

  const responseText = response.text?.trim();
  if (!responseText) {
    throw new Error("Empty response returned from AI model.");
  }

  const parsed = JSON.parse(responseText);
  const calories = Math.max(0, Math.round(Number(parsed.calories) || 0));
  const protein = Math.max(0, Math.round((Number(parsed.protein) || 0) * 10) / 10);
  const carbohydrates = Math.max(0, Math.round((Number(parsed.carbohydrates) || 0) * 10) / 10);
  const fat = Math.max(0, Math.round((Number(parsed.fat) || 0) * 10) / 10);
  const fiber = Math.max(0, Math.round((Number(parsed.fiber) || 0) * 10) / 10);
  const sodium = Math.max(0, Math.round(Number(parsed.sodium) || 0));
  const confidenceNote =
    typeof parsed.confidenceNote === "string" && parsed.confidenceNote.trim()
      ? parsed.confidenceNote.trim()
      : `Nutrition values are estimates for the entire recipe based on ${cleanedIngredientLines.length} ingredients.`;

  return {
    calories,
    protein,
    carbohydrates,
    fat,
    fiber,
    sodium,
    confidenceNote,
    source: 'ai_estimate' as NutritionSource,
    confidence: 'medium' as NutritionConfidence,
  };
}

/**
 * Estimates TOTAL nutrition for the entire recipe batch using a resilient
 * fallback chain: Primary (gemini-3.7-flash) -> Fallback (gemini-3.1-flash-lite)
 * -> Algorithmic Fallback.
 *
 * The returned values represent the ENTIRE supplied recipe batch, not per
 * serving. They are invariant to the `servings` field in the request (accepted
 * for API compatibility only; it is never used as a nutrition denominator).
 * All serving arithmetic is performed deterministically by the application.
 */
export async function estimateRecipeNutrition(
  req: NutritionEstimateRequest
): Promise<NutritionEstimateResult> {
  const recipeTitle = req.title ? req.title.trim().slice(0, 200) : "Culinary Recipe";
  const servings = Math.max(1, Math.min(100, Number(req.servings) || 4));

  if (!req.ingredients || !Array.isArray(req.ingredients) || req.ingredients.length === 0) {
    throw new Error("Please provide a list of ingredients to estimate nutrition.");
  }

  // Format ingredients list and clean Obsidian wikilinks for the prompt
  const rawIngredientLines: string[] = [];
  const cleanedIngredientLines: string[] = [];

  for (let i = 0; i < Math.min(req.ingredients.length, 100); i++) {
    const item = req.ingredients[i];
    let line = "";
    if (typeof item === "string") {
      line = item.trim().slice(0, 300);
    } else if (item && typeof item === "object") {
      line = (item.original || `${item.amount || ''} ${item.unit || ''} ${item.name || ''}`).trim().slice(0, 300);
    }

    if (line) {
      rawIngredientLines.push(line);
      cleanedIngredientLines.push(cleanWikilinks(line));
    }
  }

  if (cleanedIngredientLines.length === 0) {
    throw new Error("No valid ingredient lines were provided.");
  }

  const gemini = getGemini();
  if (!gemini) {
    console.info("[NutritionEstimator] No Gemini client configured. Using algorithmic nutrition estimation.");
    return estimateAlgorithmicNutrition(recipeTitle, servings, rawIngredientLines);
  }

  // Attempt 1: Primary Model (gemini-3.7-flash)
  try {
    return await callGeminiForNutrition(gemini, PRIMARY_MODEL, recipeTitle, servings, cleanedIngredientLines);
  } catch (primaryErr: any) {
    console.warn(`[NutritionEstimator] Primary model (${PRIMARY_MODEL}) failed: ${primaryErr?.message || primaryErr}. Attempting fallback (${FALLBACK_MODEL})...`);
    
    // Attempt 2: Fallback Model (gemini-3.1-flash-lite)
    try {
      return await callGeminiForNutrition(gemini, FALLBACK_MODEL, recipeTitle, servings, cleanedIngredientLines);
    } catch (fallbackErr: any) {
      console.warn(`[NutritionEstimator] Fallback model (${FALLBACK_MODEL}) failed: ${fallbackErr?.message || fallbackErr}. Engaging algorithmic fallback...`);
      
      // Attempt 3: Algorithmic Culinary Estimator
      return estimateAlgorithmicNutrition(recipeTitle, servings, rawIngredientLines);
    }
  }
}

