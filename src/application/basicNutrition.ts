/** One Basic Nutrition engine, shared by both buttons. The browser acquires
 * the pinned local bundle on explicit calculation; this service never calls AI
 * or writes a recipe. Quantities and per-nutrient coverage remain traceable.
 */
import { calculateCatalogBasicNutrition } from './catalogBasicNutrition';
import type { AdvancedNutritionSession } from '../core/nutritionV2/phase4/types';
import type { DeterministicIngredient } from '../core/deterministicNutrition';
import type { RecipeNutrition } from '../types';

/** The nutrient fields this service reports (null = not sufficiently supported). */
export interface BasicNutritionTotals {
  readonly calories: number | null;
  readonly protein: number | null;
  readonly carbohydrates: number | null;
  readonly fat: number | null;
  readonly fiber: number | null;
  readonly sodium: number | null;
}

export interface BasicNutritionLine {
  readonly ingredient: string;
  readonly status: 'resolved' | 'qualitative' | 'unresolved';
  readonly grams: number | null;
  /** How the grams were derived (null when unresolved). */
  readonly basis: 'direct_mass' | 'density' | 'count_weight' | 'source_portion' | 'estimated_quantity' | null;
  readonly matchedFood: string | null;
  /** Curated-assumption note for approximated weights (density/count). */
  readonly note: string | null;
  /** Bounded reason for an unresolved line, or null. */
  readonly reason: string | null;
}

export interface BasicNutritionCoverage {
  readonly total: number;
  readonly resolved: number;
  readonly qualitative: number;
  readonly unresolved: number;
  /** True when every measurable ingredient resolved (fully covered). */
  readonly complete: boolean;
}

export interface BasicNutritionEstimate {
  /** False when no defensible contribution could be calculated. */
  readonly ok: boolean;
  /** Bounded explanation when `ok` is false. */
  readonly message: string | null;
  readonly source: 'offline_heuristic';
  readonly confidence: 'high' | 'medium' | 'low' | 'unknown';
  readonly confidenceNote: string;
  readonly baseServings: number;
  /** Whole-recipe totals (the stored-block numerator contract). */
  readonly totals: BasicNutritionTotals;
  /** Deterministic per-serving derivation of `totals`. */
  readonly perServing: BasicNutritionTotals;
  readonly knownSubtotal?: BasicNutritionTotals;
  readonly coverage: BasicNutritionCoverage;
  /** Distinct, bounded assumptions the numbers rely on. */
  readonly assumptions: readonly string[];
  readonly lines: readonly BasicNutritionLine[];
}

export interface BasicNutritionInput {
  readonly ingredients: ReadonlyArray<DeterministicIngredient>;
  /** The recipe's authored serving count (the estimate's denominator). */
  readonly servings?: unknown;
}

export function calculateBasicNutrition(input: BasicNutritionInput, session: AdvancedNutritionSession): BasicNutritionEstimate {
  return calculateCatalogBasicNutrition(input, session);
}

/** Converts complete or explicitly approved partial data to the existing
 * Markdown nutrition shape. confidenceNote carries the machine-readable PARTIAL
 * marker consumed by isPartialMachineNutrition; unresolved nutrients are absent.
 */
export function basicEstimateToNutrition(
  estimate: BasicNutritionEstimate,
  options: { readonly allowPartial?: boolean } = {},
): RecipeNutrition | null {
  if (!estimate.ok || (!estimate.coverage.complete && options.allowPartial !== true)) return null;
  const values = estimate.coverage.complete ? estimate.totals : estimate.knownSubtotal;
  if (!values || !Object.values(values).some((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  return {
    ...(values.calories !== null ? { calories: values.calories } : {}),
    ...(values.protein !== null ? { protein: values.protein } : {}),
    ...(values.carbohydrates !== null ? { carbohydrates: values.carbohydrates } : {}),
    ...(values.fat !== null ? { fat: values.fat } : {}),
    ...(values.fiber !== null ? { fiber: values.fiber } : {}),
    ...(values.sodium !== null ? { sodium: values.sodium } : {}),
    servings: estimate.baseServings,
    source: 'offline_heuristic',
    confidence: estimate.confidence === 'unknown' ? 'low' : estimate.confidence,
    confidenceNote: estimate.coverage.complete
      ? estimate.confidenceNote
      : `${estimate.confidenceNote} PARTIAL subtotal: unresolved ingredients are excluded; recipe totals are unknown.`,
  };
}
