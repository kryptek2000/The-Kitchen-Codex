/**
 * The Kitchen Codex — USDA Branded Foods evidence contract.
 *
 * PURE, platform-neutral, offline. This module owns the bounded request/response
 * shapes, the defensive adapter for supported USDA FoodData Central Branded API
 * records, deterministic label/basis handling, and the conversion of one
 * explicitly selected product into an existing source-backed nutrition
 * contribution.
 *
 * A branded record is NOT a generic USDA composition record. It is a
 * manufacturer-supplied label snapshot hosted by USDA. It is therefore always
 * treated as external, source-backed evidence and is never injected into the
 * pinned Foundation/SR Legacy/FNDDS catalog.
 *
 * BASIS POLICY
 * ------------
 * Label nutrients are authoritative PER THE PUBLISHED SERVING. The serving is
 * usable only when its unit can be resolved to grams or millilitres without
 * guessing. Household serving text alone never establishes a mass. Per-100-g
 * USDA standardized values are used only when the serving unit is a mass unit;
 * volume records never treat per-100 values as grams. Missing nutrients remain
 * absent, explicit zero remains zero, and label rounding is preserved.
 */

import { isValidNutrientAmount, type CanonicalUnit } from './units';
import { NUTRIENT_IDS, NUTRIENT_REGISTRY, type NutrientId } from './nutrients';
import { canonicalStringify, sha256Hex } from './usda/digest';
import {
  applyUsdaNutrientConversion,
  getUsdaNutrientMapping,
  normalizeUsdaUnitName,
} from './usda/nutrientMap';
import { isPlainObject, toInertValue } from './schema';
import type { AiNutrientContribution } from './aiContribution';

export const USDA_BRANDED_FOOD_CONTRACT_VERSION = 'usda_branded_food_v1' as const;
export const USDA_BRANDED_API_RELEASE_ID = 'usda_fdc_branded_api_v1' as const;
export const USDA_BRANDED_LOOKUP_REQUEST_VERSION = 'usda_branded_lookup_request_v1' as const;
export const USDA_BRANDED_LOOKUP_RESPONSE_VERSION = 'usda_branded_lookup_response_v1' as const;
export const USDA_BRANDED_VERIFICATION_REQUEST_VERSION = 'usda_branded_verification_request_v1' as const;
export const USDA_BRANDED_VERIFICATION_RESPONSE_VERSION = 'usda_branded_verification_response_v1' as const;
export const MAX_BRANDED_VERIFICATION_ITEMS = 3;
export const MAX_BRANDED_QUERY_LENGTH = 120;
export const MAX_BRANDED_CANDIDATES = 3;
export const MAX_BRANDED_NUTRIENTS = 64;
export const MAX_BRANDED_SERVING = 100_000;
export const MAX_BRANDED_SCALE = 100_000;

const CONTROL = /[\u0000-\u001f\u007f]/;
const FDC_ID_MIN = 1;
const FDC_ID_MAX = Number.MAX_SAFE_INTEGER;
const SNAPSHOT_PREFIX = 'sha256:';

export type BrandedLookupFailureCode =
  | 'invalid_request'
  | 'not_configured'
  | 'auth_failed'
  | 'rate_limited'
  | 'not_found'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'invalid_response'
  | 'no_candidates';

export interface BrandedLookupRequest {
  readonly request_version: typeof USDA_BRANDED_LOOKUP_REQUEST_VERSION;
  readonly line_ref: string;
  readonly query: string;
}

export interface BrandedLookupTarget {
  readonly line_ref: string;
  readonly ingredient_text: string;
  readonly query: string;
  readonly amount: number | null;
  readonly unit: string | null;
  readonly measurement_kind: 'mass' | 'volume' | 'count' | 'unknown';
  readonly quantity_grams?: number;
  readonly quantity_ml?: number;
}

export type BrandedNutrientBasis =
  | 'per_serving_g'
  | 'per_serving_ml'
  | 'per_100_g'
  | 'unsupported';

export type BrandedMatchQuality = 'strong' | 'possible' | 'weak';

export interface BrandedNutrientValue {
  readonly amount: number;
  readonly unit: CanonicalUnit;
}

export interface BrandedServing {
  readonly amount: number;
  readonly unit: string;
  readonly household?: string;
}

export interface UsdaBrandedFoodCandidate {
  readonly contract_version: typeof USDA_BRANDED_FOOD_CONTRACT_VERSION;
  readonly source: 'usda_fdc_branded';
  readonly fdc_id: number;
  readonly description: string;
  readonly brand_owner?: string;
  readonly brand_name?: string;
  readonly data_type: 'Branded';
  readonly gtin_upc?: string;
  readonly publication_date?: string;
  readonly modified_date?: string;
  readonly serving?: BrandedServing;
  readonly basis: BrandedNutrientBasis;
  readonly serving_grams?: number;
  readonly serving_ml?: number;
  /** Nutrient amounts for `basis`. Never mixed across bases. */
  readonly nutrients: Readonly<Partial<Record<NutrientId, BrandedNutrientValue>>>;
  readonly standardized_basis?: 'per_100_g' | 'unknown';
  readonly standardized_nutrients?: Readonly<Partial<Record<NutrientId, BrandedNutrientValue>>>;
  readonly match_quality: BrandedMatchQuality;
  readonly match_reason: string;
  readonly usable: boolean;
  readonly limitations: ReadonlyArray<string>;
  readonly snapshot_digest: string;
  /** Server-issued handle for the trusted source snapshot (never client-authored). */
  readonly evidence_id?: string;
}

export interface BrandedLookupResponse {
  readonly ok: true;
  readonly request_version: typeof USDA_BRANDED_LOOKUP_RESPONSE_VERSION;
  readonly line_ref: string;
  readonly query: string;
  readonly total_hits: number;
  readonly candidates: ReadonlyArray<UsdaBrandedFoodCandidate>;
  readonly cache_status: 'hit' | 'miss';
  readonly retrieved_at: string;
  readonly signing_public_key: string;
  readonly signing_key_id: string;
  readonly limitations: ReadonlyArray<string>;
}

export type BrandedAdaptResult =
  | { readonly ok: true; readonly candidate: UsdaBrandedFoodCandidate }
  | { readonly ok: false; readonly code: string };

