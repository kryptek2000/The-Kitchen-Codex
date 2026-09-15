/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: canonical record digest and
 * defensive re-validation.
 *
 * PURE, platform-neutral. A canonical record is immutable authority once
 * inserted into the local store. `validateCanonicalRecord` re-validates an
 * already-canonical value defensively (e.g. a forged or hand-built record)
 * before it can enter the store or the cache.
 */

import { isPlainObject, toInertValue } from '../schema';
import { isNutrientId, NUTRIENT_REGISTRY, type NutrientId } from '../nutrients';
import { isCanonicalUnit, isValidNutrientAmount, type CanonicalUnit } from '../units';
import { canonicalStringify, sha256Hex } from './digest';
import { getUsdaNutrientMapping } from './nutrientMap';
import {
  MAX_PORTION_AMOUNT,
  MAX_PORTION_GRAM_WEIGHT,
  MAX_USDA_CATEGORY_LENGTH,
  MAX_USDA_DESCRIPTION_LENGTH,
  MAX_USDA_MEASURE_LENGTH,
  MAX_USDA_MODIFIER_LENGTH,
  MAX_USDA_PORTIONS,
  MAX_USDA_RELEASE_ID_LENGTH,
  SHA256_HEX_PATTERN,
  USDA_DATA_TYPES,
  USDA_FOOD_BASIS,
  USDA_SOURCE_ID,
  type CanonicalNutrientRecord,
  type CanonicalPortionRecord,
  type CanonicalUsdaFoodRecord,
  type UsdaDataType,
} from './types';

/** A canonical record before its digest is attached. */
export type CanonicalUsdaFoodRecordContent = Omit<CanonicalUsdaFoodRecord, 'record_digest'>;

export type CanonicalRecordValidation =
  | { ok: true; record: CanonicalUsdaFoodRecord }
  | { ok: false; errors: string[] };

const NUTRIENT_RECORD_KEYS = new Set([
  'nutrient_id',
  'unit',
  'amount_per_100g',
  'usda_nutrient_id',
  'source_unit',
  'converted',
]);
const PORTION_RECORD_KEYS = new Set([
  'usda_portion_id',
  'amount',
  'measure',
  'gram_weight',
  'modifier',
  'sequence',
]);
const RECORD_KEYS = new Set([
  'source',
  'bundle_release',
  'upstream_release',
  'fdc_id',
  'data_type',
  'description',
  'food_category',
  'nutrient_map_version',
  'basis',
  'nutrients',
  'portions',
  'record_digest',
]);

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Canonicalizes bounded display text: strips controls, collapses whitespace. */
export function canonicalizeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * True when text carries markup or URLs that must never be retained. A bare `>`
 * and a comparison like `=<21.2g/100g` are ordinary prose (both appear in the
 * pinned FNDDS categories), so only a tag-opening `<` (followed by a letter,
 * `/`, `!`, or `?`) and URL forms are rejected.
 */
export function containsUnsafeText(value: string): boolean {
  return /<\s*[a-zA-Z!/?]/.test(value) || /https?:\/\//i.test(value) || /www\./i.test(value);
}

