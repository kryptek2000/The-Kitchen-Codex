import dotenv from "dotenv";
import { runWithAiFallback, resolveRoleCandidates } from "./ai/provider.js";
import type { AiJsonSchema, AiProvider } from "./ai/types.js";
import { estimateAlgorithmicNutrition } from "./nutritionEstimator.js";
import { logModelAttempt } from "./providerDiagnostics.js";

dotenv.config();

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
    servings?: number;
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

  // Heuristic Cook Time — only emit when there is real evidence. Prefer absence
  // over a fabricated default ("20 mins") that the recovery UI would otherwise
  // surface as a confidently-recovered value. Inference branches are still
  // labelled `medium`/`culinary_inference` so the modal shows them as guesses.
  type RecoveredText = { value: string; confidence: "high" | "medium" | "low"; source: "instructions_explicit" | "body_parsed" | "culinary_inference"; explanation: string };
  let cookTime: RecoveredText | undefined;
  let cookMinutes: number | null = null;

  if (extractedCookMins > 0) {
    cookMinutes = extractedCookMins;
    const h = Math.floor(extractedCookMins / 60);
    const m = extractedCookMins % 60;
    const value =
      extractedCookMins < 60
        ? `${extractedCookMins} mins`
        : m > 0
        ? `${h} hr ${m} mins`
        : `${h} ${h === 1 ? 'hr' : 'hrs'}`;
    cookTime = {
      value,
      confidence: "high",
      source: "instructions_explicit",
      explanation: `Calculated from specific cooking durations mentioned in the instructions (${extractedCookMins} mins)`,
    };
  } else if (allText.includes("rub") || allText.includes("seasoning") || allText.includes("marinade") || allText.includes("dressing")) {
    cookMinutes = 0;
    cookTime = { value: "0 mins", confidence: "medium", source: "culinary_inference", explanation: "Seasoning/rub blend requires no cooking time" };
  } else if (allText.includes("slow cooker") || allText.includes("crockpot")) {
    cookMinutes = 240;
    cookTime = { value: "4 hrs", confidence: "medium", source: "culinary_inference", explanation: "Inferred from slow-cooker method" };
  } else if (allText.includes("bake") || allText.includes("roast")) {
    cookMinutes = 35;
    cookTime = { value: "35 mins", confidence: "medium", source: "culinary_inference", explanation: "Estimated typical oven baking duration" };
  }

  // Heuristic Prep Time (bounded inference derived from ingredient count)
  let prepMins = Math.min(30, Math.max(5, (rawIngs.length || 5) * 2));
  if (allText.includes("rub") || allText.includes("seasoning")) prepMins = 5;
  const prepTimeStr = `${prepMins} mins`;

  // Heuristic Servings — only emit when an explicit yield exists or the recipe is
  // clearly a batch rub/seasoning. Never fall back to a baked-in "4 servings".
  let estimatedServings: number | undefined;
  let servingsConf: "high" | "medium" | "low" = "medium";
  let servingsExplanation = "";

  const servMatch = allText.match(/(?:serves|servings|yield|yields|makes)\s*[:\-–]?\s*(\d+)/i);
  if (servMatch) {
    estimatedServings = parseInt(servMatch[1], 10);
    servingsConf = "high";
    servingsExplanation = `Extracted from recipe notes: ${servMatch[0]}`;
  } else if (allText.includes("rub") || allText.includes("seasoning")) {
    estimatedServings = 12;
    servingsExplanation = "Yield estimated for spice rub batch (~12 portions)";
  }

  // The offline nutrition estimator always returns TOTAL batch nutrition, so a
  // serving count is only a label; fall back to a neutral number for labelling
  // without fabricating a recovered servings field.
  const nutritionServings = estimatedServings ?? 4;

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
  const nutResult = estimateAlgorithmicNutrition(title, nutritionServings, rawIngs.length > 0 ? rawIngs : ["1 portion ingredients"]);

  const result: MetadataRecoveryResult = {
    prepTime: {
      value: prepTimeStr,
      confidence: "medium",
      source: "culinary_inference",
      explanation: `Estimated prep time based on ingredient count (${rawIngs.length} ingredients)`,
    },
    totalTime: cookTime
      ? {
          value: `${prepMins + (cookMinutes ?? 0)} mins`,
          confidence: "medium",
          source: "culinary_inference",
          explanation: "Sum of estimated prep and cook times",
        }
      : undefined,
    calories: {
      value: nutResult.calories,
      confidence: "medium",
      source: "culinary_inference",
      explanation: `Calculated as total nutrition for the entire recipe batch across ${nutritionServings} servings`,
    },
    nutrition: {
      value: {
        calories: nutResult.calories,
        protein: nutResult.protein,
        carbohydrates: nutResult.carbohydrates,
        fat: nutResult.fat,
        fiber: nutResult.fiber,
        sodium: nutResult.sodium,
        servings: nutritionServings,
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

  // Zero-fabrication: only attach cooked/serving fields that actually have
  // evidence. Fields left `undefined` are not offered to the user for approval.
  if (cookTime) {
    result.cookTime = cookTime;
  }
  if (estimatedServings !== undefined) {
    result.servings = {
      value: estimatedServings,
      confidence: servingsConf,
      source: "culinary_inference",
      explanation: servingsExplanation,
    };
  }

  return result;
}

/** Builds the provider-neutral schema for a single recovered-field envelope. */
function recoveredField(valueSchema: AiJsonSchema): AiJsonSchema {
  return {
    type: "object",
    properties: {
      value: valueSchema,
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      source: { type: "string", enum: ["instructions_explicit", "body_parsed", "culinary_inference"] },
      explanation: { type: "string" },
    },
    required: ["value", "confidence", "source", "explanation"],
  };
}

/**
 * Provider-neutral structured schema for metadata recovery. Mirrors the prior
 * Gemini-native schema exactly, INCLUDING every model-guidance description hint
 * (the Phase 2A `description` extension), field names, types, enums, nested
 * object/array structure, and `required` constraints.
 */
function buildSchema(): AiJsonSchema {
  return {
    type: "object",
    properties: {
      prepTime: recoveredField({ type: "string", description: "Normalized prep time string, e.g., '15 mins'" }),
      cookTime: recoveredField({ type: "string", description: "Normalized cook time string, e.g., '25 mins'" }),
      totalTime: recoveredField({ type: "string", description: "Normalized total time string, e.g., '40 mins'" }),
      servings: recoveredField({ type: "number", description: "Yield / number of servings as an integer" }),
      calories: recoveredField({ type: "number", description: "Estimated total calories for the entire recipe batch" }),
      nutrition: recoveredField({
        type: "object",
        properties: {
          calories: { type: "number" },
          protein: { type: "number" },
          carbohydrates: { type: "number" },
          fat: { type: "number" },
          fiber: { type: "number" },
          sodium: { type: "number" },
          servings: { type: "number" },
          confidenceNote: { type: "string" },
        },
        required: ["calories", "protein", "carbohydrates", "fat", "fiber", "sodium"],
      }),
      category: recoveredField({ type: "string" }),
      cuisine: recoveredField({ type: "string" }),
      difficulty: recoveredField({ type: "string", enum: ["Easy", "Medium", "Hard"] }),
      suggestedTags: recoveredField({
        type: "array",
        items: { type: "string" },
        description: "Array of Obsidian tags, e.g., ['food/recipes', 'hawaiian', 'bbq']",
      }),
    },
  };
}

/**
 * AI structured-output adapter: recipe -> recovered metadata (validated/merged
 * downstream). Routes through the provider abstraction for a single resolved
 * (provider, model) candidate (`provider.generateStructured`) with the same
 * temperature (0.1) and the same MINIMAL thinking config. Candidate resolution
 * and cross-provider fallback are handled by `runWithAiFallback`; a model that
 * throws or returns empty/unparseable output is skipped so the caller can keep
 * the algorithmic fallback.
 */
async function aiRecoverMetadata(
  provider: AiProvider,
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
   - Calculate TOTAL nutrition for the entire recipe batch as written (do NOT divide by servings).
5. For category and cuisine:
   - Provide standard culinary categories (e.g., "Main Course", "Seasonings & Rubs", "Baking & Breads", "Soups & Stews", "Salads & Bowls", "Dessert", "Pasta", "Side Dish", "Appetizer").
6. For each recovered field, provide:
   - value
   - confidence ("high", "medium", or "low")
   - source ("instructions_explicit", "body_parsed", or "culinary_inference")
   - explanation (a brief, clear sentence justifying why this value was determined).
7. Return strictly valid JSON adhering to the schema.`;

  return await provider.generateStructured<MetadataRecoveryResult>(prompt, buildSchema(), {
    model: modelName,
    temperature: 0.1,
    providerOptions: { thinkingConfig: { thinkingLevel: "MINIMAL" } },
  });
}

/**
 * Recovers missing metadata for a recipe using a resilient, provider-neutral
 * fallback chain resolved per role: Gemini (primary -> fallback) -> OpenRouter
 * (when configured) -> DeepSeek (when configured) -> Algorithmic Fallback. The
 * capability selector only admits structured-output-capable candidates, so a
 * provider that cannot honor the `AiJsonSchema` contract is never executed.
 * Zero-fabrication and evidence-labelling are preserved by the algorithmic
 * fallback on total provider failure.
 */
export async function recoverRecipeMetadata(
  req: MetadataRecoveryRequest
): Promise<MetadataRecoveryResult> {
  try {
    const { result } = await runWithAiFallback<MetadataRecoveryResult>({
      candidates: resolveRoleCandidates("metadataRecovery"),
      requiredCapabilities: ["structuredOutput"],
      run: (candidate) => aiRecoverMetadata(candidate.provider, candidate.model, req),
    });
    return result;
  } catch (err: any) {
    const model = typeof err?.model === "string" ? err.model : "<unknown>";
    logModelAttempt("metadataRecovery", model, err);
    console.info("[MetadataRecovery] No capable AI provider succeeded. Executing algorithmic metadata recovery.");
    return recoverMetadataAlgorithmically(req);
  }
}
