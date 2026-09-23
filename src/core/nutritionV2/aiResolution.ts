/**
 * The Kitchen Codex — Advanced Nutrition: AI-assisted USDA resolution contract.
 *
 * PURE, platform-neutral, offline. This module owns the STRICT, bounded contract
 * between the application and the server-side AI resolver. The model is treated
 * as fully UNTRUSTED: its response is advisory interpretation ONLY and is
 * sanitized field-by-field before it can influence anything.
 *
 * HARD RULES
 * ----------
 *  - AI may suggest an interpreted food name, bounded USDA search phrases, a
 *    short note, and a coarse confidence category.
 *  - AI NEVER supplies authority: no FDC id, no record/catalog digest, no
 *    nutrient amount, no mass, no portion, no Apply token. Any response that
 *    carries an unknown/forbidden field is REJECTED whole (fail closed), never
 *    partially trusted.
 *  - Suggestions are matched against the pinned local USDA catalog and re-ranked
 *    by the existing deterministic confidence contract before any selection;
 *    authority stays deterministic. Since v2, local resolution additionally
 *    re-checks every accepted candidate against the AUTHENTICATED source line's
 *    negative container/state/form constraints (reconstructed locally from the
 *    session-bound row), so provider wording can never erase a source constraint.
 *  - Ingredient text is DATA, never instructions (prompt-injection resistance is
 *    enforced on the server prompt AND here by strict shape validation).
 */

import { isPlainObject, toInertValue } from './schema';

export const AI_RESOLUTION_VERSION = 'nutrition_ai_resolution_v2';

/** Bounds (mirrored by the server route). */
export const MAX_AI_RESOLUTION_ROWS = 25;
export const MAX_AI_RESOLUTION_TEXT = 300;
export const MAX_AI_RESOLUTION_QUERIES = 4;
export const MAX_AI_RESOLUTION_QUERY_LENGTH = 120;
export const MAX_AI_RESOLUTION_NOTE_LENGTH = 300;
export const MAX_AI_RESOLUTION_NAME_LENGTH = 120;
export const MAX_AI_RESOLUTION_HINT_LENGTH = 60;
export const MAX_AI_RESOLUTION_PORTION_HINT_LENGTH = 120;
export const MAX_AI_RESOLUTION_QUANTITY = 1_000_000;

/**
 * Bounded, trusted issue classification supplied by the APPLICATION (never
 * inferred by the model from prose). It tells the resolver WHY a row was sent so
 * the model can focus its interpretation:
 *   - needs_match:        no confident food identity at all
 *   - review_suggested:   a credible food candidate needs confirmation
 *   - needs_amount:       food identity resolved; amount/count/portion unknown
 */
export type AiResolutionIssueKind = 'needs_match' | 'review_suggested' | 'needs_amount';

export const AI_RESOLUTION_ISSUE_KINDS: ReadonlyArray<AiResolutionIssueKind> = Object.freeze([
  'needs_match',
  'review_suggested',
  'needs_amount',
]);

function isAiResolutionIssueKind(value: unknown): value is AiResolutionIssueKind {
  return (
    typeof value === 'string' &&
    (AI_RESOLUTION_ISSUE_KINDS as ReadonlyArray<string>).includes(value)
  );
}

/** One bounded unresolved-ingredient row sent to the resolver. */
export interface AiResolutionRequestRow {
  readonly line_ref: string;
  readonly ingredient_text: string;
  readonly normalized_text?: string;
  readonly amount?: number;
  readonly unit?: string;
  readonly qualifiers?: ReadonlyArray<string>;
  readonly reason?: string;
  /** Trusted application state; never inferred by the model. */
  readonly issue_kind?: AiResolutionIssueKind;
}

export type AiResolutionConfidence = 'high' | 'medium' | 'low';

/**
 * One validated advisory suggestion. Carries NO authority: the food fields are
 * interpretation/search wording only; the amount fields are bounded
 * interpretations of the recipe's OWN quantity/count language. There is
 * deliberately NO field for a gram weight, FDC id, nutrient, portion index,
 * digest, or Apply token.
 */
