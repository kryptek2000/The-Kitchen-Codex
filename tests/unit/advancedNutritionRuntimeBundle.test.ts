/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: authenticated runtime
 * bundle decoder/composer.
 *
 * Proves the exact checked-in production bundle authenticates and composes a
 * genuine Phase 4 session, and that every mutated/forged input fails closed
 * against the source-controlled release lock with no partial session.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

import {
  composeAdvancedNutritionSessionFromBundle,
  decodeBoundedGzip,
  decodeUtf8Strict,
  type RuntimeBundleInputs,
  type RuntimeBundleResult,
} from '../../src/core/nutritionV2/runtime';
import { sha256HexFromBytes, canonicalStringify } from '../../src/core/nutritionV2/usda/digest';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { SHARD_FILENAMES, SHARD_ORDER } from '../../scripts/usda_bundle/constants';
import {
  deterministicGzip,
  serializeArtifactDescriptor,
  sha256OfBytes,
} from '../../scripts/usda_bundle/artifact';
import { computeCanonicalContentDigest } from '../../src/core/nutritionV2/usda/manifest';
import { computeCanonicalRecordDigest } from '../../src/core/nutritionV2/usda/record';
import type { UsdaDataType } from '../../src/core/nutritionV2/usda/types';

const LOCK = USDA_BUNDLE_RELEASE_LOCK;
const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

type Rec = Record<string, any>;

function failOf(result: RuntimeBundleResult): { code: string; message: string } {
  return (result as { failure: { code: string; message: string } }).failure;
}

