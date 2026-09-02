/**
 * The Kitchen Codex — Deterministic Food-Aware Nutrition Estimation (v0.3.0 Step 4)
 *
 * A pure, dependency-light, independently testable engine that turns a recipe's
 * ingredient list into a WHOLE-RECIPE nutrition total using ONLY the curated
 * Step 2 (measurement normalization) and Step 3 (curated food reference) layers.
 * It performs no AI, no network, and no invented data.
 *
 * Pipeline per ingredient:
 *   ingredient -> measurement normalization -> curated food identity
 *   -> mass resolution -> per-100g nutrition -> nutrition contribution
 *
 * HONESTY INVARIANTS (UNKNOWN MUST REMAIN UNKNOWN):
 *   - If grams cannot be resolved (unknown food, missing amount, no density /
 *     count weight), the ingredient is UNRESOLVED and contributes nothing.
 *   - If nutritionPer100g is absent, the ingredient is UNRESOLVED.
 *   - Negative amounts never enter nutrition math (they resolve to unresolved).
 *   - Zero amounts are valid degenerate inputs (resolve to 0 contribution).
 *   - The original ingredient string is NEVER mutated; wikilinks are not
 *     introduced and serialization is untouched.
 *
 * This module deliberately reuses the canonical fraction parser (`parseAmount`)
 * and the canonical unit normalizer (`normalizeUnit`) rather than introducing a
 * second parser. The thin local tokenizer exists only because the raw markdown
 * line parser attaches a mass/volume unit too greedily for count nouns (e.g.
 * "3 garlic cloves" where a leading "g" is mistaken for grams); here count nouns
 * are left in the food-name text so the Step 2 count-noun inference + Step 3
 * count weight drive the mass resolution, exactly as curated.
 */

import {
  normalizeIngredientMeasurement,
  parseAmount,
  normalizeUnit,
  getMeasurementKind,
} from '../src/utils/measurements';
import type {
  NormalizedMeasurement,
  MeasurementKind,
  MeasurementConfidence,
  NormalizedUnit,
} from '../src/utils/measurements';
import {
  findFoodReference,
  resolveFoodMass,
  getFoodNutritionPer100g,
} from '../src/data/foodReference';
import type {
  FoodReferenceEntry,
  FoodNutritionPer100g,
  FoodMassResolutionReason,
} from '../src/data/foodReference';
import type { NutritionSource, NutritionConfidence } from '../src/schema/recipeSchema';

/** The six nutrition fields this engine sums (mirrors the estimator contract). */
export type NutrientKey =
  | 'calories'
  | 'protein'
  | 'carbohydrates'
  | 'fat'
  | 'fiber'
  | 'sodium';

/** A complete set of nutrient values (internal, full-precision). */
export interface NutrientTotals {
  calories: number;
  protein: number;
  carbohydrates: number;
  fat: number;
  fiber: number;
  sodium: number;
}

/** Ingredient input accepted by the engine (mirrors NutritionEstimateRequest). */
export type DeterministicIngredient =
  | string
  | {
      original?: string;
      amount?: number | null;
      unit?: string;
      name?: string;
    };

/**
 * Provenance / confidence / reason vocabulary for one ingredient.
 * Kept as literals so consumers can switch on them without magic strings.
 */
export type MassResolutionReason = FoodMassResolutionReason;
export type IngredientUnresolvedReason =
  | 'no_curated_food_match'
  | 'no_mass_resolution'
  | 'no_nutrition_reference';
export type CoverageStatus = 'sufficient' | 'partial';

/**
 * Per-ingredient resolution provenance. This is intentionally verbose so the
 * engine is never a black-box number generator: every number is explainable.
 */