export type BrandedCandidateSanitizeResult =
  | { readonly ok: true; readonly candidate: UsdaBrandedFoodCandidate }
  | { readonly ok: false; readonly code: string };

const LABEL_NUTRIENTS: ReadonlyArray<{
  readonly key: string;
  readonly id: NutrientId;
}> = Object.freeze([
  { key: 'calories', id: 'calories' },
  { key: 'protein', id: 'protein' },
  { key: 'fat', id: 'fat' },
  { key: 'carbohydrates', id: 'carbohydrates' },
  { key: 'fiber', id: 'fiber' },
  { key: 'sugars', id: 'total_sugars' },
  { key: 'saturatedFat', id: 'saturated_fat' },
  { key: 'transFat', id: 'trans_fat' },
  { key: 'cholesterol', id: 'cholesterol' },
  { key: 'sodium', id: 'sodium' },
  { key: 'calcium', id: 'calcium' },
  { key: 'iron', id: 'iron' },
  { key: 'potassium', id: 'potassium' },
]);

const LABEL_KEY_BY_NUTRIENT = new Map<NutrientId, string>(
  LABEL_NUTRIENTS.map((entry) => [entry.id, entry.key])
);

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || CONTROL.test(trimmed)) return undefined;
  return trimmed;
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedText(value, max);
}

function safeFdcId(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < FDC_ID_MIN || value > FDC_ID_MAX) {
    return undefined;
  }
  return value;
}

function positiveNumber(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max || Object.is(value, -0)) {
    return undefined;
  }
  return value;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Canonical food-term projection used for the official USDA query. */
export function sanitizeBrandedQuery(raw: unknown): string | undefined {
  const text = boundedText(raw, MAX_BRANDED_QUERY_LENGTH);
  if (!text) return undefined;
  if (text.includes('://') || /^www\./i.test(text)) return undefined;
  const collapsed = text.replace(/\s+/g, ' ');
  if (collapsed.length < 2) return undefined;
  return collapsed;
}

/** Reads the exact bounded client lookup request (food term only). */
export function readBrandedLookupRequest(raw: unknown): BrandedLookupRequest | undefined {
  const materialized = toInertValue(raw);
  if (!materialized.ok || !isPlainObject(materialized.value)) return undefined;
  const value = materialized.value as Record<string, unknown>;
  if (value.request_version !== USDA_BRANDED_LOOKUP_REQUEST_VERSION) return undefined;
  const lineRef = boundedText(value.line_ref, 500);
  const query = sanitizeBrandedQuery(value.query);
  if (!lineRef || !query) return undefined;
  return Object.freeze({
    request_version: USDA_BRANDED_LOOKUP_REQUEST_VERSION,
    line_ref: lineRef,
    query,
  });
}

/** Escapes a term for a bounded local description match (never a network URL). */
function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const QUERY_STOPWORDS = new Set(['the', 'and', 'with', 'for', 'from', 'style', 'flavor', 'flavour']);
const MISMATCH_TERMS = ['chip', 'chips', 'snack', 'candy', 'cookie', 'cereal', 'soda', 'drink', 'beverage'];

function matchQuality(query: string, description: string, brandOwner?: string, brandName?: string): {
  readonly quality: BrandedMatchQuality;
  readonly reason: string;
} {
  const queryTokens = normalizeSearchText(query)
    .split(' ')
    .filter((token) => token.length >= 2 && !QUERY_STOPWORDS.has(token));
  if (queryTokens.length === 0) {
    return { quality: 'weak', reason: 'The search term was too generic to evaluate.' };
  }
  const candidateText = normalizeSearchText(`${description} ${brandOwner ?? ''} ${brandName ?? ''}`);
  const hits = queryTokens.filter((token) => candidateText.includes(token)).length;
  const coverage = hits / queryTokens.length;
  const hasUnexpectedForm = MISMATCH_TERMS.some(
    (term) => candidateText.includes(term) && !queryTokens.some((token) => token.includes(term))
  );
  if (coverage >= 1 && !hasUnexpectedForm) {
    return { quality: 'strong', reason: 'Every search term appears in the product description or brand.' };
  }
  if (coverage >= 0.5 && !hasUnexpectedForm) {
    return { quality: 'possible', reason: 'Some search terms appear in the product description or brand; review the product identity.' };
  }
  return {
    quality: 'weak',
    reason: hasUnexpectedForm
      ? 'The product appears to be a different food form from the search term.'
      : 'Few or none of the search terms appear in the product description.',
  };
}

function servingUnitKind(unit: string): 'mass' | 'volume' | 'unknown' {
  const normalized = unit.trim().toLowerCase().replace(/\./g, '');
  if (
    normalized === 'g' || normalized === 'gram' || normalized === 'grams' ||
    normalized === 'kg' || normalized === 'kilogram' || normalized === 'kilograms' ||
    normalized === 'mg' || normalized === 'milligram' || normalized === 'milligrams' ||
    normalized === 'oz' || normalized === 'ounce' || normalized === 'ounces' ||
    normalized === 'lb' || normalized === 'lbs' || normalized === 'pound' || normalized === 'pounds'
  ) {
    return 'mass';
  }
  if (
    normalized === 'ml' || normalized === 'milliliter' || normalized === 'milliliters' ||
    normalized === 'l' || normalized === 'liter' || normalized === 'liters' ||
    normalized === 'fl oz' || normalized === 'floz' || normalized === 'fluid ounce' || normalized === 'fluid ounces'
  ) {
    return 'volume';
  }
  return 'unknown';
}

function servingGrams(amount: number, unit: string): number | undefined {
  const normalized = unit.trim().toLowerCase().replace(/\./g, '');
  switch (normalized) {
    case 'g': case 'gram': case 'grams': return round6(amount);
    case 'kg': case 'kilogram': case 'kilograms': return round6(amount * 1000);
    case 'mg': case 'milligram': case 'milligrams': return round6(amount / 1000);
    case 'oz': case 'ounce': case 'ounces': return round6(amount * 28.349523125);
    case 'lb': case 'lbs': case 'pound': case 'pounds': return round6(amount * 453.59237);
    default: return undefined;
  }
}

