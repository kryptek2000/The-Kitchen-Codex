/**
 * The Kitchen Codex — Household-Portion Registry Contract (registry-track Phase 4):
 * materialization, validation, release-lock verification, immutable lookup.
 *
 * PURE, platform-neutral, offline. The public loader accepts INERT UNKNOWN
 * input (never trusted TypeScript objects): plain objects only, closed exact
 * key sets, guarded descriptor reads, no coercion, no silent truncation, no
 * authority-widening defaults, deterministic closed failure codes, and no
 * input mutation.
 *
 * MATERIALIZATION STRATEGY
 * ------------------------
 * Value materialization reuses the existing descriptor-based inert boundary
 * (`toInertValue` from `src/core/nutritionV2/schema.ts`) — no weaker
 * registry-specific clone is created. Because that boundary caps one value at
 * 64 KiB, the top-level records ARRAY is walked with guarded descriptor reads
 * (mirroring the strict array handling in `src/core/nutritionV2/usda/digest.ts`)
 * and each element is materialized individually; a cumulative serialized-bytes
 * cap bounds the total. Unknown keys fail at every nesting level; accessors,
 * symbol keys, prototype-polluted objects, and reflection failures fail
 * closed without invoking attacker code.
 *
 * LOAD-TIME GUARANTEES
 * --------------------
 * - Per-record closed validation with field-specific failure codes.
 * - Declared `record_digest` values (when present) are independently
 *   recomputed and required to match exactly; the authenticated record always
 *   carries the LOCALLY computed digest.
 * - Duplicate record digests, duplicate lookup keys, alias collisions, food-key
 *   reuse with incompatible FDC constraints, self-supersession, supersede
 *   cycles, and dangling-vs-present chain violations fail closed.
 * - The lock's schema version, record count, and registry digest are
 *   recomputed locally and required to match exactly (order-independent).
 * - No partial registry is returned after any failure.
 */

import {
  HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION,
  householdFailure,
  MAX_HOUSEHOLD_REGISTRY_BYTES,
  MAX_HOUSEHOLD_REGISTRY_RECORDS,
  HOUSEHOLD_SHA256_HEX_PATTERN,
  type AuthenticatedHouseholdPortionRecord,
  type HouseholdFailure,
  type HouseholdFailureCode,
  type HouseholdPortionRecordInput,
  type HouseholdPortionRegistryLock,
} from './types';
import {
  normalizeAliasList,
  normalizeAuthorityClass,
  normalizeBoolean,
  normalizeBounds,
  normalizeCanonicalText,
  normalizeDate,
  normalizeExcludedStates,
  normalizeFdcIds,
  normalizeGrams,
  normalizeHouseholdUnit,
  normalizeQuantityBehavior,
  normalizeRegistryState,
  normalizeRelease,
  normalizeSizeClass,
  normalizeSource,
  normalizeSupersedes,
} from './normalize';
import {
  computeHouseholdRecordDigest,
  computeHouseholdRegistryDigest,
  sortHouseholdRecordsCanonical,
} from './digest';
import { isPlainObject, serializedBlockBytes, toInertValue } from '../schema';

// ---------------------------------------------------------------------------
// Closed key sets
// ---------------------------------------------------------------------------

const RECORD_REQUIRED_KEYS: ReadonlyArray<string> = Object.freeze([
  'schema_version',
  'food_key',
  'aliases',
  'usda_fdc_ids',
  'household_unit',
  'size_class',
  'grams_per_unit',
  'quantity_behavior',
  'requires_state',
  'excluded_states',
  'exclude_generic_identity',
  'authority_class',
  'bounds',
  'source',
  'reviewed_at',
  'supersedes',
]);

const RECORD_ALLOWED_KEYS: ReadonlySet<string> = new Set([...RECORD_REQUIRED_KEYS, 'record_digest']);

const LOCK_REQUIRED_KEYS: ReadonlyArray<string> = Object.freeze([
  'schema_version',
  'registry_release',
  'record_count',
  'registry_digest',
]);

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type HouseholdRecordResult =
  | { ok: true; record: AuthenticatedHouseholdPortionRecord }
  | { ok: false; failure: HouseholdFailure };

