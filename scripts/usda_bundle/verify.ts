/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: strict offline bundle verifier.
 *
 * BUILD-TIME / OFFLINE ONLY. Performs no network request.
 *
 * AUTHENTICITY-BEARING
 * --------------------
 * `verifyBundleDirectory` verifies the artifact against the immutable,
 * source-controlled, externally audited release trust lock in
 * `src/core/nutritionV2/usda/releaseLock.ts` — NEVER against identities obtained
 * from the artifact itself. It never trusts a filename, count, digest, or
 * uncompressed length merely because it appears in `artifact.json`, and it does
 * not accept a caller-supplied replacement lock, environment override, query, or
 * CLI flag. A fully recomputed/self-consistent forgery therefore still fails.
 *
 * `verifyBundleDirectoryIntegrityOnly` is an explicitly-named, non-authoritative
 * internal self-consistency check (accidental-corruption integrity only). It is
 * NOT the package command, NOT a production trust boundary, and NOT exported as
 * `verifyBundleDirectory`.
 *
 * Reusable logic only. Executable entry point: `scripts/usda_bundle/verify.cli.ts`.
 * Usage:
 *   bun run verify:usda-bundle            # verifies the checked-in artifact dir
 *   bun run verify:usda-bundle -- --dir <path>
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeCanonicalContentDigest,
  validateManifest,
} from '../../src/core/nutritionV2/usda/manifest';
import { validateCanonicalRecord } from '../../src/core/nutritionV2/usda/record';
import { createUsdaRecordStore } from '../../src/core/nutritionV2/usda/store';
import { canonicalStringify } from '../../src/core/nutritionV2/usda/digest';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import type { CanonicalUsdaFoodRecord } from '../../src/core/nutritionV2/usda/types';
import {
  boundedGunzip,
  sha256OfBytes,
  validateArtifactDescriptor,
} from './artifact';
import {
  ARTIFACT_DESCRIPTOR_FILENAME,
  ARTIFACT_MANIFEST_FILENAME,
  EXPECTED_NULL_PLACEHOLDERS,
  EXPECTED_REJECTED_NON_NULL,
  EXPECTED_TOTAL_ACCEPTED,
  EXPECTED_WARNINGS,
  LIMIT_ARTIFACT_BYTES,
  LIMIT_COMPRESSED_SHARD_BYTES,
  LIMIT_DECOMPRESSION_RATIO,
  LIMIT_MANIFEST_BYTES,
  LIMIT_TOTAL_COMPRESSED_BYTES,
  LIMIT_TOTAL_UNCOMPRESSED_BYTES,
  LIMIT_UNCOMPRESSED_SHARD_BYTES,
  SHARD_FILENAMES,
  SHARD_ORDER,
  WARNING_CODE_NULL_PLACEHOLDER,
} from './constants';

export class VerifyError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function fail(code: string): never {
  throw new VerifyError(code);
}

/** The checked-in artifact directory derived from the pinned release lock. */
export function expectedArtifactDir(): string {
  return join(resolveRepoRoot(), 'data', 'advanced-nutrition', 'usda', USDA_BUNDLE_RELEASE_LOCK.bundle_release);
}

function resolveRepoRoot(): string {
  // This module is at <repo>/scripts/usda_bundle/verify.ts.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function readBounded(path: string, maxBytes: number): Buffer {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) fail('symlinked_file');
  if (!stats.isFile()) fail('not_a_regular_file');
  if (stats.size > maxBytes) fail('file_too_large');
  return readFileSync(path);
}

function listArtifactFiles(dir: string): string[] {
  const stats = lstatSync(dir);
  if (stats.isSymbolicLink()) fail('artifact_dir_is_symlink');
  if (!stats.isDirectory()) fail('artifact_dir_not_directory');
  const entries = readdirSync(dir, { withFileTypes: true });
  const names: string[] = [];
  const lower = new Set<string>();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail('symlinked_entry');
    if (!entry.isFile()) fail('unexpected_directory_entry');
    if (lower.has(entry.name.toLowerCase())) fail('case_colliding_files');
    lower.add(entry.name.toLowerCase());
    names.push(entry.name);
  }
  return names.sort();
}

export interface BundleVerifySummary {
  readonly bundle_release: string;
  readonly directory: string;
  readonly records: number;
  readonly rejected_non_null: number;
  readonly null_placeholders: number;
  readonly total_compressed_bytes: number;
  readonly total_uncompressed_bytes: number;
  readonly canonical_content_digest: string;
}

