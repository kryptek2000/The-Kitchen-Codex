/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: application/UI session boundary.
 *
 * PURE, platform-neutral, offline, ADVISORY REVIEW AND DISPLAY ONLY. This ONE
 * lexical module owns the Phase 4 session authority registry and every public
 * operation that needs it. A genuine session is built all-or-nothing from a
 * valid Phase 1 manifest + canonical records, a genuine Phase 3 calculation
 * context, and a genuine Phase 2 review catalog created from the SAME manifest
 * and records.
 *
 * LEXICAL PRIVACY
 * ---------------
 * The registry is a module-local `WeakMap` with module-local registration and
 * retrieval functions. Neither is exported. Operations resolve authority only
 * for the exact receiver object (`this`), so a structural fake, clone, spread
 * object, proxy, inherited object, wrapper, primitive, or `null` is not
 * registered and fails closed with `invalid_session`.
 *
 * The session exposes bounded review/display results and user-intent operations
 * only — never canonical food records, the internal record index, the genuine
 * Phase 2 catalog, or any blessing token/symbol/brand/key/callback/constructor.
 */

import { isPlainObject } from '../schema';
import { validateManifest } from '../usda/manifest';
import {
  createNutritionCalculationContext,
  calculateRecipeNutrition,
  reviewFoodPortions,
  reviewFoodCountPortions,
} from '../calculation/context';
import { isValidStrictServingCount } from '../calculation/servings';
import { confirmIngredientReview, createReviewCatalog, reviewIngredient } from '../matching/review';
import { normalizeQuery, normalizeQueryChecked } from '../matching/normalize';
import { parseIngredient } from '../matching/parse';
import { projectQueryText } from '../matching/query';
import { clampManualSearchLimit } from '../matching/manualSearch';
import { deriveCountRequirement, type CountPortionReviewResult } from '../calculation/countPortion';
import { phase2Failure, MAX_INGREDIENT_TEXT_LENGTH } from '../matching/types';
import type { ConfirmationResult, IngredientReviewResult, ReviewCatalog } from '../matching/types';
import type {
  AdvisoryNutritionPreview,
  CalculationResult,
  NutritionCalculationContext,
  PortionReviewResult,
} from '../calculation/types';
import type { NutrientId } from '../nutrients';
import { adaptRecipe } from './adapt';
import { buildCalculationRequest, buildReviewRows } from './rows';
import { materializeNarrow, readOwnDataField } from './materialize';
import {
  PHASE4_SESSION_VERSION,
  phase4Failure,
  phase4SessionIdentity,
  type AdaptedIngredient,
  type AdvancedNutritionSession,
  type AdvancedNutritionSessionResult,
  type FoodSearchResult,
  type FoodSearchResultUnion,
  type Phase4Failure,
  type Phase4FailureCode,
  type Phase4SessionMetadata,
  type Phase4State,
} from './types';

interface SessionAuthority {
  readonly metadata: Phase4SessionMetadata;
  readonly context: NutritionCalculationContext;
  readonly catalog: ReviewCatalog;
}

const SESSION_AUTHORITY = new WeakMap<object, SessionAuthority>();

function registerSessionAuthority(session: AdvancedNutritionSession, authority: SessionAuthority): void {
  SESSION_AUTHORITY.set(session as unknown as object, authority);
}

function resolveSessionAuthority(receiver: unknown): SessionAuthority | undefined {
  if ((typeof receiver !== 'object' && typeof receiver !== 'function') || receiver === null) {
    return undefined;
  }
  try {
    return SESSION_AUTHORITY.get(receiver as object);
  } catch {
    return undefined;
  }
}

/**
 * Bounded, deterministic USER-DIRECTED manual USDA search over the ENTIRE
 * eligible pinned catalog. Unlike automatic matching, this does NOT use
 * anchors/family/confidence/eligibility authority — it is a local database
 * discovery tool. A selection built from a result is independently
 * authenticated by the calculation engine. No network/AI.
 */
