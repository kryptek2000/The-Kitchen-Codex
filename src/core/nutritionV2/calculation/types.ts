/**
 * The Kitchen Codex — Advanced Nutrition Phase 3: advisory calculation contract.
 *
 * PURE, platform-neutral, offline, ADVISORY ONLY. Phase 3 answers: given
 * ingredients, reviewed USDA identities, and defensible masses, what are the
 * advisory entire-recipe totals, coverage, per-serving values, and derived %DV?
 *
 * It NEVER creates/writes a `codex_nutrition` block, serializes Markdown,
 * modifies frontmatter, writes a recipe/vault file, adds UI/Apply, persists
 * anything, or authorizes machine application. This is an isolated module: it is
 * NOT re-exported from any public production barrel.
 */

import type { NutrientId } from '../nutrients';
import type { CanonicalUnit } from '../units';
import type { UsdaDataType } from '../usda/types';

export const CALCULATION_SCHEMA = 1;
/**
 * Advisory calculation contract version (part of digests/bindings).
 * v2 (Phase 4.5C) adds volume-compatible source-portion scaling, the
 * `user_mass` mass source, and canonical portion-semantics binding.
 * v3 (Phase 4.5D) binds the home-recipe-eligible catalog membership and the
 * eligibility/query-projection versions; stale v2 portion/user-mass selections
 * and previews are rejected rather than reused.
 */
export const CALCULATION_VERSION = 'usda_advisory_calc_v3';
export const CALCULATION_CONTEXT_VERSION = 'usda_calc_context_v2';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const MAX_CALCULATION_INGREDIENTS = 200;
export const MAX_CALCULATION_LINE_REF_LENGTH = 500;
export const MAX_CALCULATION_REQUEST_BYTES = 64 * 1024;
export const MAX_CALCULATION_SERVINGS = 1000;
export const MAX_CALCULATION_SERVING_DECIMAL_PLACES = 6;
/** Upper bound for any single resolved mass (grams). */
export const MAX_CALCULATION_GRAMS = 1_000_000_000;
/** Canonical totals are rounded once to at most this many decimal places. */
export const MAX_CALCULATION_TOTAL_DECIMAL_PLACES = 6;

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

export type Phase3FailureCode =
  | 'invalid_context'
  | 'invalid_request'
  | 'unsafe_request'
  | 'oversized_request'
  | 'unknown_field'
  | 'empty_ingredients'
  | 'too_many_ingredients'
  | 'duplicate_line_ref'
  | 'invalid_line_ref'
  | 'invalid_servings'
  | 'invalid_nutrient_scope'
  | 'invalid_ingredient_input'
  | 'invalid_portion_selection'
  | 'invalid_user_mass'
  | 'numeric_overflow'
  | 'validation_error';

export const PHASE3_FAILURE_MESSAGE: Readonly<Record<Phase3FailureCode, string>> = Object.freeze({
  invalid_context: 'phase3_invalid_context',
  invalid_request: 'phase3_invalid_request',
  unsafe_request: 'phase3_unsafe_request',
  oversized_request: 'phase3_oversized_request',
  unknown_field: 'phase3_unknown_field',
  empty_ingredients: 'phase3_empty_ingredients',
  too_many_ingredients: 'phase3_too_many_ingredients',
  duplicate_line_ref: 'phase3_duplicate_line_ref',
  invalid_line_ref: 'phase3_invalid_line_ref',
  invalid_servings: 'phase3_invalid_servings',
  invalid_nutrient_scope: 'phase3_invalid_nutrient_scope',
  invalid_ingredient_input: 'phase3_invalid_ingredient_input',
  invalid_portion_selection: 'phase3_invalid_portion_selection',
  invalid_user_mass: 'phase3_invalid_user_mass',
  numeric_overflow: 'phase3_numeric_overflow',
  validation_error: 'phase3_validation_error',
});

export interface Phase3Failure {
  readonly code: Phase3FailureCode;
  readonly message: string;
}

export function phase3Failure(code: Phase3FailureCode): Phase3Failure {
  return { code, message: PHASE3_FAILURE_MESSAGE[code] };
}

// ---------------------------------------------------------------------------
// Calculation context
// ---------------------------------------------------------------------------

export interface CalculationContextMetadata {
  readonly context_version: string;
  readonly calculation_version: string;
  readonly bundle_release: string;
  readonly catalog_digest: string;
  readonly nutrient_map_version: string;
  /** Eligible home-recipe records indexed for matching/calculation. */
  readonly record_count: number;
  /** Complete authenticated source-record count (13,559 for the pinned bundle). */
  readonly source_record_count: number;
  /** Authenticated records excluded by the eligibility policy. */
  readonly excluded_record_count: number;
  readonly data_types: ReadonlyArray<UsdaDataType>;
}

/** Opaque, factory-created calculation context (authority is private). */
export interface NutritionCalculationContext {
  metadata(): CalculationContextMetadata;
}

export type CalculationContextResult =
  | { ok: true; context: NutritionCalculationContext }
  | { ok: false; failure: Phase3Failure };

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface CalculationIngredientInput {
  readonly line_ref: string;
  /** Raw/structured Phase 2 ingredient input. */
  readonly ingredient: unknown;
  /** Phase 2 review snapshot (required for `review_required`). */
  readonly review?: unknown;
  /** Phase 2 explicit confirmation/rejection selection. */
  readonly selection?: unknown;
  /** Explicitly reviewed source-portion selection (optional). */
  readonly portion_selection?: unknown;
  /** Explicit user-entered total ingredient-line weight (optional). */
  readonly user_mass_selection?: unknown;
}

