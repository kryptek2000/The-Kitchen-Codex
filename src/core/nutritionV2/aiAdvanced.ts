/**
 * The Kitchen Codex — AI Advanced Nutrition: canonical ingredient
 * interpretation contract (AI-0).
 *
 * PURE, provider-neutral, platform-neutral, offline. This module owns the ONE
 * canonical contract for AI-assisted ingredient INTERPRETATION. It is an
 * EVOLUTION of the Phase 4/7 advisory contract (`./aiResolution.ts`), not a
 * competing architecture:
 *
 *   provider adapter (server/ai/*, outside the domain)
 *     -> raw provider output (untrusted)
 *     -> sanitizeAiAdvancedInterpretationResponse (THIS module: closed schema)
 *     -> AiAdvancedIngredientInterpretation (canonical semantic observations)
 *     -> adaptAiAdvancedInterpretationsForResolution (THIS module)
 *     -> AiResolutionSuggestion (existing bounded transport shape)
 *     -> existing deterministic verification
 *        (phase4/aiResolve, phase4/aiAmountResolve, phase4/aiHouseholdResolve)
 *     -> pinned USDA catalog / verified household registry / calculator
 *
 * HARD RULES
 * ----------
 *  - AI MAY interpret wording: food identity wording, aliases, preparation,
 *    state, count noun, household wording, size descriptors, approximate
 *    language, authored ranges, alternatives, ambiguity, contextual qualifiers.
 *  - AI MAY NEVER author authority: no FDC id, no nutrient value, no gram
 *    weight, no density, no portion gram weights, no schema/authorization/
 *    digest/confirmation fields, no persisted provenance. Authority-shaped
 *    keys are rejected WHOLE with `authority_field` (never partially trusted).
 *  - SOURCE TEXT REMAINS AUTHORITY for the authored amount. `reconcileAiAdvancedAmount`
 *    proves any echoed quantity is compatible with the recipe's OWN parsed
 *    amount before it can influence adaptation; a `3.5 lb` scalar may never
 *    become a range, a `3-4 lb` authored range may never collapse to a scalar,
 *    and a quantity-less line may never gain an invented scalar.
 *  - The canonical interpretation carries NO execution ability: it is inert
 *    data that must pass the existing deterministic identity + measurement
 *    gates before any resolution exists.
 */

import { isPlainObject, toInertValue } from './schema';
import type { AiResolutionIssueKind, AiResolutionSuggestion } from './aiResolution';

export const AI_ADVANCED_CONTRACT_VERSION = 'nutrition_ai_advanced_interpretation_v1';

// ---------------------------------------------------------------------------
// Bounds (closed, mirrored by any future server route)
// ---------------------------------------------------------------------------

export const MAX_AI_ADVANCED_ROWS = 25;
export const MAX_AI_ADVANCED_LINE_REF_LENGTH = 200;
export const MAX_AI_ADVANCED_NAME_LENGTH = 120;
export const MAX_AI_ADVANCED_TOKEN_LENGTH = 60;
export const MAX_AI_ADVANCED_TOKENS = 12;
export const MAX_AI_ADVANCED_SEARCH_PHRASES = 4;
export const MAX_AI_ADVANCED_PHRASE_LENGTH = 120;
export const MAX_AI_ADVANCED_ALTERNATIVES = 4;
export const MAX_AI_ADVANCED_AMBIGUITY_REASONS = 6;
export const MAX_AI_ADVANCED_NOTE_LENGTH = 300;
export const MAX_AI_ADVANCED_QUANTITY = 1_000_000;
export const MAX_AI_ADVANCED_DOCUMENT_TEXT = 300;

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

export const AI_ADVANCED_AMOUNT_KINDS = Object.freeze([
  'exact',
  'range',
  'approximate',
  'qualitative',
  'alternative',
  'unknown',
] as const);
export type AiAdvancedAmountKind = (typeof AI_ADVANCED_AMOUNT_KINDS)[number];

export const AI_ADVANCED_UNIT_FAMILIES = Object.freeze([
  'mass',
  'volume',
  'count',
  'household',
  'unknown',
] as const);
export type AiAdvancedUnitFamily = (typeof AI_ADVANCED_UNIT_FAMILIES)[number];

export const AI_ADVANCED_CONFIDENCE_VALUES = Object.freeze(['high', 'medium', 'low'] as const);
export type AiAdvancedConfidence = (typeof AI_ADVANCED_CONFIDENCE_VALUES)[number];

/**
 * Keys that would grant (or forge) authority if they ever crossed the
 * interpretation boundary. They are checked BEFORE the generic unknown-key
 * rejection so adversarial payloads get the precise, testable classification.
 * This list is deliberately conservative and additive: adding a new authority
 * field to the persisted schema requires adding it here, so the contract fails
 * closed by construction.
 */
export const AI_ADVANCED_FORBIDDEN_AUTHORITY_KEYS: ReadonlySet<string> = new Set([
  // Database / catalog identity
  'fdc_id',
  'fdcId',
  'fdc',
  'usda_fdc_id',
  'food_id',
  'source_food_id',
  'catalog_id',
  'record_id',
  'local_id',
  'record_key',
  'household_record',
  'registry_record',
  // Nutrient authority
  'nutrients',
  'nutrient_amounts',
  'nutrient',
  'calories',
  'protein',
  'fat',
  'carbs',
  'carbohydrates',
  'fiber',
  'sugar',
  'sodium',
  'daily_values',
  'dv',
  // Mass / portion authority
  'gram_weight',
  'gramWeight',
  'grams',
  'mass',
  'weight',
  'density',
  'source_portion_grams',
  'count_portion_grams',
  'household_grams',
  'portion_index',
  'portion',
  'portion_grams',
  'resolved_grams',
  'representative_grams',
  // Digest / schema / provenance authority
  'digest',
  'record_digest',
  'catalog_digest',
  'selection_digest',
  'ingredient_digest',
  'artifact_digest',
  'schema',
  'schema_version',
  'provenance',
  'provenance_class',
  'range_provenance',
  'range_representative',
  'persisted_provenance',
  'authority_class',
  'mass_source',
  // Application authorization / confirmation
  'authorization',
  'apply',
  'apply_token',
  'application_authorized',
  'user_confirmed',
  'confirmed',
  'confirmation',
  'servings',
  'serving_count',
  'persist',
  'persist_block',
  'nutrition_block',
  'codex_nutrition',
  'basis',
  'status',
]);

