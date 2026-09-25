/**
 * The Kitchen Codex — Advanced Nutrition v1: evidence validation, codec, and
 * advisory eligibility.
 *
 * PURE, platform-neutral. This module NEVER authorizes an application. The
 * production Apply authorization remains the existing centralized
 * `canApplyNutritionEstimate` hard-disable (see `src/core/nutritionSanity.ts`);
 * `advancedNutritionApplicationAuthorization` below exists only to make that
 * disabled state explicit and testable.
 *
 * UNTRUSTED-VALUE POLICY
 * ----------------------
 * Every public entry point materializes the raw value into a NEW inert plain
 * structure using a single descriptor-based pass (`toInertValue`). Getters/
 * setters are rejected WITHOUT being invoked; symbol keys, non-enumerable own
 * properties, non-plain prototypes, functions, bigints, undefined, cycles,
 * dangerous keys, sparse arrays, and reflective/proxy failures all fail closed.
 * After materialization nothing revisits the original object. Public boundaries
 * are wrapped so unexpected reflective failures return a fixed bounded error
 * code and never propagate or echo the attacker's message.
 *
 * DIAGNOSTICS
 * -----------
 * All returned diagnostics are bounded in count, per-error length, and total
 * length, and are input-redacted: unknown field names/values and exception
 * messages are never echoed. Only closed, known field names may be identified.
 */

import { NUTRIENT_REGISTRY, isNutrientId, NUTRIENT_IDS, type NutrientId } from './nutrients';
import { DV_STANDARD_ID } from './dailyValues';
import { isCanonicalUnit, isValidNutrientAmount, isNegativeZero, type CanonicalUnit } from './units';
import {
  CODEX_NUTRITION_SCHEMA_V1,
  CODEX_NUTRITION_SCHEMA_V2,
  CODEX_NUTRITION_BASIS_TOTAL,
  NUTRITION_SOURCE_IDS,
  DATASET_BACKED_SOURCE_IDS,
  USER_MANUAL_RELEASE_ID,
  MAX_SERVINGS,
  MAX_SOURCES,
  MAX_NUTRIENT_SCOPE,
  MAX_INGREDIENT_EVIDENCE,
  MAX_UNRESOLVED,
  MAX_LINE_REF_LENGTH,
  MAX_DIGEST_LENGTH,
  MAX_SOURCE_ID_LENGTH,
  MAX_SOURCE_RELEASE_LENGTH,
  MAX_SERVING_SIZE_LENGTH,
  MAX_TIMESTAMP_LENGTH,
  MAX_MANUAL_NOTE_LENGTH,
  MAX_SERIALIZED_BYTES,
  MAX_VALIDATION_ERRORS,
  MAX_VALIDATION_ERROR_LENGTH,
  MAX_VALIDATION_DIAGNOSTIC_BYTES,
  containsReservedUsdaIdentity,
  isPlainObject,
  cloneSafeValue,
  serializedBlockBytes,
  toInertValue,
  type CodexNutritionV1,
  type CodexNutritionV2,
  type NutrientResult,
  type IngredientEvidence,
  type IngredientEvidenceV2,
  type UnresolvedIngredientRef,
  type ManualOverrideMetadata,
  type NutritionSourceId,
  type NutritionBlockStatus,
  type AdvancedNutritionBlock,
  type OpaqueCodexNutrition,
} from './schema';

/** Stable `sha256:<64 hex>` ingredient digest format. */
export const INGREDIENT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Mirrors `AUTOMATED_APPLICATION_DISABLED_REASON` from `src/core/nutritionSanity.ts`.
 * A test asserts equality so the two can never drift. Machine application of
 * advanced nutrition stays disabled in Phase 0.
 */
export const ADVANCED_NUTRITION_APPLICATION_DISABLED_REASON =
  'automated_application_disabled_pending_provenance_persistence';

/** Fixed, bounded, non-leaking messages for codec/serialization failures. */
export const ENCODE_UNSAFE_MESSAGE = 'advanced_nutrition_unsafe';
export const ENCODE_INVALID_MESSAGE = 'advanced_nutrition_invalid';
export const ENCODE_OVERSIZED_MESSAGE = 'advanced_nutrition_oversized';
export const MARKDOWN_UNSAFE_MESSAGE = 'advanced_nutrition_unsafe_frontmatter';

const STATUS_VALUES: ReadonlyArray<NutritionBlockStatus> = ['complete', 'partial', 'stale', 'unresolved'];
const MATCH_STATUS_VALUES: ReadonlyArray<IngredientEvidence['match_status']> = [
  'confirmed',
  'suggested',
  'ambiguous',
];
const UNRESOLVED_REASONS: ReadonlyArray<UnresolvedIngredientRef['reason']> = [
  'no_match',
  'ambiguous',
  'no_mass',
  'no_nutrition',
  'qualitative',
];
/** v1 is closed to direct mass and authenticated USDA source portions. */
const CONVERSION_BASES_V1: ReadonlyArray<NonNullable<IngredientEvidence['conversion_basis']>> = [
  'direct_mass',
  'source_portion',
];
/** v2 retains every v1 basis and adds the closed household basis. */
const CONVERSION_BASES_V2: ReadonlyArray<NonNullable<IngredientEvidenceV2['conversion_basis']>> = [
  'direct_mass',
  'source_portion',
  'household_portion',
];

const V1_KEYS = new Set([
  'schema',
  'basis',
  'servings',
  'serving_size',
  'status',
  'computed_at',
  'ingredient_digest',
  'dv_standard',
  'sources',
  'source_releases',
  'nutrient_scope',
  'nutrients',
  'ingredients',
  'unresolved',
  'manual_override',
  'extensions',
]);

/** v2 uses the same closed top-level key set as v1. */
const V2_KEYS = V1_KEYS;

