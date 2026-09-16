/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: fully self-consistent forgery.
 *
 * Proves that internal self-consistency (accidental-corruption integrity) is NOT
 * authenticity. Each forgery recomputes every embedded digest/byte-length/hash so
 * it passes `verifyBundleDirectoryIntegrityOnly`, yet MUST fail the real exported
 * authenticity-bearing `verifyBundleDirectory` against the source-controlled
 * release trust lock.
 *
 * MUTATION SENSITIVITY
 * --------------------
 * Each case below is caught by a specific locked comparison. Removing that
 * comparison (while keeping internal consistency) makes the corresponding
 * `expect(result.ok).toBe(false)` fail — so the permanent suite detects the
 * removal. The mapping:
 *   - description / nutrient amount  -> artifact+manifest+shard locked hashes,
 *                                       canonical-content locked digest
 *   - artifact-bytes-only            -> artifact descriptor locked hash
 *   - compressed-shard-bytes-only    -> compressed shard locked hash
 *   - record removal                 -> locked count
 *   - warning-count change           -> locked count/warnings
 */

import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';

import {
  expectedArtifactDir,
  verifyBundleDirectory,
  verifyBundleDirectoryIntegrityOnly,
} from '../../scripts/usda_bundle/verify';
import {
  boundedGunzip,
  deterministicGzip,
  serializeArtifactDescriptor,
  sha256OfBytes,
} from '../../scripts/usda_bundle/artifact';
import { canonicalStringify } from '../../src/core/nutritionV2/usda/digest';
import { computeCanonicalContentDigest } from '../../src/core/nutritionV2/usda/manifest';
import { computeCanonicalRecordDigest } from '../../src/core/nutritionV2/usda/record';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { SHARD_FILENAMES, SHARD_ORDER } from '../../scripts/usda_bundle/constants';
import type { UsdaDataType } from '../../src/core/nutritionV2/usda/types';

type Rec = Record<string, any>;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kc-forge-'));
  tempDirs.push(dir);
  return dir;
}

function copyCandidate(): string {
  const dir = tempDir();
  const source = expectedArtifactDir();
  for (const name of readdirSync(source)) copyFileSync(join(source, name), join(dir, name));
  return dir;
}

function loadShard(dir: string, dataType: UsdaDataType): Rec[] {
  const bytes = boundedGunzip(readFileSync(join(dir, SHARD_FILENAMES[dataType])), 128 * 1024 * 1024);
  return JSON.parse(bytes.toString('utf8')) as Rec[];
}

function sortRecords(records: Rec[]): Rec[] {
  return records
    .slice()
    .sort((a, b) => (a.fdc_id !== b.fdc_id ? a.fdc_id - b.fdc_id : a.record_digest < b.record_digest ? -1 : 1));
}

function reDigest(record: Rec): Rec {
  const { record_digest, ...content } = record;
  return { ...content, record_digest: computeCanonicalRecordDigest(content as never) };
}

/**
 * Rebuild a fully self-consistent artifact. Only shards in `changed` are
 * re-serialized/re-compressed; unchanged shards reuse the candidate bytes and
 * descriptor refs. Every embedded digest/length/hash is recomputed.
 */