function isForbiddenAuthorityKey(key: string): boolean {
  return AI_ADVANCED_FORBIDDEN_AUTHORITY_KEYS.has(key);
}

// ---------------------------------------------------------------------------
// Canonical semantic contract
// ---------------------------------------------------------------------------

export interface AiAdvancedSemanticFood {
  readonly normalized_name?: string;
  readonly modifiers: readonly string[];
  readonly preparation: readonly string[];
  readonly state: readonly string[];
  readonly qualifiers: readonly string[];
}

export interface AiAdvancedAmountSemantics {
  /**
   * Semantic interpretation of the authored amount LANGUAGE only. The authored
   * endpoints/scalar always come from the deterministic parse and are reconciled
   * by `reconcileAiAdvancedAmount` before adaptation.
   */
  readonly kind: AiAdvancedAmountKind;
  readonly range_lower?: number;
  readonly range_upper?: number;
  /** Echo/interpretation of the recipe's OWN quantity (never a mass). */
  readonly echoed_value?: number;
  /** Bounded wording observation (data only). */
  readonly phrasing?: string;
}

export interface AiAdvancedUnitSemantics {
  readonly raw?: string;
  readonly family: AiAdvancedUnitFamily;
  readonly interpreted_unit?: string;
}

export interface AiAdvancedCountSemantics {
  readonly noun?: string;
  readonly size?: string;
  readonly state?: string;
}

export interface AiAdvancedAlternative {
  readonly normalized_name: string;
  readonly notes?: string;
}

export interface AiAdvancedAmbiguity {
  readonly ambiguous: boolean;
  readonly reasons: readonly string[];
}

export interface AiAdvancedIngredientInterpretation {
  readonly contract_version: typeof AI_ADVANCED_CONTRACT_VERSION;
  readonly line_ref: string;
  readonly semantic_food: AiAdvancedSemanticFood;
  readonly search_phrases: readonly string[];
  readonly amount_semantics: AiAdvancedAmountSemantics;
  readonly unit_semantics: AiAdvancedUnitSemantics;
  readonly count_semantics: AiAdvancedCountSemantics;
  readonly alternatives: readonly AiAdvancedAlternative[];
  readonly ambiguity: AiAdvancedAmbiguity;
  readonly confidence?: AiAdvancedConfidence;
  readonly notes?: string;
}

export type AiAdvancedFailureCode =
  | 'invalid_response'
  | 'unsafe_response'
  | 'oversized_response'
  | 'unsupported_contract_version'
  | 'authority_field'
  | 'unknown_line_ref'
  | 'duplicate_line_ref';

export interface AiAdvancedSanitizeOptions {
  /** The exact line_refs the caller asked about. */
  readonly allowedLineRefs: ReadonlyArray<string>;
  /** Optional cap (clamped to MAX_AI_ADVANCED_ROWS). */
  readonly maxRows?: number;
}

export type AiAdvancedSanitizeResult =
  | { readonly ok: true; readonly interpretations: ReadonlyArray<AiAdvancedIngredientInterpretation> }
  | { readonly ok: false; readonly code: AiAdvancedFailureCode };

const ENVELOPE_KEYS = new Set(['contract_version', 'interpretations']);
const INTERPRETATION_KEYS = new Set([
  'contract_version',
  'line_ref',
  'semantic_food',
  'search_phrases',
  'amount_semantics',
  'unit_semantics',
  'count_semantics',
  'alternatives',
  'ambiguity',
  'confidence',
  'notes',
]);
const SEMANTIC_FOOD_KEYS = new Set([
  'normalized_name',
  'modifiers',
  'preparation',
  'state',
  'qualifiers',
]);
const AMOUNT_SEMANTICS_KEYS = new Set(['kind', 'range_lower', 'range_upper', 'echoed_value', 'phrasing']);
const UNIT_SEMANTICS_KEYS = new Set(['raw', 'family', 'interpreted_unit']);
const COUNT_SEMANTICS_KEYS = new Set(['noun', 'size', 'state']);
const ALTERNATIVE_KEYS = new Set(['normalized_name', 'notes']);
const AMBIGUITY_KEYS = new Set(['ambiguous', 'reasons']);

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function boundedPositive(value: unknown): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    Object.is(value, -0) ||
    value > MAX_AI_ADVANCED_QUANTITY
  ) {
    return undefined;
  }
  return value;
}

function isOneOf<T extends string>(values: ReadonlyArray<T>, value: unknown): value is T {
  return typeof value === 'string' && (values as ReadonlyArray<string>).includes(value);
}