function searchFoodsInAuthority(
  authority: SessionAuthority,
  rawQuery: unknown,
  rawLimit: unknown
): FoodSearchResultUnion {
  if (typeof rawQuery !== 'string') return { ok: false, failure: phase4Failure('invalid_request') };
  const bounded = rawQuery.length > MAX_INGREDIENT_TEXT_LENGTH
    ? rawQuery.slice(0, MAX_INGREDIENT_TEXT_LENGTH)
    : rawQuery;
  const normalizedResult = normalizeQueryChecked(bounded);
  if (!normalizedResult.ok) return { ok: false, failure: phase4Failure('invalid_request') };
  const limit = clampManualSearchLimit(rawLimit);
  const outcome = authority.catalog.manualSearch(normalizedResult.query, limit);
  const results: FoodSearchResult[] = [];
  for (const hit of outcome.hits) {
    let hasPortion = false;
    let portionSummary: string | undefined;
    const portions = reviewFoodPortions(authority.context, hit.fdc_id);
    if (portions.ok) {
      const usable = portions.review.candidates.filter((entry) => entry.gram_weight > 0);
      hasPortion = usable.length > 0;
      if (usable.length > 0) portionSummary = usable[0].display_label;
    }
    results.push(
      Object.freeze({
        fdc_id: hit.fdc_id,
        data_type: hit.data_type,
        description: hit.description,
        record_digest: hit.record_digest,
        match_class: hit.exact_fdc_id
          ? 'exact_fdc_id'
          : hit.exact_description
            ? 'exact_phrase'
            : 'all_query_tokens_present',
        has_portion: hasPortion,
        portion_summary: portionSummary,
        exact_fdc_id: hit.exact_fdc_id,
        exact_description: hit.exact_description,
      })
    );
  }
  return {
    ok: true,
    query: normalizedResult.query.text,
    results: Object.freeze(results),
    total: outcome.total,
    truncated: outcome.total > results.length,
    limit,
  };
}

function invalidReviewResult(): IngredientReviewResult {
  return Object.freeze({
    outcome: 'invalid' as const,
    line_ref: undefined,
    original_text: undefined,
    query: undefined,
    normalized_query: undefined,
    query_tokens: Object.freeze([] as string[]),
    bundle_release: '',
    catalog_digest: '',
    normalization_version: '',
    ranking_version: '',
    result_limit: 0,
    candidates: Object.freeze([]),
    review_digest: undefined,
    failure: phase2Failure('invalid_catalog'),
  });
}

/**
 * Builds a genuine Phase 4 session from a valid Phase 1 manifest and canonical
 * records. Construction is all-or-nothing.
 */