function writeForged(
  dir: string,
  shards: Record<UsdaDataType, Rec[]>,
  changed: ReadonlySet<UsdaDataType>,
  mutateManifest?: (manifest: Rec) => Rec
): Rec {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Rec;
  const artifact = JSON.parse(readFileSync(join(dir, 'artifact.json'), 'utf8')) as Rec;

  const refs: Rec[] = [];
  const all: Rec[] = [];
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (const dataType of SHARD_ORDER) {
    let ref: Rec;
    if (changed.has(dataType)) {
      const records = sortRecords(shards[dataType]);
      const uncompressed = Buffer.from(canonicalStringify(records), 'utf8');
      const compressed = deterministicGzip(uncompressed);
      ref = {
        data_type: dataType,
        filename: SHARD_FILENAMES[dataType],
        record_count: records.length,
        compression: 'gzip',
        compression_level: 9,
        compressed_bytes: compressed.length,
        compressed_sha256: sha256OfBytes(compressed),
        uncompressed_bytes: uncompressed.length,
        uncompressed_sha256: sha256OfBytes(uncompressed),
      };
      writeFileSync(join(dir, SHARD_FILENAMES[dataType]), compressed);
      all.push(...records);
    } else {
      ref = { ...(artifact.shards as Rec[]).find((entry) => entry.data_type === dataType) };
      all.push(...shards[dataType]);
    }
    refs.push(ref);
    totalCompressed += ref.compressed_bytes;
    totalUncompressed += ref.uncompressed_bytes;
  }

  const contentDigest = computeCanonicalContentDigest(all as never);
  let newManifest: Rec = {
    ...manifest,
    canonical_record_count: all.length,
    canonical_content_digest: contentDigest,
  };
  if (mutateManifest) newManifest = mutateManifest(newManifest);
  const manifestBytes = Buffer.from(canonicalStringify(newManifest), 'utf8');
  const newArtifact: Rec = {
    ...artifact,
    manifest: { filename: 'manifest.json', bytes: manifestBytes.length, sha256: sha256OfBytes(manifestBytes) },
    shards: refs,
    total_record_count: all.length,
    total_compressed_bytes: totalCompressed,
    total_uncompressed_bytes: totalUncompressed,
    canonical_content_digest: contentDigest,
  };
  writeFileSync(join(dir, 'manifest.json'), manifestBytes);
  writeFileSync(join(dir, 'artifact.json'), Buffer.from(serializeArtifactDescriptor(newArtifact as never), 'utf8'));
  return newManifest;
}

