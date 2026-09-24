/**
 * The Kitchen Codex — Household-Portion Registry (registry-track Phase 5 repair):
 * canonical provenance and cross-FDC equivalence machinery.
 *
 * PURE, platform-neutral, DETERMINISTIC. This module owns ONLY the canonical
 * serialization, validation, and digest functions for the initial dataset's
 * authenticated derivation provenance and its cross-FDC equivalence rationales.
 * It contains NO data and grants NO authority: a caller can compute a digest but
 * cannot make the loader accept it, because the loader compares against the
 * fixed reviewed constants in `initialLock.ts`.
 *
 * PROVENANCE DIGEST (what it binds)
 * ---------------------------------
 *   - the registry release, schema version, and exact record count;
 *   - every authenticated record: record linkage key
 *     (`food_key|unit|size|state`), normalized fields, the complete sorted
 *     bound-FDC set, and the record digest computed by the Phase 4 contract;
 *   - every provenance entry: source release, source FDC, source record digest,
 *     source portion index/id, amount, gram weight, measure, modifier, derived
 *     grams, and the citation linkage (citation FDC + portion id);
 *   - every cross-FDC equivalence rationale (see below).
 *
 * Set-like collections (records, bound FDCs, provenance entries, equivalence
 * pairs) are sorted before hashing, so authored order is irrelevant; ordered
 * fields keep their meaning. Unknown or malformed fields are rejected BEFORE
 * hashing (fail closed), and canonical serialization is the project's strict
 * `canonicalStringify` (locale-independent, sorted keys, no coercion).
 *
 * V1 DIVISION POLICY
 * ------------------
 * This reviewed v1 dataset requires every source portion amount to equal `1`
 * exactly, so `grams_per_unit === gram_weight` by construction and no floating
 * point quotient is claimed to be generally exact. Non-one portion amounts are
 * rejected here and require a future reviewed rational/canonical-decimal
 * derivation contract.
 */

import { canonicalStringify, sha256Hex } from '../usda/digest';
import {
  HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION,
  type AuthenticatedHouseholdPortionRecord,
} from './types';

/** Provenance contract version (part of the provenance digest). */
export const HOUSEHOLD_INITIAL_PROVENANCE_VERSION = 'household_portion_initial_provenance_v1';
/** Aggregate release identity version (part of the aggregate digest). */
export const HOUSEHOLD_INITIAL_AGGREGATE_VERSION = 'household_portion_initial_release_v1';

/** Maximum UTF-8 bytes of one provenance/rationale text field. */
export const MAX_HOUSEHOLD_INITIAL_TEXT_BYTES = 500;
/** Maximum grams of one v1 source portion (aligned with the Phase 4 bound). */
export const MAX_HOUSEHOLD_INITIAL_GRAMS = 10_000;

/** C0/C1 controls, DEL, and invisible format characters are rejected. */
const CONTROL_OR_FORMAT_PATTERN =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\u205F-\u2064\uFEFF\u00AD]/;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Exact closed key sets (unknown keys fail closed). */
const PROVENANCE_KEYS = [
  'record_key',
  'source_release',
  'source_fdc_id',
  'source_record_digest',
  'source_portion_index',
  'source_portion_id',
  'portion_amount',
  'portion_gram_weight',
  'portion_measure',
  'portion_modifier',
  'derived_grams_per_unit',
  'citation_fdc_id',
  'citation_portion_id',
].sort();

const EQUIVALENCE_KEYS = [
  'record_key',
  'source_fdc_id',
  'source_description',
  'bound_fdc_id',
  'bound_description',
  'species_family',
  'state',
  'color_variety',
  'edible_form',
  'positive_evidence',
  'corroborating_portion',
  'data_type_difference',
  'nutrient_profile_delta',
  'conclusion',
].sort();

/**
 * One authenticated derivation for one initial record: the exact source FDC,
 * source portion identity, and the derived per-unit value. `record_key` is the
 * stable authority tuple `food_key|unit|size|state`.
 */
export interface HouseholdPortionInitialProvenance {
  readonly record_key: string;
  readonly source_release: string;
  readonly source_fdc_id: number;
  readonly source_record_digest: string;
  readonly source_portion_index: number;
  readonly source_portion_id: string;
  /** V1 policy: exactly `1`. */
  readonly portion_amount: 1;
  readonly portion_gram_weight: number;
  readonly portion_measure: string;
  readonly portion_modifier: string | null;
  readonly derived_grams_per_unit: number;
  readonly citation_fdc_id: number;
  readonly citation_portion_id: string;
}

