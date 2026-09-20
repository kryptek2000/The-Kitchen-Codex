/**
 * The Kitchen Codex — Advanced Nutrition Phase 3: advisory calculation engine.
 *
 * PURE, offline. Internal to the calculation boundary; it is imported by the
 * authority-owning `context.ts` and is NOT exported from the public barrel. It
 * receives the private records map + genuine match catalog as plain inputs and
 * never registers authority itself.
 *
 * It re-derives the CURRENT Phase 2 review for every ingredient, rebinds any
 * confirmation to the current catalog, resolves mass only from direct mass or an
 * explicitly reviewed source portion, and produces advisory entire-recipe totals
 * with nutrient-specific coverage. It never persists, serializes, applies, or
 * authorizes anything.
 */

import { isPlainObject, toInertValue } from '../schema';
import { canonicalStringify, sha256Hex } from '../usda/digest';
import { isNutrientId, NUTRIENT_IDS, NUTRIENT_REGISTRY, type NutrientId } from '../nutrients';
import { isValidNutrientAmount, MAX_NUTRIENT_AMOUNT, type CanonicalUnit } from '../units';
import { normalizeQuery } from '../matching/normalize';
import { parseIngredient } from '../matching/parse';
import { projectQueryText } from '../matching/query';
import { confirmIngredientReview, reviewIngredient } from '../matching/review';
import { isDeterministicAutomaticSelection } from '../matching/confidence';
import type { ConfirmationResult, ReviewCatalog } from '../matching/types';
import type { CanonicalUsdaFoodRecord } from '../usda/types';
import { isQualitativeIngredientText } from '../../../utils/ingredientSemantics';
import { resolvePortionMassGrams, resolveUserMassGrams, type PortionMassResolution, type UserMassResolution } from './mass';
import { PORTION_SEMANTICS_VERSION, type PortionMeasurement } from './portionSemantics';
import {
  deriveCountRequirement,
  resolveCountPortionMassGrams,
  resolveDeterministicCountPortionGrams,
  sanitizeCountPortionSelection,
  type CountPortionMassResolution,
} from './countPortion';
import { contributionFor, isWithinCanonicalBound, roundCanonicalTotal, stableSum } from './numeric';
import { isValidStrictServingCount } from './servings';
import {
  CALCULATION_SCHEMA,
  CALCULATION_VERSION,
  MAX_CALCULATION_GRAMS,
  MAX_CALCULATION_INGREDIENTS,
  MAX_CALCULATION_LINE_REF_LENGTH,
  phase3Failure,
  type AdvisoryNutritionPreview,
  type CalculationResult,
  type CalculationStatus,
  type IngredientCalculationEvidence,
  type IngredientOutcome,
  type MassSource,
  type MatchStatus,
  type NutrientTotalResult,
  type Phase3Failure,
  type Phase3FailureCode,
  type PortionSelection,
  type UnresolvedIngredient,
  type UserMassSelection,
} from './types';

const REQUEST_KEYS = new Set(['servings', 'nutrient_scope', 'ingredients']);
const INGREDIENT_INPUT_KEYS = new Set([
  'line_ref',
  'ingredient',
  'review',
  'selection',
  'automatic_selection',
  'portion_selection',
  'count_portion_selection',
  'user_mass_selection',
]);
const PORTION_SELECTION_KEYS = new Set([
  'calculation_version',
  'portion_semantics_version',
  'line_ref',
  'ingredient_identity_digest',
  'bundle_release',
  'fdc_id',
  'record_digest',
  'candidates_digest',
  'portion_index',
  'portion_amount',
  'measure',
  'gram_weight',
  'modifier',
  'semantics_kind',
  'semantics_unit',
  'semantics_volume_ml',
  'semantics_amount',
  'semantics_gram_weight',
]);
const USER_MASS_SELECTION_KEYS = new Set([
  'calculation_version',
  'line_ref',
  'ingredient_identity_digest',
  'bundle_release',
  'fdc_id',
  'record_digest',
  'quantity',
  'unit',
  'grams',
  'selection_digest',
]);

export interface AdvisoryCalculationInputs {
  readonly bundleRelease: string;
  readonly catalogDigest: string;
  readonly nutrientMapVersion: string;
  readonly records: ReadonlyMap<number, CanonicalUsdaFoodRecord>;
  readonly catalog: ReviewCatalog;
  /** Untrusted request value. */
  readonly request: unknown;
}

type Materialized = { ok: true; value: unknown } | { ok: false; unsafe: boolean };

function materialize(raw: unknown): Materialized {
  const result = toInertValue(raw);
  if (result.ok) return { ok: true, value: result.value };
  const reason = (result as { ok: false; reason: string }).reason;
  const unsafe =
    reason === 'dangerous_key' ||
    reason === 'accessor_or_hidden_property' ||
    reason === 'array_accessor_or_hole' ||
    reason === 'reflection_failed' ||
    reason === 'cycle' ||
    reason === 'symbol_key';
  return { ok: false, unsafe };
}