const NUTRIENT_RESULT_KEYS = new Set([
  'amount',
  'unit',
  'status',
  'coverage',
  'covered_ingredient_count',
  'measurable_ingredient_count',
]);
/** v1 evidence keys: NO household key exists in the v1 contract. */
const EVIDENCE_KEYS_V1 = new Set([
  'line_ref',
  'line_digest',
  'source',
  'source_food_id',
  'source_release',
  'match_status',
  'resolved',
  'user_confirmed',
  'amount',
  'conversion_basis',
]);
/** v2 evidence keys: the v1 set plus the closed household evidence object. */
const EVIDENCE_KEYS_V2 = new Set([...EVIDENCE_KEYS_V1, 'household_portion']);
const HOUSEHOLD_PORTION_EVIDENCE_KEYS = new Set([
  'registry_release',
  'record_key',
  'record_digest',
  'household_unit',
  'size_class',
  'requires_state',
  'quantity',
  'selection_digest',
]);
/** Bounded household evidence text fields (registry release / key / unit / size / state). */
const MAX_HOUSEHOLD_EVIDENCE_TEXT_LENGTH = 120;
const EVIDENCE_AMOUNT_KEYS = new Set(['value', 'unit']);
const UNRESOLVED_KEYS = new Set(['line_ref', 'reason', 'source_food_id', 'source_release']);
const MANUAL_OVERRIDE_KEYS = new Set(['overridden_at', 'note']);

/**
 * Bounded, input-redacted diagnostic collector. Stores at most
 * `MAX_VALIDATION_ERRORS` fixed/bounded codes, each at most
 * `MAX_VALIDATION_ERROR_LENGTH`, totaling at most `MAX_VALIDATION_DIAGNOSTIC_BYTES`.
 */
class Diagnostics {
  private readonly items: string[] = [];
  private bytes = 0;
  private count = 0;

  add(code: string): void {
    this.count += 1;
    if (this.items.length >= MAX_VALIDATION_ERRORS) return;
    const bounded = code.length > MAX_VALIDATION_ERROR_LENGTH ? code.slice(0, MAX_VALIDATION_ERROR_LENGTH) : code;
    if (this.bytes + bounded.length > MAX_VALIDATION_DIAGNOSTIC_BYTES) return;
    this.items.push(bounded);
    this.bytes += bounded.length;
  }

  get hasErrors(): boolean {
    return this.count > 0;
  }

  list(): string[] {
    return this.items.slice();
  }
}

export interface AdvancedNutritionValidation<T = CodexNutritionV1 | CodexNutritionV2> {
  ok: boolean;
  errors: string[];
  /** Present only when `ok`. */
  value?: T;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && !isNegativeZero(value);
}

function isValidTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TIMESTAMP_LENGTH &&
    Number.isFinite(Date.parse(value))
  );
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Validates one nutrient coverage record. Counts are validated UNCONDITIONALLY
 * before any ratio comparison; coverage must exactly equal `covered / measurable`
 * (IEEE-754 double division, no epsilon). `complete` additionally requires
 * `covered === measurable` and `coverage === 1`.
 */
function validateNutrientResult(id: NutrientId, raw: unknown, diag: Diagnostics): NutrientResult | undefined {
  if (!isPlainObject(raw)) {
    diag.add(`nutrient_invalid:${id}`);
    return undefined;
  }
  let invalid = false;
  for (const key of Object.keys(raw)) {
    if (!NUTRIENT_RESULT_KEYS.has(key)) {
      diag.add(`nutrient_unknown_field:${id}`);
      invalid = true;
    }
  }

  const def = NUTRIENT_REGISTRY[id];
  const unit = raw.unit;
  if (!isCanonicalUnit(unit) || unit !== def.unit) {
    diag.add(`nutrient_unit_mismatch:${id}`);
    invalid = true;
  }
  if (!isValidNutrientAmount(raw.amount)) {
    diag.add(`nutrient_invalid_amount:${id}`);
    invalid = true;
  }

  const measurable = raw.measurable_ingredient_count;
  const covered = raw.covered_ingredient_count;
  const measurableValid =
    Number.isSafeInteger(measurable) && !isNegativeZero(measurable) && (measurable as number) >= 1;
  const coveredValid = Number.isSafeInteger(covered) && !isNegativeZero(covered) && (covered as number) >= 0;
  if (!measurableValid) {
    diag.add(`nutrient_invalid_measurable:${id}`);
    invalid = true;
  }
  if (!coveredValid) {
    diag.add(`nutrient_invalid_covered:${id}`);
    invalid = true;
  }
  let countsOrdered = false;
  if (coveredValid && measurableValid) {
    if ((covered as number) > (measurable as number)) {
      diag.add(`nutrient_covered_exceeds_measurable:${id}`);
      invalid = true;
    } else {
      countsOrdered = true;
    }
  }

  const coverage = raw.coverage;
  const coverageValid =
    typeof coverage === 'number' &&
    Number.isFinite(coverage) &&
    !isNegativeZero(coverage) &&
    coverage >= 0 &&
    coverage <= 1;
  if (!coverageValid) {
    diag.add(`nutrient_invalid_coverage:${id}`);
    invalid = true;
  }

  const status = raw.status;
  if (status !== 'complete' && status !== 'partial') {
    diag.add(`nutrient_invalid_status:${id}`);
    invalid = true;
  }

  if (countsOrdered && coverageValid) {
    const expected = (covered as number) / (measurable as number);
    if (coverage !== expected) {
      diag.add(`nutrient_coverage_mismatch:${id}`);
      invalid = true;
    }
    if (status === 'complete') {
      if ((covered as number) !== (measurable as number)) {
        diag.add(`nutrient_complete_with_partial_coverage:${id}`);
        invalid = true;
      }
      if (coverage !== 1) {
        diag.add(`nutrient_complete_coverage_not_one:${id}`);
        invalid = true;
      }
    }
    if (status === 'partial' && (covered as number) === (measurable as number)) {
      diag.add(`nutrient_partial_with_full_coverage:${id}`);
      invalid = true;
    }
  }

  if (invalid) return undefined;
  return {
    amount: raw.amount as number,
    unit: unit as CanonicalUnit,
    status: status as 'complete' | 'partial',
    coverage: coverage as number,
    covered_ingredient_count: covered as number,
    measurable_ingredient_count: measurable as number,
  };
}