export interface HouseholdRegistryMetadata {
  readonly schema_version: typeof HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION;
  readonly registry_release: string;
  readonly record_count: number;
  readonly registry_digest: string;
}

/**
 * Narrow read-only authenticated registry. Exposes metadata, deterministic
 * records in canonical order, exact-key lookup, and digest lookup. Exposes no
 * mutable maps, no registration/insertion/replace methods, no authority
 * stores, no callbacks, and no raw unvalidated input.
 */
export interface HouseholdPortionRegistry {
  metadata(): HouseholdRegistryMetadata;
  size(): number;
  records(): ReadonlyArray<AuthenticatedHouseholdPortionRecord>;
  findByKey(query: unknown): HouseholdLookupResult;
  findByDigest(digest: unknown): HouseholdLookupResult;
}

export type HouseholdLookupResult =
  | { ok: true; record: AuthenticatedHouseholdPortionRecord }
  | { ok: false; failure: HouseholdFailure };

export type HouseholdRegistryResult =
  | { ok: true; registry: HouseholdPortionRegistry }
  | { ok: false; failure: HouseholdFailure };

function fail(code: HouseholdFailureCode): { ok: false; failure: HouseholdFailure } {
  return { ok: false, failure: householdFailure(code) };
}

// ---------------------------------------------------------------------------
// Per-record validation (field-specific closed failure codes)
// ---------------------------------------------------------------------------

/**
 * Strictly validates one untrusted record value into an authenticated record.
 * Never throws; never mutates the input; independently recomputes the digest
 * and requires exact equality with any declared digest.
 */
