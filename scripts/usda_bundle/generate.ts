/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: trusted local USDA bundle generator.
 *
 * BUILD-TIME / OFFLINE ONLY. It never downloads anything: it accepts explicit
 * local archive paths, verifies each pinned SHA-256, securely extracts the single
 * official JSON member, streams records, and reuses the production Phase 1
 * adapter/validator/digest/manifest/store functions to produce one deterministic
 * canonical artifact. It never performs network calls and is never imported by
 * any production runtime module.
 *
 * REUSABLE IMPLEMENTATION ONLY. This module has NO import side effects and does
 * not run a CLI on import. The executable entry point is the entry-only
 * `scripts/usda_bundle/generate.cli.ts`, which calls `runGenerateCli`.
 *
 * `generateBundle` exits successfully ONLY after writing its requested output and
 * verifying that exact output against the source-controlled release trust lock.
 * There is no successful no-op path.
 *
 * Usage (via the package script / entry module):
 *   bun run generate:usda-bundle -- \
 *     --foundation /tmp/FoodData_Central_foundation_food_json_2026-04-30.zip \
 *     --sr-legacy  /tmp/FoodData_Central_sr_legacy_food_json_2018-04.zip \
 *     --fndds      /tmp/FoodData_Central_survey_food_json_2024-10-31.zip \
 *     --out        data/advanced-nutrition/usda/<bundle_release>
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { adaptUsdaFood } from '../../src/core/nutritionV2/usda/adapter';
import {
  computeCanonicalContentDigest,
  deriveBundleReleaseId,
  validateManifest,
} from '../../src/core/nutritionV2/usda/manifest';
import { createUsdaRecordStore } from '../../src/core/nutritionV2/usda/store';
import { canonicalStringify, sha256HexFromBytes } from '../../src/core/nutritionV2/usda/digest';
import {
  USDA_BUNDLE_ATTRIBUTION,
  USDA_BUNDLE_CANONICALIZATION_VERSION,
  USDA_BUNDLE_NUTRIENT_MAP_VERSION,
} from './constants';
import {
  USDA_MANIFEST_SCHEMA,
  type CanonicalUsdaFoodRecord,
  type UsdaBundleManifest,
  type UsdaDataType,
} from '../../src/core/nutritionV2/usda/types';
import {
  ARCHIVE_SPECS,
  ARTIFACT_DESCRIPTOR_FILENAME,
  ARTIFACT_MANIFEST_FILENAME,
  ARTIFACT_SCHEMA_VERSION,
  EXPECTED_SR_LEGACY_REJECTED_FDC_IDS,
  GENERATOR_NAME,
  GENERATOR_SCHEMA_VERSION,
  GZIP_COMPRESSION_LEVEL,
  LIMIT_ARTIFACT_BYTES,
  LIMIT_COMPRESSED_SHARD_BYTES,
  LIMIT_MANIFEST_BYTES,
  LIMIT_STREAM_ENTRY_BYTES,
  LIMIT_TOTAL_COMPRESSED_BYTES,
  LIMIT_TOTAL_RECORDS,
  LIMIT_TOTAL_UNCOMPRESSED_BYTES,
  LIMIT_UNCOMPRESSED_SHARD_BYTES,
  PINNED_CREATED_AT,
  SHARD_FILENAMES,
  SHARD_ORDER,
  WARNING_CODE_INVALID_NUTRIENT,
  WARNING_CODE_INVALID_PORTION,
  WARNING_CODE_NO_SUPPORTED_NUTRIENTS,
  WARNING_CODE_NULL_PLACEHOLDER,
  type ArchiveSpec,
} from './constants';
import {
  deterministicGzip,
  serializeArtifactDescriptor,
  sha256OfBytes,
  type ArtifactShardRef,
  type UsdaBundleArtifact,
} from './artifact';
import { streamRootArray } from './stream_json';
import { verifyBundleDirectory } from './verify';

const HERE = dirname(fileURLToPath(import.meta.url));
const ZIP_EXTRACTOR = join(HERE, 'zip_extract.py');

/** Fixed, bounded, input-redacted generation failure. */
export class GenerateError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'GenerateError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new GenerateError(code);
}

export interface GenerateArgs {
  readonly paths: Readonly<Record<UsdaDataType, string>>;
  readonly out: string;
}

export interface GenerateSummary {
  readonly bundle_release: string;
  readonly output: string;
  readonly accepted: number;
  readonly rejected_non_null: number;
  readonly null_placeholders: number;
  readonly total_compressed_bytes: number;
  readonly total_uncompressed_bytes: number;
  readonly canonical_content_digest: string;
  readonly manifest_sha256: string;
}

