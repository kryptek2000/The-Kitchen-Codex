/**
 * The Kitchen Codex — Nutrition estimate applicability contract (pure, shared).
 *
 * ONE authoritative, side-effect-free contract that decides whether a
 * MACHINE-GENERATED nutrition estimate may be applied/saved. It NEVER invents
 * numbers and it never clamps a bad result into a "good" one.
 *
 * GOVERNING RULE
 * --------------
 * A machine-generated nutrition result may be applied only when every
 * ingredient and every quantity conversion used in the calculation can be
 * re-derived from the curated local food reference (representative local
 * values; NOT exact USDA record identity). Keyword/category hits are NOT food
 * identification, and an AI result is NOT authority. Absence of an explicit
 * assessment or of structured provenance fails closed.
 *
 * This module is imported by the server estimator (to describe resolution) and
 * by every client write path (to gate application). It has no platform
 * dependency.
 */

import { findFoodReference } from '../data/foodReference';
import { estimateDeterministicNutrition } from './deterministicNutrition';

/** Upper bound for a recipe's base serving denominator. */
export const MAX_BASE_SERVINGS = 1000;

/**
 * Tolerance when comparing summed macronutrient mass to the resolved ingredient
 * mass. A tiny margin absorbs representative-record rounding without letting a
 * physically impossible macro mass pass.
 */
export const MACRO_MASS_TOLERANCE = 1.02;

/**
 * Identity of the ONLY trusted calculation authority in the immediate repair:
 * the curated local food reference. There is no algorithmic/keyword authority.
 */
export const NUTRITION_CALCULATION_ID = 'curated_food_reference';
export const NUTRITION_CALCULATION_VERSION = 'curated_local_v1';

/**
 * Automated application of machine-generated nutrition is DISABLED in this
 * immediate repair: the required detailed provenance cannot yet be persisted
 * safely to Markdown (the canonical schema has no provenance field). The
 * applicability contract below still fully evaluates the rules; when they pass
 * it returns this explicit reason instead of authorizing a save. This is the
 * documented short-term choice until the curated-reference engine persists
 * detailed provenance.
 */
export const AUTOMATED_APPLICATION_DISABLED_REASON =
  'automated_application_disabled_pending_provenance_persistence';

/** The six numeric nutrient fields, in a stable order. */
export type NutritionNumericKey =
  | 'calories'
  | 'protein'
  | 'carbohydrates'
  | 'fat'
  | 'fiber'
  | 'sodium';

export const NUTRITION_NUMERIC_KEYS: readonly NutritionNumericKey[] = [
  'calories',
  'protein',
  'carbohydrates',
  'fat',
  'fiber',
  'sodium',
];

export interface NutritionNumbers {
  calories?: number | null;
  protein?: number | null;
  carbohydrates?: number | null;
  fat?: number | null;
  fiber?: number | null;
  sodium?: number | null;
}

/** How an ingredient's quantity was converted to mass. */
export type NutritionConversionBasis = 'direct_mass' | 'density' | 'count_weight';

/** One resolved ingredient's traceable food/source record identity. */
export interface NutritionResolutionRecord {
  /** Verbatim (bounded) recipe-owned ingredient line. */
  ingredient: string;
  /** Curated food record id (must exist in the trusted food reference). */
  foodId: string;
  /** The conversion basis actually used. */
  basis: NutritionConversionBasis;
  /** Source authority of the record (e.g. `curated_local`). */
  source: string;
}

/**
 * Structured, auditable provenance for a machine-generated estimate. Additive
 * metadata only: never a nutrient value.
 */
export interface NutritionProvenance {
  /** Calculation/source identifier. */
  calculationId: string;
  /** Calculation version. */
  calculationVersion: string;
  /** Every resolved ingredient and the record + basis that resolved it. */
  resolved: NutritionResolutionRecord[];
  /** Bounded recipe-owned unresolved ingredient lines. */
  unresolvedIngredients: string[];
  /** Total ingredient lines examined. */
  totalIngredients: number;
  /** Number of resolved ingredients (must equal `resolved.length`). */
  resolvedIngredients: number;
  /** Sum of resolved ingredient grams. */
  resolvedMassGrams: number;
  /** Bounded, non-secret limitation flags (e.g. approximation warnings). */
  limitations: string[];
}

