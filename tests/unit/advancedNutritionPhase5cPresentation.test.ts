/**
 * The Kitchen Codex — Advanced Nutrition Phase 5C: consolidated presentation.
 *
 * Proves the pure precedence selector: a recognized saved Advanced result is the
 * preferred display authority, legacy/simple nutrition is the fallback only when
 * no recognized Advanced block exists, unknown/malformed saved blocks are
 * preserved and reported, and nothing is ever merged, migrated, or mutated.
 */

import { describe, it, expect } from 'vitest';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import { decodeCodexNutrition } from '../../src/core/nutritionV2/validate';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
import {
  resolveNutritionDisplayCalories,
  resolveRecipeNutritionPresentation,
} from '../../src/core/nutritionV2/phase5c';
import type { ObsidianRecipe } from '../../src/types';

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

function recipe(
  lines: ReadonlyArray<string>,
  overrides: Partial<ObsidianRecipe> = {}
): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'Test Recipe',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 4,
    ingredients: lines.map(structured) as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    ...overrides,
  } as ObsidianRecipe;
}

/** Builds a valid schema-v1 block whose line refs match the recipe's adapted set. */
function advancedBlock(
  target: ObsidianRecipe,
  overrides: Partial<CodexNutritionV1> = {}
): CodexNutritionV1 {
  const adaptation = adaptRecipe(target);
  if (!adaptation.ok) throw new Error('adapt failed');
  const lineRefs = adaptation.recipe.adapted.map((entry) => entry.line_ref);
  return {
    schema: 1,
    basis: 'total',
    servings: adaptation.recipe.base_servings,
    status: 'partial',
    computed_at: '2026-09-14T00:00:00.000Z',
    ingredient_digest: `sha256:${'a'.repeat(64)}`,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc'],
    source_releases: { usda_fdc: 'usda_fdc_release_2026_04' },
    nutrient_scope: ['calories'],
    nutrients: {
      calories: {
        amount: 364,
        unit: 'kcal',
        status: 'partial',
        coverage: 0.5,
        covered_ingredient_count: 1,
        measurable_ingredient_count: 2,
      },
    },
    ingredients: lineRefs.map((line_ref) => ({
      line_ref,
      source: 'usda_fdc' as const,
      source_food_id: '6001',
      source_release: 'usda_fdc_release_2026_04',
      match_status: 'confirmed' as const,
      resolved: true,
      user_confirmed: true,
    })),
    unresolved: [],
    ...overrides,
  };
}

/** A recognized COMPLETE block (all lines resolved, complete nutrient coverage). */
function completeBlock(
  target: ObsidianRecipe,
  overrides: Partial<CodexNutritionV1> = {}
): CodexNutritionV1 {
  return advancedBlock(target, {
    status: 'complete',
    nutrients: {
      calories: {
        amount: 364,
        unit: 'kcal',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 2,
        measurable_ingredient_count: 2,
      },
    },
    ...overrides,
  });
}

const FLOUR = '100 g Flour, wheat, white';
const SUGAR = '50 g Sugar, granulated';

