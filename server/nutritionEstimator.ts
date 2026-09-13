import dotenv from "dotenv";
import { resolveRoleCandidates, runWithAiFallback } from "./ai/provider.js";
import type { AiJsonSchema, AiProvider } from "./ai/types.js";
import type { SelectionInput } from "./ai/effectiveSelection.js";
import { logModelAttempt } from "./providerDiagnostics.js";
import {
  estimateDeterministicNutrition,
  type DeterministicNutritionResult,
} from "./deterministicNutrition.js";
import {
  buildDeterministicCacheKey,
  getDeterministicNutritionCache,
  setDeterministicNutritionCache,
} from "./nutritionCache.js";
import {
  validateNutritionNumbers,
  NUTRITION_CALCULATION_ID,
  NUTRITION_CALCULATION_VERSION,
  type NutritionAssessment,
  type NutritionProvenance,
  type NutritionResolutionRecord,
  type NutritionConversionBasis,
} from "../src/core/nutritionSanity.js";
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
  /**
   * Additive whole-recipe resolution assessment. Never a nutrient value and
   * never persisted to Markdown. Absent for AI estimates (which are not matched
   * in the curated local reference and therefore never automatically
   * applicable).
   */
  assessment?: NutritionAssessment;
}

const TRUSTED_CONVERSION_BASES: readonly NutritionConversionBasis[] = [
  'direct_mass',
  'density',
  'count_weight',
];

function isTrustedBasis(reason: string): reason is NutritionConversionBasis {
  return (TRUSTED_CONVERSION_BASES as readonly string[]).includes(reason);
}

/**
 * Builds the structured, auditable assessment for a curated deterministic
 * result. Resolution is trusted ONLY when it came from an exact curated food
 * record (`matchedFoodId`) with a real conversion basis. Keyword/category hits
 * cannot exist here because the algorithmic profile layer has been removed.
 */
function buildDeterministicAssessment(
  det: DeterministicNutritionResult,
  baseServings?: number
): NutritionAssessment {
  const resolved: NutritionResolutionRecord[] = [];
  for (const c of det.contributions) {
    if (
      c.resolved &&
      c.matchedFoodId &&
      typeof c.resolvedGrams === 'number' &&
      Number.isFinite(c.resolvedGrams) &&
      isTrustedBasis(c.massResolutionReason)
    ) {
      resolved.push({
        ingredient: c.ingredient,
        foodId: c.matchedFoodId,
        basis: c.massResolutionReason,
        source: 'curated_local',
      });
    }
  }

  const unresolvedIngredients = det.contributions
    .filter((c) => !c.resolved && !c.qualitative)
    .map((c) => c.ingredient)
    .slice(0, 50);

  const limitations: string[] = [];
  if (resolved.some((r) => r.basis !== 'direct_mass')) {
    limitations.push('density_and_count_weights_are_representative_approximations');
  }
  if (unresolvedIngredients.length > 0) {
    limitations.push('not_all_ingredients_resolved');
  }

  const provenance: NutritionProvenance = {
    calculationId: NUTRITION_CALCULATION_ID,
    calculationVersion: NUTRITION_CALCULATION_VERSION,
    resolved,
    unresolvedIngredients,
    totalIngredients: det.coverage.totalIngredients,
    resolvedIngredients: resolved.length,
    resolvedMassGrams: det.coverage.resolvedMassGrams,
    limitations,
  };

  const sanity = validateNutritionNumbers(det.totals, {
    resolvedMassGrams: det.coverage.resolvedMassGrams,
    ...(baseServings !== undefined ? { baseServings } : {}),
  });

  const reasons: string[] = [];
  if (!det.coverage.sufficient) reasons.push('incomplete_curated_coverage');
  if (resolved.length < 1) reasons.push('no_resolved_ingredients');
  if (!sanity.ok) reasons.push(...sanity.reasons);

  return {
    complete: det.coverage.sufficient && resolved.length >= 1 && sanity.ok,
    // trustedBasis is TRUE only when at least one ingredient matched a canonical
    // curated record. Zero matches => false (no traceable resolution exists).
    trustedBasis: resolved.length >= 1,
    provenance,
    reasons: [...new Set(reasons)],
  };
}

