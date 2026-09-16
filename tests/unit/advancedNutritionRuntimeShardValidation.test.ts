/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: decoded-shard validation.
 *
 * F1 remediation: `validateDecodedShard` is now a MODULE-PRIVATE function of the
 * locked composer. These tests exercise the actual production validation code by
 * driving the real composer with a TEST-TIME module mock of the statically
 * imported release-lock module, supplying synthetic but internally consistent
 * inputs. The mock is confined to this test file; the production module exposes
 * no override mechanism, no caller-supplied lock, and no validator hook.
 *
 * Coverage preserved: malformed UTF-8, malformed JSON, non-array JSON,
 * noncanonical JSON, invalid canonical record, duplicate FDC ID, data-type
 * mismatch, bundle-release mismatch, upstream-release mismatch, nutrient-map
 * mismatch, count mismatch, uncompressed-length mismatch, uncompressed-digest
 * mismatch, plus a positive control.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const holder = vi.hoisted(() => ({ lock: null as unknown }));

vi.mock('../../src/core/nutritionV2/usda/releaseLock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/nutritionV2/usda/releaseLock')>();
  return {
    ...actual,
    get USDA_BUNDLE_RELEASE_LOCK() {
      return holder.lock ?? actual.USDA_BUNDLE_RELEASE_LOCK;
    },
  };
});

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import {
  canonicalStringify,
  sha256HexFromBytes,
  utf8Encode,
} from '../../src/core/nutritionV2/usda/digest';
import {
  computeCanonicalContentDigest,
  deriveBundleReleaseId,
} from '../../src/core/nutritionV2/usda/manifest';
import { computeCanonicalRecordDigest } from '../../src/core/nutritionV2/usda/record';
import { USDA_NUTRIENT_MAP_VERSION } from '../../src/core/nutritionV2/usda/nutrientMap';
import {
  USDA_ATTRIBUTION,
  USDA_CANONICALIZATION_VERSION,
  type UsdaDataType,
} from '../../src/core/nutritionV2/usda/types';

type Rec = Record<string, any>;

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);
const DATA_TYPES: ReadonlyArray<UsdaDataType> = ['foundation', 'sr_legacy', 'fndds'];
const FILENAMES: Record<UsdaDataType, string> = {
  foundation: 'records.foundation.json.gz',
  sr_legacy: 'records.sr_legacy.json.gz',
  fndds: 'records.fndds.json.gz',
};
const UPSTREAM = ['2026-04', '2018-04', '2021-2023 (2024-10)'];
const SOURCE_URLS = [
  'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip',
  'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip',
  'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip',
];
const SOURCE_SHA = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];

function realRecords(filename: string): Rec[] {
  return JSON.parse(gunzipSync(readFileSync(join(BUNDLE_DIR, filename))).toString('utf8')) as Rec[];
}

function reDigest(record: Rec, changes: Rec): Rec {
  const merged = { ...record, ...changes };
  const { record_digest, ...content } = merged;
  return { ...content, record_digest: computeCanonicalRecordDigest(content as never) };
}

interface SyntheticOptions {
  readonly recordCount?: number;
  readonly totalRecordCount?: number;
  readonly contentDigest?: string;
  readonly overrideUncompressedBytes?: number;
  readonly overrideUncompressedSha?: string;
}