describe('phase 5C — presentation precedence', () => {
  it('1. valid Advanced only -> advanced_saved', () => {
    const r = recipe([FLOUR], { codexNutrition: advancedBlock(recipe([FLOUR])) as never });
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.kind).toBe('advanced_saved');
    expect(p.advanced_preferred).toBe(true);
    expect(p.advanced?.schema).toBe(1);
    expect(p.legacy_nutrition).toBeUndefined();
  });

  it('2. legacy only -> legacy', () => {
    const r = recipe([FLOUR], { nutrition: { calories: 320, protein: 12 } as never });
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.kind).toBe('legacy');
    expect(p.advanced_preferred).toBe(false);
    expect(p.legacy_nutrition?.calories).toBe(320);
  });

  it('3. both -> Advanced is preferred', () => {
    const base = recipe([FLOUR]);
    const r = recipe([FLOUR], {
      codexNutrition: advancedBlock(base) as never,
      nutrition: { calories: 320 } as never,
    });
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.kind).toBe('advanced_saved');
    expect(p.advanced_preferred).toBe(true);
    expect(p.legacy_nutrition?.calories).toBe(320);
  });

  it('4. conflicting both -> Advanced value wins, legacy preserved', () => {
    const base = recipe([FLOUR]);
    const r = recipe([FLOUR], {
      codexNutrition: completeBlock(base) as never,
      nutrition: { calories: 9999 } as never,
      calories: '9999',
    });
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.kind).toBe('advanced_saved');
    expect(resolveNutritionDisplayCalories(p, 4)).toBe(364);
    expect(resolveNutritionDisplayCalories(p, 4)).not.toBe(9999);
    // Legacy remains available in the presentation, untouched.
    expect(p.legacy_nutrition?.calories).toBe(9999);
    expect(p.legacy_calories).toBe('9999');
  });

  it('5. partial Advanced + legacy -> partial Advanced remains primary; header stays blank', () => {
    const base = recipe([FLOUR]);
    const block = advancedBlock(base, { status: 'partial' });
    const r = recipe([FLOUR], { codexNutrition: block as never, nutrition: { calories: 100 } as never });
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.kind).toBe('advanced_saved');
    expect(p.advanced?.status).toBe('partial');
    expect(p.advanced_preferred).toBe(true);
    // A PARTIAL result is never headlined as a complete calorie total; the
    // partial values are surfaced (labelled) in the compact card instead.
    expect(resolveNutritionDisplayCalories(p, 4)).toBeUndefined();
    expect(resolveNutritionDisplayCalories(p, 4)).not.toBe(100);
  });

  it('6. stale Advanced + legacy -> advanced_stale, not silent legacy replacement', () => {
    const base = recipe([FLOUR], { servings: 2 });
    const block = completeBlock(base, { servings: 2 });
    const edited = recipe([FLOUR, SUGAR], { servings: 4, codexNutrition: block as never, nutrition: { calories: 100 } as never });
    const p = resolveRecipeNutritionPresentation(edited);
    expect(p.kind).toBe('advanced_stale');
    expect(p.advanced_stale).toBe(true);
    expect(p.advanced_preferred).toBe(true);
    expect(p.stale_reasons).toContain('servings_changed');
    expect(p.stale_reasons).toContain('ingredients_changed');
    // The Advanced value is still the display authority, never the legacy value
    // (364 total for the stored 2-serving basis, scaled to 4 requested servings).
    expect(resolveNutritionDisplayCalories(p, 4)).toBe(728);
    expect(resolveNutritionDisplayCalories(p, 4)).not.toBe(100);
  });

  it('7. unknown future Advanced + legacy -> advanced_unsupported', () => {
    const r = recipe([FLOUR], {
      frontmatter: { codex_nutrition: { schema: 3, basis: 'total', futureField: true } },
      nutrition: { calories: 100 } as never,
    });
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.kind).toBe('advanced_unsupported');
    expect(p.has_opaque_block).toBe(true);
    expect(p.advanced_preferred).toBe(false);
    expect(p.legacy_nutrition?.calories).toBe(100);
  });

  it('8. malformed Advanced + legacy -> advanced_invalid', () => {
    const r = recipe([FLOUR], {
      frontmatter: { codex_nutrition: { schema: 1, basis: 'per_serving', servings: 4 } },
      nutrition: { calories: 100 } as never,
    });
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.kind).toBe('advanced_invalid');
    expect(p.has_malformed_block).toBe(true);
    expect(p.advanced_preferred).toBe(false);
  });

  it('9. no nutrition -> none', () => {
    const p = resolveRecipeNutritionPresentation(recipe([FLOUR]));
    expect(p.kind).toBe('none');
    expect(p.legacy_nutrition).toBeUndefined();
    expect(p.legacy_calories).toBeUndefined();
  });

  it('10. top-level calories only -> legacy fallback', () => {
    const p = resolveRecipeNutritionPresentation(recipe([FLOUR], { calories: '450' }));
    expect(p.kind).toBe('legacy');
    expect(p.legacy_calories).toBe('450');
    expect(resolveNutritionDisplayCalories(p, 4)).toBe('450');
  });

  it('derives the Advanced header value from the stored denominator at the requested count', () => {
    const base = recipe([FLOUR], { servings: 4 });
    const block = completeBlock(base, { servings: 4 });
    const p = resolveRecipeNutritionPresentation(recipe([FLOUR], { servings: 4, codexNutrition: block as never }));
    expect(resolveNutritionDisplayCalories(p, 4)).toBe(364);
    expect(resolveNutritionDisplayCalories(p, 8)).toBe(728);
  });
});

