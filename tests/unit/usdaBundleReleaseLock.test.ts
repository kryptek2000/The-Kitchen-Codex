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
  bundle_release: 'usda_fdc_87c5408a3e98838944a87be74824761e',
  generator: { name: 'the-kitchen-codex-usda-bundle', schema_version: '1' },
  created_at: '2026-09-15T00:00:00.000Z',
  nutrient_map_version: 'usda_fdc_nutrient_map_v2',
  canonicalization_version: 'usda_canonical_v1',
  canonical_record_count: 13559,
  rejected_record_count: 29,
  null_placeholder_count: 32,
  canonical_content_digest: 'dd9740bcf0efb577f0afd5b87ddb70a652384e4d7833947e83b30da8b39f67e4',
  manifest: { filename: 'manifest.json', bytes: 1573, sha256: '3b4ee9888bda49ff705e9e38971621beac7a091fe0b53e1187e68d050e70e2ba' },
  artifact: { filename: 'artifact.json', bytes: 1604, sha256: '1e525d9423572ab202d80ed78ff05b7ec34899744f62b24664f8d32c4d0efd3b' },
  total_compressed_bytes: 2491792,
  total_uncompressed_bytes: 59678264,
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
      compressed_bytes: 53877,
      compressed_sha256: '50bb6999d12b7c68f167509bc2d88d35ad9c2df9d6a03a9a7f89379323399709',
      uncompressed_bytes: 958025,
      uncompressed_sha256: '5082031987b75d388880b8d416b4c3cacd3ee4f7c227a2717d1cedfdc6b043e6',
    },
    sr_legacy: {
      filename: 'records.sr_legacy.json.gz',
      record_count: 7775,
      compressed_bytes: 1456503,
      compressed_sha256: '2fa6be1ebefa1ffd2b70554e082237f15e14ce2c51302fdf00cde97ae6e3a876',
      uncompressed_bytes: 33695908,
      uncompressed_sha256: 'e916f71396f4f55db04365e4b622fdfa3ec8006d499ed67789434e4e5d213f35',
    },
    fndds: {
      filename: 'records.fndds.json.gz',
      record_count: 5431,
      compressed_bytes: 981412,
      compressed_sha256: '1a25a5d8c4e18fbca8e91d80a0b051860bad72aedb27486e8940699ad8158b2b',
      uncompressed_bytes: 25024331,
      uncompressed_sha256: '426e6e2642bcccfe64c2f86e831ef9c272b3def9829e25a17f179b283a055fc7',
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
