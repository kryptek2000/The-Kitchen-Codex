/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5C: canonical USDA portion
 * semantics (pure, deterministic, versioned).
 *
 * This module understands the three canonical USDA portion shapes WITHOUT
 * altering the checked-in artifact:
 *
 *   1. Foundation   — numeric `amount` + a real `measure` unit (+ optional
 *                     descriptive `modifier`).
 *   2. SR Legacy    — `measure: "undetermined"`; the real unit is the leading
 *                     anchored token of `modifier` (e.g. `cup`, `cup, chopped`,
 *                     `tbsp`, `fl oz`).
 *   3. FNDDS        — no `amount`; `measure` embeds an explicit amount + unit
 *                     (e.g. `1 cup`, `1 fl oz`); `modifier` is a numeric source
 *                     code that is NEVER shown as a human descriptor.
 *
 * A normalized portion is a closed, versioned representation. A missing amount
 * is NEVER defaulted to one, and an unsupported / ambiguous shape is `unusable`.
 * No density, count-weight, or average-cup inference is ever performed here.
 *
 * PURE, platform-neutral, offline. It imports only the canonical measurement
 * layer and Phase 0/1 pure contracts; it imports no React/application/browser/
 * server/persistence module.
 */

import { isPlainObject, toInertValue } from '../schema';
import {
  convertMassToGrams,
  convertVolumeToMl,
  getMeasurementKind,
  normalizeUnit,
  parseAmount,
  type MeasurementKind,
  type NormalizedUnit,
} from '../../../utils/measurements';

/** Explicit portion-semantics version (part of selection bindings/digests). */
export const PORTION_SEMANTICS_VERSION = 'usda_portion_semantics_v1';

export type PortionKind = 'volume' | 'mass' | 'count' | 'unusable';

export type PortionAmountSource = 'raw_amount' | 'measure_text' | 'modifier_text' | 'none';

export type PortionCompatibility = 'compatible' | 'incompatible' | 'unusable';

export interface NormalizedPortion {
  readonly semantics_version: string;
  readonly index: number;
  readonly kind: PortionKind;
  /** Positive finite effective amount, or null when unusable. */
  readonly amount: number | null;
  readonly unit: NormalizedUnit | null;
  /** Bounded raw unit token for display (e.g. `cup`, `piece`). */
  readonly raw_unit: string | null;
  /** Exact canonical volume in ml for a volume portion, else null. */
  readonly volume_ml: number | null;
  /** Portion's own mass in grams for a mass portion, else null. */
  readonly mass_grams: number | null;
  readonly gram_weight: number | null;
  readonly amount_source: PortionAmountSource;
  /** Optional bounded preparation/size descriptor (never a numeric code). */
  readonly descriptor: string | null;
  /** Safe, bounded human label (e.g. `1 cup = 122 g`). */
  readonly display_label: string;
  /** Raw canonical fields retained for identity validation. */
  readonly raw_measure: string;
  readonly raw_amount: number | null;
  readonly raw_modifier: string | null;
  readonly raw_gram_weight: number | null;
}

const MAX_DESCRIPTOR_LENGTH = 60;
const MAX_LABEL_LENGTH = 80;

const UNIT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  g: 'g',
  kg: 'kg',
  oz: 'oz',
  lb: 'lb',
  ml: 'ml',
  l: 'l',
  tsp: 'tsp',
  tbsp: 'tbsp',
  fl_oz: 'fl oz',
  cup: 'cup',
  pint: 'pint',
  quart: 'quart',
  gallon: 'gallon',
});

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && !Object.is(value, -0);
}

