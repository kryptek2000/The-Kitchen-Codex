import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { estimateAlgorithmicNutrition } from "./nutritionEstimator.js";
import { MODEL_CONFIG } from "./modelConfig.js";

dotenv.config();

let aiClient: GoogleGenAI | null = null;

function getGemini(): GoogleGenAI | null {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== "MY_GEMINI_API_KEY") {
      aiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
    }
  }
  return aiClient;
}

const PRIMARY_MODEL = MODEL_CONFIG.metadataRecoveryPrimary;
const FALLBACK_MODEL = MODEL_CONFIG.metadataRecoveryFallback;

export interface MetadataRecoveryRequest {
  title?: string;
  rawMarkdown?: string;
  ingredients?: Array<string | { original?: string; amount?: number | null; unit?: string; name?: string }>;
  instructions?: Array<string | { text?: string }>;
  notes?: string;
  existingMetadata?: {
    prepTime?: string;
    cookTime?: string;
    totalTime?: string;
    servings?: number;
    calories?: number | string;
    cuisine?: string;
    category?: string;
    difficulty?: string;
    tags?: string[];
  };
  targetFields?: string[];
}

export interface RecoveredFieldResponse<T = any> {
  value: T;
  confidence: "high" | "medium" | "low";
  source: "instructions_explicit" | "body_parsed" | "culinary_inference";
  explanation: string;
}

export interface MetadataRecoveryResult {
  prepTime?: RecoveredFieldResponse<string>;
  cookTime?: RecoveredFieldResponse<string>;
  totalTime?: RecoveredFieldResponse<string>;
  servings?: RecoveredFieldResponse<number>;
  calories?: RecoveredFieldResponse<number>;
  nutrition?: RecoveredFieldResponse<{
    calories?: number;
    protein?: number;
    carbohydrates?: number;
    fat?: number;
    fiber?: number;
    sodium?: number;
    confidenceNote?: string;
  }>;
  category?: RecoveredFieldResponse<string>;
  cuisine?: RecoveredFieldResponse<string>;
  difficulty?: RecoveredFieldResponse<"Easy" | "Medium" | "Hard">;
  suggestedTags?: RecoveredFieldResponse<string[]>;
}

function cleanWikilinks(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1");
}

/**
 * Fallback algorithmic metadata recovery engine for when Gemini is unavailable or rate limited.
 */