export function validateHouseholdRecord(raw: unknown): HouseholdRecordResult {
  const materialized = toInertValue(raw);
  if (!materialized.ok) return fail('invalid_record');
  if (!isPlainObject(materialized.value)) return fail('invalid_record');
  const value = materialized.value as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (!RECORD_ALLOWED_KEYS.has(key)) return fail('invalid_record');
  }
  for (const key of RECORD_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return fail('invalid_record');
  }

  if (value.schema_version !== HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION) {
    return fail('invalid_schema_version');
  }

  const foodKey = normalizeCanonicalText(value.food_key);
  if (foodKey === null) return fail('invalid_record');

  const aliases = normalizeAliasList(value.aliases);
  if (aliases === null) return fail('invalid_record');

  const fdcIds = normalizeFdcIds(value.usda_fdc_ids);
  if (fdcIds === null) return fail('invalid_record');

  const unit = normalizeHouseholdUnit(value.household_unit);
  if (unit === null) return fail('invalid_unit');

  const size = normalizeSizeClass(value.size_class);
  if (!size.ok) return fail('invalid_size');

  const grams = normalizeGrams(value.grams_per_unit);
  if (grams === null) return fail('invalid_grams');

  if (normalizeQuantityBehavior(value.quantity_behavior) === null) return fail('invalid_record');

  const state = normalizeRegistryState(value.requires_state);
  if (!state.ok) return fail('invalid_state');

  const excluded = normalizeExcludedStates(value.excluded_states, state.value);
  if (excluded === null) return fail('invalid_state');

  if (normalizeBoolean(value.exclude_generic_identity) === null) return fail('invalid_record');

  const authorityClass = normalizeAuthorityClass(value.authority_class);
  if (authorityClass === null) return fail('invalid_authority');

  const bounds = normalizeBounds(value.bounds);
  if (!bounds.ok) return fail('invalid_authority');

  const source = normalizeSource(value.source);
  if (!source.ok) return fail('invalid_source');

  if (normalizeDate(value.reviewed_at) === null) return fail('invalid_date');

  const supersedes = normalizeSupersedes(value.supersedes);
  if (!supersedes.ok) return fail('invalid_record');

  // Authority-class consistency: bounds and source kind must agree with the
  // provenance class. Supporting `bounded_estimate` here does NOT authorize
  // automatic use — that is a later Sid-approved policy decision.
  if (authorityClass === 'usda_derived') {
    if (source.value.kind !== 'usda_fdc' || bounds.value !== null) return fail('invalid_authority');
  } else if (authorityClass === 'vetted_standard') {
    if (source.value.kind !== 'government_standard' && source.value.kind !== 'standards_body') {
      return fail('invalid_authority');
    }
    if (bounds.value !== null) return fail('invalid_authority');
  } else {
    if (source.value.kind !== 'government_standard' && source.value.kind !== 'standards_body') {
      return fail('invalid_authority');
    }
    if (bounds.value === null) return fail('invalid_authority');
    if (bounds.value.min_grams > grams || grams > bounds.value.max_grams) return fail('invalid_authority');
  }

  const semantic: HouseholdPortionRecordInput = {
    schema_version: HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION,
    food_key: foodKey,
    aliases,
    usda_fdc_ids: fdcIds,
    household_unit: unit,
    size_class: size.value,
    grams_per_unit: grams,
    quantity_behavior: 'linear',
    requires_state: state.value,
    excluded_states: excluded,
    exclude_generic_identity: value.exclude_generic_identity as boolean,
    authority_class: authorityClass,
    bounds: bounds.value,
    source: source.value,
    reviewed_at: value.reviewed_at as string,
    supersedes: supersedes.value,
  };

  const recordDigest = computeHouseholdRecordDigest(semantic);

  if (supersedes.value !== null && supersedes.value === recordDigest) {
    return fail('supersedes_conflict');
  }

  if (Object.prototype.hasOwnProperty.call(value, 'record_digest')) {
    const declared = value.record_digest;
    if (typeof declared !== 'string' || !HOUSEHOLD_SHA256_HEX_PATTERN.test(declared)) {
      return fail('invalid_digest');
    }
    if (declared !== recordDigest) return fail('record_digest_mismatch');
  }

  const record: AuthenticatedHouseholdPortionRecord = Object.freeze({
    ...semantic,
    aliases: Object.freeze([...semantic.aliases]),
    usda_fdc_ids: Object.freeze([...semantic.usda_fdc_ids]),
    excluded_states: Object.freeze([...semantic.excluded_states]),
    bounds: semantic.bounds === null ? null : Object.freeze({ ...semantic.bounds }),
    source: Object.freeze({ ...semantic.source }),
    record_digest: recordDigest,
  });
  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// Release-lock validation
// ---------------------------------------------------------------------------

function validateRegistryLock(raw: unknown):
  | { ok: true; lock: HouseholdPortionRegistryLock }
  | { ok: false; failure: HouseholdFailure } {
  const materialized = toInertValue(raw);
  if (!materialized.ok) return fail('invalid_input');
  if (!isPlainObject(materialized.value)) return fail('invalid_input');
  const value = materialized.value as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (!(LOCK_REQUIRED_KEYS as ReadonlyArray<string>).includes(key)) return fail('invalid_input');
  }
  for (const key of LOCK_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return fail('invalid_input');
  }

  if (value.schema_version !== HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION) {
    return fail('invalid_schema_version');
  }
  const release = normalizeRelease(value.registry_release);
  if (release === null) return fail('invalid_input');
  if (typeof value.record_count !== 'number' || !Number.isSafeInteger(value.record_count) || value.record_count < 0) {
    return fail('invalid_input');
  }
  if (typeof value.registry_digest !== 'string' || !HOUSEHOLD_SHA256_HEX_PATTERN.test(value.registry_digest)) {
    return fail('invalid_digest');
  }
  return {
    ok: true,
    lock: Object.freeze({
      schema_version: HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION,
      registry_release: release,
      record_count: value.record_count,
      registry_digest: value.registry_digest,
    }),
  };
}

// ---------------------------------------------------------------------------
// Guarded top-level records-array read (no attacker code invoked)
// ---------------------------------------------------------------------------

