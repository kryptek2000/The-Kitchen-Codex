/**
 * The Kitchen Codex — Advanced Nutrition Phase 5C: consolidated nutrition
 * presentation selector.
 *
 * PURE, platform-neutral, deterministic, read-only. This is the SINGLE place
 * that decides which nutrition representation a recipe presents, so precedence
 * is never scattered as ad-hoc `if (codexNutrition)` logic across components.
 *
 * PRECEDENCE (non-destructive; no merging, no averaging, no migration):
 *   - a valid recognized schema-v1 `codex_nutrition` block is the preferred
 *     display authority (`advanced_saved`, or `advanced_stale` when the saved
 *     basis no longer matches the current recipe);
 *   - an opaque unknown FUTURE schema is reported as `advanced_unsupported` and
 *     never interpreted or overwritten;
 *   - a malformed recognized schema-v1 block is reported as `advanced_invalid`;
 *   - otherwise the existing simple nutrition / top-level calories are the
 *     legacy fallback (`legacy`), or `none` when neither exists.
 *
 * It NEVER writes, never migrates, never merges legacy values into Advanced (or
 * vice versa), and never mutates its input. Untrusted recipe data is read through
 * guarded own-data descriptors and materialized inertly.
 */

import {
  CODEX_NUTRITION_FRONTMATTER_KEY,
  isPlainObject,
  toInertValue,
  type CodexNutritionV1,
  type CodexNutritionV2,
  type CodexNutritionV3,
} from '../schema';
import { decodeCodexNutrition } from '../validate';
import { readOwnDataField } from '../phase4/materialize';
import { adaptRecipe } from '../phase4/adapt';
import { parseIngredient } from '../matching/parse';
import type { AdaptedIngredient } from '../phase4/types';
import { isQualitativeIngredientText } from '../../../utils/ingredientSemantics';
import { requestedServingAmount } from '../../../utils/servingMath';
import { nutritionForRequestedServings } from '../../../utils/nutrition';
import type { RecipeNutrition } from '../../../types';

export const NUTRITION_PRESENTATION_VERSION = 'usda_phase5c_presentation_v1';

export type NutritionPresentationKind =
  | 'advanced_saved'
  | 'advanced_stale'
  | 'advanced_unsupported'
  | 'advanced_invalid'
  | 'legacy'
  | 'none';

export type NutritionStaleReason = 'servings_changed' | 'ingredients_changed';

export interface NutritionPresentation {
  readonly version: string;
  readonly kind: NutritionPresentationKind;
  /** The decoded recognized schema-v1/v2 block (advanced_saved / advanced_stale). */
  readonly advanced: CodexNutritionV1 | CodexNutritionV2 | CodexNutritionV3 | undefined;
  /** The stored whole-recipe serving denominator of the Advanced block. */
  readonly advanced_servings: number | undefined;
  /** The stored whole-recipe calories total of the Advanced block. */
  readonly advanced_calories_total: number | undefined;
  readonly advanced_stale: boolean;
  readonly stale_reasons: ReadonlyArray<NutritionStaleReason>;
  /** Materialized legacy/simple nutrition (never the original hostile object). */
  readonly legacy_nutrition: Readonly<Record<string, unknown>> | undefined;
  /** Materialized legacy top-level calories. */
  readonly legacy_calories: unknown;
  /** A raw codex_nutrition block is present but is an unknown future schema. */
  readonly has_opaque_block: boolean;
  /** A raw codex_nutrition block is present but malformed/unreadable. */
  readonly has_malformed_block: boolean;
  /** True when a recognized Advanced result is the preferred display authority. */
  readonly advanced_preferred: boolean;
  /**
   * True ONLY when the recognized Advanced block represents complete trustworthy
   * recipe coverage (status `complete` and no unresolved ingredient lines). A
   * partial/incomplete block must NOT be presented as whole-recipe totals.
   */
  readonly advanced_complete: boolean;
  /** Resolved measurable ingredient-line count of the saved Advanced block. */
  readonly advanced_resolved_count: number;
  /** Total measurable ingredient-line count (resolved + unresolved). */
  readonly advanced_ingredient_count: number;
}

function readField(object: object, key: string): { ok: true; present: boolean; value: unknown } | { ok: false } {
  return readOwnDataField(object, key);
}

/** Materializes legacy nutrition into inert bounded plain data, or undefined. */
function readLegacyNutrition(recipe: object): Readonly<Record<string, unknown>> | undefined {
  const field = readField(recipe, 'nutrition');
  if (!field.ok || !field.present || field.value === null || field.value === undefined) return undefined;
  const materialized = toInertValue(field.value);
  if (!materialized.ok || !isPlainObject(materialized.value)) return undefined;
  return materialized.value;
}

function readLegacyCalories(recipe: object): unknown {
  const field = readField(recipe, 'calories');
  if (!field.ok || !field.present) return undefined;
  return field.value;
}