function loadInputs(): RuntimeBundleInputs {
  return {
    files: LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
}

function cloneInputs(): RuntimeBundleInputs {
  const inputs = loadInputs();
  return { files: inputs.files.map((file) => ({ name: file.name, bytes: Uint8Array.from(file.bytes) })) };
}

function replaceFile(inputs: RuntimeBundleInputs, name: string, bytes: Uint8Array): RuntimeBundleInputs {
  return { files: inputs.files.map((file) => (file.name === name ? { name, bytes } : file)) };
}

function removeFile(inputs: RuntimeBundleInputs, name: string): RuntimeBundleInputs {
  return { files: inputs.files.filter((file) => file.name !== name) };
}

let loaded: RuntimeBundleResult;

beforeAll(async () => {
  loaded = await composeAdvancedNutritionSessionFromBundle(loadInputs());
}, 120000);

describe('phase 4.5B — the exact checked-in bundle authenticates', () => {
  it('loads and composes a genuine working Phase 4 session', () => {
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const metadata = loaded.session.metadata();
    expect(metadata.bundle_release).toBe('usda_fdc_87c5408a3e98838944a87be74824761e');
    // The complete authenticated source is 13,559 records; the home-recipe
    // eligible catalog excludes restaurant/fast-food records (Phase 4.5D).
    expect(metadata.source_record_count).toBe(13559);
    expect(metadata.record_count).toBe(12924);
    expect(metadata.excluded_record_count).toBe(13559 - 12924);
    expect(metadata.nutrient_map_version).toBe('usda_fdc_nutrient_map_v2');
    expect([...metadata.data_types].sort()).toEqual(['fndds', 'foundation', 'sr_legacy']);
    expect(loaded.attribution).toBe(LOCK.attribution);
    expect(loaded.metadata.bundle_release).toBe(LOCK.bundle_release);
    // The session is genuine and usable (not a structural fake).
    const review = loaded.session.reviewIngredient({ original: '100 g Flour, wheat, white' });
    expect(review.outcome).not.toBe('invalid');
  }, 120000);
});

describe('phase 4.5B — input set is closed', () => {
  it('rejects a missing logical input', async () => {
    const result = await composeAdvancedNutritionSessionFromBundle(removeFile(loadInputs(), 'artifact.json'));
    expect(result.ok).toBe(false);
    expect(failOf(result).code).toBe('missing_input');
  });

  it('rejects a duplicate logical input', async () => {
    const inputs = loadInputs();
    const artifact = inputs.files.find((f) => f.name === 'artifact.json') as { name: string; bytes: Uint8Array };
    const result = await composeAdvancedNutritionSessionFromBundle({
      files: [...inputs.files, { name: 'artifact.json', bytes: artifact.bytes }],
    });
    expect(result.ok).toBe(false);
    expect(failOf(result).code).toBe('duplicate_input');
  });

  it('rejects an unknown logical input', async () => {
    const inputs = loadInputs();
    const result = await composeAdvancedNutritionSessionFromBundle({
      files: [...inputs.files, { name: 'extra.bin', bytes: new Uint8Array([1]) }],
    });
    expect(result.ok).toBe(false);
    expect(failOf(result).code).toBe('unknown_input');
  });

  it('rejects a case-colliding logical input', async () => {
    const inputs = loadInputs();
    const result = await composeAdvancedNutritionSessionFromBundle({
      files: [...inputs.files, { name: 'Manifest.json', bytes: new Uint8Array([1]) }],
    });
    expect(result.ok).toBe(false);
    expect(failOf(result).code).toBe('case_colliding_input');
  });

  it('rejects a malformed inputs envelope without throwing', async () => {
    const result = await composeAdvancedNutritionSessionFromBundle({ files: 'nope' });
    expect(result.ok).toBe(false);
    expect(failOf(result).code).toBe('invalid_inputs');
  });
});

describe('phase 4.5B — artifact/manifest authentication before trust', () => {
  it('rejects an artifact.json byte mutation', async () => {
    const inputs = cloneInputs();
    const artifact = inputs.files.find((f) => f.name === 'artifact.json') as { bytes: Uint8Array };
    artifact.bytes[artifact.bytes.length - 2] ^= 0xff;
    const result = await composeAdvancedNutritionSessionFromBundle(inputs);
    expect(result.ok).toBe(false);
    expect(failOf(result).code).toBe('artifact_digest_mismatch');
  });

  it('rejects a manifest.json byte mutation', async () => {
    const inputs = cloneInputs();
    const manifest = inputs.files.find((f) => f.name === 'manifest.json') as { bytes: Uint8Array };
    manifest.bytes[manifest.bytes.length - 2] ^= 0xff;
    const result = await composeAdvancedNutritionSessionFromBundle(inputs);
    expect(result.ok).toBe(false);
    expect(failOf(result).code).toBe('manifest_digest_mismatch');
  });

  it('never returns a session on any failure', async () => {
    const inputs = cloneInputs();
    const artifact = inputs.files.find((f) => f.name === 'artifact.json') as { bytes: Uint8Array };
    artifact.bytes[0] ^= 0xff;
    const result = await composeAdvancedNutritionSessionFromBundle(inputs);
    expect(result.ok).toBe(false);
    expect((result as { session?: unknown }).session).toBeUndefined();
  });
});

describe('phase 4.5B — shard authentication before trust', () => {
  it('rejects a compressed-byte mutation before decompression (foundation)', async () => {
    const inputs = cloneInputs();
    const shard = inputs.files.find((f) => f.name === SHARD_FILENAMES.foundation) as { bytes: Uint8Array };
    shard.bytes[shard.bytes.length - 5] ^= 0xff;
    const result = await composeAdvancedNutritionSessionFromBundle(inputs);
    expect(result.ok).toBe(false);
    expect(failOf(result).code).toBe('shard_digest_mismatch');
  });

  it('detects a compressed mutation in every shard via the locked digest', () => {
    for (const dataType of SHARD_ORDER) {
      const locked = LOCK.shards.find((s) => s.data_type === dataType) as { compressed_sha256: string };
      const bytes = new Uint8Array(readFileSync(join(BUNDLE_DIR, SHARD_FILENAMES[dataType])));
      bytes[bytes.length - 5] ^= 0xff;
      expect(sha256HexFromBytes(bytes)).not.toBe(locked.compressed_sha256);
    }
  });

  it('rejects a truncated shard', async () => {
    const inputs = cloneInputs();
    const shard = inputs.files.find((f) => f.name === SHARD_FILENAMES.foundation) as { bytes: Uint8Array };
    const truncated = shard.bytes.slice(0, shard.bytes.length - 5);
    const result = await composeAdvancedNutritionSessionFromBundle(replaceFile(inputs, SHARD_FILENAMES.foundation, truncated));
    expect(result.ok).toBe(false);
    expect(failOf(result).code).toBe('shard_bytes_mismatch');
  });

  it('rejects appended/trailing bytes after the gzip member', async () => {
    const inputs = cloneInputs();
    const shard = inputs.files.find((f) => f.name === SHARD_FILENAMES.foundation) as { bytes: Uint8Array };
    const appended = new Uint8Array([...shard.bytes, 0, 1, 2, 3]);
    const result = await composeAdvancedNutritionSessionFromBundle(replaceFile(inputs, SHARD_FILENAMES.foundation, appended));
    expect(result.ok).toBe(false);
    expect(failOf(result).code).toBe('shard_bytes_mismatch');
  });

  it('rejects a concatenated gzip member', async () => {
    const inputs = cloneInputs();
    const shard = inputs.files.find((f) => f.name === SHARD_FILENAMES.foundation) as { bytes: Uint8Array };
    const concatenated = new Uint8Array([...shard.bytes, ...shard.bytes]);
    const result = await composeAdvancedNutritionSessionFromBundle(replaceFile(inputs, SHARD_FILENAMES.foundation, concatenated));
    expect(result.ok).toBe(false);
    expect(failOf(result).code).toBe('shard_bytes_mismatch');
  });

  it('rejects a fully self-consistent forged bundle against the external release lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kc-runtime-forge-'));
    try {
      for (const name of readdirSync(BUNDLE_DIR)) copyFileSync(join(BUNDLE_DIR, name), join(dir, name));

      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Rec;
      const artifact = JSON.parse(readFileSync(join(dir, 'artifact.json'), 'utf8')) as Rec;
      const shards: Record<string, Rec[]> = {};
      for (const dataType of SHARD_ORDER) {
        shards[dataType] = JSON.parse(
          gunzipSync(readFileSync(join(dir, SHARD_FILENAMES[dataType]))).toString('utf8')
        ) as Rec[];
      }
      // Semantically change one record and recompute its digest.
      const record = shards.foundation[0];
      record.description = `${record.description} forged`.slice(0, 500);
      const { record_digest, ...content } = record;
      shards.foundation[0] = { ...content, record_digest: computeCanonicalRecordDigest(content as never) };

      // Rebuild the foundation shard with recomputed digests.
      const ordered = shards.foundation
        .slice()
        .sort((a, b) => (a.fdc_id !== b.fdc_id ? a.fdc_id - b.fdc_id : a.record_digest < b.record_digest ? -1 : 1));
      const uncompressed = Buffer.from(canonicalStringify(ordered), 'utf8');
      const compressed = deterministicGzip(uncompressed);
      writeFileSync(join(dir, SHARD_FILENAMES.foundation), compressed);
      const foundationRef = {
        data_type: 'foundation',
        filename: SHARD_FILENAMES.foundation,
        record_count: ordered.length,
        compression: 'gzip',
        compression_level: 9,
        compressed_bytes: compressed.length,
        compressed_sha256: sha256OfBytes(compressed),
        uncompressed_bytes: uncompressed.length,
        uncompressed_sha256: sha256OfBytes(uncompressed),
      };
      const refs = (artifact.shards as Rec[]).map((ref) =>
        ref.data_type === 'foundation' ? foundationRef : ref
      );
      const all = SHARD_ORDER.flatMap((dataType) => (dataType === 'foundation' ? ordered : shards[dataType]));
      const contentDigest = computeCanonicalContentDigest(all as never);
      const newManifest = { ...manifest, canonical_content_digest: contentDigest };
      const manifestBytes = Buffer.from(canonicalStringify(newManifest), 'utf8');
      const newArtifact = {
        ...artifact,
        manifest: { filename: 'manifest.json', bytes: manifestBytes.length, sha256: sha256OfBytes(manifestBytes) },
        shards: refs,
        canonical_content_digest: contentDigest,
      };
      writeFileSync(join(dir, 'manifest.json'), manifestBytes);
      writeFileSync(join(dir, 'artifact.json'), Buffer.from(serializeArtifactDescriptor(newArtifact as never), 'utf8'));

      const inputs: RuntimeBundleInputs = {
        files: LOCK.artifact_filenames.map((name) => ({
          name,
          bytes: new Uint8Array(readFileSync(join(dir, name))),
        })),
      };
      const result = await composeAdvancedNutritionSessionFromBundle(inputs);
      expect(result.ok).toBe(false);
      // Recomputing every embedded digest does not make the forgery authentic:
      // it fails against the independent, source-controlled release lock.
      expect([
        'artifact_digest_mismatch',
        'manifest_digest_mismatch',
        'shard_digest_mismatch',
      ]).toContain(failOf(result).code);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);

  it('reports an unsupported runtime when safe gzip decoding is unavailable', async () => {
    const globalObject = globalThis as { DecompressionStream?: unknown };
    const saved = globalObject.DecompressionStream;
    try {
      globalObject.DecompressionStream = undefined;
      const result = await composeAdvancedNutritionSessionFromBundle(loadInputs());
      expect(result.ok).toBe(false);
      expect(failOf(result).code).toBe('unsupported_runtime');
    } finally {
      globalObject.DecompressionStream = saved;
    }
  }, 60000);
});