/**
 * Whole-recipe resolution assessment produced by the estimator. Additive
 * metadata: never a nutrient value, never persisted.
 */
export interface NutritionAssessment {
  /** True only when every measurable ingredient resolved AND sanity passed. */
  complete: boolean;
  /**
   * True only when AT LEAST ONE ingredient matched a canonical record in the
   * curated local food reference AND every claimed resolution passed canonical
   * re-resolution (never a keyword/category guess, never an AI number). This is
   * NOT a claim of exact USDA record identity — the local reference holds
   * representative values. False when zero ingredients resolve.
   */
  trustedBasis: boolean;
  /** Structured provenance; required for application. */
  provenance?: NutritionProvenance;
  /** Bounded machine reasons explaining an incomplete/untrusted assessment. */
  reasons: string[];
}

export interface NutritionSanityResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Validates the numeric nutrient values (and, when available, the base serving
 * denominator and the resolved ingredient mass). Every numeric value must be
 * finite and non-negative; the serving denominator must be finite, positive and
 * bounded; and summed macro mass must not exceed the resolved ingredient mass.
 */
export function validateNutritionNumbers(
  numbers: NutritionNumbers | null | undefined,
  opts: { resolvedMassGrams?: number; baseServings?: number } = {}
): NutritionSanityResult {
  const reasons: string[] = [];
  if (!numbers || typeof numbers !== 'object') {
    return { ok: false, reasons: ['missing_nutrition'] };
  }

  for (const key of NUTRITION_NUMERIC_KEYS) {
    const value = numbers[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      reasons.push(`non_finite_${key}`);
      continue;
    }
    if (value < 0) reasons.push(`negative_${key}`);
  }

  const base = opts.baseServings;
  if (base !== undefined) {
    if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0 || base > MAX_BASE_SERVINGS) {
      reasons.push('invalid_servings');
    }
  }

  const resolvedMass = opts.resolvedMassGrams;
  if (typeof resolvedMass === 'number' && Number.isFinite(resolvedMass) && resolvedMass > 0) {
    const protein = finiteNonNegative(numbers.protein);
    const carbs = finiteNonNegative(numbers.carbohydrates);
    const fat = finiteNonNegative(numbers.fat);
    const macroMass = protein + carbs + fat;
    if (macroMass > resolvedMass * MACRO_MASS_TOLERANCE) {
      reasons.push('macro_mass_exceeds_resolved_mass');
    }
  }

  return { ok: reasons.length === 0, reasons };
}