/**
 * Strictly validates an already-materialized, inert block under the VERSION-
 * SPECIFIC contract selected by the schema discriminator. Unknown or
 * unrepresentable own properties are REJECTED (never sanitized away). Returns a
 * normalized whitelisted clone on success.
 *
 * v1 is restored to its committed meaning: the closed conversion bases are
 * direct mass and an authenticated USDA source portion, and no household key
 * exists. v2 retains every v1 meaning and adds the closed household basis plus
 * the closed household evidence object, coupled bidirectionally.
 */
function validateInertCodexNutrition(
  raw: Record<string, unknown>,
  version: 1 | 2
): AdvancedNutritionValidation {
  const isV2 = version === CODEX_NUTRITION_SCHEMA_V2;
  const topLevelKeys = isV2 ? V2_KEYS : V1_KEYS;
  const evidenceKeys = isV2 ? EVIDENCE_KEYS_V2 : EVIDENCE_KEYS_V1;
  const conversionBases = isV2 ? CONVERSION_BASES_V2 : CONVERSION_BASES_V1;
  const diag = new Diagnostics();

  for (const key of Object.keys(raw)) {
    if (!topLevelKeys.has(key)) diag.add('unknown_field');
  }
  if (raw.schema !== version) diag.add('invalid_schema');
  if (raw.basis !== CODEX_NUTRITION_BASIS_TOTAL) diag.add('invalid_basis');

  const servings = raw.servings;
  if (!isFinitePositive(servings) || (servings as number) > MAX_SERVINGS) diag.add('invalid_servings');

  let servingSize: string | undefined;
  if (hasOwn(raw, 'serving_size')) {
    if (
      typeof raw.serving_size !== 'string' ||
      raw.serving_size.trim().length === 0 ||
      raw.serving_size.length > MAX_SERVING_SIZE_LENGTH
    ) {
      diag.add('invalid_serving_size');
    } else {
      servingSize = raw.serving_size.trim();
    }
  }

  const status = raw.status;
  if (typeof status !== 'string' || !STATUS_VALUES.includes(status as NutritionBlockStatus)) {
    diag.add('invalid_status');
  }

  if (!isValidTimestamp(raw.computed_at)) diag.add('invalid_computed_at');

  if (typeof raw.ingredient_digest !== 'string' || !INGREDIENT_DIGEST_PATTERN.test(raw.ingredient_digest)) {
    diag.add('invalid_ingredient_digest');
  }

  if (raw.dv_standard !== DV_STANDARD_ID) diag.add('invalid_dv_standard');

  // Sources.
  const sources: NutritionSourceId[] = [];
  if (!Array.isArray(raw.sources) || raw.sources.length < 1 || raw.sources.length > MAX_SOURCES) {
    diag.add('invalid_sources');
  } else {
    const seen = new Set<string>();
    for (const source of raw.sources) {
      if (typeof source !== 'string' || !(NUTRITION_SOURCE_IDS as ReadonlyArray<string>).includes(source)) {
        diag.add('invalid_source');
      } else if (seen.has(source)) {
        diag.add('duplicate_source');
      } else {
        seen.add(source);
        sources.push(source as NutritionSourceId);
      }
    }
  }

  // Source releases: closed/bounded, only for declared sources, never for
  // user_manual, distinct across sources.
  const sourceReleases: Partial<Record<NutritionSourceId, string>> = {};
  if (!isPlainObject(raw.source_releases)) {
    diag.add('invalid_source_releases');
  } else {
    for (const [key, value] of Object.entries(raw.source_releases)) {
      if (!(NUTRITION_SOURCE_IDS as ReadonlyArray<string>).includes(key)) {
        diag.add('unknown_source_release');
        continue;
      }
      if (!sources.includes(key as NutritionSourceId)) {
        diag.add(`source_release_without_source:${key}`);
        continue;
      }
      if (key === 'user_manual') {
        diag.add('user_manual_release_not_allowed');
        continue;
      }
      if (
        typeof value !== 'string' ||
        value.trim().length === 0 ||
        value.length > MAX_SOURCE_RELEASE_LENGTH
      ) {
        diag.add(`invalid_source_release:${key}`);
        continue;
      }
      sourceReleases[key as NutritionSourceId] = value;
    }
  }

  for (const source of sources) {
    if (
      (DATASET_BACKED_SOURCE_IDS as ReadonlyArray<string>).includes(source) &&
      sourceReleases[source] === undefined
    ) {
      diag.add(`missing_source_release:${source}`);
    }
  }

  const releaseOwners = new Set<string>();
  for (const source of Object.keys(sourceReleases) as NutritionSourceId[]) {
    const release = sourceReleases[source] as string;
    if (releaseOwners.has(release)) {
      diag.add('duplicate_source_release');
    } else {
      releaseOwners.add(release);
    }
  }

  if (sourceReleases.curated_reference !== undefined && containsReservedUsdaIdentity(sourceReleases.curated_reference)) {
    diag.add('curated_reference_usda_identity');
  }

  // Nutrient scope: closed, unique, nonempty, bounded.
  const nutrientScope: NutrientId[] = [];
  if (
    !Array.isArray(raw.nutrient_scope) ||
    raw.nutrient_scope.length < 1 ||
    raw.nutrient_scope.length > MAX_NUTRIENT_SCOPE
  ) {
    diag.add('invalid_nutrient_scope');
  } else {
    const scopeSeen = new Set<string>();
    for (const id of raw.nutrient_scope) {
      if (!isNutrientId(id)) {
        diag.add('unknown_scope_nutrient');
      } else if (scopeSeen.has(id)) {
        diag.add(`duplicate_scope_nutrient:${id}`);
      } else {
        scopeSeen.add(id);
        nutrientScope.push(id);
      }
    }
  }

  // Nutrients.
  const nutrients: Partial<Record<NutrientId, NutrientResult>> = {};
  if (!isPlainObject(raw.nutrients)) {
    diag.add('invalid_nutrients');
  } else {
    for (const [key, value] of Object.entries(raw.nutrients)) {
      if (!isNutrientId(key)) {
        diag.add('unknown_nutrient');
        continue;
      }
      const result = validateNutrientResult(key, value, diag);
      if (result) nutrients[key] = result;
    }
  }
  for (const id of Object.keys(nutrients) as NutrientId[]) {
    if (!nutrientScope.includes(id)) diag.add(`nutrient_out_of_scope:${id}`);
  }

  // Ingredients evidence.
  const ingredients: IngredientEvidenceV2[] = [];
  const lineRefs = new Set<string>();
  if (!Array.isArray(raw.ingredients) || raw.ingredients.length > MAX_INGREDIENT_EVIDENCE) {
    diag.add('invalid_ingredients');
  } else {
    for (const entry of raw.ingredients) {
      if (!isPlainObject(entry)) {
        diag.add('invalid_ingredient_evidence');
        continue;
      }
      for (const key of Object.keys(entry)) {
        if (!evidenceKeys.has(key)) diag.add('ingredient_unknown_field');
      }
      const lineRef = entry.line_ref;
      if (typeof lineRef !== 'string' || lineRef.trim().length === 0 || lineRef.length > MAX_LINE_REF_LENGTH) {
        diag.add('invalid_line_ref');
      } else if (lineRefs.has(lineRef)) {
        diag.add('duplicate_line_ref');
      } else {
        lineRefs.add(lineRef);
      }
      if (hasOwn(entry, 'line_digest')) {
        if (typeof entry.line_digest !== 'string' || entry.line_digest.length > MAX_DIGEST_LENGTH) {
          diag.add('invalid_line_digest');
        }
      }
      const source = entry.source;
      let sourceDeclared = false;
      if (typeof source !== 'string' || !(NUTRITION_SOURCE_IDS as ReadonlyArray<string>).includes(source)) {
        diag.add('ingredient_source_not_declared');
      } else if (!sources.includes(source as NutritionSourceId)) {
        diag.add('ingredient_source_not_declared');
      } else {
        sourceDeclared = true;
      }
      if (
        typeof entry.source_food_id !== 'string' ||
        entry.source_food_id.trim().length === 0 ||
        entry.source_food_id.length > MAX_SOURCE_ID_LENGTH
      ) {
        diag.add('invalid_source_food_id');
      }
      if (
        typeof entry.source_release !== 'string' ||
        entry.source_release.trim().length === 0 ||
        entry.source_release.length > MAX_SOURCE_RELEASE_LENGTH
      ) {
        diag.add('invalid_ingredient_source_release');
      } else if (sourceDeclared && source === 'user_manual') {
        if (entry.source_release !== USER_MANUAL_RELEASE_ID) diag.add('user_manual_release_mismatch');
      } else if (sourceDeclared) {
        const declared = sourceReleases[source as NutritionSourceId];
        if (declared === undefined) {
          diag.add('ingredient_release_missing');
        } else if (declared !== entry.source_release) {
          diag.add('ingredient_release_mismatch');
        }
      }
      const matchStatus = entry.match_status;
      if (
        typeof matchStatus !== 'string' ||
        !MATCH_STATUS_VALUES.includes(matchStatus as IngredientEvidence['match_status'])
      ) {
        diag.add('invalid_match_status');
      }
      if (typeof entry.resolved !== 'boolean' || typeof entry.user_confirmed !== 'boolean') {
        diag.add('invalid_ingredient_flags');
      } else if (entry.resolved !== (matchStatus === 'confirmed' && entry.user_confirmed === true)) {
        diag.add('ingredient_resolution_inconsistent');
      }
      let amount: IngredientEvidence['amount'];
      if (hasOwn(entry, 'amount')) {
        if (!isPlainObject(entry.amount)) {
          diag.add('invalid_ingredient_amount');
        } else {
          for (const key of Object.keys(entry.amount)) {
            if (!EVIDENCE_AMOUNT_KEYS.has(key)) diag.add('unknown_evidence_amount_field');
          }
          if (!isValidNutrientAmount(entry.amount.value) || !isCanonicalUnit(entry.amount.unit)) {
            diag.add('invalid_ingredient_amount');
          } else {
            amount = { value: entry.amount.value as number, unit: entry.amount.unit as CanonicalUnit };
          }
        }
      }
      let conversionBasis: IngredientEvidenceV2['conversion_basis'];
      if (hasOwn(entry, 'conversion_basis')) {
        if (
          typeof entry.conversion_basis !== 'string' ||
          !conversionBases.includes(entry.conversion_basis as NonNullable<IngredientEvidenceV2['conversion_basis']>)
        ) {
          diag.add('invalid_conversion_basis');
        } else {
          conversionBasis = entry.conversion_basis as NonNullable<IngredientEvidenceV2['conversion_basis']>;
        }
      }
      // The closed household evidence object exists ONLY in the schema-v2
      // contract. A v1 block carrying it fails closed as an unknown evidence
      // field (see `evidenceKeys` above) and is never interpreted.
      let householdPortion: IngredientEvidenceV2['household_portion'];
      if (isV2 && hasOwn(entry, 'household_portion')) {
        if (!isPlainObject(entry.household_portion)) {
          diag.add('invalid_household_portion_evidence');
        } else {
          const household = entry.household_portion;
          let householdEvidenceValid = true;
          for (const key of Object.keys(household)) {
            if (!HOUSEHOLD_PORTION_EVIDENCE_KEYS.has(key)) {
              householdEvidenceValid = false;
              diag.add('unknown_household_portion_field');
            }
          }
          const boundedText = (value: unknown): boolean =>
            typeof value === 'string' &&
            value.length > 0 &&
            value.length <= MAX_HOUSEHOLD_EVIDENCE_TEXT_LENGTH &&
            !/[\u0000-\u001f\u007f-\u009f]/.test(value);
          const nullableText = (value: unknown): boolean => value === null || boundedText(value);
          if (!boundedText(household.registry_release)) householdEvidenceValid = false;
          if (!boundedText(household.record_key)) householdEvidenceValid = false;
          if (
            typeof household.record_digest !== 'string' ||
            household.record_digest.length > MAX_DIGEST_LENGTH
          ) {
            householdEvidenceValid = false;
          }
          if (!boundedText(household.household_unit)) householdEvidenceValid = false;
          if (!nullableText(household.size_class)) householdEvidenceValid = false;
          if (!nullableText(household.requires_state)) householdEvidenceValid = false;
          if (!isValidNutrientAmount(household.quantity) || !((household.quantity as number) > 0)) {
            householdEvidenceValid = false;
          }
          if (
            typeof household.selection_digest !== 'string' ||
            household.selection_digest.length > MAX_DIGEST_LENGTH
          ) {
            householdEvidenceValid = false;
          }
          if (!householdEvidenceValid) {
            diag.add('invalid_household_portion_evidence');
          } else {
            householdPortion = {
              registry_release: household.registry_release as string,
              record_key: household.record_key as string,
              record_digest: household.record_digest as string,
              household_unit: household.household_unit as string,
              size_class: (household.size_class ?? null) as string | null,
              requires_state: (household.requires_state ?? null) as string | null,
              quantity: household.quantity as number,
              selection_digest: household.selection_digest as string,
            };
          }
        }
      }
      // The household evidence object exists ONLY for the household conversion
      // basis, and that basis requires the evidence object. Unknown/future
      // schema or conversion bases fail closed (never coerced to user mass).
      if (conversionBasis === 'household_portion' && !householdPortion) {
        diag.add('household_portion_evidence_missing');
      }
      if (householdPortion && conversionBasis !== 'household_portion') {
        diag.add('household_portion_evidence_without_basis');
      }
      // A household basis asserts a RESOLVED mass; conflicting mass evidence
      // (an unresolved line or a missing/non-positive gram amount) fails the
      // whole block closed rather than persisting an unprovable household mass.
      if (
        conversionBasis === 'household_portion' &&
        (entry.resolved !== true || amount === undefined || !(amount.value > 0))
      ) {
        diag.add('household_portion_conflicting_mass');
      }
      ingredients.push({
        line_ref: typeof lineRef === 'string' ? lineRef : '',
        ...(typeof entry.line_digest === 'string' ? { line_digest: entry.line_digest } : {}),
        source: source as NutritionSourceId,
        source_food_id: typeof entry.source_food_id === 'string' ? entry.source_food_id : '',
        source_release: typeof entry.source_release === 'string' ? entry.source_release : '',
        match_status: matchStatus as IngredientEvidence['match_status'],
        resolved: entry.resolved === true,
        user_confirmed: entry.user_confirmed === true,
        ...(amount ? { amount } : {}),
        ...(conversionBasis ? { conversion_basis: conversionBasis } : {}),
        ...(householdPortion ? { household_portion: householdPortion } : {}),
      });
    }
  }

  // Unresolved references.
  const unresolved: UnresolvedIngredientRef[] = [];
  if (!Array.isArray(raw.unresolved) || raw.unresolved.length > MAX_UNRESOLVED) {
    diag.add('invalid_unresolved');
  } else {
    for (const entry of raw.unresolved) {
      if (!isPlainObject(entry)) {
        diag.add('invalid_unresolved_entry');
        continue;
      }
      for (const key of Object.keys(entry)) {
        if (!UNRESOLVED_KEYS.has(key)) diag.add('unknown_unresolved_field');
      }
      const lineRef = entry.line_ref;
      if (typeof lineRef !== 'string' || lineRef.trim().length === 0 || lineRef.length > MAX_LINE_REF_LENGTH) {
        diag.add('invalid_unresolved_line_ref');
      } else if (lineRefs.has(lineRef)) {
        diag.add('duplicate_line_ref');
      } else {
        lineRefs.add(lineRef);
      }
      if (typeof entry.reason !== 'string' || !UNRESOLVED_REASONS.includes(entry.reason as UnresolvedIngredientRef['reason'])) {
        diag.add('invalid_unresolved_reason');
      }
      // Optional USER-CONFIRMED food identity for an unresolved-mass row. The two
      // fields are present together or absent together, and the release must match
      // the declared `usda_fdc` release. This never contributes a nutrient total.
      let unresolvedFoodId: string | undefined;
      let unresolvedRelease: string | undefined;
      const hasFoodId = hasOwn(entry, 'source_food_id');
      const hasRelease = hasOwn(entry, 'source_release');
      if (hasFoodId !== hasRelease) {
        diag.add('invalid_unresolved_food_evidence');
      } else if (hasFoodId) {
        // A USDA FDC id is a bounded positive INTEGER string. A non-numeric
        // `source_food_id` can never authenticate against the pinned catalog and
        // is rejected here (fail closed) rather than carried as inert prose.
        if (
          typeof entry.source_food_id !== 'string' ||
          !/^\d+$/.test(entry.source_food_id) ||
          entry.source_food_id.length > MAX_SOURCE_ID_LENGTH
        ) {
          diag.add('invalid_unresolved_source_food_id');
        } else {
          const numeric = Number(entry.source_food_id);
          if (!Number.isSafeInteger(numeric) || numeric <= 0) {
            diag.add('invalid_unresolved_source_food_id');
          } else {
            unresolvedFoodId = entry.source_food_id;
          }
        }
        if (
          typeof entry.source_release !== 'string' ||
          entry.source_release.trim().length === 0 ||
          entry.source_release.length > MAX_SOURCE_RELEASE_LENGTH
        ) {
          diag.add('invalid_ingredient_source_release');
        } else {
          const declaredUsda = sourceReleases.usda_fdc;
          if (declaredUsda === undefined) diag.add('ingredient_release_missing');
          else if (declaredUsda !== entry.source_release) diag.add('ingredient_release_mismatch');
          else unresolvedRelease = entry.source_release;
        }
      }
      unresolved.push({
        line_ref: typeof lineRef === 'string' ? lineRef : '',
        reason: entry.reason as UnresolvedIngredientRef['reason'],
        ...(unresolvedFoodId !== undefined ? { source_food_id: unresolvedFoodId } : {}),
        ...(unresolvedRelease !== undefined ? { source_release: unresolvedRelease } : {}),
      });
    }
  }

  // Manual override (closed fields).
  let manualOverride: ManualOverrideMetadata | undefined;
  if (hasOwn(raw, 'manual_override')) {
    if (!isPlainObject(raw.manual_override)) {
      diag.add('invalid_manual_override');
    } else {
      for (const key of Object.keys(raw.manual_override)) {
        if (!MANUAL_OVERRIDE_KEYS.has(key)) diag.add('unknown_manual_override_field');
      }
      if (!isValidTimestamp(raw.manual_override.overridden_at)) {
        diag.add('invalid_manual_override');
      } else {
        const note = raw.manual_override.note;
        if (note !== undefined && (typeof note !== 'string' || note.length > MAX_MANUAL_NOTE_LENGTH)) {
          diag.add('invalid_manual_override_note');
        } else {
          manualOverride = {
            overridden_at: raw.manual_override.overridden_at as string,
            ...(typeof note === 'string' ? { note } : {}),
          };
        }
      }
    }
  }

  // Bounded non-authoritative extensions (extension bounds + one-pass clone).
  let extensions: Record<string, unknown> | undefined;
  if (hasOwn(raw, 'extensions')) {
    if (!isPlainObject(raw.extensions)) {
      diag.add('invalid_extensions');
    } else {
      try {
        extensions = cloneSafeValue(raw.extensions) as Record<string, unknown>;
      } catch {
        diag.add('invalid_extensions');
      }
    }
  }

  // Provenance classification (computed before completeness).
  const datasetSources = sources.filter((source) =>
    (DATASET_BACKED_SOURCE_IDS as ReadonlyArray<string>).includes(source)
  );
  const resolvedEvidenceSources = new Set(
    ingredients.filter((entry) => entry.resolved === true).map((entry) => entry.source)
  );
  const isManualOnly = sources.length === 1 && sources[0] === 'user_manual';

  // Status coherence. BLOCK completeness is about INGREDIENT-LINE resolution:
  // zero unresolved ingredient lines means the whole-recipe result is COMPLETE,
  // even when a USDA record does not enumerate every nutrient in scope (each
  // nutrient still reports its own status/coverage independently). This is the
  // single completion derivation shared by the live preview, Phase 5 Apply, the
  // persisted block, and both nutrition surfaces.
  const nutrientValues = Object.values(nutrients);
  if (status === 'complete') {
    if (unresolved.length > 0) diag.add('complete_with_unresolved');
    if (nutrientScope.length === 0) diag.add('complete_without_scope');

    if (datasetSources.length > 0) {
      // Dataset provenance: every declared dataset source needs matching
      // resolved evidence; manual evidence never substitutes.
      for (const source of datasetSources) {
        if (!resolvedEvidenceSources.has(source)) {
          diag.add(`dataset_source_without_resolved_evidence:${source}`);
        }
      }
    } else if (isManualOnly) {
      // Manual-only exception: override is ALWAYS required, with or without
      // manual evidence. No dataset release/evidence can coexist (sources is
      // exactly ['user_manual']).
      if (manualOverride === undefined) diag.add('manual_only_requires_manual_override');
    } else if (resolvedEvidenceSources.size === 0) {
      diag.add('complete_without_evidence');
    }
  }
  if (status === 'partial') {
    const hasAbsentScoped = nutrientScope.some((id) => !nutrients[id]);
    const hasPartialNutrient = nutrientValues.some((entry) => entry && entry.status === 'partial');
    if (unresolved.length === 0 && !hasAbsentScoped && !hasPartialNutrient) {
      diag.add('partial_without_partial_evidence');
    }
  }
  if (status === 'unresolved' && unresolved.length === 0) diag.add('unresolved_without_entries');

  if (diag.hasErrors) return { ok: false, errors: diag.list() };

  const value = {
    schema: version,
    basis: CODEX_NUTRITION_BASIS_TOTAL,
    servings: servings as number,
    ...(servingSize !== undefined ? { serving_size: servingSize } : {}),
    status: status as NutritionBlockStatus,
    computed_at: raw.computed_at as string,
    ingredient_digest: raw.ingredient_digest as string,
    dv_standard: DV_STANDARD_ID,
    sources,
    source_releases: sourceReleases,
    nutrient_scope: nutrientScope,
    nutrients,
    ingredients,
    unresolved,
    ...(manualOverride ? { manual_override: manualOverride } : {}),
    ...(extensions ? { extensions } : {}),
  } as CodexNutritionV1 | CodexNutritionV2;
  return { ok: true, errors: [], value };
}