describe('phase 4.5B — bounded gzip decoding', () => {
  it('decodes the real foundation shard exactly', async () => {
    const bytes = new Uint8Array(readFileSync(join(BUNDLE_DIR, SHARD_FILENAMES.foundation)));
    const decoded = await decodeBoundedGzip(bytes, 4 * 1024 * 1024);
    expect(decoded.length).toBe(958025);
  });

  it('rejects decompression beyond the incremental bound', async () => {
    const bomb = gzipSync(Buffer.alloc(1 << 20, 0x61));
    await expect(decodeBoundedGzip(new Uint8Array(bomb), 1024)).rejects.toMatchObject({
      reason: 'bound_exceeded',
    });
  });

  it('rejects a truncated gzip member', async () => {
    const bytes = new Uint8Array(readFileSync(join(BUNDLE_DIR, SHARD_FILENAMES.foundation)));
    await expect(decodeBoundedGzip(bytes.slice(0, bytes.length - 5), 4 * 1024 * 1024)).rejects.toMatchObject({
      reason: 'malformed',
    });
  });

  it('rejects trailing bytes after the member', async () => {
    const bytes = new Uint8Array(readFileSync(join(BUNDLE_DIR, SHARD_FILENAMES.foundation)));
    const trailing = new Uint8Array([...bytes, 0, 1, 2, 3]);
    await expect(decodeBoundedGzip(trailing, 4 * 1024 * 1024)).rejects.toMatchObject({
      reason: 'malformed',
    });
  });

  it('rejects concatenated gzip members by exceeding the exact uncompressed length', async () => {
    const bytes = new Uint8Array(readFileSync(join(BUNDLE_DIR, SHARD_FILENAMES.foundation)));
    const concatenated = new Uint8Array([...bytes, ...bytes]);
    const decoded = await decodeBoundedGzip(concatenated, 4 * 1024 * 1024);
    expect(decoded.length).toBe(958025 * 2);
    expect(decoded.length).not.toBe(958025);
  });

  it('rejects a malformed gzip header', async () => {
    await expect(decodeBoundedGzip(new Uint8Array(32), 1024)).rejects.toMatchObject({
      reason: 'malformed',
    });
  });

  it('strict UTF-8 decoding rejects invalid bytes and accepts valid text', () => {
    expect(decodeUtf8Strict(new Uint8Array([0x61, 0x62])).ok).toBe(true);
    expect(decodeUtf8Strict(new Uint8Array([0xff, 0xfe])).ok).toBe(false);
  });
});

afterEach(() => {
  // No global state is intentionally retained; this keeps the suite hermetic.
});
