import { describe, it, expect } from 'vitest';
import { createUsdaRecordStore } from '../../src/core/nutritionV2/usda/store';
import { validateManifest } from '../../src/core/nutritionV2/usda/manifest';
import { adaptUsdaFood } from '../../src/core/nutritionV2/usda/adapter';
import { USDA_NUTRIENT_MAP_VERSION } from '../../src/core/nutritionV2/usda/nutrientMap';
import {
  buildBundle,
  cloneFixture,
  FOUNDATION_RAW,
  SR_LEGACY_RAW,
  FNDDS_RAW,
} from '../fixtures/usdaFixtures';

/**
 * Phase 1 — deterministic local store. Exact lookup only; all-or-nothing trust.
 */

function fullBundle() {
  return buildBundle([
    { dataType: 'foundation', raw: FOUNDATION_RAW },
    { dataType: 'sr_legacy', raw: SR_LEGACY_RAW },
    { dataType: 'fndds', raw: FNDDS_RAW },
  ]);
}

function codeOf(result: ReturnType<typeof createUsdaRecordStore>): string | undefined {
  return result.ok ? undefined : (result as { ok: false; code: string }).code;
}

describe('usda store — construction and exact lookup', () => {
  it('builds a trusted store from a valid manifest and canonical records', () => {
    const { manifest, records } = fullBundle();
    const result = createUsdaRecordStore(manifest, records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const metadata = result.store.metadata();
    expect(metadata.bundle_release).toBe(manifest.bundle_release);
    expect(metadata.canonical_record_count).toBe(3);
    expect(metadata.data_types).toEqual(['foundation', 'sr_legacy', 'fndds']);
    expect(metadata.upstream_releases.foundation).toBe('2026-04');
    expect(metadata.nutrient_map_version).toBe(manifest.nutrient_map_version);
  });

  it('performs exact lookup by bundle release + FDC id', () => {
    const { manifest, records } = fullBundle();
    const result = createUsdaRecordStore(manifest, records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const record of records) {
      const lookup = result.store.lookup(manifest.bundle_release, record.fdc_id);
      expect(lookup.ok).toBe(true);
      if (lookup.ok) expect(lookup.record.record_digest).toBe(record.record_digest);
    }
  });

  it('misses on a wrong release and an unknown FDC id', () => {
    const { manifest, records } = fullBundle();
    const result = createUsdaRecordStore(manifest, records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.store.lookup('usda_fdc_otherrelease', records[0].fdc_id)).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(result.store.lookup(manifest.bundle_release, 999999999)).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(result.store.lookup(manifest.bundle_release, 0)).toEqual({
      ok: false,
      code: 'invalid_fdc_id',
    });
  });
});

describe('usda store — all-or-nothing trust', () => {
  it('rejects duplicate FDC ids', () => {
    const a = cloneFixture(FOUNDATION_RAW);
    const b = cloneFixture(FOUNDATION_RAW);
    b.description = 'Synthetic duplicate id record';
    const { manifest, records } = buildBundle([
      { dataType: 'foundation', raw: a },
      { dataType: 'foundation', raw: b },
    ]);
    expect(records[0].fdc_id).toBe(records[1].fdc_id);
    const result = createUsdaRecordStore(manifest, records);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('duplicate_fdc_id');
  });

  it('rejects a manifest count mismatch and a content-digest mismatch', () => {
    const { manifest, records } = fullBundle();
    const countMismatch = { ...manifest, canonical_record_count: records.length + 1 };
    expect(validateManifest(countMismatch).ok).toBe(true);
    const countResult = createUsdaRecordStore(countMismatch, records);
    expect(countResult.ok).toBe(false);
    expect(codeOf(countResult)).toBe('count_mismatch');

    const digestMismatch = { ...manifest, canonical_content_digest: 'f'.repeat(64) };
    const digestResult = createUsdaRecordStore(digestMismatch, records);
    expect(digestResult.ok).toBe(false);
    expect(codeOf(digestResult)).toBe('content_digest_mismatch');
  });

  it('rejects an invalid manifest and one invalid record (all-or-nothing)', () => {
    const { manifest, records } = fullBundle();
    const badManifest = { ...manifest, extra: true };
    const manifestResult = createUsdaRecordStore(badManifest, records);
    expect(manifestResult.ok).toBe(false);
    expect(codeOf(manifestResult)).toBe('invalid_manifest');

    const tampered = JSON.parse(JSON.stringify(records[0]));
    tampered.description = 'tampered without digest update';
    const tamperedResult = createUsdaRecordStore(manifest, [tampered, records[1], records[2]]);
    expect(tamperedResult.ok).toBe(false);
    expect(codeOf(tamperedResult)).toBe('invalid_record');

    const rawResult = createUsdaRecordStore(manifest, [cloneFixture(FOUNDATION_RAW), records[1], records[2]]);
    expect(rawResult.ok).toBe(false);
    expect(codeOf(rawResult)).toBe('invalid_record');
  });

  it('rejects a record whose release does not match the manifest', () => {
    const { manifest, records } = fullBundle();
    const foreign = JSON.parse(JSON.stringify(records[0]));
    foreign.bundle_release = 'usda_fdc_foreign';
    // Recompute is impossible without the digest; the record fails validation first.
    const result = createUsdaRecordStore(manifest, [foreign, records[1], records[2]]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('invalid_record');
  });

  it('rejects a valid canonical record whose upstream release does not match the component', () => {
    const { manifest, records } = fullBundle();
    const wrongUpstream = adaptUsdaFood(FOUNDATION_RAW, {
      bundle_release: manifest.bundle_release,
      upstream_release: '2018-04',
      data_type: 'foundation',
      nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
    });
    expect(wrongUpstream.ok).toBe(true);
    if (!wrongUpstream.ok) return;
    const result = createUsdaRecordStore(manifest, [wrongUpstream.record, records[1], records[2]]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('release_mismatch');
  });
});

describe('usda store — authority and surface', () => {
  it('returned mutation cannot alter stored authority', () => {
    const { manifest, records } = fullBundle();
    const result = createUsdaRecordStore(manifest, records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lookup = result.store.lookup(manifest.bundle_release, records[0].fdc_id);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(Object.isFrozen(lookup.record)).toBe(true);
    expect(() => {
      (lookup.record as { description: string }).description = 'mutated';
    }).toThrow();
    const again = result.store.lookup(manifest.bundle_release, records[0].fdc_id);
    expect(again.ok && again.record.description).toBe(records[0].description);
  });

  it('exposes no search, ranking, or matching API', () => {
    const { manifest, records } = fullBundle();
    const result = createUsdaRecordStore(manifest, records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.store).sort()).toEqual(['lookup', 'metadata']);
    for (const forbidden of ['search', 'find', 'rank', 'match', 'matchIngredient', 'suggest', 'candidates']) {
      expect((result.store as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });
});