export function parseGenerateArgs(argv: ReadonlyArray<string>): GenerateArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) fail('unknown_argument');
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail('missing_value');
    map.set(token, value);
    i += 1;
  }
  const allowed = new Set(['--foundation', '--sr-legacy', '--fndds', '--out']);
  for (const key of map.keys()) {
    if (!allowed.has(key)) fail('unknown_argument');
  }
  const foundation = map.get('--foundation');
  const srLegacy = map.get('--sr-legacy');
  const fndds = map.get('--fndds');
  const out = map.get('--out');
  if (!foundation || !srLegacy || !fndds || !out) fail('missing_required_argument');
  return {
    paths: { foundation, sr_legacy: srLegacy, fndds },
    out,
  };
}

function sha256FileSync(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(1 << 20);
  try {
    while (true) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) break;
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function assertArchivePath(spec: ArchiveSpec, path: string): string {
  const absolute = resolve(path);
  if (basename(absolute) !== spec.archive_filename) fail(`archive_filename_mismatch:${spec.data_type}`);
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink()) fail(`archive_is_symlink:${spec.data_type}`);
  if (!stats.isFile()) fail(`archive_not_regular_file:${spec.data_type}`);
  if (sha256FileSync(absolute) !== spec.sha256) fail(`archive_digest_mismatch:${spec.data_type}`);
  return absolute;
}

interface ArchiveCensus {
  readonly accepted: CanonicalUsdaFoodRecord[];
  readonly totalEntries: number;
  readonly nullPlaceholders: number;
  readonly rejectedByCode: Record<string, number>;
  readonly rejectedFdcIdsByCode: Record<string, number[]>;
}

