import { describe, it, expect } from 'vitest';
import { createReviewCatalog } from '../../src/core/nutritionV2/matching/review';
import { normalizeQuery } from '../../src/core/nutritionV2/matching/normalize';
import { MAX_CATALOG_RECORDS } from '../../src/core/nutritionV2/matching/types';
import { computeCanonicalContentDigest } from '../../src/core/nutritionV2/usda/manifest';
import {
  buildMatchingBundle,
  makeCanonicalRecord,
  makeMatchingManifest,
  DEFAULT_MATCHING_SPECS,
} from '../fixtures/usdaMatchingFixtures';

/**
 * Phase 2 — manifest-bound review catalog. All-or-nothing trust.
 */

function failureCode(result: ReturnType<typeof createReviewCatalog>): string | undefined {
  return result.ok ? undefined : (result as { ok: false; failure: { code: string } }).failure.code;
}

describe('phase 2 catalog — valid construction and metadata', () => {
  it('builds a trusted catalog from a valid manifest and records', () => {
    const { manifest, records } = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
    const result = createReviewCatalog(manifest, records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const metadata = result.catalog.metadata();
    expect(metadata.bundle_release).toBe(manifest.bundle_release);
    expect(metadata.record_count).toBe(DEFAULT_MATCHING_SPECS.length);
    expect(metadata.data_types).toEqual(['foundation', 'sr_legacy', 'fndds']);
    expect(metadata.catalog_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.catalog.size()).toBe(DEFAULT_MATCHING_SPECS.length);
    expect(MAX_CATALOG_RECORDS).toBeGreaterThanOrEqual(13559);
  });

  it('is independent of input record order (digest and search results)', () => {
    const a = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
    const b = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
    const catalogA = createReviewCatalog(a.manifest, a.records);
    const catalogB = createReviewCatalog(b.manifest, [...b.records].reverse());
    expect(catalogA.ok && catalogB.ok).toBe(true);
    if (!catalogA.ok || !catalogB.ok) return;
    expect(catalogA.catalog.metadata().catalog_digest).toBe(
      catalogB.catalog.metadata().catalog_digest
    );
    const query = normalizeQuery('Milk, whole');
    expect(catalogA.catalog.search(query, 25).map((c) => c.fdc_id)).toEqual(
      catalogB.catalog.search(query, 25).map((c) => c.fdc_id)
    );
  });

  it('does not expose nutrient values through candidates', () => {
    const { manifest, records } = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
    const result = createReviewCatalog(manifest, records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidates = result.catalog.search(normalizeQuery('milk'), 25);
    expect(candidates.length).toBeGreaterThan(0);
    expect(JSON.stringify(candidates)).not.toMatch(/nutrient|amount_per_100g|calories|protein/i);
  });
});

describe('phase 2 catalog — all-or-nothing rejection', () => {
  it('rejects an invalid manifest', () => {
    const { manifest, records } = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
    expect(failureCode(createReviewCatalog({ ...manifest, extra: true }, records))).toBe(
      'invalid_manifest'
    );
  });

  it('rejects a content-digest mismatch and a count mismatch', () => {
    const { manifest, records } = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
    expect(
      failureCode(createReviewCatalog({ ...manifest, canonical_content_digest: 'f'.repeat(64) }, records))
    ).toBe('content_digest_mismatch');
    expect(
      failureCode(
        createReviewCatalog({ ...manifest, canonical_record_count: records.length + 1 }, records)
      )
    ).toBe('count_mismatch');
  });

  it('rejects a canonical-record digest mismatch (one bad record rejects everything)', () => {
    const { manifest, records } = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
    const tampered = JSON.parse(JSON.stringify(records[0]));
    tampered.description = 'Tampered without digest update';
    expect(failureCode(createReviewCatalog(manifest, [tampered, ...records.slice(1)]))).toBe(
      'invalid_record'
    );
    expect(failureCode(createReviewCatalog(manifest, [records[0], null, ...records.slice(2)]))).toBe(
      'invalid_record'
    );
  });

  it('rejects a release mismatch and a nutrient-map mismatch', () => {
    const { manifest, bundleRelease } = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
    const wrongUpstream = makeCanonicalRecord(
      { fdcId: 5001, dataType: 'foundation', description: 'Milk, whole', upstreamRelease: '1999-01' },
      bundleRelease
    );
    expect(failureCode(createReviewCatalog(manifest, [wrongUpstream]))).toBe('release_mismatch');

    const wrongMap = makeCanonicalRecord(
      { fdcId: 5002, dataType: 'foundation', description: 'Milk, whole', nutrientMapVersion: 'other' },
      bundleRelease
    );
    expect(failureCode(createReviewCatalog(manifest, [wrongMap]))).toBe('release_mismatch');
  });

  it('rejects duplicate FDC ids', () => {
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 7001, dataType: 'foundation', description: 'Milk, whole' },
      { fdcId: 7001, dataType: 'foundation', description: 'Milk, skim' },
    ]);
    expect(failureCode(createReviewCatalog(manifest, records))).toBe('duplicate_fdc_id');
  });

  it('rejects an empty catalog and one record over the maximum', () => {
    const manifest = makeMatchingManifest(['foundation'], 1, '0'.repeat(64));
    expect(failureCode(createReviewCatalog(manifest, []))).toBe('empty_catalog');
    const tooMany = new Array(MAX_CATALOG_RECORDS + 1).fill(null);
    expect(failureCode(createReviewCatalog(manifest, tooMany))).toBe('too_many_records');
    expect(failureCode(createReviewCatalog(manifest, 'not an array'))).toBe('invalid_record');
  });

  it(
    'accepts exactly MAX_CATALOG_RECORDS valid records and rejects one more (inclusive boundary)',
    () => {
      const dataTypes = ['foundation'] as const;
      const bundleRelease = makeMatchingManifest(['foundation'], 1, '0'.repeat(64)).bundle_release;
      const records = Array.from({ length: MAX_CATALOG_RECORDS }, (_, index) =>
        makeCanonicalRecord(
          { fdcId: index + 1, dataType: 'foundation', description: `Synthetic food ${index + 1}` },
          bundleRelease
        )
      );
      const manifest = makeMatchingManifest(
        dataTypes,
        MAX_CATALOG_RECORDS,
        computeCanonicalContentDigest(records)
      );

      const accepted = createReviewCatalog(manifest, records);
      expect(accepted.ok).toBe(true);
      if (accepted.ok) expect(accepted.catalog.size()).toBe(MAX_CATALOG_RECORDS);

      const oneMore = makeCanonicalRecord(
        { fdcId: MAX_CATALOG_RECORDS + 1, dataType: 'foundation', description: 'Synthetic food extra' },
        bundleRelease
      );
      const rejected = createReviewCatalog(manifest, [...records, oneMore]);
      expect(failureCode(rejected)).toBe('too_many_records');
    },
    30000
  );
});

describe('phase 2 catalog — authority isolation', () => {
  it('caller mutation of the input array cannot alter catalog authority', () => {
    const { manifest, records } = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
    const result = createReviewCatalog(manifest, records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const query = normalizeQuery('Milk, whole');
    const before = result.catalog.search(query, 25).map((c) => c.fdc_id);
    records.pop();
    records.length = 0;
    const after = result.catalog.search(query, 25).map((c) => c.fdc_id);
    expect(after).toEqual(before);
  });

  it('returned mutation cannot alter internal authority', () => {
    const { manifest, records } = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
    const result = createReviewCatalog(manifest, records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const metadata = result.catalog.metadata();
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(() => {
      (metadata as { record_count: number }).record_count = 0;
    }).toThrow();
    const candidates = result.catalog.search(normalizeQuery('milk'), 25);
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(() => {
      (candidates as unknown as unknown[]).pop();
    }).toThrow();
  });
});