export interface AiResolutionSuggestion {
  readonly line_ref: string;
  readonly interpreted_food_name: string;
  readonly suggested_usda_queries: ReadonlyArray<string>;
  readonly notes?: string;
  readonly confidence?: AiResolutionConfidence;
  /** Optional normalized food search wording (no FDC identity). */
  readonly normalized_food_query?: string;
  /** Optional preparation interpretation (e.g. `minced`). */
  readonly preparation_hint?: string;
  /** Optional echo/interpretation of the recipe's own count value. */
  readonly quantity_value?: number;
  /** Optional count unit wording (e.g. `cloves`); never a gram value. */
  readonly quantity_unit_hint?: string;
  /** Optional count descriptor (e.g. `clove`, `slice`). */
  readonly count_descriptor_hint?: string;
  /** Optional authenticated-USDA portion search wording (e.g. `clove`). */
  readonly portion_search_hint?: string;
  /** Optional bounded short explanation. */
  readonly explanation?: string;
}

export type AiResolutionFailureCode =
  | 'invalid_response'
  | 'unsafe_response'
  | 'oversized_response'
  | 'unknown_line_ref'
  | 'duplicate_line_ref';

export interface AiResolutionSanitizeOptions {
  /** The exact line_refs the caller asked about. */
  readonly allowedLineRefs: ReadonlyArray<string>;
  /** Optional cap (clamped to MAX_AI_RESOLUTION_ROWS). */
  readonly maxRows?: number;
}

export type AiResolutionSanitizeResult =
  | { readonly ok: true; readonly suggestions: ReadonlyArray<AiResolutionSuggestion> }
  | { readonly ok: false; readonly code: AiResolutionFailureCode };

const SUGGESTION_KEYS = new Set([
  'line_ref',
  'interpreted_food_name',
  'suggested_usda_queries',
  'notes',
  'confidence',
  'normalized_food_query',
  'preparation_hint',
  'quantity_value',
  'quantity_unit_hint',
  'count_descriptor_hint',
  'portion_search_hint',
  'explanation',
]);
const ENVELOPE_KEYS = new Set(['version', 'suggestions']);
const CONFIDENCE_VALUES: ReadonlyArray<AiResolutionConfidence> = ['high', 'medium', 'low'];

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/**
 * Bounded positive quantity interpretation. It NEVER participates in mass
 * authority (the calculator derives mass only from the recipe's own parsed
 * quantity plus an authenticated USDA portion).
 */
function boundedQuantity(value: unknown): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    Object.is(value, -0) ||
    value > MAX_AI_RESOLUTION_QUANTITY
  ) {
    return undefined;
  }
  return value;
}

/**
 * Strictly sanitizes one AI resolver response against the requested line_refs.
 * Never throws; every failure is a closed, bounded classification. A forbidden or
 * unknown field causes the WHOLE response to be rejected.
 */
