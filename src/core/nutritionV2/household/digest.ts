/**
 * The Kitchen Codex — Household-Portion Registry Contract (registry-track Phase 4):
 * canonical digest construction.
 *
 * PURE, platform-neutral, offline. Reuses the project's existing deterministic
 * SHA-256 and strict canonical-serialization machinery
 * (`src/core/nutritionV2/usda/digest.ts`); no new digest namespace is created.
 *
 * RECORD DIGEST
 * -------------
 * `computeHouseholdRecordDigest` hashes the canonical semantic payload: every
 * semantic field in exact key order, with exact array ordering, exact null
 * representation, exact number representation, NFC strings, no locale
 * dependence, no insertion-order dependence, no undefined values. The digest
 * field itself is excluded. Equivalent raw objects normalizing to the same
 * semantic record produce the same digest; any semantic change (food key,
 * alias, FDC id, unit, size, grams, quantity behavior, required/excluded
 * state, generic-identity policy, authority class, bounds, source
 * citation/kind/URL/access date, review date, supersedes value, schema
 * version) produces a different digest.
 *
 * REGISTRY DIGEST
 * ---------------
 * `computeHouseholdRegistryDigest` binds schema version, release identifier,
 * record count, and the canonically ORDERED record digests (ascending digest
 * order, so input array order never affects the result). Changing any record
 * or any release metadata changes the registry digest.
 *
 * No collision resistance beyond SHA-256's normal cryptographic contract is
 * claimed.
 */

import { canonicalStringify, sha256Hex } from '../usda/digest';
import type { AuthenticatedHouseholdPortionRecord, HouseholdPortionRecordInput } from './types';

/**
 * Canonical semantic payload of one record: exact key order, exact array
 * ordering (aliases/FDC ids/excluded states are pre-sorted at normalization),
 * explicit nulls, authored numbers preserved exactly.
 */
export function householdRecordCanonicalPayload(record: HouseholdPortionRecordInput): Record<string, unknown> {
  return {
    schema_version: record.schema_version,
    food_key: record.food_key,
    aliases: [...record.aliases],
    usda_fdc_ids: [...record.usda_fdc_ids],
    household_unit: record.household_unit,
    size_class: record.size_class,
    grams_per_unit: record.grams_per_unit,
    quantity_behavior: record.quantity_behavior,
    requires_state: record.requires_state,
    excluded_states: [...record.excluded_states],
    exclude_generic_identity: record.exclude_generic_identity,
    authority_class: record.authority_class,
    bounds:
      record.bounds === null
        ? null
        : { max_grams: record.bounds.max_grams, min_grams: record.bounds.min_grams },
    source: {
      accessed: record.source.accessed,
      citation: record.source.citation,
      kind: record.source.kind,
      url: record.source.url,
    },
    reviewed_at: record.reviewed_at,
    supersedes: record.supersedes,
  };
}

/** Deterministic record digest over the canonical semantic payload. */
export function computeHouseholdRecordDigest(record: HouseholdPortionRecordInput): string {
  return sha256Hex(canonicalStringify(householdRecordCanonicalPayload(record)));
}

/**
 * Deterministic registry digest. Record digests are sorted ascending so the
 * result is independent of input array order. Binds schema version, release,
 * record count, and ordered record digests.
 */
export function computeHouseholdRegistryDigest(
  schemaVersion: string,
  registryRelease: string,
  recordDigests: ReadonlyArray<string>
): string {
  const ordered = [...recordDigests].sort();
  return sha256Hex(
    canonicalStringify({
      schema_version: schemaVersion,
      registry_release: registryRelease,
      record_count: ordered.length,
      record_digests: ordered,
    })
  );
}

/** Canonical registry order: ascending record digest (stable, content-bound). */
export function sortHouseholdRecordsCanonical(
  records: ReadonlyArray<AuthenticatedHouseholdPortionRecord>
): ReadonlyArray<AuthenticatedHouseholdPortionRecord> {
  const ordered = [...records].sort((a, b) => (a.record_digest < b.record_digest ? -1 : a.record_digest > b.record_digest ? 1 : 0));
  return Object.freeze(ordered);
}
