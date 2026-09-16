/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: authenticated runtime
 * bundle decoder / composer.
 *
 * PURE, PLATFORM-NEUTRAL, OFFLINE. This module consumes a CLOSED set of raw byte
 * inputs (the five locked bundle files) through a narrow interface, treats every
 * supplied byte and every parsed value as untrusted, and authenticates the
 * entire bundle EXCLUSIVELY against the source-controlled
 * `USDA_BUNDLE_RELEASE_LOCK`. Only after every component has been verified does
 * it build a genuine existing `AdvancedNutritionSession`.
 *
 * TRUST BOUNDARY
 * --------------
 * - No caller-supplied release lock, environment variable, URL, path, or
 *   replacement authority is accepted.
 * - The success result exposes ONLY the genuine session, its bounded immutable
 *   `session.metadata()`, and the locked USDA attribution. It NEVER returns
 *   manifest objects, canonical records, shards, stores, indexes, catalogs, or
 *   authority material.
 * - Failures use a closed code vocabulary and fixed, bounded, input-redacted
 *   messages. URLs, paths, response bodies, parsed content, and exception
 *   messages are never echoed.
 * - All-or-nothing: any failure returns no session and installs no partial state.
 *
 * IMPORTS
 * -------
 * Only pure Phase 1–4 core modules and the pure bounded gzip helper. No React,
 * application, browser, Node, filesystem, child-process, ZIP, Python, server,
 * provider, vault, persistence, or any offline bundle-tooling module.
 */

import { isPlainObject, serializedBlockBytes, toInertValue } from '../schema';
import { canonicalStringify, sha256HexFromBytes } from '../usda/digest';
import { computeCanonicalContentDigest, validateManifest } from '../usda/manifest';
import { USDA_NUTRIENT_MAP_VERSION } from '../usda/nutrientMap';
import { validateCanonicalRecord } from '../usda/record';
import { USDA_BUNDLE_RELEASE_LOCK } from '../usda/releaseLock';
import {
  BUNDLE_RELEASE_PATTERN,
  MAX_MANIFEST_BYTES,
  SHA256_HEX_PATTERN,
  USDA_ATTRIBUTION,
  USDA_DATA_TYPES,
  type CanonicalUsdaFoodRecord,
  type UsdaBundleManifest,
  type UsdaDataType,
} from '../usda/types';
import { createAdvancedNutritionSession } from '../phase4/session';
import type { AdvancedNutritionSession, Phase4SessionMetadata } from '../phase4/types';
import { decodeBoundedGzip, decodeUtf8Strict, GzipDecodeError } from './gzip';

// ---------------------------------------------------------------------------
// Closed contract
// ---------------------------------------------------------------------------

/** The five locked logical filenames, in locked order. */
export const RUNTIME_BUNDLE_FILENAMES: ReadonlyArray<string> = Object.freeze([
  ...USDA_BUNDLE_RELEASE_LOCK.artifact_filenames,
]);

/** One raw logical bundle input. */
export interface RuntimeBundleInputFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** The closed set of raw byte inputs supplied by a byte source. */
export interface RuntimeBundleInputs {
  readonly files: ReadonlyArray<RuntimeBundleInputFile>;
}

export type RuntimeBundleFailureCode =
  | 'invalid_inputs'
  | 'missing_input'
  | 'duplicate_input'
  | 'unknown_input'
  | 'case_colliding_input'
  | 'unsupported_runtime'
  | 'asset_fetch_failed'
  | 'artifact_bytes_mismatch'
  | 'artifact_digest_mismatch'
  | 'artifact_utf8_invalid'
  | 'artifact_json_invalid'
  | 'invalid_artifact'
  | 'artifact_not_canonical'
  | 'artifact_lock_mismatch'
  | 'manifest_bytes_mismatch'
  | 'manifest_digest_mismatch'
  | 'manifest_utf8_invalid'
  | 'manifest_json_invalid'
  | 'invalid_manifest'
  | 'manifest_not_canonical'
  | 'manifest_lock_mismatch'
  | 'shard_bytes_mismatch'
  | 'shard_digest_mismatch'
  | 'shard_decompression_failed'
  | 'shard_output_bound_exceeded'
  | 'shard_too_large'
  | 'shard_utf8_invalid'
  | 'shard_json_invalid'
  | 'shard_not_array'
  | 'shard_not_canonical'
  | 'invalid_canonical_record'
  | 'record_identity_mismatch'
  | 'duplicate_fdc_id'
  | 'count_mismatch'
  | 'content_digest_mismatch'
  | 'cross_check_failed'
  | 'session_creation_failed'
  | 'session_metadata_mismatch'
  | 'validation_error';

