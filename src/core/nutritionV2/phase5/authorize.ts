/**
 * The Kitchen Codex — Advanced Nutrition Phase 5A: persistence-candidate builder
 * and Apply authorization.
 *
 * PURE, platform-neutral, offline, ADVISORY-BUILD ONLY. This module consumes the
 * exact current reviewed nutrition result ONLY through the genuine Phase 4
 * session boundary, then produces a canonical schema-v1 `codex_nutrition`
 * persistence candidate plus a closed authorization result for the future
 * Phase 5B Apply/write step.
 *
 * TRUST PRINCIPLE
 * ---------------
 * A caller-supplied nutrition object is NEVER authority, and a caller-supplied
 * session object is NEVER authenticated structurally. The trusted result comes
 * exclusively from `recomputeReviewedNutrition`, which resolves the genuine
 * Phase 4 session through the module-private `SESSION_AUTHORITY` WeakMap and
 * fails closed for any fake, clone, spread, inherited object, proxy, wrapper,
 * primitive, or `null` — before invoking any caller-supplied method. This module
 * then owns only:
 *   - persistence candidate construction and schema-v1 mapping,
 *   - persistence identity construction, and
 *   - the final schema validation + canonical encode gate.
 * The caller's preview is used only as a stale-detection binding against the
 * genuine re-derivation; the emitted block is always built from the genuine
 * result.
 *
 * NO WRITE PRIVILEGE
 * ------------------
 * This module contains no Markdown/frontmatter/vault/FileSystem/localStorage/
 * IndexedDB/CacheStorage/service-worker/backend write path. It constructs and
 * validates an in-memory block only; Phase 5B owns the explicit Apply.
 *
 * UNTRUSTED-VALUE POLICY
 * ----------------------
 * Public boundaries read only guarded own enumerable data properties (never
 * invoking getters/setters/proxies) and reuse the Phase 0/4 inert materializers.
 * Accessors, proxies, symbols, dangerous keys, cycles, non-plain prototypes,
 * functions, bigints, undefined-own fields, and oversized values fail closed
 * with fixed, bounded, input-redacted diagnostics. No attacker exception object
 * or message can escape.
 */

import {
  isPlainObject,
  MAX_TIMESTAMP_LENGTH,
  type CodexNutritionV1,
  type IngredientEvidence,
  type NutrientResult,
  type NutritionBlockStatus,
  type NutritionSourceId,
  type UnresolvedIngredientRef,
  type UnresolvedReason,
} from '../schema';
import { canonicalStringify, sha256Hex } from '../usda/digest';
import { DV_STANDARD_ID } from '../dailyValues';
import { decodeCodexNutrition, encodeCodexNutrition, validateCodexNutritionV1 } from '../validate';
import { isNutrientId, NUTRIENT_IDS, type NutrientId } from '../nutrients';
import { isValidStrictServingCount } from '../calculation/servings';
import { roundCanonicalTotal } from '../calculation/numeric';
import type { AdvisoryNutritionPreview } from '../calculation/types';
import { recomputeReviewedNutrition } from '../phase4/session';
import { hasDangerousOwnKey, hasSymbolKeys, materializeNarrow, readOwnDataField } from '../phase4/materialize';
import {
  PHASE5_AUTHORIZATION_VERSION,
  phase5Failure,
  type Phase5AuthorizationFailureCode,
  type Phase5AuthorizationResult,
  type Phase5PersistenceMode,
} from './types';

// ---------------------------------------------------------------------------
// Small result helpers
// ---------------------------------------------------------------------------

function fail(code: Phase5AuthorizationFailureCode): Phase5AuthorizationResult {
  return { ok: false, failure: phase5Failure(code) };
}

type FieldRead = { ok: true; present: boolean; value: unknown } | { ok: false };

function ownField(object: object, key: string): FieldRead {
  return readOwnDataField(object, key);
}

/** Reads an optional bounded string binding field. */
function readStringBinding(
  object: object,
  key: string
): { ok: true; value: string | undefined } | { ok: false } {
  const field = ownField(object, key);
  if (!field.ok) return { ok: false };
  if (!field.present || field.value === null || field.value === undefined) return { ok: true, value: undefined };
  if (typeof field.value !== 'string') return { ok: false };
  return { ok: true, value: field.value };
}