function boundedText(value: string, max: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function unitLabel(unit: NormalizedUnit | null, rawUnit: string | null): string {
  if (unit && UNIT_LABELS[unit]) return UNIT_LABELS[unit];
  if (rawUnit) return boundedText(rawUnit, 16).toLowerCase();
  return 'unit';
}

function kindForUnit(unit: NormalizedUnit | undefined): PortionKind {
  if (!unit) return 'unusable';
  const kind = getMeasurementKind(unit);
  if (kind === 'mass') return 'mass';
  if (kind === 'volume') return 'volume';
  if (kind === 'count') return 'count';
  return 'unusable';
}

interface LeadingUnit {
  readonly unit: NormalizedUnit | undefined;
  readonly rawUnit: string;
  readonly rest: string;
}

/**
 * Recognizes an ANCHORED leading unit token in a text (used for SR Legacy
 * `modifier` and FNDDS measure remainders). A unit substring in the middle of a
 * word is never treated as a measure.
 */
function parseLeadingUnit(text: string): LeadingUnit {
  const trimmed = text.trim();
  if (!trimmed) return { unit: undefined, rawUnit: '', rest: '' };
  const two = trimmed.match(/^(\S+\s+\S+)/);
  if (two) {
    const first = two[1].split(/\s+/)[0].toLowerCase();
    if (first === 'fl' || first === 'fluid') {
      const unit = normalizeUnit(two[1]);
      if (unit) return { unit, rawUnit: two[1], rest: trimmed.slice(two[1].length).replace(/^[,\s]+/, '').trim() };
    }
  }
  const one = trimmed.match(/^([^,\s]+)/);
  if (!one) return { unit: undefined, rawUnit: '', rest: '' };
  const rawUnit = one[1];
  const rest = trimmed.slice(rawUnit.length).replace(/^[,\s]+/, '').trim();
  return { unit: normalizeUnit(rawUnit), rawUnit, rest };
}

interface PortionShape {
  readonly kind: PortionKind;
  readonly amount: number | null;
  readonly unit: NormalizedUnit | null;
  readonly rawUnit: string | null;
  readonly amountSource: PortionAmountSource;
  readonly descriptor: string | null;
}

const UNUSABLE: PortionShape = {
  kind: 'unusable',
  amount: null,
  unit: null,
  rawUnit: null,
  amountSource: 'none',
  descriptor: null,
};

function shapeFromMeasure(measure: string, rawAmount: unknown): PortionShape {
  const unit = normalizeUnit(measure);
  const kind = kindForUnit(unit);
  if (kind === 'unusable') return UNUSABLE;
  if (!isPositiveFinite(rawAmount)) return UNUSABLE;
  return { kind, amount: rawAmount, unit: unit as NormalizedUnit, rawUnit: measure, amountSource: 'raw_amount', descriptor: null };
}

function shapeFromUndeterminedModifier(modifier: string, rawAmount: unknown): PortionShape {
  if (!isPositiveFinite(rawAmount)) return UNUSABLE;
  const leading = parseLeadingUnit(modifier);
  const kind = kindForUnit(leading.unit);
  if (kind === 'unusable') return UNUSABLE;
  return {
    kind,
    amount: rawAmount,
    unit: leading.unit as NormalizedUnit,
    rawUnit: leading.rawUnit,
    amountSource: 'modifier_text',
    descriptor: leading.rest ? boundedText(leading.rest, MAX_DESCRIPTOR_LENGTH) : null,
  };
}

function shapeFromEmbeddedMeasure(measure: string): PortionShape {
  const leading = measure.match(
    /^\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+\s*[½⅓⅔¼¾⅛⅜⅝⅞]|[½⅓⅔¼¾⅛⅜⅝⅞]|\d+(?:\.\d+)?)\s*([\s\S]*)$/
  );
  if (!leading) return UNUSABLE;
  const amount = parseAmount(leading[1]);
  if (!isPositiveFinite(amount)) return UNUSABLE;
  const rest = leading[2].trim();
  const unitPart = parseLeadingUnit(rest);
  const kind = kindForUnit(unitPart.unit);
  if (kind === 'unusable') return UNUSABLE;
  return {
    kind,
    amount,
    unit: unitPart.unit as NormalizedUnit,
    rawUnit: unitPart.rawUnit,
    amountSource: 'measure_text',
    descriptor: unitPart.rest ? boundedText(unitPart.rest, MAX_DESCRIPTOR_LENGTH) : null,
  };
}

/** True when a canonical measure string is the SR Legacy placeholder. */
export function isUndeterminedMeasure(measure: unknown): boolean {
  return typeof measure === 'string' && measure.trim().toLowerCase() === 'undetermined';
}

/**
 * Normalizes ONE canonical portion (already validated by Phase 1) into a closed
 * semantics value. Never throws; a malformed value yields `unusable`.
 */