/**
 * Strictly validates a recognized schema-v1 block from an untrusted value.
 * Materializes to a NEW inert plain structure first (single descriptor pass, no
 * accessor invocation), then validates only the inert copy. Never throws;
 * unexpected reflective failures return a fixed bounded error.
 */
export function validateCodexNutritionV1(
  raw: unknown
): AdvancedNutritionValidation<CodexNutritionV1> {
  try {
    const materialized = toInertValue(raw);
    if (materialized.ok) {
      if (!isPlainObject(materialized.value)) return { ok: false, errors: ['not_an_object'] };
      return validateInertCodexNutrition(materialized.value, CODEX_NUTRITION_SCHEMA_V1) as
        AdvancedNutritionValidation<CodexNutritionV1>;
    }
    const failure = materialized as { ok: false; reason: string };
    return { ok: false, errors: [`unsafe_value:${failure.reason}`] };
  } catch {
    return { ok: false, errors: ['validation_error'] };
  }
}

/**
 * Strictly validates a recognized schema-v2 block from an untrusted value. The
 * same single descriptor-based materialization precedes validation, and the v2
 * validator owns the closed household basis/evidence coupling.
 */
export function validateCodexNutritionV2(
  raw: unknown
): AdvancedNutritionValidation<CodexNutritionV2> {
  try {
    const materialized = toInertValue(raw);
    if (materialized.ok) {
      if (!isPlainObject(materialized.value)) return { ok: false, errors: ['not_an_object'] };
      return validateInertCodexNutrition(materialized.value, CODEX_NUTRITION_SCHEMA_V2) as
        AdvancedNutritionValidation<CodexNutritionV2>;
    }
    const failure = materialized as { ok: false; reason: string };
    return { ok: false, errors: [`unsafe_value:${failure.reason}`] };
  } catch {
    return { ok: false, errors: ['validation_error'] };
  }
}