/**
 * Positive, deterministic equivalence rationale for ONE bound FDC of one record
 * family. The rationale authorizes ONLY the transfer of a household mass
 * relationship between the source and bound food identities; nutrients always
 * come from the selected target FDC and are never transferred.
 */
export interface HouseholdPortionEquivalenceRationale {
  readonly record_key: string;
  readonly source_fdc_id: number;
  readonly source_description: string;
  readonly bound_fdc_id: number;
  readonly bound_description: string;
  readonly species_family: string;
  readonly state: string;
  readonly color_variety: string;
  readonly edible_form: string;
  readonly positive_evidence: string;
  readonly corroborating_portion: string;
  readonly data_type_difference: string;
  readonly nutrient_profile_delta: string;
  readonly conclusion: string;
}

export interface HouseholdInitialProvenanceInput {
  readonly registryRelease: string;
  readonly records: ReadonlyArray<AuthenticatedHouseholdPortionRecord>;
  readonly provenance: ReadonlyArray<HouseholdPortionInitialProvenance>;
  readonly equivalence: ReadonlyArray<HouseholdPortionEquivalenceRationale>;
}

/** Fixed, bounded, input-redacted provenance validation failure. */
export class HouseholdInitialProvenanceError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`household_initial_provenance_invalid:${reason}`);
    this.name = 'HouseholdInitialProvenanceError';
    this.reason = reason;
  }
}

export function householdRecordKey(record: {
  food_key: string;
  household_unit: string;
  size_class: string | null;
  requires_state: string | null;
}): string {
  return `${record.food_key}|${record.household_unit}|${record.size_class ?? 'null'}|${
    record.requires_state ?? 'null'
  }`;
}

function isBoundedText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  if (value.length > MAX_HOUSEHOLD_INITIAL_TEXT_BYTES) return false;
  if (CONTROL_OR_FORMAT_PATTERN.test(value)) return false;
  try {
    if (new TextEncoder().encode(value).length > MAX_HOUSEHOLD_INITIAL_TEXT_BYTES) return false;
  } catch {
    return false;
  }
  return true;
}

function hasExactKeys(value: unknown, expected: ReadonlyArray<string>): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] !== expected[index]) return false;
  }
  return true;
}

function isPositiveSafeInteger(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
}

/**
 * Validates the complete provenance/equivalence input against the authenticated
 * records. Returns `{ ok: true }` or a closed `{ ok: false, reason }`; never
 * throws for malformed input, and never invokes getters or coercion.
 */