export interface IngredientNutritionContribution {
  /** Verbatim original ingredient string (never mutated). */
  ingredient: string;
  /** Food-name text used for matching (may include a wikilink). */
  name: string;
  /** Parsed numeric quantity, or null when no quantity was expressed. */
  amount: number | null;
  /** Original unit token as supplied, or undefined. */
  rawUnit: string | undefined;
  normalizedUnit: NormalizedUnit;
  measurementKind: MeasurementKind;
  /** Curated food identity (exact match), or undefined when unmatched. */
  matchedFoodId: string | undefined;
  matchedFoodName: string | undefined;
  /** Resolved grams, or undefined when unresolved. */
  resolvedGrams: number | undefined;
  /** Why grams exist: direct_mass / density / count_weight / unknown. */
  massResolutionReason: MassResolutionReason;
  /** Confidence in the resolved mass (high for exact, medium/low for approximations). */
  massConfidence: MeasurementConfidence;
  massResolutionNote: string | undefined;
  /** Curated per-100g nutrition, or undefined when unmatched. */
  per100g: FoodNutritionPer100g | undefined;
  /** grams/100 x per100g, or undefined when unresolved. */
  contribution: NutrientTotals | undefined;
  /** True when both grams and nutrition reference are present. */
  resolved: boolean;
  /** True when unresolved and explicitly qualitative/negligible (to taste, etc.). */
  qualitative: boolean;
  /** Human-readable reason for being unresolved, or undefined when resolved. */
  unresolvedReason: IngredientUnresolvedReason | undefined;
}

/** Deterministic coverage model for a whole recipe. */
export interface DeterministicCoverage {
  /** Total ingredients examined. */
  totalIngredients: number;
  /** Ingredients resolved to a full nutrition contribution. */
  resolvedCount: number;
  /** Explicitly qualitative/negligible unresolved ingredients. */
  qualitativeCount: number;
  /** Material unresolved ingredients (measured/required but not resolvable). */
  materialUnresolvedCount: number;
  /** measurable = resolved + material unresolved (the coverage denominator). */
  measurableCount: number;
  /** Sum of resolved grams (0 when nothing resolved). */
  resolvedMassGrams: number;
  /** True when every measurable ingredient is resolved and at least one resolved. */
  allMeasurableResolved: boolean;
  /** True when coverage is sufficient to present as a complete recipe estimate. */
  sufficient: boolean;
  status: CoverageStatus;
}

/** The deterministic engine's result (full precision; eligibility is explicit). */
export interface DeterministicNutritionResult {
  /** True => coverage is sufficient => may be presented as a complete estimate. */
  eligible: boolean;
  source: NutritionSource;
  confidence: NutritionConfidence;
  confidenceNote: string;
  /** Whole-recipe first-pass totals (full precision, invariant to servings). */
  totals: NutrientTotals;
  coverage: DeterministicCoverage;
  contributions: IngredientNutritionContribution[];
}

const QUALITATIVE_PATTERN =
  /\b(?:to taste|as needed|as required|as desired|to your liking|as you like|use as needed|enough)\b/i;

const CONF_RANK: Record<MeasurementConfidence, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
};
const CONF_BY_RANK: MeasurementConfidence[] = ['unknown', 'low', 'medium', 'high'];

/**
 * True when free-form ingredient text carries an explicit qualitative cue.
 *
 * IMPORTANT: presence of a cue ALONE is never sufficient to exempt an ingredient
 * from coverage. A quantified/material ingredient (e.g. "1 cup butter, as
 * needed") must never be demoted to qualitative just because a cue phrase
 * appears — otherwise it can be silently dropped and let an incomplete
 * deterministic total be presented as complete. The caller gates this on
 * `hasMeasurableQuantity` (see estimateDeterministicNutrition).
 */
function isQualitative(text: string): boolean {
  return QUALITATIVE_PATTERN.test(text);
}

/**
 * Thin segmentation of a raw ingredient line into { amount, unit, name }.
 *
 * Reuses the canonical fraction parser (`parseAmount`) and unit normalizer
 * (`normalizeUnit`). It consumes a LEADING token ONLY when it is a mass/volume
 * unit; count nouns (egg, clove, slice, can, stick, ...) are intentionally LEFT
 * in the name so Step 2's count-noun inference + Step 3's count weight drive
 * mass resolution (see module docstring for why raw markdown line parsing is
 * avoided here). A leading "of" after the unit is ignored.
 */