export type BundleVerifyResult =
  | { ok: true; summary: BundleVerifySummary }
  | { ok: false; code: string };

interface DecodedShard {
  readonly dataType: string;
  readonly filename: string;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  readonly uncompressed: Buffer;
  readonly records: CanonicalUsdaFoodRecord[];
}

/**
 * Parse, bounded-decompress, validate, and canonicalize one shard from disk.
 * Returns the raw measurements and validated records; no identity is trusted.
 */
function decodeShard(dir: string, dataType: string, filename: string): DecodedShard {
  const compressed = readBounded(join(dir, filename), LIMIT_COMPRESSED_SHARD_BYTES);
  let uncompressed: Buffer;
  try {
    uncompressed = boundedGunzip(compressed, LIMIT_UNCOMPRESSED_SHARD_BYTES);
  } catch {
    fail('shard_decompression_failed');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(uncompressed.toString('utf8'));
  } catch {
    fail('shard_json_parse_failed');
  }
  if (!Array.isArray(parsed)) fail('shard_not_array');
  if (canonicalStringify(parsed) !== uncompressed.toString('utf8')) fail('shard_not_canonical');
  const records: CanonicalUsdaFoodRecord[] = [];
  for (const rawRecord of parsed) {
    const validation = validateCanonicalRecord(rawRecord);
    if (!validation.ok) fail('invalid_canonical_record');
    if (validation.record.data_type !== dataType) fail('record_data_type_mismatch');
    records.push(validation.record);
  }
  return {
    dataType,
    filename,
    compressedBytes: compressed.length,
    uncompressedBytes: uncompressed.length,
    uncompressed,
    records,
  };
}

// ---------------------------------------------------------------------------
// Authenticity-bearing verification against the source-controlled release lock
// ---------------------------------------------------------------------------