/**
 * Version-DISPATCHING validator: the schema discriminator selects the
 * version-specific contract. Schema 1 uses the restored v1 contract; schema 2
 * uses the v2 contract. Any other schema (including a future version or a
 * non-numeric discriminator) fails closed and is never coerced. The value is
 * materialized inertly BEFORE the discriminator is read, so no getter is ever
 * invoked.
 */
export function validateCodexNutrition(
  raw: unknown
): AdvancedNutritionValidation {
  try {
    const materialized = toInertValue(raw);
    if (!materialized.ok) {
      const failure = materialized as { ok: false; reason: string };
      return { ok: false, errors: [`unsafe_value:${failure.reason}`] };
    }
    if (!isPlainObject(materialized.value)) return { ok: false, errors: ['not_an_object'] };
    const inert = materialized.value;
    if (inert.schema === CODEX_NUTRITION_SCHEMA_V2) {
      return validateInertCodexNutrition(inert, CODEX_NUTRITION_SCHEMA_V2);
    }
    return validateInertCodexNutrition(inert, CODEX_NUTRITION_SCHEMA_V1);
  } catch {
    return { ok: false, errors: ['validation_error'] };
  }
}

export type DecodeResult =
  | { kind: 'none' }
  | { kind: 'v1'; value: CodexNutritionV1 }
  | { kind: 'v2'; value: CodexNutritionV2 }
  | { kind: 'opaque'; value: OpaqueCodexNutrition }
  | { kind: 'malformed'; errors: string[] };