/** Reads the raw stored block, preferring the raw frontmatter slot. */
function readRawAdvancedBlock(recipe: object): unknown {
  const frontmatter = readField(recipe, 'frontmatter');
  if (frontmatter.ok && frontmatter.present && frontmatter.value !== null && frontmatter.value !== undefined) {
    if (isPlainObject(frontmatter.value)) {
      const raw = readField(frontmatter.value, CODEX_NUTRITION_FRONTMATTER_KEY);
      if (raw.ok && raw.present && raw.value !== null && raw.value !== undefined) return raw.value;
    }
  }
  const typed = readField(recipe, 'codexNutrition');
  if (typed.ok && typed.present && typed.value !== null && typed.value !== undefined) return typed.value;
  return undefined;
}

/** True when an adapted ingredient is qualitative (never measurable). */
function isQualitativeAdapted(entry: AdaptedIngredient): boolean {
  const parsed = parseIngredient(entry.ingredient);
  if (!parsed.ok) return false;
  const hasMeasurableQuantity = typeof parsed.parsed.amount === 'number' && Number.isFinite(parsed.parsed.amount);
  if (hasMeasurableQuantity) return false;
  return isQualitativeIngredientText(`${parsed.parsed.query} ${parsed.parsed.original_text}`);
}

function sameStringSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i += 1) if (sortedA[i] !== sortedB[i]) return false;
  return true;
}

/**
 * Conservative staleness detection for a saved Advanced block relative to the
 * current recipe. It detects a changed serving denominator and a changed
 * measurable-ingredient set (by canonical line reference). Qualitative
 * ingredients are excluded exactly as the calculation layer excludes them, so an
 * unchanged recipe never reports stale.
 *
 * FAIL CLOSED: when the current recipe cannot be adapted (unreadable/empty/
 * malformed ingredient structure), the saved basis CANNOT be verified, so the
 * saved result is reported as stale/unverifiable rather than silently trusted.
 * The saved block is never deleted or mutated.
 */
function detectAdvancedStale(
  recipe: object,
  block: CodexNutritionV1 | CodexNutritionV2 | CodexNutritionV3
): ReadonlyArray<NutritionStaleReason> {
  const reasons: NutritionStaleReason[] = [];
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) return ['ingredients_changed'];

  if (block.servings !== adaptation.recipe.base_servings) reasons.push('servings_changed');

  const currentRefs = adaptation.recipe.adapted
    .filter((entry) => !isQualitativeAdapted(entry))
    .map((entry) => entry.line_ref);
  const storedRefs = [
    ...block.ingredients.map((entry) => entry.line_ref),
    ...block.unresolved.map((entry) => entry.line_ref),
  ];
  if (!sameStringSet(currentRefs, storedRefs)) reasons.push('ingredients_changed');
  return reasons;
}

/**
 * Resolves the consolidated nutrition presentation for a recipe. Never throws;
 * hostile/unreadable input fails closed to the safest available representation.
 */
export function resolveRecipeNutritionPresentation(recipe: unknown): NutritionPresentation {
  const base = (kind: NutritionPresentationKind): NutritionPresentation =>
    Object.freeze({
      version: NUTRITION_PRESENTATION_VERSION,
      kind,
      advanced: undefined,
      advanced_servings: undefined,
      advanced_calories_total: undefined,
      advanced_stale: false,
      stale_reasons: Object.freeze([]),
      legacy_nutrition: undefined,
      legacy_calories: undefined,
      has_opaque_block: false,
      has_malformed_block: false,
      advanced_preferred: false,
      advanced_complete: false,
      advanced_resolved_count: 0,
      advanced_ingredient_count: 0,
    });

  if (!isPlainObject(recipe)) return base('none');

  const legacyNutrition = readLegacyNutrition(recipe);
  const legacyCalories = readLegacyCalories(recipe);
  const legacyAvailable = legacyNutrition !== undefined || legacyCalories !== undefined;

  let decoded;
  try {
    decoded = decodeCodexNutrition(readRawAdvancedBlock(recipe));
  } catch {
    decoded = { kind: 'malformed' as const, errors: ['validation_error'] };
  }

  if (decoded.kind === 'v1' || decoded.kind === 'v2' || decoded.kind === 'v3') {
    const block = decoded.value;
    const reasons = detectAdvancedStale(recipe, block);
    const stale = reasons.length > 0;
    const calories = block.nutrients.calories?.amount;
    const resolvedCount = block.ingredients.length;
    const unresolvedCount = block.unresolved.length;
    const ingredientCount = resolvedCount + unresolvedCount;
    const complete = block.status === 'complete' && unresolvedCount === 0;
    return Object.freeze({
      version: NUTRITION_PRESENTATION_VERSION,
      kind: stale ? 'advanced_stale' : 'advanced_saved',
      advanced: block,
      advanced_servings: block.servings,
      advanced_calories_total: typeof calories === 'number' && Number.isFinite(calories) ? calories : undefined,
      advanced_stale: stale,
      stale_reasons: Object.freeze([...reasons]),
      legacy_nutrition: legacyNutrition,
      legacy_calories: legacyCalories,
      has_opaque_block: false,
      has_malformed_block: false,
      advanced_preferred: true,
      advanced_complete: complete,
      advanced_resolved_count: resolvedCount,
      advanced_ingredient_count: ingredientCount,
    });
  }

  if (decoded.kind === 'opaque') {
    return Object.freeze({
      ...base('advanced_unsupported'),
      legacy_nutrition: legacyNutrition,
      legacy_calories: legacyCalories,
      has_opaque_block: true,
    });
  }

  if (decoded.kind === 'malformed') {
    return Object.freeze({
      ...base('advanced_invalid'),
      legacy_nutrition: legacyNutrition,
      legacy_calories: legacyCalories,
      has_malformed_block: true,
    });
  }

  return Object.freeze({
    ...base(legacyAvailable ? 'legacy' : 'none'),
    legacy_nutrition: legacyNutrition,
    legacy_calories: legacyCalories,
  });
}