function servingMilliliters(amount: number, unit: string): number | undefined {
  const normalized = unit.trim().toLowerCase().replace(/\./g, '');
  switch (normalized) {
    case 'ml': case 'milliliter': case 'milliliters': return round6(amount);
    case 'l': case 'liter': case 'liters': return round6(amount * 1000);
    case 'fl oz': case 'floz': case 'fluid ounce': case 'fluid ounces': return round6(amount * 29.5735295625);
    default: return undefined;
  }
}

/** Reads labelNutrients, the only per-serving nutrient source in the API. */
function readLabelNutrients(raw: unknown): { ok: true; nutrients: Partial<Record<NutrientId, BrandedNutrientValue>> } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, nutrients: {} };
  if (!isPlainObject(raw)) return { ok: false };
  const nutrients: Partial<Record<NutrientId, BrandedNutrientValue>> = {};
  for (const { key, id } of LABEL_NUTRIENTS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const entry = (raw as Record<string, unknown>)[key];
    if (entry === null || entry === undefined) continue;
    if (!isPlainObject(entry)) return { ok: false };
    const value = (entry as Record<string, unknown>).value;
    if (!isValidNutrientAmount(value)) return { ok: false };
    const definition = NUTRIENT_REGISTRY[id];
    nutrients[id] = Object.freeze({ amount: value as number, unit: definition.unit });
  }
  return { ok: true, nutrients };
}

/** Reads standardized API foodNutrients and applies the existing nutrient map. */
function readStandardizedNutrients(raw: unknown): {
  ok: true;
  nutrients: Partial<Record<NutrientId, BrandedNutrientValue>>;
} | { ok: false; code: string } {
  if (raw === undefined || raw === null) return { ok: true, nutrients: {} };
  if (!Array.isArray(raw) || raw.length > MAX_BRANDED_NUTRIENTS * 8) return { ok: false, code: 'invalid_nutrients' };
  const candidates = new Map<NutrientId, Array<{ amount: number; mapping: NonNullable<ReturnType<typeof getUsdaNutrientMapping>> }>>();
  for (const entry of raw) {
    if (!isPlainObject(entry)) return { ok: false, code: 'invalid_nutrients' };
    const descriptor = (entry as Record<string, unknown>).nutrient;
    if (!isPlainObject(descriptor)) return { ok: false, code: 'invalid_nutrients' };
    const id = (descriptor as Record<string, unknown>).id;
    const unitName = (descriptor as Record<string, unknown>).unitName;
    const amount = (entry as Record<string, unknown>).amount;
    if (amount === null || amount === undefined) continue;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof unitName !== 'string') {
      return { ok: false, code: 'invalid_nutrients' };
    }
    if (!isValidNutrientAmount(amount)) return { ok: false, code: 'invalid_nutrients' };
    const mapping = getUsdaNutrientMapping(id);
    if (!mapping) continue;
    const normalizedUnit = normalizeUsdaUnitName(unitName);
    if (normalizedUnit !== mapping.source_unit) return { ok: false, code: 'unit_mismatch' };
    const list = candidates.get(mapping.nutrient_id) ?? [];
    list.push({ amount: amount as number, mapping });
    candidates.set(mapping.nutrient_id, list);
  }
  const nutrients: Partial<Record<NutrientId, BrandedNutrientValue>> = {};
  for (const [nutrientId, list] of candidates) {
    let resolved = list;
    if (nutrientId === 'calories' && list.length > 1) {
      const bestRank = Math.min(...list.map((entry) => entry.mapping.energy_rank ?? Number.MAX_SAFE_INTEGER));
      resolved = list.filter((entry) => (entry.mapping.energy_rank ?? Number.MAX_SAFE_INTEGER) === bestRank);
    }
    if (resolved.length !== 1) return { ok: false, code: 'duplicate_nutrient' };
    const chosen = resolved[0];
    const converted = applyUsdaNutrientConversion(chosen.mapping, chosen.amount);
    if (!isValidNutrientAmount(converted)) return { ok: false, code: 'invalid_nutrients' };
    nutrients[nutrientId] = Object.freeze({
      amount: converted,
      unit: chosen.mapping.canonical_unit,
    });
  }
  return { ok: true, nutrients };
}

/** Canonical source snapshot bound by the accepted record digest. */
export function brandedSnapshotPayload(candidate: Omit<UsdaBrandedFoodCandidate, 'snapshot_digest' | 'match_quality' | 'match_reason' | 'usable' | 'limitations'>): Record<string, unknown> {
  return {
    contract_version: candidate.contract_version,
    source: candidate.source,
    fdc_id: candidate.fdc_id,
    description: candidate.description,
    ...(candidate.brand_owner !== undefined ? { brand_owner: candidate.brand_owner } : {}),
    ...(candidate.brand_name !== undefined ? { brand_name: candidate.brand_name } : {}),
    data_type: candidate.data_type,
    ...(candidate.gtin_upc !== undefined ? { gtin_upc: candidate.gtin_upc } : {}),
    ...(candidate.publication_date !== undefined ? { publication_date: candidate.publication_date } : {}),
    ...(candidate.modified_date !== undefined ? { modified_date: candidate.modified_date } : {}),
    ...(candidate.serving !== undefined
      ? {
          serving: {
            amount: candidate.serving.amount,
            unit: candidate.serving.unit,
            ...(candidate.serving.household !== undefined ? { household: candidate.serving.household } : {}),
          },
        }
      : {}),
    basis: candidate.basis,
    ...(candidate.serving_grams !== undefined ? { serving_grams: candidate.serving_grams } : {}),
    ...(candidate.serving_ml !== undefined ? { serving_ml: candidate.serving_ml } : {}),
    nutrients: candidate.nutrients,
    ...(candidate.standardized_basis !== undefined ? { standardized_basis: candidate.standardized_basis } : {}),
    ...(candidate.standardized_nutrients !== undefined ? { standardized_nutrients: candidate.standardized_nutrients } : {}),
  };
}

export function computeBrandedSnapshotDigest(
  candidate: Omit<UsdaBrandedFoodCandidate, 'snapshot_digest' | 'match_quality' | 'match_reason' | 'usable' | 'limitations'>
): string {
  return `${SNAPSHOT_PREFIX}${sha256Hex(canonicalStringify(brandedSnapshotPayload(candidate)))}`;
}

