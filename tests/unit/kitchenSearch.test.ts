import { describe, it, expect } from 'vitest';
import {
  buildRecipeRelationshipIndex,
  recipeIdentity,
} from '../../src/utils/recipeRelationships';
import {
  searchKitchenRecipes,
  resolvePrepMinutes,
  resolveCookMinutes,
  resolveTotalMinutes,
  SCORE_WEIGHTS,
  type SearchableRecipe,
  type KitchenQuery,
  type KitchenSearchResult,
} from '../../src/utils/kitchenSearch';

const ing = (original: string) => ({ original });

/**
 * Minimal recipe factory. Always sets a stable `id` so recipe identity never
 * collides (id ?? filePath ?? fileName). All metadata is optional so individual
 * tests can focus on the dimension under test.
 */
function r(overrides: Partial<SearchableRecipe> & { id: string }): SearchableRecipe {
  return {
    title: overrides.id,
    tags: [],
    category: '',
    cuisine: '',
    difficulty: '',
    rating: 0,
    isFavorite: false,
    ingredients: [],
    ...overrides,
  };
}

describe('kitchenSearch: ingredient include (exact identity)', () => {
  it('matches when the requested identity is present', () => {
    const result = searchKitchenRecipes(
      [r({ id: 'rice-bowl', ingredients: [ing('2 cups rice')] })],
      { includeIngredients: ['rice'] }
    );
    expect(result.map((x) => x.recipeIdentity)).toEqual(['rice-bowl']);
    expect(result[0].matchedIngredients).toEqual(['rice']);
  });

  it('does not match a different exact identity (no substring matching)', () => {
    const result = searchKitchenRecipes(
      [r({ id: 'b', ingredients: [ing('1 tbsp rice vinegar')] })],
      { includeIngredients: ['rice'] }
    );
    expect(result).toEqual([]);
  });

  it('requiring multiple ingredients requires ALL (never OR)', () => {
    const recipes = [
      r({ id: 'eggs-only', ingredients: [ing('2 eggs')] }),
      r({ id: 'eggs-flour', ingredients: [ing('2 eggs'), ing('1 cup flour')] }),
    ];
    const result = searchKitchenRecipes(recipes, { includeIngredients: ['eggs', 'flour'] });
    expect(result.map((x) => x.recipeIdentity)).toEqual(['eggs-flour']);
  });

  it('exclude ingredients remove matches', () => {
    const recipes = [
      r({ id: 'chicken-rice', ingredients: [ing('chicken'), ing('rice')] }),
      r({ id: 'rice-only', ingredients: [ing('rice')] }),
    ];
    const result = searchKitchenRecipes(recipes, {
      includeIngredients: ['rice'],
      excludeIngredients: ['chicken'],
    });
    expect(result.map((x) => x.recipeIdentity)).toEqual(['rice-only']);
  });
});

describe('kitchenSearch: false positives stay distinct', () => {
  it('black beans never match kidney beans', () => {
    const recipes = [
      r({ id: 'black', ingredients: [ing('1 can black beans')] }),
      r({ id: 'kidney', ingredients: [ing('1 can kidney beans')] }),
    ];
    expect(
      searchKitchenRecipes(recipes, { includeIngredients: ['black beans'] }).map(
        (x) => x.recipeIdentity
      )
    ).toEqual(['black']);
    expect(
      searchKitchenRecipes(recipes, { includeIngredients: ['kidney beans'] }).map(
        (x) => x.recipeIdentity
      )
    ).toEqual(['kidney']);
  });

  it('cream never matches cream cheese', () => {
    const recipes = [
      r({ id: 'cream', ingredients: [ing('1/2 cup cream')] }),
      r({ id: 'cream-cheese', ingredients: [ing('4 oz cream cheese')] }),
    ];
    expect(
      searchKitchenRecipes(recipes, { includeIngredients: ['cream'] }).map(
        (x) => x.recipeIdentity
      )
    ).toEqual(['cream']);
  });

  it('rice never matches rice vinegar', () => {
    const recipes = [
      r({ id: 'rice', ingredients: [ing('2 cups rice')] }),
      r({ id: 'rice-vinegar', ingredients: [ing('2 tbsp rice vinegar')] }),
    ];
    expect(
      searchKitchenRecipes(recipes, { includeIngredients: ['rice'] }).map(
        (x) => x.recipeIdentity
      )
    ).toEqual(['rice']);
  });
});

