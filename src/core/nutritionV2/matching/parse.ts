/**
 * The Kitchen Codex — Advanced Nutrition Phase 2: defensive ingredient parsing.
 *
 * PURE, offline. Accepts a bounded raw ingredient string OR the repository's
 * structured ingredient shape (as `unknown`), materializes it through the
 * existing safe inert-value boundary, and derives a bounded review view WITHOUT
 * mutating the source.
 *
 * It reuses the canonical measurement primitives (`normalizeIngredientMeasurement`,
 * `parseAmount`, `normalizeUnit`) and the deterministic line segmenter
 * (`parseRawIngredientMeasurementParts`) — no competing fraction parser or unit system.
 *
 * HONESTY RULES
 *  - a missing amount stays null (never defaulted to 1);
 *  - volume yields milliliters only (never grams);
 *  - count yields a count classification only (never grams);
 *  - unknown / "pinch" / "dash" / "to taste" stay unmeasurable (never grams);
 *  - an oversized line is REJECTED, never silently truncated to a different
 *    valid ingredient;
 *  - the source object and any wikilinks are preserved untouched.
 */

import { isPlainObject, toInertValue } from '../schema';
import {
  normalizeIngredientMeasurement,
  parseAmount,
  parseRawIngredientMeasurementParts,
  type MeasurementKind,
  type NormalizedUnit,
} from '../../../utils/measurements';
import {
  MAX_INGREDIENT_LINE_REF_LENGTH,
  MAX_INGREDIENT_NOTE_LENGTH,
  MAX_INGREDIENT_TEXT_LENGTH,
  phase2Failure,
  type IngredientParseResult,
  type ParsedIngredientReview,
} from './types';

const STRUCTURED_KEYS = new Set([
  'original',
  'amount',
  'unit',
  'name',
  'wikilink',
  'wikilinkTarget',
  'wikilinkAlias',
  'note',
  'isChecked',
  'line_ref',
  'index',
]);

function failure(code: Parameters<typeof phase2Failure>[0]): IngredientParseResult {
  return { ok: false, failure: phase2Failure(code) };
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? undefined : value;
}

/**
 * Parses one ingredient (raw string or structured object) into a bounded review
 * view. Never throws; every failure is a closed, bounded classification.
 */
export function parseIngredient(raw: unknown): IngredientParseResult {
  try {
    if (typeof raw === 'string') return parseRawLine(raw);

    const materialized = toInertValue(raw);
    if (!materialized.ok) {
      const reason = (materialized as { ok: false; reason: string }).reason;
      if (
        reason === 'dangerous_key' ||
        reason === 'accessor_or_hidden_property' ||
        reason === 'array_accessor_or_hole' ||
        reason === 'reflection_failed' ||
        reason === 'cycle' ||
        reason === 'symbol_key'
      ) {
        return failure('unsafe_input');
      }
      if (reason === 'oversized') return failure('oversized_input');
      return failure('invalid_input');
    }
    if (!isPlainObject(materialized.value)) return failure('invalid_input');
    const source = materialized.value;

    for (const key of Object.keys(source)) {
      if (!STRUCTURED_KEYS.has(key)) return failure('unknown_field');
    }

    // Original text (bounded). Required as the base display/reference text.
    const original = boundedText(source.original, MAX_INGREDIENT_TEXT_LENGTH);
    if (source.original !== undefined && original === undefined) return failure('oversized_input');

    // Amount: absent/null stays null; present must parse to a finite number.
    let amount: number | null = null;
    if (source.amount !== undefined && source.amount !== null) {
      if (typeof source.amount !== 'number' && typeof source.amount !== 'string') {
        return failure('invalid_amount');
      }
      amount = parseAmount(source.amount as number | string);
      if (amount === null) return failure('invalid_amount');
    }

    // Unit (bounded).
    const unit = boundedText(source.unit, MAX_INGREDIENT_TEXT_LENGTH);
    if (source.unit !== undefined && source.unit !== null && unit === undefined) {
      return failure('oversized_input');
    }

    // Name (bounded).
    const name = boundedText(source.name, MAX_INGREDIENT_TEXT_LENGTH);
    if (source.name !== undefined && source.name !== null && name === undefined) {
      return failure('oversized_input');
    }

    // Non-authoritative note (bounded, optional).
    let note: string | undefined;
    if (source.note !== undefined && source.note !== null) {
      const boundedNote = boundedText(source.note, MAX_INGREDIENT_NOTE_LENGTH);
      if (boundedNote === undefined) return failure('oversized_input');
      const trimmedNote = boundedNote.trim();
      if (trimmedNote.length > 0) note = trimmedNote;
    }

    // Stable line reference (caller-supplied line_ref or index; else original).
    let lineRef: string;
    if (source.line_ref !== undefined && source.line_ref !== null) {
      const boundedRef = boundedText(source.line_ref, MAX_INGREDIENT_LINE_REF_LENGTH);
      if (boundedRef === undefined || boundedRef.trim().length === 0) return failure('invalid_line_ref');
      lineRef = boundedRef.trim();
    } else if (source.index !== undefined && source.index !== null) {
      if (
        typeof source.index !== 'number' ||
        !Number.isSafeInteger(source.index) ||
        Object.is(source.index, -0) ||
        source.index < 0
      ) {
        return failure('invalid_line_ref');
      }
      lineRef = `line:${source.index}`;
    } else {
      lineRef = original ?? name ?? '';
    }

    // Derive the food-name query. Never invent a food name.
    let query = (name ?? '').trim();
    if (!query) {
      const base = (original ?? '').trim();
      if (base) query = parseRawIngredientMeasurementParts(base).name.trim();
      if (!query) query = base;
    }
    if (query.length === 0) return failure('empty_query');
    if (query.length > MAX_INGREDIENT_TEXT_LENGTH) return failure('oversized_input');

    const originalText = (original ?? name ?? query).trim();

    const measurement = normalizeIngredientMeasurement({ amount, unit, name: query });
    return {
      ok: true,
      parsed: {
        line_ref: lineRef.length > 0 ? lineRef : originalText,
        original_text: originalText,
        amount: measurement.amount,
        raw_unit: measurement.rawUnit,
        normalized_unit: measurement.normalizedUnit as NormalizedUnit,
        measurement_kind: measurement.kind as MeasurementKind,
        grams: measurement.grams,
        milliliters: measurement.milliliters,
        count: measurement.kind === 'count',
        query,
        note,
      },
    };
  } catch {
    return failure('validation_error');
  }
}

function parseRawLine(raw: string): IngredientParseResult {
  if (raw.length > MAX_INGREDIENT_TEXT_LENGTH) return failure('oversized_input');
  const trimmed = raw.trim();
  if (trimmed.length === 0) return failure('empty_query');
  const parts = parseRawIngredientMeasurementParts(trimmed);
  const query = parts.name.trim();
  if (query.length === 0) return failure('empty_query');
  if (query.length > MAX_INGREDIENT_TEXT_LENGTH) return failure('oversized_input');

  const measurement = normalizeIngredientMeasurement({
    amount: parts.amount,
    unit: parts.unit,
    name: query,
  });
  return {
    ok: true,
    parsed: {
      line_ref: trimmed,
      original_text: trimmed,
      amount: measurement.amount,
      raw_unit: measurement.rawUnit,
      normalized_unit: measurement.normalizedUnit as NormalizedUnit,
      measurement_kind: measurement.kind as MeasurementKind,
      grams: measurement.grams,
      milliliters: measurement.milliliters,
      count: measurement.kind === 'count',
      query,
      note: undefined,
    },
  };
}