/**
 * Decodes a raw `codex_nutrition` value. A recognized schema (v1 or v2) is
 * strictly validated under its OWN version-specific contract; an unknown FUTURE
 * numeric schema is preserved as bounded opaque safe data (never interpreted);
 * anything malformed is reported and left untouched by the caller (so a
 * malformed block can never damage the recipe). The value is materialized
 * inertly first; never throws.
 */
export function decodeCodexNutrition(raw: unknown): DecodeResult {
  try {
    if (raw === undefined || raw === null) return { kind: 'none' };
    const materialized = toInertValue(raw);
    if (materialized.ok) {
      if (!isPlainObject(materialized.value)) return { kind: 'malformed', errors: ['not_an_object'] };
      const inert = materialized.value;

      if (inert.schema === CODEX_NUTRITION_SCHEMA_V1) {
        const validation = validateInertCodexNutrition(inert, CODEX_NUTRITION_SCHEMA_V1);
        if (validation.ok && validation.value) return { kind: 'v1', value: validation.value as CodexNutritionV1 };
        return { kind: 'malformed', errors: validation.errors };
      }

      if (inert.schema === CODEX_NUTRITION_SCHEMA_V2) {
        const validation = validateInertCodexNutrition(inert, CODEX_NUTRITION_SCHEMA_V2);
        if (validation.ok && validation.value) return { kind: 'v2', value: validation.value as CodexNutritionV2 };
        return { kind: 'malformed', errors: validation.errors };
      }

      if (typeof inert.schema === 'number' && Number.isFinite(inert.schema)) {
        try {
          const data = cloneSafeValue(inert) as Record<string, unknown>;
          return { kind: 'opaque', value: { kind: 'opaque', schema: inert.schema, data } };
        } catch {
          return { kind: 'malformed', errors: ['unsafe_or_oversized'] };
        }
      }

      return { kind: 'malformed', errors: ['missing_or_invalid_schema'] };
    }
    const failure = materialized as { ok: false; reason: string };
    return { kind: 'malformed', errors: [`unsafe_value:${failure.reason}`] };
  } catch {
    return { kind: 'malformed', errors: ['validation_error'] };
  }
}