describe('kitchenSearch: wikilink target semantics preserved', () => {
  it('reduces to the wikilink TARGET for identity', () => {
    const recipes = [
      r({ id: 'chicken-breast', ingredients: [ing('[[Chicken Breast|chicken]]')] }),
      r({ id: 'chicken-thigh', ingredients: [ing('[[Chicken Thigh|chicken]]')] }),
    ];
    expect(
      searchKitchenRecipes(recipes, { includeIngredients: ['chicken breast'] }).map(
        (x) => x.recipeIdentity
      )
    ).toEqual(['chicken-breast']);
    // The shared alias "chicken" never collides distinct explicit targets.
    expect(
      searchKitchenRecipes(recipes, { includeIngredients: ['chicken'] }).map(
        (x) => x.recipeIdentity
      )
    ).toEqual([]);
  });
});

describe('kitchenSearch: field filters', () => {
  const recipes = [
    r({ id: 'a', tags: ['dessert'], category: 'Dessert', cuisine: 'Italian', difficulty: 'Easy', rating: 5, isFavorite: true }),
    r({ id: 'b', tags: ['dinner'], category: 'Dinner', cuisine: 'Mexican', difficulty: 'Hard', rating: 3, isFavorite: false }),
    r({ id: 'c', tags: ['dinner', 'pasta'], category: 'Dinner', cuisine: 'Italian', difficulty: 'Medium', rating: 4, isFavorite: false }),
  ];

  it('tag filter (all provided tags required)', () => {
    expect(searchKitchenRecipes(recipes, { tags: ['dinner'] }).map((x) => x.recipeIdentity)).toEqual(['c', 'b']);
    expect(searchKitchenRecipes(recipes, { tags: ['dinner', 'pasta'] }).map((x) => x.recipeIdentity)).toEqual(['c']);
  });

  it('cuisine filter (single-valued any-of)', () => {
    expect(searchKitchenRecipes(recipes, { cuisines: ['italian'] }).map((x) => x.recipeIdentity)).toEqual(['a', 'c']);
  });

  it('course filter (category any-of)', () => {
    expect(searchKitchenRecipes(recipes, { courses: ['Dessert'] }).map((x) => x.recipeIdentity)).toEqual(['a']);
    expect(searchKitchenRecipes(recipes, { courses: ['dessert'] }).map((x) => x.recipeIdentity)).toEqual(['a']);
  });

  it('difficulty filter', () => {
    expect(searchKitchenRecipes(recipes, { difficulties: ['Easy'] }).map((x) => x.recipeIdentity)).toEqual(['a']);
  });

  it('minimum rating', () => {
    expect(searchKitchenRecipes(recipes, { minRating: 4 }).map((x) => x.recipeIdentity)).toEqual(['a', 'c']);
  });

  it('favorites only', () => {
    expect(searchKitchenRecipes(recipes, { favoritesOnly: true }).map((x) => x.recipeIdentity)).toEqual(['a']);
  });
});

