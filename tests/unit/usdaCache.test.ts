import { describe, it, expect } from 'vitest';
import { createUsdaRecordCache } from '../../src/core/nutritionV2/usda/cache';
import { adaptUsdaFood } from '../../src/core/nutritionV2/usda/adapter';
import {
  computeCanonicalContentDigest,
  deriveBundleReleaseId,
} from '../../src/core/nutritionV2/usda/manifest';
import { serializedBlockBytes } from '../../src/core/nutritionV2/schema';
import { USDA_NUTRIENT_MAP_VERSION } from '../../src/core/nutritionV2/usda/nutrientMap';
import type { UsdaBundleManifest } from '../../src/core/nutritionV2/usda/types';
import { makeManifestBase, cloneFixture, FOUNDATION_RAW } from '../fixtures/usdaFixtures';

/**
 * Phase 1 — bounded in-memory cache. A performance layer only.
 */

function bundleWithUpstream(upstream: string, count: number) {
  const base = makeManifestBase(['foundation'], count, '0'.repeat(64));
  const components = [{ ...base.components[0], upstream_release: upstream }];
  const withComponents = { ...base, components };
  const bundle_release = deriveBundleReleaseId(withComponents as UsdaBundleManifest);
  const records = Array.from({ length: count }, (_, index) => {
    const raw = cloneFixture(FOUNDATION_RAW);
    raw.fdcId = 1000 + index;
    raw.description = `Synthetic record ${upstream} ${index}`;
    const result = adaptUsdaFood(raw, {
      bundle_release,
      upstream_release: upstream,
      data_type: 'foundation',
      nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
    });
    if (!result.ok) {
      throw new Error((result as { ok: false; failure: { code: string } }).failure.code);
    }
    return result.record;
  });
  const manifest: UsdaBundleManifest = {
    ...withComponents,
    bundle_release,
    canonical_record_count: count,
    canonical_content_digest: computeCanonicalContentDigest(records),
  };
  return { manifest, records, bundle_release };
}

const A = bundleWithUpstream('2026-04', 3);
const B = bundleWithUpstream('2025-10', 3);

describe('usda cache — hits, misses, isolation', () => {
  it('stores and returns a validated record (hit) and misses on unknown keys', () => {
    const cache = createUsdaRecordCache({ maxEntries: 8 });
    expect(cache.set(A.records[0])).toEqual({ ok: true });
    const hit = cache.get(A.bundle_release, A.records[0].fdc_id);
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.record.record_digest).toBe(A.records[0].record_digest);
    expect(cache.get(A.bundle_release, 999999)).toEqual({ ok: false, code: 'not_found' });
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
  });

  it('never serves a record across releases', () => {
    const cache = createUsdaRecordCache({ maxEntries: 8 });
    cache.set(A.records[0]);
    expect(cache.get(B.bundle_release, A.records[0].fdc_id)).toEqual({ ok: false, code: 'not_found' });
    cache.set(B.records[0]);
    expect(cache.size()).toBe(2);
    expect(cache.get(A.bundle_release, A.records[0].fdc_id).ok).toBe(true);
    expect(cache.get(B.bundle_release, B.records[0].fdc_id).ok).toBe(true);
  });
});

