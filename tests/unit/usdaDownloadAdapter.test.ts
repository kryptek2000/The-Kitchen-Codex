import { describe, it, expect } from 'vitest';
import { adaptUsdaFood } from '../../src/core/nutritionV2/usda/adapter';
import { validateCanonicalRecord } from '../../src/core/nutritionV2/usda/record';
import { createUsdaRecordStore } from '../../src/core/nutritionV2/usda/store';
import { createUsdaRecordCache } from '../../src/core/nutritionV2/usda/cache';
import { USDA_DOWNLOAD_LABELS } from '../../src/core/nutritionV2/usda/transport';
import { serializedBlockBytes } from '../../src/core/nutritionV2/schema';
import {
  REAL_FOUNDATION_RAW,
  REAL_SR_LEGACY_RAW,
  REAL_FNDDS_RAW,
  REAL_SR_LEGACY_REJECTED_RAW,
  REAL_UPSTREAM_RELEASES,
  buildRealBundle,
  realContext,
} from '../fixtures/usdaRealFixtures';
import { cloneFixture } from '../fixtures/usdaFixtures';
import type { UsdaDataType } from '../../src/core/nutritionV2/usda/types';

/**
 * The pinned download-record adapter must consume complete official records
 * (deterministically extracted and compact-serialized from the pinned archives)
 * without caller reshaping.
 */

const REAL_RECORDS: ReadonlyArray<[string, unknown, UsdaDataType, number]> = [
  ['Foundation 321358', REAL_FOUNDATION_RAW, 'foundation', 321358],
  ['SR Legacy 167512', REAL_SR_LEGACY_RAW, 'sr_legacy', 167512],
  ['FNDDS 2705384', REAL_FNDDS_RAW, 'fndds', 2705384],
];

function failureOf(result: ReturnType<typeof adaptUsdaFood>): string | undefined {
  return result.ok ? undefined : (result as { ok: false; failure: { code: string } }).failure.code;
}

const IGNORED_METADATA = [
  'foodClass',
  'foodAttributes',
  'inputFoods',
  'publicationDate',
  'ndbNumber',
  'scientificName',
  'isHistoricalReference',
  'foodCode',
  'startDate',
  'endDate',
  'footnote',
  'foodNutrientDerivation',
  'dataPoints',
  'minYearAcquired',
  'wweiaFoodCategoryCode',
  'nutrientConversionFactors',
];

