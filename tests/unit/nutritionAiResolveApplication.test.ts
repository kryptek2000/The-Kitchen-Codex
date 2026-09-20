/**
 * The Kitchen Codex — application-layer AI-assisted USDA resolution flow.
 *
 * Proves the resolver request/response contract, graceful degradation when AI is
 * unavailable or malformed, and that AI suggestions are resolved against the
 * genuine pinned catalog (never granting authority).
 */

import { describe, it, expect, vi } from 'vitest';
import { buildCalculationBundle, type CalcRecordSpec } from '../fixtures/usdaCalculationFixtures';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';

vi.mock('../../src/application/aiSelection', () => ({
  buildAiSelectionRequestOptions: async () => ({}),
}));

import {
  AI_RESOLUTION_UNAVAILABLE_MESSAGE,
  AI_RESOLUTION_INVALID_MESSAGE,
  requestAiIngredientResolution,
  resolveUnresolvedRowsWithAi,
} from '../../src/application/nutritionAiResolve';

const SPECS: ReadonlyArray<CalcRecordSpec> = [
  { fdcId: 6001, dataType: 'sr_legacy', description: 'Flour, wheat, white', nutrients: { calories: 364 } },
  { fdcId: 6002, dataType: 'fndds', description: 'Mystery, raw', nutrients: { calories: 100 } },
  { fdcId: 6003, dataType: 'fndds', description: 'Mystery, cooked', nutrients: { calories: 120 } },
];

const BUNDLE = buildCalculationBundle(SPECS);
const SESSION_RESULT = createAdvancedNutritionSession(BUNDLE.manifest, BUNDLE.records);
if (!SESSION_RESULT.ok) throw new Error('session failed');
const SESSION: AdvancedNutritionSession = SESSION_RESULT.session;

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

function recipe(lines: ReadonlyArray<string>): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'AI App Flow',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: lines.map(structured) as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as ObsidianRecipe;
}

function buildRows(lines: ReadonlyArray<string>) {
  const adaptation = adaptRecipe(recipe(lines));
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  return { adapted, rows: buildReviewRows(SESSION, adapted) };
}

function fakeNetwork(impl: (path: string, body: unknown) => Promise<unknown>): NetworkAdapter {
  return {
    request: vi.fn(),
    get: vi.fn(),
    post: vi.fn(async (path: string, body: unknown) => impl(path, body)),
  } as unknown as NetworkAdapter;
}

describe('AI resolution — application request/response', () => {
  it('sends only bounded unresolved rows and accepts a valid advisory response', async () => {
    const { adapted, rows } = buildRows(['1 cup Zzz', '100 g Flour, wheat, white']);
    const zzzRow = rows.find((row) => /zzz/i.test(row.query));
    if (!zzzRow) throw new Error('missing row');

    let sentBody: unknown;
    const network = fakeNetwork(async (path, body) => {
      expect(path).toBe('/api/nutrition/resolve-ingredients');
      sentBody = body;
      return {
        ok: true,
        status: 200,
        data: {
          ok: true,
          version: 'nutrition_ai_resolution_v1',
          suggestions: [
            {
              line_ref: zzzRow.line_ref,
              interpreted_food_name: 'Mystery, raw',
              suggested_usda_queries: ['mystery raw'],
            },
          ],
        },
      };
    });

    const result = await requestAiIngredientResolution({ network, rows, adapted });
    expect(result.ok).toBe(true);
    expect(result.suggestions).toHaveLength(1);
    // The request carried ONLY the unresolved row (not the resolved flour row).
    const ingredients = (sentBody as { ingredients: ReadonlyArray<{ line_ref: string }> }).ingredients;
    expect(ingredients).toHaveLength(1);
    expect(ingredients[0].line_ref).toBe(zzzRow.line_ref);
  });

  it('degrades gracefully when the resolver is unavailable (503)', async () => {
    const { adapted, rows } = buildRows(['1 cup Zzz']);
    const network = fakeNetwork(async () => ({
      ok: false,
      status: 503,
      data: { ok: false, error: 'AI assistance is unavailable.' },
    }));
    const result = await requestAiIngredientResolution({ network, rows, adapted });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(AI_RESOLUTION_UNAVAILABLE_MESSAGE);
  });

  it('rejects a structurally invalid AI response (forbidden authority field)', async () => {
    const { adapted, rows } = buildRows(['1 cup Zzz']);
    const zzzRow = rows.find((row) => /zzz/i.test(row.query));
    if (!zzzRow) throw new Error('missing row');
    const network = fakeNetwork(async () => ({
      ok: true,
      status: 200,
      data: {
        ok: true,
        suggestions: [
          {
            line_ref: zzzRow.line_ref,
            interpreted_food_name: 'Mystery, raw',
            suggested_usda_queries: ['mystery raw'],
            fdc_id: 6002,
          },
        ],
      },
    }));
    const result = await requestAiIngredientResolution({ network, rows, adapted });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(AI_RESOLUTION_INVALID_MESSAGE);
  });

  it('reports nothing to resolve when every row is already resolved', async () => {
    const { adapted, rows } = buildRows(['100 g Flour, wheat, white']);
    const network = fakeNetwork(async () => ({ ok: true, status: 200, data: { ok: true, suggestions: [] } }));
    const result = await requestAiIngredientResolution({ network, rows, adapted });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Nothing unresolved/i);
  });

  it('resolves AI suggestions against the genuine pinned catalog end-to-end', async () => {
    const { adapted, rows } = buildRows(['1 cup Zzz']);
    const zzzRow = rows.find((row) => /zzz/i.test(row.query));
    if (!zzzRow) throw new Error('missing row');
    const network = fakeNetwork(async () => ({
      ok: true,
      status: 200,
      data: {
        ok: true,
        suggestions: [
          {
            line_ref: zzzRow.line_ref,
            interpreted_food_name: 'Mystery, raw',
            suggested_usda_queries: ['mystery raw'],
          },
        ],
      },
    }));
    const result = await resolveUnresolvedRowsWithAi({
      network,
      session: SESSION,
      rows,
      adapted,
    });
    expect(result.ok).toBe(true);
    expect(result.outcome.candidates).toHaveLength(1);
    expect(result.outcome.candidates[0].fdc_id).toBe(6002);
    expect(result.outcome.candidates[0].auto).toBe(true);
    // No mass authority from AI.
    expect((result.outcome.candidates[0].choice as { record_digest?: string }).record_digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