describe('phase 5C — non-destruction and hostile input', () => {
  it('11. resolving never mutates the recipe (view-only)', () => {
    const base = recipe([FLOUR]);
    const r = recipe([FLOUR], {
      codexNutrition: advancedBlock(base) as never,
      nutrition: { calories: 320 } as never,
      calories: '320',
      frontmatter: { my_custom_field: 'keep-me' },
    });
    const before = JSON.stringify(r);
    resolveRecipeNutritionPresentation(r);
    resolveRecipeNutritionPresentation(r);
    expect(JSON.stringify(r)).toBe(before);
  });

  it('12. opening a legacy recipe does not migrate or modify it', () => {
    const r = recipe([FLOUR], { nutrition: { calories: 320 }, calories: '320' });
    const before = JSON.stringify(r);
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.kind).toBe('legacy');
    expect(JSON.stringify(r)).toBe(before);
  });

  it('13. a hostile accessor is never invoked and fails safely', () => {
    let invoked = 0;
    const hostile = recipe([FLOUR]);
    Object.defineProperty(hostile, 'nutrition', {
      enumerable: true,
      configurable: true,
      get() {
        invoked += 1;
        return { calories: 1 };
      },
    });
    const p = resolveRecipeNutritionPresentation(hostile);
    expect(invoked).toBe(0);
    expect(p.kind).toBe('none');
  });

  it('14. a throwing Proxy fails safely without throwing', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('SECRET_MARKER');
        },
        ownKeys() {
          throw new Error('SECRET_MARKER');
        },
        getOwnPropertyDescriptor() {
          throw new Error('SECRET_MARKER');
        },
      }
    );
    let message = '';
    let p: ReturnType<typeof resolveRecipeNutritionPresentation> | undefined;
    try {
      p = resolveRecipeNutritionPresentation(hostile);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('SECRET_MARKER');
    expect(p?.kind).toBe('none');
  });

  it('15. class instances and dangerous keys are handled safely', () => {
    class Hostile {}
    expect(resolveRecipeNutritionPresentation(new Hostile()).kind).toBe('none');
    const dangerous = { __proto__: { polluted: true }, ingredients: [] };
    expect(resolveRecipeNutritionPresentation(dangerous).kind).toBe('none');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('16. a valid block survives an unrelated legacy field', () => {
    const base = recipe([FLOUR]);
    const block = advancedBlock(base);
    const r = recipe([FLOUR], { codexNutrition: block as never, nutrition: { calories: 1 } as never });
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.advanced).toBeDefined();
    expect(decodeCodexNutrition(p.advanced).kind).toBe('v1');
  });
});

// ---------------------------------------------------------------------------
// H1 — header calories are single-authority (no legacy top-up)
// ---------------------------------------------------------------------------

/** A valid partial block whose scope includes calories but has NO calories value. */
function advancedBlockWithoutCalories(target: ObsidianRecipe, overrides: Partial<CodexNutritionV1> = {}): CodexNutritionV1 {
  const base = advancedBlock(target);
  return { ...base, status: 'partial', nutrients: {}, ...overrides };
}