/** Rejects any object (at any depth of the entry) carrying an authority key. */
function containsForbiddenAuthorityKey(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenAuthorityKey(entry, depth + 1));
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (isForbiddenAuthorityKey(key)) return true;
    if (containsForbiddenAuthorityKey((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

/**
 * Bounded token list (modifiers/preparation/state/qualifiers). Absent -> empty
 * frozen list; a present malformed entry rejects the interpretation.
 */
function boundedTokens(raw: unknown): { ok: boolean; tokens: readonly string[] } {
  if (raw === undefined || raw === null) return { ok: true, tokens: Object.freeze([]) };
  if (!Array.isArray(raw) || raw.length > MAX_AI_ADVANCED_TOKENS) return { ok: false, tokens: Object.freeze([]) };
  const tokens: string[] = [];
  for (const token of raw) {
    const bounded = boundedString(token, MAX_AI_ADVANCED_TOKEN_LENGTH);
    if (bounded === undefined) return { ok: false, tokens: Object.freeze([]) };
    tokens.push(bounded);
  }
  return { ok: true, tokens: Object.freeze(tokens) };
}

/**
 * Strictly sanitizes one raw AI-Advanced interpretation response. Never throws;
 * every failure is a closed, bounded classification. A forbidden/unknown field
 * rejects the WHOLE response (fail closed, no partial authority).
 */
export function sanitizeAiAdvancedInterpretationResponse(
  raw: unknown,
  options: AiAdvancedSanitizeOptions
): AiAdvancedSanitizeResult {
  let materialized: unknown;
  try {
    const result = toInertValue(raw);
    if (!result.ok) {
      const reason = (result as { ok: false; reason: string }).reason;
      return { ok: false, code: reason === 'oversized' ? 'oversized_response' : 'unsafe_response' };
    }
    materialized = result.value;
  } catch {
    return { ok: false, code: 'unsafe_response' };
  }

  if (!isPlainObject(materialized)) return { ok: false, code: 'invalid_response' };
  for (const key of Object.keys(materialized)) {
    if (!ENVELOPE_KEYS.has(key)) {
      return { ok: false, code: isForbiddenAuthorityKey(key) ? 'authority_field' : 'invalid_response' };
    }
  }
  if (materialized.contract_version !== AI_ADVANCED_CONTRACT_VERSION) {
    return { ok: false, code: 'unsupported_contract_version' };
  }
  if (!Array.isArray(materialized.interpretations)) return { ok: false, code: 'invalid_response' };
  const maxRows = Math.min(
    typeof options.maxRows === 'number' && Number.isSafeInteger(options.maxRows) && options.maxRows > 0
      ? options.maxRows
      : MAX_AI_ADVANCED_ROWS,
    MAX_AI_ADVANCED_ROWS
  );
  if (materialized.interpretations.length > maxRows) return { ok: false, code: 'invalid_response' };

  const allowed = new Set(options.allowedLineRefs);
  const seen = new Set<string>();
  const out: AiAdvancedIngredientInterpretation[] = [];

  for (const entry of materialized.interpretations) {
    if (!isPlainObject(entry)) return { ok: false, code: 'invalid_response' };
    if (containsForbiddenAuthorityKey(entry)) return { ok: false, code: 'authority_field' };
    for (const key of Object.keys(entry)) {
      if (!INTERPRETATION_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
    }

    // The canonical envelope owns the version; a per-entry version field is
    // permitted for provider convenience but must match exactly.
    if (
      entry.contract_version !== undefined &&
      entry.contract_version !== AI_ADVANCED_CONTRACT_VERSION
    ) {
      return { ok: false, code: 'unsupported_contract_version' };
    }

    const lineRef = boundedString(entry.line_ref, MAX_AI_ADVANCED_LINE_REF_LENGTH);
    if (lineRef === undefined) return { ok: false, code: 'invalid_response' };
    if (!allowed.has(lineRef)) return { ok: false, code: 'unknown_line_ref' };
    if (seen.has(lineRef)) return { ok: false, code: 'duplicate_line_ref' };
    seen.add(lineRef);

    // --- semantic_food (optional; defaults to empty observations) ----------
    const semanticFood: {
      normalized_name?: string;
      modifiers: readonly string[];
      preparation: readonly string[];
      state: readonly string[];
      qualifiers: readonly string[];
    } = { modifiers: Object.freeze([]), preparation: Object.freeze([]), state: Object.freeze([]), qualifiers: Object.freeze([]) };
    if (entry.semantic_food !== undefined && entry.semantic_food !== null) {
      if (!isPlainObject(entry.semantic_food)) return { ok: false, code: 'invalid_response' };
      for (const key of Object.keys(entry.semantic_food)) {
        if (!SEMANTIC_FOOD_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
      }
      if (entry.semantic_food.normalized_name !== undefined && entry.semantic_food.normalized_name !== null) {
        const name = boundedString(entry.semantic_food.normalized_name, MAX_AI_ADVANCED_NAME_LENGTH);
        if (name === undefined) return { ok: false, code: 'invalid_response' };
        semanticFood.normalized_name = name;
      }
      for (const key of ['modifiers', 'preparation', 'state', 'qualifiers'] as const) {
        const tokens = boundedTokens(entry.semantic_food[key]);
        if (!tokens.ok) return { ok: false, code: 'invalid_response' };
        semanticFood[key] = tokens.tokens;
      }
    }

    // --- search_phrases -----------------------------------------------------
    const searchPhrases: string[] = [];
    if (entry.search_phrases !== undefined && entry.search_phrases !== null) {
      if (
        !Array.isArray(entry.search_phrases) ||
        entry.search_phrases.length > MAX_AI_ADVANCED_SEARCH_PHRASES
      ) {
        return { ok: false, code: 'invalid_response' };
      }
      for (const phrase of entry.search_phrases) {
        const bounded = boundedString(phrase, MAX_AI_ADVANCED_PHRASE_LENGTH);
        if (bounded === undefined) return { ok: false, code: 'invalid_response' };
        if (!searchPhrases.includes(bounded)) searchPhrases.push(bounded);
      }
    }

    // --- amount_semantics ---------------------------------------------------
    let amountSemantics: AiAdvancedAmountSemantics = Object.freeze({
      kind: 'unknown' as AiAdvancedAmountKind,
    });
    if (entry.amount_semantics !== undefined && entry.amount_semantics !== null) {
      if (!isPlainObject(entry.amount_semantics)) return { ok: false, code: 'invalid_response' };
      for (const key of Object.keys(entry.amount_semantics)) {
        if (!AMOUNT_SEMANTICS_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
      }
      if (!isOneOf(AI_ADVANCED_AMOUNT_KINDS, entry.amount_semantics.kind)) {
        return { ok: false, code: 'invalid_response' };
      }
      const kind = entry.amount_semantics.kind;
      const lower =
        entry.amount_semantics.range_lower === undefined || entry.amount_semantics.range_lower === null
          ? undefined
          : boundedPositive(entry.amount_semantics.range_lower);
      const upper =
        entry.amount_semantics.range_upper === undefined || entry.amount_semantics.range_upper === null
          ? undefined
          : boundedPositive(entry.amount_semantics.range_upper);
      if (
        (entry.amount_semantics.range_lower !== undefined &&
          entry.amount_semantics.range_lower !== null &&
          lower === undefined) ||
        (entry.amount_semantics.range_upper !== undefined &&
          entry.amount_semantics.range_upper !== null &&
          upper === undefined)
      ) {
        return { ok: false, code: 'invalid_response' };
      }
      if (kind === 'range') {
        // A claimed range must declare BOTH authored-endpoint interpretations.
        if (lower === undefined || upper === undefined || lower > upper) {
          return { ok: false, code: 'invalid_response' };
        }
      } else if (lower !== undefined || upper !== undefined) {
        // Range endpoints on a non-range claim are internally inconsistent.
        return { ok: false, code: 'invalid_response' };
      }
      let echoed: number | undefined;
      if (entry.amount_semantics.echoed_value !== undefined && entry.amount_semantics.echoed_value !== null) {
        echoed = boundedPositive(entry.amount_semantics.echoed_value);
        if (echoed === undefined) return { ok: false, code: 'invalid_response' };
      }
      let phrasing: string | undefined;
      if (entry.amount_semantics.phrasing !== undefined && entry.amount_semantics.phrasing !== null) {
        phrasing = boundedString(entry.amount_semantics.phrasing, MAX_AI_ADVANCED_PHRASE_LENGTH);
        if (phrasing === undefined) return { ok: false, code: 'invalid_response' };
      }
      amountSemantics = Object.freeze({
        kind,
        ...(lower !== undefined ? { range_lower: lower } : {}),
        ...(upper !== undefined ? { range_upper: upper } : {}),
        ...(echoed !== undefined ? { echoed_value: echoed } : {}),
        ...(phrasing !== undefined ? { phrasing } : {}),
      });
    }

    // --- unit_semantics -----------------------------------------------------
    let unitSemantics: AiAdvancedUnitSemantics = Object.freeze({
      family: 'unknown' as AiAdvancedUnitFamily,
    });
    if (entry.unit_semantics !== undefined && entry.unit_semantics !== null) {
      if (!isPlainObject(entry.unit_semantics)) return { ok: false, code: 'invalid_response' };
      for (const key of Object.keys(entry.unit_semantics)) {
        if (!UNIT_SEMANTICS_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
      }
      const family =
        entry.unit_semantics.family === undefined || entry.unit_semantics.family === null
          ? ('unknown' as AiAdvancedUnitFamily)
          : entry.unit_semantics.family;
      if (!isOneOf(AI_ADVANCED_UNIT_FAMILIES, family)) return { ok: false, code: 'invalid_response' };
      let rawUnit: string | undefined;
      if (entry.unit_semantics.raw !== undefined && entry.unit_semantics.raw !== null) {
        rawUnit = boundedString(entry.unit_semantics.raw, MAX_AI_ADVANCED_TOKEN_LENGTH);
        if (rawUnit === undefined) return { ok: false, code: 'invalid_response' };
      }
      let interpretedUnit: string | undefined;
      if (entry.unit_semantics.interpreted_unit !== undefined && entry.unit_semantics.interpreted_unit !== null) {
        interpretedUnit = boundedString(entry.unit_semantics.interpreted_unit, MAX_AI_ADVANCED_TOKEN_LENGTH);
        if (interpretedUnit === undefined) return { ok: false, code: 'invalid_response' };
      }
      unitSemantics = Object.freeze({
        family,
        ...(rawUnit !== undefined ? { raw: rawUnit } : {}),
        ...(interpretedUnit !== undefined ? { interpreted_unit: interpretedUnit } : {}),
      });
    }

    // --- count_semantics ----------------------------------------------------
    let countSemantics: AiAdvancedCountSemantics = Object.freeze({});
    if (entry.count_semantics !== undefined && entry.count_semantics !== null) {
      if (!isPlainObject(entry.count_semantics)) return { ok: false, code: 'invalid_response' };
      for (const key of Object.keys(entry.count_semantics)) {
        if (!COUNT_SEMANTICS_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
      }
      const count: { noun?: string; size?: string; state?: string } = {};
      for (const key of ['noun', 'size', 'state'] as const) {
        const value = entry.count_semantics[key];
        if (value === undefined || value === null) continue;
        const bounded = boundedString(value, MAX_AI_ADVANCED_TOKEN_LENGTH);
        if (bounded === undefined) return { ok: false, code: 'invalid_response' };
        count[key] = bounded;
      }
      countSemantics = Object.freeze(count);
    }

    // --- alternatives -------------------------------------------------------
    const alternatives: AiAdvancedAlternative[] = [];
    if (entry.alternatives !== undefined && entry.alternatives !== null) {
      if (!Array.isArray(entry.alternatives) || entry.alternatives.length > MAX_AI_ADVANCED_ALTERNATIVES) {
        return { ok: false, code: 'invalid_response' };
      }
      for (const alternative of entry.alternatives) {
        if (!isPlainObject(alternative)) return { ok: false, code: 'invalid_response' };
        for (const key of Object.keys(alternative)) {
          if (!ALTERNATIVE_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
        }
        const name = boundedString(alternative.normalized_name, MAX_AI_ADVANCED_NAME_LENGTH);
        if (name === undefined) return { ok: false, code: 'invalid_response' };
        let alternativeNotes: string | undefined;
        if (alternative.notes !== undefined && alternative.notes !== null) {
          alternativeNotes = boundedString(alternative.notes, MAX_AI_ADVANCED_NOTE_LENGTH);
          if (alternativeNotes === undefined) return { ok: false, code: 'invalid_response' };
        }
        alternatives.push(
          Object.freeze({
            normalized_name: name,
            ...(alternativeNotes !== undefined ? { notes: alternativeNotes } : {}),
          })
        );
      }
    }

    // --- ambiguity ----------------------------------------------------------
    let ambiguity: AiAdvancedAmbiguity = Object.freeze({ ambiguous: false, reasons: Object.freeze([]) });
    if (entry.ambiguity !== undefined && entry.ambiguity !== null) {
      if (!isPlainObject(entry.ambiguity)) return { ok: false, code: 'invalid_response' };
      for (const key of Object.keys(entry.ambiguity)) {
        if (!AMBIGUITY_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
      }
      if (typeof entry.ambiguity.ambiguous !== 'boolean') return { ok: false, code: 'invalid_response' };
      const reasons: string[] = [];
      if (entry.ambiguity.reasons !== undefined && entry.ambiguity.reasons !== null) {
        if (
          !Array.isArray(entry.ambiguity.reasons) ||
          entry.ambiguity.reasons.length > MAX_AI_ADVANCED_AMBIGUITY_REASONS
        ) {
          return { ok: false, code: 'invalid_response' };
        }
        for (const reason of entry.ambiguity.reasons) {
          const bounded = boundedString(reason, MAX_AI_ADVANCED_TOKEN_LENGTH);
          if (bounded === undefined) return { ok: false, code: 'invalid_response' };
          reasons.push(bounded);
        }
      }
      ambiguity = Object.freeze({
        ambiguous: entry.ambiguity.ambiguous,
        reasons: Object.freeze(reasons),
      });
    }

    // --- confidence / notes -------------------------------------------------
    let confidence: AiAdvancedConfidence | undefined;
    if (entry.confidence !== undefined && entry.confidence !== null) {
      if (!isOneOf(AI_ADVANCED_CONFIDENCE_VALUES, entry.confidence)) {
        return { ok: false, code: 'invalid_response' };
      }
      confidence = entry.confidence;
    }
    let notes: string | undefined;
    if (entry.notes !== undefined && entry.notes !== null) {
      notes = boundedString(entry.notes, MAX_AI_ADVANCED_NOTE_LENGTH);
      if (notes === undefined) return { ok: false, code: 'invalid_response' };
    }

    out.push(
      Object.freeze({
        contract_version: AI_ADVANCED_CONTRACT_VERSION,
        line_ref: lineRef,
        semantic_food: Object.freeze(semanticFood),
        search_phrases: Object.freeze(searchPhrases),
        amount_semantics: amountSemantics,
        unit_semantics: unitSemantics,
        count_semantics: countSemantics,
        alternatives: Object.freeze(alternatives),
        ambiguity,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(notes !== undefined ? { notes } : {}),
      })
    );
  }

  return { ok: true, interpretations: Object.freeze(out) };
}

/**
 * Provider-neutral structured-output schema for the canonical interpretation
 * contract. Only advisory fields are declared; the sanitizer enforces the
 * closed shape regardless of provider schema support.
 */
export function buildAiAdvancedInterpretationSchema(): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
} {
  return {
    type: 'object',
    properties: {
      contract_version: { type: 'string' },
      interpretations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line_ref: { type: 'string' },
            semantic_food: {
              type: 'object',
              properties: {
                normalized_name: { type: 'string' },
                modifiers: { type: 'array', items: { type: 'string' } },
                preparation: { type: 'array', items: { type: 'string' } },
                state: { type: 'array', items: { type: 'string' } },
                qualifiers: { type: 'array', items: { type: 'string' } },
              },
            },
            search_phrases: { type: 'array', items: { type: 'string' } },
            amount_semantics: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: [...AI_ADVANCED_AMOUNT_KINDS] },
                range_lower: { type: 'number' },
                range_upper: { type: 'number' },
                echoed_value: { type: 'number' },
                phrasing: { type: 'string' },
              },
              required: ['kind'],
            },
            unit_semantics: {
              type: 'object',
              properties: {
                raw: { type: 'string' },
                family: { type: 'string', enum: [...AI_ADVANCED_UNIT_FAMILIES] },
                interpreted_unit: { type: 'string' },
              },
            },
            count_semantics: {
              type: 'object',
              properties: {
                noun: { type: 'string' },
                size: { type: 'string' },
                state: { type: 'string' },
              },
            },
            alternatives: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  normalized_name: { type: 'string' },
                  notes: { type: 'string' },
                },
                required: ['normalized_name'],
              },
            },
            ambiguity: {
              type: 'object',
              properties: {
                ambiguous: { type: 'boolean' },
                reasons: { type: 'array', items: { type: 'string' } },
              },
              required: ['ambiguous'],
            },
            confidence: { type: 'string', enum: [...AI_ADVANCED_CONFIDENCE_VALUES] },
            notes: { type: 'string' },
          },
          required: ['line_ref'],
        },
      },
    },
    required: ['contract_version', 'interpretations'],
  };
}

