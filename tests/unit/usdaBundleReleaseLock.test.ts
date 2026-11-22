/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: source-controlled release trust lock.
 *
 * The hardcoded expectations below are a deliberate TRIPWIRE: altering the
 * release-lock source constant (for a future USDA release or generator version)
 * requires a manual, reviewed edit here too, and the permanent tests fail until
 * that review happens. This is intentional — the generator must never silently
 * update the lock.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  USDA_BUNDLE_RELEASE_LOCK,
  USDA_BUNDLE_RELEASE_LOCK_SCHEMA,
} from '../../src/core/nutritionV2/usda/releaseLock';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const ARTIFACT_DIR = join(ROOT, 'data', 'advanced-nutrition', 'usda', USDA_BUNDLE_RELEASE_LOCK.bundle_release);
const LOCK_SOURCE = join(ROOT, 'src', 'core', 'nutritionV2', 'usda', 'releaseLock.ts');

const EXPECTED = {
  lock_schema: 1,
  bundle_release: 'usda_fdc_1f3e3068a7ae0702f360d1caae40a628',
  generator: { name: 'the-kitchen-codex-usda-bundle', schema_version: '1' },
  created_at: '2026-09-15T00:00:00.000Z',
  nutrient_map_version: 'usda_fdc_nutrient_map_v3',
  canonicalization_version: 'usda_canonical_v1',
  canonical_record_count: 13559,
  rejected_record_count: 29,
  null_placeholder_count: 32,
  canonical_content_digest: 'de639e0cc2a2b0455577e0ad055e8691c73ef7dc395bfb57e76a224e050fa739',
  manifest: { filename: 'manifest.json', bytes: 1573, sha256: '5a8596432d5f050ce5a3482ef06340d876a9ff7244c88fd64b4cdb2802e2fd8f' },
  artifact: { filename: 'artifact.json', bytes: 1604, sha256: '0049be77aeed9328772a9b3561df054a80f10002a4c2b6153f2b0f1a6b6116f4' },
  total_compressed_bytes: 2472196,
  total_uncompressed_bytes: 59704487,
  sources: {
    foundation: {
      upstream_release: '2026-04',
      archive_filename: 'FoodData_Central_foundation_food_json_2026-04-30.zip',
      source_url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip',
      sha256: '186e988ec542e913f51ef62b86a47758e8cdd0d1dc3889e7b055581f3c09c77a',
    },
    sr_legacy: {
      upstream_release: '2018-04',
      archive_filename: 'FoodData_Central_sr_legacy_food_json_2018-04.zip',
      source_url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip',
      sha256: '0fe8ae486a2c8eb42cb96413f058deb51863a46c8fb8eeb4b1fb45006dd338ef',
    },
    fndds: {
      upstream_release: '2021-2023 (2024-10)',
      archive_filename: 'FoodData_Central_survey_food_json_2024-10-31.zip',
      source_url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip',
      sha256: 'dfb06ae7ddc397ccd570b91c14b75438ab2ba39f64f22d321f61d4a52a77f3eb',
    },
  },
  shards: {
    foundation: {
      filename: 'records.foundation.json.gz',
      record_count: 353,
      compressed_bytes: 54188,
      compressed_sha256: 'cab340a836c230581b6fc891b7543cc161ab637254c45d0411d2470a394dd274',
      uncompressed_bytes: 984248,
      uncompressed_sha256: 'cfdf4af6472f0c3501361df525a2c485c607c6baf23778b3380ab38cbecc7b8a',
    },
    sr_legacy: {
      filename: 'records.sr_legacy.json.gz',
      record_count: 7775,
      compressed_bytes: 1445111,
      compressed_sha256: '4f73b99807b71bf08e30677d7f1c185916f721e488168ee75e896d1086b7c3fd',
      uncompressed_bytes: 33695908,
      uncompressed_sha256: '1aedba90770903fb60944f2d9be5d92ff078bbfd464ce427c2c1e21a1ef6388a',
    },
    fndds: {
      filename: 'records.fndds.json.gz',
      record_count: 5431,
      compressed_bytes: 972897,
      compressed_sha256: '4e6f7e2a7c5a438638344fd8fa23508d61a9183608e46c7bdbf05cd55f2c461b',
      uncompressed_bytes: 25024331,
      uncompressed_sha256: '47002c269078cd69106bd805a5486312243c9b46cad855fe5d7a67d81b7a1bdc',
    },
  },
  warnings: [
    { code: 'foundation_null_placeholder', count: 32 },
    { code: 'rejected_invalid_nutrient', count: 10 },
    { code: 'rejected_invalid_portion', count: 18 },
    { code: 'rejected_no_supported_nutrients', count: 1 },
  ],
  artifact_filenames: [
    'artifact.json',
    'manifest.json',
    'records.foundation.json.gz',
    'records.sr_legacy.json.gz',
    'records.fndds.json.gz',
  ],
  attribution:
    'U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, 2019. fdc.nal.usda.gov.',
};

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