export interface CalculationRequest {
  readonly servings: number;
  readonly nutrient_scope: ReadonlyArray<NutrientId>;
  readonly ingredients: ReadonlyArray<CalculationIngredientInput>;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type IngredientOutcome =
  | 'calculated'
  | 'qualitative'
  | 'no_match'
  | 'ambiguous'
  | 'no_mass'
  | 'no_nutrition';

export type MatchStatus = 'unique_exact' | 'user_confirmed' | 'none';

export type MassSource = 'direct_mass' | 'source_portion' | 'user_mass';

export interface IngredientCalculationEvidence {
  readonly line_ref: string;
  readonly original_text: string;
  readonly outcome: IngredientOutcome;
  readonly qualitative: boolean;
  readonly match_status: MatchStatus;
  /** True ONLY for an explicitly user-confirmed ambiguous match. */
  readonly user_confirmed: boolean;
  readonly fdc_id?: number;
  readonly record_digest?: string;
  readonly mass_source?: MassSource;
  readonly resolved_grams?: number;
  /** Canonical portion index for a `source_portion` result. */
  readonly portion_index?: number;
  /** Entered total-weight quantity/unit for a `user_mass` result. */
  readonly user_mass_quantity?: number;
  readonly user_mass_unit?: string;
  /** Binds the ingredient identity WITHOUT any portion selection. */
  readonly ingredient_identity_digest: string;
  /** Binds the ingredient identity WITH the applied portion selection. */
  readonly ingredient_digest: string;
  readonly contributing_nutrients: ReadonlyArray<NutrientId>;
}

export interface UnresolvedIngredient {
  readonly line_ref: string;
  readonly outcome: IngredientOutcome;
}

export interface NutrientTotalResult {
  readonly amount: number;
  readonly unit: CanonicalUnit;
  readonly coverage: number;
  readonly covered_ingredient_count: number;
  readonly measurable_ingredient_count: number;
  readonly status: 'complete' | 'partial';
}

export type CalculationStatus = 'complete' | 'partial' | 'unresolved';

export interface AdvisoryNutritionPreview {
  readonly calculation_schema: 1;
  readonly calculation_version: string;
  readonly bundle_release: string;
  readonly catalog_digest: string;
  readonly nutrient_map_version: string;
  readonly servings: number;
  readonly ingredient_digest: string;
  readonly nutrient_scope: ReadonlyArray<NutrientId>;
  readonly basis: 'total';
  readonly status: CalculationStatus;
  readonly totals: Readonly<Partial<Record<NutrientId, NutrientTotalResult>>>;
  readonly ingredients: ReadonlyArray<IngredientCalculationEvidence>;
  readonly unresolved: ReadonlyArray<UnresolvedIngredient>;
  readonly advisory_only: true;
  readonly application_authorized: false;
}

export type CalculationResult =
  | { ok: true; preview: AdvisoryNutritionPreview }
  | { ok: false; failure: Phase3Failure };

// ---------------------------------------------------------------------------
// Portion review / selection
// ---------------------------------------------------------------------------

export interface PortionCandidate {
  readonly index: number;
  readonly measure: string;
  readonly amount?: number;
  readonly gram_weight: number;
  readonly modifier?: string;
  readonly sequence?: number;
  /** Canonical portion-semantics binding (recomputed from the raw fields). */
  readonly semantics_version: string;
  readonly kind: 'volume' | 'mass' | 'count' | 'unusable';
  readonly unit: string | null;
  /** Positive finite effective amount (raw field or explicit measure text). */
  readonly effective_amount: number | null;
  readonly volume_ml: number | null;
  readonly amount_source: string;
  /** Optional bounded descriptor (never a numeric FNDDS source code). */
  readonly descriptor: string | null;
  /** Safe bounded human label (e.g. `1 cup = 122 g`). */
  readonly display_label: string;
}

export interface PortionReview {
  readonly calculation_version: string;
  readonly portion_semantics_version: string;
  readonly bundle_release: string;
  readonly fdc_id: number;
  readonly record_digest: string;
  readonly candidates: ReadonlyArray<PortionCandidate>;
  readonly candidates_digest: string;
}

export type PortionReviewResult =
  | { ok: true; review: PortionReview }
  | { ok: false; failure: Phase3Failure };

export interface PortionSelection {
  readonly calculation_version: string;
  readonly portion_semantics_version: string;
  readonly line_ref: string;
  readonly ingredient_identity_digest: string;
  readonly bundle_release: string;
  readonly fdc_id: number;
  readonly record_digest: string;
  readonly candidates_digest: string;
  readonly portion_index: number;
  /** Effective portion amount (raw field or explicit measure text). */
  readonly portion_amount: number;
  readonly measure: string;
  readonly gram_weight: number;
  readonly modifier?: string;
  /** Recomputed semantics binding (never trusted from the caller). */
  readonly semantics_kind: 'volume' | 'mass' | 'count' | 'unusable';
  readonly semantics_unit: string | null;
  readonly semantics_volume_ml: number | null;
  readonly semantics_amount: number;
  readonly semantics_gram_weight: number;
}

/**
 * An explicit user-entered total weight for one recipe ingredient line. It is a
 * separate, mutually exclusive mass source (`user_mass`); it is NOT a density.
 * The calculator recomputes grams from `quantity` + `unit`.
 */
export interface UserMassSelection {
  readonly calculation_version: string;
  readonly line_ref: string;
  readonly ingredient_identity_digest: string;
  readonly bundle_release: string;
  readonly fdc_id: number;
  readonly record_digest: string;
  readonly quantity: number;
  readonly unit: 'g' | 'oz' | 'lb';
  /** Recomputed gram value (never trusted from the caller). */
  readonly grams: number;
  readonly selection_digest: string;
}