export function recoverMetadataAlgorithmically(
  req: MetadataRecoveryRequest
): MetadataRecoveryResult {
  const title = (req.title || "Untitled Recipe").trim();
  const rawMarkdown = req.rawMarkdown || "";

  // Parse ingredient lines
  const rawIngs: string[] = [];
  if (req.ingredients && Array.isArray(req.ingredients)) {
    for (const item of req.ingredients) {
      if (typeof item === "string" && item.trim()) rawIngs.push(cleanWikilinks(item.trim()));
      else if (item && typeof item === "object") {
        const line = item.original || `${item.amount || ""} ${item.unit || ""} ${item.name || ""}`.trim();
        if (line) rawIngs.push(cleanWikilinks(line));
      }
    }
  }

  // Parse instruction lines
  const rawSteps: string[] = [];
  if (req.instructions && Array.isArray(req.instructions)) {
    for (const item of req.instructions) {
      if (typeof item === "string" && item.trim()) rawSteps.push(cleanWikilinks(item.trim()));
      else if (item && typeof item === "object" && item.text) rawSteps.push(cleanWikilinks(item.text.trim()));
    }
  }

  const allText = `${title}\n${rawMarkdown}\n${rawSteps.join("\n")}\n${rawIngs.join("\n")}`.toLowerCase();

  // 1. Scan for explicit timings in text
  let extractedCookMins = 0;
  for (const step of rawSteps) {
    const minMatch = step.match(/(\d+)\s*(?:minutes|minute|mins|min)\b/i);
    const hrMatch = step.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/i);
    if (hrMatch) {
      extractedCookMins += Math.round(parseFloat(hrMatch[1]) * 60);
    } else if (minMatch) {
      extractedCookMins += parseInt(minMatch[1], 10);
    }
  }

  // Heuristic Cook Time
  let cookTimeStr = "20 mins";
  let cookTimeConf: "high" | "medium" | "low" = "low";
  let cookTimeSrc: "instructions_explicit" | "body_parsed" | "culinary_inference" = "culinary_inference";
  let cookExplanation = "Estimated based on standard culinary preparation times";

  if (extractedCookMins > 0) {
    if (extractedCookMins >= 60) {
      const h = Math.floor(extractedCookMins / 60);
      const m = extractedCookMins % 60;
      cookTimeStr = m > 0 ? `${h} hr ${m} mins` : `${h} ${h === 1 ? 'hr' : 'hrs'}`;
    } else {
      cookTimeStr = `${extractedCookMins} mins`;
    }
    cookTimeConf = "high";
    cookTimeSrc = "instructions_explicit";
    cookExplanation = `Calculated from specific cooking durations mentioned in the instructions (${extractedCookMins} mins)`;
  } else if (allText.includes("rub") || allText.includes("seasoning") || allText.includes("marinade") || allText.includes("dressing")) {
    cookTimeStr = "0 mins";
    cookTimeConf = "medium";
    cookTimeSrc = "culinary_inference";
    cookExplanation = "Seasoning/rub blend requires no cooking time";
  } else if (allText.includes("slow cooker") || allText.includes("crockpot")) {
    cookTimeStr = "4 hrs";
    cookTimeConf = "medium";
    cookTimeSrc = "culinary_inference";
    cookExplanation = "Inferred from slow-cooker method";
  } else if (allText.includes("bake") || allText.includes("roast")) {
    cookTimeStr = "35 mins";
    cookTimeConf = "medium";
    cookTimeSrc = "culinary_inference";
    cookExplanation = "Estimated typical oven baking duration";
  }

  // Heuristic Prep Time
  let prepMins = Math.min(30, Math.max(5, (rawIngs.length || 5) * 2));
  if (allText.includes("rub") || allText.includes("seasoning")) prepMins = 5;
  const prepTimeStr = `${prepMins} mins`;

  // Heuristic Servings
  let estimatedServings = 4;
  let servingsConf: "high" | "medium" | "low" = "medium";
  let servingsExplanation = "Estimated standard household yield of 4 servings";

  const servMatch = allText.match(/(?:serves|servings|yield|yields|makes)\s*[:\-–]?\s*(\d+)/i);
  if (servMatch) {
    estimatedServings = parseInt(servMatch[1], 10);
    servingsConf = "high";
    servingsExplanation = `Extracted from recipe notes: ${servMatch[0]}`;
  } else if (allText.includes("rub") || allText.includes("seasoning")) {
    estimatedServings = 12;
    servingsExplanation = "Yield estimated for spice rub batch (~12 portions)";
  }

  // Heuristic Cuisine & Category
  let cuisine = "General";
  let category = "Main Course";
  const tags: string[] = ["food/recipes"];

  if (allText.includes("hawaiian") || allText.includes("aloha") || allText.includes("poke") || allText.includes("luau")) {
    cuisine = "Hawaiian";
    tags.push("hawaiian");
  } else if (allText.includes("italian") || allText.includes("pasta") || allText.includes("parmesan") || allText.includes("guanciale") || allText.includes("risotto")) {
    cuisine = "Italian";
    tags.push("italian");
  } else if (allText.includes("japanese") || allText.includes("ramen") || allText.includes("miso") || allText.includes("matcha") || allText.includes("shoyu")) {
    cuisine = "Japanese";
    tags.push("japanese");
  } else if (allText.includes("thai") || allText.includes("curry") || allText.includes("coconut milk") || allText.includes("fish sauce")) {
    cuisine = "Thai";
    tags.push("thai");
  } else if (allText.includes("mexican") || allText.includes("taco") || allText.includes("salsa") || allText.includes("cilantro")) {
    cuisine = "Mexican";
    tags.push("mexican");
  } else if (allText.includes("french") || allText.includes("sourdough") || allText.includes("boule")) {
    cuisine = "French";
    tags.push("french");
  } else if (allText.includes("bbq") || allText.includes("barbecue") || allText.includes("rib")) {
    cuisine = "American BBQ";
    tags.push("bbq", "american");
  }

  if (allText.includes("rub") || allText.includes("seasoning") || allText.includes("spice blend")) {
    category = "Seasonings & Rubs";
    tags.push("seasoning", "dry-rub");
  } else if (allText.includes("soup") || allText.includes("stew") || allText.includes("ramen") || allText.includes("broth")) {
    category = "Soups & Stews";
    tags.push("soup");
  } else if (allText.includes("salad") || allText.includes("dressing")) {
    category = "Salads & Bowls";
    tags.push("salad");
  } else if (allText.includes("bread") || allText.includes("sourdough") || allText.includes("baking")) {
    category = "Baking & Breads";
    tags.push("baking", "bread");
  } else if (allText.includes("dessert") || allText.includes("cake") || allText.includes("chocolate") || allText.includes("cookie")) {
    category = "Dessert";
    tags.push("dessert", "sweet");
  } else if (allText.includes("pasta") || allText.includes("spaghetti") || allText.includes("carbonara")) {
    category = "Pasta";
    tags.push("pasta");
  }

  // Nutrition estimation
  const nutResult = estimateAlgorithmicNutrition(title, estimatedServings, rawIngs.length > 0 ? rawIngs : ["1 portion ingredients"]);

  return {
    prepTime: {
      value: prepTimeStr,
      confidence: "medium",
      source: "culinary_inference",
      explanation: `Estimated prep time based on ingredient count (${rawIngs.length} ingredients)`,
    },
    cookTime: {
      value: cookTimeStr,
      confidence: cookTimeConf,
      source: cookTimeSrc,
      explanation: cookExplanation,
    },
    totalTime: {
      value: `${prepMins + (extractedCookMins || 20)} mins`,
      confidence: "medium",
      source: "culinary_inference",
      explanation: "Sum of estimated prep and cook times",
    },
    servings: {
      value: estimatedServings,
      confidence: servingsConf,
      source: "culinary_inference",
      explanation: servingsExplanation,
    },
    calories: {
      value: nutResult.calories,
      confidence: "medium",
      source: "culinary_inference",
      explanation: `Calculated from ${rawIngs.length} ingredients divided across ${estimatedServings} servings`,
    },
    nutrition: {
      value: {
        calories: nutResult.calories,
        protein: nutResult.protein,
        carbohydrates: nutResult.carbohydrates,
        fat: nutResult.fat,
        fiber: nutResult.fiber,
        sodium: nutResult.sodium,
        confidenceNote: nutResult.confidenceNote,
      },
      confidence: "medium",
      source: "culinary_inference",
      explanation: "Estimated macronutrient breakdown based on culinary database heuristics",
    },
    category: {
      value: category,
      confidence: "medium",
      source: "culinary_inference",
      explanation: `Classified as ${category} from recipe title and ingredients`,
    },
    cuisine: {
      value: cuisine,
      confidence: "medium",
      source: "culinary_inference",
      explanation: `Detected ${cuisine} cuisine profile from flavor and ingredient markers`,
    },
    difficulty: {
      value: rawSteps.length > 6 || allText.includes("sourdough") ? "Hard" : rawSteps.length > 3 ? "Medium" : "Easy",
      confidence: "medium",
      source: "culinary_inference",
      explanation: `Difficulty inferred from technique complexity and ${rawSteps.length} instruction steps`,
    },
    suggestedTags: {
      value: Array.from(new Set(tags)),
      confidence: "high",
      source: "culinary_inference",
      explanation: "Curated Obsidian hashtags for culinary search and Dataview tables",
    },
  };
}