function runLockedVerification(dir: string): BundleVerifySummary {
  const lock = USDA_BUNDLE_RELEASE_LOCK;
  if (!existsSync(dir)) fail('artifact_dir_missing');

  // 1. Resolve the exact expected file set from the release lock.
  const expectedNames = [...lock.artifact_filenames].sort();
  const names = listArtifactFiles(dir);
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    fail('unexpected_file_set');
  }

  // 3-4. Hash and measure artifact.json BEFORE trusting its contents.
  const artifactBytes = readBounded(join(dir, lock.artifact.filename), LIMIT_ARTIFACT_BYTES);
  if (artifactBytes.length !== lock.artifact.bytes) fail('artifact_bytes_mismatch');
  if (sha256OfBytes(artifactBytes) !== lock.artifact.sha256) fail('artifact_digest_mismatch');

  // 5. Safely parse and validate it.
  let artifactRaw: unknown;
  try {
    artifactRaw = JSON.parse(artifactBytes.toString('utf8'));
  } catch {
    fail('invalid_artifact_descriptor');
  }
  const artifactValidation = validateArtifactDescriptor(artifactRaw);
  if (!artifactValidation.ok) fail('invalid_artifact_descriptor');
  const artifact = artifactValidation.artifact;

  // 6. Every authoritative descriptor field must match the release lock.
  if (artifact.bundle_release !== lock.bundle_release) fail('artifact_bundle_release_mismatch');
  if (artifact.attribution !== lock.attribution) fail('artifact_attribution_mismatch');
  if (artifact.manifest.filename !== lock.manifest.filename) fail('artifact_manifest_filename_mismatch');
  if (artifact.manifest.bytes !== lock.manifest.bytes) fail('artifact_manifest_bytes_mismatch');
  if (artifact.manifest.sha256 !== lock.manifest.sha256) fail('artifact_manifest_digest_mismatch');
  if (artifact.total_record_count !== lock.canonical_record_count) fail('artifact_record_count_mismatch');
  if (artifact.total_compressed_bytes !== lock.total_compressed_bytes) fail('artifact_total_compressed_mismatch');
  if (artifact.total_uncompressed_bytes !== lock.total_uncompressed_bytes) fail('artifact_total_uncompressed_mismatch');
  if (artifact.canonical_content_digest !== lock.canonical_content_digest) fail('artifact_content_digest_mismatch');

  const lockShardByType = new Map(lock.shards.map((shard) => [shard.data_type, shard]));
  if (artifact.shards.length !== lock.shards.length) fail('artifact_shard_count_mismatch');
  for (const shard of artifact.shards) {
    const locked = lockShardByType.get(shard.data_type);
    if (!locked) fail('artifact_unknown_shard');
    if (shard.filename !== locked.filename) fail('artifact_shard_filename_mismatch');
    if (shard.record_count !== locked.record_count) fail('artifact_shard_record_count_mismatch');
    if (shard.compressed_bytes !== locked.compressed_bytes) fail('artifact_shard_compressed_bytes_mismatch');
    if (shard.compressed_sha256 !== locked.compressed_sha256) fail('artifact_shard_compressed_digest_mismatch');
    if (shard.uncompressed_bytes !== locked.uncompressed_bytes) fail('artifact_shard_uncompressed_bytes_mismatch');
    if (shard.uncompressed_sha256 !== locked.uncompressed_sha256) fail('artifact_shard_uncompressed_digest_mismatch');
  }

  // 7-8. Hash and measure manifest.json, requiring its exact locked length/hash.
  const manifestBytes = readBounded(join(dir, lock.manifest.filename), LIMIT_MANIFEST_BYTES);
  if (manifestBytes.length !== lock.manifest.bytes) fail('manifest_bytes_mismatch');
  if (sha256OfBytes(manifestBytes) !== lock.manifest.sha256) fail('manifest_digest_mismatch');

  // 9. Validate the manifest and compare every authoritative field to the lock.
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('invalid_manifest');
  }
  const manifestValidation = validateManifest(manifestRaw);
  if (!manifestValidation.ok) fail('invalid_manifest');
  const manifest = manifestValidation.manifest;

  if (canonicalStringify(manifest) !== manifestBytes.toString('utf8')) fail('manifest_not_canonical');
  if (manifest.bundle_release !== lock.bundle_release) fail('manifest_bundle_release_mismatch');
  if (
    manifest.generator.name !== lock.generator.name ||
    manifest.generator.schema_version !== lock.generator.schema_version
  ) {
    fail('manifest_generator_mismatch');
  }
  if (manifest.created_at !== lock.created_at) fail('manifest_created_at_mismatch');
  if (manifest.nutrient_map_version !== lock.nutrient_map_version) fail('manifest_nutrient_map_mismatch');
  if (manifest.canonicalization_version !== lock.canonicalization_version) {
    fail('manifest_canonicalization_mismatch');
  }
  if (manifest.attribution !== lock.attribution) fail('manifest_attribution_mismatch');
  if (manifest.canonical_record_count !== lock.canonical_record_count) fail('manifest_record_count_mismatch');
  if (manifest.rejected_record_count !== lock.rejected_record_count) fail('manifest_rejected_count_mismatch');
  if (manifest.canonical_content_digest !== lock.canonical_content_digest) fail('manifest_content_digest_mismatch');

  const lockSourceByType = new Map(lock.sources.map((source) => [source.data_type, source]));
  if (manifest.components.length !== lock.sources.length) fail('manifest_component_count_mismatch');
  for (const component of manifest.components) {
    const locked = lockSourceByType.get(component.data_type);
    if (!locked) fail('manifest_unknown_component');
    if (component.upstream_release !== locked.upstream_release) fail('manifest_component_release_mismatch');
    if (component.source_url !== locked.source_url) fail('manifest_component_url_mismatch');
    if (component.source_sha256 !== locked.sha256) fail('manifest_component_digest_mismatch');
  }
  if (manifest.data_types.length !== lock.sources.length) fail('manifest_data_types_mismatch');
  for (const dataType of manifest.data_types) {
    if (!lockSourceByType.has(dataType)) fail('manifest_data_types_mismatch');
  }

  const warnings = (manifest.warnings ?? []).slice().sort((a, b) => (a.code < b.code ? -1 : 1));
  const lockedWarnings = lock.warnings.slice().sort((a, b) => (a.code < b.code ? -1 : 1));
  if (JSON.stringify(warnings) !== JSON.stringify(lockedWarnings)) fail('unexpected_warnings');

  // 10-13. Verify every shard against both the lock and the descriptor, then
  // bounded-decompress and validate uncompressed length/hash/records.
  const allRecords: CanonicalUsdaFoodRecord[] = [];
  const seenIds = new Set<number>();
  let totalCompressed = 0;
  let totalUncompressed = 0;

  for (const dataType of SHARD_ORDER) {
    const locked = lockShardByType.get(dataType);
    if (!locked) fail('missing_locked_shard');
    const ref = artifact.shards.find((shard) => shard.data_type === dataType);
    if (!ref) fail('missing_shard');
    if (ref.filename !== locked.filename) fail('shard_filename_mismatch');

    const compressed = readBounded(join(dir, locked.filename), LIMIT_COMPRESSED_SHARD_BYTES);
    if (compressed.length !== locked.compressed_bytes) fail('shard_compressed_bytes_mismatch');
    if (compressed.length !== ref.compressed_bytes) fail('shard_compressed_bytes_mismatch');
    if (sha256OfBytes(compressed) !== locked.compressed_sha256) fail('shard_compressed_digest_mismatch');
    if (sha256OfBytes(compressed) !== ref.compressed_sha256) fail('shard_compressed_digest_mismatch');

    if (locked.uncompressed_bytes > LIMIT_UNCOMPRESSED_SHARD_BYTES) fail('shard_uncompressed_over_limit');
    if (locked.compressed_bytes > 0 && locked.uncompressed_bytes / locked.compressed_bytes > LIMIT_DECOMPRESSION_RATIO) {
      fail('shard_compression_ratio_too_high');
    }

    const decoded = decodeShard(dir, dataType, locked.filename);
    if (decoded.compressedBytes !== locked.compressed_bytes) fail('shard_compressed_bytes_mismatch');
    if (decoded.uncompressedBytes !== locked.uncompressed_bytes) fail('shard_uncompressed_bytes_mismatch');
    if (decoded.uncompressedBytes !== ref.uncompressed_bytes) fail('shard_uncompressed_bytes_mismatch');
    if (sha256OfBytes(decoded.uncompressed) !== locked.uncompressed_sha256) fail('shard_uncompressed_digest_mismatch');
    if (sha256OfBytes(decoded.uncompressed) !== ref.uncompressed_sha256) fail('shard_uncompressed_digest_mismatch');
    if (decoded.records.length !== locked.record_count) fail('shard_record_count_mismatch');
    if (decoded.records.length !== ref.record_count) fail('shard_record_count_mismatch');

    for (const record of decoded.records) {
      if (record.bundle_release !== manifest.bundle_release) fail('record_bundle_release_mismatch');
      if (seenIds.has(record.fdc_id)) fail('duplicate_fdc_id');
      seenIds.add(record.fdc_id);
      allRecords.push(record);
    }
    totalCompressed += compressed.length;
    totalUncompressed += decoded.uncompressedBytes;
  }

  // 14-15. Recompute counts and canonical-content digest; require lock equality.
  if (allRecords.length !== lock.canonical_record_count) fail('recomputed_record_count_mismatch');
  if (allRecords.length !== artifact.total_record_count) fail('recomputed_record_count_mismatch');
  if (totalCompressed !== lock.total_compressed_bytes) fail('recomputed_total_compressed_mismatch');
  if (totalUncompressed !== lock.total_uncompressed_bytes) fail('recomputed_total_uncompressed_mismatch');
  if (totalCompressed > LIMIT_TOTAL_COMPRESSED_BYTES) fail('total_compressed_over_limit');
  if (totalUncompressed > LIMIT_TOTAL_UNCOMPRESSED_BYTES) fail('total_uncompressed_over_limit');

  const contentDigest = computeCanonicalContentDigest(allRecords);
  if (contentDigest !== lock.canonical_content_digest) fail('recomputed_content_digest_mismatch');
  if (contentDigest !== manifest.canonical_content_digest) fail('recomputed_content_digest_mismatch');

  const nullWarning = warnings.find((entry) => entry.code === WARNING_CODE_NULL_PLACEHOLDER);
  if (!nullWarning || nullWarning.count !== lock.null_placeholder_count) {
    fail('locked_null_placeholder_mismatch');
  }

  // 16. Reconstruct the exact-ID store.
  const store = createUsdaRecordStore(manifest, allRecords);
  if (!store.ok) fail('store_construction_failed');

  return {
    bundle_release: lock.bundle_release,
    directory: basename(dir),
    records: allRecords.length,
    rejected_non_null: manifest.rejected_record_count,
    null_placeholders: nullWarning.count,
    total_compressed_bytes: totalCompressed,
    total_uncompressed_bytes: totalUncompressed,
    canonical_content_digest: contentDigest,
  };
}