/** Builds a synthetic 3-shard bundle whose lock is internally consistent. */
function buildSyntheticBundle(foundationUncompressed: Uint8Array, opts: SyntheticOptions = {}) {
  const uncompressedByType: Record<UsdaDataType, Uint8Array> = {
    foundation: foundationUncompressed,
    sr_legacy: utf8Encode('[]'),
    fndds: utf8Encode('[]'),
  };
  const compressedByType = {} as Record<UsdaDataType, Uint8Array>;
  for (const dataType of DATA_TYPES) {
    compressedByType[dataType] = new Uint8Array(gzipSync(Buffer.from(uncompressedByType[dataType])));
  }

  const recordCounts: Record<UsdaDataType, number> = {
    foundation: opts.recordCount ?? 0,
    sr_legacy: 0,
    fndds: 0,
  };
  const recordedBytes: Record<UsdaDataType, number> = {
    foundation: opts.overrideUncompressedBytes ?? uncompressedByType.foundation.length,
    sr_legacy: uncompressedByType.sr_legacy.length,
    fndds: uncompressedByType.fndds.length,
  };
  const recordedSha: Record<UsdaDataType, string> = {
    foundation: opts.overrideUncompressedSha ?? sha256HexFromBytes(uncompressedByType.foundation),
    sr_legacy: sha256HexFromBytes(uncompressedByType.sr_legacy),
    fndds: sha256HexFromBytes(uncompressedByType.fndds),
  };

  const components = DATA_TYPES.map((dataType, i) => ({
    data_type: dataType,
    upstream_release: UPSTREAM[i],
    source_url: SOURCE_URLS[i],
    source_sha256: SOURCE_SHA[i],
  }));
  const shards = DATA_TYPES.map((dataType) => ({
    data_type: dataType,
    filename: FILENAMES[dataType],
    record_count: recordCounts[dataType],
    compression: 'gzip' as const,
    compression_level: 9,
    compressed_bytes: compressedByType[dataType].length,
    compressed_sha256: sha256HexFromBytes(compressedByType[dataType]),
    uncompressed_bytes: recordedBytes[dataType],
    uncompressed_sha256: recordedSha[dataType],
  }));

  const totalRecordCount = opts.totalRecordCount ?? recordCounts.foundation;
  const contentDigest = opts.contentDigest ?? 'd'.repeat(64);
  const manifestBase = {
    manifest_schema: 1,
    bundle_release: 'pending',
    generator: { name: 'the-kitchen-codex-usda-bundle', schema_version: '1' },
    created_at: '2026-09-15T00:00:00.000Z',
    data_types: [...DATA_TYPES],
    components,
    canonical_record_count: totalRecordCount,
    rejected_record_count: 0,
    canonical_content_digest: contentDigest,
    nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
    canonicalization_version: USDA_CANONICALIZATION_VERSION,
    attribution: USDA_ATTRIBUTION,
  };
  const manifest = { ...manifestBase, bundle_release: deriveBundleReleaseId(manifestBase as never) };
  const manifestBytes = utf8Encode(canonicalStringify(manifest));
  const totalCompressed = shards.reduce((sum, shard) => sum + shard.compressed_bytes, 0);
  const totalUncompressed = shards.reduce((sum, shard) => sum + shard.uncompressed_bytes, 0);
  const artifact = {
    artifact_schema: 1,
    bundle_release: manifest.bundle_release,
    manifest: {
      filename: 'manifest.json',
      bytes: manifestBytes.length,
      sha256: sha256HexFromBytes(manifestBytes),
    },
    shards,
    total_record_count: totalRecordCount,
    total_compressed_bytes: totalCompressed,
    total_uncompressed_bytes: totalUncompressed,
    canonical_content_digest: contentDigest,
    attribution: USDA_ATTRIBUTION,
  };
  const artifactBytes = utf8Encode(canonicalStringify(artifact));

  const lock = {
    lock_schema: 1,
    bundle_release: manifest.bundle_release,
    generator: manifest.generator,
    created_at: manifest.created_at,
    nutrient_map_version: manifest.nutrient_map_version,
    canonicalization_version: manifest.canonicalization_version,
    sources: components.map((component, i) => ({
      data_type: component.data_type,
      upstream_release: component.upstream_release,
      archive_filename: `archive-${i}.zip`,
      source_url: component.source_url,
      sha256: component.source_sha256,
    })),
    artifact_filenames: [
      'artifact.json',
      'manifest.json',
      FILENAMES.foundation,
      FILENAMES.sr_legacy,
      FILENAMES.fndds,
    ],
    canonical_record_count: totalRecordCount,
    rejected_record_count: 0,
    null_placeholder_count: 0,
    canonical_content_digest: contentDigest,
    manifest: artifact.manifest,
    artifact: {
      filename: 'artifact.json',
      bytes: artifactBytes.length,
      sha256: sha256HexFromBytes(artifactBytes),
    },
    shards,
    total_compressed_bytes: totalCompressed,
    total_uncompressed_bytes: totalUncompressed,
    warnings: [],
    attribution: USDA_ATTRIBUTION,
  };

  return {
    lock,
    inputs: {
      files: [
        { name: 'artifact.json', bytes: artifactBytes },
        { name: 'manifest.json', bytes: manifestBytes },
        { name: FILENAMES.foundation, bytes: compressedByType.foundation },
        { name: FILENAMES.sr_legacy, bytes: compressedByType.sr_legacy },
        { name: FILENAMES.fndds, bytes: compressedByType.fndds },
      ],
    },
  };
}

function failureCode(result: unknown): string {
  return (result as { failure: { code: string } }).failure.code;
}

beforeEach(() => {
  holder.lock = null;
});
afterEach(() => {
  holder.lock = null;
});

