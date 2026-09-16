/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: fixed browser asset URL map.
 *
 * COMPILE-TIME-OWNED, LOCAL, OFFLINE. This module contains ONLY the fixed,
 * generated production URLs of the five checked-in bundle files for the locked
 * release, paired with their logical locked filenames:
 *
 *   artifact.json
 *   manifest.json
 *   records.foundation.json.gz
 *   records.sr_legacy.json.gz
 *   records.fndds.json.gz
 *
 * Vite emits each original file as a distinct content-hashed static asset
 * (`?url&no-inline`) whose bytes stay byte-identical to the checked-in source;
 * the URL strings below are fixed at build time. This module carries NO payload,
 * NO base64, and NO fetch logic. It accepts no arguments and reads no
 * environment variable, query parameter, setting, storage value, API response,
 * DOM attribute, or caller value. No runtime path can replace these URLs.
 *
 * Authentication happens later, in the unchanged runtime composer, against the
 * source-controlled release lock, so a wrong or substituted asset fails closed.
 */

import artifactUrl from '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e/artifact.json?url&no-inline';
import manifestUrl from '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e/manifest.json?url&no-inline';
import foundationUrl from '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e/records.foundation.json.gz?url&no-inline';
import srLegacyUrl from '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e/records.sr_legacy.json.gz?url&no-inline';
import fnddsUrl from '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e/records.fndds.json.gz?url&no-inline';

/** One fixed logical bundle input and its compile-time-generated asset URL. */
export interface AdvancedNutritionBundleAsset {
  readonly name: string;
  readonly url: string;
}

/** The exact five fixed asset references, in locked logical order. */
export const ADVANCED_NUTRITION_BUNDLE_ASSETS: ReadonlyArray<AdvancedNutritionBundleAsset> =
  Object.freeze([
    Object.freeze({ name: 'artifact.json', url: artifactUrl }),
    Object.freeze({ name: 'manifest.json', url: manifestUrl }),
    Object.freeze({ name: 'records.foundation.json.gz', url: foundationUrl }),
    Object.freeze({ name: 'records.sr_legacy.json.gz', url: srLegacyUrl }),
    Object.freeze({ name: 'records.fndds.json.gz', url: fnddsUrl }),
  ]);

/** Returns the fixed, compile-time-owned asset URL map. Accepts no arguments. */
export function getFixedUsdaBundleAssetRefs(): ReadonlyArray<AdvancedNutritionBundleAsset> {
  return ADVANCED_NUTRITION_BUNDLE_ASSETS;
}