describe('kitchenSearch: time handling', () => {
  it('total resolves to explicit total when present', () => {
    expect(resolveTotalMinutes(r({ id: 't', totalTime: '1 hr 30 mins', prepTime: '15 mins', cookTime: '45 mins' }))).toBe(90);
  });

  it('total = prep + cook only when both are valid', () => {
    expect(resolveTotalMinutes(r({ id: 't', prepTime: '15 mins', cookTime: '45 mins' }))).toBe(60);
  });

  it('total is unknown when any component is missing', () => {
    expect(resolveTotalMinutes(r({ id: 't', prepTime: '15 mins' }))).toBeNull();
    expect(resolveTotalMinutes(r({ id: 't', cookTime: '45 mins' }))).toBeNull();
    expect(resolveTotalMinutes(r({ id: 't' }))).toBeNull();
  });

  it('prep / cook / total max filters accept recipes within the bound', () => {
    const recipes = [
      r({ id: 'baseline', prepTime: '10 mins', cookTime: '20 mins', totalTime: '30 mins' }),
      r({ id: 'slow-prep', prepTime: '45 mins', cookTime: '20 mins', totalTime: '65 mins' }),
      r({ id: 'slow-cook', prepTime: '10 mins', cookTime: '45 mins', totalTime: '55 mins' }),
      r({ id: 'slow-total', prepTime: '10 mins', cookTime: '20 mins', totalTime: '75 mins' }),
    ];
    const prepIds = searchKitchenRecipes(recipes, { maxPrepMinutes: 15 }).map((x) => x.recipeIdentity);
    expect(prepIds).toContain('baseline');
    expect(prepIds).not.toContain('slow-prep');

    const cookIds = searchKitchenRecipes(recipes, { maxCookMinutes: 25 }).map((x) => x.recipeIdentity);
    expect(cookIds).toContain('baseline');
    expect(cookIds).not.toContain('slow-cook');

    const totalIds = searchKitchenRecipes(recipes, { maxTotalMinutes: 45 }).map((x) => x.recipeIdentity);
    expect(totalIds).toContain('baseline');
    expect(totalIds).not.toContain('slow-total');

    // All three reject a recipe with no timing data at all.
    const unknown = searchKitchenRecipes([r({ id: 'unknown' })], { maxTotalMinutes: 45 });
    expect(unknown).toEqual([]);
  });

  it('unknown times never incorrectly qualify', () => {
    const recipes = [
      r({ id: 'no-time' }),
      r({ id: 'prep-only', prepTime: '10 mins' }),
      r({ id: 'cook-only', cookTime: '10 mins' }),
      r({ id: 'timed', totalTime: '20 mins' }),
    ];
    // Unknown total -> must NOT qualify a maxTotalMinutes query.
    const res = searchKitchenRecipes(recipes, { maxTotalMinutes: 30 });
    expect(res.map((x) => x.recipeIdentity)).toEqual(['timed']);
    // Unknown prep -> must NOT qualify a maxPrepMinutes query.
    const prep = searchKitchenRecipes(recipes, { maxPrepMinutes: 15 });
    expect(prep.map((x) => x.recipeIdentity)).toEqual(['prep-only']);
    // Unknown cook -> must NOT qualify a maxCookMinutes query.
    const cook = searchKitchenRecipes(recipes, { maxCookMinutes: 15 });
    expect(cook.map((x) => x.recipeIdentity)).toEqual(['cook-only']);
  });
});