// ---------------------------------------------------------------------------
// Non-authoritative integrity-only self-consistency check (explicitly named)
// ---------------------------------------------------------------------------

function runIntegrityVerification(dir: string): BundleVerifySummary {
  if (!existsSync(dir)) fail('artifact_dir_missing');

  const expectedNames = [
    ARTIFACT_DESCRIPTOR_FILENAME,
    ARTIFACT_MANIFEST_FILENAME,
    ...SHARD_ORDER.map((dataType) => SHARD_FILENAMES[dataType]),
  ].sort();
  const names = listArtifactFiles(dir);
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    fail('unexpected_file_set');
  }

  const artifactRaw = JSON.parse(readBounded(join(dir, ARTIFACT_DESCRIPTOR_FILENAME), 1 << 20).toString('utf8'));
  const artifactValidation = validateArtifactDescriptor(artifactRaw);
  if (!artifactValidation.ok) fail('invalid_artifact_descriptor');
  const artifact = artifactValidation.artifact;

  const manifestRaw = JSON.parse(
    readBounded(join(dir, ARTIFACT_MANIFEST_FILENAME), LIMIT_MANIFEST_BYTES).toString('utf8')
  );
  const manifestValidation = validateManifest(manifestRaw);
  if (!manifestValidation.ok) fail('invalid_manifest');
  const manifest = manifestValidation.manifest;

  if (artifact.bundle_release !== manifest.bundle_release) fail('bundle_release_mismatch');

  const manifestBytes = readBounded(join(dir, artifact.manifest.filename), LIMIT_MANIFEST_BYTES);
  if (manifestBytes.length !== artifact.manifest.bytes) fail('manifest_bytes_mismatch');
  if (sha256OfBytes(manifestBytes) !== artifact.manifest.sha256) fail('manifest_digest_mismatch');
  if (canonicalStringify(manifest) !== manifestBytes.toString('utf8')) fail('manifest_not_canonical');

  const allRecords: CanonicalUsdaFoodRecord[] = [];
  const seenIds = new Set<number>();
  let totalCompressed = 0;
  let totalUncompressed = 0;

  for (const dataType of SHARD_ORDER) {
    const ref = artifact.shards.find((shard) => shard.data_type === dataType);
    if (!ref) fail('missing_shard');
    if (ref.filename !== SHARD_FILENAMES[dataType]) fail('shard_filename_mismatch');

    const compressed = readBounded(join(dir, ref.filename), LIMIT_COMPRESSED_SHARD_BYTES);
    if (compressed.length !== ref.compressed_bytes) fail('shard_compressed_bytes_mismatch');
    if (sha256OfBytes(compressed) !== ref.compressed_sha256) fail('shard_compressed_digest_mismatch');

    if (ref.uncompressed_bytes > LIMIT_UNCOMPRESSED_SHARD_BYTES) fail('shard_uncompressed_over_limit');
    if (ref.compressed_bytes > 0 && ref.uncompressed_bytes / ref.compressed_bytes > LIMIT_DECOMPRESSION_RATIO) {
      fail('shard_compression_ratio_too_high');
    }

    const decoded = decodeShard(dir, dataType, ref.filename);
    if (decoded.uncompressedBytes !== ref.uncompressed_bytes) fail('shard_uncompressed_bytes_mismatch');
    if (sha256OfBytes(decoded.uncompressed) !== ref.uncompressed_sha256) fail('shard_uncompressed_digest_mismatch');
    if (decoded.records.length !== ref.record_count) fail('shard_record_count_mismatch');

    for (const record of decoded.records) {
      if (record.bundle_release !== manifest.bundle_release) fail('record_bundle_release_mismatch');
      if (seenIds.has(record.fdc_id)) fail('duplicate_fdc_id');
      seenIds.add(record.fdc_id);
      allRecords.push(record);
    }
    totalCompressed += compressed.length;
    totalUncompressed += decoded.uncompressedBytes;
  }

  if (allRecords.length !== artifact.total_record_count) fail('total_record_count_mismatch');
  if (allRecords.length !== manifest.canonical_record_count) fail('manifest_record_count_mismatch');
  if (allRecords.length !== EXPECTED_TOTAL_ACCEPTED) fail('unexpected_accepted_total');
  if (manifest.rejected_record_count !== EXPECTED_REJECTED_NON_NULL) fail('unexpected_rejected_total');
  if (totalCompressed !== artifact.total_compressed_bytes) fail('total_compressed_mismatch');
  if (totalUncompressed !== artifact.total_uncompressed_bytes) fail('total_uncompressed_mismatch');

  const contentDigest = computeCanonicalContentDigest(allRecords);
  if (contentDigest !== manifest.canonical_content_digest) fail('canonical_content_digest_mismatch');
  if (contentDigest !== artifact.canonical_content_digest) fail('artifact_content_digest_mismatch');

  const warnings = (manifest.warnings ?? []).slice().sort((a, b) => (a.code < b.code ? -1 : 1));
  const expectedWarnings = EXPECTED_WARNINGS.slice().sort((a, b) => (a.code < b.code ? -1 : 1));
  if (JSON.stringify(warnings) !== JSON.stringify(expectedWarnings)) fail('unexpected_warnings');
  const nullPlaceholderWarning = warnings.find((entry) => entry.code === WARNING_CODE_NULL_PLACEHOLDER);
  if (!nullPlaceholderWarning || nullPlaceholderWarning.count !== EXPECTED_NULL_PLACEHOLDERS) {
    fail('unexpected_null_placeholder_census');
  }

  const store = createUsdaRecordStore(manifest, allRecords);
  if (!store.ok) fail('store_construction_failed');

  return {
    bundle_release: manifest.bundle_release,
    directory: basename(dir),
    records: allRecords.length,
    rejected_non_null: manifest.rejected_record_count,
    null_placeholders: nullPlaceholderWarning.count,
    total_compressed_bytes: totalCompressed,
    total_uncompressed_bytes: totalUncompressed,
    canonical_content_digest: contentDigest,
  };
}