/** A valid positive safe-integer USDA FDC id. */
export function isValidFdcId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Deterministic SHA-256 over canonical content (excluding the digest field). */
export function computeCanonicalRecordDigest(content: CanonicalUsdaFoodRecordContent): string {
  return sha256Hex(canonicalStringify(content));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Attaches the deterministic digest and deep-freezes the canonical record. */
export function withCanonicalRecordDigest(content: CanonicalUsdaFoodRecordContent): CanonicalUsdaFoodRecord {
  const record: CanonicalUsdaFoodRecord = {
    ...content,
    record_digest: computeCanonicalRecordDigest(content),
  };
  return deepFreeze(record);
}

function validateNutrientEntry(
  id: NutrientId,
  raw: unknown,
  diag: string[]
): CanonicalNutrientRecord | undefined {
  if (!isPlainObject(raw)) {
    diag.push('invalid_nutrient_record');
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!NUTRIENT_RECORD_KEYS.has(key)) diag.push('unknown_nutrient_record_field');
  }
  if (raw.nutrient_id !== id) diag.push('nutrient_id_mismatch');
  const definition = NUTRIENT_REGISTRY[id];
  if (!isCanonicalUnit(raw.unit) || raw.unit !== definition.unit) diag.push('nutrient_unit_mismatch');
  if (!isValidNutrientAmount(raw.amount_per_100g)) diag.push('invalid_amount');
  if (!isValidFdcId(raw.usda_nutrient_id)) diag.push('invalid_usda_nutrient_id');
  if (typeof raw.source_unit !== 'string' || raw.source_unit.length < 1 || raw.source_unit.length > 8) {
    diag.push('invalid_source_unit');
  }
  if (typeof raw.converted !== 'boolean') diag.push('invalid_converted');
  const mapping = getUsdaNutrientMapping(raw.usda_nutrient_id);
  if (!mapping) {
    diag.push('unmapped_usda_nutrient');
  } else {
    if (mapping.nutrient_id !== id) diag.push('nutrient_mapping_mismatch');
    if (mapping.canonical_unit !== raw.unit) diag.push('nutrient_mapping_unit_mismatch');
    if (mapping.source_unit !== raw.source_unit) diag.push('nutrient_source_unit_mismatch');
  }
  if (diag.length > 0) return undefined;
  return {
    nutrient_id: id,
    unit: raw.unit as CanonicalUnit,
    amount_per_100g: raw.amount_per_100g as number,
    usda_nutrient_id: raw.usda_nutrient_id as number,
    source_unit: raw.source_unit as string,
    converted: raw.converted as boolean,
  };
}

function validatePortionEntry(raw: unknown, diag: string[]): CanonicalPortionRecord | undefined {
  if (!isPlainObject(raw)) {
    diag.push('invalid_portion_record');
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!PORTION_RECORD_KEYS.has(key)) diag.push('unknown_portion_record_field');
  }
  if (hasOwn(raw, 'usda_portion_id') && !isValidFdcId(raw.usda_portion_id)) {
    diag.push('invalid_portion_id');
  }
  // `amount` is OPTIONAL: FNDDS portions legitimately omit it. When present it
  // must satisfy the canonical numeric contract AND be strictly positive and
  // within the portion bound (rejecting 0, -0, negatives, non-finite,
  // over-precise, unsafe, and excessive values).
  if (hasOwn(raw, 'amount')) {
    if (!isValidNutrientAmount(raw.amount) || (raw.amount as number) <= 0 || (raw.amount as number) > MAX_PORTION_AMOUNT) {
      diag.push('invalid_portion_amount');
    }
  }
  if (typeof raw.measure !== 'string' || raw.measure.length < 1 || raw.measure.length > MAX_USDA_MEASURE_LENGTH) {
    diag.push('invalid_portion_measure');
  }
  if (
    typeof raw.gram_weight !== 'number' ||
    !Number.isFinite(raw.gram_weight) ||
    Object.is(raw.gram_weight, -0) ||
    raw.gram_weight <= 0 ||
    raw.gram_weight > MAX_PORTION_GRAM_WEIGHT
  ) {
    diag.push('invalid_portion_gram_weight');
  }
  if (hasOwn(raw, 'modifier') && (typeof raw.modifier !== 'string' || raw.modifier.length > MAX_USDA_MODIFIER_LENGTH)) {
    diag.push('invalid_portion_modifier');
  }
  if (hasOwn(raw, 'sequence') && (!Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 0)) {
    diag.push('invalid_portion_sequence');
  }
  if (diag.length > 0) return undefined;
  return {
    ...(hasOwn(raw, 'usda_portion_id') ? { usda_portion_id: raw.usda_portion_id as number } : {}),
    ...(hasOwn(raw, 'amount') ? { amount: raw.amount as number } : {}),
    measure: raw.measure as string,
    gram_weight: raw.gram_weight as number,
    ...(hasOwn(raw, 'modifier') ? { modifier: raw.modifier as string } : {}),
    ...(hasOwn(raw, 'sequence') ? { sequence: raw.sequence as number } : {}),
  };
}

/**
 * Strictly re-validates an already-canonical record from an untrusted value.
 * Materializes inertly first; unknown fields, mapping inconsistencies, invalid
 * amounts/portions, and a mismatched digest all fail closed. Never throws.
 */
