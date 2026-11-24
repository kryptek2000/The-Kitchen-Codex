import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK as lock } from '../../src/core/nutritionV2/usda/releaseLock';
import { calculateCatalogBasicNutrition } from '../../src/application/catalogBasicNutrition';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';

/**
 * NQ-1 — real-recipe trailing prose must not become required food identity.
 *
 * These are verbatim ingredient lines from the owner's real Vault. Before the
 * repair, a trailing comma clause such as `, at room temperature` made `at` (or
 * `is`) the required matching anchor, so an unambiguous food matched nothing.
 * The expected grams are either authored in the line or the authenticated USDA
 * household portion; no quantity is invented here.
 */
let session: AdvancedNutritionSession;

beforeAll(async () => {
  const base = join(__dirname, '../../data/advanced-nutrition/usda', lock.bundle_release);
  const files = lock.artifact_filenames.map((name) => ({
    name,
    bytes: new Uint8Array(readFileSync(join(base, name))),
  }));
  const result = await composeAdvancedNutritionSessionFromBundle({ files });
  if (!result.ok) throw result;
  session = result.session;
}, 180000);

function lineOf(ingredient: string) {
  return calculateCatalogBasicNutrition({ ingredients: [ingredient], servings: 4 }, session).lines[0];
}

describe('NQ-1 — trailing recipe prose no longer hides the food', () => {
  const cases: ReadonlyArray<{
    readonly line: string;
    readonly food: RegExp;
    readonly grams: { readonly exact?: number; readonly min?: number; readonly max?: number };
  }> = [
    {
      line: '8 tablespoons (113g) unsalted butter, at room temperature',
      food: /butter, without salt/i,
      grams: { exact: 113 },
    },
    {
      line: '2 tablespoons (30 grams) unsalted butter, cold is fine',
      food: /butter, without salt/i,
      grams: { exact: 30 },
    },
    {
      line: '6 tablespoons (3 ounces or 85 grams) unsalted butter, cold is fine',
      food: /butter, without salt/i,
      grams: { min: 80, max: 90 },
    },
    {
      line: '1 large egg, at room temperature',
      food: /egg, whole, raw/i,
      grams: { exact: 50 },
    },
    {
      line: '1/2 cup butter, at room temperature',
      food: /butter/i,
      grams: { min: 110, max: 116 },
    },
  ];

  it.each(cases)('$line', ({ line, food, grams }) => {
    const resolved = lineOf(line);
    expect(resolved.status).toBe('resolved');
    expect(resolved.matchedFood).toMatch(food);
    expect(resolved.grams).not.toBeNull();
    if (grams.exact !== undefined) expect(resolved.grams).toBeCloseTo(grams.exact, 0);
    if (grams.min !== undefined) expect(resolved.grams!).toBeGreaterThanOrEqual(grams.min);
    if (grams.max !== undefined) expect(resolved.grams!).toBeLessThanOrEqual(grams.max);
  });
});