/**
 * Builds the estimator result shape from a deterministic curated estimate,
 * applying the SAME presentation rounding used elsewhere (calories/sodium whole
 * integers, macro grams rounded to 1 decimal). The deterministic engine already
 * computed full-precision whole-recipe totals; rounding happens here, at the
 * persistent result boundary.
 */
function buildDeterministicEstimateResult(
  det: DeterministicNutritionResult
): NutritionEstimateResult {
  return {
    calories: Math.max(0, Math.round(det.totals.calories)),
    protein: Math.max(0, Math.round(det.totals.protein * 10) / 10),
    carbohydrates: Math.max(0, Math.round(det.totals.carbohydrates * 10) / 10),
    fat: Math.max(0, Math.round(det.totals.fat * 10) / 10),
    fiber: Math.max(0, Math.round(det.totals.fiber * 10) / 10),
    sodium: Math.max(0, Math.round(det.totals.sodium)),
    confidenceNote: det.confidenceNote,
    source: det.source,
    confidence: det.confidence,
    assessment: buildDeterministicAssessment(det),
  };
}

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
 * Fail-closed offline estimator.
 *
 * The previous algorithmic keyword/category profile database (and its unsourced
 * densities and count weights) has been REMOVED. The ONLY offline basis is the
 * curated `foodReference` layer (representative local reference values), reached
 * through `estimateDeterministicNutrition` (exact curated food identity +
 * food-specific conversion). An ingredient that cannot be resolved by an exact
 * curated record is reported UNRESOLVED and blocks completeness. No
 * nutrient/density/count constants are invented here.
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
  void recipeTitle;
  const det = estimateDeterministicNutrition(ingredientLines);
  const assessment = buildDeterministicAssessment(det, servings);

  const unresolvedCount = assessment.provenance
    ? assessment.provenance.unresolvedIngredients.length
    : 0;
  const resolvedCount = assessment.provenance ? assessment.provenance.resolvedIngredients : 0;

  return {
    calories: Math.max(0, Math.round(det.totals.calories)),
    protein: Math.max(0, Math.round(det.totals.protein * 10) / 10),
    carbohydrates: Math.max(0, Math.round(det.totals.carbohydrates * 10) / 10),
    fat: Math.max(0, Math.round(det.totals.fat * 10) / 10),
    fiber: Math.max(0, Math.round(det.totals.fiber * 10) / 10),
    sodium: Math.max(0, Math.round(det.totals.sodium)),
    confidenceNote:
      `Offline estimate from the curated local food reference: ` +
      `${resolvedCount}/${ingredientLines.length} ingredient(s) resolved.` +
      (unresolvedCount > 0
        ? ` ${unresolvedCount} unresolved ingredient(s) were not estimated.`
        : ''),
    source: 'offline_heuristic' as NutritionSource,
    confidence: 'low' as NutritionConfidence,
    assessment,
  };
}

/**
 * Provider-neutral structured schema for nutrition estimation. Mirrors the prior
 * Gemini-native schema exactly, including every model-guidance description hint
 * and the `required` constraints (calories/protein/carbohydrates/fat/fiber/sodium).
 * `confidenceNote` remains optional, matching the previous schema.
 */
function buildSchema(): AiJsonSchema {
  return {
    type: "object",
    properties: {
      calories: { type: "number", description: "Estimated total calories for the entire recipe batch in kcal" },
      protein: { type: "number", description: "Estimated total protein for the entire recipe batch in grams" },
      carbohydrates: { type: "number", description: "Estimated total carbohydrates for the entire recipe batch in grams" },
      fat: { type: "number", description: "Estimated total fat for the entire recipe batch in grams" },
      fiber: { type: "number", description: "Estimated total dietary fiber for the entire recipe batch in grams" },
      sodium: { type: "number", description: "Estimated total sodium for the entire recipe batch in milligrams" },
      confidenceNote: { type: "string", description: "A short qualification message regarding the estimation" },
    },
    required: ["calories", "protein", "carbohydrates", "fat", "fiber", "sodium"],
  };
}

/**
 * Coerces a provider value to a finite number, defaulting non-finite / NaN /
 * invalid values to 0. This closes the `Number(Infinity) || 0` -> Infinity gap
 * while preserving every finite value and the existing rounding/clamping.
 */
function toFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * AI structured-output adapter: recipe -> bounded nutrition result. Routes
 * through the provider abstraction (`getDefaultAiProvider().generateStructured`)
 * with the same explicit primary -> fallback model chain, same temperature
 * (0.1), and the same MINIMAL thinking config. The provider's parsed JSON is
 * ALWAYS re-bounded here (never trusted raw): every numeric field clamps negative
 * values to 0, coerces non-finite/non-numeric to 0, and rounds; the confidence
 * note falls back to a neutral message when absent. Provenance
 * (`ai_estimate`/`medium`) is application-assigned, never model-self-rated.
 */
async function aiEstimateNutrition(
  provider: AiProvider,
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

  const parsed = await provider.generateStructured<{
    calories?: number;
    protein?: number;
    carbohydrates?: number;
    fat?: number;
    fiber?: number;
    sodium?: number;
    confidenceNote?: string;
  }>(prompt, buildSchema(), {
    model: modelName,
    temperature: 0.1,
    providerOptions: { thinkingConfig: { thinkingLevel: "MINIMAL" } },
  });

  const calories = Math.max(0, Math.round(toFiniteNumber(parsed.calories)));
  const protein = Math.max(0, Math.round(toFiniteNumber(parsed.protein) * 10) / 10);
  const carbohydrates = Math.max(0, Math.round(toFiniteNumber(parsed.carbohydrates) * 10) / 10);
  const fat = Math.max(0, Math.round(toFiniteNumber(parsed.fat) * 10) / 10);
  const fiber = Math.max(0, Math.round(toFiniteNumber(parsed.fiber) * 10) / 10);
  const sodium = Math.max(0, Math.round(toFiniteNumber(parsed.sodium)));
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
    // An AI estimate is NOT curated-reference authority. It carries an explicit
    // non-trusted assessment so the applicability contract fails closed and the
    // UI never offers to save it automatically.
    assessment: {
      complete: false,
      trustedBasis: false,
      reasons: ['ai_estimate_without_source_backed_provenance'],
    },
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
  req: NutritionEstimateRequest,
  userSelection?: SelectionInput
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

  // Deterministic cache lookup. The cache is a bounded, in-memory LRU over
  // WHOLE-RECIPE deterministic (source = 'database') results, keyed ONLY on the
  // nutrition-relevant inputs (never on the requested serving count or metadata).
  // A cache hit is a performance optimization, NOT a nutrition authority: it
  // re-returns the identical deterministic result (source = 'database', same
  // confidence) and never changes fallback behavior. A cache miss simply falls
  // through to the deterministic engine below untouched.
  const cacheKey = buildDeterministicCacheKey(req.ingredients);
  const cached = getDeterministicNutritionCache(cacheKey);
  if (cached) {
    return cached;
  }

  // Attempt 0: deterministic curated estimation. This is the FIRST preference.
  // The engine computes whole-recipe totals and returns an explicit eligibility
  // flag; it is selected as the final estimate ONLY when coverage is sufficient
  // (every measurable/non-qualitative ingredient resolved). Otherwise we fall
  // through to the existing AI -> offline cascade untouched, rather than
  // presenting an incomplete total as complete.
  const deterministic = estimateDeterministicNutrition(req.ingredients);
  if (deterministic.eligible) {
    const result = buildDeterministicEstimateResult(deterministic);
    // Only an eligible/sufficient deterministic result is ever cached; a partial
    // or fallback result is never inserted into the deterministic cache.
    setDeterministicNutritionCache(cacheKey, result);
    console.info("[NutritionEstimator] Deterministic curated estimate selected (sufficient coverage).");
    return result;
  }

  // AI provider chain (structured-output capable, across configured providers),
  // then the deterministic algorithmic estimator as the final fallback. Provider
  // fallback (capability-gated) runs BEFORE the deterministic estimator only here;
  // the deterministic estimator is NEVER replaced by provider fallback.
  try {
    const { result } = await runWithAiFallback<NutritionEstimateResult>({
      candidates: resolveRoleCandidates("nutrition", undefined, userSelection),
      requiredCapabilities: ["structuredOutput"],
      run: (candidate) =>
        aiEstimateNutrition(candidate.provider, candidate.model, recipeTitle, servings, cleanedIngredientLines),
    });
    return result;
  } catch (err: any) {
    const model = typeof err?.model === "string" ? err.model : "<unknown>";
    logModelAttempt("nutrition", model, err);
  }

  return estimateAlgorithmicNutrition(recipeTitle, servings, rawIngredientLines);
}