/**
 * Strictly validates the recipe's OWN serving denominator. Unlike the Phase 4
 * adapter (which historically defaults to 1), persistence authorization rejects
 * an absent, zero, negative, non-finite, `-0`, over-precise, or out-of-range
 * denominator rather than silently defaulting it.
 */
function readRecipeServings(
  recipe: unknown
): { ok: true; value: number } | { ok: false; code: Phase5AuthorizationFailureCode } {
  if (!isPlainObject(recipe)) return { ok: false, code: 'invalid_request' };
  const field = ownField(recipe, 'servings');
  if (!field.ok) return { ok: false, code: 'unsafe_request' };
  if (!field.present) return { ok: false, code: 'invalid_servings' };
  const materialized = materializeNarrow(field.value);
  if (!materialized.ok) return { ok: false, code: 'unsafe_request' };
  if (!isValidStrictServingCount(materialized.value)) return { ok: false, code: 'invalid_servings' };
  return { ok: true, value: materialized.value };
}

/** The single wall-clock seam. Tests and the UI supply an explicit timestamp. */
function defaultClock(): string {
  return new Date().toISOString();
}

function isValidTimestampString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TIMESTAMP_LENGTH &&
    Number.isFinite(Date.parse(value))
  );
}

function readComputedAt(request: object): { ok: true; value: string } | { ok: false } {
  const field = ownField(request, 'computedAt');
  if (!field.ok) return { ok: false };
  if (!field.present) return { ok: true, value: defaultClock() };
  const materialized = materializeNarrow(field.value);
  if (!materialized.ok) return { ok: false };
  if (!isValidTimestampString(materialized.value)) return { ok: false };
  return { ok: true, value: materialized.value };
}

/** Closed create/replace/fail-closed decision for an existing stored block. */
function resolvePersistenceMode(
  existingBlock: unknown
): { ok: true; mode: Phase5PersistenceMode } | { ok: false; code: Phase5AuthorizationFailureCode } {
  const decoded = decodeCodexNutrition(existingBlock);
  switch (decoded.kind) {
    case 'none':
      return { ok: true, mode: 'create' };
    case 'v1':
      return { ok: true, mode: 'replace' };
    case 'opaque':
      // A safe but unknown FUTURE schema is never authorized for overwrite.
      return { ok: false, code: 'unknown_future_schema' };
    case 'malformed':
    default:
      return { ok: false, code: 'schema_invalid' };
  }
}

/** Maps a genuine Phase 4 re-derivation failure onto the closed Phase 5A set. */
function mapPhase4Failure(code: string): Phase5AuthorizationFailureCode {
  switch (code) {
    case 'invalid_session':
      return 'unresolved_authority';
    case 'invalid_servings':
      return 'invalid_servings';
    case 'unsafe_request':
      return 'unsafe_request';
    case 'stale_binding':
      return 'stale_preview';
    case 'validation_error':
      return 'validation_error';
    case 'invalid_recipe':
    case 'invalid_request':
    case 'unknown_field':
    case 'not_available':
    case 'invalid_selection':
    default:
      return 'invalid_request';
  }
}