// ---------------------------------------------------------------------------
// Deterministic reconciliation against the AUTHORED source
// ---------------------------------------------------------------------------

/**
 * The deterministic parse observation for one line. Only the fields the
 * reconciliation needs; supplied from the canonical Phase 1 parse, never from
 * provider output.
 */
export interface AiAdvancedAuthoritativeAmountObservation {
  readonly quantity_kind: 'exact' | 'range' | 'absent' | 'invalid' | string;
  readonly amount: number | null;
  /** Authored unit/count range endpoints (`quantity_range`), when present. */
  readonly quantity_range?: { readonly lower: number; readonly upper: number } | null;
  /** Deterministic measurement class of the authored line. */
  readonly measurement_kind?: 'mass' | 'volume' | 'count' | 'unknown' | string;
  /** Written mass-range provenance endpoints, when the parse produced them. */
  readonly mass_range?: { readonly lower: number; readonly upper: number } | null;
  /** Deterministic representative mass (written-range midpoint), when produced. */
  readonly representative_grams?: number | null;
}

export type AiAdvancedAmountReconciliation =
  | {
      readonly ok: true;
      readonly echoed_value?: number;
      readonly range_lower?: number;
      readonly range_upper?: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'amount_contradicts_source'
        | 'range_endpoints_mismatch'
        | 'exact_source_claimed_as_range'
        | 'range_source_collapsed_to_scalar'
        | 'unconfirmed_quantity';
    };

