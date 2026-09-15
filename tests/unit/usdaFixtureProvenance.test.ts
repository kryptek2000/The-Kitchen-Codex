import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptUsdaFood } from '../../src/core/nutritionV2/usda/adapter';
import { USDA_DOWNLOAD_LABEL_BY_TYPE } from '../../src/core/nutritionV2/usda/transport';
import { USDA_NUTRIENT_MAP_VERSION } from '../../src/core/nutritionV2/usda/nutrientMap';
import {
  REAL_FIXTURE_PROVENANCE,
  REAL_UPSTREAM_RELEASES,
  REAL_SOURCE_URLS,
  REAL_ARCHIVE_SHA256,
  loadRealFixtureBytes,
  realContext,
} from '../fixtures/usdaRealFixtures';

/**
 * Finding 2 — fixture provenance and deterministic compact reproduction.
 *
 * The fixtures are complete official records deterministically extracted and
 * compact-serialized (native `JSON.stringify`, no replacer, no indentation) from
 * the pinned archives. They are byte-identical to that compact extraction output
 * and semantically equal to the selected archive entry — NOT raw archive byte
 * slices and NOT synthetic.
 *
 * This suite is fully OFFLINE: it pins fixture byte lengths, fixture SHA-256
 * values, provenance metadata, and semantic completeness. The archive-to-fixture
 * reproduction runs as a temporary probe outside the routine suite.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const FIXTURE_DIR = resolve(ROOT, 'tests/fixtures/usdaRealRecords');

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PROVENANCE_KEYS = new Set([
  'provenance_schema',
  'note',
  'license',
  'attribution',
  'extraction_method',
  'records',
]);
const EXTRACTION_KEYS = new Set(['id', 'version', 'description', 'date']);
const RECORD_KEYS = new Set([
  'file',
  'data_type',
  'transport_label',
  'upstream_release',
  'fdc_id',
  'description',
  'source_url',
  'archive_sha256',
  'fixture_bytes',
  'fixture_sha256',
  'expected_outcome',
  'expected_failure',
]);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Pinned complete top-level field sets (offline proof that no field was added,
 * deleted, or changed relative to the documented extraction of the pinned
 * archive records).
 */
const EXPECTED_TOP_LEVEL_KEYS: Readonly<Record<number, ReadonlyArray<string>>> = Object.freeze({
  321358: [
    'dataType',
    'description',
    'fdcId',
    'foodAttributes',
    'foodCategory',
    'foodClass',
    'foodNutrients',
    'foodPortions',
    'inputFoods',
    'isHistoricalReference',
    'ndbNumber',
    'nutrientConversionFactors',
    'publicationDate',
  ],
  167512: [
    'dataType',
    'description',
    'fdcId',
    'foodAttributes',
    'foodCategory',
    'foodClass',
    'foodNutrients',
    'foodPortions',
    'inputFoods',
    'isHistoricalReference',
    'ndbNumber',
    'nutrientConversionFactors',
    'publicationDate',
  ],
  168789: [
    'dataType',
    'description',
    'fdcId',
    'foodAttributes',
    'foodCategory',
    'foodClass',
    'foodNutrients',
    'foodPortions',
    'inputFoods',
    'isHistoricalReference',
    'ndbNumber',
    'nutrientConversionFactors',
    'publicationDate',
  ],
  2705384: [
    'dataType',
    'description',
    'endDate',
    'fdcId',
    'foodAttributes',
    'foodClass',
    'foodCode',
    'foodNutrients',
    'foodPortions',
    'inputFoods',
    'publicationDate',
    'startDate',
    'wweiaFoodCategory',
  ],
});

function listFixtureJson(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json') && name !== 'PROVENANCE.json')
    .sort();
}

