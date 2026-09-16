/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: artifact descriptor + deterministic gzip.
 *
 * BUILD-TIME / OFFLINE ONLY. Defines the strict, closed artifact descriptor and
 * the deterministic gzip encode/decode helpers. `artifact.json` never contains
 * its own digest, local paths, host/user, timestamps, or extensions.
 */

import { gzipSync, gunzipSync } from 'node:zlib';
import { isPlainObject, toInertValue, serializedBlockBytes } from '../../src/core/nutritionV2/schema';
import { canonicalStringify, sha256HexFromBytes } from '../../src/core/nutritionV2/usda/digest';
import { USDA_DATA_TYPES, type UsdaDataType } from '../../src/core/nutritionV2/usda/types';
import {
  ARTIFACT_SCHEMA_VERSION,
  GZIP_COMPRESSION_LEVEL,
  LIMIT_ARTIFACT_BYTES,
  USDA_BUNDLE_ATTRIBUTION,
} from './constants';

export interface ArtifactFileRef {
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ArtifactShardRef {
  readonly data_type: UsdaDataType;
  readonly filename: string;
  readonly record_count: number;
  readonly compression: 'gzip';
  readonly compression_level: number;
  readonly compressed_bytes: number;
  readonly compressed_sha256: string;
  readonly uncompressed_bytes: number;
  readonly uncompressed_sha256: string;
}

export interface UsdaBundleArtifact {
  readonly artifact_schema: typeof ARTIFACT_SCHEMA_VERSION;
  readonly bundle_release: string;
  readonly manifest: ArtifactFileRef;
  readonly shards: ReadonlyArray<ArtifactShardRef>;
  readonly total_record_count: number;
  readonly total_compressed_bytes: number;
  readonly total_uncompressed_bytes: number;
  readonly canonical_content_digest: string;
  readonly attribution: string;
}

/**
 * Deterministic gzip: pinned compression level, MTIME zeroed, OS byte fixed to
 * 255 (unknown), no original filename/comment. Repeated runs on the same input
 * with the same runtime produce byte-identical output.
 */
export function deterministicGzip(input: Uint8Array): Buffer {
  const output = gzipSync(Buffer.from(input), { level: GZIP_COMPRESSION_LEVEL });
  // Gzip header: 0..1 magic, 2 CM, 3 FLG, 4..7 MTIME, 8 XFL, 9 OS.
  output[4] = 0;
  output[5] = 0;
  output[6] = 0;
  output[7] = 0;
  output[9] = 255;
  return output;
}

/** Bounded gunzip: rejects output larger than `maxBytes` (decompression bomb). */
export function boundedGunzip(input: Uint8Array, maxBytes: number): Buffer {
  return gunzipSync(Buffer.from(input), { maxOutputLength: maxBytes });
}

export function sha256OfBytes(input: Uint8Array): string {
  return sha256HexFromBytes(input);
}

export function serializeArtifactDescriptor(descriptor: UsdaBundleArtifact): string {
  return canonicalStringify(descriptor);
}

export type ArtifactValidation =
  | { ok: true; artifact: UsdaBundleArtifact }
  | { ok: false; errors: string[] };

const ARTIFACT_KEYS = new Set([
  'artifact_schema',
  'bundle_release',
  'manifest',
  'shards',
  'total_record_count',
  'total_compressed_bytes',
  'total_uncompressed_bytes',
  'canonical_content_digest',
  'attribution',
]);
const FILE_REF_KEYS = new Set(['filename', 'bytes', 'sha256']);
const SHARD_KEYS = new Set([
  'data_type',
  'filename',
  'record_count',
  'compression',
  'compression_level',
  'compressed_bytes',
  'compressed_sha256',
  'uncompressed_bytes',
  'uncompressed_sha256',
]);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const BUNDLE_RELEASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeInt(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= max;
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function isSafeFilename(value: unknown): value is string {
  return typeof value === 'string' && SAFE_FILENAME.test(value) && !value.includes('..') && !value.includes('/');
}

/** Strictly validates an artifact descriptor from an untrusted value. */
export function validateArtifactDescriptor(raw: unknown): ArtifactValidation {
  try {
    const materialized = toInertValue(raw);
    if (!materialized.ok) {
      return { ok: false, errors: [`unsafe_artifact:${(materialized as { ok: false; reason: string }).reason}`] };
    }
    if (!isPlainObject(materialized.value)) return { ok: false, errors: ['not_an_object'] };
    const value = materialized.value;
    if (serializedBlockBytes(value, LIMIT_ARTIFACT_BYTES) > LIMIT_ARTIFACT_BYTES) {
      return { ok: false, errors: ['artifact_too_large'] };
    }

    const diag: string[] = [];
    for (const key of Object.keys(value)) if (!ARTIFACT_KEYS.has(key)) diag.push('unknown_field');

    if (value.artifact_schema !== ARTIFACT_SCHEMA_VERSION) diag.push('invalid_artifact_schema');
    if (typeof value.bundle_release !== 'string' || !BUNDLE_RELEASE.test(value.bundle_release)) {
      diag.push('invalid_bundle_release');
    }
    if (value.attribution !== USDA_BUNDLE_ATTRIBUTION) diag.push('invalid_attribution');

    let manifest: ArtifactFileRef | undefined;
    if (!isPlainObject(value.manifest)) {
      diag.push('invalid_manifest_ref');
    } else {
      for (const key of Object.keys(value.manifest)) if (!FILE_REF_KEYS.has(key)) diag.push('unknown_manifest_ref_field');
      if (!isSafeFilename(value.manifest.filename)) diag.push('invalid_manifest_filename');
      if (!isSafeInt(value.manifest.bytes, LIMIT_ARTIFACT_BYTES)) diag.push('invalid_manifest_bytes');
      if (!isSha(value.manifest.sha256)) diag.push('invalid_manifest_sha256');
      manifest = {
        filename: value.manifest.filename as string,
        bytes: value.manifest.bytes as number,
        sha256: value.manifest.sha256 as string,
      };
    }

    const shards: ArtifactShardRef[] = [];
    if (!Array.isArray(value.shards) || value.shards.length !== USDA_DATA_TYPES.length) {
      diag.push('invalid_shards');
    } else {
      const seen = new Set<string>();
      for (const entry of value.shards) {
        if (!isPlainObject(entry)) {
          diag.push('invalid_shard');
          continue;
        }
        for (const key of Object.keys(entry)) if (!SHARD_KEYS.has(key)) diag.push('unknown_shard_field');
        if (typeof entry.data_type !== 'string' || !(USDA_DATA_TYPES as ReadonlyArray<string>).includes(entry.data_type)) {
          diag.push('invalid_shard_data_type');
          continue;
        }
        if (seen.has(entry.data_type)) diag.push('duplicate_shard_data_type');
        seen.add(entry.data_type);
        if (!isSafeFilename(entry.filename)) diag.push('invalid_shard_filename');
        if (!isSafeInt(entry.record_count, 1_000_000)) diag.push('invalid_shard_record_count');
        if (entry.compression !== 'gzip') diag.push('invalid_shard_compression');
        if (entry.compression_level !== GZIP_COMPRESSION_LEVEL) diag.push('invalid_shard_compression_level');
        if (!isSafeInt(entry.compressed_bytes, 2 ** 40)) diag.push('invalid_shard_compressed_bytes');
        if (!isSha(entry.compressed_sha256)) diag.push('invalid_shard_compressed_sha256');
        if (!isSafeInt(entry.uncompressed_bytes, 2 ** 40)) diag.push('invalid_shard_uncompressed_bytes');
        if (!isSha(entry.uncompressed_sha256)) diag.push('invalid_shard_uncompressed_sha256');
        shards.push({
          data_type: entry.data_type as UsdaDataType,
          filename: entry.filename as string,
          record_count: entry.record_count as number,
          compression: 'gzip',
          compression_level: GZIP_COMPRESSION_LEVEL,
          compressed_bytes: entry.compressed_bytes as number,
          compressed_sha256: entry.compressed_sha256 as string,
          uncompressed_bytes: entry.uncompressed_bytes as number,
          uncompressed_sha256: entry.uncompressed_sha256 as string,
        });
      }
    }

    if (!isSafeInt(value.total_record_count, 1_000_000)) diag.push('invalid_total_record_count');
    if (!isSafeInt(value.total_compressed_bytes, 2 ** 40)) diag.push('invalid_total_compressed_bytes');
    if (!isSafeInt(value.total_uncompressed_bytes, 2 ** 40)) diag.push('invalid_total_uncompressed_bytes');
    if (!isSha(value.canonical_content_digest)) diag.push('invalid_canonical_content_digest');

    if (diag.length > 0) return { ok: false, errors: diag.slice(0, 32) };

    return {
      ok: true,
      artifact: {
        artifact_schema: ARTIFACT_SCHEMA_VERSION,
        bundle_release: value.bundle_release as string,
        manifest: manifest as ArtifactFileRef,
        shards,
        total_record_count: value.total_record_count as number,
        total_compressed_bytes: value.total_compressed_bytes as number,
        total_uncompressed_bytes: value.total_uncompressed_bytes as number,
        canonical_content_digest: value.canonical_content_digest as string,
        attribution: value.attribution as string,
      },
    };
  } catch {
    return { ok: false, errors: ['validation_error'] };
  }
}
