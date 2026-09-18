/**
 * The Kitchen Codex — Advanced Nutrition Phase 5A: Apply authorization contract.
 *
 * PURE, platform-neutral, offline. Phase 5A establishes the trusted boundary
 * between an advisory Phase 3/4 calculation and a future Phase 5B Apply/write:
 *
 *   current authenticated authority (Phase 4 session + reviewed selections)
 *     -> deterministic re-derivation of the exact reviewed result
 *     -> canonical schema-v1 `codex_nutrition` persistence candidate
 *     -> closed AUTHORIZED / NOT AUTHORIZED result
 *
 * Phase 5A NEVER persists anything: no Markdown/frontmatter/vault write, no
 * browser/backend storage, no Apply control, and no automatic persistence. It
 * also never trusts a caller-supplied nutrition object as authority — the
 * candidate is reconstructed from the genuine Phase 4 session and the current
 * reviewed state, then proven to match the reviewed preview.
 *
 * This module is intentionally NOT re-exported from `src/core/nutritionV2/index.ts`
 * or `src/core/index.ts`; the React layer and tests import it explicitly.
 */

import type { CodexNutritionV1 } from '../schema';
import type { AdvancedNutritionSession } from '../phase4/types';

/** Closed authorization-contract version (part of the candidate identity). */
export const PHASE5_AUTHORIZATION_VERSION = 'usda_phase5a_apply_authorization_v1';

// ---------------------------------------------------------------------------
// Failure taxonomy (closed, bounded, input-redacted)
// ---------------------------------------------------------------------------

export type Phase5AuthorizationFailureCode =
  | 'stale_preview'
  | 'invalid_servings'
  | 'unresolved_authority'
  | 'schema_invalid'
  | 'calculation_mismatch'
  | 'unknown_future_schema'
  | 'unsafe_request'
  | 'invalid_request'
  | 'validation_error';

export const PHASE5_FAILURE_MESSAGE: Readonly<Record<Phase5AuthorizationFailureCode, string>> =
  Object.freeze({
    stale_preview: 'phase5_stale_preview',
    invalid_servings: 'phase5_invalid_servings',
    unresolved_authority: 'phase5_unresolved_authority',
    schema_invalid: 'phase5_schema_invalid',
    calculation_mismatch: 'phase5_calculation_mismatch',
    unknown_future_schema: 'phase5_unknown_future_schema',
    unsafe_request: 'phase5_unsafe_request',
    invalid_request: 'phase5_invalid_request',
    validation_error: 'phase5_validation_error',
  });

export interface Phase5AuthorizationFailure {
  readonly code: Phase5AuthorizationFailureCode;
  /** Fixed, bounded, input-redacted message. Never echoes caller input. */
  readonly message: string;
}

export function phase5Failure(code: Phase5AuthorizationFailureCode): Phase5AuthorizationFailure {
  return Object.freeze({ code, message: PHASE5_FAILURE_MESSAGE[code] });
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * The persistence-authorization request. Every field is treated as untrusted:
 * the raw recipe is re-adapted, the state is read through guarded own-data
 * descriptors, and the preview is only used as a binding claim that must match
 * a fresh re-derivation through the genuine session.
 */
export interface Phase5AuthorizationRequest {
  /** The genuine Phase 4 session (lexically private authority). */
  readonly session: AdvancedNutritionSession;
  /** Untrusted raw recipe; re-adapted by Phase 5A. */
  readonly recipe: unknown;
  /** Current Phase 4 review state (including the current preview). */
  readonly state: unknown;
  /**
   * Optional raw existing `codex_nutrition` frontmatter value. Used only to
   * distinguish create vs. replace and to protect an opaque future schema.
   */
  readonly existingBlock?: unknown;
  /**
   * Optional explicit ISO-8601 timestamp seam. When omitted, the candidate's
   * `computed_at` is generated once from the wall clock. Never copied from a
   * caller-supplied block.
   */
  readonly computedAt?: unknown;
}

// ---------------------------------------------------------------------------
// Authorized candidate
// ---------------------------------------------------------------------------

/** Whole-block replacement semantics for the future Phase 5B writer. */
export type Phase5PersistenceMode = 'create' | 'replace';

/**
 * The authority/provenance identity Phase 5B must re-prove immediately before a
 * write. It binds the recipe, the genuine session authority, the calculation
 * version/context, the exact reviewed ingredient set, the serving denominator,
 * and the exact encoded block.
 */
export interface Phase5PersistenceIdentity {
  readonly authorization_version: string;
  readonly recipe_key: string;
  readonly session_identity: string;
  readonly calculation_version: string;
  readonly bundle_release: string;
  readonly catalog_digest: string;
  readonly nutrient_map_version: string;
  readonly ingredient_digest: string;
  readonly servings: number;
  readonly mode: Phase5PersistenceMode;
  /** `sha256:<64 hex>` of the canonical encoded block. */
  readonly candidate_digest: string;
}

export interface Phase5AuthorizedCandidate {
  readonly identity: Phase5PersistenceIdentity;
  /** Canonical, schema-validated schema-v1 block (totals only). */
  readonly block: CodexNutritionV1;
  /** Frontmatter-ready encoded whole-block replacement unit. */
  readonly encoded: Record<string, unknown>;
}

export type Phase5AuthorizationResult =
  | { ok: true; candidate: Phase5AuthorizedCandidate }
  | { ok: false; failure: Phase5AuthorizationFailure };