/**
 * Encodes a validated block for frontmatter. Materializes the input first (so
 * no discriminator getter is ever invoked), then validates only the inert copy.
 * Throws a fixed, bounded error on invalid/unsafe/oversized input; the caller
 * must fail closed and never hand a rejected value to YAML.
 */
export function encodeCodexNutrition(block: AdvancedNutritionBlock): Record<string, unknown> {
  let inert: unknown;
  try {
    const materialized = toInertValue(block);
    if (!materialized.ok) throw new Error(ENCODE_UNSAFE_MESSAGE);
    inert = materialized.value;
  } catch (error) {
    if (error instanceof Error && error.message === ENCODE_UNSAFE_MESSAGE) throw error;
    throw new Error(ENCODE_UNSAFE_MESSAGE);
  }

  if (!isPlainObject(inert)) throw new Error(ENCODE_INVALID_MESSAGE);

  if (inert.kind === 'opaque') {
    if (!isPlainObject(inert.data) || typeof inert.schema !== 'number' || !Number.isFinite(inert.schema)) {
      throw new Error(ENCODE_INVALID_MESSAGE);
    }
    let data: Record<string, unknown>;
    try {
      data = cloneSafeValue(inert.data) as Record<string, unknown>;
    } catch {
      throw new Error(ENCODE_INVALID_MESSAGE);
    }
    const encoded = { schema: inert.schema, ...data };
    if (serializedBlockBytes(encoded) > MAX_SERIALIZED_BYTES) throw new Error(ENCODE_OVERSIZED_MESSAGE);
    return encoded;
  }

  // The schema discriminator selects the VERSION-SPECIFIC contract; a household
  // block is only ever encoded under schema v2, and a v1 block can never carry
  // household semantics.
  const validation =
    inert.schema === CODEX_NUTRITION_SCHEMA_V2
      ? validateInertCodexNutrition(inert, CODEX_NUTRITION_SCHEMA_V2)
      : validateInertCodexNutrition(inert, CODEX_NUTRITION_SCHEMA_V1);
  if (!validation.ok || !validation.value) throw new Error(ENCODE_INVALID_MESSAGE);

  const value = validation.value;
  const nutrients: Record<string, NutrientResult> = {};
  for (const id of NUTRIENT_IDS) {
    const result = value.nutrients[id];
    if (result) nutrients[id] = result;
  }
  const encoded: Record<string, unknown> = {
    schema: value.schema,
    basis: value.basis,
    servings: value.servings,
    ...(value.serving_size !== undefined ? { serving_size: value.serving_size } : {}),
    status: value.status,
    computed_at: value.computed_at,
    ingredient_digest: value.ingredient_digest,
    dv_standard: value.dv_standard,
    sources: value.sources,
    source_releases: value.source_releases,
    nutrient_scope: value.nutrient_scope,
    nutrients,
    ingredients: value.ingredients,
    unresolved: value.unresolved,
    ...(value.manual_override ? { manual_override: value.manual_override } : {}),
    ...(value.extensions ? { extensions: value.extensions } : {}),
  };
  if (serializedBlockBytes(encoded) > MAX_SERIALIZED_BYTES) throw new Error(ENCODE_OVERSIZED_MESSAGE);
  return encoded;
}