describe('usda cache — bounds and eviction', () => {
  it('evicts deterministically (LRU) and honors the entry-count bound', () => {
    const cache = createUsdaRecordCache({ maxEntries: 2 });
    cache.set(A.records[0]);
    cache.set(A.records[1]);
    cache.get(A.bundle_release, A.records[0].fdc_id); // make 0 most-recently-used
    cache.set(A.records[2]); // evicts least-recently-used (1)
    expect(cache.size()).toBe(2);
    expect(cache.has(A.bundle_release, A.records[1].fdc_id)).toBe(false);
    expect(cache.has(A.bundle_release, A.records[0].fdc_id)).toBe(true);
    expect(cache.has(A.bundle_release, A.records[2].fdc_id)).toBe(true);
    expect(cache.stats().evictions).toBeGreaterThan(0);
  });

  it('clamps the entry-count option to the hard maximum', () => {
    const cache = createUsdaRecordCache({ maxEntries: 100000 });
    expect(cache.stats().maxEntries).toBe(256);
  });

  it('honors the total byte bound and keeps byte accounting consistent', () => {
    const six = bundleWithUpstream('2026-04', 6);
    const cache = createUsdaRecordCache({ maxEntries: 64, maxBytes: 4096 });
    for (const record of six.records) cache.set(record);
    expect(cache.bytes()).toBeLessThanOrEqual(4096);
    expect(cache.size()).toBeLessThanOrEqual(2);
    expect(cache.stats().evictions).toBeGreaterThan(0);
    // Every remaining entry is still retrievable and accounted for.
    let accounted = 0;
    for (const record of six.records) {
      if (cache.has(record.bundle_release, record.fdc_id)) {
        accounted += serializedBlockBytes(record, 256 * 1024);
      }
    }
    expect(cache.bytes()).toBe(accounted);
  });

  it('rejects an oversized single entry', () => {
    const cache = createUsdaRecordCache({ maxEntries: 8, maxBytes: 1024 });
    expect(cache.set(A.records[0])).toEqual({ ok: false, code: 'entry_too_large' });
    expect(cache.size()).toBe(0);
    expect(cache.bytes()).toBe(0);
  });

  it('updates byte accounting correctly on replacement', () => {
    const cache = createUsdaRecordCache({ maxEntries: 8 });
    cache.set(A.records[0]);
    const replacementRaw = cloneFixture(FOUNDATION_RAW);
    replacementRaw.fdcId = A.records[0].fdc_id;
    replacementRaw.description = 'Synthetic replacement record with a longer description';
    const replacementResult = adaptUsdaFood(replacementRaw, {
      bundle_release: A.bundle_release,
      upstream_release: A.manifest.components[0].upstream_release,
      data_type: 'foundation',
      nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
    });
    expect(replacementResult.ok).toBe(true);
    if (!replacementResult.ok) return;
    cache.set(replacementResult.record);
    expect(cache.size()).toBe(1);
    expect(cache.bytes()).toBe(serializedBlockBytes(replacementResult.record, 256 * 1024));
    expect(cache.get(A.bundle_release, A.records[0].fdc_id).ok).toBe(true);
  });
});

describe('usda cache — invalidation, clear, authority, persistence', () => {
  it('invalidates exactly one release', () => {
    const cache = createUsdaRecordCache({ maxEntries: 16 });
    for (const record of A.records) cache.set(record);
    for (const record of B.records) cache.set(record);
    const removed = cache.invalidateRelease(A.bundle_release);
    expect(removed).toBe(3);
    for (const record of A.records) expect(cache.has(A.bundle_release, record.fdc_id)).toBe(false);
    for (const record of B.records) expect(cache.has(B.bundle_release, record.fdc_id)).toBe(true);
    expect(cache.bytes()).toBeGreaterThan(0);
  });

  it('clears all entries and resets accounting', () => {
    const cache = createUsdaRecordCache({ maxEntries: 8 });
    cache.set(A.records[0]);
    cache.get(A.bundle_release, 999999);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.bytes()).toBe(0);
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 0, evictions: 0, size: 0, bytes: 0 });
  });

  it('returns immutable authority that caller mutation cannot alter', () => {
    const cache = createUsdaRecordCache({ maxEntries: 8 });
    cache.set(A.records[0]);
    const hit = cache.get(A.bundle_release, A.records[0].fdc_id);
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(Object.isFrozen(hit.record)).toBe(true);
    expect(() => {
      (hit.record as { description: string }).description = 'mutated';
    }).toThrow();
    const again = cache.get(A.bundle_release, A.records[0].fdc_id);
    expect(again.ok && again.record.description).toBe(A.records[0].description);
  });

  it('refuses raw or malformed records', () => {
    const cache = createUsdaRecordCache({ maxEntries: 8 });
    expect(cache.set(FOUNDATION_RAW)).toEqual({ ok: false, code: 'invalid_record' });
    expect(cache.set(null)).toEqual({ ok: false, code: 'invalid_record' });
    const tampered = JSON.parse(JSON.stringify(A.records[0])) as { description: string };
    tampered.description = 'tampered';
    expect(cache.set(tampered)).toEqual({ ok: false, code: 'invalid_record' });
    expect(cache.size()).toBe(0);
  });

  it('has no hidden persistence surface', () => {
    const cache = createUsdaRecordCache();
    for (const forbidden of ['persist', 'save', 'load', 'flush', 'sync', 'write']) {
      expect((cache as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
    expect(typeof (globalThis as { localStorage?: unknown }).localStorage).toBe('undefined');
    expect(typeof (globalThis as { indexedDB?: unknown }).indexedDB).toBe('undefined');
  });
});