/** Validates the claimed canonical nutrient scope from the reviewed preview. */
function readClaimedScope(preview: object): NutrientId[] | undefined {
  const field = ownField(preview, 'nutrient_scope');
  if (!field.ok || !field.present) return undefined;
  const materialized = materializeNarrow(field.value);
  if (!materialized.ok) return undefined;
  const raw = materialized.value;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > NUTRIENT_IDS.length) return undefined;
  const ids: NutrientId[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    if (!isNutrientId(id) || seen.has(id)) return undefined;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * True when the caller's reviewed preview still binds the GENUINE re-derivation
 * on every authoritative scalar. Totals are a deterministic function of the
 * ingredient digest + scope + servings, so this is a complete staleness proof.
 */
function previewStillBinds(claimed: object, recomputed: AdvisoryNutritionPreview): boolean {
  const schema = ownField(claimed, 'calculation_schema');
  if (!schema.ok || schema.value !== 1) return false;
  for (const [key, expected] of [
    ['calculation_version', recomputed.calculation_version],
    ['bundle_release', recomputed.bundle_release],
    ['catalog_digest', recomputed.catalog_digest],
    ['nutrient_map_version', recomputed.nutrient_map_version],
    ['status', recomputed.status],
    ['ingredient_digest', recomputed.ingredient_digest],
  ] as ReadonlyArray<[string, string]>) {
    const read = readStringBinding(claimed, key);
    if (!read.ok || read.value !== expected) return false;
  }
  const servings = ownField(claimed, 'servings');
  if (!servings.ok || servings.value !== recomputed.servings) return false;
  const basis = readStringBinding(claimed, 'basis');
  if (!basis.ok || basis.value !== 'total') return false;
  const claimedScope = readClaimedScope(claimed);
  if (!claimedScope || claimedScope.length !== recomputed.nutrient_scope.length) return false;
  for (let i = 0; i < recomputed.nutrient_scope.length; i += 1) {
    if (claimedScope[i] !== recomputed.nutrient_scope[i]) return false;
  }
  return true;
}

function mapUnresolvedReason(outcome: string): UnresolvedReason | undefined {
  switch (outcome) {
    case 'no_match':
      return 'no_match';
    case 'ambiguous':
      return 'ambiguous';
    case 'no_mass':
      return 'no_mass';
    case 'no_nutrition':
      return 'no_nutrition';
    default:
      return undefined;
  }
}

/**
 * Maps a resolved Phase 3 ingredient's mass source onto the schema's closed
 * `conversion_basis`. A `user_mass` line has no schema-v1 representation (the
 * schema only distinguishes direct mass from a source portion) and is therefore
 * omitted rather than mislabelled. See §22.9 of the architecture document.
 */
function conversionBasisFor(massSource: string | undefined): 'direct_mass' | 'source_portion' | undefined {
  if (massSource === 'direct_mass') return 'direct_mass';
  if (massSource === 'source_portion' || massSource === 'count_portion') return 'source_portion';
  return undefined;
}

interface BlockBuild {
  readonly ok: true;
  readonly block: CodexNutritionV1;
}

function buildPersistenceBlock(preview: AdvisoryNutritionPreview, computedAt: string): BlockBuild {
  const sources: NutritionSourceId[] = ['usda_fdc'];
  const sourceReleases: Partial<Record<NutritionSourceId, string>> = {
    usda_fdc: preview.bundle_release,
  };

  const nutrients: Partial<Record<NutrientId, NutrientResult>> = {};
  for (const id of preview.nutrient_scope) {
    const total = preview.totals[id];
    if (!total) continue;
    nutrients[id] = {
      amount: total.amount,
      unit: total.unit,
      status: total.status,
      coverage: total.coverage,
      covered_ingredient_count: total.covered_ingredient_count,
      measurable_ingredient_count: total.measurable_ingredient_count,
    };
  }

  const ingredients: IngredientEvidence[] = [];
  for (const entry of preview.ingredients) {
    if (entry.outcome !== 'calculated') continue;
    if (entry.fdc_id === undefined || entry.resolved_grams === undefined) continue;
    const conversion = conversionBasisFor(entry.mass_source);
    ingredients.push({
      line_ref: entry.line_ref,
      source: 'usda_fdc',
      source_food_id: String(entry.fdc_id),
      source_release: preview.bundle_release,
      match_status: 'confirmed',
      resolved: true,
      user_confirmed: true,
      amount: { value: roundCanonicalTotal(entry.resolved_grams), unit: 'g' },
      ...(conversion ? { conversion_basis: conversion } : {}),
    });
  }

  const unresolved: UnresolvedIngredientRef[] = [];
  for (const entry of preview.unresolved) {
    const reason = mapUnresolvedReason(entry.outcome);
    if (!reason) continue;
    unresolved.push({ line_ref: entry.line_ref, reason });
  }

  const block: CodexNutritionV1 = {
    schema: 1,
    basis: 'total',
    servings: preview.servings,
    status: preview.status as NutritionBlockStatus,
    computed_at: computedAt,
    ingredient_digest: preview.ingredient_digest,
    dv_standard: DV_STANDARD_ID,
    sources,
    source_releases: sourceReleases,
    nutrient_scope: [...preview.nutrient_scope],
    nutrients,
    ingredients,
    unresolved,
  };
  return { ok: true, block };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Authorizes (or refuses) construction of a `codex_nutrition` persistence
 * candidate from the current authenticated authority. The nutrition result is
 * re-derived ONLY through the genuine Phase 4 session boundary; a fake session
 * fails closed before any caller-supplied method is invoked. Never persists,
 * never throws; always returns a closed result with bounded, input-redacted
 * failures.
 */
export function authorizeNutritionPersistence(requestRaw: unknown): Phase5AuthorizationResult {
  try {
    if (!isPlainObject(requestRaw)) return fail('invalid_request');
    if (hasSymbolKeys(requestRaw) || hasDangerousOwnKey(requestRaw)) return fail('unsafe_request');

    const sessionField = ownField(requestRaw, 'session');
    if (!sessionField.ok) return fail('unsafe_request');
    if (!sessionField.present) return fail('unresolved_authority');

    const recipeField = ownField(requestRaw, 'recipe');
    if (!recipeField.ok) return fail('unsafe_request');
    if (!recipeField.present) return fail('invalid_request');

    // Strict serving-denominator validation happens BEFORE any authority use, so
    // an absent/invalid denominator is never silently defaulted.
    const rawServings = readRecipeServings(recipeField.value);
    if (!rawServings.ok) {
      return fail((rawServings as { ok: false; code: Phase5AuthorizationFailureCode }).code);
    }

    const stateField = ownField(requestRaw, 'state');
    if (!stateField.ok) return fail('unsafe_request');
    if (!stateField.present || !isPlainObject(stateField.value)) return fail('invalid_request');
    const state = stateField.value;

    // The reviewed preview is a stale-detection claim only — never authority.
    const previewField = ownField(state, 'preview');
    if (!previewField.ok) return fail('unsafe_request');
    if (!previewField.present || !isPlainObject(previewField.value)) return fail('stale_preview');
    const claimedPreview = previewField.value;

    const computedAt = readComputedAt(requestRaw);
    if (!computedAt.ok) return fail('unsafe_request');

    const existingField = ownField(requestRaw, 'existingBlock');
    if (!existingField.ok) return fail('unsafe_request');
    const modeResult = resolvePersistenceMode(existingField.present ? existingField.value : undefined);
    if (!modeResult.ok) {
      return fail((modeResult as { ok: false; code: Phase5AuthorizationFailureCode }).code);
    }

    // --- Genuine Phase 4 authority re-derivation ---------------------------
    // Authority is resolved through the module-private WeakMap for the exact
    // receiver; a forged session fails closed before any of its methods run.
    const recompute = recomputeReviewedNutrition(sessionField.value, recipeField.value, state);
    if (!recompute.ok) {
      const failure = (recompute as { ok: false; failure: { code: string } }).failure;
      return fail(mapPhase4Failure(failure.code));
    }
    const trusted = recompute.result;

    if (rawServings.value !== trusted.servings) return fail('stale_preview');
    if (!previewStillBinds(claimedPreview, trusted.preview)) return fail('calculation_mismatch');

    // --- Build the canonical block from the GENUINE result ------------------
    const built = buildPersistenceBlock(trusted.preview, computedAt.value);

    // --- Final schema validation gate (never bypass) ------------------------
    const validation = validateCodexNutritionV1(built.block);
    if (!validation.ok || !validation.value) return fail('schema_invalid');
    const canonical = validation.value;

    let encoded: Record<string, unknown>;
    try {
      encoded = encodeCodexNutrition(canonical);
    } catch {
      return fail('schema_invalid');
    }

    let candidateDigest: string;
    try {
      candidateDigest = `sha256:${sha256Hex(canonicalStringify(encoded))}`;
    } catch {
      return fail('schema_invalid');
    }

    const metadata = trusted.metadata;
    const identity = Object.freeze({
      authorization_version: PHASE5_AUTHORIZATION_VERSION,
      recipe_key: trusted.recipe_key,
      session_identity: trusted.session_identity,
      calculation_version: metadata.calculation_version,
      bundle_release: metadata.bundle_release,
      catalog_digest: metadata.catalog_digest,
      nutrient_map_version: metadata.nutrient_map_version,
      ingredient_digest: trusted.preview.ingredient_digest,
      servings: trusted.servings,
      mode: modeResult.mode,
      candidate_digest: candidateDigest,
    });

    return {
      ok: true,
      candidate: Object.freeze({
        identity,
        block: canonical,
        encoded: Object.freeze(encoded),
      }),
    };
  } catch {
    return fail('validation_error');
  }
}