const QUANTITY_TOLERANCE_FLOOR = 0.01;
const QUANTITY_TOLERANCE_RATIO = 0.05;

function quantityCompatible(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(QUANTITY_TOLERANCE_FLOOR, b * QUANTITY_TOLERANCE_RATIO);
}

function finitePair(value: { lower: number; upper: number } | null | undefined): { lower: number; upper: number } | undefined {
  if (
    value === null ||
    value === undefined ||
    typeof value.lower !== 'number' ||
    typeof value.upper !== 'number' ||
    !Number.isFinite(value.lower) ||
    !Number.isFinite(value.upper)
  ) {
    return undefined;
  }
  return value;
}

/**
 * Proves an AI amount interpretation is COMPATIBLE with the authored source
 * before it may influence adaptation. Source wording always outranks AI:
 *   - an exact authored scalar can never be reinterpreted as a range;
 *   - an authored range can never be collapsed to an exact scalar or lose an
 *     endpoint (the deterministic representative mass may be echoed, but the
 *     AI's own scalar is never accepted as the amount);
 *   - a quantity-less/qualitative line can never gain an invented scalar.
 * The source endpoints themselves remain the parse authority; this helper only
 * admits/refuses the AI's echo of them.
 */
export function reconcileAiAdvancedAmount(
  semantics: AiAdvancedAmountSemantics,
  source: AiAdvancedAuthoritativeAmountObservation
): AiAdvancedAmountReconciliation {
  const exactSource =
    source.quantity_kind === 'exact' && typeof source.amount === 'number' && Number.isFinite(source.amount);
  const authoredRange = finitePair(source.quantity_range);
  const massRange = finitePair(source.mass_range);
  const representative =
    typeof source.representative_grams === 'number' && Number.isFinite(source.representative_grams)
      ? source.representative_grams
      : undefined;
  const rangeSource = authoredRange !== undefined || massRange !== undefined;

  if (semantics.kind === 'range') {
    const target = massRange ?? authoredRange;
    if (target === undefined) {
      return { ok: false, code: exactSource ? 'exact_source_claimed_as_range' : 'unconfirmed_quantity' };
    }
    if (
      semantics.range_lower === undefined ||
      semantics.range_upper === undefined ||
      !quantityCompatible(semantics.range_lower, target.lower) ||
      !quantityCompatible(semantics.range_upper, target.upper)
    ) {
      return { ok: false, code: 'range_endpoints_mismatch' };
    }
    return { ok: true, range_lower: target.lower, range_upper: target.upper };
  }

  if (semantics.kind === 'exact' || semantics.kind === 'approximate') {
    if (rangeSource) {
      // An authored range is the author's evidence; AI may not collapse it into
      // its own scalar. Echoing the DETERMINISTIC representative is admitted.
      if (
        representative !== undefined &&
        semantics.echoed_value !== undefined &&
        quantityCompatible(semantics.echoed_value, representative)
      ) {
        return { ok: true, echoed_value: representative };
      }
      return { ok: false, code: 'range_source_collapsed_to_scalar' };
    }
    if (!exactSource) {
      if (semantics.echoed_value !== undefined) return { ok: false, code: 'unconfirmed_quantity' };
      return { ok: true };
    }
    if (semantics.echoed_value === undefined) return { ok: true };
    if (!quantityCompatible(semantics.echoed_value, source.amount as number)) {
      return { ok: false, code: 'amount_contradicts_source' };
    }
    return { ok: true, echoed_value: source.amount as number };
  }

  if (semantics.kind === 'qualitative' || semantics.kind === 'alternative') {
    // A qualitative claim on a line that carries an authored amount erases the
    // author's wording only if it also asserts a scalar; a bare qualitative
    // observation is admitted as a non-authoritative remark.
    if (semantics.echoed_value !== undefined) return reconcileEchoOrRefuse(semantics.echoed_value, source);
    return { ok: true };
  }

  // kind === 'unknown': a non-claim. It may carry a bounded echo for context.
  if (semantics.echoed_value !== undefined) {
    return reconcileEchoOrRefuse(semantics.echoed_value, source);
  }
  return { ok: true };
}

