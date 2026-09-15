/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: hostile-adaptation boundary.
 *
 * Proves the exported `adaptRecipe` boundary materializes its untrusted input
 * once into inert data BEFORE any property use, fails closed with fixed bounded
 * input-redacted diagnostics, and never invokes a hostile accessor or proxy trap.
 */

import { describe, it, expect } from 'vitest';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { readStoredBlock } from '../../src/core/nutritionV2/phase4/stored';

function failureCode(result: ReturnType<typeof adaptRecipe>): string {
  return (result as { ok: false; failure: { code: string; message: string } }).failure.code;
}

function failureMessage(result: ReturnType<typeof adaptRecipe>): string {
  return (result as { ok: false; failure: { code: string; message: string } }).failure.message;
}

describe('phase 4 adapt — ordinary recipes', () => {
  it('adapts a valid recipe deterministically and preserves the original fields', () => {
    const recipe = {
      id: 'r1',
      filePath: 'Recipes/r1.md',
      title: 'Test',
      servings: 4,
      ingredients: [
        { original: '100 g Flour, wheat, white', amount: 100, unit: 'g', name: 'Flour, wheat, white' },
        { original: 'Butter', name: 'Butter', note: 'softened' },
      ],
    };
    const first = adaptRecipe(recipe);
    const second = adaptRecipe(recipe);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.recipe.recipe_key.startsWith('Recipes/r1.md#')).toBe(true);
    expect(first.recipe.base_servings).toBe(4);
    expect(first.recipe.title).toBe('Test');
    expect(first.recipe.adapted.map((entry) => entry.line_ref)).toEqual([
      'ing:0:' + first.recipe.adapted[0].line_ref.split(':')[2],
      'ing:1:' + first.recipe.adapted[1].line_ref.split(':')[2],
    ]);
    expect(first.recipe.adapted[0].ingredient).toMatchObject({
      original: '100 g Flour, wheat, white',
      amount: 100,
      unit: 'g',
      name: 'Flour, wheat, white',
    });
    expect(first.recipe.adapted[1].ingredient).toMatchObject({
      original: 'Butter',
      name: 'Butter',
      note: 'softened',
    });
    if (second.ok) {
      expect(second.recipe.recipe_key).toBe(first.recipe.recipe_key);
      expect(second.recipe.adapted).toEqual(first.recipe.adapted);
    }
  });

  it('accepts a null-prototype recipe and ingredient (existing plain-safe contract)', () => {
    const ingredient = Object.create(null) as Record<string, unknown>;
    ingredient.original = 'Butter';
    const recipe = Object.create(null) as Record<string, unknown>;
    recipe.ingredients = [ingredient];
    const result = adaptRecipe(recipe);
    expect(result.ok).toBe(true);
  });

  it('preserves absent optional fields and explicit null according to the contract', () => {
    const result = adaptRecipe({ ingredients: [{ original: 'Butter', amount: null }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ingredient = result.recipe.adapted[0].ingredient as Record<string, unknown>;
    expect('unit' in ingredient).toBe(false);
    expect('name' in ingredient).toBe(false);
    expect('note' in ingredient).toBe(false);
    expect(ingredient.amount).toBeNull();
  });

  it('keeps missing distinct from explicit zero and preserves -0 versus 0', () => {
    const missing = adaptRecipe({ ingredients: [{ original: 'A' }] });
    const zero = adaptRecipe({ ingredients: [{ original: 'A', amount: 0 }] });
    const negativeZero = adaptRecipe({ ingredients: [{ original: 'A', amount: -0 }] });
    expect(missing.ok && zero.ok && negativeZero.ok).toBe(true);
    if (!missing.ok || !zero.ok || !negativeZero.ok) return;
    expect('amount' in missing.recipe.adapted[0].ingredient).toBe(false);
    expect(Object.is(zero.recipe.adapted[0].ingredient.amount, 0)).toBe(true);
    expect(Object.is(negativeZero.recipe.adapted[0].ingredient.amount, -0)).toBe(true);
  });

  it('freezes the adapted result and does not observe later source mutation', () => {
    const ingredient: Record<string, unknown> = { original: 'Butter' };
    const recipe = { ingredients: [ingredient] };
    const result = adaptRecipe(recipe);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.recipe.adapted)).toBe(true);
    expect(Object.isFrozen(result.recipe.adapted[0])).toBe(true);
    expect(Object.isFrozen(result.recipe.adapted[0].ingredient)).toBe(true);
    ingredient.original = 'MUTATED';
    expect(result.recipe.adapted[0].ingredient.original).toBe('Butter');
  });
});