async function callGeminiForRecovery(
  gemini: GoogleGenAI,
  modelName: string,
  req: MetadataRecoveryRequest
): Promise<MetadataRecoveryResult> {
  const title = (req.title || "Culinary Recipe").trim();
  const rawMarkdown = req.rawMarkdown || "";
  const existing = req.existingMetadata || {};

  const prompt = `You are the Obsidian Vault Intelligence AI engine for The Kitchen Codex.
Your task is to analyze an existing or legacy culinary recipe and recover/estimate missing structured metadata.

Recipe Title: ${title}

Existing Frontmatter / Metadata:
- Prep Time: ${existing.prepTime || "MISSING"}
- Cook Time: ${existing.cookTime || "MISSING"}
- Total Time: ${existing.totalTime || "MISSING"}
- Servings: ${existing.servings || "MISSING"}
- Calories: ${existing.calories || "MISSING"}
- Category: ${existing.category || "MISSING"}
- Cuisine: ${existing.cuisine || "MISSING"}
- Difficulty: ${existing.difficulty || "MISSING"}
- Current Tags: ${(existing.tags || []).join(", ") || "MISSING"}

Full Recipe Text / Markdown:
${rawMarkdown.slice(0, 15000)}

Guidelines:
1. Examine the ingredient list, instructions, cooking temperatures, step durations, and notes.
2. For any timing (prep_time, cook_time, total_time):
   - Standardize format into clean strings (e.g. "15 mins", "45 mins", "1 hr 30 mins", "0 mins" for dry rubs/marinades).
   - If cook times are mentioned explicitly in steps (e.g. "bake for 25 minutes"), mark source as "instructions_explicit" and confidence "high".
3. For servings:
   - Provide a sensible integer (e.g. 4 for dinners, 12 for cookies/muffins/rubs, 8 for breads/cakes).
4. For calories and nutrition:
   - Calculate reasonable per-serving values based on ingredients and servings.
5. For category and cuisine:
   - Provide standard culinary categories (e.g., "Main Course", "Seasonings & Rubs", "Baking & Breads", "Soups & Stews", "Salads & Bowls", "Dessert", "Pasta", "Side Dish", "Appetizer").
6. For each recovered field, provide:
   - value
   - confidence ("high", "medium", or "low")
   - source ("instructions_explicit", "body_parsed", or "culinary_inference")
   - explanation (a brief, clear sentence justifying why this value was determined).
7. Return strictly valid JSON adhering to the schema.`;

  const response = await gemini.models.generateContent({
    model: modelName,
    contents: prompt,
    config: {
      temperature: 0.1,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          prepTime: {
            type: Type.OBJECT,
            properties: {
              value: { type: Type.STRING, description: "Normalized prep time string, e.g., '15 mins'" },
              confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
              source: { type: Type.STRING, enum: ["instructions_explicit", "body_parsed", "culinary_inference"] },
              explanation: { type: Type.STRING },
            },
            required: ["value", "confidence", "source", "explanation"],
          },
          cookTime: {
            type: Type.OBJECT,
            properties: {
              value: { type: Type.STRING, description: "Normalized cook time string, e.g., '25 mins'" },
              confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
              source: { type: Type.STRING, enum: ["instructions_explicit", "body_parsed", "culinary_inference"] },
              explanation: { type: Type.STRING },
            },
            required: ["value", "confidence", "source", "explanation"],
          },
          totalTime: {
            type: Type.OBJECT,
            properties: {
              value: { type: Type.STRING, description: "Normalized total time string, e.g., '40 mins'" },
              confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
              source: { type: Type.STRING, enum: ["instructions_explicit", "body_parsed", "culinary_inference"] },
              explanation: { type: Type.STRING },
            },
            required: ["value", "confidence", "source", "explanation"],
          },
          servings: {
            type: Type.OBJECT,
            properties: {
              value: { type: Type.NUMBER, description: "Yield / number of servings as an integer" },
              confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
              source: { type: Type.STRING, enum: ["instructions_explicit", "body_parsed", "culinary_inference"] },
              explanation: { type: Type.STRING },
            },
            required: ["value", "confidence", "source", "explanation"],
          },
          calories: {
            type: Type.OBJECT,
            properties: {
              value: { type: Type.NUMBER, description: "Estimated calories per serving" },
              confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
              source: { type: Type.STRING, enum: ["instructions_explicit", "body_parsed", "culinary_inference"] },
              explanation: { type: Type.STRING },
            },
            required: ["value", "confidence", "source", "explanation"],
          },
          nutrition: {
            type: Type.OBJECT,
            properties: {
              value: {
                type: Type.OBJECT,
                properties: {
                  calories: { type: Type.NUMBER },
                  protein: { type: Type.NUMBER },
                  carbohydrates: { type: Type.NUMBER },
                  fat: { type: Type.NUMBER },
                  fiber: { type: Type.NUMBER },
                  sodium: { type: Type.NUMBER },
                  confidenceNote: { type: Type.STRING },
                },
                required: ["calories", "protein", "carbohydrates", "fat", "fiber", "sodium"],
              },
              confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
              source: { type: Type.STRING, enum: ["instructions_explicit", "body_parsed", "culinary_inference"] },
              explanation: { type: Type.STRING },
            },
            required: ["value", "confidence", "source", "explanation"],
          },
          category: {
            type: Type.OBJECT,
            properties: {
              value: { type: Type.STRING },
              confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
              source: { type: Type.STRING, enum: ["instructions_explicit", "body_parsed", "culinary_inference"] },
              explanation: { type: Type.STRING },
            },
            required: ["value", "confidence", "source", "explanation"],
          },
          cuisine: {
            type: Type.OBJECT,
            properties: {
              value: { type: Type.STRING },
              confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
              source: { type: Type.STRING, enum: ["instructions_explicit", "body_parsed", "culinary_inference"] },
              explanation: { type: Type.STRING },
            },
            required: ["value", "confidence", "source", "explanation"],
          },
          difficulty: {
            type: Type.OBJECT,
            properties: {
              value: { type: Type.STRING, enum: ["Easy", "Medium", "Hard"] },
              confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
              source: { type: Type.STRING, enum: ["instructions_explicit", "body_parsed", "culinary_inference"] },
              explanation: { type: Type.STRING },
            },
            required: ["value", "confidence", "source", "explanation"],
          },
          suggestedTags: {
            type: Type.OBJECT,
            properties: {
              value: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "Array of Obsidian tags, e.g., ['food/recipes', 'hawaiian', 'bbq']",
              },
              confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
              source: { type: Type.STRING, enum: ["instructions_explicit", "body_parsed", "culinary_inference"] },
              explanation: { type: Type.STRING },
            },
            required: ["value", "confidence", "source", "explanation"],
          },
        },
      },
    },
  });

  const responseText = response.text?.trim();
  if (!responseText) {
    throw new Error("Empty response returned from AI model.");
  }

  const parsed = JSON.parse(responseText);
  return parsed as MetadataRecoveryResult;
}

