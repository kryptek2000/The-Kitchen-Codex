/**
 * SINC-2 — SHISO read-only branded evidence tool.
 *
 * SHISO may explain and compare USDA Branded contributions that the user has
 * already explicitly accepted into the working review. It cannot search USDA,
 * create a product, or apply nutrition from this tool.
 */

import { describe, expect, it } from 'vitest';

import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import {
  adaptUsdaBrandedFoodRecord,
  buildBrandedContribution,
} from '../../src/core/nutritionV2/brandedFoods';
import type { LiveRowState } from '../../src/core/nutritionV2/phase4/liveRow';
import {
  MOCK_BRANDED_GOCHUJANG_FDC_ID,
  mockBrandedDetail,
} from '../fixtures/usdaBrandedFixtures';

function brandedContribution() {
  const candidate = adaptUsdaBrandedFoodRecord(
    mockBrandedDetail(MOCK_BRANDED_GOCHUJANG_FDC_ID),
    'gochujang'
  );
  if (!candidate.ok) throw new Error('fixture failed');
  const built = buildBrandedContribution(candidate.candidate, {
    line_ref: 'ing:gochujang',
    ingredient_text: '2 tbsp gochujang',
    query: 'gochujang',
    amount: 2,
    unit: 'tbsp',
    measurement_kind: 'volume',
    quantity_ml: 29.5735295625,
  });
  if (!built.ok) throw new Error(`contribution failed: ${(built as { reason?: string }).reason}`);
  return built.contribution;
}

function context(contributions = [brandedContribution()]): ShisoToolContext {
  return {
    session: null,
    recipe: {
      title: 'SINC-2 SHISO fixture',
      servings: 2,
      ingredients: [{ text: '2 tbsp gochujang', name: 'gochujang', line_ref: 'ing:gochujang' }],
      instructions: [],
    },
    nutrition: {
      rows: [{ line_ref: 'ing:gochujang' } as LiveRowState],
      aiContributions: contributions,
      summary: '1 of 1 ingredient lines resolved.',
      unsaved: true,
    },
  };
}

describe('SINC-2 SHISO branded evidence tool', () => {
  it('reports only accepted USDA Branded contributions with exact provenance', async () => {
    const observation = await executeShisoTool({ tool: 'get_branded_evidence' }, context());
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;
    expect(observation.tool).toBe('get_branded_evidence');
    const data = observation.data as { count: number; items: Array<Record<string, unknown>> };
    expect(data.count).toBe(1);
    expect(data.items[0]).toMatchObject({
      line_ref: 'ing:gochujang',
      fdc_id: MOCK_BRANDED_GOCHUJANG_FDC_ID,
      product: 'SINC2 MOCK GOCHUJANG SAUCE',
      brand: 'Mock Foods',
      basis: 'per_serving_g',
    });
    expect(observation.summary).toMatch(/accepted USDA Branded contribution/i);
  });

  it('reports no accepted branded evidence without inventing a product', async () => {
    const observation = await executeShisoTool({ tool: 'get_branded_evidence' }, context([]));
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;
    const data = observation.data as { count: number; items: unknown[] };
    expect(data.count).toBe(0);
    expect(data.items).toEqual([]);
    expect(JSON.stringify(observation)).not.toMatch(/gochujang sauce/i);
  });

  it('fails closed when the review is stale relative to the open recipe', async () => {
    const stale = context();
    const observation = await executeShisoTool(
      { tool: 'get_branded_evidence' },
      { ...stale, recipe: { ...stale.recipe!, ingredients: [] } }
    );
    expect(observation.ok).toBe(false);
    if (!observation.ok) expect((observation as { code: string }).code).toBe('stale_recipe');
  });
});
