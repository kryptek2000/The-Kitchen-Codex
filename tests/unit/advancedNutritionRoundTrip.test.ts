import { describe, it, expect } from 'vitest';
import {
  parseObsidianRecipeMarkdown,
  serializeRecipeToObsidianMarkdown,
} from '../../src/utils/markdownParser';
import { nutritionForServings, resolveNutritionBase } from '../../src/utils/nutrition';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
import type { ObsidianRecipe } from '../../src/types';

/**
 * Phase 0 — `codex_nutrition` Markdown/frontmatter round-trip and backward
 * compatibility. Proves canonical (semantic) schema round-trip for validated v1
 * data, safe opaque future schemas, inert structural preservation for malformed
 * data, and that existing simple/legacy nutrition and custom frontmatter are
 * unchanged. It does NOT claim byte-for-byte preservation.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`;

function validV1(overrides: Partial<CodexNutritionV1> = {}): CodexNutritionV1 {
  return {
    schema: 1,
    basis: 'total',
    servings: 4,
    serving_size: '1 burger',
    status: 'complete',
    computed_at: '2026-09-14T00:00:00.000Z',
    ingredient_digest: DIGEST,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc'],
    source_releases: { usda_fdc: '2026-04' },
    nutrient_scope: ['calories', 'protein'],
    nutrients: {
      calories: {
        amount: 540,
        unit: 'kcal',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 2,
        measurable_ingredient_count: 2,
      },
      protein: {
        amount: 32,
        unit: 'g',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 2,
        measurable_ingredient_count: 2,
      },
    },
    ingredients: [
      {
        line_ref: '454 g ground beef',
        source: 'usda_fdc',
        source_food_id: '171077',
        source_release: '2026-04',
        match_status: 'confirmed',
        resolved: true,
        user_confirmed: true,
      },
    ],
    unresolved: [],
    ...overrides,
  };
}

function baseRecipe(overrides: Partial<ObsidianRecipe> = {}): Partial<ObsidianRecipe> {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'r1.md',
    title: 'Blue Cheese Smashburgers',
    tags: ['food/recipes'],
    category: 'Main Course',
    cuisine: 'American',
    difficulty: 'Easy',
    rating: 5,
    servings: 4,
    ingredients: [{ original: '454 g ground beef', name: 'ground beef' }],
    instructions: [{ stepNumber: 1, text: 'Cook.' }],
    callouts: [],
    wikilinks: [],
    dataviewFields: {},
    frontmatter: {},
    ...overrides,
  };
}

describe('recognized schema v1 — canonical round-trip', () => {
  it('1. serializes and reparses a validated v1 block with equal semantics (incl. serving_size)', () => {
    const block = validV1();
    const md = serializeRecipeToObsidianMarkdown({
      ...baseRecipe(),
      frontmatter: { codex_nutrition: block },
    });
    const parsed = parseObsidianRecipeMarkdown(md, 'r1.md', 'r1.md');
    expect(parsed.codexNutrition).toMatchObject({ schema: 1, basis: 'total', serving_size: '1 burger' });

    const reparsed = parseObsidianRecipeMarkdown(
      serializeRecipeToObsidianMarkdown(parsed),
      'r1.md',
      'r1.md'
    );
    expect(reparsed.codexNutrition).toEqual(parsed.codexNutrition);
    expect(reparsed.codexNutrition).toMatchObject({ serving_size: '1 burger' });
  });

  it('25. the raw Markdown block is preserved as inert structure through a raw-mode save', () => {
    const md = serializeRecipeToObsidianMarkdown({
      ...baseRecipe(),
      frontmatter: { codex_nutrition: validV1() },
    });
    const parsed = parseObsidianRecipeMarkdown(md, 'r1.md', 'r1.md');
    // Raw-mode path: re-serialize the parsed recipe (as the editor does).
    const rawSaved = serializeRecipeToObsidianMarkdown(parsed);
    const reparsed = parseObsidianRecipeMarkdown(rawSaved, 'r1.md', 'r1.md');
    expect(reparsed.codexNutrition).toEqual(parsed.codexNutrition);
  });

  it('26. a visual-editor partial (frontmatter carried through) preserves the block', () => {
    const md = serializeRecipeToObsidianMarkdown({
      ...baseRecipe(),
      frontmatter: { codex_nutrition: validV1() },
    });
    const parsed = parseObsidianRecipeMarkdown(md, 'r1.md', 'r1.md');
    // Mirrors RecipeEditorModal.generateCurrentMarkdown: a partial recipe whose
    // frontmatter is copied from the initial recipe.
    const edited: Partial<ObsidianRecipe> = {
      ...baseRecipe({ title: 'Edited Title' }),
      frontmatter: { ...(parsed.frontmatter || {}) },
    };
    const reparsed = parseObsidianRecipeMarkdown(
      serializeRecipeToObsidianMarkdown(edited),
      'r1.md',
      'r1.md'
    );
    expect(reparsed.title).toBe('Edited Title');
    expect(reparsed.codexNutrition).toEqual(parsed.codexNutrition);
  });
});

describe('unknown future schema — opaque, never interpreted', () => {
  it('2. safely round-trips an unknown future schema as bounded opaque data', () => {
    const future = { schema: 3, basis: 'total', futureField: { nested: [1, 2, 3] }, note: 'future' };
    const md = serializeRecipeToObsidianMarkdown({
      ...baseRecipe(),
      frontmatter: { codex_nutrition: future },
    });
    const parsed = parseObsidianRecipeMarkdown(md, 'r1.md', 'r1.md');
    expect(parsed.codexNutrition).toMatchObject({ kind: 'opaque', schema: 3 });
    expect((parsed.codexNutrition as { data: Record<string, unknown> }).data.note).toBe('future');

    const reparsed = parseObsidianRecipeMarkdown(
      serializeRecipeToObsidianMarkdown(parsed),
      'r1.md',
      'r1.md'
    );
    expect(reparsed.codexNutrition).toEqual(parsed.codexNutrition);
  });

  it('3. an unknown future schema is never interpreted as v1', () => {
    const future = { schema: 99, anything: true };
    const md = serializeRecipeToObsidianMarkdown({
      ...baseRecipe(),
      frontmatter: { codex_nutrition: future },
    });
    const parsed = parseObsidianRecipeMarkdown(md, 'r1.md', 'r1.md');
    expect(parsed.codexNutrition).toBeDefined();
    expect('nutrients' in (parsed.codexNutrition as object)).toBe(false);
    expect((parsed.codexNutrition as { kind: string }).kind).toBe('opaque');
  });
});

describe('backward compatibility — simple, legacy, and custom frontmatter', () => {
  it('4. existing simple nutrition is unchanged through a round-trip', () => {
    const md = '---\ntitle: Simple\nnutrition:\n  calories: 320\n  protein: 12\n  servings: 4\n---\n\n# Simple\n';
    const parsed = parseObsidianRecipeMarkdown(md, 'Simple.md', 'Simple.md');
    expect(parsed.nutrition).toMatchObject({ calories: 320, protein: 12, servings: 4 });
    const reparsed = parseObsidianRecipeMarkdown(
      serializeRecipeToObsidianMarkdown(parsed),
      'Simple.md',
      'Simple.md'
    );
    expect(reparsed.nutrition).toEqual(parsed.nutrition);
  });

  it('5. legacy per-serving nutrition (no denominator) is unchanged', () => {
    const md = '---\ntitle: Legacy\nnutrition:\n  calories: 1385\n---\n\n# Legacy\n';
    const parsed = parseObsidianRecipeMarkdown(md, 'Legacy.md', 'Legacy.md');
    expect(parsed.nutrition?.calories).toBe(1385);
    expect(parsed.nutrition?.servings).toBeUndefined();
    const base = resolveNutritionBase(parsed.nutrition);
    expect(base).toBe(1);
    expect(nutritionForServings(parsed.nutrition, base, 2).calories).toBe(2770);
  });

  it('6. custom frontmatter is preserved', () => {
    const md = '---\ntitle: Custom\nmy_custom_field: keep-me\nnested:\n  a: 1\n---\n\n# Custom\n';
    const parsed = parseObsidianRecipeMarkdown(md, 'Custom.md', 'Custom.md');
    expect(parsed.frontmatter?.my_custom_field).toBe('keep-me');
    const out = serializeRecipeToObsidianMarkdown(parsed);
    expect(out).toContain('my_custom_field: keep-me');
  });
});

describe('fail-closed malformed data and no auto-creation', () => {
  it('24. a malformed advanced block is inert structurally preserved without corrupting the recipe', () => {
    const malformed =
      '---\ntitle: Broken\nnutrition:\n  calories: 200\ncodex_nutrition:\n  schema: 1\n  basis: per_serving\n  servings: 4\n---\n\n# Broken\n';
    const parsed = parseObsidianRecipeMarkdown(malformed, 'Broken.md', 'Broken.md');
    // Not interpreted as trusted v1 ...
    expect(parsed.codexNutrition).toBeUndefined();
    // ... but structurally preserved in frontmatter (semantic structure, not bytes).
    expect(parsed.frontmatter?.codex_nutrition).toMatchObject({ schema: 1, basis: 'per_serving' });
    // The rest of the recipe is intact.
    expect(parsed.nutrition?.calories).toBe(200);
    expect(parsed.title).toBe('Broken');

    const reparsed = parseObsidianRecipeMarkdown(
      serializeRecipeToObsidianMarkdown(parsed),
      'Broken.md',
      'Broken.md'
    );
    expect(reparsed.frontmatter?.codex_nutrition).toMatchObject({ schema: 1, basis: 'per_serving' });
    expect(reparsed.nutrition?.calories).toBe(200);
    expect(reparsed.title).toBe('Broken');
  });

  it('18. inert structural preservation is not byte-for-byte preservation', () => {
    const malformed =
      '---\ntitle: Commented\ncodex_nutrition:\n  schema: 1\n  basis: "per_serving"   # a user comment\n  servings: 4\n---\n\n# Commented\n';
    const parsed = parseObsidianRecipeMarkdown(malformed, 'Commented.md', 'Commented.md');
    expect(parsed.codexNutrition).toBeUndefined();
    expect(parsed.frontmatter?.codex_nutrition).toMatchObject({ schema: 1, basis: 'per_serving', servings: 4 });

    const out = serializeRecipeToObsidianMarkdown(parsed);
    const reparsed = parseObsidianRecipeMarkdown(out, 'Commented.md', 'Commented.md');
    // The semantic structure survives...
    expect(reparsed.frontmatter?.codex_nutrition).toMatchObject({ schema: 1, basis: 'per_serving', servings: 4 });
    // ...but YAML comments/formatting are NOT byte-preserved.
    expect(out).not.toContain('# a user comment');
  });

  it('19. an unsafe/oversized block never attaches as canonical nutrition', () => {
    const invalidScope =
      '---\ntitle: BadScope\ncodex_nutrition:\n  schema: 1\n  basis: total\n  servings: 4\n  status: complete\n  computed_at: "2026-09-14T00:00:00.000Z"\n  ingredient_digest: "sha256:' +
      'a'.repeat(64) +
      '"\n  dv_standard: fda_adult_4plus_2020\n  sources:\n    - usda_fdc\n  source_releases:\n    usda_fdc: "2026-04"\n  nutrient_scope:\n    - calories\n    - protein\n  nutrients:\n    calories:\n      amount: 10\n      unit: kcal\n      status: complete\n      coverage: 1\n      covered_ingredient_count: 1\n      measurable_ingredient_count: 1\n  ingredients: []\n  unresolved: []\n---\n\n# BadScope\n';
    const parsed = parseObsidianRecipeMarkdown(invalidScope, 'BadScope.md', 'BadScope.md');
    // A scope-complete violation is never interpreted as trusted nutrition.
    expect(parsed.codexNutrition).toBeUndefined();
    expect(parsed.frontmatter?.codex_nutrition).toMatchObject({ schema: 1, status: 'complete' });
    expect(parsed.title).toBe('BadScope');

    const huge = 'x'.repeat(70000);
    const oversized =
      '---\ntitle: Huge\ncodex_nutrition:\n  schema: 3\n  note: "' + huge + '"\n---\n\n# Huge\n';
    const parsedHuge = parseObsidianRecipeMarkdown(oversized, 'Huge.md', 'Huge.md');
    expect(parsedHuge.codexNutrition).toBeUndefined();
    expect(parsedHuge.title).toBe('Huge');
  });

  it('27. no advanced block is ever created automatically', () => {
    const md = '---\ntitle: Plain\nnutrition:\n  calories: 100\n---\n\n# Plain\n';
    const parsed = parseObsidianRecipeMarkdown(md, 'Plain.md', 'Plain.md');
    expect(parsed.codexNutrition).toBeUndefined();
    const out = serializeRecipeToObsidianMarkdown(parsed);
    expect(out).not.toContain('codex_nutrition');
  });
});

describe('Markdown Save fails closed on hostile advanced data (Final Finding 3)', () => {
  it('10. never invokes an accessor and never hands hostile data to YAML', () => {
    let getterCalls = 0;
    const frontmatter: Record<string, any> = { title: 'Hostile' };
    Object.defineProperty(frontmatter, 'codex_nutrition', {
      get() {
        getterCalls += 1;
        return { schema: 1 };
      },
      enumerable: true,
      configurable: true,
    });
    const recipe: Partial<ObsidianRecipe> = {
      frontmatter,
      dataviewFields: {},
      wikilinks: [],
    };
    expect(() => serializeRecipeToObsidianMarkdown(recipe)).toThrow();
    expect(getterCalls).toBe(0);
  });

  it('never passes a throwing proxy to YAML and never leaks its message', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('SECRET_MARKER_' + 'Y'.repeat(60000));
        },
        getPrototypeOf() {
          throw new Error('SECRET_MARKER');
        },
      }
    );
    const recipe: Partial<ObsidianRecipe> = {
      frontmatter: { codex_nutrition: hostile as never },
      dataviewFields: {},
      wikilinks: [],
    };
    let message = '';
    try {
      serializeRecipeToObsidianMarkdown(recipe);
      expect.unreachable();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('SECRET_MARKER');
  });

  it('a safely-representable malformed block still serializes inertly', () => {
    const recipe: Partial<ObsidianRecipe> = {
      frontmatter: { codex_nutrition: { schema: 1, basis: 'per_serving', servings: 4 } },
      dataviewFields: {},
      wikilinks: [],
    };
    const out = serializeRecipeToObsidianMarkdown(recipe);
    expect(out).toContain('codex_nutrition');
    expect(out).toContain('per_serving');
  });
});