export function validateHouseholdInitialProvenance(
  input: HouseholdInitialProvenanceInput
): { ok: true } | { ok: false; reason: string } {
  const records = input.records;
  const provenance = input.provenance;
  const equivalence = input.equivalence;
  if (!Array.isArray(records) || !Array.isArray(provenance) || !Array.isArray(equivalence)) {
    return { ok: false, reason: 'shape' };
  }
  if (!isBoundedText(input.registryRelease)) return { ok: false, reason: 'release' };

  const recordByKey = new Map<string, AuthenticatedHouseholdPortionRecord>();
  for (const record of records) {
    const key = householdRecordKey(record);
    if (recordByKey.has(key)) return { ok: false, reason: 'duplicate_record' };
    if (!Array.isArray(record.usda_fdc_ids) || record.usda_fdc_ids.length === 0) {
      return { ok: false, reason: 'record_fdcs' };
    }
    recordByKey.set(key, record);
  }

  if (provenance.length !== records.length) return { ok: false, reason: 'provenance_count' };

  const seenProvenance = new Set<string>();
  const expectedRationalePairs = new Set<string>();
  for (const entry of provenance) {
    if (!hasExactKeys(entry, PROVENANCE_KEYS)) return { ok: false, reason: 'provenance_keys' };
    const value = entry as unknown as Record<string, unknown>;
    if (typeof value.record_key !== 'string') return { ok: false, reason: 'record_key' };
    const record = recordByKey.get(value.record_key);
    if (!record) return { ok: false, reason: 'record_linkage' };
    if (seenProvenance.has(value.record_key)) return { ok: false, reason: 'duplicate_provenance' };
    seenProvenance.add(value.record_key);

    if (!isBoundedText(value.source_release)) return { ok: false, reason: 'source_release' };
    if (!isPositiveSafeInteger(value.source_fdc_id, Number.MAX_SAFE_INTEGER)) {
      return { ok: false, reason: 'source_fdc' };
    }
    if (typeof value.source_record_digest !== 'string' || !SHA256_HEX_PATTERN.test(value.source_record_digest)) {
      return { ok: false, reason: 'source_record_digest' };
    }
    if (typeof value.source_portion_index !== 'number' || !Number.isSafeInteger(value.source_portion_index) || value.source_portion_index < 0) {
      return { ok: false, reason: 'source_portion_index' };
    }
    if (!isBoundedText(value.source_portion_id)) return { ok: false, reason: 'source_portion_id' };
    // V1 DIVISION POLICY: the source amount must be exactly one.
    if (value.portion_amount !== 1) return { ok: false, reason: 'portion_amount_not_one' };
    if (!isPositiveSafeInteger(value.portion_gram_weight, MAX_HOUSEHOLD_INITIAL_GRAMS)) {
      return { ok: false, reason: 'portion_gram_weight' };
    }
    if (!isBoundedText(value.portion_measure)) return { ok: false, reason: 'portion_measure' };
    if (value.portion_modifier !== null && !isBoundedText(value.portion_modifier)) {
      return { ok: false, reason: 'portion_modifier' };
    }
    if (value.derived_grams_per_unit !== value.portion_gram_weight) {
      return { ok: false, reason: 'derived_grams' };
    }
    if (!record.usda_fdc_ids.includes(value.source_fdc_id as number)) {
      return { ok: false, reason: 'source_fdc_linkage' };
    }
    if (value.citation_fdc_id !== value.source_fdc_id) return { ok: false, reason: 'citation_fdc' };
    if (value.citation_portion_id !== value.source_portion_id) {
      return { ok: false, reason: 'citation_portion' };
    }
    if (!record.source.citation.includes(`USDA FDC ${value.source_fdc_id}`)) {
      return { ok: false, reason: 'citation_text_fdc' };
    }
    if (!record.source.citation.includes(value.source_portion_id as string)) {
      return { ok: false, reason: 'citation_text_portion' };
    }

    for (const fdcId of record.usda_fdc_ids) {
      if (fdcId !== value.source_fdc_id) {
        expectedRationalePairs.add(`${value.record_key}|${fdcId}`);
      } else {
        expectedRationalePairs.add(`${value.record_key}|source`);
      }
    }
  }
  for (const record of records) {
    const key = householdRecordKey(record);
    if (!seenProvenance.has(key)) return { ok: false, reason: 'missing_provenance' };
  }

  const seenRationales = new Set<string>();
  for (const rationale of equivalence) {
    if (!hasExactKeys(rationale, EQUIVALENCE_KEYS)) return { ok: false, reason: 'equivalence_keys' };
    const value = rationale as unknown as Record<string, unknown>;
    if (typeof value.record_key !== 'string') return { ok: false, reason: 'rationale_record_key' };
    const pairKey = `${value.record_key}|${value.bound_fdc_id}`;
    if (seenRationales.has(pairKey)) return { ok: false, reason: 'duplicate_rationale' };
    if (!expectedRationalePairs.has(pairKey)) return { ok: false, reason: 'rationale_pair' };
    seenRationales.add(pairKey);
    if (!isPositiveSafeInteger(value.bound_fdc_id, Number.MAX_SAFE_INTEGER)) {
      return { ok: false, reason: 'rationale_bound_fdc' };
    }
    if (!isPositiveSafeInteger(value.source_fdc_id, Number.MAX_SAFE_INTEGER)) {
      return { ok: false, reason: 'rationale_source_fdc' };
    }
    const record = recordByKey.get(value.record_key as string);
    if (!record || value.source_fdc_id === value.bound_fdc_id) {
      return { ok: false, reason: 'rationale_linkage' };
    }
    if (!record.usda_fdc_ids.includes(value.bound_fdc_id as number)) {
      return { ok: false, reason: 'rationale_bound_linkage' };
    }
    for (const field of [
      'source_description',
      'bound_description',
      'species_family',
      'state',
      'color_variety',
      'edible_form',
      'positive_evidence',
      'corroborating_portion',
      'data_type_difference',
      'nutrient_profile_delta',
      'conclusion',
    ]) {
      if (!isBoundedText(value[field])) return { ok: false, reason: `rationale_${field}` };
    }
    // Positive evidence must not be a bare absence-of-contradiction statement.
    if (/^\s*(no|without|absence|there is no|nothing)\b/i.test(value.positive_evidence as string)) {
      return { ok: false, reason: 'rationale_absence_only' };
    }
  }
  for (const expected of expectedRationalePairs) {
    if (expected.endsWith('|source')) continue;
    if (!seenRationales.has(expected)) return { ok: false, reason: 'missing_rationale' };
  }
  return { ok: true };
}

