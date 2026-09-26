/**
 * The Kitchen Codex — Advanced Nutrition Phase 5A: persistence-candidate builder
 * and Apply authorization.
 *
 * PURE, platform-neutral, offline, ADVISORY-BUILD ONLY. This module consumes the
 * exact current reviewed nutrition result ONLY through the genuine Phase 4
 * session boundary, then produces a canonical `codex_nutrition` persistence
 * candidate (schema v1, or schema v2 when any applied line carries verified
 * household provenance) plus a closed authorization result for the future
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
 *   - persistence candidate construction and schema v1/v2 mapping,
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
  MAX_RANGE_UNIT_LENGTH,
  type CodexNutritionV1,
  type CodexNutritionV2,
  type CodexNutritionV3,
  type IngredientEvidenceV2,
  type IngredientEvidenceV3,
  type NutrientResult,
  type NutritionBlockStatus,
  type NutritionSourceId,
  type UnresolvedIngredientRef,
  type UnresolvedReason,
  type WrittenMassRangeEvidence,
} from '../schema';
import { canonicalStringify, sha256Hex } from '../usda/digest';
import { DV_STANDARD_ID } from '../dailyValues';
import { decodeCodexNutrition, encodeCodexNutrition, validateCodexNutrition } from '../validate';
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
    case 'v2':
    case 'v3':
      return { ok: true, mode: 'replace' };
    case 'opaque':
      // A safe but unknown FUTURE schema is never authorized for overwrite.
      return { ok: false, code: 'unknown_future_schema' };
    case 'malformed':
    default:
      return { ok: false, code: 'schema_invalid' };
  }
}

/** Maps a genuine Phase 4 re-derivation failure onto the closed Phase 5A set. */function mapPhase4Failure(code: string): Phase5AuthorizationFailureCode {
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
 * `conversion_basis`. A `user_mass` line has no schema representation (neither
 * v1 nor v2 distinguishes a user-entered total weight) and is therefore
 * omitted rather than mislabelled. See §22.9 of the architecture document.
 */
function conversionBasisFor(
  massSource: string | undefined
): 'direct_mass' | 'source_portion' | 'household_portion' | undefined {
  if (massSource === 'direct_mass') return 'direct_mass';
  if (massSource === 'source_portion' || massSource === 'count_portion') return 'source_portion';
  if (massSource === 'household_portion') return 'household_portion';
  return undefined;
}

interface BlockBuild {
  readonly ok: true;
  readonly block: CodexNutritionV1 | CodexNutritionV2 | CodexNutritionV3;
}

/**
 * Canonicalizes a Phase 3 written-mass-range representative from the GENUINE
 * re-derived preview. A persisted marker is admitted ONLY when the authored
 * endpoints/unit are well-formed and the representative midpoint matches the
 * resolved direct mass within the canonical rounding bound; the marker's
 * `representative_grams` is then written as the SAME canonical rounded scalar as
 * the line `amount`, so a block-only consumer can never see a contradictory
 * pair. Malformed or absent evidence yields no marker (never a fabricated one).
 */
function persistedRangeRepresentative(
  raw: WrittenMassRangeEvidence | undefined,
  grams: number
): WrittenMassRangeEvidence | undefined {
  if (raw === undefined) return undefined;
  if (raw.amount_source !== 'written_mass_range' || raw.policy !== 'midpoint') return undefined;
  const lower = raw.lower;
  const upper = raw.upper;
  if (typeof lower !== 'number' || !Number.isFinite(lower) || lower <= 0 || Object.is(lower, -0)) {
    return undefined;
  }
  if (typeof upper !== 'number' || !Number.isFinite(upper) || upper <= 0 || Object.is(upper, -0)) {
    return undefined;
  }
  if (lower > upper) return undefined;
  if (typeof raw.unit !== 'string') return undefined;
  const unit = raw.unit.trim();
  if (unit.length === 0 || unit.length > MAX_RANGE_UNIT_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(unit)) {
    return undefined;
  }
  if (typeof raw.representative_grams !== 'number' || !Number.isFinite(raw.representative_grams)) {
    return undefined;
  }
  // The preview midpoint is derived from the same parse as the resolved grams;
  // it may only differ by the canonical 6-decimal rounding of the stored amount.
  if (Math.abs(raw.representative_grams - grams) > 1e-6) return undefined;
  return {
    amount_source: 'written_mass_range',
    policy: 'midpoint',
    lower,
    upper,
    unit,
    representative_grams: grams,
  };
}

/**
 * Canonical conditional write policy (Phase 6 + persisted-range repair):
 *   - when ANY applied line carries the `household_portion` basis, the block is
 *     serialized as schema v2 (household provenance is a v2/v3 meaning);
 *   - when ANY applied line carries a written-mass-range representative, the
 *     WHOLE block is serialized as schema v3 (the range marker is a v3 meaning;
 *     v3 retains household evidence, so a household + range block is v3);
 *   - when neither extension exists, the canonical write remains schema v1
 *     exactly as before.
 * A recipe that drops its last extended-provenance line therefore
 * deterministically returns to the smallest truthful schema version on the next
 * Apply (v2 with household only, v1 with neither).
 */
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

  const ingredients: IngredientEvidenceV3[] = [];
  let hasHouseholdBasis = false;
  let hasRangeRepresentative = false;
  for (const entry of preview.ingredients) {
    if (entry.outcome !== 'calculated') continue;
    if (entry.fdc_id === undefined || entry.resolved_grams === undefined) continue;
    const conversion = conversionBasisFor(entry.mass_source);
    if (conversion === 'household_portion') hasHouseholdBasis = true;
    const canonicalGrams = roundCanonicalTotal(entry.resolved_grams);
    // Persisted written-mass-range provenance: the marker exists ONLY for a
    // resolved `direct_mass` line and is coherent with the stored amount. It is
    // deterministic recipe-authored evidence, never AI-supplied and never
    // re-derived from the caller's claimed preview.
    const rangeRepresentative =
      entry.mass_source === 'direct_mass'
        ? persistedRangeRepresentative(entry.range_representative, canonicalGrams)
        : undefined;
    if (rangeRepresentative !== undefined) hasRangeRepresentative = true;
    // Phase 6 household provenance: persist ONLY the bounded re-authentication
    // evidence (registry release + record binding + quantity + selection digest).
    // A household basis without complete evidence is persisted WITHOUT the
    // evidence object on purpose: schema validation then fails the whole block
    // closed rather than writing a household result that cannot be re-proven.
    const householdPortion =
      entry.mass_source === 'household_portion' &&
      typeof entry.household_registry_release === 'string' &&
      typeof entry.household_record_key === 'string' &&
      typeof entry.household_record_digest === 'string' &&
      typeof entry.household_unit === 'string' &&
      typeof entry.household_quantity === 'number' &&
      typeof entry.household_selection_digest === 'string'
        ? {
            registry_release: entry.household_registry_release,
            record_key: entry.household_record_key,
            record_digest: entry.household_record_digest,
            household_unit: entry.household_unit,
            size_class: entry.household_size_class ?? null,
            requires_state: entry.household_requires_state ?? null,
            quantity: entry.household_quantity,
            selection_digest: entry.household_selection_digest,
          }
        : undefined;
    // ESTABLISHED Phase 5 persisted-review semantics (see §22.2 / §22.12): the
    // `confirmed` / `resolved: true` / `user_confirmed: true` triple means "this
    // evidence was part of the explicit reviewed result the user authorized for
    // Apply" — not "the original match required a manual click". A unique-exact
    // match, an explicit user confirmation, and a deterministic ANALYZER
    // selection (`auto_confirmed`) are all resolved evidence once the user
    // explicitly Applies. The automatic-vs-user distinction is preserved in the
    // live Phase 3 calculation evidence (`match_status`), never lost.
    ingredients.push({
      line_ref: entry.line_ref,
      source: 'usda_fdc',
      source_food_id: String(entry.fdc_id),
      source_release: preview.bundle_release,
      match_status: 'confirmed',
      resolved: true,
      user_confirmed: true,
      amount: { value: canonicalGrams, unit: 'g' },
      ...(conversion ? { conversion_basis: conversion } : {}),
      ...(householdPortion ? { household_portion: householdPortion } : {}),
      ...(rangeRepresentative ? { range_representative: rangeRepresentative } : {}),
    });
  }

  const unresolved: UnresolvedIngredientRef[] = [];
  const evidenceByRef = new Map(preview.ingredients.map((entry) => [entry.line_ref, entry]));
  for (const entry of preview.unresolved) {
    const reason = mapUnresolvedReason(entry.outcome);
    if (!reason) continue;
    // FOOD-VS-MASS INDEPENDENCE: when the user explicitly confirmed a USDA food
    // for a line whose MASS is still unresolved, persist that reviewed food
    // identity so the selection survives reopen (the line still contributes ZERO
    // to nutrient totals). Only a user-confirmed choice is persisted; an
    // automatic candidate is never promoted to reviewed evidence.
    const evidence = evidenceByRef.get(entry.line_ref);
    const reviewedFood =
      evidence !== undefined &&
      evidence.user_confirmed === true &&
      evidence.match_status === 'user_confirmed' &&
      typeof evidence.fdc_id === 'number' &&
      Number.isSafeInteger(evidence.fdc_id) &&
      evidence.fdc_id > 0;
    unresolved.push({
      line_ref: entry.line_ref,
      reason,
      ...(reviewedFood
        ? {
            source_food_id: String((evidence as { fdc_id: number }).fdc_id),
            source_release: preview.bundle_release,
          }
        : {}),
    });
  }

  const schema = hasRangeRepresentative ? 3 : hasHouseholdBasis ? 2 : 1;
  const block = {
    schema,
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
  } as CodexNutritionV1 | CodexNutritionV2 | CodexNutritionV3;
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

    // --- REPLACE-MODE REGRESSION GATE ---------------------------------------
    // An explicit re-Apply must never silently downgrade a previously applied
    // and reviewed ingredient line from resolved mass to unresolved. When the
    // existing block binds a line that the freshly derived result can no
    // longer resolve (for example a hint-dependent count portion the current
    // context cannot re-authenticate), authorization fails closed until the
    // user resolves that mass again — the saved applied report stays
    // untouched and no provenance downgrade is ever written. Lines whose
    // line_ref no longer exists in the derived result (edited recipe lines)
    // are not comparable and never block.
    if (existingField.present) {
      // The existing block may be stored in its encoded frontmatter form; use
      // the SAME decoding the mode resolution already performed.
      const decodedExisting = decodeCodexNutrition(existingField.value);
      if (decodedExisting.kind === 'v1' || decodedExisting.kind === 'v2' || decodedExisting.kind === 'v3') {
        const derivedResolved = new Set(
          built.block.ingredients.filter((entry) => entry.resolved === true).map((entry) => entry.line_ref)
        );
        for (const applied of decodedExisting.value.ingredients) {
          if (applied.resolved !== true) continue;
          if (derivedResolved.has(applied.line_ref)) continue;
          const stillInRecipe = trusted.preview.ingredients.some(
            (entry) => entry.line_ref === applied.line_ref
          );
          if (stillInRecipe) return fail('applied_line_unresolved');
        }
      }
    }

    // --- Final schema validation gate (never bypass) ------------------------
    // The schema discriminator selects the version-specific contract; a
    // household-bearing candidate is validated as v2, a non-household candidate
    // as canonical v1.
    const validation = validateCodexNutrition(built.block);
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