/** An echoed scalar is admitted only against deterministic scalar evidence. */
function reconcileEchoOrRefuse(
  echoed: number,
  source: AiAdvancedAuthoritativeAmountObservation
): AiAdvancedAmountReconciliation {
  const exactSource =
    source.quantity_kind === 'exact' && typeof source.amount === 'number' && Number.isFinite(source.amount);
  const representative =
    typeof source.representative_grams === 'number' && Number.isFinite(source.representative_grams)
      ? source.representative_grams
      : undefined;
  if (exactSource && quantityCompatible(echoed, source.amount as number)) {
    return { ok: true, echoed_value: source.amount as number };
  }
  if (representative !== undefined && quantityCompatible(echoed, representative)) {
    return { ok: true, echoed_value: representative };
  }
  if (source.quantity_range !== null && source.quantity_range !== undefined) {
    return { ok: false, code: 'range_source_collapsed_to_scalar' };
  }
  return { ok: false, code: 'unconfirmed_quantity' };
}

// ---------------------------------------------------------------------------
// Adaptation into the existing bounded transport contract
// ---------------------------------------------------------------------------

export interface AiAdvancedAdaptInput {
  readonly interpretations: ReadonlyArray<AiAdvancedIngredientInterpretation>;
  /**
   * Optional deterministic parse observation by line ref. When supplied, the
   * interpretation is reconciled against the authored source before adaptation;
   * a contradiction drops that line entirely.
   */
  readonly authoritativeByLineRef?: ReadonlyMap<string, AiAdvancedAuthoritativeAmountObservation>;
}