export function createAdvancedNutritionSession(
  manifestRaw: unknown,
  recordsRaw: unknown
): AdvancedNutritionSessionResult {
  const manifestValidation = validateManifest(manifestRaw);
  if (!manifestValidation.ok) {
    return { ok: false, failure: phase4Failure('invalid_session') };
  }

  // The Phase 3 context validates the records, bundle identity, content digest,
  // and builds its own genuine Phase 2 catalog from the same inputs.
  const contextResult = createNutritionCalculationContext(manifestRaw, recordsRaw);
  if (!contextResult.ok) {
    return { ok: false, failure: phase4Failure('invalid_session') };
  }
  const context = contextResult.context;

  // A genuine Phase 2 catalog created from the SAME manifest and records.
  const catalogResult = createReviewCatalog(manifestRaw, recordsRaw);
  if (!catalogResult.ok) {
    return { ok: false, failure: phase4Failure('invalid_session') };
  }
  const catalog = catalogResult.catalog;

  const contextMetadata = context.metadata();
  const catalogMetadata = catalog.metadata();
  if (catalogMetadata.catalog_digest !== contextMetadata.catalog_digest) {
    return { ok: false, failure: phase4Failure('invalid_session') };
  }
  if (catalogMetadata.bundle_release !== contextMetadata.bundle_release) {
    return { ok: false, failure: phase4Failure('invalid_session') };
  }

  const metadata: Phase4SessionMetadata = Object.freeze({
    session_version: PHASE4_SESSION_VERSION,
    context_version: contextMetadata.context_version,
    calculation_version: contextMetadata.calculation_version,
    bundle_release: contextMetadata.bundle_release,
    catalog_digest: contextMetadata.catalog_digest,
    nutrient_map_version: contextMetadata.nutrient_map_version,
    record_count: contextMetadata.record_count,
    source_record_count: contextMetadata.source_record_count,
    excluded_record_count: contextMetadata.excluded_record_count,
    data_types: Object.freeze([...contextMetadata.data_types]),
  });

  const session = {
    metadata(this: AdvancedNutritionSession): Phase4SessionMetadata {
      const authority = resolveSessionAuthority(this);
      if (!authority) throw new Error('phase4_invalid_session');
      return authority.metadata;
    },
    reviewIngredient(this: AdvancedNutritionSession, raw: unknown): IngredientReviewResult {
      const authority = resolveSessionAuthority(this);
      if (!authority) return invalidReviewResult();
      return reviewIngredient(authority.catalog, raw);
    },
    reviewPortions(this: AdvancedNutritionSession, fdcId: unknown): PortionReviewResult {
      const authority = resolveSessionAuthority(this);
      if (!authority) {
        return { ok: false, failure: phase3PortionFailure() };
      }
      return reviewFoodPortions(authority.context, fdcId);
    },
    reviewCountPortions(
      this: AdvancedNutritionSession,
      ingredient: unknown,
      fdcId: unknown
    ): CountPortionReviewResult {
      const authority = resolveSessionAuthority(this);
      if (!authority) {
        return { ok: false, failure: phase3PortionFailure() };
      }
      const parsed = parseIngredient(ingredient);
      if (!parsed.ok) return { ok: false, failure: phase3PortionFailure() };
      const projection = projectQueryText(normalizeQuery(parsed.parsed.query).text);
      const requirement = deriveCountRequirement(
        parsed.parsed.amount,
        parsed.parsed.raw_unit,
        projection.food_tokens,
        projection.size_qualifiers
      );
      if (!requirement) return { ok: false, failure: phase3PortionFailure() };
      return reviewFoodCountPortions(authority.context, fdcId, requirement);
    },
    confirmMatch(this: AdvancedNutritionSession, review: unknown, selection: unknown): ConfirmationResult {
      const authority = resolveSessionAuthority(this);
      if (!authority) {
        return Object.freeze({ outcome: 'invalid' as const, failure: phase2Failure('invalid_catalog') });
      }
      return confirmIngredientReview(authority.catalog, review, selection);
    },
    calculate(this: AdvancedNutritionSession, request: unknown): CalculationResult {
      const authority = resolveSessionAuthority(this);
      if (!authority) {
        return { ok: false, failure: invalidCalculationFailure() };
      }
      return calculateRecipeNutrition(authority.context, request);
    },
    searchFoods(
      this: AdvancedNutritionSession,
      rawQuery: unknown,
      limit?: unknown
    ): FoodSearchResultUnion {
      const authority = resolveSessionAuthority(this);
      if (!authority) {
        return { ok: false, failure: phase4Failure('invalid_session') };
      }
      return searchFoodsInAuthority(authority, rawQuery, limit);
    },
  } as AdvancedNutritionSession;

  registerSessionAuthority(session, Object.freeze({ metadata, context, catalog }));

  return { ok: true, session: Object.freeze(session) };
}

function phase3PortionFailure() {
  // Bounded Phase 3 failure for a non-genuine receiver.
  return { code: 'invalid_context' as const, message: 'phase3_invalid_context' };
}

