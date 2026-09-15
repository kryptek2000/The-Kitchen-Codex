/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: deterministic local store.
 *
 * PURE, platform-neutral, READ-ONLY over already-canonicalized trusted records.
 * Phase 1 supports EXACT lookup only: there is no search, token search, ranking,
 * ingredient matching, candidate selection, category guessing, branded fallback,
 * recipe parsing, or network fallback.
 *
 * ALL-OR-NOTHING
 * --------------
 * Construction validates the manifest, re-validates every canonical record,
 * binds every record to the manifest's bundle release + component release, and
 * verifies the canonical-content digest and exact record count. One invalid
 * record prevents the store from ever being declared trusted.
 */

import { computeCanonicalContentDigest, validateManifest } from './manifest';
import { validateCanonicalRecord } from './record';
import {
  type CanonicalUsdaFoodRecord,
  type UsdaBundleManifest,
  type UsdaDataType,
} from './types';

export type UsdaStoreFailureCode =
  | 'invalid_manifest'
  | 'invalid_record'
  | 'duplicate_fdc_id'
  | 'release_mismatch'
  | 'count_mismatch'
  | 'content_digest_mismatch';

const STORE_FAILURE_MESSAGE: Readonly<Record<UsdaStoreFailureCode, string>> = Object.freeze({
  invalid_manifest: 'usda_store_invalid_manifest',
  invalid_record: 'usda_store_invalid_record',
  duplicate_fdc_id: 'usda_store_duplicate_fdc_id',
  release_mismatch: 'usda_store_release_mismatch',
  count_mismatch: 'usda_store_count_mismatch',
  content_digest_mismatch: 'usda_store_content_digest_mismatch',
});

export interface UsdaStoreMetadata {
  readonly bundle_release: string;
  readonly canonical_record_count: number;
  readonly rejected_record_count: number;
  readonly data_types: ReadonlyArray<UsdaDataType>;
  readonly upstream_releases: Readonly<Partial<Record<UsdaDataType, string>>>;
  readonly nutrient_map_version: string;
  readonly canonicalization_version: string;
}

export type UsdaLookupResult =
  | { ok: true; record: CanonicalUsdaFoodRecord }
  | { ok: false; code: 'not_found' | 'invalid_fdc_id' };

export interface UsdaRecordStore {
  /** Exact lookup by bundle release + FDC id. Never searches or ranks. */
  lookup(bundleRelease: string, fdcId: number): UsdaLookupResult;
  /** Bounded, frozen store metadata. */
  metadata(): UsdaStoreMetadata;
}

export type UsdaStoreResult =
  | { ok: true; store: UsdaRecordStore }
  | { ok: false; code: UsdaStoreFailureCode; message: string };

function storeFailure(code: UsdaStoreFailureCode): UsdaStoreResult {
  return { ok: false, code, message: STORE_FAILURE_MESSAGE[code] };
}

function makeKey(bundleRelease: string, fdcId: number): string {
  return `${bundleRelease}::${fdcId}`;
}

/**
 * Builds a trusted read-only store from a validated manifest and canonical
 * records. Returns a closed failure classification when anything is invalid.
 */
export function createUsdaRecordStore(manifestRaw: unknown, recordsRaw: unknown): UsdaStoreResult {
  const manifestValidation = validateManifest(manifestRaw);
  if (!manifestValidation.ok) return storeFailure('invalid_manifest');
  const manifest: UsdaBundleManifest = manifestValidation.manifest;

  if (!Array.isArray(recordsRaw)) return storeFailure('invalid_record');

  const records: CanonicalUsdaFoodRecord[] = [];
  for (const raw of recordsRaw) {
    const validation = validateCanonicalRecord(raw);
    if (!validation.ok) return storeFailure('invalid_record');
    records.push(validation.record);
  }

  const componentByType = new Map<UsdaDataType, string>();
  for (const component of manifest.components) {
    componentByType.set(component.data_type, component.upstream_release);
  }

  const index = new Map<string, CanonicalUsdaFoodRecord>();
  for (const record of records) {
    if (record.bundle_release !== manifest.bundle_release) return storeFailure('release_mismatch');
    if (record.nutrient_map_version !== manifest.nutrient_map_version) return storeFailure('release_mismatch');
    const expectedUpstream = componentByType.get(record.data_type);
    if (expectedUpstream === undefined || expectedUpstream !== record.upstream_release) {
      return storeFailure('release_mismatch');
    }
    const key = makeKey(record.bundle_release, record.fdc_id);
    if (index.has(key)) return storeFailure('duplicate_fdc_id');
    index.set(key, record);
  }

  if (records.length !== manifest.canonical_record_count) return storeFailure('count_mismatch');
  if (computeCanonicalContentDigest(records) !== manifest.canonical_content_digest) {
    return storeFailure('content_digest_mismatch');
  }

  const upstreamReleases: Partial<Record<UsdaDataType, string>> = {};
  for (const component of manifest.components) {
    upstreamReleases[component.data_type] = component.upstream_release;
  }

  const metadata: UsdaStoreMetadata = Object.freeze({
    bundle_release: manifest.bundle_release,
    canonical_record_count: manifest.canonical_record_count,
    rejected_record_count: manifest.rejected_record_count,
    data_types: Object.freeze([...manifest.data_types]),
    upstream_releases: Object.freeze(upstreamReleases),
    nutrient_map_version: manifest.nutrient_map_version,
    canonicalization_version: manifest.canonicalization_version,
  });

  const store: UsdaRecordStore = Object.freeze({
    lookup(bundleRelease: string, fdcId: number): UsdaLookupResult {
      if (typeof fdcId !== 'number' || !Number.isSafeInteger(fdcId) || fdcId <= 0) {
        return { ok: false, code: 'invalid_fdc_id' };
      }
      if (typeof bundleRelease !== 'string' || bundleRelease !== manifest.bundle_release) {
        return { ok: false, code: 'not_found' };
      }
      const record = index.get(makeKey(bundleRelease, fdcId));
      if (!record) return { ok: false, code: 'not_found' };
      return { ok: true, record };
    },
    metadata(): UsdaStoreMetadata {
      return metadata;
    },
  });

  return { ok: true, store };
}