describe('phase 4.5A release trust lock — tripwire', () => {
  it('pins the exact audited production release (any change fails this test)', () => {
    expect(USDA_BUNDLE_RELEASE_LOCK_SCHEMA).toBe(EXPECTED.lock_schema);
    expect(USDA_BUNDLE_RELEASE_LOCK.lock_schema).toBe(EXPECTED.lock_schema);
    expect(USDA_BUNDLE_RELEASE_LOCK.bundle_release).toBe(EXPECTED.bundle_release);
    expect(USDA_BUNDLE_RELEASE_LOCK.generator).toEqual(EXPECTED.generator);
    expect(USDA_BUNDLE_RELEASE_LOCK.created_at).toBe(EXPECTED.created_at);
    expect(USDA_BUNDLE_RELEASE_LOCK.nutrient_map_version).toBe(EXPECTED.nutrient_map_version);
    expect(USDA_BUNDLE_RELEASE_LOCK.canonicalization_version).toBe(EXPECTED.canonicalization_version);
    expect(USDA_BUNDLE_RELEASE_LOCK.canonical_record_count).toBe(EXPECTED.canonical_record_count);
    expect(USDA_BUNDLE_RELEASE_LOCK.rejected_record_count).toBe(EXPECTED.rejected_record_count);
    expect(USDA_BUNDLE_RELEASE_LOCK.null_placeholder_count).toBe(EXPECTED.null_placeholder_count);
    expect(USDA_BUNDLE_RELEASE_LOCK.canonical_content_digest).toBe(EXPECTED.canonical_content_digest);
    expect(USDA_BUNDLE_RELEASE_LOCK.manifest).toEqual(EXPECTED.manifest);
    expect(USDA_BUNDLE_RELEASE_LOCK.artifact).toEqual(EXPECTED.artifact);
    expect(USDA_BUNDLE_RELEASE_LOCK.total_compressed_bytes).toBe(EXPECTED.total_compressed_bytes);
    expect(USDA_BUNDLE_RELEASE_LOCK.total_uncompressed_bytes).toBe(EXPECTED.total_uncompressed_bytes);
    expect([...USDA_BUNDLE_RELEASE_LOCK.artifact_filenames].sort()).toEqual([...EXPECTED.artifact_filenames].sort());
    expect(USDA_BUNDLE_RELEASE_LOCK.attribution).toBe(EXPECTED.attribution);

    for (const [dataType, source] of Object.entries(EXPECTED.sources)) {
      const locked = USDA_BUNDLE_RELEASE_LOCK.sources.find((entry) => entry.data_type === dataType);
      expect(locked, dataType).toBeDefined();
      expect(locked).toEqual({ data_type: dataType, ...source });
    }
    for (const [dataType, shard] of Object.entries(EXPECTED.shards)) {
      const locked = USDA_BUNDLE_RELEASE_LOCK.shards.find((entry) => entry.data_type === dataType);
      expect(locked, dataType).toBeDefined();
      expect(locked).toEqual({ data_type: dataType, ...shard });
    }
    expect([...USDA_BUNDLE_RELEASE_LOCK.warnings].sort((a, b) => (a.code < b.code ? -1 : 1))).toEqual(
      [...EXPECTED.warnings].sort((a, b) => (a.code < b.code ? -1 : 1))
    );
  });
});

describe('phase 4.5A release trust lock — properties', () => {
  it('is deeply frozen immutable data', () => {
    expect(Object.isFrozen(USDA_BUNDLE_RELEASE_LOCK)).toBe(true);
    expect(Object.isFrozen(USDA_BUNDLE_RELEASE_LOCK.sources)).toBe(true);
    expect(Object.isFrozen(USDA_BUNDLE_RELEASE_LOCK.shards)).toBe(true);
    expect(Object.isFrozen(USDA_BUNDLE_RELEASE_LOCK.warnings)).toBe(true);
    expect(Object.isFrozen(USDA_BUNDLE_RELEASE_LOCK.manifest)).toBe(true);
    expect(Object.isFrozen(USDA_BUNDLE_RELEASE_LOCK.artifact)).toBe(true);
    expect(Object.isFrozen(USDA_BUNDLE_RELEASE_LOCK.generator)).toBe(true);
    expect(Object.isFrozen(USDA_BUNDLE_RELEASE_LOCK.sources[0])).toBe(true);
    expect(Object.isFrozen(USDA_BUNDLE_RELEASE_LOCK.shards[0])).toBe(true);
  });

  it('imports no Node, filesystem, child-process, ZIP, Python, React, application, or platform module', () => {
    const source = readFileSync(LOCK_SOURCE, 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bnode:/);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bfs\b/);
  });

  it('lives outside the generated artifact directory', () => {
    const artifactFiles = listFilesRecursive(ARTIFACT_DIR);
    expect(artifactFiles.length).toBeGreaterThan(0);
    expect(artifactFiles.some((file) => /releaseLock/.test(file))).toBe(false);
    expect(existsSync(join(ARTIFACT_DIR, 'releaseLock.ts'))).toBe(false);
  });

  it('matches the exact bytes and hashes of the checked-in candidate artifact', () => {
    const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const manifestBytes = readFileSync(join(ARTIFACT_DIR, EXPECTED.manifest.filename));
    const artifactBytes = readFileSync(join(ARTIFACT_DIR, EXPECTED.artifact.filename));
    expect(manifestBytes.length).toBe(EXPECTED.manifest.bytes);
    expect(sha(join(ARTIFACT_DIR, EXPECTED.manifest.filename))).toBe(EXPECTED.manifest.sha256);
    expect(artifactBytes.length).toBe(EXPECTED.artifact.bytes);
    expect(sha(join(ARTIFACT_DIR, EXPECTED.artifact.filename))).toBe(EXPECTED.artifact.sha256);
    for (const shard of Object.values(EXPECTED.shards)) {
      const file = join(ARTIFACT_DIR, shard.filename);
      const bytes = readFileSync(file);
      expect(bytes.length).toBe(shard.compressed_bytes);
      expect(sha(file)).toBe(shard.compressed_sha256);
    }
  });
});