/**
 * Defensive adapter for one USDA Branded Foods API food-detail record.
 *
 * It accepts only the fields the API actually documents, validates every
 * nutrient value and unit, never invents a serving weight, and returns a
 * canonical candidate with an exact source-snapshot digest.
 */
export function adaptUsdaBrandedFoodRecord(raw: unknown, queryRaw: unknown): BrandedAdaptResult {
  const query = sanitizeBrandedQuery(queryRaw);
  if (!query) return { ok: false, code: 'invalid_query' };
  const materialized = toInertValue(raw);
  if (!materialized.ok || !isPlainObject(materialized.value)) return { ok: false, code: 'malformed' };
  const value = materialized.value as Record<string, unknown>;

  const fdcId = safeFdcId(value.fdcId);
  if (!fdcId) return { ok: false, code: 'invalid_fdc_id' };
  if (value.dataType !== 'Branded') return { ok: false, code: 'unsupported_data_type' };
  const description = boundedText(value.description, 500);
  if (!description) return { ok: false, code: 'invalid_description' };
  const brandOwnerRaw = value.brandOwner;
  const brandNameRaw = value.brandName;
  const brandOwner = optionalText(brandOwnerRaw, 200);
  const brandName = optionalText(brandNameRaw, 200);
  if (brandOwnerRaw !== undefined && brandOwnerRaw !== null && brandOwner === undefined) return { ok: false, code: 'invalid_brand' };
  if (brandNameRaw !== undefined && brandNameRaw !== null && brandName === undefined) return { ok: false, code: 'invalid_brand' };
  const gtinRaw = value.gtinUpc;
  let gtinUpc: string | undefined;
  if (gtinRaw !== undefined && gtinRaw !== null) {
    if (typeof gtinRaw !== 'string' || !/^[0-9]{8,14}$/.test(gtinRaw)) return { ok: false, code: 'invalid_gtin' };
    gtinUpc = gtinRaw;
  }
  const publicationDateRaw = value.publicationDate;
  const modifiedDateRaw = value.modifiedDate;
  const publicationDate = optionalText(publicationDateRaw, 40);
  const modifiedDate = optionalText(modifiedDateRaw, 40);
  if (publicationDateRaw !== undefined && publicationDateRaw !== null && publicationDate === undefined) return { ok: false, code: 'invalid_date' };
  if (modifiedDateRaw !== undefined && modifiedDateRaw !== null && modifiedDate === undefined) return { ok: false, code: 'invalid_date' };

  const servingAmount = value.servingSize === undefined || value.servingSize === null
    ? undefined
    : positiveNumber(value.servingSize, MAX_BRANDED_SERVING);
  if (value.servingSize !== undefined && value.servingSize !== null && servingAmount === undefined) {
    return { ok: false, code: 'invalid_serving' };
  }
  const servingUnitRaw = value.servingSizeUnit;
  const householdRaw = value.householdServingFullText;
  const servingUnit = optionalText(servingUnitRaw, 30);
  const household = optionalText(householdRaw, 120);
  if (servingUnitRaw !== undefined && servingUnitRaw !== null && servingUnit === undefined) return { ok: false, code: 'invalid_serving' };
  if (householdRaw !== undefined && householdRaw !== null && household === undefined) return { ok: false, code: 'invalid_serving' };
  const serving = servingAmount !== undefined && servingUnit !== undefined
    ? Object.freeze({
        amount: servingAmount,
        unit: servingUnit,
        ...(household !== undefined ? { household } : {}),
      })
    : undefined;

  const unitKind = servingUnit !== undefined ? servingUnitKind(servingUnit) : 'unknown';
  const grams = serving !== undefined && unitKind === 'mass' ? servingGrams(serving.amount, serving.unit) : undefined;
  const ml = serving !== undefined && unitKind === 'volume' ? servingMilliliters(serving.amount, serving.unit) : undefined;

  const label = readLabelNutrients(value.labelNutrients);
  if (!label.ok) return { ok: false, code: 'invalid_nutrients' };
  const standardized = readStandardizedNutrients(value.foodNutrients);
  if (!standardized.ok) return { ok: false, code: (standardized as { code: string }).code };

  const standardizedBasis: 'per_100_g' | 'unknown' | undefined = unitKind === 'mass' && Object.keys(standardized.nutrients).length > 0
    ? ('per_100_g' as const)
    : unitKind === 'volume'
      ? ('unknown' as const)
      : undefined;

  let basis: BrandedNutrientBasis = 'unsupported';
  let nutrients: Partial<Record<NutrientId, BrandedNutrientValue>> = {};
  if (Object.keys(label.nutrients).length > 0 && grams !== undefined) {
    basis = 'per_serving_g';
    nutrients = label.nutrients;
  } else if (Object.keys(label.nutrients).length > 0 && ml !== undefined) {
    basis = 'per_serving_ml';
    nutrients = label.nutrients;
  } else if (standardizedBasis === 'per_100_g' && Object.keys(standardized.nutrients).length > 0) {
    basis = 'per_100_g';
    nutrients = standardized.nutrients;
  }

  const limitations: string[] = [
    'USDA Branded Foods are manufacturer-supplied label records, not analytically measured generic foods.',
  ];
  if (basis === 'per_serving_g' || basis === 'per_serving_ml') {
    limitations.push('Values are per the published label serving; label rounding is preserved.');
  }
  if (basis === 'per_100_g') {
    limitations.push('Label nutrients were unavailable; values are USDA standardized per 100 g.');
  }
  if (basis === 'per_serving_ml') {
    limitations.push('The serving basis is volume; no gram weight or density is inferred.');
  }
  if (basis === 'unsupported') {
    limitations.push('No usable serving weight or volume was published; nutrition cannot be scaled.');
  }
  const match = matchQuality(query, description, brandOwner, brandName);
  if (match.quality === 'weak') {
    limitations.push('The product description does not closely match the search term; review before use.');
  }

  const usable = basis !== 'unsupported' && Object.keys(nutrients).length > 0;
  const base: Omit<UsdaBrandedFoodCandidate, 'snapshot_digest'> = {
    contract_version: USDA_BRANDED_FOOD_CONTRACT_VERSION,
    source: 'usda_fdc_branded',
    fdc_id: fdcId,
    description,
    ...(brandOwner !== undefined ? { brand_owner: brandOwner } : {}),
    ...(brandName !== undefined ? { brand_name: brandName } : {}),
    data_type: 'Branded',
    ...(gtinUpc !== undefined ? { gtin_upc: gtinUpc } : {}),
    ...(publicationDate !== undefined ? { publication_date: publicationDate } : {}),
    ...(modifiedDate !== undefined ? { modified_date: modifiedDate } : {}),
    ...(serving !== undefined ? { serving } : {}),
    basis,
    ...(grams !== undefined ? { serving_grams: grams } : {}),
    ...(ml !== undefined ? { serving_ml: ml } : {}),
    nutrients: Object.freeze(nutrients),
    ...(standardizedBasis !== undefined
      ? { standardized_basis: standardizedBasis as 'per_100_g' | 'unknown' }
      : {}),
    ...(Object.keys(standardized.nutrients).length > 0 ? { standardized_nutrients: Object.freeze(standardized.nutrients) } : {}),
    match_quality: match.quality,
    match_reason: match.reason,
    usable,
    limitations: Object.freeze(limitations),
  };
  const candidate: UsdaBrandedFoodCandidate = Object.freeze({
    ...base,
    snapshot_digest: computeBrandedSnapshotDigest(base),
  });
  return { ok: true, candidate };
}