function readRecordElements(raw: unknown):
  | { ok: true; elements: ReadonlyArray<unknown> }
  | { ok: false; failure: HouseholdFailure } {
  if (!Array.isArray(raw)) return fail('invalid_input');
  let names: string[];
  let lengthValue: unknown;
  try {
    if (Object.getPrototypeOf(raw) !== Array.prototype) return fail('invalid_input');
    if (Object.getOwnPropertySymbols(raw).length > 0) return fail('invalid_input');
    names = Object.getOwnPropertyNames(raw);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(raw, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor)) return fail('invalid_input');
    lengthValue = lengthDescriptor.value;
  } catch {
    return fail('invalid_input');
  }
  if (typeof lengthValue !== 'number' || !Number.isSafeInteger(lengthValue) || lengthValue < 0) {
    return fail('invalid_input');
  }
  if (lengthValue > MAX_HOUSEHOLD_REGISTRY_RECORDS) return fail('registry_too_large');
  if (names.length !== lengthValue + 1) return fail('invalid_input');
  const elements: unknown[] = [];
  try {
    for (let index = 0; index < lengthValue; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
        return fail('invalid_input');
      }
      elements.push(descriptor.value);
    }
  } catch {
    return fail('invalid_input');
  }
  return { ok: true, elements };
}

// ---------------------------------------------------------------------------
// Registry loader
// ---------------------------------------------------------------------------

/** Lookup-key serialization: FDC id + canonical unit + size + required state. */
function lookupKeyString(fdcId: number, unit: string, size: string | null, state: string | null): string {
  return `${fdcId}|${unit}|${size ?? ''}|${state ?? ''}`;
}

/**
 * Loads and authenticates a household-portion registry from inert unknown
 * input plus an independently verified release lock. All-or-nothing: any
 * failure returns a closed failure and no partial registry.
 */
export function loadHouseholdPortionRegistry(recordsRaw: unknown, lockRaw: unknown): HouseholdRegistryResult {
  const lockValidation = validateRegistryLock(lockRaw);
  // NOTE: the repo typechecks with `strict: false`, so discriminant narrowing
  // on the failure branch is unavailable; the runtime guard makes this cast sound.
  if (!lockValidation.ok) return lockValidation as { ok: false; failure: HouseholdFailure };
  const lock = lockValidation.lock;

  const arrayValidation = readRecordElements(recordsRaw);
  if (!arrayValidation.ok) return arrayValidation as { ok: false; failure: HouseholdFailure };
  const elements = arrayValidation.elements;

  let totalBytes = 0;
  const records: AuthenticatedHouseholdPortionRecord[] = [];
  for (const element of elements) {
    const bytes = serializedBlockBytes(element);
    if (bytes === Infinity) return fail('invalid_record');
    totalBytes += bytes;
    if (totalBytes > MAX_HOUSEHOLD_REGISTRY_BYTES) return fail('registry_too_large');
    const validation = validateHouseholdRecord(element);
    if (!validation.ok) return validation as { ok: false; failure: HouseholdFailure };
    records.push(validation.record);
  }

  if (records.length !== lock.record_count) return fail('record_count_mismatch');

  // Duplicate digests, duplicate lookup keys, alias collisions, food-key
  // reuse with incompatible FDC constraints.
  const seenDigests = new Set<string>();
  const keyOwner = new Map<string, string>();
  const labelOwner = new Map<string, string>();
  const foodKeyFdc = new Map<string, string>();
  for (const record of records) {
    if (seenDigests.has(record.record_digest)) return fail('duplicate_record');
    seenDigests.add(record.record_digest);

    for (const fdcId of record.usda_fdc_ids) {
      const key = lookupKeyString(fdcId, record.household_unit, record.size_class, record.requires_state);
      if (keyOwner.has(key)) return fail('duplicate_record');
      keyOwner.set(key, record.record_digest);
    }

    const fdcSignature = record.usda_fdc_ids.join(',');
    const knownFdc = foodKeyFdc.get(record.food_key);
    if (knownFdc !== undefined && knownFdc !== fdcSignature) return fail('duplicate_record');
    foodKeyFdc.set(record.food_key, fdcSignature);

    const labels = [record.food_key, ...record.aliases];
    for (const label of labels) {
      const owner = labelOwner.get(label);
      if (owner !== undefined && owner !== record.food_key) return fail('alias_collision');
      labelOwner.set(label, record.food_key);
    }
  }

  // Supersede-chain check: cycles among present records fail. Dangling
  // targets (cross-release references) are allowed but never resolved here.
  const byDigest = new Map<string, AuthenticatedHouseholdPortionRecord>();
  for (const record of records) byDigest.set(record.record_digest, record);
  for (const record of records) {
    if (record.supersedes === null) continue;
    const seen = new Set<string>([record.record_digest]);
    let cursor: string | null = record.supersedes;
    while (cursor !== null) {
      if (seen.has(cursor)) return fail('supersedes_conflict');
      seen.add(cursor);
      const target = byDigest.get(cursor);
      cursor = target ? target.supersedes : null;
    }
  }

  const digests = records.map((record) => record.record_digest);
  const expectedRegistryDigest = computeHouseholdRegistryDigest(
    HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION,
    lock.registry_release,
    digests
  );
  if (lock.registry_digest !== expectedRegistryDigest) return fail('registry_digest_mismatch');

  const ordered = sortHouseholdRecordsCanonical(records);
  const metadata: HouseholdRegistryMetadata = Object.freeze({
    schema_version: HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION,
    registry_release: lock.registry_release,
    record_count: ordered.length,
    registry_digest: lock.registry_digest,
  });

  const registry: HouseholdPortionRegistry = {
    metadata: () => metadata,
    size: () => ordered.length,
    records: () => ordered,
    findByKey: (query: unknown) => findRecordByKey(ordered, query),
    findByDigest: (digest: unknown) => findRecordByDigest(ordered, digest),
  };
  return { ok: true, registry };
}