describe('kitchenSearch: similarity integration', () => {
  const recipes = [
    r({ id: 'focaccia', title: 'Focaccia', ingredients: [ing('flour'), ing('olive oil'), ing('salt')] }),
    r({ id: 'bread', title: 'Bread', ingredients: [ing('flour'), ing('yeast'), ing('salt')] }),
    r({ id: 'pizza', title: 'Pizza', ingredients: [ing('flour'), ing('yeast'), ing('cheese')] }),
    r({ id: 'soup', title: 'Soup', ingredients: [ing('stock'), ing('onion'), ing('carrot')] }),
  ];

  it('reuses the Jaccard relationship engine and excludes the target', () => {
    const result = searchKitchenRecipes(recipes, { similarToRecipeId: 'focaccia' });
    const ids = result.map((x) => x.recipeIdentity);
    expect(ids).not.toContain('focaccia');
    expect(ids).toContain('bread');
    expect(ids).toContain('pizza');
    // soup shares no ingredient with focaccia, so it is excluded.
    expect(ids).not.toContain('soup');
  });

  it('produces a deterministic ordering across repeated calls', () => {
    const a = searchKitchenRecipes(recipes, { similarToRecipeId: 'focaccia' }).map((x) => x.recipeIdentity);
    const b = searchKitchenRecipes(recipes, { similarToRecipeId: 'focaccia' }).map((x) => x.recipeIdentity);
    expect(a).toEqual(b);
  });

  it('orders deterministically by similarity descending then identity ascending', () => {
    const result = searchKitchenRecipes(recipes, { similarToRecipeId: 'focaccia' });
    // bread: |shared|=2 (flour,salt) |union|=4 => 0.5
    // pizza: |shared|=1 (flour)     |union|=5 => 0.2
    const bread = result.find((x) => x.recipeIdentity === 'bread')!;
    const pizza = result.find((x) => x.recipeIdentity === 'pizza')!;
    expect(bread.similarity!.score).toBeGreaterThan(pizza.similarity!.score);
    expect(result[0].recipeIdentity).toBe('bread');
  });
});

describe('kitchenSearch: missing data (zero fabrication)', () => {
  const recipes = [
    r({ id: 'minimal' }),
    r({ id: 'rated', category: '', cuisine: '', difficulty: '', rating: 2 }),
  ];

  it('no cuisine is never treated as a match for a cuisine requirement', () => {
    expect(searchKitchenRecipes(recipes, { cuisines: ['italian'] })).toEqual([]);
  });

  it('no course is never treated as a match for a course requirement', () => {
    expect(searchKitchenRecipes(recipes, { courses: ['Dessert'] })).toEqual([]);
  });

  it('no difficulty is never treated as a match for a difficulty requirement', () => {
    expect(searchKitchenRecipes(recipes, { difficulties: ['Easy'] })).toEqual([]);
  });

  it('no rating never clears a minRating bar', () => {
    expect(searchKitchenRecipes(recipes, { minRating: 4 })).toEqual([]);
  });
});

describe('kitchenSearch: immutability', () => {
  it('never mutates frozen recipe objects', () => {
    const recipeA = r({
      id: 'a',
      ingredients: [Object.freeze(ing('2 eggs')), Object.freeze(ing('1 cup flour'))],
    });
    const recipeB = r({
      id: 'b',
      ingredients: [Object.freeze(ing('2 eggs')), Object.freeze(ing('1 tbsp sugar'))],
    });
    Object.freeze(recipeA);
    Object.freeze(recipeB);
    const recipes = Object.freeze([recipeA, recipeB]) as unknown as SearchableRecipe[];

    const snapshot = JSON.stringify([recipeA, recipeB]);
    // Would throw in strict TS mode if any recipe (or nested ingredient) were mutated.
    searchKitchenRecipes(recipes, { includeIngredients: ['eggs', 'flour'] });
    expect(JSON.stringify([recipeA, recipeB])).toBe(snapshot);
    expect(recipeA.ingredients.length).toBe(2);
  });

  it('never mutates a frozen query object', () => {
    const recipes = [r({ id: 'a', ingredients: [ing('eggs')] })];
    const query: KitchenQuery = Object.freeze({
      includeIngredients: Object.freeze(['eggs']) as unknown as string[],
    });
    // Would throw if the engine tried to push/mutate the query arrays.
    const result = searchKitchenRecipes(recipes, query);
    expect(result.map((x) => x.recipeIdentity)).toEqual(['a']);
  });
});