function finiteNonNegative(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function isConversionBasis(value: unknown): value is NutritionConversionBasis {
  return value === 'direct_mass' || value === 'density' || value === 'count_weight';
}

/**
 * Canonical re-resolution of a claimed resolved ingredient line using the
 * EXISTING curated deterministic resolver (no duplicated food-matching logic).
 * Returns the canonical food id + conversion basis, or null when the line does
 * not resolve — including ambiguous alternatives, unknown foods, and missing
 * density/count conversions. This is the authority that binds a provenance
 * entry's evidence to the ingredient it claims to describe.
 */
function canonicalResolutionFor(
  line: string
): { foodId: string; basis: NutritionConversionBasis } | null {
  if (typeof line !== 'string' || !line.trim()) return null;
  const det = estimateDeterministicNutrition([line]);
  const contribution = det.contributions[0];
  if (!contribution || !contribution.resolved || !contribution.matchedFoodId) return null;
  if (!isConversionBasis(contribution.massResolutionReason)) return null;
  return { foodId: contribution.matchedFoodId, basis: contribution.massResolutionReason };
}

/**
 * Evaluates the full trusted-resolution rules for a machine-generated estimate.
 * Returns `ok:true` ONLY when an explicit trusted assessment with complete
 * structured provenance and sane numbers is present. A forged `complete:true`
 * (or a forged assessment without provenance, or unknown food records) fails.
 *
 * NOTE: this is the RULE evaluation. The deployed gate
 * (`canApplyNutritionEstimate`) additionally fails closed because automated
 * application is disabled in this repair (see the constant above).
 */
export function evaluateMachineNutritionApplicability(
  numbers: NutritionNumbers | null | undefined,
  assessment: NutritionAssessment | null | undefined,
  baseServings: number
): NutritionSanityResult {
  if (!assessment || typeof assessment !== 'object') {
    return { ok: false, reasons: ['missing_assessment'] };
  }

  const reasons: string[] = [];
  if (assessment.trustedBasis !== true) reasons.push('untrusted_basis');
  if (assessment.complete !== true) reasons.push('incomplete_estimate');

  const provenance = assessment.provenance;
  if (!provenance || typeof provenance !== 'object') {
    reasons.push('missing_provenance');
  } else {
    if (typeof provenance.calculationId !== 'string' || !provenance.calculationId) {
      reasons.push('missing_calculation_id');
    }
    if (typeof provenance.calculationVersion !== 'string' || !provenance.calculationVersion) {
      reasons.push('missing_calculation_version');
    }
    if (!Array.isArray(provenance.resolved) || provenance.resolved.length < 1) {
      reasons.push('no_resolved_ingredients');
    }
    if (!Array.isArray(provenance.unresolvedIngredients)) {
      reasons.push('invalid_provenance');
    }
    if (
      typeof provenance.resolvedIngredients !== 'number' ||
      provenance.resolvedIngredients !== (Array.isArray(provenance.resolved) ? provenance.resolved.length : -1)
    ) {
      reasons.push('provenance_resolution_mismatch');
    }
    if (
      typeof provenance.totalIngredients !== 'number' ||
      provenance.totalIngredients < (Array.isArray(provenance.resolved) ? provenance.resolved.length : 0)
    ) {
      reasons.push('invalid_provenance');
    }
    if (Array.isArray(provenance.resolved)) {
      for (const record of provenance.resolved) {
        if (!record || typeof record !== 'object') {
          reasons.push('invalid_resolution_record');
          continue;
        }
        if (typeof record.foodId !== 'string' || !record.foodId) {
          reasons.push('invalid_resolution_record');
          continue;
        }
        if (typeof record.source !== 'string' || !record.source) {
          reasons.push('missing_resolution_source');
        }
        if (!isConversionBasis(record.basis)) {
          reasons.push('invalid_conversion_basis');
        }
        // The food id must resolve to a real record in the curated local
        // reference. A fabricated food id can never authorize application.
        if (!findFoodReference(record.foodId)) {
          reasons.push('unknown_food_record');
        }
        // EVIDENCE BINDING: the claimed food id + conversion basis must match
        // what the canonical resolver produces for the SAME ingredient line. A
        // real food id paired with an unrelated ingredient (e.g. ground beef
        // paired with the `butter` id) or the wrong conversion basis fails
        // closed. Caller-supplied provenance is never trusted as authority.
        const canonical = canonicalResolutionFor(record.ingredient);
        if (!canonical) {
          reasons.push('evidence_not_resolvable');
        } else {
          if (canonical.foodId !== record.foodId) reasons.push('evidence_food_mismatch');
          if (canonical.basis !== record.basis) reasons.push('evidence_basis_mismatch');
        }
      }
    }
  }

  const numeric = validateNutritionNumbers(numbers, {
    resolvedMassGrams: provenance?.resolvedMassGrams,
    baseServings,
  });
  reasons.push(...numeric.reasons);

  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/**
 * THE deployed "may this machine estimate be applied/saved?" gate.
 *
 * Automated application of machine-generated nutrition is DISABLED in this
 * immediate repair, so this ALWAYS fails closed: even a fully curated-reference
 * result returns `AUTOMATED_APPLICATION_DISABLED_REASON` rather than being
 * saved without persisted detailed provenance. Manual nutrition editing is
 * unaffected.
 */
export function canApplyNutritionEstimate(
  numbers: NutritionNumbers | null | undefined,
  assessment: NutritionAssessment | null | undefined,
  baseServings: number
): NutritionSanityResult {
  const evaluation = evaluateMachineNutritionApplicability(numbers, assessment, baseServings);
  if (!evaluation.ok) return evaluation;
  return { ok: false, reasons: [AUTOMATED_APPLICATION_DISABLED_REASON] };
}
