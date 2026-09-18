/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: advisory review/display contract.
 *
 * PURE, platform-neutral, offline, ADVISORY REVIEW AND DISPLAY ONLY. Phase 4
 * consumes the trusted Phase 1–3 contracts without weakening them. It NEVER
 * creates or persists a `codex_nutrition` block, modifies Markdown/frontmatter,
 * writes a recipe/vault file, enables Apply, or authorizes machine application.
 * Phase 5 owns explicit Apply/persistence.
 *
 * This module is the closed vocabulary shared by the Phase 4 session boundary,
 * the UI state machine, and the React presentation layer. It is NOT re-exported
 * from any public production barrel.
 */

import { canonicalStringify, sha256Hex } from '../usda/digest';
import type { NutrientId } from '../nutrients';
import type { CanonicalUnit } from '../units';
import type { UsdaDataType } from '../usda/types';
import type { AdvisoryNutritionPreview, CalculationResult, PortionReviewResult } from '../calculation/types';
import type { CountPortionReviewResult } from '../calculation/countPortion';
import type { ConfirmationResult, IngredientReviewResult } from '../matching/types';

export const PHASE4_SESSION_VERSION = 'usda_phase4_session_v3';
export const PHASE4_STATE_VERSION = 'usda_phase4_state_v4';

/**
 * Canonical, value-based identity of a Phase 4 session's authority. It is a
 * deterministic projection of the authoritative `Phase4SessionMetadata`, so two
 * sessions built from the same manifest/records share an identity and ANY
 * authoritative change (bundle release, catalog identity/eligibility digest,
 * session/context/calculation version, nutrient map, membership counts, data
 * types) yields a different identity. It carries no new authority; it exists so
 * UI state can invalidate stale selections and previews when the session
 * authority changes even though the recipe identity is unchanged.
 */
export function phase4SessionIdentity(metadata: Phase4SessionMetadata): string {
  return sha256Hex(
    canonicalStringify({
      session_version: metadata.session_version,
      context_version: metadata.context_version,
      calculation_version: metadata.calculation_version,
      bundle_release: metadata.bundle_release,
      catalog_digest: metadata.catalog_digest,
      nutrient_map_version: metadata.nutrient_map_version,
      record_count: metadata.record_count,
      source_record_count: metadata.source_record_count,
      excluded_record_count: metadata.excluded_record_count,
      data_types: [...metadata.data_types],
    })
  );
}

/** Working bound on adapted recipe ingredients (mirrors Phase 3). */
export const MAX_PHASE4_INGREDIENTS = 200;

/**
 * Honest production-unavailability copy. Calm product wording; it is NOT an
 * error in the recipe itself.
 */
export const PHASE4_UNAVAILABLE_MESSAGE =
  'Advanced Nutrition requires a trusted local USDA data bundle. No source data are configured in this build.';

export const PHASE4_NOT_MEDICAL_ADVICE =
  'Advisory nutrition preview. Estimates only — not medical advice, not individualized dietary advice, and not a claim of complete nutritional coverage.';

export const PHASE4_UNCONFIGURED_LABEL = 'Source data unavailable';

/**
 * Phase 4.5B lazy local-bundle copy. Calm product language; the recipe is never
 * described as defective, no path/URL/exception/digest detail is exposed, and
 * success is never claimed before the locked bundle and genuine session exist.
 */
export const PHASE4_IDLE_MESSAGE = 'Trusted USDA source data are ready to load.';
export const PHASE4_LOADING_MESSAGE = 'Authenticating local USDA nutrition data…';
export const PHASE4_BUNDLE_FAILED_MESSAGE =
  'Advanced Nutrition could not authenticate its local USDA data.';
export const PHASE4_UNSUPPORTED_MESSAGE =
  'This browser cannot safely open the local USDA nutrition bundle.';
export const PHASE4_BUNDLE_RETRY_LABEL = 'Retry';

/** Fixed, bounded copy shown when a hostile/unreadable recipe fails adaptation. */
export const PHASE4_UNREADABLE_MESSAGE =
  "This recipe's ingredient data could not be read safely, so Advanced Nutrition is unavailable.";

/**
 * Phase 4.5C explicit total-weight fallback copy. This is a user-entered total
 * weight for one ingredient line — NOT a density.
 */
export const PHASE4_USER_MASS_LABEL = 'Enter total weight for this ingredient line';
export const PHASE4_USER_MASS_NOTE =
  'A user-entered total weight applies to this ingredient line only. It is not a density and is never saved.';
export const PHASE4_USER_MASS_CONFIRM_LABEL = 'Use this weight';
export const PHASE4_PORTION_SECTION_LABEL = 'USDA source portions';
export const PHASE4_USER_MASS_SECTION_LABEL = 'Or enter a total weight';

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

export type Phase4FailureCode =
  | 'invalid_session'
  | 'invalid_request'
  | 'unsafe_request'
  | 'unknown_field'
  | 'not_available'
  | 'invalid_recipe'
  | 'invalid_servings'
  | 'invalid_selection'
  | 'stale_binding'
  | 'validation_error';