export function normalizeRawIngredientLine(
  line: string
): { amount: number | null; unit: string | null; name: string } {
  const trimmed = String(line).trim().slice(0, 300);
  const match = trimmed.match(
    /^\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+\s*[½⅓⅔¼¾⅛⅜⅝⅞]|[½⅓⅔¼¾⅛⅜⅝⅞]|\d+(?:\.\d+)?)/
  );
  let amount: number | null = null;
  let rest = trimmed;
  if (match) {
    amount = parseAmount(match[1]);
    rest = trimmed.slice(match[0].length);
  }
  rest = rest.trim();

  const firstToken = rest.match(/^(\S+)/)?.[1];
  let unit: string | null = null;
  let name = rest;
  if (firstToken) {
    const normalized = normalizeUnit(firstToken);
    const kind = getMeasurementKind(normalized);
    if (normalized && (kind === 'mass' || kind === 'volume')) {
      unit = firstToken;
      // A leading "of" sits between the unit and the food name ("1 cup of flour").
      name = rest.slice(firstToken.length).replace(/^\s*of\s+/i, '').trim();
    }
  }
  return { amount, unit, name: name || trimmed };
}

function toIngredientParts(
  item: DeterministicIngredient
): { originalText: string; amount: number | null; unit: string | null; name: string } {
  if (typeof item === 'string') {
    const line = item.trim().slice(0, 300);
    const parts = normalizeRawIngredientLine(line);
    return { originalText: line, ...parts };
  }
  const originalText = (
    item.original || `${item.amount ?? ''} ${item.unit ?? ''} ${item.name ?? ''}`.trim()
  )
    .trim()
    .slice(0, 300);
  let amount: number | null = item.amount ?? null;
  let unit: string | null = item.unit ?? null;
  let name = (item.name ?? '').trim();
  if (!name && (amount === null || !unit) && item.original) {
    const parsed = normalizeRawIngredientLine(item.original);
    name = parsed.name || item.original;
  }
  if (!name && item.unit) {
    const parsed = normalizeRawIngredientLine(originalText);
    name = parsed.name || originalText;
  }
  if (!name) name = originalText;
  return { originalText, amount: amount ?? null, unit: unit ?? null, name };
}

function contributionFor(
  grams: number,
  per100g: FoodNutritionPer100g
): NutrientTotals {
  const factor = grams / 100;
  return {
    calories: factor * per100g.calories,
    protein: factor * per100g.protein,
    carbohydrates: factor * per100g.carbohydrates,
    fat: factor * per100g.fat,
    fiber: factor * (per100g.fiber ?? 0),
    sodium: factor * (per100g.sodium ?? 0),
  };
}

function addTotals(target: NutrientTotals, contribution: NutrientTotals): void {
  target.calories += contribution.calories;
  target.protein += contribution.protein;
  target.carbohydrates += contribution.carbohydrates;
  target.fat += contribution.fat;
  target.fiber += contribution.fiber;
  target.sodium += contribution.sodium;
}

function weakestConfidence(contributions: IngredientNutritionContribution[]): NutritionConfidence {
  let worst = Number.POSITIVE_INFINITY;
  for (const c of contributions) {
    if (!c.resolved) continue;
    const rank = CONF_RANK[c.massConfidence] ?? 0;
    if (rank < worst) worst = rank;
  }
  if (!Number.isFinite(worst)) return 'unknown';
  return CONF_BY_RANK[Math.max(0, Math.round(worst))];
}

/**
 * Pure deterministic food-aware whole-recipe nutrition estimator.
 *
 * Computes per-ingredient contributions and first-pass whole-recipe totals, then
 * derives an explicit coverage model and eligibility flag:
 *
 *   eligible === coverage.sufficient === (materialUnresolvedCount === 0
 *                                         && resolvedCount >= 1)
 *
 * i.e. EVERY measurable (non-qualitative) ingredient must be resolved for the
 * deterministic total to be presented as a complete estimate. Qualitatively
 * negligible ingredients ("salt to taste") do NOT block coverage; a genuinely
 * unresolvable ingredient (a material unknown) DOES.
 *
 * The result is invariant to the requested serving count: this engine computes
 * WHOLE-RECIPE totals only. All serving arithmetic remains the responsibility of
 * the existing `nutritionForServings` contract.
 */