describe('kitchenSearch: determinism & scoring', () => {
  it('same input yields the same result order', () => {
    const recipes = [
      r({ id: 'b', ingredients: [ing('eggs')], rating: 3 }),
      r({ id: 'a', ingredients: [ing('eggs')], rating: 5 }),
    ];
    const first = searchKitchenRecipes(recipes, { includeIngredients: ['eggs'] }).map((x) => x.recipeIdentity);
    const second = searchKitchenRecipes(recipes, { includeIngredients: ['eggs'] }).map((x) => x.recipeIdentity);
    expect(first).toEqual(second);
    // Higher rating is a secondary/tie-break signal, so a outranks b.
    expect(first).toEqual(['a', 'b']);
  });

  it('hard filter failures never rank, even with a high rating', () => {
    const recipes = [
      r({ id: 'high-rated-no-corn', ingredients: [ing('eggs')], rating: 5 }),
      r({ id: 'corn', ingredients: [ing('corn')], rating: 1 }),
    ];
    const result = searchKitchenRecipes(recipes, { includeIngredients: ['corn'] });
    expect(result.map((x) => x.recipeIdentity)).toEqual(['corn']);
  });

  it('score follows the documented deterministic weighted formula', () => {
    const recipes = [
      r({ id: 'target', ingredients: [ing('eggs'), ing('flour')], tags: ['dinner'], category: 'Dinner', rating: 4 }),
    ];
    const result = searchKitchenRecipes(recipes, {
      includeIngredients: ['eggs', 'flour'],
      tags: ['dinner'],
      courses: ['Dinner'],
    }) as KitchenSearchResult[];
    const hit = result[0];
    const expected =
      hit.matchedIngredients.length * SCORE_WEIGHTS.ingredient +
      hit.matchedFields.length * SCORE_WEIGHTS.field +
      (4 / 5) * SCORE_WEIGHTS.rating;
    expect(hit.score).toBeCloseTo(expected, 10);
    expect(hit.matchedIngredients).toEqual(['eggs', 'flour']);
    expect(hit.reasons).toContain('contains "eggs"');
    expect(hit.reasons).toContain('contains "flour"');
    expect(hit.reasons).toContain('tag: dinner');
    expect(hit.reasons).toContain('course: Dinner');
  });

  it('ingredient inclusion is a hard gate: field matches alone cannot substitute', () => {
    // includeIngredients is hard ALL semantics, so a recipe that lacks the required
    // ingredient is ineligible even if it matches many fields. The ingredient
    // score term is therefore a constant across eligible results (bookkeeping),
    // not within-eligible ranking strength.
    const recipes = [
      r({ id: 'by-ingredient', ingredients: [ing('eggs')] }),
      r({ id: 'by-fields', ingredients: [], tags: ['dinner', 'pasta'], category: 'Dinner' }),
    ];
    const result = searchKitchenRecipes(recipes, { includeIngredients: ['eggs'] });
    expect(result.map((x) => x.recipeIdentity)).toEqual(['by-ingredient']);
  });

  it('limit caps results', () => {
    const recipes = [
      r({ id: 'a', ingredients: [ing('eggs')], rating: 1 }),
      r({ id: 'b', ingredients: [ing('eggs')], rating: 5 }),
    ];
    expect(searchKitchenRecipes(recipes, { includeIngredients: ['eggs'], limit: 1 }).length).toBe(1);
    expect(searchKitchenRecipes(recipes, { includeIngredients: ['eggs'], limit: 1 })[0].recipeIdentity).toBe('b');
  });
});

describe('kitchenSearch: audit hardening — missing rating', () => {
  it('a literal missing rating never clears a minRating of 1', () => {
    const recipes = [
      r({ id: 'explicit-zero', rating: 0 }),
      r({ id: 'missing-rating', rating: undefined as unknown as number }),
      r({ id: 'rated-one', rating: 1 }),
    ];
    expect(searchKitchenRecipes(recipes, { minRating: 1 }).map((x) => x.recipeIdentity)).toEqual(['rated-one']);
  });
});