/** Revalidates one already-canonical candidate returned by the server. */
export function sanitizeBrandedCandidate(raw: unknown): BrandedCandidateSanitizeResult {
  const materialized = toInertValue(raw);
  if (!materialized.ok || !isPlainObject(materialized.value)) return { ok: false, code: 'malformed' };
  const value = materialized.value as Record<string, unknown>;
  if (value.contract_version !== USDA_BRANDED_FOOD_CONTRACT_VERSION) return { ok: false, code: 'contract' };
  if (value.source !== 'usda_fdc_branded' || value.data_type !== 'Branded') return { ok: false, code: 'source' };
  const fdcId = safeFdcId(value.fdc_id);
  if (!fdcId) return { ok: false, code: 'fdc_id' };
  const description = boundedText(value.description, 500);
  if (!description) return { ok: false, code: 'description' };
  const basis = value.basis;
  if (basis !== 'per_serving_g' && basis !== 'per_serving_ml' && basis !== 'per_100_g' && basis !== 'unsupported') {
    return { ok: false, code: 'basis' };
  }
  const servingRaw = value.serving;
  let serving: BrandedServing | undefined;
  if (servingRaw !== undefined) {
    if (!isPlainObject(servingRaw)) return { ok: false, code: 'serving' };
    const amount = (servingRaw as Record<string, unknown>).amount;
    const unit = boundedText((servingRaw as Record<string, unknown>).unit, 30);
    if (!positiveNumber(amount, MAX_BRANDED_SERVING) || !unit) return { ok: false, code: 'serving' };
    const household = optionalText((servingRaw as Record<string, unknown>).household, 120);
    serving = Object.freeze({ amount: amount as number, unit, ...(household !== undefined ? { household } : {}) });
  }
  const readNutrientMap = (mapRaw: unknown): Partial<Record<NutrientId, BrandedNutrientValue>> | undefined => {
    if (mapRaw === undefined) return undefined;
    if (!isPlainObject(mapRaw)) return undefined;
    const out: Partial<Record<NutrientId, BrandedNutrientValue>> = {};
    for (const [key, nutrientRaw] of Object.entries(mapRaw as Record<string, unknown>)) {
      if (!NUTRIENT_IDS.includes(key as NutrientId) || !isPlainObject(nutrientRaw)) return undefined;
      const amount = (nutrientRaw as Record<string, unknown>).amount;
      const unit = (nutrientRaw as Record<string, unknown>).unit;
      const definition = NUTRIENT_REGISTRY[key as NutrientId];
      if (!isValidNutrientAmount(amount) || unit !== definition.unit) return undefined;
      out[key as NutrientId] = Object.freeze({ amount: amount as number, unit: definition.unit });
    }
    return out;
  };
  const nutrients = readNutrientMap(value.nutrients);
  if (!nutrients) return { ok: false, code: 'nutrients' };
  const standardizedNutrients = readNutrientMap(value.standardized_nutrients);
  if (value.standardized_nutrients !== undefined && !standardizedNutrients) return { ok: false, code: 'nutrients' };
  const standardizedBasis = value.standardized_basis;
  if (standardizedBasis !== undefined && standardizedBasis !== 'per_100_g' && standardizedBasis !== 'unknown') {
    return { ok: false, code: 'basis' };
  }
  const matchQuality = value.match_quality;
  if (matchQuality !== 'strong' && matchQuality !== 'possible' && matchQuality !== 'weak') {
    return { ok: false, code: 'match' };
  }
  const matchReason = boundedText(value.match_reason, 300);
  if (!matchReason) return { ok: false, code: 'match' };
  const limitationsRaw = value.limitations;
  if (!Array.isArray(limitationsRaw) || limitationsRaw.length > 12) return { ok: false, code: 'limitations' };
  const limitations: string[] = [];
  for (const entry of limitationsRaw) {
    const text = boundedText(entry, 500);
    if (!text) return { ok: false, code: 'limitations' };
    limitations.push(text);
  }
  const usable = value.usable === true;
  const evidenceId = optionalText(value.evidence_id, 80);
  if (value.evidence_id !== undefined && (evidenceId === undefined || evidenceId.length < 8)) {
    return { ok: false, code: 'evidence_id' };
  }
  const snapshotDigest = value.snapshot_digest;
  if (typeof snapshotDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(snapshotDigest)) {
    return { ok: false, code: 'digest' };
  }
  const base: Omit<UsdaBrandedFoodCandidate, 'snapshot_digest'> = {
    contract_version: USDA_BRANDED_FOOD_CONTRACT_VERSION,
    source: 'usda_fdc_branded',
    fdc_id: fdcId,
    description,
    ...(optionalText(value.brand_owner, 200) !== undefined ? { brand_owner: optionalText(value.brand_owner, 200)! } : {}),
    ...(optionalText(value.brand_name, 200) !== undefined ? { brand_name: optionalText(value.brand_name, 200)! } : {}),
    data_type: 'Branded',
    ...(optionalText(value.gtin_upc, 32) !== undefined ? { gtin_upc: optionalText(value.gtin_upc, 32)! } : {}),
    ...(optionalText(value.publication_date, 40) !== undefined ? { publication_date: optionalText(value.publication_date, 40)! } : {}),
    ...(optionalText(value.modified_date, 40) !== undefined ? { modified_date: optionalText(value.modified_date, 40)! } : {}),
    ...(serving !== undefined ? { serving } : {}),
    basis,
    ...(positiveNumber(value.serving_grams, MAX_BRANDED_SERVING) !== undefined ? { serving_grams: positiveNumber(value.serving_grams, MAX_BRANDED_SERVING)! } : {}),
    ...(positiveNumber(value.serving_ml, MAX_BRANDED_SERVING) !== undefined ? { serving_ml: positiveNumber(value.serving_ml, MAX_BRANDED_SERVING)! } : {}),
    nutrients: Object.freeze(nutrients),
    ...(standardizedBasis !== undefined
      ? { standardized_basis: standardizedBasis as 'per_100_g' | 'unknown' }
      : {}),
    ...(standardizedNutrients !== undefined ? { standardized_nutrients: Object.freeze(standardizedNutrients) } : {}),
    match_quality: matchQuality,
    match_reason: matchReason,
    usable,
    limitations: Object.freeze(limitations),
    ...(evidenceId !== undefined ? { evidence_id: evidenceId } : {}),
  };
  if (computeBrandedSnapshotDigest(base) !== snapshotDigest) return { ok: false, code: 'digest' };
  return { ok: true, candidate: Object.freeze({ ...base, snapshot_digest: snapshotDigest }) };
}