function loadAllShards(dir: string): Record<UsdaDataType, Rec[]> {
  return {
    foundation: loadShard(dir, 'foundation'),
    sr_legacy: loadShard(dir, 'sr_legacy'),
    fndds: loadShard(dir, 'fndds'),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

describe('phase 4.5A fully self-consistent forgery', () => {
  it('rejects a semantically changed canonical description even though it is fully recomputed', () => {
    const dir = copyCandidate();
    const shards = loadAllShards(dir);
    const record = shards.foundation[0];
    record.description = `${record.description} forged`.slice(0, 500);
    shards.foundation[0] = reDigest(record);

    const manifest = writeForged(dir, shards, new Set<UsdaDataType>(['foundation']));

    // Preserved non-content identities.
    expect(manifest.bundle_release).toBe(USDA_BUNDLE_RELEASE_LOCK.bundle_release);
    expect(manifest.canonical_record_count).toBe(USDA_BUNDLE_RELEASE_LOCK.canonical_record_count);
    expect(manifest.rejected_record_count).toBe(USDA_BUNDLE_RELEASE_LOCK.rejected_record_count);
    expect(manifest.generator).toEqual(USDA_BUNDLE_RELEASE_LOCK.generator);

    // Fully self-consistent (integrity-only passes) but NOT authentic.
    expect(verifyBundleDirectoryIntegrityOnly(dir).ok).toBe(true);
    expect(verifyBundleDirectory(dir).ok).toBe(false);
  }, 300000);

  it('rejects a nutrient amount changed within valid numeric bounds even though it is fully recomputed', () => {
    const dir = copyCandidate();
    const shards = loadAllShards(dir);
    let changedType: UsdaDataType | null = null;
    for (const dataType of SHARD_ORDER) {
      for (let i = 0; i < shards[dataType].length && !changedType; i += 1) {
        const record = shards[dataType][i];
        const nutrientIds = Object.keys(record.nutrients ?? {});
        if (nutrientIds.length === 0) continue;
        const id = nutrientIds[0];
        const nutrient = record.nutrients[id];
        nutrient.amount_per_100g = nutrient.amount_per_100g + 1;
        shards[dataType][i] = reDigest(record);
        changedType = dataType;
      }
      if (changedType) break;
    }
    expect(changedType).not.toBeNull();

    const manifest = writeForged(dir, shards, new Set<UsdaDataType>([changedType as UsdaDataType]));
    expect(manifest.bundle_release).toBe(USDA_BUNDLE_RELEASE_LOCK.bundle_release);
    expect(verifyBundleDirectoryIntegrityOnly(dir).ok).toBe(true);
    expect(verifyBundleDirectory(dir).ok).toBe(false);
  }, 300000);

  it('rejects an artifact.json byte change even when every semantic field is unchanged', () => {
    const dir = copyCandidate();
    const artifactPath = join(dir, 'artifact.json');
    const original = readFileSync(artifactPath);
    writeFileSync(artifactPath, Buffer.concat([original, Buffer.from(' ')]));
    // Semantic content is identical, so integrity-only still passes.
    expect(verifyBundleDirectoryIntegrityOnly(dir).ok).toBe(true);
    expect(verifyBundleDirectory(dir).ok).toBe(false);
  }, 60000);

  it('rejects a compressed-shard byte change', () => {
    const dir = copyCandidate();
    const shard = join(dir, 'records.foundation.json.gz');
    const bytes = readFileSync(shard);
    bytes[bytes.length - 5] = bytes[bytes.length - 5] ^ 0xff;
    writeFileSync(shard, bytes);
    expect(verifyBundleDirectory(dir).ok).toBe(false);
  }, 60000);

  it('rejects a self-consistent record removal (locked count)', () => {
    const dir = copyCandidate();
    const shards = loadAllShards(dir);
    shards.foundation = shards.foundation.slice(0, -1);
    const manifest = writeForged(dir, shards, new Set<UsdaDataType>(['foundation']));
    expect(manifest.canonical_record_count).toBe(USDA_BUNDLE_RELEASE_LOCK.canonical_record_count - 1);
    expect(verifyBundleDirectoryIntegrityOnly(dir).ok).toBe(false);
    expect(verifyBundleDirectory(dir).ok).toBe(false);
  }, 300000);

  it('rejects a self-consistent warning-count change (locked warnings)', () => {
    const dir = copyCandidate();
    const shards = loadAllShards(dir);
    const manifest = writeForged(dir, shards, new Set<UsdaDataType>(), (value) => ({
      ...value,
      warnings: (value.warnings as Rec[]).map((warning) =>
        warning.code === 'foundation_null_placeholder' ? { ...warning, count: warning.count - 1 } : warning
      ),
    }));
    expect((manifest.warnings as Rec[]).find((w) => w.code === 'foundation_null_placeholder')?.count).toBe(
      USDA_BUNDLE_RELEASE_LOCK.null_placeholder_count - 1
    );
    expect(verifyBundleDirectoryIntegrityOnly(dir).ok).toBe(false);
    expect(verifyBundleDirectory(dir).ok).toBe(false);
  }, 300000);
});

describe('phase 4.5A lock cannot be overridden', () => {
  it('ignores a caller-supplied replacement lock argument', () => {
    const dir = copyCandidate();
    const forgedLock = { ...USDA_BUNDLE_RELEASE_LOCK, bundle_release: 'usda_fdc_deadbeefdeadbeefdeadbeefdeadbeef' };
    const result = (verifyBundleDirectory as unknown as (d: string, l: unknown) => { ok: boolean })(dir, forgedLock);
    expect(result.ok).toBe(true); // built-in lock used; forged extra arg ignored
  }, 120000);

  it('cannot be overridden by environment variables', () => {
    const dir = copyCandidate();
    const shard = join(dir, 'records.foundation.json.gz');
    const bytes = readFileSync(shard);
    bytes[bytes.length - 5] = bytes[bytes.length - 5] ^ 0xff;
    writeFileSync(shard, bytes);

    const saved = { ...process.env };
    try {
      process.env.USDA_BUNDLE_RELEASE_LOCK = JSON.stringify({ bundle_release: 'anything' });
      process.env.KC_USDA_LOCK = 'anything';
      process.env.USDA_BUNDLE_EXPECTED_SHA256 = '0'.repeat(64);
      process.env.USDA_BUNDLE_RELEASE = 'usda_fdc_deadbeefdeadbeefdeadbeefdeadbeef';
      expect(verifyBundleDirectory(dir).ok).toBe(false);
      expect(verifyBundleDirectory().ok).toBe(true);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }, 120000);
});