describe('phase 5C H1 — header calories never fall back to legacy while Advanced is preferred', () => {
  it('1. valid Advanced with calories + legacy 9999 -> Advanced calories', () => {
    const base = recipe([FLOUR]);
    const r = recipe([FLOUR], {
      codexNutrition: completeBlock(base) as never,
      nutrition: { calories: 9999, servings: 4 } as never,
      calories: '9999',
    });
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.kind).toBe('advanced_saved');
    expect(resolveNutritionDisplayCalories(p, 4)).toBe(364);
  });

  it('2. valid Advanced WITHOUT calories + legacy 9999 -> undefined (never legacy)', () => {
    const base = recipe([FLOUR]);
    const r = recipe([FLOUR], {
      codexNutrition: advancedBlockWithoutCalories(base) as never,
      nutrition: { calories: 9999, servings: 4 } as never,
      calories: '9999',
    });
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.kind).toBe('advanced_saved');
    expect(p.advanced_preferred).toBe(true);
    expect(p.advanced_calories_total).toBeUndefined();
    expect(resolveNutritionDisplayCalories(p, 4)).toBeUndefined();
  });

  it('3. partial Advanced without calories + legacy -> Advanced authority, header undefined', () => {
    const base = recipe([FLOUR]);
    const block = advancedBlockWithoutCalories(base, { status: 'partial' });
    const r = recipe([FLOUR], { codexNutrition: block as never, nutrition: { calories: 9999, servings: 4 } as never });
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.kind).toBe('advanced_saved');
    expect(p.advanced?.status).toBe('partial');
    expect(resolveNutritionDisplayCalories(p, 4)).toBeUndefined();
  });

  it('4. stale Advanced without calories + legacy -> stale Advanced authority, header undefined', () => {
    const base = recipe([FLOUR], { servings: 2 });
    const block = advancedBlockWithoutCalories(base, { servings: 2 });
    const r = recipe([FLOUR, SUGAR], {
      servings: 4,
      codexNutrition: block as never,
      nutrition: { calories: 9999, servings: 4 } as never,
      calories: '9999',
    });
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.kind).toBe('advanced_stale');
    expect(p.advanced_preferred).toBe(true);
    expect(resolveNutritionDisplayCalories(p, 4)).toBeUndefined();
  });

  it('5. legacy-only -> legacy calories still work', () => {
    const r = recipe([FLOUR], { nutrition: { calories: 500, servings: 4 } as never });
    const p = resolveRecipeNutritionPresentation(r);
    expect(p.kind).toBe('legacy');
    expect(resolveNutritionDisplayCalories(p, 4)).toBe(500);
  });

  it('6. calories-only legacy recipe -> existing legacy behavior preserved', () => {
    const p = resolveRecipeNutritionPresentation(recipe([FLOUR], { calories: '450' }));
    expect(p.kind).toBe('legacy');
    expect(resolveNutritionDisplayCalories(p, 4)).toBe('450');
  });

  it('does not "top up" a recognized Advanced result with legacy calories', () => {
    const base = recipe([FLOUR]);
    const r = recipe([FLOUR], {
      codexNutrition: advancedBlockWithoutCalories(base) as never,
      nutrition: { calories: 9999, servings: 4 } as never,
      calories: '9999',
    });
    const p = resolveRecipeNutritionPresentation(r);
    expect(resolveNutritionDisplayCalories(p, 4)).not.toBe(9999);
    expect(resolveNutritionDisplayCalories(p, 8)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// H2 — adaptation failure fails closed to stale
// ---------------------------------------------------------------------------

describe('phase 5C H2 — adaptation failure marks the saved result stale', () => {
  it('a recipe with no measurable ingredients -> advanced_stale, block preserved', () => {
    const base = recipe([FLOUR]);
    const block = completeBlock(base);
    const broken = recipe([], { codexNutrition: block as never, nutrition: { calories: 9999, servings: 4 } as never });
    const before = JSON.stringify(broken);
    const p = resolveRecipeNutritionPresentation(broken);
    expect(p.kind).toBe('advanced_stale');
    expect(p.advanced_stale).toBe(true);
    expect(p.advanced_preferred).toBe(true);
    expect(p.stale_reasons).toContain('ingredients_changed');
    expect(p.advanced).toEqual(block);
    // No legacy substitution (the block has its own calories).
    expect(resolveNutritionDisplayCalories(p, 4)).toBe(364);
    // No mutation.
    expect(JSON.stringify(broken)).toBe(before);
  });

  it('a malformed current ingredient structure -> advanced_stale without throwing', () => {
    const base = recipe([FLOUR]);
    const block = advancedBlock(base);
    const malformed = recipe([FLOUR], {
      ingredients: 'not-an-array' as never,
      codexNutrition: block as never,
      nutrition: { calories: 9999, servings: 4 } as never,
    });
    let message = '';
    let p: ReturnType<typeof resolveRecipeNutritionPresentation> | undefined;
    try {
      p = resolveRecipeNutritionPresentation(malformed);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('');
    expect(p?.kind).toBe('advanced_stale');
    expect(p?.stale_reasons).toContain('ingredients_changed');
    expect(p?.advanced).toEqual(block);
  });

  it('adaptation failure without Advanced calories -> header undefined (no legacy top-up)', () => {
    const base = recipe([FLOUR]);
    const block = advancedBlockWithoutCalories(base);
    const broken = recipe([], { codexNutrition: block as never, nutrition: { calories: 9999, servings: 4 } as never, calories: '9999' });
    const p = resolveRecipeNutritionPresentation(broken);
    expect(p.kind).toBe('advanced_stale');
    expect(resolveNutritionDisplayCalories(p, 4)).toBeUndefined();
  });
});