/** Reads and revalidates one bounded lookup response from the server. */
export function sanitizeBrandedLookupResponse(
  raw: unknown,
  expectedLineRef: string,
  expectedQuery: string
): { ok: true; response: BrandedLookupResponse } | { ok: false; code: string } {
  const materialized = toInertValue(raw);
  if (!materialized.ok || !isPlainObject(materialized.value)) return { ok: false, code: 'malformed' };
  const value = materialized.value as Record<string, unknown>;
  if (value.request_version !== USDA_BRANDED_LOOKUP_RESPONSE_VERSION) return { ok: false, code: 'version' };
  if (value.line_ref !== expectedLineRef) return { ok: false, code: 'line_ref' };
  const query = sanitizeBrandedQuery(value.query);
  if (!query || query !== sanitizeBrandedQuery(expectedQuery)) return { ok: false, code: 'query' };
  const totalHits = value.total_hits;
  if (typeof totalHits !== 'number' || !Number.isSafeInteger(totalHits) || totalHits < 0) {
    return { ok: false, code: 'total_hits' };
  }
  const cacheStatus = value.cache_status;
  if (cacheStatus !== 'hit' && cacheStatus !== 'miss') return { ok: false, code: 'cache' };
  const retrievedAt = boundedText(value.retrieved_at, 40);
  if (!retrievedAt) return { ok: false, code: 'retrieved_at' };
  const signingPublicKey = boundedText(value.signing_public_key, 4096);
  const signingKeyId = boundedText(value.signing_key_id, 64);
  if (!signingPublicKey || signingPublicKey.length < 40 || !signingKeyId || signingKeyId.length < 8) {
    return { ok: false, code: 'signing_key' };
  }
  if (!Array.isArray(value.candidates) || value.candidates.length > MAX_BRANDED_CANDIDATES) {
    return { ok: false, code: 'candidates' };
  }
  const candidates: UsdaBrandedFoodCandidate[] = [];
  const seen = new Set<number>();
  for (const item of value.candidates) {
    const candidate = sanitizeBrandedCandidate(item);
    if (!candidate.ok) return { ok: false, code: (candidate as { code: string }).code };
    if (seen.has(candidate.candidate.fdc_id)) return { ok: false, code: 'duplicate' };
    seen.add(candidate.candidate.fdc_id);
    candidates.push(candidate.candidate);
  }
  const limitationsRaw = value.limitations;
  if (!Array.isArray(limitationsRaw) || limitationsRaw.length > 12) return { ok: false, code: 'limitations' };
  const limitations: string[] = [];
  for (const entry of limitationsRaw) {
    const text = boundedText(entry, 500);
    if (!text) return { ok: false, code: 'limitations' };
    limitations.push(text);
  }
  return {
    ok: true,
    response: Object.freeze({
      ok: true,
      request_version: USDA_BRANDED_LOOKUP_RESPONSE_VERSION,
      line_ref: expectedLineRef,
      query,
      total_hits: totalHits,
      candidates: Object.freeze(candidates),
      cache_status: cacheStatus,
      retrieved_at: retrievedAt,
      signing_public_key: signingPublicKey,
      signing_key_id: signingKeyId,
      limitations: Object.freeze(limitations),
    }),
  };
}

/** True when a brand owner/name token appears in the authored ingredient text. */
export function brandedBrandAppearsInIngredient(
  candidate: UsdaBrandedFoodCandidate,
  ingredientText: string
): boolean {
  const ingredient = normalizeSearchText(ingredientText);
  const brandText = normalizeSearchText(`${candidate.brand_owner ?? ''} ${candidate.brand_name ?? ''}`);
  const tokens = brandText.split(' ').filter(
    (token) => token.length >= 3 && !['the', 'and', 'foods', 'food', 'company', 'inc', 'llc', 'brand', 'products'].includes(token)
  );
  return tokens.some((token) => ingredient.includes(token));
}

const HOUSEHOLD_VOLUME_ML: Readonly<Record<string, number>> = Object.freeze({
  tsp: 4.92892159375,
  teaspoon: 4.92892159375,
  teaspoons: 4.92892159375,
  tbsp: 14.78676478125,
  tablespoon: 14.78676478125,
  tablespoons: 14.78676478125,
  cup: 236.5882365,
  cups: 236.5882365,
  'fl oz': 29.5735295625,
  'floz': 29.5735295625,
  'fluid ounce': 29.5735295625,
  'fluid ounces': 29.5735295625,
  ml: 1,
  milliliter: 1,
  milliliters: 1,
  l: 1000,
  liter: 1000,
  liters: 1000,
});