export function validateCanonicalRecord(raw: unknown): CanonicalRecordValidation {
  try {
    const materialized = toInertValue(raw);
    if (!materialized.ok) {
      return { ok: false, errors: [`unsafe_record:${(materialized as { ok: false; reason: string }).reason}`] };
    }
    if (!isPlainObject(materialized.value)) return { ok: false, errors: ['not_an_object'] };
    const value = materialized.value;
    const diag: string[] = [];
    for (const key of Object.keys(value)) {
      if (!RECORD_KEYS.has(key)) diag.push('unknown_field');
    }

    if (value.source !== USDA_SOURCE_ID) diag.push('invalid_source');
    if (typeof value.bundle_release !== 'string' || value.bundle_release.length < 1 || value.bundle_release.length > MAX_USDA_RELEASE_ID_LENGTH) {
      diag.push('invalid_bundle_release');
    }
    if (typeof value.upstream_release !== 'string' || value.upstream_release.length < 1 || value.upstream_release.length > MAX_USDA_RELEASE_ID_LENGTH) {
      diag.push('invalid_upstream_release');
    }
    if (!isValidFdcId(value.fdc_id)) diag.push('invalid_fdc_id');
    if (typeof value.data_type !== 'string' || !(USDA_DATA_TYPES as ReadonlyArray<string>).includes(value.data_type)) {
      diag.push('invalid_data_type');
    }
    if (typeof value.description !== 'string' || value.description.length < 1 || value.description.length > MAX_USDA_DESCRIPTION_LENGTH) {
      diag.push('invalid_description');
    }
    if (hasOwn(value, 'food_category')) {
      if (typeof value.food_category !== 'string' || value.food_category.length > MAX_USDA_CATEGORY_LENGTH) {
        diag.push('invalid_food_category');
      }
    }
    if (typeof value.nutrient_map_version !== 'string' || value.nutrient_map_version.length < 1) {
      diag.push('invalid_nutrient_map_version');
    }
    if (value.basis !== USDA_FOOD_BASIS) diag.push('invalid_basis');

    const nutrients: Partial<Record<NutrientId, CanonicalNutrientRecord>> = {};
    if (!isPlainObject(value.nutrients)) {
      diag.push('invalid_nutrients');
    } else {
      const keys = Object.keys(value.nutrients);
      if (keys.length > Object.keys(NUTRIENT_REGISTRY).length) diag.push('too_many_nutrients');
      for (const key of keys) {
        if (!isNutrientId(key)) {
          diag.push('unknown_nutrient_id');
          continue;
        }
        const before = diag.length;
        const result = validateNutrientEntry(key, (value.nutrients as Record<string, unknown>)[key], diag);
        if (result && diag.length === before) nutrients[key] = result;
      }
    }

    const portions: CanonicalPortionRecord[] = [];
    if (!Array.isArray(value.portions) || value.portions.length > MAX_USDA_PORTIONS) {
      diag.push('invalid_portions');
    } else {
      for (const entry of value.portions) {
        const before = diag.length;
        const portion = validatePortionEntry(entry, diag);
        if (portion && diag.length === before) portions.push(portion);
      }
    }

    if (!SHA256_HEX_PATTERN.test(value.record_digest as string)) diag.push('invalid_record_digest');

    if (diag.length > 0) return { ok: false, errors: diag.slice(0, 32) };

    const record: CanonicalUsdaFoodRecord = {
      source: USDA_SOURCE_ID,
      bundle_release: value.bundle_release as string,
      upstream_release: value.upstream_release as string,
      fdc_id: value.fdc_id as number,
      data_type: value.data_type as UsdaDataType,
      description: value.description as string,
      ...(hasOwn(value, 'food_category') ? { food_category: value.food_category as string } : {}),
      nutrient_map_version: value.nutrient_map_version as string,
      basis: USDA_FOOD_BASIS,
      nutrients,
      portions,
      record_digest: value.record_digest as string,
    };

    const expected = computeCanonicalRecordDigest({
      source: record.source,
      bundle_release: record.bundle_release,
      upstream_release: record.upstream_release,
      fdc_id: record.fdc_id,
      data_type: record.data_type,
      description: record.description,
      ...(record.food_category !== undefined ? { food_category: record.food_category } : {}),
      nutrient_map_version: record.nutrient_map_version,
      basis: record.basis,
      nutrients: record.nutrients,
      portions: record.portions,
    });
    if (expected !== record.record_digest) return { ok: false, errors: ['digest_mismatch'] };

    return { ok: true, record: deepFreeze(record) };
  } catch {
    return { ok: false, errors: ['validation_error'] };
  }
}