export const RUNTIME_BUNDLE_FAILURE_MESSAGE: Readonly<Record<RuntimeBundleFailureCode, string>> =
  Object.freeze({
    invalid_inputs: 'advanced_nutrition_bundle_invalid_inputs',
    missing_input: 'advanced_nutrition_bundle_missing_input',
    duplicate_input: 'advanced_nutrition_bundle_duplicate_input',
    unknown_input: 'advanced_nutrition_bundle_unknown_input',
    case_colliding_input: 'advanced_nutrition_bundle_case_colliding_input',
    unsupported_runtime: 'advanced_nutrition_bundle_unsupported_runtime',
    asset_fetch_failed: 'advanced_nutrition_bundle_asset_fetch_failed',
    artifact_bytes_mismatch: 'advanced_nutrition_bundle_artifact_bytes_mismatch',
    artifact_digest_mismatch: 'advanced_nutrition_bundle_artifact_digest_mismatch',
    artifact_utf8_invalid: 'advanced_nutrition_bundle_artifact_utf8_invalid',
    artifact_json_invalid: 'advanced_nutrition_bundle_artifact_json_invalid',
    invalid_artifact: 'advanced_nutrition_bundle_invalid_artifact',
    artifact_not_canonical: 'advanced_nutrition_bundle_artifact_not_canonical',
    artifact_lock_mismatch: 'advanced_nutrition_bundle_artifact_lock_mismatch',
    manifest_bytes_mismatch: 'advanced_nutrition_bundle_manifest_bytes_mismatch',
    manifest_digest_mismatch: 'advanced_nutrition_bundle_manifest_digest_mismatch',
    manifest_utf8_invalid: 'advanced_nutrition_bundle_manifest_utf8_invalid',
    manifest_json_invalid: 'advanced_nutrition_bundle_manifest_json_invalid',
    invalid_manifest: 'advanced_nutrition_bundle_invalid_manifest',
    manifest_not_canonical: 'advanced_nutrition_bundle_manifest_not_canonical',
    manifest_lock_mismatch: 'advanced_nutrition_bundle_manifest_lock_mismatch',
    shard_bytes_mismatch: 'advanced_nutrition_bundle_shard_bytes_mismatch',
    shard_digest_mismatch: 'advanced_nutrition_bundle_shard_digest_mismatch',
    shard_decompression_failed: 'advanced_nutrition_bundle_shard_decompression_failed',
    shard_output_bound_exceeded: 'advanced_nutrition_bundle_shard_output_bound_exceeded',
    shard_too_large: 'advanced_nutrition_bundle_shard_too_large',
    shard_utf8_invalid: 'advanced_nutrition_bundle_shard_utf8_invalid',
    shard_json_invalid: 'advanced_nutrition_bundle_shard_json_invalid',
    shard_not_array: 'advanced_nutrition_bundle_shard_not_array',
    shard_not_canonical: 'advanced_nutrition_bundle_shard_not_canonical',
    invalid_canonical_record: 'advanced_nutrition_bundle_invalid_canonical_record',
    record_identity_mismatch: 'advanced_nutrition_bundle_record_identity_mismatch',
    duplicate_fdc_id: 'advanced_nutrition_bundle_duplicate_fdc_id',
    count_mismatch: 'advanced_nutrition_bundle_count_mismatch',
    content_digest_mismatch: 'advanced_nutrition_bundle_content_digest_mismatch',
    cross_check_failed: 'advanced_nutrition_bundle_cross_check_failed',
    session_creation_failed: 'advanced_nutrition_bundle_session_creation_failed',
    session_metadata_mismatch: 'advanced_nutrition_bundle_session_metadata_mismatch',
    validation_error: 'advanced_nutrition_bundle_validation_error',
  });