export function estimateDeterministicNutrition(
  ingredients: DeterministicIngredient[]
): DeterministicNutritionResult {
  const contributions: IngredientNutritionContribution[] = [];
  const totals: NutrientTotals = {
    calories: 0,
    protein: 0,
    carbohydrates: 0,
    fat: 0,
    fiber: 0,
    sodium: 0,
  };

  let resolvedCount = 0;
  let qualitativeCount = 0;
  let materialUnresolvedCount = 0;
  let resolvedMassGrams = 0;

  for (const item of ingredients) {
    const parts = toIngredientParts(item);
    const measurement: NormalizedMeasurement = normalizeIngredientMeasurement({
      amount: parts.amount,
      unit: parts.unit,
      name: parts.name,
    });
    let food: FoodReferenceEntry | undefined;
    try {
      food = findFoodReference(parts.name);
    } catch {
      food = undefined;
    }
    const mass = resolveFoodMass(measurement, food);
    const per100g = food ? getFoodNutritionPer100g(food) : undefined;

    const grams = mass.grams;
    const hasGrams = grams !== undefined && Number.isFinite(grams);
    const hasNutrition = !!per100g;
    const resolved = hasGrams && hasNutrition;

    // SAFETY RULE: an ingredient is never exempted from deterministic coverage
    // as qualitative simply because a cue phrase ("to taste", "as needed", ...)
    // appears in its text. A quantified/material ingredient (measurement carries a
    // finite, parsed amount) MUST stay measurable: if it cannot resolve it falls
    // through to the material-unresolved branch and blocks eligibility, so an
    // incomplete total is never presented as complete. Exemption applies only to
    // genuinely amount-free qualitative ingredients (e.g. "salt to taste").
    const hasMeasurableQuantity =
      typeof measurement.amount === 'number' && Number.isFinite(measurement.amount);

    let qualitative = false;
    let unresolvedReason: IngredientNutritionContribution['unresolvedReason'] = undefined;
    if (!resolved) {
      qualitative = !hasMeasurableQuantity && isQualitative(`${parts.name} ${parts.originalText}`);
      if (!qualitative) {
        if (!food) {
          unresolvedReason = 'no_curated_food_match';
        } else if (!hasGrams) {
          unresolvedReason = 'no_mass_resolution';
        } else if (!hasNutrition) {
          unresolvedReason = 'no_nutrition_reference';
        }
      }
    }

    let contribution: NutrientTotals | undefined;
    if (resolved && per100g && grams !== undefined) {
      contribution = contributionFor(Math.max(0, grams), per100g);
      addTotals(totals, contribution);
      resolvedCount += 1;
      resolvedMassGrams += Math.max(0, grams);
    } else if (qualitative) {
      qualitativeCount += 1;
    } else {
      materialUnresolvedCount += 1;
    }

    contributions.push({
      ingredient: parts.originalText,
      name: parts.name,
      amount: parts.amount,
      rawUnit: measurement.rawUnit,
      normalizedUnit: measurement.normalizedUnit,
      measurementKind: measurement.kind,
      matchedFoodId: food?.id,
      matchedFoodName: food?.name,
      resolvedGrams: grams,
      massResolutionReason: mass.reason,
      massConfidence: mass.confidence,
      massResolutionNote: mass.note,
      per100g,
      contribution,
      resolved,
      qualitative,
      unresolvedReason,
    });
  }

  const measurableCount = resolvedCount + materialUnresolvedCount;
  const allMeasurableResolved = materialUnresolvedCount === 0 && resolvedCount >= 1;
  const sufficient = allMeasurableResolved;
  const coverage: DeterministicCoverage = {
    totalIngredients: contributions.length,
    resolvedCount,
    qualitativeCount,
    materialUnresolvedCount,
    measurableCount,
    resolvedMassGrams,
    allMeasurableResolved,
    sufficient,
    status: sufficient ? 'sufficient' : 'partial',
  };

  const confidence = weakestConfidence(contributions);
  const missing =
    materialUnresolvedCount > 0
      ? ` ${materialUnresolvedCount} measurable ingredient(s) could not be resolved and were not estimated.`
      : '';
  const confidenceNote =
    `Deterministic estimate from the curated local food database: ` +
    `${resolvedCount}/${measurableCount} measurable ingredient(s) resolved` +
    `${qualitativeCount > 0 ? ` (${qualitativeCount} qualitative/negligible ignored)` : ''}.` +
    ` Per-100g values and densities/count weights are representative approximations.` +
    missing;

  return {
    eligible: sufficient,
    source: 'database' as NutritionSource,
    confidence,
    confidenceNote,
    totals,
    coverage,
    contributions,
  };
}