function fail(code: Phase3FailureCode): CalculationResult {
  return { ok: false, failure: phase3Failure(code) };
}

function isSafePositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && value >= 0;
}

interface PreparedIngredient {
  readonly lineRef: string;
  readonly ingredient: unknown;
  readonly review: unknown;
  readonly selection: unknown;
  /** True when the UI analyzer (not the user) chose this match. */
  readonly automaticSelection: unknown;
  readonly portionSelection: unknown;
  readonly countPortionSelection: unknown;
  readonly userMassSelection: unknown;
}

interface EvaluatedIngredient {
  readonly lineRef: string;
  readonly originalText: string;
  readonly amount: number | null;
  readonly rawUnit: string | undefined;
  readonly normalizedUnit: string;
  readonly measurementKind: string;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly note: string | undefined;
  readonly qualitative: boolean;
  readonly matchStatus: MatchStatus;
  readonly matched: boolean;
  readonly ambiguous: boolean;
  readonly fdcId: number | undefined;
  readonly recordDigest: string | undefined;
  readonly confirmationDigest: string | undefined;
  readonly grams: number | undefined;
  readonly massSource: MassSource | undefined;
  readonly portionIndex: number | undefined;
  readonly portionCandidatesDigest: string | undefined;
  readonly countIngredientAmount: number | undefined;
  readonly countPortionAmount: number | undefined;
  readonly countGramWeight: number | undefined;
  readonly countUnit: string | undefined;
  readonly countSize: string | undefined;
  readonly countDeterministic: boolean | undefined;
  readonly userMassQuantity: number | undefined;
  readonly userMassUnit: string | undefined;
  readonly contributions: Partial<Record<NutrientId, number>>;
  readonly contributingNutrients: ReadonlyArray<NutrientId>;
  readonly outcome: IngredientOutcome;
}

function identityPayload(e: EvaluatedIngredient) {
  return {
    line_ref: e.lineRef,
    original_text: e.originalText,
    amount: e.amount,
    ...(e.rawUnit !== undefined ? { raw_unit: e.rawUnit } : {}),
    normalized_unit: e.normalizedUnit,
    measurement_kind: e.measurementKind,
    query: e.query,
    normalized_query: e.normalizedQuery,
    ...(e.note !== undefined ? { note: e.note } : {}),
    qualitative: e.qualitative,
    match_status: e.matchStatus,
    ...(e.fdcId !== undefined ? { fdc_id: e.fdcId } : {}),
    ...(e.recordDigest !== undefined ? { record_digest: e.recordDigest } : {}),
    ...(e.confirmationDigest !== undefined ? { confirmation_digest: e.confirmationDigest } : {}),
  };
}

function fullPayload(e: EvaluatedIngredient) {
  return {
    identity: identityPayload(e),
    mass_source: e.massSource ?? null,
    ...(e.portionIndex !== undefined ? { portion_index: e.portionIndex } : {}),
    ...(e.portionCandidatesDigest !== undefined
      ? { portion_candidates_digest: e.portionCandidatesDigest }
      : {}),
    ...(e.countPortionAmount !== undefined
      ? {
          count_ingredient_amount: e.countIngredientAmount,
          count_portion_amount: e.countPortionAmount,
          count_gram_weight: e.countGramWeight,
          count_unit: e.countUnit ?? null,
          count_size: e.countSize ?? null,
          count_deterministic: e.countDeterministic === true,
        }
      : {}),
    ...(e.userMassQuantity !== undefined ? { user_mass_quantity: e.userMassQuantity } : {}),
    ...(e.userMassUnit !== undefined ? { user_mass_unit: e.userMassUnit } : {}),
    resolved_grams: e.grams ?? null,
    outcome: e.outcome,
    contributing_nutrients: [...e.contributingNutrients],
  };
}