export interface AiAdvancedAdaptOutcome {
  /** Bounded transport suggestions for the existing deterministic verification. */
  readonly suggestions: ReadonlyArray<AiResolutionSuggestion>;
  /** Interpretations dropped because the authored source contradicted them. */
  readonly contradicted: ReadonlyArray<string>;
  /** Interpretations without a usable primary food identity / search phrase. */
  readonly inadaptable: ReadonlyArray<string>;
}

/**
 * Converts canonical interpretations into the existing bounded transport shape.
 * The adapter NEVER invents grams, FDC ids, nutrients, digests, or authority;
 * every deterministic verification (confidence matcher, count-portion review,
 * household registry, calculator) still runs downstream unchanged.
 *
 * Alternatives are carried in the canonical contract but intentionally NOT
 * mapped into resolution queries: the deterministic pipeline never collapses an
 * `X or Y` alternative into a fabricated single identity.
 */
export function adaptAiAdvancedInterpretationsForResolution(
  input: AiAdvancedAdaptInput
): AiAdvancedAdaptOutcome {
  const suggestions: AiResolutionSuggestion[] = [];
  const contradicted: string[] = [];
  const inadaptable: string[] = [];

  for (const interpretation of input.interpretations) {
    const authoritative = input.authoritativeByLineRef?.get(interpretation.line_ref);
    let echo: { echoed_value?: number } = {};
    if (authoritative !== undefined) {
      const reconciled = reconcileAiAdvancedAmount(interpretation.amount_semantics, authoritative);
      if (!reconciled.ok) {
        contradicted.push(interpretation.line_ref);
        continue;
      }
      echo = reconciled.echoed_value !== undefined ? { echoed_value: reconciled.echoed_value } : {};
    } else if (interpretation.amount_semantics.echoed_value !== undefined) {
      echo = { echoed_value: interpretation.amount_semantics.echoed_value };
    }

    const primaryName = interpretation.semantic_food.normalized_name;
    const firstPhrase = interpretation.search_phrases[0];
    const interpretedFoodName = primaryName ?? firstPhrase;
    if (interpretedFoodName === undefined) {
      inadaptable.push(interpretation.line_ref);
      continue;
    }

    const searchPhrases: string[] = [];
    for (const phrase of interpretation.search_phrases) {
      if (phrase !== interpretedFoodName && !searchPhrases.includes(phrase)) searchPhrases.push(phrase);
    }
    if (searchPhrases.length === 0 && firstPhrase !== undefined && firstPhrase !== interpretedFoodName) {
      searchPhrases.push(firstPhrase);
    }

    const preparationHint = interpretation.semantic_food.preparation[0];
    const family = interpretation.unit_semantics.family;
    const interpretedUnit = interpretation.unit_semantics.interpreted_unit;
    const quantityUnitHint = family === 'count' ? interpretedUnit : undefined;
    const householdUnitHint = family === 'household' ? interpretedUnit : undefined;
    const countNoun = interpretation.count_semantics.noun;
    const householdSize = interpretation.count_semantics.size;
    const householdState = interpretation.count_semantics.state;

    suggestions.push(
      Object.freeze({
        line_ref: interpretation.line_ref,
        interpreted_food_name: interpretedFoodName,
        suggested_usda_queries: Object.freeze(searchPhrases),
        ...(interpretation.notes !== undefined ? { notes: interpretation.notes } : {}),
        ...(interpretation.confidence !== undefined ? { confidence: interpretation.confidence } : {}),
        ...(primaryName !== undefined ? { normalized_food_query: primaryName } : {}),
        ...(preparationHint !== undefined ? { preparation_hint: preparationHint } : {}),
        ...(echo.echoed_value !== undefined ? { quantity_value: echo.echoed_value } : {}),
        ...(quantityUnitHint !== undefined ? { quantity_unit_hint: quantityUnitHint } : {}),
        ...(countNoun !== undefined ? { count_descriptor_hint: countNoun } : {}),
        ...(countNoun !== undefined ? { portion_search_hint: countNoun } : {}),
        ...(householdUnitHint !== undefined ? { household_unit_hint: householdUnitHint } : {}),
        ...(householdSize !== undefined ? { household_size_hint: householdSize } : {}),
        ...(householdState !== undefined ? { household_state_hint: householdState } : {}),
      })
    );
  }

  return Object.freeze({
    suggestions: Object.freeze(suggestions),
    contradicted: Object.freeze(contradicted),
    inadaptable: Object.freeze(inadaptable),
  });
}

/**
 * Maps an already-sanitized Phase 4/7 advisory suggestion INTO the canonical
 * semantic contract, proving the existing Phase 7 semantics are a subset of the
 * canonical model (no field is lost that the canonical model needs, and no new
 * authority is created).
 */