export function normalizePortionSemantics(raw: unknown, index: number): NormalizedPortion {
  const safeIndex = Number.isSafeInteger(index) && index >= 0 ? index : 0;
  const materialized = toInertValue(raw);
  if (!materialized.ok || !isPlainObject(materialized.value)) {
    return Object.freeze({
      semantics_version: PORTION_SEMANTICS_VERSION,
      index: safeIndex,
      kind: 'unusable' as const,
      amount: null,
      unit: null,
      raw_unit: null,
      volume_ml: null,
      mass_grams: null,
      gram_weight: null,
      amount_source: 'none' as const,
      descriptor: null,
      display_label: 'No usable amount',
      raw_measure: '',
      raw_amount: null,
      raw_modifier: null,
      raw_gram_weight: null,
    });
  }
  const value = materialized.value;
  const measure = typeof value.measure === 'string' ? value.measure : '';
  const rawAmount = typeof value.amount === 'number' ? value.amount : null;
  const rawModifier = typeof value.modifier === 'string' ? value.modifier : null;
  const gramWeight = isPositiveFinite(value.gram_weight) ? value.gram_weight : null;

  let shape: PortionShape;
  if (measure.trim().length > 0 && !isUndeterminedMeasure(measure)) {
    const directUnit = normalizeUnit(measure);
    if (directUnit !== undefined) {
      shape = shapeFromMeasure(measure, rawAmount);
    } else {
      // FNDDS embeds the amount+unit in the measure text.
      shape = shapeFromEmbeddedMeasure(measure);
    }
  } else if (isUndeterminedMeasure(measure)) {
    shape = shapeFromUndeterminedModifier(rawModifier ?? '', rawAmount);
  } else if (rawModifier) {
    shape = shapeFromUndeterminedModifier(rawModifier, rawAmount);
  } else {
    shape = UNUSABLE;
  }

  const usable = shape.kind !== 'unusable' && shape.amount !== null && gramWeight !== null;
  const kind: PortionKind = usable ? shape.kind : 'unusable';
  const amount = usable ? shape.amount : null;
  const unit = usable ? shape.unit : null;
  const volumeMl = kind === 'volume' && amount !== null && unit ? convertVolumeToMl(amount, unit) ?? null : null;
  const massGrams = kind === 'mass' && amount !== null && unit ? convertMassToGrams(amount, unit) ?? null : null;

  let displayLabel: string;
  if (kind === 'unusable' || amount === null || gramWeight === null) {
    displayLabel = 'No usable amount';
  } else {
    displayLabel = boundedText(
      `${amount} ${unitLabel(unit, shape.rawUnit)} = ${gramWeight} g`,
      MAX_LABEL_LENGTH
    );
  }

  return Object.freeze({
    semantics_version: PORTION_SEMANTICS_VERSION,
    index: safeIndex,
    kind,
    amount,
    unit,
    raw_unit: shape.rawUnit ? boundedText(shape.rawUnit, 24) : null,
    volume_ml: volumeMl,
    mass_grams: massGrams,
    gram_weight: kind === 'unusable' ? null : gramWeight,
    amount_source: usable ? shape.amountSource : 'none',
    descriptor: usable ? shape.descriptor : null,
    display_label: displayLabel,
    raw_measure: measure,
    raw_amount: rawAmount,
    raw_modifier: rawModifier,
    raw_gram_weight: gramWeight,
  });
}

/** Computes compatibility of a normalized portion with an ingredient dimension. */
export function portionCompatibility(
  portion: NormalizedPortion,
  measurementKind: MeasurementKind
): PortionCompatibility {
  if (portion.kind === 'unusable' || portion.amount === null || portion.gram_weight === null) {
    return 'unusable';
  }
  if (measurementKind === 'mass' && portion.kind === 'mass') return 'compatible';
  if (measurementKind === 'volume' && portion.kind === 'volume') return 'compatible';
  return 'incompatible';
}

/** Compatibility for a bounded candidate view (structural subset of a portion). */
export function candidatePortionCompatibility(
  candidate: { readonly kind: PortionKind; readonly effective_amount: number | null; readonly gram_weight: number },
  measurementKind: MeasurementKind
): PortionCompatibility {
  if (candidate.kind === 'unusable' || candidate.effective_amount === null || !(candidate.gram_weight > 0)) {
    return 'unusable';
  }
  if (measurementKind === 'mass' && candidate.kind === 'mass') return 'compatible';
  if (measurementKind === 'volume' && candidate.kind === 'volume') return 'compatible';
  return 'incompatible';
}

export interface PortionMeasurement {
  readonly kind: MeasurementKind;
  readonly grams: number | undefined;
  readonly milliliters: number | undefined;
}

/**
 * Resolves the mass in grams for a compatible normalized portion. Volume scales
 * by EXACT canonical volume; mass scales by the portion's own mass. Returns
 * undefined when incompatible, unusable, or non-finite/overflowing.
 */
export function resolvePortionMassFromSemantics(
  portion: NormalizedPortion,
  measurement: PortionMeasurement,
  maxGrams: number
): number | undefined {
  if (portionCompatibility(portion, measurement.kind) !== 'compatible') return undefined;
  if (portion.amount === null || portion.gram_weight === null) return undefined;

  let resolved: number;
  if (portion.kind === 'volume') {
    const recipeMl = measurement.milliliters;
    if (recipeMl === undefined || !Number.isFinite(recipeMl) || recipeMl < 0 || portion.volume_ml === null || portion.volume_ml <= 0) {
      return undefined;
    }
    resolved = (recipeMl / portion.volume_ml) * portion.gram_weight;
  } else {
    const recipeGrams = measurement.grams;
    if (recipeGrams === undefined || !Number.isFinite(recipeGrams) || recipeGrams < 0 || portion.mass_grams === null || portion.mass_grams <= 0) {
      return undefined;
    }
    resolved = (recipeGrams / portion.mass_grams) * portion.gram_weight;
  }

  if (!Number.isFinite(resolved) || resolved < 0 || Object.is(resolved, -0)) return undefined;
  if (resolved > maxGrams) return undefined;
  return resolved;
}