/**
 * Canonical provenance payload. Set-like collections are sorted: records by
 * record key, provenance by record key, equivalence by (record key, bound FDC).
 */
export function householdInitialProvenanceCanonicalPayload(
  input: HouseholdInitialProvenanceInput
): Record<string, unknown> {
  const keyOf = (record: {
    food_key: string;
    household_unit: string;
    size_class: string | null;
    requires_state: string | null;
  }): string => householdRecordKey(record);

  const records = [...input.records]
    .map((record) => ({
      record_key: keyOf(record),
      food_key: record.food_key,
      household_unit: record.household_unit,
      size_class: record.size_class,
      requires_state: record.requires_state,
      usda_fdc_ids: [...record.usda_fdc_ids].sort((a, b) => a - b),
      record_digest: record.record_digest,
    }))
    .sort((a, b) => (a.record_key < b.record_key ? -1 : a.record_key > b.record_key ? 1 : 0));

  const provenance = [...input.provenance]
    .map((entry) => ({ ...entry }))
    .sort((a, b) => (a.record_key < b.record_key ? -1 : a.record_key > b.record_key ? 1 : 0));

  const equivalence = [...input.equivalence]
    .map((entry) => ({ ...entry }))
    .sort((a, b) =>
      a.record_key < b.record_key
        ? -1
        : a.record_key > b.record_key
          ? 1
          : a.bound_fdc_id - b.bound_fdc_id
    );

  return {
    provenance_version: HOUSEHOLD_INITIAL_PROVENANCE_VERSION,
    schema_version: HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION,
    registry_release: input.registryRelease,
    record_count: records.length,
    records,
    provenance,
    equivalence,
  };
}

/**
 * Deterministic provenance digest. Validates the complete input first and
 * throws a fixed `HouseholdInitialProvenanceError` for any malformed/unknown
 * field (fail closed, nothing hashed).
 */
export function computeHouseholdInitialProvenanceDigest(
  input: HouseholdInitialProvenanceInput
): string {
  const validation = validateHouseholdInitialProvenance(input);
  if (!validation.ok) {
    throw new HouseholdInitialProvenanceError(
      (validation as { ok: false; reason: string }).reason
    );
  }
  return sha256Hex(canonicalStringify(householdInitialProvenanceCanonicalPayload(input)));
}

export interface HouseholdInitialAggregateInput {
  readonly registryRelease: string;
  readonly recordCount: number;
  readonly registryDigest: string;
  readonly provenanceDigest: string;
}

/**
 * Aggregate reviewed-release digest committing to the registry digest AND the
 * provenance digest together. The lock stores the fixed expected value.
 */
export function computeHouseholdInitialAggregateDigest(input: HouseholdInitialAggregateInput): string {
  if (!isBoundedText(input.registryRelease)) throw new HouseholdInitialProvenanceError('release');
  if (
    typeof input.recordCount !== 'number' ||
    !Number.isSafeInteger(input.recordCount) ||
    input.recordCount < 0
  ) {
    throw new HouseholdInitialProvenanceError('record_count');
  }
  if (!SHA256_HEX_PATTERN.test(input.registryDigest)) {
    throw new HouseholdInitialProvenanceError('registry_digest');
  }
  if (!SHA256_HEX_PATTERN.test(input.provenanceDigest)) {
    throw new HouseholdInitialProvenanceError('provenance_digest');
  }
  return sha256Hex(
    canonicalStringify({
      aggregate_version: HOUSEHOLD_INITIAL_AGGREGATE_VERSION,
      schema_version: HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION,
      registry_release: input.registryRelease,
      record_count: input.recordCount,
      registry_digest: input.registryDigest,
      provenance_digest: input.provenanceDigest,
    })
  );
}