describe('phase 4 adapt — getter non-execution', () => {
  it('does not invoke a throwing recipe-level ingredients getter', () => {
    let calls = 0;
    const recipe: Record<string, unknown> = {};
    Object.defineProperty(recipe, 'ingredients', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        throw new Error('getter');
      },
    });
    const result = adaptRecipe(recipe);
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
    expect(failureMessage(result)).toBe('phase4_unsafe_request');
  });

  it('does not invoke throwing ingredient getters for original/name/amount/unit/note', () => {
    for (const field of ['original', 'name', 'amount', 'unit', 'note']) {
      let calls = 0;
      const ingredient: Record<string, unknown> = { original: 'placeholder' };
      Object.defineProperty(ingredient, field, {
        enumerable: true,
        configurable: true,
        get() {
          calls += 1;
          throw new Error('getter');
        },
      });
      const result = adaptRecipe({ ingredients: [ingredient] });
      expect(result.ok, field).toBe(false);
      expect(calls, field).toBe(0);
    }
  });

  it('rejects a getter that returns a plausible value without invoking it', () => {
    let calls = 0;
    const ingredient: Record<string, unknown> = {};
    Object.defineProperty(ingredient, 'original', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return 'Butter';
      },
    });
    const result = adaptRecipe({ ingredients: [ingredient] });
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('rejects a setter-only property without invoking it', () => {
    let calls = 0;
    const ingredient: Record<string, unknown> = { original: 'Butter' };
    Object.defineProperty(ingredient, 'unit', {
      enumerable: true,
      configurable: true,
      set() {
        calls += 1;
      },
    });
    const result = adaptRecipe({ ingredients: [ingredient] });
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('rejects a non-enumerable accessor without invoking it', () => {
    let calls = 0;
    const ingredient: Record<string, unknown> = {};
    Object.defineProperty(ingredient, 'original', {
      enumerable: false,
      configurable: true,
      get() {
        calls += 1;
        return 'Butter';
      },
    });
    const result = adaptRecipe({ ingredients: [ingredient] });
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('does not invoke a getter on an unknown ingredient field', () => {
    let calls = 0;
    const ingredient: Record<string, unknown> = { original: 'Butter' };
    Object.defineProperty(ingredient, 'bogus', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return 'x';
      },
    });
    const result = adaptRecipe({ ingredients: [ingredient] });
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('phase 4 adapt — proxy non-execution and containment', () => {
  it('does not call a proxy ingredient get trap and never leaks a trap message', () => {
    let getCalls = 0;
    const proxy = new Proxy(
      { original: 'Butter' },
      {
        get() {
          getCalls += 1;
          throw new Error('trap-get');
        },
      }
    );
    const result = adaptRecipe({ ingredients: [proxy] });
    // The descriptor-based materializer never reads through `get`.
    expect(getCalls).toBe(0);
    expect(result.ok).toBe(true);
  });

  it('contains a throwing getOwnPropertyDescriptor trap without leaking its message', () => {
    const proxy = new Proxy(
      { original: 'Butter' },
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap-gopd');
        },
      }
    );
    const result = adaptRecipe({ ingredients: [proxy] });
    expect(result.ok).toBe(false);
    expect(failureMessage(result)).toBe('phase4_unsafe_request');
    expect(failureMessage(result)).not.toMatch(/trap-gopd/);
  });

  it('contains a throwing ownKeys trap without leaking its message', () => {
    const proxy = new Proxy(
      { original: 'Butter' },
      {
        ownKeys() {
          throw new Error('trap-ownKeys');
        },
      }
    );
    const result = adaptRecipe({ ingredients: [proxy] });
    expect(result.ok).toBe(false);
    expect(failureMessage(result)).not.toMatch(/trap-ownKeys/);
  });

  it('contains a throwing getPrototypeOf trap on the recipe', () => {
    const proxy = new Proxy(
      { ingredients: [{ original: 'Butter' }] },
      {
        getPrototypeOf() {
          throw new Error('trap-proto');
        },
      }
    );
    const result = adaptRecipe(proxy);
    expect(result.ok).toBe(false);
    expect(failureMessage(result)).not.toMatch(/trap-proto/);
  });

  it('rejects a proxy ingredient array', () => {
    const proxy = new Proxy([{ original: 'Butter' }], {
      getOwnPropertyDescriptor() {
        throw new Error('trap-array');
      },
    });
    const result = adaptRecipe({ ingredients: proxy });
    expect(result.ok).toBe(false);
    expect(failureMessage(result)).not.toMatch(/trap-array/);
  });
});

describe('phase 4 adapt — structural rejection matrix', () => {
  it('rejects symbol-keyed recipe and ingredient fields', () => {
    const recipe: Record<string | symbol, unknown> = { ingredients: [{ original: 'Butter' }] };
    recipe[Symbol('s')] = 1;
    expect(adaptRecipe(recipe).ok).toBe(false);

    const ingredient: Record<string | symbol, unknown> = { original: 'Butter' };
    ingredient[Symbol('s')] = 1;
    expect(adaptRecipe({ ingredients: [ingredient] }).ok).toBe(false);
  });

  it('rejects a sparse ingredient array and a sparse nested array', () => {
    const sparse: unknown[] = [{ original: 'A' }];
    sparse[2] = { original: 'B' };
    expect(adaptRecipe({ ingredients: sparse }).ok).toBe(false);

    const nested: unknown[] = [];
    nested[2] = 1;
    expect(adaptRecipe({ ingredients: [{ original: 'A', isChecked: nested }] }).ok).toBe(false);
  });

  it('rejects direct and indirect cycles', () => {
    const direct: Record<string, unknown> = { original: 'A' };
    direct.note = direct;
    expect(adaptRecipe({ ingredients: [direct] }).ok).toBe(false);

    const a: Record<string, unknown> = { original: 'A' };
    const b: Record<string, unknown> = { note: a };
    a.wikilink = b;
    expect(adaptRecipe({ ingredients: [a] }).ok).toBe(false);
  });

  it('rejects class-instance recipes and ingredients', () => {
    class RecipeClass {
      ingredients = [{ original: 'Butter' }];
    }
    expect(adaptRecipe(new RecipeClass()).ok).toBe(false);

    class IngredientClass {
      original = 'Butter';
    }
    expect(adaptRecipe({ ingredients: [new IngredientClass()] }).ok).toBe(false);
  });

  it('rejects own undefined for every consumed optional field', () => {
    for (const field of ['original', 'name', 'amount', 'unit', 'note']) {
      const ingredient: Record<string, unknown> = { original: 'Butter', [field]: undefined };
      if (field === 'original') ingredient.original = undefined;
      const result = adaptRecipe({ ingredients: [ingredient] });
      expect(result.ok, field).toBe(false);
      expect(failureCode(result), field).toBe('unsafe_request');
    }
  });

  it('rejects present undefined on envelope fields', () => {
    for (const field of ['title', 'filePath', 'id', 'fileName', 'servings']) {
      const recipe: Record<string, unknown> = { ingredients: [{ original: 'Butter' }], [field]: undefined };
      const result = adaptRecipe(recipe);
      expect(result.ok, field).toBe(false);
    }
  });

  it('rejects function and bigint values', () => {
    expect(adaptRecipe({ ingredients: [{ original: 'A', unit: () => 'g' }] }).ok).toBe(false);
    expect(adaptRecipe({ ingredients: [{ original: 'A', amount: 1n }] }).ok).toBe(false);
  });

  it('rejects dangerous keys on the envelope and on ingredients', () => {
    for (const key of ['__proto__', 'prototype', 'constructor']) {
      const recipe = { ingredients: [{ original: 'Butter' }] } as Record<string, unknown>;
      Object.defineProperty(recipe, key, { value: {}, enumerable: true, configurable: true });
      expect(adaptRecipe(recipe).ok, `recipe ${key}`).toBe(false);

      const ingredient = { original: 'Butter' } as Record<string, unknown>;
      Object.defineProperty(ingredient, key, { value: {}, enumerable: true, configurable: true });
      expect(adaptRecipe({ ingredients: [ingredient] }).ok, `ingredient ${key}`).toBe(false);
    }
  });

  it('rejects unknown ingredient fields', () => {
    const result = adaptRecipe({ ingredients: [{ original: 'Butter', bogus: 1 }] });
    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe('unknown_field');
  });

  it('rejects oversized original/name/note strings', () => {
    const big = 'x'.repeat(5000);
    expect(adaptRecipe({ ingredients: [{ original: big }] }).ok).toBe(false);
    expect(adaptRecipe({ ingredients: [{ original: 'A', name: big }] }).ok).toBe(false);
    expect(adaptRecipe({ ingredients: [{ original: 'A', note: big }] }).ok).toBe(false);
  });

  it('rejects an excessive ingredient count', () => {
    const ingredients = Array.from({ length: 201 }, (_, index) => ({ original: `Item ${index}` }));
    expect(adaptRecipe({ ingredients }).ok).toBe(false);
  });

  it('rejects primitive recipes and primitive ingredient entries', () => {
    for (const value of [null, undefined, 42, 'recipe', true]) {
      const result = adaptRecipe(value);
      expect(result.ok, String(value)).toBe(false);
      expect(failureCode(result)).toBe('invalid_recipe');
    }
    for (const value of [null, 42, 'flour', true]) {
      expect(adaptRecipe({ ingredients: [value] }).ok, String(value)).toBe(false);
    }
  });

  it('fails closed for missing and non-array ingredients (never an empty success)', () => {
    expect(adaptRecipe({}).ok).toBe(false);
    expect(adaptRecipe({ ingredients: 'flour' }).ok).toBe(false);
    expect(adaptRecipe({ ingredients: [] }).ok).toBe(false);
  });

  it('never converts a rejection into an empty successful adaptation', () => {
    const hostile = {
      get ingredients() {
        throw new Error('getter');
      },
    };
    const result = adaptRecipe(hostile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect('recipe' in result).toBe(false);
  });
});

describe('phase 4 stored block — hostile input containment', () => {
  it('does not invoke a throwing codexNutrition getter', () => {
    let calls = 0;
    const recipe: Record<string, unknown> = {};
    Object.defineProperty(recipe, 'codexNutrition', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        throw new Error('getter');
      },
    });
    const summary = readStoredBlock(recipe);
    expect(summary.kind).toBe('opaque');
    expect(calls).toBe(0);
  });

  it('materializes a hostile block value before reading it', () => {
    const summary = readStoredBlock({
      codexNutrition: {
        schema: 1,
        basis: 'total',
        nutrients: {
          calories: {
            get amount() {
              throw new Error('getter');
            },
          },
        },
      },
    });
    expect(summary.kind).toBe('opaque');
  });
});