/**
 * Parses a product's declared household serving (for example `2 tbsp` or
 * `1/2 cup`) into millilitres. This is used ONLY to apply the product's OWN
 * declared household-to-gram relationship when the recipe uses the same
 * household measure. It is never a generic density estimate.
 */
export function parseBrandedHouseholdVolumeMl(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?|\d+\s*\/\s*\d+)\s*([a-zA-Z][a-zA-Z .]*)\s*$/.exec(text);
  if (!match) return undefined;
  const rawAmount = match[1];
  let amount: number;
  if (rawAmount.includes('/')) {
    const [numerator, denominator] = rawAmount.split('/').map((part) => Number(part.trim()));
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return undefined;
    amount = numerator / denominator;
  } else {
    amount = Number(rawAmount);
  }
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2].trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  const ml = HOUSEHOLD_VOLUME_ML[unit];
  if (ml === undefined) return undefined;
  const total = amount * ml;
  return total > 0 ? total : undefined;
}

/** Strict local target binding used for deterministic branded scaling. */
export function sanitizeBrandedTarget(raw: unknown): BrandedLookupTarget | undefined {
  if (!isPlainObject(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const lineRef = boundedText(value.line_ref, 500);
  const ingredientText = boundedText(value.ingredient_text, 300);
  const query = sanitizeBrandedQuery(value.query);
  if (!lineRef || !ingredientText || !query) return undefined;
  const amount = value.amount === null ? null : finiteNonNegativeInput(value.amount);
  if (value.amount !== null && amount === undefined) return undefined;
  const unit = value.unit === null ? null : boundedText(value.unit, 60);
  if (value.unit !== null && unit === undefined) return undefined;
  const measurement = value.measurement_kind;
  if (measurement !== 'mass' && measurement !== 'volume' && measurement !== 'count' && measurement !== 'unknown') return undefined;
  const quantityGrams = value.quantity_grams === undefined ? undefined : positiveInput(value.quantity_grams);
  if (value.quantity_grams !== undefined && quantityGrams === undefined) return undefined;
  const quantityMl = value.quantity_ml === undefined ? undefined : positiveInput(value.quantity_ml);
  if (value.quantity_ml !== undefined && quantityMl === undefined) return undefined;
  return Object.freeze({
    line_ref: lineRef,
    ingredient_text: ingredientText,
    query,
    amount,
    unit,
    measurement_kind: measurement,
    ...(quantityGrams !== undefined ? { quantity_grams: quantityGrams } : {}),
    ...(quantityMl !== undefined ? { quantity_ml: quantityMl } : {}),
  }) as BrandedLookupTarget;
}

function finiteNonNegativeInput(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Object.is(value, -0)) return undefined;
  return value;
}

function positiveInput(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000) return undefined;
  return value;
}

export interface BrandedVerificationRequestItem {
  readonly evidence_id: string;
  readonly target: BrandedLookupTarget;
  readonly proposed_digest: string;
}

export interface BrandedVerificationRequest {
  readonly request_version: typeof USDA_BRANDED_VERIFICATION_REQUEST_VERSION;
  readonly recipe_digest: string;
  readonly review_identity: string;
  readonly items: ReadonlyArray<BrandedVerificationRequestItem>;
}

/** Reads the exact bounded verification request (no recipe/Vault payload). */
export function readBrandedVerificationRequest(raw: unknown): BrandedVerificationRequest | undefined {
  const materialized = toInertValue(raw);
  if (!materialized.ok || !isPlainObject(materialized.value)) return undefined;
  const value = materialized.value as Record<string, unknown>;
  if (value.request_version !== USDA_BRANDED_VERIFICATION_REQUEST_VERSION) return undefined;
  const recipeDigest = typeof value.recipe_digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.recipe_digest)
    ? value.recipe_digest
    : undefined;
  const reviewIdentity = boundedText(value.review_identity, 300);
  if (!recipeDigest || !reviewIdentity) return undefined;
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > MAX_BRANDED_VERIFICATION_ITEMS) return undefined;
  const items: BrandedVerificationRequestItem[] = [];
  const seenLines = new Set<string>();
  for (const itemRaw of value.items) {
    if (!isPlainObject(itemRaw)) return undefined;
    const item = itemRaw as Record<string, unknown>;
    const evidenceId = boundedText(item.evidence_id, 80);
    const target = sanitizeBrandedTarget(item.target);
    const proposedDigest = typeof item.proposed_digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(item.proposed_digest)
      ? item.proposed_digest
      : undefined;
    if (!evidenceId || evidenceId.length < 8 || !target || !proposedDigest || seenLines.has(target.line_ref)) return undefined;
    seenLines.add(target.line_ref);
    items.push(Object.freeze({ evidence_id: evidenceId, target, proposed_digest: proposedDigest }));
  }
  return Object.freeze({
    request_version: USDA_BRANDED_VERIFICATION_REQUEST_VERSION,
    recipe_digest: recipeDigest,
    review_identity: reviewIdentity,
    items: Object.freeze(items),
  });
}

export type BrandedContributionResult =
  | { readonly ok: true; readonly contribution: AiNutrientContribution }
  | { readonly ok: false; readonly reason: string };

/**
 * Deterministically converts one selected branded product into the existing
 * source-backed contribution shape. The client supplies the authored quantity;
 * the product supplies only its published nutrient basis. No density, gram
 * weight or nutrient is invented.
 */