/**
 * Recovers missing metadata for a recipe using a resilient fallback chain:
 * Primary (gemini-3.7-flash) -> Fallback (gemini-3.1-flash-lite) -> Algorithmic Fallback
 */
export async function recoverRecipeMetadata(
  req: MetadataRecoveryRequest
): Promise<MetadataRecoveryResult> {
  const gemini = getGemini();

  if (!gemini) {
    console.info("[MetadataRecovery] No Gemini API key configured. Executing algorithmic metadata recovery.");
    return recoverMetadataAlgorithmically(req);
  }

  // Attempt 1: Primary Model (gemini-3.7-flash)
  try {
    return await callGeminiForRecovery(gemini, PRIMARY_MODEL, req);
  } catch (primaryErr: any) {
    console.warn(`[MetadataRecovery] Primary model (${PRIMARY_MODEL}) failed: ${primaryErr?.message || primaryErr}. Attempting fallback (${FALLBACK_MODEL})...`);

    // Attempt 2: Fallback Model (gemini-3.1-flash-lite)
    try {
      return await callGeminiForRecovery(gemini, FALLBACK_MODEL, req);
    } catch (fallbackErr: any) {
      console.warn(`[MetadataRecovery] Fallback model (${FALLBACK_MODEL}) failed: ${fallbackErr?.message || fallbackErr}. Engaging algorithmic fallback...`);

      // Attempt 3: Algorithmic Recovery
      return recoverMetadataAlgorithmically(req);
    }
  }
}
