/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: production loader.
 *
 * Proves the fixed no-argument loader: checks the safe gzip capability BEFORE
 * any dataset request; maps any asset-fetch failure to a fixed bounded failure
 * with no session; and, when the exact locked bytes are served, composes one
 * genuine Phase 4 session through the unchanged authenticated composer.
 *
 * Runs in the Node environment (fast native ReadableStream/DecompressionStream)
 * with a stubbed `location`; the platform fetch uses `globalThis.fetch`.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadProductionAdvancedNutritionSession } from '../../src/browser/advancedNutritionBundle';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

function realBytesByName(): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const name of USDA_BUNDLE_RELEASE_LOCK.artifact_filenames) {
    map.set(name, new Uint8Array(readFileSync(join(BUNDLE_DIR, name))));
  }
  return map;
}

function failOf(result: unknown): { code: string; message: string } {
  return (result as { failure: { code: string; message: string } }).failure;
}

function mockRealAssetFetch(): ReturnType<typeof vi.fn> {
  const bytes = realBytesByName();
  const fetchMock = vi.fn(async (url: string) => {
    const requested = String(url);
    let matched: Uint8Array | undefined;
    for (const [name, value] of bytes) {
      if (requested.includes(name)) {
        matched = value;
        break;
      }
    }
    if (!matched) {
      return { ok: false, status: 404, redirected: false, url: requested, headers: new Headers(), body: null };
    }
    return {
      ok: true,
      status: 200,
      redirected: false,
      url: requested,
      headers: new Headers({ 'content-length': String(matched.byteLength) }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(matched as Uint8Array);
          controller.close();
        },
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubGlobal('location', { href: 'http://localhost:3000/', origin: 'http://localhost:3000' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('phase 4.5B loader — capability and failure mapping', () => {
  it('fails unsupported BEFORE requesting any dataset asset', async () => {
    const saved = (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      (globalThis as { DecompressionStream?: unknown }).DecompressionStream = undefined;
      const result = await loadProductionAdvancedNutritionSession();
      expect(result.ok).toBe(false);
      expect(failOf(result).code).toBe('unsupported_runtime');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      (globalThis as { DecompressionStream?: unknown }).DecompressionStream = saved;
    }
  });

  it('maps an asset fetch failure to a fixed bounded failure with no session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('attacker-controlled-message');
    }));
    const result = await loadProductionAdvancedNutritionSession();
    expect(result.ok).toBe(false);
    expect(failOf(result).code).toBe('asset_fetch_failed');
    expect(failOf(result).message).toBe('advanced_nutrition_bundle_asset_fetch_failed');
    expect(failOf(result).message).not.toMatch(/attacker/);
    expect((result as { session?: unknown }).session).toBeUndefined();
  });

  it('composes one genuine session from the exact locked bytes', async () => {
    mockRealAssetFetch();
    const result = await loadProductionAdvancedNutritionSession();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.metadata().source_record_count).toBe(13559);
      expect(result.session.metadata().record_count).toBe(12924);
      expect(result.session.metadata().bundle_release).toBe(
        USDA_BUNDLE_RELEASE_LOCK.bundle_release
      );
    }
  }, 120000);
});
