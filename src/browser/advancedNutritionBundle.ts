/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: production runtime entry.
 *
 * FIXED, NO-ARGUMENT production loader. It accepts NO asset URL, directory,
 * release lock, environment override, or replacement byte source from callers.
 *
 * Boundary:
 *   fixed compile-time URL map -> bounded same-origin fetch -> exact locked bytes
 *     -> unchanged authenticated composer -> genuine Phase 4 session
 *
 * On explicit user action it: confirms the safe gzip capability BEFORE
 * downloading; resolves the fixed generated asset URLs; fetches them with
 * ordinary retryable same-origin fetch semantics (no dynamic module import, so a
 * failed request can be genuinely retried); enforces the exact locked byte
 * lengths as streaming bounds; and passes exactly the five `{ name, bytes }`
 * inputs to the unchanged composer. All or nothing: any failure returns a fixed,
 * bounded, input-redacted failure and installs no session.
 *
 * Loading happens ONLY when this function is explicitly invoked; it is never
 * called at application startup. The returned session is in-memory only — nothing
 * is written to IndexedDB, localStorage/sessionStorage, Cache Storage, a service
 * worker, a vault file, settings, or Markdown/frontmatter.
 */

import { ADVANCED_NUTRITION_BUNDLE_ASSETS } from '../application/advancedNutritionBundleAssets';
import { fetchAdvancedNutritionBundleAssets } from '../platform/browser/advancedNutritionBundleFetch';
import type { AdvancedNutritionAssetRequest } from '../platform/browser/advancedNutritionBundleFetch';
import {
  composeAdvancedNutritionSessionFromBundle,
  hasGzipDecodeCapability,
  runtimeBundleFailure,
} from '../core/nutritionV2/runtime';
import type { RuntimeBundleResult } from '../core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../core/nutritionV2/usda/releaseLock';

export type { RuntimeBundleFailure, RuntimeBundleResult } from '../core/nutritionV2/runtime';

/** The exact locked byte length for each of the five logical filenames. */
function lockedExpectedBytesByName(): Map<string, number> {
  const lock = USDA_BUNDLE_RELEASE_LOCK;
  const expected = new Map<string, number>();
  expected.set(lock.artifact.filename, lock.artifact.bytes);
  expected.set(lock.manifest.filename, lock.manifest.bytes);
  for (const shard of lock.shards) expected.set(shard.filename, shard.compressed_bytes);
  return expected;
}

/**
 * Loads and authenticates the fixed local USDA bundle, then composes one genuine
 * Phase 4 session. All-or-nothing; no fallback and no caller-supplied source.
 */
export async function loadProductionAdvancedNutritionSession(): Promise<RuntimeBundleResult> {
  // Confirm the safe gzip capability BEFORE requesting the dataset.
  if (!hasGzipDecodeCapability()) {
    return { ok: false, failure: runtimeBundleFailure('unsupported_runtime') };
  }

  const expected = lockedExpectedBytesByName();
  const requests: AdvancedNutritionAssetRequest[] = [];
  for (const asset of ADVANCED_NUTRITION_BUNDLE_ASSETS) {
    const expectedBytes = expected.get(asset.name);
    if (expectedBytes === undefined) {
      return { ok: false, failure: runtimeBundleFailure('asset_fetch_failed') };
    }
    requests.push({ name: asset.name, url: asset.url, expectedBytes });
  }

  const fetched = await fetchAdvancedNutritionBundleAssets(requests);
  if (!fetched.ok) {
    return { ok: false, failure: runtimeBundleFailure('asset_fetch_failed') };
  }

  return composeAdvancedNutritionSessionFromBundle({ files: fetched.files });
}