function extractArchive(spec: ArchiveSpec, archivePath: string): string {
  const workDir = mkdtempSync(join(tmpdir(), 'kc-usda-extract-'));
  const outDir = join(workDir, 'payload');
  const result = spawnSync(
    'python3',
    [
      ZIP_EXTRACTOR,
      '--archive',
      archivePath,
      '--sha256',
      spec.sha256,
      '--member',
      spec.member_name,
      '--out',
      outDir,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    rmSync(workDir, { recursive: true, force: true });
    fail(`zip_extract_failed:${spec.data_type}`);
  }
  return outDir;
}

function processArchive(spec: ArchiveSpec, archivePath: string, bundleRelease: string): ArchiveCensus {
  const outDir = extractArchive(spec, archivePath);
  const payload = join(outDir, 'payload.json');
  const context = {
    bundle_release: bundleRelease,
    upstream_release: spec.upstream_release,
    data_type: spec.data_type,
    nutrient_map_version: USDA_BUNDLE_NUTRIENT_MAP_VERSION,
  };
  const accepted: CanonicalUsdaFoodRecord[] = [];
  const rejectedByCode: Record<string, number> = {};
  const rejectedFdcIdsByCode: Record<string, number[]> = {};
  let totalEntries = 0;
  let nullPlaceholders = 0;
  try {
    for (const raw of streamRootArray(payload, spec.root_key, LIMIT_STREAM_ENTRY_BYTES)) {
      totalEntries += 1;
      if (raw === 'null') {
        nullPlaceholders += 1;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fail(`record_json_parse_failed:${spec.data_type}`);
      }
      const result = adaptUsdaFood(parsed, context);
      if (result.ok) {
        accepted.push(result.record);
      } else {
        const code = (result as { ok: false; failure: { code: string } }).failure.code;
        rejectedByCode[code] = (rejectedByCode[code] ?? 0) + 1;
        const fdcId = (parsed as { fdcId?: unknown }).fdcId;
        if (typeof fdcId === 'number') {
          const list = rejectedFdcIdsByCode[code] ?? [];
          list.push(fdcId);
          rejectedFdcIdsByCode[code] = list;
        }
      }
    }
  } finally {
    rmSync(dirname(outDir), { recursive: true, force: true });
  }
  if (totalEntries !== spec.expected_total_entries) fail(`unexpected_total_entries:${spec.data_type}`);
  if (nullPlaceholders !== spec.expected_null_placeholders) fail(`unexpected_null_placeholders:${spec.data_type}`);
  if (accepted.length !== spec.expected_accepted) fail(`unexpected_accepted:${spec.data_type}`);
  return { accepted, totalEntries, nullPlaceholders, rejectedByCode, rejectedFdcIdsByCode };
}

function buildManifestSkeleton(): UsdaBundleManifest {
  const components = SHARD_ORDER.map((dataType) => {
    const spec = ARCHIVE_SPECS.find((entry) => entry.data_type === dataType) as ArchiveSpec;
    return {
      data_type: spec.data_type,
      upstream_release: spec.upstream_release,
      source_url: spec.source_url,
      source_sha256: spec.sha256,
    };
  });
  const base = {
    manifest_schema: USDA_MANIFEST_SCHEMA,
    bundle_release: 'pending',
    generator: { name: GENERATOR_NAME, schema_version: GENERATOR_SCHEMA_VERSION },
    created_at: PINNED_CREATED_AT,
    data_types: [...SHARD_ORDER],
    components,
    canonical_record_count: 1,
    rejected_record_count: 0,
    canonical_content_digest: '0'.repeat(64),
    nutrient_map_version: USDA_BUNDLE_NUTRIENT_MAP_VERSION,
    canonicalization_version: USDA_BUNDLE_CANONICALIZATION_VERSION,
    attribution: USDA_BUNDLE_ATTRIBUTION,
  } as UsdaBundleManifest;
  return { ...base, bundle_release: deriveBundleReleaseId(base) };
}

function buildShard(
  dataType: UsdaDataType,
  records: ReadonlyArray<CanonicalUsdaFoodRecord>
): { ref: ArtifactShardRef; bytes: Buffer } {
  const shardRecords = records
    .filter((record) => record.data_type === dataType)
    .slice()
    .sort((a, b) => (a.fdc_id !== b.fdc_id ? a.fdc_id - b.fdc_id : a.record_digest < b.record_digest ? -1 : 1));
  const canonical = canonicalStringify(shardRecords);
  const uncompressed = Buffer.from(canonical, 'utf8');
  if (uncompressed.length > LIMIT_UNCOMPRESSED_SHARD_BYTES) fail(`shard_too_large:${dataType}`);
  const compressed = deterministicGzip(uncompressed);
  if (compressed.length > LIMIT_COMPRESSED_SHARD_BYTES) fail(`shard_compressed_too_large:${dataType}`);
  return {
    ref: {
      data_type: dataType,
      filename: SHARD_FILENAMES[dataType],
      record_count: shardRecords.length,
      compression: 'gzip',
      compression_level: GZIP_COMPRESSION_LEVEL,
      compressed_bytes: compressed.length,
      compressed_sha256: sha256OfBytes(compressed),
      uncompressed_bytes: uncompressed.length,
      uncompressed_sha256: sha256OfBytes(uncompressed),
    },
    bytes: compressed,
  };
}

/**
 * Reusable generator implementation. Writes the artifact to `args.out` and then
 * verifies that exact output against the release trust lock. On any failure it
 * removes the just-written (unverified) output and throws a `GenerateError`.
 */
export function generateBundle(args: GenerateArgs): GenerateSummary {
  const paths = new Set<string>();
  for (const spec of ARCHIVE_SPECS) {
    const absolute = assertArchivePath(spec, args.paths[spec.data_type]);
    if (paths.has(absolute)) fail('duplicate_archive_path');
    paths.add(absolute);
  }

  const skeleton = buildManifestSkeleton();
  const bundleRelease = skeleton.bundle_release;

  const accepted: CanonicalUsdaFoodRecord[] = [];
  const warnings: Array<{ code: string; count: number }> = [];
  let rejectedNonEmpty = 0;
  let nullPlaceholders = 0;
  const rejectedPortionIds: number[] = [];

  for (const spec of ARCHIVE_SPECS) {
    const census = processArchive(spec, args.paths[spec.data_type], bundleRelease);
    accepted.push(...census.accepted);
    nullPlaceholders += census.nullPlaceholders;
    for (const [code, count] of Object.entries(census.rejectedByCode)) {
      rejectedNonEmpty += count;
      if (code === 'invalid_portion') rejectedPortionIds.push(...(census.rejectedFdcIdsByCode[code] ?? []));
    }
    if (census.nullPlaceholders > 0) {
      warnings.push({ code: WARNING_CODE_NULL_PLACEHOLDER, count: census.nullPlaceholders });
    }
    if (census.rejectedByCode.invalid_nutrient) {
      warnings.push({ code: WARNING_CODE_INVALID_NUTRIENT, count: census.rejectedByCode.invalid_nutrient });
    }
    if (census.rejectedByCode.invalid_portion) {
      warnings.push({ code: WARNING_CODE_INVALID_PORTION, count: census.rejectedByCode.invalid_portion });
    }
    if (census.rejectedByCode.no_supported_nutrients) {
      warnings.push({ code: WARNING_CODE_NO_SUPPORTED_NUTRIENTS, count: census.rejectedByCode.no_supported_nutrients });
    }
  }

  if (accepted.length > LIMIT_TOTAL_RECORDS) fail('too_many_records');

  const expectedPortionIds = [...EXPECTED_SR_LEGACY_REJECTED_FDC_IDS].sort((a, b) => a - b);
  const actualPortionIds = rejectedPortionIds.slice().sort((a, b) => a - b);
  if (JSON.stringify(actualPortionIds) !== JSON.stringify(expectedPortionIds)) {
    fail('unexpected_rejected_portion_ids');
  }

  accepted.sort((a, b) => (a.fdc_id !== b.fdc_id ? a.fdc_id - b.fdc_id : a.record_digest < b.record_digest ? -1 : 1));
  const seenIds = new Set<number>();
  for (const record of accepted) {
    if (seenIds.has(record.fdc_id)) fail('duplicate_fdc_id');
    seenIds.add(record.fdc_id);
  }

  const canonicalContentDigest = computeCanonicalContentDigest(accepted);
  const manifest: UsdaBundleManifest = {
    ...skeleton,
    canonical_record_count: accepted.length,
    rejected_record_count: rejectedNonEmpty,
    canonical_content_digest: canonicalContentDigest,
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  const manifestValidation = validateManifest(manifest);
  if (!manifestValidation.ok) fail('manifest_validation_failed');
  const storeResult = createUsdaRecordStore(manifest, accepted);
  if (!storeResult.ok) fail('store_validation_failed');

  const manifestBytes = Buffer.from(canonicalStringify(manifest), 'utf8');
  if (manifestBytes.length > LIMIT_MANIFEST_BYTES) fail('manifest_too_large');

  const shards: Array<{ ref: ArtifactShardRef; bytes: Buffer }> = [];
  for (const dataType of SHARD_ORDER) shards.push(buildShard(dataType, accepted));

  const totalCompressed = shards.reduce((sum, shard) => sum + shard.ref.compressed_bytes, 0);
  const totalUncompressed = shards.reduce((sum, shard) => sum + shard.ref.uncompressed_bytes, 0);
  if (totalCompressed > LIMIT_TOTAL_COMPRESSED_BYTES) fail('total_compressed_too_large');
  if (totalUncompressed > LIMIT_TOTAL_UNCOMPRESSED_BYTES) fail('total_uncompressed_too_large');

  const artifact: UsdaBundleArtifact = {
    artifact_schema: ARTIFACT_SCHEMA_VERSION,
    bundle_release: bundleRelease,
    manifest: {
      filename: ARTIFACT_MANIFEST_FILENAME,
      bytes: manifestBytes.length,
      sha256: sha256OfBytes(manifestBytes),
    },
    shards: shards.map((shard) => shard.ref),
    total_record_count: accepted.length,
    total_compressed_bytes: totalCompressed,
    total_uncompressed_bytes: totalUncompressed,
    canonical_content_digest: canonicalContentDigest,
    attribution: USDA_BUNDLE_ATTRIBUTION,
  };
  const artifactBytes = Buffer.from(serializeArtifactDescriptor(artifact), 'utf8');
  if (artifactBytes.length > LIMIT_ARTIFACT_BYTES) fail('artifact_too_large');

  const outDir = resolve(args.out);
  if (existsSync(outDir)) fail('output_exists');
  mkdirSync(outDir, { recursive: false });
  writeFileSync(join(outDir, ARTIFACT_MANIFEST_FILENAME), manifestBytes);
  writeFileSync(join(outDir, ARTIFACT_DESCRIPTOR_FILENAME), artifactBytes);
  for (const shard of shards) writeFileSync(join(outDir, shard.ref.filename), shard.bytes);

  // Exit 0 is possible ONLY after the exact written output verifies against the
  // built-in, source-controlled release trust lock. Never auto-update the lock.
  const verification = verifyBundleDirectory(outDir);
  if (!verification.ok) {
    rmSync(outDir, { recursive: true, force: true });
    fail(`generated_artifact_verification_failed:${(verification as { ok: false; code: string }).code}`);
  }

  return {
    bundle_release: bundleRelease,
    output: outDir,
    accepted: accepted.length,
    rejected_non_null: rejectedNonEmpty,
    null_placeholders: nullPlaceholders,
    total_compressed_bytes: totalCompressed,
    total_uncompressed_bytes: totalUncompressed,
    canonical_content_digest: canonicalContentDigest,
    manifest_sha256: artifact.manifest.sha256,
  };
}

/** Fixed, bounded, input-redacted diagnostic code. Never echoes paths/values. */
function boundedCode(error: unknown): string {
  if (error instanceof GenerateError) return error.code;
  const message = error instanceof Error ? error.message : '';
  const match = /^[a-z][a-z0-9_]*(?::[A-Za-z0-9_]+)?/.exec(message);
  return match ? match[0] : 'generation_failed';
}

/**
 * Reusable CLI runner. Contains every failure and returns a process exit code.
 * Zero is returned only after `generateBundle` wrote and verified its output.
 */
export function runGenerateCli(argv: ReadonlyArray<string>): number {
  try {
    const args = parseGenerateArgs(argv);
    const summary = generateBundle(args);
    process.stdout.write(JSON.stringify({ ok: true, ...summary }) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, code: boundedCode(error) }) + '\n');
    return 1;
  }
}