export const PHASE4_FAILURE_MESSAGE: Readonly<Record<Phase4FailureCode, string>> = Object.freeze({
  invalid_session: 'phase4_invalid_session',
  invalid_request: 'phase4_invalid_request',
  unsafe_request: 'phase4_unsafe_request',
  unknown_field: 'phase4_unknown_field',
  not_available: 'phase4_not_available',
  invalid_recipe: 'phase4_invalid_recipe',
  invalid_servings: 'phase4_invalid_servings',
  invalid_selection: 'phase4_invalid_selection',
  stale_binding: 'phase4_stale_binding',
  validation_error: 'phase4_validation_error',
});

export interface Phase4Failure {
  readonly code: Phase4FailureCode;
  /** Fixed, bounded, input-redacted message. Never echoes caller input. */
  readonly message: string;
}

export function phase4Failure(code: Phase4FailureCode): Phase4Failure {
  return Object.freeze({ code, message: PHASE4_FAILURE_MESSAGE[code] });
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface Phase4SessionMetadata {
  readonly session_version: string;
  readonly context_version: string;
  readonly calculation_version: string;
  readonly bundle_release: string;
  readonly catalog_digest: string;
  readonly nutrient_map_version: string;
  /** Eligible home-recipe records available to the matcher. */
  readonly record_count: number;
  /** Complete authenticated source-record count. */
  readonly source_record_count: number;
  /** Authenticated records excluded from home-recipe matching. */
  readonly excluded_record_count: number;
  readonly data_types: ReadonlyArray<UsdaDataType>;
}

/**
 * A genuine Phase 4 review session. Authority is lexically private; operations
 * resolve authority only for the exact receiver object, so a structural fake,
 * clone, spread, proxy, inherited object, wrapper, primitive, or `null` cannot
 * impersonate a genuine session.
 *
 * Public UI-facing operations expose only bounded review/display results and
 * user-intent operations — never canonical food records or mutable authority.
 */
export interface AdvancedNutritionSession {
  metadata(this: AdvancedNutritionSession): Phase4SessionMetadata;
  /** Bounded Phase 2 review outcome (candidate identities only). */
  reviewIngredient(this: AdvancedNutritionSession, raw: unknown): IngredientReviewResult;
  /** Bounded Phase 3 portion candidates for one matched food. */
  reviewPortions(this: AdvancedNutritionSession, fdcId: unknown): PortionReviewResult;
  /** Bounded Phase 4.5E authenticated count-portion candidates for one matched food. */
  reviewCountPortions(
    this: AdvancedNutritionSession,
    ingredient: unknown,
    fdcId: unknown
  ): CountPortionReviewResult;
  /** User-intent confirmation/rejection against the genuine current catalog. */
  confirmMatch(
    this: AdvancedNutritionSession,
    review: unknown,
    selection: unknown
  ): ConfirmationResult;
  /** Explicit advisory calculation (never automatic). */
  calculate(this: AdvancedNutritionSession, request: unknown): CalculationResult;
}

export type AdvancedNutritionSessionResult =
  | { ok: true; session: AdvancedNutritionSession }
  | { ok: false; failure: Phase4Failure };

// ---------------------------------------------------------------------------
// Recipe adaptation
// ---------------------------------------------------------------------------

/** Minimal structural recipe-ingredient input (avoids a production coupling). */
export interface RecipeIngredientInput {
  readonly original?: string;
  readonly amount?: number | null;
  readonly unit?: string;
  readonly name?: string;
  readonly note?: string;
}

export interface AdaptedIngredient {
  readonly line_ref: string;
  readonly ingredient: {
    readonly original: string;
    readonly amount?: number | null;
    readonly unit?: string;
    readonly name?: string;
    readonly note?: string;
    readonly line_ref: string;
  };
}

// ---------------------------------------------------------------------------
// Review state
// ---------------------------------------------------------------------------

export type Phase4Status =
  | 'unavailable'
  | 'ready'
  | 'preview_current'
  | 'preview_stale'
  | 'invalid';

export type BasisMode = 'entire_recipe' | 'per_serving' | 'selected_servings';

/** Authoritative per-ingredient matching outcome shown to the user. */
export type ReviewOutcome =
  | 'matched_exact'
  | 'review_required'
  | 'unmatched'
  | 'qualitative'
  | 'invalid'
  | 'none_selected';

export interface Phase4CandidateView {
  readonly fdc_id: number;
  readonly data_type: UsdaDataType;
  readonly description: string;
  readonly match_class: string;
  readonly rank_evidence: string;
  /** Bounded portion-availability annotation for the current ingredient. */
  readonly portion_annotation: string;
}

export interface Phase4Row {
  readonly line_ref: string;
  readonly original_text: string;
  readonly outcome: ReviewOutcome;
  readonly query: string;
  readonly candidates: ReadonlyArray<Phase4CandidateView>;
  readonly review_digest: string | undefined;
  /** Present ONLY for an automatic unique-exact match. */
  readonly selected_fdc_id: number | undefined;
  /** The opaque Phase 2 review snapshot used for confirmation/calculation. */
  readonly review: unknown;
  readonly note: string | undefined;
}

export interface MatchChoice {
  readonly kind: 'candidate' | 'none';
  readonly fdc_id?: number;
  readonly review_digest: string;
}

export interface PortionChoice {
  readonly fdc_id: number;
  readonly portion_index: number;
  readonly selection: unknown;
  readonly review: unknown;
}

/** An explicitly reviewed authenticated count-portion selection (`count_portion`). */
export interface CountPortionChoice {
  readonly fdc_id: number;
  readonly portion_index: number;
  readonly selection: unknown;
  readonly review: unknown;
}

/** An explicit user-entered total weight for one ingredient line (`user_mass`). */
export interface UserMassChoice {
  readonly fdc_id: number;
  readonly quantity: number;
  readonly unit: 'g' | 'oz' | 'lb';
  readonly selection: unknown;
}

export interface Phase4State {
  readonly version: string;
  readonly status: Phase4Status;
  readonly recipeKey: string | null;
  /** Canonical authority identity of the session that owns this state. */
  readonly sessionIdentity: string | null;
  readonly baseServings: number;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly matches: Readonly<Record<string, MatchChoice>>;
  readonly portions: Readonly<Record<string, PortionChoice>>;
  readonly countPortions: Readonly<Record<string, CountPortionChoice>>;
  readonly userMasses: Readonly<Record<string, UserMassChoice>>;
  readonly basis: BasisMode;
  readonly selectedServings: number;
  readonly preview: AdvisoryNutritionPreview | null;
  readonly previewKey: string | null;
  readonly failure: Phase4Failure | null;
  readonly operationSeq: number;
}

export type Phase4Action =
  | {
      readonly type: 'initialize';
      readonly recipeKey: string;
      /** Canonical session authority identity (`phase4SessionIdentity`). */
      readonly sessionIdentity: string;
      readonly rows: ReadonlyArray<Phase4Row>;
      readonly baseServings: number;
    }
  | { readonly type: 'reset' }
  | { readonly type: 'select_match'; readonly lineRef: string; readonly choice: MatchChoice }
  | { readonly type: 'select_portion'; readonly lineRef: string; readonly choice: PortionChoice }
  | { readonly type: 'clear_portion'; readonly lineRef: string }
  | {
      readonly type: 'select_count_portion';
      readonly lineRef: string;
      readonly choice: CountPortionChoice;
    }
  | { readonly type: 'clear_count_portion'; readonly lineRef: string }
  | { readonly type: 'select_user_mass'; readonly lineRef: string; readonly choice: UserMassChoice }
  | { readonly type: 'clear_user_mass'; readonly lineRef: string }
  | { readonly type: 'set_basis'; readonly basis: BasisMode }
  | { readonly type: 'set_servings'; readonly value: unknown }
  | {
      readonly type: 'preview_succeeded';
      readonly seq: number;
      readonly recipeKey: string;
      readonly preview: AdvisoryNutritionPreview;
    }
  | { readonly type: 'preview_failed'; readonly seq: number; readonly failure: Phase4Failure }
  | { readonly type: 'dismiss_failure' };

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export interface NutrientGroup {
  readonly id: string;
  readonly label: string;
  readonly nutrients: ReadonlyArray<NutrientId>;
}

export interface DisplayNutrient {
  readonly nutrient: NutrientId;
  readonly label: string;
  readonly unit: CanonicalUnit;
  /** Canonical display unit text (`µg`, `µg RAE`, `mg NE`, `µg DFE`, ...). */
  readonly unit_label: string;
  /** Derived amount for the current basis, or undefined when missing. */
  readonly amount: number | undefined;
  readonly explicit_zero: boolean;
  readonly coverage: 'complete' | 'partial' | 'missing';
  readonly covered_ingredient_count: number;
  readonly measurable_ingredient_count: number;
  readonly percent_daily_value:
    | { readonly available: true; readonly percent: number; readonly standard: string }
    | { readonly available: false; readonly reason: string };
}

export interface IngredientEvidenceView {
  readonly line_ref: string;
  readonly original_text: string;
  readonly outcome: string;
  readonly match_status: string;
  readonly user_confirmed: boolean;
  readonly fdc_id: number | undefined;
  readonly mass_source: string | undefined;
  readonly resolved_grams: number | undefined;
  readonly portion_index: number | undefined;
  readonly count_ingredient_amount: number | undefined;
  readonly count_portion_amount: number | undefined;
  readonly count_gram_weight: number | undefined;
  readonly count_unit: string | undefined;
  readonly count_size: string | undefined;
  readonly count_deterministic: boolean | undefined;
  readonly user_mass_quantity: number | undefined;
  readonly user_mass_unit: string | undefined;
  readonly contributing_nutrients: ReadonlyArray<NutrientId>;
}

export interface CoverageSummary {
  readonly status: 'complete' | 'partial' | 'unresolved';
  readonly unresolved_count: number;
  readonly total_ingredients: number;
}