/**
 * Derives the ordinary compact `Nutrition & Macros` values from a recognized
 * saved Advanced block, so the NORMAL recipe presentation can stay visible and
 * authoritative without maintaining a second competing stored dataset.
 *
 * It returns the values whenever a recognized Advanced result is the preferred
 * authority — COMPLETE or PARTIAL. A PARTIAL block's values are the sum over the
 * RESOLVED ingredient lines only; the caller must label them as a partial
 * estimate (the presentation exposes `advanced_complete` and the resolved/
 * unresolved counts). It NEVER writes, never migrates, and never falls back to
 * legacy values — the compact numbers come ONLY from the saved Advanced block.
 * A nutrient absent from the block is left absent (never topped up from legacy).
 */
export function deriveAdvancedCompactNutrition(
  presentation: NutritionPresentation
): RecipeNutrition | undefined {
  if (!presentation.advanced_preferred || !presentation.advanced) {
    return undefined;
  }
  const block = presentation.advanced;
  const out: RecipeNutrition = { servings: block.servings };
  const calories = block.nutrients.calories?.amount;
  const protein = block.nutrients.protein?.amount;
  const carbohydrates = block.nutrients.carbohydrates?.amount;
  const fat = block.nutrients.fat?.amount;
  const fiber = block.nutrients.fiber?.amount;
  const sodium = block.nutrients.sodium?.amount;
  if (typeof calories === 'number' && Number.isFinite(calories)) out.calories = calories;
  if (typeof protein === 'number' && Number.isFinite(protein)) out.protein = protein;
  if (typeof carbohydrates === 'number' && Number.isFinite(carbohydrates)) out.carbohydrates = carbohydrates;
  if (typeof fat === 'number' && Number.isFinite(fat)) out.fat = fat;
  if (typeof fiber === 'number' && Number.isFinite(fiber)) out.fiber = fiber;
  if (typeof sodium === 'number' && Number.isFinite(sodium)) out.sodium = sodium;
  return Object.freeze(out);
}

/**
 * Deterministic primary calories for a requested serving count. A recognized
 * Advanced block ALWAYS wins over legacy values; legacy is used only as the
 * fallback. Never writes or mutates.
 */
export function resolveNutritionDisplayCalories(
  presentation: NutritionPresentation,
  requestedServings: number
): number | string | undefined {
  // SINGLE-AUTHORITY RULE: while a recognized Advanced result is preferred,
  // calories come ONLY from that block. A missing Advanced `calories` nutrient
  // yields `undefined` — it is NEVER "topped up" from legacy/top-level calories.
  // CONSERVATIVE PARTIAL RULE: an INCOMPLETE (partial) Advanced result must not
  // be presented in the recipe header as though it were a complete calorie total.
  // The partial values are surfaced in the standard Nutrition & Macros card with
  // an explicit partial label instead.
  if (presentation.advanced_preferred) {
    if (!presentation.advanced_complete) return undefined;
    if (
      presentation.advanced_calories_total !== undefined &&
      presentation.advanced_servings !== undefined &&
      Number.isFinite(presentation.advanced_servings) &&
      presentation.advanced_servings > 0 &&
      Number.isFinite(requestedServings) &&
      requestedServings > 0
    ) {
      const derived = requestedServingAmount(
        presentation.advanced_calories_total,
        presentation.advanced_servings,
        requestedServings
      );
      if (Number.isFinite(derived)) return derived;
    }
    return undefined;
  }

  // Legacy fallback is permitted ONLY when Advanced is not the preferred authority.
  const legacy = nutritionForRequestedServings(
    presentation.legacy_nutrition as RecipeNutrition | undefined,
    requestedServings
  ).calories;
  if (legacy !== undefined && legacy !== null) return legacy;
  if (presentation.legacy_calories !== undefined && presentation.legacy_calories !== null) {
    return presentation.legacy_calories as number | string;
  }
  return undefined;
}