export function buildBrandedContribution(
  candidate: UsdaBrandedFoodCandidate,
  target: BrandedLookupTarget
): BrandedContributionResult {
  if (!candidate.usable) return { ok: false, reason: 'missing_serving_basis' };
  if (target.query.length === 0 || target.ingredient_text.length === 0) return { ok: false, reason: 'invalid_target' };
  let factor: number | undefined;
  let basisDescription: string;
  let weightGrams = target.quantity_grams;
  let usedHouseholdRelationship = false;
  switch (candidate.basis) {
    case 'per_serving_g': {
      if (candidate.serving_grams === undefined || candidate.serving_grams <= 0) {
        return { ok: false, reason: 'missing_serving_basis' };
      }
      if (target.quantity_grams !== undefined && target.quantity_grams > 0) {
        factor = target.quantity_grams / candidate.serving_grams;
        basisDescription = `USDA Branded label serving (${candidate.serving_grams} g) scaled to ${round6(target.quantity_grams)} g`;
        break;
      }
      // A volume-authored line may use the product's OWN declared household
      // serving relationship (for example, "2 tbsp = 30 g"). This is not a
      // generic density guess: it is the label's verified mass for the exact
      // household measure, and only that measure family is accepted.
      const household = candidate.serving?.household;
      const householdMl = household !== undefined ? parseBrandedHouseholdVolumeMl(household) : undefined;
      if (target.quantity_ml === undefined || target.quantity_ml <= 0 || householdMl === undefined) {
        return { ok: false, reason: 'mass_required' };
      }
      factor = target.quantity_ml / householdMl;
      weightGrams = round6(candidate.serving_grams * factor);
      basisDescription = `USDA Branded label household serving (${household} = ${candidate.serving_grams} g) scaled to ${round6(target.quantity_ml)} ml (${weightGrams} g)`;
      usedHouseholdRelationship = true;
      break;
    }
    case 'per_serving_ml':
      if (target.quantity_ml === undefined || target.quantity_ml <= 0 || candidate.serving_ml === undefined) {
        return { ok: false, reason: 'volume_required' };
      }
      factor = target.quantity_ml / candidate.serving_ml;
      basisDescription = `USDA Branded label serving (${candidate.serving_ml} ml) scaled to ${round6(target.quantity_ml)} ml`;
      break;
    case 'per_100_g':
      if (target.quantity_grams === undefined || target.quantity_grams <= 0) {
        return { ok: false, reason: 'mass_required' };
      }
      factor = target.quantity_grams / 100;
      basisDescription = `USDA Branded standardized per 100 g scaled to ${round6(target.quantity_grams)} g`;
      break;
    default:
      return { ok: false, reason: 'missing_serving_basis' };
  }
  if (!Number.isFinite(factor) || factor <= 0 || factor > MAX_BRANDED_SCALE) {
    return { ok: false, reason: 'unsupported_scale' };
  }
  const nutrients: Partial<Record<NutrientId, BrandedNutrientValue>> = {};
  for (const [id, nutrient] of Object.entries(candidate.nutrients)) {
    if (!nutrient) continue;
    const scaled = round6(nutrient.amount * factor);
    if (!isValidNutrientAmount(scaled)) return { ok: false, reason: 'invalid_scaled_nutrient' };
    nutrients[id as NutrientId] = Object.freeze({ amount: scaled, unit: nutrient.unit });
  }
  if (Object.keys(nutrients).length === 0) return { ok: false, reason: 'no_nutrients' };
  const brandMatch = brandedBrandAppearsInIngredient(candidate, target.ingredient_text);
  const unknown = NUTRIENT_IDS.filter((id) => nutrients[id] === undefined);
  const brandLabel = candidate.brand_owner ?? candidate.brand_name;
  const assumptions = [
    `Representative USDA Branded product: ${candidate.description}${brandLabel ? ` (${brandLabel})` : ''}.`,
    brandMatch
      ? 'The authored ingredient appears to name this product brand.'
      : 'The recipe does not specify a brand; this product is a representative estimate, not an exact match for every brand.',
    'USDA Branded values are manufacturer-supplied label data, not an analytical generic USDA food.',
    ...(usedHouseholdRelationship
      ? ['The product label declares the household serving used for this mass relationship; no generic density was inferred.']
      : []),
    'Values were scaled deterministically from the published serving basis; label rounding is preserved.',
    ...candidate.limitations,
  ].slice(0, 12).map((value) => value.slice(0, 500));
  const confidence = candidate.match_quality === 'weak'
    ? 'low'
    : brandMatch && candidate.basis !== 'per_serving_ml'
      ? 'high'
      : 'medium';
  const quantityBasis = `${target.ingredient_text} — ${basisDescription}`.slice(0, 200);
  return {
    ok: true,
    contribution: Object.freeze({
      line_ref: target.line_ref,
      ingredient: target.ingredient_text,
      quantity_basis: quantityBasis,
      ...(weightGrams !== undefined && weightGrams > 0 ? { weight_grams: weightGrams } : {}),
      disposition: 'edible',
      exclusion_role: 'none',
      exclusion_assumption: '',
      classification: 'source_backed',
      source_kind: 'usda_branded',
      usda_branded: Object.freeze({
        fdc_id: candidate.fdc_id,
        description: candidate.description,
        ...(candidate.brand_owner !== undefined ? { brand_owner: candidate.brand_owner } : {}),
        ...(candidate.brand_name !== undefined ? { brand_name: candidate.brand_name } : {}),
        ...(candidate.serving !== undefined
          ? { serving_size: candidate.serving.amount, serving_size_unit: candidate.serving.unit }
          : {}),
        basis: candidate.basis,
        ...(candidate.publication_date !== undefined ? { publication_date: candidate.publication_date } : {}),
        snapshot_digest: candidate.snapshot_digest,
        ...(candidate.evidence_id !== undefined ? { evidence_id: candidate.evidence_id } : {}),
        target: Object.freeze({
          query: target.query,
          amount: target.amount,
          unit: target.unit,
          measurement_kind: target.measurement_kind,
          ...(target.quantity_grams !== undefined ? { quantity_grams: target.quantity_grams } : {}),
          ...(target.quantity_ml !== undefined ? { quantity_ml: target.quantity_ml } : {}),
        }),
      }),
      nutrients: Object.freeze(nutrients),
      unknown_nutrients: Object.freeze(unknown),
      assumptions: Object.freeze(assumptions),
      confidence,
      sources: Object.freeze([
        {
          title: `USDA FDC Branded ${candidate.fdc_id} — ${candidate.description}`,
          url: `https://fdc.nal.usda.gov/food-details/${candidate.fdc_id}/nutrients`,
        },
      ]),
    }),
  };
}