describe('phase 4.5B — decoded-shard validation via the locked composer', () => {
  it('positive control: a synthetic valid bundle composes a genuine session', async () => {
    const syntheticRelease = buildSyntheticBundle(utf8Encode('[]'), { totalRecordCount: 1 }).lock.bundle_release;
    const record = reDigest(realRecords(FILENAMES.foundation)[0], { bundle_release: syntheticRelease });
    const uncompressed = utf8Encode(canonicalStringify([record]));
    const bundle = buildSyntheticBundle(uncompressed, {
      recordCount: 1,
      totalRecordCount: 1,
      contentDigest: computeCanonicalContentDigest([record] as never),
    });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.metadata().record_count).toBe(1);
  });

  it('rejects malformed UTF-8', async () => {
    const bundle = buildSyntheticBundle(new Uint8Array([0xff, 0xfe, 0xfd]), { recordCount: 1 });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('shard_utf8_invalid');
  });

  it('rejects malformed JSON', async () => {
    const bundle = buildSyntheticBundle(utf8Encode('{not json'), { recordCount: 1 });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('shard_json_invalid');
  });

  it('rejects a non-array JSON value', async () => {
    const bundle = buildSyntheticBundle(utf8Encode('{"a":1}'), { recordCount: 1 });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('shard_not_array');
  });

  it('rejects non-canonical JSON', async () => {
    const bundle = buildSyntheticBundle(utf8Encode('[{"b":1,"a":2}]'), { recordCount: 1 });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('shard_not_canonical');
  });

  it('rejects an invalid canonical record', async () => {
    const bundle = buildSyntheticBundle(utf8Encode(canonicalStringify([{ foo: 1 }])), { recordCount: 1 });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('invalid_canonical_record');
  });

  it('rejects a duplicate FDC id', async () => {
    const syntheticRelease = buildSyntheticBundle(utf8Encode('[]'), { totalRecordCount: 1 }).lock.bundle_release;
    const record = reDigest(realRecords(FILENAMES.foundation)[0], { bundle_release: syntheticRelease });
    const bundle = buildSyntheticBundle(utf8Encode(canonicalStringify([record, record])), {
      recordCount: 2,
      totalRecordCount: 2,
    });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('duplicate_fdc_id');
  });

  it('rejects a data-type mismatch', async () => {
    const record = realRecords(FILENAMES.fndds)[0];
    const bundle = buildSyntheticBundle(utf8Encode(canonicalStringify([record])), {
      recordCount: 1,
      totalRecordCount: 1,
    });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('record_identity_mismatch');
  });

  it('rejects a bundle-release mismatch', async () => {
    const record = reDigest(realRecords(FILENAMES.foundation)[0], {
      bundle_release: 'usda_fdc_deadbeefdeadbeefdeadbeefdeadbeef',
    });
    const bundle = buildSyntheticBundle(utf8Encode(canonicalStringify([record])), {
      recordCount: 1,
      totalRecordCount: 1,
    });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('record_identity_mismatch');
  });

  it('rejects an upstream-release mismatch', async () => {
    const record = reDigest(realRecords(FILENAMES.foundation)[0], { upstream_release: 'bogus' });
    const bundle = buildSyntheticBundle(utf8Encode(canonicalStringify([record])), {
      recordCount: 1,
      totalRecordCount: 1,
    });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('record_identity_mismatch');
  });

  it('rejects a nutrient-map mismatch', async () => {
    const record = reDigest(realRecords(FILENAMES.foundation)[0], { nutrient_map_version: 'bogus_map' });
    const bundle = buildSyntheticBundle(utf8Encode(canonicalStringify([record])), {
      recordCount: 1,
      totalRecordCount: 1,
    });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('record_identity_mismatch');
  });

  it('rejects an exact-count mismatch', async () => {
    const record = realRecords(FILENAMES.foundation)[0];
    const bundle = buildSyntheticBundle(utf8Encode(canonicalStringify([record])), {
      recordCount: 2,
      totalRecordCount: 2,
    });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('count_mismatch');
  });

  it('rejects an uncompressed length mismatch', async () => {
    const record = realRecords(FILENAMES.foundation)[0];
    const uncompressed = utf8Encode(canonicalStringify([record]));
    const bundle = buildSyntheticBundle(uncompressed, {
      recordCount: 1,
      totalRecordCount: 1,
      overrideUncompressedBytes: uncompressed.length + 1,
    });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('shard_bytes_mismatch');
  });

  it('rejects an uncompressed digest mismatch', async () => {
    const record = realRecords(FILENAMES.foundation)[0];
    const uncompressed = utf8Encode(canonicalStringify([record]));
    const bundle = buildSyntheticBundle(uncompressed, {
      recordCount: 1,
      totalRecordCount: 1,
      overrideUncompressedSha: '0'.repeat(64),
    });
    holder.lock = bundle.lock;
    const result = await composeAdvancedNutritionSessionFromBundle(bundle.inputs);
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('shard_digest_mismatch');
  });
});