export function sanitizeAiResolutionResponse(
  raw: unknown,
  options: AiResolutionSanitizeOptions
): AiResolutionSanitizeResult {
  let materialized: unknown;
  try {
    const result = toInertValue(raw);
    if (!result.ok) {
      const reason = (result as { ok: false; reason: string }).reason;
      return {
        ok: false,
        code: reason === 'oversized' ? 'oversized_response' : 'unsafe_response',
      };
    }
    materialized = result.value;
  } catch {
    return { ok: false, code: 'unsafe_response' };
  }

  if (!isPlainObject(materialized)) return { ok: false, code: 'invalid_response' };
  for (const key of Object.keys(materialized)) {
    if (!ENVELOPE_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
  }
  if (!Array.isArray(materialized.suggestions)) return { ok: false, code: 'invalid_response' };
  const maxRows = Math.min(
    typeof options.maxRows === 'number' && Number.isSafeInteger(options.maxRows) && options.maxRows > 0
      ? options.maxRows
      : MAX_AI_RESOLUTION_ROWS,
    MAX_AI_RESOLUTION_ROWS
  );
  if (materialized.suggestions.length > maxRows) return { ok: false, code: 'invalid_response' };

  const allowed = new Set(options.allowedLineRefs);
  const seen = new Set<string>();
  const out: AiResolutionSuggestion[] = [];

  for (const entry of materialized.suggestions) {
    if (!isPlainObject(entry)) return { ok: false, code: 'invalid_response' };
    for (const key of Object.keys(entry)) {
      if (!SUGGESTION_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
    }

    const lineRef = boundedString(entry.line_ref, 200);
    if (lineRef === undefined) return { ok: false, code: 'invalid_response' };
    if (!allowed.has(lineRef)) return { ok: false, code: 'unknown_line_ref' };
    if (seen.has(lineRef)) return { ok: false, code: 'duplicate_line_ref' };
    seen.add(lineRef);

    const foodName = boundedString(entry.interpreted_food_name, MAX_AI_RESOLUTION_NAME_LENGTH);
    if (foodName === undefined) return { ok: false, code: 'invalid_response' };

    const rawQueries = entry.suggested_usda_queries;
    if (!Array.isArray(rawQueries) || rawQueries.length > MAX_AI_RESOLUTION_QUERIES) {
      return { ok: false, code: 'invalid_response' };
    }
    const queries: string[] = [];
    for (const query of rawQueries) {
      const bounded = boundedString(query, MAX_AI_RESOLUTION_QUERY_LENGTH);
      if (bounded === undefined) return { ok: false, code: 'invalid_response' };
      queries.push(bounded);
    }

    let notes: string | undefined;
    if (entry.notes !== undefined && entry.notes !== null) {
      notes = boundedString(entry.notes, MAX_AI_RESOLUTION_NOTE_LENGTH);
      if (notes === undefined) return { ok: false, code: 'invalid_response' };
    }

    let confidence: AiResolutionConfidence | undefined;
    if (entry.confidence !== undefined && entry.confidence !== null) {
      if (
        typeof entry.confidence !== 'string' ||
        !CONFIDENCE_VALUES.includes(entry.confidence as AiResolutionConfidence)
      ) {
        return { ok: false, code: 'invalid_response' };
      }
      confidence = entry.confidence as AiResolutionConfidence;
    }

    const normalizedFoodQuery = optionalField(entry, 'normalized_food_query', MAX_AI_RESOLUTION_NAME_LENGTH);
    if (normalizedFoodQuery.malformed) return { ok: false, code: 'invalid_response' };
    const preparationHint = optionalField(entry, 'preparation_hint', MAX_AI_RESOLUTION_HINT_LENGTH);
    if (preparationHint.malformed) return { ok: false, code: 'invalid_response' };
    const quantityUnitHint = optionalField(entry, 'quantity_unit_hint', MAX_AI_RESOLUTION_HINT_LENGTH);
    if (quantityUnitHint.malformed) return { ok: false, code: 'invalid_response' };
    const countDescriptorHint = optionalField(entry, 'count_descriptor_hint', MAX_AI_RESOLUTION_HINT_LENGTH);
    if (countDescriptorHint.malformed) return { ok: false, code: 'invalid_response' };
    const portionSearchHint = optionalField(entry, 'portion_search_hint', MAX_AI_RESOLUTION_PORTION_HINT_LENGTH);
    if (portionSearchHint.malformed) return { ok: false, code: 'invalid_response' };
    const explanation = optionalField(entry, 'explanation', MAX_AI_RESOLUTION_NOTE_LENGTH);
    if (explanation.malformed) return { ok: false, code: 'invalid_response' };
    let quantityValue: number | undefined;
    if (entry.quantity_value !== undefined && entry.quantity_value !== null) {
      quantityValue = boundedQuantity(entry.quantity_value);
      if (quantityValue === undefined) return { ok: false, code: 'invalid_response' };
    }

    out.push(
      Object.freeze({
        line_ref: lineRef,
        interpreted_food_name: foodName,
        suggested_usda_queries: Object.freeze(queries),
        ...(notes !== undefined ? { notes } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(normalizedFoodQuery.value !== undefined ? { normalized_food_query: normalizedFoodQuery.value } : {}),
        ...(preparationHint.value !== undefined ? { preparation_hint: preparationHint.value } : {}),
        ...(quantityValue !== undefined ? { quantity_value: quantityValue } : {}),
        ...(quantityUnitHint.value !== undefined ? { quantity_unit_hint: quantityUnitHint.value } : {}),
        ...(countDescriptorHint.value !== undefined ? { count_descriptor_hint: countDescriptorHint.value } : {}),
        ...(portionSearchHint.value !== undefined ? { portion_search_hint: portionSearchHint.value } : {}),
        ...(explanation.value !== undefined ? { explanation: explanation.value } : {}),
      })
    );
  }

  return { ok: true, suggestions: Object.freeze(out) };
}

/**
 * Optional bounded string field. Absent/null -> `{ ok: true, value: undefined }`;
 * a present malformed value (wrong type, empty, or oversized) -> `malformed`.
 */
function optionalField(
  entry: Record<string, unknown>,
  key: string,
  max: number
): { readonly malformed: boolean; readonly value?: string } {
  const raw = entry[key];
  if (raw === undefined || raw === null) return { malformed: false };
  const bounded = boundedString(raw, max);
  if (bounded === undefined) return { malformed: true };
  return { malformed: false, value: bounded };
}

/**
 * The provider-neutral structured-output schema for the AI resolver. Only
 * advisory fields are declared; `additionalProperties: false` is set by the
 * strict provider schema converter where supported, and the sanitizer enforces it
 * regardless.
 */
export function buildAiResolutionSchema(): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
} {
  return {
    type: 'object',
    properties: {
      version: { type: 'number' },
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line_ref: { type: 'string' },
            interpreted_food_name: { type: 'string' },
            suggested_usda_queries: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            normalized_food_query: { type: 'string' },
            preparation_hint: { type: 'string' },
            quantity_value: { type: 'number' },
            quantity_unit_hint: { type: 'string' },
            count_descriptor_hint: { type: 'string' },
            portion_search_hint: { type: 'string' },
            explanation: { type: 'string' },
          },
          required: ['line_ref', 'interpreted_food_name', 'suggested_usda_queries'],
        },
      },
    },
    required: ['version', 'suggestions'],
  };
}