function invalidCalculationFailure() {
  return { code: 'invalid_context' as const, message: 'phase3_invalid_context' };
}

// ---------------------------------------------------------------------------
// Genuine authority re-derivation (for the Phase 5A Apply boundary)
// ---------------------------------------------------------------------------

/**
 * Trusted output of a genuine Phase 4 re-derivation. It carries only bounded
 * derived data — never the private catalog/context/records.
 */
export interface ReviewedNutritionRecompute {
  readonly metadata: Phase4SessionMetadata;
  /** Canonical authority identity of the genuine session. */
  readonly session_identity: string;
  readonly recipe_key: string;
  readonly servings: number;
  readonly preview: AdvisoryNutritionPreview;
}

export type ReviewedNutritionRecomputeResult =
  | { ok: true; result: ReviewedNutritionRecompute }
  | { ok: false; failure: Phase4Failure };

type SelectionRead = { ok: true; value: unknown } | { ok: false; unsafe: boolean };

function selectionReadFailure(result: SelectionRead): Phase4FailureCode {
  return (result as { unsafe?: boolean }).unsafe ? 'unsafe_request' : 'invalid_request';
}

function readSelectionField(state: object, key: string): SelectionRead {
  const field = readOwnDataField(state, key);
  if (!field.ok) return { ok: false, unsafe: true };
  if (!field.present || field.value === null || field.value === undefined) return { ok: true, value: {} };
  const materialized = materializeNarrow(field.value);
  if (!materialized.ok) return { ok: false, unsafe: materialized.unsafe };
  if (!isPlainObject(materialized.value)) return { ok: false, unsafe: false };
  return { ok: true, value: materialized.value };
}

/**
 * Reads the reviewed nutrient scope from the state's preview WITHOUT
 * materializing the whole preview. The value is an untrusted request parameter;
 * the calculation engine validates it. Returns undefined when absent/unsafe.
 */
function readStateNutrientScope(state: object): unknown {
  const previewField = readOwnDataField(state, 'preview');
  if (!previewField.ok || !previewField.present || !isPlainObject(previewField.value)) return undefined;
  const scopeField = readOwnDataField(previewField.value, 'nutrient_scope');
  if (!scopeField.ok || !scopeField.present) return undefined;
  const materialized = materializeNarrow(scopeField.value);
  if (!materialized.ok) return undefined;
  return materialized.value;
}

function mapCalculationCode(code: string): Phase4FailureCode {
  switch (code) {
    case 'invalid_servings':
      return 'invalid_servings';
    case 'unsafe_request':
      return 'unsafe_request';
    case 'invalid_context':
      return 'invalid_session';
    case 'validation_error':
      return 'validation_error';
    default:
      return 'invalid_request';
  }
}

/**
 * Genuinely re-derives the current reviewed nutrition result for the EXACT
 * receiver session. Authority is resolved through the module-private
 * `SESSION_AUTHORITY` WeakMap, so a structural fake, clone, spread, inherited
 * object, proxy, wrapper, primitive, or `null` is not registered and fails
 * closed as `invalid_session` BEFORE any caller-supplied method is invoked.
 *
 * The recipe envelope is re-adapted through the hardened Phase 4 adapter; the
 * state is read through guarded own-data descriptors; the calculation runs on
 * the genuine session. Only bounded derived data (metadata + preview) is
 * returned — never the private authority.
 */