export interface RuntimeBundleFailure {
  readonly code: RuntimeBundleFailureCode;
  /** Fixed, bounded, input-redacted message. Never echoes caller input. */
  readonly message: string;
}

export function runtimeBundleFailure(code: RuntimeBundleFailureCode): RuntimeBundleFailure {
  return Object.freeze({ code, message: RUNTIME_BUNDLE_FAILURE_MESSAGE[code] });
}

export type RuntimeBundleResult =
  | {
      readonly ok: true;
      readonly session: AdvancedNutritionSession;
      readonly metadata: Phase4SessionMetadata;
      readonly attribution: string;
    }
  | { readonly ok: false; readonly failure: RuntimeBundleFailure };

// ---------------------------------------------------------------------------
// Internal fixed bounds (mirror the Phase 4.5A artifact contract)
// ---------------------------------------------------------------------------

const ARTIFACT_SCHEMA_VERSION = 1;
const GZIP_COMPRESSION_LEVEL = 9;
const LIMIT_ARTIFACT_BYTES = 64 * 1024;
const LIMIT_COMPRESSED_SHARD_BYTES = 16 * 1024 * 1024;
const LIMIT_UNCOMPRESSED_SHARD_BYTES = 128 * 1024 * 1024;
const LIMIT_TOTAL_COMPRESSED_BYTES = 32 * 1024 * 1024;
const LIMIT_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const LIMIT_DECOMPRESSION_RATIO = 200;

class BundleError extends Error {
  readonly code: RuntimeBundleFailureCode;
  constructor(code: RuntimeBundleFailureCode) {
    super(code);
    this.name = 'BundleError';
    this.code = code;
  }
}

function fail(code: RuntimeBundleFailureCode): never {
  throw new BundleError(code);
}

// ---------------------------------------------------------------------------
// Artifact descriptor (closed, pure, duplicated from the offline contract)
// ---------------------------------------------------------------------------

interface RuntimeArtifactFileRef {
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface RuntimeArtifactShardRef {
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

interface RuntimeArtifact {
  readonly artifact_schema: number;
  readonly bundle_release: string;
  readonly manifest: RuntimeArtifactFileRef;
  readonly shards: ReadonlyArray<RuntimeArtifactShardRef>;
  readonly total_record_count: number;
  readonly total_compressed_bytes: number;
  readonly total_uncompressed_bytes: number;
  readonly canonical_content_digest: string;
  readonly attribution: string;
}

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
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeInt(value: unknown, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= 0 &&
    value <= max
  );
}

function isSafeFilename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SAFE_FILENAME.test(value) &&
    !value.includes('..') &&
    !value.includes('/')
  );
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