describe('usda download adapter — complete official records', () => {
  it.each(REAL_RECORDS)('%s adapts without caller reshaping', (_label, raw, dataType, fdcId) => {
    const result = adaptUsdaFood(raw, realContext(dataType, 'usda_fdc_realrecords'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.fdc_id).toBe(fdcId);
    expect(result.record.data_type).toBe(dataType);
    expect(Object.keys(result.record.nutrients).length).toBeGreaterThan(0);
  });

  it('maps the exact official transport labels to internal identifiers', () => {
    expect(USDA_DOWNLOAD_LABELS.Foundation).toBe('foundation');
    expect(USDA_DOWNLOAD_LABELS['SR Legacy']).toBe('sr_legacy');
    expect(USDA_DOWNLOAD_LABELS['Survey (FNDDS)']).toBe('fndds');
    expect(USDA_DOWNLOAD_LABELS['Foundation Foods']).toBeUndefined();
    expect(USDA_DOWNLOAD_LABELS.foundation).toBeUndefined();
  });

  it('uses per_100_g for all three canonical records', () => {
    for (const [, raw, dataType] of REAL_RECORDS) {
      const result = adaptUsdaFood(raw, realContext(dataType, 'usda_fdc_realrecords'));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.basis).toBe('per_100_g');
    }
  });

  it('binds each record to the exact component release', () => {
    for (const [, raw, dataType] of REAL_RECORDS) {
      const result = adaptUsdaFood(raw, realContext(dataType, 'usda_fdc_realrecords'));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.upstream_release).toBe(REAL_UPSTREAM_RELEASES[dataType]);
    }
  });

  it('does not let approved official extra fields enter canonical output', () => {
    for (const [, raw, dataType] of REAL_RECORDS) {
      const result = adaptUsdaFood(raw, realContext(dataType, 'usda_fdc_realrecords'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const serialized = JSON.stringify(result.record);
      for (const field of IGNORED_METADATA) {
        expect(serialized, `${dataType} leaked ${field}`).not.toContain(field);
      }
    }
  });

  it('passes canonical record validation for all three records', () => {
    for (const [, raw, dataType] of REAL_RECORDS) {
      const result = adaptUsdaFood(raw, realContext(dataType, 'usda_fdc_realrecords'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(validateCanonicalRecord(result.record).ok).toBe(true);
    }
  });

  it('rejects a caller-supplied unknown non-official field', () => {
    for (const [, raw, dataType] of REAL_RECORDS) {
      const tampered = { ...(raw as Record<string, unknown>), evilExtraField: true };
      const result = adaptUsdaFood(tampered, realContext(dataType, 'usda_fdc_realrecords'));
      expect(result.ok).toBe(false);
      expect(failureOf(result)).toBe('malformed');
    }
  });

  it('handles explicit null optional fields without inventing values', () => {
    const noCategory = cloneFixture(REAL_FOUNDATION_RAW) as Record<string, any>;
    noCategory.foodCategory = null;
    const result = adaptUsdaFood(noCategory, realContext('foundation', 'usda_fdc_realrecords'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.food_category).toBeUndefined();

    const nullAmount = cloneFixture(REAL_FOUNDATION_RAW) as Record<string, any>;
    nullAmount.foodNutrients = [{ nutrient: { id: 1003, unitName: 'g' }, amount: null }];
    const nullResult = adaptUsdaFood(nullAmount, realContext('foundation', 'usda_fdc_realrecords'));
    expect(nullResult.ok).toBe(false);
    expect(failureOf(nullResult)).toBe('no_supported_nutrients');
  });

  it('adapts the real Foundation record portions (amount/value agree)', () => {
    const result = adaptUsdaFood(REAL_FOUNDATION_RAW, realContext('foundation', 'usda_fdc_realrecords'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Foundation 321358 carries both `amount` and `value`, equal on each portion.
    const racc = result.record.portions.find((portion) => portion.measure === 'RACC');
    expect(racc).toBeDefined();
    expect(racc?.amount).toBe(1);
    expect(racc?.gram_weight).toBe(30);
  });

  it('keeps the FNDDS portion amount absent (never invented)', () => {
    const result = adaptUsdaFood(REAL_FNDDS_RAW, realContext('fndds', 'usda_fdc_realrecords'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.portions.length).toBeGreaterThan(0);
    for (const portion of result.record.portions) {
      expect('amount' in portion).toBe(false);
      expect(portion.gram_weight).toBeGreaterThan(0);
    }
  });

  it('produces a deterministic digest for a real record', () => {
    const a = adaptUsdaFood(REAL_FOUNDATION_RAW, realContext('foundation', 'usda_fdc_realrecords'));
    const b = adaptUsdaFood(cloneFixture(REAL_FOUNDATION_RAW), realContext('foundation', 'usda_fdc_realrecords'));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.record.record_digest).toBe(b.record.record_digest);
  });
});

function realBundle(): ReturnType<typeof buildRealBundle> {
  return buildRealBundle([
    { dataType: 'foundation', raw: REAL_FOUNDATION_RAW },
    { dataType: 'sr_legacy', raw: REAL_SR_LEGACY_RAW },
    { dataType: 'fndds', raw: REAL_FNDDS_RAW },
  ]);
}

describe('usda download adapter — real records in store and cache', () => {
  it('enters a correctly constructed trusted store', () => {
    const bundle = realBundle();
    const result = createUsdaRecordStore(bundle.manifest, bundle.records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const metadata = result.store.metadata();
    expect(metadata.upstream_releases.foundation).toBe(REAL_UPSTREAM_RELEASES.foundation);
    expect(metadata.upstream_releases.sr_legacy).toBe(REAL_UPSTREAM_RELEASES.sr_legacy);
    expect(metadata.upstream_releases.fndds).toBe(REAL_UPSTREAM_RELEASES.fndds);
    for (const record of bundle.records) {
      const lookup = result.store.lookup(bundle.bundleRelease, record.fdc_id);
      expect(lookup.ok).toBe(true);
    }
  });

  it('enters the bounded cache', () => {
    const bundle = realBundle();
    const cache = createUsdaRecordCache({ maxEntries: 8 });
    for (const record of bundle.records) {
      expect(cache.set(record)).toEqual({ ok: true });
      expect(cache.get(bundle.bundleRelease, record.fdc_id).ok).toBe(true);
    }
    expect(cache.size()).toBe(3);
  });

  it('never accepts a raw official record directly into the store or cache', () => {
    const bundle = realBundle();
    const storeResult = createUsdaRecordStore(bundle.manifest, [REAL_FOUNDATION_RAW]);
    expect(storeResult.ok).toBe(false);
    const cache = createUsdaRecordCache();
    expect(cache.set(REAL_FOUNDATION_RAW)).toEqual({ ok: false, code: 'invalid_record' });
  });

  it('keeps the canonical projection under the canonical 64 KiB bound', () => {
    const bundle = realBundle();
    for (const record of bundle.records) {
      const bytes = serializedBlockBytes(record, 64 * 1024);
      expect(Number.isFinite(bytes)).toBe(true);
      expect(bytes).toBeLessThan(64 * 1024);
    }
    const forged = { ...cloneFixture(bundle.records[0]), extraHuge: 'x'.repeat(100 * 1024) };
    expect(validateCanonicalRecord(forged).ok).toBe(false);
  });
});

describe('usda download adapter — real invalid-portion record regression', () => {
  it('rejects SR Legacy 168789 (present `amount: 0`) as invalid_portion', () => {
    const result = adaptUsdaFood(
      REAL_SR_LEGACY_REJECTED_RAW,
      realContext('sr_legacy', 'usda_fdc_realrecords')
    );
    expect(result.ok).toBe(false);
    expect(failureOf(result)).toBe('invalid_portion');
  });

  it('never turns the affected record into a trusted canonical record', () => {
    const result = adaptUsdaFood(
      REAL_SR_LEGACY_REJECTED_RAW,
      realContext('sr_legacy', 'usda_fdc_realrecords')
    );
    expect(result.ok).toBe(false);
    expect('record' in (result as Record<string, unknown>)).toBe(false);
  });
});