/**
 * ADVISORY ONLY. Reports whether a recognized schema-v1 or schema-v2 block has
 * complete evidence. It does NOT authorize any write; the production gate
 * remains the existing `canApplyNutritionEstimate` hard-disable.
 */
export function evaluateAdvancedNutritionEligibility(block: unknown): { eligible: boolean; reasons: string[] } {
  const validation = validateCodexNutrition(block);
  if (!validation.ok || !validation.value) {
    return { eligible: false, reasons: ['invalid_block', ...validation.errors].slice(0, 20) };
  }
  const value = validation.value;
  const reasons: string[] = [];
  if (value.status !== 'complete') reasons.push('status_not_complete');
  if (value.unresolved.length > 0) reasons.push('has_unresolved_ingredients');
  if (value.nutrient_scope.length === 0) reasons.push('empty_scope');
  for (const id of value.nutrient_scope) {
    const nutrient = value.nutrients[id];
    if (!nutrient) reasons.push(`missing_scoped_nutrient:${id}`);
    else if (nutrient.status !== 'complete' || nutrient.coverage !== 1) reasons.push(`partial_nutrient:${id}`);
  }
  if (value.sources.length === 0) reasons.push('no_sources');
  const datasetSources = value.sources.filter((source) =>
    (DATASET_BACKED_SOURCE_IDS as ReadonlyArray<string>).includes(source)
  );
  const resolvedSources = new Set(
    value.ingredients.filter((entry) => entry.resolved === true).map((entry) => entry.source)
  );
  const isManualOnly = value.sources.length === 1 && value.sources[0] === 'user_manual';
  if (datasetSources.length > 0) {
    for (const source of datasetSources) {
      if (!resolvedSources.has(source)) reasons.push(`dataset_source_without_evidence:${source}`);
    }
  } else if (isManualOnly) {
    if (value.manual_override === undefined) reasons.push('manual_override_required');
  } else if (resolvedSources.size === 0) {
    reasons.push('no_evidence');
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * The Phase 0 production Apply authorization for advanced nutrition: ALWAYS
 * disabled, returning the SAME reason as the centralized gate. Nothing wires
 * this to a write path.
 */
export function advancedNutritionApplicationAuthorization(): { ok: false; reasons: string[] } {
  return { ok: false, reasons: [ADVANCED_NUTRITION_APPLICATION_DISABLED_REASON] };
}