/** Strictly validates the closed artifact descriptor from an untrusted value. */
function validateArtifactDescriptor(raw: unknown): RuntimeArtifact {
  const materialized = toInertValue(raw);
  if (!materialized.ok) fail('invalid_artifact');
  if (!isPlainObject(materialized.value)) fail('invalid_artifact');
  const value = materialized.value;
  if (serializedBlockBytes(value, LIMIT_ARTIFACT_BYTES) > LIMIT_ARTIFACT_BYTES) {
    fail('invalid_artifact');
  }
  for (const key of Object.keys(value)) if (!ARTIFACT_KEYS.has(key)) fail('invalid_artifact');

  if (value.artifact_schema !== ARTIFACT_SCHEMA_VERSION) fail('invalid_artifact');
  if (typeof value.bundle_release !== 'string' || !BUNDLE_RELEASE_PATTERN.test(value.bundle_release)) {
    fail('invalid_artifact');
  }
  if (value.attribution !== USDA_ATTRIBUTION) fail('invalid_artifact');

  let manifest: RuntimeArtifactFileRef | undefined;
  if (!isPlainObject(value.manifest)) fail('invalid_artifact');
  for (const key of Object.keys(value.manifest)) {
    if (!FILE_REF_KEYS.has(key)) fail('invalid_artifact');
  }
  if (!isSafeFilename(value.manifest.filename)) fail('invalid_artifact');
  if (!isSafeInt(value.manifest.bytes, LIMIT_ARTIFACT_BYTES)) fail('invalid_artifact');
  if (!isSha(value.manifest.sha256)) fail('invalid_artifact');
  manifest = {
    filename: value.manifest.filename as string,
    bytes: value.manifest.bytes as number,
    sha256: value.manifest.sha256 as string,
  };

  const shards: RuntimeArtifactShardRef[] = [];
  if (!Array.isArray(value.shards) || value.shards.length !== USDA_DATA_TYPES.length) {
    fail('invalid_artifact');
  }
  const seen = new Set<string>();
  for (const entry of value.shards) {
    if (!isPlainObject(entry)) fail('invalid_artifact');
    for (const key of Object.keys(entry)) if (!SHARD_KEYS.has(key)) fail('invalid_artifact');
    if (typeof entry.data_type !== 'string' || !(USDA_DATA_TYPES as ReadonlyArray<string>).includes(entry.data_type)) {
      fail('invalid_artifact');
    }
    if (seen.has(entry.data_type)) fail('invalid_artifact');
    seen.add(entry.data_type);
    if (!isSafeFilename(entry.filename)) fail('invalid_artifact');
    if (!isSafeInt(entry.record_count, 1_000_000)) fail('invalid_artifact');
    if (entry.compression !== 'gzip') fail('invalid_artifact');
    if (entry.compression_level !== GZIP_COMPRESSION_LEVEL) fail('invalid_artifact');
    if (!isSafeInt(entry.compressed_bytes, 2 ** 40)) fail('invalid_artifact');
    if (!isSha(entry.compressed_sha256)) fail('invalid_artifact');
    if (!isSafeInt(entry.uncompressed_bytes, 2 ** 40)) fail('invalid_artifact');
    if (!isSha(entry.uncompressed_sha256)) fail('invalid_artifact');
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

  if (!isSafeInt(value.total_record_count, 1_000_000)) fail('invalid_artifact');
  if (!isSafeInt(value.total_compressed_bytes, 2 ** 40)) fail('invalid_artifact');
  if (!isSafeInt(value.total_uncompressed_bytes, 2 ** 40)) fail('invalid_artifact');
  if (!isSha(value.canonical_content_digest)) fail('invalid_artifact');

  return {
    artifact_schema: ARTIFACT_SCHEMA_VERSION,
    bundle_release: value.bundle_release as string,
    manifest: manifest as RuntimeArtifactFileRef,
    shards,
    total_record_count: value.total_record_count as number,
    total_compressed_bytes: value.total_compressed_bytes as number,
    total_uncompressed_bytes: value.total_uncompressed_bytes as number,
    canonical_content_digest: value.canonical_content_digest as string,
    attribution: value.attribution as string,
  };
}

// ---------------------------------------------------------------------------
// Input reading (own-data only; never invokes a getter or proxy trap)
// ---------------------------------------------------------------------------

function readInputFiles(inputs: unknown): Map<string, Uint8Array> {
  if (typeof inputs !== 'object' || inputs === null) fail('invalid_inputs');
  const filesDescriptor = Object.getOwnPropertyDescriptor(inputs as object, 'files');
  if (!filesDescriptor || !('value' in filesDescriptor)) fail('invalid_inputs');
  const files = filesDescriptor.value;
  if (!Array.isArray(files)) fail('invalid_inputs');

  const required = USDA_BUNDLE_RELEASE_LOCK.artifact_filenames;
  const requiredSet = new Set<string>(required);
  const map = new Map<string, Uint8Array>();
  const lowered = new Set<string>();

  for (const entry of files) {
    if (typeof entry !== 'object' || entry === null) fail('invalid_inputs');
    const nameDescriptor = Object.getOwnPropertyDescriptor(entry as object, 'name');
    const bytesDescriptor = Object.getOwnPropertyDescriptor(entry as object, 'bytes');
    if (!nameDescriptor || !('value' in nameDescriptor) || typeof nameDescriptor.value !== 'string') {
      fail('invalid_inputs');
    }
    if (!bytesDescriptor || !('value' in bytesDescriptor)) fail('invalid_inputs');
    const name = nameDescriptor.value as string;
    const bytes = bytesDescriptor.value;
    if (!(bytes instanceof Uint8Array)) fail('invalid_inputs');
    if (name.length === 0 || name.length > 128) fail('invalid_inputs');

    const lower = name.toLowerCase();
    if (lowered.has(lower)) {
      fail(map.has(name) ? 'duplicate_input' : 'case_colliding_input');
    }
    lowered.add(lower);
    if (!requiredSet.has(name)) fail('unknown_input');
    map.set(name, bytes);
  }

  for (const name of required) if (!map.has(name)) fail('missing_input');
  if (map.size !== required.length) fail('invalid_inputs');
  return map;
}

// ---------------------------------------------------------------------------
// Lock comparisons
// ---------------------------------------------------------------------------

function compareArtifactToLock(artifact: RuntimeArtifact): void {
  const lock = USDA_BUNDLE_RELEASE_LOCK;
  if (artifact.bundle_release !== lock.bundle_release) fail('artifact_lock_mismatch');
  if (artifact.attribution !== lock.attribution) fail('artifact_lock_mismatch');
  if (artifact.manifest.filename !== lock.manifest.filename) fail('artifact_lock_mismatch');
  if (artifact.manifest.bytes !== lock.manifest.bytes) fail('artifact_lock_mismatch');
  if (artifact.manifest.sha256 !== lock.manifest.sha256) fail('artifact_lock_mismatch');
  if (artifact.total_record_count !== lock.canonical_record_count) fail('artifact_lock_mismatch');
  if (artifact.total_compressed_bytes !== lock.total_compressed_bytes) fail('artifact_lock_mismatch');
  if (artifact.total_uncompressed_bytes !== lock.total_uncompressed_bytes) fail('artifact_lock_mismatch');
  if (artifact.canonical_content_digest !== lock.canonical_content_digest) fail('artifact_lock_mismatch');
  if (artifact.shards.length !== lock.shards.length) fail('artifact_lock_mismatch');

  const lockShardByType = new Map(lock.shards.map((shard) => [shard.data_type, shard]));
  for (const shard of artifact.shards) {
    const locked = lockShardByType.get(shard.data_type);
    if (!locked) fail('artifact_lock_mismatch');
    if (shard.filename !== locked.filename) fail('artifact_lock_mismatch');
    if (shard.record_count !== locked.record_count) fail('artifact_lock_mismatch');
    if (shard.compressed_bytes !== locked.compressed_bytes) fail('artifact_lock_mismatch');
    if (shard.compressed_sha256 !== locked.compressed_sha256) fail('artifact_lock_mismatch');
    if (shard.uncompressed_bytes !== locked.uncompressed_bytes) fail('artifact_lock_mismatch');
    if (shard.uncompressed_sha256 !== locked.uncompressed_sha256) fail('artifact_lock_mismatch');
  }
}

function compareManifestToLock(manifest: UsdaBundleManifest): void {
  const lock = USDA_BUNDLE_RELEASE_LOCK;
  if (manifest.bundle_release !== lock.bundle_release) fail('manifest_lock_mismatch');
  if (
    manifest.generator.name !== lock.generator.name ||
    manifest.generator.schema_version !== lock.generator.schema_version
  ) {
    fail('manifest_lock_mismatch');
  }
  if (manifest.created_at !== lock.created_at) fail('manifest_lock_mismatch');
  if (manifest.nutrient_map_version !== lock.nutrient_map_version) fail('manifest_lock_mismatch');
  if (manifest.canonicalization_version !== lock.canonicalization_version) {
    fail('manifest_lock_mismatch');
  }
  if (manifest.attribution !== lock.attribution) fail('manifest_lock_mismatch');
  if (manifest.canonical_record_count !== lock.canonical_record_count) fail('manifest_lock_mismatch');
  if (manifest.rejected_record_count !== lock.rejected_record_count) fail('manifest_lock_mismatch');
  if (manifest.canonical_content_digest !== lock.canonical_content_digest) {
    fail('manifest_lock_mismatch');
  }
  if (manifest.components.length !== lock.sources.length) fail('manifest_lock_mismatch');
  const lockSourceByType = new Map(lock.sources.map((source) => [source.data_type, source]));
  for (const component of manifest.components) {
    const locked = lockSourceByType.get(component.data_type);
    if (!locked) fail('manifest_lock_mismatch');
    if (component.upstream_release !== locked.upstream_release) fail('manifest_lock_mismatch');
    if (component.source_url !== locked.source_url) fail('manifest_lock_mismatch');
    if (component.source_sha256 !== locked.sha256) fail('manifest_lock_mismatch');
  }
  if (manifest.data_types.length !== lock.sources.length) fail('manifest_lock_mismatch');
  for (const dataType of manifest.data_types) {
    if (!lockSourceByType.has(dataType)) fail('manifest_lock_mismatch');
  }
  const warnings = [...(manifest.warnings ?? [])].sort((a, b) => (a.code < b.code ? -1 : 1));
  const lockedWarnings = [...lock.warnings].sort((a, b) => (a.code < b.code ? -1 : 1));
  if (canonicalStringify(warnings) !== canonicalStringify(lockedWarnings)) {
    fail('manifest_lock_mismatch');
  }
}

function parseJsonOrFail(text: string, code: RuntimeBundleFailureCode): unknown {
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

function readSessionMetadata(session: AdvancedNutritionSession): Phase4SessionMetadata | null {
  try {
    return session.metadata();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Module-private decoded-shard validation (used ONLY by the locked composer)
// ---------------------------------------------------------------------------

/** The locked identity a decoded shard must satisfy. Module-private. */
interface RuntimeShardExpectation {
  readonly data_type: UsdaDataType;
  readonly upstream_release: string;
  readonly bundle_release: string;
  readonly nutrient_map_version: string;
  readonly record_count: number;
  readonly uncompressed_bytes: number;
  readonly uncompressed_sha256: string;
}

type DecodedShardValidation =
  | { readonly ok: true; readonly records: ReadonlyArray<CanonicalUsdaFoodRecord> }
  | { readonly ok: false; readonly code: RuntimeBundleFailureCode };

/**
 * MODULE-PRIVATE. Validates one already-decompressed shard against an expected
 * locked identity: exact length and SHA-256, strict UTF-8, JSON array, canonical
 * serialization, exact record count, every canonical record, and unique positive
 * FDC identity. Returns a closed union; never throws on bad content. It is NOT
 * exported and is reachable only through the locked composer.
 */
function validateDecodedShard(
  uncompressed: Uint8Array,
  expected: RuntimeShardExpectation
): DecodedShardValidation {
  try {
    if (!(uncompressed instanceof Uint8Array)) return { ok: false, code: 'shard_bytes_mismatch' };
    if (uncompressed.length !== expected.uncompressed_bytes) {
      return { ok: false, code: 'shard_bytes_mismatch' };
    }
    if (sha256HexFromBytes(uncompressed) !== expected.uncompressed_sha256) {
      return { ok: false, code: 'shard_digest_mismatch' };
    }
    const text = decodeUtf8Strict(uncompressed);
    if (!text.ok) return { ok: false, code: 'shard_utf8_invalid' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.text);
    } catch {
      return { ok: false, code: 'shard_json_invalid' };
    }
    if (!Array.isArray(parsed)) return { ok: false, code: 'shard_not_array' };
    if (canonicalStringify(parsed) !== text.text) return { ok: false, code: 'shard_not_canonical' };
    if (parsed.length !== expected.record_count) return { ok: false, code: 'count_mismatch' };

    const records: CanonicalUsdaFoodRecord[] = [];
    const seen = new Set<number>();
    for (const rawRecord of parsed) {
      const validation = validateCanonicalRecord(rawRecord);
      if (!validation.ok) return { ok: false, code: 'invalid_canonical_record' };
      const record = validation.record;
      if (record.data_type !== expected.data_type) {
        return { ok: false, code: 'record_identity_mismatch' };
      }
      if (record.bundle_release !== expected.bundle_release) {
        return { ok: false, code: 'record_identity_mismatch' };
      }
      if (record.upstream_release !== expected.upstream_release) {
        return { ok: false, code: 'record_identity_mismatch' };
      }
      if (record.nutrient_map_version !== expected.nutrient_map_version) {
        return { ok: false, code: 'record_identity_mismatch' };
      }
      if (seen.has(record.fdc_id)) return { ok: false, code: 'duplicate_fdc_id' };
      seen.add(record.fdc_id);
      records.push(record);
    }
    return { ok: true, records };
  } catch {
    return { ok: false, code: 'validation_error' };
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Authenticates the five locked bundle inputs against the source-controlled
 * release lock and composes a genuine Phase 4 session. All-or-nothing; never
 * returns partial or untrusted material.
 */
export async function composeAdvancedNutritionSessionFromBundle(
  inputs: unknown
): Promise<RuntimeBundleResult> {
  try {
    return await compose(inputs);
  } catch (error) {
    if (error instanceof BundleError) return { ok: false, failure: runtimeBundleFailure(error.code) };
    return { ok: false, failure: runtimeBundleFailure('validation_error') };
  }
}

async function compose(inputs: unknown): Promise<RuntimeBundleResult> {
  const lock = USDA_BUNDLE_RELEASE_LOCK;
  const files = readInputFiles(inputs);

  // --- artifact.json -------------------------------------------------------
  const artifactBytes = files.get(lock.artifact.filename) as Uint8Array;
  if (artifactBytes.length !== lock.artifact.bytes) fail('artifact_bytes_mismatch');
  if (sha256HexFromBytes(artifactBytes) !== lock.artifact.sha256) fail('artifact_digest_mismatch');
  const artifactText = decodeUtf8Strict(artifactBytes);
  if (!artifactText.ok) fail('artifact_utf8_invalid');
  const artifactRaw = parseJsonOrFail(artifactText.text, 'artifact_json_invalid');
  const artifact = validateArtifactDescriptor(artifactRaw);
  if (canonicalStringify(artifact) !== artifactText.text) fail('artifact_not_canonical');
  compareArtifactToLock(artifact);

  // --- manifest.json -------------------------------------------------------
  const manifestBytes = files.get(lock.manifest.filename) as Uint8Array;
  if (manifestBytes.length !== lock.manifest.bytes) fail('manifest_bytes_mismatch');
  if (sha256HexFromBytes(manifestBytes) !== lock.manifest.sha256) fail('manifest_digest_mismatch');
  if (manifestBytes.length > MAX_MANIFEST_BYTES) fail('invalid_manifest');
  const manifestText = decodeUtf8Strict(manifestBytes);
  if (!manifestText.ok) fail('manifest_utf8_invalid');
  const manifestRaw = parseJsonOrFail(manifestText.text, 'manifest_json_invalid');
  const manifestValidation = validateManifest(manifestRaw);
  if (!manifestValidation.ok) fail('invalid_manifest');
  const manifest = manifestValidation.manifest;
  if (canonicalStringify(manifest) !== manifestText.text) fail('manifest_not_canonical');
  compareManifestToLock(manifest);

  // --- shards (locked order) ----------------------------------------------
  const sourceByType = new Map(lock.sources.map((source) => [source.data_type, source]));
  const allRecords: CanonicalUsdaFoodRecord[] = [];
  const seenIds = new Set<number>();
  let totalCompressed = 0;
  let totalUncompressed = 0;

  for (const locked of lock.shards) {
    const ref = artifact.shards.find((shard) => shard.data_type === locked.data_type);
    if (!ref) fail('cross_check_failed');
    if (ref.filename !== locked.filename) fail('cross_check_failed');

    const compressed = files.get(locked.filename);
    if (!compressed) fail('missing_input');
    if (compressed.length !== locked.compressed_bytes) fail('shard_bytes_mismatch');
    if (sha256HexFromBytes(compressed) !== locked.compressed_sha256) fail('shard_digest_mismatch');
    if (locked.compressed_bytes > LIMIT_COMPRESSED_SHARD_BYTES) fail('shard_too_large');
    if (locked.uncompressed_bytes > LIMIT_UNCOMPRESSED_SHARD_BYTES) fail('shard_too_large');
    if (
      locked.compressed_bytes > 0 &&
      locked.uncompressed_bytes / locked.compressed_bytes > LIMIT_DECOMPRESSION_RATIO
    ) {
      fail('shard_too_large');
    }

    let decodedBytes: Uint8Array;
    try {
      decodedBytes = await decodeBoundedGzip(compressed, LIMIT_UNCOMPRESSED_SHARD_BYTES);
    } catch (error) {
      if (error instanceof GzipDecodeError && error.reason === 'unsupported') {
        fail('unsupported_runtime');
      }
      if (error instanceof GzipDecodeError && error.reason === 'bound_exceeded') {
        fail('shard_output_bound_exceeded');
      }
      fail('shard_decompression_failed');
    }
    const source = sourceByType.get(locked.data_type);
    if (!source) fail('cross_check_failed');

    const shardValidation = validateDecodedShard(decodedBytes, {
      data_type: locked.data_type as UsdaDataType,
      upstream_release: source.upstream_release,
      bundle_release: lock.bundle_release,
      nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
      record_count: locked.record_count,
      uncompressed_bytes: locked.uncompressed_bytes,
      uncompressed_sha256: locked.uncompressed_sha256,
    });
    if (shardValidation.ok) {
      const records = shardValidation.records;
      if (records.length !== ref.record_count) fail('count_mismatch');
      for (const record of records) {
        if (seenIds.has(record.fdc_id)) fail('duplicate_fdc_id');
        seenIds.add(record.fdc_id);
        allRecords.push(record);
      }
    } else {
      const code = (shardValidation as { readonly code: RuntimeBundleFailureCode }).code;
      fail(code);
    }

    totalCompressed += compressed.length;
    totalUncompressed += decodedBytes.length;
    // Release compressed bytes as soon as the shard is verified and decoded.
    files.delete(locked.filename);
  }

  if (allRecords.length !== lock.canonical_record_count) fail('count_mismatch');
  if (allRecords.length !== artifact.total_record_count) fail('count_mismatch');
  if (totalCompressed !== lock.total_compressed_bytes) fail('cross_check_failed');
  if (totalUncompressed !== lock.total_uncompressed_bytes) fail('cross_check_failed');
  if (totalCompressed > LIMIT_TOTAL_COMPRESSED_BYTES) fail('shard_too_large');
  if (totalUncompressed > LIMIT_TOTAL_UNCOMPRESSED_BYTES) fail('shard_too_large');

  const contentDigest = computeCanonicalContentDigest(allRecords);
  if (contentDigest !== lock.canonical_content_digest) fail('content_digest_mismatch');
  if (contentDigest !== manifest.canonical_content_digest) fail('content_digest_mismatch');

  // --- genuine Phase 4 session (only after full authentication) ------------
  const sessionResult = createAdvancedNutritionSession(manifest, allRecords);
  if (!sessionResult.ok) fail('session_creation_failed');
  const session = sessionResult.session;

  const metadata = readSessionMetadata(session);
  if (!metadata) fail('session_metadata_mismatch');
  if (metadata.bundle_release !== lock.bundle_release) fail('session_metadata_mismatch');
  if (metadata.record_count !== lock.canonical_record_count) fail('session_metadata_mismatch');
  if (metadata.nutrient_map_version !== lock.nutrient_map_version) fail('session_metadata_mismatch');
  const metadataTypes = new Set(metadata.data_types);
  if (metadataTypes.size !== lock.sources.length) fail('session_metadata_mismatch');
  for (const source of lock.sources) {
    if (!metadataTypes.has(source.data_type as UsdaDataType)) fail('session_metadata_mismatch');
  }

  return { ok: true, session, metadata, attribution: lock.attribution };
}