/**
 * NON-AUTHORITATIVE. Self-consistency (accidental-corruption) integrity check
 * only. This is deliberately NOT `verifyBundleDirectory` and must never be used
 * as a production trust boundary or package command. A fully recomputed forgery
 * passes this check, which is exactly why the release lock exists.
 */
export function verifyBundleDirectoryIntegrityOnly(dirArg?: string): BundleVerifyResult {
  try {
    return { ok: true, summary: runIntegrityVerification(dirArg ? resolve(dirArg) : expectedArtifactDir()) };
  } catch (error) {
    return { ok: false, code: error instanceof VerifyError ? error.code : 'verification_failed' };
  }
}

/**
 * AUTHENTICITY-BEARING. Verifies one artifact directory against the built-in,
 * source-controlled release trust lock. No caller-supplied replacement lock,
 * environment override, query, or CLI flag can alter the expected identities.
 */
export function verifyBundleDirectory(dirArg?: string): BundleVerifyResult {
  try {
    return { ok: true, summary: runLockedVerification(dirArg ? resolve(dirArg) : expectedArtifactDir()) };
  } catch (error) {
    return { ok: false, code: error instanceof VerifyError ? error.code : 'verification_failed' };
  }
}

// ---------------------------------------------------------------------------
// CLI runner (reusable; invoked by the entry-only verify.cli.ts)
// ---------------------------------------------------------------------------

/** Fixed, bounded diagnostic codes only. Never echoes attacker input or paths. */
export function runVerifyCli(argv: ReadonlyArray<string>): number {
  try {
    let dirArg: string | undefined;
    for (let i = 0; i < argv.length; i += 1) {
      const token = argv[i];
      if (token === '--dir') {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          process.stderr.write(JSON.stringify({ ok: false, code: 'missing_dir_value' }) + '\n');
          return 2;
        }
        dirArg = value;
        i += 1;
        continue;
      }
      process.stderr.write(JSON.stringify({ ok: false, code: 'unknown_argument' }) + '\n');
      return 2;
    }

    const result = verifyBundleDirectory(dirArg);
    if (result.ok) {
      process.stdout.write(JSON.stringify({ ok: true, ...result.summary }) + '\n');
      return 0;
    }
    process.stderr.write(JSON.stringify({ ok: false, code: (result as { ok: false; code: string }).code }) + '\n');
    return 1;
  } catch {
    process.stderr.write(JSON.stringify({ ok: false, code: 'verification_failed' }) + '\n');
    return 1;
  }
}
