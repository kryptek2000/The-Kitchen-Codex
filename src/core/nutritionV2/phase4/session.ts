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

import { validateManifest } from '../usda/manifest';
import { createNutritionCalculationContext, calculateRecipeNutrition, reviewFoodPortions } from '../calculation/context';
import { confirmIngredientReview, createReviewCatalog, reviewIngredient } from '../matching/review';
import { phase2Failure } from '../matching/types';
import type { ConfirmationResult, IngredientReviewResult, ReviewCatalog } from '../matching/types';
import type { CalculationResult, NutritionCalculationContext, PortionReviewResult } from '../calculation/types';
import {
  PHASE4_SESSION_VERSION,
  phase4Failure,
  type AdvancedNutritionSession,
  type AdvancedNutritionSessionResult,
  type Phase4SessionMetadata,
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
