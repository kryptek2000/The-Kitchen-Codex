import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Phase 1 — USDA adapter isolation (test-only; no production code involved).
 *
 * The Phase 1 trusted USDA adapter layer under `src/core/nutritionV2/usda/` is
 * deliberately NOT wired into any production surface. It must not be
 * re-exported, imported, or otherwise exposed through the two public barrels
 * `src/core/nutritionV2/index.ts` and `src/core/index.ts`; callers and tests
 * must reach it by explicit deep import.
 *
 * Proven two ways:
 *   1. static source-text assertions — neither barrel mentions `usda`;
 *   2. runtime export-surface assertions — no USDA name appears in either
 *      barrel namespace, while the USDA barrel itself still exports them.
 */

const USDA_EXPORT_MARKERS = [
  'adaptUsdaFood',
  'createUsdaRecordCache',
  'USDA_SOURCE_ID',
  'USDA_DATA_TYPES',
  'USDA_NUTRIENT_MAP_VERSION',
  'computeCanonicalContentDigest',
  'deriveBundleReleaseId',
] as const;

const BARREL_SOURCES = {
  'src/core/nutritionV2/index.ts': fileURLToPath(
    new URL('../../src/core/nutritionV2/index.ts', import.meta.url),
  ),
  'src/core/index.ts': fileURLToPath(new URL('../../src/core/index.ts', import.meta.url)),
} as const;

type NamespaceLike = Record<string, unknown>;

describe('Phase 1 USDA adapter isolation', () => {
  it('neither public barrel source mentions the usda module', () => {
    for (const [label, filePath] of Object.entries(BARREL_SOURCES)) {
      const source = readFileSync(filePath, 'utf8');
      expect(source, `${label} must not reference the usda module`).not.toMatch(/usda/i);
      for (const marker of USDA_EXPORT_MARKERS) {
        expect(source, `${label} must not mention ${marker}`).not.toContain(marker);
      }
    }
  });

  it('neither barrel namespace exposes USDA adapter exports', async () => {
    const nutritionV2 = (await import('../../src/core/nutritionV2')) as unknown as NamespaceLike;
    const core = (await import('../../src/core')) as unknown as NamespaceLike;
    for (const marker of USDA_EXPORT_MARKERS) {
      expect(nutritionV2[marker], `nutritionV2 barrel leaks ${marker}`).toBeUndefined();
      expect(core[marker], `core barrel leaks ${marker}`).toBeUndefined();
    }
  });

  it('the USDA barrel still exports the adapter surface by deep import', async () => {
    const usda = (await import('../../src/core/nutritionV2/usda')) as unknown as NamespaceLike;
    for (const marker of ['adaptUsdaFood', 'createUsdaRecordCache', 'USDA_SOURCE_ID'] as const) {
      expect(usda[marker], `usda barrel must export ${marker}`).toBeDefined();
    }
  });
});
