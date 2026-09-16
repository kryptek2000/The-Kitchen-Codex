/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: fixed browser asset URL map.
 *
 * Proves the compile-time-owned asset module contains exactly the five locked
 * logical filenames paired with fixed generated URLs, carries no payload, accepts
 * no arguments, and that the production loader is a fixed no-argument function.
 * Byte-identity of the emitted assets is verified by the production build script.
 */

import { describe, it, expect } from 'vitest';
import {
  ADVANCED_NUTRITION_BUNDLE_ASSETS,
  getFixedUsdaBundleAssetRefs,
} from '../../src/application/advancedNutritionBundleAssets';
import { loadProductionAdvancedNutritionSession } from '../../src/browser/advancedNutritionBundle';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';

const LOCK = USDA_BUNDLE_RELEASE_LOCK;

describe('phase 4.5B — fixed browser asset URL map', () => {
  it('exposes exactly the five locked logical filenames in locked order', () => {
    expect(ADVANCED_NUTRITION_BUNDLE_ASSETS.map((asset) => asset.name)).toEqual([
      ...LOCK.artifact_filenames,
    ]);
    expect(getFixedUsdaBundleAssetRefs().map((asset) => asset.name)).toEqual([...LOCK.artifact_filenames]);
  });

  it('pairs each logical filename with a fixed non-empty same-origin URL', () => {
    for (const asset of ADVANCED_NUTRITION_BUNDLE_ASSETS) {
      expect(typeof asset.url).toBe('string');
      expect(asset.url.length).toBeGreaterThan(0);
      // Never a data URI / inline payload.
      expect(asset.url.startsWith('data:')).toBe(false);
      // Fixed local asset reference (site-relative or same-origin absolute).
      expect(asset.url.startsWith('/')).toBe(true);
    }
  });

  it('contains no base64/gzip payload and is deeply frozen', () => {
    const serialized = JSON.stringify(ADVANCED_NUTRITION_BUNDLE_ASSETS);
    expect(serialized).not.toMatch(/base64/);
    expect(serialized.length).toBeLessThan(2000);
    expect(Object.isFrozen(ADVANCED_NUTRITION_BUNDLE_ASSETS)).toBe(true);
    for (const asset of ADVANCED_NUTRITION_BUNDLE_ASSETS) expect(Object.isFrozen(asset)).toBe(true);
  });

  it('the zero-argument getter accepts no caller override', () => {
    expect(getFixedUsdaBundleAssetRefs.length).toBe(0);
    expect(getFixedUsdaBundleAssetRefs()).toBe(ADVANCED_NUTRITION_BUNDLE_ASSETS);
  });

  it('the production loader is a fixed no-argument function', () => {
    expect(typeof loadProductionAdvancedNutritionSession).toBe('function');
    expect(loadProductionAdvancedNutritionSession.length).toBe(0);
  });
});