/**
 * Builds bounded, minimal request rows from already-adapted unresolved working
 * rows. Only the fields the resolver genuinely needs are included; no vault data,
 * no credentials, no unrelated recipe state.
 */
export function buildAiResolutionRequestRows(
  rows: ReadonlyArray<{
    readonly line_ref: string;
    readonly ingredient_text: string;
    readonly normalized_text?: string;
    readonly amount?: number | null;
    readonly unit?: string;
    readonly qualifiers?: ReadonlyArray<string>;
    readonly reason?: string;
    readonly issue_kind?: AiResolutionIssueKind;
  }>
): ReadonlyArray<AiResolutionRequestRow> {
  const bounded: AiResolutionRequestRow[] = [];
  for (const row of rows.slice(0, MAX_AI_RESOLUTION_ROWS)) {
    const text = typeof row.ingredient_text === 'string' ? row.ingredient_text.trim() : '';
    if (text.length === 0 || text.length > MAX_AI_RESOLUTION_TEXT) continue;
    const normalized =
      typeof row.normalized_text === 'string' && row.normalized_text.trim().length > 0
        ? row.normalized_text.trim().slice(0, MAX_AI_RESOLUTION_TEXT)
        : undefined;
    const amount =
      typeof row.amount === 'number' && Number.isFinite(row.amount) && row.amount > 0
        ? row.amount
        : undefined;
    const unit =
      typeof row.unit === 'string' && row.unit.trim().length > 0
        ? row.unit.trim().slice(0, 40)
        : undefined;
    const qualifiers = Array.isArray(row.qualifiers)
      ? row.qualifiers
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .slice(0, 8)
          .map((value) => value.trim().slice(0, 40))
      : undefined;
    const reason =
      typeof row.reason === 'string' && row.reason.trim().length > 0
        ? row.reason.trim().slice(0, 80)
        : undefined;
    bounded.push(
      Object.freeze({
        line_ref: row.line_ref.slice(0, 200),
        ingredient_text: text,
        ...(normalized !== undefined ? { normalized_text: normalized } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(unit !== undefined ? { unit } : {}),
        ...(qualifiers !== undefined && qualifiers.length > 0 ? { qualifiers: Object.freeze(qualifiers) } : {}),
        ...(reason !== undefined ? { reason } : {}),
        // Trusted application state only; an unrecognized value is omitted
        // (the server independently re-validates the closed enum).
        ...(isAiResolutionIssueKind(row.issue_kind) ? { issue_kind: row.issue_kind } : {}),
      })
    );
  }
  return Object.freeze(bounded);
}