export function aiAdvancedInterpretationFromResolutionSuggestion(
  suggestion: AiResolutionSuggestion
): AiAdvancedIngredientInterpretation {
  const preparation = suggestion.preparation_hint !== undefined ? [suggestion.preparation_hint] : [];
  const countNoun = suggestion.count_descriptor_hint ?? suggestion.portion_search_hint;
  const family: AiAdvancedUnitFamily =
    suggestion.household_unit_hint !== undefined
      ? 'household'
      : suggestion.quantity_unit_hint !== undefined
        ? 'count'
        : 'unknown';
  const amountKind: AiAdvancedAmountKind =
    suggestion.quantity_value !== undefined ? 'exact' : 'unknown';
  return Object.freeze({
    contract_version: AI_ADVANCED_CONTRACT_VERSION,
    line_ref: suggestion.line_ref,
    semantic_food: Object.freeze({
      ...(suggestion.normalized_food_query !== undefined
        ? { normalized_name: suggestion.normalized_food_query }
        : {}),
      modifiers: Object.freeze([]),
      preparation: Object.freeze(preparation),
      state: Object.freeze(suggestion.household_state_hint !== undefined ? [suggestion.household_state_hint] : []),
      qualifiers: Object.freeze([]),
    }),
    search_phrases: Object.freeze([...suggestion.suggested_usda_queries]),
    amount_semantics: Object.freeze({
      kind: amountKind,
      ...(suggestion.quantity_value !== undefined ? { echoed_value: suggestion.quantity_value } : {}),
    }),
    unit_semantics: Object.freeze({
      family,
      ...(suggestion.quantity_unit_hint !== undefined ? { raw: suggestion.quantity_unit_hint } : {}),
      ...(suggestion.household_unit_hint !== undefined
        ? { interpreted_unit: suggestion.household_unit_hint }
        : suggestion.quantity_unit_hint !== undefined
          ? { interpreted_unit: suggestion.quantity_unit_hint }
          : {}),
    }),
    count_semantics: Object.freeze({
      ...(countNoun !== undefined ? { noun: countNoun } : {}),
      ...(suggestion.household_size_hint !== undefined ? { size: suggestion.household_size_hint } : {}),
      ...(suggestion.household_state_hint !== undefined ? { state: suggestion.household_state_hint } : {}),
    }),
    alternatives: Object.freeze([]),
    ambiguity: Object.freeze({ ambiguous: false, reasons: Object.freeze([]) }),
    ...(suggestion.confidence !== undefined ? { confidence: suggestion.confidence } : {}),
    ...(suggestion.notes !== undefined ? { notes: suggestion.notes } : {}),
  });
}

// ---------------------------------------------------------------------------
// Provider-neutral port + bounded request rows
// ---------------------------------------------------------------------------

export interface AiAdvancedInterpretationRequestRow {
  readonly line_ref: string;
  readonly ingredient_text: string;
  readonly normalized_text?: string;
  readonly amount?: number;
  readonly unit?: string;
  readonly issue_kind?: AiResolutionIssueKind;
}

export interface AiAdvancedInterpretationRequest {
  readonly contract_version: typeof AI_ADVANCED_CONTRACT_VERSION;
  readonly rows: ReadonlyArray<AiAdvancedInterpretationRequestRow>;
}

/**
 * The provider-neutral port the nutrition domain owns. Any adapter (BYOK
 * provider, Kitchen Codex-hosted provider, test double) implements this and
 * returns RAW output that must pass `sanitizeAiAdvancedInterpretationResponse`.
 * No provider SDK type ever crosses this boundary.
 */
export interface AiAdvancedInterpretationPort {
  readonly id: string;
  interpret(request: AiAdvancedInterpretationRequest): Promise<unknown>;
}

/** Builds bounded, minimal request rows (no vault data, no credentials). */
export function buildAiAdvancedInterpretationRequest(
  rows: ReadonlyArray<{
    readonly line_ref: string;
    readonly ingredient_text: string;
    readonly normalized_text?: string;
    readonly amount?: number | null;
    readonly unit?: string;
    readonly issue_kind?: AiResolutionIssueKind;
  }>
): AiAdvancedInterpretationRequest {
  const bounded: AiAdvancedInterpretationRequestRow[] = [];
  for (const row of rows.slice(0, MAX_AI_ADVANCED_ROWS)) {
    const text = typeof row.ingredient_text === 'string' ? row.ingredient_text.trim() : '';
    if (text.length === 0 || text.length > MAX_AI_ADVANCED_DOCUMENT_TEXT) continue;
    const normalized =
      typeof row.normalized_text === 'string' && row.normalized_text.trim().length > 0
        ? row.normalized_text.trim().slice(0, MAX_AI_ADVANCED_DOCUMENT_TEXT)
        : undefined;
    const amount =
      typeof row.amount === 'number' && Number.isFinite(row.amount) && row.amount > 0
        ? row.amount
        : undefined;
    const unit =
      typeof row.unit === 'string' && row.unit.trim().length > 0
        ? row.unit.trim().slice(0, MAX_AI_ADVANCED_TOKEN_LENGTH)
        : undefined;
    bounded.push(
      Object.freeze({
        line_ref: row.line_ref.slice(0, MAX_AI_ADVANCED_LINE_REF_LENGTH),
        ingredient_text: text,
        ...(normalized !== undefined ? { normalized_text: normalized } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(unit !== undefined ? { unit } : {}),
        ...(row.issue_kind !== undefined ? { issue_kind: row.issue_kind } : {}),
      })
    );
  }
  return Object.freeze({ contract_version: AI_ADVANCED_CONTRACT_VERSION, rows: Object.freeze(bounded) });
}