// ---------------------------------------------------------------------------
// Immutable lookup (exact key / digest; never first-wins)
// ---------------------------------------------------------------------------

function findRecordByKey(
  ordered: ReadonlyArray<AuthenticatedHouseholdPortionRecord>,
  query: unknown
): HouseholdLookupResult {
  const materialized = toInertValue(query);
  if (!materialized.ok) return fail('invalid_input');
  if (!isPlainObject(materialized.value)) return fail('invalid_input');
  const value = materialized.value as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 4) return fail('invalid_input');
  for (const key of ['fdc_id', 'household_unit', 'size_class', 'requires_state']) {
    if (!keys.includes(key)) return fail('invalid_input');
  }
  if (typeof value.fdc_id !== 'number' || !Number.isSafeInteger(value.fdc_id) || value.fdc_id <= 0) {
    return fail('invalid_input');
  }
  const unit = normalizeHouseholdUnit(value.household_unit);
  if (unit === null) return fail('invalid_unit');
  const size = normalizeSizeClass(value.size_class);
  if (!size.ok) return fail('invalid_size');
  const state = normalizeRegistryState(value.requires_state);
  if (!state.ok) return fail('invalid_state');

  const matches = ordered.filter(
    (record) =>
      record.usda_fdc_ids.includes(value.fdc_id as number) &&
      record.household_unit === unit &&
      record.size_class === size.value &&
      record.requires_state === state.value
  );
  if (matches.length === 0) return fail('not_found');
  if (matches.length > 1) return fail('ambiguous_lookup');
  return { ok: true, record: matches[0] };
}

function findRecordByDigest(
  ordered: ReadonlyArray<AuthenticatedHouseholdPortionRecord>,
  digest: unknown
): HouseholdLookupResult {
  // A direct `typeof` check invokes no attacker code (no getters, no
  // valueOf/toString coercion); non-strings fail closed without materialization.
  if (typeof digest !== 'string' || !HOUSEHOLD_SHA256_HEX_PATTERN.test(digest)) {
    return fail('invalid_digest');
  }
  const matches = ordered.filter((record) => record.record_digest === digest);
  if (matches.length === 0) return fail('not_found');
  if (matches.length > 1) return fail('ambiguous_lookup');
  return { ok: true, record: matches[0] };
}