function digestOf(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalStringify(payload))}`;
}

function validateNutrientScope(raw: unknown): { ok: true; ids: NutrientId[] } | { ok: false; code: Phase3FailureCode } {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > NUTRIENT_IDS.length) {
    return { ok: false, code: 'invalid_nutrient_scope' };
  }
  const ids: NutrientId[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!isNutrientId(value)) return { ok: false, code: 'invalid_nutrient_scope' };
    if (seen.has(value)) return { ok: false, code: 'invalid_nutrient_scope' };
    seen.add(value);
    ids.push(value);
  }
  return { ok: true, ids };
}

function sanitizePortionSelection(
  raw: unknown
): { ok: true; selection: PortionSelection } | { ok: false; code: Phase3FailureCode } {
  const materialized = materialize(raw);
  if (!materialized.ok) {
    return {
      ok: false,
      code: (materialized as { ok: false; unsafe: boolean }).unsafe
        ? 'unsafe_request'
        : 'invalid_portion_selection',
    };
  }
  if (!isPlainObject(materialized.value)) return { ok: false, code: 'invalid_portion_selection' };
  const value = materialized.value;
  for (const key of Object.keys(value)) {
    if (!PORTION_SELECTION_KEYS.has(key)) return { ok: false, code: 'unknown_field' };
  }
  if (value.calculation_version !== CALCULATION_VERSION) return { ok: false, code: 'invalid_portion_selection' };
  if (value.portion_semantics_version !== PORTION_SEMANTICS_VERSION) {
    return { ok: false, code: 'invalid_portion_selection' };
  }
  if (typeof value.line_ref !== 'string' || value.line_ref.length === 0) {
    return { ok: false, code: 'invalid_portion_selection' };
  }
  if (typeof value.ingredient_identity_digest !== 'string') {
    return { ok: false, code: 'invalid_portion_selection' };
  }
  if (typeof value.bundle_release !== 'string') return { ok: false, code: 'invalid_portion_selection' };
  if (!isSafePositiveInt(value.fdc_id)) return { ok: false, code: 'invalid_portion_selection' };
  if (typeof value.record_digest !== 'string') return { ok: false, code: 'invalid_portion_selection' };
  if (typeof value.candidates_digest !== 'string') return { ok: false, code: 'invalid_portion_selection' };
  if (!Number.isSafeInteger(value.portion_index) || (value.portion_index as number) < 0) {
    return { ok: false, code: 'invalid_portion_selection' };
  }
  if (!isFiniteNonNegativeNumber(value.portion_amount) || !((value.portion_amount as number) > 0)) {
    return { ok: false, code: 'invalid_portion_selection' };
  }
  if (typeof value.measure !== 'string') return { ok: false, code: 'invalid_portion_selection' };
  if (!isFiniteNonNegativeNumber(value.gram_weight) || !((value.gram_weight as number) > 0)) {
    return { ok: false, code: 'invalid_portion_selection' };
  }
  if (value.modifier !== undefined && typeof value.modifier !== 'string') {
    return { ok: false, code: 'invalid_portion_selection' };
  }
  const kind = value.semantics_kind;
  if (kind !== 'volume' && kind !== 'mass' && kind !== 'count' && kind !== 'unusable') {
    return { ok: false, code: 'invalid_portion_selection' };
  }
  if (value.semantics_unit !== null && typeof value.semantics_unit !== 'string') {
    return { ok: false, code: 'invalid_portion_selection' };
  }
  if (value.semantics_volume_ml !== null && !isFiniteNonNegativeNumber(value.semantics_volume_ml)) {
    return { ok: false, code: 'invalid_portion_selection' };
  }
  if (!isFiniteNonNegativeNumber(value.semantics_amount) || !((value.semantics_amount as number) > 0)) {
    return { ok: false, code: 'invalid_portion_selection' };
  }
  if (!isFiniteNonNegativeNumber(value.semantics_gram_weight) || !((value.semantics_gram_weight as number) > 0)) {
    return { ok: false, code: 'invalid_portion_selection' };
  }
  return {
    ok: true,
    selection: {
      calculation_version: CALCULATION_VERSION,
      portion_semantics_version: PORTION_SEMANTICS_VERSION,
      line_ref: value.line_ref,
      ingredient_identity_digest: value.ingredient_identity_digest,
      bundle_release: value.bundle_release,
      fdc_id: value.fdc_id,
      record_digest: value.record_digest,
      candidates_digest: value.candidates_digest,
      portion_index: value.portion_index as number,
      portion_amount: value.portion_amount,
      measure: value.measure,
      gram_weight: value.gram_weight,
      ...(value.modifier !== undefined ? { modifier: value.modifier as string } : {}),
      semantics_kind: kind,
      semantics_unit: (value.semantics_unit ?? null) as string | null,
      semantics_volume_ml: (value.semantics_volume_ml ?? null) as number | null,
      semantics_amount: value.semantics_amount,
      semantics_gram_weight: value.semantics_gram_weight,
    },
  };
}

function sanitizeUserMassSelection(
  raw: unknown
): { ok: true; selection: UserMassSelection } | { ok: false; code: Phase3FailureCode } {
  const materialized = materialize(raw);
  if (!materialized.ok) {
    return {
      ok: false,
      code: (materialized as { ok: false; unsafe: boolean }).unsafe ? 'unsafe_request' : 'invalid_user_mass',
    };
  }
  if (!isPlainObject(materialized.value)) return { ok: false, code: 'invalid_user_mass' };
  const value = materialized.value;
  for (const key of Object.keys(value)) {
    if (!USER_MASS_SELECTION_KEYS.has(key)) return { ok: false, code: 'unknown_field' };
  }
  if (value.calculation_version !== CALCULATION_VERSION) return { ok: false, code: 'invalid_user_mass' };
  if (typeof value.line_ref !== 'string' || value.line_ref.length === 0) {
    return { ok: false, code: 'invalid_user_mass' };
  }
  if (typeof value.ingredient_identity_digest !== 'string') return { ok: false, code: 'invalid_user_mass' };
  if (typeof value.bundle_release !== 'string') return { ok: false, code: 'invalid_user_mass' };
  if (!isSafePositiveInt(value.fdc_id)) return { ok: false, code: 'invalid_user_mass' };
  if (typeof value.record_digest !== 'string') return { ok: false, code: 'invalid_user_mass' };
  if (
    typeof value.quantity !== 'number' ||
    !Number.isFinite(value.quantity) ||
    value.quantity <= 0 ||
    Object.is(value.quantity, -0)
  ) {
    return { ok: false, code: 'invalid_user_mass' };
  }
  if (value.unit !== 'g' && value.unit !== 'oz' && value.unit !== 'lb') {
    return { ok: false, code: 'invalid_user_mass' };
  }
  if (
    typeof value.grams !== 'number' ||
    !Number.isFinite(value.grams) ||
    value.grams <= 0 ||
    Object.is(value.grams, -0)
  ) {
    return { ok: false, code: 'invalid_user_mass' };
  }
  if (typeof value.selection_digest !== 'string') return { ok: false, code: 'invalid_user_mass' };
  return {
    ok: true,
    selection: {
      calculation_version: CALCULATION_VERSION,
      line_ref: value.line_ref,
      ingredient_identity_digest: value.ingredient_identity_digest,
      bundle_release: value.bundle_release,
      fdc_id: value.fdc_id,
      record_digest: value.record_digest,
      quantity: value.quantity,
      unit: value.unit,
      grams: value.grams,
      selection_digest: value.selection_digest,
    },
  };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MANUAL_SELECTION_KEYS = new Set([
  'kind',
  'fdc_id',
  'record_digest',
  'catalog_digest',
  'line_ref',
  'review_digest',
  'ai_assisted',
]);

interface ManualFoodSelection {
  readonly fdc_id: number;
  readonly record_digest: string;
  readonly catalog_digest: string;
  readonly line_ref: string;
  readonly review_digest: string;
  /**
   * True ONLY for an AI-assisted DETERMINISTIC acceptance (AI supplied an
   * advisory search phrase; the deterministic matcher independently accepted the
   * genuine pinned-USDA record). Such a selection is authoritative as an
   * AUTOMATIC match (`auto_confirmed`), NEVER as human-reviewed authority. An
   * explicit user choice (manual search / "Use this match") leaves this false and
   * yields `user_confirmed`.
   */
  readonly aiAssisted: boolean;
}

/**
 * Bounded, fail-closed sanitization of a USER-DIRECTED manual USDA food
 * selection (manual search) or an AI-assisted deterministic acceptance. Returns
 * undefined for anything that is not exactly a well-formed selection, so a
 * forged/partial object can never be interpreted as a choice. Authority still
 * requires the referenced record to exist in the authenticated pinned bundle
 * with a matching digest and the selection to bind the CURRENT review digest and
 * catalog digest; those checks happen at the call site where the record store is
 * available.
 */
function sanitizeManualSelection(raw: unknown): ManualFoodSelection | undefined {
  if (!isPlainObject(raw)) return undefined;
  for (const key of Object.keys(raw)) {
    if (!MANUAL_SELECTION_KEYS.has(key)) return undefined;
  }
  const value = raw;
  if (value.kind !== 'manual') return undefined;
  if (!isSafePositiveInt(value.fdc_id)) return undefined;
  if (typeof value.record_digest !== 'string' || !SHA256_HEX.test(value.record_digest)) return undefined;
  if (typeof value.catalog_digest !== 'string' || !SHA256_HEX.test(value.catalog_digest)) return undefined;
  if (typeof value.line_ref !== 'string' || value.line_ref.length === 0) return undefined;
  if (typeof value.review_digest !== 'string' || !SHA256_HEX.test(value.review_digest)) return undefined;
  if (value.ai_assisted !== undefined && typeof value.ai_assisted !== 'boolean') return undefined;
  return {
    fdc_id: value.fdc_id,
    record_digest: value.record_digest,
    catalog_digest: value.catalog_digest,
    line_ref: value.line_ref,
    review_digest: value.review_digest,
    aiAssisted: value.ai_assisted === true,
  };
}

function evaluateIngredient(
  inputs: AdvisoryCalculationInputs,
  prepared: PreparedIngredient,
  scope: ReadonlyArray<NutrientId>
): { ok: true; value: EvaluatedIngredient } | { ok: false; code: Phase3FailureCode } {
  const parsedResult = parseIngredient(prepared.ingredient);
  if (!parsedResult.ok) return { ok: false, code: 'invalid_ingredient_input' };
  const parsed = parsedResult.parsed;
  // Reject a present negative / -0 / non-finite quantity (fail closed, whole request).
  if (
    parsed.amount !== null &&
    (!Number.isFinite(parsed.amount) || parsed.amount < 0 || Object.is(parsed.amount, -0))
  ) {
    return { ok: false, code: 'invalid_ingredient_input' };
  }
  const hasMeasurableQuantity = typeof parsed.amount === 'number' && Number.isFinite(parsed.amount);
  const qualitative =
    !hasMeasurableQuantity && isQualitativeIngredientText(`${parsed.query} ${parsed.original_text}`);
  const normalizedQuery = normalizeQuery(parsed.query).text;

  const currentReview = reviewIngredient(inputs.catalog, prepared.ingredient);
  if (currentReview.outcome === 'invalid') return { ok: false, code: 'invalid_ingredient_input' };

  let matchStatus: MatchStatus = 'none';
  let matched = false;
  let ambiguous = false;
  let fdcId: number | undefined;
  let recordDigest: string | undefined;
  let confirmationDigest: string | undefined;
  let manualRecordId: number | undefined;
  let manualRecordDigest: string | undefined;

  // USER-DIRECTED MANUAL SELECTION (manual USDA search) is explicit
  // user-confirmed authority available for ANY review outcome, but it is still
  // authenticated: the referenced FDC id must exist in the pinned bundle with a
  // matching record digest, the catalog digest must match the active bundle, the
  // line ref must match, and the selection must bind the CURRENT review digest.
  // A forged/stale/wrong-bundle selection fails closed (falls through to the
  // ordinary outcome) and is NEVER granted authority.
  const manual = sanitizeManualSelection(prepared.selection);
  let manualApplied = false;
  if (manual) {
    const manualRecord = inputs.records.get(manual.fdc_id);
    if (
      manual.line_ref === prepared.lineRef &&
      manual.review_digest === currentReview.review_digest &&
      manual.catalog_digest === inputs.catalogDigest &&
      manualRecord !== undefined &&
      manualRecord.record_digest === manual.record_digest &&
      manualRecord.bundle_release === inputs.bundleRelease
    ) {
      matched = true;
      ambiguous = false;
      // PROVENANCE: an AI-assisted deterministic acceptance is an AUTOMATIC
      // match (`auto_confirmed`), never human-reviewed authority. Only an
      // explicit user selection yields `user_confirmed`.
      matchStatus = manual.aiAssisted ? 'auto_confirmed' : 'user_confirmed';
      fdcId = manual.fdc_id;
      recordDigest = manualRecord.record_digest;
      confirmationDigest = currentReview.review_digest;
      manualRecordId = manual.fdc_id;
      manualRecordDigest = manual.record_digest;
      manualApplied = true;
    }
  }

  if (!manualApplied && currentReview.outcome === 'matched_exact') {
    matched = true;
    matchStatus = 'unique_exact';
    fdcId = currentReview.selected_fdc_id;
  } else if (!manualApplied && currentReview.outcome === 'review_required') {
    ambiguous = true;
    if (prepared.review !== undefined && prepared.selection !== undefined) {
      const suppliedDigest = isPlainObject(prepared.review) ? prepared.review.review_digest : undefined;
      if (typeof suppliedDigest === 'string' && suppliedDigest === currentReview.review_digest) {
        const confirmation: ConfirmationResult = confirmIngredientReview(
          inputs.catalog,
          currentReview,
          prepared.selection
        );
        if (confirmation.outcome === 'confirmed') {
          // An automatic-selection claim is honored ONLY when the deterministic
          // confidence contract independently confirms that this exact candidate
          // is the automatic choice. A forged/invalid automatic claim FAILS
          // CLOSED — it is never reinterpreted as a literal user confirmation.
          if (prepared.automaticSelection === true) {
            if (!isDeterministicAutomaticSelection(currentReview, confirmation.fdc_id)) {
              return { ok: false, code: 'invalid_ingredient_input' };
            }
            matched = true;
            ambiguous = false;
            matchStatus = 'auto_confirmed';
            fdcId = confirmation.fdc_id;
            confirmationDigest = currentReview.review_digest;
          } else {
            matched = true;
            ambiguous = false;
            matchStatus = 'user_confirmed';
            fdcId = confirmation.fdc_id;
            confirmationDigest = currentReview.review_digest;
          }
        } else if (confirmation.outcome === 'invalid') {
          const code = confirmation.failure.code;
          if (code === 'unsafe_selection' || code === 'unknown_field' || code === 'validation_error') {
            return { ok: false, code: 'invalid_ingredient_input' };
          }
        }
      }
    }
  }

  // Resolve the current canonical record for a matched identity.
  let record: CanonicalUsdaFoodRecord | undefined;
  if (matched && fdcId !== undefined) {
    record = inputs.records.get(fdcId);
    if (manualRecordId !== undefined && manualRecordId === fdcId) {
      if (!record || record.record_digest !== manualRecordDigest) {
        return { ok: false, code: 'invalid_ingredient_input' };
      }
    } else {
      const candidate = currentReview.candidates.find((entry) => entry.fdc_id === fdcId);
      if (!candidate || !record || record.record_digest !== candidate.record_digest) {
        return { ok: false, code: 'invalid_ingredient_input' };
      }
    }
    recordDigest = record.record_digest;
  }

  // Identity digest (binds identity WITHOUT any portion selection).
  const base: EvaluatedIngredient = {
    lineRef: prepared.lineRef,
    originalText: parsed.original_text,
    amount: parsed.amount,
    rawUnit: parsed.raw_unit,
    normalizedUnit: parsed.normalized_unit,
    measurementKind: parsed.measurement_kind,
    query: parsed.query,
    normalizedQuery,
    note: parsed.note,
    qualitative,
    matchStatus,
    matched,
    ambiguous,
    fdcId,
    recordDigest,
    confirmationDigest,
    grams: undefined,
    massSource: undefined,
    portionIndex: undefined,
    portionCandidatesDigest: undefined,
    countIngredientAmount: undefined,
    countPortionAmount: undefined,
    countGramWeight: undefined,
    countUnit: undefined,
    countSize: undefined,
    countDeterministic: undefined,
    userMassQuantity: undefined,
    userMassUnit: undefined,
    contributions: {},
    contributingNutrients: [],
    outcome: 'no_match',
  };
  const identityDigest = digestOf(identityPayload(base));

  // Mass resolution.
  let grams: number | undefined;
  let massSource: MassSource | undefined;
  let portionIndex: number | undefined;
  let portionCandidatesDigest: string | undefined;
  let countIngredientAmount: number | undefined;
  let countPortionAmount: number | undefined;
  let countGramWeight: number | undefined;
  let countUnit: string | undefined;
  let countSize: string | undefined;
  let countDeterministic: boolean | undefined;
  let userMassQuantity: number | undefined;
  let userMassUnit: string | undefined;

  if (!qualitative && matched && record) {
    const hasPortion = prepared.portionSelection !== undefined;
    const hasCountPortion = prepared.countPortionSelection !== undefined;
    const hasUserMass = prepared.userMassSelection !== undefined;
    // Every mass source is mutually exclusive with every other.
    const massSourceCount = [hasPortion, hasCountPortion, hasUserMass].filter(Boolean).length;
    if (massSourceCount > 1) {
      return { ok: false, code: 'invalid_portion_selection' };
    }
    if (parsed.measurement_kind === 'mass' && parsed.grams !== undefined) {
      if (!isWithinCanonicalBound(parsed.grams)) return { ok: false, code: 'numeric_overflow' };
      grams = parsed.grams;
      massSource = 'direct_mass';
    } else if (hasUserMass) {
      const userResult = sanitizeUserMassSelection(prepared.userMassSelection);
      if (!userResult.ok) return { ok: false, code: (userResult as { ok: false; code: Phase3FailureCode }).code };
      const resolution: UserMassResolution = resolveUserMassGrams(
        userResult.selection,
        record,
        inputs.bundleRelease,
        prepared.lineRef,
        identityDigest
      );
      if (resolution.ok) {
        grams = resolution.grams;
        massSource = 'user_mass';
        userMassQuantity = userResult.selection.quantity;
        userMassUnit = userResult.selection.unit;
      } else if ((resolution as { ok: false; reason: string }).reason === 'overflow') {
        return { ok: false, code: 'numeric_overflow' };
      } else if ((resolution as { ok: false; reason: string }).reason === 'invalid') {
        return { ok: false, code: 'invalid_user_mass' };
      }
    } else if (hasPortion) {
      const selectionResult = sanitizePortionSelection(prepared.portionSelection);
      if (!selectionResult.ok) {
        return { ok: false, code: (selectionResult as { ok: false; code: Phase3FailureCode }).code };
      }
      const measurement: PortionMeasurement = {
        kind: parsed.measurement_kind,
        grams: parsed.grams,
        milliliters: parsed.milliliters,
      };
      const resolution: PortionMassResolution = resolvePortionMassGrams(
        record,
        selectionResult.selection,
        measurement,
        inputs.bundleRelease,
        prepared.lineRef,
        identityDigest
      );
      if (resolution.ok) {
        grams = resolution.grams;
        massSource = 'source_portion';
        portionIndex = selectionResult.selection.portion_index;
        portionCandidatesDigest = selectionResult.selection.candidates_digest;
      } else if ((resolution as { ok: false; reason: string }).reason === 'overflow') {
        return { ok: false, code: 'numeric_overflow' };
      }
    } else {
      // Phase 4.5E authenticated count-portion resolution. A deterministic unique
      // compatible portion resolves without a user choice; an ambiguous set
      // requires an explicit, independently re-verified selection.
      const projection = projectQueryText(normalizedQuery);
      const requirement = deriveCountRequirement(
        parsed.amount,
        parsed.raw_unit,
        projection.food_tokens,
        projection.size_qualifiers
      );
      if (requirement) {
        let resolution: CountPortionMassResolution | undefined;
        if (hasCountPortion) {
          const sanitized = sanitizeCountPortionSelection(prepared.countPortionSelection);
          if (!sanitized.ok) {
            return {
              ok: false,
              code: (sanitized as { ok: false; unsafe: boolean }).unsafe
                ? 'unsafe_request'
                : 'invalid_portion_selection',
            };
          }
          resolution = resolveCountPortionMassGrams(
            record,
            sanitized.selection,
            requirement,
            inputs.bundleRelease,
            inputs.catalogDigest,
            prepared.lineRef,
            identityDigest,
            CALCULATION_VERSION,
            MAX_CALCULATION_GRAMS
          );
        } else {
          resolution = resolveDeterministicCountPortionGrams(
            record,
            requirement,
            MAX_CALCULATION_GRAMS
          );
        }
        if (resolution.ok) {
          grams = resolution.grams;
          massSource = 'count_portion';
          portionIndex = resolution.candidate.index;
          countIngredientAmount = requirement.amount;
          countPortionAmount = resolution.candidate.amount;
          countGramWeight = resolution.candidate.gram_weight;
          countUnit = resolution.candidate.unit ?? undefined;
          countSize = resolution.candidate.size ?? undefined;
          countDeterministic = resolution.deterministic;
        } else if ((resolution as { ok: false; reason: string }).reason === 'overflow') {
          return { ok: false, code: 'numeric_overflow' };
        }
      }
    }
  }

  // Contributions.
  const contributions: Partial<Record<NutrientId, number>> = {};
  const contributingNutrients: NutrientId[] = [];
  if (grams !== undefined && record) {
    for (const nutrient of scope) {
      const nutrientRecord = record.nutrients[nutrient];
      if (!nutrientRecord) continue;
      const value = contributionFor(nutrientRecord.amount_per_100g, grams);
      if (value === undefined) return { ok: false, code: 'numeric_overflow' };
      contributions[nutrient] = value;
      contributingNutrients.push(nutrient);
    }
  }

  let outcome: IngredientOutcome;
  if (qualitative) outcome = 'qualitative';
  else if (!matched && !ambiguous) outcome = 'no_match';
  else if (ambiguous) outcome = 'ambiguous';
  else if (grams === undefined) outcome = 'no_mass';
  else if (contributingNutrients.length === 0) outcome = 'no_nutrition';
  else outcome = 'calculated';

  const evaluated: EvaluatedIngredient = {
    ...base,
    grams,
    massSource,
    portionIndex,
    portionCandidatesDigest,
    countIngredientAmount,
    countPortionAmount,
    countGramWeight,
    countUnit,
    countSize,
    countDeterministic,
    userMassQuantity,
    userMassUnit,
    contributions,
    contributingNutrients,
    outcome,
  };
  return { ok: true, value: evaluated };
}

/** Runs the advisory calculation. Never throws; always returns a closed result. */
export function runAdvisoryCalculation(inputs: AdvisoryCalculationInputs): CalculationResult {
  try {
    const requestResult = materialize(inputs.request);
    if (!requestResult.ok) {
      return fail((requestResult as { ok: false; unsafe: boolean }).unsafe ? 'unsafe_request' : 'invalid_request');
    }
    if (!isPlainObject(requestResult.value)) return fail('invalid_request');
    const request = requestResult.value;

    for (const key of Object.keys(request)) {
      if (!REQUEST_KEYS.has(key)) return fail('unknown_field');
    }
    if (!isValidStrictServingCount(request.servings)) return fail('invalid_servings');
    const servings = request.servings as number;

    const scopeResult = validateNutrientScope(request.nutrient_scope);
    if (!scopeResult.ok) return fail((scopeResult as { ok: false; code: Phase3FailureCode }).code);
    const scope = scopeResult.ids;

    if (!Array.isArray(request.ingredients)) return fail('invalid_request');
    if (request.ingredients.length === 0) return fail('empty_ingredients');
    if (request.ingredients.length > MAX_CALCULATION_INGREDIENTS) return fail('too_many_ingredients');

    const seenRefs = new Set<string>();
    const prepared: PreparedIngredient[] = [];
    for (const raw of request.ingredients) {
      if (!isPlainObject(raw)) return fail('invalid_request');
      for (const key of Object.keys(raw)) {
        if (!INGREDIENT_INPUT_KEYS.has(key)) return fail('unknown_field');
      }
      const lineRef = raw.line_ref;
      if (
        typeof lineRef !== 'string' ||
        lineRef.trim().length === 0 ||
        lineRef.length > MAX_CALCULATION_LINE_REF_LENGTH
      ) {
        return fail('invalid_line_ref');
      }
      if (seenRefs.has(lineRef)) return fail('duplicate_line_ref');
      seenRefs.add(lineRef);
      prepared.push({
        lineRef,
        ingredient: raw.ingredient,
        review: raw.review,
        selection: raw.selection,
        automaticSelection: raw.automatic_selection,
        portionSelection: raw.portion_selection,
        countPortionSelection: raw.count_portion_selection,
        userMassSelection: raw.user_mass_selection,
      });
    }

    const evidence: EvaluatedIngredient[] = [];
    for (const entry of prepared) {
      const evaluated = evaluateIngredient(inputs, entry, scope);
      if (!evaluated.ok) return fail((evaluated as { ok: false; code: Phase3FailureCode }).code);
      evidence.push(evaluated.value);
    }

    const measurable = evidence.filter((entry) => !entry.qualitative).length;
    const ordered = [...evidence].sort((a, b) => (a.lineRef < b.lineRef ? -1 : a.lineRef > b.lineRef ? 1 : 0));

    const totals: Partial<Record<NutrientId, NutrientTotalResult>> = {};
    if (measurable > 0) {
      for (const nutrient of scope) {
        const values: number[] = [];
        let covered = 0;
        for (const entry of ordered) {
          if (entry.qualitative) continue;
          const value = entry.contributions[nutrient];
          if (value === undefined) continue;
          covered += 1;
          values.push(value);
        }
        if (covered === 0) continue;
        const total = stableSum(values);
        if (total === undefined) return fail('numeric_overflow');
        const rounded = roundCanonicalTotal(total);
        if (!Number.isFinite(rounded) || rounded < 0 || Object.is(rounded, -0)) {
          return fail('numeric_overflow');
        }
        if (rounded > MAX_NUTRIENT_AMOUNT || !isValidNutrientAmount(rounded)) {
          return fail('numeric_overflow');
        }
        totals[nutrient] = Object.freeze({
          amount: rounded,
          unit: NUTRIENT_REGISTRY[nutrient].unit as CanonicalUnit,
          coverage: covered / measurable,
          covered_ingredient_count: covered,
          measurable_ingredient_count: measurable,
          status: covered === measurable ? 'complete' : 'partial',
        });
      }
    }

    // SINGLE COMPLETENESS AUTHORITY. Completion is about INGREDIENT-LINE
    // resolution, not nutrient-list breadth: once every measurable ingredient
    // line has an authenticated mass, the whole-recipe result is COMPLETE even
    // when a USDA record does not enumerate every nutrient in scope (individual
    // nutrients still report their own `coverage`). A line that could not be
    // resolved keeps the result PARTIAL. This is the invariant shared by the
    // live preview, Phase 5 Apply, and the persisted block.
    const unresolved: UnresolvedIngredient[] = evidence
      .filter((entry) => entry.outcome !== 'calculated' && entry.outcome !== 'qualitative')
      .map((entry) => Object.freeze({ line_ref: entry.lineRef, outcome: entry.outcome }));

    const totalKeys = Object.keys(totals) as NutrientId[];
    let status: CalculationStatus;
    if (measurable === 0 || totalKeys.length === 0) status = 'unresolved';
    else if (unresolved.length === 0) status = 'complete';
    else status = 'partial';

    const ingredientEvidence: IngredientCalculationEvidence[] = evidence.map((entry) =>
      Object.freeze({
        line_ref: entry.lineRef,
        original_text: entry.originalText,
        outcome: entry.outcome,
        qualitative: entry.qualitative,
        match_status: entry.matchStatus,
        user_confirmed: entry.matchStatus === 'user_confirmed',
        ...(entry.fdcId !== undefined ? { fdc_id: entry.fdcId } : {}),
        ...(entry.recordDigest !== undefined ? { record_digest: entry.recordDigest } : {}),
        ...(entry.massSource !== undefined ? { mass_source: entry.massSource } : {}),
        ...(entry.grams !== undefined ? { resolved_grams: entry.grams } : {}),
        ...(entry.portionIndex !== undefined ? { portion_index: entry.portionIndex } : {}),
        ...(entry.countPortionAmount !== undefined
          ? {
              count_ingredient_amount: entry.countIngredientAmount,
              count_portion_amount: entry.countPortionAmount,
              count_gram_weight: entry.countGramWeight,
              ...(entry.countUnit !== undefined ? { count_unit: entry.countUnit } : {}),
              ...(entry.countSize !== undefined ? { count_size: entry.countSize } : {}),
              count_deterministic: entry.countDeterministic === true,
            }
          : {}),
        ...(entry.userMassQuantity !== undefined ? { user_mass_quantity: entry.userMassQuantity } : {}),
        ...(entry.userMassUnit !== undefined ? { user_mass_unit: entry.userMassUnit } : {}),
        ingredient_identity_digest: digestOf(identityPayload(entry)),
        ingredient_digest: digestOf(fullPayload(entry)),
        contributing_nutrients: Object.freeze([...entry.contributingNutrients]),
      })
    );

    const preview: AdvisoryNutritionPreview = Object.freeze({
      calculation_schema: CALCULATION_SCHEMA,
      calculation_version: CALCULATION_VERSION,
      bundle_release: inputs.bundleRelease,
      catalog_digest: inputs.catalogDigest,
      nutrient_map_version: inputs.nutrientMapVersion,
      servings,
      ingredient_digest: digestOf(evidence.map(fullPayload)),
      nutrient_scope: Object.freeze([...scope]),
      basis: 'total',
      status,
      totals: Object.freeze(totals),
      ingredients: Object.freeze(ingredientEvidence),
      unresolved: Object.freeze(unresolved),
      advisory_only: true,
      application_authorized: false,
    });

    return { ok: true, preview };
  } catch {
    return fail('validation_error');
  }
}