describe('fixture provenance — closed schema', () => {
  it('PROVENANCE.json uses a strict closed schema', () => {
    const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, 'PROVENANCE.json'), 'utf8'));
    expect(Object.keys(raw).every((key) => PROVENANCE_KEYS.has(key))).toBe(true);
    expect([...PROVENANCE_KEYS].every((key) => key in raw)).toBe(true);
    expect(raw.provenance_schema).toBe(1);
    expect(typeof raw.note).toBe('string');
    expect(raw.license).toMatch(/CC0/);
    expect(raw.attribution).toMatch(/FoodData Central/);

    expect(Object.keys(raw.extraction_method).every((key) => EXTRACTION_KEYS.has(key))).toBe(true);
    expect([...EXTRACTION_KEYS].every((key) => key in raw.extraction_method)).toBe(true);
    expect(raw.extraction_method.id).toBe('compact_json_stringify_v1');
    expect(raw.extraction_method.version).toBe(1);
    expect(raw.extraction_method.description).toMatch(/JSON\.stringify/);

    expect(Array.isArray(raw.records)).toBe(true);
    for (const record of raw.records) {
      expect(Object.keys(record).every((key) => RECORD_KEYS.has(key)), record.file).toBe(true);
      for (const key of RECORD_KEYS) {
        if (key === 'expected_failure') continue;
        expect(key in record, `${record.file}.${key}`).toBe(true);
      }
      expect(USDA_DOWNLOAD_LABEL_BY_TYPE[record.data_type]).toBe(record.transport_label);
      expect(Number.isSafeInteger(record.fdc_id)).toBe(true);
      expect(SHA256_HEX.test(record.archive_sha256)).toBe(true);
      expect(SHA256_HEX.test(record.fixture_sha256)).toBe(true);
      expect(Number.isSafeInteger(record.fixture_bytes)).toBe(true);
      expect(['accepted', 'rejected']).toContain(record.expected_outcome);
      if (record.expected_outcome === 'rejected') {
        expect(typeof record.expected_failure).toBe('string');
      } else {
        expect('expected_failure' in record).toBe(false);
      }
    }
  });

  it('every checked-in fixture is listed and every listed fixture exists', () => {
    const listed = REAL_FIXTURE_PROVENANCE.records.map((record) => record.file).sort();
    expect(listed).toEqual(listFixtureJson());
  });

  it('records the exact source URL and archive digest for each data type', () => {
    for (const record of REAL_FIXTURE_PROVENANCE.records) {
      expect(record.source_url).toBe(REAL_SOURCE_URLS[record.data_type]);
      expect(record.archive_sha256).toBe(REAL_ARCHIVE_SHA256[record.data_type]);
      expect(record.upstream_release).toBe(REAL_UPSTREAM_RELEASES[record.data_type]);
      expect(record.source_url.startsWith('https://fdc.nal.usda.gov/')).toBe(true);
    }
  });
});

describe('fixture provenance — byte identity with compact extraction output', () => {
  it('each fixture matches its pinned byte length and SHA-256', () => {
    for (const record of REAL_FIXTURE_PROVENANCE.records) {
      const bytes = loadRealFixtureBytes(record.file);
      expect(bytes.length, record.file).toBe(record.fixture_bytes);
      expect(sha256(bytes), record.file).toBe(record.fixture_sha256);
    }
  });

  it('each fixture is byte-identical to native compact JSON.stringify of its parsed record', () => {
    for (const record of REAL_FIXTURE_PROVENANCE.records) {
      const bytes = loadRealFixtureBytes(record.file);
      const reparsed = JSON.parse(bytes.toString('utf8'));
      const compact = Buffer.from(JSON.stringify(reparsed), 'utf8');
      expect(compact.equals(bytes), record.file).toBe(true);
      // No added leading/trailing whitespace or newline.
      expect(bytes.toString('utf8')).toBe(bytes.toString('utf8').trim());
      expect(bytes[bytes.length - 1]).not.toBe(0x0a);
    }
  });

  it('parsing a fixture yields the expected complete record shape with no lost fields', () => {
    for (const record of REAL_FIXTURE_PROVENANCE.records) {
      const parsed = JSON.parse(loadRealFixtureBytes(record.file).toString('utf8')) as Record<string, unknown>;
      expect(parsed.fdcId).toBe(record.fdc_id);
      expect(parsed.dataType).toBe(record.transport_label);
      expect(parsed.description).toBe(record.description);
      expect(Array.isArray(parsed.foodNutrients)).toBe(true);
      expect((parsed.foodNutrients as unknown[]).length).toBeGreaterThan(0);
      // A complete record, not a reduced projection: the exact pinned top-level
      // field set must be present with no added, deleted, or changed field.
      expect(Object.keys(parsed).sort(), record.file).toEqual(
        [...EXPECTED_TOP_LEVEL_KEYS[record.fdc_id]].sort()
      );
    }
  });

  it('fixtures are not imported by any production surface', () => {
    const productionRoots = [resolve(ROOT, 'src'), resolve(ROOT, 'server')];
    const offenders: string[] = [];
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
      }
      return out;
    };
    for (const root of productionRoots) {
      for (const file of walk(root)) {
        const source = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(source)) !== null) {
          if (/usdaRealRecords|usdaRealFixtures/.test(match[1])) offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('fixture provenance — adapter outcome matches the declared expectation', () => {
  it('accepted fixtures adapt; the rejected fixture fails with the declared classification', () => {
    for (const record of REAL_FIXTURE_PROVENANCE.records) {
      const raw = JSON.parse(loadRealFixtureBytes(record.file).toString('utf8'));
      const result = adaptUsdaFood(raw, realContext(record.data_type, 'usda_fdc_fixtures'));
      if (record.expected_outcome === 'accepted') {
        expect(result.ok, record.file).toBe(true);
      } else {
        expect(result.ok, record.file).toBe(false);
        const failure = (result as { ok: false; failure: { code: string } }).failure;
        expect(failure.code, record.file).toBe(record.expected_failure);
      }
    }
  });

  it('uses the current nutrient-map version in every real context', () => {
    expect(realContext('foundation', 'usda_fdc_fixtures').nutrient_map_version).toBe(
      USDA_NUTRIENT_MAP_VERSION
    );
  });
});