describe('kitchenSearch: audit hardening — limit semantics', () => {
  const recipes = [
    r({ id: 'a', ingredients: [ing('eggs')], rating: 1 }),
    r({ id: 'b', ingredients: [ing('eggs')], rating: 5 }),
    r({ id: 'c', ingredients: [ing('eggs')], rating: 3 }),
  ];

  it('limit 0 returns an empty list', () => {
    expect(searchKitchenRecipes(recipes, { includeIngredients: ['eggs'], limit: 0 })).toEqual([]);
  });

  it('limit -1 is interpreted as no limit (returns all)', () => {
    expect(searchKitchenRecipes(recipes, { includeIngredients: ['eggs'], limit: -1 }).length).toBe(3);
  });

  it('limit NaN is interpreted as no limit (returns all, never throws)', () => {
    expect(searchKitchenRecipes(recipes, { includeIngredients: ['eggs'], limit: Number.NaN }).length).toBe(3);
  });

  it('limit undefined / null is interpreted as no limit', () => {
    expect(searchKitchenRecipes(recipes, { includeIngredients: ['eggs'], limit: undefined }).length).toBe(3);
    expect(searchKitchenRecipes(recipes, { includeIngredients: ['eggs'], limit: null }).length).toBe(3);
  });
});

describe('kitchenSearch: audit hardening — unknown similarToRecipeId', () => {
  it('returns a safe, deterministic empty result for an unknown target', () => {
    const recipes = [
      r({ id: 'a', ingredients: [ing('flour')] }),
      r({ id: 'b', ingredients: [ing('flour'), ing('salt')] }),
    ];
    const first = searchKitchenRecipes(recipes, { similarToRecipeId: 'does-not-exist' });
    const second = searchKitchenRecipes(recipes, { similarToRecipeId: 'does-not-exist' });
    expect(first).toEqual([]);
    expect(second).toEqual(first);
    expect(first.map((x) => x.recipeIdentity)).toEqual([]);
  });
});

describe('kitchenSearch: audit hardening — text inertness', () => {
  it('text has zero effect on eligibility, ordering, and reasons', () => {
    const recipes = [
      r({ id: 'a', ingredients: [ing('chicken'), ing('rice')] }),
      r({ id: 'b', ingredients: [ing('tofu')] }),
    ];
    const withText = searchKitchenRecipes(recipes, { text: 'What uses chicken?' });
    const withoutText = searchKitchenRecipes(recipes, {});
    // text is NOT a free-text filter: a recipe without "chicken" is still eligible,
    // and it has no effect on ordering or per-recipe reasons.
    expect(withText.map((x) => x.recipeIdentity)).toEqual(['a', 'b']);
    expect(withText).toEqual(withoutText);
    expect(withText).toEqual(searchKitchenRecipes(recipes, { text: 'completely unrelated' }));
    expect(withText.map((x) => x.reasons)).toEqual(withoutText.map((x) => x.reasons));
  });
});

describe('kitchenSearch: audit hardening — supplied options.index contract', () => {
  it('reuses a prebuilt index from the SAME recipes array and matches the default path', () => {
    const recipes = [
      r({ id: 'focaccia', ingredients: [ing('flour'), ing('olive oil'), ing('salt')] }),
      r({ id: 'bread', ingredients: [ing('flour'), ing('yeast'), ing('salt')] }),
      r({ id: 'soup', ingredients: [ing('stock'), ing('onion'), ing('carrot')] }),
    ];
    // Contract: options.index must be built from the SAME recipes array.
    const prebuilt = buildRecipeRelationshipIndex(recipes);

    const withIndex = searchKitchenRecipes(recipes, { similarToRecipeId: 'focaccia' }, { index: prebuilt });
    const withoutIndex = searchKitchenRecipes(recipes, { similarToRecipeId: 'focaccia' });

    expect(withIndex.map((x) => x.recipeIdentity)).toEqual(withoutIndex.map((x) => x.recipeIdentity));
    expect(withIndex).toEqual(withoutIndex);
    // Sanity: the relationship index keys on the same stable identity.
    expect(prebuilt.recipeProfiles.has(recipeIdentity(recipes[0]))).toBe(true);
  });
});
