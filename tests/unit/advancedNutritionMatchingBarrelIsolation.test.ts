import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Phase 2 — matching barrel isolation (test-only; no production code involved).
 *
 * The Phase 2 deterministic matching layer under `src/core/nutritionV2/matching/`
 * is deliberately NOT wired into any production surface. Its public API markers
 * must not be mentioned, re-exported, or exposed through either public barrel
 * (`src/core/nutritionV2/index.ts`, `src/core/index.ts`); callers and tests must
 * reach them by explicit deep import.
 *
 * Proven two ways:
 *   1. static source-text assertions — neither barrel mentions the markers;
 *   2. runtime export-surface assertions — no marker appears in either barrel
 *      namespace, while the matching barrel itself still exports all six.
 */

const MATCHING_EXPORT_MARKERS = [
  'normalizeQuery',
  'parseIngredient',
  'rankCandidates',
  'reviewIngredient',
  'createReviewCatalog',
  'confirmIngredientReview',
] as const;

const BARREL_SOURCES = {
  'src/core/nutritionV2/index.ts': fileURLToPath(
    new URL('../../src/core/nutritionV2/index.ts', import.meta.url),
  ),
  'src/core/index.ts': fileURLToPath(new URL('../../src/core/index.ts', import.meta.url)),
} as const;

type NamespaceLike = Record<string, unknown>;

describe('Phase 2 matching barrel isolation', () => {
  it('neither public barrel source mentions the matching module or its markers', () => {
    for (const [label, filePath] of Object.entries(BARREL_SOURCES)) {
      const source = readFileSync(filePath, 'utf8');
      expect(source, `${label} must not reference the matching module`).not.toMatch(/matching/i);
      for (const marker of MATCHING_EXPORT_MARKERS) {
        expect(source, `${label} must not mention ${marker}`).not.toContain(marker);
      }
    }
  });

  it('neither barrel namespace exposes the matching API markers', async () => {
    const nutritionV2 = (await import('../../src/core/nutritionV2')) as unknown as NamespaceLike;
    const core = (await import('../../src/core')) as unknown as NamespaceLike;
    for (const marker of MATCHING_EXPORT_MARKERS) {
      expect(nutritionV2[marker], `nutritionV2 barrel leaks ${marker}`).toBeUndefined();
      expect(core[marker], `core barrel leaks ${marker}`).toBeUndefined();
    }
  });

  it('the matching barrel still exports all six markers by deep import', async () => {
    const matching = (await import(
      '../../src/core/nutritionV2/matching'
    )) as unknown as NamespaceLike;
    for (const marker of MATCHING_EXPORT_MARKERS) {
      expect(matching[marker], `matching barrel must export ${marker}`).toBeDefined();
    }
  });
});