export function recomputeReviewedNutrition(
  sessionRaw: unknown,
  recipeRaw: unknown,
  stateRaw: unknown
): ReviewedNutritionRecomputeResult {
  // Resolve authority FIRST: a forged session never has its methods invoked.
  const authority = resolveSessionAuthority(sessionRaw);
  if (!authority) return { ok: false, failure: phase4Failure('invalid_session') };

  try {
    const session = sessionRaw as AdvancedNutritionSession;

    const adaptation = adaptRecipe(recipeRaw);
    if (!adaptation.ok) {
      return { ok: false, failure: (adaptation as { ok: false; failure: Phase4Failure }).failure };
    }
    const adapted = adaptation.recipe;
    if (!isValidStrictServingCount(adapted.base_servings)) {
      return { ok: false, failure: phase4Failure('invalid_servings') };
    }

    if (!isPlainObject(stateRaw)) return { ok: false, failure: phase4Failure('invalid_request') };
    const state = stateRaw;

    const statusField = readOwnDataField(state, 'status');
    if (!statusField.ok) return { ok: false, failure: phase4Failure('unsafe_request') };
    if (statusField.value !== 'preview_current') return { ok: false, failure: phase4Failure('stale_binding') };

    const recipeKeyField = readOwnDataField(state, 'recipeKey');
    if (!recipeKeyField.ok) return { ok: false, failure: phase4Failure('unsafe_request') };
    if (recipeKeyField.value !== adapted.recipe_key) return { ok: false, failure: phase4Failure('stale_binding') };

    const sessionIdentity = phase4SessionIdentity(authority.metadata);
    const identityField = readOwnDataField(state, 'sessionIdentity');
    if (!identityField.ok) return { ok: false, failure: phase4Failure('unsafe_request') };
    if (identityField.value !== sessionIdentity) {
      return { ok: false, failure: phase4Failure('stale_binding') };
    }

    const baseServingsField = readOwnDataField(state, 'baseServings');
    if (!baseServingsField.ok) return { ok: false, failure: phase4Failure('unsafe_request') };
    if (baseServingsField.value !== adapted.base_servings) {
      return { ok: false, failure: phase4Failure('stale_binding') };
    }

    const matches = readSelectionField(state, 'matches');
    if (!matches.ok) return { ok: false, failure: phase4Failure(selectionReadFailure(matches)) };
    const portions = readSelectionField(state, 'portions');
    if (!portions.ok) return { ok: false, failure: phase4Failure(selectionReadFailure(portions)) };
    const countPortions = readSelectionField(state, 'countPortions');
    if (!countPortions.ok) return { ok: false, failure: phase4Failure(selectionReadFailure(countPortions)) };
    const userMasses = readSelectionField(state, 'userMasses');
    if (!userMasses.ok) return { ok: false, failure: phase4Failure(selectionReadFailure(userMasses)) };

    const scope = readStateNutrientScope(state);

    const rows = buildReviewRows(session, adapted.adapted as ReadonlyArray<AdaptedIngredient>);
    const syntheticState = {
      version: '',
      status: 'ready',
      recipeKey: adapted.recipe_key,
      sessionIdentity,
      baseServings: adapted.base_servings,
      rows,
      matches: matches.value,
      portions: portions.value,
      countPortions: countPortions.value,
      userMasses: userMasses.value,
      basis: 'entire_recipe',
      selectedServings: adapted.base_servings,
      preview: null,
      previewKey: null,
      failure: null,
      operationSeq: 0,
    } as unknown as Phase4State;

    const baseRequest = buildCalculationRequest(
      adapted.adapted as ReadonlyArray<AdaptedIngredient>,
      syntheticState
    ) as { servings: number; nutrient_scope: ReadonlyArray<NutrientId>; ingredients: unknown };
    const request = { ...baseRequest, ...(scope !== undefined ? { nutrient_scope: scope } : {}) };

    const calculated = session.calculate(request);
    if (!calculated.ok) {
      const code = (calculated as { ok: false; failure: { code: string } }).failure.code;
      return { ok: false, failure: phase4Failure(mapCalculationCode(code)) };
    }

    return {
      ok: true,
      result: {
        metadata: authority.metadata,
        session_identity: sessionIdentity,
        recipe_key: adapted.recipe_key,
        servings: adapted.base_servings,
        preview: calculated.preview,
      },
    };
  } catch {
    return { ok: false, failure: phase4Failure('validation_error') };
  }
}
